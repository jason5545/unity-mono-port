// 執行中的場景：每格依 Unity 的順序跑——腳本 Update → DOTween（defaultUpdateType 0 跟著 Update）→ Animator → 重排（Canvas 在 render 前重排）。
// 遊戲腳本（轉換器產生或手寫的橋接）依類別名稱註冊（BehaviourRegistry），放在遊戲專案裡。
// 第 3 段起還有舊版滑鼠事件（OnMouse 系列）：腳本 Update 之後呼叫 world.sendMouseEvents()
// （Unity 的 Player loop 裡 SendMouseEvents 在 Update 之後，見 mouseEvents.ts 檔頭）。

import type { Localization } from '../localization/localization';
import type { TextMeshResult } from '../text/types';
import type { TmpVertexHook } from '../text/vertexHooks';
import { canvasDisabled, layoutWithUI, rebuildLayoutRoot, type SceneGraph, type SceneNode, type UILayoutOptions } from '../unity/scene';
import type { RectTransformData } from '../unity/types';
import type { ComponentData, Ref, SceneFile } from '../unity/types';
import { destroy, destroyedObjects, type SubtreeHooks } from '../unity/instantiate';
import type { SceneManagerService } from '../unity/sceneManager';
import { Scenes } from '../unity/scenes';
import type { MaterialInfo, SpriteInfo } from '../unity/assets';
import { AnimatorRuntime, type AnimEventData, type ClipAsset, type ControllerAsset } from './animator';
import { RectClipRegistry } from '../ui/rectMask2d';
import { EventSystem, type PointerHandlers } from './events';
import { MouseEventDispatcher, type MouseMessageHandlers, type MouseState } from './mouseEvents';
import { Tweens } from './tween';
import { ParticleWorld } from '../particles/manager';
import { TrailWorld } from '../particles/trailRenderer';

/** Unity 的 coroutine，每幀在 Update 之後恢復，回 false 表示結束 */
export interface Coroutine {
  step(dt: number): boolean;
}

export interface Behaviour extends PointerHandlers, MouseMessageHandlers {
  /** C# 的 Awake：全部建好後、任何 start() 之前跑（PauseMenu 要在 MainMenu.Initialize 之前就接好滑桿） */
  awake?(): void;
  start?(): void;
  update?(dt: number): void;
  /** C# 的 LateUpdate：全部 Update、補間、協程、動畫之後另跑一趟 */
  lateUpdate?(dt: number): void;
  /** C# 的 OnEnable：元件由未啟用轉為啟用（activeInHierarchy && m_Enabled）時跑；場景載入時只對當下啟用的跑 */
  onEnable?(): void;
  /** C# 的 OnDisable：由啟用轉未啟用時跑 */
  onDisable?(): void;
  /** C# 的 OnDestroy：Destroy 或場景卸載時，OnDisable 之後跑（只對跑過 Awake 的；World.destroyBehaviour） */
  onDestroy?(): void;
}

export interface BehaviourContext {
  world: World;
  node: SceneNode;
  comp: ComponentData;
}

export type BehaviourRegistry = Record<string, (ctx: BehaviourContext) => Behaviour>;

/**
 * World.behaviours：Map 本身照登記順序（refreshEnables 全掃的順序）。另外照 GameObject 分組、記登記序號，
 * SetActive 與 Behaviour.enabled 只處理受影響的那幾個（entriesOn），不用整個掃（MT2 戰鬥有 1.8 萬個，掃一次約 1.5 ms，
 * 結束回合的協程一格 SetActive 幾十次）。
 */
export class BehaviourTable extends Map<ComponentData, Behaviour> {
  private seq = 0;
  private readonly order = new Map<ComponentData, number>();
  private readonly byGo = new Map<string, Set<ComponentData>>();
  /** 增刪時清掉的快照（snapshot）：tick 每格要走三遍（refreshEnables、Update、LateUpdate），以前每遍都 [...this] 抄 1.8 萬個 [c, b]，
   *  有 Update 的其實只有兩百多個（MT2 戰鬥，10/18 量）。快照建好就不再改，迴圈開頭拿到的那份跟 [...this] 一樣是當下的內容 */
  private snapshots: { all?: [ComponentData, Behaviour][]; update?: [ComponentData, Behaviour][]; lateUpdate?: [ComponentData, Behaviour][] } = {};
  /** 目前全部的 [元件, behaviour]，照登記順序（同 [...this]；不要改它） */
  entriesSnapshot(): readonly [ComponentData, Behaviour][] {
    return (this.snapshots.all ??= [...super.entries()]);
  }
  /** 有 update／lateUpdate 方法的那幾個（同 entriesSnapshot 的順序）。方法在 behaviour 建立時就定了 */
  withMethod(method: 'update' | 'lateUpdate'): readonly [ComponentData, Behaviour][] {
    return (this.snapshots[method] ??= this.entriesSnapshot().filter(([, b]) => typeof b[method] === 'function'));
  }
  override set(c: ComponentData, b: Behaviour): this {
    // 建構時（super()）order 還沒建好；這個類別不帶初始內容
    if (this.snapshots) this.snapshots = {};
    if (this.order && !this.order.has(c)) {
      this.order.set(c, this.seq++);
      let set = this.byGo.get(c.gameObject);
      if (!set) this.byGo.set(c.gameObject, (set = new Set()));
      set.add(c);
    }
    return super.set(c, b);
  }
  override delete(c: ComponentData): boolean {
    this.snapshots = {};
    if (this.order.delete(c)) {
      const set = this.byGo.get(c.gameObject);
      set?.delete(c);
      if (set && set.size === 0) this.byGo.delete(c.gameObject);
    }
    return super.delete(c);
  }
  override clear(): void {
    this.snapshots = {};
    this.order.clear();
    this.byGo.clear();
    super.clear();
  }
  /** 這些 GameObject 上的 behaviour，照登記順序（跟全掃時的相對順序一樣） */
  entriesOn(goIds: Iterable<string>): [ComponentData, Behaviour][] {
    const out: [ComponentData, Behaviour, number][] = [];
    for (const id of goIds) for (const c of this.byGo.get(id) ?? []) out.push([c, super.get(c)!, this.order.get(c)!]);
    out.sort((a, b) => a[2] - b[2]);
    return out.map(([c, b]) => [c, b]);
  }
}

export interface WorldServices {
  localization: Localization;
  /** Application.version（PlayerSettings.bundleVersion） */
  version: string;
  controllers: Record<string, ControllerAsset>;
  clips: Record<string, ClipAsset>;
  registry: BehaviourRegistry;
  /**
   * 類別 → 基底類別鏈（轉換器 --hierarchy 的輸出，直接基底在前）。registry 沒有這個類別時沿鏈找：
   * 遊戲的 GameUISelectableButton : Button 沒有自己的 behaviour 時用 Button 的（factoryFor）。
   */
  hierarchy?: Record<string, string[]>;
  layout: UILayoutOptions;
  sortingLayerIndex: (id: number) => number;
  /** 圖層名稱（ProjectSettings/TagManager 的 layers，索引就是圖層編號；LayerMask.NameToLayer 用） */
  layerNames?: string[];
  /**
   * 音訊（遊戲專案給：Diceomancer 是 FMOD HTML5 runtime，Unity 內建聲音的遊戲是 AudioClip 播放器）。
   * 執行環境本身不碰，只轉交給遊戲腳本；null／沒給＝沒聲音，腳本照常跑。
   */
  audio?: unknown;
  /**
   * 每格腳本、補間、Animator 跑完、重排之前呼叫（遊戲專案的版面調整，例如 diceomancer-web 的手機寬版 applyWideLayout）。
   * 原版沒有的行為只能掛在這裡，執行環境不寫遊戲專屬的規則。
   */
  beforeLayout?: (world: World) => void;
  /** 換場景與常駐物件（unity/sceneManager.ts）。檢視頁才有；vitest 沒給時常駐的寫法照舊（不檢查重複） */
  sceneManager?: SceneManagerService;
  /**
   * 載入場景併進這個 World（viewer/boot.ts 的 bootGame 接上；相容層的 SceneManager.LoadScene／LoadSceneAsync 用）。
   * key：場景名、Assets 路徑或 build 順序；mode：LoadSceneMode（0 Single、1 Additive）。resolve 時場景已經載入（Awake／OnEnable 跑完）
   */
  loadScene?: (key: string | number, mode?: number) => Promise<import('../unity/scenes').LoadedScene>;
  /** 遊戲腳本要碰繪製端資料的地方（檢視頁接上；vitest 沒有） */
  render?: RenderServices;
}

/** 遊戲腳本用的繪製端介面（第 3 階段第六段起；戰鬥畫面的 BattleBridge 另外由 options 拿同樣的東西） */
export interface RenderServices {
  /**
   * 共用材質（Graphic.material 回傳的是 m_Material 本身，不是複本）：改 record.m_SavedProperties 的 float／color
   * 會影響所有用這個材質的物件，跨場景保留（素材庫是全頁共用的）。LevelLoader 的 _MaskAmount 用這個。
   */
  sharedMaterial(ref: Ref): MaterialInfo | null;
  /** Renderer.material：這個 renderer 元件專屬的材質複本，第一次要才複製（rendererMaterial.ts） */
  rendererMaterial(comp: ComponentData): MaterialInfo | null;
  /** 執行中換 sprite 之前先載好貼圖（不載也會畫，只是晚一格） */
  preloadSprites(refs: Ref[]): Promise<void>;
  /** 素材庫的 sprite 資料（m_Rect、m_PixelsToUnits…；Image.SetNativeSize 用） */
  spriteInfo(ref: Ref): SpriteInfo | null;
  /** 素材庫的貼圖寬高（Texture.width／height；材質 GetTexture 拿到的貼圖參照） */
  textureInfo?(ref: Ref): { width: number; height: number } | null;
  /** 素材庫的素材名字（Object.name 給 sprite、貼圖、材質的參照；物件庫的 prefab、ScriptableObject 不在這裡） */
  assetName?(ref: Ref): string | null;
  /**
   * 同步排版（DOTweenTMPAnimator 的 ForceMeshUpdate，DOTweenTMPAnimator.cs:259）：只排版、不建網格、不碰畫面。
   * withHook＝是否套上掛勾。沒有文字功能（?text=0）或還沒建置時回 null（第 2 輪）。
   */
  layoutText(comp: ComponentData, node: SceneNode, withHook: boolean): TextMeshResult | null;
  /** 登記（或拿掉，null）TMP 元件的網格掛勾；版本變了下一格整個重產（第 2 輪，裁決 3 方案 A） */
  setTextHook(comp: ComponentData, hook: TmpVertexHook | null): void;
  /** 最近一次畫出來（掛勾已套上）的排版結果；還沒畫過回 null（第 2 輪） */
  textResultOf(comp: ComponentData): TextMeshResult | null;
  /** TMP 的 preferredWidth（卡名底圖寬度用；第 3 階段第九段第 3 輪：戰鬥外的卡牌顯示） */
  preferredWidth?(node: SceneNode, comp: ComponentData): number;
  /** Material.SetTexture 的 sprite 版（卡圖 _CardArtTex 用；貼圖載完才 resolve）。第 3 階段第九段第 3 輪 */
  setRendererSpriteTexture?(comp: ComponentData, property: string, spriteRef: Ref): Promise<void>;
  /**
   * 生成物的子樹都畫進繪製端了才完成（第 3 階段第九段第 1 輪，裁決 7）：故事畫面換狀態要等它，才淡入、才拍截圖。
   * 檢視頁接上 subtreePending 鏈（main.ts）；沒有的環境（vitest）不接，呼叫端當作已經完成。
   */
  whenSubtreesBuilt?(): Promise<void>;
  /**
   * 預先編譯 prefab 裡 K3 材質要用的 shader program（SceneRenderer.prewarmPrefabs）：之後才生出來的物件（tooltip 框）
   * 第一次出現時不用同步編譯。不影響畫面；呼叫端不必等它完成。
   */
  prewarmPrefabs?(files: SceneFile[]): Promise<void>;
}

/**
 * 執行環境原生做的每格系統：腳本的 Update（與跟著 Update 的 DOTween）之後、協程之前（Unity 的 Update.DirectorUpdate）。
 * csport 的 PlayableDirector 載入時登記，engine 不用依賴 csport
 */
/** 動畫事件的派送（csport 登記：照接收方法的參數型別帶值）；沒登記就只記在 notes */
type AnimationEventSink = (w: World, node: SceneNode, ev: AnimEventData, clip: string) => void;
let animationEventSink: AnimationEventSink | null = null;
export function setAnimationEventSink(fn: AnimationEventSink): void {
  animationEventSink = fn;
}

const directorUpdates: ((w: World, dt: number) => void)[] = [];
export function registerDirectorUpdate(fn: (w: World, dt: number) => void): void {
  if (!directorUpdates.includes(fn)) directorUpdates.push(fn);
}

/**
 * Canvas.willRenderCanvases（Unity 在畫之前、排版之後發；UIParticle 在這時把粒子烤成網格交給 CanvasRenderer）：
 * csport 登記（事件存在 csport 的事件表裡），World 每格在粒子推進之後叫
 */
const willRenderCanvases: ((w: World) => void)[] = [];
export function registerWillRenderCanvases(fn: (w: World) => void): void {
  if (!willRenderCanvases.includes(fn)) willRenderCanvases.push(fn);
}

export class World {
  /** Time.time：乘過 timeScale 的世界時間 */
  time = 0;
  /** Time.unscaledTime：不受 timeScale 影響 */
  unscaledTime = 0;
  /**
   * Time.timeScale（整個 session 一個 World，跨場景保留）。Unity 文件（Manual: Time and frame rate management）：
   * Time.time／deltaTime 乘它，unscaledTime／unscaledDeltaTime 不乘；0 的時候 Update 照叫、Time.time 不走
   */
  timeScale = 1;
  /** Time.frameCount：tick 過幾格（轉換器產生的 Feel 用：MMF_Player 第一、二格的特別處理） */
  frameCount = 0;
  /** 這一幀的 Time.deltaTime（乘過 timeScale），還沒 tick 過是 0 */
  deltaTime = 0;
  /** 這一幀的 Time.unscaledDeltaTime */
  unscaledDeltaTime = 0;
  readonly coroutines = new Set<Coroutine>();
  readonly tweens = new Tweens();
  readonly animators: AnimatorRuntime[] = [];
  readonly behaviours = new BehaviourTable();
  /** 已跑過 OnEnable、還沒跑 OnDisable 的 behaviour（activeInHierarchy && m_Enabled）。refreshEnables 追蹤轉換 */
  readonly enabled = new Set<Behaviour>();
  readonly events: EventSystem;
  /** 舊版滑鼠事件（OnMouse 系列，mouseEvents.ts）。檢視頁在腳本 Update 之後呼叫 sendMouseEvents() */
  readonly mouseEvents: MouseEventDispatcher;
  /** 滑鼠狀態（Input.mousePosition 與 GetMouseButton 系；檢視頁的 DOM 事件寫進來，腳本在 Update 裡讀） */
  readonly mouse: MouseState = {
    x: 0,
    y: 0,
    leftDownThisFrame: false,
    leftPressed: false,
    leftUpThisFrame: false,
    rightDownThisFrame: false,
    scrollY: 0,
    buttons: [false, false, false],
    buttonsDown: [false, false, false],
    buttonsUp: [false, false, false],
  };
  /** 鍵盤（KeyboardEvent.code 與 .key 都記）：按住中、這一幀按下、這一幀放開（Input.GetKey／GetKeyDown／GetKeyUp） */
  readonly keysHeld = new Set<string>();
  readonly keysUp = new Set<string>();
  /** RectMask2D 裁切（ClipperRegistry 的等價，ui/rectMask2d.ts）；每格排版後 cullAll（ctor 初始化，要看得到 graph） */
  readonly clips: RectClipRegistry;
  readonly notes = new Set<string>();
  screen = { w: 1920, h: 1080 };
  /** 這個 World 的子樹新增／移除通知（繪製端接上）。沒給就用 instantiate.ts 的全域掛勾（舊的寫法） */
  subtreeHooks?: SubtreeHooks;
  /** 場景載入時還沒啟用的 Animator：啟用之後的第一次 tick 才建 runtime（Unity：物件啟用後 Animator 才開始跑預設狀態） */
  private readonly dormantAnimators: { node: SceneNode; comp: ComponentData; ctrl: ControllerAsset }[] = [];
  /** Object.Destroy 的延後佇列（Unity 的 Destroy 在幀尾生效）：start() 結束與每次 tick 結束時處理 */
  private readonly pendingDestroy: (SceneNode | ComponentData)[] = [];
  /** 已經 Awake、還沒 Start 的 behaviour（Unity：Start 在第一次 Update 之前；Instantiate、載入場景時排進來，flushStarts 跑） */
  private readonly pendingStarts: { comp: ComponentData; b: Behaviour }[] = [];
  /** 已載入的場景與 DontDestroyOnLoad（unity/scenes.ts）。開機流程用 scenes.registerInitial 登記第一個場景 */
  readonly scenes: Scenes;
  /**
   * 腳本丟出的例外（Unity 的做法：記到主控台，那個方法的其餘部分不跑，其他物件照常）。
   * 同一個訊息只記一次（times 累計），最多 500 種。
   */
  readonly exceptions: { where: string; message: string; stack: string; times: number }[] = [];

  constructor(
    readonly graph: SceneGraph,
    readonly services: WorldServices,
  ) {
    this.clips = new RectClipRegistry(graph);
    this.events = new EventSystem(graph, (node) => this.handlersOf(node), services.sortingLayerIndex, () => this.services.hierarchy);
    this.events.cullCheck = (id) => this.clips.isCulled(id);
    this.mouseEvents = new MouseEventDispatcher(this);
    this.scenes = new Scenes(this);
    this.particles = new ParticleWorld(this);
    this.trails = new TrailWorld(this);
  }

  /** 場景裡的 ParticleSystem（particles/manager.ts） */
  readonly particles: ParticleWorld;
  /** 場景裡的 TrailRenderer 留下的點（particles/trailRenderer.ts） */
  readonly trails: TrailWorld;

  /** 跑一段腳本（生命週期、事件、協程）：例外照 Unity 的做法記下來、不往外丟。回傳是否正常結束 */
  guard(where: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (e) {
      this.reportException(where, e);
      return false;
    }
  }

  reportException(where: string, e: unknown): void {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const hit = this.exceptions.find((x) => x.message === message);
    if (hit) {
      hit.times++;
      return;
    }
    if (this.exceptions.length >= 500) return;
    const stack = e instanceof Error ? (e.stack ?? '') : '';
    this.exceptions.push({ where, message, stack, times: 1 });
    console.error(`[${where}] ${message}`, e);
  }

  /** 排進 Start 佇列（Awake 已經跑過）；flushStarts 在下一次 Update 之前跑 */
  queueStart(comp: ComponentData, b: Behaviour): void {
    if (this.started.has(b) || this.pendingStarts.some((p) => p.b === b)) return;
    this.pendingStarts.push({ comp, b });
  }

  /** 佇列裡的 Start：物件還在、啟用中才跑（Unity：停用的物件等啟用後才 Start；這裡啟用時由 refreshEnables 再排） */
  flushStarts(): void {
    while (this.pendingStarts.length) {
      const batch = this.pendingStarts.splice(0);
      for (const { comp, b } of batch) {
        if (this.behaviours.get(comp) !== b) continue;
        const node = this.graph.nodes.get(comp.gameObject);
        if (this.started.has(b)) continue;
        if (!node?.activeInHierarchy || comp.m_Enabled === 0) {
          this.unstarted.add(b);
          continue;
        }
        this.started.add(b);
        if (b.start) this.guard(`${comp.script?.class ?? comp.type}.Start`, () => b.start!());
      }
    }
  }
  /** 排隊等 Start、自己沒有 Start 方法、現在啟用中的：直接算 Start 過（LateUpdate 那一趟用，見 tick） */
  private startTrivial(): void {
    if (!this.pendingStarts.length) return;
    const keep = this.pendingStarts.filter(({ comp, b }) => {
      if (b.start || this.behaviours.get(comp) !== b || this.started.has(b)) return true;
      const node = this.graph.nodes.get(comp.gameObject);
      if (!node?.activeInHierarchy || comp.m_Enabled === 0) return true;
      this.started.add(b);
      return false;
    });
    this.pendingStarts.splice(0, this.pendingStarts.length, ...keep);
  }
  /** 跑過 Start 的 behaviour；沒跑過、而且當時沒啟用的（unstarted）等啟用時再排 */
  private readonly started = new WeakSet<Behaviour>();
  /** start() 的 Awake 迴圈還沒輪到的 behaviour（refreshEnables 先不動它們） */
  private awaitingAwake: Set<Behaviour> | null = null;
  /** 跑過 Awake 的 behaviour（沒啟用的物件，Awake 延到第一次啟用） */
  private readonly awoken = new WeakSet<Behaviour>();
  private readonly unstarted = new Set<Behaviour>();

  /**
   * C# 的 OnDestroy（Object.Destroy、場景卸載）：Unity 手冊「OnDestroy will only be called on game objects that have previously been active」，
   * 這裡照「跑過 Awake」判斷。呼叫端先叫完 OnDisable，節點拆掉之前叫這個（OnDestroy 裡還讀得到自己的元件）。
   * 以前完全沒有 OnDestroy：MT2 的 UIScreen.OnDestroy 不會 UnregisterScreen，場景卸載後 ScreenManager 還拿著銷毀的畫面，
   * 下一次 RefreshScreenStack 讀它的 canvas 丟例外
   */
  destroyBehaviour(comp: ComponentData, b: Behaviour): void {
    if (!b.onDestroy || !this.awoken.has(b)) return;
    this.guard(`${comp.script?.class ?? comp.type}.OnDestroy`, () => b.onDestroy!());
  }

  private handlersOf(node: SceneNode): PointerHandlers[] {
    const out: PointerHandlers[] = [];
    for (const c of this.graph.components(node)) {
      const b = this.behaviours.get(c);
      if (b && c.m_Enabled !== 0 && node.activeInHierarchy) out.push(b);
    }
    return out;
  }

  /** 腳本 behaviour（依元件找） */
  behaviour<T extends Behaviour>(comp: ComponentData | undefined): T | undefined {
    return comp ? (this.behaviours.get(comp) as T | undefined) : undefined;
  }

  /**
   * 場景載入：建 Animator（只目前啟用的）與腳本（全部元件，含 activeInHierarchy off 的）。
   * 未啟用物件也要建 behaviour：OnClick／OpenCredit 這類綁定要在 CreditsPanel 被 SetActive 之前就找得到
   * （unityEvents 用 world.behaviour(target)，啟用前必須已存在）。Awake 與 OnEnable 照 Unity 只對當下啟用的物件跑（awakeBatch），
   * 之後才啟用的由 refreshEnables 在啟用那一幀補跑 Awake 與 OnEnable。
   */
  start(): void {
    for (const node of this.graph.nodes.values()) {
      for (const c of this.graph.components(node)) {
        if (c.type === 'Animator') {
          const ref = c.m_Controller as Ref;
          const ctrl = ref && 'guid' in ref ? this.services.controllers[ref.guid] : undefined;
          if (!ctrl) continue;
          if (c.m_Enabled === 0 || !node.activeInHierarchy) {
            // 例：LevelLoader 的 loadingIcon（OnLoadingAnimation）預設關著，載入場景時才 SetActive(true)
            this.dormantAnimators.push({ node, comp: c, ctrl });
            continue;
          }
          const rt = new AnimatorRuntime(this.graph, node, c, ctrl, this.services.controllers, this.services.clips);
          this.animators.push(rt);
          for (const n of rt.notes) this.notes.add(n);
          continue;
        }
        // 腳本 behaviour：不分啟用／啟用元件。C# 的 UnityEvent（onClick→OpenCredit）對「停用元件」的方法照樣呼叫，
        // 所以 CreditsPanel（m_Enabled 0）等的 behaviour 必須先建好；update／handler／OnEnable 再各自依 m_Enabled 與 activeInHierarchy 過濾。
        const factory = this.factoryForScript(c.script);
        if (factory) this.behaviours.set(c, factory({ world: this, node, comp: c }));
      }
    }
    // Awake／OnEnable 照 Unity 的順序（awakeBatch）；Start 全部排在第一次 Update 之前（flushStarts）。
    // 物件之間照場景檔的元件 fileID（原版 build 的 pathID，同 unity/scenes.ts 的 loadOrder）；id 不是數字的維持樹的順序
    const fileOrder = new Map<ComponentData, number>();
    for (const [id, c] of Object.entries(this.graph.file.components)) if (/^-?\d+$/.test(id)) fileOrder.set(c, Number(id));
    this.awakeBatch([...this.behaviours].sort((a, b) => (fileOrder.get(a[0]) ?? Infinity) - (fileOrder.get(b[0]) ?? Infinity)));
    this.flushStarts();
    this.flushDestroy();
    this.relayout();
  }

  /**
   * Object.Destroy(gameObject)／Object.Destroy(this)：延後到 start() 或這一格 tick 的最後才真的銷毀。
   * 給節點＝整個物件（連子樹）；給元件＝只拿掉那個元件（PlayerCommandHandler.Awake 的 Destroy(this)）。
   */
  destroyDeferred(target: SceneNode | ComponentData): void {
    if (!this.pendingDestroy.includes(target)) this.pendingDestroy.push(target);
  }

  /** 延後銷毀佇列裡、已經確定要被砍的元件（start() 用：不替它們跑 OnEnable／Start） */
  private doomedComponents(): Set<ComponentData> {
    const out = new Set<ComponentData>();
    for (const t of this.pendingDestroy) {
      if ('go' in t) {
        const stack: SceneNode[] = [t as SceneNode];
        while (stack.length) {
          const n = stack.pop()!;
          for (const c of this.graph.components(n)) out.add(c);
          stack.push(...n.children);
        }
      } else out.add(t as ComponentData);
    }
    return out;
  }

  private flushDestroy(): void {
    while (this.pendingDestroy.length) {
      const t = this.pendingDestroy.shift()!;
      if ('go' in t) {
        const node = t as SceneNode;
        if (this.graph.nodes.get(node.id) === node) destroy(this, node);
        continue;
      }
      const comp = t as ComponentData;
      const node = this.graph.nodes.get(comp.gameObject);
      const b = this.behaviours.get(comp);
      if (b && this.enabled.has(b)) {
        this.enabled.delete(b);
        b.onDisable?.();
      }
      if (b) this.destroyBehaviour(comp, b);
      // OnDisable／OnDestroy 跑完才算已銷毀（回呼裡自己還是有效的）
      destroyedObjects.add(comp);
      this.behaviours.delete(comp);
      if (!node) continue;
      const id = node.go.components.find((cid) => this.graph.file.components[cid] === comp);
      if (id === undefined) continue;
      node.go.components.splice(node.go.components.indexOf(id), 1);
      delete this.graph.file.components[id];
      this.graph.bumpStructure(); // 元件移除：候選清單的快取失效（scene.ts structureVersion）
    }
  }

  /**
   * 一批新建的 behaviour（場景載入、Instantiate、AddComponent）照 Unity 的順序：物件一個一個來，啟用中的物件先 Awake、緊接著 OnEnable
   * （元件停用時只有 Awake）；物件沒啟用的，Awake 延到第一次啟用（refreshEnables）。批次中別人的 Awake 觸發的 refreshEnables
   * 不替還沒輪到的跑（照順序來），但批次開始時沒啟用、被中途啟用的物件馬上 Awake＋OnEnable（Unity 的 SetActive 也是）。
   * Awake 裡被 Destroy 的物件不跑 OnEnable／Start。Start 一律排在下一次 Update 之前（flushStarts）。
   */
  awakeBatch(list: [ComponentData, Behaviour][]): void {
    const prev = this.awaitingAwake;
    const pending = new Set<Behaviour>(prev ?? []);
    for (const [c, b] of list) if (!this.awoken.has(b) && this.graph.nodeById(c.gameObject)?.activeInHierarchy) pending.add(b);
    this.awaitingAwake = pending;
    try {
      for (const [c, b] of list) {
        if (!pending.has(b)) continue;
        pending.delete(b);
        if (this.doomedComponents().has(c)) continue;
        this.awakeAndEnable(c, b);
      }
    } finally {
      this.awaitingAwake = prev;
    }
    for (const [, b] of list) if (!this.enabled.has(b) && !this.started.has(b)) this.unstarted.add(b);
  }
  /** Awake（還沒跑過的話），再看物件與元件都啟用就 OnEnable、排 Start */
  private awakeAndEnable(c: ComponentData, b: Behaviour): void {
    if (!this.awoken.has(b)) {
      this.awoken.add(b);
      if (b.awake) this.guard(`${c.script?.class ?? c.type}.Awake`, () => b.awake!());
    }
    if (!this.behaviours.has(c) || this.enabled.has(b)) return;
    const node = this.graph.nodeById(c.gameObject);
    if (node?.activeInHierarchy && c.m_Enabled !== 0 && !this.doomedComponents().has(c)) {
      this.enabled.add(b);
      if (b.onEnable) this.guard(`${c.script?.class ?? c.type}.OnEnable`, () => b.onEnable!());
      this.unstarted.delete(b);
      if (!this.started.has(b)) this.queueStart(c, b);
    }
  }

  /** refreshEnables 的單一個 behaviour：active 是所在節點的 activeInHierarchy */
  private refreshEnable(c: ComponentData, b: Behaviour, active: boolean): void {
    // 節點停用（全掃時占四分之三）：只有原本啟用中的要送 OnDisable，其他不用再查（判斷結果同下面的完整版）
    if (!active && !this.enabled.has(b)) return;
    if (this.awaitingAwake?.has(b)) return;
    if (active && !this.awoken.has(b)) {
      this.awakeAndEnable(c, b);
      return;
    }
    const now = active && c.m_Enabled !== 0;
    const was = this.enabled.has(b);
    if (now && !was) {
      this.enabled.add(b);
      if (b.onEnable) this.guard(`${c.script?.class ?? c.type}.OnEnable`, () => b.onEnable!());
      this.unstarted.delete(b);
      if (!this.started.has(b)) this.queueStart(c, b);
    } else if (!now && was) {
      this.enabled.delete(b);
      if (b.onDisable) this.guard(`${c.script?.class ?? c.type}.OnDisable`, () => b.onDisable!());
    }
  }

  /**
   * activeInHierarchy／m_Enabled 改變後補跑 Awake（第一次啟用）與 OnEnable／OnDisable（C# 的啟用事件）。
   * tick 開頭全掃（Animator 曲線這類直接改 m_Enabled 的也接得到）；SetActive 只處理那棵子樹、Behaviour.enabled 只處理那個元件
   * （scope，10/17 以前每次都全掃）。處理順序都照登記順序。
   */
  /** 全掃用：快照裡每個 behaviour 所在的節點（照快照的索引）。節點或元件增減時（membershipVersion）整份重查；
   *  以前每格對 1.8 萬個 behaviour 各查一次 graph.nodes（MT2 戰鬥，10/18） */
  private enableScanNodes: {
    snap: readonly [ComponentData, Behaviour][];
    version: number;
    nodes: (SceneNode | undefined)[];
    /**
     * 上一次全掃完要再看的索引（節點啟用中、或掃完還在 enabled 裡的），照索引排序；watchActive 是那次掃描開始時的 graph.activeVersion。
     * activeVersion 沒變：其他索引的節點都還是停用、behaviour 也不在 enabled（加進 enabled 都要節點啟用），全掃的判斷對它們什麼都不做，
     * 只走這份（MT2 戰鬥 1.8 萬個裡約 4600 個，10/18）。掃描途中 activeVersion 變了（OnEnable 裡 SetActive），剩下的照全掃
     */
    watch: Int32Array | null;
    watchActive: number;
    /** 建 watch 時的 enabledVersion（m_Enabled 被腳本直接改的版本）；跟 activeVersion 一起判斷要不要整段跳過 */
    watchEnabled: number;
  } | null = null;

  refreshEnables(scope?: SceneNode | ComponentData): void {
    let list: readonly [ComponentData, Behaviour][];
    let nodes: (SceneNode | undefined)[] | null = null;
    let cache: NonNullable<World['enableScanNodes']> | null = null;
    if (!scope) {
      list = this.behaviours.entriesSnapshot();
      cache = this.enableScanNodes;
      if (!cache || cache.snap !== list || cache.version !== this.graph.membershipVersion) {
        cache = this.enableScanNodes = { snap: list, version: this.graph.membershipVersion, nodes: list.map(([c]) => this.graph.nodes.get(c.gameObject)), watch: null, watchActive: -1, watchEnabled: -1 };
      }
      nodes = cache.nodes;
    } else if ('go' in scope) {
      // ComponentData 有索引簽章，in 縮不了型別
      const ids: string[] = [];
      const stack: SceneNode[] = [scope as SceneNode];
      while (stack.length) {
        const n = stack.pop()!;
        ids.push(n.id);
        for (const ch of n.children) stack.push(ch);
      }
      list = this.behaviours.entriesOn(ids);
    } else {
      const comp = scope as ComponentData;
      const b = this.behaviours.get(comp);
      list = b ? [[comp, b]] : [];
    }
    // 全掃：activeVersion 跟上一次一樣就只走 watch（見 enableScanNodes）；不一樣就全走，順便記下一次的 watch
    const av = this.graph.activeVersion;
    // 掃描開始時的版本：途中回呼又改了 m_Enabled 的話，下一趟對不上、照走一次
    const ev = this.graph.enabledVersion;
    // 兩個版本都沒變：上一趟之後沒人動過啟用狀態，而 watch 裡的節點上次都已經確認過（節點啟用中、behaviour 在 enabled 裡），
    // 這趟什麼都不會變——整段跳過。MT2 戰鬥 10/18 量：每格 4985 次呼叫、狀態變化 0 次（1.09 ms）
    if (cache && cache.watch && cache.watchActive === av && cache.watchEnabled === ev) {
      if (!scope) this.particles.syncActivation(null);
      else if ('go' in scope) this.particles.syncActivation(scope as SceneNode);
      return;
    }
    let watch = cache && cache.watch && cache.watchActive === av ? cache.watch : null;
    const nextWatch: number[] | null = cache && !watch ? [] : null;
    let k = 0;
    for (let i = watch ? (watch.length ? watch[0] : list.length) : 0; i < list.length; ) {
      const [c, b] = list[i];
      const active = !!(nodes ? nodes[i] : this.graph.nodes.get(c.gameObject))?.activeInHierarchy;
      this.refreshEnable(c, b, active);
      if (nextWatch && (active || this.enabled.has(b))) nextWatch.push(i);
      // 回呼裡改了啟用狀態：剩下的照全掃（同一趟就要看到新啟用的物件，跟全掃一樣）
      if (watch && this.graph.activeVersion !== av) watch = null;
      if (watch) i = ++k < watch.length ? watch[k] : list.length;
      else i++;
    }
    if (cache) {
      // 這一趟中途 activeVersion 變了：下一格版本對不上，照全掃
      if (nextWatch) {
        cache.watch = Int32Array.from(nextWatch);
        cache.watchActive = av;
        cache.watchEnabled = ev;
      } else if (watch) {
        // 只走 watch、途中 activeVersion 沒變：watch 外的都在停用節點上，m_Enabled 怎麼改都不影響，這趟等於全部確認過。
        // 不記的話，一次 Behaviour.enabled 之後要等到下一次 SetActive 才會再跳過
        cache.watchEnabled = ev;
      }
    }
    // 原生元件的啟用（ParticleSystem 的 playOnAwake、停用時清掉）：Behaviour.enabled 不影響 ParticleSystem（它不是 Behaviour）
    if (!scope) this.particles.syncActivation(null);
    else if ('go' in scope) this.particles.syncActivation(scope as SceneNode);
  }
  /**
   * Instantiate 出來的子樹上的 Animator（Unity 的 Animator 跟物件一起從預設狀態開始）：跟 start() 同一套，啟用的立刻建 runtime、
   * 沒啟用的等啟用那一幀（wakeAnimators）。spawnPrefab 本身不呼叫：只給需要的 prefab 用（傳送門、釣魚，10/12），
   * 不改其他 prefab 既有的生命周期與截圖。已經建過的跳過。
   */
  startAnimatorsIn(nodes: SceneNode[]): void {
    for (const node of nodes) {
      for (const c of this.graph.components(node)) {
        if (c.type !== 'Animator') continue;
        if (this.animators.some((a) => a.component === c) || this.dormantAnimators.some((d) => d.comp === c)) continue;
        const ref = c.m_Controller as Ref;
        // 沒有指定 controller（{fileID: 0}）：Unity 的 Animator 什麼都不播，等腳本設 runtimeAnimatorController（setAnimatorController）
        if (!ref || !('guid' in ref)) continue;
        const ctrl = this.services.controllers[ref.guid];
        if (!ctrl) throw new Error(`Animator（${node.go.m_Name}）的 controller ${ref.guid} 沒有載入`);
        if (c.m_Enabled === 0 || !node.activeInHierarchy) {
          this.dormantAnimators.push({ node, comp: c, ctrl });
          continue;
        }
        const rt = new AnimatorRuntime(this.graph, node, c, ctrl, this.services.controllers, this.services.clips);
        this.animators.push(rt);
        for (const n of rt.notes) this.notes.add(n);
      }
    }
  }

  /**
   * Animator.runtimeAnimatorController 的 set：換掉元件的 controller，舊的執行狀態丟掉，新的從預設狀態開始
   * （停用中的等啟用才建）。給 null 就停下來不播。
   */
  setAnimatorController(node: SceneNode, comp: ComponentData, ref: Ref | null): void {
    const i = this.animators.findIndex((a) => a.component === comp);
    if (i >= 0) this.animators.splice(i, 1);
    const j = this.dormantAnimators.findIndex((d) => d.comp === comp);
    if (j >= 0) this.dormantAnimators.splice(j, 1);
    comp.m_Controller = ref;
    if (this.graph.nodes.get(node.id) === node) this.startAnimatorsIn([node]);
  }

  /** 載入時還沒啟用、現在啟用了的 Animator：建 runtime（從預設狀態開始）。已經建過的照舊，不因為停用而重來 */
  private wakeAnimators(): void {
    for (let i = this.dormantAnimators.length - 1; i >= 0; i--) {
      const { node, comp, ctrl } = this.dormantAnimators[i];
      if (this.graph.nodes.get(node.id) !== node) {
        this.dormantAnimators.splice(i, 1);
        continue;
      }
      if (comp.m_Enabled === 0 || !node.activeInHierarchy) continue;
      this.dormantAnimators.splice(i, 1);
      const rt = new AnimatorRuntime(this.graph, node, comp, ctrl, this.services.controllers, this.services.clips);
      this.animators.push(rt);
      for (const n of rt.notes) this.notes.add(n);
    }
  }

  /** 動畫會換到的 sprite（給繪製端預載） */
  animatedSprites(): Ref[] {
    const out: Ref[] = [];
    for (const a of this.animators) {
      const ctrl = this.services.controllers[(a.component.m_Controller as { guid: string }).guid];
      const guids = new Set<string>();
      const collect = (c: ControllerAsset) => {
        for (const o of Object.values(c.objects)) {
          const m = o.m_Motion as Ref;
          if (m && 'guid' in m) guids.add(m.guid);
          for (const cl of (o.m_Clips as { m_OverrideClip: Ref }[]) ?? []) if (cl.m_OverrideClip && 'guid' in cl.m_OverrideClip) guids.add(cl.m_OverrideClip.guid);
          const base = o.m_Controller as Ref;
          if (base && 'guid' in base && this.services.controllers[base.guid]) collect(this.services.controllers[base.guid]);
        }
      };
      if (ctrl) collect(ctrl);
      for (const g of guids) for (const e of this.services.clips[g]?.m_PPtrCurves ?? []) for (const k of e.curve as { value: Ref }[]) out.push(k.value);
    }
    return out;
  }

  /**
   * 增量排版的驗證（?layoutcheck=1）：每次 relayout 之後照目前資料全部重算一次比對（SceneGraph.verifyLayout），
   * 不一樣的記進 layoutMismatches 與 notes。只給 check 與除錯用，會把排版變回每次全算的成本。
   */
  layoutVerify = false;
  readonly layoutMismatches: { frame: number; id: string; name: string; what: string }[] = [];

  /** relayout 跑完的次數（ScrollRect 的 m_HasRebuiltLayout：啟用之後排過版沒有） */
  layoutCount = 0;
  /** 正在 relayout（CanvasUpdateRegistry.IsRebuildingLayout） */
  inLayout = false;

  /**
   * 這一格延後、還沒排的 layout root：所在的 Canvas 關掉的（不畫、射線也跳過，MT2 戰鬥是牌池 26 張卡，每格 319 個 root）。
   * 腳本讀到或寫到底下的 RectTransform 之前（refreshTransform、nativeGet／nativeSet、RectTransform 的原生方法）由 flushDeferredLayout
   * 先排；Canvas 打開的那一格 tick 結尾的排版就照常排（畫之前）。Unity 是 dirty 才重排，不 dirty 的排了也是同一個結果；
   * 差別只在「Canvas 關著、內容變了、又沒人讀」的時候晚一點排，讀的人看到的跟 Unity 一樣（10/18，Jason 定）
   */
  private deferredLayout = new Set<SceneNode>();

  /**
   * 延後排版的驗證（除錯用）：每格把延後的 root 實際排一次，跟延後的值比（sizeDelta、anchoredPosition、anchor），比完還原。
   * 不一樣的記進 layoutDeferMismatches。會把延後省下的成本加回來
   */
  layoutDeferVerify = false;
  readonly layoutDeferMismatches: { frame: number; node: string; field: string; deferred: unknown; full: unknown }[] = [];
  /** 延後排版的統計（除錯用）：延後的 root 數、補排的 root 數（累計） */
  readonly layoutDeferStats = { deferred: 0, flushed: 0 };

  /** deferDisabledCanvas：只有 tick 結尾那一次（每格的排版）延後；ForceRebuildLayoutImmediate、Canvas.ForceUpdateCanvases、場景載入照舊全排 */
  relayout(deferDisabledCanvas = false): void {
    this.inLayout = true;
    try {
      this.relayoutNow(deferDisabledCanvas);
    } finally {
      this.inLayout = false;
      this.layoutCount++;
    }
  }

  private relayoutNow(deferDisabledCanvas: boolean): void {
    const report = layoutWithUI(this.graph, this.screen.w, this.screen.h, this.services.layout, deferDisabledCanvas ? (r) => canvasDisabled(r) : undefined);
    this.deferredLayout = new Set(report.deferred ?? []);
    this.layoutDeferStats.deferred += this.deferredLayout.size;
    if (this.layoutDeferVerify) this.verifyDeferredLayout();
    if (this.layoutVerify) {
      for (const m of this.graph.verifyLayout(this.screen.w, this.screen.h)) {
        if (this.layoutMismatches.length < 200) this.layoutMismatches.push({ frame: this.frameCount, ...m });
        this.notes.add(`增量排版跟全部重算不一樣：${m.name}（${m.id}）`);
      }
    }
    // ClipperRegistry.Cull：排版之後、Graphic 重建之前（CanvasUpdateRegistry.cs:113）。
    // 裁切狀態與 cull 存在 registry 裡；繪製端每格讀（clip 轉變由 refreshKeyOf 的 clip 欄觸發重產）
    this.clips.cullAll();
    for (const [k, n] of Object.entries(report.unsupported)) this.notes.add(`排版：${k}（${n}）`);
  }

  /**
   * 腳本讀 Transform／RectTransform 之前（transform.position、TransformPoint、RectTransform.rect…）：只沿父物件鏈算 node 與它的祖先
   * （SceneGraph.refreshChain）。Unity 讀的時候就是這樣算，uGUI 的自動排版（LayoutGroup、ContentSizeFitter）要等畫之前的 Canvas 重建
   * 或 ForceRebuildLayoutImmediate，讀 transform 不會觸發。10/17 以前讀一次就整棵樹 relayout：MT2 戰鬥一格讀 108 次、每次 7 ms（1.4 萬個節點）。
   */
  refreshTransform(node: SceneNode): void {
    this.flushDeferredLayout(node);
    this.graph.refreshChain(node, this.screen.w, this.screen.h);
  }

  /** node 或它的祖先是延後中的 layout root（deferredLayout）：由外往內先排好再讓呼叫端讀寫 */
  flushDeferredLayout(node: SceneNode): void {
    const set = this.deferredLayout;
    if (set.size === 0) return;
    let hits: SceneNode[] | null = null;
    for (let n: SceneNode | null = node; n; n = n.parent) if (set.has(n)) (hits ??= []).push(n);
    if (!hits) return;
    for (let i = hits.length - 1; i >= 0; i--) {
      const root = hits[i];
      // 先拿掉：排版中腳本的 CalculateLayoutInput 可能又讀 transform，不要重入
      set.delete(root);
      if (this.graph.nodes.get(root.id) !== root || !root.activeInHierarchy) continue;
      this.layoutDeferStats.flushed++;
      rebuildLayoutRoot(this.graph, root, this.screen.w, this.screen.h, this.services.layout);
    }
  }

  private verifyDeferredLayout(): void {
    const FIELDS = ['m_SizeDelta', 'm_AnchoredPosition', 'm_AnchorMin', 'm_AnchorMax'] as const;
    for (const root of this.deferredLayout) {
      if (!root.activeInHierarchy) continue;
      const saved: { node: SceneNode; rt: RectTransformData; values: Record<string, { x: number; y: number }> }[] = [];
      const visit = (n: SceneNode): void => {
        if (n.isRect) {
          const rt = n.transform as unknown as RectTransformData;
          saved.push({ node: n, rt, values: Object.fromEntries(FIELDS.map((f) => [f, rt[f]])) });
        }
        for (const ch of n.children) visit(ch);
      };
      visit(root);
      rebuildLayoutRoot(this.graph, root, this.screen.w, this.screen.h, this.services.layout);
      for (const { node, rt, values } of saved) {
        for (const f of FIELDS) {
          const a = values[f];
          const b = rt[f];
          if (a.x !== b.x || a.y !== b.y) {
            if (this.layoutDeferMismatches.length < 200) this.layoutDeferMismatches.push({ frame: this.frameCount, node: node.go.m_Name, field: f, deferred: a, full: b });
          }
          rt[f] = a;
        }
      }
      this.graph.refreshSubtree(root, this.screen.w, this.screen.h);
    }
  }

  /**
   * 新生出來或剛換父物件的子樹（SceneGraph.refreshSubtree）：Instantiate、SetParent 以前整棵樹 relayout（一次約 10 ms，
   * MT2 結束回合那段 700 格裡叫了上百次），Unity 在這些時機不重排；這裡只算那棵子樹，讓之後讀它的與繪製端的掛勾拿到新的位置
   */
  refreshSubtree(root: SceneNode): void {
    this.graph.refreshSubtree(root, this.screen.w, this.screen.h);
  }

  /** 元件腳本的 behaviour 工廠：不同 namespace 的同名類別，產生名帶 namespace（轉換器的規則），先找那個 */
  factoryForScript(script: { namespace?: string | null; class?: string } | null | undefined): BehaviourRegistry[string] | undefined {
    if (!script?.class) return undefined;
    if (script.namespace) {
      const q = `${script.namespace.replace(/\./g, '_')}_${script.class}`;
      if (this.services.registry[q]) return this.services.registry[q];
    }
    return this.factoryFor(script.class);
  }

  /** 類別的 behaviour 工廠：自己註冊的優先，沒有就沿 services.hierarchy 的基底鏈找最近的 */
  factoryFor(cls: string | undefined): BehaviourRegistry[string] | undefined {
    if (!cls) return undefined;
    const reg = this.services.registry;
    if (reg[cls]) return reg[cls];
    for (const b of this.services.hierarchy?.[cls] ?? []) if (reg[b]) return reg[b];
    return undefined;
  }

  /** 下一格開頭（腳本 Update 之前）要跑的事：場景載入完成後的啟用（Unity 的非同步載入在主執行緒的某一格完成） */
  private readonly nextTick: (() => void)[] = [];
  beforeNextTick(fn: () => void): void {
    this.nextTick.push(fn);
  }

  /**
   * 推一格。dt 是這一格實際經過的時間（unscaled）；腳本、協程（WaitForSeconds、Invoke、Destroy(t)）、補間拿乘過 timeScale 的，
   * Animator 照 updateMode（UnscaledTime 用 unscaled）、PlayableDirector 照 DirectorUpdateMode 選。
   * Unity 還會用 Time.maximumDeltaTime 截斷一格的時間（文件沒寫在乘 timeScale 之前或之後，未查證），這裡沒做（跟以前一樣）
   */
  tick(dt: number): void {
    const sdt = dt * this.timeScale;
    this.unscaledTime += dt;
    this.unscaledDeltaTime = dt;
    this.time += sdt;
    this.frameCount++;
    this.deltaTime = sdt;
    for (const fn of this.nextTick.splice(0)) this.guard('場景載入', fn);
    // 啟用狀態可能在上一幀的 SetActive（點 CREDITS／Close）之後變；OnEnable 要在本幀 Update／LateUpdate 之前跑完
    this.refreshEnables();
    // Start：上一格之後生出來、載入的物件（Unity：第一次 Update 之前）
    this.flushStarts();
    // 從別的場景帶過來的常駐物件（DontDestroyOnLoad）：它們的節點在舊場景樹裡，由目前的場景每格呼叫
    for (const b of this.services.sceneManager?.persistentFor(this) ?? []) b.update?.(sdt);
    for (const [c, b] of this.behaviours.withMethod('update')) {
      const node = this.graph.nodes.get(c.gameObject);
      if (b.update && node?.activeInHierarchy && c.m_Enabled !== 0 && this.started.has(b)) this.guard(`${c.script?.class ?? c.type}.Update`, () => b.update!(sdt));
    }
    this.tweens.update(sdt);
    for (const fn of directorUpdates) this.guard('PlayableDirector', () => fn(this, sdt));
    // 協程丟例外：那個協程停掉（Unity 一樣），其他照常
    for (const c of [...this.coroutines]) {
      let alive = false;
      if (!this.guard('協程', () => (alive = c.step(sdt))) || !alive) this.coroutines.delete(c);
    }
    this.wakeAnimators();
    // 事件的接收者可能啟用別的物件、換 controller（animators 會變），照這一格開頭的清單走。
    // AnimatorUpdateMode：Normal 0、AnimatePhysics 1、UnscaledTime 2（UnscaledTime 不受 timeScale 影響）
    for (const a of [...this.animators]) {
      if (a.node.activeInHierarchy && a.component.m_Enabled !== 0) a.update(a.component.m_UpdateMode === 2 ? dt : sdt);
      for (const { ev, clip } of a.fired.splice(0)) {
        if (animationEventSink) this.guard(`AnimationEvent ${ev.functionName}`, () => animationEventSink!(this, a.node, ev, clip));
        else this.notes.add(`動畫事件 ${clip}.${ev.functionName}：沒有登記派送`);
      }
    }
    for (const a of this.animators) for (const n of a.notes) this.notes.add(n);
    // LateUpdate：全部 Update、補間、協程、動畫之後（Unity 文件 Order of execution for event functions）。
    // 這一格才啟用的 behaviour 照規矩先排 Start（下一格開頭 flushStarts）；沒有 Start 方法的沒有東西要先跑，這一格就跑 LateUpdate
    //（Unity 同一格會不會叫未查證；MT2 的 CardTrail 在補間裡才 SetActive，沒跑的話拖尾的第一個點留在池子的位置）
    this.startTrivial();
    for (const b of this.services.sceneManager?.persistentFor(this) ?? []) b.lateUpdate?.(sdt);
    for (const [c, b] of this.behaviours.withMethod('lateUpdate')) {
      if (!b.lateUpdate) continue;
      const node = this.graph.nodes.get(c.gameObject);
      if (node?.activeInHierarchy && c.m_Enabled !== 0 && this.started.has(b)) this.guard(`${c.script?.class ?? c.type}.LateUpdate`, () => b.lateUpdate!(sdt));
    }
    this.flushDestroy();
    this.services.beforeLayout?.(this);
    // 每格的排版：所在 Canvas 關掉的 layout root 延後（deferredLayout）
    this.relayout(true);
    // 粒子在排版之後推進（發射器的位置是這一格最後的），再發 Canvas.willRenderCanvases（UIParticle 烤網格）
    this.guard('ParticleSystem', () => this.particles.update(sdt, dt));
    this.guard('TrailRenderer', () => this.trails.update(sdt));
    for (const fn of willRenderCanvases) this.guard('Canvas.willRenderCanvases', () => fn(this));
    this.input.clear();
  }

  // ───────── 指標（螢幕像素，原點左下）與鍵盤 ─────────

  /** 這一幀按下的鍵（Input.GetKeyDown；檢視頁 keydown 事件寫入，tick 結束清空） */
  readonly input = new Set<string>();

  pointerMove(sx: number, sy: number): void {
    this.events.screenSize = this.screen;
    this.mouse.x = sx;
    this.mouse.y = sy;
    this.events.pointerMove(this.events.raycast(sx, sy, this.screen.w, this.screen.h), { x: sx, y: sy });
  }
  pointerDown(sx: number, sy: number, button = 0): void {
    this.events.screenSize = this.screen;
    this.mouse.x = sx;
    this.mouse.y = sy;
    this.events.pointerDown(this.events.raycast(sx, sy, this.screen.w, this.screen.h), button, { x: sx, y: sy });
  }
  pointerUp(sx: number, sy: number, button = 0): void {
    this.events.screenSize = this.screen;
    this.mouse.x = sx;
    this.mouse.y = sy;
    this.events.pointerUp(this.events.raycast(sx, sy, this.screen.w, this.screen.h), button, { x: sx, y: sy });
  }
  /** 滾輪（WheelEvent → scrollDelta，換算在 viewer/main.ts）。派給滑鼠停留處（pointerEnter）往上的 IScrollHandler。 */
  pointerScroll(sx: number, sy: number, scrollDelta: { x: number; y: number }): void {
    this.events.screenSize = this.screen;
    this.mouse.x = sx;
    this.mouse.y = sy;
    this.events.pointerScroll(this.events.raycast(sx, sy, this.screen.w, this.screen.h), scrollDelta, { x: sx, y: sy });
  }

  /** SendMouseEvents（MouseEvents.cs:92）。Unity 的 Player loop 裡它在腳本 Update 之後，檢視頁照那個順序呼叫 */
  sendMouseEvents(): void {
    this.mouseEvents.send();
  }

  /** 這一幀的按鍵邊緣狀態清掉（Input.GetMouseButtonDown／Up 只在那一幀為 true）。
   *  檢視頁在處理完滑鼠事件（uGUI 射線 → SendMouseEvents）之後呼叫 */
  endInputFrame(): void {
    this.mouse.leftDownThisFrame = false;
    this.mouse.leftUpThisFrame = false;
    this.mouse.rightDownThisFrame = false;
    this.mouse.scrollY = 0;
    this.mouse.buttonsDown?.fill(false);
    this.mouse.buttonsUp?.fill(false);
    this.keysUp.clear();
  }
}

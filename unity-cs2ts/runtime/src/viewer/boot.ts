// 通用的開機流程：讀匯入器的輸出（<base>/assets、<base>/scenes），建場景樹、排版、World（Awake／Start）、three.js 繪製端。
// 照 diceomancer-web 的 src/viewer/main.ts 的 bootScene，拿掉遊戲專屬的部分（戰鬥、FMOD、tooltip、手機寬版）：
// 那些由遊戲專案透過 BootOptions 給（registry、localization、audio、beforeLayout）。
import { SceneRenderer } from '../render/sceneRenderer';
import { startRenderThread, type RenderThread } from '../render/gfx/thread';
import { startVerifyThread } from '../render/gfx/verify';
import { renderPipelineOf } from '../render/cameraStack';
import { cameraHasTargetTexture, cameraTargetTexture } from '../csport/unityCamera';
import { cameraPostProcess } from '../csport/unityPostProcess';
import { lightmapOf } from '../csport/unityNative';
import { ShaderLibrary } from '../render/unityShader';
import { AssetDB, setImageLoader } from '../unity/assets';
import type { ClipAsset, ControllerAsset } from '../engine/animator';
import { World, type BehaviourRegistry } from '../engine/world';
import { SceneGraph, type SceneNode } from '../unity/scene';
import { setClassHierarchy } from '../unity/componentKind';
import type { Ref, SceneFile } from '../unity/types';
import { GameTextAssets } from '../font/textAssets';
import { generateText, getPreferredWidth } from '../text/index';
import { makePreferredExternal, textContextOf } from '../text/textContext';
import type { TmpComponentData } from '../text/types';
import { applyLocalization, Localization, type LocalizationSettings } from '../localization/localization';
import { setActiveWorld, setObjectStore } from '../csport/core';
import { ObjectStore } from '../unity/objectStore';
import { fetchJsonCached, fetchJsonOnce, installPacks } from '../unity/packs';
import { LoadSceneMode } from '../unity/scenes';
import { installApplicationFocus, installSceneEvents } from '../csport/unityScene';
import { mountAudio } from '../csport/unityAudio';
import { mountPersistent, mountStreaming } from '../csport/dotnetIO';
import { videoLayers } from '../csport/unityVideo';
import { UI_BEHAVIOURS } from '../ui/selectable';
import { SLIDER_BEHAVIOURS } from '../ui/slider';
import { TOGGLE_BEHAVIOURS } from '../ui/toggle';
import { SCROLLBAR_BEHAVIOURS } from '../ui/scrollbar';
import { SCROLLRECT_BEHAVIOURS } from '../ui/scrollRect';
import { DROPDOWN_BEHAVIOURS } from '../ui/tmpDropdown';

/** 執行環境內建的 uGUI 元件（Unity 原生、沒有遊戲的 C#）：每個遊戲都預設註冊，遊戲的 registry 可以蓋過 */
export const UNITY_UI_BEHAVIOURS: BehaviourRegistry = {
  ...UI_BEHAVIOURS,
  ...SLIDER_BEHAVIOURS,
  ...TOGGLE_BEHAVIOURS,
  ...SCROLLBAR_BEHAVIOURS,
  ...SCROLLRECT_BEHAVIOURS,
  ...DROPDOWN_BEHAVIOURS,
};

/** 全頁共用、換場景不重載的東西 */
export interface Shared {
  base: string;
  db: AssetDB;
  shaders: ShaderLibrary;
  controllers: Record<string, ControllerAsset>;
  clips: Record<string, ClipAsset>;
  project: { m_ActiveColorSpace: number };
  /** TMP 的素材；沒有字形資料（匯入器還沒跑 glyphs）時是 null，場景照樣畫，只是沒有文字 */
  textAssets: GameTextAssets | null;
  /** 轉換器 --hierarchy 輸出的繼承鏈（scenes/hierarchy.json）；沒有時子類別找不到基底的實作 */
  hierarchy: Record<string, string[]>;
  notes: string[];
}

export interface BootOptions {
  /** 遊戲腳本（類別名 → behaviour 工廠）：轉換器產生的類別經橋接層註冊，或手寫的執行環境元件（uGUI 的 Button 等） */
  registry?: BehaviourRegistry;
  /** Unity Localization 套件的在地化；遊戲沒用這個套件時給 emptyLocalization() */
  localization?: Localization;
  /** Application.version */
  version?: string;
  /** 音訊（遊戲專案自己的播放器，執行環境只轉交給腳本） */
  audio?: unknown;
  /** 每格重排之前的遊戲專屬調整（WorldServices.beforeLayout） */
  beforeLayout?: (world: World) => void;
  /** 不畫文字（像素比對用） */
  noText?: boolean;
  /** 存檔在瀏覽器 IndexedDB 裡的 key 前綴（bootGame；不同遊戲的存檔分開） */
  gameKey?: string;
  /**
   * render thread（render/gfx）：WebGL 呼叫交給 worker 的 OffscreenCanvas 執行，主執行緒只產生指令（照 Unity 的 render thread）。
   * 瀏覽器不支援時照舊在主執行緒畫。'verify' 是逐位元驗證（render/gfx/verify.ts：主執行緒照舊畫，worker 另外重播一份比像素）
   */
  renderThread?: boolean | 'verify';
}

export interface Session {
  readonly name: string;
  readonly canvas: HTMLCanvasElement;
  readonly world: World;
  readonly renderer: SceneRenderer;
  readonly graph: SceneGraph;
  /** render thread（沒開或不支援是 null） */
  readonly renderThread: RenderThread | null;
  /** render thread 落後兩格以上：主迴圈這個 rAF 先不跑（Unity 的主執行緒最多領先 render thread 一格） */
  busy(): boolean;
  frame(dt: number): void;
  draw(): void;
  resize(w: number, h: number): void;
  dispose(): void;
}

// project.json 這類素材庫也要讀的表共用同一份（unity/packs.ts）
const fetchJson = fetchJsonCached;

/** 沒用 Unity Localization 套件的遊戲：一個沒有表的在地化（場景裡也不會有 GameObjectLocalizer 等元件） */
export function emptyLocalization(projectLocale = 'en'): Localization {
  const settings = { projectLocale, locales: { [projectLocale]: { name: projectLocale, sortOrder: 0, fallback: [] } } } as unknown as LocalizationSettings;
  return Localization.fromData(settings, {}, {}, {}, projectLocale);
}

/** base：匯入器輸出的網址（例如 "./game/"） */
export async function loadShared(base: string): Promise<Shared> {
  const notes: string[] = [];
  // 匯入器打包過的檔（開機的依賴閉包）改從包裡拿，開機那幾包現在就開始抓
  await installPacks(base);
  const [db, shaders, controllers, clips, project, textAssets, hierarchy] = await Promise.all([
    AssetDB.load(`${base}assets/`),
    ShaderLibrary.load(`${base}shaders/`),
    fetchJson<Record<string, ControllerAsset>>(`${base}assets/animators.json`),
    fetchJson<Record<string, ClipAsset>>(`${base}assets/animations.json`),
    fetchJson<{ ProjectSettings?: { m_ActiveColorSpace: number } }>(`${base}assets/project.json`),
    GameTextAssets.load(`${base}assets/`).catch((e) => {
      notes.push(`沒有 TMP 字形資料，不畫文字（匯入器跑 glyphs）：${e instanceof Error ? e.message : e}`);
      return null;
    }),
    fetchJson<Record<string, string[]>>(`${base}scenes/hierarchy.json`).catch(() => {
      notes.push('沒有 scenes/hierarchy.json（轉換器 --hierarchy），遊戲的子類別用不到基底的實作');
      return {} as Record<string, string[]>;
    }),
  ]);
  const colorSpace = (project as Record<string, Record<string, Record<string, number>>>).ProjectSettings?.PlayerSettings?.m_ActiveColorSpace ?? 1;
  return { base, db, shaders, controllers, clips, project: { m_ActiveColorSpace: colorSpace }, textAssets, hierarchy, notes };
}

/** render thread：開了就把 2D 貼圖改成 worker 解碼（AssetDB 的影像載入） */
async function startGfx(canvas: HTMLCanvasElement, opts: BootOptions): Promise<RenderThread | null> {
  if (!opts.renderThread) return null;
  const gfx = opts.renderThread === 'verify' ? await startVerifyThread(canvas) : await startRenderThread(canvas);
  const load = gfx?.loadImage;
  setImageLoader(load ? (url) => load(url) : null);
  return gfx;
}

/** 建一個場景：載場景樹、在地化、排版、World（Awake／Start）、繪製端建置。回傳時還沒開始跑迴圈 */
export async function bootScene(shared: Shared, name: string, canvas: HTMLCanvasElement, size: { w: number; h: number }, opts: BootOptions = {}): Promise<Session> {
  const [file, gfx] = await Promise.all([fetchJsonOnce<SceneFile>(`${shared.base}scenes/${name}.json`), startGfx(canvas, opts)]);
  return createSession(shared, file, name, canvas, size, opts, gfx);
}

/** 場景檔（或 prefab 檔）裡 TMP 元件用到的字型 guid */
function fontGuidsOf(file: SceneFile): Set<string> {
  const fontGuids = new Set<string>();
  for (const c of Object.values(file.components)) {
    const k = c.script?.class ?? c.type;
    if (k === 'TextMeshProUGUI' || k === 'TextMeshPro') {
      const f = c.m_fontAsset as Ref;
      if (f && 'guid' in f) fontGuids.add(f.guid);
    }
  }
  return fontGuids;
}

/**
 * 從 build 的第一個場景開機（原版的開機流程：Build Settings 的場景 0，之後由遊戲腳本 SceneManager.LoadScene 換場景）。
 * 物件庫（unity/objectStore.ts）先載好 Resources 與場景的依賴閉包；World 的 services.loadScene 給相容層的 SceneManager 用：
 * 檔案與依賴載完後，在下一格開頭（腳本 Update 之前）併進同一個 World（unity/scenes.ts）。
 */
export async function bootGame(shared: Shared, canvas: HTMLCanvasElement, size: { w: number; h: number }, opts: BootOptions & { scene?: string | number } = {}): Promise<Session> {
  // render thread 跟物件庫一起準備（貼圖要在它好了之後才開始載，createSession 之前等它）
  const gfxReady = startGfx(canvas, opts);
  const store = await ObjectStore.load(shared.base);
  setObjectStore(store);
  // System.IO 的虛擬檔案系統：StreamingAssets（唯讀，預載文字檔）與存檔（IndexedDB）；聲音的表（csport/unityAudio.ts）
  await Promise.all([store.preloadResources(), mountStreaming(shared.base), mountPersistent(opts.gameKey ?? shared.base), mountAudio(shared.base)]);
  const { file, info } = await store.loadScene(opts.scene ?? 0);
  // prefab 裡的 TMP 用到的字型也先準備（Instantiate 是同步的，生出來就要畫得出字）
  const prepareFonts = async (files: SceneFile[]): Promise<void> => {
    if (opts.noText || !shared.textAssets) return;
    const all = new Set<string>();
    for (const f of files) for (const g of fontGuidsOf(f)) all.add(g);
    await shared.textAssets.prepare(all);
  };
  await prepareFonts(store.loadedPrefabs());
  const loc = opts.localization ?? emptyLocalization();
  const gfx = await gfxReady;
  // 場景載入服務在 world.start() 之前接上：開機場景的 Start 就可能 SceneManager.LoadScene（MT2 的 ScreenManager）
  return createSession(shared, file, info.name, canvas, size, opts, gfx, (world) => {
    world.scenes.registerInitial({ name: info.name, path: `Assets/${info.src}`, buildIndex: info.buildIndex, guid: info.guid });
    installSceneEvents(world);
    installApplicationFocus(world);
    world.services.loadScene = async (key, mode) => {
      const { file: f, info: i } = await store.loadScene(key);
      applyLocalization(f, loc);
      await prepareFonts([f, ...store.loadedPrefabs()]);
      return new Promise((resolve) => {
        world.beforeNextTick(() => resolve(world.scenes.load(f, { name: i.name, path: `Assets/${i.src}`, buildIndex: i.buildIndex, guid: i.guid }, mode ?? LoadSceneMode.Single)));
      });
    };
  });
}

async function createSession(
  shared: Shared,
  file: SceneFile,
  name: string,
  canvas: HTMLCanvasElement,
  size: { w: number; h: number },
  opts: BootOptions,
  gfx: RenderThread | null,
  beforeStart?: (world: World) => void,
): Promise<Session> {
  const { db, shaders, controllers, clips, project, textAssets } = shared;
  // 繪製端、遮罩、排版認得繼承 TMP 的遊戲類別（unity/componentKind.ts）
  setClassHierarchy(shared.hierarchy);
  const loc = opts.localization ?? emptyLocalization();
  applyLocalization(file, loc); // 在地化會改 RectTransform 的尺寸與位置，要在排版之前
  const graph = new SceneGraph(file);
  const text = opts.noText ? null : textAssets;
  if (text) await text.prepare(fontGuidsOf(file));
  const cam0 = graph.cameras.find((c) => c.node.activeInHierarchy && c.data.m_Enabled !== 0);
  const textEnv = { orthographic: cam0?.orthographic ?? true, linearColorSpace: project.m_ActiveColorSpace === 1 };
  const renderer = new SceneRenderer(canvas, { pipeline: renderPipelineOf(db.project as unknown as Record<string, unknown>), text: text ? { generate: generateText, assets: text } : undefined, gfx });
  renderer.cameraHasTarget = cameraHasTargetTexture;
  renderer.cameraTarget = cameraTargetTexture;
  renderer.setSize(size.w, size.h);
  renderer.placeholderSprites = true;
  const world = new World(graph, {
    localization: loc,
    version: opts.version ?? '',
    controllers,
    clips,
    registry: { ...UNITY_UI_BEHAVIOURS, ...opts.registry },
    hierarchy: shared.hierarchy,
    layout: {
      spriteOf: (c) => db.sprite(c.m_Sprite as Ref),
      external: text ? makePreferredExternal(text, textEnv) : null,
    },
    sortingLayerIndex: (id) => db.sortingLayerIndex(id),
    layerNames: (db.project.TagManager.TagManager as { layers?: string[] }).layers ?? [],
    audio: opts.audio ?? null,
    beforeLayout: opts.beforeLayout,
  });
  world.screen = { w: size.w, h: size.h };
  setActiveWorld(world);
  // async 方法（async void、沒人 await 的 Task）裡沒接到的例外：Unity 印到 Console、遊戲照跑，這裡記進 world.exceptions
  if (typeof window !== 'undefined')
    window.addEventListener('unhandledrejection', (e) => {
      e.preventDefault(); // reportException 自己印 console.error
      world.reportException('async', e.reason);
    });
  renderer.videoLayers = videoLayers;
  // shader 的 _Time：Time.timeSinceLevelLoad（相容層也是 world.time）與這一格的 deltaTime（smoothDeltaTime 相容層同 deltaTime）
  renderer.shaderTime = () => ({ time: world.time, deltaTime: world.deltaTime, smoothDeltaTime: world.deltaTime });
  // Post Processing v2：攝影機上有 PostProcessLayer 的，照 volume 混合後的設定畫後製（render/postProcess.ts）
  renderer.postProcess = cameraPostProcess(world);
  // 烘焙光照圖：遊戲設的 LightmapSettings.lightmaps 與 Renderer.lightmapIndex（MT2 的 PrefabLightmapData）
  renderer.lightmapOf = lightmapOf;
  // built-in 的光照照 active 場景的設定（RenderSettings、匯入器從 LightingData 帶出來的環境探針）；單一場景檢視沒有 active 場景，用場景檔自己的
  renderer.sceneLighting = () => {
    const settings = (world.scenes.active?.settings ?? graph.file.settings) as { RenderSettings?: Record<string, unknown>; LightingData?: { ambientProbe?: number[] } } | undefined;
    return { renderSettings: settings?.RenderSettings, ambientProbe: settings?.LightingData?.ambientProbe ?? null };
  };
  world.services.render = {
    sharedMaterial: (ref) => db.material(ref),
    rendererMaterial: (comp) => renderer.rendererMaterial(comp),
    preloadSprites: (refs) => renderer.preloadSprites(db, refs),
    spriteInfo: (ref) => db.sprite(ref),
    textureInfo: (ref) => (ref && 'guid' in ref ? db.textureInfo(ref.guid) : null),
    assetName: (ref) => db.assetName(ref),
    layoutText: (comp, node, withHook) => renderer.layoutText(comp, node, withHook),
    preferredWidth: text ? (node, comp) => getPreferredWidth(comp as unknown as TmpComponentData, textContextOf(node, comp as unknown as TmpComponentData, textEnv), text) : undefined,
    setRendererSpriteTexture: (comp, property, spriteRef) => renderer.setRendererSpriteTexture(comp, property, spriteRef),
    prewarmPrefabs: (files) => renderer.prewarmPrefabs(files),
    setTextHook: (comp, hook) => renderer.setTextHook(comp, hook),
    textResultOf: (comp) => renderer.textResultOf(comp),
  };
  // 執行時生成／銷毀的子樹進繪製端（建置前生的由 build 一起建）
  let built = false;
  let pending: Promise<unknown> = Promise.resolve();
  world.subtreeHooks = {
    added: (root: SceneNode) => {
      if (!built) return;
      // 貼圖先同時開始讀，建網格照佇列（sceneRenderer.ts 的 prefetchSubtree）
      renderer.prefetchSubtree(root);
      pending = pending.then(() => renderer.addSubtree(root));
    },
    removed: (root: SceneNode) => {
      if (built) renderer.removeSubtree(root);
    },
  };
  beforeStart?.(world);
  world.start();
  renderer.clips = world.clips;
  renderer.particles = world.particles;
  renderer.trails = world.trails;
  await renderer.preloadSprites(db, world.animatedSprites());
  await renderer.build(graph, db, shaders);
  built = true;
  renderer.frame();
  await renderer.settle();
  renderer.frame();
  renderer.render();
  return {
    name,
    canvas,
    world,
    renderer,
    graph,
    renderThread: gfx,
    busy: () => gfx?.busy() ?? false,
    // Unity 的 PlayerLoop：PreUpdate.SendMouseEvents 在腳本 Update 之前；同一格的按鍵邊緣用完才清
    frame(dt) {
      world.sendMouseEvents();
      world.tick(dt);
      world.endInputFrame();
    },
    draw() {
      renderer.frame();
      renderer.render();
    },
    resize(w, h) {
      renderer.resize(w, h);
      world.screen.w = w;
      world.screen.h = h;
      world.events.screenSize = world.screen;
      world.relayout();
    },
    dispose: () => renderer.dispose(),
  };
}

/**
 * 滑鼠與鍵盤接進 World（照 diceomancer-web 檢視頁的遊戲模式）：DOM 指標事件 → Unity 螢幕座標（繪圖緩衝像素、原點左下）→
 * world.mouse（Input.mousePosition 與 GetMouseButton 系，累積到下一格的 endInputFrame）與 uGUI 的指標事件（當下送）。
 * 按下時捕捉指標（Unity 在按住期間拿得到視窗外的移動與放開）。觸控的翻譯層（長按當懸停等）還沒搬，觸控照滑鼠送。回傳解除函式。
 */
export function attachInput(session: Session): () => void {
  const { canvas, world } = session;
  const toScreen = (e: PointerEvent): [number, number] => [(e.offsetX / canvas.clientWidth) * world.screen.w, world.screen.h - (e.offsetY / canvas.clientHeight) * world.screen.h];
  const down = (e: PointerEvent): void => {
    // 捕捉失敗（指標已經不在、合成的事件）不影響這次按下
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 沒有可捕捉的指標 */
    }
    const [sx, sy] = toScreen(e);
    world.mouse.x = sx;
    world.mouse.y = sy;
    if (e.button === 0) {
      world.mouse.leftDownThisFrame = true;
      world.mouse.leftPressed = true;
    }
    if (e.button === 2) world.mouse.rightDownThisFrame = true;
    const ub = UNITY_BUTTON[e.button];
    if (ub !== undefined && world.mouse.buttons && world.mouse.buttonsDown) {
      world.mouse.buttons[ub] = true;
      world.mouse.buttonsDown[ub] = true;
    }
    world.pointerDown(sx, sy, e.button);
  };
  const move = (e: PointerEvent): void => {
    const [sx, sy] = toScreen(e);
    world.mouse.x = sx;
    world.mouse.y = sy;
    world.pointerMove(sx, sy);
  };
  const up = (e: PointerEvent): void => {
    const [sx, sy] = toScreen(e);
    world.mouse.x = sx;
    world.mouse.y = sy;
    if (e.button === 0) {
      world.mouse.leftUpThisFrame = true;
      world.mouse.leftPressed = false;
    }
    const ub = UNITY_BUTTON[e.button];
    if (ub !== undefined && world.mouse.buttons && world.mouse.buttonsUp) {
      world.mouse.buttons[ub] = false;
      world.mouse.buttonsUp[ub] = true;
    }
    world.pointerUp(sx, sy, e.button);
  };
  const leave = (): void => world.events.pointerMove(null);
  const menu = (e: Event): void => e.preventDefault();
  // e.key 之外也記 e.code：左右 Shift 的 e.key 都是 'Shift'，KeyCode.LeftShift 要看 'ShiftLeft'
  const key = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    world.input.add(e.key);
    if (e.code) world.input.add(e.code);
    world.keysHeld.add(e.key);
    if (e.code) world.keysHeld.add(e.code);
  };
  const keyUp = (e: KeyboardEvent): void => {
    world.keysHeld.delete(e.key);
    world.keysUp.add(e.key);
    if (e.code) {
      world.keysHeld.delete(e.code);
      world.keysUp.add(e.code);
    }
  };
  const wheel = (e: WheelEvent): void => {
    // Input.mouseScrollDelta.y：一格約 ±1（瀏覽器的 deltaY 往下是正，Unity 往前／往上是正）
    world.mouse.scrollY += -Math.sign(e.deltaY);
  };
  const blur = (): void => world.keysHeld.clear();
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointerleave', leave);
  canvas.addEventListener('contextmenu', menu);
  canvas.addEventListener('wheel', wheel, { passive: true });
  window.addEventListener('keydown', key);
  window.addEventListener('keyup', keyUp);
  window.addEventListener('blur', blur);
  return () => {
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointerleave', leave);
    canvas.removeEventListener('contextmenu', menu);
    window.removeEventListener('keydown', key);
    window.removeEventListener('keyup', keyUp);
    window.removeEventListener('blur', blur);
    canvas.removeEventListener('wheel', wheel);
  };
}
/** 瀏覽器的 MouseEvent.button（0 左、1 中、2 右）→ Unity 的滑鼠按鍵（0 左、1 右、2 中） */
const UNITY_BUTTON: Record<number, number> = { 0: 0, 1: 2, 2: 1 };

/**
 * 原版的長寬比等比縮放、補黑邊（16:9 等）。回傳繪圖緩衝的像素尺寸。
 * aspect 給 null 是填滿視窗（手機版的原生解析度）：用版面的小數寬高，innerWidth 是整數
 * （測試手機 橫放 869.33 CSS px 給 869，乘 dpr 3 是 2607，螢幕是 2608）
 */
export function fitCanvas(canvas: HTMLCanvasElement, aspect: number | null = 16 / 9): { w: number; h: number } {
  const page = aspect === null ? document.documentElement.getBoundingClientRect() : null;
  const vw = page?.width || window.innerWidth;
  const vh = page?.height || window.innerHeight;
  const a = aspect ?? vw / vh;
  const w = Math.min(vw, vh * a);
  const h = w / a;
  canvas.style.position = 'absolute';
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.left = `${(vw - w) / 2}px`;
  canvas.style.top = `${(vh - h) / 2}px`;
  const dpr = window.devicePixelRatio || 1;
  return { w: Math.round(w * dpr), h: Math.round(h * dpr) };
}

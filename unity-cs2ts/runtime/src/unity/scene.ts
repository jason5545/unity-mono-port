// 場景樹：public/game/scenes/<場景>.json 載進來，算每個物件的世界矩陣（Unity 座標：左手系，x 右、y 上、z 往畫面裡）。
// RectTransform 的位置照錨點重算（build 存的 m_LocalPosition.xy 大多是 0，不能用，見 HANDOFF「0d」）；
// Screen Space - Camera 的 Canvas 根節點照攝影機擺放。

import { Matrix4, Quaternion, Vector3 } from 'three';
import { canvasScaleFactor, type CanvasScalerData } from '../ui/canvas';
import { UILayout, type ExternalLayoutElement, type LayoutReport } from '../ui/layout';
import { layoutRect, type Rect, ZERO_RECT } from '../ui/rectTransform';
import type { ComponentData, GameObjectData, RectTransformData, SceneFile, TransformData } from './types';
import { updateDrivenControls } from '../ui/drivenControls';

export interface CanvasInfo {
  node: SceneNode;
  data: ComponentData; // Canvas 元件
  renderMode: number; // 0 Overlay、1 ScreenSpaceCamera、2 WorldSpace
  scaleFactor: number;
  referencePixelsPerUnit: number;
  /**
   * Screen Space 的根 Canvas 的平面距離（元件的 m_PlaneDistance）；World Space 是 null（排序時用物件位置）。
   * Overlay（renderMode 0）在螢幕像素空間，這個值給繪製端：畫的時候放在攝影機前這個距離（sceneRenderer.drawWorld）、排序用它當深度。
   */
  planeDistance: number | null;
}

export interface SceneNode {
  id: string;
  go: GameObjectData;
  parent: SceneNode | null;
  children: SceneNode[];
  transform: TransformData;
  isRect: boolean;
  /** RectTransform 的 rect（自己的區域空間，原點是 pivot） */
  rect: Rect;
  world: Matrix4;
  activeInHierarchy: boolean;
  /** 往上最近的 Canvas（含自己） */
  canvas: CanvasInfo | null;
  /** 深度優先的順序，uGUI 同一個 Canvas 裡照這個順序畫 */
  order: number;
  /** 增量排版的快取（SceneGraph.layout 自己用）：上一次算 rect／world 時的輸入 */
  layoutCache?: LayoutCache;
  /**
   * 根物件所在的場景（unity/scenes.ts 的 LoadedScene；GameObject.scene）。只有根物件有，子物件沿 parent 往上找。
   * SceneGraph 不管內容，只在 attach 新的根時填 rootSceneTag（目前的 active 場景）。
   */
  scene?: unknown;
}

/**
 * 增量排版（SceneGraph.layout）每個節點記的東西。Unity 的 RectTransform 是寫入時 SetDirty、讀取時才重算；
 * 這裡的寫入點散在腳本、補間、Animator、轉換器產生的程式（直接改 m_AnchoredPosition 這類欄位），不一一攔截，
 * 改成排版時比對輸入：自己的 Transform／RectTransform 欄位與父節點都沒變、父節點的輸出也沒變，就沿用上一次的 rect 與世界矩陣。
 */
interface LayoutCache {
  /** m_LocalPosition(3)、m_LocalRotation(4)、m_LocalScale(3)，RectTransform 再加錨點、anchoredPosition、sizeDelta、pivot(10) */
  sig: Float64Array;
  parent: SceneNode | null;
  /** Canvas 元件的查表（go.components 換陣列或長度變了才重查） */
  comps: string[];
  compsLen: number;
  canvasComp: ComponentData | undefined;
  /**
   * 讀取時沿父物件鏈更新（SceneGraph.refreshChain）時輸出變了：鏈上只更新了一個子物件，其他子物件的輸入比對看不出父物件變過，
   * 下一次 layout 走到這裡時讓全部子物件重算，之後清掉
   */
  childrenStale: boolean;
  /** 停用時被 layout 跳過（期間父物件的輸出可能變過）：下一次算到它時一律當作輸入有變 */
  skipped: boolean;
}

const SIG_LEN = 20;

/** sig[i] 跟 v 不同就寫進去並回 true（NaN 視為相同，免得每格都當成有變） */
function sigSet(sig: Float64Array, i: number, v: number): boolean {
  const old = sig[i];
  if (old === v || (old !== old && v !== v)) return false;
  sig[i] = v;
  return true;
}

function rectEquals(a: Rect, b: Rect): boolean {
  return a === b || (a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

function matrixEquals(a: Matrix4, b: Matrix4): boolean {
  if (a === b) return true;
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i++) if (x[i] !== y[i]) return false;
  return true;
}

function canvasEquals(a: CanvasInfo | null, b: CanvasInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.node === b.node &&
    a.data === b.data &&
    a.renderMode === b.renderMode &&
    a.scaleFactor === b.scaleFactor &&
    a.referencePixelsPerUnit === b.referencePixelsPerUnit &&
    a.planeDistance === b.planeDistance
  );
}

export interface CameraInfo {
  node: SceneNode;
  data: ComponentData;
  orthographic: boolean;
  orthographicSize: number;
  fieldOfView: number;
  near: number;
  far: number;
}

/**
 * 這個 uGUI 元素所屬的 Canvas（含往上的父 Canvas）有沒有被停用（Canvas 元件的 enabled＝false）。停用的 Canvas 整個不畫，
 * 底下的 Graphic 的 depth 是 −1，GraphicRaycaster 也打不到（Graphic.depth、GraphicRaycaster.Raycast 的 depth == -1 判斷）。
 * MT2 的 CardUI.SetCardVisible 用這個藏卡（物件池裡的卡都是啟用的 GameObject）。巢狀 Canvas 跟著父 Canvas 停用（未查證）
 */
export function canvasDisabled(node: SceneNode): boolean {
  for (let cv = node.canvas; cv; cv = cv.node.parent?.canvas ?? null) if ((cv.data.m_Enabled as number | undefined) === 0) return true;
  return false;
}

/** 節點所在的場景（根物件的 scene 標記；子物件沿 parent 往上找） */
export function sceneTagOf(node: SceneNode): unknown {
  let n = node;
  while (n.parent) n = n.parent;
  return n.scene;
}

export class SceneGraph {
  readonly nodes = new Map<string, SceneNode>();
  /**
   * prefab 資產本身（還沒 Instantiate 的 prefab）的節點：Unity 的資產是載入記憶體、不在任何場景裡的物件樹，
   * 遊戲可以直接對它 GetComponentInChildren、讀元件屬性。這些節點不在 roots、不在 nodes（排版、繪製、Find 都看不到），
   * 只給 id 查詢（nodeById）。由 csport 的 prefab 資產物件建（buildDormant）。
   */
  readonly dormant = new Map<string, SceneNode>();
  readonly roots: SceneNode[] = [];
  readonly cameras: CameraInfo[] = [];
  /** Screen Space 的根 Canvas（rect 由螢幕決定，不由 RectTransform） */
  private screenRoots = new Set<SceneNode>();
  /**
   * 節點增刪、換父物件、元件增刪時加一（bumpStructure；換父物件是 bumpHierarchy）。排版、裁切、被驅動控制項掃全樹找候選的結果照它快取：
   * 候選清單只看「有沒有那種元件」，啟用與否每次照舊判斷。
   */
  structureVersion = 0;
  /**
   * 只在節點增刪、元件增刪時加一（換父物件不加）。「哪些節點有哪種元件」的候選清單照它快取（cached 的 'membership'）：
   * 清單照 nodes 的順序（登記順序），換父物件不改變成員也不改變順序。MT2 戰鬥的物件池一直換父物件（600 格 45 次），
   * 以前每次都讓四份候選清單重掃 1.4 萬個節點（合計約 17 ms）
   */
  membershipVersion = 0;
  /**
   * 任何節點的 activeInHierarchy 真的變了就加一（refreshHierarchy 比對新舊值、detach）。World.refreshEnables 的全掃靠它：
   * 沒變的格子，停用節點上的 behaviour 不用再看（上一次掃完它們都不在 enabled 裡）
   */
  activeVersion = 0;
  /**
   * 任何元件的 m_Enabled 被腳本改了就加一（Behaviour_set_enabled、Animator 曲線、直接寫欄位的原生 setter）。
   * World.refreshEnables 的全掃靠它跟 activeVersion 一起判斷「上一趟之後有沒有人動過啟用狀態」：
   * 兩個版本都沒變就整段跳過（MT2 戰鬥 10/18 量：每格 4985 次呼叫、狀態變化 0 次，花 1.09 ms）
   */
  enabledVersion = 0;
  private readonly structureCache = new Map<string, { version: number; value: unknown }>();
  /** 增量排版的統計（除錯用）：上一次 layout 重算了幾個節點 */
  lastLayoutRecomputed = 0;

  bumpStructure(): void {
    this.structureVersion++;
    this.membershipVersion++;
  }

  /** 只換了父物件（節點與元件都沒增減） */
  bumpHierarchy(): void {
    this.structureVersion++;
  }

  /**
   * 跟著版本失效的快取（掃全樹的候選清單）。dep 'structure'（預設）：任何結構變動都重建；
   * 'membership'：只在節點或元件增減時重建（結果只看哪些節點有哪種元件、照 nodes 的順序）
   */
  cached<T>(key: string, build: () => T, dep: 'structure' | 'membership' = 'structure'): T {
    const version = dep === 'membership' ? this.membershipVersion : this.structureVersion;
    const hit = this.structureCache.get(key);
    if (hit && hit.version === version) return hit.value as T;
    const value = build();
    this.structureCache.set(key, { version, value });
    return value;
  }

  /** 執行時期新增的根物件（Instantiate 到場景根、new GameObject）放進哪個場景：unity/scenes.ts 設成目前的 active 場景 */
  rootSceneTag: unknown = undefined;

  constructor(readonly file: SceneFile) {
    for (const r of file.roots) this.roots.push(this.buildNode(r, null));
    this.rescanCameras();
  }

  /** 攝影機清單照目前的樹重建（場景樹的順序）；同一個 Camera 元件沿用原本的 CameraInfo（繪製端拿著它比對身分） */
  rescanCameras(): void {
    const old = new Map(this.cameras.map((c) => [c.data, c]));
    this.cameras.length = 0;
    const visit = (node: SceneNode): void => {
      const cam = this.component(node, 'Camera');
      if (cam) {
        this.cameras.push(
          old.get(cam) ?? {
            node,
            data: cam,
            orthographic: !!cam.orthographic,
            orthographicSize: cam['orthographic size'] as number,
            fieldOfView: cam['field of view'] as number,
            near: cam['near clip plane'] as number,
            far: cam['far clip plane'] as number,
          },
        );
      }
      for (const c of node.children) visit(c);
    };
    for (const r of this.roots) visit(r);
  }

  /** GameObject 資料（file.gameObjects）建成節點，遞迴建子樹。建構時與執行時期新增（attach）共用 */
  /** 節點（場景裡的或 prefab 資產的）照 id 找 */
  nodeById(id: string): SceneNode | undefined {
    return this.nodes.get(id) ?? this.dormant.get(id);
  }

  /** prefab 資產的物件樹：file 裡已經放好資料，建成節點登記在 dormant（不接進 roots；activeInHierarchy 當作根在啟用的場景裡算） */
  buildDormant(goId: string): SceneNode {
    return this.buildNode(goId, null, this.dormant);
  }

  private buildNode(id: string, parent: SceneNode | null, into: Map<string, SceneNode> = this.nodes): SceneNode {
    const go = this.file.gameObjects[id];
    const tf = this.file.components[go.transform] as TransformData;
    const node: SceneNode = {
      id,
      go,
      parent,
      children: [],
      transform: tf,
      isRect: tf.type === 'RectTransform',
      rect: ZERO_RECT,
      world: new Matrix4(),
      activeInHierarchy: !!go.m_IsActive && (parent ? parent.activeInHierarchy : true),
      canvas: null,
      order: this.nodes.size,
    };
    into.set(id, node);
    node.children = go.children.map((c) => this.buildNode(c, node, into));
    return node;
  }

  /**
   * 執行時期新增：file.gameObjects／file.components 已經放好資料（unity/instantiate.ts 做），
   * 在這裡建成節點接進樹裡。回傳新子樹的根。要接著呼叫 layout() 才有 rect、世界矩陣與 canvas。
   */
  attach(goId: string, parent: SceneNode | null): SceneNode {
    const node = this.buildNode(goId, parent);
    if (parent) parent.children.push(node);
    else {
      this.roots.push(node);
      node.scene = this.rootSceneTag;
    }
    this.bumpStructure();
    this.refreshHierarchy();
    this.rescanCameras();
    return node;
  }

  /** 執行時期移除：把 node 這棵子樹的節點從樹與 nodes 裡拿掉（資料由 instantiate.ts 從 file 刪） */
  detach(node: SceneNode): void {
    const drop = (n: SceneNode): void => {
      for (const c of n.children) drop(c);
      this.nodes.delete(n.id);
      if (n.activeInHierarchy) this.activeVersion++;
      n.activeInHierarchy = false;
      n.children = [];
    };
    const list = node.parent ? node.parent.children : this.roots;
    const i = list.indexOf(node);
    if (i >= 0) list.splice(i, 1);
    drop(node);
    this.bumpStructure();
    this.refreshHierarchy();
    this.rescanCameras();
  }

  /** 第一個型別（或 MonoBehaviour 的類別名）符合的元件 */
  component(node: SceneNode, kind: string): ComponentData | undefined {
    for (const cid of node.go.components) {
      const c = this.file.components[cid];
      if (c.type === kind || c.script?.class === kind) return c;
    }
    return undefined;
  }

  components(node: SceneNode): ComponentData[] {
    return node.go.components.map((cid) => this.file.components[cid]);
  }

  /** 元件（含 Transform）的 fileID → 所在節點 */
  nodeOfComponent(fileID: string | undefined | null): SceneNode | undefined {
    const c = fileID ? this.file.components[fileID] : undefined;
    return c ? this.nodes.get(c.gameObject) : undefined;
  }

  /** GameObject.SetActive：改 m_IsActive，重算整棵樹的 activeInHierarchy */
  setActive(node: SceneNode, active: boolean): void {
    node.go.m_IsActive = active ? 1 : 0;
    this.refreshHierarchy();
  }

  /** Transform.SetSiblingIndex：改父物件的子物件順序（GameObject 的 children 與 Transform 的 m_Children 一起改），重算順序 */
  setSiblingIndex(node: SceneNode, index: number): void {
    const parent = node.parent;
    const list = parent ? parent.children : this.roots;
    const i = list.indexOf(node);
    if (i < 0) return;
    list.splice(i, 1);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, node);
    if (parent) {
      parent.go.children = list.map((n) => n.id);
      const tf = parent.transform as unknown as { m_Children?: { fileID: string }[] };
      if (tf.m_Children) tf.m_Children = list.map((n) => ({ fileID: n.go.transform }));
    }
    this.refreshHierarchy();
  }

  /** activeInHierarchy 與深度優先順序（uGUI 的繪製順序）照目前的樹重算 */
  refreshHierarchy(): void {
    let order = 0;
    let changed = false;
    const visit = (n: SceneNode, parentActive: boolean) => {
      const active = !!n.go.m_IsActive && parentActive;
      if (active !== n.activeInHierarchy) changed = true;
      n.activeInHierarchy = active;
      n.order = order++;
      for (const c of n.children) visit(c, active);
    };
    for (const r of this.roots) visit(r, true);
    if (changed) this.activeVersion++;
  }

  isScreenRoot(node: SceneNode): boolean {
    return this.screenRoots.has(node);
  }

  cameraByComponentId(fileID: string | undefined): CameraInfo | undefined {
    return this.cameras.find((c) => this.file.components[fileID ?? ''] === c.data);
  }

  /** 繪製端用的攝影機：第一個啟用中（自己與父層都啟用）且 m_Enabled 的 Camera（sceneRenderer.build 的選法；Overlay 的排版也用它，第 2 輪） */
  firstActiveCamera(): CameraInfo | null {
    return this.cameras.find((c) => c.node.activeInHierarchy && (c.data.m_Enabled as number) !== 0) ?? null;
  }

  /** Unity 的 Camera.main：場景順序裡第一個啟用、tag 是 MainCamera 的 Camera（GraphicRaycaster.eventCamera 的 fallback） */
  get mainCamera(): CameraInfo | null {
    for (const c of this.cameras) {
      if (c.node.go.m_IsActive === 1 && (c.data.m_Enabled as number) !== 0 && c.node.go.m_TagString === 'MainCamera') return c;
    }
    return null;
  }

  /**
   * 依螢幕大小算全部物件的 rect 與世界矩陣。
   * Screen Space - Camera 的 Canvas 要用攝影機的世界矩陣，所以先算攝影機所在的樹（攝影機不會在自己的 Screen Space - Camera Canvas 底下；
   * Overlay Canvas 底下可以有攝影機，Overlay 在像素空間、不靠攝影機）。
   *
   * 增量（10/15）：節點自己的 Transform／RectTransform 欄位、父物件都沒變，父物件的輸出（rect、世界矩陣、canvas）也沒變，
   * 就沿用上一次的結果，不重算（LayoutCache 的說明）。Screen Space 的根 Canvas 每次都重算（輸入是螢幕、CanvasScaler、攝影機），
   * 算出來跟上一次一樣就當作沒變。結果跟每次全部重算一個位元都不差：輸入相同、算法相同；force 給驗證用（verifyLayout）。
   *
   * 停用的子樹（activeInHierarchy false）不算（10/17）：沒有東西畫它，事件、射線、物理也跳過它；腳本讀它的 transform 時由
   * refreshChain 沿父物件鏈算（Unity 本來就是讀的時候才算）。MT2 戰鬥 1.4 萬個節點只有 3 千多個啟用。force 照舊全算。
   */
  layout(screenW: number, screenH: number, force = false): void {
    this.layoutRecomputed = 0;
    const visit = (node: SceneNode, parentWorld: Matrix4 | null, parentRect: Rect, parentCanvas: CanvasInfo | null, parentChanged: boolean) => {
      if (!force && !node.activeInHierarchy) {
        if (node.layoutCache) node.layoutCache.skipped = true;
        return;
      }
      let changed = this.layoutNode(node, parentWorld, parentRect, parentCanvas, parentChanged, screenW, screenH, force, false);
      const cache = node.layoutCache!;
      if (cache.childrenStale) {
        cache.childrenStale = false;
        changed = true;
      }
      for (const ch of node.children) visit(ch, node.world, node.isRect ? node.rect : ZERO_RECT, node.canvas, changed);
    };

    // 攝影機所在的根先算，Canvas 才拿得到攝影機的世界矩陣（根的順序只隨結構變，快取）
    const ordered = this.cached('layout.rootOrder', () => {
      const hasCamera = (n: SceneNode): boolean => this.cameras.some((c) => c.node === n) || n.children.some(hasCamera);
      return [...this.roots.filter(hasCamera), ...this.roots.filter((r) => !hasCamera(r))];
    });
    for (const r of ordered) visit(r, null, ZERO_RECT, null, false);
    this.lastLayoutRecomputed = this.layoutRecomputed;
  }

  /**
   * 只更新 node 與它的祖先（由根往下），跟 layout 同一套算法與快取。給讀 Transform／RectTransform 的時候用（World.refreshTransform）：
   * Unity 的 transform.position、RectTransform.rect 是讀的時候沿父物件鏈算出來的，不會因為讀一次就整棵樹重排、也不跑 uGUI 的自動排版。
   * 鏈上某個節點的輸出變了就記 childrenStale（它不在鏈上的子物件由下一次 layout 重算）。
   * Screen Space - Camera 的 Canvas 在鏈上時，先更新那台攝影機的鏈（layout 是靠根的順序先算攝影機）。
   */
  refreshChain(node: SceneNode, screenW: number, screenH: number): void {
    const chain: SceneNode[] = [];
    for (let n: SceneNode | null = node; n; n = n.parent) chain.push(n);
    let parentWorld: Matrix4 | null = null;
    let parentRect: Rect = ZERO_RECT;
    let parentCanvas: CanvasInfo | null = null;
    let parentChanged = false;
    for (let i = chain.length - 1; i >= 0; i--) {
      const n = chain[i];
      // 還沒排過版的節點（剛生出來）由 layoutNode 建快取
      if (this.layoutNode(n, parentWorld, parentRect, parentCanvas, parentChanged, screenW, screenH, false, true)) n.layoutCache!.childrenStale = true;
      parentChanged = n.layoutCache!.childrenStale;
      parentWorld = n.world;
      parentRect = n.isRect ? n.rect : ZERO_RECT;
      parentCanvas = n.canvas;
    }
  }

  /**
   * 一棵子樹（新生出來的、剛換父物件的）：先沿鏈算 root，再往下算整棵（停用的照 layout 跳過）。
   * Instantiate、SetParent 用它取代整棵樹 relayout（Unity 在這些時機不重排，讀的時候才算；uGUI 自動排版等每格結尾）
   */
  refreshSubtree(root: SceneNode, screenW: number, screenH: number): void {
    this.refreshChain(root, screenW, screenH);
    const visit = (node: SceneNode, parentChanged: boolean): void => {
      for (const ch of node.children) {
        if (!ch.activeInHierarchy) {
          if (ch.layoutCache) ch.layoutCache.skipped = true;
          continue;
        }
        let changed = this.layoutNode(ch, node.world, node.isRect ? node.rect : ZERO_RECT, node.canvas, parentChanged, screenW, screenH, false, true);
        const cache = ch.layoutCache!;
        if (cache.childrenStale) {
          cache.childrenStale = false;
          changed = true;
        }
        visit(ch, changed);
      }
    };
    const rootCache = root.layoutCache!;
    const stale = rootCache.childrenStale;
    rootCache.childrenStale = false;
    visit(root, stale);
  }

  /** layout 的重算計數（layout 開頭歸零） */
  private layoutRecomputed = 0;

  /**
   * 一個節點的 rect、世界矩陣與 canvas（layout 與 refreshChain 共用）。回傳輸出有沒有變（子物件要不要跟著重算）。
   * chain：refreshChain 呼叫的，Screen Space - Camera 的 Canvas 要先更新攝影機
   */
  private layoutNode(
    node: SceneNode,
    parentWorld: Matrix4 | null,
    parentRect: Rect,
    parentCanvas: CanvasInfo | null,
    parentChanged: boolean,
    screenW: number,
    screenH: number,
    force: boolean,
    chain: boolean,
  ): boolean {
    const tf = node.transform;
    let cache = node.layoutCache;
    let inputsChanged = force || parentChanged;
    if (!cache) {
      cache = node.layoutCache = { sig: new Float64Array(SIG_LEN), parent: node.parent, comps: node.go.components, compsLen: -1, canvasComp: undefined, childrenStale: false, skipped: false };
      inputsChanged = true;
    }
    if (cache.skipped) {
      cache.skipped = false;
      inputsChanged = true;
    }
    if (cache.comps !== node.go.components || cache.compsLen !== node.go.components.length) {
      cache.comps = node.go.components;
      cache.compsLen = node.go.components.length;
      const c = this.component(node, 'Canvas');
      if (c !== cache.canvasComp) inputsChanged = true;
      cache.canvasComp = c;
    }
    if (cache.parent !== node.parent) {
      cache.parent = node.parent;
      inputsChanged = true;
    }
    // 輸入比對：一律寫回 sig（不短路），下一次才比得準
    const sig = cache.sig;
    const p = tf.m_LocalPosition;
    const q = tf.m_LocalRotation;
    const s = tf.m_LocalScale;
    let ch = sigSet(sig, 0, p.x);
    ch = sigSet(sig, 1, p.y) || ch;
    ch = sigSet(sig, 2, p.z) || ch;
    ch = sigSet(sig, 3, q.x) || ch;
    ch = sigSet(sig, 4, q.y) || ch;
    ch = sigSet(sig, 5, q.z) || ch;
    ch = sigSet(sig, 6, q.w) || ch;
    ch = sigSet(sig, 7, s.x) || ch;
    ch = sigSet(sig, 8, s.y) || ch;
    ch = sigSet(sig, 9, s.z) || ch;
    if (node.isRect) {
      const rt = tf as RectTransformData;
      ch = sigSet(sig, 10, rt.m_AnchorMin.x) || ch;
      ch = sigSet(sig, 11, rt.m_AnchorMin.y) || ch;
      ch = sigSet(sig, 12, rt.m_AnchorMax.x) || ch;
      ch = sigSet(sig, 13, rt.m_AnchorMax.y) || ch;
      ch = sigSet(sig, 14, rt.m_AnchoredPosition.x) || ch;
      ch = sigSet(sig, 15, rt.m_AnchoredPosition.y) || ch;
      ch = sigSet(sig, 16, rt.m_SizeDelta.x) || ch;
      ch = sigSet(sig, 17, rt.m_SizeDelta.y) || ch;
      ch = sigSet(sig, 18, rt.m_Pivot.x) || ch;
      ch = sigSet(sig, 19, rt.m_Pivot.y) || ch;
    }
    if (ch) inputsChanged = true;

    const canvasComp = cache.canvasComp;
    const isRootCanvas = canvasComp && (!parentCanvas || !node.parent);
    const renderMode = (canvasComp?.m_RenderMode as number) ?? 2;
    if (canvasComp && isRootCanvas && renderMode !== 2) {
      // Screen Space：根 RectTransform 是 build 存成全 0 的那種，大小 = 螢幕 / scaleFactor
      this.layoutRecomputed++;
      const scaler = this.component(node, 'CanvasScaler') as unknown as CanvasScalerData | undefined;
      const scaleFactor = canvasScaleFactor(scaler, screenW, screenH);
      const w = screenW / scaleFactor;
      const h = screenH / scaleFactor;
      const rect = { x: -w / 2, y: -h / 2, width: w, height: h };
      this.screenRoots.add(node);
      const planeDistance = canvasComp.m_PlaneDistance as number;
      // Screen Space - Camera：放在 m_Camera 前 planeDistance、縮放到填滿畫面高度。
      // Overlay（renderMode 0，或沒有攝影機的 Screen Space - Camera，Unity 會退回 Overlay）：照 Unity 放在螢幕像素空間，
      // 位置 (寬/2, 高/2, 0)、縮放 scaleFactor，原點在左下。腳本讀到的 transform.position 是像素座標，掛在底下的物件
      // （MT2 的 Main Camera 就在 Overlay Canvas 底下）也照這個空間。繪製端畫的時候才換到攝影機前（sceneRenderer.drawWorld）。
      // 10/16 以前 Overlay 也用攝影機的數學（第 2 輪裁決 4），攝影機掛在 Canvas 底下時兩邊互相依賴，每格越飄越遠。
      const cam = renderMode === 1 ? this.cameraByComponentId((canvasComp.m_Camera as { fileID: string } | null)?.fileID) : undefined;
      const useCamera = renderMode === 1 && !!cam;
      // 攝影機停用時 layout 跳過了它的樹，一樣先沿鏈算
      if (useCamera && (chain || !cam!.node.activeInHierarchy)) this.refreshChain(cam!.node, screenW, screenH);
      const world = useCamera
        ? screenSpaceCameraMatrix(cam!, planeDistance, h)
        : new Matrix4().makeTranslation(screenW / 2, screenH / 2, 0).multiply(new Matrix4().makeScale(scaleFactor, scaleFactor, scaleFactor));
      const canvas: CanvasInfo = {
        node,
        data: canvasComp,
        renderMode: useCamera ? 1 : 0,
        scaleFactor,
        referencePixelsPerUnit: scaler?.m_ReferencePixelsPerUnit ?? 100,
        planeDistance,
      };
      let changed = inputsChanged;
      if (!rectEquals(node.rect, rect)) {
        node.rect = rect;
        changed = true;
      }
      if (!matrixEquals(node.world, world)) {
        node.world = world;
        changed = true;
      }
      if (!canvasEquals(node.canvas, canvas)) {
        node.canvas = canvas;
        changed = true;
      }
      return changed;
    }

    let changed = false;
    if (inputsChanged) {
      this.layoutRecomputed++;
      let position = new Vector3(p.x, p.y, p.z);
      let rect = node.rect;
      if (node.isRect) {
        const r = layoutRect(parentRect, tf as RectTransformData);
        rect = r.rect;
        position = new Vector3(r.localPosition.x, r.localPosition.y, p.z);
      }
      const local = new Matrix4().compose(position, new Quaternion(q.x, q.y, q.z, q.w), new Vector3(s.x, s.y, s.z));
      const world = parentWorld ? parentWorld.clone().multiply(local) : local;

      let canvas = parentCanvas;
      if (canvasComp) {
        // World Space 的根 Canvas，或巢狀 Canvas
        const scaler = this.component(node, 'CanvasScaler') as unknown as CanvasScalerData | undefined;
        canvas = {
          node,
          data: canvasComp,
          renderMode: parentCanvas && !isRootCanvas ? parentCanvas.renderMode : 2,
          scaleFactor: parentCanvas?.scaleFactor ?? 1,
          referencePixelsPerUnit: scaler?.m_ReferencePixelsPerUnit ?? parentCanvas?.referencePixelsPerUnit ?? 100,
          planeDistance: parentCanvas?.planeDistance ?? null,
        };
      }
      // 輸出跟上一次一樣就留舊的物件，子物件不必跟著重算
      if (node.isRect && !rectEquals(node.rect, rect)) {
        node.rect = rect;
        changed = true;
      }
      if (!matrixEquals(node.world, world)) {
        node.world = world;
        changed = true;
      }
      if (canvas !== node.canvas && !(canvasComp && canvasEquals(node.canvas, canvas))) {
        node.canvas = canvas;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * 驗證增量排版（?layoutcheck=1／測試用）：照目前的資料全部重算一次，跟現在的 rect、世界矩陣、canvas 比，回傳不一樣的節點。
   * 比完把原本的結果放回去（不改場景狀態）。
   */
  verifyLayout(screenW: number, screenH: number): { id: string; name: string; what: string }[] {
    const saved = new Map<SceneNode, { rect: Rect; world: Matrix4; canvas: CanvasInfo | null }>();
    for (const n of this.nodes.values()) saved.set(n, { rect: n.rect, world: n.world, canvas: n.canvas });
    this.layout(screenW, screenH, true);
    const out: { id: string; name: string; what: string }[] = [];
    for (const [n, s] of saved) {
      const what: string[] = [];
      // 停用的物件 layout 不算（讀的時候 refreshChain 才算），不比。上面全算時輸入的快取已經更新、輸出又放回舊的，
      // 記 skipped 讓之後第一次算到它時重算
      if (!n.activeInHierarchy) {
        n.rect = s.rect;
        n.world = s.world;
        n.canvas = s.canvas;
        if (n.layoutCache) n.layoutCache.skipped = true;
        continue;
      }
      if (n.isRect && !rectEquals(n.rect, s.rect)) what.push(`rect ${JSON.stringify(s.rect)} → ${JSON.stringify(n.rect)}`);
      if (!matrixEquals(n.world, s.world)) what.push(`world ${s.world.elements.join(',')} → ${n.world.elements.join(',')}`);
      if (!canvasEquals(n.canvas, s.canvas)) what.push('canvas');
      if (what.length) out.push({ id: n.id, name: n.go.m_Name, what: what.join('；') });
      n.rect = s.rect;
      n.world = s.world;
      n.canvas = s.canvas;
    }
    return out;
  }
}

export interface UILayoutOptions {
  /** TMP 文字的偏好尺寸 */
  external?: ExternalLayoutElement | null;
  /** Image 的 sprite（偏好尺寸用） */
  spriteOf?: UILayout['spriteOf'];
}

/**
 * 排版加上 uGUI 的自動排版（LayoutGroup、ContentSizeFitter）：先算一遍 rect（自動排版要知道 Canvas 大小），
 * 自動排版改 RectTransform 的資料，再算一遍 rect 與世界矩陣。defer 回 true 的 layout root 不排（report.deferred）。
 */
export function layoutWithUI(graph: SceneGraph, screenW: number, screenH: number, options: UILayoutOptions = {}, defer?: (root: SceneNode) => boolean): LayoutReport {
  updateDrivenControls(graph);
  graph.layout(screenW, screenH);
  const ui = new UILayout(graph, options.external ?? null, (n) => (graph.isScreenRoot(n) ? n.rect : null));
  ui.spriteOf = options.spriteOf ?? null;
  ui.rebuildAll(defer);
  // 自動排版沒改到任何 RectTransform（也沒跑腳本的排版）時，第二遍的輸入跟第一遍一樣，結果也一樣
  if (ui.wrote) graph.layout(screenW, screenH);
  return ui.report;
}

/**
 * 補排一個延後的 layout root（World.flushDeferredLayout）：先把子樹的 rect 算到最新（TMP 的偏好尺寸要用），
 * 跟 layoutWithUI 同一套 LayoutRebuilder.Rebuild，有改到 RectTransform 再算一次子樹的 rect 與世界矩陣
 */
export function rebuildLayoutRoot(graph: SceneGraph, root: SceneNode, screenW: number, screenH: number, options: UILayoutOptions = {}): void {
  graph.refreshSubtree(root, screenW, screenH);
  const ui = new UILayout(graph, options.external ?? null, (n) => (graph.isScreenRoot(n) ? n.rect : null));
  ui.spriteOf = options.spriteOf ?? null;
  ui.rebuild(root);
  if (ui.wrote) graph.refreshSubtree(root, screenW, screenH);
}

/** Screen Space - Camera：Canvas 放在攝影機前方 planeDistance，朝向跟攝影機一樣，縮放到剛好填滿畫面高度 */
export function screenSpaceCameraMatrix(cam: CameraInfo, planeDistance: number, canvasHeight: number): Matrix4 {
  const camPos = new Vector3();
  const camRot = new Quaternion();
  const camScale = new Vector3();
  cam.node.world.decompose(camPos, camRot, camScale);
  const forward = new Vector3(0, 0, 1).applyQuaternion(camRot); // Unity 攝影機看 +z
  const worldHeight = cam.orthographic
    ? 2 * cam.orthographicSize
    : 2 * planeDistance * Math.tan(((cam.fieldOfView * Math.PI) / 180) / 2);
  const s = worldHeight / canvasHeight;
  return new Matrix4().compose(camPos.clone().addScaledVector(forward, planeDistance), camRot, new Vector3(s, s, s));
}

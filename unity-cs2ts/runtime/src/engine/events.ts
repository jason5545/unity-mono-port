// uGUI 的指標事件（GraphicRaycaster、EventSystem、InputSystemUIInputModule 的滑鼠部分）。依據：反編譯 build 的 UnityEngine.UI.dll。
//
// 射線：每個根 Canvas 一條射線（有事件攝影機就是 Camera.ScreenPointToRay，正交與透視都可以；Overlay 是 (x, y, −100) 沿 +Z），
// 逐一檢查 Graphic（Image、RawImage、TextMeshProUGUI、Text）：射線打 Graphic 自己的平面（RectTransformUtility.RectangleContainsScreenPoint），
// 開著 raycastTarget、物件與元件都啟用、點落在 rect（扣掉 raycastPadding）裡、往上的 CanvasGroup 沒有關 blocksRaycasts。
// GraphicRaycaster.Raycast（反編譯 UnityEngine.UI.dll）的另外三條也照做：螢幕點在事件攝影機 viewport 外的整個 Canvas 不算、
// Graphic 位置比 farClipPlane 遠的不算、ignoreReversedGraphics（背對攝影機的不算）。
// 3D 碰撞器：攝影機上的 PhysicsRaycaster 照 Physics.RaycastAll 打（engine/raycast3d.ts），MT2 的房間與 SpawnPointUI 靠它。
// 多個命中照 EventSystem.RaycastComparer 排（不同 Raycaster 先比事件攝影機的 depth、sortOrderPriority，再比 sorting layer、
// sorting order、同一個根 Canvas 的繪製順序、距離），取最上面的。Physics2DRaycaster 還沒做。
// 進出（HandlePointerExitAndEnter）：舊目標往上到共同祖先之前都收 exit，新目標往上到共同祖先之前都收 enter。
// 點擊：按下時記住「往上第一個有 click handler 的物件」，放開時同一個才算點擊。
// 按下、放開、選取照 InputSystemUIInputModule.ProcessPointerButton 與 EventSystem.SetSelectedGameObject；
// 左、中、右鍵共用同一組 pointerPress（Unity 每個鍵各一組），這個遊戲只用左鍵。
//
// 拖曳（0g）：照 InputSystemUIInputModule.ProcessPointerButton（pointerDrag、initializePotentialDrag）與
// ProcessPointerButtonDrag（useDragThreshold、pixelDragThreshold、開始拖曳時 pointerPress 收 pointerUp 並失去點擊資格）。
// 放開時照 StandaloneInputModule.ReleaseMouse（反編譯 UnityEngine.UI.dll；MT2 的 CustomStandaloneInputModule 直接用它）：
// pointerUp → click → 有在拖就對放開處往上第一個 IDropHandler 送 drop → pointerDrag 收 endDrag。
// 還沒做：Image 的 alphaHitTestMinimumThreshold ＞0 的分支不做（永遠當成通過）。
// （Mask 的裁切 10/6 完成：ui/mask.ts 算 uGUI 的那組 stencil 值、render/sceneRenderer.ts 套成 GL 狀態；
//  RectMask2D 裁切與射線過濾 10/6 完成：ui/rectMask2d.ts）
// 捲動（0g）：ProcessPointerScroll（InputSystemUIInputModule.cs:815-823）從 pointerEnter 往上找 IScrollHandler 派送；
// scrollDelta 換算見 viewer/main.ts 的 wheel 監聽（瀏覽器 WheelEvent → Input System 的滾輪格數）。

import { Quaternion, Vector3 } from 'three';
import { canvasDisabled, type CameraInfo, type SceneGraph, type SceneNode } from '../unity/scene';
import { rectMaskRaycastValid } from '../ui/rectMask2d';
import { nearestCollider2DDistance } from './mouseEvents';
import { cameraBasis, cameraRay, cameraWorldToScreen, inCameraViewport, overlayRay, rayRectPlane, type Ray3 } from './screenRay';
import { raycastAll3D } from './raycast3d';
import type { ComponentData } from '../unity/types';

const GRAPHICS = new Set(['Image', 'RawImage', 'TextMeshProUGUI', 'Text']);

/**
 * 場景元件上 DLL 基底的虛擬屬性（Graphic.raycastTarget）：遊戲類別覆寫了 getter 就照覆寫（MT2 的 Coffee UIParticle 回永遠 false），
 * 沒覆寫回 undefined、照元件資料。engine 不依賴 csport，由 csport 載入時登記（setComponentVirtualGet）
 */
let componentVirtualGet: (comp: ComponentData, prop: string) => unknown = () => undefined;
export function setComponentVirtualGet(fn: (comp: ComponentData, prop: string) => unknown): void {
  componentVirtualGet = fn;
}
/** GraphicRaycaster 讀的 graphic.raycastTarget（虛擬屬性） */
function graphicRaycastTarget(comp: ComponentData): boolean {
  const v = componentVirtualGet(comp, 'raycastTarget');
  return v === undefined ? !!comp.m_RaycastTarget : !!v;
}

/** 一個根 Canvas 這次的射線：cam 是事件攝影機（Overlay 是 null） */
interface CanvasRay {
  cam: CameraInfo | null;
  ray: Ray3;
}

/** RaycastResult 裡排序用得到的部分（module 是 Raycaster 元件本身，比身分用） */
interface RaycastHitEntry {
  node: SceneNode;
  module: ComponentData;
  /** module.eventCamera.depth（沒有事件攝影機是 null） */
  camDepth: number | null;
  sortPrio: number;
  renderPrio: number;
  /** module.rootRaycaster（這裡用根 Canvas 節點；PhysicsRaycaster 用自己） */
  rootKey: unknown;
  layer: number;
  order: number;
  depth: number;
  distance: number;
}

/**
 * EventSystem.RaycastComparer（反編譯 UnityEngine.UI.dll EventSystem.cs:220-277）：不同 Raycaster 先比事件攝影機的 depth（大的在前，
 * 兩邊都有攝影機才比）、再比 sortOrderPriority、renderOrderPriority；之後比 sortingLayer、sortingOrder、同一個 rootRaycaster 才比 depth、
 * 比 distance（近的在前）。最後 Unity 比 index（加進結果的順序），這裡用繪製順序大的在前代替（同一個 GraphicRaycaster 裡 index 就是照 depth 由大到小）。
 */
function raycastComparer(a: RaycastHitEntry, b: RaycastHitEntry): number {
  if (a.module !== b.module) {
    if (a.camDepth !== null && b.camDepth !== null && a.camDepth !== b.camDepth) return b.camDepth - a.camDepth;
    if (a.sortPrio !== b.sortPrio) return b.sortPrio > a.sortPrio ? 1 : -1;
    if (a.renderPrio !== b.renderPrio) return b.renderPrio > a.renderPrio ? 1 : -1;
  }
  if (a.layer !== b.layer) return b.layer - a.layer;
  if (a.order !== b.order) return b.order - a.order;
  if (a.depth !== b.depth && a.rootKey === b.rootKey) return b.depth - a.depth;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return b.depth - a.depth;
}

/** Transform.forward（rotation × +Z，不含縮放） */
function forwardOf(node: SceneNode): Vector3 {
  const q = new Quaternion();
  node.world.decompose(new Vector3(), q, new Vector3());
  return new Vector3(0, 0, 1).applyQuaternion(q);
}

/** 送給控制項的指標事件（PointerEventData 的子集，events.ts 自己維護座標） */
export interface PointerEventDataLike {
  /** 目前滑鼠位置（繪圖緩衝像素，原點左下） */
  position: { x: number; y: number };
  /** 按下的位置（PointerEventData.pointerPressRaycast.screenPosition） */
  screenPosition: { x: number; y: number };
  /** PointerEventData.scrollDelta（OnScroll 讀取；ProcessPointerScroll 由輸入模組填入，本專案由 world.pointerScroll 給） */
  scrollDelta: { x: number; y: number };
  button: number;
  /** ProcessPointerButton 按下的時候設 true；Slider.OnInitializePotentialDrag 設 false（拖曳不用門檻） */
  useDragThreshold: boolean;
}

export interface PointerHandlers {
  onPointerEnter?(): void;
  onPointerExit?(): void;
  onPointerClick?(button: number): void;
  onPointerDown?(button: number, ev: PointerEventDataLike): void;
  onPointerUp?(button: number): void;
  /** ISelectHandler.OnSelect：data 是 SetSelectedGameObject 帶的事件資料（滑鼠按下選取時是 PointerEventData），沒帶就是 undefined */
  onSelect?(data?: unknown): void;
  onDeselect?(data?: unknown): void;
  /** IBeginDragHandler.OnBeginDrag（拖曳超過門檻、開始拖的那一幀） */
  onBeginDrag?(ev: PointerEventDataLike): void;
  /** IDragHandler.OnDrag */
  onDrag?(ev: PointerEventDataLike): void;
  /** IEndDragHandler.OnEndDrag（放開時，drop 之後） */
  onEndDrag?(ev: PointerEventDataLike): void;
  /** IDropHandler.OnDrop（拖著放開時，放開處往上第一個收得到的物件） */
  onDrop?(ev: PointerEventDataLike): void;
  /** IInitializePotentialDragHandler.OnInitializePotentialDrag */
  onInitializePotentialDrag?(ev: PointerEventDataLike): void;
  /** IScrollHandler.OnScroll */
  onScroll?(ev: PointerEventDataLike): void;
}

/** 物件上會收事件的東西（腳本移植的 Behaviour） */
export type HandlerLookup = (node: SceneNode) => PointerHandlers[];

export class EventSystem {
  private hovered: SceneNode[] = [];
  private enter: SceneNode | null = null;
  readonly notes = new Set<string>();
  currentSelected: SceneNode | null = null;
  private pointerPress: SceneNode | null = null;
  private pointerClick: SceneNode | null = null;
  private selecting = false;
  private eligibleForClick = false;
  readonly deselectOnBackgroundClick: boolean;
  /** canvasRenderer.cull 的查詢（RectClipRegistry.isCulled；world 建構時接線）。預設全部不 cull */
  cullCheck: (nodeId: string) => boolean = () => false;
  /** EventSystem.m_DragThreshold（EventSystem.cs:pixelDragThreshold，level1 存的是 10） */
  readonly pixelDragThreshold: number;
  /** PointerEventData 自己維護的座標與拖曳狀態（單一滑鼠指標，InputSystemUIInputModule 也是每指標一份） */
  position = { x: 0, y: 0 };
  private pressPosition = { x: 0, y: 0 };
  useDragThreshold = true;
  private pointerDrag: SceneNode | null = null;
  dragging = false;
  /** 檢視頁每次送事件都更新（world.pointerDown/Move/Up 帶螢幕尺寸） */
  screenSize = { w: 1920, h: 1080 };

  constructor(
    private readonly graph: SceneGraph,
    private readonly handlers: HandlerLookup,
    private readonly sortingLayerIndex: (id: number) => number,
    /** 類別 → 基底鏈（World.services.hierarchy）：遊戲自己的 Graphic 子類別（MT2 的 Graphic2DInvisRaycastTarget）也當射線目標 */
    private readonly hierarchy: () => Record<string, string[]> | undefined = () => undefined,
  ) {
    // InputSystemUIInputModule.m_DeselectOnBackgroundClick（level1 是 1）；找不到模組時照預設 true
    const module = Object.values(graph.file.components).find((c) => c.script?.class === 'InputSystemUIInputModule');
    const flag = module as { m_DeselectOnBackgroundClick?: number } | undefined;
    this.deselectOnBackgroundClick = flag ? flag.m_DeselectOnBackgroundClick !== 0 : true;
    const es = Object.values(graph.file.components).find((c) => c.script?.class === 'EventSystem') as { m_DragThreshold?: number } | undefined;
    this.pixelDragThreshold = es?.m_DragThreshold ?? 10;
  }

  /**
   * 螢幕像素（原點左下，跟 Unity 的 Input.mousePosition 一樣）→ 最上面的 Graphic 所在節點。
   * 排序照 EventSystem.RaycastComparer（com.unity.ugui EventSystem.cs）：sortingLayer → sortingOrder →
   * 同一個根 Canvas（rootRaycaster）才比 depth → 比 distance（離攝影機近的先；GraphicRaycaster.Raycast 的
   * Dot(forward, 位置 − 射線起點) ÷ Dot(forward, 射線方向)，負的不算）→ 最後照階層順序。
   * 10/15 牌組檢視之前 depth 不分根 Canvas 就比，World Space 的 Canvas 疊在一起時（ShowDeckCanvas z −60 與
   * TopUICanvas z −90）階層後面的會搶到點擊，原版是近的那個。
   */
  /** 元件是 Graphic（uGUI 的 Image、Text…，或遊戲自己繼承 Graphic 的類別） */
  private isGraphic(cls: string | undefined): boolean {
    if (!cls) return false;
    return GRAPHICS.has(cls) || (this.hierarchy()?.[cls] ?? []).includes('Graphic');
  }

  /**
   * 射線的候選：有 PhysicsRaycaster 或 Graphic 元件的節點，照 nodes 的順序（同掃全樹）。只隨節點與元件增減變（SceneGraph.cached 的
   * membership）；類別的基底鏈（hierarchy）換了也重建。啟用、canvas、元件開關每次照舊判斷。以前每次射線都掃 1.4 萬個節點：
   * MT2 的 InputManager.LateUpdate 每格叫 RaycastAll，手指拖動時每個 touch 事件又各一次（10/18 手機上量）
   */
  private candidateHierarchy: Record<string, string[]> | undefined = undefined;
  private candidateEpoch = 0;
  private raycastCandidates(): SceneNode[] {
    const h = this.hierarchy();
    if (h !== this.candidateHierarchy) {
      this.candidateHierarchy = h;
      this.candidateEpoch++;
    }
    return this.graph.cached(
      `events.raycastCandidates#${this.candidateEpoch}`,
      () => [...this.graph.nodes.values()].filter((n) => this.graph.components(n).some((c) => c?.script?.class === 'PhysicsRaycaster' || this.isGraphic(c?.script?.class))),
      'membership',
    );
  }

  raycast(sx: number, sy: number, screenW: number, screenH: number): SceneNode | null {
    return this.raycastAll(sx, sy, screenW, screenH)[0] ?? null;
  }
  /**
   * EventSystem.RaycastAll：全部 Raycaster 打到的節點，照 RaycastComparer 排好（最上面的在前）。
   * Raycaster：每個 Canvas 的 GraphicRaycaster（Graphic）、攝影機上的 PhysicsRaycaster（3D 碰撞器，engine/raycast3d.ts）。
   */
  raycastAll(sx: number, sy: number, screenW: number, screenH: number): SceneNode[] {
    const hits: RaycastHitEntry[] = [];
    const blocking = new Map<SceneNode, number>();
    const rays = new Map<SceneNode, CanvasRay | null>();
    const physics: { node: SceneNode; comp: ComponentData }[] = [];
    for (const node of this.raycastCandidates()) {
      if (!node.activeInHierarchy) continue;
      for (const c of this.graph.components(node)) if (c?.script?.class === 'PhysicsRaycaster' && c.m_Enabled !== 0) physics.push({ node, comp: c });
      if (!node.isRect || !node.canvas) continue;
      const canvas = node.canvas;
      const overlay = canvas.renderMode === 0;
      const graphic = this.graph.components(node).find((c) => this.isGraphic(c.script?.class) && c.m_Enabled !== 0 && graphicRaycastTarget(c));
      if (!graphic) continue;
      if (canvasDisabled(node)) continue; // Canvas 停用：Graphic.depth 是 −1，GraphicRaycaster.Raycast 跳過
      const raycaster = this.raycasterOf(canvas.node);
      if (!raycaster) continue;
      const root = this.rootCanvasNode(canvas.node);
      let cr = rays.get(root);
      if (cr === undefined) rays.set(root, (cr = this.canvasRay(root, sx, sy, screenW, screenH)));
      if (!cr) continue; // 螢幕點在事件攝影機的 viewport 外
      // 縮放是 0 的物件（例如隱藏中的選取裝飾）：Unity 的射線打不到退化的平面；three.js 對不可逆矩陣會回傳全 0，要先擋掉
      if (Math.abs(node.world.determinant()) < 1e-12) continue;
      // RectTransformUtility.RectangleContainsScreenPoint(graphic.rectTransform, sp, eventCamera, raycastPadding)：射線打 Graphic 自己的平面
      const p = rayRectPlane(cr.ray, node);
      if (!p) continue;
      const local = p.clone().applyMatrix4(node.world.clone().invert());
      const pad = (graphic.m_RaycastPadding as { x: number; y: number; z: number; w: number }) ?? { x: 0, y: 0, z: 0, w: 0 };
      const r = node.rect;
      if (local.x < r.x + pad.x || local.x > r.x + r.width - pad.z || local.y < r.y + pad.y || local.y > r.y + r.height - pad.w) continue;
      if (this.cullCheck(node.id)) {
        // GraphicRaycaster.Raycast :280：canvasRenderer.cull 的打不到
        continue;
      }
      const goPos = new Vector3().setFromMatrixPosition(node.world);
      // eventCamera.WorldToScreenPoint(graphic.rectTransform.position).z > farClipPlane 的不算
      if (cr.cam && cameraWorldToScreen(cr.cam, goPos, screenW, screenH).z > cr.cam.far) continue;
      if (!this.passesRaycastFilters(node, cr.ray)) continue;
      const goForward = forwardOf(node);
      if ((raycaster.m_IgnoreReversedGraphics as number | undefined) !== 0) {
        // ignoreReversedGraphics：Overlay 看 Graphic 的 forward 跟 +Z 同向；有攝影機看 Graphic 在近平面前面、而且背對攝影機
        if (cr.cam) {
          const { pos: camPos, forward: camForward } = cameraBasis(cr.cam);
          if (goPos.clone().sub(camPos).addScaledVector(camForward, -cr.cam.near).dot(goForward) < 0) continue;
        } else if (!(goForward.z > 0)) continue;
      }
      // Overlay：沒有事件攝影機，距離是 0，不看 blockingObjects（GraphicRaycaster.Raycast 的 eventCamera == null 分支）
      let distance = 0;
      if (cr.cam && !overlay) {
        // Dot(go.forward, go.position − ray.origin) ÷ Dot(go.forward, ray.direction)，負的（射線起點後面）不算
        const dn = goForward.dot(cr.ray.dir);
        distance = Math.abs(dn) < 1e-9 ? 0 : goForward.dot(goPos.clone().sub(cr.ray.origin)) / dn;
        if (distance < 0) continue;
        // blockingObjects（TwoD／All）：比最近的 2D 碰撞器遠（或一樣遠）的不算（GraphicRaycaster.Raycast 的 num4）
        if (distance >= this.blockingDistance(canvas.node, cr.cam, cr.ray, blocking)) continue;
      }
      // 巢狀 Canvas 沒開 overrideSorting 時用父 Canvas 的 sorting layer／order（Unity 手冊 Canvas 的 Override Sorting；繪製端同一套，sceneRenderer.sortingCanvasOf）。
      // 以前直接用最近的 Canvas 自己的值：牌庫畫面捲動區的巢狀 Canvas（order 0）被同畫面 order 33 的全螢幕 Overlay 蓋住，點不到卡
      let sortCanvas = canvas;
      while ((sortCanvas.data.m_OverrideSorting as number | undefined) !== 1 && sortCanvas.node.parent?.canvas) sortCanvas = sortCanvas.node.parent.canvas;
      const order = sortCanvas.data.m_SortingOrder as number;
      hits.push({
        node,
        module: raycaster,
        camDepth: cr.cam ? ((cr.cam.data.m_Depth as number | undefined) ?? 0) : null,
        // GraphicRaycaster.sortOrderPriority／renderOrderPriority：Overlay 是 Canvas 的 sortingOrder 與根 Canvas 的 renderOrder
        //（這裡用根 Canvas 的階層順序代替 renderOrder），其他是 int.MinValue
        sortPrio: overlay ? order : -Infinity,
        renderPrio: overlay ? root.order : -Infinity,
        rootKey: root,
        layer: this.sortingLayerIndex(sortCanvas.data.m_SortingLayerID as number),
        order,
        depth: node.order,
        distance,
      });
    }
    for (const { node, comp } of physics) this.physicsRaycast(node, comp, sx, sy, screenW, screenH, hits);
    hits.sort(raycastComparer);
    return hits.map((h) => h.node);
  }

  /**
   * PhysicsRaycaster.Raycast（反編譯 UnityEngine.UI.dll）：事件攝影機是同一個物件上的 Camera（沒有就 Camera.main）；
   * 螢幕點要在 camera.pixelRect 裡；射線長度 |(far − near) ÷ ray.direction.z|；圖層是 camera.cullingMask & m_EventMask；
   * m_MaxRayIntersections 0 是 Physics.RaycastAll，其他是 RaycastNonAlloc（最多那麼多個）。命中照距離排。
   */
  private physicsRaycast(node: SceneNode, comp: ComponentData, sx: number, sy: number, w: number, h: number, out: RaycastHitEntry[]): void {
    const own = this.graph.component(node, 'Camera');
    const cam = (own ? this.graph.cameras.find((c) => c.data === own) : undefined) ?? this.graph.mainCamera;
    if (!cam) return;
    if (!inCameraViewport(cam, sx, sy, w, h)) return;
    const ray = cameraRay(cam, sx, sy, w, h);
    const maxDistance = Math.abs(ray.dir.z) < 1e-6 ? Infinity : Math.abs((cam.far - cam.near) / ray.dir.z);
    const cullingMask = (cam.data.m_CullingMask as { m_Bits?: number } | undefined)?.m_Bits ?? -1;
    const eventMask = (comp.m_EventMask as { m_Bits?: number } | undefined)?.m_Bits ?? -1;
    let found = raycastAll3D(this.graph, ray.origin, ray.dir, maxDistance, cullingMask & eventMask, this.notes);
    const max = (comp.m_MaxRayIntersections as number | undefined) ?? 0;
    if (max > 0) found = found.slice(0, max);
    for (const hit of found) {
      out.push({
        node: hit.node,
        module: comp,
        camDepth: (cam.data.m_Depth as number | undefined) ?? 0,
        sortPrio: -Infinity,
        renderPrio: -Infinity,
        rootKey: comp,
        layer: this.sortingLayerIndex(0),
        order: 0,
        depth: 0,
        distance: hit.distance,
      });
    }
  }

  /**
   * 根 Canvas 這一次的射線（GraphicRaycaster.Raycast 開頭）：有事件攝影機就是 Camera.ScreenPointToRay（screenRay.ts；正交、透視都行），
   * 沒有（Overlay，或 World Space 找不到攝影機）是 RectTransformUtility.ScreenPointToRay(null, p)。
   * 螢幕點在事件攝影機 viewport 外回 null：這個 Canvas 一個都不算。
   */
  private canvasRay(root: SceneNode, sx: number, sy: number, w: number, h: number): CanvasRay | null {
    const cam = root.canvas?.renderMode === 0 ? null : this.eventCameraFor(root);
    if (!cam) return { cam: null, ray: overlayRay(sx, sy) };
    if (!inCameraViewport(cam, sx, sy, w, h)) return null;
    return { cam, ray: cameraRay(cam, sx, sy, w, h) };
  }

  /**
   * GraphicRaycaster 的 blockingObjects（GraphicRaycaster.cs Raycast 的 num4）：TwoD（1）、All（3）時是
   * Physics2D.GetRayIntersectionAll(ray, …, m_BlockingMask) 第一個命中的距離，否則 Infinity。3D 碰撞器沒做（ThreeD 的部分當成沒擋）。
   * 同一次射線每個 Canvas 算一次（cache）。
   */
  private blockingDistance(canvasNode: SceneNode, cam: CameraInfo, ray: Ray3, cache: Map<SceneNode, number>): number {
    const hit = cache.get(canvasNode);
    if (hit !== undefined) return hit;
    const r = this.graph.component(canvasNode, 'GraphicRaycaster');
    const mode = (r?.m_BlockingObjects as number | undefined) ?? 0;
    let d = Infinity;
    if (mode === 1 || mode === 3) {
      const mask = (r?.m_BlockingMask as { m_Bits?: number } | undefined)?.m_Bits ?? -1;
      d = nearestCollider2DDistance(this.graph, cam, ray.origin, ray.dir, mask);
    }
    if (mode === 2 || mode === 3) this.notes.add('射線：GraphicRaycaster 的 blockingObjects ThreeD（3D 碰撞器）還沒做');
    cache.set(canvasNode, d);
    return d;
  }

  /** Canvas 上啟用中的 GraphicRaycaster（沒有就 null：這個 Canvas 的 Graphic 打不到） */
  private raycasterOf(canvasNode: SceneNode): ComponentData | null {
    const r = this.graph.component(canvasNode, 'GraphicRaycaster');
    return r && r.m_Enabled !== 0 ? r : null;
  }

  /**
   * Graphic.Raycast（Graphic.cs:573-629）：從 Graphic 自己往上，每個 ICanvasRaycastFilter 都要通過；
   * 遇 overrideSorting 的 Canvas，那一層處理完就停（:589-592、:625）。
   * filter：CanvasGroup（:599-613 的 ignoreParentGroups 旗標）、Mask（Mask.cs:104，含自己那層）、
   * RectMask2D（RectMask2D.cs:147-154 含 padding，ui/rectMask2d.ts）。
   * Image（Image.cs:1251 alphaHitTestMinimumThreshold）＞0 的分支不做：永遠當成通過。
   * Mask、RectMask2D 都是 RectangleContainsScreenPoint：射線打各自的平面再比 rect。
   */
  private passesRaycastFilters(node: SceneNode, ray: Ray3): boolean {
    let ignoreFound = false;
    for (let n: SceneNode | null = node; n; n = n.parent) {
      let stopAfter = false;
      for (const c of this.graph.components(n)) {
        if ((c.m_OverrideSorting as number) !== 0 && this.graph.component(n, 'Canvas') === c) stopAfter = true;
        if (c.m_Enabled === 0) continue;
        // CanvasGroup 是原生元件（只有 type）；Mask／RectMask2D／Image 是 uGUI 的腳本（script.class）
        const cls = c.script?.class ?? c.type ?? '';
        if (cls === 'CanvasGroup') {
          if (ignoreFound) continue;
          if (c.m_IgnoreParentGroups) ignoreFound = true;
          if (c.m_BlocksRaycasts === 0) return false;
        } else if (cls === 'Mask') {
          if (!this.maskRectContains(n, ray)) return false;
        } else if (cls === 'RectMask2D') {
          if (!n.activeInHierarchy) continue;
          const p = rayRectPlane(ray, n);
          if (!p || !rectMaskRaycastValid(this.graph, n, p)) return false;
        } else if (cls === 'Image') {
          // Image.cs:1251 IsRaycastLocationValid 的 alphaHitTestMinimumThreshold ＞0 分支沒實作：
          // 照常通過（整個 rect），記一筆 note 讓繪製報告看得到。
          if ((c.m_AlphaHitTestMinimumThreshold as number) > 0) this.notes.add('Image 的 alphaHitTestMinimumThreshold 還沒做（當成整個 rect）');
        }
      }
      if (stopAfter) break;
    }
    return true;
  }

  /** Mask.IsRaycastLocationValid（:104-110）＝ RectangleContainsScreenPoint(rectTransform, sp, eventCamera)：射線打 Mask 自己的平面再比 rect（無 padding） */
  private maskRectContains(maskNode: SceneNode, ray: Ray3): boolean {
    if (!maskNode.activeInHierarchy) return true;
    if (Math.abs(maskNode.world.determinant()) < 1e-12) return false;
    const p = rayRectPlane(ray, maskNode);
    if (!p) return false;
    const q = p.applyMatrix4(maskNode.world.clone().invert());
    const r = maskNode.rect;
    return q.x >= r.x && q.x <= r.x + r.width && q.y >= r.y && q.y <= r.y + r.height;
  }

  /**
   * 巢狀 Canvas 的攝影機與 render mode 是繼承根 Canvas 的（Canvas.worldCamera／Canvas.renderMode 對子 Canvas
   * 回傳根的值）。TMP_Dropdown.SetupTemplate 建的清單 Canvas 與 CreateBlocker 建的 blocker Canvas 都沒有自己的
   * m_Camera（序列化資料裡是 null），射線與座標換算要往上找根 Canvas 才有攝影機。
   */
  private rootCanvasNode(canvasNode: SceneNode): SceneNode {
    let n = canvasNode;
    for (let p = n.parent; p; p = p.parent) if (this.graph.component(p, 'Canvas')) n = p;
    return n;
  }

  /** GraphicRaycaster.eventCamera（GraphicRaycaster.cs:114-124）：Overlay、或 ScreenSpaceCamera 沒設世界攝影機 → null；
   *  否則 worldCamera ?? Camera.main（World Space 常用）。回傳 null 表示這 Canvas 不走攝影機射線。 */
  private eventCameraFor(rootCanvas: SceneNode): CameraInfo | null {
    const comp = this.graph.component(rootCanvas, 'Canvas');
    if (!comp) return null;
    const renderMode = comp.m_RenderMode as number;
    const worldCamId = (comp.m_Camera as { fileID: string } | null | undefined)?.fileID;
    if (renderMode === 0 || (renderMode === 1 && !worldCamId)) return null;
    return worldCamId ? (this.graph.cameraByComponentId(worldCamId) ?? null) : this.graph.mainCamera;
  }

  /** 除錯介面（settings-check 算滑鼠位置用）：節點本地座標 → 螢幕像素（RectTransformUtility.WorldToScreenPoint(eventCamera, …)） */
  localPointToScreen(node: SceneNode, lx: number, ly: number): { x: number; y: number } | null {
    if (!node.canvas) return null;
    const w = this.screenSize.w;
    const h = this.screenSize.h;
    const p = new Vector3(lx, ly, 0).applyMatrix4(node.world);
    const root = this.rootCanvasNode(node.canvas.node);
    // Overlay：世界座標就是螢幕像素
    if (root.canvas?.renderMode === 0) return { x: p.x, y: p.y };
    const cam = this.eventCameraFor(root);
    if (!cam) return { x: p.x, y: p.y };
    const s = cameraWorldToScreen(cam, p, w, h);
    return { x: s.x, y: s.y };
  }

  private ancestors(n: SceneNode | null): SceneNode[] {
    const out: SceneNode[] = [];
    for (let p = n; p; p = p.parent) out.push(p);
    return out;
  }

  private send(node: SceneNode, fn: (h: PointerHandlers) => void) {
    for (const h of this.handlers(node)) fn(h);
  }

  /** 一趟指標移動：先進出（ProcessPointerMovement／HandlePointerExitAndEnter），再拖曳（ProcessPointerButtonDrag） */
  pointerMove(target: SceneNode | null, pos?: { x: number; y: number }): void {
    const prev = this.position;
    if (pos) this.position = pos;
    const moving = !pos || pos.x !== prev.x || pos.y !== prev.y; // PointerEventData.IsPointerMoving（delta ≠ 0）
    this.updateEnter(target);
    this.processDrag(moving);
  }

  /** ProcessPointerScroll（InputSystemUIInputModule.cs:815-823）：從 pointerEnter 往上找 IScrollHandler 派送。
   *  scrollDelta 已是輸入模組算好的 PointerEventData.scrollDelta（格數 × scrollDeltaPerTick）。 */
  pointerScroll(target: SceneNode | null, scrollDelta: { x: number; y: number }, pos?: { x: number; y: number }): void {
    if (pos) this.position = pos;
    const handler = this.scrollHandlerOf(target ?? this.enter);
    if (handler) this.send(handler, (h) => h.onScroll?.(this.eventData(0, scrollDelta)));
  }

  /** BaseInputModule.HandlePointerExitAndEnter */
  private updateEnter(target: SceneNode | null): void {
    if (target === this.enter) return;
    if (!target || !this.enter) {
      for (const n of this.hovered) this.send(n, (h) => h.onPointerExit?.());
      this.hovered = [];
      this.enter = null;
      if (!target) return;
    }
    const newChain = this.ancestors(target);
    const common = this.ancestors(this.enter).find((n) => newChain.includes(n)) ?? null;
    if (this.enter) {
      for (let t: SceneNode | null = this.enter; t && t !== common; t = t.parent) {
        this.send(t, (h) => h.onPointerExit?.());
        this.hovered = this.hovered.filter((x) => x !== t);
      }
    }
    this.enter = target;
    for (let t: SceneNode | null = target; t && t !== common; t = t.parent) {
      this.send(t, (h) => h.onPointerEnter?.());
      this.hovered.push(t);
    }
  }

  /** ProcessPointerButtonDrag（InputSystemUIInputModule.cs:790-817） */
  private processDrag(moving: boolean): void {
    if (!moving || this.pointerDrag === null) return;
    const ev = this.eventData(0);
    const dist = (this.pressPosition.x - this.position.x) ** 2 + (this.pressPosition.y - this.position.y) ** 2;
    if (!this.dragging && (!this.useDragThreshold || dist >= this.pixelDragThreshold * this.pixelDragThreshold)) {
      this.dragging = true;
      // IBeginDragHandler（OnInitializePotentialDrag 已在 pointerDown 跑過）；Slider 沒有 beginDrag，ScrollRect／Scrollbar 有
      this.send(this.pointerDrag, (h) => h.onBeginDrag?.(ev));
    }
    if (!this.dragging) return;
    if (this.pointerPress !== this.pointerDrag) {
      if (this.pointerPress) this.send(this.pointerPress, (h) => h.onPointerUp?.(0));
      this.eligibleForClick = false;
      this.pointerPress = null;
    }
    this.send(this.pointerDrag, (h) => h.onDrag?.(ev));
  }

  /** ExecuteEvents.GetEventHandler<IPointerClickHandler>：往上第一個有 click handler 的物件 */
  private clickHandlerOf(n: SceneNode | null): SceneNode | null {
    for (let p = n; p; p = p.parent) if (this.handlers(p).some((h) => h.onPointerClick)) return p;
    return null;
  }

  /** ExecuteEvents.GetEventHandler<ISelectHandler>：往上第一個有 select handler 的物件 */
  private selectHandlerOf(n: SceneNode | null): SceneNode | null {
    for (let p = n; p; p = p.parent) if (this.handlers(p).some((h) => h.onSelect)) return p;
    return null;
  }

  /** ExecuteEvents.GetEventHandler<IDragHandler>：往上第一個有 drag handler 的物件 */
  private dragHandlerOf(n: SceneNode | null): SceneNode | null {
    for (let p = n; p; p = p.parent) if (this.handlers(p).some((h) => h.onDrag)) return p;
    return null;
  }

  /** ExecuteEvents.ExecuteHierarchy(…, dropHandler) 會收到的物件：往上第一個有 drop handler 的 */
  private dropHandlerOf(n: SceneNode | null): SceneNode | null {
    for (let p = n; p; p = p.parent) if (this.handlers(p).some((h) => h.onDrop)) return p;
    return null;
  }

  /** ExecuteEvents.GetEventHandler<IScrollHandler>：往上第一個有 scroll handler 的物件 */
  private scrollHandlerOf(n: SceneNode | null): SceneNode | null {
    for (let p = n; p; p = p.parent) if (this.handlers(p).some((h) => h.onScroll)) return p;
    return null;
  }

  private eventData(button: number, scrollDelta?: { x: number; y: number }): PointerEventDataLike {
    return { position: { ...this.position }, screenPosition: { ...this.pressPosition }, button, useDragThreshold: this.useDragThreshold, scrollDelta: scrollDelta ?? { x: 0, y: 0 } };
  }

  /**
   * RectTransformUtility.ScreenPointToLocalPointInRectangle：所在根 Canvas 的射線（canvasRay 同一條，不看 viewport）打節點自己的平面，
   * 再換到節點本地座標（原點是 pivot）。打不到（平行或在射線起點後面）回 null。
   */
  screenPointToLocal(node: SceneNode, sx: number, sy: number, screenW: number, screenH: number): { x: number; y: number } | null {
    if (!node.canvas) return null;
    if (Math.abs(node.world.determinant()) < 1e-12) return null;
    const root = this.rootCanvasNode(node.canvas.node);
    const cam = root.canvas?.renderMode === 0 ? null : this.eventCameraFor(root);
    const p = rayRectPlane(cam ? cameraRay(cam, sx, sy, screenW, screenH) : overlayRay(sx, sy), node);
    if (!p) return null;
    const local = p.applyMatrix4(node.world.clone().invert());
    return { x: local.x, y: local.y };
  }

  /** EventSystem.SetSelectedGameObject：先 deselect 舊的、再 select 新的；alreadySelecting 擋重入 */
  /** EventSystem.SetSelectedGameObject(selected, data)：data 傳給 OnDeselect／OnSelect（沒給時 Unity 用一份 BaseEventData） */
  setSelected(selected: SceneNode | null, data?: unknown): void {
    if (this.selecting) {
      this.notes.add('SetSelectedGameObject 在選取中又被呼叫');
      return;
    }
    this.selecting = true;
    if (selected === this.currentSelected) {
      this.selecting = false;
      return;
    }
    if (this.currentSelected) this.send(this.currentSelected, (h) => h.onDeselect?.(data));
    this.currentSelected = selected;
    if (this.currentSelected) this.send(this.currentSelected, (h) => h.onSelect?.(data));
    this.selecting = false;
  }

  pointerDown(target: SceneNode | null, button = 0, pos?: { x: number; y: number }): void {
    if (pos) this.position = pos;
    // ProcessPointerButton（按下）：選取目標交給 GetEventHandler<ISelectHandler>（null ＝ 點背景）
    const sel = this.selectHandlerOf(target);
    if (sel !== this.currentSelected && (sel !== null || this.deselectOnBackgroundClick)) this.setSelected(null);
    // ExecuteHierarchy：往上第一個收得到 onPointerDown 的節點，它的所有 handler 都收
    this.pressPosition = { ...this.position };
    this.useDragThreshold = true;
    this.dragging = false;
    const ev = this.eventData(button);
    let press: SceneNode | null = null;
    for (let p = target; p; p = p.parent) {
      if (this.handlers(p).some((h) => h.onPointerDown)) {
        this.send(p, (h) => h.onPointerDown?.(button, ev));
        press = p;
        break;
      }
    }
    const click = this.clickHandlerOf(target);
    if (press === null) press = click;
    this.pointerPress = press;
    this.pointerClick = click;
    this.eligibleForClick = true;
    // pointerDrag ＝ GetEventHandler<IDragHandler>；有就跑 initializePotentialDrag（Slider 關門檻）。
    // C# 的 PointerEventData 是同一物件引用，handler 改 useDragThreshold 立即生效；
    // 這裡 eventData() 是副本，送完寫回 this.useDragThreshold，語義相同。
    this.pointerDrag = this.dragHandlerOf(target);
    if (this.pointerDrag) {
      this.send(this.pointerDrag, (h) => h.onInitializePotentialDrag?.(ev));
      this.useDragThreshold = ev.useDragThreshold;
    }
  }

  pointerUp(target: SceneNode | null, button = 0, pos?: { x: number; y: number }): void {
    if (pos) this.position = pos;
    // ProcessPointerButton（放開）：onPointerUp 給 pointerPress；按下與放開的點擊目標相同才算點擊
    const click = this.clickHandlerOf(target);
    const doClick = this.pointerClick !== null && this.pointerClick === click && this.eligibleForClick;
    if (this.pointerPress) this.send(this.pointerPress, (h) => h.onPointerUp?.(button));
    if (doClick && this.pointerClick) this.send(this.pointerClick, (h) => h.onPointerClick?.(button));
    // ReleaseMouse：有在拖就 ExecuteHierarchy(currentOverGo, dropHandler)，放開處往上第一個收得到 drop 的物件
    if (this.dragging && this.pointerDrag) {
      const drop = this.dropHandlerOf(target);
      if (drop) this.send(drop, (h) => h.onDrop?.(this.eventData(button)));
    }
    this.eligibleForClick = false;
    this.pointerPress = null;
    // 拖曳收尾：IEndDragHandler 給 pointerDrag（drop 之後）
    if (this.dragging && this.pointerDrag) this.send(this.pointerDrag, (h) => h.onEndDrag?.(this.eventData(button)));
    this.dragging = false;
    this.pointerDrag = null;
  }
}


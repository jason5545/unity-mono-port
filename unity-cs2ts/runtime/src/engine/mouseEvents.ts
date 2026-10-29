// Unity 舊版的滑鼠事件（OnMouseDown／Up／UpAsButton／Enter／Over／Exit／Drag）。
// 照 UnityCsReference 2022.3 的 Modules/InputLegacy/MouseEvents.cs（272 行，
// 下載在 reference/unitycs/MouseEvents.cs）移植：
//   - DoSendMouseEvents（:92-211）：清掉上一格的 hit、逐台攝影機把螢幕點變成射線、
//     找 2D／3D 碰撞器（2D 與 3D 是兩個獨立的 hit 槽，互不遮蔽），再 SendEvents。
//   - SendEvents（:217-270）：OnMouseDown／Drag／Up／UpAsButton 只看左鍵，而且收的是
//     「按下去那一格命中什麼」；OnMouseOver／Enter／Exit 看「這一格命中什麼」跟上一格是不是同一個。
//   - SendMessage（:21-24）：送給該 GameObject 上的元件（RequireReceiver 沒接也沒事），不往父物件傳。
//   - UpdateMouse（:60-83）：滑鼠位置與左鍵的三個狀態。
//
// 與原版的差異（會記在 world.notes）：
//   - 只做 2D 碰撞器（Box／Circle／Capsule／Polygon）。3D 碰撞器（level2 的骰盤）不做，這一段用不到。
//   - PolygonCollider2D 用匯出的 m_Points.m_Paths（本地座標，加 m_Offset；點落在任一條路徑的多邊形內（奇偶規則）就算命中）。
//     Claude Code 10/10 查過：level2 與全部 prefab 的 194 個 PolygonCollider2D 都有匯出（Enemy_Goose 9 條、286 點），
//     這裡舊版「沒匯出、打不到」的註解是錯的。未查證：多條路徑重疊或巢狀時 Unity 會不會挖洞；這裡不挖洞，落在任一條內就算。
//   - collider2DWorldBounds（給 tooltip 用，不影響命中判定）：Circle 是中心 ± 半徑 × 世界縮放；Box、Capsule 是 size 矩形四個角轉到世界座標後的 AABB；Polygon 是所有點的 AABB。旋轉的 Capsule 會比實際形狀的框大（未處理）。
//   - 2D 命中用「沿射線離起點最近」判定：射線（screenRay.ts 的 Camera.ScreenPointToRay，正交與透視都可以）打碰撞器所在的
//     z 平面，交點在攝影機 [near, far] 深度內才算。CameraRaycastHelper 不在公開的 UnityCsReference 裡，
//     PhysX2D 對沒有 Rigidbody2D 的 collider 實際查多厚的 z 範圍查不到。
//   - Camera.eventMask 沒有匯出（level2 相機上那個有 m_EventMask 欄位的元件是 uGUI 的
//     PhysicsRaycaster，而且掛在相機物件上、EventSystem 不會收它），原版預設是全部圖層。
//   - 舊版 Input 的按鍵狀態由檢視頁的 DOM 事件寫進 world.mouse；右鍵另外記一個
//     down-this-frame 給腳本在 Update 裡讀（Input.GetMouseButtonDown(1)）。
//   - 已銷毀的目標（Object.Destroy 之後）視同沒命中：C# 的 HitInfo 轉 bool 會檢查 target != null（:26-29），
//     銷毀後的 GameObject 比 null，所以不送 OnMouseExit／Up，也不送任何訊息。見 isLiveNode。

import { Vector3 } from 'three';
import { cameraBasis, cameraPixelRect, cameraRay } from './screenRay';
import type { World } from './world';
import type { CameraInfo, SceneGraph, SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';

/** GameObject.SendMessage 會呼叫的方法（OnMouse 系列；名稱照 C#） */
export interface MouseMessageHandlers {
  onMouseDown?(): void;
  onMouseUp?(): void;
  onMouseUpAsButton?(): void;
  onMouseEnter?(): void;
  onMouseOver?(): void;
  onMouseExit?(): void;
  onMouseDrag?(): void;
}

/** HitInfo（MouseEvents.cs:16-35）：命中的 GameObject ＋ 產生它的攝影機 */
export interface HitInfo {
  target: SceneNode | null;
  camera: CameraInfo | null;
}

const EMPTY: HitInfo = { target: null, camera: null };
/** m_CurrentHit 的三個槽（MouseEvents.cs:37-39）：0 GUI、1 3D、2 2D。1 這格永遠空（3D 碰撞器沒做） */
const HIT_INDEX_2D = 2;

/**
 * 節點還在不在場景裡（沒有被銷毀）。
 *
 * 可靠的欄位是 world.graph.nodes：unity/instantiate.ts 的 destroy 最後呼叫 graph.detach（scene.ts 的 detach），
 * detach 會把整棵子樹從 nodes 刪掉；這是唯一會刪 nodes 的地方（已用 grep 確認）。比對用「同一個物件」而不是 id：
 * 銷毀後同 id 若又被 attach 重建，會是新的 SceneNode，舊的參考不算數。
 *
 * 不能用的欄位：
 *   - activeInHierarchy：detach 會設成 false，但「只是停用」的物件也是 false，分不出來；
 *   - node.go.components：destroy 會刪掉 file.components 裡對應的元件，id 還在但查不到資料，
 *     讀 comp.m_Enabled 就是原本的 TypeError（world.graph.components 會回傳 undefined）；
 *   - node.go：destroy 之後仍然在記憶體裡，讀得到，不能用來判斷。
 */
export function isLiveNode(world: World, node: SceneNode): boolean {
  return world.graph.nodes.get(node.id) === node;
}

/** 目標已銷毀就當沒命中：回傳 EMPTY 的複本（C# 的 HitInfo bool 為 false） */
export function liveHit(world: World, hit: HitInfo): HitInfo {
  return hit.target && isLiveNode(world, hit.target) ? hit : { ...EMPTY };
}

/** 滑鼠狀態（Input.mousePosition ＋ GetMouseButton 系；檢視頁的 DOM 事件寫進來） */
export interface MouseState {
  /** Input.mousePosition：繪圖緩衝像素，原點左下 */
  x: number;
  y: number;
  /** Input.GetMouseButtonDown(0) */
  leftDownThisFrame: boolean;
  /** Input.GetMouseButton(0) */
  leftPressed: boolean;
  /** Input.GetMouseButtonUp(0)（ManaConverter.Update 讀） */
  leftUpThisFrame: boolean;
  /** Input.GetMouseButtonDown(1)：舊版 Input 沒有內建，遊戲腳本在 Update 裡讀的就是它 */
  rightDownThisFrame: boolean;
  /** Input.GetAxis("Mouse ScrollWheel") 的這一幀累計（正＝往前／往上；第 3 階段第九段第 3 輪：挑卡的捲動，CardManager.cs:154-158） */
  scrollY: number;
  /** 三個按鍵（0 左、1 右、2 中）各自的 GetMouseButton／Down／Up；沒給的環境（舊的測試）照 left／right 欄位 */
  buttons?: boolean[];
  buttonsDown?: boolean[];
  buttonsUp?: boolean[];
}

const COLLIDER_2D = new Set(['BoxCollider2D', 'CircleCollider2D', 'CapsuleCollider2D', 'PolygonCollider2D']);

export class MouseEventDispatcher {
  /** 滑鼠有沒有被舊版 GUI 用掉（SetMouseMoved；這個專案沒有 OnGUI，永遠 false） */
  private mouseUsed = false;
  private readonly lastHit: HitInfo[] = [{ ...EMPTY }, { ...EMPTY }, { ...EMPTY }];
  private readonly mouseDownHit: HitInfo[] = [{ ...EMPTY }, { ...EMPTY }, { ...EMPTY }];
  private readonly currentHit: HitInfo[] = [{ ...EMPTY }, { ...EMPTY }, { ...EMPTY }];
  /** 這一格實際派送過的訊息（除錯用：battle-check 驗「引擎沒收到輸入」時對照） */
  lastDispatch: { node: string; method: string }[] = [];

  constructor(private readonly world: World) {}

  markMoved(): void {
    this.mouseUsed = true;
  }

  /** 檢視頁的 DOM 事件呼叫：滑鼠位置（繪圖緩衝像素，原點左下） */
  setPosition(x: number, y: number): void {
    this.world.mouse.x = x;
    this.world.mouse.y = y;
  }

  /** DoSendMouseEvents（:92-211）＋ SendEvents（:217-270）。檢視頁在腳本 Update 之後呼叫 */
  send(): void {
    const st = this.world.mouse;
    // 換新的物件，不要在原來那個上 Object.assign：lastHit[i]／mouseDownHit[i] 存的是同一個參考，
    // 在原地清空會把「上一格命中的東西」一起清掉，OnMouseExit／OnMouseUp 就永遠不會送出來
    // （Unity 的 HitInfo 是 struct，賦值是複製，語意不同）。
    for (let i = 0; i < this.currentHit.length; i++) this.currentHit[i] = { ...EMPTY };
    if (!this.mouseUsed) {
      for (const cam of this.world.graph.cameras) {
        if (!cam.node.activeInHierarchy || cam.data.m_Enabled === 0) continue;
        const rect = this.cameraPixelRect(cam);
        if (st.x < rect.x0 || st.x > rect.x1 || st.y < rect.y0 || st.y > rect.y1) continue;
        // Did we hit any 2D colliders?（:188-202）
        const hit = this.raycast2D(cam, st.x, st.y);
        if (hit) this.currentHit[HIT_INDEX_2D] = { target: hit, camera: cam };
        // 攝影機清掉畫面（Skybox／SolidColor）時，沒打中就要把之前的命中清掉
        else if (cam.data.m_ClearFlags === 1 || cam.data.m_ClearFlags === 2) this.currentHit[HIT_INDEX_2D] = { ...EMPTY };
      }
    }
    this.lastDispatch = [];
    for (let i = 0; i < this.currentHit.length; i++) this.sendEvents(i, this.currentHit[i]);
    this.mouseUsed = false;
  }

  /**
   * 除錯（tooltip-check 找法力池沒被轉換區蓋住的懸停點）：螢幕點（原點左下，同 world.mouse）命中的 2D 碰撞器所在節點。
   * 規則同 send()：第一個覆蓋這一點的攝影機。純讀取，不送任何訊息。
   */
  pick2DAt(sx: number, sy: number): SceneNode | null {
    for (const cam of this.world.graph.cameras) {
      if (!cam.node.activeInHierarchy || cam.data.m_Enabled === 0) continue;
      const rect = this.cameraPixelRect(cam);
      if (sx < rect.x0 || sx > rect.x1 || sy < rect.y0 || sy > rect.y1) continue;
      return this.raycast2D(cam, sx, sy);
    }
    return null;
  }

  /** 螢幕點射線打 2D 碰撞器：回傳離攝影機最近的那個（null ＝ 沒打到） */
  private raycast2D(cam: CameraInfo, sx: number, sy: number): SceneNode | null {
    const { w, h } = this.world.screen;
    const ray = cameraRay(cam, sx, sy, w, h);
    return nearestCollider2D(this.world.graph, cam, ray.origin, ray.dir, -1)?.node ?? null;
  }

  /** Camera.pixelRect（m_NormalizedViewPortRect × 螢幕大小） */
  private cameraPixelRect(cam: CameraInfo): { x0: number; y0: number; x1: number; y1: number } {
    return cameraPixelRect(cam, this.world.screen.w, this.world.screen.h);
  }

  /** SendEvents（:217-270） */
  private sendEvents(i: number, hitAtFrame: HitInfo): void {
    const world = this.world;
    const st = world.mouse;
    // 上一格的回呼可能已經銷毀過這三個槽裡的目標（例如點選項把選項拿掉）：銷毀的一律視同沒命中，
    // 不然 OnMouseExit／OnMouseUp 會送到已銷毀的物件上。
    const hit = liveHit(world, hitAtFrame);
    this.lastHit[i] = liveHit(world, this.lastHit[i]);
    this.mouseDownHit[i] = liveHit(world, this.mouseDownHit[i]);
    if (st.leftDownThisFrame) {
      if (hit.target) {
        this.mouseDownHit[i] = hit;
        this.sendMessage(hit.target, 'OnMouseDown');
      }
    } else if (!st.leftPressed) {
      const down = this.mouseDownHit[i];
      if (down.target) {
        // 按下與放開命中同一個物件才有 OnMouseUpAsButton（:235-237）
        if (sameHit(hit, down)) this.sendMessage(down.target, 'OnMouseUpAsButton');
        this.sendMessage(down.target, 'OnMouseUp');
        this.mouseDownHit[i] = { ...EMPTY };
      }
    } else if (this.mouseDownHit[i].target) {
      this.sendMessage(this.mouseDownHit[i].target!, 'OnMouseDrag');
    }

    if (sameHit(hit, this.lastHit[i])) {
      if (hit.target) this.sendMessage(hit.target, 'OnMouseOver');
    } else {
      if (this.lastHit[i].target) this.sendMessage(this.lastHit[i].target!, 'OnMouseExit');
      if (hit.target) {
        this.sendMessage(hit.target, 'OnMouseEnter');
        this.sendMessage(hit.target, 'OnMouseOver');
      }
    }
    this.lastHit[i] = hit;
  }

  /** GameObject.SendMessage：送給該物件上所有「已建 behaviour 且元件自己啟用」的那幾個方法 */
  private sendMessage(node: SceneNode, method: string): void {
    const world = this.world;
    // 已銷毀的物件收不到訊息（見 isLiveNode）。每個方法前都重查：前一個回呼可能把它銷毀了，
    // 這時候剩下的元件不能再呼叫（destroy 也會把它們的 behaviour 從 world.behaviours 拿掉）。
    if (!isLiveNode(world, node)) return;
    for (const comp of world.graph.components(node)) {
      if (!isLiveNode(world, node)) return;
      if (!comp || comp.m_Enabled === 0) continue;
      const b = world.behaviours.get(comp) as (MouseMessageHandlers & Record<string, unknown>) | undefined;
      if (!b) continue;
      const fn = b[lowerFirst(method)];
      if (typeof fn === 'function') {
        this.lastDispatch.push({ node: node.go.m_Name, method });
        (fn as () => void).call(b);
      }
    }
  }
}

/** Unity 的訊息名是 OnMouseEnter 這種 PascalCase，behaviour 上的方法是小寫開頭的 onMouseEnter */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function sameHit(a: HitInfo, b: HitInfo): boolean {
  return a.target === b.target && a.camera === b.camera;
}

/**
 * Physics2D.GetRayIntersection（DoSendMouseEvents :188-202）與 GetRayIntersectionAll 的第一個（GraphicRaycaster 的
 * blockingObjects TwoD）：3D 射線打每個 2D 碰撞器所在的 z 平面（2D 物理在世界 XY 平面上，碰撞器在自己 transform 的 z），
 * 交點換到碰撞器本地座標比形狀。只算交點在攝影機 [near, far] 深度內的；回傳沿射線離起點最近的（distance 是射線參數，dir 是單位向量）。
 * 呼叫端的 Graphic 距離要用同一條射線量，兩邊才比得起來。
 */
export function nearestCollider2D(
  graph: SceneGraph,
  cam: CameraInfo,
  origin: Vector3,
  dir: Vector3,
  layerMask: number,
): { node: SceneNode; distance: number } | null {
  if (dir.z === 0) return null;
  const { pos: camPos, forward: camForward } = cameraBasis(cam);
  let best: { node: SceneNode; distance: number } | null = null;
  // 有 2D 碰撞器的節點只隨節點與元件增減變（SceneGraph.cached 的 membership，照 nodes 的順序）；啟用與否每次照舊判斷。
  // 每格（SendMouseEvents）掃 1.4 萬個節點，MT2 戰鬥占一格約 6%（10/18 量）
  const candidates = graph.cached(
    'mouseEvents.collider2D',
    () => [...graph.nodes.values()].filter((n) => graph.components(n).some((c) => COLLIDER_2D.has(c.type))),
    'membership',
  );
  for (const node of candidates) {
    if (!node.activeInHierarchy) continue;
    if ((layerMask & (1 << ((node.go.m_Layer as number) ?? 0))) === 0) continue;
    if (Math.abs(node.world.determinant()) < 1e-12) continue;
    for (const comp of graph.components(node)) {
      if (comp.m_Enabled === 0 || !COLLIDER_2D.has(comp.type)) continue;
      const distance = (node.world.elements[14] - origin.z) / dir.z;
      if (best && distance >= best.distance) continue;
      const hit = origin.clone().addScaledVector(dir, distance);
      const depth = hit.clone().sub(camPos).dot(camForward);
      if (depth < cam.near || depth > cam.far) continue;
      const local = hit.applyMatrix4(node.world.clone().invert());
      if (!containsPoint(comp, local)) continue;
      best = { node, distance };
    }
  }
  return best;
}

/** GraphicRaycaster 的 blockingObjects TwoD：第一個命中的距離，沒有命中回 Infinity（nearestCollider2D） */
export function nearestCollider2DDistance(graph: SceneGraph, cam: CameraInfo, origin: Vector3, dir: Vector3, layerMask: number): number {
  return nearestCollider2D(graph, cam, origin, dir, layerMask)?.distance ?? Infinity;
}

/** 點是否在這個 2D collider 的形狀內（p 已經換到 collider 物件的本地空間） */
function containsPoint(comp: ComponentData, p: Vector3): boolean {
  switch (comp.type) {
    case 'BoxCollider2D': {
      const o = (comp.m_Offset as { x: number; y: number }) ?? { x: 0, y: 0 };
      const s = (comp.m_Size as { x: number; y: number }) ?? { x: 1, y: 1 };
      return Math.abs(p.x - o.x) <= s.x / 2 && Math.abs(p.y - o.y) <= s.y / 2;
    }
    case 'CircleCollider2D': {
      const o = (comp.m_Offset as { x: number; y: number }) ?? { x: 0, y: 0 };
      const r = (comp.m_Radius as number) ?? 0.5;
      return (p.x - o.x) ** 2 + (p.y - o.y) ** 2 <= r * r;
    }
    case 'CapsuleCollider2D': {
      const o = (comp.m_Offset as { x: number; y: number }) ?? { x: 0, y: 0 };
      const s = (comp.m_Size as { x: number; y: number }) ?? { x: 1, y: 1 };
      const dir = (comp.m_Direction as number) ?? 0;
      // Box2D 的膠囊：size 含兩端的半圓，圓角半徑 = 短邊 / 2
      const r = (dir === 0 ? s.y : s.x) / 2;
      const half = Math.max(0, (dir === 0 ? s.x : s.y) / 2 - r);
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const along = dir === 0 ? Math.max(-half, Math.min(half, dx)) : Math.max(-half, Math.min(half, dy));
      return (dx - along) ** 2 + dy ** 2 <= r * r;
    }
    case 'PolygonCollider2D': {
      // m_Points.m_Paths：每條路徑是本地座標（不含 m_Offset）；落在任一條多邊形內就算命中（奇偶規則，見檔頭）
      const o = (comp.m_Offset as { x: number; y: number }) ?? { x: 0, y: 0 };
      for (const path of polygonPaths(comp)) if (pointInPolygon(p.x - o.x, p.y - o.y, path)) return true;
      return false;
    }
    default:
      return false;
  }
}

/** 2D 碰撞器的世界座標 AABB（Collider2D.bounds）。 */
export interface WorldBounds3 {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * Collider2D.bounds：把碰撞器的形狀點轉到世界座標後取 AABB。沒有形狀（路徑是空的）回 null。
 * node 是碰撞器所在的物件（Collider2D 的 transform）。Circle 見 circleWorldBounds；Capsule 用 size 矩形的 AABB（旋轉的 Capsule 會偏大，未處理）。
 */
export function collider2DWorldBounds(node: SceneNode, comp: ComponentData): WorldBounds3 | null {
  const o = (comp.m_Offset as { x: number; y: number }) ?? { x: 0, y: 0 };
  if (comp.type === 'CircleCollider2D') return circleWorldBounds(node, o, (comp.m_Radius as number) ?? 0.5);
  const local: { x: number; y: number }[] = [];
  if (comp.type === 'PolygonCollider2D') {
    for (const path of polygonPaths(comp)) for (const pt of path) local.push({ x: pt.x + o.x, y: pt.y + o.y });
  } else if (comp.type === 'BoxCollider2D' || comp.type === 'CapsuleCollider2D') {
    // Box 與 Capsule 都取 size 矩形的四個角轉到世界座標：Capsule 的外接框就是 size（裁決 6）
    const s = (comp.m_Size as { x: number; y: number }) ?? { x: 1, y: 1 };
    local.push({ x: o.x - s.x / 2, y: o.y - s.y / 2 }, { x: o.x + s.x / 2, y: o.y - s.y / 2 }, { x: o.x - s.x / 2, y: o.y + s.y / 2 }, { x: o.x + s.x / 2, y: o.y + s.y / 2 });
  } else {
    return null;
  }
  if (local.length === 0) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const pt of local) {
    const w = new Vector3(pt.x, pt.y, 0).applyMatrix4(node.world);
    min.x = Math.min(min.x, w.x);
    min.y = Math.min(min.y, w.y);
    min.z = Math.min(min.z, w.z);
    max.x = Math.max(max.x, w.x);
    max.y = Math.max(max.y, w.y);
    max.z = Math.max(max.z, w.z);
  }
  return { min, max };
}

/**
 * CircleCollider2D 的世界 AABB：中心（offset 經世界矩陣）± 半徑 × 世界縮放。旋轉不改圓的外接框；世界縮放取局部 x、y 軸變換後長度的較大者
 * （等比縮放時兩者相同；非等比縮放的 Unity 規則未查證）。z 取中心的 z。
 */
function circleWorldBounds(node: SceneNode, o: { x: number; y: number }, radius: number): WorldBounds3 {
  const m = node.world;
  const origin = new Vector3(0, 0, 0).applyMatrix4(m);
  const sx = new Vector3(1, 0, 0).applyMatrix4(m).sub(origin).length();
  const sy = new Vector3(0, 1, 0).applyMatrix4(m).sub(origin).length();
  const R = radius * Math.max(sx, sy);
  const c = new Vector3(o.x, o.y, 0).applyMatrix4(m);
  return { min: { x: c.x - R, y: c.y - R, z: c.z }, max: { x: c.x + R, y: c.y + R, z: c.z } };
}

function polygonPaths(comp: ComponentData): { x: number; y: number }[][] {
  const pts = comp.m_Points as { m_Paths?: { x: number; y: number }[][] } | undefined;
  return pts?.m_Paths ?? [];
}

/** 點是否在多邊形內（奇偶規則；x、y 已經是多邊形的本地座標） */
function pointInPolygon(x: number, y: number, path: readonly { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const a = path[i]!;
    const b = path[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// 透視攝影機的射線、3D 碰撞器（Physics.RaycastAll）、PhysicsRaycaster、拖放（2026/10/16，MT2 新手戰鬥的出牌：
// 把卡從手牌拖到房間的 SpawnPointUI；房間是 BoxCollider ＋ GameUISelectable，GameCamera 上的 PhysicsRaycaster 打它們）
import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { World, type Behaviour } from './world';
import { SceneGraph, type CameraInfo, type SceneNode } from '../unity/scene';
import type { ComponentData, SceneFile } from '../unity/types';
import { cameraRay, cameraWorldToScreen, rayRectPlane } from './screenRay';
import { raycast3D, raycastAll3D } from './raycast3d';

const SCREEN = { w: 1920, h: 1080 };

function camInfo(pos: Vector3, comp: Partial<ComponentData> = {}): CameraInfo {
  const node = { world: new Matrix4().compose(pos, new Quaternion(), new Vector3(1, 1, 1)) } as SceneNode;
  return { node, data: { type: 'Camera', ...comp } as ComponentData, orthographic: false, orthographicSize: 5, fieldOfView: 60, near: 0.3, far: 1000 };
}

describe('screenRay：Camera.ScreenPointToRay 與 WorldToScreenPoint', () => {
  it('透視：畫面中央沿前方、起點在近平面；上緣的射線張開半個 fov', () => {
    const cam = camInfo(new Vector3(0, 0, -10));
    const mid = cameraRay(cam, 960, 540, SCREEN.w, SCREEN.h);
    expect(mid.dir.toArray().map((v) => +v.toFixed(6))).toEqual([0, 0, 1]);
    expect(mid.origin.z).toBeCloseTo(-9.7, 6);
    const top = cameraRay(cam, 960, 1080, SCREEN.w, SCREEN.h);
    expect(Math.atan2(top.dir.y, top.dir.z)).toBeCloseTo(Math.PI / 6, 6);
    // 起點的深度（沿前方）是 near
    expect(top.origin.z - -10).toBeCloseTo(0.3, 6);
  });
  it('透視：WorldToScreenPoint 與 ScreenPointToRay 互為反向', () => {
    const cam = camInfo(new Vector3(1, 2, -10));
    const p = new Vector3(3.5, -1.25, 7);
    const s = cameraWorldToScreen(cam, p, SCREEN.w, SCREEN.h);
    expect(s.z).toBeCloseTo(17, 6);
    const ray = cameraRay(cam, s.x, s.y, SCREEN.w, SCREEN.h);
    const t = p.clone().sub(ray.origin).dot(ray.dir);
    expect(ray.origin.clone().addScaledVector(ray.dir, t).distanceTo(p)).toBeLessThan(1e-6);
  });
  it('正交：照舊從攝影機平面平移到螢幕點，方向是前方', () => {
    const cam = { ...camInfo(new Vector3(0, 0, -10)), orthographic: true, orthographicSize: 5 };
    const r = cameraRay(cam, 1920, 1080, SCREEN.w, SCREEN.h);
    expect(r.origin.toArray()).toEqual([(5 * 1920) / 1080, 5, -10]);
    expect(r.dir.toArray()).toEqual([0, 0, 1]);
  });
  it('rayRectPlane：交點在射線起點後面就是打不到（Plane.Raycast 的 enter ＞0）', () => {
    const node = { world: new Matrix4().makeTranslation(0, 0, -20) } as SceneNode;
    expect(rayRectPlane({ origin: new Vector3(0, 0, -10), dir: new Vector3(0, 0, 1) }, node)).toBeNull();
    const front = { world: new Matrix4().makeTranslation(0, 0, 5) } as SceneNode;
    expect(rayRectPlane({ origin: new Vector3(1, 2, -10), dir: new Vector3(0, 0, 1) }, front)?.toArray()).toEqual([1, 2, 5]);
  });
});

// ───────── 合成場景：一台透視攝影機（掛 PhysicsRaycaster）、幾個 BoxCollider ─────────

interface Obj {
  name: string;
  pos?: [number, number, number];
  rot?: [number, number, number, number];
  scale?: [number, number, number];
  layer?: number;
  comps: Partial<ComponentData>[];
}
function scene(objs: Obj[]): SceneFile {
  const file: SceneFile = { guid: 'g', name: 's', src: 's.unity', settings: {}, roots: [], gameObjects: {}, components: {} };
  let next = 1;
  objs.forEach((o, i) => {
    const go = String(1000 + i);
    const tf = String(next++);
    const pos = o.pos ?? [0, 0, 0];
    const rot = o.rot ?? [0, 0, 0, 1];
    const sc = o.scale ?? [1, 1, 1];
    file.components[tf] = {
      type: 'Transform',
      gameObject: go,
      m_LocalPosition: { x: pos[0], y: pos[1], z: pos[2] },
      m_LocalRotation: { x: rot[0], y: rot[1], z: rot[2], w: rot[3] },
      m_LocalScale: { x: sc[0], y: sc[1], z: sc[2] },
      m_Children: [],
      m_Father: null,
    } as unknown as ComponentData;
    const ids = [tf];
    for (const c of o.comps) {
      const id = String(next++);
      file.components[id] = { m_Enabled: 1, gameObject: go, ...c } as ComponentData;
      ids.push(id);
    }
    file.gameObjects[go] = { m_Name: o.name, m_IsActive: 1, m_Layer: o.layer ?? 0, m_TagString: 'Untagged', transform: tf, parent: null, children: [], components: ids };
    file.roots.push(go);
  });
  return file;
}
const camera = (depth: number): Partial<ComponentData> => ({
  type: 'Camera',
  orthographic: 0,
  'field of view': 60,
  'near clip plane': 0.3,
  'far clip plane': 1000,
  m_Depth: depth,
  m_CullingMask: { m_Bits: -1 },
  m_NormalizedViewPortRect: { x: 0, y: 0, width: 1, height: 1 },
});
const physicsRaycaster: Partial<ComponentData> = { type: 'MonoBehaviour', script: { class: 'PhysicsRaycaster' } as never, m_EventMask: { m_Bits: -1 }, m_MaxRayIntersections: 0 };
const box = (size: [number, number, number] = [2, 2, 0.2], center: [number, number, number] = [0, 0, 0]): Partial<ComponentData> => ({
  type: 'BoxCollider',
  m_Size: { x: size[0], y: size[1], z: size[2] },
  m_Center: { x: center[0], y: center[1], z: center[2] },
});
const handler = (cls: string): Partial<ComponentData> => ({ type: 'MonoBehaviour', script: { class: cls } as never });

function world(file: SceneFile, registry: Record<string, (ctx: { node: SceneNode }) => Behaviour> = {}): World {
  const w = new World(new SceneGraph(file), {
    localization: undefined as never,
    version: 'test',
    controllers: {},
    clips: {},
    registry: registry as never,
    layout: {},
    sortingLayerIndex: () => 0,
  });
  w.screen = { ...SCREEN };
  w.events.screenSize = { ...SCREEN };
  w.start();
  w.relayout();
  return w;
}

describe('raycast3d：Physics.RaycastAll 打 BoxCollider／SphereCollider', () => {
  it('打到盒子的前面，距離沿射線量；起點在盒子裡的不算；照距離排', () => {
    const w = world(
      scene([
        { name: 'Near', pos: [0, 0, 0], comps: [box([2, 2, 0.2])] },
        { name: 'Far', pos: [0, 0, 5], comps: [box([2, 2, 2])] },
        { name: 'Around', pos: [0, 0, -10], comps: [box([1, 1, 1])] },
      ]),
    );
    const hits = raycastAll3D(w.graph, new Vector3(0, 0, -10), new Vector3(0, 0, 1), Infinity, -1);
    expect(hits.map((h) => h.node.go.m_Name)).toEqual(['Near', 'Far']);
    expect(hits[0]!.distance).toBeCloseTo(9.9, 6);
    expect(hits[1]!.distance).toBeCloseTo(14, 6);
    expect(hits[0]!.normal.toArray().map((v) => Math.round(v))).toEqual([0, 0, -1]);
    expect(raycastAll3D(w.graph, new Vector3(0, 0, -10), new Vector3(0, 0, 1), 12, -1).length).toBe(1);
  });
  it('節點的縮放與旋轉跟著算；圖層遮罩；球的半徑乘最大的世界縮放', () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 4);
    const w = world(
      scene([
        { name: 'Scaled', pos: [3, 0, 0], scale: [4, 1, 1], comps: [box([1, 1, 1])] },
        { name: 'Rotated', pos: [0, 3, 0], rot: [q.x, q.y, q.z, q.w], layer: 9, comps: [box([1, 1, 1])] },
        { name: 'Ball', pos: [0, -3, 0], scale: [1, 3, 1], comps: [{ type: 'SphereCollider', m_Radius: 0.5, m_Center: { x: 0, y: 0, z: 0 } }] },
      ]),
    );
    const dir = new Vector3(0, 0, 1);
    // 寬 4 的盒子在 x = 1.2 也打得到
    expect(raycast3D(w.graph, new Vector3(1.2, 0, -10), dir)?.node.go.m_Name).toBe('Scaled');
    // 轉 45° 的盒子：(0.6, 3) 在對角線方向的半寬 0.707 以內
    expect(raycast3D(w.graph, new Vector3(0.6, 3, -10), dir)?.node.go.m_Name).toBe('Rotated');
    expect(raycast3D(w.graph, new Vector3(0.6, 3, -10), dir, Infinity, ~(1 << 9))).toBeNull();
    // 球：半徑 0.5 × 3 ＝ 1.5（Unity 的球不會被壓扁）
    const ball = raycast3D(w.graph, new Vector3(1.4, -3, -10), dir);
    expect(ball?.node.go.m_Name).toBe('Ball');
  });
});

describe('EventSystem 的 PhysicsRaycaster 與拖放', () => {
  it('透視攝影機上的 PhysicsRaycaster 打得到 BoxCollider，指標進出送到碰撞器的物件', () => {
    const log: string[] = [];
    const w = world(
      scene([
        { name: 'Cam', pos: [0, 0, -10], comps: [camera(0), physicsRaycaster] },
        { name: 'Room', pos: [0, 0, 0], comps: [box([4, 2, 0.2]), handler('Rec')] },
      ]),
      { Rec: ({ node }) => ({ onPointerEnter: () => log.push(`enter ${node.go.m_Name}`), onPointerExit: () => log.push(`exit ${node.go.m_Name}`) }) },
    );
    const s = cameraWorldToScreen(w.graph.cameras[0]!, new Vector3(1.5, 0.5, 0), SCREEN.w, SCREEN.h);
    expect(w.events.raycast(s.x, s.y, SCREEN.w, SCREEN.h)?.go.m_Name).toBe('Room');
    const out = cameraWorldToScreen(w.graph.cameras[0]!, new Vector3(2.5, 0, 0), SCREEN.w, SCREEN.h);
    expect(w.events.raycast(out.x, out.y, SCREEN.w, SCREEN.h)).toBeNull();
    w.pointerMove(s.x, s.y);
    w.pointerMove(out.x, out.y);
    expect(log).toEqual(['enter Room', 'exit Room']);
  });

  it('RaycastComparer：不同 Raycaster 先比事件攝影機的 depth（大的在前），之後才比距離', () => {
    // 兩台攝影機在同一個位置；depth 0 那台只看得到第 8 層的 Back（較遠），depth −1 那台看得到全部
    const w = world(
      scene([
        { name: 'LowCam', pos: [0, 0, -10], comps: [camera(-1), { ...physicsRaycaster, m_EventMask: { m_Bits: 1 } }] },
        { name: 'HighCam', pos: [0, 0, -10], comps: [{ ...camera(0), m_CullingMask: { m_Bits: 1 << 8 } }, physicsRaycaster] },
        { name: 'Front', pos: [0, 0, 0], comps: [box()] },
        { name: 'Back', pos: [0, 0, 5], layer: 8, comps: [box()] },
      ]),
    );
    expect(w.events.raycastAll(960, 540, SCREEN.w, SCREEN.h).map((n) => n.go.m_Name)).toEqual(['Back', 'Front']);
  });

  it('放開順序照 StandaloneInputModule.ReleaseMouse：pointerUp → drop（放開處往上第一個）→ endDrag（拖的那個）', () => {
    const log: string[] = [];
    const rec = (name: string): Behaviour => ({
      onPointerDown: () => log.push(`${name} down`),
      onPointerUp: () => log.push(`${name} up`),
      onBeginDrag: () => log.push(`${name} beginDrag`),
      onDrag: () => void 0,
      onEndDrag: () => log.push(`${name} endDrag`),
      onDrop: () => log.push(`${name} drop`),
    });
    const w = world(
      scene([
        { name: 'Cam', pos: [0, 0, -10], comps: [camera(0), physicsRaycaster] },
        { name: 'Card', pos: [-3, 0, 0], comps: [box(), handler('Rec')] },
        { name: 'Room', pos: [3, 0, 0], comps: [box(), handler('Rec')] },
      ]),
      { Rec: ({ node }) => rec(node.go.m_Name) },
    );
    const cam = w.graph.cameras[0]!;
    const a = cameraWorldToScreen(cam, new Vector3(-3, 0, 0), SCREEN.w, SCREEN.h);
    const b = cameraWorldToScreen(cam, new Vector3(3, 0, 0), SCREEN.w, SCREEN.h);
    w.pointerMove(a.x, a.y);
    w.pointerDown(a.x, a.y, 0);
    w.pointerMove((a.x + b.x) / 2, a.y);
    w.pointerMove(b.x, b.y);
    w.pointerUp(b.x, b.y, 0);
    // 開始拖的時候 pointerPress（Card）先收 pointerUp、失去點擊資格（ProcessDrag），放開時就沒有 pointerPress 了
    expect(log).toEqual(['Card down', 'Card beginDrag', 'Card up', 'Room drop', 'Card endDrag']);
  });
});

import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { H, type Ctx } from './core';
import { Camera_ScreenPointToRay$Vector3, Camera_ScreenToWorldPoint$Vector3, Camera_WorldToScreenPoint$Vector3, Camera_WorldToViewportPoint$Vector3, Plane_Raycast, new_Plane$Vector3_Vector3 } from './unityCamera';

// 攝影機在 (0, 0, -10) 看 +Z；螢幕 1920×1080
function setup(comp: Record<string, unknown>): { c: Ctx; h: H } {
  const node = { id: 'cam', world: new Matrix4().compose(new Vector3(0, 0, -10), new Quaternion(), new Vector3(1, 1, 1)), parent: null, children: [], go: {}, transform: {} };
  const world = { screen: { w: 1920, h: 1080 }, graph: { cameras: [] }, notes: new Set(), relayout() {}, refreshTransform() {}, refreshSubtree() {} };
  const c = { w: world, self: null, ed: {}, ai: {}, cls: '', bound: new Map() } as unknown as Ctx;
  return { c, h: new H(node as never, comp as never, 'comp') };
}
const near = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 4);
  expect(a.y).toBeCloseTo(b.y, 4);
  expect(a.z).toBeCloseTo(b.z, 4);
};

describe('Camera 的座標換算（照 Unity：看 +Z、原點左下）', () => {
  it('正交：size 5 的畫面高 10 個單位，原點在畫面中央，z 是距離', () => {
    const { c, h } = setup({ orthographic: 1, 'orthographic size': 5, 'near clip plane': 0.3, 'far clip plane': 1000 });
    near(Camera_WorldToScreenPoint$Vector3(c, h, { x: 0, y: 0, z: 0 }), { x: 960, y: 540, z: 10 });
    near(Camera_WorldToScreenPoint$Vector3(c, h, { x: 0, y: 5, z: 0 }), { x: 960, y: 1080, z: 10 });
    near(Camera_WorldToViewportPoint$Vector3(c, h, { x: (-5 * 1920) / 1080, y: -5, z: 3 }), { x: 0, y: 0, z: 13 });
    near(Camera_ScreenToWorldPoint$Vector3(c, h, { x: 1920, y: 540, z: 10 }), { x: (5 * 1920) / 1080, y: 0, z: 0 });
  });
  it('透視：fov 60，來回換算一致；ScreenPointToRay 從攝影機穿過那一點', () => {
    const { c, h } = setup({ orthographic: 0, 'field of view': 60, 'near clip plane': 0.3, 'far clip plane': 1000 });
    const top = 10 * Math.tan(Math.PI / 6);
    near(Camera_WorldToScreenPoint$Vector3(c, h, { x: 0, y: top, z: 0 }), { x: 960, y: 1080, z: 10 });
    const p = { x: 1.25, y: -2.5, z: 4 };
    near(Camera_ScreenToWorldPoint$Vector3(c, h, Camera_WorldToScreenPoint$Vector3(c, h, p)), p);
    const ray = Camera_ScreenPointToRay$Vector3(c, h, { x: 960, y: 540, z: 0 });
    near(ray.direction, { x: 0, y: 0, z: 1 });
    near(ray.origin, { x: 0, y: 0, z: -9.7 });
  });
  it('Plane.Raycast', () => {
    const plane = new_Plane$Vector3_Vector3({} as Ctx, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 });
    let enter = 0;
    expect(Plane_Raycast({} as Ctx, plane, { origin: { x: 0, y: 0, z: -10 }, direction: { x: 0, y: 0, z: 1 } }, (v) => (enter = v))).toBe(true);
    expect(enter).toBeCloseTo(10, 5);
  });
});

describe('RectTransform.offsetMin／offsetMax（RectTransform.bindings.cs:154-180）', () => {
  it('讀：anchoredPosition ∓ sizeDelta × pivot；寫：sizeDelta 與 anchoredPosition 照原文調整', async () => {
    const { nativeGet, nativeSet } = await import('./unityNative');
    const tf = { type: 'RectTransform', m_AnchoredPosition: { x: 10, y: 20 }, m_SizeDelta: { x: 100, y: 50 }, m_Pivot: { x: 0.5, y: 0 } };
    const h = new H({ transform: tf } as never, null, 'transform');
    const c = { w: { relayout() {}, refreshTransform() {}, refreshSubtree() {}, flushDeferredLayout() {} } } as unknown as Ctx;
    expect(nativeGet(c, h, 'RectTransform', 'offsetMin')).toEqual({ x: -40, y: 20 });
    expect(nativeGet(c, h, 'RectTransform', 'offsetMax')).toEqual({ x: 60, y: 70 });
    nativeSet(c, h, 'RectTransform', 'offsetMin', { x: -50, y: 10 });
    expect(tf.m_SizeDelta).toEqual({ x: 110, y: 60 });
    expect(tf.m_AnchoredPosition).toEqual({ x: 5, y: 10 });
    expect(nativeGet(c, h, 'RectTransform', 'offsetMax')).toEqual({ x: 60, y: 70 });
  });
});

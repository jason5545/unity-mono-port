// 相容層：UnityEngine.Camera 的屬性與座標換算、RectTransform 的尺寸工具與 RectTransformUtility、Plane、全域 shader keyword、
// RenderTexture 的描述。unity.ts 會 export * 這裡。
//   - 攝影機的數學照 Unity：攝影機看 +Z；view ＝ 翻 Z × 攝影機世界矩陣的反矩陣；投影照 OpenGL（正交的半高是 orthographicSize，
//     透視的 fieldOfView 是垂直視角）；像素照 Screen 的寬高與 m_NormalizedViewPortRect，原點左下；
//     WorldToScreenPoint 的 z 是離攝影機的距離（沿攝影機前方），ScreenToWorldPoint 反過來。
//   - Overlay Canvas：跟 Unity 一樣在螢幕像素空間（unity/scene.ts 的 layout），RectTransformUtility 的 camera 是 null 時世界座標就是像素。
//   - Camera 元件的設定改了，unity/scene.ts 的 CameraInfo（繪製端讀的那份）跟著改。
// 與原版的差異：RenderTexture 只有尺寸與物件，攝影機的 targetTexture 由繪製端畫進一張 render target（格式一律 SRGB8_ALPHA8、沒有深度貼圖）；SetReplacementShader 不換 shader（記一筆）；
// Physics.Raycast 只打 BoxCollider、SphereCollider（engine/raycast3d.ts）。

import { Matrix4, Quaternion, Vector3, Vector4 } from 'three';
import type { World } from '../engine/world';
import type { CameraInfo, SceneNode } from '../unity/scene';
import type { ComponentData, RectTransformData } from '../unity/types';
import { compHandle, getActiveWorld, H, registerExternalCtor, transformOf, type Ctx } from './core';
import { DEFAULT_RAYCAST_LAYERS, raycast3D } from '../engine/raycast3d';
import { registerNativeProp } from './unityNative';
import { topCanvas } from '../ui/rectMask2d';

type V2 = { x: number; y: number };
type V3 = { x: number; y: number; z: number };
type RectV = { x: number; y: number; width: number; height: number };
const FLIP_Z = new Matrix4().makeScale(1, 1, -1);

function w(c: Ctx): World {
  const world = c.w ?? getActiveWorld();
  if (!world) throw new Error('Camera：沒有作用中的 World');
  return world;
}
function camComp(h: H | null, what: string): ComponentData {
  if (!h?.comp) throw new Error(`${what}：對象不是 Camera（C# 會 NullReferenceException）`);
  return h.comp;
}
function camInfo(world: World, comp: ComponentData): CameraInfo | undefined {
  return world.graph.cameras.find((x) => x.data === comp);
}
const isOrtho = (comp: ComponentData): boolean => !!comp.orthographic;
const orthoSize = (comp: ComponentData): number => (comp['orthographic size'] as number | undefined) ?? 5;
const fov = (comp: ComponentData): number => (comp['field of view'] as number | undefined) ?? 60;
const near = (comp: ComponentData): number => (comp['near clip plane'] as number | undefined) ?? 0.3;
const far = (comp: ComponentData): number => (comp['far clip plane'] as number | undefined) ?? 1000;
function viewportRect(comp: ComponentData): RectV {
  const r = comp.m_NormalizedViewPortRect as RectV | undefined;
  return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : { x: 0, y: 0, width: 1, height: 1 };
}
function pixelRect(world: World, comp: ComponentData): RectV {
  const r = viewportRect(comp);
  const W = world.screen.w;
  const Hh = world.screen.h;
  return { x: r.x * W, y: r.y * Hh, width: r.width * W, height: r.height * Hh };
}
/** Camera.aspect：腳本設過就用設的，否則照像素區域 */
const aspectOverride = new WeakMap<ComponentData, number>();
function aspect(world: World, comp: ComponentData): number {
  const o = aspectOverride.get(comp);
  if (o !== undefined) return o;
  const pr = pixelRect(world, comp);
  return pr.height > 0 ? pr.width / pr.height : 1;
}
function projection(world: World, comp: ComponentData): Matrix4 {
  const a = aspect(world, comp);
  const n = near(comp);
  const f = far(comp);
  if (isOrtho(comp)) {
    const s = orthoSize(comp);
    return new Matrix4().makeOrthographic(-s * a, s * a, s, -s, n, f);
  }
  const top = n * Math.tan((fov(comp) * Math.PI) / 360);
  return new Matrix4().makePerspective(-top * a, top * a, top, -top, n, f);
}
function view(node: SceneNode): Matrix4 {
  return FLIP_Z.clone().multiply(node.world.clone().invert());
}

/** 世界座標 → viewport（0 到 1，z 是離攝影機的距離） */
function worldToViewport(world: World, h: H, p: V3): V3 {
  const comp = camComp(h, 'Camera.WorldToViewportPoint');
  world.refreshTransform(h.node);
  const eye = new Vector4(p.x, p.y, p.z, 1).applyMatrix4(view(h.node));
  const clip = eye.clone().applyMatrix4(projection(world, comp));
  const iw = clip.w !== 0 ? 1 / clip.w : 1;
  return { x: (clip.x * iw + 1) / 2, y: (clip.y * iw + 1) / 2, z: -eye.z };
}
/** viewport（z 是離攝影機的距離）→ 世界座標 */
function viewportToWorld(world: World, h: H, v: V3): V3 {
  const comp = camComp(h, 'Camera.ViewportToWorldPoint');
  world.refreshTransform(h.node);
  const nx = v.x * 2 - 1;
  const ny = v.y * 2 - 1;
  let ex: number;
  let ey: number;
  if (isOrtho(comp)) {
    const s = orthoSize(comp);
    ex = nx * s * aspect(world, comp);
    ey = ny * s;
  } else {
    const t = Math.tan((fov(comp) * Math.PI) / 360);
    ex = nx * v.z * t * aspect(world, comp);
    ey = ny * v.z * t;
  }
  const r = new Vector3(ex, ey, -v.z).applyMatrix4(view(h.node).invert());
  return { x: r.x, y: r.y, z: r.z };
}
function viewportToScreen(world: World, comp: ComponentData, v: V3): V3 {
  const pr = pixelRect(world, comp);
  return { x: pr.x + v.x * pr.width, y: pr.y + v.y * pr.height, z: v.z };
}
function screenToViewport(world: World, comp: ComponentData, s: V3): V3 {
  const pr = pixelRect(world, comp);
  return { x: pr.width ? (s.x - pr.x) / pr.width : 0, y: pr.height ? (s.y - pr.y) / pr.height : 0, z: s.z ?? 0 };
}

export function Camera_WorldToViewportPoint$Vector3(c: Ctx, h: H, p: V3): V3 {
  return worldToViewport(w(c), h, p);
}
export const Camera_WorldToViewportPoint$Vector3_MonoOrStereoscopicEye = (c: Ctx, h: H, p: V3): V3 => Camera_WorldToViewportPoint$Vector3(c, h, p);
export function Camera_WorldToScreenPoint$Vector3(c: Ctx, h: H, p: V3): V3 {
  const world = w(c);
  return viewportToScreen(world, camComp(h, 'Camera.WorldToScreenPoint'), worldToViewport(world, h, p));
}
export const Camera_WorldToScreenPoint$Vector3_MonoOrStereoscopicEye = (c: Ctx, h: H, p: V3): V3 => Camera_WorldToScreenPoint$Vector3(c, h, p);
export function Camera_ViewportToWorldPoint$Vector3(c: Ctx, h: H, v: V3): V3 {
  return viewportToWorld(w(c), h, v);
}
export const Camera_ViewportToWorldPoint$Vector3_MonoOrStereoscopicEye = (c: Ctx, h: H, v: V3): V3 => Camera_ViewportToWorldPoint$Vector3(c, h, v);
export function Camera_ScreenToWorldPoint$Vector3(c: Ctx, h: H, s: V3): V3 {
  const world = w(c);
  return viewportToWorld(world, h, screenToViewport(world, camComp(h, 'Camera.ScreenToWorldPoint'), s));
}
export const Camera_ScreenToWorldPoint$Vector3_MonoOrStereoscopicEye = (c: Ctx, h: H, s: V3): V3 => Camera_ScreenToWorldPoint$Vector3(c, h, s);
export const Camera_ViewportToScreenPoint = (c: Ctx, h: H, v: V3): V3 => viewportToScreen(w(c), camComp(h, 'Camera.ViewportToScreenPoint'), v);
export const Camera_ScreenToViewportPoint = (c: Ctx, h: H, s: V3): V3 => screenToViewport(w(c), camComp(h, 'Camera.ScreenToViewportPoint'), s);
/** ScreenPointToRay：起點在近平面上，方向從攝影機穿過那一點（正交是攝影機前方） */
export function Camera_ScreenPointToRay$Vector3(c: Ctx, h: H, s: V3): { origin: V3; direction: V3 } {
  const world = w(c);
  const comp = camComp(h, 'Camera.ScreenPointToRay');
  const v = screenToViewport(world, comp, s);
  const origin = viewportToWorld(world, h, { x: v.x, y: v.y, z: near(comp) });
  let dir: Vector3;
  if (isOrtho(comp)) {
    const q = new Quaternion();
    h.node.world.decompose(new Vector3(), q, new Vector3());
    dir = new Vector3(0, 0, 1).applyQuaternion(q);
  } else {
    const camPos = new Vector3().setFromMatrixPosition(h.node.world);
    dir = new Vector3(origin.x, origin.y, origin.z).sub(camPos);
  }
  dir.normalize();
  return { origin, direction: { x: dir.x, y: dir.y, z: dir.z } };
}
export const Camera_ScreenPointToRay$Vector3_MonoOrStereoscopicEye = (c: Ctx, h: H, s: V3): { origin: V3; direction: V3 } => Camera_ScreenPointToRay$Vector3(c, h, s);
export const Camera_ViewportPointToRay$Vector3 = (c: Ctx, h: H, v: V3): { origin: V3; direction: V3 } =>
  Camera_ScreenPointToRay$Vector3(c, h, viewportToScreen(w(c), camComp(h, 'Camera.ViewportPointToRay'), v));

/** Camera.CopyFrom(other)：設定（投影、裁切、清除、深度、viewport…）照抄，Transform 的位置與旋轉、圖層也照對方 */
export function Camera_CopyFrom(c: Ctx, h: H, other: H): void {
  const world = w(c);
  const dst = camComp(h, 'Camera.CopyFrom');
  const src = camComp(other, 'Camera.CopyFrom');
  for (const [k, v] of Object.entries(src)) if (!['gameObject', 'm_GameObject', 'm_Enabled', 'type', 'classID', 'script', 'm_Script'].includes(k)) dst[k] = structuredClone(v);
  const o = aspectOverride.get(src);
  if (o !== undefined) aspectOverride.set(dst, o);
  else aspectOverride.delete(dst);
  const info = camInfo(world, dst);
  if (info) syncInfo(info, dst);
  const pos = new Vector3();
  const rot = new Quaternion();
  world.refreshTransform(other.node);
  if (h.node.parent) world.refreshTransform(h.node.parent);
  other.node.world.decompose(pos, rot, new Vector3());
  // Transform 照對方的世界位置與旋轉（父物件的矩陣換回本地）
  const parentInv = h.node.parent ? h.node.parent.world.clone().invert() : new Matrix4();
  const local = parentInv.multiply(new Matrix4().compose(pos, rot, new Vector3(1, 1, 1)));
  const lp = new Vector3();
  const lq = new Quaternion();
  local.decompose(lp, lq, new Vector3());
  const tf = h.node.transform as unknown as { m_LocalPosition: V3; m_LocalRotation: { x: number; y: number; z: number; w: number } };
  tf.m_LocalPosition = { x: lp.x, y: lp.y, z: lp.z };
  tf.m_LocalRotation = { x: lq.x, y: lq.y, z: lq.z, w: lq.w };
  h.node.go.m_Layer = other.node.go.m_Layer;
  world.refreshSubtree(h.node);
}
const replacementNoted = new WeakSet<ComponentData>();
/** SetReplacementShader：繪製端還不會換 shader，記一筆 */
export function Camera_SetReplacementShader(c: Ctx, h: H, shader: unknown, tag: string): void {
  void shader;
  const comp = camComp(h, 'Camera.SetReplacementShader');
  if (!replacementNoted.has(comp)) {
    replacementNoted.add(comp);
    w(c).notes.add(`Camera.SetReplacementShader（${tag}）：還不會換 shader`);
  }
}
export const Camera_ResetReplacementShader = (_c: Ctx, h: H): void => void h;

function syncInfo(info: CameraInfo, comp: ComponentData): void {
  info.orthographic = isOrtho(comp);
  info.orthographicSize = orthoSize(comp);
  info.fieldOfView = fov(comp);
  info.near = near(comp);
  info.far = far(comp);
}
/** 序列化欄位名有空格的設定（orthographic size、field of view…）：讀寫元件資料，CameraInfo 跟著改 */
function camProp(name: string, key: string, conv: (v: unknown) => unknown = (v) => v, back: (v: unknown) => unknown = (v) => v): void {
  registerNativeProp('Camera', name, {
    get: (_c, h) => conv(h.comp?.[key]),
    set: (c, h, v) => {
      const comp = camComp(h, `Camera.${name}`);
      comp[key] = back(v);
      const info = camInfo(w(c), comp);
      if (info) syncInfo(info, comp);
    },
  });
}
camProp('orthographic', 'orthographic', (v) => !!v, (v) => (v ? 1 : 0));
camProp('orthographicSize', 'orthographic size');
camProp('fieldOfView', 'field of view');
camProp('nearClipPlane', 'near clip plane');
camProp('farClipPlane', 'far clip plane');
camProp('depth', 'm_Depth');
camProp('clearFlags', 'm_ClearFlags');
camProp('backgroundColor', 'm_BackGroundColor', (v) => ({ ...(v as object) }), (v) => ({ ...(v as object) }));
camProp('cullingMask', 'm_CullingMask', (v) => ((v as { m_Bits?: number } | undefined)?.m_Bits ?? -1) | 0, (v) => ({ m_Bits: (v as number) >>> 0 }));
camProp('rect', 'm_NormalizedViewPortRect', (v) => ({ ...((v as RectV | undefined) ?? { x: 0, y: 0, width: 1, height: 1 }) }), (v) => ({ ...(v as RectV) }));
registerNativeProp('Camera', 'aspect', {
  get: (c, h) => aspect(w(c), camComp(h, 'Camera.aspect')),
  set: (_c, h, v) => void aspectOverride.set(camComp(h, 'Camera.aspect'), v as number),
});
registerNativeProp('Camera', 'pixelRect', { get: (c, h) => pixelRect(w(c), camComp(h, 'Camera.pixelRect')) });
/**
 * Canvas.pixelRect：Overlay 是整個螢幕（0, 0, Screen.width, Screen.height）；Screen Space - Camera 有指定攝影機時是那台攝影機的 pixelRect。
 * World Space 照指定的攝影機、沒有就整個螢幕（未查證）。巢狀 Canvas 照根 Canvas
 */
registerNativeProp('Canvas', 'pixelRect', {
  get: (c, h) => {
    const world = w(c);
    const info = h.node.canvas;
    const data = info?.data ?? h.comp;
    const camRef = data?.m_Camera as { fileID?: string } | null | undefined;
    const cam = info?.renderMode !== 0 && camRef?.fileID ? world.graph.file.components[camRef.fileID] : undefined;
    return cam ? pixelRect(world, cam) : { x: 0, y: 0, width: world.screen.w, height: world.screen.h };
  },
});
/**
 * Canvas.referencePixelsPerUnit：CanvasScaler 每格寫進 Canvas 的值（反編譯的 UnityEngine.UI CanvasScaler.cs:346 SetReferencePixelsPerUnit）。
 * 排版端的 CanvasInfo（unity/scene.ts）照 CanvasScaler 的 m_ReferencePixelsPerUnit 算好，沒有 CanvasScaler 照父 Canvas、再沒有是 100。
 * ConstantPhysicalSize 模式 Unity 還要乘 DPI／m_DefaultSpriteDPI（CanvasScaler.cs:334），排版端沒算（差異清單）
 */
registerNativeProp('Canvas', 'referencePixelsPerUnit', { get: (_c, h) => h.node.canvas?.referencePixelsPerUnit ?? 100 });
/**
 * Canvas.rootCanvas：往上最頂的 Canvas（手冊：「Returns the Canvas closest to root, by checking through each parent and returning the last canvas found」；
 * 只有自己就是自己）。停用的 Canvas 算不算：未查證，這裡照 RectMask2D 那邊的 topCanvas 一律算
 */
registerNativeProp('Canvas', 'rootCanvas', {
  get: (c, h) => {
    const world = w(c);
    const top = topCanvas(world.graph, h.node) ?? h.node;
    const comp = world.graph.component(top, 'Canvas');
    return comp ? compHandle(world, comp) : h;
  },
});
registerNativeProp('Canvas', 'isRootCanvas', { get: (c, h) => (topCanvas(w(c).graph, h.node) ?? h.node) === h.node });
registerNativeProp('Camera', 'pixelWidth', { get: (c, h) => Math.round(pixelRect(w(c), camComp(h, 'Camera.pixelWidth')).width) });
registerNativeProp('Camera', 'pixelHeight', { get: (c, h) => Math.round(pixelRect(w(c), camComp(h, 'Camera.pixelHeight')).height) });
/** 繪製端用：這台攝影機有沒有 targetTexture（有的不畫到螢幕；render/cameraStack.ts） */
export function cameraHasTargetTexture(comp: ComponentData): boolean {
  return !!targetTextures.get(comp);
}
/** 繪製端用：這台攝影機的 targetTexture（RenderTexture 物件；繪製端照物件身分配一張 render target） */
export function cameraTargetTexture(comp: ComponentData): { width: number; height: number } | null {
  return targetTextures.get(comp) ?? null;
}
registerNativeProp('Camera', 'targetTexture', {
  get: (_c, h) => targetTextures.get(camComp(h, 'Camera.targetTexture')) ?? null,
  set: (_c, h, v) => void targetTextures.set(camComp(h, 'Camera.targetTexture'), v as RenderTextureJs | null),
});
const m4 = (m: Matrix4): Record<string, number> => {
  const e = m.elements;
  const out: Record<string, number> = {};
  for (let r = 0; r < 4; r++) for (let col = 0; col < 4; col++) out[`m${r}${col}`] = e[col * 4 + r];
  return out;
};
registerNativeProp('Camera', 'worldToCameraMatrix', { get: (_c, h) => m4(view(h.node)) });
registerNativeProp('Camera', 'cameraToWorldMatrix', { get: (_c, h) => m4(view(h.node).invert()) });
registerNativeProp('Camera', 'projectionMatrix', { get: (c, h) => m4(projection(w(c), camComp(h, 'Camera.projectionMatrix'))) });

// ───────── RectTransform 的尺寸工具（RectTransform.cs 的 C# 本體照抄） ─────────

function rtData(t: H | null, what: string): RectTransformData {
  if (!t) throw new Error(`${what}：對象是 null`);
  const tf = t.node.transform as unknown as RectTransformData;
  if ((tf as unknown as { type: string }).type !== 'RectTransform') throw new Error(`${what}：不是 RectTransform`);
  return tf;
}
const axisGet = (v: V2, i: number): number => (i === 0 ? v.x : v.y);
function axisSet(v: V2, i: number, x: number): V2 {
  return i === 0 ? { x, y: v.y } : { x: v.x, y: x };
}
/** SetSizeWithCurrentAnchors(axis, size)：sizeDelta[軸] ＝ size − 父物件大小[軸] ×（anchorMax − anchorMin） */
export function RectTransform_SetSizeWithCurrentAnchors(c: Ctx, t: H, axis: number, size: number): void {
  const rt = rtData(t, 'RectTransform.SetSizeWithCurrentAnchors');
  w(c).flushDeferredLayout(t.node);
  if (t.node.parent) w(c).refreshTransform(t.node.parent);
  const pr = t.node.parent?.isRect ? t.node.parent.rect : null;
  const parentSize = pr ? (axis === 0 ? pr.width : pr.height) : 0;
  rt.m_SizeDelta = axisSet(rt.m_SizeDelta, axis, size - parentSize * (axisGet(rt.m_AnchorMax, axis) - axisGet(rt.m_AnchorMin, axis)));
  w(c).refreshSubtree(t.node);
}
/** SetInsetAndSizeFromParentEdge(edge, inset, size)：錨點貼到那一邊、大小與離邊距離 */
export function RectTransform_SetInsetAndSizeFromParentEdge(c: Ctx, t: H, edge: number, inset: number, size: number): void {
  const rt = rtData(t, 'RectTransform.SetInsetAndSizeFromParentEdge');
  w(c).flushDeferredLayout(t.node);
  const index = edge === 2 || edge === 3 ? 1 : 0; // Edge：Left 0、Right 1、Top 2、Bottom 3
  const end = edge === 2 || edge === 1;
  const anchorValue = end ? 1 : 0;
  rt.m_AnchorMin = axisSet(rt.m_AnchorMin, index, anchorValue);
  rt.m_AnchorMax = axisSet(rt.m_AnchorMax, index, anchorValue);
  rt.m_SizeDelta = axisSet(rt.m_SizeDelta, index, size);
  const pivot = axisGet(rt.m_Pivot, index);
  rt.m_AnchoredPosition = axisSet(rt.m_AnchoredPosition, index, end ? -inset - size * (1 - pivot) : inset + size * pivot);
  w(c).refreshSubtree(t.node);
}
/**
 * RectTransform.offsetMin／offsetMax（UnityCsReference 2022.3 RectTransform.bindings.cs:154-180，照原文算）：
 *   offsetMin = anchoredPosition − sizeDelta × pivot；offsetMax = anchoredPosition + sizeDelta ×（1 − pivot）。
 *   設 offsetMin：差值從 sizeDelta 扣掉、anchoredPosition 加差值 ×（1 − pivot）；設 offsetMax：sizeDelta 加差值、anchoredPosition 加差值 × pivot
 */
registerNativeProp('RectTransform', 'offsetMin', {
  get: (_c, h) => {
    const rt = rtData(h, 'RectTransform.offsetMin');
    return { x: rt.m_AnchoredPosition.x - rt.m_SizeDelta.x * rt.m_Pivot.x, y: rt.m_AnchoredPosition.y - rt.m_SizeDelta.y * rt.m_Pivot.y };
  },
  set: (c, h, v) => {
    const rt = rtData(h, 'RectTransform.offsetMin');
    const value = v as V2;
    const ox = value.x - (rt.m_AnchoredPosition.x - rt.m_SizeDelta.x * rt.m_Pivot.x);
    const oy = value.y - (rt.m_AnchoredPosition.y - rt.m_SizeDelta.y * rt.m_Pivot.y);
    rt.m_SizeDelta = { x: rt.m_SizeDelta.x - ox, y: rt.m_SizeDelta.y - oy };
    rt.m_AnchoredPosition = { x: rt.m_AnchoredPosition.x + ox * (1 - rt.m_Pivot.x), y: rt.m_AnchoredPosition.y + oy * (1 - rt.m_Pivot.y) };
    w(c).refreshSubtree(h.node);
  },
});
registerNativeProp('RectTransform', 'offsetMax', {
  get: (_c, h) => {
    const rt = rtData(h, 'RectTransform.offsetMax');
    return { x: rt.m_AnchoredPosition.x + rt.m_SizeDelta.x * (1 - rt.m_Pivot.x), y: rt.m_AnchoredPosition.y + rt.m_SizeDelta.y * (1 - rt.m_Pivot.y) };
  },
  set: (c, h, v) => {
    const rt = rtData(h, 'RectTransform.offsetMax');
    const value = v as V2;
    const ox = value.x - (rt.m_AnchoredPosition.x + rt.m_SizeDelta.x * (1 - rt.m_Pivot.x));
    const oy = value.y - (rt.m_AnchoredPosition.y + rt.m_SizeDelta.y * (1 - rt.m_Pivot.y));
    rt.m_SizeDelta = { x: rt.m_SizeDelta.x + ox, y: rt.m_SizeDelta.y + oy };
    rt.m_AnchoredPosition = { x: rt.m_AnchoredPosition.x + ox * rt.m_Pivot.x, y: rt.m_AnchoredPosition.y + oy * rt.m_Pivot.y };
    w(c).refreshSubtree(h.node);
  },
});
function localCorners(node: SceneNode): Vector3[] {
  const r = node.rect;
  return [new Vector3(r.x, r.y, 0), new Vector3(r.x, r.y + r.height, 0), new Vector3(r.x + r.width, r.y + r.height, 0), new Vector3(r.x + r.width, r.y, 0)];
}
/** GetWorldCorners(corners)：左下、左上、右上、右下的世界座標，填進呼叫端的陣列 */
export function RectTransform_GetWorldCorners(c: Ctx, t: H, corners: V3[]): void {
  if (!corners || corners.length < 4) throw new Error('GetWorldCorners：陣列要四格');
  w(c).refreshTransform(t.node);
  localCorners(t.node).forEach((p, i) => {
    p.applyMatrix4(t.node.world);
    corners[i] = { x: p.x, y: p.y, z: p.z };
  });
}
export function RectTransform_GetLocalCorners(c: Ctx, t: H, corners: V3[]): void {
  w(c).refreshTransform(t.node);
  localCorners(t.node).forEach((p, i) => (corners[i] = { x: p.x, y: p.y, z: p.z }));
}

// ───────── RectTransformUtility ─────────

/** 螢幕點 → RectTransform 的本地座標（原點是 pivot）：事件系統的同一套（照所在 Canvas 的模式；camera 參數由 Canvas 決定） */
export function RectTransformUtility_ScreenPointToLocalPointInRectangle(c: Ctx, t: H, sp: V2, cam: unknown, out: (v: V2) => void): boolean {
  void cam;
  const world = w(c);
  world.refreshTransform(t.node);
  const p = world.events.screenPointToLocal(t.node, sp.x, sp.y, world.screen.w, world.screen.h);
  out(p ?? { x: 0, y: 0 });
  return !!p;
}
export function RectTransformUtility_ScreenPointToWorldPointInRectangle(c: Ctx, t: H, sp: V2, cam: unknown, out: (v: V3) => void): boolean {
  void cam;
  const world = w(c);
  world.refreshTransform(t.node);
  const p = world.events.screenPointToLocal(t.node, sp.x, sp.y, world.screen.w, world.screen.h);
  if (!p) {
    out({ x: 0, y: 0, z: 0 });
    return false;
  }
  const r = new Vector3(p.x, p.y, 0).applyMatrix4(t.node.world);
  out({ x: r.x, y: r.y, z: r.z });
  return true;
}
export function RectTransformUtility_RectangleContainsScreenPoint$RectTransform_Vector2_Camera(c: Ctx, t: H, sp: V2, cam: unknown): boolean {
  void cam;
  const world = w(c);
  world.refreshTransform(t.node);
  const p = world.events.screenPointToLocal(t.node, sp.x, sp.y, world.screen.w, world.screen.h);
  const r = t.node.rect;
  return !!p && p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}
export const RectTransformUtility_RectangleContainsScreenPoint$RectTransform_Vector2 = (c: Ctx, t: H, sp: V2): boolean =>
  RectTransformUtility_RectangleContainsScreenPoint$RectTransform_Vector2_Camera(c, t, sp, null);
/** WorldToScreenPoint(cam, worldPoint)：camera 是 null（Overlay）時世界座標的 xy 就是像素（RectTransformUtility.cs 同） */
export function RectTransformUtility_WorldToScreenPoint(c: Ctx, cam: H | null, p: V3): V2 {
  if (!cam) return { x: p.x, y: p.y };
  const s = Camera_WorldToScreenPoint$Vector3(c, cam, p);
  return { x: s.x, y: s.y };
}
/** CalculateRelativeRectTransformBounds(root, child)：child 底下全部 RectTransform 的四角換到 root 的本地座標，取外框 */
export function RectTransformUtility_CalculateRelativeRectTransformBounds$Transform_Transform(c: Ctx, root: H, child: H): { center: V3; extents: V3 } {
  const world = w(c);
  world.refreshTransform(root.node);
  const inv = root.node.world.clone().invert();
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const visit = (n: SceneNode): void => {
    world.refreshTransform(n);
    if (n.isRect)
      for (const p of localCorners(n)) {
        p.applyMatrix4(n.world).applyMatrix4(inv);
        min.min(p);
        max.max(p);
      }
    for (const ch of n.children) visit(ch);
  };
  visit(child.node);
  if (!Number.isFinite(min.x)) return { center: { x: 0, y: 0, z: 0 }, extents: { x: 0, y: 0, z: 0 } };
  return {
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    extents: { x: (max.x - min.x) / 2, y: (max.y - min.y) / 2, z: (max.z - min.z) / 2 },
  };
}
export const RectTransformUtility_CalculateRelativeRectTransformBounds$Transform = (c: Ctx, t: H): { center: V3; extents: V3 } =>
  RectTransformUtility_CalculateRelativeRectTransformBounds$Transform_Transform(c, t, t);

// ───────── Plane、Physics ─────────

type PlaneJs = { normal: V3; distance: number };
const dot = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export function new_Plane$Vector3_Vector3(c: Ctx, normal: V3, point: V3): PlaneJs {
  void c;
  const n = new Vector3(normal.x, normal.y, normal.z).normalize();
  return { normal: { x: n.x, y: n.y, z: n.z }, distance: -dot(n, point) };
}
export function new_Plane$Vector3_float(c: Ctx, normal: V3, d: number): PlaneJs {
  void c;
  const n = new Vector3(normal.x, normal.y, normal.z).normalize();
  return { normal: { x: n.x, y: n.y, z: n.z }, distance: d };
}
export const Plane_GetDistanceToPoint = (_c: Ctx, p: PlaneJs, pt: V3): number => dot(p.normal, pt) + p.distance;
/** Plane.Raycast(ray, out enter)：平行時 false；打在背面（enter < 0）時 false，enter 照算 */
export function Plane_Raycast(c: Ctx, p: PlaneJs, ray: { origin: V3; direction: V3 }, out: (v: number) => void): boolean {
  void c;
  const vdot = dot(ray.direction, p.normal);
  const ndot = -dot(ray.origin, p.normal) - p.distance;
  if (Math.abs(vdot) < 1e-6) {
    out(0);
    return false;
  }
  const enter = ndot / vdot;
  out(enter);
  return enter > 0;
}
export const Ray_GetPoint = (_c: Ctx, r: { origin: V3; direction: V3 }, d: number): V3 => ({ x: r.origin.x + r.direction.x * d, y: r.origin.y + r.direction.y * d, z: r.origin.z + r.direction.z * d });
export const new_Ray = (_c: Ctx, origin: V3, direction: V3): { origin: V3; direction: V3 } => {
  const d = new Vector3(direction.x, direction.y, direction.z).normalize();
  return { origin: { ...origin }, direction: { x: d.x, y: d.y, z: d.z } };
};
/**
 * Physics.Raycast(ray, out hit)：最近的 3D 碰撞器（engine/raycast3d.ts；BoxCollider、SphereCollider，其他種類記 note）。
 * 沒指定的參數照 Unity 預設：maxDistance Infinity、layerMask DefaultRaycastLayers（IgnoreRaycast 以外）、觸發器也算。
 * RaycastHit 帶 point、normal、distance、collider、transform（MT2 的 InputManager.GetGameComponentAtScreenPos 讀 transform）。
 */
export function Physics_Raycast$Ray_RaycastHit(c: Ctx, ray: { origin: V3; direction: V3 }, out: (v: unknown) => void): boolean {
  const world = w(c);
  const d = new Vector3(ray.direction.x, ray.direction.y, ray.direction.z).normalize();
  const hit = raycast3D(world.graph, new Vector3(ray.origin.x, ray.origin.y, ray.origin.z), d, Infinity, DEFAULT_RAYCAST_LAYERS, world.notes);
  if (!hit) {
    out({ $type: 'RaycastHit', point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, distance: 0, collider: null, transform: null });
    return false;
  }
  out({
    $type: 'RaycastHit',
    point: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
    normal: { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
    distance: hit.distance,
    collider: compHandle(world, hit.collider),
    transform: transformOf(hit.node),
  });
  return true;
}

// ───────── 全域 shader keyword ─────────

const globalKeywords = new Set<string>();
/** Shader.EnableKeyword／DisableKeyword／IsKeywordEnabled：全域 keyword（繪製端選 variant 時讀 globalShaderKeywords） */
export const Shader_EnableKeyword$string = (_c: Ctx, k: string): void => void globalKeywords.add(k);
export const Shader_DisableKeyword$string = (_c: Ctx, k: string): void => void globalKeywords.delete(k);
export const Shader_IsKeywordEnabled$string = (_c: Ctx, k: string): boolean => globalKeywords.has(k);
export function globalShaderKeywords(): ReadonlySet<string> {
  return globalKeywords;
}

// ───────── RenderTexture（描述與物件；攝影機的 targetTexture 由繪製端畫進對應的 render target，RawImage 照它顯示） ─────────

interface RenderTextureJs {
  $type: 'RenderTexture';
  width: number;
  height: number;
  depth: number;
  format: number;
  created: boolean;
  /** Release 過（Create 之後清掉）：繪製端放掉 render target */
  released?: boolean;
  name: string;
}
const targetTextures = new WeakMap<ComponentData, RenderTextureJs | null>();
registerExternalCtor('RenderTextureDescriptor', (width = 0, height = 0, format = 0, depthBufferBits = 0) => ({
  $type: 'RenderTextureDescriptor', width, height, colorFormat: format, depthBufferBits, msaaSamples: 1, volumeDepth: 1, dimension: 2, useMipMap: false, autoGenerateMips: true, sRGB: false,
}));
function newRT(width: number, height: number, depth = 0, format = 0): RenderTextureJs {
  return { $type: 'RenderTexture', width, height, depth, format, created: false, name: '' };
}
export const new_RenderTexture$int_int_int = (_c: Ctx, wd: number, ht: number, d: number): RenderTextureJs => newRT(wd, ht, d);
export const new_RenderTexture$int_int_int_RenderTextureFormat = (_c: Ctx, wd: number, ht: number, d: number, f: number): RenderTextureJs => newRT(wd, ht, d, f);
export const new_RenderTexture$RenderTextureDescriptor = (_c: Ctx, desc: { width: number; height: number; depthBufferBits: number; colorFormat: number }): RenderTextureJs =>
  newRT(desc.width, desc.height, desc.depthBufferBits, desc.colorFormat);
export const RenderTexture_Create = (_c: Ctx, rt: RenderTextureJs): boolean => ((rt.created = true), (rt.released = false), true);
/** Release：釋放 GPU 上的內容（繪製端看 released 放掉對應的 render target） */
export const RenderTexture_Release = (_c: Ctx, rt: RenderTextureJs): void => void (rt && ((rt.created = false), (rt.released = true)));
export const RenderTexture_IsCreated = (_c: Ctx, rt: RenderTextureJs): boolean => !!rt?.created;
export const RenderTexture_GetTemporary$int_int_int = (_c: Ctx, wd: number, ht: number, d: number): RenderTextureJs => newRT(wd, ht, d);
export const RenderTexture_GetTemporary$RenderTextureDescriptor = (c: Ctx, desc: { width: number; height: number; depthBufferBits: number; colorFormat: number }): RenderTextureJs =>
  new_RenderTexture$RenderTextureDescriptor(c, desc);
export const RenderTexture_ReleaseTemporary = (_c: Ctx, rt: RenderTextureJs): void => void rt;

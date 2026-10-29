// 相容層：UnityEngine.Mesh 與 MeshFilter（unity.ts 會 export * 這裡）。網格資料在 unity/meshes.ts：
//   - 資產：meshes.json（AssetRipper 匯出的 .asset）與 builtin.json 的內建網格（unity default resources 的 Quad、Cube…，照 {guid, fileID} 找）。
//   - MeshFilter.mesh：Unity 第一次讀時把 sharedMesh 複製一份給這個 MeshFilter（ensureMeshInstance），之後改頂點只影響它。
//   - MeshFilter.sharedMesh：資產本身（元件欄位 m_Mesh 的參照），或執行期 new Mesh() 建的網格（Spine 的 SkeletonRenderer 每格寫頂點）。
//   - new Mesh()：跟複本同一種結構（MeshInstance：channels、indices、version），另有子網格。寫入照 Unity 的 API（vertices、uv、colors32、
//     SetTriangles…），長度跟頂點數不同時 Unity 記錯誤、不寫入，這裡記在 notes。繪製端目前只畫有資產的 MeshRenderer（差異清單）。
// Mesh 的屬性對兩種都回得出來：複本讀它自己的資料，資產參照讀匯入的資料（meshes.json 是延後載入的，沒載到會丟錯，不回假的值）。

import { canvasRendererState, getCanvasRendererColor, setCanvasRendererColor, type CanvasRendererState } from '../ui/canvasRenderer';
import type { ColorRGBA, ComponentData } from '../unity/types';
import {
  assetBounds,
  boundsOf,
  channelRead,
  dropMeshInstance,
  ensureMeshInstance,
  meshAssetOf,
  meshInstanceOf,
  setMeshInstance,
  type MeshAssetRecord,
  type MeshBounds,
  type MeshInstance,
} from '../unity/meshes';
import { getActiveWorld, NotPorted, registerExternalCtor, type Ctx, type H } from './core';
import { registerNativeDataProp, registerNativeProp } from './unityNative';

const isInstance = (o: object): o is MeshInstance => 'channels' in o && 'version' in o && 'source' in o;

function assetOf(o: object, what: string): MeshAssetRecord {
  const a = meshAssetOf(o as { guid?: string; fileID?: string });
  if (!a) throw new Error(`${what}：網格 ${(o as { guid?: string }).guid ?? '?'} 沒有載入（meshes.json 還沒讀，或不是網格資產）`);
  return a;
}

/** sharedMesh 設成執行期建的網格（new Mesh()）的 MeshFilter */
const sharedRuntime = new WeakMap<ComponentData, MeshInstance>();

/** MeshFilter.mesh：執行期複本（第一次讀時從 sharedMesh 複製）。sharedMesh 是執行期建的網格時回它本身（Unity 會不會另複製一份未查證） */
registerNativeProp('MeshFilter', 'mesh', {
  get: (_c: Ctx, h: H) => {
    if (!h.comp) throw new Error('MeshFilter.mesh：對象不是 MeshFilter');
    const rt = sharedRuntime.get(h.comp);
    if (rt) return rt;
    return h.comp.m_Mesh ? ensureMeshInstance(h.comp) : null;
  },
});

/** MeshFilter.sharedMesh：資產參照（{guid, fileID}）或執行期建的網格；set 換掉，原本的執行期複本不再用 */
registerNativeProp('MeshFilter', 'sharedMesh', {
  get: (_c: Ctx, h: H) => (h.comp && sharedRuntime.get(h.comp)) ?? ((h.comp?.m_Mesh as { guid?: string } | null)?.guid ? h.comp!.m_Mesh : null),
  set: (_c: Ctx, h: H, v: unknown) => {
    if (!h.comp) throw new Error('MeshFilter.sharedMesh：對象不是 MeshFilter');
    if (v != null && typeof v === 'object' && isInstance(v)) {
      h.comp.m_Mesh = null;
      sharedRuntime.set(h.comp, v);
      setMeshInstance(h.comp, v);
      return;
    }
    if (v != null && !(typeof v === 'object' && typeof (v as { guid?: unknown }).guid === 'string'))
      throw new Error('MeshFilter.sharedMesh：只認得網格資產的參照（{guid, fileID}）與執行期建的 Mesh');
    sharedRuntime.delete(h.comp);
    h.comp.m_Mesh = v ?? null;
    dropMeshInstance(h.comp);
  },
});

// ───────── new Mesh()：執行期建的網格 ─────────

type RuntimeMesh = MeshInstance & { $type: 'Mesh'; name: string; hideFlags: number; dynamic: boolean; submeshes: number[][] };
const ZERO_BOUNDS = (): MeshBounds => ({ center: { x: 0, y: 0, z: 0 }, extents: { x: 0, y: 0, z: 0 } });
registerExternalCtor('Mesh', (): RuntimeMesh => ({
  $type: 'Mesh',
  source: '',
  vertexCount: 0,
  channels: {},
  indices: [],
  submeshes: [[]],
  version: 0,
  bounds: ZERO_BOUNDS(),
  name: '',
  hideFlags: 0,
  dynamic: false,
}));
function rt(o: object, what: string): RuntimeMesh {
  if (!isInstance(o)) throw new NotPorted(what, '網格資產（唯讀的匯入資料）不能寫；只有執行期的網格與 MeshFilter.mesh 的複本可以', what.replace('.', '_set_'));
  const m = o as RuntimeMesh;
  m.submeshes ??= [m.indices];
  return m;
}
function note(msg: string): void {
  getActiveWorld()?.notes.add(msg);
}
/** 整批寫一個 channel（null 拿掉）；長度跟頂點數不同：Unity 記錯誤、不寫入 */
function writeChannel(m: RuntimeMesh, name: string, prop: string, items: ArrayLike<Record<string, number>> | null, keys: string[], scale = 1): void {
  if (items == null) {
    delete m.channels[name];
    m.version++;
    return;
  }
  if (items.length !== m.vertexCount) {
    note(`Mesh.${prop} is out of bounds. The supplied array needs to be the same size as the Mesh.vertices array.`);
    return;
  }
  const dim = keys.length;
  const values = new Float32Array(m.vertexCount * dim);
  for (let i = 0; i < items.length; i++) for (let k = 0; k < dim; k++) values[i * dim + k] = (items[i]?.[keys[k]] ?? 0) / scale;
  m.channels[name] = { dimension: dim, values };
  m.version++;
}
/** vertices 的 set：頂點數跟著變，長度不同的其他 channel 拿掉，外框重算（Unity 設 vertices 會自動重算 bounds） */
function writePositions(m: RuntimeMesh, items: ArrayLike<Record<string, number>> | null): void {
  const n = items?.length ?? 0;
  if (n !== m.vertexCount) for (const k of Object.keys(m.channels)) if (k !== 'position') delete m.channels[k];
  m.vertexCount = n;
  const values = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    values[i * 3] = items![i]?.x ?? 0;
    values[i * 3 + 1] = items![i]?.y ?? 0;
    values[i * 3 + 2] = items![i]?.z ?? 0;
  }
  m.channels.position = { dimension: 3, values };
  m.bounds = boundsOf(values, 3, n);
  m.version++;
}
const XYZ = ['x', 'y', 'z'];
const XY = ['x', 'y'];
const XYZW = ['x', 'y', 'z', 'w'];
const RGBA = ['r', 'g', 'b', 'a'];
const v3 = (v: Float32Array, i: number) => ({ x: v[i], y: v[i + 1], z: v[i + 2] });
const v2 = (v: Float32Array, i: number) => ({ x: v[i], y: v[i + 1] });
registerNativeDataProp('Mesh', 'vertices', { get: (_c, o) => channelRead(rt(o, 'Mesh.vertices'), 'position', v3), set: (_c, o, v) => writePositions(rt(o, 'Mesh.vertices'), v as never) });
registerNativeDataProp('Mesh', 'normals', { get: (_c, o) => channelRead(rt(o, 'Mesh.normals'), 'normal', v3), set: (_c, o, v) => writeChannel(rt(o, 'Mesh.normals'), 'normal', 'normals', v as never, XYZ) });
registerNativeDataProp('Mesh', 'tangents', { set: (_c, o, v) => writeChannel(rt(o, 'Mesh.tangents'), 'tangent', 'tangents', v as never, XYZW) });
registerNativeDataProp('Mesh', 'uv', { get: (_c, o) => channelRead(rt(o, 'Mesh.uv'), 'uv0', v2), set: (_c, o, v) => writeChannel(rt(o, 'Mesh.uv'), 'uv0', 'uv', v as never, XY) });
registerNativeDataProp('Mesh', 'uv2', { set: (_c, o, v) => writeChannel(rt(o, 'Mesh.uv2'), 'uv1', 'uv2', v as never, XY) });
registerNativeDataProp('Mesh', 'uv3', { set: (_c, o, v) => writeChannel(rt(o, 'Mesh.uv3'), 'uv2', 'uv3', v as never, XY) });
/** colors32：頂點色存 0–1（同匯入的 UNorm8 解碼） */
registerNativeDataProp('Mesh', 'colors32', { set: (_c, o, v) => writeChannel(rt(o, 'Mesh.colors32'), 'color', 'colors32', v as never, RGBA, 255) });
registerNativeDataProp('Mesh', 'colors', { set: (_c, o, v) => writeChannel(rt(o, 'Mesh.colors'), 'color', 'colors', v as never, RGBA) });
registerNativeDataProp('Mesh', 'triangles', {
  get: (_c, o) => (isInstance(o) ? [...o.indices] : [...assetOf(o, 'Mesh.triangles').indices]),
  set: (_c, o, v) => {
    const m = rt(o, 'Mesh.triangles');
    m.submeshes = [[...((v as number[]) ?? [])]];
    syncIndices(m, true);
  },
});
registerNativeDataProp('Mesh', 'subMeshCount', {
  get: (_c, o) => (isInstance(o) ? ((o as RuntimeMesh).submeshes?.length ?? 1) : 1),
  set: (_c, o, v) => {
    const m = rt(o, 'Mesh.subMeshCount');
    const n = Math.max(0, v as number);
    m.submeshes = Array.from({ length: n }, (_, i) => m.submeshes[i] ?? []);
    syncIndices(m, false);
  },
});
/** 子網格接起來給繪製端（一次畫完；子網格各自的材質還沒做） */
function syncIndices(m: RuntimeMesh, recalcBounds: boolean): void {
  m.indices = m.submeshes.flat();
  if (recalcBounds) m.bounds = boundsOf(m.channels.position?.values ?? [], 3, m.vertexCount);
  m.version++;
}

/**
 * VertexHelper.FillMesh（UnityEngine.UI VertexHelper.cs）：mesh.Clear() 之後 SetVertices、SetColors（Color32）、SetUVs(0..3, List<Vector4>)、
 * SetNormals、SetTangents、SetTriangles(indices, 0)、RecalculateBounds。uv 照 Vector4 存 4 個分量
 */
export function fillRuntimeMesh(
  o: object,
  d: { positions: ArrayLike<Record<string, number>>; colors: ArrayLike<Record<string, unknown>>; uvs: ArrayLike<Record<string, number>>[]; normals: ArrayLike<Record<string, number>>; tangents: ArrayLike<Record<string, number>>; indices: number[] },
): void {
  const m = rt(o, 'VertexHelper.FillMesh');
  Mesh_Clear$(null as never, m);
  writePositions(m, d.positions);
  writeChannel(m, 'color', 'colors32', d.colors as ArrayLike<Record<string, number>>, RGBA, 255);
  d.uvs.forEach((uv, i) => writeChannel(m, `uv${i}`, `uv${i === 0 ? '' : i + 1}`, uv, XYZW));
  writeChannel(m, 'normal', 'normals', d.normals, XYZ);
  writeChannel(m, 'tangent', 'tangents', d.tangents, XYZW);
  m.submeshes[0] = [...d.indices];
  syncIndices(m, true);
}

/** Mesh.MarkDynamic：給繪製端的提示（常常改），這裡沒有作用 */
export function Mesh_MarkDynamic(_c: Ctx, m: RuntimeMesh): void {
  rt(m, 'Mesh.MarkDynamic').dynamic = true;
}
/** Mesh.Clear(keepVertexLayout)：頂點資料與三角形清掉（子網格數不變） */
export function Mesh_Clear$(_c: Ctx, o: object): void {
  const m = rt(o, 'Mesh.Clear');
  m.vertexCount = 0;
  m.channels = {};
  m.submeshes = m.submeshes.map(() => []);
  m.indices = [];
  m.bounds = ZERO_BOUNDS();
  m.version++;
}
export const Mesh_Clear$bool = (c: Ctx, o: object, keepVertexLayout: boolean): void => void [keepVertexLayout, Mesh_Clear$(c, o)];
/** SetTriangles(triangles, indicesStart, indicesLength, submesh, calculateBounds, baseVertex) */
export function Mesh_SetTriangles$Int32_arr_int_int_int_bool_int(_c: Ctx, o: object, tris: ArrayLike<number>, start: number, length: number, submesh: number, calculateBounds = true, baseVertex = 0): void {
  const m = rt(o, 'Mesh.SetTriangles');
  if (submesh < 0 || submesh >= m.submeshes.length) {
    note(`Failed setting triangles. Submesh index is out of bounds.`);
    return;
  }
  const out: number[] = new Array(length);
  for (let i = 0; i < length; i++) out[i] = tris[start + i] + baseVertex;
  m.submeshes[submesh] = out;
  syncIndices(m, calculateBounds);
}
export const Mesh_SetTriangles$Int32_arr_int = (c: Ctx, o: object, tris: number[], submesh: number): void => Mesh_SetTriangles$Int32_arr_int_int_int_bool_int(c, o, tris, 0, tris.length, submesh);
export const Mesh_SetTriangles$Int32_arr_int_bool_int = (c: Ctx, o: object, tris: number[], submesh: number, calculateBounds: boolean, baseVertex: number): void =>
  Mesh_SetTriangles$Int32_arr_int_int_int_bool_int(c, o, tris, 0, tris.length, submesh, calculateBounds, baseVertex);
export const Mesh_SetTriangles$List_int = Mesh_SetTriangles$Int32_arr_int;
export const Mesh_SetTriangles$List_int_bool_int = Mesh_SetTriangles$Int32_arr_int_bool_int;
/** SetVertices／SetUVs／SetColors（List 版）：同整批寫 */
export const Mesh_SetVertices$List = (_c: Ctx, o: object, items: ArrayLike<Record<string, number>>): void => writePositions(rt(o, 'Mesh.SetVertices'), items);
/** Mesh.GetVertices(List<Vector3>)：清單清空、放進每個頂點的位置（UIParticle 拿 BakeMesh 的結果再換座標） */
export function Mesh_GetVertices(_c: Ctx, o: object, list: { x: number; y: number; z: number }[]): void {
  const m = rt(o, 'Mesh.GetVertices');
  list.length = 0;
  const p = m.channels.position?.values;
  if (!p) return;
  for (let i = 0; i < m.vertexCount; i++) list.push({ x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2] });
}
export const Mesh_SetUVs$int_List = (_c: Ctx, o: object, channel: number, items: ArrayLike<Record<string, number>>): void =>
  writeChannel(rt(o, 'Mesh.SetUVs'), `uv${channel}`, `uv${channel === 0 ? '' : channel + 1}`, items, XY);
export const Mesh_SetColors$List = (_c: Ctx, o: object, items: ArrayLike<Record<string, number>>): void => {
  const isC32 = items.length > 0 && (items[0] as { $color32?: boolean }).$color32;
  writeChannel(rt(o, 'Mesh.SetColors'), 'color', 'colors', items, RGBA, isC32 ? 255 : 1);
};
export const Mesh_SetNormals$List = (_c: Ctx, o: object, items: ArrayLike<Record<string, number>>): void => writeChannel(rt(o, 'Mesh.SetNormals'), 'normal', 'normals', items, XYZ);
/** RecalculateBounds：照目前的頂點 */
export function Mesh_RecalculateBounds$(_c: Ctx, o: object): void {
  const m = rt(o, 'Mesh.RecalculateBounds');
  m.bounds = boundsOf(m.channels.position?.values ?? [], 3, m.vertexCount);
}
/** RecalculateNormals：每個頂點的法線＝用到它的三角形面法線（叉積，面積加權）加總後正規化 */
export function Mesh_RecalculateNormals$(_c: Ctx, o: object): void {
  const m = rt(o, 'Mesh.RecalculateNormals');
  const p = m.channels.position?.values;
  const n = new Float32Array(m.vertexCount * 3);
  if (p)
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3];
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const i of [a, b, c]) {
        n[i] += nx;
        n[i + 1] += ny;
        n[i + 2] += nz;
      }
    }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l;
    n[i + 1] /= l;
    n[i + 2] /= l;
  }
  m.channels.normal = { dimension: 3, values: n };
  m.version++;
}

/** Mesh.bounds：複本照它目前的頂點（設 vertices 會重算），資產照匯入的 m_LocalAABB */
registerNativeDataProp('Mesh', 'bounds', {
  get: (_c, o) => (isInstance(o) ? o.bounds : assetBounds(assetOf(o, 'Mesh.bounds'))),
  set: (_c, o, v) => {
    const b = v as MeshBounds;
    rt(o, 'Mesh.bounds').bounds = { center: { ...b.center }, extents: { ...b.extents } };
  },
});
registerNativeDataProp('Mesh', 'vertexCount', {
  get: (_c, o) => (isInstance(o) ? o.vertexCount : assetOf(o, 'Mesh.vertexCount').vertexCount),
});

/**
 * Renderer.bounds（世界座標的 AABB）。MeshRenderer：同物件 MeshFilter 的網格（有執行期複本照複本，沒有照資產的 m_LocalAABB）
 * 換到世界座標：中心乘 localToWorld，半長乘矩陣 3×3 的絕對值（AABB 的仿射變換）。其他 Renderer 還沒做。
 * 物件或元件停用時 Unity 回什麼未查證，這裡照樣算。
 */
registerNativeProp('Renderer', 'bounds', {
  get: (c: Ctx, h: H): MeshBounds => {
    const world = c.w ?? getActiveWorld();
    const type = h.comp?.type;
    if (!world || type !== 'MeshRenderer') throw new NotPorted('Renderer.bounds', `${type ?? '?'} 的 bounds 還沒做（只有 MeshRenderer）`, 'Renderer_get_bounds');
    const mf = world.graph.components(h.node).find((x) => x?.type === 'MeshFilter');
    const ref = mf?.m_Mesh as { guid?: string; fileID?: string } | null | undefined;
    if (!mf || !ref?.guid) return { center: { x: 0, y: 0, z: 0 }, extents: { x: 0, y: 0, z: 0 } };
    const local = meshInstanceOf(mf)?.bounds ?? assetBounds(assetOf(ref, 'Renderer.bounds'));
    world.refreshTransform(h.node);
    const e = h.node.world.elements;
    const { x: cx, y: cy, z: cz } = local.center;
    const { x: ex, y: ey, z: ez } = local.extents;
    return {
      center: { x: e[0] * cx + e[4] * cy + e[8] * cz + e[12], y: e[1] * cx + e[5] * cy + e[9] * cz + e[13], z: e[2] * cx + e[6] * cy + e[10] * cz + e[14] },
      extents: {
        x: Math.abs(e[0]) * ex + Math.abs(e[4]) * ey + Math.abs(e[8]) * ez,
        y: Math.abs(e[1]) * ex + Math.abs(e[5]) * ey + Math.abs(e[9]) * ez,
        z: Math.abs(e[2]) * ex + Math.abs(e[6]) * ey + Math.abs(e[10]) * ez,
      },
    };
  },
});

// ───────── CanvasRenderer：網格、材質、貼圖（Spine 的 SkeletonGraphic、UIMeshRenderer 自己把網格交給 CanvasRenderer）─────────
// UnityCsReference 2022.3 Modules/UI/ScriptBindings/CanvasRenderer.bindings.cs：SetMesh／GetMesh、SetMaterial(material, index)／GetMaterial(index)、
// SetTexture、SetAlphaTexture、materialCount 是原生；SetMaterial(material, texture) 是 materialCount = Math.Max(1, materialCount)、
// SetMaterial(material, 0)、SetTexture(texture)，GetMaterial() 是 GetMaterial(0)。這裡照呼叫存下來、讀得回（狀態在 ui/canvasRenderer.ts）。
// Clear 照文件「Remove all cached vertices」只丟網格（材質與貼圖留不留未查證）。繪製端只畫登記了網格來源的類別（UIParticle，canvasMeshOf），
// 其他 Graphic 照元件資料畫（差異清單）。
function crState(h: H | null, what: string): CanvasRendererState {
  const comp = h?.comp;
  if (!comp) throw new Error(`${what}：對象是 null（C# 這裡會 NullReferenceException）`);
  return canvasRendererState(comp);
}
export const CanvasRenderer_SetMesh = (_c: Ctx, h: H, mesh: unknown): void => void (crState(h, 'CanvasRenderer.SetMesh').mesh = mesh ?? null);
export const CanvasRenderer_GetMesh = (_c: Ctx, h: H): unknown => crState(h, 'CanvasRenderer.GetMesh').mesh;
export const CanvasRenderer_Clear = (_c: Ctx, h: H): void => void (crState(h, 'CanvasRenderer.Clear').mesh = null);
export const CanvasRenderer_SetTexture = (_c: Ctx, h: H, t: unknown): void => void (crState(h, 'CanvasRenderer.SetTexture').texture = t ?? null);
export const CanvasRenderer_SetAlphaTexture = (_c: Ctx, h: H, t: unknown): void => void (crState(h, 'CanvasRenderer.SetAlphaTexture').alphaTexture = t ?? null);
export const CanvasRenderer_SetMaterial$Material_int = (_c: Ctx, h: H, m: unknown, i: number): void => void (crState(h, 'CanvasRenderer.SetMaterial').materials[i] = m ?? null);
export const CanvasRenderer_GetMaterial$int = (_c: Ctx, h: H, i: number): unknown => crState(h, 'CanvasRenderer.GetMaterial').materials[i] ?? null;
export function CanvasRenderer_SetMaterial$Material_Texture(c: Ctx, h: H, m: unknown, t: unknown): void {
  const s = crState(h, 'CanvasRenderer.SetMaterial');
  s.materialCount = Math.max(1, s.materialCount);
  CanvasRenderer_SetMaterial$Material_int(c, h, m, 0);
  CanvasRenderer_SetTexture(c, h, t);
}
export const CanvasRenderer_GetMaterial$ = (c: Ctx, h: H): unknown => CanvasRenderer_GetMaterial$int(c, h, 0);
registerNativeProp('CanvasRenderer', 'materialCount', {
  get: (_c: Ctx, h: H) => crState(h, 'CanvasRenderer.materialCount').materialCount,
  set: (_c: Ctx, h: H, v: unknown) => void (crState(h, 'CanvasRenderer.materialCount').materialCount = Number(v)),
});
/**
 * CanvasRenderer.cull：RectMask2D 的剔除結果（ui/rectMask2d.ts 每格排版後 cullAll，等於 MaskableGraphic.UpdateCull 寫的值）。
 * 腳本自己設的值沒有存（差異清單）
 */
registerNativeProp('CanvasRenderer', 'cull', { get: (c: Ctx, h: H) => (c.w ?? getActiveWorld())?.clips.isCulled(h.node.id) ?? false });
/** CanvasRenderer.GetColor／SetColor：顏色存在元件資料的 $color（ui/canvasRenderer.ts，Selectable 的 ColorTint 也是它） */
export function CanvasRenderer_GetColor(c: Ctx, h: H): ColorRGBA {
  const world = c.w ?? getActiveWorld();
  if (!world || !h?.comp) throw new Error('CanvasRenderer.GetColor：對象是 null（C# 這裡會 NullReferenceException）');
  return getCanvasRendererColor(world.graph, h.node) ?? { r: 1, g: 1, b: 1, a: 1 };
}
export function CanvasRenderer_SetColor(c: Ctx, h: H, color: ColorRGBA): void {
  const world = c.w ?? getActiveWorld();
  if (!world || !h?.comp) throw new Error('CanvasRenderer.SetColor：對象是 null（C# 這裡會 NullReferenceException）');
  setCanvasRendererColor(world.graph, h.node, color);
}

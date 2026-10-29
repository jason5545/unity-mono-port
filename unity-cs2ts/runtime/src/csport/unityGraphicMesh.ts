// 相容層：腳本自己產網格的 Graphic（unity.ts 會 export * 這裡）。UnityEngine.UI 的 VertexHelper、UIVertex、Sprites.DataUtility，
// 與 Graphic 的重建流程（UnityEngine.UI Graphic.cs:385-515，原始碼在 mt2-web/reference/decompiled/UnityEngine.UI）。
//
// uGUI 的 Graphic 在這個專案是執行環境原生的（cs2ts.json 的 exclude）：Image、RawImage、TMP 由繪製端照元件欄位畫，不跑 OnPopulateMesh。
// 遊戲繼承 Graphic／MaskableGraphic、自己覆寫 OnPopulateMesh(VertexHelper) 的類別（UI Extensions 的 UILineRenderer：出牌的瞄準曲線）以前完全沒畫，
// 現在照原版的流程：
//   - OnEnable（Graphic.OnEnable 的 SetAllDirty）、SetAllDirty／SetVerticesDirty／SetMaterialDirty 記髒旗標（unityNative.ts 的 markGraphicDirty）。
//     原生欄位的 set 在 Unity 也會記（Graphic.color、material、OnRectTransformDimensionsChange）：這裡每格比對 rect、顏色、材質，變了才記。
//   - Canvas 畫之前（willRenderCanvases，排版之後）對髒的叫 Rebuild(PreRender)：子類別覆寫了就叫它，沒有走原生的版本
//     → UpdateGeometry（DoMeshGeneration：OnPopulateMesh(s_VertexHelper)、同一個物件上 IMeshModifier 的 ModifyMesh、FillMesh、CanvasRenderer.SetMesh）
//     → UpdateMaterial（CanvasRenderer 的材質 ＝ materialForRendering、貼圖 ＝ mainTexture）。
//   - OnDisable：CanvasRenderer.Clear。
// 繪製端照 UIParticle 那條 CanvasRenderer 網格路徑畫（ui/canvasRenderer.ts 的 registerCanvasMeshResolver；材質、Mask／RectMask2D、排序同 Image）。

import { registerWillRenderCanvases, type World } from '../engine/world';
import { canvasRendererState, existingCanvasRendererState, registerCanvasMeshResolver } from '../ui/canvasRenderer';
import { registerGraphicMeshModifier, type GraphicVertices } from '../ui/graphicMeshModifier';
import { innerUV, outerUV, spritePadding } from '../ui/imageMesh';
import type { SpriteInfo } from '../unity/assets';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { compHandle, componentVirtualGet, ctxOf, genCallVirtual, genClass, genMethodOf, genNativeBaseOf, getActiveWorld, H, hasGen, newExternal, registerExternalCtor, scriptGenName, staticCtx, type Ctx } from './core';
import { fillRuntimeMesh } from './unityMesh';
import { nativeGet, registerNativeBase, registerNativeStatic } from './unityNative';

type V3 = { x: number; y: number; z: number };
type V4 = { x: number; y: number; z: number; w: number };
type C32 = { r: number; g: number; b: number; a: number; $color32: true };

// ───────── UIVertex ─────────

/** UIVertex（UnityEngine 的 struct）：一般物件、不帶 $type，指定與傳參時 cloneData 照欄位複製 */
export interface UIVertex {
  position: V3;
  normal: V3;
  tangent: V4;
  color: C32;
  uv0: V4;
  uv1: V4;
  uv2: V4;
  uv3: V4;
}
const vec3 = (v: Partial<V3> | null | undefined): V3 => ({ x: v?.x ?? 0, y: v?.y ?? 0, z: v?.z ?? 0 });
const vec4 = (v: Partial<V4> | null | undefined): V4 => ({ x: v?.x ?? 0, y: v?.y ?? 0, z: v?.z ?? 0, w: v?.w ?? 0 });
/** Color32；傳進來的是 Color（0–1）時照 Color → Color32 的隱含轉型（四捨五入到偶數，同 unityMath.ts） */
function color32(c: Partial<C32> & { $color32?: boolean } | null | undefined): C32 {
  if (!c) return { r: 0, g: 0, b: 0, a: 0, $color32: true };
  if (c.$color32) return { r: c.r ?? 0, g: c.g ?? 0, b: c.b ?? 0, a: c.a ?? 0, $color32: true };
  const k = (x: number | undefined) => {
    const v = Math.min(1, Math.max(0, x ?? 0)) * 255;
    const f = Math.floor(v);
    return v - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(v);
  };
  return { r: k(c.r), g: k(c.g), b: k(c.b), a: k(c.a), $color32: true };
}
const ZERO4: V4 = { x: 0, y: 0, z: 0, w: 0 };
/** VertexHelper 的預設法線與切線（VertexHelper.cs：s_DefaultNormal ＝ Vector3.back、s_DefaultTangent ＝ (1, 0, 0, −1)） */
const DEFAULT_NORMAL: V3 = { x: 0, y: 0, z: -1 };
const DEFAULT_TANGENT: V4 = { x: 1, y: 0, z: 0, w: -1 };
/** new UIVertex()／default(UIVertex)：全部是 0 */
export function newUIVertex(): UIVertex {
  return { position: vec3(null), normal: vec3(null), tangent: vec4(null), color: color32(null), uv0: vec4(null), uv1: vec4(null), uv2: vec4(null), uv3: vec4(null) };
}
/** UIVertex.simpleVert：位置 0、法線 back、切線 (1, 0, 0, −1)、白色、uv 0 */
export function simpleVert(): UIVertex {
  return { ...newUIVertex(), normal: { ...DEFAULT_NORMAL }, tangent: { ...DEFAULT_TANGENT }, color: { r: 255, g: 255, b: 255, a: 255, $color32: true } };
}
registerExternalCtor('UIVertex', newUIVertex);
registerNativeStatic('UIVertex', 'simpleVert', simpleVert);

// ───────── VertexHelper ─────────

/** VertexHelper（UnityEngine.UI VertexHelper.cs）：九條清單，頂點的各個 channel 與三角形索引。C# 是 class，參照語意 */
export class VertexHelper {
  readonly $type = 'VertexHelper';
  positions: V3[] = [];
  colors: C32[] = [];
  uv0s: V4[] = [];
  uv1s: V4[] = [];
  uv2s: V4[] = [];
  uv3s: V4[] = [];
  normals: V3[] = [];
  tangents: V4[] = [];
  indices: number[] = [];
  get currentVertCount(): number {
    return this.positions.length;
  }
  get currentIndexCount(): number {
    return this.indices.length;
  }
  clear(): void {
    for (const l of [this.positions, this.colors, this.uv0s, this.uv1s, this.uv2s, this.uv3s, this.normals, this.tangents, this.indices]) l.length = 0;
  }
  addVert(position: Partial<V3>, color: Partial<C32>, uv0: Partial<V4>, uv1: Partial<V4>, uv2: Partial<V4>, uv3: Partial<V4>, normal: Partial<V3>, tangent: Partial<V4>): void {
    this.positions.push(vec3(position));
    this.colors.push(color32(color));
    this.uv0s.push(vec4(uv0));
    this.uv1s.push(vec4(uv1));
    this.uv2s.push(vec4(uv2));
    this.uv3s.push(vec4(uv3));
    this.normals.push(vec3(normal));
    this.tangents.push(vec4(tangent));
  }
  addUIVertex(v: UIVertex): void {
    this.addVert(v.position, v.color, v.uv0, v.uv1, v.uv2, v.uv3, v.normal, v.tangent);
  }
  /** 第 i 個頂點（各 channel 複製一份）；超出範圍同 List 的索引子丟錯 */
  vertexAt(i: number): UIVertex {
    if (!(i >= 0 && i < this.positions.length)) throw new Error(`VertexHelper：頂點索引 ${i} 超出範圍（共 ${this.positions.length} 個；C# 會 ArgumentOutOfRangeException）`);
    return {
      position: vec3(this.positions[i]),
      color: color32(this.colors[i]),
      uv0: vec4(this.uv0s[i]),
      uv1: vec4(this.uv1s[i]),
      uv2: vec4(this.uv2s[i]),
      uv3: vec4(this.uv3s[i]),
      normal: vec3(this.normals[i]),
      tangent: vec4(this.tangents[i]),
    };
  }
}
export const new_VertexHelper$ = (_c: Ctx): VertexHelper => new VertexHelper();
/** new VertexHelper(Mesh)：照網格的頂點、頂點色、4 個 uv、法線、切線、第 0 個子網格的三角形 */
export function new_VertexHelper$Mesh(_c: Ctx, m: { vertexCount: number; channels: Record<string, { dimension: number; values: ArrayLike<number> }>; submeshes?: number[][]; indices: number[] }): VertexHelper {
  const vh = new VertexHelper();
  const read = (name: string, i: number, k: number, def: number, scale = 1) => {
    const ch = m.channels[name];
    return ch && k < ch.dimension ? ch.values[i * ch.dimension + k] * scale : def;
  };
  for (let i = 0; i < m.vertexCount; i++) {
    const v4 = (name: string) => ({ x: read(name, i, 0, 0), y: read(name, i, 1, 0), z: read(name, i, 2, 0), w: read(name, i, 3, 0) });
    vh.positions.push({ x: read('position', i, 0, 0), y: read('position', i, 1, 0), z: read('position', i, 2, 0) });
    vh.colors.push({ r: Math.round(read('color', i, 0, 1, 255)), g: Math.round(read('color', i, 1, 1, 255)), b: Math.round(read('color', i, 2, 1, 255)), a: Math.round(read('color', i, 3, 1, 255)), $color32: true });
    vh.uv0s.push(v4('uv0'));
    vh.uv1s.push(v4('uv1'));
    vh.uv2s.push(v4('uv2'));
    vh.uv3s.push(v4('uv3'));
    vh.normals.push({ x: read('normal', i, 0, 0), y: read('normal', i, 1, 0), z: read('normal', i, 2, 0) });
    vh.tangents.push(v4('tangent'));
  }
  vh.indices.push(...(m.submeshes?.[0] ?? m.indices));
  return vh;
}
export const VertexHelper_Clear = (_c: Ctx, vh: VertexHelper): void => vh.clear();
/** Dispose：清單還給池子，之後再加頂點會重新拿（效果同清空） */
export const VertexHelper_Dispose = VertexHelper_Clear;
/** PopulateUIVertex(ref vertex, i)：八個欄位全部換成第 i 個頂點的（ref 參數是產生碼的 { get v, set v } 盒子） */
export function VertexHelper_PopulateUIVertex(_c: Ctx, vh: VertexHelper, ref: { v: UIVertex }, i: number): void {
  ref.v = vh.vertexAt(i);
}
export function VertexHelper_SetUIVertex(_c: Ctx, vh: VertexHelper, v: UIVertex, i: number): void {
  vh.vertexAt(i); // 範圍檢查
  vh.positions[i] = vec3(v.position);
  vh.colors[i] = color32(v.color);
  vh.uv0s[i] = vec4(v.uv0);
  vh.uv1s[i] = vec4(v.uv1);
  vh.uv2s[i] = vec4(v.uv2);
  vh.uv3s[i] = vec4(v.uv3);
  vh.normals[i] = vec3(v.normal);
  vh.tangents[i] = vec4(v.tangent);
}
/** FillMesh：65000 個頂點以上丟 ArgumentException（VertexHelper.cs） */
export function VertexHelper_FillMesh(_c: Ctx, vh: VertexHelper, mesh: object): void {
  if (vh.positions.length >= 65000) throw new Error('ArgumentException: Mesh can not have more than 65000 vertices');
  fillRuntimeMesh(mesh, { positions: vh.positions, colors: vh.colors, uvs: [vh.uv0s, vh.uv1s, vh.uv2s, vh.uv3s], normals: vh.normals, tangents: vh.tangents, indices: vh.indices });
}
export const VertexHelper_AddVert$Vector3_Color32_Vector4_Vector4_Vector4_Vector4_Vector3_Vector4 = (_c: Ctx, vh: VertexHelper, p: V3, col: C32, uv0: V4, uv1: V4, uv2: V4, uv3: V4, n: V3, t: V4): void =>
  vh.addVert(p, col, uv0, uv1, uv2, uv3, n, t);
export const VertexHelper_AddVert$Vector3_Color32_Vector4_Vector4_Vector3_Vector4 = (_c: Ctx, vh: VertexHelper, p: V3, col: C32, uv0: V4, uv1: V4, n: V3, t: V4): void =>
  vh.addVert(p, col, uv0, uv1, ZERO4, ZERO4, n, t);
export const VertexHelper_AddVert$Vector3_Color32_Vector4 = (_c: Ctx, vh: VertexHelper, p: V3, col: C32, uv0: V4): void =>
  vh.addVert(p, col, uv0, ZERO4, ZERO4, ZERO4, DEFAULT_NORMAL, DEFAULT_TANGENT);
export const VertexHelper_AddVert$UIVertex = (_c: Ctx, vh: VertexHelper, v: UIVertex): void => vh.addUIVertex(v);
export function VertexHelper_AddTriangle(_c: Ctx, vh: VertexHelper, a: number, b: number, c: number): void {
  vh.indices.push(a, b, c);
}
/** AddUIVertexQuad：四個頂點（uv2、uv3 不帶，同 AddVert 的六參數版本）、兩個三角形 (0,1,2)、(2,3,0) */
export function VertexHelper_AddUIVertexQuad(_c: Ctx, vh: VertexHelper, verts: UIVertex[]): void {
  const n = vh.currentVertCount;
  for (let i = 0; i < 4; i++) vh.addVert(verts[i].position, verts[i].color, verts[i].uv0, verts[i].uv1, ZERO4, ZERO4, verts[i].normal, verts[i].tangent);
  vh.indices.push(n, n + 1, n + 2, n + 2, n + 3, n);
}
/** AddUIVertexStream(verts, indices)：頂點接在後面（CanvasRenderer.AddUIVertexStream），索引照原樣接上 */
export function VertexHelper_AddUIVertexStream(_c: Ctx, vh: VertexHelper, verts: UIVertex[] | null, indices: number[] | null): void {
  if (verts) for (const v of verts) vh.addUIVertex(v);
  if (indices) vh.indices.push(...indices);
}
/**
 * AddUIVertexTriangleStream(verts)：三個一組的三角形串（CanvasRenderer.SplitUIVertexStreams）。原生程式看不到；這裡照「整份換成這串、索引 0..n−1」做
 * （未查證；遊戲都是先 Clear 再加，接在後面或整份換掉結果一樣）
 */
export function VertexHelper_AddUIVertexTriangleStream(_c: Ctx, vh: VertexHelper, verts: UIVertex[] | null): void {
  if (!verts) return;
  vh.clear();
  verts.forEach((v, i) => {
    vh.addUIVertex(v);
    vh.indices.push(i);
  });
}
/** GetUIVertexStream(stream)：照三角形索引展開成三個一組的頂點串（CanvasRenderer.CreateUIVertexStream；清單先清空，未查證） */
export function VertexHelper_GetUIVertexStream(_c: Ctx, vh: VertexHelper, stream: UIVertex[] | null): void {
  if (!stream) return;
  stream.length = 0;
  for (const i of vh.indices) stream.push(vh.vertexAt(i));
}

// ───────── Sprites.DataUtility（ui/imageMesh.ts 的算法） ─────────

type SpriteRef = { guid: string; fileID: string | number };
function spriteOf(c: Ctx, s: SpriteRef | null): SpriteInfo | null {
  if (!s) throw new Error('DataUtility：sprite 是 null（C# 會 NullReferenceException）');
  return (c.w ?? getActiveWorld())?.services.render?.spriteInfo(s as never) ?? null;
}
const asV4 = (a: [number, number, number, number] | null): V4 => (a ? { x: a[0], y: a[1], z: a[2], w: a[3] } : { ...ZERO4 });
export const DataUtility_GetOuterUV = (c: Ctx, s: SpriteRef): V4 => {
  const i = spriteOf(c, s);
  return asV4(i ? outerUV(i) : null);
};
export const DataUtility_GetInnerUV = (c: Ctx, s: SpriteRef): V4 => {
  const i = spriteOf(c, s);
  return asV4(i ? innerUV(i) : null);
};
export const DataUtility_GetPadding = (c: Ctx, s: SpriteRef): V4 => {
  const i = spriteOf(c, s);
  return asV4(i ? spritePadding(i) : null);
};

// ───────── Graphic 的重建 ─────────

/** 產生的類別是不是腳本自己產網格的 Graphic：產生的基底鏈接到原生的 Graphic／MaskableGraphic，鏈上覆寫了 OnPopulateMesh(VertexHelper) */
const populateCache = new Map<string, boolean>();
export function isPopulateMeshGraphic(cls: string): boolean {
  let v = populateCache.get(cls);
  if (v === undefined) {
    const nb = hasGen(cls) ? genNativeBaseOf(cls) : null;
    v = (nb === 'Graphic' || nb === 'MaskableGraphic') && !!genMethodOf(cls, 'OnPopulateMesh$VertexHelper');
    populateCache.set(cls, v);
  }
  return v;
}

interface Target {
  h: H;
  cls: string;
  /** 上一次看到的 rect 與顏色（變了記 m_VertsDirty）、材質（變了記 m_MaterialDirty） */
  vertsSig: string | null;
  materialSig: string | null;
}
/** 啟用過的對象（Graphic.OnEnable 登記；Unity 的 CanvasUpdateRegistry 只收髒的，這裡每格看旗標） */
const targets = new Map<ComponentData, Target>();
/** Graphic.s_VertexHelper：全部 Graphic 共用一個（OnPopulateMesh 自己 Clear；沒清的話留著上一個的內容，同原版） */
const sVertexHelper = new VertexHelper();
/** 每個 CanvasRenderer 自己一份網格（Unity 的 workerMesh 是共用的，SetMesh 時複製進 CanvasRenderer；這裡 SetMesh 存參照，所以各給一份） */
const meshes = new WeakMap<ComponentData, object>();

function targetOf(self: unknown): Target | null {
  const comp = self instanceof H ? self.comp : null;
  return comp ? (targets.get(comp) ?? null) : null;
}
function worldOf(c: Ctx): World {
  const w = c.w ?? getActiveWorld();
  if (!w) throw new Error('Graphic 重建：沒有作用中的 World');
  return w;
}
const isActive = (t: Target): boolean => t.h.node.activeInHierarchy && t.h.comp!.m_Enabled !== 0;

/** Graphic.OnEnable：登記、SetAllDirty（Graphic.cs:385-395） */
registerNativeBase('Graphic.OnEnable', (_c, self) => {
  const h = self as H;
  const comp = h instanceof H ? h.comp : null;
  const cls = comp ? scriptGenName(comp.script) : undefined;
  if (!comp || !cls || !isPopulateMeshGraphic(cls)) return;
  if (!targets.has(comp)) targets.set(comp, { h, cls, vertsSig: null, materialSig: null });
  comp.$vertsDirty = true;
  comp.$materialDirty = true;
});
/** Graphic.OnDisable：canvasRenderer.Clear()（Graphic.cs:397-408） */
registerNativeBase('Graphic.OnDisable', (c, self) => {
  const t = targetOf(self);
  if (!t) return;
  const cr = worldOf(c).graph.component(t.h.node, 'CanvasRenderer');
  const st = cr ? existingCanvasRendererState(cr) : null;
  if (st) st.mesh = null;
});
/** Graphic.Rebuild(update)：PreRender 時髒的頂點 → UpdateGeometry、髒的材質 → UpdateMaterial（Graphic.cs:449-463；canvasRenderer.cull 沒做） */
registerNativeBase('Graphic.Rebuild', (c, self, update) => {
  const t = targetOf(self);
  if (!t || update !== 3 /* CanvasUpdate.PreRender */) return;
  const comp = t.h.comp!;
  if (comp.$vertsDirty) {
    updateGeometry(worldOf(c), t);
    comp.$vertsDirty = false;
  }
  if (comp.$materialDirty) {
    updateMaterial(worldOf(c), t);
    comp.$materialDirty = false;
  }
});
registerNativeBase('Graphic.UpdateGeometry', (c, self) => {
  const t = targetOf(self);
  if (t) doMeshGeneration(worldOf(c), t);
});
registerNativeBase('Graphic.UpdateMaterial', (c, self) => {
  const t = targetOf(self);
  if (t) nativeUpdateMaterial(worldOf(c), t);
});

/** UpdateGeometry（virtual）：子類別覆寫了叫它，沒有是 DoMeshGeneration */
function updateGeometry(w: World, t: Target): void {
  if (genMethodOf(t.cls, 'UpdateGeometry')) genCallVirtual(w, t.cls, t.h, 'UpdateGeometry');
  else doMeshGeneration(w, t);
}
/** UpdateMaterial（virtual）：同上 */
function updateMaterial(w: World, t: Target): void {
  if (genMethodOf(t.cls, 'UpdateMaterial')) genCallVirtual(w, t.cls, t.h, 'UpdateMaterial');
  else nativeUpdateMaterial(w, t);
}

/**
 * DoMeshGeneration（Graphic.cs:496-515）：rect 寬高不是負的才 OnPopulateMesh，否則清空；同一個物件上的 IMeshModifier 依元件順序 ModifyMesh；
 * FillMesh、CanvasRenderer.SetMesh。useLegacyMeshGeneration 的那條（OnPopulateMesh(Mesh)）結果相同，不分開做。
 * IMeshModifier 只叫產生碼的（BaseMeshEffect 的子類別；Shadow、Outline、PositionAsUV1 由遊戲專案從 UnityEngine.UI 的原始碼轉）
 */
function doMeshGeneration(w: World, t: Target): void {
  const node = t.h.node;
  const vh = sVertexHelper;
  if (node.rect.width >= 0 && node.rect.height >= 0) genCallVirtual(w, t.cls, t.h, 'OnPopulateMesh$VertexHelper', vh);
  else vh.clear();
  for (const other of w.graph.components(node)) {
    const oc = scriptGenName(other.script);
    if (!oc || !hasGen(oc) || !implementsMeshModifier(oc) || !genMethodOf(oc, 'ModifyMesh$VertexHelper')) continue;
    genCallVirtual(w, oc, compHandle(w, other), 'ModifyMesh$VertexHelper', vh);
  }
  const comp = t.h.comp!;
  let mesh = meshes.get(comp);
  if (!mesh) meshes.set(comp, (mesh = newExternal(staticCtx, 'Mesh')));
  VertexHelper_FillMesh(staticCtx, vh, mesh);
  const cr = w.graph.component(node, 'CanvasRenderer');
  if (cr) canvasRendererState(cr).mesh = mesh;
}
function implementsMeshModifier(cls: string): boolean {
  for (let k: string | undefined = cls; k && hasGen(k); k = genClass(k).base) if (genClass(k).interfaces?.includes('IMeshModifier')) return true;
  return false;
}

/**
 * UpdateMaterial（Graphic.cs:474-482）：CanvasRenderer 一個材質 ＝ materialForRendering、貼圖 ＝ mainTexture。
 * materialForRendering 套 IMaterialModifier（Mask 的模板）的那一步由繪製端照 Mask 自己算，這裡給 material 本身
 */
function nativeUpdateMaterial(w: World, t: Target): void {
  if (!isActive(t)) return;
  const comp = t.h.comp!;
  const cr = w.graph.component(t.h.node, 'CanvasRenderer');
  if (!cr) return;
  const st = canvasRendererState(cr);
  const c = ctxOf(w, t.h, t.cls);
  const material = componentVirtualGet(comp, 'material');
  const texture = componentVirtualGet(comp, 'mainTexture');
  st.materialCount = 1;
  st.materials[0] = material === undefined ? nativeGet(c, t.h, 'Graphic', 'material') : material;
  // Graphic.mainTexture 的原生版本是 s_WhiteTexture（Image、RawImage 才看 sprite、texture）
  st.texture = texture === undefined ? nativeGet(c, null, 'Graphic', 's_WhiteTexture') : texture;
}

/** 原生欄位的變化（Unity 由屬性的 set 與 OnRectTransformDimensionsChange 記髒）：rect、顏色 → 頂點；材質 → 材質 */
function vertsSigOf(t: Target): string {
  const r = t.h.node.rect;
  const col = t.h.comp!.m_Color as { r: number; g: number; b: number; a: number } | undefined;
  return `${r.width},${r.height},${col ? `${col.r},${col.g},${col.b},${col.a}` : ''}`;
}
function materialSigOf(t: Target): string {
  const m = t.h.comp!.m_Material as { guid?: string; $asset?: string } | null | undefined;
  return m ? (m.guid ?? m.$asset ?? 'runtime') : '';
}

/** Canvas.willRenderCanvases（排版之後）：CanvasUpdateRegistry.PerformUpdate 的 PreRender 這一步 */
export function rebuildGraphics(w: World): void {
  for (const [comp, t] of targets) {
    const node = t.h.node;
    if (w.graph.nodes.get(node.id) !== node) {
      targets.delete(comp); // 銷毀了
      continue;
    }
    if (!isActive(t)) continue;
    const vs = vertsSigOf(t);
    if (vs !== t.vertsSig) {
      t.vertsSig = vs;
      comp.$vertsDirty = true;
    }
    const ms = materialSigOf(t);
    if (ms !== t.materialSig) {
      t.materialSig = ms;
      comp.$materialDirty = true;
    }
    if (!comp.$vertsDirty && !comp.$materialDirty) continue;
    w.guard(`${t.cls}.Rebuild`, () => {
      if (genMethodOf(t.cls, 'Rebuild')) genCallVirtual(w, t.cls, t.h, 'Rebuild', 3 /* CanvasUpdate.PreRender */);
      else {
        if (comp.$vertsDirty) updateGeometry(w, t);
        comp.$vertsDirty = false;
        if (comp.$materialDirty) updateMaterial(w, t);
        comp.$materialDirty = false;
      }
    });
  }
}
registerWillRenderCanvases(rebuildGraphics);

/** 繪製端的材質要資產參照（{guid, fileID}）：materialOf 包過的換回參照，執行期建的材質（沒有資產）還不能畫 */
function materialRefOf(m: unknown): unknown {
  const o = m as { guid?: string; $type?: string; $asset?: string } | null;
  if (!o) return null;
  if (typeof o.guid === 'string') return o;
  if (o.$type === 'Material' && o.$asset) return { guid: o.$asset, fileID: '2100000' };
  return null;
}
/** 繪製端：這些類別的網格是 CanvasRenderer 上的（Rebuild 交的），材質、貼圖照 UpdateMaterial 交的 */
registerCanvasMeshResolver((cls) =>
  isPopulateMeshGraphic(cls)
    ? (node: SceneNode) => {
        const w = getActiveWorld();
        const cr = w?.graph.component(node, 'CanvasRenderer');
        const st = cr ? existingCanvasRendererState(cr) : null;
        if (!st?.mesh) return null;
        return { mesh: st.mesh, material: materialRefOf(st.materials[0]), texture: st.texture };
      }
    : null,
);

// ───────── 原生 Graphic（Image）的 IMeshModifier ─────────
// 繪製端照元件欄位產 Image 的網格（ui/imageMesh.ts ＝ Image.OnPopulateMesh），產完交給這裡：照 DoMeshGeneration 的順序，
// 同一個物件上每個 IMeshModifier（停用的也叫，Unity 用 GetComponents；各自的 ModifyMesh 自己看 IsActive）。
// 頂點進 VertexHelper 照 Image.OnPopulateMesh 的 AddVert(位置, color32, uv0)：法線、切線是預設值，uv1–3 是 0

/** 類別是不是產生碼的網格修改器（繪製端每格對每個 Image 問，照類別記住） */
const modifierClassCache = new Map<string, boolean>();
function isMeshModifierClass(cls: string): boolean {
  let v = modifierClassCache.get(cls);
  if (v === undefined) modifierClassCache.set(cls, (v = hasGen(cls) && implementsMeshModifier(cls) && !!genMethodOf(cls, 'ModifyMesh$VertexHelper')));
  return v;
}
type ModifierList = { comp: ComponentData; cls: string }[];
const NO_MODIFIERS: ModifierList = [];
/**
 * 這個節點上產生碼的網格修改器（元件順序）。有修改器的節點整棵樹掃一次記起來，節點或元件增減（membershipVersion）才重掃：
 * 繪製端每格對每個 Image 問（MT2 戰鬥 1500 個啟用中的 Image，有修改器的 3 個；逐個查元件每格約 0.9 ms）
 */
function meshModifiersOf(w: World, node: SceneNode): ModifierList {
  const table = w.graph.cached(
    'meshModifiers',
    () => {
      const m = new Map<SceneNode, ModifierList>();
      for (const n of w.graph.nodes.values()) {
        let list: ModifierList | null = null;
        for (const comp of w.graph.components(n)) {
          if (!comp.script) continue;
          const cls = scriptGenName(comp.script);
          if (cls && isMeshModifierClass(cls)) (list ??= []).push({ comp, cls });
        }
        if (list) m.set(n, list);
      }
      return m;
    },
    'membership',
  );
  return table.get(node) ?? NO_MODIFIERS;
}
/** 欄位的簽章：數值、字串、資料物件（Gradient、Color）照值；元件與 GameObject 的參照只看有沒有（不展開） */
function fieldSig(v: unknown, depth: number): string {
  if (v === null || v === undefined) return '-';
  if (typeof v !== 'object') return typeof v === 'function' ? 'f' : String(v);
  if (v instanceof H) return 'H';
  if (depth >= 3) return 'o';
  if (Array.isArray(v)) return `[${v.map((x) => fieldSig(x, depth + 1)).join(',')}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .filter(([k]) => !k.startsWith('$'))
    .map(([k, x]) => `${k}:${fieldSig(x, depth + 1)}`)
    .join(',')}}`;
}
registerGraphicMeshModifier({
  signature(node) {
    const w = getActiveWorld();
    if (!w) return '';
    const mods = meshModifiersOf(w, node);
    if (mods.length === 0) return '';
    return mods
      .map(({ comp, cls }) => {
        const ai = ctxOf(w, compHandle(w, comp), cls).ai as Record<string, unknown>;
        return `${cls}:${comp.m_Enabled === 0 ? 0 : 1}:${fieldSig(ai, 0)}`;
      })
      .join('|');
  },
  modify(node, mesh) {
    const w = getActiveWorld();
    if (!w) return null;
    const mods = meshModifiersOf(w, node);
    if (mods.length === 0) return null;
    const vh = new VertexHelper();
    const n = mesh.positions.length / 3;
    for (let i = 0; i < n; i++) {
      const col = { r: mesh.colors[i * 4], g: mesh.colors[i * 4 + 1], b: mesh.colors[i * 4 + 2], a: mesh.colors[i * 4 + 3] };
      vh.addVert(
        { x: mesh.positions[i * 3], y: mesh.positions[i * 3 + 1], z: mesh.positions[i * 3 + 2] },
        color32(col),
        { x: mesh.uvs[i * 2], y: mesh.uvs[i * 2 + 1], z: 0, w: 0 },
        ZERO4,
        ZERO4,
        ZERO4,
        DEFAULT_NORMAL,
        DEFAULT_TANGENT,
      );
    }
    vh.indices.push(...mesh.indices);
    for (const { comp, cls } of mods) w.guard(`${cls}.ModifyMesh`, () => genCallVirtual(w, cls, compHandle(w, comp), 'ModifyMesh$VertexHelper', vh));
    const out: GraphicVertices = { positions: [], uvs: [], colors: [], indices: [...vh.indices] };
    for (let i = 0; i < vh.currentVertCount; i++) {
      const p = vh.positions[i];
      const c = vh.colors[i];
      const uv = vh.uv0s[i];
      out.positions.push(p.x, p.y, p.z);
      out.uvs.push(uv.x, uv.y);
      out.colors.push(c.r / 255, c.g / 255, c.b / 255, c.a / 255);
    }
    return out;
  },
});

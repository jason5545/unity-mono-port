// CanvasRenderer 的顏色（CanvasRenderer.GetColor／SetColor）。對應 Unity 的 CanvasRenderer：
// 顏色存在元件資料的 $color 欄位（匯入時沒有這個欄位，等同于白色）。Graphic.CrossFadeColor 套用的就是這個顏色。

import type { SceneGraph, SceneNode } from '../unity/scene';
import type { ColorRGBA } from '../unity/types';

const WHITE = (): ColorRGBA => ({ r: 1, g: 1, b: 1, a: 1 });

/** CanvasRenderer.GetColor：沒有 CanvasRenderer 回 null；$color 是複本，沒有時白色 */
export function getCanvasRendererColor(graph: SceneGraph, node: SceneNode): ColorRGBA | null {
  const cr = graph.component(node, 'CanvasRenderer');
  if (!cr) return null;
  const c = cr.$color as ColorRGBA | undefined;
  return c ? { ...c } : WHITE();
}

/** CanvasRenderer.SetColor：沒有 CanvasRenderer 什麼都不做；寫入複本 */
export function setCanvasRendererColor(graph: SceneGraph, node: SceneNode, color: ColorRGBA): void {
  const cr = graph.component(node, 'CanvasRenderer');
  if (!cr) return;
  cr.$color = { ...color };
}

// ───────── CanvasRenderer 的網格、材質、貼圖（腳本自己把網格交給 CanvasRenderer：UIParticle、Spine 的 SkeletonGraphic） ─────────
// UnityCsReference 2022.3 Modules/UI/ScriptBindings/CanvasRenderer.bindings.cs：SetMesh／GetMesh、SetMaterial(material, index)、SetTexture。
// 狀態照 CanvasRenderer 元件資料存（csport/unityMesh.ts 的腳本 API 讀寫這裡），繪製端照 canvasMeshOf 的來源畫。

export interface CanvasRendererState {
  mesh: unknown;
  materials: unknown[];
  materialCount: number;
  texture: unknown;
  alphaTexture: unknown;
}
const canvasRenderers = new WeakMap<object, CanvasRendererState>();
/** 這個 CanvasRenderer 元件的狀態（第一次用到才建） */
export function canvasRendererState(comp: object): CanvasRendererState {
  let s = canvasRenderers.get(comp);
  if (!s) canvasRenderers.set(comp, (s = { mesh: null, materials: [], materialCount: 0, texture: null, alphaTexture: null }));
  return s;
}
/** 已經有狀態的才回（繪製端用；沒被腳本碰過的 CanvasRenderer 回 null） */
export function existingCanvasRendererState(comp: object): CanvasRendererState | null {
  return canvasRenderers.get(comp) ?? null;
}

/**
 * 腳本自己產網格的 Graphic 要畫什麼（csport 登記：UIParticle 的材質是粒子 Renderer 的材質，要叫產生碼的 material 屬性才知道）。
 * mesh 是執行期的 Mesh（MeshInstance），material 是材質參照（資產 {guid, fileID} 或執行期的 Material）
 */
export interface CanvasMeshSource {
  mesh: unknown;
  material: unknown;
  texture: unknown;
}
export type CanvasMeshProvider = (node: SceneNode, comp: object) => CanvasMeshSource | null;
const providers = new Map<string, CanvasMeshProvider>();
/** 照類別判斷的來源（csport 登記：覆寫 OnPopulateMesh 的 Graphic 子類別，類別名要看產生碼才知道） */
const resolvers: ((scriptClass: string) => CanvasMeshProvider | null)[] = [];
/** 問過、不是的類別（繪製端每格對每個繪製物件查） */
const notMesh = new Set<string>();
/** 登記某個腳本類別（Graphic 的子類別）的網格來源 */
export function registerCanvasMeshSource(scriptClass: string, fn: CanvasMeshProvider): void {
  providers.set(scriptClass, fn);
  notMesh.delete(scriptClass);
}
/** 登記照類別判斷的網格來源（類別第一次被問到時決定，之後記住） */
export function registerCanvasMeshResolver(fn: (scriptClass: string) => CanvasMeshProvider | null): void {
  resolvers.push(fn);
  notMesh.clear();
}
function providerOf(scriptClass: string): CanvasMeshProvider | undefined {
  const p = providers.get(scriptClass);
  if (p || notMesh.has(scriptClass)) return p;
  for (const r of resolvers) {
    const q = r(scriptClass);
    if (q) {
      providers.set(scriptClass, q);
      return q;
    }
  }
  notMesh.add(scriptClass);
  return undefined;
}
/** 這個腳本類別的網格是不是腳本自己交給 CanvasRenderer 的 */
export function isCanvasMeshClass(scriptClass: string): boolean {
  return providerOf(scriptClass) !== undefined;
}
export function canvasMeshOf(scriptClass: string, node: SceneNode, comp: object): CanvasMeshSource | null {
  return providerOf(scriptClass)?.(node, comp) ?? null;
}

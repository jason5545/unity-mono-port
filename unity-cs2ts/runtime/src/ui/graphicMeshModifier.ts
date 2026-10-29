// 原生畫的 Graphic（Image）的網格修改器（IMeshModifier）。Unity 的 Graphic.DoMeshGeneration（Graphic.cs:496-515）在 OnPopulateMesh 之後，
// 把同一個物件上全部的 IMeshModifier（GetComponents，停用的也算，各自看 IsActive）依元件順序叫 ModifyMesh(VertexHelper)。
// MT2 掛在 Image 上的有 UIFlippable（翻轉）、Gradient2（漸層，設定與牌組畫面的底）、Outline、PositionAsUV1：都是產生碼，
// 實作在 csport/unityGraphicMesh.ts（要叫產生的方法），繪製端只問這裡。

import type { SceneNode } from '../unity/scene';

/** 一份 UI 網格的頂點：位置在 RectTransform 自己的區域空間（原點是 pivot），uv 是 uv0 的 xy，顏色是 Color32 / 255（gamma 空間） */
export interface GraphicVertices {
  /** x, y, z 交錯 */
  positions: number[];
  /** u, v 交錯 */
  uvs: number[];
  /** r, g, b, a 交錯（0–1） */
  colors: number[];
  indices: number[];
}

export interface GraphicMeshModifierHook {
  /** 會影響修改結果的輸入（修改器的種類、啟用、欄位）；沒有修改器是空字串。繪製端放進重產鍵 */
  signature(node: SceneNode): string;
  /** 照順序叫這個物件上的修改器；沒有修改器回 null（照原本的網格畫） */
  modify(node: SceneNode, mesh: GraphicVertices): GraphicVertices | null;
}

let hook: GraphicMeshModifierHook | null = null;
export function registerGraphicMeshModifier(h: GraphicMeshModifierHook): void {
  hook = h;
}
export function graphicMeshModifier(): GraphicMeshModifierHook | null {
  return hook;
}

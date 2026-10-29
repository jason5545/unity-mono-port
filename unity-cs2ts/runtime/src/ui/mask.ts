// uGUI Mask 的 stencil 裁切（純 TS、不碰 DOM）。對應 reference/decompiled/UnityEngine.UI/UnityEngine.UI/：
//   Mask.cs:49（graphic）、55-62（MaskEnabled）、76-79（isMaskingGraphic）、113-149（GetModifiedMaterial）
//   MaskableGraphic.cs:24-25（m_Maskable 預設 true）、117-141（GetModifiedMaterial）
//   MaskUtilities.cs:36-55（FindRootSortOverrideCanvas）、57-85（GetStencilDepth）
//   StencilMaterial.cs:42-45（Add 的 readMask/writeMask 預設 255）、55-131（Add）
//   Graphic.cs:210-224（materialForRendering：同一個 GameObject 上的 IMaterialModifier 依元件順序串起來）
//   UnityEngine.EventSystems/UIBehaviour.cs:25-28（IsActive() ＝ isActiveAndEnabled）
// TMP 的 TextMeshProUGUI 走同一條鏈：TextMeshProUGUI.cs:23-26 的 materialForRendering →
//   TMP_MaterialManager.GetMaterialForRendering（TMP_MaterialManager.cs:304-318，內容與 Graphic.cs:210-224 相同）。
//   TMP 自己那套 TMP_MaterialManager.GetStencilMaterial（:43-96，_StencilComp 寫 4＝LessEqual）在整個 Runtime
//   裡沒有任何呼叫者（grep 只有 :43 的宣告），TMP_SubMeshUI 用到它的那段在 #if UNITY_EDITOR 裡（:343、376-419）。
//
// Unity 的做法是 StencilMaterial.Add 複製一份材質、把 _Stencil／_StencilOp／_StencilComp／_StencilReadMask／
// _StencilWriteMask／_ColorMask／_UseUIAlphaClip 七個 float 寫進去（StencilMaterial.cs:114-120），shader 的
// render state 綁這些屬性。遊戲匯出的 TextMeshPro/Distance Field 就是這個綁定：Pass [_StencilOp]、
// Comp [_StencilComp]、Ref [_Stencil]、ReadMask [_StencilReadMask]、WriteMask [_StencilWriteMask]
// （../../DiCEOMANCER-Swift/extracted_data/ar_fullver_shaders/ExportedProject/Assets/Shader/
//   TextMeshPro_Distance Field_1.asset:1060-1107）。
// 這裡不複製材質，只把同一組值算成 StencilState，由繪製端套成 GL 的 stencil 狀態
// （render/unityShader.ts 的 applyStencilState、render/sceneRenderer.ts 的 stencilMaterial）。

import type { ComponentData } from '../unity/types';
import { componentKind } from '../unity/componentKind';
import type { SceneNode } from '../unity/scene';

/** SceneGraph 上這個模組用到的兩個方法（scene.ts:95-105）；測試可以自己給一份 */
export interface MaskLookup {
  component(node: SceneNode, kind: string): ComponentData | undefined;
  components(node: SceneNode): ComponentData[];
}

// UnityEngine.Rendering.StencilOp 的列舉值
export const STENCIL_OP_KEEP = 0;
export const STENCIL_OP_ZERO = 1;
export const STENCIL_OP_REPLACE = 2;
// UnityEngine.Rendering.CompareFunction 的列舉值
export const COMPARE_EQUAL = 3;
export const COMPARE_ALWAYS = 8;
// UnityEngine.Rendering.ColorWriteMask.All
export const COLOR_WRITE_ALL = 15;

/** StencilMaterial.Add 要求的六個材質屬性（StencilMaterial.cs:61-90）；缺一就回傳原材質 */
export const STENCIL_PROPERTIES = ['_Stencil', '_StencilOp', '_StencilComp', '_StencilReadMask', '_StencilWriteMask', '_ColorMask'];

/** uGUI 的 Graphic 子類（Mask.graphic ＝ GetComponent<Graphic>()，Mask.cs:49） */
const GRAPHICS = new Set(['Image', 'RawImage', 'Text', 'TextMeshProUGUI', 'TMP_SubMeshUI']);
/** 其中繼承 MaskableGraphic 的（3D 的 TextMeshPro 不是 Graphic，不吃 Mask） */
const MASKABLE_GRAPHICS = GRAPHICS;

/** 一份材質畫的時候實際的 stencil 與 colorMask render state（＝StencilMaterial.Add 寫進材質的那七個 float） */
export interface StencilState {
  /** _Stencil（GL 的 stencil ref） */
  ref: number;
  /** _StencilComp（CompareFunction） */
  comp: number;
  /** _StencilOp（StencilOp，Pass 那一項；Fail／ZFail 在 UI shader 裡沒綁屬性，恆為 Keep） */
  op: number;
  /** _StencilReadMask */
  readMask: number;
  /** _StencilWriteMask */
  writeMask: number;
  /** _ColorMask（ColorWriteMask） */
  colorMask: number;
  /** _UseUIAlphaClip／UNITY_UI_ALPHACLIP keyword（StencilMaterial.cs:112、121-128） */
  alphaClip: boolean;
}

/**
 * 沒有任何遮罩時的狀態，也就是內建 UI/Default 的屬性預設值。
 * Graphic 沒指定材質時用的是 Graphic.defaultGraphicMaterial ＝ Canvas.GetDefaultCanvasMaterial()
 * （Graphic.cs:81-89）——執行期才存在的內建材質，不會序列化進 materials.json，所以預設值要從 shader 的
 * 屬性表拿。materials.json 裡沒有任何材質的 shader 是 UI/Default（10/6 掃過 143 個）。
 * 交叉佐證：遊戲匯出的 TextMeshPro/Distance Field 屬性表裡同一組屬性的預設值逐項相同
 * （reference/shaders/TextMeshPro_Distance Field_1/index.json 的 properties：_StencilComp [8,0,0,0]、
 * _Stencil [0,0,0,0]、_StencilOp [0,0,0,0]、_StencilWriteMask [255,…]、_StencilReadMask [255,…]、
 * _ColorMask [15,…]）——TMP 的 UI shader 這幾個屬性照抄 UI/Default。
 */
export const DEFAULT_STENCIL: StencilState = {
  ref: 0,
  comp: COMPARE_ALWAYS,
  op: STENCIL_OP_KEEP,
  readMask: 255,
  writeMask: 255,
  colorMask: COLOR_WRITE_ALL,
  alphaClip: false,
};

/** 一份材質自己的 _Stencil* 欄位 → 實際的 render state（沒有 StencilMaterial.Add 介入時就是這個） */
export function stencilFromMaterial(floats: Record<string, number> | undefined | null, keywords: readonly string[] | undefined | null): StencilState {
  const f = floats ?? {};
  return {
    ref: f._Stencil ?? DEFAULT_STENCIL.ref,
    comp: f._StencilComp ?? DEFAULT_STENCIL.comp,
    op: f._StencilOp ?? DEFAULT_STENCIL.op,
    readMask: f._StencilReadMask ?? DEFAULT_STENCIL.readMask,
    writeMask: f._StencilWriteMask ?? DEFAULT_STENCIL.writeMask,
    colorMask: f._ColorMask ?? DEFAULT_STENCIL.colorMask,
    // UNITY_UI_ALPHACLIP 是 keyword（[Toggle(UNITY_UI_ALPHACLIP)]），材質序列化在 m_ValidKeywords；
    // _UseUIAlphaClip 那個 float 是 StencilMaterial.cs:120 另外寫的
    alphaClip: (keywords ?? []).includes('UNITY_UI_ALPHACLIP') || (f._UseUIAlphaClip ?? 0) !== 0,
  };
}

/** 跟「沒有遮罩」一樣 → 不用另外做一份材質、也不用開 stencil test（Comp Always＋Pass Keep＋ref 0 本來就不作用） */
export function isDefaultStencil(s: StencilState): boolean {
  return s.ref === DEFAULT_STENCIL.ref && s.comp === DEFAULT_STENCIL.comp && s.op === DEFAULT_STENCIL.op && s.readMask === DEFAULT_STENCIL.readMask && s.writeMask === DEFAULT_STENCIL.writeMask && s.colorMask === DEFAULT_STENCIL.colorMask && s.alphaClip === DEFAULT_STENCIL.alphaClip;
}

/** 重產偵測的 key 用（sceneRenderer 的 refreshKeyOf） */
export function stencilKey(s: StencilState): string {
  return isDefaultStencil(s) ? '' : `${s.ref}|${s.comp}|${s.op}|${s.readMask}|${s.writeMask}|${s.colorMask}|${s.alphaClip ? 1 : 0}`;
}

/**
 * StencilMaterial.Add（StencilMaterial.cs:42-45 的 readMask／writeMask 預設 255、55-131）。
 * hasStencilProperties 是 :61-90 那六個 HasProperty 檢查的結果——缺一就回傳原材質（Unity 還會印 warning）。
 */
export function stencilMaterialAdd(base: StencilState, stencilID: number, operation: number, compareFunction: number, colorWriteMask: number, readMask = 255, writeMask = 255, hasStencilProperties = true): StencilState {
  if ((stencilID <= 0 && colorWriteMask === COLOR_WRITE_ALL) || !hasStencilProperties) return base; // :57-60、:61-90
  return {
    ref: stencilID, // :114
    op: operation, // :115
    comp: compareFunction, // :116
    readMask, // :117
    writeMask, // :118
    colorMask: colorWriteMask, // :119
    alphaClip: operation !== STENCIL_OP_KEEP && writeMask > 0, // :112
  };
}

/** 元件種類：繼承 TMP 的遊戲類別（ExtendedTextMeshProUGUI）算 TextMeshProUGUI（unity/componentKind.ts） */
function kindOf(comp: ComponentData): string {
  return componentKind(comp);
}

/** Mask.graphic ＝ GetComponent<Graphic>()（Mask.cs:49） */
function graphicOf(g: MaskLookup, node: SceneNode): ComponentData | undefined {
  for (const c of g.components(node)) if (GRAPHICS.has(kindOf(c))) return c;
  return undefined;
}

/** Mask.MaskEnabled（Mask.cs:55-62）：Mask 自己 IsActive()（UIBehaviour.cs:25-28）且同一個 GameObject 上有 Graphic */
export function maskEnabled(g: MaskLookup, node: SceneNode): boolean {
  const mask = g.component(node, 'Mask');
  if (!mask || mask.m_Enabled === 0 || !node.activeInHierarchy) return false;
  return graphicOf(g, node) !== undefined;
}

/** MaskUtilities.GetStencilDepth 的計數條件（MaskUtilities.cs:71）：MaskEnabled() 且 graphic.IsActive() */
function countsForStencilDepth(g: MaskLookup, node: SceneNode): boolean {
  if (!maskEnabled(g, node)) return false;
  return (graphicOf(g, node)!.m_Enabled ?? 0) !== 0;
}

/**
 * MaskUtilities.FindRootSortOverrideCanvas（MaskUtilities.cs:36-55）。
 * GetComponentsInParent(includeInactive: false) 只收 activeInHierarchy 的 GameObject、順序由自己往上；
 * 第一個 overrideSorting 的 Canvas 就是 stopAfter，都沒有就是最上層那個 Canvas，一個都沒有回 null。
 */
export function findRootSortOverrideCanvas(g: MaskLookup, node: SceneNode): SceneNode | null {
  let last: SceneNode | null = null;
  for (let n: SceneNode | null = node; n; n = n.parent) {
    if (!n.activeInHierarchy) continue;
    const canvas = g.component(n, 'Canvas');
    if (!canvas) continue;
    last = n;
    if ((canvas.m_OverrideSorting as number) !== 0) return n;
  }
  return last;
}

/** MaskUtilities.GetStencilDepth（MaskUtilities.cs:57-85）：沿 parent 鏈往上數 Mask，遇到 stopAfter 停（含它） */
export function getStencilDepth(g: MaskLookup, node: SceneNode, stopAfter: SceneNode | null): number {
  if (node === stopAfter) return 0; // :60-63
  let count = 0;
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (countsForStencilDepth(g, parent)) count++; // :68-76（同一個 GameObject 上最多一個 Mask，:69-75 的 break 等同）
    if (parent === stopAfter) break; // :77-80
  }
  return count;
}

/**
 * Mask.GetModifiedMaterial（Mask.cs:113-149）。回傳遮罩圖形用的狀態（:129／:139）與 unmask 材質的狀態
 * （:132／:143）；MaskEnabled() 不成立（:115-118）或 depth ≥ 8（:121-125，Unity 只印 warning 並回傳原材質）回 null。
 * m_ShowMaskGraphic ＝ 0 時 colorMask 傳 0（:129、:139）——stencil 照樣寫（op 仍是 Replace），只是不寫 color buffer。
 */
export function maskGetModifiedMaterial(g: MaskLookup, node: SceneNode, base: StencilState, hasStencilProperties: boolean): { mask: StencilState; unmask: StencilState } | null {
  if (!maskEnabled(g, node)) return null; // :115-118
  const depth = getStencilDepth(g, node, findRootSortOverrideCanvas(g, node)); // :119-120
  if (depth >= 8) return null; // :121-125
  const num = 1 << depth; // :126
  const show = ((g.component(node, 'Mask')!.m_ShowMaskGraphic as number) ?? 1) !== 0;
  const colorMask = show ? COLOR_WRITE_ALL : 0; // :129、:139
  if (num === 1)
    return {
      mask: stencilMaterialAdd(base, 1, STENCIL_OP_REPLACE, COMPARE_ALWAYS, colorMask, 255, 255, hasStencilProperties), // :129（readMask/writeMask 走 :42-45 的預設 255）
      unmask: stencilMaterialAdd(base, 1, STENCIL_OP_ZERO, COMPARE_ALWAYS, 0, 255, 255, hasStencilProperties), // :132
    };
  return {
    mask: stencilMaterialAdd(base, num | (num - 1), STENCIL_OP_REPLACE, COMPARE_EQUAL, colorMask, num - 1, num | (num - 1), hasStencilProperties), // :139
    unmask: stencilMaterialAdd(base, num - 1, STENCIL_OP_REPLACE, COMPARE_EQUAL, 0, num - 1, num | (num - 1), hasStencilProperties), // :143
  };
}

/**
 * MaskableGraphic.GetModifiedMaterial（MaskableGraphic.cs:117-141）。
 * m_Maskable 為 0 時 stencilValue 是 0（:127-130）；stencilValue > 0 且自己不是遮罩圖形（isMaskingGraphic，
 * Mask.cs:76-79 在 OnEnable 設的）才套 stencil（:133-139）：Keep／Equal、readMask ＝ (1<<depth)-1、writeMask 0。
 */
export function maskableGetModifiedMaterial(g: MaskLookup, node: SceneNode, comp: ComponentData, base: StencilState, isMaskingGraphic: boolean, hasStencilProperties: boolean): StencilState {
  const maskable = ((comp.m_Maskable as number | undefined) ?? 1) !== 0; // :24-25、:122
  const stencilValue = maskable ? getStencilDepth(g, node, findRootSortOverrideCanvas(g, node)) : 0; // :122-131
  if (stencilValue > 0 && !isMaskingGraphic)
    // :135
    return stencilMaterialAdd(base, (1 << stencilValue) - 1, STENCIL_OP_KEEP, COMPARE_EQUAL, COLOR_WRITE_ALL, (1 << stencilValue) - 1, 0, hasStencilProperties);
  return base;
}

/** 一個 Graphic 畫出來的結果：實效 stencil 狀態、Mask 的 unmask（pop）材質狀態、自己是不是遮罩圖形 */
export interface GraphicStencil {
  state: StencilState;
  /** Mask 的 unmask 材質（Mask.cs:132／:143）：遮罩子樹畫完之後要再畫一次同一個網格，把 stencil 清回。
   *  Unity 用 canvasRenderer.popMaterialCount ＝ 1 ＋ SetPopMaterial（Mask.cs:135-136、146-147）交給原生批次繪製，
   *  pop 繪製排在這個節點的子樹之後——排在子樹之前的話 stencil 會在子元素畫之前就被清掉，Mask 完全沒作用。 */
  pop: StencilState | null;
  /** isMaskingGraphic（Mask.cs:76-79） */
  masking: boolean;
}

/**
 * Graphic.materialForRendering（Graphic.cs:210-224）：同一個 GameObject 上全部 IMaterialModifier 依元件順序串起來。
 * 這條鏈上只有 Mask（Mask.cs:11）與 Graphic 自己（MaskableGraphic.cs:8）。base 是材質目前的狀態。
 */
export function graphicStencil(g: MaskLookup, node: SceneNode, base: StencilState, hasStencilProperties: boolean): GraphicStencil {
  // isMaskingGraphic 在 Mask.OnEnable 就設好（Mask.cs:76-79），跟元件順序無關，所以先算
  const masking = maskEnabled(g, node);
  let state = base;
  let pop: StencilState | null = null;
  for (const comp of g.components(node)) {
    const kind = kindOf(comp);
    if (kind === 'Mask') {
      const r = maskGetModifiedMaterial(g, node, state, hasStencilProperties);
      if (r) {
        state = r.mask;
        pop = r.unmask; // Mask.cs:135-136、146-147
      }
    } else if (MASKABLE_GRAPHICS.has(kind)) {
      state = maskableGetModifiedMaterial(g, node, comp, state, masking, hasStencilProperties);
    }
  }
  return { state, pop, masking };
}

/** 場景裡全部掛 Mask 的節點（啟用與否由 activeMaskNodes 每格判斷） */
export function maskNodesOf(g: MaskLookup, nodes: Iterable<SceneNode>): SceneNode[] {
  const out: SceneNode[] = [];
  for (const n of nodes) if (g.component(n, 'Mask')) out.push(n);
  return out;
}

/** 目前 MaskEnabled() 成立的 Mask 節點 */
export function activeMaskNodes(g: MaskLookup, maskNodes: Iterable<SceneNode>): SceneNode[] {
  const out: SceneNode[] = [];
  for (const n of maskNodes) if (maskEnabled(g, n)) out.push(n);
  return out;
}

/** 某個 Mask 底下（含自己）的全部節點。GetStencilDepth 只數祖先，所以只有這些節點的 stencil 會受它影響 */
export function maskSubtree(root: SceneNode, out: SceneNode[] = []): SceneNode[] {
  out.push(root);
  for (const c of root.children) maskSubtree(c, out);
  return out;
}

/** 子樹裡最大的 node.order（scene.ts:136-144 的深度優先計數）：pop 繪製要排在子樹之後、下一個兄弟之前 */
export function subtreeLastOrder(node: SceneNode): number {
  let last = node.order;
  for (const c of node.children) last = Math.max(last, subtreeLastOrder(c));
  return last;
}

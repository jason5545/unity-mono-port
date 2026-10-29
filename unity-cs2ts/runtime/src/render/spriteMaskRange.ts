// SpriteMask 的範圍、stencil 狀態與排序鍵（純函式：不碰 three.js、DOM）。
//
// 對應 C#：Unity 的 SpriteMask 是原生元件，reference/ 沒有它的原始碼。原版 SpriteMask 用的材質是 Sprites/Mask
//   （reference/builtin-shaders-2022.3.3f1/DefaultResourcesExtra/Sprites-Mask.shader：ColorMask 0、clip(a − _Cutoff)，
//   stencil 狀態不在 shader 裡，由引擎決定）。這裡的 stencil 規則是 2026-10-10 裁決 5、6、11 定的，不是從原版查來的。
//
// 規則：
//   - 遮罩的 stencil 位元是 0x80（bit 7）。mask.ts 的 uGUI 遮罩用 bit 0 到 bit d（深度 d，最多 depth 7），
//     bit 7 只在 uGUI 深度 7 才會用到，而且 level2 的 uGUI Mask 載入時都在未啟用的父物件底下。
//   - 寫入（mask 的 key 在 back 那一刻）：Comp Always、Pass Replace、writeMask 0x80、colorMask 0；alpha < cutoff 的像素丟掉（保留 ≥，
//     照 Sprites-Mask.shader 的 clip(a − _Cutoff)）。
//   - 清除（mask 的 key 在 front 那一刻）：Comp Always、Pass Zero、writeMask 0x80、colorMask 0。
//   - 被遮的 renderer：m_MaskInteraction 1（VisibleInsideMask）用 Equal，2（VisibleOutsideMask）用 NotEqual；
//     readMask 0x80、writeMask 0、ref 0x80。
//   - 排序（不靠距離）：寫入那筆排在「同 sorting layer、order ≤ back」的所有 renderer 之後、「order > back」的之前；
//     清除那筆排在「order ≤ front」的所有 renderer 之後、「order > front」的之前。做法是 key 的 order 欄放 back + 0.25、front + 0.75
//     （renderer 的 order 都是整數，這樣不會跟任何 renderer 同值）。
//   - interaction 1 不在任何遮罩範圍內：不畫。這不用另外判斷，範圍外的像素在該 renderer 畫的時候 bit 是 0，Equal 不過。
//   - interaction 2 不在任何遮罩範圍內：照常畫。範圍外 bit 是 0，NotEqual 過。
//   - 自訂範圍關閉（m_IsCustomRangeActive 0）：範圍是本層的全部 order（未查證，level2 的遮罩都是開的）。
// 刻意不做（寫進檔頭的差異）：多個遮罩範圍重疊時共用 0x80 位元，第一個清除會把重疊區的 bit 清掉（目前的場景只有一個遮罩）。

import type { StencilState } from '../ui/mask';

/** 遮罩用的 stencil 位元 */
export const MASK_BIT = 0x80;

/** CompareFunction（UnityEngine.Rendering.CompareFunction）的數值：Equal 3、NotEqual 6、Always 8 */
export const COMPARE_EQUAL = 3;
export const COMPARE_NOT_EQUAL = 6;
export const COMPARE_ALWAYS = 8;

/** StencilOp：Keep 0、Zero 1、Replace 2 */
export const STENCIL_OP_KEEP = 0;
export const STENCIL_OP_ZERO = 1;
export const STENCIL_OP_REPLACE = 2;

/** 排序鍵 order 欄的偏移：寫入在 back + 這個值、清除在 front + 另一個值（兩者都不跟整數 order 相等） */
export const MASK_WRITE_OFFSET = 0.25;
export const MASK_CLEAR_OFFSET = 0.75;

/** 沒有自訂範圍時用的無限大代替（排序鍵要是有限的數字，不能用 Infinity） */
const WHOLE_LAYER = 1e9;

export interface MaskRange {
  /** m_IsCustomRangeActive 是否開啟 */
  custom: boolean;
  /** 範圍的後端（不含）：m_BackSortingOrder */
  back: number;
  /** 範圍的前端（含）：m_FrontSortingOrder */
  front: number;
}

/** 從 SpriteMask 元件讀範圍（m_IsCustomRangeActive、m_BackSortingOrder、m_FrontSortingOrder） */
export function maskRangeOf(comp: Readonly<Record<string, unknown>>): MaskRange {
  const custom = ((comp.m_IsCustomRangeActive as number | undefined) ?? 0) !== 0;
  if (!custom) return { custom: false, back: -WHOLE_LAYER, front: WHOLE_LAYER };
  return {
    custom: true,
    back: (comp.m_BackSortingOrder as number | undefined) ?? -1,
    front: (comp.m_FrontSortingOrder as number | undefined) ?? 1,
  };
}

/** renderer 的 sorting order 是否落在遮罩範圍內（同一個 sorting layer 才算，呼叫端自己比對 layer） */
export function inMaskRange(order: number, range: MaskRange): boolean {
  return order > range.back && order <= range.front;
}

/** 寫入那筆在排序鍵 order 欄的值 */
export function maskWriteKeyOrder(range: MaskRange): number {
  return range.back + MASK_WRITE_OFFSET;
}

/** 清除那筆在排序鍵 order 欄的值 */
export function maskClearKeyOrder(range: MaskRange): number {
  return range.front + MASK_CLEAR_OFFSET;
}

/** 寫入遮罩的 stencil 狀態（只寫 bit 7，不寫顏色） */
export function maskWriteState(): StencilState {
  return { ref: MASK_BIT, comp: COMPARE_ALWAYS, op: STENCIL_OP_REPLACE, readMask: 255, writeMask: MASK_BIT, colorMask: 0, alphaClip: false };
}

/** 清除遮罩的 stencil 狀態（把 bit 7 清成 0，不寫顏色） */
export function maskClearState(): StencilState {
  return { ref: 0, comp: COMPARE_ALWAYS, op: STENCIL_OP_ZERO, readMask: 255, writeMask: MASK_BIT, colorMask: 0, alphaClip: false };
}

/**
 * 被遮的 renderer 的 stencil 狀態。interaction 0 回傳 null（不受遮罩影響，不開 stencil test）。
 * interaction 1 用 Equal（只畫在遮罩裡），2 用 NotEqual（只畫在遮罩外）。
 */
export function maskedRendererState(interaction: number): StencilState | null {
  if (interaction === 1) return { ref: MASK_BIT, comp: COMPARE_EQUAL, op: STENCIL_OP_KEEP, readMask: MASK_BIT, writeMask: 0, colorMask: 15, alphaClip: false };
  if (interaction === 2) return { ref: MASK_BIT, comp: COMPARE_NOT_EQUAL, op: STENCIL_OP_KEEP, readMask: MASK_BIT, writeMask: 0, colorMask: 15, alphaClip: false };
  return null;
}

/** m_MaskInteraction 的值（缺欄位當 0） */
export function maskInteractionOf(comp: Readonly<Record<string, unknown>>): number {
  const v = comp.m_MaskInteraction as number | undefined;
  return typeof v === 'number' ? v : 0;
}

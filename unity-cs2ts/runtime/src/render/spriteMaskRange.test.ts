// spriteMaskRange.ts 的測試：SpriteMask 的範圍、stencil 狀態與排序（規格 4.2，裁決 5、6、11）。
// 排序與 stencil 的行為用一個小模擬驗：照排序鍵排好的繪製清單，逐筆套 stencil 狀態，看內外兩個像素各畫到哪些。
import { describe, expect, it } from 'vitest';
import {
  COMPARE_ALWAYS,
  COMPARE_EQUAL,
  COMPARE_NOT_EQUAL,
  MASK_BIT,
  maskClearKeyOrder,
  maskClearState,
  maskRangeOf,
  maskWriteKeyOrder,
  maskWriteState,
  maskedRendererState,
  inMaskRange,
  maskInteractionOf,
  STENCIL_OP_REPLACE,
  STENCIL_OP_ZERO,
  type MaskRange,
} from './spriteMaskRange';
import type { StencilState } from '../ui/mask';

type Entry = { name: string; kind: 'write' | 'clear' | 'draw'; key: number[]; interaction?: number };

/** 排序鍵 ＝ [sorting layer, order, queue, −距離, 場景樹順序]，逐項比較（同 sceneRenderer.resortDrawables） */
function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return 0;
  });
}

/** 一個 stencil 像素值套一筆寫入（Replace 或 Zero，只動 writeMask 的位元） */
function applyWrite(value: number, s: StencilState): number {
  if (s.op === STENCIL_OP_REPLACE) return (value & ~s.writeMask) | (s.ref & s.writeMask);
  if (s.op === STENCIL_OP_ZERO) return value & ~s.writeMask;
  return value;
}

/** 這個像素在 stencil test 下過不過（Always、Equal、NotEqual） */
function passes(value: number, s: StencilState): boolean {
  if (s.comp === COMPARE_ALWAYS) return true;
  if (s.comp === COMPARE_EQUAL) return (value & s.readMask) === (s.ref & s.readMask);
  if (s.comp === COMPARE_NOT_EQUAL) return (value & s.readMask) !== (s.ref & s.readMask);
  return false;
}

/**
 * 模擬一個像素：inside 表示這個像素在遮罩的形狀裡（alpha 夠的地方）。
 * 寫入與清除只在遮罩形狀內生效；被遮的 renderer 照 stencil test 決定畫不畫。回傳畫出來的 renderer 名字。
 */
function drawnAt(entries: Entry[], inside: boolean): string[] {
  let value = 0;
  const drawn: string[] = [];
  for (const e of sortEntries(entries)) {
    if (e.kind === 'write') {
      if (inside) value = applyWrite(value, maskWriteState());
      continue;
    }
    if (e.kind === 'clear') {
      if (inside) value = applyWrite(value, maskClearState());
      continue;
    }
    const s = maskedRendererState(e.interaction ?? 0);
    if (!s || passes(value, s)) drawn.push(e.name);
  }
  return drawn.sort(); // 比的是集合，不是繪製順序
}

describe('範圍', () => {
  it('自訂範圍：back −1、front 1（minimap 遮罩）；不含 back，含 front', () => {
    const range = maskRangeOf({ m_IsCustomRangeActive: 1, m_BackSortingOrder: -1, m_FrontSortingOrder: 1 });
    expect(range).toEqual({ custom: true, back: -1, front: 1 });
    expect(inMaskRange(-1, range)).toBe(false);
    expect(inMaskRange(0, range)).toBe(true);
    expect(inMaskRange(1, range)).toBe(true);
    expect(inMaskRange(2, range)).toBe(false);
  });

  it('自訂範圍關閉：整層（不論 order）', () => {
    const range = maskRangeOf({ m_IsCustomRangeActive: 0, m_BackSortingOrder: -1, m_FrontSortingOrder: 1 });
    expect(range.custom).toBe(false);
    expect(inMaskRange(-500, range)).toBe(true);
    expect(inMaskRange(500, range)).toBe(true);
  });

  it('寫入與清除的排序鍵落在整數 order 之間（不跟任何 renderer 同值）', () => {
    const range: MaskRange = { custom: true, back: -1, front: 1 };
    expect(maskWriteKeyOrder(range)).toBe(-0.75);
    expect(maskClearKeyOrder(range)).toBe(1.75);
    expect(Number.isInteger(maskWriteKeyOrder(range))).toBe(false);
    expect(Number.isInteger(maskClearKeyOrder(range))).toBe(false);
  });

  it('m_MaskInteraction 缺欄位當 0', () => {
    expect(maskInteractionOf({})).toBe(0);
    expect(maskInteractionOf({ m_MaskInteraction: 2 })).toBe(2);
  });
});

describe('stencil 狀態（裁決 5）', () => {
  it('寫入：Always、Replace、ref 與 writeMask 都是 0x80、不寫顏色', () => {
    const s = maskWriteState();
    expect(s).toMatchObject({ ref: MASK_BIT, comp: COMPARE_ALWAYS, op: STENCIL_OP_REPLACE, writeMask: 0x80, colorMask: 0 });
  });

  it('清除：Always、Zero、writeMask 0x80、不寫顏色', () => {
    const s = maskClearState();
    expect(s).toMatchObject({ comp: COMPARE_ALWAYS, op: STENCIL_OP_ZERO, writeMask: 0x80, colorMask: 0 });
  });

  it('interaction 1：Equal；interaction 2：NotEqual；readMask 0x80、writeMask 0；interaction 0 不開 stencil', () => {
    expect(maskedRendererState(1)).toMatchObject({ ref: 0x80, comp: COMPARE_EQUAL, readMask: 0x80, writeMask: 0 });
    expect(maskedRendererState(2)).toMatchObject({ ref: 0x80, comp: COMPARE_NOT_EQUAL, readMask: 0x80, writeMask: 0 });
    expect(maskedRendererState(0)).toBeNull();
  });
});

describe('排序與 stencil 的模擬（minimap 遮罩：layer 0、範圍 (−1, 1]）', () => {
  // 遮罩的 depth 放得遠、B 的 depth 放得近：如果排序靠距離，B 會排到寫入前面。這個測試要 B 照 order 排。
  const mask = (): Entry[] => [
    { name: 'mask-write', kind: 'write', key: [0, maskWriteKeyOrder({ custom: true, back: -1, front: 1 }), 3000, 5, 10] },
    { name: 'mask-clear', kind: 'clear', key: [0, maskClearKeyOrder({ custom: true, back: -1, front: 1 }), 3000, 5, 10] },
  ];
  const draw = (name: string, layer: number, order: number, depth: number, node: number, interaction: number): Entry => ({
    name,
    kind: 'draw',
    key: [layer, order, 3000, depth, node],
    interaction,
  });
  const scene: Entry[] = [
    ...mask(),
    draw('A-order-1-inter1', 0, -1, -3, 1, 1), // 範圍之前、interaction 1：不畫
    draw('B-order0-inter1', 0, 0, -10, 20, 1), // 範圍內：只畫在遮罩裡
    draw('C-order0-inter2', 0, 0, 0, 21, 2), // 範圍內：只畫在遮罩外
    draw('D-order1-inter1', 0, 1, 2, 22, 1), // 範圍內（front）：只畫在遮罩裡
    draw('E-order2-inter1', 0, 2, 0, 23, 1), // 範圍之後、interaction 1：不畫
    draw('F-order2-inter2', 0, 2, 0, 24, 2), // 範圍之後、interaction 2：照常畫
    draw('G-order0-none', 0, 0, 0, 25, 0), // 沒有遮罩：照常畫
    draw('H-layer1-inter2', 1, 0, 0, 30, 2), // 另一個 sorting layer：照常畫
  ];

  it('遮罩裡：B、D、F、G、H 畫出來（A、C、E 不畫）', () => {
    expect(drawnAt(scene, true)).toEqual(['B-order0-inter1', 'D-order1-inter1', 'F-order2-inter2', 'G-order0-none', 'H-layer1-inter2']);
  });

  it('遮罩外：C、F、G、H 畫出來（A、B、D、E 不畫）', () => {
    expect(drawnAt(scene, false)).toEqual(['C-order0-inter2', 'F-order2-inter2', 'G-order0-none', 'H-layer1-inter2']);
  });

  it('沒有遮罩：interaction 1 的一律不畫，interaction 2 與 0 的照常畫', () => {
    const none = scene.filter((e) => e.kind === 'draw');
    expect(drawnAt(none, true)).toEqual(['C-order0-inter2', 'F-order2-inter2', 'G-order0-none', 'H-layer1-inter2']);
    expect(drawnAt(none, false)).toEqual(['C-order0-inter2', 'F-order2-inter2', 'G-order0-none', 'H-layer1-inter2']);
  });

  it('自訂範圍關閉（整層）：範圍內的 renderer 都在遮罩之後、清除之前', () => {
    const whole: Range = { custom: false, back: -1e9, front: 1e9 };
    const entries: Entry[] = [
      { name: 'mask-write', kind: 'write', key: [0, maskWriteKeyOrder(whole), 3000, 0, 1] },
      { name: 'mask-clear', kind: 'clear', key: [0, maskClearKeyOrder(whole), 3000, 0, 1] },
      draw('X-order-5-inter1', 0, -5, 0, 2, 1),
      draw('Y-order7-inter1', 0, 7, 0, 3, 1),
    ];
    expect(drawnAt(entries, true)).toEqual(['X-order-5-inter1', 'Y-order7-inter1']);
    expect(drawnAt(entries, false)).toEqual([]);
  });
});

type Range = MaskRange;

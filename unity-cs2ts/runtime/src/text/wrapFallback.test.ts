// TMP 3.0 的元件沒有 m_TextWrappingMode（2026/10/17）：MT2 的 Unity.TextMeshPro.dll 是 3.0 系列，換行只有布林的 m_enableWordWrapping。
// 3.2 的 m_TextWrappingMode 是 [FormerlySerializedAs("m_enableWordWrapping")]（TMP_Text.cs:746），舊資料的 0／1 照數值讀成 NoWrap／Normal。
// 以前欄位不存在一律當 Normal：MT2 關掉換行的 5984 個元件都會換行（獎勵畫面的「Skip (+10 金幣)」排成兩行、字號沒縮到 24）。
// 資料用 Diceomancer level1 的 1104（TMP 3.2 的元件），拿掉 m_TextWrappingMode 當成 3.0 的元件。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameTextAssets } from '../font/textAssets';
import type { SceneFile } from '../unity/types';
import type { TextContext } from './types';
import { generateText, getPreferredHeight } from './index';
import { TEST_GAME } from '../testData';

function load<T>(p: string): T {
  const f = resolve(TEST_GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}
function makeAssets(): GameTextAssets {
  const index = load<Record<string, { name: string; src: string; kind: string | null; file: string }>>('assets/monobehaviours.json');
  const objects = new Map<string, Record<string, unknown>>();
  for (const [guid, m] of Object.entries(index)) {
    if (!m.kind || !['TMP_FontAsset', 'TMP_Settings', 'TMP_StyleSheet', 'TMP_ColorGradient'].includes(m.kind)) continue;
    objects.set(guid, load(`assets/${m.file}`));
  }
  const materials = load<Record<string, Record<string, unknown>>>('assets/materials.json');
  const texts = load<Record<string, { text: string }>>('assets/texts.json');
  const glyphs = load<{ fontAssets: Record<string, string> }>('assets/glyphs.json');
  return GameTextAssets.fromData(index, objects, materials, texts, glyphs.fontAssets, {});
}
// 寬 200 放不下整句（30 號字約 600 寬），高度夠排好幾行
const ctx: TextContext = { rect: { x: 0, y: 0, width: 200, height: 200 }, lossyScaleY: 1, canvas: { renderMode: 1, scaleFactor: 1, worldCameraAssigned: true }, isOrthographic: true, linearColorSpace: true };
const assets = makeAssets();
const TEXT = 'The quick brown fox jumps over the lazy dog';
/** 3.2 的元件：照存檔的 m_TextWrappingMode */
function comp32(mode: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...load<SceneFile>('scenes/level1.json').components['1104'], m_text: TEXT, m_TextWrappingMode: mode, ...fields };
}
/** 3.0 的元件：沒有 m_TextWrappingMode，只有 m_enableWordWrapping */
function comp30(wrap: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const c: Record<string, unknown> = { ...comp32(1, fields), m_enableWordWrapping: wrap };
  delete c.m_TextWrappingMode;
  return c;
}
const layout = (c: Record<string, unknown>) => {
  const r = generateText(c, ctx, assets);
  return { lineCount: r.lineCount, fontSize: r.fontSize, origins: r.textInfo.characterInfo.map((ch) => [Math.round(ch.origin * 100) / 100, ch.lineNumber]) };
};
// 自動縮放：上限 50、下限 10，高 40 只放得下一行。換行時先排成多行再縮，不換行時縮到寬度放得下
const AUTO = { m_enableAutoSizing: 1, m_fontSizeMin: 10, m_fontSizeMax: 50 };
const ctxShort: TextContext = { ...ctx, rect: { x: 0, y: 0, width: 200, height: 40 } };
const fontSizeShort = (c: Record<string, unknown>) => generateText(c, ctxShort, assets).fontSize;

describe('TMP 3.0 的元件（沒有 m_TextWrappingMode）', () => {
  it('這段字在 3.2 的 Normal 與 NoWrap 排得不一樣（測試不是空的）', () => {
    expect(layout(comp32(1)).lineCount).toBeGreaterThan(1);
    expect(layout(comp32(0)).lineCount).toBe(1);
    expect(fontSizeShort(comp32(1, AUTO))).not.toBe(fontSizeShort(comp32(0, AUTO)));
  });

  it('m_enableWordWrapping 0：跟 NoWrap 一樣排成一行', () => {
    expect(layout(comp30(0))).toEqual(layout(comp32(0)));
  });

  it('m_enableWordWrapping 1：跟 Normal 一樣換行', () => {
    expect(layout(comp30(1))).toEqual(layout(comp32(1)));
  });

  it('偏好高度照 m_enableWordWrapping（ContentSizeFitter、LayoutGroup 讀的）', () => {
    expect(getPreferredHeight(comp30(0), ctx, assets)).toBe(getPreferredHeight(comp32(0), ctx, assets));
    expect(getPreferredHeight(comp30(1), ctx, assets)).toBe(getPreferredHeight(comp32(1), ctx, assets));
  });

  it('自動縮放：不換行時縮到一行放得下', () => {
    expect(fontSizeShort(comp30(0, AUTO))).toBe(fontSizeShort(comp32(0, AUTO)));
    expect(fontSizeShort(comp30(1, AUTO))).toBe(fontSizeShort(comp32(1, AUTO)));
  });

  it('兩個欄位都有時照 m_TextWrappingMode（3.2 的資料不受影響）', () => {
    expect(layout({ ...comp32(1), m_enableWordWrapping: 0 })).toEqual(layout(comp32(1)));
    expect(layout({ ...comp32(0), m_enableWordWrapping: 1 })).toEqual(layout(comp32(0)));
  });
});

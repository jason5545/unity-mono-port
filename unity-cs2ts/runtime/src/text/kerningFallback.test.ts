// TMP 3.0 的元件沒有 m_ActiveFontFeatures（2026/10/17）：MT2 的 Unity.TextMeshPro.dll 是 3.0 系列，GenerateTextMesh 的字距調整看 m_enableKerning；
// 3.2 才改成 m_ActiveFontFeatures。以前欄位不存在就當成空清單，產生網格不做字距調整、偏好尺寸（照 m_enableKerning）有做，
// ContentSizeFitter 給的寬度比實際排的窄：關鍵字提示框的標題「圖示 Valor」被擠成兩行。字型用 Diceomancer 的 LiberationSans SDF（靜態字型裡唯一有字距表的，104 組）。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameTextAssets } from '../font/textAssets';
import type { SceneFile } from '../unity/types';
import type { TextContext } from './types';
import { generateText } from './index';
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
const ctx: TextContext = { rect: { x: 0, y: 0, width: 2000, height: 200 }, lossyScaleY: 1, canvas: { renderMode: 1, scaleFactor: 1, worldCameraAssigned: true }, isOrthographic: true, linearColorSpace: true };
const assets = makeAssets();
const LIBERATION = { guid: '4ad64ffb5da4df640b302df07e1298db', fileID: '11400000' };
const LIBERATION_MAT = { guid: '070ab48be76db4f4fa792c3146bc35f7', fileID: '2100000' };
/** 以 level1 的 1104 為底換成 LiberationSans SDF（存檔的 m_ActiveFontFeatures 是 kern），這裡改成各種組合 */
function comp(fields: Record<string, unknown>, dropFeatures: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = { ...load<SceneFile>('scenes/level1.json').components['1104'], m_text: 'AVATAR WAVE TOYOTA', m_TextWrappingMode: 0, m_fontAsset: LIBERATION, m_sharedMaterial: LIBERATION_MAT, ...fields };
  if (dropFeatures) delete base.m_ActiveFontFeatures;
  return base;
}
const origins = (c: Record<string, unknown>) => generateText(c, ctx, assets).textInfo.characterInfo.slice(0, 18).map((ch) => Math.round(ch.origin * 100) / 100);

describe('TMP 3.0 的元件（沒有 m_ActiveFontFeatures）', () => {
  // '6b65726e' 是 parseActiveFontFeatures 讀得出 kern 的寫法（存檔的 6e72656b 它讀不出來，見 README 的新發現）
  const kerned = origins(comp({ m_ActiveFontFeatures: '6b65726e' }, false));
  const plain = origins(comp({ m_ActiveFontFeatures: '' }, false));

  it('這段字有字距調整（測試不是空的）', () => {
    expect(kerned).not.toEqual(plain);
  });

  it('m_enableKerning 開著：照字距表排（跟 3.2 開了 kern 一樣）', () => {
    expect(origins(comp({ m_enableKerning: 1 }, true))).toEqual(kerned);
  });

  it('m_enableKerning 關著：不調整', () => {
    expect(origins(comp({ m_enableKerning: 0 }, true))).toEqual(plain);
  });
});

// 驗收 8：手算單元測試。字型一律用真的 Biko_Bold SDF（f7e314a5…，pointSize 44；sprite 用 TMP Settings 預設的 ManaSheetForTMP）。
// 每條的期望值都是照原始碼公式用 float32 手算的（算式寫在各案例註解）；元件以 level1 的 1104 為底改欄位。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameTextAssets } from '../font/textAssets';
import type { SceneFile } from '../unity/types';
import type { TextContext } from './types';
import { generateText } from './index';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

const BIKO = 'f7e314a50ab19a849b3cde5fc51294a1';
const MANA = 'a7b4008c908e48b4093a090ead49af25';

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

/** 以 level1 元件 1104（Biko_Bold、字級 30）為底的元件 */
function baseComp(overrides: Record<string, unknown>): Record<string, unknown> {
  const level1 = load<SceneFile>('scenes/level1.json');
  return { ...level1.components['1104'], ...overrides };
}

function uiCtx(w: number, h: number): TextContext {
  return { rect: { x: 0, y: 0, width: w, height: h }, lossyScaleY: 1, canvas: { renderMode: 1, scaleFactor: 1, worldCameraAssigned: true }, isOrthographic: true, linearColorSpace: true };
}

const assets = makeAssets();

describe('驗收 8：手算單元測試（Biko_Bold SDF）', () => {
  it('自動換行：A A A 在寬 30 斷成三行（含行距 30）', () => {
    // scale = 30/44 = 0.6818182；A adv 21.2962、space 6.9034；30.0001 放不下 A空格A（28.2 放得下的其實是 A+space）
    // 行距：lineOffset = 0 − (−7.5) + 22.5 + 0×baseScale = 30（InsertNewLine，TMP_Text.cs:5000–5011）
    const r = generateText(baseComp({ m_text: 'A A A', m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(30, 200), assets);
    expect(r.textInfo.lineCount).toBe(3);
    expect(r.textInfo.characterInfo.map((c) => c.lineNumber)).toEqual([0, 0, 1, 1, 2]);
    // Top 對齊：anchorOffset.y = 200 − 22.5 = 177.5（3750–3761）；A 的 BL.y = −0.852273 − lineOffset + 177.5
    const ci = r.textInfo.characterInfo;
    expect(ci[0].bottomLeft.y).toBeCloseTo(176.6477, 3);
    expect(ci[2].bottomLeft.y).toBeCloseTo(146.6477, 3);
    expect(ci[4].bottomLeft.y).toBeCloseTo(116.6477, 3);
    // Left 對齊：origin.x = 0
    expect(ci[0].origin).toBeCloseTo(0, 5);
    expect(ci[2].origin).toBeCloseTo(0, 5);
    expect(ci[4].origin).toBeCloseTo(0, 5);
    // 行高與 baseline（phase II 對齊後：phase I 的 0/−30/−60 加 offset.y 177.5，TMPro_UGUI_Private.cs:4165）
    expect(r.textInfo.lineInfo[0].baseline).toBeCloseTo(177.5, 3);
    expect(r.textInfo.lineInfo[1].baseline).toBeCloseTo(147.5, 3);
    expect(r.textInfo.lineInfo[2].baseline).toBeCloseTo(117.5, 3);
  });

  it('auto size 縮小：A 在寬 25 從 50 縮到 35.2', () => {
    // 二分：50→34→42→38→36→35→35.5→35.25→35.125→35.1875→35.25→35.2（35.25−35.2 = 0.05 ≤ 0.051 停）
    const r = generateText(baseComp({ m_text: 'A', m_enableAutoSizing: 1, m_fontSizeMin: 18, m_fontSizeMax: 50, m_TextWrappingMode: 0, m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(25, 57), assets);
    expect(r.fontSize).toBe(Math.fround(35.2));
    // scale = 35.2/44 = 0.8；A BL.x = (0.875−1.25)×0.8 = −0.3；BL.y = −1.0 + 30.6 = 29.6
    const ci = r.textInfo.characterInfo;
    expect(ci[0].bottomLeft.x).toBeCloseTo(-0.3, 3);
    expect(ci[0].bottomLeft.y).toBeCloseTo(29.6, 3);
    expect(ci[0].topRight.x).toBeCloseTo(25.2875, 3);
  });

  it('<size=130%>：A 字級 30→39', () => {
    // m_currentFontSize = 30 × 130 / 100 = 39；scale = 39/44 = 0.8863636
    const r = generateText(baseComp({ m_text: '<size=130%>A', m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(100, 100), assets);
    const ci = r.textInfo.characterInfo;
    // BL.x = (0.875−1.25)×0.88636 = −0.33239；offset.y = 100 − 33×0.88636 = 70.75
    expect(ci[0].bottomLeft.x).toBeCloseTo(-0.33239, 3);
    expect(ci[0].bottomLeft.y).toBeCloseTo(69.642, 3);
    expect(ci[0].topRight.x).toBeCloseTo(28.0174, 3);
    expect(ci[0].topRight.y).toBeCloseTo(99.6261, 3);
  });

  it('<color=#FF0000>：頂點色變紅', () => {
    const r = generateText(baseComp({ m_text: '<color=#FF0000>A</color>', m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(100, 100), assets);
    const sub = r.subMeshes[0];
    expect([...sub.colors.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it('<i>：斜體剪切（italicStyle 15）', () => {
    // shear = 15×0.01 = 0.15；midPoint = 31/2 = 15.5；topShear = 0.15×(31.328125+1.25−15.5)×0.68182 = 1.74663
    // botShear = 0.15×(31.328125−31.328125−1.25−15.5)×0.68182 = −1.71307
    const r = generateText(baseComp({ m_text: '<i>A', m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(100, 100), assets);
    const ci = r.textInfo.characterInfo;
    expect(ci[0].topLeft.x).toBeCloseTo(1.49094, 3);
    expect(ci[0].topRight.x).toBeCloseTo(23.29847, 3);
    expect(ci[0].bottomLeft.x).toBeCloseTo(-1.96875, 3);
    expect(ci[0].bottomRight.x).toBeCloseTo(19.83878, 3);
    // y 不變（剪切只動 x）
    expect(ci[0].topLeft.y).toBeCloseTo(99.7124, 3);
    expect(ci[0].bottomLeft.y).toBeCloseTo(76.6477, 3);
  });

  it('<u>：底線網格頂點（12 頂點，加在主網格 referenceCount×4 之後）', () => {
    // underlineBaseLine = baseLine + (−4.4)×0.68182 = 77.5 − 3.0 = 74.5；segW = 16.671875/2 × 0.68182 = 5.68359
    // y0 = 74.5 − (2.2+1.25)×0.68182 = 72.14773；y1 = 74.5 + 1.25×0.68182 = 75.35227
    const r = generateText(baseComp({ m_text: '<u>A', m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(100, 100), assets);
    const sub = r.subMeshes[0];
    expect(sub.positions.length / 3).toBe(16); // 4（A）＋12（底線）
    const P = (v: number) => [sub.positions[v * 3], sub.positions[v * 3 + 1]];
    // 底線 12 頂點在輸出的 4..15（主網格前 4 個是 A）；P(4+n) = DrawUnderlineMesh 的 vertices[n]
    expect(P(4)[0]).toBeCloseTo(-0.25568, 3);
    expect(P(4)[1]).toBeCloseTo(72.14773, 3);
    expect(P(5)[1]).toBeCloseTo(75.35227, 3);
    expect(P(6)[0]).toBeCloseTo(5.42791, 3);
    expect(P(10)[0]).toBeCloseTo(15.86825, 3); // v6 = end.x − segW
    expect(P(14)[0]).toBeCloseTo(21.55185, 3); // v10 = end.x
    expect(P(15)[1]).toBeCloseTo(72.14773, 3);
    // uv：'_' 的 rect (445,496,17,6)，padding 1.25，atlas 512
    expect(sub.uvs0[4 * 4]).toBeCloseTo(0.866699, 5);
    expect(sub.uvs0[4 * 4 + 1]).toBeCloseTo(0.966309, 5);
    expect(sub.uvs0[5 * 4 + 1]).toBeCloseTo(0.98291, 5);
    // uv0.w = |xScaleMax| = 0.68182（sdfScale）
    expect(sub.uvs0[4 * 4 + 3]).toBeCloseTo(0.681818, 4);
  });

  it('<b>：style padding 0.9375、boldSpacing 7、uv0.w 變負', () => {
    // style_padding = 0.75/4 × 6 × 0.8333333 = 0.9375；xAdvance = 31.234375×0.68182 + 7×0.3 = 21.2962 + 2.1 = 23.3962
    const r = generateText(baseComp({ m_text: '<b>A', m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(100, 100), assets);
    const ci = r.textInfo.characterInfo;
    // BL.x = (0.875 − 1.25 − 0.9375)×0.68182 = −0.89489
    expect(ci[0].bottomLeft.x).toBeCloseTo(-0.89489, 3);
    expect(ci[0].topRight.x).toBeCloseTo(22.19105, 3);
    expect(ci[0].xAdvance).toBeCloseTo(23.3962, 3);
    // uv0.w = −scale（粗體取負，4069–4070）
    expect(r.subMeshes[0].uvs0[3]).toBeCloseTo(-0.681818, 4);
  });

  it('<sprite=0>：預設 sprite asset 的 sprite 0', () => {
    // spriteScale = 30/44 = 0.68182；elementScale = 33/128 × 1 × 1 × 0.68182 = 0.17578125
    // BL=(0, 77.5) TR=(22.5, 100)（glyph 128×128，bearing (0,128)，padding 0）
    const r = generateText(baseComp({ m_text: '<sprite=0>', m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(100, 100), assets);
    expect(r.subMeshes.length).toBe(2);
    const sub = r.subMeshes[1];
    expect(sub.spriteAsset?.guid).toBe(MANA);
    expect(sub.positions.length / 3).toBe(4);
    expect(sub.positions[0]).toBeCloseTo(0, 5);
    expect(sub.positions[1]).toBeCloseTo(77.5, 3);
    expect(sub.positions[2 * 3]).toBeCloseTo(22.5, 3);
    expect(sub.positions[2 * 3 + 1]).toBeCloseTo(100.0, 3);
    // uv：rect (0,384,128,128) / sheet 768×512
    expect(sub.uvs0[0]).toBeCloseTo(0, 6);
    expect(sub.uvs0[1]).toBeCloseTo(0.75, 6);
    expect(sub.uvs0[2 * 4]).toBeCloseTo(0.166667, 5);
    expect(sub.uvs0[2 * 4 + 1]).toBeCloseTo(1.0, 6);
  });

  it('<link>：linkInfo 的 id 與範圍', () => {
    const r = generateText(baseComp({ m_text: '<link="abc">A</link>' }), uiCtx(100, 100), assets);
    expect(r.textInfo.linkCount).toBe(1);
    const l = r.textInfo.linkInfo[0];
    expect(l.linkId).toBe('abc');
    expect(l.linkText).toBe('A');
    expect(l.linkTextfirstCharacterIndex).toBe(0);
    expect(l.linkTextLength).toBe(1);
    // hashCode：GetHashCode 的大小寫不敏感版（ToUpperFast）對 "abc" → "ABC" = 68800
    expect(l.hashCode).toBe(68800);
    // linkIdFirstCharacterIndex = startIndex(1) + valueStartIndex(6) = 7（'a' 在 <link="abc"> 裡的位置）
    expect(l.linkIdFirstCharacterIndex).toBe(7);
    expect(l.linkIdLength).toBe(3);
  });

  it('overflow Ellipsis：AAA 在 45×40 截成 A…', () => {
    // A adv 21.2962；A+A+… = 42.59+19.02 > 45.0001 放不下；A+… = 40.31 放得下
    // 截斷後 characterCount 3：A、…、注入的 0x03（End of Text，不可見）
    const r = generateText(baseComp({ m_text: 'AAA', m_overflowMode: 1, m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(45, 40), assets);
    expect(r.isTextTruncated).toBe(true);
    expect(r.textInfo.characterCount).toBe(3);
    expect(r.textInfo.characterInfo[1].character).toBe(0x2026);
    expect(r.textInfo.characterInfo[2].character).toBe(0x03);
    expect(r.textInfo.characterInfo[2].isVisible).toBe(false);
    // A BL.y = −0.8523 + 17.5 = 16.6477；… BL.x = 21.2962 + (1.984375−1.25)×0.68182 = 21.7969
    const ci = r.textInfo.characterInfo;
    expect(ci[0].bottomLeft.y).toBeCloseTo(16.6477, 3);
    expect(ci[1].bottomLeft.x).toBeCloseTo(21.7969, 3);
    expect(ci[1].topRight.x).toBeCloseTo(39.8224, 3);
    expect(ci[1].xAdvance).toBeCloseTo(40.3125, 3);
  });

  it('Justified：A A A 在寬 70 換行，第一行兩端對齊、最後一行靠左', () => {
    // 換行後行 0 = A␣A␣（trailing space 在行 0 但不計入 maxAdvance：Normal 模式的空白不走 3284 的 lastVisible 更新）
    // maxAdvance = xAdvance(A2) = 49.4957；visibleSpaceCount = 0 → spaces=0 → ratio=1 → gap 全給非空白字元
    // gap = 70.0001−49.4957 = 20.5044；A2 += gap×1/1 = 20.5044 → 28.1996+20.5044 = 48.7040；sp3 = 49.4957+20.5044 = 70.0001
    const r = generateText(baseComp({ m_text: 'A A A', m_HorizontalAlignment: 8, m_VerticalAlignment: 0x100 }), uiCtx(70, 100), assets);
    const ci = r.textInfo.characterInfo;
    expect(r.textInfo.lineCount).toBe(2);
    expect(ci[0].origin).toBeCloseTo(0, 5);
    expect(ci[1].origin).toBeCloseTo(21.2962, 3);
    expect(ci[2].origin).toBeCloseTo(48.704, 3);
    expect(ci[3].origin).toBeCloseTo(70.0001, 3);
    expect(ci[4].origin).toBeCloseTo(0, 5); // 最後一行不對齊
    expect(r.textInfo.lineInfo[0].maxAdvance).toBeCloseTo(49.4957, 3);
  });

  it('TextMeshPro 3D 版的 xScale：scale × |lossyScale|', () => {
    // 3D：xScale = characterInfos[i].scale × |lossyScale| × (1 − charWidthAdjDelta)（TMPro_Private.cs:3941）
    const comp = baseComp({ m_text: 'P', script: { assembly: 'Unity.TextMeshPro', namespace: 'TMPro', class: 'TextMeshPro' } });
    const r = generateText(comp, { rect: { x: 0, y: 0, width: 100, height: 100 }, lossyScaleY: 2, canvas: null, isOrthographic: true, linearColorSpace: true }, assets);
    // scale = 30/44 = 0.68182；xScale = 0.68182 × 2 = 1.36364
    expect(r.subMeshes[0].uvs0[3]).toBeCloseTo(1.363636, 4);
  });

  it('fallback 字型：A玩 → 玩 走江城 600W 的子網格與 fallback 材質', async () => {
    // 動態字型要先 prepare（fallback 鏈會把江城 600W 載進來）
    await assets.prepare([BIKO], (f) => Promise.resolve(load(`assets/glyphs/${f}`)));
    const r = generateText(baseComp({ m_text: 'A玩', m_HorizontalAlignment: 1, m_VerticalAlignment: 0x100 }), uiCtx(200, 100), assets);
    expect(r.subMeshes.length).toBe(2);
    const sub0 = r.subMeshes[0];
    const sub1 = r.subMeshes[1];
    expect(sub0.fontAsset?.guid).toBe(BIKO);
    expect(sub1.fontAsset?.guid).toBe('98924f49e2a56d34e8a40c61694e1146');
    // fallback 材質：m_matchMaterialPreset=1 → GetFallbackMaterial（從元件材質複製，保留江城材質的 _GradientScale/_TextureWidth/_Height/_WeightNormal/_WeightBold 與 _MainTex）
    expect(sub1.material.source).toBeNull();
    expect(sub1.material.floats._GradientScale).toBe(6);
    expect(sub1.material.floats._TextureWidth).toBe(4096);
    // 江城 pointSize 90：elementScale = 30/90 = 0.33333；玩 metrics（glyph store）：w 84.609375、h 77.671875、bx 2.875、by 69.84375、adv 90
    // BL.x = A.xAdvance + (2.875−1.25)×0.33333 = 21.2962 + 0.54167 = 21.8378
    const ci = r.textInfo.characterInfo;
    expect(ci[0].materialReferenceIndex).toBe(0);
    expect(ci[1].materialReferenceIndex).toBe(1);
    expect(ci[1].bottomLeft.x).toBeCloseTo(21.8378, 3);
    expect(ci[1].xAdvance).toBeCloseTo(51.2962, 3);
  });
});

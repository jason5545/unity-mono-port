// 驗收 4：PLAY。真字型（Biko_Bold SDF f7e314a5…）、真材質（6697e69f…）、真元件（level1.json 元件 1104，m_text 換成 'PLAY'）。
// 中間值與頂點表是 Claude Code 10/5 用 float32 照原始碼手算的。
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

describe('驗收 4：PLAY', () => {
  const assets = makeAssets();
  const level1 = load<SceneFile>('scenes/level1.json');
  const comp = { ...level1.components['1104'], m_text: 'PLAY' };
  const ctx: TextContext = {
    rect: { x: -143, y: -28.5, width: 286, height: 57 },
    lossyScaleY: 0.01,
    canvas: { renderMode: 1, scaleFactor: 1, worldCameraAssigned: true },
    isOrthographic: true,
    linearColorSpace: true,
  };
  const result = generateText(comp, ctx, assets);

  it('主網格 16 頂點、24 index', () => {
    expect(result.subMeshes.length).toBe(1);
    const sub = result.subMeshes[0];
    expect(sub.materialIndex).toBe(0);
    expect(sub.positions.length).toBe(48);
    expect(sub.indices.length).toBe(24);
  });

  // 頂點順序 BL、TL、TR、BR；位置誤差 1e-3、uv 誤差 1e-5
  const expected: [string, [number, number], [number, number], [number, number], [number, number]][] = [
    // [字, BL(x,y), TR(x,y), uv BL, uv TR]
    ['P', [-36.6583, -8.3523], [-21.7862, 14.7124], [0.669434, 0.519043], [0.713379, 0.586426]],
    ['L', [-20.2201, -8.3523], [-3.6008, 14.7124], [0.591309, 0.437012], [0.641113, 0.504395]],
    ['A', [-3.9311, -8.3523], [17.8765, 14.7124], [0.507324, 0.530762], [0.572754, 0.598145]],
    ['Y', [17.2479, -8.3523], [38.4269, 14.7124], [0.589355, 0.526855], [0.652832, 0.594238]],
  ];

  it.each(expected)('%s 的四角與 uv', (_ch, bl, tr, uvBL, uvTR) => {
    const sub = result.subMeshes[0];
    const i = expected.findIndex((e) => e[0] === _ch) * 4;
    // BL
    expect(sub.positions[i * 3]).toBeCloseTo(bl[0], 3);
    expect(sub.positions[i * 3 + 1]).toBeCloseTo(bl[1], 3);
    // TR
    expect(sub.positions[(i + 2) * 3]).toBeCloseTo(tr[0], 3);
    expect(sub.positions[(i + 2) * 3 + 1]).toBeCloseTo(tr[1], 3);
    // uv BL / TR
    expect(sub.uvs0[i * 4]).toBeCloseTo(uvBL[0], 5);
    expect(sub.uvs0[i * 4 + 1]).toBeCloseTo(uvBL[1], 5);
    expect(sub.uvs0[(i + 2) * 4]).toBeCloseTo(uvTR[0], 5);
    expect(sub.uvs0[(i + 2) * 4 + 1]).toBeCloseTo(uvTR[1], 5);
  });

  it('uv0.w = 0.6818182 × 0.01（4068–4090，ScreenSpaceCamera 有攝影機）；頂點色 [254,255,213,255]', () => {
    const sub = result.subMeshes[0];
    for (let v = 0; v < 16; v++) {
      expect(sub.uvs0[v * 4 + 3]).toBeCloseTo(0.006818182, 8);
      expect([...sub.colors.slice(v * 4, v * 4 + 4)]).toEqual([254, 255, 213, 255]);
    }
  });

  it('textInfo：lineCount 1；lineInfo 是 phase II 對齊後的最終狀態', () => {
    expect(result.textInfo.lineCount).toBe(1);
    const line = result.textInfo.lineInfo[0];
    // phase II 的調整（TMPro_UGUI_Private.cs:4159–4188）：offset = anchorOffset(−143, −7.5) + justificationOffset(104.946, 0) = (−38.05393, −7.5)
    // maxAdvance = 76.10796 + (−38.05393) = 38.05403；baseline = 0 + (−7.5)；ascender = 22.5 − 7.5；descender = −7.5 − 7.5
    expect(line.maxAdvance).toBeCloseTo(38.054, 3);
    expect(line.baseline).toBeCloseTo(-7.5, 3);
    expect(line.ascender).toBeCloseTo(15.0, 3);
    expect(line.descender).toBeCloseTo(-15.0, 3);
    // lineExtents：min.x = 第一個字（firstCharacterIndex 0）的 bottomLeft.x，max.x = 最後可見字（lastVisibleCharacterIndex 3）的 topRight.x，min.y/max.y = descender/ascender
    expect(line.lineExtents.min.x).toBeCloseTo(-36.6583, 3);
    expect(line.lineExtents.max.x).toBeCloseTo(38.4269, 3);
    expect(line.lineExtents.min.y).toBeCloseTo(-15.0, 3);
    expect(line.lineExtents.max.y).toBeCloseTo(15.0, 3);
    expect(result.textInfo.characterInfo[0].origin).toBeCloseTo(-38.0539, 3);
    expect(result.textInfo.characterInfo[3].xAdvance).toBeCloseTo(38.054, 3);
  });

  it('材質帶算過的 _ScaleRatioA（UpdateShaderRatios）', () => {
    // Biko_Bold SDF 材質：_GradientScale 6、weight = max(0, 0.75)/4 = 0.1875、t = max(1, 0.1875+0+0+0) = 1
    // ratio_A = (6 − 1) / (6 × 1) = 0.8333333
    expect(result.subMeshes[0].material.floats._ScaleRatioA).toBeCloseTo(0.8333333, 6);
  });
});

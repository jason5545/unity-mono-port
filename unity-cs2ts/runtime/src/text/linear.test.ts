// 驗收 6：3D 版（TextMeshPro）在 linear 色彩空間把頂點色每個 byte 照 GammaToLinear 轉（alpha 不轉）；
// 同一個元件換成 TextMeshProUGUI 時不轉。
// 期望值是 Claude Code 用 float32 算的：0→0、10→0、128→55、200→147、213→169、254→252、255→255。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameTextAssets } from '../font/textAssets';
import type { SceneFile } from '../unity/types';
import type { TextContext } from './types';
import { generateText } from './index';
import { gammaToLinearByte } from './utils';
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

describe('驗收 6：3D 版轉線性', () => {
  const assets = makeAssets();
  const level1 = load<SceneFile>('scenes/level1.json');

  // 元件 1104（TextMeshProUGUI）複製成 TextMeshPro，顏色給已知 byte 值
  const base = level1.components['1104'];
  const comp3d = {
    ...base,
    m_text: 'P',
    script: { ...(base.script as object), class: 'TextMeshPro' },
    m_fontColor: { r: 128 / 255, g: 200 / 255, b: 213 / 255, a: 254 / 255 },
  };
  const ctx3d: TextContext = { rect: { x: -143, y: -28.5, width: 286, height: 57 }, lossyScaleY: 1, canvas: null, isOrthographic: true, linearColorSpace: true };

  it('TextMeshPro（3D）linear：頂點色 byte 轉 linear，alpha 不轉', () => {
    const result = generateText(comp3d, ctx3d, assets);
    const c = result.subMeshes[0].colors;
    // 原始 Color32 = (128, 200, 213, 254)
    expect([c[0], c[1], c[2], c[3]]).toEqual([55, 147, 169, 254]);
  });

  it('GammaToLinear byte 表（float32）：0→0、10→0、128→55、200→147、213→169、254→252、255→255', () => {
    expect(gammaToLinearByte(0)).toBe(0);
    expect(gammaToLinearByte(10)).toBe(0);
    expect(gammaToLinearByte(128)).toBe(55);
    expect(gammaToLinearByte(200)).toBe(147);
    expect(gammaToLinearByte(213)).toBe(169);
    expect(gammaToLinearByte(254)).toBe(252);
    expect(gammaToLinearByte(255)).toBe(255);
  });

  it('同一個元件換成 TextMeshProUGUI：不轉（linearColorSpace true 也不轉）', () => {
    const compUi = { ...comp3d, script: { ...(base.script as object), class: 'TextMeshProUGUI' } };
    const ctxUi: TextContext = { ...ctx3d, canvas: { renderMode: 1, scaleFactor: 1, worldCameraAssigned: true } };
    const result = generateText(compUi, ctxUi, assets);
    const c = result.subMeshes[0].colors;
    expect([c[0], c[1], c[2], c[3]]).toEqual([128, 200, 213, 254]);
  });
});

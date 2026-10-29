// 驗收 5：Unity 編輯器存下的偏好尺寸（真元件、GameTextAssets、不套在地化、用存檔的 m_text）。
//   '12'（Biko_Regular 135，字級 20）→ getPreferredWidth = 16.67
//   '022222'（Biko_Bold，字級 24）→ getPreferredWidth = 75.90（模擬 75.894890 取整；存檔 75.91 差 0.01，兩個都算過）
//   'None'（Biko_Bold，auto size，上限 38）→ getPreferredHeight = 38.01
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameTextAssets } from '../font/textAssets';
import type { SceneFile } from '../unity/types';
import type { TextContext } from './types';
import { getPreferredHeight, getPreferredWidth } from './index';
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

// getPreferredWidth／Height 不用版面（margin 無限大）；ctx 的 rect 只是占位
const ctx: TextContext = { rect: { x: 0, y: 0, width: 0, height: 0 }, lossyScaleY: 1, canvas: null, isOrthographic: true, linearColorSpace: true };

describe('驗收 5：Unity 存檔的偏好尺寸', () => {
  const assets = makeAssets();
  const prefab = load<SceneFile>('scenes/prefabs/29d17aae0ae65a6478c8d11c25305fd1.json');
  const level2 = load<SceneFile>('scenes/level2.json');

  it("'12'（Biko_Regular 135，字級 20）：getPreferredWidth = 16.67", () => {
    const w = getPreferredWidth(prefab.components['114393105877652414'], ctx, assets);
    expect(w).toBe(Math.fround(16.67));
  });

  it("'022222'（Biko_Bold，字級 24）：getPreferredWidth = 75.90", () => {
    const w = getPreferredWidth(prefab.components['114630643969539439'], ctx, assets);
    expect(w).toBe(Math.fround(75.9));
  });

  // 元件 2065 存檔的 m_text 是 null（執行時由程式碼填 "None"）；高度只看字型與字級，補上執行時的值
  it("'None'（Biko_Bold，auto size，上限 38）：getPreferredHeight = 38.01", () => {
    const h = getPreferredHeight({ ...level2.components['2065'], m_text: 'None' }, ctx, assets);
    expect(h).toBe(Math.fround(38.01));
  });
});

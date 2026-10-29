// sdf.ts 對原版 build 已烘好的動態字型 atlas 驗證（江城圆体 600W 兩份、ConcertOne）：同樣的字、同樣的設定（point size、padding、SDFAA），
// 我們算的距離場要跟原版 FontEngine 的結果幾乎一樣，GlyphRect 的寬高與度量值要完全一樣。
// 門檻照 10/5 實測值：這份 TS 實作江城 87 字 MAE 0.978、p99 10、偏差 −0.001；22 字 MAE 0.977、p99 9；ConcertOne MAE 0.788、p99 6。
// 誤差最大的單一像素是 36 階（角落），平均約 1 階，畫面上看不出來。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bitmapBox, renderSdf, type Outline } from './sdf';
import { readPng } from './testing/png';
import { TEST_GAME } from '../testData';

const ASSETS = resolve(TEST_GAME, 'assets');
function load<T>(p: string): T {
  const f = resolve(ASSETS, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

interface GlyphRecord {
  m_Index: number;
  m_Metrics: { m_Width: number; m_Height: number; m_HorizontalBearingX: number; m_HorizontalBearingY: number; m_HorizontalAdvance: number };
  m_GlyphRect: { m_X: number; m_Y: number; m_Width: number; m_Height: number };
}
interface Store {
  pointSize: number;
  glyphs: Record<string, [number, number, number, number, number, Outline]>;
}

function compare(fontAssetGuid: string) {
  const index = load<{ fontAssets: Record<string, string> }>('glyphs.json');
  const store = load<Store>(`glyphs/${index.fontAssets[fontAssetGuid]}`);
  const asset = load<{ m_GlyphTable: GlyphRecord[]; m_AtlasPadding: number; m_AtlasTextures: { guid: string }[] }>(`objects/${fontAssetGuid}.json`);
  const textures = load<Record<string, { file: string }>>('textures.json');
  const atlas = readPng(resolve(ASSETS, textures[asset.m_AtlasTextures[0].guid].file));
  const pad = asset.m_AtlasPadding;
  const errs: number[] = [];
  let glyphs = 0;
  const badRects: string[] = [];
  const badMetrics: string[] = [];
  const missing: number[] = [];
  for (const g of asset.m_GlyphTable) {
    const s = store.glyphs[g.m_Index];
    if (!s) {
      missing.push(g.m_Index);
      continue;
    }
    const m = g.m_Metrics;
    const mine = s.slice(0, 5).map((v) => (v as number) / 64);
    const theirs = [m.m_Width, m.m_Height, m.m_HorizontalBearingX, m.m_HorizontalBearingY, m.m_HorizontalAdvance];
    if (mine.some((v, i) => Math.fround(v) !== Math.fround(theirs[i]))) badMetrics.push(`${g.m_Index}: ${mine} ≠ ${theirs}`);
    const r = g.m_GlyphRect;
    const box = bitmapBox(s[5]);
    if (box.width !== r.m_Width || box.height !== r.m_Height) badRects.push(`${g.m_Index}: ${box.width}×${box.height} ≠ ${r.m_Width}×${r.m_Height}`);
    if (r.m_Width === 0) continue;
    const bmp = renderSdf(s[5], pad);
    const W = bmp.width + 2 * pad;
    for (let j = 0; j < bmp.height + 2 * pad; j++) {
      const yUnity = r.m_Y - pad + j;
      const row = atlas.height - 1 - yUnity;
      for (let i = 0; i < W; i++) {
        const alpha = atlas.data[(row * atlas.width + r.m_X - pad + i) * 4 + 3];
        errs.push(bmp.data[j * W + i] - alpha);
      }
    }
    glyphs++;
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  return {
    glyphs,
    missing,
    badRects,
    badMetrics,
    mae: abs.reduce((a, b) => a + b, 0) / abs.length,
    p99: abs[Math.floor(abs.length * 0.99)],
    bias: errs.reduce((a, b) => a + b, 0) / errs.length,
  };
}

describe('TMP 動態字型的 SDF（對原版烘好的 atlas）', () => {
  it('江城圆体 600W（TextMesh Pro/Resources 那份，87 個字，90pt、padding 5）', () => {
    const r = compare('02a5eddc677cfd04dbfce3831516abbb');
    expect({ glyphs: r.glyphs, missing: r.missing, badRects: r.badRects, badMetrics: r.badMetrics }).toEqual({ glyphs: 87, missing: [], badRects: [], badMetrics: [] });
    expect(r.mae).toBeLessThan(1.3);
    expect(r.p99).toBeLessThanOrEqual(10);
    expect(Math.abs(r.bias)).toBeLessThan(0.3);
  });

  it('江城圆体 600W（Resources 那份，22 個字）', () => {
    const r = compare('98924f49e2a56d34e8a40c61694e1146');
    expect({ glyphs: r.glyphs, missing: r.missing, badRects: r.badRects, badMetrics: r.badMetrics }).toEqual({ glyphs: 22, missing: [], badRects: [], badMetrics: [] });
    expect(r.mae).toBeLessThan(1.3);
    expect(r.p99).toBeLessThanOrEqual(10);
  });

  it('ConcertOne-Regular（7 個字，90pt、padding 9）', () => {
    const r = compare('6d44507c802bdc1468e27930b2d4e21a');
    expect({ glyphs: r.glyphs, missing: r.missing, badRects: r.badRects, badMetrics: r.badMetrics }).toEqual({ glyphs: 7, missing: [], badRects: [], badMetrics: [] });
    expect(r.mae).toBeLessThan(1.1);
    expect(r.p99).toBeLessThanOrEqual(7);
  });
});

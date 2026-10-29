// textAssets.ts 的測試，用真的匯入資料（public/game/assets，先跑 npm run import）。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderSdf } from './sdf';
import { GameTextAssets, resourcePath } from './textAssets';
import { TEST_GAME } from '../testData';

const ASSETS = resolve(TEST_GAME, 'assets');
function load<T>(p: string): T {
  const f = resolve(ASSETS, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

const BIKO_BOLD = 'f7e314a50ab19a849b3cde5fc51294a1'; // 場景用的那份（另一份 c24c6125 是內容相同的副本）
const JIANGCHENG_600W = '98924f49e2a56d34e8a40c61694e1146'; // Biko_Bold 的 fallback

let assets: GameTextAssets;
beforeAll(async () => {
  const index = load<Record<string, { name: string; src: string; kind: string | null; file: string }>>('monobehaviours.json');
  const objects = new Map<string, Record<string, unknown>>();
  for (const [guid, m] of Object.entries(index)) if (m.kind?.startsWith('TMP_')) objects.set(guid, load(m.file));
  assets = GameTextAssets.fromData(index, objects, load('materials.json'), load('texts.json'), load<{ fontAssets: Record<string, string> }>('glyphs.json').fontAssets, {
    [BIKO_BOLD]: 100,
  });
  await assets.prepare([BIKO_BOLD], async (file) => load(`glyphs/${file}`));
});

describe('TMP 的素材介面', () => {
  it('Resources 路徑：去掉 Resources/ 之前與副檔名、不分大小寫', () => {
    expect(resourcePath('TextMesh Pro/Resources/Fonts & Materials/Jua-Regular SDF.asset')).toBe('fonts & materials/jua-regular sdf');
    expect(resourcePath('Sprite/foo.asset')).toBeNull();
  });

  it('Resources.Load：字型、sprite asset、材質；兩個 Resources 資料夾的同名副本挑場景用的那份', () => {
    expect(assets.resource('Fonts & Materials/Jua-Regular SDF', 'TMP_FontAsset')?.data.m_Name).toBe('Jua-Regular SDF');
    expect(assets.resource('fonts & materials/BIKO_BOLD SDF', 'TMP_FontAsset')?.ref.guid).toBe(BIKO_BOLD);
    expect(assets.resource('Sprite Assets/ManaSheetForTMP', 'TMP_SpriteAsset')?.ref.guid).toBe('a7b4008c908e48b4093a090ead49af25');
    expect(assets.resource('Sprite Assets/ManaSheetForTMP', 'TMP_FontAsset')).toBeNull();
    expect(assets.resource('Fonts & Materials/Biko_Bold SDF Material', 'Material')?.data.m_Name).toBe('Biko_Bold SDF Material');
  });

  it('fallback 鏈：Biko_Bold SDF → 江城圆体 600W SDF', () => {
    expect(assets.fallbackChain(BIKO_BOLD)).toEqual([BIKO_BOLD, JIANGCHENG_600W]);
  });

  it('動態字：度量值 = FreeType 26.6 ÷ 64；新字避開烘好的 22 個佔位；atlas 內容就是那個字的 SDF', () => {
    const font = assets.dynamicFonts.get(JIANGCHENG_600W)!;
    expect(font.atlas.padding).toBe(5);
    // 這個字型是動態的但 build 裡烘好了 22 個字（m_GlyphTable）：prepare 已佔住那些位置（reserve），
    // 執行時新加的字排在別處（TMP 的動態字型：新字加進同一張 atlas，不能蓋到烘好的內容）
    expect(font.bakedRects.length).toBe(22);
    const r = assets.addDynamicCharacter({ guid: JIANGCHENG_600W, fileID: '11400000' }, '繼'.codePointAt(0)!)!;
    const gid = font.store.cmap['繼'.codePointAt(0)!];
    const g = font.store.glyphs[gid];
    expect(r.character).toEqual({ m_ElementType: 1, m_Unicode: 0x7e7c, m_GlyphIndex: gid, m_Scale: 1 });
    expect(r.glyph.m_Metrics).toEqual({ m_Width: g[0] / 64, m_Height: g[1] / 64, m_HorizontalBearingX: g[2] / 64, m_HorizontalBearingY: g[3] / 64, m_HorizontalAdvance: g[4] / 64 });
    const rect = r.glyph.m_GlyphRect as { m_X: number; m_Y: number; m_Width: number; m_Height: number };
    // 位置不跟任何烘好區域重疊
    for (const z of font.bakedRects) {
      const overlap = rect.m_X < z.x + z.width && z.x < rect.m_X + rect.m_Width && rect.m_Y < z.y + z.height && z.y < rect.m_Y + rect.m_Height;
      expect(overlap).toBe(false);
    }
    const bmp = renderSdf(g[5], 5);
    expect([rect.m_Width, rect.m_Height]).toEqual([bmp.width, bmp.height]);
    const W = bmp.width + 10;
    for (let j = 0; j < bmp.height + 10; j++) {
      const row = font.atlas.data.subarray((rect.m_Y - 5 + j) * font.atlas.width + rect.m_X - 5, (rect.m_Y - 5 + j) * font.atlas.width + rect.m_X - 5 + W);
      expect(Array.from(row)).toEqual(Array.from(bmp.data.subarray(j * W, (j + 1) * W)));
    }
    // 再要一次是同一份；字型沒有的字是 null
    expect(assets.addDynamicCharacter({ guid: JIANGCHENG_600W, fileID: '11400000' }, 0x7e7c)).toBe(r);
    expect(assets.addDynamicCharacter({ guid: JIANGCHENG_600W, fileID: '11400000' }, 0x10ffff)).toBeNull();
    expect(assets.warnings).toEqual([]);
  });
});

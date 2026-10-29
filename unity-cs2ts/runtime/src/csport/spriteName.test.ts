// sprite 的名字（2026/10/17）：MT2 關鍵字提示框的標題用 iconSprite.name 組 `<sprite name="…" tint=1>`
// （StatusEffectsDisplayData.GetTMPSpriteTag）。以前 Object.name 對素材參照只問物件庫（prefab、ScriptableObject、文字檔），sprite 拿到空字串；
// Sprite.name／pivot 讀 m_Name、m_Pivot，素材庫給的欄位是 name、pivot，也拿不到。
import { describe, expect, it } from 'vitest';
import { AssetDB } from '../unity/assets';
import type { Ctx } from './core';
import { Sprite_get_bounds, Sprite_get_name, Sprite_get_pivot } from './unityAssets';
import { Object_get_name } from './unityScene';

const ctxWith = (render: Record<string, unknown>) => ({ w: { services: { render } } }) as unknown as Ctx;
const valor = { guid: '2c1b8f7e0d4a4c5f9a3e6b7d8c9e0f1a', fileID: '21300000' };

describe('Object.name 給素材參照', () => {
  it('物件庫沒有的參照問素材庫（sprite 的名字）', () => {
    const c = ctxWith({ assetName: (ref: { guid: string }) => (ref.guid === valor.guid ? 'StatusValor' : null) });
    expect(Object_get_name(c, valor)).toBe('StatusValor');
  });

  it('素材庫也沒有：空字串', () => {
    expect(Object_get_name(ctxWith({ assetName: () => null }), valor)).toBe('');
  });
});

describe('Sprite.name、pivot', () => {
  const info = { name: 'StatusValor', pivot: { x: 0, y: 1 }, m_Rect: { x: 0, y: 0, width: 64, height: 32 }, m_PixelsToUnits: 100 };
  const c = ctxWith({ spriteInfo: () => info });

  it('名字讀素材庫的 name', () => {
    expect(Sprite_get_name(c, valor)).toBe('StatusValor');
  });

  it('pivot 是像素（樞紐比例 × rect），bounds 的中心照樞紐偏', () => {
    expect(Sprite_get_pivot(c, valor)).toEqual({ x: 0, y: 32 });
    const b = Sprite_get_bounds(c, valor);
    expect(b.center.x).toBeCloseTo(0.32);
    expect(b.center.y).toBeCloseTo(-0.16);
  });
});

describe('AssetDB.assetName', () => {
  // 建構子是 private：測試直接給四張表（貼圖、sprite、材質、內建資源）
  const db = new (AssetDB as unknown as new (...a: unknown[]) => AssetDB)(
    './',
    { tex1: { name: 'TGT_Arrow_Links', file: 'x.png', width: 256, height: 256 }, tex3: { name: 'CardArt', file: 'y.png', width: 972, height: 1176 } },
    { tex1: { m_Name: 'TGT_Arrow_Links_Sprite' }, spr2: { m_Name: 'StatusValor' } },
    { mat1: { m_Name: 'TargetingBeamV2' } },
    { '0000000000000000f000000000000000:10905': { name: 'UISprite', type: 'Sprite' } },
    [],
    {},
  );

  it('材質（2100000）、貼圖（2800000）、sprite（其他 fileID）、內建資源', () => {
    expect(db.assetName({ guid: 'mat1', fileID: '2100000' })).toBe('TargetingBeamV2');
    expect(db.assetName({ guid: 'tex1', fileID: '2800000' })).toBe('TGT_Arrow_Links');
    expect(db.assetName({ guid: 'spr2', fileID: '21300000' })).toBe('StatusValor');
    expect(db.assetName({ guid: '0000000000000000f000000000000000', fileID: '10905' })).toBe('UISprite');
  });

  it('sprite 照 guid 找（sprites.json 只照 guid 記）；sprite 表沒有就退回貼圖名；都沒有回 null', () => {
    expect(db.assetName({ guid: 'tex1', fileID: '21300002' })).toBe('TGT_Arrow_Links_Sprite');
    expect(db.assetName({ guid: 'tex3', fileID: '21300000' })).toBe('CardArt');
    expect(db.assetName({ guid: 'nope', fileID: '21300000' })).toBeNull();
  });
});

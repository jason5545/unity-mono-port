// MT2 卡圖與卡名底板的兩個輸入（2026/10/17）：
// - AssetRipper 匯出的十六進位陣列把 ffffffff 寫成 ffffff/f，以前解成 16777215，MasterySpriteSelector 用 MasteryFrameType.None（−1）查不到 sprite，
//   把卡名底板（Nameplate）關掉。
// - Texture.width／height 以前只看同 guid 的 sprite，卡圖材質的貼圖拿到 0，AnimateCardEffects 的 UV 矩陣變 NaN。
import { describe, expect, it } from 'vitest';
import { decodeHexArray, type Ctx } from './core';
import { Texture_get_height, Texture_get_width } from './unityAssets';

describe('decodeHexArray', () => {
  it('ffffff/f 是 −1（MT2 SerializableDictionary 的 _keys：MasteryFrameType None～Prismatic）', () => {
    expect(decodeHexArray('ffffff/f0000000001000000020000000300000004000000', 'i32')).toEqual([-1, 0, 1, 2, 3, 4]);
    expect(decodeHexArray('ffffff/fffffff/f', 'i32')).toEqual([-1, -1]);
  });

  it('一般的十六進位照舊（小端序）', () => {
    expect(decodeHexArray('feffffff0a000000', 'i32')).toEqual([-2, 10]);
  });
});

describe('Texture.width／height', () => {
  const ctxWith = (render: Record<string, unknown>) => ({ w: { services: { render } } }) as unknown as Ctx;
  const tex = { guid: 'b23c7b6502b30ff4086284ff5881dd28', fileID: '2800000' };

  it('讀素材庫的貼圖寬高（卡圖的 972×1176），不是 sprite 的', () => {
    const c = ctxWith({ textureInfo: () => ({ width: 972, height: 1176 }), spriteInfo: () => ({ m_Rect: { x: 0, y: 0, width: 10, height: 20 } }) });
    expect(Texture_get_width(c, tex)).toBe(972);
    expect(Texture_get_height(c, tex)).toBe(1176);
  });

  it('素材庫沒有這張貼圖：退回同 guid 的 sprite（fileID 21300000）的 m_Rect', () => {
    const c = ctxWith({ textureInfo: () => null, spriteInfo: () => ({ m_Rect: { x: 0, y: 0, width: 64, height: 32 } }) });
    expect(Texture_get_width(c, tex)).toBe(64);
    expect(Texture_get_height(c, tex)).toBe(32);
  });

  it('執行期建的貼圖（new Texture2D）照自己的寬高', () => {
    const c = ctxWith({ textureInfo: () => ({ width: 1, height: 1 }), spriteInfo: () => null });
    expect(Texture_get_width(c, { $width: 8 } as never)).toBe(8);
  });
});

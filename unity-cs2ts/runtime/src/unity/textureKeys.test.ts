// 執行期子樹排進建置佇列時先讀貼圖（2026/10/17 Jason：第一次開新局，三張起始牌的開局畫面要等好幾秒）。
// 建網格照佇列一個一個來，以前讀貼圖也跟著排隊：62 個子樹 5.3 秒，地圖節點圖示每個等貼圖 260–400 ms。
// textureKeysIn 從元件資料找出要讀的貼圖：Sprite 的圖、Material 各貼圖屬性的圖、直接參照的 Texture。
import { describe, expect, it } from 'vitest';
import { textureKeysIn, type TextureKeyLookup } from './assets';

const db: TextureKeyLookup = {
  sprite: (r) => (r && 'guid' in r && r.guid === 'spriteGuid' ? { textureKey: 'atlasTex' } : null),
  material: (r) =>
    r && 'guid' in r && r.guid === 'matGuid'
      ? { record: { m_SavedProperties: { m_TexEnvs: { _MainTex: { m_Texture: { guid: 'mainTex', fileID: '2800000' }, m_Scale: { x: 1, y: 1 }, m_Offset: { x: 0, y: 0 } }, _Noise: { m_Texture: { fileID: '0' } as never, m_Scale: { x: 1, y: 1 }, m_Offset: { x: 0, y: 0 } } }, m_Floats: {}, m_Colors: {} } } }
      : null,
  hasTexture: (g) => ['atlasTex', 'mainTex', 'rawTex'].includes(g),
};

describe('textureKeysIn（元件資料參照到的貼圖）', () => {
  it('Image 的 sprite 與 material、RawImage 的 texture；沒有 guid 的空參照與不認得的資產略過', () => {
    const image = { type: 'MonoBehaviour', m_Sprite: { guid: 'spriteGuid', fileID: '21300000' }, m_Material: { guid: 'matGuid', fileID: '2100000' }, m_Color: { r: 1, g: 1, b: 1, a: 1 } };
    const raw = { m_Texture: { guid: 'rawTex', fileID: '2800000' }, m_Script: { guid: 'scriptGuid', fileID: '11500000' }, empty: { fileID: '0' } };
    expect([...textureKeysIn([image, raw], db)].sort()).toEqual(['atlasTex', 'mainTex', 'rawTex']);
  });

  it('巢狀的陣列與物件（粒子的材質清單）也找；自我參照不會無限走', () => {
    const cyc: Record<string, unknown> = { m_Materials: [{ guid: 'matGuid', fileID: '2100000' }] };
    cyc.self = cyc;
    expect([...textureKeysIn(cyc, db)]).toEqual(['mainTex']);
  });
});

// TMP_StyleSheet（2026/10/17）：MT2 的 TMP 3.x 樣式表匯出後 m_HashCode 是字串、m_OpeningTagArray 只剩前 10 個。
// 照 TMP_Style.RefreshStyle（TMP_Style.cs:97）由定義字串逐字算 tag 陣列。
import { describe, expect, it } from 'vitest';
import { StyleSheetData } from './assets';
import { getHashCode } from './utils';

const tags = (codes: number[]) => String.fromCharCode(...codes);

describe('StyleSheetData', () => {
  it('m_HashCode 是字串也查得到；tag 陣列用完整的定義字串，不用被截斷的匯出陣列', () => {
    const sheet = new StyleSheetData({
      m_StyleList: [
        {
          m_Name: 'Body',
          m_HashCode: '2451216',
          m_OpeningDefinition: '<color=#F2F0EF>',
          m_ClosingDefinition: '</color>',
          // 匯出的只有 "<color=#F2"
          m_OpeningTagArray: '3c000000630000006f0000006c0000006f000000720000003d000000230000004600000032000000',
          m_ClosingTagArray: '3c0000002f000000630000006f0000006c0000006f000000720000003e000000',
        },
      ],
    });
    expect(getHashCode('Body')).toBe(2451216);
    const body = sheet.getStyle(2451216)!;
    expect(body.name).toBe('Body');
    expect(tags(body.styleOpeningTagArray)).toBe('<color=#F2F0EF>');
    expect(tags(body.styleClosingTagArray)).toBe('</color>');
  });
  it('沒有定義字串時照舊讀匯出的 tag 陣列；沒有 Normal 就補一個空的', () => {
    const sheet = new StyleSheetData({ m_StyleList: [{ m_Name: 'X', m_HashCode: 88, m_OpeningTagArray: [60, 98, 62], m_ClosingTagArray: [] }] });
    expect(tags(sheet.getStyle(88)!.styleOpeningTagArray)).toBe('<b>');
    expect(sheet.getStyle(getHashCode('Normal'))!.styleOpeningTagArray).toEqual([]);
  });
});

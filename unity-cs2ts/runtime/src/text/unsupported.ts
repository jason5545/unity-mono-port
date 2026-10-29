// MarkupTag 列舉（TMP_RichTextTagsCommon.cs:10）裡沒有 case 分支的名稱，與原因。
// 規則：ValidateHtmlTag（TMP_Text.cs:6734–8337）／PopulateTextProcessingArray（TMP_Text.cs:2144）有處理的才配叫「有分支」；
// 這裡列的是其餘名稱。reason 寫清楚是原版就沒有、還是屬性級判斷、還是移植版不支援。

/** 列舉名稱 → 原因 */
export const UNSUPPORTED_MARKUP_TAGS: Record<string, string> = {
  // ── 標籤值／單位的 hash，不是標籤 ──
  NONE: '標籤值的 "none"（單位後綴的 hash），不是標籤',
  PLUS: '標籤值的 + 前綴（單位後綴的 hash），不是標籤',
  MINUS: '標籤值的 − 前綴（單位後綴的 hash），不是標籤',
  PX: '單位後綴 px 的 hash（TagUnitType.Pixels），不是標籤',
  PLUS_PX: '單位後綴 +px 的 hash，不是標籤',
  MINUS_PX: '單位後綴 −px 的 hash，不是標籤',
  EM: '單位後綴 em 的 hash（TagUnitType.FontUnits），不是標籤',
  PLUS_EM: '單位後綴 +em 的 hash，不是標籤',
  MINUS_EM: '單位後綴 −em 的 hash，不是標籤',
  PCT: '單位後綴 pct 的 hash，不是標籤',
  PLUS_PCT: '單位後綴 +pct 的 hash，不是標籤',
  MINUS_PCT: '單位後綴 −pct 的 hash，不是標籤',
  PERCENTAGE: '單位後綴 % 的 hash（TagUnitType.Percentage），不是標籤',
  PLUS_PERCENTAGE: '單位後綴 +% 的 hash，不是標籤',
  MINUS_PERCENTAGE: '單位後綴 −% 的 hash，不是標籤',
  TRUE: '布林值 true 的 hash（屬性值用），不是標籤',
  FALSE: '布林值 false 的 hash（屬性值用），不是標籤',
  // ── 內部標記 ──
  INVALID: '內部標記（無效標籤的 hash），不是標籤',
  NOTDEF: '.notdef glyph 名稱的 hash，不是標籤',
  // ── 樣式／字型查找用的名稱 hash ──
  NORMAL: '預設樣式 "Normal" 的 hash（TMP_StyleSheet），不是標籤',
  DEFAULT: '<font=default>／<material=default> 的值；在 FONT／MATERIAL 分支裡用 valueHashCode 判斷（TMP_Text.cs:7308、7406），不是獨立 case',
  REGULAR: '字型粗細名稱的 hash（<font-weight> 的值用），不是標籤',
  FAMILYNAME: '<font> 的屬性名（familyname），原版 ValidateHtmlTag 沒有處理（TMP 預留）',
  STYLENAME: '<font> 的屬性名（stylename），原版 ValidateHtmlTag 沒有處理（TMP 預留）',
  // ── 原版 pre.4 就沒有的標籤（ValidateHtmlTag 落到最後 return false，標籤無效） ──
  LIGA: '原版 pre.4 的 ValidateHtmlTag 沒有 <liga> 的 case（落到 return false）；連字符功能由 m_ActiveFontFeatures 控制（SetArraySizes 的 LIGATURES region）',
  SLASH_LIGA: '原版 pre.4 的 ValidateHtmlTag 沒有 </liga> 的 case（落到 return false）',
  FRAC: '原版 pre.4 的 ValidateHtmlTag 沒有 <frac> 的 case（落到 return false）',
  SLASH_FRAC: '原版 pre.4 的 ValidateHtmlTag 沒有 </frac> 的 case（落到 return false）',
  // ── 屬性名（在對應標籤的分支裡判斷，不是獨立 case） ──
  ANGLE: '<i angle=…> 的屬性名，在 ITALIC 分支裡判斷（TMP_Text.cs:6986）',
  HREF: '<a href=…> 的屬性名，在 A 分支裡判斷（TMP_Text.cs:7493）',
  DUOSPACE: '<mspace=… duospace=…> 的屬性名，在 MONOSPACE 分支裡判斷（TMP_Text.cs:7809）',
  // ── 沒有關閉分支的（原版的 switch 就沒有） ──
  SLASH_PAGE: '原版 ValidateHtmlTag 沒有 </page> 的 case（落到 return false）',
  SLASH_SPACE: '原版 ValidateHtmlTag 沒有 </space> 的 case（落到 return false）',
};

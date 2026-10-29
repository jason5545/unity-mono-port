// TMP 的列舉，值照 TMP_Text.cs、TMP_RichTextTagsCommon.cs、FontFeatureCommon.cs、TMP_TextProcessingCommon.cs。

/** TMP_Text.cs:74 */
export const enum HorizontalAlignmentOptions {
  Left = 0x1,
  Center = 0x2,
  Right = 0x4,
  Justified = 0x8,
  Flush = 0x10,
  Geometry = 0x20,
}

/** TMP_Text.cs:82 */
export const enum VerticalAlignmentOptions {
  Top = 0x100,
  Middle = 0x200,
  Bottom = 0x400,
  Baseline = 0x800,
  Geometry = 0x1000,
  Capline = 0x2000,
}

/** TMP_Text.cs:97 */
export const enum TmpTextElementType {
  Character = 0,
  Sprite = 1,
}

/** TMP_Text.cs:99 */
export const enum TextOverflowModes {
  Overflow = 0,
  Ellipsis = 1,
  Masking = 2,
  Truncate = 3,
  ScrollRect = 4,
  Page = 5,
  Linked = 6,
}

/** TMP_Text.cs:100 */
export const enum TextWrappingModes {
  NoWrap = 0,
  Normal = 1,
  PreserveWhitespace = 2,
  PreserveWhitespaceNoWrap = 3,
}

/** TMP_Text.cs:102 */
export const enum TextureMappingOptions {
  Character = 0,
  Line = 1,
  Paragraph = 2,
  MatchAspect = 3,
}

/** TMP_Text.cs:105 */
export const enum FontStyles {
  Normal = 0x0,
  Bold = 0x1,
  Italic = 0x2,
  Underline = 0x4,
  LowerCase = 0x8,
  UpperCase = 0x10,
  SmallCaps = 0x20,
  Strikethrough = 0x40,
  Superscript = 0x80,
  Subscript = 0x100,
  Highlight = 0x200,
}

/** TMP_Text.cs:106 */
export const enum FontWeight {
  Thin = 100,
  ExtraLight = 200,
  Light = 300,
  Regular = 400,
  Medium = 500,
  SemiBold = 600,
  Bold = 700,
  Heavy = 800,
  Black = 900,
}

/** UnityEngine.TextCore OTL_FeatureTag（FontFeatureCommon.cs:8）；元件序列化成 hex 字串（小端 uint） */
export const OTL_FeatureTag = {
  kern: 0x6b65726e | 0, // 'k'<<24|'e'<<16|'r'<<8|'n'
  liga: 0x6c696761 | 0,
  mark: 0x6d61726b | 0,
  mkmk: 0x6d6b6d6b | 0,
} as const;

/** 序列化的 m_ActiveFontFeatures（hex 字串，小端）→ OTL_FeatureTag 值清單 */
export function parseActiveFontFeatures(hex: unknown): number[] {
  if (typeof hex !== 'string' || hex.length === 0) return [];
  const out: number[] = [];
  for (let i = 0; i + 8 <= hex.length; i += 8) {
    const le = parseInt(hex.slice(i, i + 8), 16) >>> 0;
    // 小端 bytes → big-endian 組的 tag 值
    const v = ((le & 0xff) | ((le >> 8) & 0xff) << 8 | ((le >> 16) & 0xff) << 16 | (le >>> 24) << 24) | 0;
    out.push(v);
  }
  return out;
}

/** TMP_RichTextTagsCommon.cs:176 */
export const enum TagValueType {
  None = 0x0,
  NumericalValue = 0x1,
  StringValue = 0x2,
  ColorValue = 0x4,
}

/** TMP_RichTextTagsCommon.cs:184 */
export const enum TagUnitType {
  Pixels = 0x0,
  FontUnits = 0x1,
  Percentage = 0x2,
}

/** CodePoint（TMP_RichTextTagsCommon.cs:194） */
export const CodePoint = {
  SPACE: 0x20,
  DOUBLE_QUOTE: 0x22,
  NUMBER_SIGN: 0x23,
  PERCENTAGE: 0x25,
  PLUS: 0x2b,
  MINUS: 0x2d,
  PERIOD: 0x2e,
  HYPHEN_MINUS: 0x2d,
  SOFT_HYPHEN: 0xad,
  HYPHEN: 0x2010,
  NON_BREAKING_HYPHEN: 0x2011,
  ZERO_WIDTH_SPACE: 0x200b,
  RIGHT_SINGLE_QUOTATION: 0x2019,
  APOSTROPHE: 0x27,
  WORD_JOINER: 0x2060,
  HIGH_SURROGATE_START: 0xd800,
  HIGH_SURROGATE_END: 0xdbff,
  LOW_SURROGATE_START: 0xdc00,
  LOW_SURROGATE_END: 0xdfff,
  UNICODE_PLANE01_START: 0x10000,
} as const;

/** MarkupTag（TMP_RichTextTagsCommon.cs:10–171），值照原版 */
export const enum MarkupTag {
  BOLD = 66,
  SLASH_BOLD = 1613,
  ITALIC = 73,
  SLASH_ITALIC = 1606,
  UNDERLINE = 85,
  SLASH_UNDERLINE = 1626,
  STRIKETHROUGH = 83,
  SLASH_STRIKETHROUGH = 1628,
  MARK = 2699125,
  SLASH_MARK = 57644506,
  SUBSCRIPT = 92132,
  SLASH_SUBSCRIPT = 1770219,
  SUPERSCRIPT = 92150,
  SLASH_SUPERSCRIPT = 1770233,
  COLOR = 81999901,
  SLASH_COLOR = 1909026194,
  ALPHA = 75165780,
  A = 65,
  SLASH_A = 1614,
  SIZE = 3061285,
  SLASH_SIZE = 58429962,
  SPRITE = -991527447,
  NO_BREAK = 2856657,
  SLASH_NO_BREAK = 57477502,
  STYLE = 100252951,
  SLASH_STYLE = 1927738392,
  FONT = 2586451,
  SLASH_FONT = 57747708,
  SLASH_MATERIAL = -1100708252,
  LINK = 2656128,
  SLASH_LINK = 57686191,
  FONT_WEIGHT = -1889896162,
  SLASH_FONT_WEIGHT = -757976431,
  NO_PARSE = -408011596,
  SLASH_NO_PARSE = -294095813,
  POSITION = 85420,
  SLASH_POSITION = 1777699,
  VERTICAL_OFFSET = 1952379995,
  SLASH_VERTICAL_OFFSET = -11107948,
  SPACE = 100083556,
  SLASH_SPACE = 1927873067,
  PAGE = 2808691,
  SLASH_PAGE = 58683868,
  ALIGN = 75138797,
  SLASH_ALIGN = 1916026786,
  WIDTH = 105793766,
  SLASH_WIDTH = 1923459625,
  GRADIENT = -1999759898,
  SLASH_GRADIENT = -1854491959,
  CHARACTER_SPACE = -1584382009,
  SLASH_CHARACTER_SPACE = -1394426712,
  MONOSPACE = -1340221943,
  SLASH_MONOSPACE = -1638865562,
  CLASS = 82115566,
  INDENT = -1514123076,
  SLASH_INDENT = -1496889389,
  LINE_INDENT = -844305121,
  SLASH_LINE_INDENT = 93886352,
  MARGIN = -1355614050,
  SLASH_MARGIN = -1649644303,
  MARGIN_LEFT = -272933656,
  MARGIN_RIGHT = -447416589,
  LINE_HEIGHT = -799081892,
  SLASH_LINE_HEIGHT = 200452819,
  ACTION = -1827519330,
  SLASH_ACTION = -1187217679,
  SCALE = 100553336,
  SLASH_SCALE = 1928413879,
  ROTATE = -1000007783,
  SLASH_ROTATE = -764695562,
  TABLE = 226476955,
  SLASH_TABLE = -979118220,
  TH = 5862489,
  SLASH_TH = 193346070,
  TR = 5862467,
  SLASH_TR = 193346060,
  TD = 5862485,
  SLASH_TD = 193346074,
  LOWERCASE = -1506899689,
  SLASH_LOWERCASE = -1451284584,
  ALLCAPS = 218273952,
  SLASH_ALLCAPS = -797437649,
  UPPERCASE = -305409418,
  SLASH_UPPERCASE = -582368199,
  SMALLCAPS = -766062114,
  SLASH_SMALLCAPS = 199921873,
  LIGA = 2655971,
  SLASH_LIGA = 57686604,
  FRAC = 2598518,
  SLASH_FRAC = 57774681,
  NAME = 2875623,
  INDEX = 84268030,
  TINT = 2960519,
  ANIM = 2283339,
  MATERIAL = 825491659,
  HREF = 2535353,
  ANGLE = 75347905,
  PADDING = -2144568463,
  FAMILYNAME = 704251153,
  STYLENAME = -1207081936,
  DUOSPACE = 582810522,
  RED = 91635,
  GREEN = 87065851,
  BLUE = 2457214,
  YELLOW = -882444668,
  ORANGE = -1108587920,
  BLACK = 81074727,
  WHITE = 105680263,
  PURPLE = -1250222130,
  BR = 2256,
  CR = 2289,
  ZWSP = 3288238,
  ZWJ = 99623,
  NBSP = 2869039,
  SHY = 92674,
  LEFT = 2660507,
  RIGHT = 99937376,
  CENTER = -1591113269,
  JUSTIFIED = 817091359,
  FLUSH = 85552164,
  NONE = 2857034,
  PLUS = 43,
  MINUS = 45,
  PX = 2568,
  PLUS_PX = 49507,
  MINUS_PX = 47461,
  EM = 2216,
  PLUS_EM = 49091,
  MINUS_EM = 46789,
  PCT = 85031,
  PLUS_PCT = 1634348,
  MINUS_PCT = 1567082,
  PERCENTAGE = 37,
  PLUS_PERCENTAGE = 1454,
  MINUS_PERCENTAGE = 1512,
  TRUE = 2932022,
  FALSE = 85422813,
  INVALID = 1585415185,
  NOTDEF = 612146780,
  NORMAL = -1183493901,
  DEFAULT = -620974005,
  REGULAR = 1291372090,
}

/** TMP_TextProcessingCommon.cs:7 */
export const enum TextProcessingElementType {
  Undefined = 0x0,
  TextCharacterElement = 0x1,
  TextMarkupElement = 0x2,
}

/** TextProcessingElement（TMP_TextProcessingCommon.cs:161） */
export interface TextProcessingElement {
  elementType: TextProcessingElementType;
  stringIndex: number;
  length: number;
  unicode: number;
}

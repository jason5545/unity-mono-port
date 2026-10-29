// C# float／int／char 語義的 TS 對應。TMP 的排版全是 float32 運算，這裡用 Math.fround 在每個 C# 陳述式的結果上取回 float32。
// 對應 UnityEngine.Mathf、System.Char、TMPro_ExtensionMethods.cs、TMP_TextUtilities.cs 的 ToUpperFast。

export const f32 = (x: number): number => Math.fround(x);

export const INT16_MIN = -32768;

/** C# (int)float：往 0 截斷 */
export const intCast = (x: number): number => (x < 0 ? Math.ceil(x) : Math.floor(x)) | 0;

/** Mathf.RoundToInt：banker's rounding（中點取偶） */
export function roundToInt(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5 && Math.abs(r % 2) === 1) return r - Math.sign(x);
  return r;
}

export const ceilToInt = (x: number): number => Math.ceil(x);
export const floorToInt = (x: number): number => Math.floor(x);

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Mathf.Ceil（回傳 float） */
export const mceil = (x: number): number => f32(Math.ceil(x));

/** TMP_Math（TMPro_ExtensionMethods.cs:272） */
export const TMP_MATH = {
  FLOAT_MAX: 32767,
  FLOAT_MIN: -32767,
  INT_MAX: 2147483647,
  INT_MIN: -2147483647,
  FLOAT_UNSET: -32767,
  INT_UNSET: -32767,
};

export const k_LargePositiveFloat = TMP_MATH.FLOAT_MAX;
export const k_LargeNegativeFloat = TMP_MATH.FLOAT_MIN;
export const k_LargePositiveInt = TMP_MATH.INT_MAX;
export const k_LargeNegativeInt = TMP_MATH.INT_MIN;
export const k_LargePositiveVector2 = { x: TMP_MATH.INT_MAX, y: TMP_MATH.INT_MAX };
export const k_LargeNegativeVector2 = { x: TMP_MATH.INT_MIN, y: TMP_MATH.INT_MIN };

/** TMP_Math.Approximately（TMPro_ExtensionMethods.cs:285） */
export function tmpApproximately(a: number, b: number): boolean {
  return b - 0.0001 < a && a < b + 0.0001;
}

/** Mathf.NextPowerOfTwo */
export function nextPowerOfTwo(v: number): number {
  v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16;
  return v + 1;
}

// ───────── System.Char（以 UTF-16 單元為準，C# char 是 16-bit） ─────────

const reSpaceSeparator = /[\p{Zs}\p{Zl}\p{Zp}]/u;
const reControl = /\p{Cc}/u;
const reLetterOrDigit = /[\p{L}\p{N}]/u;
const rePunctuation = /\p{P}/u;
const reLower = /\p{Ll}/u;
const reUpper = /\p{Lu}/u;

const ch = (c: number): string => String.fromCharCode(c & 0xffff);

/** char.IsWhiteSpace：Zs/Zl/Zp 加上 0x09–0x0D、0x85（.NET 定義） */
export function charIsWhiteSpace(c: number): boolean {
  if (c >= 0x09 && c <= 0x0d) return true;
  if (c === 0x85) return true;
  return reSpaceSeparator.test(ch(c));
}

/** char.IsSeparator：Zs/Zl/Zp */
export function charIsSeparator(c: number): boolean {
  return reSpaceSeparator.test(ch(c));
}

/** char.IsControl：Cc */
export function charIsControl(c: number): boolean {
  return reControl.test(ch(c));
}

export function charIsLetterOrDigit(c: number): boolean {
  return reLetterOrDigit.test(ch(c));
}

export function charIsPunctuation(c: number): boolean {
  return rePunctuation.test(ch(c));
}

export function charIsLower(c: number): boolean {
  return reLower.test(ch(c));
}

export function charIsUpper(c: number): boolean {
  return reUpper.test(ch(c));
}

/** char.ToUpper（不變文化特性；simple 1:1 mapping） */
export function charToUpper(c: number): number {
  const s = ch(c);
  const u = s.toUpperCase();
  return u.length === 1 ? u.charCodeAt(0) : c & 0xffff;
}

export function charToLower(c: number): number {
  const s = ch(c);
  const l = s.toLowerCase();
  return l.length === 1 ? l.charCodeAt(0) : c & 0xffff;
}

// ───────── TMP_TextUtilities.ToUpperFast（TMP_TextUtilities.cs:2200）／TMP_TextParsingUtilities ─────────

/** k_lookupStringU（TMP_TextUtilities.cs:2183）；超出範圍回傳原字元 */
const k_lookupStringU = '-------------------------------- !-#$%&-()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[-]^_`ABCDEFGHIJKLMNOPQRSTUVWXYZ{|}~-';

export function toUpperFast(c: number): number {
  if (c > k_lookupStringU.length - 1) return c;
  return k_lookupStringU.charCodeAt(c);
}

/** TMP_TextParsingUtilities.GetHashCode（TMP_TextParsingUtilities.cs:29）：int32 溢位照 C#  wrap */
export function getHashCode(s: string): number {
  let hashCode = 0;
  for (let i = 0; i < s.length; i++) hashCode = (Math.imul(hashCode, 33) ^ toUpperFast(s.charCodeAt(i))) | 0;
  return hashCode;
}

export function getHashCodeCaseSensitive(s: string): number {
  let hashCode = 0;
  for (let i = 0; i < s.length; i++) hashCode = (Math.imul(hashCode, 33) ^ s.charCodeAt(i)) | 0;
  return hashCode;
}

/** TMP_TextParsingUtilities.ConvertToUTF32（TMP_TextParsingUtilities.cs:141） */
export function convertToUTF32(highSurrogate: number, lowSurrogate: number): number {
  return (highSurrogate - 0xd800) * 0x400 + (lowSurrogate - 0xdc00) + 0x10000;
}

/** TMP_TextParsingUtilities.IsDiacriticalMark（TMP_TextParsingUtilities.cs:151） */
export function isDiacriticalMark(c: number): boolean {
  return (c >= 0x300 && c <= 0x36f) || (c >= 0x1ab0 && c <= 0x1aff) || (c >= 0x1dc0 && c <= 0x1dff) || (c >= 0x20d0 && c <= 0x20ff) || (c >= 0xfe20 && c <= 0xfe2f);
}

/** TMP_TextParsingUtilities.IsBaseGlyph（TMP_TextParsingUtilities.cs:156） */
export function isBaseGlyph(c: number): boolean {
  return !(
    isDiacriticalMark(c) ||
    c === 0xe31 || (c >= 0xe34 && c <= 0xe3a) || (c >= 0xe47 && c <= 0xe4e) ||
    (c >= 0x591 && c <= 0x5bd) || c === 0x5bf || (c >= 0x5c1 && c <= 0x5c2) || (c >= 0x5c4 && c <= 0x5c5) || c === 0x5c7 ||
    (c >= 0x610 && c <= 0x61a) || (c >= 0x64b && c <= 0x65f) || c === 0x670 || (c >= 0x6d6 && c <= 0x6dc) || (c >= 0x6df && c <= 0x6e4) || (c >= 0x6e7 && c <= 0x6e8) || (c >= 0x6ea && c <= 0x6ed) ||
    (c >= 0x8d3 && c <= 0x8e1) || (c >= 0x8e3 && c <= 0x8ff) ||
    (c >= 0xfbb2 && c <= 0xfbc1)
  );
}

/** TMP_TextParsingUtilities.IsEmoji（TMP_TextParsingUtilities.cs:170） */
export function isEmoji(c: number): boolean {
  return (
    c === 0x200d || c === 0x203c || c === 0x2049 || c === 0x20e3 || c === 0x2122 || c === 0x2139 || (c >= 0x2194 && c <= 0x2199) || (c >= 0x21a9 && c <= 0x21aa) || (c >= 0x231a && c <= 0x231b) || c === 0x2328 || c === 0x2388 || c === 0x23cf || (c >= 0x23e9 && c <= 0x23f3) || (c >= 0x23f8 && c <= 0x23fa) || c === 0x24c2 || (c >= 0x25aa && c <= 0x25ab) || c === 0x25b6 || c === 0x25c0 || (c >= 0x25fb && c <= 0x25fe) || (c >= 0x2600 && c <= 0x2605) || (c >= 0x2607 && c <= 0x2612) || (c >= 0x2614 && c <= 0x2685) || (c >= 0x2690 && c <= 0x2705) || (c >= 0x2708 && c <= 0x2712) || c === 0x2714 || c === 0x2716 || c === 0x271d || c === 0x2721 || c === 0x2728 || (c >= 0x2733 && c <= 0x2734) || c === 0x2744 || c === 0x2747 || c === 0x274c || c === 0x274e || (c >= 0x2753 && c <= 0x2755) || c === 0x2757 || (c >= 0x2763 && c <= 0x2767) || (c >= 0x2795 && c <= 0x2797) || c === 0x27a1 || c === 0x27b0 || c === 0x27bf || (c >= 0x2934 && c <= 0x2935) || (c >= 0x2b05 && c <= 0x2b07) || (c >= 0x2b1b && c <= 0x2b1c) || c === 0x2b50 || c === 0x2b55 ||
    c === 0x3030 || c === 0x303d || c === 0x3297 || c === 0x3299 ||
    c === 0xfe0f ||
    (c >= 0x1f000 && c <= 0x1f0ff) || (c >= 0x1f10d && c <= 0x1f10f) || c === 0x1f12f || (c >= 0x1f16c && c <= 0x1f171) || (c >= 0x1f17e && c <= 0x1f17f) || c === 0x1f18e || (c >= 0x1f191 && c <= 0x1f19a) || (c >= 0x1f1ad && c <= 0x1f1ff) || (c >= 0x1f201 && c <= 0x1f20f) || c === 0x1f21a || c === 0x1f22f || (c >= 0x1f232 && c <= 0x1f23a) || (c >= 0x1f23c && c <= 0x1f23f) || (c >= 0x1f249 && c <= 0x1f53d) || (c >= 0x1f546 && c <= 0x1f64f) || (c >= 0x1f680 && c <= 0x1f6ff) || (c >= 0x1f774 && c <= 0x1f77f) || (c >= 0x1f7d5 && c <= 0x1f7ff) || (c >= 0x1f80c && c <= 0x1f80f) || (c >= 0x1f848 && c <= 0x1f84f) || (c >= 0x1f85a && c <= 0x1f85f) || (c >= 0x1f888 && c <= 0x1f88f) || (c >= 0x1f8ae && c <= 0x1f8ff) || (c >= 0x1f90c && c <= 0x1f93a) || (c >= 0x1f93c && c <= 0x1f945) || (c >= 0x1f947 && c <= 0x1faff) || (c >= 0x1fc00 && c <= 0x1fffd) ||
    (c >= 0xe0020 && c <= 0xe007f)
  );
}

/** TMP_TextParsingUtilities.IsHangul（TMP_TextParsingUtilities.cs:180） */
export function isHangul(c: number): boolean {
  return (c >= 0x1100 && c <= 0x11ff) || (c >= 0xa960 && c <= 0xa97f) || (c >= 0xd7b0 && c <= 0xd7ff) || (c >= 0x3130 && c <= 0x318f) || (c >= 0xffa0 && c <= 0xffdc) || (c >= 0xac00 && c <= 0xd7af);
}

/** TMP_TextParsingUtilities.IsCJK（TMP_TextParsingUtilities.cs:190） */
export function isCJK(c: number): boolean {
  return (c >= 0x3100 && c <= 0x312f) || (c >= 0x31a0 && c <= 0x31bf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2a6df) || (c >= 0x2a700 && c <= 0x2b73f) || (c >= 0x2b740 && c <= 0x2b81f) || (c >= 0x2b820 && c <= 0x2ceaf) || (c >= 0x2ceb0 && c <= 0x2ebe0) || (c >= 0x30000 && c <= 0x3134a) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f) || (c >= 0x2f00 && c <= 0x2fdf) || (c >= 0x2e80 && c <= 0x2eff) || (c >= 0x31c0 && c <= 0x31ef) || (c >= 0x2ff0 && c <= 0x2fff) || (c >= 0x3040 && c <= 0x309f) || (c >= 0x1b100 && c <= 0x1b12f) || (c >= 0x1aff0 && c <= 0x1afff) || (c >= 0x1b000 && c <= 0x1b0ff) || (c >= 0x1b130 && c <= 0x1b16f) || (c >= 0x3190 && c <= 0x319f) || (c >= 0x30a0 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xff65 && c <= 0xff9f);
}

// ───────── Color32（UnityEngine.Color32；byte 截斷照 C# (byte) 往 0 截斷再 mod 256） ─────────

export interface Color32 {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const color32 = (r: number, g: number, b: number, a: number): Color32 => ({ r, g, b, a });
export const s_colorWhite: Color32 = { r: 255, g: 255, b: 255, a: 255 };

const byteCast = (v: number): number => (v < 0 ? Math.ceil(v) : Math.floor(v)) & 0xff;

/** TMPro_ExtensionMethods.Multiply（TMPro_ExtensionMethods.cs:128）：float32 運算 */
export function color32Multiply(c1: Color32, c2: Color32): Color32 {
  return {
    r: byteCast(f32(f32(f32(c1.r / 255) * f32(c2.r / 255)) * 255)),
    g: byteCast(f32(f32(f32(c1.g / 255) * f32(c2.g / 255)) * 255)),
    b: byteCast(f32(f32(f32(c1.b / 255) * f32(c2.b / 255)) * 255)),
    a: byteCast(f32(f32(f32(c1.a / 255) * f32(c2.a / 255)) * 255)),
  };
}

/** Color32.Compare（TMPro_ExtensionMethods.cs:106） */
export function color32Compare(a: Color32, b: Color32): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

/** UnityEngine.Color 隱式轉 Color32（UnityCsReference Color32.cs）：(byte)(Mathf.Clamp01(v) * 255)，float 相乘後往 0 截斷 */
export function colorToColor32(c: { r: number; g: number; b: number; a: number }): Color32 {
  return {
    r: byteCast(f32(clamp(f32(c.r), 0, 1) * 255)),
    g: byteCast(f32(clamp(f32(c.g), 0, 1) * 255)),
    b: byteCast(f32(clamp(f32(c.b), 0, 1) * 255)),
    a: byteCast(f32(clamp(f32(c.a), 0, 1) * 255)),
  };
}

/** Color32 → Color */
export function color32ToColor(c: Color32): { r: number; g: number; b: number; a: number } {
  return { r: f32(c.r / 255), g: f32(c.g / 255), b: f32(c.b / 255), a: f32(c.a / 255) };
}

/** TMPro_ExtensionMethods.GammaToLinear 的 byte 版本（TMPro_ExtensionMethods.cs:159） */
export function gammaToLinearByte(value: number): number {
  const v = f32(value / 255);
  if (v <= 0.04045) return byteCast(f32(f32(v / 12.92) * 255));
  if (v < 1.0) return byteCast(f32(Math.pow(f32((v + 0.055) / 1.055), 2.4) * 255));
  if (v === 1.0) return 255;
  return byteCast(f32(Math.pow(v, 2.2) * 255));
}

export function gammaToLinearColor32(c: Color32): Color32 {
  return { r: gammaToLinearByte(c.r), g: gammaToLinearByte(c.g), b: gammaToLinearByte(c.b), a: c.a };
}

/** Color32 * Color32（C# Color32 operator *：byte 各自相乘除以 255，截斷） */
export function color32Times(c1: Color32, c2: Color32): Color32 {
  return color32Multiply(c1, c2);
}

/** Color.MinAlpha（TMPro_ExtensionMethods.cs:180） */
export function colorMinAlpha(c1: Color32, c2: Color32): Color32 {
  const a = c1.a < c2.a ? c1.a : c2.a;
  return { r: c1.r, g: c1.g, b: c1.b, a };
}

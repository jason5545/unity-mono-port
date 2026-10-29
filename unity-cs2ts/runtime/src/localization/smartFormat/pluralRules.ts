// C#: UnityEngine.Localization.SmartFormat.Utilities/PluralRules.cs PluralRules
// 整張 IsoLangToDelegate 表照抄（含遊戲沒用到的語言），規則逐一對應 C# 的私有 delegate。
// value 是 C# decimal：遊戲傳入的值在 JS 安全整數範圍內（±2^53）運算結果與 decimal 完全一致；
// 超出這個範圍時 double 的精度與 decimal 不同（餘數、相等判斷會有出入）。Between 只認整數（value % 1 == 0）。

export type PluralRuleDelegate = (value: number, pluralCount: number) => number;

/** C#: PluralRules.Between（decimal 擴充方法：整數且在 [min, max]） */
function between(value: number, min: number, max: number): boolean {
  return value % 1 === 0 && value >= min && value <= max;
}

/** C#: PluralRules.Singular */
const Singular: PluralRuleDelegate = () => 0;

/** C#: PluralRules.DualOneOther */
const DualOneOther: PluralRuleDelegate = (n, c) => {
  switch (c) {
    case 2:
      return n === 1 ? 0 : 1;
    case 3:
      return n === 0 ? 0 : n === 1 ? 1 : 2;
    case 4:
      return n < 0 ? 0 : n === 0 ? 1 : n === 1 ? 2 : 3;
    default:
      return -1;
  }
};

/** C#: PluralRules.DualWithZero */
const DualWithZero: PluralRuleDelegate = (n) => (n !== 0 && n !== 1 ? 1 : 0);

/** C#: PluralRules.DualFromZeroToTwo */
const DualFromZeroToTwo: PluralRuleDelegate = (n) => (n !== 0 && n !== 1 ? 1 : 0);

/** C#: PluralRules.TripleOneTwoOther */
const TripleOneTwoOther: PluralRuleDelegate = (n) => (n !== 1 ? (n === 2 ? 1 : 2) : 0);

/** C#: PluralRules.RussianSerboCroatian */
const RussianSerboCroatian: PluralRuleDelegate = (n) => (n % 10 !== 1 || !(n % 100 !== 11) ? (between(n % 10, 2, 4) && !between(n % 100, 12, 14) ? 1 : 2) : 0);

/** C#: PluralRules.Arabic */
const Arabic: PluralRuleDelegate = (n) => (n !== 0 ? (n === 1 ? 1 : n !== 2 ? (!between(n % 100, 3, 10) ? (!between(n % 100, 11, 99) ? 5 : 4) : 3) : 2) : 0);

/** C#: PluralRules.Breton */
const Breton: PluralRuleDelegate = (n) => (n !== 0 ? (n === 1 ? 1 : n !== 2 ? (n !== 3 ? (n !== 6 ? 5 : 4) : 3) : 2) : 0);

/** C#: PluralRules.Czech */
const Czech: PluralRuleDelegate = (n) => (n !== 1 ? (between(n, 2, 4) ? 1 : 2) : 0);

/** C#: PluralRules.Welsh */
const Welsh: PluralRuleDelegate = (n) => (n !== 0 ? (n === 1 ? 1 : n !== 2 ? (n !== 3 ? (n !== 6 ? 5 : 4) : 3) : 2) : 0);

/** C#: PluralRules.Manx */
const Manx: PluralRuleDelegate = (n) => (!between(n % 10, 1, 2) && !(n % 20 === 0) ? 1 : 0);

/** C#: PluralRules.Langi */
const Langi: PluralRuleDelegate = (n) => (n !== 0 ? (n > 0 && n < 2 ? 1 : 2) : 0);

/** C#: PluralRules.Lithuanian */
const Lithuanian: PluralRuleDelegate = (n) => (n % 10 !== 1 || between(n % 100, 11, 19) ? (between(n % 10, 2, 9) && !between(n % 100, 11, 19) ? 1 : 2) : 0);

/** C#: PluralRules.Latvian */
const Latvian: PluralRuleDelegate = (n) => (n !== 0 ? (n % 10 === 1 && n % 100 !== 11 ? 1 : 2) : 0);

/** C#: PluralRules.Macedonian */
const Macedonian: PluralRuleDelegate = (n) => (n % 10 !== 1 || !(n !== 11) ? 1 : 0);

/** C#: PluralRules.Moldavian */
const Moldavian: PluralRuleDelegate = (n) => (n !== 1 ? (n === 0 || (n !== 1 && between(n % 100, 1, 19)) ? 1 : 2) : 0);

/** C#: PluralRules.Maltese */
const Maltese: PluralRuleDelegate = (n) => (n !== 1 ? (n === 0 || between(n % 100, 2, 10) ? 1 : !between(n % 100, 11, 19) ? 3 : 2) : 0);

/** C#: PluralRules.Polish */
const Polish: PluralRuleDelegate = (n) =>
  n !== 1 ? (between(n % 10, 2, 4) && !between(n % 100, 12, 14) ? 1 : !between(n % 10, 0, 1) && !between(n % 10, 5, 9) && !between(n % 100, 12, 14) ? 3 : 2) : 0;

/** C#: PluralRules.Romanian */
const Romanian: PluralRuleDelegate = (n) => (n !== 1 ? (n === 0 || between(n % 100, 1, 19) ? 1 : 2) : 0);

/** C#: PluralRules.Tachelhit */
const Tachelhit: PluralRuleDelegate = (n) => (!(n >= 0) || !(n <= 1) ? (between(n, 2, 10) ? 1 : 2) : 0);

/** C#: PluralRules.Slovak */
const Slovak: PluralRuleDelegate = (n) => (n !== 1 ? (between(n, 2, 4) ? 1 : 2) : 0);

/** C#: PluralRules.Slovenian */
const Slovenian: PluralRuleDelegate = (n) => (n % 100 !== 1 ? (n % 100 === 2 ? 1 : !between(n % 100, 3, 4) ? 3 : 2) : 0);

/** C#: PluralRules.CentralMoroccoTamazight */
const CentralMoroccoTamazight: PluralRuleDelegate = (n) => (!between(n, 0, 1) && !between(n, 11, 99) ? 1 : 0);

/** C#: PluralRules.IsoLangToDelegate（鍵與值的順序照 C# 字典初始化順序） */
export const IsoLangToDelegate: Record<string, PluralRuleDelegate> = {
  az: Singular,
  bm: Singular,
  bo: Singular,
  dz: Singular,
  fa: Singular,
  hu: Singular,
  id: Singular,
  ig: Singular,
  ii: Singular,
  ja: Singular,
  jv: Singular,
  ka: Singular,
  kde: Singular,
  kea: Singular,
  km: Singular,
  kn: Singular,
  ko: Singular,
  ms: Singular,
  my: Singular,
  root: Singular,
  sah: Singular,
  ses: Singular,
  sg: Singular,
  th: Singular,
  to: Singular,
  vi: Singular,
  wo: Singular,
  yo: Singular,
  zh: Singular,
  af: DualOneOther,
  bem: DualOneOther,
  bg: DualOneOther,
  bn: DualOneOther,
  brx: DualOneOther,
  ca: DualOneOther,
  cgg: DualOneOther,
  chr: DualOneOther,
  da: DualOneOther,
  de: DualOneOther,
  dv: DualOneOther,
  ee: DualOneOther,
  el: DualOneOther,
  en: DualOneOther,
  eo: DualOneOther,
  es: DualOneOther,
  et: DualOneOther,
  eu: DualOneOther,
  fi: DualOneOther,
  fo: DualOneOther,
  fur: DualOneOther,
  fy: DualOneOther,
  gl: DualOneOther,
  gsw: DualOneOther,
  gu: DualOneOther,
  ha: DualOneOther,
  haw: DualOneOther,
  he: DualOneOther,
  is: DualOneOther,
  it: DualOneOther,
  kk: DualOneOther,
  kl: DualOneOther,
  ku: DualOneOther,
  lb: DualOneOther,
  lg: DualOneOther,
  lo: DualOneOther,
  mas: DualOneOther,
  ml: DualOneOther,
  mn: DualOneOther,
  mr: DualOneOther,
  nah: DualOneOther,
  nb: DualOneOther,
  ne: DualOneOther,
  nl: DualOneOther,
  nn: DualOneOther,
  no: DualOneOther,
  nyn: DualOneOther,
  om: DualOneOther,
  or: DualOneOther,
  pa: DualOneOther,
  pap: DualOneOther,
  ps: DualOneOther,
  pt: DualOneOther,
  rm: DualOneOther,
  saq: DualOneOther,
  so: DualOneOther,
  sq: DualOneOther,
  ssy: DualOneOther,
  sw: DualOneOther,
  sv: DualOneOther,
  syr: DualOneOther,
  ta: DualOneOther,
  te: DualOneOther,
  tk: DualOneOther,
  tr: DualOneOther,
  ur: DualOneOther,
  wae: DualOneOther,
  xog: DualOneOther,
  zu: DualOneOther,
  ak: DualWithZero,
  am: DualWithZero,
  bh: DualWithZero,
  fil: DualWithZero,
  guw: DualWithZero,
  hi: DualWithZero,
  ln: DualWithZero,
  mg: DualWithZero,
  nso: DualWithZero,
  ti: DualWithZero,
  tl: DualWithZero,
  wa: DualWithZero,
  ff: DualFromZeroToTwo,
  fr: DualFromZeroToTwo,
  kab: DualFromZeroToTwo,
  ga: TripleOneTwoOther,
  iu: TripleOneTwoOther,
  ksh: TripleOneTwoOther,
  kw: TripleOneTwoOther,
  se: TripleOneTwoOther,
  sma: TripleOneTwoOther,
  smi: TripleOneTwoOther,
  smj: TripleOneTwoOther,
  smn: TripleOneTwoOther,
  sms: TripleOneTwoOther,
  be: RussianSerboCroatian,
  bs: RussianSerboCroatian,
  hr: RussianSerboCroatian,
  ru: RussianSerboCroatian,
  sh: RussianSerboCroatian,
  sr: RussianSerboCroatian,
  uk: RussianSerboCroatian,
  ar: Arabic,
  br: Breton,
  cs: Czech,
  cy: Welsh,
  gv: Manx,
  lag: Langi,
  lt: Lithuanian,
  lv: Latvian,
  mb: Macedonian,
  mo: Moldavian,
  mt: Maltese,
  pl: Polish,
  ro: Romanian,
  shi: Tachelhit,
  sk: Slovak,
  sl: Slovenian,
  tzm: CentralMoroccoTamazight,
};

/** C#: PluralRules.GetPluralRule */
export function GetPluralRule(twoLetterIsoLanguageName: string): PluralRuleDelegate {
  const rule = IsoLangToDelegate[twoLetterIsoLanguageName];
  if (rule === undefined) {
    throw new Error(`IsoLangToDelegate not found for ${twoLetterIsoLanguageName}`);
  }
  return rule;
}

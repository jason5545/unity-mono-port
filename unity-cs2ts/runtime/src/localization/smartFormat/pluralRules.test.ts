// PluralRules 的表格測試：期望值是照 C#（UnityEngine.Localization.SmartFormat.Utilities/PluralRules.cs）
// 手算後寫死的字面陣列，不是用移植的實作算的（自己對自己沒有意義）。
// n = 0..30 與 100..112，索引就是 n。
import { describe, expect, it } from 'vitest';
import { GetPluralRule, IsoLangToDelegate } from './pluralRules.ts';

const N = [...Array.from({ length: 31 }, (_, i) => i), ...Array.from({ length: 13 }, (_, i) => 100 + i)];

// C#: PluralRules.RussianSerboCroatian（第 176 行）：n%10==1 且 n%100!=11 → 0；
// n%10∈2..4 且 n%100∉12..14 → 1；否則 2。
const RU = [2, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2];

// C#: PluralRules.Polish（第 192 行）：n==1 → 0；n%10∈2..4 且 n%100∉12..14 → 1；
// n%10∉0..1 且 n%10∉5..9 且 n%100∉12..14 → 3；否則 2。（非負整數下第三支走不到）
const PL = [2, 0, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2];

// C#: PluralRules.DualFromZeroToTwo（第 140 行）：n==0 或 n==1 → 0；否則 1。
const FR = [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

// C#: PluralRules.DualOneOther（第 99 行）case 2：n==1 → 0；否則 1。
const EN2 = [1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];

// C#: PluralRules.DualOneOther case 3：n==0 → 0；n==1 → 1；否則 2。
const EN3 = [0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2];

// C#: PluralRules.DualOneOther case 4：n<0 → 0；n==0 → 1；n==1 → 2；否則 3。
const EN4 = [1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3];

// C#: PluralRules.Singular（第 97 行）：永遠 0。
const ZH = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

describe('PluralRules：表格值照 C# 手算', () => {
  it('ru（RussianSerboCroatian）對 n = 0..30、100..112', () => {
    const rule = GetPluralRule('ru');
    expect(N.map((n) => rule(n, 3))).toEqual(RU);
  });

  it('pl（Polish）對 n = 0..30、100..112', () => {
    const rule = GetPluralRule('pl');
    expect(N.map((n) => rule(n, 2))).toEqual(PL);
  });

  it('fr（DualFromZeroToTwo）對 n = 0..30、100..112', () => {
    const rule = GetPluralRule('fr');
    expect(N.map((n) => rule(n, 2))).toEqual(FR);
  });

  it('en 兩種（DualOneOther c=2）對 n = 0..30、100..112', () => {
    const rule = GetPluralRule('en');
    expect(N.map((n) => rule(n, 2))).toEqual(EN2);
  });

  it('en 三種（DualOneOther c=3）對 n = 0..30、100..112', () => {
    const rule = GetPluralRule('en');
    expect(N.map((n) => rule(n, 3))).toEqual(EN3);
  });

  it('en 四種（DualOneOther c=4）對 n = 0..30、100..112', () => {
    const rule = GetPluralRule('en');
    expect(N.map((n) => rule(n, 4))).toEqual(EN4);
  });

  it('zh（Singular）對 n = 0..30、100..112', () => {
    const rule = GetPluralRule('zh');
    expect(N.map((n) => rule(n, 2))).toEqual(ZH);
  });

  it('DualOneOther 對 c=5（不在 2..4）回 -1（C# default 分支）', () => {
    expect(GetPluralRule('en')(1, 5)).toBe(-1);
    expect(GetPluralRule('en')(0, 1)).toBe(-1);
  });

  it('IsoLangToDelegate 的表跟 C# 一樣大（147 個語言），沒有的語言丟 ArgumentException 對應的錯誤', () => {
    expect(Object.keys(IsoLangToDelegate).length).toBe(147);
    expect(() => GetPluralRule('zz')).toThrow('IsoLangToDelegate not found for zz');
    expect(GetPluralRule('zh')).toBe(GetPluralRule('zh'));
    expect(GetPluralRule('pt')).toBe(GetPluralRule('en'));
  });
});

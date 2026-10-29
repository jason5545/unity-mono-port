// C#: UnityEngine.Localization.SmartFormat.Extensions/DefaultSource.cs、DictionarySource.cs、
//     ValueTupleSource.cs、XmlSource.cs、ReflectionSource.cs、PersistentVariablesSource.cs。
// （ListFormatter 的 ISource 半邊在 formatters.ts。）
// 註冊順序照 settings.json 的 m_Sources：ListFormatter、PersistentVariablesSource、DictionarySource、
// ValueTupleSource、XmlSource、ReflectionSource、DefaultSource。
//
// 瀏覽器沒有的 C# 型別：XElement（XmlSource）、ValueTuple（ValueTupleSource）在這裡只有型別判斷，
// 永遠不會符合，行為與原版傳入這些型別之外的值一致。

import type { ISelectorInfo, ISource } from './interfaces.ts';
import type { Parser } from './parser.ts';
import { wrap, type CsValue } from './values.ts';
import type { IVariable, IVariableGroup } from './persistentVariables.ts';

/** C#: Extensions/DefaultSource.cs DefaultSource */
export class DefaultSource implements ISource {
  constructor(parser: Parser) {
    /** C#: DefaultSource.DefaultSource（ctor 調整 Parser 設定） */
    parser.AddOperators(',');
    parser.AddAdditionalSelectorChars('-');
  }

  /** C#: DefaultSource.TryEvaluateSelector */
  TryEvaluateSelector(selectorInfo: ISelectorInfo): boolean {
    const currentValue = selectorInfo.CurrentValue;
    const selectorText = selectorInfo.SelectorText;
    const originalArgs = selectorInfo.FormatDetails.OriginalArgs;
    const parsed = TryParseInt32(selectorText);
    if (parsed !== null) {
      const result = parsed;
      if (selectorInfo.SelectorIndex === 0 && result < originalArgs.length && selectorInfo.SelectorOperator === '') {
        if (result < 0) throw new Error(`Index was out of range (OriginalArgs[${result}])`);
        selectorInfo.Result = originalArgs[result];
        return true;
      }
      if (selectorInfo.SelectorOperator === ',') {
        if (selectorInfo.Placeholder !== null) selectorInfo.Placeholder.Alignment = result;
        selectorInfo.Result = currentValue;
        return true;
      }
    }
    return false;
  }
}

/** C#: System.Int32.TryParse（NumberStyles.Integer：前後空白、正負號、十進位，範圍 int32） */
export function TryParseInt32(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return null;
  if (n < -2147483648 || n > 2147483647) return null;
  return n;
}

/** C#: Extensions/DictionarySource.cs DictionarySource */
export class DictionarySource implements ISource {
  constructor(parser: Parser) {
    /** C#: DictionarySource.DictionarySource */
    parser.AddAlphanumericSelectors();
    parser.AddAdditionalSelectorChars('_');
    parser.AddOperators('.');
  }

  /** C#: DictionarySource.TryEvaluateSelector */
  TryEvaluateSelector(selectorInfo: ISelectorInfo): boolean {
    const currentValue = selectorInfo.CurrentValue;
    const selector = selectorInfo.SelectorText;
    const eq = selectorInfo.FormatDetails.Settings.getCaseSensitivityComparison();
    if (currentValue.kind === 'dict' && currentValue.nonGeneric) {
      for (const [key, value] of currentValue.entries) {
        if (eq(String(key), selector)) {
          selectorInfo.Result = value;
          return true;
        }
      }
    }
    if (currentValue.kind === 'dict') {
      // C# 的 FirstOrDefault(x => x.Key.Equals(...)).Value；找不到或值是 null 都回 false
      const hit = currentValue.entries.find(([key]) => eq(String(key), selector));
      const value: CsValue | undefined = hit?.[1];
      if (value !== undefined && value.kind !== 'null') {
        selectorInfo.Result = value;
        return true;
      }
    }
    return false;
  }
}

/** C#: Extensions/ValueTupleSource.cs ValueTupleSource（C# ValueTuple：瀏覽器沒有這個型別） */
export class ValueTupleSource implements ISource {
  constructor(_formatter: { SourceExtensions: ISource[] }) {
    /** C#: ValueTupleSource.ValueTupleSource */
  }

  /** C#: Utilities/TupleExtensions.cs TupleExtensions.IsValueTuple（永遠不會符合） */
  static IsValueTuple(_value: CsValue): boolean {
    return false;
  }

  /** C#: ValueTupleSource.TryEvaluateSelector */
  TryEvaluateSelector(selectorInfo: ISelectorInfo): boolean {
    if (!ValueTupleSource.IsValueTuple(selectorInfo.CurrentValue)) return false;
    return false;
  }
}

/** C#: Extensions/XmlSource.cs XmlSource（XElement：瀏覽器沒有這個型別） */
export class XmlSource implements ISource {
  constructor(parser: Parser) {
    /** C#: XmlSource.XmlSource */
    parser.AddAlphanumericSelectors();
    parser.AddAdditionalSelectorChars('_');
    parser.AddOperators('.');
  }

  /** C#: XmlSource.TryEvaluateSelector（currentValue is XElement） */
  TryEvaluateSelector(): boolean {
    return false;
  }
}

/** C#: Extensions/ReflectionSource.cs ReflectionSource（POCO 的欄位／屬性／無參數方法；
 *  TS 的物件就是屬性表，方法要沒有參數才會被呼叫） */
export class ReflectionSource implements ISource {
  private readonly typeCache = new Map<string, { kind: 'field' | 'method'; key: string } | null>();

  constructor(parser: Parser) {
    /** C#: ReflectionSource.ReflectionSource */
    parser.AddAlphanumericSelectors();
    parser.AddAdditionalSelectorChars('_');
    parser.AddOperators('.');
  }

  /** C#: ReflectionSource.TryEvaluateSelector */
  TryEvaluateSelector(selectorInfo: ISelectorInfo): boolean {
    const currentValue = selectorInfo.CurrentValue;
    const selector = selectorInfo.SelectorText;
    if (currentValue.kind === 'null') return false;
    if (currentValue.kind !== 'object') return false;
    const obj = currentValue.value as Record<string, unknown>;
    const eq = selectorInfo.FormatDetails.Settings.getCaseSensitivityComparison();
    const cacheKey = `${obj.constructor?.name ?? ''}\u0000${selector}`;
    const cached = this.typeCache.get(cacheKey);
    if (cached !== undefined) {
      if (cached === null) return false;
      const v = obj[cached.key];
      selectorInfo.Result = cached.kind === 'method' ? wrap((v as () => unknown).call(obj)) : wrap(v);
      return true;
    }
    for (const key of AllMemberNames(obj)) {
      if (!eq(key, selector)) continue;
      const v = obj[key];
      if (typeof v === 'function') {
        if ((v as { length: number }).length !== 0) continue;
        this.typeCache.set(cacheKey, { kind: 'method', key });
        selectorInfo.Result = wrap((v as () => unknown).call(obj));
        return true;
      }
      this.typeCache.set(cacheKey, { kind: 'field', key });
      selectorInfo.Result = wrap(v);
      return true;
    }
    this.typeCache.set(cacheKey, null);
    return false;
  }
}

/** C# 的欄位、靜態欄位、可讀屬性、無參數方法：TS 一律以 own／prototype 屬性名表示 */
function AllMemberNames(obj: object): string[] {
  const names = new Set<string>();
  for (let o: object | null = obj; o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key !== 'constructor') names.add(key);
    }
  }
  for (const key of Object.keys(obj)) names.add(key);
  return [...names];
}

/** C#: Extensions/PersistentVariablesSource.cs PersistentVariablesSource
 *  （IVariable／IVariableGroup 在 persistentVariables.ts；遊戲的全域 m_Groups 是空的，
 *  但 FormatCache.LocalVariables 會帶區域變數，查找順序照 TryEvaluateSelector 第 190 行） */
export type { IVariable, IVariableGroup };

export class PersistentVariablesSource implements ISource {
  private readonly groupLookup = new Map<string, IVariableGroup>();

  constructor(parser: Parser) {
    /** C#: PersistentVariablesSource.PersistentVariablesSource */
    parser.AddOperators('.');
  }

  /** C#: PersistentVariablesSource.Add */
  Add(name: string, group: IVariableGroup): void {
    if (!name) throw new Error('Name must not be null or empty.');
    if (group === null) throw new Error('group');
    this.groupLookup.set(name.replace(/\s+/g, '-'), group);
  }

  /** C#: PersistentVariablesSource.TryGetValue */
  TryGetValue(name: string): IVariableGroup | undefined {
    return this.groupLookup.get(name);
  }

  /** C#: PersistentVariablesSource.TryEvaluateSelector */
  TryEvaluateSelector(selectorInfo: ISelectorInfo): boolean {
    const selectorText = selectorInfo.SelectorText;
    const current = selectorInfo.CurrentValue;
    if (current.kind === 'object' && IsVariableGroup(current.value) && EvaluateLocalGroup(selectorInfo, current.value)) {
      return true;
    }
    const local = (selectorInfo.FormatDetails.FormatCache?.LocalVariables ?? null) as IVariableGroup | null;
    if (selectorInfo.SelectorOperator === '' && local !== null && EvaluateLocalGroup(selectorInfo, local)) {
      return true;
    }
    const hit = this.TryGetValue(selectorText);
    if (hit !== undefined) {
      selectorInfo.Result = wrap(hit);
      return true;
    }
    return false;
  }
}

/** C#: `is IVariableGroup` */
function IsVariableGroup(value: unknown): value is IVariableGroup {
  return typeof (value as IVariableGroup | null)?.TryGetValue === 'function';
}

/** C#: PersistentVariablesSource.EvaluateLocalGroup（第 209 行） */
function EvaluateLocalGroup(selectorInfo: ISelectorInfo, group: IVariableGroup): boolean {
  if (group === null) return false;
  const value = group.TryGetValue(selectorInfo.SelectorText);
  if (value !== undefined) {
    // C#: EvaluateLocalGroup 第 217-221 行：IVariableValueChanged 記進 FormatCache.VariableTriggers
    const formatCache = selectorInfo.FormatDetails.FormatCache;
    if (formatCache !== null && typeof (value as { AddValueChanged?: unknown }).AddValueChanged === 'function' && !formatCache.VariableTriggers.includes(value as never)) {
      formatCache.VariableTriggers.push(value as never);
    }
    selectorInfo.Result = value.GetSourceValue(selectorInfo);
    return true;
  }
  return false;
}

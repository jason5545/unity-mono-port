// C#: UnityEngine.Localization.SmartFormat.Extensions/ListFormatter.cs、PluralLocalizationFormatter.cs、
//     ConditionalFormatter.cs、TimeFormatter.cs、XElementFormatter.cs、ChooseFormatter.cs、
//     SubStringFormatter.cs、IsMatchFormatter.cs、DefaultFormatter.cs。
// （OrdinalFormatter 是遊戲自訂的，在 ordinalFormatter.ts。）
// 註冊順序照 settings.json 的 m_Formatters：ListFormatter、PluralLocalizationFormatter、ConditionalFormatter、
// TimeFormatter、XElementFormatter、ChooseFormatter、SubStringFormatter、IsMatchFormatter、OrdinalFormatter、
// DefaultFormatter。名字有寫明的（{a:p:…}）只會試名字含該名的 formatter（SmartFormatter.InvokeFormatterExtensions）。
//
// 瀏覽器沒有的 C# 型別：XElement（XElementFormatter）在這裡只有型別判斷，永遠不會符合。

import { FormattingException, type FormatDetails, type FormatProvider } from './formatting.ts';
import { FormatterBase, type IFormatterLiteralExtractor, type IFormattingInfo, type ISelectorInfo, type ISource } from './interfaces.ts';
import { FormatItemPool, type Format } from './parsing.ts';
import { GetPluralRule, type PluralRuleDelegate } from './pluralRules.ts';
import type { SmartSettings } from './settings.ts';
import { GetTimeTextInfo, SystemTime, TimeSpanUtility, parseTimeSpanFormatOptions, type TimeTextInfo } from './time.ts';
import {
  cs,
  isConvertibleNotDateTimeStringBool,
  isConvertibleNumeric,
  isEnumerableOfObject,
  isEnumerable,
  isFormattable,
  toDecimal,
  type CsValue,
} from './values.ts';

/** C#: Extensions/ListFormatter.cs ListFormatter 的靜態 CollectionIndex（list 索引的「index」選擇器用） */
let CollectionIndex = -1;

/** C#: Extensions/ListFormatter.cs ListFormatter（同時是 ISource 與 IFormatter） */
export class ListFormatter extends FormatterBase implements ISource, IFormatterLiteralExtractor {
  private readonly m_SmartSettings: SmartSettings;

  constructor(parser: { AddOperators(chars: string): void }, settings: SmartSettings) {
    super();
    /** C#: ListFormatter.ListFormatter */
    parser.AddOperators('[]()');
    this.m_SmartSettings = settings;
    this.Names = this.DefaultNames;
  }

  /** C#: ListFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['list', 'l', ''];
  }

  /** C#: ListFormatter.TryEvaluateSelector */
  TryEvaluateSelector(selectorInfo: ISelectorInfo): boolean {
    const currentValue = selectorInfo.CurrentValue;
    const selectorText = selectorInfo.SelectorText;
    if (currentValue.kind !== 'list') return false;
    const list = currentValue;
    const parsed = tryParseInt32(selectorText);
    if ((selectorInfo.SelectorIndex !== 0 || selectorInfo.SelectorOperator.length !== 0) && parsed !== null && parsed < list.items.length) {
      selectorInfo.Result = list.items[parsed];
      return true;
    }
    if (selectorText.toLowerCase() === 'index') {
      if (selectorInfo.SelectorIndex === 0) {
        selectorInfo.Result = cs.int(CollectionIndex);
        return true;
      }
      if (0 <= CollectionIndex && CollectionIndex < list.items.length) {
        selectorInfo.Result = list.items[CollectionIndex];
        return true;
      }
    }
    return false;
  }

  /** C#: ListFormatter.TryEvaluateFormat */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    const format = formattingInfo.Format;
    const currentValue = formattingInfo.CurrentValue;
    if (!isEnumerable(currentValue)) return false;
    if (currentValue.kind === 'string') return false;
    if (isFormattable(currentValue)) return false;
    if (format === null) return false;
    const list = format.Split('|', 4);
    if (list.Count < 2) return false;
    let itemFormat = list.At(0);
    const text = list.At(1).GetLiteralText();
    const text2 = list.Count >= 3 ? list.At(2).GetLiteralText() : text;
    const text3 = list.Count >= 4 ? list.At(3).GetLiteralText() : text2;
    if (!itemFormat.HasNested) {
      const wrapper = FormatItemPool.GetFormatNested(this.m_SmartSettings, itemFormat.baseString, itemFormat.startIndex, itemFormat.endIndex, true);
      wrapper.Items.push(FormatItemPool.GetPlaceholderWithFormat(this.m_SmartSettings, wrapper, itemFormat.startIndex, 0, itemFormat, itemFormat.endIndex));
      itemFormat = wrapper;
    }
    // C#：ICollection 拿不到就先攤平 IEnumerable；Dictionary 的項目是 DictionaryEntry（Key／Value）
    let items: CsValue[];
    if (currentValue.kind === 'list') {
      items = currentValue.items;
    } else if (currentValue.kind === 'dict') {
      items = currentValue.entries.map(([k, v]) => cs.object({ Key: cs.string(k), Value: v }));
    } else {
      items = [currentValue];
    }
    const collectionCount = items.length;
    const saved = CollectionIndex;
    CollectionIndex = -1;
    for (const item of items) {
      CollectionIndex++;
      if (CollectionIndex !== 0) {
        if (CollectionIndex < collectionCount - 1) formattingInfo.Write(text);
        else if (CollectionIndex === 1) formattingInfo.Write(text3);
        else formattingInfo.Write(text2);
      }
      formattingInfo.WriteFormat(itemFormat, item);
    }
    CollectionIndex = saved;
    return true;
  }

  /** C#: ListFormatter.WriteAllLiterals */
  WriteAllLiterals(formattingInfo: IFormattingInfo): void {
    const format = formattingInfo.Format;
    if (format === null) return;
    const list = format.Split('|', 4);
    if (list.Count >= 2) {
      let itemFormat = list.At(0);
      for (let i = 0; i < Math.min(list.Count, 4); i++) formattingInfo.WriteFormat(list.At(i), cs.null());
      if (!itemFormat.HasNested) {
        const wrapper = FormatItemPool.GetFormatNested(this.m_SmartSettings, itemFormat.baseString, itemFormat.startIndex, itemFormat.endIndex, true);
        wrapper.Items.push(FormatItemPool.GetPlaceholderWithFormat(this.m_SmartSettings, wrapper, itemFormat.startIndex, 0, itemFormat, itemFormat.endIndex));
        itemFormat = wrapper;
      }
      formattingInfo.WriteFormat(itemFormat, cs.null());
    }
  }
}

/** C#: Extensions/PluralLocalizationFormatter.cs PluralLocalizationFormatter */
export class PluralLocalizationFormatter extends FormatterBase implements IFormatterLiteralExtractor {
  /** C#: PluralLocalizationFormatter.m_DefaultTwoLetterISOLanguageName */
  m_DefaultTwoLetterISOLanguageName = 'en';
  private m_DefaultPluralRule: PluralRuleDelegate | null = null;

  constructor() {
    super();
    /** C#: PluralLocalizationFormatter.PluralLocalizationFormatter（Names = DefaultNames） */
    this.Names = this.DefaultNames;
  }

  /** C#: PluralLocalizationFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['plural', 'p', ''];
  }

  /** C#: PluralLocalizationFormatter.TryEvaluateFormat */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    const format = formattingInfo.Format;
    const currentValue = formattingInfo.CurrentValue;
    if (format === null || format.baseString[format.startIndex] === ':') return false;
    const list = format.Split('|');
    if (list.Count === 1) return false;
    let value: number;
    if (isConvertibleNumeric(currentValue)) {
      value = toDecimal(currentValue);
    } else {
      if (!isEnumerableOfObject(currentValue)) return false;
      value = currentValue.items.length;
    }
    const pluralRule = this.GetPluralRule(formattingInfo);
    if (pluralRule === null) return false;
    const count = list.Count;
    const num = pluralRule(value, count);
    if (num < 0 || list.Count <= num) {
      throw new FormattingException(format, 'Invalid number of plural parameters', list.Last().endIndex);
    }
    const chosen = list.At(num);
    formattingInfo.WriteFormat(chosen, currentValue);
    return true;
  }

  /** C#: PluralLocalizationFormatter.GetPluralRule */
  protected GetPluralRule(formattingInfo: IFormattingInfo): PluralRuleDelegate | null {
    const formatterOptions = formattingInfo.FormatterOptions;
    if (formatterOptions.length !== 0) return GetPluralRule(formatterOptions);
    const provider: FormatProvider | null = formattingInfo.FormatDetails.Provider;
    if (provider?.CustomPluralRule) return provider.CustomPluralRule;
    if (provider) return GetPluralRule(TwoLetterISOLanguageName(provider.Code));
    return (this.m_DefaultPluralRule ??= GetPluralRule(this.m_DefaultTwoLetterISOLanguageName));
  }

  /** C#: PluralLocalizationFormatter.WriteAllLiterals */
  WriteAllLiterals(formattingInfo: IFormattingInfo): void {
    const format = formattingInfo.Format;
    if (format === null || format.baseString[format.startIndex] === ':') return;
    const list = format.Split('|');
    if (list.Count !== 1) {
      for (let i = 0; i < list.Count; i++) formattingInfo.WriteFormat(list.At(i), cs.null());
    }
  }
}

/** C#: Locale.Identifier.CultureInfo.TwoLetterISOLanguageName（zh-Hans、zh-Hant → zh；pt-BR → pt） */
export function TwoLetterISOLanguageName(code: string): string {
  const dash = code.indexOf('-');
  return dash === -1 ? code : code.slice(0, dash);
}

/** C#: Extensions/ConditionalFormatter.cs ConditionalFormatter */
export class ConditionalFormatter extends FormatterBase implements IFormatterLiteralExtractor {
  constructor() {
    super();
    /** C#: ConditionalFormatter.ConditionalFormatter（Names = DefaultNames） */
    this.Names = this.DefaultNames;
  }

  /** C#: ConditionalFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['conditional', 'cond', ''];
  }

  /** C#: ConditionalFormatter.TryEvaluateFormat */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    let format = formattingInfo.Format;
    const currentValue = formattingInfo.CurrentValue;
    if (format === null) return false;
    if (format.baseString[format.startIndex] === ':') format = format.Substring(1);
    const list = format.Split('|');
    if (list.Count === 1) return false;
    const convertible = isConvertibleNotDateTimeStringBool(currentValue);
    const num = convertible ? toDecimal(currentValue) : 0;
    if (convertible) {
      let i = -1;
      for (;;) {
        i++;
        if (i === list.Count) return true;
        const evaluated = TryEvaluateCondition(list.At(i), num);
        // C#：TryEvaluateCondition 失敗時第一個選項就跳出 while 改用索引挑，其他選項視為 conditionResult=true
        const conditionResult = evaluated === null ? (i === 0 ? null : true) : evaluated.conditionResult;
        if (conditionResult === null) break;
        if (conditionResult) {
          formattingInfo.WriteFormat(evaluated === null ? list.At(i) : evaluated.outputItem, currentValue);
          return true;
        }
      }
    }
    const count = list.Count;
    let index: number;
    if (convertible) {
      index = !(num < 0) ? Math.min(Math.floor(num), count - 1) : count - 1;
    } else if (currentValue.kind === 'bool') {
      index = !currentValue.value ? 1 : 0;
    } else if (currentValue.kind === 'datetime') {
      const today = SystemTime.nowTicks() / 864000000000n;
      const valueDay = currentValue.ticks / 864000000000n;
      if (count === 3 && valueDay === today) index = 1;
      else index = !(currentValue.ticks <= SystemTime.nowTicks()) ? count - 1 : 0;
    } else if (currentValue.kind === 'timespan') {
      if (count === 3 && currentValue.ticks === 0n) index = 1;
      else index = currentValue.ticks > 0 ? count - 1 : 0;
    } else if (currentValue.kind === 'string') {
      index = currentValue.value.length === 0 ? 1 : 0;
    } else {
      index = currentValue.kind === 'null' ? 1 : 0;
    }
    formattingInfo.WriteFormat(list.At(index), currentValue);
    return true;
  }

  /** C#: ConditionalFormatter.WriteAllLiterals */
  WriteAllLiterals(formattingInfo: IFormattingInfo): void {
    let format = formattingInfo.Format;
    if (format === null) return;
    if (format.baseString[format.startIndex] === ':') format = format.Substring(1);
    const list = format.Split('|');
    if (list.Count === 1) return;
    for (let i = 0; i < list.Count; i++) {
      let part = list.At(i);
      const evaluated = TryEvaluateCondition(part, 0);
      if (evaluated !== null) part = evaluated.outputItem;
      formattingInfo.WriteFormat(part, cs.null());
    }
  }
}

/** C#: ConditionalFormatter.TryEvaluateCondition（回傳 null 對應 C# 的 return false） */
function TryEvaluateCondition(parameter: Format, value: number): { conditionResult: boolean; outputItem: Format } | null {
  const text = parameter.baseString.slice(parameter.startIndex, parameter.endIndex);
  const match = ConditionalFormatterPattern.exec(text);
  if (match === null) return null;
  const body = match[0].slice(0, -1); // 去掉結尾的 '?'
  let conditionResult = false;
  let i = 0;
  for (const part of body.matchAll(/([&/]?)([<>=!]=?)([0-9.-]+)/g)) {
    const n = decimalParse(part[3]);
    let flag = false;
    switch (part[2]) {
      case '>':
        flag = value > n;
        break;
      case '<':
        flag = value < n;
        break;
      case '=':
      case '==':
        flag = value === n;
        break;
      case '<=':
        flag = value <= n;
        break;
      case '>=':
        flag = value >= n;
        break;
      case '!':
      case '!=':
        flag = value !== n;
        break;
    }
    if (i === 0) {
      conditionResult = flag;
    } else if (part[1] === '/') {
      conditionResult = conditionResult || flag;
    } else {
      conditionResult = conditionResult && flag;
    }
    i++;
  }
  return { conditionResult, outputItem: parameter.Substring(match[0].length) };
}

// C#: ConditionalFormatter._complexConditionPattern（^ (?: ([&/]?) ([<>=!]=?) ([0-9.-]+) )+ \?）
const ConditionalFormatterPattern = /^(?:([&/]?)([<>=!]=?)([0-9.-]+))+\?/;

/** C#: System.Decimal.Parse（"[0-9.-]+" 的字面值） */
function decimalParse(text: string): number {
  const n = Number(text);
  if (Number.isNaN(n)) throw new Error(`Input string was not in a correct format: "${text}"`);
  return n;
}

/** C#: Extensions/TimeFormatter.cs TimeFormatter */
export class TimeFormatter extends FormatterBase {
  /** C#: TimeFormatter.m_DefaultFormatOptions */
  m_DefaultFormatOptions: number = TimeSpanUtility.defaultFormatOptions;
  /** C#: TimeFormatter.m_DefaultTwoLetterIsoLanguageName */
  private m_DefaultTwoLetterIsoLanguageName = 'en';

  constructor() {
    super();
    /** C#: TimeFormatter.TimeFormatter（Names = DefaultNames） */
    this.Names = this.DefaultNames;
  }

  /** C#: TimeFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['timespan', 'time', 't', ''];
  }

  /** C#: TimeFormatter.DefaultFormatOptions */
  get DefaultFormatOptions(): number {
    return this.m_DefaultFormatOptions;
  }
  set DefaultFormatOptions(value: number) {
    this.m_DefaultFormatOptions = value;
  }

  /** C#: TimeFormatter.TryEvaluateFormat */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    const format = formattingInfo.Format;
    const currentValue = formattingInfo.CurrentValue;
    if (format !== null && format.HasNested) return false;
    const formatOptionsString = formattingInfo.FormatterOptions !== '' ? formattingInfo.FormatterOptions : format === null ? '' : format.GetLiteralText();
    let fromTime: bigint;
    if (currentValue.kind === 'timespan') {
      fromTime = currentValue.ticks;
    } else if (currentValue.kind === 'datetime') {
      if (formattingInfo.FormatterOptions === '') return false;
      fromTime = SystemTime.nowTicks() - currentValue.ticks;
    } else {
      return false;
    }
    const timeTextInfo = this.GetTimeTextInfo(formattingInfo.FormatDetails);
    if (timeTextInfo === null) return false;
    const options = parseTimeSpanFormatOptions(formatOptionsString);
    formattingInfo.Write(TimeSpanUtility.toTimeString(fromTime, options, timeTextInfo));
    return true;
  }

  /** C#: TimeFormatter.GetTimeTextInfo */
  private GetTimeTextInfo(formatDetails: FormatDetails): TimeTextInfo | null {
    const provider = formatDetails.Provider;
    if (provider === null) return GetTimeTextInfo(this.m_DefaultTwoLetterIsoLanguageName);
    if (provider.TimeTextInfo) return provider.TimeTextInfo;
    return GetTimeTextInfo(TwoLetterISOLanguageName(provider.Code));
  }
}

/** C#: Extensions/XElementFormatter.cs XElementFormatter（XElement：瀏覽器沒有這個型別） */
export class XElementFormatter extends FormatterBase {
  constructor() {
    super();
    /** C#: XElementFormatter.XElementFormatter（Names = DefaultNames） */
    this.Names = this.DefaultNames;
  }

  /** C#: XElementFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['xelement', 'xml', 'x', ''];
  }

  /** C#: XElementFormatter.TryEvaluateFormat（currentValue is XElement／IList<XElement>） */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    const format = formattingInfo.Format;
    if (format !== null && format.HasNested) return false;
    return false;
  }
}

/** C#: Extensions/ChooseFormatter.cs ChooseFormatter */
export class ChooseFormatter extends FormatterBase implements IFormatterLiteralExtractor {
  /** C#: ChooseFormatter.m_SplitChar */
  m_SplitChar = '|';

  constructor() {
    super();
    /** C#: ChooseFormatter.ChooseFormatter（Names = DefaultNames） */
    this.Names = this.DefaultNames;
  }

  /** C#: ChooseFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['choose', 'c'];
  }

  /** C#: ChooseFormatter.TryEvaluateFormat */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    if (formattingInfo.FormatterOptions === '') return false;
    const chooseOptions = formattingInfo.FormatterOptions.split(this.m_SplitChar);
    const list = formattingInfo.Format!.Split(this.m_SplitChar);
    if (list.Count < 2) return false;
    const format = DetermineChosenFormat(formattingInfo, list, chooseOptions);
    formattingInfo.WriteFormat(format, formattingInfo.CurrentValue);
    return true;
  }

  /** C#: ChooseFormatter.WriteAllLiterals */
  WriteAllLiterals(formattingInfo: IFormattingInfo): void {
    if (formattingInfo.FormatterOptions === '') return;
    const list = formattingInfo.Format!.Split(this.m_SplitChar);
    if (list.Count >= 2) {
      for (let i = 0; i < list.Count; i++) formattingInfo.WriteFormat(list.At(i), cs.null());
    }
  }
}

/** C#: ChooseFormatter.DetermineChosenFormat */
function DetermineChosenFormat(formattingInfo: IFormattingInfo, choiceFormats: { Count: number; At(i: number): Format }, chooseOptions: string[]): Format {
  const currentValue = formattingInfo.CurrentValue;
  const text = currentValue.kind === 'null' ? 'null' : valueToString(currentValue);
  const num = chooseOptions.indexOf(text);
  if (choiceFormats.Count < chooseOptions.length) {
    throw formattingInfo.FormattingException(`You must specify at least ${chooseOptions.length} choices`);
  }
  if (choiceFormats.Count > chooseOptions.length + 1) {
    throw formattingInfo.FormattingException(`You cannot specify more than ${chooseOptions.length + 1} choices`);
  }
  if (num === -1 && choiceFormats.Count === chooseOptions.length) {
    throw formattingInfo.FormattingException(`"${text}" is not a valid choice, and a "default" choice was not supplied`);
  }
  return choiceFormats.At(num === -1 ? choiceFormats.Count - 1 : num);
}

/** C#: Extensions/SubStringFormatter.cs SubStringFormatter */
export class SubStringFormatter extends FormatterBase {
  /** C#: SubStringFormatter.SubStringOutOfRangeBehavior */
  static readonly SubStringOutOfRangeBehavior = {
    ReturnEmptyString: 0,
    ReturnStartIndexToEndOfString: 1,
    ThrowException: 2,
  } as const;

  /** C#: SubStringFormatter.m_ParameterDelimiter */
  m_ParameterDelimiter = ',';
  /** C#: SubStringFormatter.m_NullDisplayString */
  m_NullDisplayString = '(null)';
  /** C#: SubStringFormatter.m_OutOfRangeBehavior */
  m_OutOfRangeBehavior = 0;

  constructor() {
    super();
    /** C#: SubStringFormatter.SubStringFormatter（Names = DefaultNames） */
    this.Names = this.DefaultNames;
  }

  /** C#: SubStringFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['substr'];
  }

  /** C#: SubStringFormatter.OutOfRangeBehavior */
  get OutOfRangeBehavior(): number {
    return this.m_OutOfRangeBehavior;
  }
  set OutOfRangeBehavior(value: number) {
    this.m_OutOfRangeBehavior = value;
  }

  /** C#: SubStringFormatter.TryEvaluateFormat */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    if (formattingInfo.FormatterOptions === '') return false;
    const array = formattingInfo.FormatterOptions.split(this.m_ParameterDelimiter);
    const source = formattingInfo.CurrentValue;
    if (source.kind === 'null') {
      formattingInfo.Write(this.m_NullDisplayString);
      return true;
    }
    const text = valueToString(source);
    let start = intParse(array[0]);
    let length = array.length > 1 ? intParse(array[1]) : 0;
    if (start < 0) start = text.length + start;
    if (start > text.length) start = text.length;
    if (length < 0) length = text.length - start + length;
    switch (this.m_OutOfRangeBehavior) {
      case SubStringFormatter.SubStringOutOfRangeBehavior.ReturnEmptyString:
        if (start + length > text.length) length = 0;
        break;
      case SubStringFormatter.SubStringOutOfRangeBehavior.ReturnStartIndexToEndOfString:
        if (start > text.length) start = text.length;
        if (start + length > text.length) length = text.length - start;
        break;
    }
    formattingInfo.Write(array.length > 1 ? text.slice(start, start + length) : text.slice(start));
    return true;
  }
}

/** C#: System.Int32.Parse */
function intParse(text: string): number {
  const n = tryParseInt32(text);
  if (n === null) throw new Error(`Input string was not in a correct format: "${text}"`);
  return n;
}

/** C#: Extensions/IsMatchFormatter.cs IsMatchFormatter */
export class IsMatchFormatter extends FormatterBase implements IFormatterLiteralExtractor {
  /** C#: IsMatchFormatter.RegexOptions */
  RegexOptions = 0;

  constructor() {
    super();
    /** C#: IsMatchFormatter.IsMatchFormatter（Names = DefaultNames） */
    this.Names = this.DefaultNames;
  }

  /** C#: IsMatchFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['ismatch'];
  }

  /** C#: IsMatchFormatter.TryEvaluateFormat */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    const formatterOptions = formattingInfo.FormatterOptions;
    const list = formattingInfo.Format!.Split('|');
    if (list.Count === 0) return true;
    if (list.Count !== 2) throw new Error('Exactly 2 format options are required.');
    const re = new RegExp(formatterOptions);
    if (re.test(valueToString(formattingInfo.CurrentValue))) {
      formattingInfo.WriteFormat(list.At(0), formattingInfo.CurrentValue);
    } else {
      formattingInfo.WriteFormat(list.At(1), formattingInfo.CurrentValue);
    }
    return true;
  }

  /** C#: IsMatchFormatter.WriteAllLiterals */
  WriteAllLiterals(formattingInfo: IFormattingInfo): void {
    const list = formattingInfo.Format!.Split('|');
    if (list.Count !== 0 && list.Count === 2) {
      formattingInfo.WriteFormat(list.At(0), formattingInfo.CurrentValue);
      formattingInfo.WriteFormat(list.At(1), formattingInfo.CurrentValue);
    }
  }
}

/** C#: Extensions/DefaultFormatter.cs DefaultFormatter */
export class DefaultFormatter extends FormatterBase {
  constructor() {
    super();
    /** C#: DefaultFormatter.DefaultFormatter（Names = DefaultNames） */
    this.Names = this.DefaultNames;
  }

  /** C#: DefaultFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['default', 'd', ''];
  }

  /** C#: DefaultFormatter.TryEvaluateFormat */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    const format = formattingInfo.Format;
    let obj = formattingInfo.CurrentValue;
    if (format !== null && format.HasNested) {
      formattingInfo.WriteFormat(format, obj);
      return true;
    }
    if (obj.kind === 'null') {
      obj = cs.string('');
    }
    // C# 的 ICustomFormatter 分支（provider.GetFormat(typeof(ICustomFormatter))）：Locale.Formatter
    // 對 CultureInfo 而言 GetFormat(ICustomFormatter) 是 null，遊戲走不到，這裡不移植（見回報）。
    let text: string;
    if (isFormattable(obj)) {
      const formatText = format?.toString();
      text = formattableToString(obj, formatText ?? null);
    } else {
      text = valueToString(obj);
    }
    if (formattingInfo.Alignment > 0) {
      const pad = formattingInfo.Alignment - text.length;
      if (pad > 0) formattingInfo.Write(' '.repeat(pad));
    }
    formattingInfo.Write(text);
    if (formattingInfo.Alignment < 0) {
      const pad = -formattingInfo.Alignment - text.length;
      if (pad > 0) formattingInfo.Write(' '.repeat(pad));
    }
    return true;
  }
}

/** C#: IFormattable.ToString(format, provider)（數值／DateTime／TimeSpan／Enum）。
 *  C# 的數值格式字串（F2、X…）這裡只支援「無格式」與整數十進位／十六進位，遊戲資料用不到其他格式。 */
export function formattableToString(v: CsValue, format: string | null): string {
  if (format !== null && /^x\d*$/i.test(format)) {
    const n = v.kind === 'long' ? Number(v.value) : toDecimal(v);
    return Math.trunc(n).toString(16).toUpperCase();
  }
  return valueToString(v);
}

/** C#: object.ToString() 的對應（非 IFormattable 也用得到） */
export function valueToString(v: CsValue): string {
  switch (v.kind) {
    case 'null':
      return '';
    case 'string':
      return v.value;
    case 'bool':
      return v.value ? 'True' : 'False';
    case 'int':
    case 'double':
    case 'decimal':
    case 'float':
      return String(v.value);
    case 'long':
      return String(v.value);
    case 'enum':
      return v.name;
    case 'datetime':
      return new Date(Number((v.ticks - 621355968000000000n) / 10000n)).toISOString();
    case 'timespan':
      return timespanToString(v.ticks);
    case 'list':
      return v.items.map(valueToString).join(', ');
    case 'dict':
      return v.entries.map(([k, x]) => `${k}=${valueToString(x)}`).join(', ');
    case 'object':
      return String(v.value);
  }
}

/** C#: TimeSpan.ToString() 的 [-][d.]hh:mm:ss.fffffff 形式（小數只在非零時顯示） */
function timespanToString(ticks: bigint): string {
  const neg = ticks < 0n;
  let t = neg ? -ticks : ticks;
  const days = t / 864000000000n;
  t %= 864000000000n;
  const hours = t / 360000000000n;
  t %= 360000000000n;
  const minutes = t / 6000000000n;
  t %= 6000000000n;
  const seconds = t / 100000000n;
  t %= 100000000n;
  const frac = t;
  const pad = (n: bigint, w: number) => String(n).padStart(w, '0');
  let out = neg ? '-' : '';
  if (days !== 0n) out += `${days}.`;
  out += `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}`;
  if (frac !== 0n) out += `.${String(frac).padStart(7, '0').replace(/0+$/, '')}`;
  return out;
}

/** C#: System.Int32.TryParse（供 ListFormatter／SubStringFormatter 用） */
function tryParseInt32(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isSafeInteger(n)) return null;
  if (n < -2147483648 || n > 2147483647) return null;
  return n;
}

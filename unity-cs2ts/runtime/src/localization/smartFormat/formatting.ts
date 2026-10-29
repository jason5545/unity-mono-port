// C#: UnityEngine.Localization.SmartFormat.Core.Formatting/FormattingInfo.cs、FormatDetails.cs、
//     FormattingException.cs、FormatCache.cs，以及 Core.Output/IOutput.cs、StringOutput.cs。
// IFormatProvider 在這個移植用 FormatProvider 介面表示：語言代碼 + GetFormat 的兩個掛鉤。
// 類別、屬性、方法名稱一律照 C#（PascalCase），方便對反編譯原始碼逐行核對。

import type { ISelectorInfo, IFormattingInfo } from './interfaces.ts';
import type { Format, FormatItem, Placeholder, Selector } from './parsing.ts';
import type { SmartSettings } from './settings.ts';
import type { SmartFormatter } from './smartFormatter.ts';
import type { CsValue } from './values.ts';
import type { IVariableGroup, IVariableValueChanged } from './persistentVariables.ts';
import type { PluralRuleDelegate } from './pluralRules.ts';
import type { TimeTextInfo } from './time.ts';

/** C#: System.IFormatProvider 的對應（StringTableEntry.GetLocalizedString 傳的 locale.Formatter） */
export interface FormatProvider {
  /** Locale.Identifier.Code，例如 'pt-BR'、'zh-Hans'；OrdinalFormatter 的 pt 判斷與複數規則的兩字母代碼都從這裡來 */
  Code: string;
  /** C#: provider.GetFormat(typeof(CustomPluralRuleProvider)) is CustomPluralRuleProvider */
  CustomPluralRule?: PluralRuleDelegate;
  /** C#: provider.GetFormat(typeof(TimeTextInfo)) is TimeTextInfo */
  TimeTextInfo?: TimeTextInfo;
}

/** C#: Core.Output/IOutput.cs IOutput */
export interface IOutput {
  Write(text: string, formattingInfo: IFormattingInfo): void;
  WriteRange(text: string, startIndex: number, length: number, formattingInfo: IFormattingInfo): void;
  Clear(): void;
  ToString(): string;
}

/** C#: Core.Output/StringOutput.cs StringOutput */
export class StringOutput implements IOutput {
  private readonly sb: string[] = [];

  Write(text: string): void {
    this.sb.push(text);
  }
  WriteRange(text: string, startIndex: number, length: number): void {
    this.sb.push(text.slice(startIndex, startIndex + length));
  }
  Clear(): void {
    this.sb.length = 0;
  }
  ToString(): string {
    return this.sb.join('');
  }
}

/** C#: Core.Formatting/FormatCache.cs FormatCache（LocalVariables 是區域變數的查找來源，
 *  由 GetLocalizedStringOperation 在格式化前後設成 null；VariableTriggers 記錄用到的
 *  IVariableValueChanged，StringChanged 自動刷新不在這個移植的範圍） */
export class FormatCache {
  Format: Format;
  /** C#: FormatCache.LocalVariables */
  LocalVariables: IVariableGroup | null = null;
  /** C#: FormatCache.VariableTriggers */
  readonly VariableTriggers: IVariableValueChanged[] = [];
  /** C#: FormatCache.Table（LocalizationTable）；這個移植只保留 LocaleIdentifier */
  Table: { LocaleIdentifier: string } | null = null;

  constructor(format: Format) {
    this.Format = format;
  }
}

/** C#: Core.Formatting/FormattingException.cs FormattingException */
export class FormattingException extends Error {
  /** C#: FormattingException.Format */
  readonly Format: string;
  /** C#: FormattingException.ErrorItem */
  readonly ErrorItem: FormatItem;
  /** C#: FormattingException.Issue */
  readonly Issue: string;
  /** C#: FormattingException.Index */
  readonly Index: number;

  constructor(errorItem: FormatItem, issueOrException: string | Error, index: number) {
    // 不給 super 訊息：Error 建構子寫入的 message 會蓋掉下面的 Message getter
    super();
    this.name = 'FormattingException';
    this.Format = errorItem.baseString;
    this.ErrorItem = errorItem;
    this.Issue = typeof issueOrException === 'string' ? issueOrException : issueOrException.message;
    this.Index = index;
  }

  /** C#: FormattingException.Message */
  override get message(): string {
    return `Error parsing format string: ${this.Issue} at ${this.Index}\n${this.Format}\n${'-'.repeat(Math.max(this.Index, 0))}^`;
  }
}

/** C#: Core.Formatting/FormatDetails.cs FormatDetails */
export class FormatDetails {
  Formatter!: SmartFormatter;
  OriginalFormat!: Format;
  OriginalArgs!: CsValue[];
  FormatCache: FormatCache | null = null;
  Provider: FormatProvider | null = null;
  Output!: IOutput;
  FormattingException: FormattingException | null = null;

  /** C#: FormatDetails.Settings */
  get Settings(): SmartSettings {
    return this.Formatter.Settings;
  }
}

/** C#: Core.Formatting/FormattingInfo.cs FormattingInfo */
export class FormattingInfo implements IFormattingInfo, ISelectorInfo {
  /** C#: FormattingInfo.Parent */
  Parent: FormattingInfo | null = null;
  /** C#: FormattingInfo.Selector */
  Selector: Selector | null = null;
  /** C#: FormattingInfo.FormatDetails */
  FormatDetails!: FormatDetails;
  /** C#: FormattingInfo.CurrentValue */
  CurrentValue!: CsValue;
  /** C#: FormattingInfo.Placeholder */
  Placeholder: Placeholder | null = null;
  /** C#: FormattingInfo.Format */
  Format: Format | null = null;
  /** C#: FormattingInfo.Children */
  readonly Children: FormattingInfo[] = [];
  /** C#: FormattingInfo.Result */
  Result: CsValue | null = null;

  /** C#: FormattingInfo.Init 的三個多載（FormatDetails 版把 parent 設成 null） */
  Init(formatDetails: FormatDetails, format: Format, currentValue: CsValue): void;
  Init(parent: FormattingInfo | null, formatDetails: FormatDetails, format: Format | null, currentValue: CsValue): void;
  Init(parent: FormattingInfo | null, formatDetails: FormatDetails, ph: Placeholder, currentValue: CsValue): void;
  Init(a: FormatDetails | FormattingInfo | null, b: Format | FormatDetails, c: Format | Placeholder | CsValue | null, d?: CsValue): void {
    this.Selector = null;
    this.Result = null;
    if (a instanceof FormatDetails) {
      this.Parent = null;
      this.CurrentValue = c as CsValue;
      this.Format = b as Format;
      this.FormatDetails = a;
      this.Placeholder = null;
      return;
    }
    this.Parent = a;
    this.FormatDetails = b as FormatDetails;
    this.CurrentValue = d!;
    const item = c as Format | Placeholder | null;
    if (item !== null && typeof item === 'object' && 'Selectors' in item) {
      const ph = item as Placeholder;
      this.Placeholder = ph;
      this.Format = ph.Format;
    } else {
      this.Placeholder = null;
      this.Format = item as Format | null;
    }
  }

  /** C#: FormattingInfo.Alignment */
  get Alignment(): number {
    return this.Placeholder?.Alignment ?? 0;
  }

  /** C#: FormattingInfo.FormatterOptions */
  get FormatterOptions(): string {
    return this.Placeholder?.FormatterOptions ?? '';
  }

  /** C#: FormattingInfo.SelectorText */
  get SelectorText(): string {
    return this.Selector!.RawText;
  }

  /** C#: FormattingInfo.SelectorIndex */
  get SelectorIndex(): number {
    return this.Selector!.SelectorIndex;
  }

  /** C#: FormattingInfo.SelectorOperator */
  get SelectorOperator(): string {
    return this.Selector!.Operator;
  }

  /** C#: FormattingInfo.Write(string) */
  Write(text: string): void {
    this.FormatDetails.Output.Write(text, this);
  }

  /** C#: FormattingInfo.Write(string, int, int) */
  WriteRange(text: string, startIndex: number, length: number): void {
    this.FormatDetails.Output.WriteRange(text, startIndex, length, this);
  }

  /** C#: FormattingInfo.Write(Format, object) */
  WriteFormat(format: Format, value: CsValue): void {
    const child = this.CreateChildFormat(format, value);
    this.FormatDetails.Formatter.Format(child);
  }

  /** C#: FormattingInfo.FormattingException */
  FormattingException(issue: string, problemItem: FormatItem | null = null, startIndex = -1): FormattingException {
    const item = problemItem ?? (this.Format as FormatItem);
    const index = startIndex === -1 ? item.startIndex : startIndex;
    return new FormattingException(item, issue, index);
  }

  /** C#: FormattingInfo.CreateChild(Format, object) */
  private CreateChildFormat(format: Format, currentValue: CsValue): FormattingInfo {
    const info = new FormattingInfo();
    info.Init(this, this.FormatDetails, format, currentValue);
    this.Children.push(info);
    return info;
  }

  /** C#: FormattingInfo.CreateChild(Placeholder) */
  CreateChildPlaceholder(ph: Placeholder): FormattingInfo {
    const info = new FormattingInfo();
    info.Init(this, this.FormatDetails, ph, this.CurrentValue);
    this.Children.push(info);
    return info;
  }
}

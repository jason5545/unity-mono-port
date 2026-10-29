// C#: UnityEngine.Localization.SmartFormat.Core.Extensions/ISelectorInfo.cs、IFormattingInfo.cs、
//     ISource.cs、IFormatter.cs、IFormatterLiteralExtractor.cs、FormatterBase.cs
// 介面成員名稱照 C#（PascalCase），方便對反編譯原始碼逐行核對。

import type { FormattingException, FormatDetails } from './formatting.ts';
import type { Format, FormatItem, Placeholder, Selector } from './parsing.ts';
import type { CsValue } from './values.ts';

/** C#: Core.Extensions/ISelectorInfo.cs ISelectorInfo */
export interface ISelectorInfo {
  readonly CurrentValue: CsValue;
  readonly SelectorText: string;
  readonly SelectorIndex: number;
  readonly SelectorOperator: string;
  Result: CsValue | null;
  readonly Placeholder: Placeholder | null;
  readonly FormatDetails: FormatDetails;
}

/** C#: Core.Extensions/IFormattingInfo.cs IFormattingInfo */
export interface IFormattingInfo {
  readonly CurrentValue: CsValue;
  readonly Format: Format | null;
  readonly Placeholder: Placeholder | null;
  readonly Alignment: number;
  readonly FormatterOptions: string;
  readonly FormatDetails: FormatDetails;
  Write(text: string): void;
  WriteRange(text: string, startIndex: number, length: number): void;
  WriteFormat(format: Format, value: CsValue): void;
  FormattingException(issue: string, problemItem?: FormatItem | null, startIndex?: number): FormattingException;
}

/** C#: Core.Extensions/ISource.cs ISource */
export interface ISource {
  TryEvaluateSelector(selectorInfo: ISelectorInfo): boolean;
}

/** C#: Core.Extensions/IFormatter.cs IFormatter */
export interface IFormatter {
  Names: string[];
  TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean;
}

/** C#: Core.Extensions/IFormatterLiteralExtractor.cs IFormatterLiteralExtractor */
export interface IFormatterLiteralExtractor {
  WriteAllLiterals(formattingInfo: IFormattingInfo): void;
}

/** C#: Core.Extensions/FormatterBase.cs FormatterBase */
export abstract class FormatterBase implements IFormatter {
  /** C#: FormatterBase.Names（C# 的 OnAfterDeserialize：沒給就是 DefaultNames；子類別 ctor 補上） */
  Names: string[] = [];

  /** C#: FormatterBase.DefaultNames */
  abstract get DefaultNames(): string[];

  /** C#: FormatterBase.TryEvaluateFormat */
  abstract TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean;
}

export type { Selector };

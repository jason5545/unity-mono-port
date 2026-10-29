// C#: UnityEngine.Localization.SmartFormat.Core.Parsing/Parser.cs Parser
// 遊戲的 Parser 設定（public/game/localization/settings.json 的 smartFormat.m_Parser）：
// m_OpeningBrace '{'、m_ClosingBrace '}'、m_AlphanumericSelectors 1、m_AllowedSelectorChars "_-"、
// m_Operators "[]().,"、m_AlternativeEscaping 0。呼叫端（SmartFormatter）在解析時會帶上全部 formatter 的
// 非空名稱，格式區開頭的名稱要真的存在才會被當成 FormatterName（Parser.FormatterNameExists）。

import { FormatItemPool, Format, ParsingErrors, Placeholder } from './parsing.ts';
import { ErrorAction, type SmartSettings } from './settings.ts';

/** C#: Parser.ParsingError */
export const ParsingError = {
  TooManyClosingBraces: 1,
  TrailingOperatorsInSelector: 2,
  InvalidCharactersInSelector: 3,
  MissingClosingBrace: 4,
} as const;
export type ParsingError = (typeof ParsingError)[keyof typeof ParsingError];

/** C#: Parser.ParsingErrorText（字典內容照 C#；注意無效字元用的也是 TrailingOperatorsInSelector 的字串） */
const ParsingErrorText: Record<number, string> = {
  [ParsingError.TooManyClosingBraces]: 'Format string has too many closing braces',
  [ParsingError.TrailingOperatorsInSelector]: 'There are trailing operators in the selector',
  [ParsingError.InvalidCharactersInSelector]: 'Invalid character in the selector',
  [ParsingError.MissingClosingBrace]: 'Format string is missing a closing brace',
};

export class Parser {
  /** C#: Parser.m_OpeningBrace */
  m_OpeningBrace = '{';
  /** C#: Parser.m_ClosingBrace */
  m_ClosingBrace = '}';
  /** C#: Parser.m_AlphanumericSelectors */
  m_AlphanumericSelectors = false;
  /** C#: Parser.m_AllowedSelectorChars */
  m_AllowedSelectorChars = '';
  /** C#: Parser.m_Operators */
  m_Operators = '';
  /** C#: Parser.m_AlternativeEscaping */
  m_AlternativeEscaping = false;
  /** C#: Parser.m_AlternativeEscapeChar */
  m_AlternativeEscapeChar = '\\';

  /** C#: Parser.m_Settings */
  readonly Settings: SmartSettings;

  constructor(settings: SmartSettings) {
    this.Settings = settings;
  }

  /** C#: Parser.AddAlphanumericSelectors */
  AddAlphanumericSelectors(): void {
    this.m_AlphanumericSelectors = true;
  }

  /** C#: Parser.AddAdditionalSelectorChars */
  AddAdditionalSelectorChars(chars: string): void {
    for (const value of chars) {
      if (!this.m_AllowedSelectorChars.includes(value)) this.m_AllowedSelectorChars += value;
    }
  }

  /** C#: Parser.AddOperators */
  AddOperators(chars: string): void {
    for (const value of chars) {
      if (!this.m_Operators.includes(value)) this.m_Operators += value;
    }
  }

  /** C#: Parser.UseAlternativeEscapeChar */
  UseAlternativeEscapeChar(alternativeEscapeChar = '\\'): void {
    this.m_AlternativeEscapeChar = alternativeEscapeChar;
    this.m_AlternativeEscaping = true;
  }

  /** C#: Parser.UseBraceEscaping */
  UseBraceEscaping(): void {
    this.m_AlternativeEscaping = false;
  }

  /** C#: Parser.UseAlternativeBraces */
  UseAlternativeBraces(opening: string, closing: string): void {
    this.m_OpeningBrace = opening;
    this.m_ClosingBrace = closing;
  }

  /** C#: Parser.ParseFormat */
  ParseFormat(format: string, formatterExtensionNames: string[]): Format {
    const result = FormatItemPool.GetFormat(this.Settings, format);
    let current = result;
    let ph: Placeholder | null = null;
    let formatterNameStart = -1;
    let optionsStart = -1;
    let optionsEnd = -1;
    const parsingErrors = new ParsingErrors();
    parsingErrors.Init(result);
    const openingBrace = this.m_OpeningBrace;
    const closingBrace = this.m_ClosingBrace;
    let nestedDepth = 0;
    let literalStart = 0;
    let operatorStart = 0;
    let selectorIndex = 0;
    for (let i = 0; i < format.length; i++) {
      const c = format[i];
      if (ph === null) {
        if (c === openingBrace) {
          if (i !== literalStart) current.Items.push(FormatItemPool.GetLiteralText(this.Settings, current, literalStart, i));
          literalStart = i + 1;
          if (!this.m_AlternativeEscaping) {
            const next = literalStart;
            if (next < format.length && format[next] === openingBrace) {
              i++;
              continue;
            }
          }
          nestedDepth++;
          ph = FormatItemPool.GetPlaceholder(this.Settings, current, i, nestedDepth);
          current.Items.push(ph);
          current.HasNested = true;
          operatorStart = i + 1;
          selectorIndex = 0;
          formatterNameStart = -1;
        } else if (c === closingBrace) {
          if (i !== literalStart) current.Items.push(FormatItemPool.GetLiteralText(this.Settings, current, literalStart, i));
          literalStart = i + 1;
          if (!this.m_AlternativeEscaping) {
            const next = literalStart;
            if (next < format.length && format[next] === closingBrace) {
              i++;
              continue;
            }
          }
          if (current.parent === null) {
            current.Items.push(FormatItemPool.GetLiteralText(this.Settings, current, i, i + 1));
            parsingErrors.AddIssue(ParsingErrorText[ParsingError.TooManyClosingBraces], i, i + 1);
            continue;
          }
          nestedDepth--;
          current.endIndex = i;
          current.parent.endIndex = i + 1;
          current = current.parent.Parent as Format;
          formatterNameStart = -1;
        } else if ((c === '\\' && this.Settings.convertCharacterStringLiterals) || (this.m_AlternativeEscaping && c === this.m_AlternativeEscapeChar)) {
          formatterNameStart = -1;
          const next = i + 1;
          if (next < format.length && (format[next] === openingBrace || format[next] === closingBrace)) {
            if (i !== literalStart) current.Items.push(FormatItemPool.GetLiteralText(this.Settings, current, literalStart, i));
            literalStart = i + 1;
            i++;
            continue;
          }
          if (i !== literalStart) current.Items.push(FormatItemPool.GetLiteralText(this.Settings, current, literalStart, i));
          literalStart = i + 1 >= format.length || format[i + 1] !== 'u' ? i + 2 : i + 6;
          if (literalStart > format.length) literalStart = format.length;
          current.Items.push(FormatItemPool.GetLiteralText(this.Settings, current, i, literalStart));
          i++;
        } else {
          if (formatterNameStart === -1) continue;
          switch (c) {
            case '(': {
              if (formatterNameStart === i) {
                formatterNameStart = -1;
              } else {
                optionsStart = i;
              }
              break;
            }
            case ')':
            case ':': {
              if (c === ')') {
                const hasOpen = optionsStart !== -1;
                const after = i + 1;
                const followedByDelimiter = after < format.length && (format[after] === ':' || format[after] === closingBrace);
                if (!hasOpen || !followedByDelimiter) {
                  formatterNameStart = -1;
                  break;
                }
                optionsEnd = i;
                if (format[after] === ':') i++;
              }
              const nameAtCursor = formatterNameStart === i;
              const openWithoutClose = optionsStart !== -1 && optionsEnd === -1;
              if (nameAtCursor || openWithoutClose) {
                formatterNameStart = -1;
                break;
              }
              literalStart = i + 1;
              const owner = current.parent!;
              if (optionsStart === -1) {
                const name = format.slice(formatterNameStart, i);
                if (FormatterNameExists(name, formatterExtensionNames)) {
                  owner.FormatterName = name;
                } else {
                  literalStart = current.startIndex;
                }
              } else {
                const name = format.slice(formatterNameStart, optionsStart);
                if (FormatterNameExists(name, formatterExtensionNames)) {
                  owner.FormatterName = name;
                  owner.FormatterOptions = format.slice(optionsStart + 1, optionsEnd);
                } else {
                  literalStart = current.startIndex;
                }
              }
              current.startIndex = literalStart;
              formatterNameStart = -1;
              break;
            }
          }
        }
      } else if (this.m_Operators.includes(c)) {
        if (i !== literalStart) {
          ph.Selectors.push(FormatItemPool.GetSelector(this.Settings, ph, format, literalStart, i, operatorStart, selectorIndex));
          selectorIndex++;
          operatorStart = i;
        }
        literalStart = i + 1;
      } else if (c === ':') {
        if (i !== literalStart) {
          ph.Selectors.push(FormatItemPool.GetSelector(this.Settings, ph, format, literalStart, i, operatorStart, selectorIndex));
        } else if (operatorStart !== i) {
          parsingErrors.AddIssue(`'0x${Hex(c)}': ${ParsingErrorText[ParsingError.TrailingOperatorsInSelector]}`, operatorStart, i);
        }
        literalStart = i + 1;
        ph.Format = FormatItemPool.GetFormatOf(this.Settings, ph, i + 1);
        current = ph.Format;
        ph = null;
        formatterNameStart = literalStart;
        optionsStart = -1;
        optionsEnd = -1;
      } else if (c === closingBrace) {
        if (i !== literalStart) {
          ph.Selectors.push(FormatItemPool.GetSelector(this.Settings, ph, format, literalStart, i, operatorStart, selectorIndex));
        } else if (operatorStart !== i) {
          parsingErrors.AddIssue(`'0x${Hex(c)}': ${ParsingErrorText[ParsingError.TrailingOperatorsInSelector]}`, operatorStart, i);
        }
        literalStart = i + 1;
        nestedDepth--;
        ph.endIndex = i + 1;
        current = ph.Parent as Format;
        ph = null;
      } else if (!IsSelectorChar(c, this)) {
        parsingErrors.AddIssue(`'0x${Hex(c)}': ${ParsingErrorText[ParsingError.TrailingOperatorsInSelector]}`, i, i + 1);
      }
    }
    if (current.parent !== null || ph !== null) {
      parsingErrors.AddIssue(ParsingErrorText[ParsingError.MissingClosingBrace], format.length, format.length);
      current.endIndex = format.length;
    } else if (literalStart !== format.length) {
      current.Items.push(FormatItemPool.GetLiteralText(this.Settings, current, literalStart, format.length));
    }
    while (current.parent !== null) {
      current = current.parent.Parent as Format;
      current.endIndex = format.length;
    }
    if (parsingErrors.HasIssues) {
      if (this.Settings.parseErrorAction === ErrorAction.ThrowError) throw parsingErrors;
      return this.HandleParsingErrors(parsingErrors, result);
    }
    return result;
  }

  /** C#: Parser.HandleParsingErrors */
  private HandleParsingErrors(parsingErrors: ParsingErrors, currentResult: Format): Format {
    switch (this.Settings.parseErrorAction) {
      case ErrorAction.ThrowError:
        throw parsingErrors;
      case ErrorAction.MaintainTokens: {
        for (let i = 0; i < currentResult.Items.length; i++) {
          const item = currentResult.Items[i];
          if (item instanceof Placeholder && parsingErrors.Issues.some((e) => e.Index >= item.startIndex && e.Index <= item.endIndex)) {
            currentResult.Items[i] = FormatItemPool.GetLiteralText(this.Settings, item.Format ?? FormatItemPool.GetFormat(this.Settings, item.baseString), item.startIndex, item.endIndex);
          }
        }
        return currentResult;
      }
      case ErrorAction.Ignore: {
        for (let i = 0; i < currentResult.Items.length; i++) {
          const item = currentResult.Items[i];
          if (item instanceof Placeholder && parsingErrors.Issues.some((e) => e.Index >= item.startIndex && e.Index <= item.endIndex)) {
            currentResult.Items[i] = FormatItemPool.GetLiteralText(this.Settings, item.Format ?? FormatItemPool.GetFormat(this.Settings, item.baseString), item.startIndex, item.startIndex);
          }
        }
        return currentResult;
      }
      case ErrorAction.OutputErrorInResult: {
        const format = FormatItemPool.GetFormatRange(this.Settings, parsingErrors.message, 0, parsingErrors.message.length);
        format.Items.push(FormatItemPool.GetLiteralTextFrom(this.Settings, format, 0));
        return format;
      }
      default:
        throw new Error(`Illegal type for ParsingErrors: ${String(this.Settings.parseErrorAction)}`);
    }
  }
}

/** C#: Parser.FormatterNameExists */
function FormatterNameExists(name: string, formatterExtensionNames: string[]): boolean {
  for (const n of formatterExtensionNames) {
    if (n === name) return true;
  }
  return false;
}

/** C#: Parser.ParseFormat 的選擇器字元檢查（digits／alphanumeric／AllowedSelectorChars） */
function IsSelectorChar(c: string, p: Parser): boolean {
  if (c >= '0' && c <= '9') return true;
  if (p.m_AlphanumericSelectors && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return true;
  return p.m_AllowedSelectorChars.includes(c);
}

/** C#: $"'0x{Convert.ToByte(c):X}'" */
function Hex(c: string): string {
  return (c.charCodeAt(0) & 0xff).toString(16).toUpperCase();
}

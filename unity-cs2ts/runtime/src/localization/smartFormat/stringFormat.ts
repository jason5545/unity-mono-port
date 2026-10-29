// C#: System.String.Format（mscorlib，不是 Localization 的 DLL；StringTableEntry.GetLocalizedString
// 對非 smart 項目且有參數時呼叫它，FormatException 會被包成「Ensure that the string is marked as Smart…」）。
// 這裡移植 composite formatting：{{ 與 }} 是跳脫、{index[,alignment][:formatString]}、
// 其他單獨的 { 或 } 一律 FormatException（與 .NET 的 StringBuilder.AppendFormatHelper 相同）。
// 數值的 formatString 只支援無格式與整數 X（十六進位），遊戲資料用不到其他 .NET 格式。

import type { FormatProvider } from './formatting.ts';
import { formattableToString, valueToString } from './formatters.ts';
import { isFormattable, type CsValue } from './values.ts';

/** C#: System.FormatException */
export class StringFormatException extends Error {
  readonly inner?: Error;

  constructor(message: string, inner?: Error) {
    super(message);
    this.name = 'FormatException';
    this.inner = inner;
  }
}

/** C#: String.Format(string, object[])（IFormatProvider 分支用 provider 取格式，這裡一致用 formattableToString） */
export function stringFormat(format: string, args: CsValue[], provider: FormatProvider | null = null): string {
  void provider;
  let out = '';
  let i = 0;
  const n = format.length;
  while (i < n) {
    const c = format[i];
    if (c === '{') {
      if (format[i + 1] === '{') {
        out += '{';
        i += 2;
        continue;
      }
      i++;
      let index = 0;
      let digits = 0;
      while (i < n && format[i] >= '0' && format[i] <= '9') {
        index = index * 10 + (format[i].charCodeAt(0) - 48);
        i++;
        digits++;
      }
      if (digits === 0) throw new StringFormatException('Input string was not in a correct format.');
      let alignment = 0;
      if (i < n && format[i] === ',') {
        i++;
        while (i < n && format[i] === ' ') i++;
        let sign = 1;
        if (i < n && (format[i] === '-' || format[i] === '+')) {
          sign = format[i] === '-' ? -1 : 1;
          i++;
        }
        let alignDigits = 0;
        while (i < n && format[i] >= '0' && format[i] <= '9') {
          alignment = alignment * 10 + (format[i].charCodeAt(0) - 48);
          i++;
          alignDigits++;
        }
        if (alignDigits === 0) throw new StringFormatException('Input string was not in a correct format.');
        alignment *= sign;
      }
      let formatText: string | null = null;
      if (i < n && format[i] === ':') {
        i++;
        let start = i;
        while (i < n && format[i] !== '}') i++;
        formatText = format.slice(start, i);
      }
      if (i >= n || format[i] !== '}') throw new StringFormatException('Input string was not in a correct format.');
      i++;
      if (index >= args.length) {
        throw new StringFormatException('Index (zero based) must be greater than or equal to zero and less than the size of the argument list.');
      }
      const value = args[index];
      let text = isFormattable(value) ? formattableToString(value, formatText) : valueToString(value);
      if (alignment > 0) {
        const pad = alignment - text.length;
        if (pad > 0) text = ' '.repeat(pad) + text;
      } else if (alignment < 0) {
        const pad = -alignment - text.length;
        if (pad > 0) text += ' '.repeat(pad);
      }
      out += text;
    } else if (c === '}') {
      if (format[i + 1] === '}') {
        out += '}';
        i += 2;
        continue;
      }
      throw new StringFormatException('Input string was not in a correct format.');
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** C#: StringTableEntry.GetLocalizedString 的 catch（FormatException）→ 包裝後重丟 */
export function wrapStringFormatError(value: string, ex: Error): Error {
  return new StringFormatException(
    `Input string was not in the correct format for String.Format. Ensure that the string is marked as Smart if you intended to use Smart Format.\n\`${value}\`\n${ex.message}`,
    ex,
  );
}

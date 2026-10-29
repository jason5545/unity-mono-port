// C#: reference/csharp/Utilities/OrdinalFormatter.cs OrdinalFormatter（遊戲自訂的 formatter，
// 對應 public/game/localization/settings.json 的 smartFormat.m_Formatters 裡 $type=OrdinalFormatter）。
// 原版讀 LocalizationSettings.SelectedLocale.Identifier.Code 判斷 pt；這個移植從格式化時傳入的語言取
// （FormatDetails.Provider.Code，與原版執行時的 SelectedLocale 相同）。Debug.LogWarning／LogError →
// console.warn／console.error，訊息字串照原樣。

import type { IFormattingInfo } from './interfaces.ts';
import { FormatterBase } from './interfaces.ts';
import { cs, csharpAbsInt, type CsValue } from './values.ts';

export class OrdinalFormatter extends FormatterBase {
  /** C#: OrdinalFormatter.DefaultNames */
  override get DefaultNames(): string[] {
    return ['ordinal'];
  }

  /** C#: OrdinalFormatter.TryEvaluateFormat */
  override TryEvaluateFormat(formattingInfo: IFormattingInfo): boolean {
    const currentValue: CsValue = formattingInfo.CurrentValue;
    if (currentValue.kind === 'int') {
      const value = currentValue.value;
      const code = formattingInfo.FormatDetails.Provider?.Code ?? '';
      if (code.startsWith('pt')) {
        let text = 'º';
        if (formattingInfo.FormatterOptions !== '') {
          const option = formattingInfo.FormatterOptions.trim().toLowerCase();
          switch (option) {
            case 'f':
            case 'female':
            case 'feminine':
              text = 'ª';
              break;
            case 'm':
            case 'male':
            case 'masculine':
              text = 'º';
              break;
            default:
              console.warn(`未知的性别选项 '${option}'，使用默认的阳性符号。`);
              break;
          }
        }
        formattingInfo.Write(text);
      } else {
        const num = csharpAbsInt(value);
        const num2 = num % 10;
        const num3 = num % 100;
        const text = num2 === 1 && num3 !== 11 ? 'st' : num2 === 2 && num3 !== 12 ? 'nd' : num2 !== 3 || num3 === 13 ? 'th' : 'rd';
        formattingInfo.Write(text);
      }
      return true;
    }
    console.error('OrdinalFormatter 只能用于整数类型的值。');
    return false;
  }
}

/** C#: Mathf.Abs(int)（int.MinValue 回傳 int.MinValue） */
export { csharpAbsInt, cs };

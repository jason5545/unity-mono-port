// C#: UnityEngine.Localization.SmartFormat.Core.Settings/SmartSettings.cs、ErrorAction.cs、CaseSensitivityType.cs
// 遊戲的設定值在 public/game/localization/settings.json 的 smartFormat.m_Settings：
// m_FormatErrorAction 0、m_ParseErrorAction 0（都是 ThrowError）、m_CaseSensitivity 0（CaseSensitive）、
// m_ConvertCharacterStringLiterals 1（true）。enum 的數值照 C# 宣告順序。

/** C#: Core.Settings/ErrorAction.cs */
export const ErrorAction = {
  ThrowError: 0,
  OutputErrorInResult: 1,
  Ignore: 2,
  MaintainTokens: 3,
} as const;
export type ErrorAction = (typeof ErrorAction)[keyof typeof ErrorAction];

/** C#: Core.Settings/CaseSensitivityType.cs */
export const CaseSensitivityType = {
  CaseSensitive: 0,
  CaseInsensitive: 1,
} as const;
export type CaseSensitivityType = (typeof CaseSensitivityType)[keyof typeof CaseSensitivityType];

/** C#: Core.Settings/SmartSettings.cs */
export class SmartSettings {
  formatErrorAction: ErrorAction = ErrorAction.ThrowError;
  parseErrorAction: ErrorAction = ErrorAction.ThrowError;
  caseSensitivity: CaseSensitivityType = CaseSensitivityType.CaseSensitive;
  convertCharacterStringLiterals = true;

  /** C#: SmartSettings.GetCaseSensitivityComparison（字串比較方式，DictionarySource／ReflectionSource 用） */
  getCaseSensitivityComparison(): (a: string, b: string) => boolean {
    switch (this.caseSensitivity) {
      case CaseSensitivityType.CaseSensitive:
        return (a, b) => a === b;
      case CaseSensitivityType.CaseInsensitive:
        return (a, b) => a.toLowerCase() === b.toLowerCase();
      default:
        throw new Error(`The case sensitivity type [${this.caseSensitivity}] is unknown.`);
    }
  }
}

/** settings.json 的 m_Settings（含 Parser 底下的另一份）→ SmartSettings */
export function smartSettingsFromJson(s: Record<string, unknown>): SmartSettings {
  const out = new SmartSettings();
  out.formatErrorAction = (s.m_FormatErrorAction as ErrorAction) ?? ErrorAction.ThrowError;
  out.parseErrorAction = (s.m_ParseErrorAction as ErrorAction) ?? ErrorAction.ThrowError;
  out.caseSensitivity = (s.m_CaseSensitivity as CaseSensitivityType) ?? CaseSensitivityType.CaseSensitive;
  out.convertCharacterStringLiterals = s.m_ConvertCharacterStringLiterals !== 0;
  return out;
}

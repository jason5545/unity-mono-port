// C#: UnityEngine.Localization.SmartFormat/Smart.cs Smart.CreateDefaultSmartFormat + Unity 對
// SmartFormatter 的序列化還原（settings.json 的 smartFormat 物件）。
// 遊戲的設定在 public/game/localization/settings.json：m_Sources 與 m_Formatters 的順序就是原版的
// 嘗試順序，這裡照那個順序建構與註冊（AddExtensions 是 InsertRange(0, …)，一次給齊順序才會一致）。

import { ChooseFormatter, ConditionalFormatter, DefaultFormatter, IsMatchFormatter, ListFormatter, PluralLocalizationFormatter, SubStringFormatter, TimeFormatter, XElementFormatter } from './formatters.ts';
import { OrdinalFormatter } from './ordinalFormatter.ts';
import { SmartFormatter } from './smartFormatter.ts';
import { smartSettingsFromJson } from './settings.ts';
import { DefaultSource, DictionarySource, PersistentVariablesSource, ReflectionSource, ValueTupleSource, XmlSource } from './sources.ts';
import type { IFormatter, ISource } from './interfaces.ts';

interface JsonPart {
  $type: string;
  m_Names?: string[];
  [key: string]: unknown;
}

/** settings.json 的 smartFormat 物件 → SmartFormatter（Parser 設定、10 個 Formatter、7 個 Source 全部就位） */
export function createSmartFormat(smartFormatJson: Record<string, unknown>): SmartFormatter {
  const settings = smartSettingsFromJson((smartFormatJson.m_Settings as Record<string, unknown>) ?? {});
  const formatter = new SmartFormatter(settings);
  const parserJson = smartFormatJson.m_Parser as Record<string, unknown>;
  if (parserJson) {
    const p = formatter.Parser;
    p.m_OpeningBrace = String.fromCharCode(Number(parserJson.m_OpeningBrace));
    p.m_ClosingBrace = String.fromCharCode(Number(parserJson.m_ClosingBrace));
    p.m_AlphanumericSelectors = parserJson.m_AlphanumericSelectors !== 0;
    p.m_AllowedSelectorChars = String(parserJson.m_AllowedSelectorChars);
    p.m_Operators = String(parserJson.m_Operators);
    p.m_AlternativeEscaping = parserJson.m_AlternativeEscaping !== 0;
    p.m_AlternativeEscapeChar = String.fromCharCode(Number(parserJson.m_AlternativeEscapeChar));
  }
  const sources = (smartFormatJson.m_Sources as JsonPart[]).map((s) => makeSource(s, formatter));
  formatter.AddSourceExtensions(...sources);
  const formatters = (smartFormatJson.m_Formatters as JsonPart[]).map((f) => makeFormatter(f, formatter));
  formatter.AddFormatterExtensions(...formatters);
  return formatter;
}

/** C#: 各 Source 的 ctor（會呼叫 Parser.Add…）＋序列化欄位還原 */
function makeSource(json: JsonPart, formatter: SmartFormatter): ISource {
  const parser = formatter.Parser;
  switch (json.$type) {
    case 'ListFormatter':
      return new ListFormatter(parser, formatter.Settings);
    case 'PersistentVariablesSource':
      return new PersistentVariablesSource(parser);
    case 'DictionarySource':
      return new DictionarySource(parser);
    case 'ValueTupleSource':
      return new ValueTupleSource(formatter);
    case 'XmlSource':
      return new XmlSource(parser);
    case 'ReflectionSource':
      return new ReflectionSource(parser);
    case 'DefaultSource':
      return new DefaultSource(parser);
    default:
      throw new Error(`不認得的 Source：${json.$type}`);
  }
}

/** C#: 各 Formatter 的 ctor ＋序列化欄位還原（m_Names 對應 FormatterBase.Names） */
function makeFormatter(json: JsonPart, formatter: SmartFormatter): IFormatter {
  let out: IFormatter;
  switch (json.$type) {
    case 'ListFormatter':
      out = new ListFormatter(formatter.Parser, formatter.Settings);
      break;
    case 'PluralLocalizationFormatter': {
      const f = new PluralLocalizationFormatter();
      if (typeof json.m_DefaultTwoLetterISOLanguageName === 'string') f.m_DefaultTwoLetterISOLanguageName = json.m_DefaultTwoLetterISOLanguageName;
      out = f;
      break;
    }
    case 'ConditionalFormatter':
      out = new ConditionalFormatter();
      break;
    case 'TimeFormatter': {
      const f = new TimeFormatter();
      if (json.m_DefaultFormatOptions !== undefined) f.DefaultFormatOptions = Number(json.m_DefaultFormatOptions);
      out = f;
      break;
    }
    case 'XElementFormatter':
      out = new XElementFormatter();
      break;
    case 'ChooseFormatter': {
      const f = new ChooseFormatter();
      if (json.m_SplitChar !== undefined) f.m_SplitChar = String.fromCharCode(Number(json.m_SplitChar));
      out = f;
      break;
    }
    case 'SubStringFormatter': {
      const f = new SubStringFormatter();
      if (json.m_ParameterDelimiter !== undefined) f.m_ParameterDelimiter = String.fromCharCode(Number(json.m_ParameterDelimiter));
      if (typeof json.m_NullDisplayString === 'string') f.m_NullDisplayString = json.m_NullDisplayString;
      if (json.m_OutOfRangeBehavior !== undefined) f.OutOfRangeBehavior = Number(json.m_OutOfRangeBehavior);
      out = f;
      break;
    }
    case 'IsMatchFormatter':
      out = new IsMatchFormatter();
      break;
    case 'OrdinalFormatter':
      out = new OrdinalFormatter();
      break;
    case 'DefaultFormatter':
      out = new DefaultFormatter();
      break;
    default:
      throw new Error(`不認得的 Formatter：${json.$type}`);
  }
  if (json.m_Names && json.m_Names.length > 0) out.Names = [...json.m_Names];
  return out;
}


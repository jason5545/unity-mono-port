// Unity Localization 的 SmartFormat 移植（對應 reference/decompiled/Unity.Localization/UnityEngine.Localization.SmartFormat*）。
// 各檔案的檔頭寫了它對應的 C# 路徑。值的型別表示法在 values.ts 的檔頭。

export { createSmartFormat } from './createSmartFormat.ts';
export { SmartFormatter } from './smartFormatter.ts';
export { Parser, ParsingError } from './parser.ts';
export {
  Format,
  FormatItem,
  FormatItemPool,
  LiteralText,
  ParsingErrors,
  ParsingIssue,
  Placeholder,
  Selector,
  SplitList,
} from './parsing.ts';
export {
  FormatCache,
  FormatDetails,
  FormattingException,
  FormattingInfo,
  StringOutput,
  type FormatProvider,
  type IOutput,
} from './formatting.ts';
export {
  CaseSensitivityType,
  ErrorAction,
  SmartSettings,
  smartSettingsFromJson,
} from './settings.ts';
export {
  FormatterBase,
  type IFormatter,
  type IFormatterLiteralExtractor,
  type IFormattingInfo,
  type ISelectorInfo,
  type ISource,
} from './interfaces.ts';
export { GetPluralRule, IsoLangToDelegate, type PluralRuleDelegate } from './pluralRules.ts';
export { OrdinalFormatter } from './ordinalFormatter.ts';
export {
  ChooseFormatter,
  ConditionalFormatter,
  DefaultFormatter,
  IsMatchFormatter,
  ListFormatter,
  PluralLocalizationFormatter,
  SubStringFormatter,
  TimeFormatter,
  TwoLetterISOLanguageName,
  XElementFormatter,
  formattableToString,
  valueToString,
} from './formatters.ts';
export {
  DefaultSource,
  DictionarySource,
  PersistentVariablesSource,
  ReflectionSource,
  ValueTupleSource,
  XmlSource,
} from './sources.ts';
export {
  BoolVariable,
  ByteVariable,
  DoubleVariable,
  FloatVariable,
  IntVariable,
  LongVariable,
  NestedVariablesGroup,
  ObjectVariable,
  ReplaceWhiteSpaces,
  SByteVariable,
  ShortVariable,
  StringVariable,
  UIntVariable,
  ULongVariable,
  UShortVariable,
  Variable,
  VariableNameValuePair,
  VariablesGroupAsset,
  type Action,
  type IMetadataVariable,
  type IVariable,
  type IVariableGroup,
  type IVariableValueChanged,
} from './persistentVariables.ts';
export { stringFormat, wrapStringFormatError, StringFormatException } from './stringFormat.ts';
export {
  cs,
  isCsValue,
  wrap,
  wrapAll,
  type CsValue,
} from './values.ts';
export {
  EnglishTimeTextInfo,
  GetTimeTextInfo,
  TimeSpanFormatOptions,
  TimeSpanUtility,
  type TimeTextInfo,
} from './time.ts';

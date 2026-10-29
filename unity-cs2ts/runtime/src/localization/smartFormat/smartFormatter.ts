// C#: UnityEngine.Localization.SmartFormat/SmartFormatter.cs SmartFormatter，
//     以及 Smart.cs Smart.CreateDefaultSmartFormat（組裝在 createSmartFormat.ts，照 settings.json）。
// UnityEngine.Pool 的物件池（FormatDetailsPool、FormattingInfoPool、StringOutputPool）在 TS 交給 GC。

import {
  FormattingException,
  FormatCache,
  FormatDetails,
  FormattingInfo,
  StringOutput,
  type FormatProvider,
} from './formatting.ts';
import type { IFormatter, ISource } from './interfaces.ts';
import { LiteralText, type Format, type FormatItem, type Placeholder, type Selector } from './parsing.ts';
import { Parser } from './parser.ts';
import { ErrorAction, SmartSettings } from './settings.ts';
import { cs, type CsValue } from './values.ts';

export class SmartFormatter {
  /** C#: SmartFormatter.m_Settings */
  Settings: SmartSettings;
  /** C#: SmartFormatter.m_Parser */
  Parser: Parser;
  /** C#: SmartFormatter.m_Sources */
  readonly SourceExtensions: ISource[] = [];
  /** C#: SmartFormatter.m_Formatters */
  readonly FormatterExtensions: IFormatter[] = [];
  private m_NotEmptyFormatterExtensionNames: string[] | null = null;

  constructor(settings: SmartSettings = new SmartSettings()) {
    this.Settings = settings;
    this.Parser = new Parser(settings);
  }

  /** C#: SmartFormatter.GetNotEmptyFormatterExtensionNames */
  GetNotEmptyFormatterExtensionNames(): string[] {
    if (this.m_NotEmptyFormatterExtensionNames !== null) return this.m_NotEmptyFormatterExtensionNames;
    const names: string[] = [];
    for (const formatter of this.FormatterExtensions) {
      for (const name of formatter.Names ?? []) {
        if (name !== '') names.push(name);
      }
    }
    this.m_NotEmptyFormatterExtensionNames = names;
    return names;
  }

  /** C#: SmartFormatter.AddExtensions(params ISource[])（InsertRange(0, …)：新來源排前面） */
  AddSourceExtensions(...sourceExtensions: ISource[]): void {
    this.SourceExtensions.unshift(...sourceExtensions);
  }

  /** C#: SmartFormatter.AddExtensions(params IFormatter[])（InsertRange(0, …)：新 formatter 排前面） */
  AddFormatterExtensions(...formatterExtensions: IFormatter[]): void {
    this.m_NotEmptyFormatterExtensionNames = null;
    this.FormatterExtensions.unshift(...formatterExtensions);
  }

  /** C#: SmartFormatter.Format 的多載：Format(IFormatProvider, IList<object>, string) 與 Format(FormattingInfo) */
  Format(formattingInfo: FormattingInfo): void;
  Format(provider: FormatProvider | null, args: CsValue[], format: string): string;
  Format(a: FormattingInfo | FormatProvider | null, b?: CsValue[], c?: string): string | void {
    if (a instanceof FormattingInfo) {
      this.FormatInfo(a);
      return;
    }
    const output = new StringOutput();
    const parsed = this.Parser.ParseFormat(c!, this.GetNotEmptyFormatterExtensionNames());
    const args = b ?? [];
    const current = args.length > 0 ? args[0] : cs.list(args);
    const formatDetails = this.makeFormatDetails(parsed, args, null, a, output);
    this.FormatRoot(formatDetails, parsed, current);
    return output.ToString();
  }

  /** C#: SmartFormatter.FormatWithCache(ref FormatCache, string, IFormatProvider, IList<object>)
   *  （cache 由呼叫端持有，TS 用回傳值更新） */
  FormatWithCache(cache: FormatCache | null, format: string, provider: FormatProvider | null, args: CsValue[]): { text: string; cache: FormatCache } {
    const output = new StringOutput();
    if (cache === null) cache = new FormatCache(this.Parser.ParseFormat(format, this.GetNotEmptyFormatterExtensionNames()));
    const current = args.length > 0 ? args[0] : cs.list(args);
    const formatDetails = this.makeFormatDetails(cache.Format, args, cache, provider, output);
    this.FormatRoot(formatDetails, cache.Format, current);
    return { text: output.ToString(), cache };
  }

  private makeFormatDetails(originalFormat: Format, originalArgs: CsValue[], formatCache: FormatCache | null, provider: FormatProvider | null, output: StringOutput): FormatDetails {
    const details = new FormatDetails();
    details.Formatter = this;
    details.OriginalFormat = originalFormat;
    details.OriginalArgs = originalArgs;
    details.FormatCache = formatCache;
    details.Provider = provider;
    details.Output = output;
    return details;
  }

  /** C#: SmartFormatter.Format(FormatDetails, Format, object) */
  private FormatRoot(formatDetails: FormatDetails, format: Format, current: CsValue): void {
    const formattingInfo = new FormattingInfo();
    formattingInfo.Init(formatDetails, format, current);
    this.Format(formattingInfo);
  }

  /** C#: SmartFormatter.Format(FormattingInfo) */
  private FormatInfo(formattingInfo: FormattingInfo): void {
    if (formattingInfo.Format === null) return;
    this.CheckForExtensions();
    for (const item of formattingInfo.Format.Items) {
      if (item instanceof LiteralText) {
        formattingInfo.Write(item.toString());
        continue;
      }
      const ph = item as Placeholder;
      const child = formattingInfo.CreateChildPlaceholder(ph);
      try {
        this.EvaluateSelectors(child);
      } catch (innerException) {
        const startIndex = ph.Format?.startIndex ?? ph.Selectors[ph.Selectors.length - 1].endIndex;
        this.FormatError(item, innerException as Error, startIndex, child);
        continue;
      }
      try {
        this.EvaluateFormatters(child);
      } catch (innerException) {
        const startIndex = ph.Format?.startIndex ?? ph.Selectors[ph.Selectors.length - 1].endIndex;
        this.FormatError(item, innerException as Error, startIndex, child);
      }
    }
  }

  /** C#: SmartFormatter.FormatError */
  private FormatError(errorItem: FormatItem, innerException: Error, startIndex: number, formattingInfo: FormattingInfo): void {
    switch (this.Settings.formatErrorAction) {
      case ErrorAction.Ignore:
        break;
      case ErrorAction.ThrowError:
        throw innerException instanceof FormattingException ? innerException : new FormattingException(errorItem, innerException, startIndex);
      case ErrorAction.OutputErrorInResult: {
        formattingInfo.FormatDetails.FormattingException = innerException instanceof FormattingException ? innerException : new FormattingException(errorItem, innerException, startIndex);
        formattingInfo.Write(innerException.message);
        formattingInfo.FormatDetails.FormattingException = null;
        break;
      }
      case ErrorAction.MaintainTokens:
        formattingInfo.Write(formattingInfo.Placeholder!.RawText);
        break;
    }
  }

  /** C#: SmartFormatter.CheckForExtensions */
  private CheckForExtensions(): void {
    if (this.SourceExtensions.length === 0) {
      throw new Error('No source extensions are available. Please add at least one source extension, such as the DefaultSource.');
    }
    if (this.FormatterExtensions.length === 0) {
      throw new Error('No formatter extensions are available. Please add at least one formatter extension, such as the DefaultFormatter.');
    }
  }

  /** C#: SmartFormatter.EvaluateSelectors */
  private EvaluateSelectors(formattingInfo: FormattingInfo): void {
    if (formattingInfo.Placeholder === null) return;
    let isFirstSelector = true;
    for (const selector of formattingInfo.Placeholder.Selectors) {
      formattingInfo.Selector = selector as Selector;
      formattingInfo.Result = null;
      let found = this.InvokeSourceExtensions(formattingInfo);
      if (found) formattingInfo.CurrentValue = formattingInfo.Result!;
      if (isFirstSelector) {
        isFirstSelector = false;
        let walk: FormattingInfo | null = formattingInfo;
        while (!found && walk.Parent !== null) {
          walk = walk.Parent;
          walk.Selector = selector as Selector;
          walk.Result = null;
          found = this.InvokeSourceExtensions(walk);
          if (found) formattingInfo.CurrentValue = walk.Result!;
        }
      }
      if (!found) {
        throw formattingInfo.FormattingException(`Could not evaluate the selector "${selector.RawText}"`, selector);
      }
    }
  }

  /** C#: SmartFormatter.InvokeSourceExtensions */
  private InvokeSourceExtensions(formattingInfo: FormattingInfo): boolean {
    for (const source of this.SourceExtensions) {
      if (source.TryEvaluateSelector(formattingInfo)) return true;
    }
    return false;
  }

  /** C#: SmartFormatter.EvaluateFormatters */
  private EvaluateFormatters(formattingInfo: FormattingInfo): void {
    if (!this.InvokeFormatterExtensions(formattingInfo)) {
      throw formattingInfo.FormattingException('No suitable Formatter could be found', formattingInfo.Format);
    }
  }

  /** C#: SmartFormatter.InvokeFormatterExtensions */
  private InvokeFormatterExtensions(formattingInfo: FormattingInfo): boolean {
    if (formattingInfo.Placeholder === null) return false;
    const formatterName = formattingInfo.Placeholder.FormatterName;
    for (const formatter of this.FormatterExtensions) {
      if (formatter.Names.includes(formatterName) && formatter.TryEvaluateFormat(formattingInfo)) return true;
    }
    return false;
  }
}

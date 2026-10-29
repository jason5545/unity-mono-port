// C#: UnityEngine.Localization.SmartFormat.Core.Parsing/FormatItem.cs、Format.cs、LiteralText.cs、
//     Placeholder.cs、Selector.cs、ParsingErrors.cs（Parser.cs 在 parser.ts）。
// UnityEngine.Pool 的物件池在 TS 交給 GC，FormatItemPool 只保留建構方法的對應。
// 成員名稱照 C#（FormatItem.ToString 在 TS 用 toString，讓字串轉換自動呼叫）。

import { SmartSettings } from './settings.ts';

/** C#: Core.Parsing/FormatItem.cs FormatItem */
export abstract class FormatItem {
  baseString = '';
  startIndex = 0;
  endIndex = 0;
  Parent: FormatItem | null = null;
  protected SmartSettings: SmartSettings | null = null;
  private m_RawText: string | null = null;

  /** C#: FormatItem.Init(SmartSettings, FormatItem, int) */
  Init(smartSettings: SmartSettings, parent: FormatItem, startIndex: number): void {
    this.InitBase(smartSettings, parent, parent.baseString, startIndex, parent.baseString.length);
  }

  /** C#: FormatItem.Init(SmartSettings, FormatItem, int, int) */
  InitRange(smartSettings: SmartSettings, parent: FormatItem, startIndex: number, endIndex: number): void {
    this.InitBase(smartSettings, parent, parent.baseString, startIndex, endIndex);
  }

  /** C#: FormatItem.Init(SmartSettings, FormatItem, string, int, int) */
  InitBase(smartSettings: SmartSettings, parent: FormatItem | null, baseString: string, startIndex: number, endIndex: number): void {
    this.Parent = parent;
    this.SmartSettings = smartSettings;
    this.baseString = baseString;
    this.startIndex = startIndex;
    this.endIndex = endIndex;
  }

  /** C#: FormatItem.Clear */
  Clear(): void {
    this.baseString = '';
    this.endIndex = 0;
    this.startIndex = 0;
    this.SmartSettings = null;
    this.m_RawText = null;
    this.Parent = null;
  }

  /** C#: FormatItem.RawText */
  get RawText(): string {
    if (this.m_RawText === null) {
      this.m_RawText = this.baseString.slice(this.startIndex, this.endIndex);
    }
    return this.m_RawText;
  }

  /** C#: FormatItem.ToString */
  toString(): string {
    if (this.endIndex > this.startIndex) {
      return this.RawText;
    }
    return `Empty (${this.baseString.slice(this.startIndex)})`;
  }
}

/** C#: Core.Parsing/LiteralText.cs LiteralText */
export class LiteralText extends FormatItem {
  /** C#: LiteralText.ToString（ConvertCharacterStringLiterals 時把跳脫字元轉成真的字元） */
  override toString(): string {
    if (!this.SmartSettings?.convertCharacterStringLiterals) return this.RawText;
    return this.ConvertCharacterLiteralsToUnicode();
  }

  /** C#: LiteralText.ConvertCharacterLiteralsToUnicode */
  private ConvertCharacterLiteralsToUnicode(): string {
    const raw = this.RawText;
    if (raw.length === 0) return raw;
    if (raw[0] !== '\\') return raw;
    if (raw.length < 2) throw new Error(`Missing escape sequence in literal: "${raw}"`);
    let c: string;
    switch (raw[1]) {
      case "'":
        c = "'";
        break;
      case '"':
        c = '"';
        break;
      case '\\':
        c = '\\';
        break;
      case '0':
        c = '\0';
        break;
      case 'a':
        c = '\x07';
        break;
      case 'b':
        c = '\b';
        break;
      case 'f':
        c = '\f';
        break;
      case 'n':
        c = '\n';
        break;
      case 'r':
        c = '\r';
        break;
      case 't':
        c = '\t';
        break;
      case 'v':
        c = '\v';
        break;
      case 'u': {
        const hex = raw.slice(2);
        if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`Failed to parse unicode escape sequence in literal: "${raw}"`);
        c = String.fromCharCode(parseInt(hex, 16));
        break;
      }
      default:
        throw new Error(`Unrecognized escape sequence in literal: "${raw}"`);
    }
    return c;
  }
}

/** C#: Core.Parsing/Selector.cs Selector */
export class Selector extends FormatItem {
  SelectorIndex = 0;
  operatorStart = 0;
  private m_Operator: string | null = null;

  /** C#: Selector.Operator */
  get Operator(): string {
    if (this.m_Operator === null) {
      this.m_Operator = this.baseString.slice(this.operatorStart, this.startIndex);
    }
    return this.m_Operator;
  }

  override Clear(): void {
    super.Clear();
    this.m_Operator = null;
  }
}

/** C#: Core.Parsing/Placeholder.cs Placeholder（類別名照 C#，就是「{…}」區塊） */
export class Placeholder extends FormatItem {
  NestedDepth = 0;
  readonly Selectors: Selector[] = [];
  Alignment = 0;
  FormatterName = '';
  FormatterOptions = '';
  Format: Format | null = null;

  /** C#: Placeholder.ToString */
  override toString(): string {
    let out = '{';
    for (const s of this.Selectors) out += s.baseString.slice(s.operatorStart, s.endIndex);
    if (this.Alignment !== 0) out += `,${this.Alignment}`;
    if (this.FormatterName !== '') {
      out += `:${this.FormatterName}`;
      if (this.FormatterOptions !== '') out += `(${this.FormatterOptions})`;
    }
    if (this.Format !== null) out += `:${this.Format.toString()}`;
    out += '}';
    return out;
  }
}

/** C#: Core.Parsing/Format.cs Format.SplitList（lazy 切割，索引對應以分隔字元切開的區段） */
export class SplitList {
  private m_Format: Format | null = null;
  private m_Splits: number[] = [];
  private readonly m_FormatCache: (Format | null)[] = [];

  /** C#: SplitList.this[int] */
  At(index: number): Format {
    const f = this.m_Format;
    if (f === null) throw new Error('SplitList not initialized');
    if (index > this.m_Splits.length) throw new Error('index');
    if (this.m_Splits.length === 0) return f;
    const cached = this.m_FormatCache[index];
    if (cached != null) return cached;
    let out: Format;
    if (index === 0) {
      out = f.Substring(0, this.m_Splits[0]);
    } else if (index === this.m_Splits.length) {
      out = f.Substring(this.m_Splits[index - 1] + 1);
    } else {
      const start = this.m_Splits[index - 1] + 1;
      out = f.Substring(start, this.m_Splits[index] - start);
    }
    this.m_FormatCache[index] = out;
    return out;
  }

  /** C#: SplitList.Count */
  get Count(): number {
    return this.m_Splits.length + 1;
  }

  /** C#: SplitList.Init */
  Init(format: Format, splits: number[]): void {
    this.m_Format = format;
    this.m_Splits = splits;
    this.m_FormatCache.length = 0;
    for (let i = 0; i < this.Count; i++) this.m_FormatCache.push(null);
  }

  /** C#: LINQ 的 list.Last()（IList 版走索引，不列舉） */
  Last(): Format {
    return this.At(this.Count - 1);
  }
}

/** C#: Core.Parsing/Format.cs Format */
export class Format extends FormatItem {
  /** C#: Format.parent（Format 自己的欄位；FormatItem.Parent 是另一個成員） */
  parent: Placeholder | null = null;
  /** C#: Format.Items */
  readonly Items: FormatItem[] = [];
  /** C#: Format.HasNested */
  HasNested = false;
  private splitCacheChar = '';
  private splitCache: SplitList | null = null;

  /** C#: Format.Substring(int) */
  Substring(startIndex: number): Format;
  /** C#: Format.Substring(int, int) */
  Substring(startIndex: number, length: number): Format;
  Substring(startIndex: number, length?: number): Format {
    const len = length ?? this.endIndex - this.startIndex - startIndex;
    const absStart = this.startIndex + startIndex;
    const absEnd = absStart + len;
    if (absStart < this.startIndex || absStart > this.endIndex) throw new Error('startIndex');
    if (absEnd > this.endIndex) throw new Error('length');
    if (absStart === this.startIndex && absEnd === this.endIndex) return this;
    const f = FormatItemPool.GetFormatRange(this.SmartSettings!, this.baseString, absStart, absEnd);
    for (const item of this.Items) {
      if (item.endIndex <= absStart) continue;
      if (absEnd <= item.startIndex) break;
      let out: FormatItem = item;
      if (item instanceof LiteralText) {
        if (absStart > item.startIndex || item.endIndex > absEnd) {
          out = FormatItemPool.GetLiteralText(this.SmartSettings!, f, Math.max(absStart, item.startIndex), Math.min(absEnd, item.endIndex));
        }
      } else {
        f.HasNested = true;
      }
      f.Items.push(out);
    }
    return f;
  }

  /** C#: Format.IndexOf(char) */
  IndexOf(search: string): number;
  /** C#: Format.IndexOf(char, int) */
  IndexOf(search: string, startIndex: number): number;
  IndexOf(search: string, startIndex = 0): number {
    let start = this.startIndex + startIndex;
    for (const item of this.Items) {
      if (item.endIndex >= start && item instanceof LiteralText) {
        if (start < item.startIndex) start = item.startIndex;
        const found = item.baseString.indexOf(search, start);
        if (found !== -1 && found < item.endIndex) return found - this.startIndex;
      }
    }
    return -1;
  }

  /** C#: Format.FindAll(char, int) */
  private FindAll(search: string, maxCount: number): number[] {
    const list: number[] = [];
    let pos = 0;
    while (maxCount !== 0) {
      pos = this.IndexOf(search, pos);
      if (pos === -1) break;
      list.push(pos);
      pos++;
      maxCount--;
    }
    return list;
  }

  /** C#: Format.Split(char)（帶快取） */
  Split(search: string): SplitList;
  /** C#: Format.Split(char, int) */
  Split(search: string, maxCount: number): SplitList;
  Split(search: string, maxCount?: number): SplitList {
    if (maxCount !== undefined) return this.SplitCount(search, maxCount);
    if (this.splitCache === null || this.splitCacheChar !== search) {
      this.splitCacheChar = search;
      this.splitCache = this.SplitCount(search, -1);
    }
    return this.splitCache;
  }

  /** C#: Format.Split(char, int) 的實作 */
  private SplitCount(search: string, maxCount: number): SplitList {
    const splits = this.FindAll(search, maxCount);
    const list = new SplitList();
    list.Init(this, splits);
    return list;
  }

  /** C#: Format.GetLiteralText */
  GetLiteralText(): string {
    let out = '';
    for (const item of this.Items) if (item instanceof LiteralText) out += item.toString();
    return out;
  }

  /** C#: Format.ToString */
  override toString(): string {
    let out = '';
    for (const item of this.Items) out += item.toString();
    return out;
  }
}

/** C#: UnityEngine.Localization.SmartFormat/FormatItemPool.cs（只保留建構方法，物件池交給 GC） */
export const FormatItemPool = {
  /** C#: FormatItemPool.GetLiteralText(SmartSettings, FormatItem, int) */
  GetLiteralTextFrom(smartSettings: SmartSettings, parent: FormatItem, startIndex: number): LiteralText {
    const lt = new LiteralText();
    lt.Init(smartSettings, parent, startIndex);
    return lt;
  },
  /** C#: FormatItemPool.GetLiteralText(SmartSettings, FormatItem, int, int) */
  GetLiteralText(smartSettings: SmartSettings, parent: FormatItem, startIndex: number, endIndex: number): LiteralText {
    const lt = new LiteralText();
    lt.InitRange(smartSettings, parent, startIndex, endIndex);
    return lt;
  },
  /** C#: FormatItemPool.GetFormat(SmartSettings, string) */
  GetFormat(smartSettings: SmartSettings, baseString: string): Format {
    const f = new Format();
    f.InitBase(smartSettings, null, baseString, 0, baseString.length);
    return f;
  },
  /** C#: FormatItemPool.GetFormat(SmartSettings, string, int, int) */
  GetFormatRange(smartSettings: SmartSettings, baseString: string, startIndex: number, endIndex: number): Format {
    const f = new Format();
    f.InitBase(smartSettings, null, baseString, startIndex, endIndex);
    return f;
  },
  /** C#: FormatItemPool.GetFormat(SmartSettings, string, int, int, bool) */
  GetFormatNested(smartSettings: SmartSettings, baseString: string, startIndex: number, endIndex: number, nested: boolean): Format {
    const f = FormatItemPool.GetFormatRange(smartSettings, baseString, startIndex, endIndex);
    f.HasNested = nested;
    return f;
  },
  /** C#: FormatItemPool.GetFormat(SmartSettings, Placeholder, int) */
  GetFormatOf(smartSettings: SmartSettings, parent: Placeholder, startIndex: number): Format {
    const f = new Format();
    f.Init(smartSettings, parent, startIndex);
    f.parent = parent;
    return f;
  },
  /** C#: FormatItemPool.GetPlaceholder(SmartSettings, Format, int, int) */
  GetPlaceholder(smartSettings: SmartSettings, parent: Format, startIndex: number, nestedDepth: number): Placeholder {
    const p = new Placeholder();
    p.Init(smartSettings, parent, startIndex);
    p.NestedDepth = nestedDepth;
    p.FormatterName = '';
    p.FormatterOptions = '';
    return p;
  },
  /** C#: FormatItemPool.GetPlaceholder(SmartSettings, Format, int, int, Format, int) */
  GetPlaceholderWithFormat(smartSettings: SmartSettings, parent: Format, startIndex: number, nestedDepth: number, itemFormat: Format, endIndex: number): Placeholder {
    const p = new Placeholder();
    p.InitRange(smartSettings, parent, startIndex, endIndex);
    p.Format = itemFormat;
    p.NestedDepth = nestedDepth;
    p.FormatterName = '';
    p.FormatterOptions = '';
    return p;
  },
  /** C#: FormatItemPool.GetSelector */
  GetSelector(smartSettings: SmartSettings, parent: FormatItem, baseString: string, startIndex: number, endIndex: number, operatorStart: number, selectorIndex: number): Selector {
    const s = new Selector();
    s.InitBase(smartSettings, parent, baseString, startIndex, endIndex);
    s.operatorStart = operatorStart;
    s.SelectorIndex = selectorIndex;
    return s;
  },
};

/** C#: Core.Parsing/ParsingErrors.cs ParsingErrors.ParsingIssue */
export class ParsingIssue {
  readonly Issue: string;
  readonly Index: number;
  readonly Length: number;

  constructor(issue: string, index: number, length: number) {
    this.Issue = issue;
    this.Index = index;
    this.Length = length;
  }
}

/** C#: Core.Parsing/ParsingErrors.cs ParsingErrors */
export class ParsingErrors extends Error {
  readonly Issues: ParsingIssue[] = [];
  private result: Format | null = null;

  constructor() {
    // 不給 super 訊息：Error 建構子寫入的 message 會蓋掉下面的 Message getter
    super();
    this.name = 'ParsingErrors';
  }

  /** C#: ParsingErrors.HasIssues */
  get HasIssues(): boolean {
    return this.Issues.length > 0;
  }

  /** C#: ParsingErrors.Init */
  Init(result: Format): void {
    this.result = result;
  }

  /** C#: ParsingErrors.AddIssue */
  AddIssue(issue: string, startIndex: number, endIndex: number): void {
    this.Issues.push(new ParsingIssue(issue, startIndex, endIndex - startIndex));
  }

  /** C#: ParsingErrors.MessageShort */
  get MessageShort(): string {
    return `The format string has ${this.Issues.length} issue${this.Issues.length === 1 ? '' : 's'}: ${this.Issues.map((i) => i.Issue).join(', ')}`;
  }

  /** C#: ParsingErrors.Message */
  override get message(): string {
    let marks = '';
    let num = 0;
    for (const issue of this.Issues) {
      marks += '-'.repeat(Math.max(issue.Index - num, 0));
      if (issue.Length > 0) {
        marks += '^'.repeat(Math.max(issue.Length, 1));
        num = issue.Index + issue.Length;
      } else {
        marks += '^';
        num = issue.Index + 1;
      }
    }
    return `The format string has ${this.Issues.length} issue${this.Issues.length === 1 ? '' : 's'}:\n${this.Issues.map((i) => i.Issue).join(', ')}\nIn: "${this.result?.baseString ?? ''}"\nAt:  ${marks} `;
  }
}

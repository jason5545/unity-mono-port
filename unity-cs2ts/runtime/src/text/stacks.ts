// TMP_TextProcessingStack.cs 的兩個 stack，行為照原版（含 index 邊界語義）。
// 對應 reference/tmp-src/pre.4/package/Scripts/Runtime/TMP_TextProcessingStack.cs

import { FontStyles } from './enums';

/** TMP_FontStyleStack（TMP_TextProcessingStack.cs:10）：binary（on/off）style 的計數 stack */
export class TmpFontStyleStack {
  bold = 0;
  italic = 0;
  underline = 0;
  strikethrough = 0;
  highlight = 0;
  superscript = 0;
  subscript = 0;
  uppercase = 0;
  lowercase = 0;
  smallcaps = 0;

  clear(): void {
    this.bold = 0;
    this.italic = 0;
    this.underline = 0;
    this.strikethrough = 0;
    this.highlight = 0;
    this.superscript = 0;
    this.subscript = 0;
    this.uppercase = 0;
    this.lowercase = 0;
    this.smallcaps = 0;
  }

  add(style: FontStyles): number {
    switch (style) {
      case FontStyles.Bold: return ++this.bold;
      case FontStyles.Italic: return ++this.italic;
      case FontStyles.Underline: return ++this.underline;
      case FontStyles.UpperCase: return ++this.uppercase;
      case FontStyles.LowerCase: return ++this.lowercase;
      case FontStyles.Strikethrough: return ++this.strikethrough;
      case FontStyles.Highlight: return ++this.highlight;
      case FontStyles.Superscript: return ++this.superscript;
      case FontStyles.Subscript: return ++this.subscript;
    }
    return 0;
  }

  remove(style: FontStyles): number {
    switch (style) {
      case FontStyles.Bold: this.bold = this.bold > 1 ? this.bold - 1 : 0; return this.bold;
      case FontStyles.Italic: this.italic = this.italic > 1 ? this.italic - 1 : 0; return this.italic;
      case FontStyles.Underline: this.underline = this.underline > 1 ? this.underline - 1 : 0; return this.underline;
      case FontStyles.UpperCase: this.uppercase = this.uppercase > 1 ? this.uppercase - 1 : 0; return this.uppercase;
      case FontStyles.LowerCase: this.lowercase = this.lowercase > 1 ? this.lowercase - 1 : 0; return this.lowercase;
      case FontStyles.Strikethrough: this.strikethrough = this.strikethrough > 1 ? this.strikethrough - 1 : 0; return this.strikethrough;
      case FontStyles.Highlight: this.highlight = this.highlight > 1 ? this.highlight - 1 : 0; return this.highlight;
      case FontStyles.Superscript: this.superscript = this.superscript > 1 ? this.superscript - 1 : 0; return this.superscript;
      case FontStyles.Subscript: this.subscript = this.subscript > 1 ? this.subscript - 1 : 0; return this.subscript;
    }
    return 0;
  }

  /** C# struct 複製語義：全純量，直接複製 */
  snapshot(): TmpFontStyleStack {
    const s = new TmpFontStyleStack();
    Object.assign(s, this);
    return s;
  }
}

/**
 * TMP_TextProcessingStack<T>（TMP_TextProcessingStack.cs:146）。
 * 注意 Remove 的邊界：index 退到 0 時強制回 itemStack[0] 且 index 重設 1（SetDefault 的預設項語義）。
 * T 是物件時，內部陣列持有參照（C# 是值型別複製，這裡呼叫端要自行 clone——見 WordWrapState）。
 */
export class TmpTextProcessingStack<T> {
  itemStack: (T | undefined)[];
  index = 0;
  private m_DefaultItem: T | undefined;
  private m_Capacity: number;
  private m_RolloverSize: number;
  private m_Count = 0;

  constructor(stackOrCapacity: (T | undefined)[] | number, rolloverSize = 0) {
    if (Array.isArray(stackOrCapacity)) {
      this.itemStack = stackOrCapacity;
      this.m_Capacity = stackOrCapacity.length;
      this.m_RolloverSize = 0;
    } else {
      this.itemStack = new Array(stackOrCapacity).fill(undefined);
      this.m_Capacity = stackOrCapacity;
      this.m_RolloverSize = rolloverSize;
    }
  }

  get count(): number {
    return this.m_Count;
  }

  get current(): T | undefined {
    if (this.index > 0) return this.itemStack[this.index - 1];
    return this.itemStack[0];
  }

  get rolloverSize(): number {
    return this.m_RolloverSize;
  }

  clear(): void {
    this.index = 0;
    this.m_Count = 0;
  }

  setDefault(item: T): void {
    this.itemStack[0] = item;
    this.index = 1;
    this.m_Count = 1;
  }

  add(item: T): void {
    if (this.index < this.itemStack.length) {
      this.itemStack[this.index] = item;
      this.index += 1;
    }
  }

  remove(): T | undefined {
    this.index -= 1;
    this.m_Count -= 1;
    if (this.index <= 0) {
      this.m_Count = 0;
      this.index = 1;
      return this.itemStack[0];
    }
    return this.itemStack[this.index - 1];
  }

  push(item: T): void {
    if (this.index === this.m_Capacity) {
      this.m_Capacity *= 2;
      if (this.m_Capacity === 0) this.m_Capacity = 4;
      this.itemStack.length = this.m_Capacity;
    }
    this.itemStack[this.index] = item;
    if (this.m_RolloverSize === 0) {
      this.index += 1;
      this.m_Count += 1;
    } else {
      this.index = (this.index + 1) % this.m_RolloverSize;
      this.m_Count = this.m_Count < this.m_RolloverSize ? this.m_Count + 1 : this.m_RolloverSize;
    }
  }

  pop(): T | undefined {
    if (this.index === 0 && this.m_RolloverSize === 0) return undefined;
    if (this.m_RolloverSize === 0) this.index -= 1;
    else {
      this.index = (this.index - 1) % this.m_RolloverSize;
      this.index = this.index < 0 ? this.index + this.m_RolloverSize : this.index;
    }
    const item = this.itemStack[this.index];
    this.itemStack[this.index] = this.m_DefaultItem;
    this.m_Count = this.m_Count > 0 ? this.m_Count - 1 : 0;
    return item;
  }

  peek(): T | undefined {
    if (this.index === 0) return this.m_DefaultItem;
    return this.itemStack[this.index - 1];
  }

  currentItem(): T | undefined {
    if (this.index > 0) return this.itemStack[this.index - 1];
    return this.itemStack[0];
  }

  previousItem(): T | undefined {
    if (this.index > 1) return this.itemStack[this.index - 2];
    return this.itemStack[0];
  }

  /** C# struct 複製語義：共享 itemStack 陣列，index/count/capacity/rollover 各自一份 */
  snapshot(): TmpTextProcessingStack<T> {
    const s = new TmpTextProcessingStack<T>(this.itemStack);
    s.index = this.index;
    s.m_DefaultItem = this.m_DefaultItem;
    s.m_Capacity = this.m_Capacity;
    s.m_RolloverSize = this.m_RolloverSize;
    s.m_Count = this.m_Count;
    return s;
  }
}

// C# 值的型別表示法（對應 reference/decompiled/Unity.Localization 裡各擴充功能的 `is`／`as` 型別判斷）。
//
// 原版是 C#，值有靜態型別：OrdinalFormatter 只接受 int、PluralLocalizationFormatter 排除 string／bool／Enum／
// DateTime、ListFormatter 排除 string 與 IFormattable。JS 的值沒有這些型別，所以這裡用包裝物件保留：
// 每個值都是 { kind, value }，kind 對應 C# 型別。要傳 C# float 1（不是 int 1）就用 cs.float(1)。
//
// 純 JS 值在 API 邊界自動包裝，規則：
//   number   → Number.isInteger 且在 int32 範圍內是 C# int，其餘是 C# double
//   bigint   → C# long        string → C# string       boolean → C# bool
//   null／undefined → C# null（物件參考 null）  Date → C# DateTime
//   Array／Map／一般物件 → C# object[]／Dictionary<string,object>／POCO
//   已包裝的 { kind, value } → 原樣
// number 這樣定的理由：遊戲傳進 smart string 的參數幾乎都是 int（骰子點數、張數、回合數），整數走 int
// 才會過 OrdinalFormatter 的 `is int`；JS 的 number 本質是 IEEE 754 double，非整數用 double 最忠實。
// 要 float、long、decimal 一律顯式包裝（例如驗收的 C# float 1 用 cs.float(1)）。
// C# char 不在遊戲資料裡，不移植。C# 的 List<T> 泛型參數決定它算不算 IEnumerable<object>（見 CsList）。

export interface CsNull {
  readonly kind: 'null';
}
export interface CsInt {
  readonly kind: 'int';
  readonly value: number;
}
export interface CsLong {
  readonly kind: 'long';
  readonly value: bigint;
}
export interface CsFloat {
  readonly kind: 'float';
  readonly value: number;
}
export interface CsDouble {
  readonly kind: 'double';
  readonly value: number;
}
export interface CsDecimal {
  readonly kind: 'decimal';
  readonly value: number;
}
export interface CsString {
  readonly kind: 'string';
  readonly value: string;
}
export interface CsBool {
  readonly kind: 'bool';
  readonly value: boolean;
}
export interface CsEnum {
  readonly kind: 'enum';
  readonly name: string;
  readonly value: number;
}
export interface CsDateTime {
  readonly kind: 'datetime';
  /** DateTime.Ticks（100ns，UTC；原版呼叫 ToUniversalTime() 比較） */
  readonly ticks: bigint;
}
export interface CsTimeSpan {
  readonly kind: 'timespan';
  readonly ticks: bigint;
}
/** C# object[]／List<object> 是 IEnumerable<object>；typedList 對應 List<int> 這類非物件的泛型集合 */
export interface CsList {
  readonly kind: 'list';
  readonly items: CsValue[];
  readonly objectElements: boolean;
}
/** Map／plain object → C# Dictionary<string,object>（IDictionary，DictionarySource 第一支）。
 *  nonGeneric=false 對應只實作 IDictionary<string,object> 的型別（第二支：值是 null 就當找不到）。 */
export interface CsDict {
  readonly kind: 'dict';
  readonly nonGeneric: boolean;
  readonly entries: ReadonlyArray<readonly [string, CsValue]>;
}
/** POCO：交給 ReflectionSource 取欄位／屬性／無參數方法 */
export interface CsObject {
  readonly kind: 'object';
  readonly value: object;
}

export type CsValue = CsNull | CsInt | CsLong | CsFloat | CsDouble | CsDecimal | CsString | CsBool | CsEnum | CsDateTime | CsTimeSpan | CsList | CsDict | CsObject;

const NULL_VALUE: CsNull = { kind: 'null' };

function asInt32(n: number): number {
  return n | 0;
}

export const cs = {
  int(value: number): CsInt {
    return { kind: 'int', value: asInt32(value) };
  },
  long(value: bigint | number): CsLong {
    return { kind: 'long', value: typeof value === 'bigint' ? value : BigInt(Math.trunc(value)) };
  },
  float(value: number): CsFloat {
    return { kind: 'float', value: Math.fround(value) };
  },
  double(value: number): CsDouble {
    return { kind: 'double', value };
  },
  decimal(value: number): CsDecimal {
    return { kind: 'decimal', value };
  },
  string(value: string): CsString {
    return { kind: 'string', value };
  },
  bool(value: boolean): CsBool {
    return { kind: 'bool', value };
  },
  enum(name: string, value = 0): CsEnum {
    return { kind: 'enum', name, value };
  },
  /** ticks 是 C# DateTime.Ticks；用 JS Date 建請用 wrap(new Date()) */
  datetimeTicks(ticks: bigint): CsDateTime {
    return { kind: 'datetime', ticks };
  },
  timespanTicks(ticks: bigint): CsTimeSpan {
    return { kind: 'timespan', ticks };
  },
  timespanMs(ms: number): CsTimeSpan {
    return { kind: 'timespan', ticks: BigInt(Math.round(ms)) * 10000n };
  },
  list(items: readonly CsValue[]): CsList {
    return { kind: 'list', items: [...items], objectElements: true };
  },
  /** 對應 List<int> 之類：是 IEnumerable 但不是 IEnumerable<object> */
  typedList(element: 'int' | 'long' | 'float' | 'double' | 'decimal' | 'string' | 'bool', items: readonly CsValue[]): CsList {
    void element;
    return { kind: 'list', items: [...items], objectElements: false };
  },
  dict(entries: ReadonlyArray<readonly [string, CsValue]>): CsDict {
    return { kind: 'dict', nonGeneric: true, entries: [...entries] };
  },
  /** 只實作 IDictionary<string,object> 的型別（DictionarySource 第二支） */
  genericDict(entries: ReadonlyArray<readonly [string, CsValue]>): CsDict {
    return { kind: 'dict', nonGeneric: false, entries: [...entries] };
  },
  /** 對應 POCO（非 Dictionary 的物件），走 ReflectionSource */
  object(value: object): CsObject {
    return { kind: 'object', value };
  },
  null(): CsNull {
    return NULL_VALUE;
  },
};

export function isCsValue(v: unknown): v is CsValue {
  return typeof v === 'object' && v !== null && 'kind' in v && typeof (v as { kind: unknown }).kind === 'string';
}

/** API 邊界的自動包裝（規則寫在檔頭） */
export function wrap(v: unknown): CsValue {
  if (isCsValue(v)) return v;
  if (v === null || v === undefined) return NULL_VALUE;
  switch (typeof v) {
    case 'number':
      return Number.isInteger(v) && v >= -2147483648 && v <= 2147483647 ? cs.int(v) : cs.double(v);
    case 'bigint':
      return cs.long(v);
    case 'string':
      return cs.string(v);
    case 'boolean':
      return cs.bool(v);
    default:
      break;
  }
  if (v instanceof Date) return cs.datetimeTicks(BigInt(v.getTime()) * 10000n + 621355968000000000n);
  if (Array.isArray(v)) return cs.list(v.map(wrap));
  if (v instanceof Map) return cs.dict([...v.entries()].map(([k, x]) => [String(k), wrap(x)] as const));
  if (typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      return cs.dict(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, wrap(x)] as const));
    }
    return cs.object(v as object);
  }
  return NULL_VALUE;
}

export function wrapAll(v: readonly unknown[]): CsValue[] {
  return v.map(wrap);
}

/** C# Convert.ToDecimal（PluralLocalizationFormatter／ConditionalFormatter 的 IConvertible 分支） */
export function toDecimal(v: CsValue): number {
  switch (v.kind) {
    case 'int':
    case 'float':
    case 'double':
    case 'decimal':
      return v.value;
    case 'long':
      return Number(v.value);
    case 'enum':
      return v.value;
    default:
      throw new Error(`toDecimal: ${v.kind} 不是數值型別`);
  }
}

/** C# Convert.ToBoolean（ConditionalFormatter 的 bool 分支前的物件判斷） */
export function toBoolean(v: CsValue): boolean {
  return v.kind === 'bool' && v.value;
}

/** C# `is IConvertible && !(is DateTime) && !(is string) && !(is bool) && !(is Enum)`（PluralLocalizationFormatter） */
export function isConvertibleNumeric(v: CsValue): boolean {
  return v.kind === 'int' || v.kind === 'long' || v.kind === 'float' || v.kind === 'double' || v.kind === 'decimal';
}

/** C# `is IConvertible && !(is DateTime) && !(is string) && !(is bool)`（ConditionalFormatter，Enum 算 IConvertible） */
export function isConvertibleNotDateTimeStringBool(v: CsValue): boolean {
  return isConvertibleNumeric(v) || v.kind === 'enum';
}

/** C# `is IEnumerable<object>`（PluralLocalizationFormatter 的集合分支；string 是 IEnumerable<char>，不算） */
export function isEnumerableOfObject(v: CsValue): v is CsList {
  return v.kind === 'list' && v.objectElements;
}

/** C# `is IEnumerable`（ListFormatter；string 另行排除） */
export function isEnumerable(v: CsValue): boolean {
  return v.kind === 'list' || v.kind === 'string' || v.kind === 'dict';
}

/** C# `is IFormattable`（ListFormatter 排除、DefaultFormatter 用 ToString(format, provider)）。
 *  int／long／float／double／decimal／DateTime／TimeSpan／Enum 實作 IFormattable；string 不是。 */
export function isFormattable(v: CsValue): boolean {
  return isConvertibleNumeric(v) || v.kind === 'enum' || v.kind === 'datetime' || v.kind === 'timespan';
}

/** C# `is IDictionary`（DictionarySource 第一支；Dictionary<string,object> 走這支） */
export function isIDictionary(v: CsValue): v is CsDict {
  return v.kind === 'dict' && v.nonGeneric;
}

/** C# `is IDictionary<string,object>`（DictionarySource 第二支） */
export function isGenericStringObjectDictionary(v: CsValue): v is CsDict {
  return v.kind === 'dict';
}

export const TICKS_PER_MS = 10000n;
export const TICKS_EPOCH_DOTNET = 621355968000000000n; // DateTime ticks of 1970-01-01

export function ticksToDate(ticks: bigint): Date {
  return new Date(Number((ticks - TICKS_EPOCH_DOTNET) / TICKS_PER_MS));
}

export function dateToTicks(d: Date): bigint {
  return BigInt(d.getTime()) * TICKS_PER_MS + TICKS_EPOCH_DOTNET;
}

/** int 的 C# % 與 Math.Abs（Mathf.Abs(int.MinValue) 回傳 int.MinValue） */
export function csharpAbsInt(v: number): number {
  return v === -2147483648 ? -2147483648 : Math.abs(v);
}

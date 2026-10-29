// 相容層：.NET 基礎類別庫（System.*）裡產生碼用到的部分。名字規則見 converter/Program.cs 檔頭（R.<型別>_<成員>，多載加 $<參數型別>）。
import { cloneData, externalValueType, genClass, H, hasGen, objectOverride, setEnumTypeCheck, setNewDictHook, staticCtx, type Ctx } from './core';

export * from './dotnetBcl';
export * from './dotnetIO';
export * from './dotnetLinq';
export * from './dotnetReflection';

/** new T[n]：產生碼傳長度與元素型別的預設值 */
export function newArray(n: number, v: unknown): unknown[] {
  return Array.from({ length: n }, () => cloneData(v));
}
/** foreach 走 System.Array（非泛型）：照元素順序 */
export function Array_toArray(c: Ctx, a: Iterable<unknown>): unknown[] {
  void c;
  return [...a];
}
/** System.Array.Length（Enum.GetValues 回傳的是 System.Array） */
export function Array_get_Length(c: Ctx, a: ArrayLike<unknown>): number {
  void c;
  return a.length;
}
/** Array.Copy(src, dst, length)：從頭複製 length 個 */
export function Array_Copy$Array_Array_int(c: Ctx, src: unknown[], dst: unknown[], length: number): void {
  void c;
  for (let i = 0; i < length; i++) dst[i] = src[i];
}
export function String_get_Empty(c: Ctx): string {
  void c;
  return '';
}
/** object.Equals(object)：值型別（一般物件）比欄位，其他比參照 */
export function Object_Equals$Object(c: Ctx, a: unknown, b: unknown): boolean {
  void c;
  if (a === b) return true;
  // 產生類別覆寫了 Equals(object)（CoreSymbol 照 m_value 比）：照實體的實際類別分派
  const eq = objectOverride(a, 'Equals');
  if (eq) return !!eq(b);
  // DLL 裡的結構有專門的相等（相容層 registerValueType 給的）
  const vt = externalValueType(a);
  if (vt?.equals) return externalValueType(b) === vt && vt.equals(a, b);
  if (a instanceof BoxedEnum || b instanceof BoxedEnum) return a instanceof BoxedEnum && b instanceof BoxedEnum && a.type === b.type && a.value === b.value;
  if (isValueObj(a) && isValueObj(b)) return valueEquals(a, b);
  return false;
}
/** 這個值的 Equals 不是參照相等（覆寫了 Equals、值型別、裝箱的列舉）：集合找元素時要逐一比 */
export function hasValueEquality(x: unknown): boolean {
  return !!x && typeof x === 'object' && (x instanceof BoxedEnum || isValueObj(x) || !!objectOverride(x, 'Equals'));
}
/** ValueType.Equals 的基底版（struct 覆寫裡的 base.Equals(obj)）：欄位逐一比，不再分派 */
export function base_ValueType_Equals(c: Ctx, self: unknown, o: unknown): boolean {
  void c;
  return self === o || (isValueObj(self) && isValueObj(o) && valueEquals(self, o));
}
export const ValueType_Equals = (c: Ctx, a: unknown, b: unknown): boolean => Object_Equals$Object(c, a, b);
/** object.Equals 的基底版（class 覆寫裡的 base.Equals(obj)）：參照相等 */
export const base_Object_Equals$Object = (_c: Ctx, self: unknown, o: unknown): boolean => self === o;
/** 值型別的物件：沒有 $type 的一般物件（Unity 的 Vector3、Color…）或產生的 struct；產生的 class 實體、場景 handle 是參照 */
function isValueObj(x: unknown): x is Record<string, unknown> {
  if (!x || typeof x !== 'object' || Object.getPrototypeOf(x) !== Object.prototype) return false;
  const t = (x as { $type?: unknown }).$type;
  return typeof t !== 'string' || (hasGen(t) && !!genClass(t).struct) || !!externalValueType(x);
}
/** ValueType.Equals：欄位逐一比，欄位是值型別就往下比，參照型別比是不是同一個 */
function valueEquals(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (x === y || (typeof x === 'number' && typeof y === 'number' && Number.isNaN(x) && Number.isNaN(y))) continue;
    if (isValueObj(x) && isValueObj(y) && valueEquals(x, y)) continue;
    if (x instanceof BoxedEnum && y instanceof BoxedEnum && x.type === y.type && x.value === y.value) continue;
    return false;
  }
  return true;
}
/** EqualityComparer<T>.Default.Equals：同上 */
export function EqualityComparer_get_Default(c: Ctx): object {
  void c;
  return EQUALITY;
}
const EQUALITY = { name: 'EqualityComparer.Default' };
export function EqualityComparer_Equals(c: Ctx, cmp: object, a: unknown, b: unknown): boolean {
  void cmp;
  return Object_Equals$Object(c, a, b);
}
const UTF8 = { name: 'UTF8' };
export function Encoding_get_UTF8(c: Ctx): object {
  void c;
  return UTF8;
}
export function Encoding_GetBytes$string(c: Ctx, enc: object, s: string): Uint8Array {
  void c;
  if (enc !== UTF8) throw new Error('Encoding.GetBytes：只有 UTF8');
  return new TextEncoder().encode(s);
}

// ───────── 裝箱的列舉（System.Enum／object：轉換器在裝箱的地方寫 R.boxEnum，型別與成員名跟著值走） ─────────

export class BoxedEnum {
  constructor(
    readonly value: number,
    readonly type: string,
    readonly names: Record<number, string>,
  ) {}
  valueOf(): number {
    return this.value;
  }
}
export function boxEnum(v: number | BoxedEnum, type: string, names: Record<number, string>): BoxedEnum {
  enumTypes.add(type);
  return v instanceof BoxedEnum ? v : new BoxedEnum(v, type, names);
}
/** Enum.ToString()：成員名；[Flags] 是組合的名字（"A, B"，照 .NET 從大的值往下扣）；沒有對應的值照數字 */
export function Enum_ToString$(c: Ctx, e: BoxedEnum | number): string {
  void c;
  if (!(e instanceof BoxedEnum)) return String(e);
  const direct = e.names[e.value];
  if (direct !== undefined) return direct;
  const info = ENUMS[e.type];
  if (info?.flags && e.value !== 0) {
    let rest = e.value;
    const parts: string[] = [];
    for (let i = info.members.length - 1; i >= 0 && rest !== 0; i--) {
      const [n, v] = info.members[i];
      if (v !== 0 && (rest & v) === v) {
        parts.unshift(n);
        rest &= ~v;
      }
    }
    if (rest === 0) return parts.join(', ');
  }
  return String(e.value);
}

// ───────── 列舉的名字表（轉換器的 gen/$enums.ts；System.Type 是型別名字串） ─────────

/** kind：底層型別不是 int 時轉換器才寫（u8、i16…） */
type EnumInfo = { flags: boolean; members: [string, number][]; kind?: string };
const ENUMS: Record<string, EnumInfo> = {};
/** 開機時登記產生的列舉名字表（gen/index.ts 的 <IndexConst>_ENUMS） */
export function registerEnums(map: Record<string, EnumInfo>): void {
  Object.assign(ENUMS, map);
  for (const k of Object.keys(map)) enumTypes.add(k);
}
/** 列舉值的成員名（名字表裡沒有回 null） */
export function enumNameOf(type: string, value: number): string | null {
  return ENUMS[type]?.members.find(([, v]) => v === value)?.[0] ?? null;
}
function enumInfo(t: string): EnumInfo {
  const info = ENUMS[t];
  if (!info) throw new Error(`C# ArgumentException：${t} 不是列舉（或沒有名字表）`);
  return info;
}
function enumValue(v: unknown): number {
  return v instanceof BoxedEnum ? v.value : Number(v);
}
function boxed(t: string, v: number): BoxedEnum {
  const info = ENUMS[t];
  const names: Record<number, string> = {};
  if (info) for (const [n, x] of info.members) if (!(x in names)) names[x] = n;
  return new BoxedEnum(v, t, names);
}
export function Enum_GetNames$Type(c: Ctx, t: string): string[] {
  void c;
  return enumInfo(t).members.map(([n]) => n);
}
export const Enum_GetNames = Enum_GetNames$Type;
/** Enum.GetValues(type)：照 .NET 的順序（無號值由小到大）；元素是列舉值（數字） */
export function Enum_GetValues$Type(c: Ctx, t: string): number[] {
  void c;
  return enumInfo(t).members.map(([, v]) => v);
}
export const Enum_GetValues = Enum_GetValues$Type;
export function Enum_GetName$Type_Object(c: Ctx, t: string, v: unknown): string | null {
  void c;
  const x = enumValue(v);
  return enumInfo(t).members.find(([, m]) => m === x)?.[0] ?? null;
}
export function Enum_IsDefined$Type_Object(c: Ctx, t: string, v: unknown): boolean {
  void c;
  if (typeof v === 'string') return enumInfo(t).members.some(([n]) => n === v);
  const x = enumValue(v);
  return enumInfo(t).members.some(([, m]) => m === x);
}
function parseEnum(t: string, s: string, ignoreCase: boolean): number | null {
  const info = enumInfo(t);
  let total = 0;
  for (const part of s.split(',')) {
    const p = part.trim();
    if (/^[-+]?\d+$/.test(p)) {
      total |= parseInt(p, 10);
      continue;
    }
    const hit = info.members.find(([n]) => (ignoreCase ? n.toLowerCase() === p.toLowerCase() : n === p));
    if (!hit) return null;
    total |= hit[1];
  }
  return total;
}
export function Enum_Parse$Type_string(c: Ctx, t: string, s: string): BoxedEnum {
  void c;
  const v = parseEnum(t, s ?? '', false);
  if (v === null) throw csException(['ArgumentException', 'SystemException', 'Exception'], `Requested value '${s}' was not found.`, null, 'Enum.Parse');
  return boxed(t, v);
}
export function Enum_Parse$Type_string_bool(c: Ctx, t: string, s: string, ignoreCase: boolean): BoxedEnum {
  void c;
  const v = parseEnum(t, s ?? '', ignoreCase);
  if (v === null) throw csException(['ArgumentException', 'SystemException', 'Exception'], `Requested value '${s}' was not found.`, null, 'Enum.Parse');
  return boxed(t, v);
}
/** Enum.TryParse<T>(s, out v)：型別名在最後（轉換器把泛型引數接在後面） */
export function Enum_TryParse$string_TEnum(c: Ctx, s: string, out: (v: number) => void, t: string): boolean {
  void c;
  const v = s == null ? null : parseEnum(t, s, false);
  out(v ?? 0);
  return v !== null;
}
export function Enum_TryParse$string_bool_TEnum(c: Ctx, s: string, ignoreCase: boolean, out: (v: number) => void, t: string): boolean {
  void c;
  const v = s == null ? null : parseEnum(t, s, ignoreCase);
  out(v ?? 0);
  return v !== null;
}
/** Enum.TryParse(Type, string, out object)：成功時 out 是裝箱的列舉，失敗是 null */
export function Enum_TryParse$Type_string_Object(c: Ctx, t: string, s: string, out: (v: BoxedEnum | null) => void): boolean {
  void c;
  const v = s == null ? null : parseEnum(t, s, false);
  out(v === null ? null : boxed(t, v));
  return v !== null;
}
export function Enum_ToObject$Type_int(c: Ctx, t: string, v: number): BoxedEnum {
  void c;
  return boxed(t, v);
}
export const Enum_ToObject$Type_Object = (c: Ctx, t: string, v: unknown): BoxedEnum => Enum_ToObject$Type_int(c, t, enumValue(v));
export function Enum_HasFlag(c: Ctx, e: unknown, flag: unknown): boolean {
  void c;
  const f = enumValue(flag);
  return (enumValue(e) & f) === f;
}
export function Enum_GetUnderlyingType(c: Ctx, t: string): string {
  void c;
  void t;
  return 'Int32';
}
export function Enum_CompareTo(c: Ctx, a: unknown, b: unknown): number {
  void c;
  return Math.sign(enumValue(a) - enumValue(b));
}

// ───────── 例外（C# 的例外物件：型別鏈、訊息、InnerException；catch 用 exceptionIs 比型別） ─────────

export class CsException extends Error {
  constructor(
    /** 型別與基底鏈（自己在前，到 Exception） */
    readonly chain: string[],
    readonly csMessage: string | null,
    readonly inner: unknown,
    where: string,
  ) {
    super(`C# ${chain[0]}：${csMessage ?? ''}（${where}）`);
    this.name = chain[0];
  }
}
/** new XException(訊息, inner)（轉換器寫）：訊息是 null 時照 .NET 的預設訊息概念，給型別名 */
export function csException(chain: string[], message: string | null, inner: unknown, where: string): CsException {
  return new CsException(chain, message, inner ?? null, where);
}
/** throw 運算式（x ?? throw …） */
export function throwIt(e: unknown): never {
  throw e;
}
/** 執行環境自己丟的錯誤對到 C# 的例外型別：TypeError（讀 null 的成員）是 NullReferenceException，其他當 Exception */
function chainOf(e: unknown): string[] {
  if (e instanceof CsException) return e.chain;
  if (e instanceof TypeError || (e instanceof Error && /對象是 null|NullReferenceException/.test(e.message))) return ['NullReferenceException', 'SystemException', 'Exception'];
  if (e instanceof RangeError) return ['IndexOutOfRangeException', 'SystemException', 'Exception'];
  if (e instanceof Error && /^C# (\w+)/.test(e.message)) return [/^C# (\w+)/.exec(e.message)![1], 'Exception'];
  return ['Exception'];
}
/** catch (T ex) 的型別比對：T 在例外的型別鏈裡。還沒移植（NotPorted）只有 catch (Exception) 接得到 */
export function exceptionIs(e: unknown, type: string): boolean {
  if (type === 'Exception') return true;
  if (e instanceof Error && e.name === 'NotPorted') return false;
  return chainOf(e).includes(type);
}
export function Exception_get_Message(c: Ctx, e: unknown): string {
  void c;
  if (e instanceof CsException) return e.csMessage ?? `Exception of type '${e.chain[0]}' was thrown.`;
  return e instanceof Error ? e.message : String(e);
}
export function Exception_get_InnerException(c: Ctx, e: unknown): unknown {
  void c;
  return e instanceof CsException ? e.inner : null;
}
export function Exception_GetBaseException(c: Ctx, e: unknown): unknown {
  let x = e;
  while (x instanceof CsException && x.inner) x = x.inner;
  void c;
  return x;
}
export function Exception_get_StackTrace(c: Ctx, e: unknown): string {
  void c;
  return e instanceof Error ? (e.stack ?? '') : '';
}
export function Exception_ToString(c: Ctx, e: unknown): string {
  const type = chainOf(e)[0];
  return `${type === 'Exception' && e instanceof Error ? e.name : type}: ${Exception_get_Message(c, e)}\n${Exception_get_StackTrace(c, e)}`;
}
/** ex.GetType()：例外的型別名（System.Type 是型別名字串） */
export function Exception_GetType(c: Ctx, e: unknown): string {
  void c;
  return chainOf(e)[0] === 'Exception' && e instanceof Error && e.name !== 'Error' ? e.name : chainOf(e)[0];
}
export function Exception_get_Source(c: Ctx, e: unknown): string {
  void c;
  void e;
  return '';
}
export function Exception_get_HResult(c: Ctx, e: unknown): number {
  void c;
  void e;
  return -2146233088;
}
export function Exception_get_Data(c: Ctx, e: unknown): Map<unknown, unknown> {
  void c;
  const o = e as { $data?: Map<unknown, unknown> };
  return (o.$data ??= new Map());
}

// ───────── 執行緒（瀏覽器只有主執行緒） ─────────

const MAIN_THREAD = { $type: 'Thread', ManagedThreadId: 1, Name: 'Main Thread', IsBackground: false };
export function Thread_get_CurrentThread(c: Ctx): typeof MAIN_THREAD {
  void c;
  return MAIN_THREAD;
}
export function Thread_get_ManagedThreadId(c: Ctx, t: typeof MAIN_THREAD): number {
  void c;
  return t.ManagedThreadId;
}
export function Thread_get_Name(c: Ctx, t: typeof MAIN_THREAD): string {
  void c;
  return t.Name;
}
export function Thread_get_IsBackground(c: Ctx, t: typeof MAIN_THREAD): boolean {
  void c;
  return t.IsBackground;
}
export function Thread_Sleep$int(c: Ctx, ms: number): void {
  void c;
  void ms;
}
export function Environment_get_CurrentManagedThreadId(c: Ctx): number {
  void c;
  return 1;
}
export function Enum_GetHashCode(c: Ctx, e: BoxedEnum | number): number {
  void c;
  return e instanceof BoxedEnum ? e.value : e;
}

// ───────── Dictionary<TKey, TValue>（CsDict：照 .NET 的實作排列；out 參數是設值的回呼） ─────────

/**
 * .NET 的 Dictionary：項目放在格子陣列裡，Remove 空出來的格子串成空格串列（後進先出），下一次加入先用空格，
 * 列舉照格子的順序——所以刪過東西之後，列舉順序不是單純的加入順序。key 的相等照 Equals：字串、數字、列舉值照值，
 * 值型別（結構、tuple：一般物件）照欄位，其他照參照；給了 StringComparer.OrdinalIgnoreCase 時字串不分大小寫。
 * 對外是 Map 的介面（get／set／has／delete／size／列舉），其他相容層與產生碼照 Map 用。
 */
export class CsDict<K = unknown, V = unknown> extends Map<K, V> {
  private keys_: (K | undefined)[] = [];
  private vals: (V | undefined)[] = [];
  private used: boolean[] = [];
  private free: number[] = [];
  private index = new Map<unknown, number>();
  /** 照 GetHashCode／Equals 比的 key（覆寫了相等的產生類別、產生的結構）：雜湊值 → 存在表裡的 key（index 用它當代表） */
  private buckets: Map<number, object[]> | null = null;
  constructor(readonly ignoreCase = false) {
    super();
  }
  /** key → index 用的代表：字串、數字、列舉值照值，一般物件照欄位，覆寫相等的照 C# 的 GetHashCode＋Equals，其他照參照 */
  private norm(k: unknown, add = false): unknown {
    if (typeof k === 'string') return this.ignoreCase ? k.toUpperCase() : k;
    if (k instanceof BoxedEnum) return k.value;
    if (k && typeof k === 'object' && Object.getPrototypeOf(k) === Object.prototype) {
      if (!('$type' in k)) return `\u0000S${JSON.stringify(k)}`;
      if (objectOverride(k, 'GetHashCode') || objectOverride(k, 'Equals') || isValueObj(k)) return this.byEquals(k, add);
    }
    return k;
  }
  private byEquals(k: object, add: boolean): unknown {
    const h = Object_GetHashCode(staticCtx, k);
    this.buckets ??= new Map();
    let list = this.buckets.get(h);
    // .NET 的 FindValue：comparer.Equals(表裡的 key, 要找的 key)
    if (list) for (const r of list) if (r === k || Object_Equals$Object(staticCtx, r, k)) return r;
    if (!add) return k;
    if (!list) this.buckets.set(h, (list = []));
    list.push(k);
    return k;
  }
  private forget(rep: unknown): void {
    if (!this.buckets || !rep || typeof rep !== 'object') return;
    const h = Object_GetHashCode(staticCtx, rep);
    const list = this.buckets.get(h);
    const i = list ? list.indexOf(rep as object) : -1;
    if (i >= 0) list!.splice(i, 1);
  }
  override get size(): number {
    return this.index.size;
  }
  override has(k: K): boolean {
    return this.index.has(this.norm(k));
  }
  override get(k: K): V | undefined {
    const i = this.index.get(this.norm(k));
    return i === undefined ? undefined : this.vals[i];
  }
  override set(k: K, v: V): this {
    if (k == null) throw new Error('C# ArgumentNullException：key');
    const nk = this.norm(k, true);
    const i = this.index.get(nk);
    if (i !== undefined) {
      this.vals[i] = v;
      return this;
    }
    const slot = this.free.length ? this.free.pop()! : this.keys_.length;
    this.keys_[slot] = k;
    this.vals[slot] = v;
    this.used[slot] = true;
    this.index.set(nk, slot);
    return this;
  }
  override delete(k: K): boolean {
    const nk = this.norm(k);
    const i = this.index.get(nk);
    if (i === undefined) return false;
    this.index.delete(nk);
    this.forget(nk);
    this.keys_[i] = undefined;
    this.vals[i] = undefined;
    this.used[i] = false;
    this.free.push(i);
    return true;
  }
  override clear(): void {
    this.keys_ = [];
    this.vals = [];
    this.used = [];
    this.free = [];
    this.index.clear();
    this.buckets = null;
  }
  override *entries(): MapIterator<[K, V]> {
    for (let i = 0; i < this.keys_.length; i++) if (this.used[i]) yield [this.keys_[i] as K, this.vals[i] as V];
  }
  override *keys(): MapIterator<K> {
    for (const [k] of this.entries()) yield k;
  }
  override *values(): MapIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }
  override [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }
  override forEach(fn: (v: V, k: K, m: Map<K, V>) => void): void {
    for (const [k, v] of this.entries()) fn(v, k, this);
  }
}
setNewDictHook(() => new CsDict());
type Dict = Map<unknown, unknown>;
export function new_Dictionary$(c: Ctx): Dict {
  void c;
  return new CsDict();
}
export function new_Dictionary$int(c: Ctx, capacity: number): Dict {
  void capacity;
  return new_Dictionary$(c);
}
/** new Dictionary(comparer)：StringComparer.OrdinalIgnoreCase 系的不分大小寫，其他照預設的相等 */
export function new_Dictionary$IEqualityComparer(c: Ctx, cmp: unknown): Dict {
  void c;
  const name = (cmp as { name?: string } | null)?.name ?? '';
  return new CsDict(/IgnoreCase/.test(name));
}
export const new_Dictionary$int_IEqualityComparer = (c: Ctx, _n: number, cmp: unknown): Dict => new_Dictionary$IEqualityComparer(c, cmp);
export function new_Dictionary$IDictionary(c: Ctx, src: Dict): Dict {
  const d = new_Dictionary$(c);
  for (const [k, v] of src) d.set(k, v);
  return d;
}
export const new_Dictionary$IDictionary_IEqualityComparer = (c: Ctx, src: Dict, cmp: unknown): Dict => {
  const d = new_Dictionary$IEqualityComparer(c, cmp);
  for (const [k, v] of src) d.set(k, v);
  return d;
};
export function Dictionary_ContainsValue(c: Ctx, d: Dict, v: unknown): boolean {
  void c;
  for (const x of d.values()) if (x === v || Object_Equals$Object(c, x, v)) return true;
  return false;
}
export function Dictionary_get_Comparer(c: Ctx, d: Dict): object {
  void c;
  return { $type: 'EqualityComparer', name: d instanceof CsDict && d.ignoreCase ? 'OrdinalIgnoreCase' : 'Default' };
}
export function Dictionary_EnsureCapacity(c: Ctx, d: Dict, n: number): number {
  void c;
  return Math.max(n, d.size);
}
export function Dictionary_TrimExcess$(c: Ctx, d: Dict): void {
  void c;
  void d;
}
/** dict.GetEnumerator() 手動走（while (e.MoveNext()) e.Current）：Current 是 KeyValuePair */
class DictEnumerator {
  readonly items: { Key: unknown; Value: unknown }[];
  i = -1;
  constructor(d: Dict) {
    this.items = [...d.entries()].map(([Key, Value]) => ({ Key, Value }));
  }
  moveNext(): boolean {
    return ++this.i < this.items.length;
  }
  get current(): { Key: unknown; Value: unknown } {
    return this.items[this.i];
  }
}
export function Dictionary_GetEnumerator(c: Ctx, d: Dict): DictEnumerator {
  void c;
  return new DictEnumerator(d);
}
export function Dictionary_Enumerator_MoveNext(c: Ctx, e: DictEnumerator): boolean {
  void c;
  return ++e.i < e.items.length;
}
export function Dictionary_Enumerator_get_Current(c: Ctx, e: DictEnumerator): { Key: unknown; Value: unknown } {
  void c;
  return e.items[e.i];
}
export function Dictionary_Enumerator_Dispose(c: Ctx, e: DictEnumerator): void {
  void c;
  void e;
}
export function Dictionary_KeyCollection_toArray(c: Ctx, keys: unknown[]): unknown[] {
  void c;
  return keys;
}
export function Dictionary_ValueCollection_CopyTo(c: Ctx, values: unknown[], dst: unknown[], index: number): void {
  void c;
  for (let i = 0; i < values.length; i++) dst[index + i] = values[i];
}
export const IDictionary_get_Item = (c: Ctx, d: Dict, k: unknown): unknown => Dictionary_get_Item(c, d, k);
export const IDictionary_set_Item = (c: Ctx, d: Dict, k: unknown, v: unknown): void => Dictionary_set_Item(c, d, k, v);
export const IDictionary_get_Values = (c: Ctx, d: Dict): unknown[] => Dictionary_get_Values(c, d);
export const IDictionary_get_Keys = (c: Ctx, d: Dict): unknown[] => Dictionary_get_Keys(c, d);
export const IDictionary_toArray = (c: Ctx, d: Dict): { Key: unknown; Value: unknown }[] => Dictionary_toArray(c, d);
export const IReadOnlyDictionary_toArray = IDictionary_toArray;
export const IReadOnlyDictionary_get_Item = IDictionary_get_Item;
/** Dictionary.Add：重複的 key 丟 ArgumentException（照 C#） */
export function Dictionary_Add(c: Ctx, d: Dict, k: unknown, v: unknown): void {
  void c;
  if (k == null) throw csException(['ArgumentNullException', 'ArgumentException', 'SystemException', 'Exception'], 'key', null, 'Dictionary.Add');
  if (d.has(k)) throw csException(['ArgumentException', 'SystemException', 'Exception'], `An item with the same key has already been added. Key: ${String(k)}`, null, 'Dictionary.Add');
  d.set(k, v);
}
export function Dictionary_TryAdd(c: Ctx, d: Dict, k: unknown, v: unknown): boolean {
  void c;
  if (d.has(k)) return false;
  d.set(k, v);
  return true;
}
export function Dictionary_TryGetValue(c: Ctx, d: Dict, k: unknown, out: (v: unknown) => void): boolean {
  void c;
  if (d.has(k)) {
    out(d.get(k));
    return true;
  }
  out(null);
  return false;
}
export function Dictionary_get_Item(c: Ctx, d: Dict, k: unknown): unknown {
  void c;
  if (!d.has(k)) throw csException(['KeyNotFoundException', 'SystemException', 'Exception'], `The given key '${String(k)}' was not present in the dictionary.`, null, 'Dictionary[]');
  return d.get(k);
}
export function Dictionary_set_Item(c: Ctx, d: Dict, k: unknown, v: unknown): void {
  void c;
  d.set(k, v);
}
export function Dictionary_ContainsKey(c: Ctx, d: Dict, k: unknown): boolean {
  void c;
  return d.has(k);
}
export function Dictionary_Remove$TKey(c: Ctx, d: Dict, k: unknown): boolean {
  void c;
  return d.delete(k);
}
export function Dictionary_Clear(c: Ctx, d: Dict): void {
  void c;
  d.clear();
}
export function Dictionary_get_Count(c: Ctx, d: Dict): number {
  void c;
  return d.size;
}
/** Keys／Values：照加入順序的陣列（C# 的 KeyCollection／ValueCollection 在沒有刪除時也是加入順序） */
export function Dictionary_get_Keys(c: Ctx, d: Dict): unknown[] {
  void c;
  return [...d.keys()];
}
export function Dictionary_get_Values(c: Ctx, d: Dict): unknown[] {
  void c;
  return [...d.values()];
}
export function Dictionary_KeyCollection_get_Count(c: Ctx, keys: unknown[]): number {
  void c;
  return keys.length;
}
export function Dictionary_ValueCollection_get_Count(c: Ctx, values: unknown[]): number {
  void c;
  return values.length;
}
export function Dictionary_KeyCollection_CopyTo(c: Ctx, keys: unknown[], dst: unknown[], index: number): void {
  void c;
  for (let i = 0; i < keys.length; i++) dst[index + i] = keys[i];
}
export function Dictionary_ValueCollection_toArray(c: Ctx, values: unknown[]): unknown[] {
  void c;
  return [...values];
}
/** foreach (var kv in dict)：KeyValuePair 的 Key／Value */
export function Dictionary_toArray(c: Ctx, d: Dict): { Key: unknown; Value: unknown }[] {
  void c;
  return [...d.entries()].map(([Key, Value]) => ({ Key, Value }));
}

// ───────── StringBuilder ─────────

export class StringBuilderJs {
  s = '';
}
export function new_StringBuilder$(c: Ctx): StringBuilderJs {
  void c;
  return new StringBuilderJs();
}
export function new_StringBuilder$int(c: Ctx, capacity: number): StringBuilderJs {
  void capacity;
  return new_StringBuilder$(c);
}
export function new_StringBuilder$string(c: Ctx, v: string | null): StringBuilderJs {
  const b = new_StringBuilder$(c);
  b.s = v ?? '';
  return b;
}
export function StringBuilder_Append$string(c: Ctx, b: StringBuilderJs, v: string | null): StringBuilderJs {
  void c;
  b.s += v ?? '';
  return b;
}
export function StringBuilder_Append$char(c: Ctx, b: StringBuilderJs, v: string): StringBuilderJs {
  void c;
  b.s += v;
  return b;
}
export function StringBuilder_Append$int(c: Ctx, b: StringBuilderJs, v: number): StringBuilderJs {
  void c;
  b.s += String(v);
  return b;
}
export function StringBuilder_ToString$(c: Ctx, b: StringBuilderJs): string {
  void c;
  return b.s;
}
export function StringBuilder_get_Length(c: Ctx, b: StringBuilderJs): number {
  void c;
  return b.s.length;
}
/** Length 設小截斷、設大補 \0（C#） */
export function StringBuilder_set_Length(c: Ctx, b: StringBuilderJs, n: number): void {
  void c;
  b.s = n <= b.s.length ? b.s.slice(0, n) : b.s + '\0'.repeat(n - b.s.length);
}
export function StringBuilder_Clear(c: Ctx, b: StringBuilderJs): StringBuilderJs {
  void c;
  b.s = '';
  return b;
}

// ───────── String、Object、Convert ─────────

export function String_get_Item(c: Ctx, s: string, i: number): string {
  void c;
  if (i < 0 || i >= s.length) throw new Error(`C# IndexOutOfRangeException：${i}`);
  return s[i];
}
export function String_get_Length(c: Ctx, s: string): number {
  void c;
  return s.length;
}
export function String_ToString$(c: Ctx, s: string): string {
  void c;
  return s;
}
export function String_IsNullOrEmpty(c: Ctx, s: string | null): boolean {
  void c;
  return s == null || s.length === 0;
}
/** object.ToString()：基本型別照值（float 照 C# 的 "R" 近似：JS 的最短表示），其他照 $type 或類別名 */
export function Object_ToString(c: Ctx, o: unknown): string {
  void c;
  if (o == null) return '';
  if (o instanceof BoxedEnum) return o.names[o.value] ?? String(o.value);
  if (typeof o === 'boolean') return o ? 'True' : 'False';
  if (typeof o !== 'object') return String(o);
  // StringBuilder.ToString：內容（插值字串 $"… {sb}" 走這裡，以前是「[object Object]」）
  if (o instanceof StringBuilderJs) return o.s;
  // 產生類別覆寫了 ToString：照實體的實際類別分派
  const ts = objectOverride(o, 'ToString');
  if (ts) return (ts() as string | null) ?? '';
  const ext = externalValueType(o)?.format;
  if (ext) return ext(o);
  // UnityEngine.Object：「名字 (型別)」
  if (o instanceof H) return `${o.node.go.m_Name} (${o.kind === 'go' ? 'UnityEngine.GameObject' : o.kind === 'transform' ? 'UnityEngine.Transform' : (o.comp?.script?.class ?? o.comp?.type)})`;
  const r = o as { $type?: string; $asset?: string; m_Name?: string };
  if (r.$asset) return `${r.m_Name ?? ''} (${r.$type})`;
  return r.$type ?? Object.prototype.toString.call(o);
}
/** object.ToString／ValueType.ToString 的基底版（覆寫裡的 base.ToString()）：型別名 */
export const base_Object_ToString = (_c: Ctx, self: unknown): string => ((self as { $type?: string } | null)?.$type ?? 'System.Object');
export const base_ValueType_ToString = base_Object_ToString;
export const ValueType_ToString = (c: Ctx, o: unknown): string => Object_ToString(c, o);
/** static object.Equals(a, b)：同一個、或都不是 null 且 a.Equals(b) */
export function Object_Equals$Object_Object(c: Ctx, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return Object_Equals$Object(c, a, b);
}
const hashIds = new WeakMap<object, number>();
let hashSeq = 1;
function identityHash(o: object): number {
  const key = o instanceof H ? (o.comp ?? o.node) : o;
  let v = hashIds.get(key);
  if (!v) hashIds.set(key, (v = hashSeq++));
  return v;
}
/** ValueType.GetHashCode：照欄位算（跟 valueEquals 一致：相等的結構同一個數字；參照型別的欄位照身分） */
function valueHash(c: Ctx, o: Record<string, unknown>): number {
  let h = 17;
  for (const k of Object.keys(o)) h = (Math.imul(h, 31) + Object_GetHashCode(c, o[k])) | 0;
  return h;
}
export const base_ValueType_GetHashCode = (c: Ctx, self: unknown): number => (isValueObj(self) ? valueHash(c, self) : Object_GetHashCode(c, self));
export const base_Object_GetHashCode = (c: Ctx, self: unknown): number => (self && typeof self === 'object' ? identityHash(self) : Object_GetHashCode(c, self));
export const ValueType_GetHashCode = (c: Ctx, o: unknown): number => Object_GetHashCode(c, o);
/**
 * object.GetHashCode()：數字照值、字串照內容（同一個字串同一個數字）；產生類別覆寫了 GetHashCode 照它；
 * 值型別（結構、Vector3 這類一般物件）照欄位；其他物件照身分（同一個物件同一個數字）
 */
export function Object_GetHashCode(c: Ctx, o: unknown): number {
  if (o == null) return 0;
  if (typeof o === 'number') return Number.isInteger(o) ? o | 0 : Math.fround(o) * 1000003 | 0;
  if (typeof o === 'boolean') return o ? 1 : 0;
  if (typeof o === 'string') {
    let h = 0;
    for (let i = 0; i < o.length; i++) h = (Math.imul(h, 31) + o.charCodeAt(i)) | 0;
    return h;
  }
  if (o instanceof BoxedEnum) return o.value | 0;
  if (typeof o !== 'object') return 0;
  const gh = objectOverride(o, 'GetHashCode');
  if (gh) return gh() | 0;
  const vh = externalValueType(o)?.hash;
  if (vh) return vh(o) | 0;
  if (isValueObj(o)) return valueHash(c, o);
  return identityHash(o);
}
/** object.GetType()：型別名字串（Type 的比較與 Name 用） */
export function Object_GetType(c: Ctx, o: unknown): string {
  void c;
  if (o instanceof BoxedEnum) return o.type;
  if (o && typeof o === 'object') {
    const t = (o as { $type?: string }).$type;
    if (t) return t;
    const comp = (o as { comp?: { script?: { class?: string }; type?: string } | null }).comp;
    if (comp) return comp.script?.class ?? comp.type ?? 'Object';
  }
  return typeof o === 'string' ? 'String' : typeof o === 'number' ? 'Int32' : typeof o === 'boolean' ? 'Boolean' : 'Object';
}
export function Type_op_Equality(c: Ctx, a: string | null, b: string | null): boolean {
  void c;
  return a === b;
}
export function Type_op_Inequality(c: Ctx, a: string | null, b: string | null): boolean {
  void c;
  return a !== b;
}
/** Type.IsEnum：列舉的名字表（registerEnums）有它，或裝箱過的列舉回傳的型別（Object_GetType） */
const enumTypes = new Set<string>();
/** 列舉型別名（反射的 IsValueType 用） */
export const ENUM_TYPES: ReadonlySet<string> = enumTypes;
setEnumTypeCheck(
  (t) => enumTypes.has(t),
  (t) => (enumTypes.has(t) ? (ENUMS[t]?.kind ?? 'i32') : null),
);
export function Type_get_IsEnum(c: Ctx, t: string): boolean {
  void c;
  return enumTypes.has(t);
}
/** Type.Name：泛型是 "名字`個數"（List<int> → List`1） */
export function Type_get_Name(c: Ctx, t: string): string {
  void c;
  const b = t.replace(/<.*>$/, '');
  return b.replace(/\$(\d+)$/, '`$1');
}
/** Convert.ToUInt32(object)：數值（列舉值也是數字）轉 uint，超出範圍丟 OverflowException */
export function Convert_ToUInt32$Object(c: Ctx, v: unknown): number {
  void c;
  const n = typeof v === 'string' ? Number(v) : Number(v ?? 0); // BoxedEnum 照 valueOf
  if (!Number.isFinite(n) || n < 0 || n > 4294967295) throw new Error(`C# OverflowException：Convert.ToUInt32(${String(v)})`);
  return Math.round(n) >>> 0;
}
export function Convert_ToInt32$Object(c: Ctx, v: unknown): number {
  void c;
  return Math.round(Number(v ?? 0)) | 0;
}
/** Array.GetValue(i)（System.Array） */
export function Array_GetValue$int(c: Ctx, a: unknown[], i: number): unknown {
  void c;
  return a[i];
}

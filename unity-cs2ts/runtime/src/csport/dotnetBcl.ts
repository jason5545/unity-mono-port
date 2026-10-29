// 相容層：.NET 基礎類別庫的常用部分（字串、格式化、數字、Nullable、集合、排序、DateTime／TimeSpan、Path、Regex、Convert、
// Char、StringBuilder、HashCode、Guid、Stopwatch、Activator…）。dotnet.ts 會 export * 這裡。
//
// TS 這邊的樣子：string 是 JS 字串、char 是一個字的字串；List／HashSet／Queue／Stack 是 JS 陣列；Dictionary 是 Map；
// Nullable<T> 是值或 null；KeyValuePair 是 { Key, Value }；out 參數是設值的回呼；ref 參數是 { v } 盒子（get／set）；
// params 是陣列。行為照 Unity 用的 Mono（.NET Framework 的 referencesource）：排序是同一套 introsort（同值元素的順序跟原版一樣），
// float.ToString() 是 G7、double 是 G15（Mono 的預設，不是 .NET Core 3 之後的最短表示）。

import { BoxedEnum, csException, hasValueEquality, new_StringBuilder$, new_StringBuilder$string, Object_Equals$Object_Object } from './dotnet';
import { cloneData, genCallVirtual, genMethodOf, getActiveWorld, H, hasGen, invokeDelegate, newGen, registerExternalCtor, staticCtx, type Ctx } from './core';

type Ref<T> = { v: T };
type Out<T> = (v: T) => void;
const csErr = (type: string, msg: string): Error => Object.assign(new Error(`C# ${type}：${msg}`), { name: type });

// ───────── 比較（Comparer<T>.Default、排序） ─────────

/** Comparer<T>.Default.Compare：數字、字串（文化相關的比較，近似 en-US）、列舉、bool、IComparable（產生的 CompareTo） */
const collator = typeof Intl !== 'undefined' ? new Intl.Collator('en-US') : null;
export function defaultCompare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' || a instanceof BoxedEnum) {
    const x = Number(a);
    const y = Number(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === 'string') return collator ? Math.sign(collator.compare(a, b as string)) : a < (b as string) ? -1 : 1;
  if (typeof a === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  const t = (a as { $type?: string }).$type;
  if (t && hasGen(t)) {
    const m = genMethodOf(t, 'CompareTo') ? 'CompareTo' : genMethodOf(t, 'IComparable$1$CompareTo') ? 'IComparable$1$CompareTo' : genMethodOf(t, 'IComparable$CompareTo') ? 'IComparable$CompareTo' : null;
    if (m) return genCallVirtual(getActiveWorld(), t, a as object, m, b);
  }
  throw csErr('InvalidOperationException', `比較不了 ${t ?? typeof a}（沒有 IComparable）`);
}
type Cmp = (a: unknown, b: unknown) => number;
/** IComparer 物件（產生的類別，Compare 方法）或 Comparison 委派 → 比較函式 */
function toCmp(c: Ctx, cmp: unknown): Cmp {
  if (cmp == null) return defaultCompare;
  if (typeof cmp === 'function') return (a, b) => invokeDelegate(c, cmp, a, b) as number;
  if (cmp === ORDINAL || cmp === ORDINAL_IGNORE_CASE) return (a, b) => String_CompareOrdinal(c, cmp === ORDINAL_IGNORE_CASE ? String(a).toUpperCase() : (a as string), cmp === ORDINAL_IGNORE_CASE ? String(b).toUpperCase() : (b as string));
  if (cmp === DEFAULT_COMPARER) return defaultCompare;
  const t = (cmp as { $type?: string }).$type;
  if (t && hasGen(t)) {
    const m = genMethodOf(t, 'Compare') ? 'Compare' : 'IComparer$1$Compare';
    return (a, b) => genCallVirtual(getActiveWorld(), t, cmp as object, m, a, b) as number;
  }
  throw csErr('ArgumentException', '不認得的 IComparer');
}
/**
 * .NET（referencesource 的 ArraySortHelper<T>）的 introsort：keys[lo..hi]。List.Sort、Array.Sort 都是這個，
 * 不穩定排序，同值元素的順序要照它才跟原版一樣。
 */
export function introSort(keys: unknown[], lo: number, length: number, cmp: Cmp): void {
  if (length < 2) return;
  let bits = 0;
  for (let n = keys.length; n >= 1; n = Math.floor(n / 2)) bits++;
  introSortRange(keys, lo, lo + length - 1, 2 * bits, cmp);
}
function swapIfGreater(k: unknown[], cmp: Cmp, a: number, b: number): void {
  if (a !== b && cmp(k[a], k[b]) > 0) {
    const t = k[a];
    k[a] = k[b];
    k[b] = t;
  }
}
function swap(k: unknown[], i: number, j: number): void {
  if (i === j) return;
  const t = k[i];
  k[i] = k[j];
  k[j] = t;
}
function introSortRange(k: unknown[], lo: number, hi: number, depthLimit: number, cmp: Cmp): void {
  while (hi > lo) {
    const size = hi - lo + 1;
    if (size <= 16) {
      if (size === 1) return;
      if (size === 2) {
        swapIfGreater(k, cmp, lo, hi);
        return;
      }
      if (size === 3) {
        swapIfGreater(k, cmp, lo, hi - 1);
        swapIfGreater(k, cmp, lo, hi);
        swapIfGreater(k, cmp, hi - 1, hi);
        return;
      }
      for (let i = lo; i < hi; i++) {
        let j = i;
        const t = k[i + 1];
        while (j >= lo && cmp(t, k[j]) < 0) {
          k[j + 1] = k[j];
          j--;
        }
        k[j + 1] = t;
      }
      return;
    }
    if (depthLimit === 0) {
      heapSort(k, lo, hi, cmp);
      return;
    }
    depthLimit--;
    const mid = lo + ((hi - lo) >> 1);
    swapIfGreater(k, cmp, lo, mid);
    swapIfGreater(k, cmp, lo, hi);
    swapIfGreater(k, cmp, mid, hi);
    const pivot = k[mid];
    swap(k, mid, hi - 1);
    let left = lo;
    let right = hi - 1;
    while (left < right) {
      while (cmp(k[++left], pivot) < 0);
      while (cmp(pivot, k[--right]) < 0);
      if (left >= right) break;
      swap(k, left, right);
    }
    swap(k, left, hi - 1);
    introSortRange(k, left + 1, hi, depthLimit, cmp);
    hi = left - 1;
  }
}
function heapSort(k: unknown[], lo: number, hi: number, cmp: Cmp): void {
  const n = hi - lo + 1;
  for (let i = Math.floor(n / 2); i >= 1; i--) downHeap(k, i, n, lo, cmp);
  for (let i = n; i > 1; i--) {
    swap(k, lo, lo + i - 1);
    downHeap(k, 1, i - 1, lo, cmp);
  }
}
function downHeap(k: unknown[], i: number, n: number, lo: number, cmp: Cmp): void {
  const d = k[lo + i - 1];
  while (i <= Math.floor(n / 2)) {
    let child = 2 * i;
    if (child < n && cmp(k[lo + child - 1], k[lo + child]) < 0) child++;
    if (!(cmp(d, k[lo + child - 1]) < 0)) break;
    k[lo + i - 1] = k[lo + child - 1];
    i = child;
  }
  k[lo + i - 1] = d;
}
const DEFAULT_COMPARER = { $type: 'Comparer', name: 'Default' };
export function Comparer_get_Default(c: Ctx): object {
  void c;
  return DEFAULT_COMPARER;
}
export function Comparer_Compare(c: Ctx, cmp: unknown, a: unknown, b: unknown): number {
  return toCmp(c, cmp)(a, b);
}
export function Comparer_Create(c: Ctx, comparison: unknown): unknown {
  void c;
  return comparison;
}

// ───────── List<T>（JS 陣列） ─────────

export function List_Sort$(c: Ctx, list: unknown[]): void {
  void c;
  introSort(list, 0, list.length, defaultCompare);
}
export function List_Sort$Comparison(c: Ctx, list: unknown[], comparison: unknown): void {
  introSort(list, 0, list.length, toCmp(c, comparison));
}
export function List_Sort$IComparer(c: Ctx, list: unknown[], comparer: unknown): void {
  introSort(list, 0, list.length, toCmp(c, comparer));
}
export function List_Sort$int_int_IComparer(c: Ctx, list: unknown[], index: number, count: number, comparer: unknown): void {
  introSort(list, index, count, toCmp(c, comparer));
}
export function Array_Sort$T_arr(c: Ctx, a: unknown[]): void {
  List_Sort$(c, a);
}
export const Array_Sort$Array = Array_Sort$T_arr;
export function Array_Sort$T_arr_Comparison(c: Ctx, a: unknown[], comparison: unknown): void {
  List_Sort$Comparison(c, a, comparison);
}
export function Array_Sort$T_arr_IComparer(c: Ctx, a: unknown[], comparer: unknown): void {
  List_Sort$IComparer(c, a, comparer);
}
export function Array_Sort$T_arr_int_int(c: Ctx, a: unknown[], index: number, count: number): void {
  void c;
  introSort(a, index, count, defaultCompare);
}
const pred = (c: Ctx, p: unknown) => (x: unknown): boolean => !!invokeDelegate(c, p, x);
export function List_Find(c: Ctx, list: unknown[], p: unknown): unknown {
  const f = pred(c, p);
  for (const x of list) if (f(x)) return x;
  return null;
}
export function List_FindLast(c: Ctx, list: unknown[], p: unknown): unknown {
  const f = pred(c, p);
  for (let i = list.length - 1; i >= 0; i--) if (f(list[i])) return list[i];
  return null;
}
export function List_FindAll(c: Ctx, list: unknown[], p: unknown): unknown[] {
  return list.filter(pred(c, p));
}
export function List_FindIndex$Predicate(c: Ctx, list: unknown[], p: unknown): number {
  return list.findIndex(pred(c, p));
}
export function List_FindIndex$int_Predicate(c: Ctx, list: unknown[], start: number, p: unknown): number {
  const f = pred(c, p);
  for (let i = start; i < list.length; i++) if (f(list[i])) return i;
  return -1;
}
export function List_FindLastIndex$Predicate(c: Ctx, list: unknown[], p: unknown): number {
  const f = pred(c, p);
  for (let i = list.length - 1; i >= 0; i--) if (f(list[i])) return i;
  return -1;
}
export function List_Exists(c: Ctx, list: unknown[], p: unknown): boolean {
  return list.some(pred(c, p));
}
export function List_TrueForAll(c: Ctx, list: unknown[], p: unknown): boolean {
  return list.every(pred(c, p));
}
/** RemoveAll：照順序留下不符合的，回傳拿掉幾個 */
export function List_RemoveAll(c: Ctx, list: unknown[], p: unknown): number {
  const f = pred(c, p);
  const keep = list.filter((x) => !f(x));
  const n = list.length - keep.length;
  list.length = 0;
  list.push(...keep);
  return n;
}
export function List_RemoveRange(c: Ctx, list: unknown[], index: number, count: number): void {
  void c;
  if (index < 0 || count < 0 || index + count > list.length) throw csErr('ArgumentException', 'List.RemoveRange 超出範圍');
  list.splice(index, count);
}
export function List_InsertRange(c: Ctx, list: unknown[], index: number, items: Iterable<unknown>): void {
  void c;
  list.splice(index, 0, ...items);
}
export function List_GetRange(c: Ctx, list: unknown[], index: number, count: number): unknown[] {
  void c;
  if (index < 0 || count < 0 || index + count > list.length) throw csErr('ArgumentException', 'List.GetRange 超出範圍');
  return list.slice(index, index + count);
}
export function List_LastIndexOf$T(c: Ctx, list: unknown[], x: unknown): number {
  void c;
  return list.lastIndexOf(x);
}
export function List_IndexOf$T_int(c: Ctx, list: unknown[], x: unknown, start: number): number {
  void c;
  return list.indexOf(x, start);
}
export function List_CopyTo$T_arr_int(c: Ctx, list: unknown[], arr: unknown[], index: number): void {
  void c;
  for (let i = 0; i < list.length; i++) arr[index + i] = list[i];
}
export function List_CopyTo$T_arr(c: Ctx, list: unknown[], arr: unknown[]): void {
  List_CopyTo$T_arr_int(c, list, arr, 0);
}
export function List_AsReadOnly(c: Ctx, list: unknown[]): unknown[] {
  void c;
  return list;
}
// ReadOnlyCollection<T>（List.AsReadOnly 的結果）：就是那個 List 的陣列本身，只讀不改
export function new_ReadOnlyCollection$IList(c: Ctx, list: unknown[]): unknown[] {
  void c;
  return list;
}
export const ReadOnlyCollection_toArray = (_c: Ctx, list: unknown[]): unknown[] => list;
export const ReadOnlyCollection_get_Count = (_c: Ctx, list: unknown[]): number => list.length;
export function ReadOnlyCollection_get_Item(c: Ctx, list: unknown[], i: number): unknown {
  void c;
  if (!(i >= 0 && i < list.length)) throw csErr('ArgumentOutOfRangeException', 'Index was out of range. Must be non-negative and less than the size of the collection.');
  return list[i];
}
/** Contains／IndexOf 跟 List 一樣用 EqualityComparer<T>.Default（覆寫了 Equals 的類別、結構照 C# 的 Equals） */
export const ReadOnlyCollection_Contains = (c: Ctx, list: unknown[], x: unknown): boolean => setIndexOf(c, list, x) >= 0;
export const ReadOnlyCollection_IndexOf = (c: Ctx, list: unknown[], x: unknown): number => setIndexOf(c, list, x);
export function List_get_Capacity(c: Ctx, list: unknown[]): number {
  void c;
  return Math.max(list.length, (list as { $cap?: number }).$cap ?? 0);
}
export function List_set_Capacity(c: Ctx, list: unknown[], v: number): void {
  void c;
  (list as { $cap?: number }).$cap = v;
}
export function List_TrimExcess(c: Ctx, list: unknown[]): void {
  void c;
  void list;
}
export function List_ConvertAll(c: Ctx, list: unknown[], conv: unknown): unknown[] {
  return list.map((x) => invokeDelegate(c, conv, x));
}
export function List_ForEach(c: Ctx, list: unknown[], action: unknown): void {
  for (const x of [...list]) invokeDelegate(c, action, x);
}
export function List_BinarySearch$T(c: Ctx, list: unknown[], x: unknown): number {
  void c;
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const m = lo + ((hi - lo) >> 1);
    const r = defaultCompare(list[m], x);
    if (r === 0) return m;
    if (r < 0) lo = m + 1;
    else hi = m - 1;
  }
  return ~lo;
}
/** List.GetEnumerator()：手動走（while (e.MoveNext()) e.Current） */
class ListEnumerator {
  i = -1;
  constructor(readonly list: unknown[]) {}
  /** 經由 IEnumerator 介面走的時候（IEnumerator_MoveNext／get_Current） */
  moveNext(): boolean {
    return ++this.i < this.list.length;
  }
  get current(): unknown {
    return this.list[this.i];
  }
}
export function List_GetEnumerator(c: Ctx, list: unknown[]): ListEnumerator {
  void c;
  return new ListEnumerator(list);
}
export function List_Enumerator_MoveNext(c: Ctx, e: ListEnumerator): boolean {
  void c;
  return ++e.i < e.list.length;
}
export function List_Enumerator_get_Current(c: Ctx, e: ListEnumerator): unknown {
  void c;
  return e.list[e.i];
}
export function List_Enumerator_Dispose(c: Ctx, e: ListEnumerator): void {
  void c;
  void e;
}
export function List_toArray(c: Ctx, list: unknown[]): unknown[] {
  void c;
  return list;
}
export function new_List$int(c: Ctx, n: number): unknown[] {
  void c;
  void n;
  return [];
}
export function new_List$(c: Ctx): unknown[] {
  void c;
  return [];
}
export function new_List$IEnumerable(c: Ctx, src: Iterable<unknown>): unknown[] {
  void c;
  return [...(src ?? [])];
}
/** Remove(x)：拿掉第一個（Equals 相同；值型別照欄位），回傳有沒有拿到 */
/** List.Remove：第一個相等的（EqualityComparer<T>.Default：覆寫的 Equals、結構照值） */
export function listRemove(c: Ctx, list: unknown[], x: unknown): boolean {
  const i = setIndexOf(c, list, x);
  if (i < 0) return false;
  list.splice(i, 1);
  return true;
}
/** List.IndexOf／Contains（元素不是數字、字串時轉換器寫這個）：照 C# 的相等 */
export const listIndexOf = (c: Ctx, list: unknown[], x: unknown): number => setIndexOf(c, list, x);
export const listContains = (c: Ctx, list: Iterable<unknown>, x: unknown): boolean => setIndexOf(c, Array.isArray(list) ? list : [...list], x) >= 0;

// ───────── 陣列 ─────────

export function Array_Empty(c: Ctx): unknown[] {
  void c;
  return [];
}
export function Array_IndexOf$T_arr_T(c: Ctx, a: unknown[], x: unknown): number {
  void c;
  return a.indexOf(x);
}
export const Array_IndexOf$Array_Object = Array_IndexOf$T_arr_T;
export function Array_LastIndexOf$T_arr_T(c: Ctx, a: unknown[], x: unknown): number {
  void c;
  return a.lastIndexOf(x);
}
export function Array_Exists(c: Ctx, a: unknown[], p: unknown): boolean {
  return a.some(pred(c, p));
}
export function Array_Find(c: Ctx, a: unknown[], p: unknown): unknown {
  return List_Find(c, a, p);
}
export function Array_FindAll(c: Ctx, a: unknown[], p: unknown): unknown[] {
  return a.filter(pred(c, p));
}
export function Array_FindIndex$T_arr_Predicate(c: Ctx, a: unknown[], p: unknown): number {
  return a.findIndex(pred(c, p));
}
export function Array_TrueForAll(c: Ctx, a: unknown[], p: unknown): boolean {
  return a.every(pred(c, p));
}
export function Array_ForEach(c: Ctx, a: unknown[], action: unknown): void {
  for (const x of a) invokeDelegate(c, action, x);
}
export function Array_Clear(c: Ctx, a: unknown[], index: number, length: number): void {
  void c;
  for (let i = index; i < index + length; i++) a[i] = defaultLike(a[i]);
}
/** 清成預設值：數字 0、bool false、字串與物件 null（值型別的結構清成全 0 近似：數字欄位歸零） */
function defaultLike(v: unknown): unknown {
  if (typeof v === 'number') return 0;
  if (typeof v === 'boolean') return false;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && !('$type' in v)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = defaultLike(x);
    return o;
  }
  return null;
}
export function Array_Copy$Array_int_Array_int_int(c: Ctx, src: unknown[], si: number, dst: unknown[], di: number, n: number): void {
  void c;
  if (src === dst && si < di) for (let i = n - 1; i >= 0; i--) dst[di + i] = src[si + i];
  else for (let i = 0; i < n; i++) dst[di + i] = src[si + i];
}
export const Array_ConstrainedCopy = Array_Copy$Array_int_Array_int_int;
export function Array_CopyTo$Array_int(c: Ctx, src: unknown[], dst: unknown[], index: number): void {
  void c;
  for (let i = 0; i < src.length; i++) dst[index + i] = src[i];
}
export function Array_Clone(c: Ctx, a: unknown[]): unknown[] {
  void c;
  return [...a];
}
/** Array.Resize(ref a, n)：新格子是 default(T)。轉換器（工具包模式）把 default(T) 接在後面，每格複製一份；沒給時照第一個元素猜 */
export function Array_Resize(c: Ctx, ref: Ref<unknown[] | null>, n: number, ...def: unknown[]): void {
  void c;
  const old = ref.v ?? [];
  const sample = old[0];
  const out = old.slice(0, n);
  while (out.length < n) out.push(def.length > 0 ? cloneData(def[0]) : sample === undefined ? null : defaultLike(sample));
  ref.v = out;
}
export function Array_Reverse$Array(c: Ctx, a: unknown[]): void {
  void c;
  a.reverse();
}
export function Array_get_Rank(c: Ctx, a: unknown[]): number {
  void c;
  void a;
  return 1;
}
export function Array_GetLength(c: Ctx, a: unknown[], dim: number): number {
  void c;
  void dim;
  return a.length;
}
export function Array_BinarySearch$T_arr_T(c: Ctx, a: unknown[], x: unknown): number {
  return List_BinarySearch$T(c, a, x);
}

// ───────── HashSet<T>、Queue<T>、Stack<T>（JS 陣列） ─────────

/** HashSet 的相等（EqualityComparer<T>.Default）：字串、數字照值；覆寫了 Equals 的產生類別、結構照 C# 的 Equals；其他照參照 */
function setIndexOf(c: Ctx, s: unknown[], x: unknown): number {
  if (x == null || typeof x !== 'object' || !hasValueEquality(x)) return s.indexOf(x);
  for (let i = 0; i < s.length; i++) if (s[i] === x || Object_Equals$Object_Object(c, s[i], x)) return i;
  return -1;
}
const setHas = (c: Ctx, s: unknown[], x: unknown): boolean => setIndexOf(c, s, x) >= 0;
function distinct(c: Ctx, src: Iterable<unknown>): unknown[] {
  const out: unknown[] = [];
  for (const x of src ?? []) if (!setHas(c, out, x)) out.push(x);
  return out;
}
export function HashSet_Add(c: Ctx, s: unknown[], x: unknown): boolean {
  if (setHas(c, s, x)) return false;
  s.push(x);
  return true;
}
export function HashSet_Contains(c: Ctx, s: unknown[], x: unknown): boolean {
  return setHas(c, s, x);
}
export function HashSet_Remove(c: Ctx, s: unknown[], x: unknown): boolean {
  const i = setIndexOf(c, s, x);
  if (i < 0) return false;
  s.splice(i, 1);
  return true;
}
export function HashSet_Clear(c: Ctx, s: unknown[]): void {
  void c;
  s.length = 0;
}
export function HashSet_get_Count(c: Ctx, s: unknown[]): number {
  void c;
  return s.length;
}
export function HashSet_toArray(c: Ctx, s: unknown[]): unknown[] {
  void c;
  return s;
}
export function HashSet_UnionWith(c: Ctx, s: unknown[], other: Iterable<unknown>): void {
  for (const x of other ?? []) if (!setHas(c, s, x)) s.push(x);
}
export function HashSet_ExceptWith(c: Ctx, s: unknown[], other: Iterable<unknown>): void {
  const o = [...(other ?? [])];
  const keep = s.filter((x) => !setHas(c, o, x));
  s.length = 0;
  s.push(...keep);
}
export function HashSet_IntersectWith(c: Ctx, s: unknown[], other: Iterable<unknown>): void {
  const o = [...(other ?? [])];
  const keep = s.filter((x) => setHas(c, o, x));
  s.length = 0;
  s.push(...keep);
}
export function HashSet_RemoveWhere(c: Ctx, s: unknown[], p: unknown): number {
  return List_RemoveAll(c, s, p);
}
export function HashSet_SetEquals(c: Ctx, s: unknown[], other: Iterable<unknown>): boolean {
  const o = distinct(c, other);
  return o.length === s.length && o.every((x) => setHas(c, s, x));
}
export function HashSet_IsSubsetOf(c: Ctx, s: unknown[], other: Iterable<unknown>): boolean {
  const o = [...(other ?? [])];
  return s.every((x) => setHas(c, o, x));
}
export function HashSet_IsSupersetOf(c: Ctx, s: unknown[], other: Iterable<unknown>): boolean {
  return [...(other ?? [])].every((x) => setHas(c, s, x));
}
export function HashSet_Overlaps(c: Ctx, s: unknown[], other: Iterable<unknown>): boolean {
  return [...(other ?? [])].some((x) => setHas(c, s, x));
}
export function HashSet_CopyTo$T_arr(c: Ctx, s: unknown[], a: unknown[]): void {
  List_CopyTo$T_arr_int(c, s, a, 0);
}
export function new_HashSet$(c: Ctx): unknown[] {
  void c;
  return [];
}
export function new_HashSet$IEnumerable(c: Ctx, src: Iterable<unknown>): unknown[] {
  return distinct(c, src);
}
export function new_Queue$(c: Ctx): unknown[] {
  void c;
  return [];
}
export const new_Queue$int = new_Queue$;
export function new_Queue$IEnumerable(c: Ctx, src: Iterable<unknown>): unknown[] {
  void c;
  return [...(src ?? [])];
}
export function Queue_Enqueue(c: Ctx, q: unknown[], x: unknown): void {
  void c;
  q.push(x);
}
export function Queue_Dequeue(c: Ctx, q: unknown[]): unknown {
  void c;
  if (!q.length) throw csErr('InvalidOperationException', 'Queue empty.');
  return q.shift();
}
export function Queue_TryDequeue(c: Ctx, q: unknown[], out: Out<unknown>): boolean {
  void c;
  if (!q.length) {
    out(null);
    return false;
  }
  out(q.shift());
  return true;
}
export function Queue_Peek(c: Ctx, q: unknown[]): unknown {
  void c;
  if (!q.length) throw csErr('InvalidOperationException', 'Queue empty.');
  return q[0];
}
export function Queue_TryPeek(c: Ctx, q: unknown[], out: Out<unknown>): boolean {
  void c;
  out(q.length ? q[0] : null);
  return q.length > 0;
}
export function Queue_get_Count(c: Ctx, q: unknown[]): number {
  void c;
  return q.length;
}
export function Queue_Clear(c: Ctx, q: unknown[]): void {
  void c;
  q.length = 0;
}
export function Queue_Contains(c: Ctx, q: unknown[], x: unknown): boolean {
  void c;
  return q.includes(x);
}
export function Queue_toArray(c: Ctx, q: unknown[]): unknown[] {
  void c;
  return q;
}
export function Queue_ToArray(c: Ctx, q: unknown[]): unknown[] {
  void c;
  return [...q];
}
/**
 * Stack<T>：陣列尾端是頂端（Push／Pop／Peek 照陣列）。.NET 列舉 Stack 是從頂端往底（後進先出），ToArray 也是。
 * Stack 當 IEnumerable 傳出去時（AddRange 產生的 push(...s)、new List(s)、LINQ）照 iterator 走，所以 iterator 反著列舉；
 * map／filter／slice 照索引、產生一般陣列（Symbol.species）。
 * 以前是一般陣列：ink 的 Object.path 把路徑一段段 Push 進 Stack 再 new Path(stack)，路徑整串反過來（'c-0.0.PenanceFields'），
 * MT2 的故事事件選完選項就 StoryException
 */
export class CsStack<T = unknown> extends Array<T> {
  static get [Symbol.species](): ArrayConstructor {
    return Array;
  }
}
Object.defineProperty(CsStack.prototype, Symbol.iterator, {
  value: function* (this: unknown[]) {
    for (let i = this.length - 1; i >= 0; i--) yield this[i];
  },
  writable: true,
  configurable: true,
});
export function new_Stack$(c: Ctx): unknown[] {
  void c;
  return new CsStack();
}
export const new_Stack$int = new_Stack$;
/** new Stack<T>(IEnumerable<T>)：照列舉順序一個個 Push，最後一個在頂端（陣列尾端） */
export function new_Stack$IEnumerable(c: Ctx, src: Iterable<unknown>): unknown[] {
  void c;
  const s = new CsStack();
  for (const x of src ?? []) s.push(x);
  return s;
}
export function Stack_Push(c: Ctx, s: unknown[], x: unknown): void {
  void c;
  s.push(x);
}
export function Stack_Pop(c: Ctx, s: unknown[]): unknown {
  void c;
  if (!s.length) throw csErr('InvalidOperationException', 'Stack empty.');
  return s.pop();
}
export function Stack_TryPop(c: Ctx, s: unknown[], out: Out<unknown>): boolean {
  void c;
  if (!s.length) {
    out(null);
    return false;
  }
  out(s.pop());
  return true;
}
export function Stack_Peek(c: Ctx, s: unknown[]): unknown {
  void c;
  if (!s.length) throw csErr('InvalidOperationException', 'Stack empty.');
  return s[s.length - 1];
}
export function Stack_TryPeek(c: Ctx, s: unknown[], out: Out<unknown>): boolean {
  void c;
  out(s.length ? s[s.length - 1] : null);
  return s.length > 0;
}
export function Stack_get_Count(c: Ctx, s: unknown[]): number {
  void c;
  return s.length;
}
export function Stack_Clear(c: Ctx, s: unknown[]): void {
  void c;
  s.length = 0;
}
export function Stack_Contains(c: Ctx, s: unknown[], x: unknown): boolean {
  void c;
  return s.includes(x);
}
/** foreach (x in stack)：從頂端往下（照索引複製再反轉；CsStack 的 iterator 已經是反的，不能用展開） */
export function Stack_toArray(c: Ctx, s: unknown[]): unknown[] {
  void c;
  return Array.prototype.slice.call(s).reverse();
}
export function Stack_ToArray(c: Ctx, s: unknown[]): unknown[] {
  void c;
  return Array.prototype.slice.call(s).reverse();
}

// ───────── KeyValuePair、Tuple ─────────

export function KeyValuePair_get_Key(c: Ctx, kv: { Key: unknown }): unknown {
  void c;
  return kv.Key;
}
export function KeyValuePair_get_Value(c: Ctx, kv: { Value: unknown }): unknown {
  void c;
  return kv.Value;
}
export function new_KeyValuePair(c: Ctx, k: unknown, v: unknown): { Key: unknown; Value: unknown } {
  void c;
  return { Key: k, Value: v };
}
export function KeyValuePair_Deconstruct(c: Ctx, kv: { Key: unknown; Value: unknown }, k: Out<unknown>, v: Out<unknown>): void {
  void c;
  k(kv.Key);
  v(kv.Value);
}
export function Tuple_Create(c: Ctx, ...items: unknown[]): Record<string, unknown> {
  void c;
  const o: Record<string, unknown> = {};
  items.forEach((x, i) => (o[`Item${i + 1}`] = x));
  return o;
}

// ───────── Nullable<T>（值或 null） ─────────

// new bool?(false)（CombatManager.GetTargetCharacters 的 firstEffectInPlayedCard）就是那個值，new int?() 是 null
registerExternalCtor('Nullable', (...a: unknown[]) => (a.length ? a[0] : null) as object);

export function Nullable_get_HasValue(c: Ctx, v: unknown): boolean {
  void c;
  return v != null;
}
export function Nullable_get_Value(c: Ctx, v: unknown): unknown {
  void c;
  if (v == null) throw csErr('InvalidOperationException', 'Nullable object must have a value.');
  return v;
}
export function Nullable_GetValueOrDefault$(c: Ctx, v: unknown): unknown {
  void c;
  return v ?? 0;
}
export function Nullable_GetValueOrDefault$T(c: Ctx, v: unknown, d: unknown): unknown {
  void c;
  return v ?? d;
}
export function Nullable_ToString(c: Ctx, v: unknown): string {
  return v == null ? '' : formatValue(c, v);
}
export function Nullable_Equals(c: Ctx, a: unknown, b: unknown): boolean {
  void c;
  return a === b || (a == null && b == null);
}

// ───────── 字串 ─────────

export function String_Contains$string(c: Ctx, s: string, v: string): boolean {
  void c;
  if (v == null) throw csErr('ArgumentNullException', 'value');
  return s.includes(v);
}
export const String_Contains$Char = String_Contains$string;
export function String_Contains$string_StringComparison(c: Ctx, s: string, v: string, cmp: number): boolean {
  void c;
  return ignoreCase(cmp) ? s.toLowerCase().includes(v.toLowerCase()) : s.includes(v);
}
/** StringComparison：CurrentCultureIgnoreCase 1、InvariantCultureIgnoreCase 3、OrdinalIgnoreCase 5 */
function ignoreCase(cmp: number): boolean {
  return cmp === 1 || cmp === 3 || cmp === 5;
}
function checkRange(s: string, start: number, len: number): void {
  if (start < 0 || len < 0 || start + len > s.length) throw csErr('ArgumentOutOfRangeException', `Substring(${start}, ${len})：字串長度 ${s.length}`);
}
export function String_Substring$int(c: Ctx, s: string, start: number): string {
  void c;
  checkRange(s, start, s.length - start);
  return s.substring(start);
}
export function String_Substring$int_int(c: Ctx, s: string, start: number, len: number): string {
  void c;
  checkRange(s, start, len);
  return s.substr(start, len);
}
export function String_StartsWith$string(c: Ctx, s: string, v: string): boolean {
  void c;
  return s.startsWith(v);
}
export function String_StartsWith$string_StringComparison(c: Ctx, s: string, v: string, cmp: number): boolean {
  void c;
  return ignoreCase(cmp) ? s.toLowerCase().startsWith(v.toLowerCase()) : s.startsWith(v);
}
export function String_StartsWith$string_bool_CultureInfo(c: Ctx, s: string, v: string, ic: boolean): boolean {
  void c;
  return ic ? s.toLowerCase().startsWith(v.toLowerCase()) : s.startsWith(v);
}
export function String_StartsWith$Char(c: Ctx, s: string, v: string): boolean {
  void c;
  return s.startsWith(v);
}
export function String_EndsWith$string(c: Ctx, s: string, v: string): boolean {
  void c;
  return s.endsWith(v);
}
export const String_EndsWith$Char = String_EndsWith$string;
export function String_EndsWith$string_StringComparison(c: Ctx, s: string, v: string, cmp: number): boolean {
  void c;
  return ignoreCase(cmp) ? s.toLowerCase().endsWith(v.toLowerCase()) : s.endsWith(v);
}
const WS = ' \t\n\r\v\f   ﻿              　\u0085';
function trimChars(s: string, chars: string, start: boolean, end: boolean): string {
  let a = 0;
  let b = s.length;
  if (start) while (a < b && chars.includes(s[a])) a++;
  if (end) while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
export function String_Trim$(c: Ctx, s: string): string {
  void c;
  return trimChars(s, WS, true, true);
}
export function String_Trim$Char_arr(c: Ctx, s: string, chars: string[]): string {
  void c;
  return trimChars(s, chars && chars.length ? chars.join('') : WS, true, true);
}
export const String_Trim$Char = (_c: Ctx, s: string, ch: string): string => trimChars(s, ch, true, true);
export function String_TrimStart$(c: Ctx, s: string): string {
  void c;
  return trimChars(s, WS, true, false);
}
export function String_TrimStart$Char_arr(c: Ctx, s: string, chars: string[]): string {
  void c;
  return trimChars(s, chars && chars.length ? chars.join('') : WS, true, false);
}
export const String_TrimStart$Char = (_c: Ctx, s: string, ch: string): string => trimChars(s, ch, true, false);
export function String_TrimEnd$(c: Ctx, s: string): string {
  void c;
  return trimChars(s, WS, false, true);
}
export function String_TrimEnd$Char_arr(c: Ctx, s: string, chars: string[]): string {
  void c;
  return trimChars(s, chars && chars.length ? chars.join('') : WS, false, true);
}
export const String_TrimEnd$Char = (_c: Ctx, s: string, ch: string): string => trimChars(s, ch, false, true);
export function String_Replace$string_string(c: Ctx, s: string, a: string, b: string | null): string {
  void c;
  if (!a) throw csErr('ArgumentException', 'String cannot be of zero length.');
  return s.split(a).join(b ?? '');
}
export const String_Replace$Char_Char = String_Replace$string_string;
export function String_Equals$string(c: Ctx, s: string, v: string | null): boolean {
  void c;
  return s === v;
}
export const String_Equals$Object = String_Equals$string;
export function String_Equals$string_StringComparison(c: Ctx, s: string, v: string | null, cmp: number): boolean {
  void c;
  if (v == null) return false;
  return ignoreCase(cmp) ? s.toLowerCase() === v.toLowerCase() : s === v;
}
export function String_Equals$string_string(c: Ctx, a: string | null, b: string | null): boolean {
  void c;
  return a === b;
}
export function String_Equals$string_string_StringComparison(c: Ctx, a: string | null, b: string | null, cmp: number): boolean {
  void c;
  if (a == null || b == null) return a === b;
  return ignoreCase(cmp) ? a.toLowerCase() === b.toLowerCase() : a === b;
}
export function String_IsNullOrWhiteSpace(c: Ctx, s: string | null): boolean {
  void c;
  return s == null || trimChars(s, WS, true, true).length === 0;
}
export function String_IndexOf$string(c: Ctx, s: string, v: string): number {
  void c;
  return s.indexOf(v);
}
export const String_IndexOf$Char = String_IndexOf$string;
export function String_IndexOf$string_int(c: Ctx, s: string, v: string, start: number): number {
  void c;
  return s.indexOf(v, start);
}
export const String_IndexOf$Char_int = String_IndexOf$string_int;
export function String_IndexOf$string_int_int(c: Ctx, s: string, v: string, start: number, count: number): number {
  void c;
  const i = s.slice(0, start + count).indexOf(v, start);
  return i;
}
export const String_IndexOf$Char_int_int = String_IndexOf$string_int_int;
export function String_IndexOf$string_StringComparison(c: Ctx, s: string, v: string, cmp: number): number {
  void c;
  return ignoreCase(cmp) ? s.toLowerCase().indexOf(v.toLowerCase()) : s.indexOf(v);
}
export function String_IndexOf$string_int_StringComparison(c: Ctx, s: string, v: string, start: number, cmp: number): number {
  void c;
  return ignoreCase(cmp) ? s.toLowerCase().indexOf(v.toLowerCase(), start) : s.indexOf(v, start);
}
export function String_LastIndexOf$string(c: Ctx, s: string, v: string): number {
  void c;
  return s.lastIndexOf(v);
}
export const String_LastIndexOf$Char = String_LastIndexOf$string;
export function String_LastIndexOf$string_int(c: Ctx, s: string, v: string, start: number): number {
  void c;
  return s.lastIndexOf(v, start);
}
export const String_LastIndexOf$Char_int = String_LastIndexOf$string_int;
export function String_LastIndexOf$string_StringComparison(c: Ctx, s: string, v: string, cmp: number): number {
  void c;
  return ignoreCase(cmp) ? s.toLowerCase().lastIndexOf(v.toLowerCase()) : s.lastIndexOf(v);
}
export function String_IndexOfAny$Char_arr(c: Ctx, s: string, chars: string[]): number {
  void c;
  for (let i = 0; i < s.length; i++) if (chars.includes(s[i])) return i;
  return -1;
}
export function String_IndexOfAny$Char_arr_int(c: Ctx, s: string, chars: string[], start: number): number {
  void c;
  for (let i = start; i < s.length; i++) if (chars.includes(s[i])) return i;
  return -1;
}
export function String_LastIndexOfAny$Char_arr(c: Ctx, s: string, chars: string[]): number {
  void c;
  for (let i = s.length - 1; i >= 0; i--) if (chars.includes(s[i])) return i;
  return -1;
}
export function String_ToLowerInvariant(c: Ctx, s: string): string {
  void c;
  return s.toLowerCase();
}
export const String_ToLower$ = String_ToLowerInvariant;
export const String_ToLower$CultureInfo = String_ToLowerInvariant;
export function String_ToUpperInvariant(c: Ctx, s: string): string {
  void c;
  return s.toUpperCase();
}
export const String_ToUpper$ = String_ToUpperInvariant;
export const String_ToUpper$CultureInfo = String_ToUpperInvariant;
export function String_ToCharArray$(c: Ctx, s: string): string[] {
  void c;
  return s.split('');
}
export function String_ToCharArray$int_int(c: Ctx, s: string, start: number, len: number): string[] {
  void c;
  return s.substr(start, len).split('');
}
/** Split：StringSplitOptions.RemoveEmptyEntries 1、TrimEntries 2；count 是最多切幾段（最後一段放剩下的） */
function splitBy(s: string, seps: string[], count: number, opts: number): string[] {
  let parts: string[] = [];
  if (!seps.length || seps.every((x) => !x)) {
    // 沒給分隔字元：照空白切
    parts = s.split(/[\s]/);
  } else {
    let cur = 0;
    let i = 0;
    while (i <= s.length) {
      const hit = i < s.length ? seps.find((x) => x && s.startsWith(x, i)) : undefined;
      if (hit !== undefined && (count <= 0 || parts.length < count - 1)) {
        parts.push(s.slice(cur, i));
        i += hit.length;
        cur = i;
      } else if (i === s.length) {
        parts.push(s.slice(cur));
        break;
      } else i++;
    }
  }
  if (opts & 2) parts = parts.map((x) => trimChars(x, WS, true, true));
  if (opts & 1) parts = parts.filter((x) => x.length > 0);
  if (count > 0 && parts.length > count) parts = [...parts.slice(0, count - 1), parts.slice(count - 1).join(seps[0] ?? '')];
  return parts;
}
export function String_Split$Char_arr(c: Ctx, s: string, seps: string[]): string[] {
  void c;
  return splitBy(s, seps ?? [], 0, 0);
}
export function String_Split$Char_StringSplitOptions(c: Ctx, s: string, sep: string, opts: number): string[] {
  void c;
  return splitBy(s, [sep], 0, opts);
}
export function String_Split$Char_arr_StringSplitOptions(c: Ctx, s: string, seps: string[], opts: number): string[] {
  void c;
  return splitBy(s, seps ?? [], 0, opts);
}
export function String_Split$Char_arr_int(c: Ctx, s: string, seps: string[], count: number): string[] {
  void c;
  return splitBy(s, seps ?? [], count, 0);
}
export function String_Split$Char_int_StringSplitOptions(c: Ctx, s: string, sep: string, count: number, opts: number): string[] {
  void c;
  return splitBy(s, [sep], count, opts);
}
export function String_Split$String_arr_StringSplitOptions(c: Ctx, s: string, seps: string[], opts: number): string[] {
  void c;
  return splitBy(s, seps ?? [], 0, opts);
}
export function String_Split$string_StringSplitOptions(c: Ctx, s: string, sep: string, opts: number): string[] {
  void c;
  return splitBy(s, [sep], 0, opts);
}
export function String_Split$String_arr_int_StringSplitOptions(c: Ctx, s: string, seps: string[], count: number, opts: number): string[] {
  void c;
  return splitBy(s, seps ?? [], count, opts);
}
export function String_Split$Char(c: Ctx, s: string, sep: string): string[] {
  void c;
  return splitBy(s, [sep], 0, 0);
}
export function String_Join$string_IEnumerable(c: Ctx, sep: string, items: Iterable<unknown>): string {
  return [...(items ?? [])].map((x) => (x == null ? '' : formatValue(c, x))).join(sep ?? '');
}
export const String_Join$string_String_arr = String_Join$string_IEnumerable;
export const String_Join$string_Object_arr = String_Join$string_IEnumerable;
export const String_Join$Char_String_arr = String_Join$string_IEnumerable;
export const String_Join$Char_IEnumerable = String_Join$string_IEnumerable;
export function String_Join$string_String_arr_int_int(c: Ctx, sep: string, items: string[], start: number, count: number): string {
  return String_Join$string_IEnumerable(c, sep, items.slice(start, start + count));
}
export function String_Concat$String_arr(c: Ctx, items: unknown[]): string {
  return (items ?? []).map((x) => (x == null ? '' : formatValue(c, x))).join('');
}
export const String_Concat$Object_arr = String_Concat$String_arr;
export const String_Concat$IEnumerable = (c: Ctx, items: Iterable<unknown>): string => String_Concat$String_arr(c, [...items]);
export function String_Concat$string_string(c: Ctx, a: unknown, b: unknown): string {
  return String_Concat$String_arr(c, [a, b]);
}
export const String_Concat$Object_Object = String_Concat$string_string;
export function String_Concat$string_string_string(c: Ctx, a: unknown, b: unknown, d: unknown): string {
  return String_Concat$String_arr(c, [a, b, d]);
}
export const String_Concat$Object_Object_Object = String_Concat$string_string_string;
export function String_Concat$string_string_string_string(c: Ctx, a: unknown, b: unknown, d: unknown, e: unknown): string {
  return String_Concat$String_arr(c, [a, b, d, e]);
}
export function String_Copy(c: Ctx, s: string): string {
  void c;
  return s;
}
export function String_Remove$int(c: Ctx, s: string, start: number): string {
  void c;
  return s.slice(0, start);
}
export function String_Remove$int_int(c: Ctx, s: string, start: number, n: number): string {
  void c;
  checkRange(s, start, n);
  return s.slice(0, start) + s.slice(start + n);
}
export function String_Insert(c: Ctx, s: string, i: number, v: string): string {
  void c;
  return s.slice(0, i) + v + s.slice(i);
}
export function String_PadLeft$int(c: Ctx, s: string, n: number): string {
  void c;
  return s.padStart(n, ' ');
}
export function String_PadLeft$int_Char(c: Ctx, s: string, n: number, ch: string): string {
  void c;
  return s.padStart(n, ch);
}
export function String_PadRight$int(c: Ctx, s: string, n: number): string {
  void c;
  return s.padEnd(n, ' ');
}
export function String_PadRight$int_Char(c: Ctx, s: string, n: number, ch: string): string {
  void c;
  return s.padEnd(n, ch);
}
export function String_CompareOrdinal(c: Ctx, a: string | null, b: string | null): number {
  void c;
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d) return d;
  }
  return a.length - b.length;
}
export const String_CompareOrdinal$string_string = String_CompareOrdinal;
/** string.Compare(a, b, StringComparison)：Ordinal 系照碼位，其他照文化相關的比較 */
export function String_Compare$string_string_StringComparison(c: Ctx, a: string | null, b: string | null, cmp: number): number {
  if (cmp === 4) return Math.sign(String_CompareOrdinal(c, a, b));
  if (cmp === 5) return Math.sign(String_CompareOrdinal(c, a?.toUpperCase() ?? null, b?.toUpperCase() ?? null));
  if (ignoreCase(cmp)) return defaultCompare(a?.toLowerCase() ?? null, b?.toLowerCase() ?? null);
  return defaultCompare(a, b);
}
export function String_Compare$string_string(c: Ctx, a: string | null, b: string | null): number {
  void c;
  return defaultCompare(a, b);
}
export function String_Compare$string_string_bool(c: Ctx, a: string | null, b: string | null, ic: boolean): number {
  void c;
  return ic ? defaultCompare(a?.toLowerCase() ?? null, b?.toLowerCase() ?? null) : defaultCompare(a, b);
}
export function String_Compare$string_int_string_int_int_StringComparison(c: Ctx, a: string, ia: number, b: string, ib: number, n: number, cmp: number): number {
  return String_Compare$string_string_StringComparison(c, a.substr(ia, n), b.substr(ib, n), cmp);
}
export function String_CompareTo$string(c: Ctx, a: string, b: string | null): number {
  void c;
  return defaultCompare(a, b);
}
export const String_CompareTo$Object = String_CompareTo$string;
export function String_GetHashCode$(c: Ctx, s: string): number {
  void c;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
export function String_get_Chars(c: Ctx, s: string, i: number): string {
  void c;
  return s[i];
}
export function new_String$Char_int(c: Ctx, ch: string, n: number): string {
  void c;
  return ch.repeat(Math.max(0, n));
}
export function new_String$Char_arr(c: Ctx, chars: string[]): string {
  void c;
  return (chars ?? []).join('');
}
export function new_String$Char_arr_int_int(c: Ctx, chars: string[], start: number, n: number): string {
  void c;
  return chars.slice(start, start + n).join('');
}
export function String_IsNormalized(c: Ctx, s: string): boolean {
  void c;
  return s === s.normalize();
}
export function String_Normalize$(c: Ctx, s: string): string {
  void c;
  return s.normalize();
}
export function String_Intern(c: Ctx, s: string): string {
  void c;
  return s;
}

// ───────── 格式化（composite format：{0}、{0,5}、{0:N2}；標準與自訂數字格式） ─────────

/** 數字的格式字串（標準：D、F、N、P、X、G、C、E、R；自訂：0、#、.、,、%） */
export function formatNumber(v: number, fmt: string | null | undefined, isInt: boolean): string {
  if (!fmt) return isInt ? String(Math.trunc(v)) : formatG(v, 7);
  const m = /^([DdFfNnPpXxGgCcEeRr])(\d*)$/.exec(fmt);
  if (m) {
    const k = m[1].toUpperCase();
    const p = m[2] === '' ? null : parseInt(m[2], 10);
    switch (k) {
      case 'D': {
        const s = String(Math.abs(Math.trunc(v))).padStart(p ?? 0, '0');
        return v < 0 ? `-${s}` : s;
      }
      case 'F':
        return roundAway(v, p ?? 2).toFixed(p ?? 2);
      case 'N':
        return groupDigits(roundAway(v, p ?? 2).toFixed(p ?? 2));
      case 'P':
        return `${groupDigits(roundAway(v * 100, p ?? 2).toFixed(p ?? 2))} %`;
      case 'C':
        return `$${groupDigits(roundAway(Math.abs(v), p ?? 2).toFixed(p ?? 2))}`.replace(/^/, v < 0 ? '-' : '');
      case 'X': {
        const s = (Math.trunc(v) >>> 0).toString(16).padStart(p ?? 0, '0');
        return m[1] === 'X' ? s.toUpperCase() : s;
      }
      case 'E': {
        const s = v.toExponential(p ?? 6).replace(/e([+-])(\d+)$/, (_, sg, d) => `E${sg}${d.padStart(3, '0')}`);
        return m[1] === 'e' ? s.toLowerCase() : s;
      }
      case 'G':
        return isInt && p === null ? String(Math.trunc(v)) : formatG(v, p ?? (isInt ? 10 : 7));
      case 'R':
        return String(v);
    }
  }
  return formatCustom(v, fmt);
}
/** .NET 的 F／N 格式是遠離零的四捨五入（MidpointRounding.AwayFromZero 的十進位近似） */
function roundAway(v: number, digits: number): number {
  const f = 10 ** digits;
  const x = Math.abs(v) * f;
  const r = Math.round(x + 1e-9 * Math.max(1, x));
  return (Math.sign(v) * r) / f;
}
function groupDigits(s: string): string {
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + g + (f !== undefined ? `.${f}` : '');
}
/** G 格式（有效位數 p）：Mono 的 float.ToString() 是 G7、double 是 G15 */
export function formatG(v: number, p: number): string {
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
  if (v === 0) return '0';
  const e = Math.floor(Math.log10(Math.abs(v)));
  if (e < -5 || e >= p) {
    let s = v.toExponential(p - 1);
    s = s.replace(/\.?0+e/, 'e');
    return s.replace(/e([+-])(\d+)$/, (_, sg, d) => `E${sg}${d.padStart(2, '0')}`);
  }
  let s = v.toPrecision(p);
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s;
}
function formatCustom(v: number, fmt: string): string {
  // 自訂格式（常見的部分）：0 與 # 的位數、. 小數點、, 千分位、% 乘 100；; 分段（正;負;零）
  const sections = fmt.split(';');
  let f = sections[0];
  if (v < 0 && sections[1] !== undefined) {
    f = sections[1];
    v = -v;
  } else if (v === 0 && sections[2] !== undefined) f = sections[2];
  const pct = f.includes('%');
  if (pct) v *= 100;
  const lit = f.replace(/[0#.,%]/g, '');
  const num = f.replace(/[^0#.,]/g, '');
  const [ip, fp = ''] = num.split('.');
  const decimals = fp.length;
  const minDec = (fp.match(/0/g) ?? []).length;
  let s = roundAway(Math.abs(v), decimals).toFixed(decimals);
  let [i, d = ''] = s.split('.');
  while (d.length > minDec && d.endsWith('0')) d = d.slice(0, -1);
  const minInt = (ip.match(/0/g) ?? []).length;
  i = i.padStart(minInt, '0');
  if (minInt === 0 && i === '0') i = '';
  if (ip.includes(',')) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  s = i + (d ? `.${d}` : '');
  if (s === '') s = '0';
  const neg = v < 0 && sections[1] === undefined && Number(s.replace(/,/g, '')) !== 0;
  // 字面文字放回原本的位置（簡化：數字前的字面放前面，其他放後面）
  const firstDigit = f.search(/[0#]/);
  const pre = firstDigit > 0 ? f.slice(0, firstDigit).replace(/[0#.,]/g, '') : '';
  const post = lit.slice(pre.length);
  return (neg ? '-' : '') + pre + s + post;
}
/** 值放進字串時的樣子（ToString()）：數字照型別的預設格式（Mono：float G7）、bool True／False、列舉照名字、null 空字串 */
export function formatValue(c: Ctx, v: unknown, fmt?: string | null): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  // 數字：型別資訊沒有了，整數照整數、其他照 float 的 G7（Unity 的數值大多是 float）
  if (typeof v === 'number') return formatNumber(v, fmt, Number.isInteger(v));
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof BoxedEnum) {
    if (fmt === 'D' || fmt === 'd') return String(v.value);
    return v.names[v.value] ?? String(v.value);
  }
  if (v instanceof DateTimeJs) return DateTime_ToString$string(c, v, fmt ?? null);
  if (v instanceof TimeSpanJs) return TimeSpan_ToString$(c, v);
  if (v instanceof H) return `${v.node.go.m_Name} (${v.kind === 'go' ? 'UnityEngine.GameObject' : v.kind === 'transform' ? 'UnityEngine.Transform' : (v.comp?.script?.class ?? v.comp?.type)})`;
  const o = v as Record<string, unknown>;
  const t = o.$type as string | undefined;
  if (t && hasGen(t) && genMethodOf(t, 'ToString')) return String(genCallVirtual(getActiveWorld(), t, o, 'ToString'));
  // Unity 的值型別：Vector3 (x, y, z) 的 F2 樣子
  if ('x' in o && 'y' in o && !t) {
    const f2 = (n: unknown) => (n as number).toFixed(2);
    if ('w' in o) return `(${f2(o.x)}, ${f2(o.y)}, ${f2(o.z)}, ${f2(o.w)})`;
    if ('z' in o) return `(${f2(o.x)}, ${f2(o.y)}, ${f2(o.z)})`;
    return `(${f2(o.x)}, ${f2(o.y)})`;
  }
  if ('r' in o && 'g' in o && 'b' in o && 'a' in o && !t) return `RGBA(${(o.r as number).toFixed(3)}, ${(o.g as number).toFixed(3)}, ${(o.b as number).toFixed(3)}, ${(o.a as number).toFixed(3)})`;
  return t ?? '[object]';
}
/** string.Format 的 composite format */
export function compositeFormat(c: Ctx, fmt: string, args: unknown[]): string {
  if (fmt == null) throw csErr('ArgumentNullException', 'format');
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '{') {
      if (fmt[i + 1] === '{') {
        out += '{';
        i++;
        continue;
      }
      const end = fmt.indexOf('}', i);
      if (end < 0) throw csErr('FormatException', 'Input string was not in a correct format.');
      const spec = fmt.slice(i + 1, end);
      const m = /^\s*(\d+)\s*(?:,\s*(-?\d+))?\s*(?::(.*))?$/.exec(spec);
      if (!m) throw csErr('FormatException', 'Input string was not in a correct format.');
      const idx = parseInt(m[1], 10);
      if (idx >= args.length) throw csErr('FormatException', 'Index (zero based) must be greater than or equal to zero and less than the size of the argument list.');
      let s = formatValue(c, args[idx], m[3]);
      if (m[2]) {
        const w = parseInt(m[2], 10);
        s = w < 0 ? s.padEnd(-w) : s.padStart(w);
      }
      out += s;
      i = end;
    } else if (ch === '}') {
      if (fmt[i + 1] === '}') i++;
      out += '}';
    } else out += ch;
  }
  return out;
}
/** 插值字串的 {x:格式,對齊}（轉換器寫 R.csFormat）：跟 string.Format 同一套 */
export function csFormat(c: Ctx, v: unknown, fmt: string, align: number): string {
  const s = formatValue(c, v, fmt || null);
  return align < 0 ? s.padEnd(-align) : s.padStart(align);
}
export function String_Format$string_Object(c: Ctx, f: string, a: unknown): string {
  return compositeFormat(c, f, [a]);
}
export function String_Format$string_Object_Object(c: Ctx, f: string, a: unknown, b: unknown): string {
  return compositeFormat(c, f, [a, b]);
}
export function String_Format$string_Object_Object_Object(c: Ctx, f: string, a: unknown, b: unknown, d: unknown): string {
  return compositeFormat(c, f, [a, b, d]);
}
export function String_Format$string_Object_arr(c: Ctx, f: string, args: unknown[]): string {
  return compositeFormat(c, f, args ?? []);
}
export function String_Format$IFormatProvider_string_Object(c: Ctx, p: unknown, f: string, a: unknown): string {
  void p;
  return compositeFormat(c, f, [a]);
}
export function String_Format$IFormatProvider_string_Object_Object(c: Ctx, p: unknown, f: string, a: unknown, b: unknown): string {
  void p;
  return compositeFormat(c, f, [a, b]);
}
export function String_Format$IFormatProvider_string_Object_Object_Object(c: Ctx, p: unknown, f: string, a: unknown, b: unknown, d: unknown): string {
  void p;
  return compositeFormat(c, f, [a, b, d]);
}
export function String_Format$IFormatProvider_string_Object_arr(c: Ctx, p: unknown, f: string, args: unknown[]): string {
  void p;
  return compositeFormat(c, f, args ?? []);
}

// ───────── 數字 ─────────

export function Int32_ToString$(c: Ctx, v: number): string {
  void c;
  return String(v | 0);
}
export function Int32_ToString$string(c: Ctx, v: number, f: string): string {
  void c;
  return formatNumber(v, f, true);
}
export function Int32_ToString$string_IFormatProvider(c: Ctx, v: number, f: string): string {
  void c;
  return formatNumber(v, f, true);
}
export const Int32_ToString$IFormatProvider = Int32_ToString$;
export const Int64_ToString$ = Int32_ToString$;
export const Int64_ToString$string = Int32_ToString$string;
export const UInt32_ToString$ = (_c: Ctx, v: number): string => String(v >>> 0);
export const UInt32_ToString$string = Int32_ToString$string;
export const Byte_ToString$ = Int32_ToString$;
export const Byte_ToString$string = Int32_ToString$string;
export const Int16_ToString$ = Int32_ToString$;
export function Single_ToString$(c: Ctx, v: number): string {
  void c;
  return formatG(Math.fround(v), 7);
}
export function Single_ToString$string(c: Ctx, v: number, f: string): string {
  void c;
  return formatNumber(Math.fround(v), f, false);
}
export const Single_ToString$string_IFormatProvider = Single_ToString$string;
export const Single_ToString$IFormatProvider = Single_ToString$;
export function Double_ToString$(c: Ctx, v: number): string {
  void c;
  return formatG(v, 15);
}
export function Double_ToString$string(c: Ctx, v: number, f: string): string {
  void c;
  return formatNumber(v, f, false);
}
export const Double_ToString$string_IFormatProvider = Double_ToString$string;
export const Double_ToString$IFormatProvider = Double_ToString$;
// GetHashCode（.NET Framework 參考原始碼，Unity 的 Mono 同一份）：Double 是 0 回 0（0 與 -0 同一個），其他是 64 位元的低 32 位 XOR 高 32 位；
// Int64 是低 32 位 XOR 高 32 位
const hashBuf = new DataView(new ArrayBuffer(8));
export function Double_GetHashCode(_c: Ctx, v: number): number {
  if (v === 0) return 0;
  hashBuf.setFloat64(0, v, true);
  return (hashBuf.getInt32(0, true) ^ hashBuf.getInt32(4, true)) | 0;
}
export function Int64_GetHashCode(_c: Ctx, v: number | bigint): number {
  hashBuf.setBigInt64(0, BigInt.asIntN(64, typeof v === 'bigint' ? v : BigInt(Math.trunc(v))), true);
  return (hashBuf.getInt32(0, true) ^ hashBuf.getInt32(4, true)) | 0;
}
export function Boolean_ToString$(c: Ctx, v: boolean): string {
  void c;
  return v ? 'True' : 'False';
}
export function Char_ToString$(c: Ctx, v: string): string {
  void c;
  return v;
}
/** 整數的解析：前後空白可以、正負號、超出範圍丟 OverflowException（TryParse 回 false） */
function parseIntStrict(s: string | null, min: number, max: number, hex = false): number | null {
  if (s == null) return null;
  const t = s.trim();
  if (!(hex ? /^[0-9a-fA-F]+$/ : /^[+-]?\d+$/).test(t)) return null;
  const n = hex ? parseInt(t, 16) : Number(t);
  if (n < min || n > max) return null;
  return n;
}
const I32 = [-2147483648, 2147483647] as const;
export function Int32_Parse$string(c: Ctx, s: string): number {
  void c;
  const n = parseIntStrict(s, I32[0], I32[1]);
  if (n === null) throw csErr(s == null ? 'ArgumentNullException' : 'FormatException', `Int32.Parse("${s}")`);
  return n;
}
export const int32Parse = Int32_Parse$string;
export function Int32_Parse$string_NumberStyles(c: Ctx, s: string, style: number): number {
  void c;
  const n = parseIntStrict(s, I32[0], I32[1], (style & 512) !== 0);
  if (n === null) throw csErr('FormatException', `Int32.Parse("${s}")`);
  return n | 0;
}
export const Int32_Parse$string_IFormatProvider = Int32_Parse$string;
export function Int32_TryParse$string_int(c: Ctx, s: string, out: Out<number>): boolean {
  void c;
  const n = parseIntStrict(s, I32[0], I32[1]);
  out(n ?? 0);
  return n !== null;
}
export function Int32_TryParse$string_NumberStyles_IFormatProvider_int(c: Ctx, s: string, style: number, p: unknown, out: Out<number>): boolean {
  void c;
  void p;
  const n = parseIntStrict(s, I32[0], I32[1], (style & 512) !== 0);
  out(n ?? 0);
  return n !== null;
}
export function Int64_TryParse$string_Int64(c: Ctx, s: string, out: Out<number>): boolean {
  void c;
  const n = parseIntStrict(s, -9223372036854775808, 9223372036854775807);
  out(n ?? 0);
  return n !== null;
}
export function Int64_Parse$string(c: Ctx, s: string): number {
  void c;
  const n = parseIntStrict(s, -9223372036854775808, 9223372036854775807);
  if (n === null) throw csErr('FormatException', `Int64.Parse("${s}")`);
  return n;
}
export function UInt32_TryParse$string_UInt32(c: Ctx, s: string, out: Out<number>): boolean {
  void c;
  const n = parseIntStrict(s, 0, 4294967295);
  out(n ?? 0);
  return n !== null;
}
export function UInt32_Parse$string(c: Ctx, s: string): number {
  void c;
  const n = parseIntStrict(s, 0, 4294967295);
  if (n === null) throw csErr('FormatException', `UInt32.Parse("${s}")`);
  return n;
}
export function Byte_TryParse$string_Byte(c: Ctx, s: string, out: Out<number>): boolean {
  void c;
  const n = parseIntStrict(s, 0, 255);
  out(n ?? 0);
  return n !== null;
}
export function Byte_Parse$string(c: Ctx, s: string): number {
  void c;
  const n = parseIntStrict(s, 0, 255);
  if (n === null) throw csErr('FormatException', `Byte.Parse("${s}")`);
  return n;
}
export function Byte_Parse$string_NumberStyles(c: Ctx, s: string, style: number): number {
  void c;
  const n = parseIntStrict(s, 0, 255, (style & 512) !== 0);
  if (n === null) throw csErr('FormatException', `Byte.Parse("${s}")`);
  return n;
}
function parseFloatStrict(s: string | null): number | null {
  if (s == null) return null;
  const t = s.trim();
  if (/^[+-]?(Infinity|∞)$/i.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^NaN$/i.test(t)) return NaN;
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/.test(t.replace(/,(?=\d{3}(\D|$))/g, ''))) return null;
  return Number(t.replace(/,(?=\d{3}(\D|$))/g, ''));
}
export function Single_Parse$string(c: Ctx, s: string): number {
  void c;
  const n = parseFloatStrict(s);
  if (n === null) throw csErr('FormatException', `Single.Parse("${s}")`);
  return Math.fround(n);
}
export const Single_Parse$string_IFormatProvider = Single_Parse$string;
export const Single_Parse$string_NumberStyles_IFormatProvider = Single_Parse$string;
export function Single_TryParse$string_float(c: Ctx, s: string, out: Out<number>): boolean {
  void c;
  const n = parseFloatStrict(s);
  out(n === null ? 0 : Math.fround(n));
  return n !== null;
}
export function Single_TryParse$string_NumberStyles_IFormatProvider_float(c: Ctx, s: string, st: number, p: unknown, out: Out<number>): boolean {
  void st;
  void p;
  return Single_TryParse$string_float(c, s, out);
}
export function Double_Parse$string(c: Ctx, s: string): number {
  void c;
  const n = parseFloatStrict(s);
  if (n === null) throw csErr('FormatException', `Double.Parse("${s}")`);
  return n;
}
export const Double_Parse$string_IFormatProvider = Double_Parse$string;
export function Double_TryParse$string_double(c: Ctx, s: string, out: Out<number>): boolean {
  void c;
  const n = parseFloatStrict(s);
  out(n ?? 0);
  return n !== null;
}
export function Boolean_Parse(c: Ctx, s: string): boolean {
  void c;
  const t = s?.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  throw csErr('FormatException', `Boolean.Parse("${s}")`);
}
export function Boolean_TryParse$string_bool(c: Ctx, s: string, out: Out<boolean>): boolean {
  void c;
  const t = s?.trim().toLowerCase();
  out(t === 'true');
  return t === 'true' || t === 'false';
}
export function Single_IsNaN(c: Ctx, v: number): boolean {
  void c;
  return Number.isNaN(v);
}
export const Double_IsNaN = Single_IsNaN;
export function Single_IsInfinity(c: Ctx, v: number): boolean {
  void c;
  return v === Infinity || v === -Infinity;
}
export const Double_IsInfinity = Single_IsInfinity;
export function Single_IsPositiveInfinity(c: Ctx, v: number): boolean {
  void c;
  return v === Infinity;
}
export const Double_IsPositiveInfinity = Single_IsPositiveInfinity;
export function Single_IsNegativeInfinity(c: Ctx, v: number): boolean {
  void c;
  return v === -Infinity;
}
export const Double_IsNegativeInfinity = Single_IsNegativeInfinity;
export function Single_GetHashCode(c: Ctx, v: number): number {
  void c;
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, v);
  return b.getInt32(0);
}
export function Int32_GetHashCode(c: Ctx, v: number): number {
  void c;
  return v | 0;
}
export function Int32_CompareTo$int(c: Ctx, a: number, b: number): number {
  void c;
  return a < b ? -1 : a > b ? 1 : 0;
}
export const Int32_CompareTo$Object = Int32_CompareTo$int;
/** bool.CompareTo：false 比 true 小（Boolean.CompareTo 的原文） */
export function Boolean_CompareTo$bool(c: Ctx, a: boolean, b: boolean): number {
  void c;
  return a === b ? 0 : a ? 1 : -1;
}
export const Boolean_CompareTo$Object = Boolean_CompareTo$bool;
export const Single_CompareTo$float = Int32_CompareTo$int;
export const Double_CompareTo$double = Int32_CompareTo$int;
export const Int64_CompareTo$Int64 = Int32_CompareTo$int;
export function Int32_Equals$int(c: Ctx, a: number, b: number): boolean {
  void c;
  return a === b;
}
export const Int32_Equals$Object = Int32_Equals$int;
export const Single_Equals$float = Int32_Equals$int;
export const Single_Equals$Object = Int32_Equals$int;
export const Double_Equals$double = Int32_Equals$int;
export const Boolean_Equals$bool = Int32_Equals$int;

// ───────── System.Math ─────────

/** Math.Round(double)：銀行家捨入（MidpointRounding.ToEven，.NET 的預設） */
export function roundEven(v: number): number {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
export function Math_Round$double(c: Ctx, v: number): number {
  void c;
  return roundEven(v);
}
export const Math_Round$float = Math_Round$double;
export const Math_Round$decimal = Math_Round$double;
export function Math_Round$double_int(c: Ctx, v: number, d: number): number {
  void c;
  const f = 10 ** d;
  return roundEven(v * f) / f;
}
export function Math_Round$double_MidpointRounding(c: Ctx, v: number, mode: number): number {
  void c;
  return mode === 1 ? Math.sign(v) * Math.round(Math.abs(v)) : roundEven(v);
}
export function Math_Round$double_int_MidpointRounding(c: Ctx, v: number, d: number, mode: number): number {
  void c;
  const f = 10 ** d;
  return (mode === 1 ? Math.sign(v) * Math.round(Math.abs(v * f)) : roundEven(v * f)) / f;
}
export const Math_Max$int_int = (_c: Ctx, a: number, b: number): number => Math.max(a, b);
export const Math_Max$float_float = Math_Max$int_int;
export const Math_Max$double_double = Math_Max$int_int;
export const Math_Max$Int64_Int64 = Math_Max$int_int;
export const Math_Max$UInt32_UInt32 = Math_Max$int_int;
export const Math_Min$int_int = (_c: Ctx, a: number, b: number): number => Math.min(a, b);
export const Math_Min$float_float = Math_Min$int_int;
export const Math_Min$double_double = Math_Min$int_int;
export const Math_Min$Int64_Int64 = Math_Min$int_int;
export const Math_Min$UInt32_UInt32 = Math_Min$int_int;
export const Math_Abs$int = (_c: Ctx, v: number): number => Math.abs(v);
export const Math_Abs$float = Math_Abs$int;
export const Math_Abs$double = Math_Abs$int;
export const Math_Abs$Int64 = Math_Abs$int;
export const Math_Sign$int = (_c: Ctx, v: number): number => Math.sign(v);
export const Math_Sign$float = Math_Sign$int;
export const Math_Sign$double = Math_Sign$int;
export function Math_Clamp$int_int_int(c: Ctx, v: number, lo: number, hi: number): number {
  void c;
  if (lo > hi) throw csErr('ArgumentException', `Math.Clamp：min ${lo} > max ${hi}`);
  return v < lo ? lo : v > hi ? hi : v;
}
export const Math_Clamp$float_float_float = Math_Clamp$int_int_int;
export const Math_Clamp$double_double_double = Math_Clamp$int_int_int;
export const Math_Floor$double = (_c: Ctx, v: number): number => Math.floor(v);
export const Math_Floor$decimal = Math_Floor$double;
export const Math_Ceiling$double = (_c: Ctx, v: number): number => Math.ceil(v);
export const Math_Ceiling$decimal = Math_Ceiling$double;
export const Math_Truncate$double = (_c: Ctx, v: number): number => Math.trunc(v);
export const Math_Truncate$decimal = Math_Truncate$double;
export const Math_Sqrt = (_c: Ctx, v: number): number => Math.sqrt(v);
export const Math_Pow = (_c: Ctx, a: number, b: number): number => Math.pow(a, b);
export const Math_Exp = (_c: Ctx, v: number): number => Math.exp(v);
export const Math_Log$double = (_c: Ctx, v: number): number => Math.log(v);
export const Math_Log$double_double = (_c: Ctx, v: number, b: number): number => Math.log(v) / Math.log(b);
export const Math_Log10 = (_c: Ctx, v: number): number => Math.log10(v);
export const Math_Log2 = (_c: Ctx, v: number): number => Math.log2(v);
export const Math_Sin = (_c: Ctx, v: number): number => Math.sin(v);
export const Math_Cos = (_c: Ctx, v: number): number => Math.cos(v);
export const Math_Tan = (_c: Ctx, v: number): number => Math.tan(v);
export const Math_Asin = (_c: Ctx, v: number): number => Math.asin(v);
export const Math_Acos = (_c: Ctx, v: number): number => Math.acos(v);
export const Math_Atan = (_c: Ctx, v: number): number => Math.atan(v);
export const Math_Atan2 = (_c: Ctx, y: number, x: number): number => Math.atan2(y, x);
export const Math_Sinh = (_c: Ctx, v: number): number => Math.sinh(v);
export const Math_Cosh = (_c: Ctx, v: number): number => Math.cosh(v);
export const Math_Tanh = (_c: Ctx, v: number): number => Math.tanh(v);
export function Math_get_PI(c: Ctx): number {
  void c;
  return Math.PI;
}
export function Math_DivRem$int_int_int(c: Ctx, a: number, b: number, out: Out<number>): number {
  void c;
  out(a % b);
  return Math.trunc(a / b);
}

// ───────── Convert、BitConverter、Encoding ─────────

export function Convert_ToInt32$string(c: Ctx, s: string | null): number {
  return s == null ? 0 : Int32_Parse$string(c, s);
}
export function Convert_ToInt32$string_int(c: Ctx, s: string | null, base: number): number {
  void c;
  if (s == null) return 0;
  return parseInt(s, base) | 0;
}
/** Convert.ToInt32(double)：銀行家捨入（不是截斷） */
export function Convert_ToInt32$double(c: Ctx, v: number): number {
  void c;
  return roundEven(v) | 0;
}
export const Convert_ToInt32$float = Convert_ToInt32$double;
export const Convert_ToInt32$decimal = Convert_ToInt32$double;
export function Convert_ToInt32$bool(c: Ctx, v: boolean): number {
  void c;
  return v ? 1 : 0;
}
export function Convert_ToInt32$Int64(c: Ctx, v: number): number {
  void c;
  return v | 0;
}
export function Convert_ToInt64$string(c: Ctx, s: string | null): number {
  return s == null ? 0 : Int64_Parse$string(c, s);
}
export function Convert_ToUInt64$string(c: Ctx, s: string | null): number {
  return s == null ? 0 : Int64_Parse$string(c, s);
}
/** Convert.ToUInt64(char)：字元的 UTF-16 碼（char 在產生碼裡是長度 1 的字串） */
export function Convert_ToUInt64$Char(c: Ctx, ch: string): number {
  void c;
  return ch.charCodeAt(0);
}
export function Convert_ToSingle$string(c: Ctx, s: string | null): number {
  return s == null ? 0 : Single_Parse$string(c, s);
}
export function Convert_ToSingle$double(c: Ctx, v: number): number {
  void c;
  return Math.fround(v);
}
export function Convert_ToDouble$string(c: Ctx, s: string | null): number {
  return s == null ? 0 : Double_Parse$string(c, s);
}
export function Convert_ToDouble$float(c: Ctx, v: number): number {
  void c;
  return v;
}
export const Convert_ToDouble$int = Convert_ToDouble$float;
export function Convert_ToDecimal$string(c: Ctx, s: string | null): number {
  return s == null ? 0 : Double_Parse$string(c, s);
}
export function Convert_ToBoolean$string(c: Ctx, s: string | null): boolean {
  return s == null ? false : Boolean_Parse(c, s);
}
export function Convert_ToString$int_int(c: Ctx, v: number, base: number): string {
  void c;
  return (base === 10 ? v : v >>> 0).toString(base);
}
export function Convert_ToString$Object(c: Ctx, v: unknown): string {
  return formatValue(c, v);
}
export const Convert_ToString$int = Convert_ToString$Object;
export const Convert_ToString$float = Convert_ToString$Object;
export function Convert_ToBase64String$Byte_arr(c: Ctx, bytes: ArrayLike<number>): string {
  void c;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 255);
  return btoa(s);
}
export function Convert_ToBase64String$Byte_arr_int_int(c: Ctx, bytes: ArrayLike<number>, start: number, n: number): string {
  return Convert_ToBase64String$Byte_arr(c, Array.from(bytes).slice(start, start + n));
}
export function Convert_FromBase64String(c: Ctx, s: string): Uint8Array {
  void c;
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function BitConverter_GetBytes$double(c: Ctx, v: number): Uint8Array {
  void c;
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, v, true);
  return new Uint8Array(b.buffer);
}
export function BitConverter_GetBytes$float(c: Ctx, v: number): Uint8Array {
  void c;
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, v, true);
  return new Uint8Array(b.buffer);
}
export function BitConverter_GetBytes$int(c: Ctx, v: number): Uint8Array {
  void c;
  const b = new DataView(new ArrayBuffer(4));
  b.setInt32(0, v, true);
  return new Uint8Array(b.buffer);
}
export function BitConverter_ToDouble$Byte_arr_int(c: Ctx, bytes: ArrayLike<number>, i: number): number {
  void c;
  return new DataView(Uint8Array.from(Array.from(bytes).slice(i, i + 8)).buffer).getFloat64(0, true);
}
export function BitConverter_ToSingle$Byte_arr_int(c: Ctx, bytes: ArrayLike<number>, i: number): number {
  void c;
  return new DataView(Uint8Array.from(Array.from(bytes).slice(i, i + 4)).buffer).getFloat32(0, true);
}
export function BitConverter_ToInt32$Byte_arr_int(c: Ctx, bytes: ArrayLike<number>, i: number): number {
  void c;
  return new DataView(Uint8Array.from(Array.from(bytes).slice(i, i + 4)).buffer).getInt32(0, true);
}
export function BitConverter_ToString$Byte_arr(c: Ctx, bytes: ArrayLike<number>): string {
  void c;
  return Array.from(bytes, (b) => (b & 255).toString(16).toUpperCase().padStart(2, '0')).join('-');
}
export function BitConverter_get_IsLittleEndian(c: Ctx): boolean {
  void c;
  return true;
}
export function Encoding_GetString$Byte_arr(c: Ctx, enc: unknown, bytes: ArrayLike<number>): string {
  void c;
  void enc;
  return new TextDecoder().decode(Uint8Array.from(Array.from(bytes)));
}
export function Encoding_GetString$Byte_arr_int_int(c: Ctx, enc: unknown, bytes: ArrayLike<number>, i: number, n: number): string {
  void c;
  void enc;
  return new TextDecoder().decode(Uint8Array.from(Array.from(bytes).slice(i, i + n)));
}
export function Encoding_GetByteCount$string(c: Ctx, enc: unknown, s: string): number {
  void c;
  void enc;
  return new TextEncoder().encode(s).length;
}
export const Encoding_get_ASCII = (_c: Ctx): object => ({ name: 'UTF8' });
export const Encoding_get_Unicode = (_c: Ctx): object => ({ name: 'UTF8' });

// ───────── Char ─────────

export const Char_IsWhiteSpace$Char = (_c: Ctx, ch: string): boolean => WS.includes(ch);
export const Char_IsDigit$Char = (_c: Ctx, ch: string): boolean => /^\p{Nd}$/u.test(ch);
export const Char_IsNumber$Char = (_c: Ctx, ch: string): boolean => /^\p{N}$/u.test(ch);
export const Char_IsLetter$Char = (_c: Ctx, ch: string): boolean => /^\p{L}$/u.test(ch);
export const Char_IsLetterOrDigit$Char = (_c: Ctx, ch: string): boolean => /^[\p{L}\p{Nd}]$/u.test(ch);
export const Char_IsUpper$Char = (_c: Ctx, ch: string): boolean => /^\p{Lu}$/u.test(ch);
export const Char_IsLower$Char = (_c: Ctx, ch: string): boolean => /^\p{Ll}$/u.test(ch);
export const Char_IsPunctuation$Char = (_c: Ctx, ch: string): boolean => /^\p{P}$/u.test(ch);
export const Char_IsSymbol$Char = (_c: Ctx, ch: string): boolean => /^\p{S}$/u.test(ch);
export const Char_IsControl$Char = (_c: Ctx, ch: string): boolean => /^\p{Cc}$/u.test(ch);
export const Char_IsSeparator$Char = (_c: Ctx, ch: string): boolean => /^\p{Z}$/u.test(ch);
export const Char_IsSurrogate$Char = (_c: Ctx, ch: string): boolean => /^[\ud800-\udfff]$/.test(ch);
export const Char_IsHighSurrogate$Char = (_c: Ctx, ch: string): boolean => /^[\ud800-\udbff]$/.test(ch);
export const Char_IsLowSurrogate$Char = (_c: Ctx, ch: string): boolean => /^[\udc00-\udfff]$/.test(ch);
export const Char_ToUpper$Char = (_c: Ctx, ch: string): string => ch.toUpperCase();
export const Char_ToLower$Char = (_c: Ctx, ch: string): string => ch.toLowerCase();
export const Char_ToUpperInvariant = Char_ToUpper$Char;
export const Char_ToLowerInvariant = Char_ToLower$Char;
export const Char_GetNumericValue$Char = (_c: Ctx, ch: string): number => (/^\d$/.test(ch) ? Number(ch) : -1);
export const Char_ConvertFromUtf32 = (_c: Ctx, cp: number): string => String.fromCodePoint(cp);
export const Char_ConvertToUtf32$string_int = (_c: Ctx, s: string, i: number): number => s.codePointAt(i) ?? 0;
export const Char_Equals$Char = (_c: Ctx, a: string, b: string): boolean => a === b;
export const Char_CompareTo$Char = (_c: Ctx, a: string, b: string): number => a.charCodeAt(0) - b.charCodeAt(0);

// ───────── StringBuilder（dotnet.ts 的 StringBuilderJs；這裡補其他成員） ─────────

type SB = { s: string };
/** new StringBuilder(value, capacity)：容量只是預留，內容是 value */
export const new_StringBuilder$string_int = (c: Ctx, v: string | null, capacity: number): SB => (void capacity, new_StringBuilder$string(c, v));
export const new_StringBuilder$int_int = (c: Ctx, capacity: number, maxCapacity: number): SB => (void [capacity, maxCapacity], new_StringBuilder$(c));
/** new StringBuilder(value, startIndex, length, capacity)：value 的子字串 */
export const new_StringBuilder$string_int_int_int = (c: Ctx, v: string | null, start: number, n: number, capacity: number): SB =>
  (void capacity, new_StringBuilder$string(c, (v ?? '').substr(start, n)));
export function StringBuilder_AppendLine$(c: Ctx, b: SB): SB {
  void c;
  b.s += '\n';
  return b;
}
export function StringBuilder_AppendLine$string(c: Ctx, b: SB, v: string | null): SB {
  void c;
  b.s += (v ?? '') + '\n';
  return b;
}
export function StringBuilder_AppendFormat$string_Object(c: Ctx, b: SB, f: string, a: unknown): SB {
  b.s += compositeFormat(c, f, [a]);
  return b;
}
export function StringBuilder_AppendFormat$string_Object_Object(c: Ctx, b: SB, f: string, a: unknown, d: unknown): SB {
  b.s += compositeFormat(c, f, [a, d]);
  return b;
}
export function StringBuilder_AppendFormat$string_Object_Object_Object(c: Ctx, b: SB, f: string, a: unknown, d: unknown, e: unknown): SB {
  b.s += compositeFormat(c, f, [a, d, e]);
  return b;
}
export function StringBuilder_AppendFormat$string_Object_arr(c: Ctx, b: SB, f: string, args: unknown[]): SB {
  b.s += compositeFormat(c, f, args ?? []);
  return b;
}
export function StringBuilder_Append$Char(c: Ctx, b: SB, ch: string): SB {
  void c;
  b.s += ch;
  return b;
}
export function StringBuilder_Append$Char_int(c: Ctx, b: SB, ch: string, n: number): SB {
  void c;
  b.s += ch.repeat(n);
  return b;
}
export function StringBuilder_Append$Object(c: Ctx, b: SB, v: unknown): SB {
  b.s += formatValue(c, v);
  return b;
}
export const StringBuilder_Append$float = (c: Ctx, b: SB, v: number): SB => ((b.s += Single_ToString$(c, v)), b);
export const StringBuilder_Append$double = (c: Ctx, b: SB, v: number): SB => ((b.s += Double_ToString$(c, v)), b);
export const StringBuilder_Append$bool = (_c: Ctx, b: SB, v: boolean): SB => ((b.s += v ? 'True' : 'False'), b);
export const StringBuilder_Append$Int64 = (_c: Ctx, b: SB, v: number): SB => ((b.s += String(v)), b);
export const StringBuilder_Append$UInt32 = (_c: Ctx, b: SB, v: number): SB => ((b.s += String(v >>> 0)), b);
export function StringBuilder_Append$string_int_int(c: Ctx, b: SB, v: string, start: number, n: number): SB {
  void c;
  b.s += v.substr(start, n);
  return b;
}
export function StringBuilder_Append$Char_arr(c: Ctx, b: SB, chars: string[]): SB {
  void c;
  b.s += (chars ?? []).join('');
  return b;
}
export function StringBuilder_Append$StringBuilder(c: Ctx, b: SB, o: SB): SB {
  void c;
  b.s += o?.s ?? '';
  return b;
}
export function StringBuilder_Insert$int_string(c: Ctx, b: SB, i: number, v: string): SB {
  void c;
  b.s = b.s.slice(0, i) + (v ?? '') + b.s.slice(i);
  return b;
}
export function StringBuilder_Insert$int_Char(c: Ctx, b: SB, i: number, v: string): SB {
  return StringBuilder_Insert$int_string(c, b, i, v);
}
export function StringBuilder_Remove(c: Ctx, b: SB, i: number, n: number): SB {
  void c;
  b.s = b.s.slice(0, i) + b.s.slice(i + n);
  return b;
}
export function StringBuilder_Replace$string_string(c: Ctx, b: SB, a: string, d: string | null): SB {
  void c;
  b.s = b.s.split(a).join(d ?? '');
  return b;
}
export const StringBuilder_Replace$Char_Char = StringBuilder_Replace$string_string;
export function StringBuilder_get_Item(c: Ctx, b: SB, i: number): string {
  void c;
  return b.s[i];
}
export const StringBuilder_get_Chars = StringBuilder_get_Item;
export function StringBuilder_set_Item(c: Ctx, b: SB, i: number, ch: string): void {
  void c;
  b.s = b.s.slice(0, i) + ch + b.s.slice(i + 1);
}
export const StringBuilder_set_Chars = StringBuilder_set_Item;
export function StringBuilder_ToString$int_int(c: Ctx, b: SB, i: number, n: number): string {
  void c;
  return b.s.substr(i, n);
}
export function StringBuilder_get_Capacity(c: Ctx, b: SB): number {
  void c;
  return Math.max(16, b.s.length);
}
export function StringBuilder_set_Capacity(c: Ctx, b: SB, v: number): void {
  void c;
  void b;
  void v;
}
export function StringBuilder_EnsureCapacity(c: Ctx, b: SB, v: number): number {
  void c;
  return Math.max(v, b.s.length);
}

// ───────── HashCode、Guid、Environment、Stopwatch、Activator、Lazy ─────────

function mix(h: number, v: unknown): number {
  const x = v == null ? 0 : typeof v === 'number' && Number.isInteger(v) ? v | 0 : hashOf(v);
  h = (h + Math.imul(x, 0x9e3779b1)) | 0;
  h = Math.imul((h << 13) | (h >>> 19), 0x85ebca77);
  return h | 0;
}
function hashOf(v: unknown): number {
  if (typeof v === 'string') return String_GetHashCode$(staticCtx, v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Single_GetHashCode(staticCtx, v);
  if (v instanceof BoxedEnum) return v.value;
  const t = (v as { $type?: string }).$type;
  if (t && hasGen(t) && genMethodOf(t, 'GetHashCode')) return genCallVirtual(getActiveWorld(), t, v as object, 'GetHashCode') | 0;
  let id = hashIds.get(v as object);
  if (!id) hashIds.set(v as object, (id = ++hashSeq));
  return id;
}
const hashIds = new WeakMap<object, number>();
let hashSeq = 0;
const HC_SEED = 0x2d358dcc;
export const HashCode_Combine$T1 = (_c: Ctx, a: unknown): number => mix(HC_SEED, a);
export const HashCode_Combine$T1_T2 = (_c: Ctx, a: unknown, b: unknown): number => mix(mix(HC_SEED, a), b);
export const HashCode_Combine$T1_T2_T3 = (_c: Ctx, a: unknown, b: unknown, d: unknown): number => mix(mix(mix(HC_SEED, a), b), d);
export const HashCode_Combine$T1_T2_T3_T4 = (_c: Ctx, ...a: unknown[]): number => a.slice(0, 4).reduce<number>((h, x) => mix(h, x), HC_SEED);
export const HashCode_Combine$T1_T2_T3_T4_T5 = (_c: Ctx, ...a: unknown[]): number => a.slice(0, 5).reduce<number>((h, x) => mix(h, x), HC_SEED);
export const HashCode_Combine$T1_T2_T3_T4_T5_T6 = (_c: Ctx, ...a: unknown[]): number => a.slice(0, 6).reduce<number>((h, x) => mix(h, x), HC_SEED);
export const HashCode_Combine$T1_T2_T3_T4_T5_T6_T7 = (_c: Ctx, ...a: unknown[]): number => a.slice(0, 7).reduce<number>((h, x) => mix(h, x), HC_SEED);
export const HashCode_Combine$T1_T2_T3_T4_T5_T6_T7_T8 = (_c: Ctx, ...a: unknown[]): number => a.slice(0, 8).reduce<number>((h, x) => mix(h, x), HC_SEED);
/** HashCode 結構（new HashCode(); h.Add(x); h.ToHashCode()） */
export function new_HashCode(c: Ctx): { h: number } {
  void c;
  return { h: HC_SEED };
}
export function HashCode_Add$T(c: Ctx, hc: { h: number }, v: unknown): void {
  void c;
  hc.h = mix(hc.h, v);
}
export function HashCode_ToHashCode(c: Ctx, hc: { h: number }): number {
  void c;
  return hc.h;
}
export class GuidJs {
  constructor(readonly hex: string) {}
}
export function Guid_NewGuid(c: Ctx): GuidJs {
  void c;
  const u = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '00000000-0000-4000-8000-000000000000'.replace(/0/g, () => Math.floor(Math.random() * 16).toString(16));
  return new GuidJs(u.replace(/-/g, ''));
}
export function Guid_get_Empty(c: Ctx): GuidJs {
  void c;
  return new GuidJs('0'.repeat(32));
}
export function Guid_ToString$(c: Ctx, g: GuidJs): string {
  void c;
  const h = g.hex;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function Guid_ToString$string(c: Ctx, g: GuidJs, f: string): string {
  if (f === 'N' || f === 'n') return g.hex;
  const d = Guid_ToString$(c, g);
  if (f === 'B' || f === 'b') return `{${d}}`;
  if (f === 'P' || f === 'p') return `(${d})`;
  return d;
}
export function Guid_TryParse$string_Guid(c: Ctx, s: string, out: Out<GuidJs>): boolean {
  void c;
  const h = (s ?? '').replace(/[-{}()]/g, '');
  const ok = /^[0-9a-fA-F]{32}$/.test(h);
  out(new GuidJs(ok ? h.toLowerCase() : '0'.repeat(32)));
  return ok;
}
export function Guid_Parse$string(c: Ctx, s: string): GuidJs {
  let g: GuidJs | null = null;
  if (!Guid_TryParse$string_Guid(c, s, (x) => (g = x))) throw csErr('FormatException', `Guid.Parse("${s}")`);
  return g!;
}
export function Guid_op_Equality(c: Ctx, a: GuidJs, b: GuidJs): boolean {
  void c;
  return a?.hex === b?.hex;
}
export function Guid_op_Inequality(c: Ctx, a: GuidJs, b: GuidJs): boolean {
  void c;
  return a?.hex !== b?.hex;
}
export function Guid_Equals$Guid(c: Ctx, a: GuidJs, b: GuidJs): boolean {
  void c;
  return a?.hex === b?.hex;
}
export function Environment_get_NewLine(c: Ctx): string {
  void c;
  return '\n';
}
export function Environment_get_StackTrace(c: Ctx): string {
  void c;
  return new Error().stack ?? '';
}
export function Environment_get_TickCount(c: Ctx): number {
  void c;
  return Math.floor(performance.now()) | 0;
}
export function Environment_GetCommandLineArgs(c: Ctx): string[] {
  void c;
  return ['game'];
}
export function Environment_ExpandEnvironmentVariables(c: Ctx, s: string): string {
  void c;
  return s;
}
export function Environment_GetEnvironmentVariable$string(c: Ctx, k: string): string | null {
  void c;
  void k;
  return null;
}
export function Environment_get_ProcessorCount(c: Ctx): number {
  void c;
  return typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
}
export function Environment_get_MachineName(c: Ctx): string {
  void c;
  return 'web';
}
export function Environment_get_UserName(c: Ctx): string {
  void c;
  return 'player';
}
export function Environment_get_OSVersion(c: Ctx): { $type: string; VersionString: string } {
  void c;
  return { $type: 'OperatingSystem', VersionString: typeof navigator !== 'undefined' ? navigator.userAgent : 'web' };
}
export function Environment_GetFolderPath$SpecialFolder(c: Ctx, f: number): string {
  void c;
  return `/special/${f}`;
}
export class StopwatchJs {
  start = 0;
  acc = 0;
  running = false;
}
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
export function new_Stopwatch(c: Ctx): StopwatchJs {
  void c;
  return new StopwatchJs();
}
export function Stopwatch_StartNew(c: Ctx): StopwatchJs {
  void c;
  const s = new StopwatchJs();
  s.start = now();
  s.running = true;
  return s;
}
export function Stopwatch_Start(c: Ctx, s: StopwatchJs): void {
  void c;
  if (!s.running) {
    s.start = now();
    s.running = true;
  }
}
export function Stopwatch_Stop(c: Ctx, s: StopwatchJs): void {
  void c;
  if (s.running) {
    s.acc += now() - s.start;
    s.running = false;
  }
}
export function Stopwatch_Reset(c: Ctx, s: StopwatchJs): void {
  void c;
  s.acc = 0;
  s.running = false;
}
export function Stopwatch_Restart(c: Ctx, s: StopwatchJs): void {
  void c;
  s.acc = 0;
  s.start = now();
  s.running = true;
}
function elapsedMs(s: StopwatchJs): number {
  return s.acc + (s.running ? now() - s.start : 0);
}
export function Stopwatch_get_ElapsedMilliseconds(c: Ctx, s: StopwatchJs): number {
  void c;
  return Math.floor(elapsedMs(s));
}
export function Stopwatch_get_ElapsedTicks(c: Ctx, s: StopwatchJs): number {
  void c;
  return Math.floor(elapsedMs(s) * 10000);
}
export function Stopwatch_get_Elapsed(c: Ctx, s: StopwatchJs): TimeSpanJs {
  void c;
  return new TimeSpanJs(elapsedMs(s));
}
export function Stopwatch_get_IsRunning(c: Ctx, s: StopwatchJs): boolean {
  void c;
  return s.running;
}
export function Stopwatch_get_Frequency(c: Ctx): number {
  void c;
  return 10000000;
}
export function Stopwatch_GetTimestamp(c: Ctx): number {
  void c;
  return Math.floor(now() * 10000);
}
/** Activator.CreateInstance(type)／CreateInstance<T>()：產生的類別照無參數建構子 new；Unity 物件不行 */
export function Activator_CreateInstance$Type(c: Ctx, t: string): unknown {
  if (!hasGen(t)) throw csErr('MissingMethodException', `Activator.CreateInstance：${t} 沒有轉出`);
  return newGen(c, t, null);
}
export function Activator_CreateInstance$(c: Ctx, t: string): unknown {
  return Activator_CreateInstance$Type(c, t);
}
export function Activator_CreateInstance$Type_Object_arr(c: Ctx, t: string, args: unknown[]): unknown {
  if (!hasGen(t)) throw csErr('MissingMethodException', `Activator.CreateInstance：${t} 沒有轉出`);
  if (!args?.length) return newGen(c, t, null);
  throw csErr('MissingMethodException', `Activator.CreateInstance(${t}, 引數)：還沒做建構子的選擇`);
}

// ───────── DateTime、TimeSpan ─────────

/** DateTime：UTC 毫秒（epoch）＋ Kind（0 Unspecified、1 Utc、2 Local） */
export class DateTimeJs {
  constructor(
    readonly ms: number,
    readonly kind: number = 0,
  ) {}
}
export class TimeSpanJs {
  constructor(readonly ms: number) {}
}
const EPOCH_TICKS = 621355968000000000;
const MIN_MS = -62135596800000;
const MAX_MS = 253402300799999;
const localOffsetMs = (ms: number): number => -new Date(ms).getTimezoneOffset() * 60000;
export function DateTime_get_Now(c: Ctx): DateTimeJs {
  void c;
  const t = Date.now();
  return new DateTimeJs(t + localOffsetMs(t), 2);
}
export function DateTime_get_UtcNow(c: Ctx): DateTimeJs {
  void c;
  return new DateTimeJs(Date.now(), 1);
}
export function DateTime_get_Today(c: Ctx): DateTimeJs {
  const n = DateTime_get_Now(c);
  return new DateTimeJs(Math.floor(n.ms / 86400000) * 86400000, 2);
}
export function DateTime_get_MinValue(c: Ctx): DateTimeJs {
  void c;
  return new DateTimeJs(MIN_MS);
}
export function DateTime_get_MaxValue(c: Ctx): DateTimeJs {
  void c;
  return new DateTimeJs(MAX_MS);
}
export function new_DateTime$int_int_int(c: Ctx, y: number, mo: number, d: number): DateTimeJs {
  void c;
  return new DateTimeJs(Date.UTC(y, mo - 1, d));
}
export function new_DateTime$int_int_int_int_int_int(c: Ctx, y: number, mo: number, d: number, h: number, mi: number, s: number): DateTimeJs {
  void c;
  return new DateTimeJs(Date.UTC(y, mo - 1, d, h, mi, s));
}
export function new_DateTime$int_int_int_int_int_int_DateTimeKind(c: Ctx, y: number, mo: number, d: number, h: number, mi: number, s: number, k: number): DateTimeJs {
  void c;
  return new DateTimeJs(Date.UTC(y, mo - 1, d, h, mi, s), k);
}
export function new_DateTime$Int64(c: Ctx, ticks: number): DateTimeJs {
  void c;
  return new DateTimeJs((ticks - EPOCH_TICKS) / 10000);
}
export function new_DateTime$Int64_DateTimeKind(c: Ctx, ticks: number, k: number): DateTimeJs {
  void c;
  return new DateTimeJs((ticks - EPOCH_TICKS) / 10000, k);
}
const dt = (d: DateTimeJs) => new Date(d.ms);
export const DateTime_get_Year = (_c: Ctx, d: DateTimeJs): number => dt(d).getUTCFullYear();
export const DateTime_get_Month = (_c: Ctx, d: DateTimeJs): number => dt(d).getUTCMonth() + 1;
export const DateTime_get_Day = (_c: Ctx, d: DateTimeJs): number => dt(d).getUTCDate();
export const DateTime_get_Hour = (_c: Ctx, d: DateTimeJs): number => dt(d).getUTCHours();
export const DateTime_get_Minute = (_c: Ctx, d: DateTimeJs): number => dt(d).getUTCMinutes();
export const DateTime_get_Second = (_c: Ctx, d: DateTimeJs): number => dt(d).getUTCSeconds();
export const DateTime_get_Millisecond = (_c: Ctx, d: DateTimeJs): number => dt(d).getUTCMilliseconds();
export const DateTime_get_DayOfWeek = (_c: Ctx, d: DateTimeJs): number => dt(d).getUTCDay();
export const DateTime_get_DayOfYear = (_c: Ctx, d: DateTimeJs): number => Math.floor((d.ms - Date.UTC(dt(d).getUTCFullYear(), 0, 1)) / 86400000) + 1;
export const DateTime_get_Date = (_c: Ctx, d: DateTimeJs): DateTimeJs => new DateTimeJs(Math.floor(d.ms / 86400000) * 86400000, d.kind);
export const DateTime_get_TimeOfDay = (_c: Ctx, d: DateTimeJs): TimeSpanJs => new TimeSpanJs(((d.ms % 86400000) + 86400000) % 86400000);
export const DateTime_get_Ticks = (_c: Ctx, d: DateTimeJs): number => d.ms * 10000 + EPOCH_TICKS;
export const DateTime_get_Kind = (_c: Ctx, d: DateTimeJs): number => d.kind;
export const DateTime_AddSeconds = (_c: Ctx, d: DateTimeJs, s: number): DateTimeJs => new DateTimeJs(d.ms + s * 1000, d.kind);
export const DateTime_AddMilliseconds = (_c: Ctx, d: DateTimeJs, s: number): DateTimeJs => new DateTimeJs(d.ms + s, d.kind);
export const DateTime_AddMinutes = (_c: Ctx, d: DateTimeJs, s: number): DateTimeJs => new DateTimeJs(d.ms + s * 60000, d.kind);
export const DateTime_AddHours = (_c: Ctx, d: DateTimeJs, s: number): DateTimeJs => new DateTimeJs(d.ms + s * 3600000, d.kind);
export const DateTime_AddDays = (_c: Ctx, d: DateTimeJs, s: number): DateTimeJs => new DateTimeJs(d.ms + s * 86400000, d.kind);
export const DateTime_AddTicks = (_c: Ctx, d: DateTimeJs, t: number): DateTimeJs => new DateTimeJs(d.ms + t / 10000, d.kind);
export const DateTime_Add = (_c: Ctx, d: DateTimeJs, t: TimeSpanJs): DateTimeJs => new DateTimeJs(d.ms + t.ms, d.kind);
export function DateTime_AddMonths(c: Ctx, d: DateTimeJs, n: number): DateTimeJs {
  void c;
  const x = dt(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return new DateTimeJs(x.getTime(), d.kind);
}
export function DateTime_AddYears(c: Ctx, d: DateTimeJs, n: number): DateTimeJs {
  void c;
  const x = dt(d);
  x.setUTCFullYear(x.getUTCFullYear() + n);
  return new DateTimeJs(x.getTime(), d.kind);
}
export function DateTime_ToLocalTime(c: Ctx, d: DateTimeJs): DateTimeJs {
  void c;
  return d.kind === 2 ? d : new DateTimeJs(d.ms + localOffsetMs(d.ms), 2);
}
export function DateTime_ToUniversalTime(c: Ctx, d: DateTimeJs): DateTimeJs {
  void c;
  return d.kind === 1 ? d : new DateTimeJs(d.ms - localOffsetMs(d.ms), 1);
}
export const DateTime_op_Equality = (_c: Ctx, a: DateTimeJs, b: DateTimeJs): boolean => a.ms === b.ms;
export const DateTime_op_Inequality = (_c: Ctx, a: DateTimeJs, b: DateTimeJs): boolean => a.ms !== b.ms;
export const DateTime_op_LessThan = (_c: Ctx, a: DateTimeJs, b: DateTimeJs): boolean => a.ms < b.ms;
export const DateTime_op_GreaterThan = (_c: Ctx, a: DateTimeJs, b: DateTimeJs): boolean => a.ms > b.ms;
export const DateTime_op_LessThanOrEqual = (_c: Ctx, a: DateTimeJs, b: DateTimeJs): boolean => a.ms <= b.ms;
export const DateTime_op_GreaterThanOrEqual = (_c: Ctx, a: DateTimeJs, b: DateTimeJs): boolean => a.ms >= b.ms;
export const DateTime_op_Subtraction$DateTime_DateTime = (_c: Ctx, a: DateTimeJs, b: DateTimeJs): TimeSpanJs => new TimeSpanJs(a.ms - b.ms);
export const DateTime_op_Subtraction$DateTime_TimeSpan = (_c: Ctx, a: DateTimeJs, b: TimeSpanJs): DateTimeJs => new DateTimeJs(a.ms - b.ms, a.kind);
export const DateTime_op_Addition = (_c: Ctx, a: DateTimeJs, b: TimeSpanJs): DateTimeJs => new DateTimeJs(a.ms + b.ms, a.kind);
export const DateTime_Subtract$DateTime = DateTime_op_Subtraction$DateTime_DateTime;
export const DateTime_Subtract$TimeSpan = DateTime_op_Subtraction$DateTime_TimeSpan;
export const DateTime_CompareTo$DateTime = (_c: Ctx, a: DateTimeJs, b: DateTimeJs): number => Math.sign(a.ms - b.ms);
export const DateTime_Compare = DateTime_CompareTo$DateTime;
export const DateTime_Equals$DateTime = DateTime_op_Equality;
export const DateTime_GetHashCode = (_c: Ctx, d: DateTimeJs): number => d.ms | 0;
const p2 = (n: number) => String(n).padStart(2, '0');
/** DateTime.ToString(格式)：自訂格式的常見符號（yyyy MM dd HH mm ss fff tt）與標準格式 d、D、s、o、u、G（預設，en-US 的樣子） */
export function DateTime_ToString$string(c: Ctx, d: DateTimeJs, f: string | null): string {
  void c;
  const x = dt(d);
  const Y = x.getUTCFullYear();
  const M = x.getUTCMonth() + 1;
  const D = x.getUTCDate();
  const h = x.getUTCHours();
  const mi = x.getUTCMinutes();
  const s = x.getUTCSeconds();
  const ms = x.getUTCMilliseconds();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  if (!f || f === 'G') return `${M}/${D}/${Y} ${h12}:${p2(mi)}:${p2(s)} ${h < 12 ? 'AM' : 'PM'}`;
  if (f === 'd') return `${M}/${D}/${Y}`;
  if (f === 's') return `${Y}-${p2(M)}-${p2(D)}T${p2(h)}:${p2(mi)}:${p2(s)}`;
  if (f === 'u') return `${Y}-${p2(M)}-${p2(D)} ${p2(h)}:${p2(mi)}:${p2(s)}Z`;
  if (f === 'o' || f === 'O') return `${Y}-${p2(M)}-${p2(D)}T${p2(h)}:${p2(mi)}:${p2(s)}.${String(ms).padStart(3, '0')}0000${d.kind === 1 ? 'Z' : ''}`;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return f.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fff|ff|f|tt|'[^']*'/g, (t) => {
    switch (t) {
      case 'yyyy': return String(Y).padStart(4, '0');
      case 'yy': return p2(Y % 100);
      case 'MMMM': return MONTHS[M - 1];
      case 'MMM': return MONTHS[M - 1].slice(0, 3);
      case 'MM': return p2(M);
      case 'M': return String(M);
      case 'dddd': return DAYS[x.getUTCDay()];
      case 'ddd': return DAYS[x.getUTCDay()].slice(0, 3);
      case 'dd': return p2(D);
      case 'd': return String(D);
      case 'HH': return p2(h);
      case 'H': return String(h);
      case 'hh': return p2(h12);
      case 'h': return String(h12);
      case 'mm': return p2(mi);
      case 'm': return String(mi);
      case 'ss': return p2(s);
      case 's': return String(s);
      case 'fff': return String(ms).padStart(3, '0');
      case 'ff': return String(ms).padStart(3, '0').slice(0, 2);
      case 'f': return String(ms).padStart(3, '0').slice(0, 1);
      case 'tt': return h < 12 ? 'AM' : 'PM';
      default: return t.slice(1, -1);
    }
  });
}
export const DateTime_ToString$ = (c: Ctx, d: DateTimeJs): string => DateTime_ToString$string(c, d, null);
export const DateTime_ToString$string_IFormatProvider = (c: Ctx, d: DateTimeJs, f: string): string => DateTime_ToString$string(c, d, f);
export const DateTime_ToString$IFormatProvider = DateTime_ToString$;
export const DateTime_ToShortDateString = (c: Ctx, d: DateTimeJs): string => DateTime_ToString$string(c, d, 'd');
export const DateTime_ToBinary = (c: Ctx, d: DateTimeJs): number => DateTime_get_Ticks(c, d);
export const DateTime_FromBinary = (c: Ctx, v: number): DateTimeJs => new_DateTime$Int64(c, v);
export function DateTime_TryParse$string_DateTime(c: Ctx, s: string, out: Out<DateTimeJs>): boolean {
  void c;
  const t = s == null ? NaN : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  out(new DateTimeJs(Number.isNaN(t) ? MIN_MS : t));
  return !Number.isNaN(t);
}
export const DateTime_TryParse$string_IFormatProvider_DateTimeStyles_DateTime = (c: Ctx, s: string, _p: unknown, _st: unknown, out: Out<DateTimeJs>): boolean => DateTime_TryParse$string_DateTime(c, s, out);
export function DateTime_TryParseExact$string_string_IFormatProvider_DateTimeStyles_DateTime(c: Ctx, s: string, f: string, p: unknown, st: unknown, out: Out<DateTimeJs>): boolean {
  void f;
  void p;
  void st;
  return DateTime_TryParse$string_DateTime(c, s, out);
}
export function DateTime_Parse$string(c: Ctx, s: string): DateTimeJs {
  let d: DateTimeJs | null = null;
  if (!DateTime_TryParse$string_DateTime(c, s, (x) => (d = x))) throw csErr('FormatException', `DateTime.Parse("${s}")`);
  return d!;
}
export const DateTime_Parse$string_IFormatProvider = DateTime_Parse$string;
export const DateTime_SpecifyKind = (_c: Ctx, d: DateTimeJs, k: number): DateTimeJs => new DateTimeJs(d.ms, k);
export const DateTime_IsLeapYear = (_c: Ctx, y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
export const DateTime_DaysInMonth = (_c: Ctx, y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const DateTimeOffset_get_UtcNow = (c: Ctx): DateTimeJs => DateTime_get_UtcNow(c);
export const DateTimeOffset_ToUnixTimeSeconds = (_c: Ctx, d: DateTimeJs): number => Math.floor(d.ms / 1000);
export const DateTimeOffset_ToUnixTimeMilliseconds = (_c: Ctx, d: DateTimeJs): number => Math.floor(d.ms);
export const DateTimeOffset_FromUnixTimeSeconds = (_c: Ctx, s: number): DateTimeJs => new DateTimeJs(s * 1000, 1);
export const DateTimeOffset_FromUnixTimeMilliseconds = (_c: Ctx, s: number): DateTimeJs => new DateTimeJs(s, 1);
export const DateTimeOffset_get_DateTime = (_c: Ctx, d: DateTimeJs): DateTimeJs => d;
export const DateTimeOffset_get_UtcDateTime = (_c: Ctx, d: DateTimeJs): DateTimeJs => d;

export const TimeSpan_get_Zero = (_c: Ctx): TimeSpanJs => new TimeSpanJs(0);
export const TimeSpan_get_MaxValue = (_c: Ctx): TimeSpanJs => new TimeSpanJs(922337203685477);
export const TimeSpan_get_MinValue = (_c: Ctx): TimeSpanJs => new TimeSpanJs(-922337203685477);
export const TimeSpan_FromSeconds = (_c: Ctx, s: number): TimeSpanJs => new TimeSpanJs(Math.round(s * 1000));
export const TimeSpan_FromMilliseconds = (_c: Ctx, s: number): TimeSpanJs => new TimeSpanJs(Math.round(s));
export const TimeSpan_FromMinutes = (_c: Ctx, s: number): TimeSpanJs => new TimeSpanJs(Math.round(s * 60000));
export const TimeSpan_FromHours = (_c: Ctx, s: number): TimeSpanJs => new TimeSpanJs(Math.round(s * 3600000));
export const TimeSpan_FromDays = (_c: Ctx, s: number): TimeSpanJs => new TimeSpanJs(Math.round(s * 86400000));
export const TimeSpan_FromTicks = (_c: Ctx, t: number): TimeSpanJs => new TimeSpanJs(t / 10000);
export const new_TimeSpan$int_int_int = (_c: Ctx, h: number, m: number, s: number): TimeSpanJs => new TimeSpanJs(((h * 60 + m) * 60 + s) * 1000);
export const new_TimeSpan$int_int_int_int = (_c: Ctx, d: number, h: number, m: number, s: number): TimeSpanJs => new TimeSpanJs((((d * 24 + h) * 60 + m) * 60 + s) * 1000);
export const new_TimeSpan$Int64 = (_c: Ctx, t: number): TimeSpanJs => new TimeSpanJs(t / 10000);
export const TimeSpan_get_TotalSeconds = (_c: Ctx, t: TimeSpanJs): number => t.ms / 1000;
export const TimeSpan_get_TotalMilliseconds = (_c: Ctx, t: TimeSpanJs): number => t.ms;
export const TimeSpan_get_TotalMinutes = (_c: Ctx, t: TimeSpanJs): number => t.ms / 60000;
export const TimeSpan_get_TotalHours = (_c: Ctx, t: TimeSpanJs): number => t.ms / 3600000;
export const TimeSpan_get_TotalDays = (_c: Ctx, t: TimeSpanJs): number => t.ms / 86400000;
export const TimeSpan_get_Ticks = (_c: Ctx, t: TimeSpanJs): number => Math.round(t.ms * 10000);
export const TimeSpan_get_Days = (_c: Ctx, t: TimeSpanJs): number => Math.trunc(t.ms / 86400000);
export const TimeSpan_get_Hours = (_c: Ctx, t: TimeSpanJs): number => Math.trunc(t.ms / 3600000) % 24;
export const TimeSpan_get_Minutes = (_c: Ctx, t: TimeSpanJs): number => Math.trunc(t.ms / 60000) % 60;
export const TimeSpan_get_Seconds = (_c: Ctx, t: TimeSpanJs): number => Math.trunc(t.ms / 1000) % 60;
export const TimeSpan_get_Milliseconds = (_c: Ctx, t: TimeSpanJs): number => Math.trunc(t.ms) % 1000;
export const TimeSpan_op_Addition = (_c: Ctx, a: TimeSpanJs, b: TimeSpanJs): TimeSpanJs => new TimeSpanJs(a.ms + b.ms);
export const TimeSpan_op_Subtraction = (_c: Ctx, a: TimeSpanJs, b: TimeSpanJs): TimeSpanJs => new TimeSpanJs(a.ms - b.ms);
export const TimeSpan_op_UnaryNegation = (_c: Ctx, a: TimeSpanJs): TimeSpanJs => new TimeSpanJs(-a.ms);
export const TimeSpan_op_LessThan = (_c: Ctx, a: TimeSpanJs, b: TimeSpanJs): boolean => a.ms < b.ms;
export const TimeSpan_op_GreaterThan = (_c: Ctx, a: TimeSpanJs, b: TimeSpanJs): boolean => a.ms > b.ms;
export const TimeSpan_op_LessThanOrEqual = (_c: Ctx, a: TimeSpanJs, b: TimeSpanJs): boolean => a.ms <= b.ms;
export const TimeSpan_op_GreaterThanOrEqual = (_c: Ctx, a: TimeSpanJs, b: TimeSpanJs): boolean => a.ms >= b.ms;
export const TimeSpan_op_Equality = (_c: Ctx, a: TimeSpanJs, b: TimeSpanJs): boolean => a.ms === b.ms;
export const TimeSpan_op_Inequality = (_c: Ctx, a: TimeSpanJs, b: TimeSpanJs): boolean => a.ms !== b.ms;
export const TimeSpan_Add = TimeSpan_op_Addition;
export const TimeSpan_Subtract = TimeSpan_op_Subtraction;
export const TimeSpan_Duration = (_c: Ctx, a: TimeSpanJs): TimeSpanJs => new TimeSpanJs(Math.abs(a.ms));
export const TimeSpan_CompareTo$TimeSpan = (_c: Ctx, a: TimeSpanJs, b: TimeSpanJs): number => Math.sign(a.ms - b.ms);
/** TimeSpan.ToString()：[-][d.]hh:mm:ss[.fffffff] */
export function TimeSpan_ToString$(c: Ctx, t: TimeSpanJs): string {
  void c;
  const neg = t.ms < 0;
  const a = Math.abs(t.ms);
  const d = Math.floor(a / 86400000);
  const h = Math.floor(a / 3600000) % 24;
  const m = Math.floor(a / 60000) % 60;
  const s = Math.floor(a / 1000) % 60;
  const frac = Math.round((a % 1000) * 10000);
  return `${neg ? '-' : ''}${d ? `${d}.` : ''}${p2(h)}:${p2(m)}:${p2(s)}${frac ? `.${String(frac).padStart(7, '0')}` : ''}`;
}
export function TimeSpan_ToString$string(c: Ctx, t: TimeSpanJs, f: string): string {
  void c;
  const a = Math.abs(t.ms);
  const vals: Record<string, number> = { d: Math.floor(a / 86400000), h: Math.floor(a / 3600000) % 24, m: Math.floor(a / 60000) % 60, s: Math.floor(a / 1000) % 60, f: Math.floor(a % 1000) };
  if (f === 'c' || f === 'g' || f === 'G') return TimeSpan_ToString$(c, t);
  return f.replace(/\\(.)/g, '\u0000$1').replace(/dd?|hh?|mm?|ss?|f{1,3}/g, (k) => {
    const v = vals[k[0]];
    if (k[0] === 'f') return String(v).padStart(3, '0').slice(0, k.length);
    return k.length === 2 ? p2(v) : String(v);
  }).replace(/\u0000(.)/g, '$1');
}

// ───────── Path（虛擬檔案系統用 / 分隔） ─────────

export function Path_Combine$string_string(c: Ctx, a: string, b: string): string {
  void c;
  if (b.startsWith('/') || /^[A-Za-z]:[\\/]/.test(b)) return b;
  if (!a) return b;
  return a.endsWith('/') || a.endsWith('\\') ? a + b : `${a}/${b}`;
}
export const Path_Combine$string_string_string = (c: Ctx, a: string, b: string, d: string): string => Path_Combine$string_string(c, Path_Combine$string_string(c, a, b), d);
export const Path_Combine$string_string_string_string = (c: Ctx, a: string, b: string, d: string, e: string): string => Path_Combine$string_string(c, Path_Combine$string_string_string(c, a, b, d), e);
export const Path_Combine$String_arr = (c: Ctx, parts: string[]): string => parts.reduce((x, y) => Path_Combine$string_string(c, x, y), '');
export const Path_Join$string_string = Path_Combine$string_string;
function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
export const Path_GetFileName$string = (_c: Ctx, p: string | null): string | null => (p == null ? null : baseName(p));
export function Path_GetFileNameWithoutExtension$string(c: Ctx, p: string | null): string | null {
  void c;
  if (p == null) return null;
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}
export function Path_GetExtension$string(c: Ctx, p: string | null): string | null {
  void c;
  if (p == null) return null;
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i >= 0 && i < b.length - 1 ? b.slice(i) : '';
}
export function Path_GetDirectoryName$string(c: Ctx, p: string | null): string | null {
  void c;
  if (p == null) return null;
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : i === 0 ? '/' : '';
}
export function Path_ChangeExtension(c: Ctx, p: string | null, ext: string | null): string | null {
  void c;
  if (p == null) return null;
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  const stem = i > 0 ? p.slice(0, p.length - (b.length - i)) : p;
  return ext == null ? stem : stem + (ext.startsWith('.') ? ext : `.${ext}`);
}
export const Path_GetFullPath$string = (_c: Ctx, p: string): string => p;
export const Path_HasExtension = (_c: Ctx, p: string): boolean => /\.[^./\\]+$/.test(p ?? '');
export const Path_IsPathRooted$string = (_c: Ctx, p: string): boolean => !!p && (p.startsWith('/') || /^[A-Za-z]:/.test(p));
export const Path_GetInvalidFileNameChars = (_c: Ctx): string[] => ['"', '<', '>', '|', '\u0000', ':', '*', '?', '\\', '/', ...Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1))];
export const Path_GetInvalidPathChars = (_c: Ctx): string[] => ['"', '<', '>', '|', '\u0000', ...Array.from({ length: 31 }, (_, i) => String.fromCharCode(i + 1))];
export const Path_GetTempPath = (_c: Ctx): string => '/temp/';
export const Path_GetRandomFileName = (_c: Ctx): string => Math.random().toString(36).slice(2, 10) + '.tmp';
export function Path_get_DirectorySeparatorChar(c: Ctx): string {
  void c;
  return '/';
}
export function Path_get_AltDirectorySeparatorChar(c: Ctx): string {
  void c;
  return '/';
}

// ───────── Regex（JS 的 RegExp；.NET 專屬語法只做常見的：(?i) 開頭、命名群組） ─────────

/**
 * .NET 的正規式 → JS：字元類別相減 [A-[B]] 改成 (?:(?![B])[A])；群組中間的行內選項 (?i) 改成 (?i:…) 包到所屬群組的結尾
 * （JS 的 regexp modifiers）；(?'名字'…) 改成 (?<名字>…)；\A、\z、\Z 改成 ^、$；原子群組 (?>…) 當一般群組。
 */
export function translateDotNetRegex(p: string): string {
  let out = '';
  // 開著的群組：每層記住要不要在結尾多補一個 )（行內選項改成的 (?i: 群組）
  const groups: number[] = [];
  let i = 0;
  const readClass = (start: number): { body: string; end: number } => {
    // start 指在 [ 上；回傳 [ 之後到對應 ] 之前的內容（含巢狀的相減）與結束位置
    let j = start + 1;
    let body = '';
    if (p[j] === '^') body += p[j++];
    if (p[j] === ']') body += p[j++];
    while (j < p.length && p[j] !== ']') {
      if (p[j] === '\\') {
        body += p[j] + (p[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (p[j] === '-' && p[j + 1] === '[') {
        const sub = readClass(j + 1);
        return { body: `\u0000SUB${body}\u0000${sub.body}`, end: sub.end + 1 };
      }
      body += p[j++];
    }
    return { body, end: j };
  };
  while (i < p.length) {
    const ch = p[i];
    if (ch === '\\') {
      const nx = p[i + 1];
      if (nx === 'A') out += '^';
      else if (nx === 'z' || nx === 'Z') out += '$';
      else out += ch + (nx ?? '');
      i += 2;
      continue;
    }
    if (ch === '[') {
      const { body, end } = readClass(i);
      if (body.startsWith('\u0000SUB')) {
        const [, base, sub] = body.split('\u0000');
        out += `(?:(?![${sub}])[${base.slice(3)}])`;
      } else out += `[${body}]`;
      i = end + 1;
      continue;
    }
    if (ch === '(') {
      const m = /^\(\?([imnsx]*)(?:-([imnsx]*))?\)/.exec(p.slice(i));
      if (m && (m[1] || m[2])) {
        const on = m[1].replace(/[nx]/g, '');
        const off = (m[2] ?? '').replace(/[nx]/g, '');
        if (on || off) {
          out += `(?${on}${off ? `-${off}` : ''}:`;
          if (groups.length) groups[groups.length - 1]++;
          else groups.push(1);
        }
        i += m[0].length;
        continue;
      }
      if (p.startsWith("(?'", i)) {
        const e = p.indexOf("'", i + 3);
        out += `(?<${p.slice(i + 3, e)}>`;
        i = e + 1;
        groups.push(0);
        continue;
      }
      if (p.startsWith('(?>', i)) {
        out += '(?:';
        i += 3;
        groups.push(0);
        continue;
      }
      out += ch;
      i++;
      groups.push(0);
      continue;
    }
    if (ch === ')') {
      const extra = groups.pop() ?? 0;
      out += ')'.repeat(extra) + ')';
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  // 最外層的行內選項：補到結尾
  for (const extra of groups) out += ')'.repeat(extra);
  return out;
}

export class RegexJs {
  readonly re: RegExp;
  constructor(pattern: string, options = 0) {
    let flags = 'g';
    let p = pattern;
    // 開頭的行內選項當整個式子的旗標（不必用 JS 的 modifiers）
    const inline = /^\(\?([imnsx]+)\)/.exec(p);
    if (inline) {
      p = p.slice(inline[0].length);
      if (inline[1].includes('i')) flags += 'i';
      if (inline[1].includes('m')) flags += 'm';
      if (inline[1].includes('s')) flags += 's';
    }
    p = translateDotNetRegex(p);
    if (options & 1) flags += 'i';
    if (options & 2) flags += 'm';
    if (options & 16) flags += 's';
    // .NET 的正規式允許單獨的 ]、{（JS 的 u 旗標不准）：只有用到 \p{…} 才開 u
    this.re = new RegExp(p, [...new Set(flags)].join('') + (/\\[pP]\{/.test(p) ? 'u' : ''));
  }
}
const regexCache = new Map<string, RegexJs>();
function rx(pattern: string, options = 0): RegexJs {
  const k = `${options}:${pattern}`;
  let r = regexCache.get(k);
  if (!r) regexCache.set(k, (r = new RegexJs(pattern, options)));
  return r;
}
export class MatchJs {
  constructor(
    readonly m: RegExpExecArray | null,
    readonly r: RegexJs | null = null,
  ) {}
}
function exec(r: RegexJs, s: string, start = 0): MatchJs {
  r.re.lastIndex = start;
  return new MatchJs(r.re.exec(s), r);
}
export const new_Regex$string = (_c: Ctx, p: string): RegexJs => new RegexJs(p);
export const new_Regex$string_RegexOptions = (_c: Ctx, p: string, o: number): RegexJs => new RegexJs(p, o);
export const Regex_Match$string_string = (_c: Ctx, s: string, p: string): MatchJs => exec(rx(p), s);
export const Regex_Match$string_string_RegexOptions = (_c: Ctx, s: string, p: string, o: number): MatchJs => exec(rx(p, o), s);
export const Regex_Match$string = (_c: Ctx, r: RegexJs, s: string): MatchJs => exec(r, s);
export const Regex_Match$string_int = (_c: Ctx, r: RegexJs, s: string, i: number): MatchJs => exec(r, s, i);
export const Regex_IsMatch$string_string = (_c: Ctx, s: string, p: string): boolean => !!exec(rx(p), s).m;
export const Regex_IsMatch$string_string_RegexOptions = (_c: Ctx, s: string, p: string, o: number): boolean => !!exec(rx(p, o), s).m;
export const Regex_IsMatch$string = (_c: Ctx, r: RegexJs, s: string): boolean => !!exec(r, s).m;
function matchesOf(r: RegexJs, s: string): MatchJs[] {
  const out: MatchJs[] = [];
  r.re.lastIndex = 0;
  for (let m = r.re.exec(s); m; m = r.re.exec(s)) {
    out.push(new MatchJs(m, r));
    if (m[0] === '') r.re.lastIndex++;
  }
  return out;
}
export const Regex_Matches$string_string = (_c: Ctx, s: string, p: string): MatchJs[] => matchesOf(rx(p), s);
export const Regex_Matches$string = (_c: Ctx, r: RegexJs, s: string): MatchJs[] => matchesOf(r, s);
/** .NET 的替換字串（$1、${name}、$$）跟 JS 的寫法大致一樣 */
export const Regex_Replace$string_string_string = (_c: Ctx, s: string, p: string, rep: string): string => s.replace(rx(p).re, rep);
export const Regex_Replace$string_string_string_RegexOptions = (_c: Ctx, s: string, p: string, rep: string, o: number): string => s.replace(rx(p, o).re, rep);
export const Regex_Replace$string_string = (_c: Ctx, r: RegexJs, s: string, rep: string): string => s.replace(r.re, rep);
export function Regex_Replace$string_string_MatchEvaluator(c: Ctx, s: string, p: string, ev: unknown): string {
  return s.replace(rx(p).re, (...a) => String(invokeDelegate(c, ev, new MatchJs(Object.assign([...a.slice(0, -2)] as unknown as RegExpExecArray, { index: a[a.length - 2], input: s })))));
}
export function Regex_Replace$string_MatchEvaluator(c: Ctx, r: RegexJs, s: string, ev: unknown): string {
  return s.replace(r.re, (...a) => String(invokeDelegate(c, ev, new MatchJs(Object.assign([...a.slice(0, -2)] as unknown as RegExpExecArray, { index: a[a.length - 2], input: s })))));
}
export const Regex_Split$string_string = (_c: Ctx, s: string, p: string): string[] => s.split(new RegExp(rx(p).re.source, rx(p).re.flags.replace('g', '')));
export const Regex_Split$string = (_c: Ctx, r: RegexJs, s: string): string[] => s.split(new RegExp(r.re.source, r.re.flags.replace('g', '')));
export const Regex_Escape = (_c: Ctx, s: string): string => s.replace(/[\\^$.*+?()[\]{}|#\s-]/g, (x) => (x === ' ' ? '\\ ' : `\\${x}`));
export const Group_get_Success = (_c: Ctx, g: MatchJs | GroupJs): boolean => (g instanceof GroupJs ? g.value !== undefined : !!g.m);
export const Match_get_Success = Group_get_Success;
export function Capture_get_Value(c: Ctx, g: MatchJs | GroupJs): string {
  void c;
  return g instanceof GroupJs ? (g.value ?? '') : (g.m?.[0] ?? '');
}
export const Group_get_Value = Capture_get_Value;
export const Match_get_Value = Capture_get_Value;
export const Capture_ToString = Capture_get_Value;
export function Capture_get_Index(c: Ctx, g: MatchJs | GroupJs): number {
  void c;
  return g instanceof GroupJs ? g.index : (g.m?.index ?? 0);
}
export const Group_get_Index = Capture_get_Index;
export const Match_get_Index = Capture_get_Index;
export function Capture_get_Length(c: Ctx, g: MatchJs | GroupJs): number {
  return Capture_get_Value(c, g).length;
}
export const Group_get_Length = Capture_get_Length;
export const Match_get_Length = Capture_get_Length;
export class GroupJs {
  constructor(
    readonly value: string | undefined,
    readonly index: number,
  ) {}
}
export function Match_get_Groups(c: Ctx, m: MatchJs): MatchJs {
  void c;
  return m;
}
export function GroupCollection_get_Item(c: Ctx, m: MatchJs, k: number | string): GroupJs {
  void c;
  const v = typeof k === 'number' ? m.m?.[k] : m.m?.groups?.[k];
  const idx = v === undefined || !m.m ? 0 : m.m.index + Math.max(0, m.m[0].indexOf(v));
  return new GroupJs(v, idx);
}
export const GroupCollection_get_Item$int = GroupCollection_get_Item;
export const GroupCollection_get_Item$string = GroupCollection_get_Item;
export function GroupCollection_get_Count(c: Ctx, m: MatchJs): number {
  void c;
  return m.m ? m.m.length : 0;
}
export function Match_NextMatch(c: Ctx, m: MatchJs): MatchJs {
  void c;
  if (!m.m || !m.r) return new MatchJs(null);
  return exec(m.r, m.m.input, m.m.index + Math.max(1, m.m[0].length));
}
/**
 * Group.Captures／Match.Captures：這一組每次捕捉到的子字串。整個比對（Match、第 0 組）成功時剛好一個。
 * 與 .NET 的差異：其他組被量詞重複捕捉時（(ab)+），JS 只留最後一次，這裡也只有那一個
 */
export function Group_get_Captures(c: Ctx, g: MatchJs | GroupJs): (MatchJs | GroupJs)[] {
  void c;
  return (g instanceof GroupJs ? g.value !== undefined : !!g.m) ? [g] : [];
}
export const Match_get_Captures = Group_get_Captures;
export const CaptureCollection_get_Count = (_c: Ctx, cs: unknown[]): number => cs.length;
export const CaptureCollection_get_Item = (_c: Ctx, cs: unknown[], i: number): unknown => cs[i];
export const CaptureCollection_toArray = (_c: Ctx, cs: unknown[]): unknown[] => cs;
export const MatchCollection_get_Count = (_c: Ctx, ms: MatchJs[]): number => ms.length;
export const MatchCollection_get_Item = (_c: Ctx, ms: MatchJs[], i: number): MatchJs => ms[i];
export const MatchCollection_toArray = (_c: Ctx, ms: MatchJs[]): MatchJs[] => ms;

// ───────── 文化、比較器 ─────────

const INVARIANT = { $type: 'CultureInfo', Name: '', TwoLetterISOLanguageName: 'iv' };
const CURRENT = { $type: 'CultureInfo', Name: 'en-US', TwoLetterISOLanguageName: 'en' };
export const CultureInfo_get_InvariantCulture = (_c: Ctx): object => INVARIANT;
export const CultureInfo_get_CurrentCulture = (_c: Ctx): object => CURRENT;
export const CultureInfo_get_CurrentUICulture = (_c: Ctx): object => CURRENT;
export const CultureInfo_CreateSpecificCulture = (_c: Ctx, name: string): object => ({ $type: 'CultureInfo', Name: name, TwoLetterISOLanguageName: name.split('-')[0] });
export const new_CultureInfo$string = CultureInfo_CreateSpecificCulture;
export const CultureInfo_GetCultureInfo$string = CultureInfo_CreateSpecificCulture;
export const CultureInfo_get_Name = (_c: Ctx, ci: { Name: string }): string => ci.Name;
export const CultureInfo_get_TwoLetterISOLanguageName = (_c: Ctx, ci: { TwoLetterISOLanguageName: string }): string => ci.TwoLetterISOLanguageName;
export const CultureInfo_get_Calendar = (_c: Ctx): object => ({ $type: 'GregorianCalendar' });
// Calendar（目前的文化固定是公曆，取值跟 DateTime 自己的一樣）
export const Calendar_GetYear = (c: Ctx, _cal: unknown, d: DateTimeJs): number => DateTime_get_Year(c, d);
export const Calendar_GetMonth = (c: Ctx, _cal: unknown, d: DateTimeJs): number => DateTime_get_Month(c, d);
export const Calendar_GetDayOfMonth = (c: Ctx, _cal: unknown, d: DateTimeJs): number => DateTime_get_Day(c, d);
export const Calendar_GetHour = (c: Ctx, _cal: unknown, d: DateTimeJs): number => DateTime_get_Hour(c, d);
export const Calendar_GetMinute = (c: Ctx, _cal: unknown, d: DateTimeJs): number => DateTime_get_Minute(c, d);
export const Calendar_GetSecond = (c: Ctx, _cal: unknown, d: DateTimeJs): number => DateTime_get_Second(c, d);
/** Calendar.ToDateTime(年, 月, 日, 時, 分, 秒, 毫秒)：Kind 是 Unspecified */
export const Calendar_ToDateTime$int_int_int_int_int_int_int = (_c: Ctx, _cal: unknown, y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): DateTimeJs =>
  new DateTimeJs(Date.UTC(y, mo - 1, d, h, mi, s, ms));
export const CultureInfo_get_NumberFormat = (_c: Ctx): object => ({ $type: 'NumberFormatInfo', NumberDecimalSeparator: '.', NumberGroupSeparator: ',' });
export const CultureInfo_get_TextInfo = (_c: Ctx): object => ({ $type: 'TextInfo' });
export const TextInfo_ToTitleCase = (_c: Ctx, _ti: unknown, s: string): string => s.replace(/\b\p{L}+/gu, (w) => (w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()));
export const NumberFormatInfo_get_InvariantInfo = (_c: Ctx): object => ({ $type: 'NumberFormatInfo', NumberDecimalSeparator: '.', NumberGroupSeparator: ',' });
export const NumberFormatInfo_get_CurrentInfo = NumberFormatInfo_get_InvariantInfo;
export const ORDINAL = { $type: 'StringComparer', name: 'Ordinal' };
export const ORDINAL_IGNORE_CASE = { $type: 'StringComparer', name: 'OrdinalIgnoreCase' };
export const StringComparer_get_Ordinal = (_c: Ctx): object => ORDINAL;
export const StringComparer_get_OrdinalIgnoreCase = (_c: Ctx): object => ORDINAL_IGNORE_CASE;
export const StringComparer_get_InvariantCultureIgnoreCase = (_c: Ctx): object => ORDINAL_IGNORE_CASE;
export const StringComparer_get_CurrentCultureIgnoreCase = (_c: Ctx): object => ORDINAL_IGNORE_CASE;
export const StringComparer_get_InvariantCulture = (_c: Ctx): object => ORDINAL;
export function StringComparer_Compare$string_string(c: Ctx, cmp: unknown, a: string, b: string): number {
  return toCmp(c, cmp)(a, b);
}
export function StringComparer_Equals$string_string(c: Ctx, cmp: unknown, a: string | null, b: string | null): boolean {
  void c;
  if (a == null || b == null) return a === b;
  return cmp === ORDINAL_IGNORE_CASE ? a.toUpperCase() === b.toUpperCase() : a === b;
}

// ───────── object ─────────

/** new object()（lock 用的物件、哨兵值） */
export function new_Object(c: Ctx): object {
  void c;
  return { $type: 'Object' };
}

// ───────── Uri ─────────

/** System.Uri：網址字串包一層（ToString 是原字串；主機、路徑等照 WHATWG URL 解析） */
export class UriJs {
  readonly $type = 'Uri';
  constructor(readonly original: string) {}
  toString(): string {
    return this.original;
  }
  url(): URL | null {
    try {
      return new URL(this.original);
    } catch {
      return null;
    }
  }
}
export const new_Uri$string = (_c: Ctx, s: string): UriJs => new UriJs(s);
export const Uri_ToString = (_c: Ctx, u: UriJs): string => u.original;
export const Uri_get_AbsoluteUri = (_c: Ctx, u: UriJs): string => u.url()?.href ?? u.original;
export const Uri_get_OriginalString = (_c: Ctx, u: UriJs): string => u.original;
export const Uri_get_Host = (_c: Ctx, u: UriJs): string => u.url()?.hostname ?? '';
export const Uri_get_AbsolutePath = (_c: Ctx, u: UriJs): string => u.url()?.pathname ?? '';
export const Uri_get_Query = (_c: Ctx, u: UriJs): string => u.url()?.search ?? '';
export const Uri_get_Scheme = (_c: Ctx, u: UriJs): string => u.url()?.protocol.replace(/:$/, '') ?? '';
export const Uri_EscapeDataString = (_c: Ctx, s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (x) => `%${x.charCodeAt(0).toString(16).toUpperCase()}`);
export const Uri_EscapeUriString = (_c: Ctx, s: string): string => encodeURI(s);
export const Uri_UnescapeDataString = (_c: Ctx, s: string): string => decodeURIComponent(s);

// ───────── SortedDictionary、SortedList（Map；列舉時照 key 排序，Comparer<TKey>.Default） ─────────

export const new_SortedDictionary$ = (_c: Ctx): Map<unknown, unknown> => new Map();
export const new_SortedDictionary$IComparer = new_SortedDictionary$;
export const new_SortedList$ = new_SortedDictionary$;
const sortedKeys = (d: Map<unknown, unknown>): unknown[] => [...d.keys()].sort(defaultCompare);
export const SortedDictionary_Add = (_c: Ctx, d: Map<unknown, unknown>, k: unknown, v: unknown): void => {
  if (d.has(k)) throw csErr('ArgumentException', 'An item with the same key has already been added.');
  d.set(k, v);
};
export const SortedList_Add = SortedDictionary_Add;
export const SortedDictionary_TryGetValue = (_c: Ctx, d: Map<unknown, unknown>, k: unknown, out: Out<unknown>): boolean => {
  out(d.has(k) ? d.get(k) : null);
  return d.has(k);
};
export const SortedDictionary_get_Item = (_c: Ctx, d: Map<unknown, unknown>, k: unknown): unknown => {
  if (!d.has(k)) throw csErr('KeyNotFoundException', `The given key '${String(k)}' was not present in the dictionary.`);
  return d.get(k);
};
export const SortedDictionary_set_Item = (_c: Ctx, d: Map<unknown, unknown>, k: unknown, v: unknown): void => void d.set(k, v);
export const SortedDictionary_ContainsKey = (_c: Ctx, d: Map<unknown, unknown>, k: unknown): boolean => d.has(k);
export const SortedDictionary_Remove = (_c: Ctx, d: Map<unknown, unknown>, k: unknown): boolean => d.delete(k);
export const SortedDictionary_Clear = (_c: Ctx, d: Map<unknown, unknown>): void => d.clear();
export const SortedDictionary_get_Count = (_c: Ctx, d: Map<unknown, unknown>): number => d.size;
export const SortedDictionary_get_Keys = (_c: Ctx, d: Map<unknown, unknown>): unknown[] => sortedKeys(d);
export const SortedDictionary_get_Values = (_c: Ctx, d: Map<unknown, unknown>): unknown[] => sortedKeys(d).map((k) => d.get(k));
export const SortedDictionary_toArray = (_c: Ctx, d: Map<unknown, unknown>): { Key: unknown; Value: unknown }[] => sortedKeys(d).map((k) => ({ Key: k, Value: d.get(k) }));
export const SortedDictionary_ValueCollection_toArray = (_c: Ctx, v: unknown[]): unknown[] => v;
export const SortedDictionary_KeyCollection_toArray = SortedDictionary_ValueCollection_toArray;
export const SortedList_toArray = SortedDictionary_toArray;
export const SortedList_get_Count = SortedDictionary_get_Count;

// ───────── BitArray ─────────

export class BitArrayJs {
  readonly $type = 'BitArray';
  constructor(readonly bits: boolean[]) {}
}
export const new_BitArray$int = (_c: Ctx, n: number): BitArrayJs => new BitArrayJs(new Array(n).fill(false));
export const new_BitArray$int_bool = (_c: Ctx, n: number, v: boolean): BitArrayJs => new BitArrayJs(new Array(n).fill(!!v));
export const BitArray_get_Item = (_c: Ctx, b: BitArrayJs, i: number): boolean => {
  if (i < 0 || i >= b.bits.length) throw csErr('ArgumentOutOfRangeException', 'index');
  return b.bits[i];
};
export const BitArray_set_Item = (_c: Ctx, b: BitArrayJs, i: number, v: boolean): void => {
  if (i < 0 || i >= b.bits.length) throw csErr('ArgumentOutOfRangeException', 'index');
  b.bits[i] = !!v;
};
export const BitArray_Get = BitArray_get_Item;
export const BitArray_Set = BitArray_set_Item;
export const BitArray_SetAll = (_c: Ctx, b: BitArrayJs, v: boolean): void => void b.bits.fill(!!v);
export const BitArray_get_Count = (_c: Ctx, b: BitArrayJs): number => b.bits.length;
export const BitArray_get_Length = BitArray_get_Count;

// ───────── Task（async 方法回傳 JS 的 Promise；完成狀態第一次問的時候開始追蹤） ─────────

type Tracked = Promise<unknown> & { $done?: boolean; $result?: unknown; $error?: unknown };
function track(p: Tracked): Tracked {
  if (p.$done === undefined) {
    p.$done = false;
    p.then(
      (v) => {
        p.$done = true;
        p.$result = v;
      },
      (e) => {
        p.$done = true;
        p.$error = e;
      },
    );
  }
  return p;
}
export function Task_FromResult(_c: Ctx, v: unknown): Tracked {
  const p = Promise.resolve(v) as Tracked;
  p.$done = true;
  p.$result = v;
  return p;
}
export const Task_get_CompletedTask = (c: Ctx): Tracked => Task_FromResult(c, undefined);
export const Task_get_IsCompleted = (_c: Ctx, p: Tracked): boolean => !!track(p).$done;
export const Task_get_IsCompletedSuccessfully = (_c: Ctx, p: Tracked): boolean => !!track(p).$done && p.$error === undefined;
export const Task_get_IsFaulted = (_c: Ctx, p: Tracked): boolean => !!track(p).$done && p.$error !== undefined;
export const Task_get_IsCanceled = (_c: Ctx, p: Tracked): boolean => (void p, false);
/** Task.Result／Wait()：瀏覽器不能同步等，已經完成才拿得到；還沒完成就丟（C# 會卡住主執行緒等它） */
export function Task_get_Result(_c: Ctx, p: Tracked): unknown {
  track(p);
  if (!p.$done) throw csErr('InvalidOperationException', 'Task.Result：還沒完成（網頁上不能同步等）');
  if (p.$error !== undefined) throw p.$error;
  return p.$result;
}
export const Task_Wait$ = (c: Ctx, p: Tracked): void => void Task_get_Result(c, p);
export const Task_GetAwaiter = (_c: Ctx, p: Tracked): Tracked => track(p);
export const TaskAwaiter_GetResult = Task_get_Result;
export const TaskAwaiter_get_IsCompleted = Task_get_IsCompleted;
export const Task_ConfigureAwait = (_c: Ctx, p: Tracked): Tracked => p;
export const Task_Delay$int = (_c: Ctx, ms: number): Tracked => track(new Promise((r) => setTimeout(r, ms)) as Tracked);
export const Task_Delay$TimeSpan = (_c: Ctx, t: { ms: number }): Tracked => track(new Promise((r) => setTimeout(r, t.ms)) as Tracked);
export const Task_Delay$int_CancellationToken = Task_Delay$int;
export const Task_Run$Func = (c: Ctx, f: unknown): Tracked => track(Promise.resolve().then(() => invokeDelegate(c, f)) as Tracked);
export const Task_Run$Action = Task_Run$Func;
export const Task_WhenAll$Task_arr = (_c: Ctx, ps: Promise<unknown>[]): Tracked => track(Promise.all(ps ?? []) as Tracked);
export const Task_WhenAll$IEnumerable = (_c: Ctx, ps: Iterable<Promise<unknown>>): Tracked => track(Promise.all([...(ps ?? [])]) as Tracked);
export const Task_WhenAny$Task_arr = (_c: Ctx, ps: Promise<unknown>[]): Tracked => track(Promise.race((ps ?? []).map((p) => p.then(() => p))) as Tracked);
export const Task_Yield = (_c: Ctx): Tracked => track(new Promise((r) => setTimeout(r, 0)) as Tracked);
export const Task_ContinueWith$Action = (c: Ctx, p: Tracked, f: unknown): Tracked => track(p.then(() => invokeDelegate(c, f, p)) as Tracked);
const NO_CANCEL = { $type: 'CancellationToken', IsCancellationRequested: false };
export const CancellationToken_get_None = (_c: Ctx): object => NO_CANCEL;
export const CancellationToken_get_IsCancellationRequested = (_c: Ctx, t: { IsCancellationRequested?: boolean }): boolean => !!t?.IsCancellationRequested;
export const CancellationToken_Register$Action = (_c: Ctx, t: unknown, f: unknown): object => (void [t, f], { $type: 'CancellationTokenRegistration' });
export const CancellationToken_ThrowIfCancellationRequested = (_c: Ctx, t: { IsCancellationRequested?: boolean }): void => {
  if (t?.IsCancellationRequested) throw csErr('OperationCanceledException', 'The operation was canceled.');
};
export const new_CancellationTokenSource$ = (_c: Ctx): { $type: string; Token: { IsCancellationRequested: boolean } } => ({ $type: 'CancellationTokenSource', Token: { IsCancellationRequested: false } });
export const CancellationTokenSource_get_Token = (_c: Ctx, s: { Token: object }): object => s.Token;
export const CancellationTokenSource_Cancel$ = (_c: Ctx, s: { Token: { IsCancellationRequested: boolean } }): void => void (s.Token.IsCancellationRequested = true);
export const CancellationTokenSource_Dispose = (_c: Ctx, s: unknown): void => void s;

// ───────── System.Random（referencesource 的 Knuth 減法產生器，Unity 的 Mono 用同一份：同 seed 同序列） ─────────

const MBIG = 2147483647;
const MSEED = 161803398;
export class RandomJs {
  readonly $type = 'Random';
  private seeds = new Array<number>(56).fill(0);
  private inext = 0;
  private inextp = 21;
  constructor(seed: number) {
    seed |= 0;
    const subtraction = seed === -2147483648 ? MBIG : Math.abs(seed);
    let mj = MSEED - subtraction;
    this.seeds[55] = mj;
    let mk = 1;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      this.seeds[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += MBIG;
      mj = this.seeds[ii];
    }
    for (let k = 1; k < 5; k++)
      for (let i = 1; i < 56; i++) {
        this.seeds[i] -= this.seeds[1 + ((i + 30) % 55)];
        if (this.seeds[i] < 0) this.seeds[i] += MBIG;
      }
  }
  internalSample(): number {
    let a = this.inext + 1;
    let b = this.inextp + 1;
    if (a >= 56) a = 1;
    if (b >= 56) b = 1;
    let r = this.seeds[a] - this.seeds[b];
    if (r === MBIG) r--;
    if (r < 0) r += MBIG;
    this.seeds[a] = r;
    this.inext = a;
    this.inextp = b;
    return r;
  }
  sample(): number {
    return this.internalSample() * (1 / MBIG);
  }
  largeRangeSample(): number {
    let r = this.internalSample();
    if (this.internalSample() % 2 === 0) r = -r;
    return (r + (MBIG - 1)) / (2 * MBIG - 1);
  }
}
export const new_Random$int = (_c: Ctx, seed: number): RandomJs => new RandomJs(seed);
export const new_Random$ = (c: Ctx): RandomJs => new RandomJs(Environment_get_TickCount(c));
export const new_Random = new_Random$;
export const Random_Next$ = (_c: Ctx, r: RandomJs): number => r.internalSample();
export function Random_Next$int(_c: Ctx, r: RandomJs, max: number): number {
  if (max < 0) throw csException(['ArgumentOutOfRangeException', 'ArgumentException'], "'maxValue' must be greater than zero.", null, 'Random.Next');
  return Math.trunc(r.sample() * max);
}
export function Random_Next$int_int(_c: Ctx, r: RandomJs, min: number, max: number): number {
  if (min > max) throw csException(['ArgumentOutOfRangeException', 'ArgumentException'], "'minValue' cannot be greater than maxValue.", null, 'Random.Next');
  const range = max - min;
  return range <= MBIG ? Math.trunc(r.sample() * range) + min : Math.trunc(r.largeRangeSample() * range) + min;
}
export const Random_NextDouble = (_c: Ctx, r: RandomJs): number => r.sample();
export function Random_NextBytes(_c: Ctx, r: RandomJs, buf: number[] | Uint8Array): void {
  for (let i = 0; i < buf.length; i++) buf[i] = r.internalSample() % 256;
}
export const Random_NextBytes$byte_arr = Random_NextBytes;

// ───────── GC（JS 的記憶體回收不能手動觸發：不做事） ─────────

export const GC_Collect$ = (_c: Ctx): void => undefined;
export const GC_Collect = GC_Collect$;
export const GC_Collect$int = (_c: Ctx, g: number): void => void g;
export const GC_WaitForPendingFinalizers = (_c: Ctx): void => undefined;
export const GC_GetTotalMemory = (_c: Ctx, force: boolean): number => (void force, (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);
export const GC_SuppressFinalize = (_c: Ctx, o: unknown): void => void o;
export const GC_get_MaxGeneration = (_c: Ctx): number => 2;

// ───────── System.MathF ─────────

export const MathF_Floor = (_c: Ctx, v: number): number => Math.floor(v);
export const MathF_Ceiling = (_c: Ctx, v: number): number => Math.ceil(v);
export const MathF_Round$float = (_c: Ctx, v: number): number => roundEven(v);
export const MathF_Abs = (_c: Ctx, v: number): number => Math.abs(v);
export const MathF_Max = (_c: Ctx, a: number, b: number): number => Math.max(a, b);
export const MathF_Min = (_c: Ctx, a: number, b: number): number => Math.min(a, b);
export const MathF_Sqrt = (_c: Ctx, v: number): number => Math.sqrt(v);
export const MathF_Pow = (_c: Ctx, a: number, b: number): number => Math.pow(a, b);
export const MathF_Sin = (_c: Ctx, v: number): number => Math.sin(v);
export const MathF_Cos = (_c: Ctx, v: number): number => Math.cos(v);
export const MathF_Atan2 = (_c: Ctx, y: number, x: number): number => Math.atan2(y, x);
export const MathF_Truncate = (_c: Ctx, v: number): number => Math.trunc(v);
export const MathF_Log$float = (_c: Ctx, v: number): number => Math.log(v);
export const MathF_Exp = (_c: Ctx, v: number): number => Math.exp(v);
export const MathF_Clamp = (_c: Ctx, v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
export const MathF_get_PI = (_c: Ctx): number => Math.PI;

// ───────── 外部結構的預設值（default(T)、欄位的初始值） ─────────

registerExternalCtor('DateTime', () => new DateTimeJs(MIN_MS));
registerExternalCtor('DateTimeOffset', () => new DateTimeJs(MIN_MS, 1));
registerExternalCtor('TimeSpan', () => new TimeSpanJs(0));
registerExternalCtor('Guid', () => new GuidJs('0'.repeat(32)));
registerExternalCtor('KeyValuePair', () => ({ Key: null, Value: null }));
registerExternalCtor('CancellationToken', () => NO_CANCEL);
registerExternalCtor('HashCode', () => ({ h: HC_SEED }));

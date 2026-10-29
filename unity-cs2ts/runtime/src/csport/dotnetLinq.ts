// 相容層：System.Linq.Enumerable（轉換器在工具包模式下把沒有直接對應 JS 陣列操作的運算子寫成 R.linq<名字>(c, 來源, 引數…)）。
// dotnet.ts 會 export * 這裡。來源是 JS 陣列（或可列舉的東西）；委派是函式。語意照 .NET：
//   - First／Last／Single 空的或不符合丟 InvalidOperationException；…OrDefault 回轉換器帶來的元素型別預設值。
//   - OrderBy／ThenBy 是穩定排序（.NET 的 OrderBy 是穩定的，跟 List.Sort 不同）。
//   - GroupBy、Distinct、Union 照元素第一次出現的順序；相等照 Equals（值型別比欄位）。
//   - Max／Min 對空的序列丟例外；Sum 對空的序列是 0。

import { BoxedEnum, CsDict } from './dotnet';
import { defaultCompare } from './dotnetBcl';
import { callIface, genMethodOf, hasGen, invokeDelegate, isInstance, isJsGenerator, setEnumerateHook, staticCtx, type Ctx } from './core';

type Fn = unknown;
const csErr = (type: string, msg: string): Error => Object.assign(new Error(`C# ${type}：${msg}`), { name: type });
const arr = (src: Iterable<unknown> | null | undefined): unknown[] => {
  if (src == null) throw csErr('ArgumentNullException', 'source');
  // 換過列舉順序的陣列（dotnetBcl 的 CsStack：從頂端往底）照 iterator 走，其他陣列直接用
  return Array.isArray(src) && src[Symbol.iterator] === Array.prototype[Symbol.iterator] ? src : [...src];
};
const call = (c: Ctx, f: Fn, ...a: unknown[]): unknown => invokeDelegate(c, f, ...a);
/** Equals 的相等：同一個、列舉值相同、或兩個一般物件（值型別）欄位都相同 */
export function valueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof BoxedEnum || b instanceof BoxedEnum) return Number(a) === Number(b);
  if (a && b && typeof a === 'object' && typeof b === 'object' && Object.getPrototypeOf(a) === Object.prototype && !('$type' in a)) return JSON.stringify(a) === JSON.stringify(b);
  return false;
}
function indexOfEq(list: unknown[], x: unknown): number {
  for (let i = 0; i < list.length; i++) if (valueEquals(list[i], x)) return i;
  return -1;
}

export function linqFirst(c: Ctx, src: Iterable<unknown>, pred?: Fn): unknown {
  for (const x of arr(src)) if (pred == null || call(c, pred, x)) return x;
  throw csErr('InvalidOperationException', pred == null ? 'Sequence contains no elements' : 'Sequence contains no matching element');
}
export function linqFirstOrDefault(c: Ctx, src: Iterable<unknown>, pred: Fn, def: unknown = null): unknown {
  for (const x of arr(src)) if (pred == null || call(c, pred, x)) return x;
  return def;
}
export function linqLast(c: Ctx, src: Iterable<unknown>, pred?: Fn): unknown {
  const a = arr(src);
  for (let i = a.length - 1; i >= 0; i--) if (pred == null || call(c, pred, a[i])) return a[i];
  throw csErr('InvalidOperationException', pred == null ? 'Sequence contains no elements' : 'Sequence contains no matching element');
}
export function linqLastOrDefault(c: Ctx, src: Iterable<unknown>, pred: Fn, def: unknown = null): unknown {
  const a = arr(src);
  for (let i = a.length - 1; i >= 0; i--) if (pred == null || call(c, pred, a[i])) return a[i];
  return def;
}
export function linqSingle(c: Ctx, src: Iterable<unknown>, pred?: Fn): unknown {
  const hits = arr(src).filter((x) => pred == null || call(c, pred, x));
  if (hits.length === 1) return hits[0];
  throw csErr('InvalidOperationException', hits.length ? 'Sequence contains more than one element' : 'Sequence contains no elements');
}
export function linqSingleOrDefault(c: Ctx, src: Iterable<unknown>, pred: Fn, def: unknown = null): unknown {
  const hits = arr(src).filter((x) => pred == null || call(c, pred, x));
  if (hits.length > 1) throw csErr('InvalidOperationException', 'Sequence contains more than one element');
  return hits.length ? hits[0] : def;
}
export function linqElementAt(c: Ctx, src: Iterable<unknown>, i: number): unknown {
  void c;
  const a = arr(src);
  if (i < 0 || i >= a.length) throw csErr('ArgumentOutOfRangeException', 'index');
  return a[i];
}
export function linqElementAtOrDefault(c: Ctx, src: Iterable<unknown>, i: number, def: unknown = null): unknown {
  void c;
  const a = arr(src);
  return i >= 0 && i < a.length ? a[i] : def;
}
const num = (v: unknown): number => (v instanceof BoxedEnum ? v.value : (v as number));
export function linqSum(c: Ctx, src: Iterable<unknown>, sel?: Fn): number {
  let s = 0;
  for (const x of arr(src)) {
    const v = sel == null ? x : call(c, sel, x);
    if (v != null) s += num(v);
  }
  return s;
}
export function linqAverage(c: Ctx, src: Iterable<unknown>, sel?: Fn): number {
  const a = arr(src);
  if (!a.length) throw csErr('InvalidOperationException', 'Sequence contains no elements');
  return linqSum(c, a, sel) / a.length;
}
function extreme(c: Ctx, src: Iterable<unknown>, sel: Fn | undefined, sign: number): unknown {
  const a = arr(src);
  // Max(comparer) 的多載：第二個引數是 IComparer 物件（不是函式）
  const cmp = sel != null && typeof sel !== 'function' ? (x: unknown, y: unknown) => num(call(c, (sel as { Compare?: Fn }).Compare ?? sel, x, y)) : defaultCompare;
  const f = sel != null && typeof sel === 'function' ? sel : null;
  let best: unknown = undefined;
  let any = false;
  for (const x of a) {
    const v = f ? call(c, f, x) : x;
    if (v == null) continue;
    if (!any || sign * cmp(v, best) > 0) best = v;
    any = true;
  }
  if (!any) {
    if (a.length && a.every((x) => (f ? call(c, f, x) : x) == null)) return null;
    throw csErr('InvalidOperationException', 'Sequence contains no elements');
  }
  return best;
}
export function linqMax(c: Ctx, src: Iterable<unknown>, sel?: Fn): unknown {
  return extreme(c, src, sel, 1);
}
export function linqMin(c: Ctx, src: Iterable<unknown>, sel?: Fn): unknown {
  return extreme(c, src, sel, -1);
}
export function linqMaxBy(c: Ctx, src: Iterable<unknown>, sel: Fn): unknown {
  let best: unknown = null;
  let bk: unknown = undefined;
  for (const x of arr(src)) {
    const k = call(c, sel, x);
    if (bk === undefined || defaultCompare(k, bk) > 0) {
      best = x;
      bk = k;
    }
  }
  return best;
}
export function linqMinBy(c: Ctx, src: Iterable<unknown>, sel: Fn): unknown {
  let best: unknown = null;
  let bk: unknown = undefined;
  for (const x of arr(src)) {
    const k = call(c, sel, x);
    if (bk === undefined || defaultCompare(k, bk) < 0) {
      best = x;
      bk = k;
    }
  }
  return best;
}

// ───────── 排序（穩定；ThenBy 接在 OrderBy 的結果後面） ─────────

type Ordered = unknown[] & { $src?: unknown[]; $keys?: { sel: Fn; desc: boolean; cmp: (a: unknown, b: unknown) => number }[] };
function keyCmp(c: Ctx, cmp: Fn | undefined): (a: unknown, b: unknown) => number {
  if (cmp == null) return defaultCompare;
  if (typeof cmp === 'function') return (a, b) => num(call(c, cmp, a, b));
  const o = cmp as { $type?: string };
  void o;
  return (a, b) => num(call(c, (cmp as { Compare?: Fn }).Compare ?? cmp, a, b));
}
function sortBy(c: Ctx, src: unknown[], keys: NonNullable<Ordered['$keys']>): Ordered {
  const idx = src.map((x, i) => ({ x, i, k: keys.map((k) => call(c, k.sel, x)) }));
  idx.sort((p, q) => {
    for (let j = 0; j < keys.length; j++) {
      const r = keys[j].cmp(p.k[j], q.k[j]);
      if (r !== 0) return keys[j].desc ? -r : r;
    }
    return p.i - q.i;
  });
  const out = idx.map((e) => e.x) as Ordered;
  Object.defineProperty(out, '$src', { value: src, enumerable: false });
  Object.defineProperty(out, '$keys', { value: keys, enumerable: false });
  return out;
}
export function linqOrderBy(c: Ctx, src: Iterable<unknown>, sel: Fn, cmp?: Fn): Ordered {
  return sortBy(c, [...arr(src)], [{ sel, desc: false, cmp: keyCmp(c, cmp) }]);
}
export function linqOrderByDescending(c: Ctx, src: Iterable<unknown>, sel: Fn, cmp?: Fn): Ordered {
  return sortBy(c, [...arr(src)], [{ sel, desc: true, cmp: keyCmp(c, cmp) }]);
}
export function linqThenBy(c: Ctx, src: Ordered, sel: Fn, cmp?: Fn): Ordered {
  return sortBy(c, src.$src ?? [...src], [...(src.$keys ?? []), { sel, desc: false, cmp: keyCmp(c, cmp) }]);
}
export function linqThenByDescending(c: Ctx, src: Ordered, sel: Fn, cmp?: Fn): Ordered {
  return sortBy(c, src.$src ?? [...src], [...(src.$keys ?? []), { sel, desc: true, cmp: keyCmp(c, cmp) }]);
}
export const IOrderedEnumerable_toArray = (_c: Ctx, src: Iterable<unknown>): unknown[] => arr(src);

// ───────── 集合運算 ─────────

export function linqExcept(c: Ctx, a: Iterable<unknown>, b: Iterable<unknown>): unknown[] {
  void c;
  const bb = arr(b);
  const out: unknown[] = [];
  for (const x of arr(a)) if (indexOfEq(bb, x) < 0 && indexOfEq(out, x) < 0) out.push(x);
  return out;
}
export function linqIntersect(c: Ctx, a: Iterable<unknown>, b: Iterable<unknown>): unknown[] {
  void c;
  const bb = arr(b);
  const out: unknown[] = [];
  for (const x of arr(a)) if (indexOfEq(bb, x) >= 0 && indexOfEq(out, x) < 0) out.push(x);
  return out;
}
export function linqUnion(c: Ctx, a: Iterable<unknown>, b: Iterable<unknown>): unknown[] {
  void c;
  const out: unknown[] = [];
  for (const x of [...arr(a), ...arr(b)]) if (indexOfEq(out, x) < 0) out.push(x);
  return out;
}
export function linqDistinct(c: Ctx, a: Iterable<unknown>): unknown[] {
  void c;
  const out: unknown[] = [];
  for (const x of arr(a)) if (indexOfEq(out, x) < 0) out.push(x);
  return out;
}
export function linqDistinctBy(c: Ctx, a: Iterable<unknown>, sel: Fn): unknown[] {
  const keys: unknown[] = [];
  const out: unknown[] = [];
  for (const x of arr(a)) {
    const k = call(c, sel, x);
    if (indexOfEq(keys, k) < 0) {
      keys.push(k);
      out.push(x);
    }
  }
  return out;
}
export function linqSequenceEqual(c: Ctx, a: Iterable<unknown>, b: Iterable<unknown>): boolean {
  void c;
  const x = arr(a);
  const y = arr(b);
  return x.length === y.length && x.every((v, i) => valueEquals(v, y[i]));
}
export function linqToHashSet(c: Ctx, a: Iterable<unknown>): unknown[] {
  return linqDistinct(c, a);
}
export function linqToDictionary(c: Ctx, a: Iterable<unknown>, keySel: Fn, valSel?: Fn): Map<unknown, unknown> {
  const m = new CsDict<unknown, unknown>();
  for (const x of arr(a)) {
    const k = call(c, keySel, x);
    if (k == null) throw csErr('ArgumentNullException', 'key');
    if (m.has(k)) throw csErr('ArgumentException', `An item with the same key has already been added. Key: ${String(k)}`);
    m.set(k, valSel == null ? x : call(c, valSel, x));
  }
  return m;
}
/** GroupBy：每組是陣列，帶 Key（IGrouping<TKey, T> 也是 IEnumerable<T>）；照第一次出現的順序 */
export function linqGroupBy(c: Ctx, a: Iterable<unknown>, keySel: Fn, elemSel?: Fn): (unknown[] & { Key: unknown })[] {
  const groups: (unknown[] & { Key: unknown })[] = [];
  for (const x of arr(a)) {
    const k = call(c, keySel, x);
    let g = groups.find((y) => valueEquals(y.Key, k));
    if (!g) {
      g = Object.assign([], { Key: k });
      groups.push(g);
    }
    g.push(elemSel == null ? x : call(c, elemSel, x));
  }
  return groups;
}
export const linqToLookup = linqGroupBy;
export const IGrouping_get_Key = (_c: Ctx, g: { Key: unknown }): unknown => g.Key;
export const IGrouping_toArray = (_c: Ctx, g: unknown[]): unknown[] => g;
export function linqAggregate(c: Ctx, a: Iterable<unknown>, x: unknown, y?: unknown, z?: unknown): unknown {
  const list = arr(a);
  if (y === undefined) {
    // Aggregate(func)
    if (!list.length) throw csErr('InvalidOperationException', 'Sequence contains no elements');
    let acc = list[0];
    for (let i = 1; i < list.length; i++) acc = call(c, x, acc, list[i]);
    return acc;
  }
  let acc = x;
  for (const v of list) acc = call(c, y, acc, v);
  return z === undefined ? acc : call(c, z, acc);
}
export function linqZip(c: Ctx, a: Iterable<unknown>, b: Iterable<unknown>, f?: Fn): unknown[] {
  const x = arr(a);
  const y = arr(b);
  const n = Math.min(x.length, y.length);
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push(f == null ? { Item1: x[i], Item2: y[i] } : call(c, f, x[i], y[i]));
  return out;
}
export function linqDefaultIfEmpty(c: Ctx, a: Iterable<unknown>, def: unknown = null): unknown[] {
  void c;
  const x = arr(a);
  return x.length ? x : [def];
}
export function linqTakeWhile(c: Ctx, a: Iterable<unknown>, pred: Fn): unknown[] {
  const out: unknown[] = [];
  const x = arr(a);
  for (let i = 0; i < x.length; i++) {
    if (!call(c, pred, x[i], i)) break;
    out.push(x[i]);
  }
  return out;
}
export function linqSkipWhile(c: Ctx, a: Iterable<unknown>, pred: Fn): unknown[] {
  const x = arr(a);
  let i = 0;
  while (i < x.length && call(c, pred, x[i], i)) i++;
  return x.slice(i);
}
export const linqTakeLast = (_c: Ctx, a: Iterable<unknown>, n: number): unknown[] => (n > 0 ? arr(a).slice(-n) : []);
export const linqSkipLast = (_c: Ctx, a: Iterable<unknown>, n: number): unknown[] => (n > 0 ? arr(a).slice(0, -n) : [...arr(a)]);
export const linqPrepend = (_c: Ctx, a: Iterable<unknown>, x: unknown): unknown[] => [x, ...arr(a)];
export const linqAsEnumerable = (_c: Ctx, a: Iterable<unknown>): unknown[] => arr(a);
export const linqLongCount = (c: Ctx, a: Iterable<unknown>, pred?: Fn): number => arr(a).filter((x) => pred == null || call(c, pred, x)).length;
export const linqCount = linqLongCount;
export function linqOfType(c: Ctx, a: Iterable<unknown>, type: string): unknown[] {
  return arr(a).filter((x) => isInstance(c, x, type));
}
export function linqCast(c: Ctx, a: Iterable<unknown>, type: string): unknown[] {
  void c;
  void type;
  return arr(a);
}
export const linqContains = (_c: Ctx, a: Iterable<unknown>, x: unknown): boolean => indexOfEq(arr(a), x) >= 0;
export const linqAny = (c: Ctx, a: Iterable<unknown>, pred?: Fn): boolean => arr(a).some((x) => pred == null || call(c, pred, x));
export const linqAll = (c: Ctx, a: Iterable<unknown>, pred: Fn): boolean => arr(a).every((x) => call(c, pred, x));
export const linqReverse = (_c: Ctx, a: Iterable<unknown>): unknown[] => [...arr(a)].reverse();
export const linqToList = (_c: Ctx, a: Iterable<unknown>): unknown[] => [...arr(a)];
export const linqToArray = linqToList;

// ───────── Enumerable 的靜態方法、IEnumerable 的列舉 ─────────

export const Enumerable_Range = (_c: Ctx, start: number, count: number): number[] => Array.from({ length: count }, (_, i) => start + i);
export const Enumerable_Repeat = (_c: Ctx, x: unknown, count: number): unknown[] => Array.from({ length: count }, () => x);
export const Enumerable_Empty = (_c: Ctx): unknown[] => [];
export const IEnumerable_toArray = (_c: Ctx, a: Iterable<unknown>): unknown[] => arr(a);
export const ICollection_toArray = IEnumerable_toArray;
export const IList_toArray = IEnumerable_toArray;
export const IReadOnlyList_toArray = IEnumerable_toArray;
export const IReadOnlyCollection_toArray = IEnumerable_toArray;
export const IEnumerable_GetEnumerator = (_c: Ctx, a: Iterable<unknown>): Iterator<unknown> => arr(a)[Symbol.iterator]();
/** IEnumerator 的手動走法（while (e.MoveNext()) e.Current）：JS 的 iterator 包一層 */
const cursors = new WeakMap<object, { cur: unknown }>();
/** C# 的列舉器結構（List／Dictionary 的 Enumerator）：moveNext／current */
type CsEnumerator = { moveNext(): boolean; readonly current: unknown };
const isCsEnumerator = (it: unknown): it is CsEnumerator => typeof (it as CsEnumerator)?.moveNext === 'function';
/** 產生的類別自己實作 IEnumerator（明確實作的名字是 IEnumerator$MoveNext、IEnumerator$1$get_Current） */
const isGenEnumerator = (it: unknown): boolean => typeof (it as { $type?: string })?.$type === 'string' && hasGen((it as { $type: string }).$type);
export function IEnumerator_MoveNext(c: Ctx, it: Iterator<unknown>): boolean {
  if (isCsEnumerator(it)) return it.moveNext();
  if (isGenEnumerator(it)) return callIface(c, 'IEnumerator', 'MoveNext', it);
  const r = it.next();
  let s = cursors.get(it);
  if (!s) cursors.set(it, (s = { cur: undefined }));
  s.cur = r.value;
  return !r.done;
}
export function IEnumerator_get_Current(c: Ctx, it: Iterator<unknown>): unknown {
  if (isCsEnumerator(it)) return it.current;
  if (isGenEnumerator(it)) {
    const t = (it as unknown as { $type: string }).$type;
    return callIface(c, !genMethodOf(t, 'IEnumerator$1$get_Current') && genMethodOf(t, 'IEnumerator$get_Current') ? 'IEnumerator' : 'IEnumerator$1', 'get_Current', it);
  }
  return cursors.get(it)?.cur;
}
// 只實作 IEnumerable 的產生類別拿來 for…of（core 的 enumerableFacade）：照它的 GetEnumerator 走
setEnumerateHook(function* (e) {
  while (IEnumerator_MoveNext(staticCtx, e as Iterator<unknown>)) yield IEnumerator_get_Current(staticCtx, e as Iterator<unknown>);
});
export const IEnumerator_Reset = (_c: Ctx, it: unknown): void => void it;
/**
 * IDisposable.Dispose（對象的型別是介面時轉換器寫這個）：迭代器方法（JS 產生器）照 C# 編譯器產生的 Dispose 跑停住那裡的 finally（generator.return）；
 * 產生的類別叫它自己的 Dispose；其他（相容層的列舉器、集合）沒有要釋放的。
 *
 * 迭代器自己還在跑的時候被 Dispose（MT2：CharacterState.InnerSetWorldPosition 叫 onReachedPoint → SetWorldPosition →
 * CoroutineController.Stop 把正在跑的自己 Dispose 掉）：C# 不丟例外，這一次 MoveNext 照常跑到下一個 yield 或結束；
 * JS 的 return() 在執行中會丟 TypeError（V8「Generator is already running」），這裡當作沒事。
 * 差異：停在 try 裡時 C# 的 Dispose 會先跑 finally，這裡沒跑（執行中的產生器沒辦法從外面結束）。
 */
export function IDisposable_Dispose(c: Ctx, d: unknown): void {
  if (d == null) throw new Error('IDisposable.Dispose：對象是 null（C# 這裡會 NullReferenceException）');
  if (isJsGenerator(d)) {
    try {
      d.return(undefined);
    } catch (e) {
      if (!(e instanceof TypeError && /already running|already executing|is executing/i.test(e.message))) throw e;
    }
    return;
  }
  if (isGenEnumerator(d) && isInstance(c, d, 'IDisposable')) callIface(c, 'IDisposable', 'Dispose', d as object);
}
export const IEnumerator_Dispose = IDisposable_Dispose;

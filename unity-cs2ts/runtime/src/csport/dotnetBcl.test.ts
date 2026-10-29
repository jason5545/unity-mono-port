import { describe, expect, it } from 'vitest';
import {
  compositeFormat,
  formatG,
  introSort,
  List_AsReadOnly,
  new_Random$int,
  new_Stack$,
  new_Stack$IEnumerable,
  Random_Next$,
  Random_Next$int,
  Random_Next$int_int,
  Random_NextDouble,
  ReadOnlyCollection_get_Count,
  ReadOnlyCollection_get_Item,
  Stack_Peek,
  Stack_Pop,
  Stack_Push,
  Stack_ToArray,
  Stack_toArray,
  translateDotNetRegex,
} from './dotnetBcl';
import { eventAdd, eventGet, eventRemove, invokeDelegate, isInstance, staticCtx } from './core';
import { IDisposable_Dispose, linqFirst } from './dotnetLinq';
import { tmpFormat } from './unityNative';

describe('.NET 正規式轉譯', () => {
  it('字元類別相減', () => {
    const re = new RegExp(translateDotNetRegex('[\\s-[\\n\\r]]+'));
    expect(re.test(' \t')).toBe(true);
    expect(new RegExp(`^${translateDotNetRegex('[\\s-[\\n\\r]]+')}$`).test('a\n')).toBe(false);
  });
  it('群組中間的 (?i) 包到群組結尾', () => {
    const t = translateDotNetRegex('a(?:(?i)b)c');
    expect(t).toBe('a(?:(?i:b))c');
  });
  it('MT2 的 LocalizationUtil 式子編得過', () => {
    const t = translateDotNetRegex('x?\\{\\[[^\\]]*]}+x?[\\s-[\\n\\r]]*(?:(?i)(?<=^|\\s|]}|>)X?[\\-\\+]?\\d+X?(?=\\s|\\{\\[|,|\\.|<))');
    expect(() => new RegExp(t, 'g')).not.toThrow();
  });
});

describe('格式化', () => {
  it('composite format', () => {
    expect(compositeFormat(staticCtx, '{0} + {1,3} = {2:F2}', [1, 2, 3])).toBe('1 +   2 = 3.00');
    expect(compositeFormat(staticCtx, '{{x}} {0:N0}', [12345])).toBe('{x} 12,345');
  });
  it('G7（Mono 的 float.ToString）', () => {
    expect(formatG(Math.fround(1 / 3), 7)).toBe('0.3333333');
    expect(formatG(Math.fround(0.1), 7)).toBe('0.1');
    expect(formatG(1e-7, 7)).toBe('1E-07');
  });
});

describe('introsort（referencesource 的 ArraySortHelper）', () => {
  it('排得正確', () => {
    const a = Array.from({ length: 200 }, (_, i) => (i * 7919) % 101);
    introSort(a, 0, a.length, (x, y) => (x as number) - (y as number));
    for (let i = 1; i < a.length; i++) expect(a[i - 1] <= a[i]).toBe(true);
  });
  it('同值的順序照 .NET（不穩定）：小陣列是插入排序，保持原順序', () => {
    const a = [{ k: 1, id: 'a' }, { k: 0, id: 'b' }, { k: 1, id: 'c' }, { k: 0, id: 'd' }];
    introSort(a, 0, a.length, (x, y) => (x as { k: number }).k - (y as { k: number }).k);
    expect(a.map((x) => x.id).join('')).toBe('bdac');
  });
});

import { CsDict } from './dotnet';
describe('Dictionary（.NET 的格子與空格串列）', () => {
  it('刪掉的格子給下一次加入用，列舉照格子順序', () => {
    const d = new CsDict<string, number>();
    d.set('a', 1);
    d.set('b', 2);
    d.set('c', 3);
    d.delete('b');
    d.set('d', 4);
    expect([...d.keys()].join('')).toBe('adc');
  });
  it('值型別的 key 照欄位比；不分大小寫的比較器', () => {
    const d = new CsDict<unknown, number>();
    d.set({ x: 1, y: 2 }, 5);
    expect(d.get({ x: 1, y: 2 })).toBe(5);
    const ci = new CsDict<string, number>(true);
    ci.set('Hello', 1);
    expect(ci.has('HELLO')).toBe(true);
    expect([...ci.keys()]).toEqual(['Hello']);
  });
});

describe('System.Random', () => {
  const c = staticCtx;
  it('同 seed 的序列跟 .NET 一樣（2026/10/16 用 dotnet run 算的標準答案）', () => {
    const r = new_Random$int(c, 42);
    expect([0, 1, 2, 3, 4].map(() => Random_Next$(c, r))).toEqual([1434747710, 302596119, 269548474, 1122627734, 361709742]);
    const r2 = new_Random$int(c, 0);
    expect([0, 1, 2, 3, 4].map(() => Random_Next$int(c, r2, 100))).toEqual([72, 81, 76, 55, 20]);
    const r3 = new_Random$int(c, -7);
    expect(Random_Next$int_int(c, r3, -5, 2000000000)).toBe(766440935);
    expect(Random_Next$int_int(c, r3, -2147483648, 2147483647)).toBe(-1871007333);
    expect(Random_NextDouble(c, r3)).toBe(0.052261705534654534);
  });
});

describe('TMP_Text.SetText 的數字格式', () => {
  it('照 AddFloatToInternalTextBackingArray', () => {
    expect(tmpFormat('{0}', [12.5])).toBe('12.5');
    expect(tmpFormat('{0:2}', [3.14159])).toBe('3.14');
    expect(tmpFormat('{0:0.00}', [0.1])).toBe('0.10'); // 進位加的 0.005 留在餘數，C# 原版也是 0.10
    expect(tmpFormat('{0:00}', [7])).toBe('07');
    expect(tmpFormat('HP {0}/{1}', [5, 10])).toBe('HP 5/10');
    expect(tmpFormat('{0:1}', [2.96])).toBe('3.0');
    expect(tmpFormat('{0}', [-0.25])).toBe('-0.25');
  });
});

describe('集合與迭代器的型別判斷', () => {
  it('迭代器方法（JS 產生器）是 IEnumerator<object>、IEnumerator、IDisposable', () => {
    const g = (function* () {
      yield 1;
    })();
    expect(isInstance(staticCtx, g, 'IEnumerator')).toBe(true);
    expect(isInstance(staticCtx, g, 'IEnumerator$1')).toBe(true);
    expect(isInstance(staticCtx, g, 'IDisposable')).toBe(true);
    expect(isInstance(staticCtx, g, 'CustomYieldInstruction')).toBe(false);
    expect(isInstance(staticCtx, [1], 'IEnumerator')).toBe(false);
  });
  it('迭代器的 Dispose 跑停在那裡的 finally', () => {
    const log: string[] = [];
    const g = (function* () {
      try {
        yield 1;
        yield 2;
      } finally {
        log.push('finally');
      }
    })();
    g.next();
    IDisposable_Dispose(staticCtx, g);
    expect(log).toEqual(['finally']);
    expect(g.next().done).toBe(true);
  });
  it('IDisposable.Dispose：迭代器在自己執行中被 Dispose（回呼停掉自己的協程）不丟例外，這一次照常跑到下一個 yield', () => {
    const log: string[] = [];
    const self: { g?: Generator<number> } = {};
    const g = (self.g = (function* () {
      log.push('start');
      IDisposable_Dispose(staticCtx, self.g);
      log.push('after dispose');
      yield 1;
    })());
    expect(g.next()).toEqual({ value: 1, done: false });
    expect(log).toEqual(['start', 'after dispose']);
  });
  it('事件 += 多播委派（另一個事件讀出來的呼叫清單）照 Delegate.Combine 接上；-= 拿掉最後一段相同的', () => {
    const log: string[] = [];
    const a = () => log.push('a');
    const b = () => log.push('b');
    const src = {};
    const dst = {};
    eventAdd(staticCtx, 'Signal.Listener', src, a);
    eventAdd(staticCtx, 'Signal.Listener', src, b);
    // MT2 CoroutineSignal.Clone：copy.Listener += this.Listener
    eventAdd(staticCtx, 'Signal.Listener', dst, eventGet(staticCtx, 'Signal.Listener', src));
    eventAdd(staticCtx, 'Signal.Listener', dst, a);
    invokeDelegate(staticCtx, eventGet(staticCtx, 'Signal.Listener', dst));
    expect(log).toEqual(['a', 'b', 'a']);
    eventRemove(staticCtx, 'Signal.Listener', dst, [a, b]);
    expect(eventGet(staticCtx, 'Signal.Listener', dst)).toEqual([a]);
  });
  it('new Stack<T>(IEnumerable<T>)：最後列舉到的在頂端', () => {
    const s = new_Stack$IEnumerable(staticCtx, ['a', 'b', 'c']);
    expect(Stack_Pop(staticCtx, s)).toBe('c');
    expect(Stack_toArray(staticCtx, s)).toEqual(['b', 'a']);
  });
  it('Stack 當 IEnumerable 列舉是從頂端往底（ink 的 new Path(stack)：路徑的根在前）；LINQ、new Stack(stack) 也照這個順序', () => {
    const s = new_Stack$(staticCtx);
    for (const x of ['c-0', '0', 'PenanceFields']) Stack_Push(staticCtx, s, x); // ink 從葉往根 Push
    const comps: unknown[] = [];
    comps.push(...s); // List.AddRange 產生的寫法
    expect(comps).toEqual(['PenanceFields', '0', 'c-0']);
    expect(linqFirst(staticCtx, s)).toBe('PenanceFields');
    expect(Stack_Pop(staticCtx, new_Stack$IEnumerable(staticCtx, s))).toBe('c-0'); // .NET：new Stack(stack) 順序反過來
    expect(Stack_ToArray(staticCtx, s)).toEqual(['PenanceFields', '0', 'c-0']);
    expect(Stack_Peek(staticCtx, s)).toBe('PenanceFields');
  });
  it('ReadOnlyCollection 就是原本的陣列，索引超出範圍丟 ArgumentOutOfRangeException', () => {
    const list = [30, 60];
    const ro = List_AsReadOnly(staticCtx, list);
    expect(ReadOnlyCollection_get_Item(staticCtx, ro, 1)).toBe(60);
    expect(ReadOnlyCollection_get_Count(staticCtx, ro)).toBe(2);
    expect(() => ReadOnlyCollection_get_Item(staticCtx, ro, 2)).toThrow();
  });
});

describe('2026/10/16 Spine 與 Text Animator 用到的', () => {
  it('Array.Resize 放大時新格子是轉換器給的 default(T)，struct 每格各一份', async () => {
    const { Array_Resize } = await import('./dotnetBcl');
    const { registerGen } = await import('./core');
    registerGen({ TestCharacterData: { name: 'TestCharacterData', file: 'TestCharacterData.cs', initAi: () => ({}), overrides: {}, delegates: {}, methods: {}, struct: true } });
    const ref = { v: [] as unknown[] };
    Array_Resize(staticCtx, ref, 2, { $type: 'TestCharacterData', passedTime: 0 });
    expect(ref.v).toEqual([{ $type: 'TestCharacterData', passedTime: 0 }, { $type: 'TestCharacterData', passedTime: 0 }]);
    expect(ref.v[0]).not.toBe(ref.v[1]);
    const ints = { v: [7] as unknown[] };
    Array_Resize(staticCtx, ints, 3, 0);
    expect(ints.v).toEqual([7, 0, 0]);
  });

  it('bool.CompareTo：false 比 true 小', async () => {
    const { Boolean_CompareTo$bool } = await import('./dotnetBcl');
    expect([Boolean_CompareTo$bool(staticCtx, false, true), Boolean_CompareTo$bool(staticCtx, true, false), Boolean_CompareTo$bool(staticCtx, true, true)]).toEqual([-1, 1, 0]);
  });

  it('JS 函式（產生碼裡的委派）算 Action、Func、Delegate，不算別的類別', async () => {
    const { isInstance } = await import('./core');
    const f = () => 0;
    expect(['Action', 'Action$1', 'Func$2', 'Delegate', 'MulticastDelegate', 'Object'].map((t) => isInstance(staticCtx, f, t))).toEqual([true, true, true, true, true, true]);
    expect(isInstance(staticCtx, f, 'String')).toBe(false);
  });

  it('Color32.LerpUnclamped：t 不夾，(byte) 轉型繞回', async () => {
    const { Color32_LerpUnclamped } = await import('./unityMath');
    const a = { r: 0, g: 100, b: 200, a: 255 };
    const b = { r: 100, g: 200, b: 250, a: 255 };
    expect(Color32_LerpUnclamped(staticCtx, a, b, 0.5)).toEqual({ r: 50, g: 150, b: 225, a: 255, $color32: true });
    expect(Color32_LerpUnclamped(staticCtx, a, b, 2)).toEqual({ r: 200, g: 300 & 0xff, b: 300 & 0xff, a: 255, $color32: true });
  });
});

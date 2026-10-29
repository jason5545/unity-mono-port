import { describe, expect, it } from 'vitest';
import { cloneData, newGen, registerGen, staticCtx, type Ctx, type GenClassImpl } from './core';
import { CsDict, newArray, Object_Equals$Object, Object_GetHashCode, Object_ToString } from './dotnet';
import { HashSet_Add, HashSet_Contains, HashSet_Remove, new_HashSet$ } from './dotnetBcl';

// 跟 MT2 的 CoreSymbol／MappingID 同一個形狀：基底覆寫 Equals(object)／GetHashCode（照 m_value），子類別另外覆寫一個 Equals(string) 多載
const Sym: GenClassImpl = {
  name: 'TestSym',
  file: 'TestSym.cs',
  ctor0: 'ctor$',
  initAi: () => ({ m_value: 0 }),
  objectMethods: { Equals: 'Equals$Object', GetHashCode: 'GetHashCode', ToString: 'ToString' },
  overrides: {},
  delegates: {},
  methods: {
    ctor$: () => undefined,
    ctor$int: (c: Ctx, v: number) => void (c.ai.m_value = v),
    Equals$Object: (c: Ctx, o: any) => o != null && o.$type === (c.self as any).$type && o.m_value === c.ai.m_value,
    Equals$string: (c: Ctx, s: string) => String(c.ai.m_value) === s,
    GetHashCode: (c: Ctx) => c.ai.m_value,
    ToString: (c: Ctx) => `sym${c.ai.m_value}`,
  },
};
const SubSym: GenClassImpl = {
  name: 'TestSubSym',
  file: 'TestSubSym.cs',
  base: 'TestSym',
  initAi: () => ({}),
  overrides: {},
  delegates: {},
  methods: {
    ctor$int: (c: Ctx, v: number) => void (c.ai.m_value = v),
  },
};
const Pt: GenClassImpl = { name: 'TestPt', file: 'TestPt.cs', struct: true, initAi: () => ({ x: 0, y: 0 }), overrides: {}, delegates: {}, methods: {} };
registerGen({ TestSym: Sym, TestSubSym: SubSym, TestPt: Pt });

const sub = (v: number) => newGen(staticCtx, 'TestSubSym', 'ctor$int', v);

describe('產生類別覆寫的 Equals／GetHashCode／ToString', () => {
  it('Object.Equals、GetHashCode、ToString 沿繼承鏈分派到覆寫', () => {
    expect(Object_Equals$Object(staticCtx, sub(21), sub(21))).toBe(true);
    expect(Object_Equals$Object(staticCtx, sub(21), sub(13))).toBe(false);
    expect(Object_GetHashCode(staticCtx, sub(21))).toBe(21);
    expect(Object_ToString(staticCtx, sub(7))).toBe('sym7');
    expect(Object_ToString(staticCtx, true)).toBe('True');
    expect(Object_ToString(staticCtx, null)).toBe('');
  });
  it('Dictionary 的 key：另一個相等的實體查得到，刪了就查不到', () => {
    const d = new CsDict<unknown, string>();
    d.set(sub(21), 'Cancel');
    d.set(sub(19), 'Submit');
    expect(d.get(sub(21))).toBe('Cancel');
    expect(d.has(sub(13))).toBe(false);
    d.set(sub(21), 'Cancel2');
    expect(d.size).toBe(2);
    expect(d.delete(sub(21))).toBe(true);
    expect(d.has(sub(21))).toBe(false);
    d.set(sub(21), 'again');
    expect(d.get(sub(21))).toBe('again');
  });
  it('結構沒覆寫：照欄位比（Dictionary 與 HashSet）', () => {
    const a = { $type: 'TestPt', x: 1, y: 2 };
    const d = new CsDict<unknown, number>();
    d.set(a, 5);
    expect(d.get({ $type: 'TestPt', x: 1, y: 2 })).toBe(5);
    expect(Object_GetHashCode(staticCtx, a)).toBe(Object_GetHashCode(staticCtx, { $type: 'TestPt', x: 1, y: 2 }));
    const s = new_HashSet$(staticCtx);
    expect(HashSet_Add(staticCtx, s, a)).toBe(true);
    expect(HashSet_Add(staticCtx, s, { $type: 'TestPt', x: 1, y: 2 })).toBe(false);
    expect(HashSet_Contains(staticCtx, s, sub(1))).toBe(false);
  });
  it('HashSet 照覆寫的 Equals', () => {
    const s = new_HashSet$(staticCtx);
    HashSet_Add(staticCtx, s, sub(3));
    expect(HashSet_Contains(staticCtx, s, sub(3))).toBe(true);
    expect(HashSet_Remove(staticCtx, s, sub(3))).toBe(true);
    expect(s.length).toBe(0);
  });
});

describe('產生的結構是值型別', () => {
  it('cloneData 複製結構、不複製類別實體；new T[n] 每格各自一份（EnumValuesCache 的 Elem）', () => {
    const p = { $type: 'TestPt', x: 1, y: 2 };
    const q = cloneData(p);
    expect(q).not.toBe(p);
    expect(q).toEqual(p);
    const s = sub(1);
    expect(cloneData(s)).toBe(s);
    const arr = newArray(3, { $type: 'TestPt', x: 0, y: 0 }) as { x: number }[];
    arr[0].x = 5;
    expect(arr[1].x).toBe(0);
  });
});

// Malee 的 ReorderableArray<T>：自己包一個 List，實作 IList<T>；遊戲把它當 IList<T> 傳給 CoreUtil.RandomElement
const RA: GenClassImpl = {
  name: 'TestRA',
  file: 'TestRA.cs',
  interfaces: ['ICollection$1', 'IEnumerable', 'IEnumerable$1', 'IList$1'],
  initAi: () => ({ array: [] as unknown[] }),
  overrides: {},
  delegates: {},
  methods: {
    get_Item: (c: Ctx, i: number) => c.ai.array[i],
    set_Item: (c: Ctx, i: number, v: unknown) => void (c.ai.array[i] = v),
    get_Count: (c: Ctx) => c.ai.array.length,
    Add: (c: Ctx, x: unknown) => void c.ai.array.push(x),
    Insert: (c: Ctx, i: number, x: unknown) => void c.ai.array.splice(i, 0, x),
    RemoveAt: (c: Ctx, i: number) => void c.ai.array.splice(i, 1),
    Clear: (c: Ctx) => void (c.ai.array.length = 0),
  },
};
registerGen({ TestRA: RA });

describe('實作 IList<T> 的產生類別當 JS 陣列用', () => {
  it('length、索引、for…of、push、陣列方法、清空都分派到介面成員', () => {
    const ra = newGen(staticCtx, 'TestRA', null) as any;
    ra.push('a', 'b');
    expect(ra.length).toBe(2);
    expect(ra[1]).toBe('b');
    ra[0] = 'z';
    expect([...ra]).toEqual(['z', 'b']);
    expect(ra.includes('b')).toBe(true);
    expect(ra.map((x: string) => x.toUpperCase())).toEqual(['Z', 'B']);
    ra.splice(1, 0, 'm');
    expect(ra.array).toEqual(['z', 'm', 'b']);
    ra.length = 0;
    expect(ra.length).toBe(0);
    expect(ra.$type).toBe('TestRA');
  });
});

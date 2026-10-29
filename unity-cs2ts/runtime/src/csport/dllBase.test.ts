// 直接基底不是產生類別的資料類別：建構子的 : base(…) 由相容層的建構子建一份，併進實體（2026/10/16，MT2 的 FakePointerEventData、Ink 的 InkList）
import { describe, expect, it } from 'vitest';
import { callGen, componentVirtualGet, dllBaseInit, H, newGen, registerGen, setActiveWorld, staticCtx, type Ctx, type GenClassImpl } from './core';
import { new_Dictionary$ } from './dotnet';
import './unity';

describe('dllBaseInit', () => {
  it('資料類別：基底的欄位併進實體，$type 與自己的欄位不蓋', () => {
    const g: GenClassImpl = {
      name: 'TestFakePointerEventData',
      file: 'TestFakePointerEventData.cs',
      base: 'PointerEventData',
      initAi: () => ({ _axisEventData: null }),
      overrides: {},
      delegates: {},
      methods: {
        ctor: (c: Ctx) => dllBaseInit(c, { $type: 'PointerEventData', $isa: ['PointerEventData'], button: 0, eligibleForClick: false, _axisEventData: 'x' }),
      },
    };
    registerGen({ TestFakePointerEventData: g });
    const o = newGen(staticCtx, 'TestFakePointerEventData', 'ctor') as Record<string, unknown>;
    expect(o.$type).toBe('TestFakePointerEventData');
    expect(o.button).toBe(0);
    expect(o.eligibleForClick).toBe(false);
    expect(o._axisEventData).toBe(null);
  });

  it('集合：實體本身就是字典時，把基底建構子建好的內容抄進來', () => {
    const self = new_Dictionary$(staticCtx);
    const src = new_Dictionary$(staticCtx);
    src.set('a', 1);
    src.set('b', 2);
    dllBaseInit({ ...staticCtx, self } as Ctx, src);
    expect([...self.entries()]).toEqual([['a', 1], ['b', 2]]);
  });
});

describe('ctxOf：場景元件第一次被 w 是 null 的呼叫端叫到', () => {
  it('退回作用中的 World（MT2 拖卡經過房間：Signal 監聽者從靜態 ctx 叫還沒建 ctx 的 CharacterUI）', () => {
    const g: GenClassImpl = { name: 'TestSceneComp', file: 'TestSceneComp.cs', initAi: () => ({}), overrides: {}, delegates: {}, methods: { Who: (c: Ctx) => c.w } };
    registerGen({ TestSceneComp: g });
    const world = { graph: { components: () => [] } } as never;
    const comp = { type: 'MonoBehaviour', script: { class: 'TestSceneComp' } };
    const h = new H({ id: 'n' } as never, comp as never, 'comp');
    setActiveWorld(world);
    try {
      expect(callGen(staticCtx, 'TestSceneComp', 'Who', h)).toBe(world);
    } finally {
      setActiveWorld(null);
    }
  });
});

describe('componentVirtualGet：場景元件覆寫 DLL 基底的虛擬屬性', () => {
  it('產生類別（含產生的基底）覆寫了 get_raycastTarget 就照它（Coffee UIParticle 回 false），沒覆寫回 undefined', () => {
    const base: GenClassImpl = { name: 'TestParticleBase', file: 'b.cs', initAi: () => ({}), overrides: {}, delegates: {}, methods: { get_raycastTarget: () => false } };
    const derived: GenClassImpl = { name: 'TestParticle', file: 'd.cs', base: 'TestParticleBase', initAi: () => ({}), overrides: {}, delegates: {}, methods: {} };
    const plain: GenClassImpl = { name: 'TestPlainGraphic', file: 'p.cs', initAi: () => ({}), overrides: {}, delegates: {}, methods: {} };
    registerGen({ TestParticleBase: base, TestParticle: derived, TestPlainGraphic: plain });
    setActiveWorld({ graph: { components: () => [], nodeById: (id: string) => ({ id }) } } as never);
    try {
      expect(componentVirtualGet({ type: 'MonoBehaviour', script: { class: 'TestParticle' }, m_RaycastTarget: 1 } as never, 'raycastTarget')).toBe(false);
      expect(componentVirtualGet({ type: 'MonoBehaviour', script: { class: 'TestPlainGraphic' }, m_RaycastTarget: 1 } as never, 'raycastTarget')).toBeUndefined();
      expect(componentVirtualGet({ type: 'MonoBehaviour', script: { class: 'Image' }, m_RaycastTarget: 1 } as never, 'raycastTarget')).toBeUndefined();
    } finally {
      setActiveWorld(null);
    }
  });
});

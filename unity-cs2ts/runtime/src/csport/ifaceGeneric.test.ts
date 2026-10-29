import { describe, expect, it } from 'vitest';
import { callIface, callIfaceT, newGen, registerGen, staticCtx, type GenClassImpl } from './core';

// 跟 MT2 的 RelicTooltipProvider／RelicInfoUI 同一個形狀：基底實作 IDataView<RelicState>、IDataView<RelicData>（virtual Set），
// 子類別覆寫 Set(RelicState)，另外明確實作 IDataView<CollectableRelicData>.Set（產生名 IDataView$1$Set，不帶型別引數）
const calls: string[] = [];
const Base: GenClassImpl = {
  name: 'TestRelicTooltipProvider',
  file: 'TestRelicTooltipProvider.cs',
  initAi: () => ({}),
  overrides: {},
  delegates: {},
  methods: {
    Set$RelicState_int: () => void calls.push('Base.Set(RelicState)'),
    Set$RelicData_int: () => void calls.push('Base.Set(RelicData)'),
  },
  interfaces: ['IDataView$1'],
  ifaceImpls: { 'IDataView$1<RelicState>$Set': 'Set$RelicState_int', 'IDataView$1<RelicData>$Set': 'Set$RelicData_int' },
};
const Sub: GenClassImpl = {
  name: 'TestRelicInfoUI',
  file: 'TestRelicInfoUI.cs',
  base: 'TestRelicTooltipProvider',
  initAi: () => ({}),
  overrides: {},
  delegates: {},
  methods: {
    IDataView$1$Set: () => void calls.push('Sub.IDataView<CollectableRelicData>.Set'),
    Set$RelicData: () => void calls.push('Sub.Set(RelicData)'),
    Set$RelicState_int: () => void calls.push('Sub.Set(RelicState)'),
  },
  interfaces: ['IDataView$1'],
  ifaceImpls: {
    'IDataView$1<RelicState>$Set': 'Set$RelicState_int',
    'IDataView$1<RelicData>$Set': 'Set$RelicData_int',
    'IDataView$1<CollectableRelicData>$Set': 'IDataView$1$Set',
  },
};
registerGen({ TestRelicTooltipProvider: Base, TestRelicInfoUI: Sub });

describe('泛型介面的多種封閉型別（IDataView<T>.Set）', () => {
  it('照呼叫端的型別引數找實作，覆寫照實際類別分派；基底才有的實作往上找', () => {
    const ui = newGen(staticCtx, 'TestRelicInfoUI', null) as object;
    calls.length = 0;
    callIfaceT(staticCtx, 'IDataView$1', ['RelicState'], 'Set', ui, {}, 0);
    callIfaceT(staticCtx, 'IDataView$1', ['RelicData'], 'Set', ui, {}, 0);
    callIfaceT(staticCtx, 'IDataView$1', ['CollectableRelicData'], 'Set', ui, {}, 0);
    expect(calls).toEqual(['Sub.Set(RelicState)', 'Base.Set(RelicData)', 'Sub.IDataView<CollectableRelicData>.Set']);
  });

  it('沒有對照表時跟 callIface 一樣（以前 IDataView<RelicState> 也打到明確實作，GameObjectUtil.PopulateViewList 的戰前試煉標題）', () => {
    const ui = newGen(staticCtx, 'TestRelicInfoUI', null) as object;
    calls.length = 0;
    callIface(staticCtx, 'IDataView$1', 'Set', ui, {}, 0);
    callIfaceT(staticCtx, 'IDataView$1', ['SomethingElse'], 'Set', ui, {}, 0);
    expect(calls).toEqual(['Sub.IDataView<CollectableRelicData>.Set', 'Sub.IDataView<CollectableRelicData>.Set']);
  });
});

import { describe, expect, it } from 'vitest';
import { boundAs, boundGen, newGen, registerGen, staticCtx, type GenClassImpl } from './core';

// 跟 MT2 的 UIScreen／RewardScreen 同一個形狀：子類別覆寫 Close，覆寫裡把 base.Close 當委派交出去（補間的 OnComplete）
const calls: string[] = [];
const Base: GenClassImpl = {
  name: 'TestScreen',
  file: 'TestScreen.cs',
  initAi: () => ({}),
  overrides: {},
  delegates: {},
  methods: { Close: () => void calls.push('TestScreen.Close') },
};
const Sub: GenClassImpl = {
  name: 'TestRewardScreen',
  file: 'TestRewardScreen.cs',
  base: 'TestScreen',
  initAi: () => ({}),
  overrides: { Close: () => void calls.push('TestRewardScreen.Close') },
  delegates: {},
  methods: { Close: () => void calls.push('TestRewardScreen.Close') },
};
registerGen({ TestScreen: Base, TestRewardScreen: Sub });

describe('方法群組當委派', () => {
  it('base.M 固定叫基底那一版，一般的方法群組照實際類別分派', () => {
    const s = newGen(staticCtx, 'TestRewardScreen', null) as object;
    calls.length = 0;
    boundAs(staticCtx, 'TestScreen', 'Close', s)!();
    expect(calls).toEqual(['TestScreen.Close']);
    calls.length = 0;
    boundGen(staticCtx, 'TestScreen', 'Close', s)!();
    expect(calls).toEqual(['TestRewardScreen.Close']);
  });

  it('同一個實體同一個方法拿到同一個函式（-= 拿得掉），base 版跟分派版不同', () => {
    const s = newGen(staticCtx, 'TestRewardScreen', null) as object;
    expect(boundAs(staticCtx, 'TestScreen', 'Close', s)).toBe(boundAs(staticCtx, 'TestScreen', 'Close', s));
    expect(boundAs(staticCtx, 'TestScreen', 'Close', s)).not.toBe(boundGen(staticCtx, 'TestScreen', 'Close', s));
  });
});

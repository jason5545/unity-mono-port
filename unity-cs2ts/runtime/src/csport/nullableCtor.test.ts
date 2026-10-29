// new T?(值)：相容層的 Nullable<T> 是「值或 null」
import { describe, expect, it } from 'vitest';
import { newExternal, staticCtx } from './core';
import { Nullable_get_HasValue, Nullable_get_Value } from './dotnetBcl';

describe('new Nullable<T>', () => {
  it('new bool?(false) 是 false、有值（CombatManager.GetTargetCharacters 的 firstEffectInPlayedCard）；new int?() 是 null', () => {
    const v = newExternal(staticCtx, 'Nullable', false);
    expect(v).toBe(false);
    expect(Nullable_get_HasValue(staticCtx, v)).toBe(true);
    expect(Nullable_get_Value(staticCtx, v)).toBe(false);
    expect(newExternal(staticCtx, 'Nullable', 3)).toBe(3);
    expect(Nullable_get_HasValue(staticCtx, newExternal(staticCtx, 'Nullable'))).toBe(false);
  });
});

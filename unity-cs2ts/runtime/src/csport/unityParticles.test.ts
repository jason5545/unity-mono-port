// ParticleSystem.main（2026/10/16，MT2 出牌生單位時 AnimEventFx.Awake 讀 simulationSpeed、VFXModify 改複本的 simulationSpeed）
import { describe, expect, it } from 'vitest';
import { cloneData, H, staticCtx as c } from './core';
import { nativeGet, nativeSet } from './unityNative';
import './unityParticles';

function ps(): { comp: Record<string, unknown>; h: H } {
  const comp: Record<string, unknown> = {
    type: 'ParticleSystem',
    lengthInSec: 1.5,
    simulationSpeed: 1,
    looping: 0,
    moveWithTransform: 1,
    scalingMode: 1,
    startDelay: { minMaxState: 0, scalar: 0, minScalar: 0 },
    InitialModule: {
      maxNumParticles: 1000,
      startLifetime: { minMaxState: 3, scalar: 0.1, minScalar: 0.3, maxCurve: { m_Curve: [] }, minCurve: { m_Curve: [] } },
      startSize: { minMaxState: 1, scalar: 2, minScalar: 0, maxCurve: { m_Curve: [{ time: 0, value: 1 }] }, minCurve: { m_Curve: [] } },
    },
  };
  return { comp, h: new H({} as never, comp as never, 'comp') };
}

describe('ParticleSystem.MainModule：讀寫落在粒子系統的序列化資料', () => {
  it('屬性照 InitialModuleUI.cs 的欄位對應讀出來', () => {
    const { h } = ps();
    const main = nativeGet(c, h, 'ParticleSystem', 'main');
    expect(nativeGet(c, main, 'ParticleSystem_MainModule', 'duration')).toBe(1.5);
    expect(nativeGet(c, main, 'ParticleSystem_MainModule', 'loop')).toBe(false);
    expect(nativeGet(c, main, 'ParticleSystem_MainModule', 'simulationSpace')).toBe(1);
    expect(nativeGet(c, main, 'ParticleSystem_MainModule', 'maxParticles')).toBe(1000);
  });
  it('改模組的複本就是改粒子系統（C# 的 var main = ps.main; main.simulationSpeed = x）', () => {
    const { comp, h } = ps();
    const main = cloneData(nativeGet(c, h, 'ParticleSystem', 'main'));
    nativeSet(c, main, 'ParticleSystem_MainModule', 'simulationSpeed', 2.5);
    nativeSet(c, main, 'ParticleSystem_MainModule', 'loop', true);
    expect(comp.simulationSpeed).toBe(2.5);
    expect(comp.looping).toBe(1);
    expect(nativeGet(c, nativeGet(c, h, 'ParticleSystem', 'main'), 'ParticleSystem_MainModule', 'simulationSpeed')).toBe(2.5);
  });
  it('MinMaxCurve：TwoConstants 的 scalar／minScalar 是 constantMax／constantMin；曲線模式的 scalar 是倍率', () => {
    const { comp, h } = ps();
    const main = nativeGet(c, h, 'ParticleSystem', 'main');
    const life = nativeGet(c, main, 'ParticleSystem_MainModule', 'startLifetime');
    expect(nativeGet(c, life, 'ParticleSystem_MinMaxCurve', 'mode')).toBe(3);
    expect(nativeGet(c, life, 'ParticleSystem_MinMaxCurve', 'constantMin')).toBe(0.3);
    expect(nativeGet(c, life, 'ParticleSystem_MinMaxCurve', 'constant')).toBe(0.1);
    const size = nativeGet(c, main, 'ParticleSystem_MainModule', 'startSize');
    expect(nativeGet(c, size, 'ParticleSystem_MinMaxCurve', 'curveMultiplier')).toBe(2);
    expect(nativeGet(c, size, 'ParticleSystem_MinMaxCurve', 'curve')).toEqual({ m_Curve: [{ time: 0, value: 1 }] });
    // float 隱含轉 MinMaxCurve 再寫回：變成 Constant
    nativeSet(c, main, 'ParticleSystem_MainModule', 'startLifetime', 4);
    expect((comp.InitialModule as Record<string, { minMaxState: number; scalar: number }>).startLifetime).toMatchObject({ minMaxState: 0, scalar: 4 });
  });
});

describe('ParticleSystem 的其他模組：enabled 與用到的屬性照序列化的 XModule', () => {
  it('trails ↔ TrailModule、textureSheetAnimation ↔ UVModule（numTilesX ↔ tilesX、spriteCount ↔ sprites 的長度）', () => {
    const comp: Record<string, unknown> = {
      type: 'ParticleSystem',
      TrailModule: { enabled: 0, worldSpace: 1 },
      UVModule: { enabled: 1, mode: 1, tilesX: 4, tilesY: 2, cycles: 3, sprites: [{ sprite: null }, { sprite: null }], frameOverTime: { minMaxState: 1, scalar: 0.9999, minScalar: 0, maxCurve: { m_Curve: [] }, minCurve: { m_Curve: [] } } },
    };
    const h = new H({} as never, comp as never, 'comp');
    const trails = nativeGet(c, h, 'ParticleSystem', 'trails');
    expect(nativeGet(c, trails, 'ParticleSystem_TrailModule', 'enabled')).toBe(false);
    expect(nativeGet(c, trails, 'ParticleSystem_TrailModule', 'worldSpace')).toBe(true);
    nativeSet(c, cloneData(trails), 'ParticleSystem_TrailModule', 'enabled', true);
    expect((comp.TrailModule as { enabled: number }).enabled).toBe(1);
    const tsa = nativeGet(c, h, 'ParticleSystem', 'textureSheetAnimation');
    expect(nativeGet(c, tsa, 'ParticleSystem_TextureSheetAnimationModule', 'numTilesX')).toBe(4);
    expect(nativeGet(c, tsa, 'ParticleSystem_TextureSheetAnimationModule', 'cycleCount')).toBe(3);
    expect(nativeGet(c, tsa, 'ParticleSystem_TextureSheetAnimationModule', 'spriteCount')).toBe(2);
    expect(nativeGet(c, nativeGet(c, tsa, 'ParticleSystem_TextureSheetAnimationModule', 'frameOverTime'), 'ParticleSystem_MinMaxCurve', 'curveMultiplier')).toBe(0.9999);
    // 沒有序列化的模組（舊資料）：enabled 是 false，不丟例外
    expect(nativeGet(c, nativeGet(c, h, 'ParticleSystem', 'noise'), 'ParticleSystem_NoiseModule', 'enabled')).toBe(false);
  });
});

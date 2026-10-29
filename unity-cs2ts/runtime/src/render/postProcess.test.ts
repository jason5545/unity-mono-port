// 戰鬥房間的火盆（2026/10/17，Jason 拿原版 Windows 2.2.1 的畫面對照）：火不會動、顏色是平的紅、整個房間偏暗。四個原因：
//   1. shader 的 _Time 一律給 0（「動畫是 0g」一直沒做），靠時間捲動的雜訊、扭曲都是靜止的。
//   2. 烘焙光照圖沒畫：MT2 的房間靠 PrefabLightmapData 在 Start 設 LightmapSettings.lightmaps 與 Renderer.lightmapIndex，
//      繪製端沒讀，房間只剩即時光（烘焙用的燈還被 _lightsToDisable 關掉）。
//   3. Post Processing v2 沒畫：GameCamera 的 profile 是 Bloom（強度 1.2、門檻 0.2）、HDR 色彩分級（ACES、飽和 +5、對比 +10）、暗角 0.625。
//   4. 標了 [HDR] 的顏色被轉成線性：火的 _Color_1 (1, 0.1296, 0) 變成 (1, 0.0153, 0)，核心到不了原版的橘黃（推論，見 materialColorConstant）。
import { describe, expect, it } from 'vitest';
import { bloomParams, colorToGain, colorToInverseGamma, colorToLift, computeColorBalance, effectActive, gammaToLinearSpace, lutBakerParams, tonemapKeyword, vignetteParams } from './postProcess';
import { materialColorConstant, shaderTimeGlobals } from './sceneRenderer';
import { defaultEffect, interpParam, overrideSettings, type PPEffect } from '../csport/unityPostProcess';
import { H, staticCtx } from '../csport/core';
import { lightmapOf, nativeGet, nativeSet } from '../csport/unityNative';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';

/** MT2 的 MainCamera-PostProcessingProfile（只列 overrideState 為真的參數） */
const MT2_PROFILE = [
  { $type: 'ColorGrading', active: 1, enabled: { overrideState: 1, value: 1 }, gradingMode: { overrideState: 1, value: 1 }, tonemapper: { overrideState: 1, value: 2 }, saturation: { overrideState: 1, value: 5 }, contrast: { overrideState: 1, value: 10 }, temperature: { overrideState: 0, value: 5 } },
  { $type: 'Bloom', active: 1, enabled: { overrideState: 1, value: true }, intensity: { overrideState: 1, value: 1.2 }, threshold: { overrideState: 1, value: 0.2 }, fastMode: { overrideState: true, value: false } },
  { $type: 'Vignette', active: 1, enabled: { overrideState: 1, value: 1 }, mode: { overrideState: 1, value: 0 }, intensity: { overrideState: 1, value: 0.625 }, roundness: { overrideState: 1, value: 0 } },
  { $type: 'MotionBlur', active: 0, enabled: { overrideState: 1, value: true } },
];

function blended(weight = 1): Record<string, PPEffect> {
  const e: Record<string, PPEffect> = { Bloom: defaultEffect('Bloom'), ColorGrading: defaultEffect('ColorGrading'), Vignette: defaultEffect('Vignette') };
  overrideSettings(e, MT2_PROFILE, weight);
  return e;
}

describe('shader 的時間全域（Unity 手冊 Built-in shader variables）', () => {
  it('_Time ＝ (t/20, t, 2t, 3t)、_SinTime／_CosTime 是 t/8、t/4、t/2、t、unity_DeltaTime ＝ (dt, 1/dt, smoothDt, 1/smoothDt)', () => {
    const g = shaderTimeGlobals(10, 0.02, 0.025);
    expect(g._Time).toEqual([0.5, 10, 20, 30]);
    expect(g._SinTime.map((v) => +v.toFixed(6))).toEqual([Math.sin(1.25), Math.sin(2.5), Math.sin(5), Math.sin(10)].map((v) => +v.toFixed(6)));
    expect(g._CosTime[3]).toBeCloseTo(Math.cos(10), 9);
    expect(g.unity_DeltaTime).toEqual([0.02, 50, 0.025, 40]);
    expect(g._TimeParameters).toEqual([10, Math.sin(10), Math.cos(10), 0]);
    // 第 0 格 dt ＝ 0：倒數給 0（不給 Infinity）
    expect(shaderTimeGlobals(0, 0, 0).unity_DeltaTime).toEqual([0, 0, 0, 0]);
  });
});

describe('材質顏色進 cbuffer', () => {
  it('Color 轉線性、Vector 不轉、[HDR] 的 Color 不轉（火盆 FireVertical 的 _Color_1）', () => {
    const c = { r: 1, g: 0.12962784, b: 0, a: 0 };
    expect(materialColorConstant(c, true, false)[1]).toBeCloseTo(0.01525, 4);
    expect(materialColorConstant(c, true, true)).toEqual([1, 0.12962784, 0, 0]);
    expect(materialColorConstant(c, false, false)).toEqual([1, 0.12962784, 0, 0]);
  });
});

describe('Post Processing v2 的 volume 混合（PostProcessManager.UpdateSettings／PostProcessLayer.OverrideSettings）', () => {
  it('overrideState 為真的參數才蓋；沒蓋的維持效果類別的預設值；active 0 的效果整個不算', () => {
    const e = blended();
    expect(e.ColorGrading.saturation).toBe(5);
    expect(e.ColorGrading.temperature).toBe(0); // profile 存 5，但沒有 override
    expect(e.Bloom.softKnee).toBe(0.5);
    expect(e.MotionBlur).toBeUndefined();
    expect(effectActive('Bloom', e.Bloom)).toBe(true);
    expect(effectActive('Vignette', e.Vignette)).toBe(true);
  });

  it('weight 0.5：Float 線性插、列舉與布林 t > 0 就換', () => {
    const e = blended(0.5);
    expect(e.Bloom.intensity).toBeCloseTo(0.6, 9);
    expect(e.Bloom.threshold).toBeCloseTo(0.6, 9); // 預設 1 → 0.2
    expect(e.ColorGrading.tonemapper).toBe(2);
    expect(interpParam(false, true, 0.5)).toBe(true);
    expect(interpParam(false, true, 0)).toBe(false);
    expect(interpParam({ r: 0, g: 0, b: 0, a: 1 }, { r: 1, g: 1, b: 1, a: 1 }, 0.25)).toEqual({ r: 0.25, g: 0.25, b: 0.25, a: 1 });
  });
});

describe('Post Processing v2 的參數（BloomRenderer、ColorGradingRenderer.RenderHDRPipeline2D、VignetteRenderer）', () => {
  it('Bloom：2100×1181 的畫面 7 層；門檻轉線性；強度 2^(1.2/10) − 1', () => {
    const b = bloomParams(blended().Bloom, 2100, 1181);
    expect(b.iterations).toBe(7);
    expect(b.sizes[0]).toEqual({ w: 1050, h: 590 });
    expect(b.sizes[6]).toEqual({ w: 16, h: 9 });
    expect(b.sampleScale).toBeCloseTo(0.5 + Math.log2(1050) - 3 - 7, 6);
    const t = gammaToLinearSpace(0.2);
    expect(t).toBeCloseTo(0.0331, 4);
    const knee = t * 0.5 + 1e-5;
    expect(b.threshold.map((v) => +v.toFixed(6))).toEqual([t, t - knee, knee * 2, 0.25 / knee].map((v) => +v.toFixed(6)));
    expect(b.settings[1]).toBeCloseTo(Math.pow(2, 0.12) - 1, 9);
  });

  it('色彩分級：ACES、飽和 1.05、對比 1.1；預設的 lift／gamma／gain 是不變的值；色溫 0 的白平衡約 1', () => {
    const cg = blended().ColorGrading;
    expect(tonemapKeyword(cg)).toBe('TONEMAPPING_ACES');
    const p = lutBakerParams(cg);
    expect(p._HueSatCon).toEqual([0, 1.05, 1.1]);
    expect(p._Lift.map((v) => +v.toFixed(6))).toEqual([0, 0, 0]);
    expect(p._InvGamma.map((v) => +v.toFixed(6))).toEqual([1, 1, 1]);
    expect(p._Gain.map((v) => +v.toFixed(6))).toEqual([1, 1, 1]);
    for (const v of computeColorBalance(0, 0)) expect(v).toBeCloseTo(1, 3);
    expect(colorToLift([0.3, 0.2, 0.2, 0.1])[0]).toBeGreaterThan(colorToLift([0.2, 0.2, 0.2, 0.1])[0]);
    expect(colorToInverseGamma([1, 1, 1, -1]).every((v) => v === 1000)).toBe(true); // max(…, 0.001)
    expect(colorToGain([1, 1, 1, 0])).toEqual([1, 1, 1]);
  });

  it('暗角 Classic：強度 × 3、平滑 × 5、roundness 0 → 6', () => {
    const v = vignetteParams(blended().Vignette);
    expect(v._Vignette_Settings).toEqual([1.875, 1, 6, 0]);
    expect(v._Vignette_Center).toEqual([0.5, 0.5]);
    expect(v._Vignette_Mode).toEqual([0]);
  });
});

describe('烘焙光照圖（PrefabLightmapData 設的 LightmapSettings.lightmaps 與 Renderer.lightmapIndex）', () => {
  it('lightmapIndex／lightmapScaleOffset 存成序列化欄位，繪製端照清單取貼圖；−1、65535、超出清單回 null', () => {
    const comp = { type: 'MeshRenderer' } as unknown as ComponentData;
    const h = new H({} as SceneNode, comp, 'comp');
    const c = staticCtx;
    expect(nativeGet(c, h, 'Renderer', 'lightmapIndex')).toBe(-1);
    expect(lightmapOf(comp)).toBeNull();
    nativeSet(c, null, 'LightmapSettings', 'lightmaps', [{ $type: 'LightmapData', lightmapColor: { guid: 'aaa', fileID: '2800000' } }, { $type: 'LightmapData', lightmapColor: { guid: 'c70dba05', fileID: '2800000' } }]);
    nativeSet(c, h, 'Renderer', 'lightmapIndex', 1);
    nativeSet(c, h, 'Renderer', 'lightmapScaleOffset', { x: 0.7432256, y: 0.7432256, z: -0.005899879, w: -0.005899879 });
    expect(comp.m_LightmapIndex).toBe(1);
    expect(lightmapOf(comp)).toEqual({ guid: 'c70dba05', scaleOffset: [0.7432256, 0.7432256, -0.005899879, -0.005899879] });
    nativeSet(c, h, 'Renderer', 'lightmapIndex', 5);
    expect(lightmapOf(comp)).toBeNull();
    comp.m_LightmapIndex = 0xffff;
    expect(nativeGet(c, h, 'Renderer', 'lightmapIndex')).toBe(-1);
    expect(lightmapOf(comp)).toBeNull();
    nativeSet(c, null, 'LightmapSettings', 'lightmaps', []);
  });
});

// built-in 管線 ForwardBase 的光照常數（2026/10/17，MT2：火車與角色各自只受一盞平行光，靠光源的 cullingMask 分開）
import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { builtinKeywords, builtinLightGlobals, lightFinalColor, mainLightFor, packAmbientSH, type BuiltinLightingInput } from './builtinLighting';
import { gammaToLinear } from '../unity/color';

function light(name: string, comp: Partial<ComponentData>, rot = new Quaternion()) {
  const node = { go: { m_Name: name }, activeInHierarchy: true, world: new Matrix4().compose(new Vector3(), rot, new Vector3(1, 1, 1)) } as unknown as SceneNode;
  return { node, comp: { type: 'Light', m_Enabled: 1, m_Type: 1, m_Intensity: 1, m_Color: { r: 1, g: 1, b: 1, a: 1 }, ...comp } as ComponentData };
}

const input = (lights: ReturnType<typeof light>[], rs: Record<string, unknown> = {}, probe: number[] | null = null): BuiltinLightingInput => ({
  lights,
  renderSettings: rs,
  ambientProbe: probe,
  lightsUseLinearIntensity: false,
});

describe('builtinLighting：主光源照圖層挑', () => {
  it('cullingMask 不含物件圖層的平行光不算；兩盞都算時挑強度大的', () => {
    const train = light('Light_Train', { m_Intensity: 0.85, m_CullingMask: { m_Bits: 1 << 13 } });
    const chara = light('Light_Character', { m_Intensity: 0.45, m_CullingMask: { m_Bits: 1 << 10 } });
    const all = light('All', { m_Intensity: 0.5 });
    expect(mainLightFor(input([train, chara]), 13)?.node.go.m_Name).toBe('Light_Train');
    expect(mainLightFor(input([train, chara]), 10)?.node.go.m_Name).toBe('Light_Character');
    expect(mainLightFor(input([train, chara]), 0)).toBeNull();
    expect(mainLightFor(input([chara, all]), 10)?.node.go.m_Name).toBe('All');
  });
  it('_WorldSpaceLightPos0 是指向光源的方向（−forward）；沒有主光源時顏色是 0', () => {
    // 繞 x 軸轉 90 度：forward (0,0,1) → (0,−1,0)，光往下照，指向光源是 (0,1,0)
    const down = light('Sun', {}, new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2));
    const g: Record<string, number[]> = {};
    builtinLightGlobals(input([down]), 0, g);
    expect(g._WorldSpaceLightPos0.map((v) => +v.toFixed(6) + 0)).toEqual([0, 1, 0, 0]);
    builtinLightGlobals(input([]), 0, g);
    expect(g._LightColor0).toEqual([0, 0, 0, 0]);
  });
  it('lightsUseLinearIntensity false：強度乘在 gamma 色上再轉線性', () => {
    const c = lightFinalColor({ r: 0.5, g: 1, b: 1, a: 1 }, 0.8, false);
    expect(c[0]).toBeCloseTo(gammaToLinear(0.4), 6);
    const lin = lightFinalColor({ r: 0.5, g: 1, b: 1, a: 1 }, 0.8, true);
    expect(lin[0]).toBeCloseTo(gammaToLinear(0.5) * 0.8, 6);
  });
});

describe('builtinLighting：環境光的 SH 與霧', () => {
  it('只有常數項的 SH：ShadeSH9 的常數部分（SHA.w − SHC 的 sh6 項，見 PackCoefficients）等於 L0 × 0.282095', () => {
    const sh = new Array(27).fill(0);
    sh[0] = 1; // R 的 L0
    sh[9] = 2; // G
    sh[18] = 3; // B
    const p = packAmbientSH(sh);
    expect(p.unity_SHAr[3]).toBeCloseTo(0.282095, 6);
    expect(p.unity_SHAg[3]).toBeCloseTo(0.56419, 6);
    expect(p.unity_SHAb[3]).toBeCloseTo(0.846285, 6);
    expect(p.unity_SHBr.map((v) => v + 0)).toEqual([0, 0, 0, 0]);
  });
  it('沒有 LightingData 時 Flat 環境光：常數項 ＝ 天空色轉線性 × 強度', () => {
    const g: Record<string, number[]> = {};
    builtinLightGlobals(input([], { m_AmbientMode: 3, m_AmbientSkyColor: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, m_AmbientIntensity: 2 }), 0, g);
    expect(g.unity_SHAr[3]).toBeCloseTo(gammaToLinear(0.5) * 2, 6);
  });
  it('線性霧：FOG_LINEAR 與 unity_FogParams 的 z、w', () => {
    const rs = { m_Fog: 1, m_FogMode: 1, m_LinearFogStart: 100, m_LinearFogEnd: 3500, m_FogDensity: 0.01 };
    expect(builtinKeywords(input([], rs))).toEqual(['DIRECTIONAL', 'LIGHTPROBE_SH', 'FOG_LINEAR']);
    const g: Record<string, number[]> = {};
    builtinLightGlobals(input([], rs), 0, g);
    expect(g.unity_FogParams[2]).toBeCloseTo(-1 / 3400, 9);
    expect(g.unity_FogParams[3]).toBeCloseTo(3500 / 3400, 9);
    expect(builtinKeywords(input([], { m_Fog: 0 }))).toEqual(['DIRECTIONAL', 'LIGHTPROBE_SH']);
    // Overlay Canvas 的 UI（fog: false）：不加霧的 keyword，同 unity-native（Jason 10/19）
    expect(builtinKeywords(input([], rs), { fog: false })).toEqual(['DIRECTIONAL', 'LIGHTPROBE_SH']);
  });
});

// built-in 管線前向繪製（ForwardBase pass）的光照常數與 keyword（UnityShaderVariables.cginc 的那些全域值；Unity 原生程式碼設的，看不到原文）。
//
// 每個物件一組（照物件的圖層挑光源，所以實作上是每個圖層一組，每格重算）：
//   - 主光源：啟用中的平行光、cullingMask 含物件圖層的，挑強度最大的（RenderSettings.sun 有設時優先）。
//     _WorldSpaceLightPos0 ＝ (−forward, 0)（指向光源的方向）、_LightColor0 ＝ 光的顏色 × 強度。沒有主光源時兩個都是 0。
//     GraphicsSettings.lightsUseLinearIntensity 是 false（MT2）時，Unity 文件說強度乘在 gamma 色上：線性值 ＝ 轉線性(顏色 × 強度)；
//     true 時是 轉線性(顏色) × 強度。
//   - 環境光（SH，ShadeSH9 讀 unity_SHAr…unity_SHC）：場景 LightingData 的 m_BakedAmbientProbeInLinear（27 個係數，照 SphericalHarmonicsL2
//     的 [通道 × 9 + 係數]），先乘基底常數（HDRP 的 SphericalHarmonicMath.PremultiplyCoefficients 的 ks）再照 PackCoefficients 排；
//     內建管線引擎內部是不是同一套換算未查證（HDRP 跟它相容的寫法）。沒有 LightingData 時照 m_AmbientMode：Flat（3）只有常數項 ＝ 天空色轉線性 × 強度。
//   - 霧：RenderSettings 的 m_Fog 開著時 FOG_LINEAR／FOG_EXP／FOG_EXP2（m_FogMode 1／2／3），unity_FogColor（線性）、
//     unity_FogParams ＝ (density/√ln2, density/ln2, −1/(end−start), end/(end−start))（UnityShaderVariables.cginc 的註解）。
//   - keyword：沒有 lightmap 的動態物件是 DIRECTIONAL＋LIGHTPROBE_SH（multi_compile_fwdbase）；陰影（SHADOWS_SCREEN）與頂點光源
//     （VERTEXLIGHT_ON）沒做（差異清單）。
// 與原版的差異：陰影、ForwardAdd（其他逐像素光源）、頂點光源、光照探針群組（物件的 SH 一律用環境探針）、反射探針的盒狀投影。

import * as THREE from 'three';
import { colorToLinear } from '../unity/color';
import type { ColorRGBA } from '../unity/types';
import type { LightEntry } from './mesh3d';

export interface BuiltinLightingInput {
  lights: LightEntry[];
  /** 目前 active 場景的 RenderSettings（Unity 用 active 場景的光照設定） */
  renderSettings: Record<string, unknown> | undefined;
  /** active 場景 LightingData 的 m_BakedAmbientProbeInLinear（27 個係數），沒有是 null */
  ambientProbe: number[] | null;
  /** GraphicsSettings.m_LightsUseLinearIntensity */
  lightsUseLinearIntensity: boolean;
}

/** HDRP SphericalHarmonicMath.PremultiplyCoefficients 的 ks（SH 基底的正規化常數） */
const SH_KS = [0.282095, -0.325735, 0.325735, -0.325735, 0.273137, -0.273137, 0.078848, -0.273137, 0.136569];

/** SphericalHarmonicsL2（27 個係數）→ unity_SHAr／Ag／Ab／Br／Bg／Bb／C（HDRP SphericalHarmonicMath.PackCoefficients） */
export function packAmbientSH(sh: ArrayLike<number>): Record<string, number[]> {
  const k = (c: number, i: number): number => (sh[c * 9 + i] ?? 0) * SH_KS[i];
  const out: Record<string, number[]> = {};
  const names = ['r', 'g', 'b'];
  for (let c = 0; c < 3; c++) {
    out[`unity_SHA${names[c]}`] = [k(c, 3), k(c, 1), k(c, 2), k(c, 0) - k(c, 6)];
    out[`unity_SHB${names[c]}`] = [k(c, 4), k(c, 5), k(c, 6) * 3, k(c, 7)];
  }
  out.unity_SHC = [k(0, 8), k(1, 8), k(2, 8), 1];
  return out;
}

/** 常數環境光（Flat）的 SH：只有常數項 */
export function flatAmbientSH(color: { r: number; g: number; b: number }): Record<string, number[]> {
  return {
    unity_SHAr: [0, 0, 0, color.r],
    unity_SHAg: [0, 0, 0, color.g],
    unity_SHAb: [0, 0, 0, color.b],
    unity_SHBr: [0, 0, 0, 0],
    unity_SHBg: [0, 0, 0, 0],
    unity_SHBb: [0, 0, 0, 0],
    unity_SHC: [0, 0, 0, 1],
  };
}

function forwardOf(world: THREE.Matrix4): THREE.Vector3 {
  const q = new THREE.Quaternion();
  world.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
}

/** 光源的最終顏色（線性），見檔頭 lightsUseLinearIntensity */
export function lightFinalColor(color: ColorRGBA, intensity: number, linearIntensity: boolean): number[] {
  if (linearIntensity) {
    const c = colorToLinear(color);
    return [c.r * intensity, c.g * intensity, c.b * intensity, 1];
  }
  const c = colorToLinear({ r: color.r * intensity, g: color.g * intensity, b: color.b * intensity, a: color.a });
  return [c.r, c.g, c.b, 1];
}

const lit = (l: LightEntry): boolean => l.node.activeInHierarchy && l.comp.m_Enabled !== 0;
const maskOf = (l: LightEntry): number => {
  const b = (l.comp.m_CullingMask as { m_Bits?: number } | undefined)?.m_Bits;
  return b === undefined ? 0xffffffff : b >>> 0;
};

/** 這個圖層的主光源（平行光，見檔頭）；沒有是 null */
export function mainLightFor(input: BuiltinLightingInput, layer: number): LightEntry | null {
  let main: LightEntry | null = null;
  for (const l of input.lights) {
    if (!lit(l) || l.comp.m_Type !== 1 || (maskOf(l) & (1 << (layer & 31))) === 0) continue;
    if (!main || ((l.comp.m_Intensity as number) ?? 1) > ((main.comp.m_Intensity as number) ?? 1)) main = l;
  }
  return main;
}

const FOG_KEYWORDS: Record<number, string> = { 1: 'FOG_LINEAR', 2: 'FOG_EXP', 3: 'FOG_EXP2' };

/**
 * ForwardBase 的 keyword（材質自己的另外加）。fog＝false：不加霧的 keyword（Overlay Canvas 的 UI：不在任何一台攝影機的繪製裡；
 * unity-native 的霧 keyword 也只給 MeshRenderer，UI 一律選不到霧的變體。Unity 怎麼處理 Overlay 的霧未查證，照原生版，Jason 10/19 裁定）
 */
export function builtinKeywords(input: BuiltinLightingInput, opts: { fog?: boolean } = {}): string[] {
  const out = ['DIRECTIONAL', 'LIGHTPROBE_SH'];
  const rs = input.renderSettings;
  if (rs && rs.m_Fog && opts.fog !== false) {
    const kw = FOG_KEYWORDS[(rs.m_FogMode as number) ?? 3];
    if (kw) out.push(kw);
  }
  return out;
}

/** 這個圖層的光照常數寫進 out（就地改，K3 程式的 ctx.globals 指著它） */
export function builtinLightGlobals(input: BuiltinLightingInput, layer: number, out: Record<string, number[]>): void {
  const main = mainLightFor(input, layer);
  if (main) {
    const f = forwardOf(main.node.world);
    out._WorldSpaceLightPos0 = [-f.x, -f.y, -f.z, 0];
    out._LightColor0 = lightFinalColor(main.comp.m_Color as ColorRGBA, (main.comp.m_Intensity as number) ?? 1, input.lightsUseLinearIntensity);
  } else {
    out._WorldSpaceLightPos0 = [0, 0, 0, 0];
    out._LightColor0 = [0, 0, 0, 0];
  }
  const rs = input.renderSettings ?? {};
  const sky = (rs.m_AmbientSkyColor as ColorRGBA | undefined) ?? { r: 0, g: 0, b: 0, a: 1 };
  const intensity = (rs.m_AmbientIntensity as number | undefined) ?? 1;
  const skyLin = colorToLinear(sky);
  const sh = input.ambientProbe ? packAmbientSH(input.ambientProbe) : flatAmbientSH({ r: skyLin.r * intensity, g: skyLin.g * intensity, b: skyLin.b * intensity });
  Object.assign(out, sh);
  const amb = (c: ColorRGBA | undefined): number[] => {
    const l = colorToLinear(c ?? { r: 0, g: 0, b: 0, a: 1 });
    return [l.r, l.g, l.b, 1];
  };
  out.unity_AmbientSky = amb(rs.m_AmbientSkyColor as ColorRGBA | undefined);
  out.unity_AmbientEquator = amb(rs.m_AmbientEquatorColor as ColorRGBA | undefined);
  out.unity_AmbientGround = amb(rs.m_AmbientGroundColor as ColorRGBA | undefined);
  out.glstate_lightmodel_ambient = out.unity_AmbientSky;
  const fogColor = colorToLinear((rs.m_FogColor as ColorRGBA | undefined) ?? { r: 0, g: 0, b: 0, a: 1 });
  out.unity_FogColor = [fogColor.r, fogColor.g, fogColor.b, fogColor.a];
  const density = (rs.m_FogDensity as number | undefined) ?? 0;
  const start = (rs.m_LinearFogStart as number | undefined) ?? 0;
  const end = (rs.m_LinearFogEnd as number | undefined) ?? 300;
  const span = end - start || 1;
  out.unity_FogParams = [density / Math.sqrt(Math.LN2), density / Math.LN2, -1 / span, end / span];
  // 反射：沒有反射探針，unity_SpecCube0 是 RenderSettings 的反射來源（sceneRenderer.reflectionCube）。HDR 解碼值 (1, 1, 0, 0) 是原樣取 rgb；
  // x 乘 m_ReflectionIntensity（Lighting window 的 Intensity Multiplier；Unity 是不是摺進這個值未查證，MT2 都是 1）。
  // 光照探針群組、陰影都沒做：給「沒有」的值（探針群組 x＝0 是關、遮蔽全 1、陰影強度 0）
  out.unity_SpecCube0_HDR = [(rs.m_ReflectionIntensity as number | undefined) ?? 1, 1, 0, 0];
  out.unity_SpecCube1_HDR = [1, 1, 0, 0];
  out.unity_ProbeVolumeParams = [0, 0, 0, 0];
  out.unity_ProbesOcclusion = [1, 1, 1, 1];
  out.unity_OcclusionMaskSelector = [1, 0, 0, 0];
  out._LightShadowData = [1, 0, 0, 0];
}

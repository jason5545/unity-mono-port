// 3D 網格（MeshRenderer＋MeshFilter）與 URP Forward 的光源常數（10/13，3D 骰子與骰盤）。
//
// 這個專案只有 level2 的骰盤（Dice Box/DiceTray，Shader Graphs/PrincipleDiceTrayShader）與 DiceManager 生的骰子
//（D6／D8／D12／D20，Shader Graphs/DiceMaterial）是 3D 網格，兩個都是 URP Lit 的 Shader Graph（UniversalForward pass）。
// 攝影機（PlayerCamera）的 renderer 是 URP2D 資產的第 0 個（URP3D_Renderer，前向），所以 3D 光源有作用。
//
// 光源常數照原版 URP（Unity.RenderPipelines.Universal.Runtime.dll，反編譯在 reference/decompiled/）：
//   - 主光源：GetMainLightIndex（UniversalRenderPipeline.cs:1163-1198）：RenderSettings.sun（level2 是 null），否則強度最大的平行光。
//     _MainLightPosition ＝ (−forward, 0)、_MainLightColor ＝ finalColor（InitializeLightConstants_Common :1493-1534）。
//     沒有主光源時是預設值：位置 (0,0,1,0)、顏色 0（k_DefaultLightPosition／k_DefaultLightColor）。
//   - 附加光源（Dice Light 是聚光燈）：位置 (pos, 1)、finalColor、衰減 GetPunctualLightDistanceAttenuation（:1466-1474）
//     與 GetSpotAngleAttenuation（:1476-1485，innerSpotAngle 是 Light.m_InnerSpotAngle）、方向 GetSpotDirection（:1487-1491，−forward）。
//   - finalColor ＝ color.linear × intensity：lightsUseLinearIntensity ＝ 色彩空間是 Linear（:312，這個專案是 Linear）；
//     lightsUseColorTemperature 開著（:313），但兩個光源的 m_UseColorTemperature 都是 0。
//   - unity_LightData.y ＝ 這個物件受影響的附加光源數、unity_LightIndices 是它們的索引（原生程式碼依範圍與錐角挑，這裡用範圍判斷）。
//   - 環境光：RenderSettings 的 m_AmbientMode 3（Flat），SH 只有常數項 ＝ m_AmbientSkyColor 轉線性 × m_AmbientIntensity。
//   - 反射探針：沒有 skybox（m_SkyboxMaterial null）、沒有探針，unity_SpecCube0 給全黑的 cube。
// 與原版的差異：聚光燈的陰影（Dice Light 的 m_Shadows Soft，_ADDITIONAL_LIGHT_SHADOWS）沒做；固定用 _ADDITIONAL_LIGHTS 變體
//（附加光源數 0 時跟沒開這個 keyword 的結果相同）。
// 排序：three.js 照 renderOrder 畫、透明物件不開深度測試（sceneRenderer 檔頭）。這兩種網格開深度測試與寫入，排在一般圖層之後、
// Overlay Canvas 之前（MESH3D_LAYER）。原版是不透明佇列先畫、後面的透明物件被深度擋住；骰盤（z ≈ −91.4）比這時畫面上其他東西都靠近攝影機，
// 所以「最後畫、蓋在上面」跟原版的結果一樣。

import * as THREE from 'three';
import type { ComponentData } from '../unity/types';
import type { SceneNode } from '../unity/scene';
import { colorToLinear } from '../unity/color';
import type { MeshAssetRecord, MeshInstance } from '../unity/meshes';

/** mesh 的 channel 名稱 → K3 vertexInputs 的 D3D 語意 */
export const CHANNEL_SEMANTIC: Record<string, string> = {
  position: 'POSITION0',
  normal: 'NORMAL0',
  tangent: 'TANGENT0',
  color: 'COLOR0',
  uv0: 'TEXCOORD0',
  uv1: 'TEXCOORD1',
  uv2: 'TEXCOORD2',
  uv3: 'TEXCOORD3',
};

/** 網格資料（資產或 MeshFilter.mesh 的複本）→ 每個語意一個 BufferAttribute */
export function meshAttributes(src: MeshAssetRecord | MeshInstance): Record<string, THREE.BufferAttribute> {
  const out: Record<string, THREE.BufferAttribute> = {};
  for (const [name, ch] of Object.entries(src.channels)) {
    const sem = CHANNEL_SEMANTIC[name];
    if (!sem) continue;
    out[sem] = new THREE.BufferAttribute(Float32Array.from(ch.values as ArrayLike<number>), ch.dimension);
  }
  return out;
}

export interface LightEntry {
  node: SceneNode;
  comp: ComponentData;
}

const DEFAULT_LIGHT_POSITION = [0, 0, 1, 0];

function forwardOf(node: SceneNode): THREE.Vector3 {
  const q = new THREE.Quaternion();
  node.world.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
}

/** VisibleLight.finalColor（線性色 × 強度） */
function finalColor(comp: ComponentData): number[] {
  const c = colorToLinear(comp.m_Color as { r: number; g: number; b: number; a: number });
  const i = (comp.m_Intensity as number) ?? 1;
  return [c.r * i, c.g * i, c.b * i, 1];
}

/** URP 前向的光源全域常數（每格依場景裡啟用中的 Light 算；所有 3D 網格共用同一份） */
export function forwardLightGlobals(lights: LightEntry[], ambient: { color: { r: number; g: number; b: number }; intensity: number }, out: Record<string, number[]>): void {
  const live = lights.filter((l) => l.node.activeInHierarchy && l.comp.m_Enabled !== 0);
  let main: LightEntry | null = null;
  for (const l of live) {
    if (l.comp.m_Type !== 1) continue;
    if (!main || (l.comp.m_Intensity as number) > (main.comp.m_Intensity as number)) main = l;
  }
  if (main) {
    const f = forwardOf(main.node);
    out._MainLightPosition = [-f.x, -f.y, -f.z, 0];
    out._MainLightColor = finalColor(main.comp);
  } else {
    out._MainLightPosition = [...DEFAULT_LIGHT_POSITION];
    out._MainLightColor = [0, 0, 0, 0];
  }
  const adds = live.filter((l) => l !== main && (l.comp.m_Type === 0 || l.comp.m_Type === 2));
  // 陣列只填第一個元素（sceneRenderer 的 fillBlock 依名稱填一個向量）：場景裡只有一個附加光源
  const a = adds[0];
  out._AdditionalLightsCount = [adds.length, 0, 0, 0];
  if (a) {
    const p = new THREE.Vector3().setFromMatrixPosition(a.node.world);
    out._AdditionalLightsPosition = [p.x, p.y, p.z, 1];
    out._AdditionalLightsColor = finalColor(a.comp);
    const range = (a.comp.m_Range as number) ?? 10;
    const rr = range * range;
    const fade = 0.64000005 * rr - rr;
    const att = [1 / Math.max(0.0001, rr), -rr / fade, 0, 1];
    let dir = [0, 0, 1, 0];
    if (a.comp.m_Type === 0) {
      const spot = (a.comp.m_SpotAngle as number) ?? 30;
      const inner = (a.comp.m_InnerSpotAngle as number) ?? 21.80208;
      const cosOuter = Math.cos(((Math.PI / 180) * spot) / 2);
      const cosInner = Math.cos(((Math.PI / 180) * inner) / 2);
      const inv = 1 / Math.max(0.001, cosInner - cosOuter);
      att[2] = inv;
      att[3] = -cosOuter * inv;
      const f = forwardOf(a.node);
      dir = [-f.x, -f.y, -f.z, 0];
    }
    out._AdditionalLightsAttenuation = att;
    out._AdditionalLightsSpotDir = dir;
  } else {
    out._AdditionalLightsPosition = [0, 0, 1, 0];
    out._AdditionalLightsColor = [0, 0, 0, 0];
    out._AdditionalLightsAttenuation = [0, 1, 0, 1];
    out._AdditionalLightsSpotDir = [0, 0, 1, 0];
  }
  out.unity_LightIndices = [0, 1, 2, 3];
  out.unity_LightData = [0, Math.min(adds.length, 4), 1, 0];
  // 平面環境光：SH 只有常數項
  const amb = colorToLinear({ ...ambient.color, a: 1 });
  out.unity_SHAr = [0, 0, 0, amb.r * ambient.intensity];
  out.unity_SHAg = [0, 0, 0, amb.g * ambient.intensity];
  out.unity_SHAb = [0, 0, 0, amb.b * ambient.intensity];
  out.unity_SHBr = [0, 0, 0, 0];
  out.unity_SHBg = [0, 0, 0, 0];
  out.unity_SHBb = [0, 0, 0, 0];
  out.unity_SHC = [0, 0, 0, 0];
  out.unity_SpecCube0_HDR = [1, 1, 0, 0];
}

let blackCube: THREE.CubeTexture | null = null;
/** 沒有 skybox 與反射探針時的 unity_SpecCube0（全黑） */
export function blackCubeTexture(): THREE.CubeTexture {
  if (!blackCube) {
    const faces = Array.from({ length: 6 }, () => {
      const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
      t.needsUpdate = true;
      return t;
    });
    blackCube = new THREE.CubeTexture(faces as unknown as HTMLImageElement[]);
    blackCube.format = THREE.RGBAFormat;
    blackCube.generateMipmaps = false;
    blackCube.minFilter = THREE.LinearFilter;
    blackCube.magFilter = THREE.LinearFilter;
    blackCube.needsUpdate = true;
  }
  return blackCube;
}

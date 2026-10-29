// URP 2D 光照（URP 14，GitHub Unity-Technologies/Graphics 2022.3/staging 分支，10/5 讀；遊戲是 2022.3.3，確切的 URP 小版號未查證）。
//
// 流程（RendererLighting.cs）：每個 sorting layer、每個用到的混合樣式各一張光照貼圖（大小 = 畫面 × lightRenderTextureScale），
// 先清成該層的全域光顏色（沒有就黑），再用 Light2D-Point 等 shader 把光畫上去。受光的 sprite（Sprite-Lit-Default）
// 依所在 layer 打開 USE_SHAPE_LIGHT_TYPE_<樣式> keyword，取樣光照貼圖合成（CombinedShapeLightShared.hlsl）。
//
// 這裡只做這個遊戲用到的：點光源（m_LightType 3）、相加或 alpha 重疊、沒有 cookie、沒有法線貼圖、沒有陰影。

import * as THREE from 'three';

export const LIGHT_TYPE_POINT = 3;
export const LIGHT_TYPE_GLOBAL = 4;

/** Light2D 元件會用到的欄位 */
export interface Light2DData {
  m_LightType: number;
  m_BlendStyleIndex: number;
  m_Color: { r: number; g: number; b: number; a: number };
  m_Intensity: number;
  m_FalloffIntensity: number;
  m_ApplyToSortingLayers: string | number[]; // 0b 保留原始十六進位（int32 陣列）
  m_OverlapOperation: number; // 0 Additive、1 AlphaBlend
  m_PointLightInnerRadius: number;
  m_PointLightOuterRadius: number;
  m_PointLightInnerAngle: number;
  m_PointLightOuterAngle: number;
  m_NormalMapQuality: number; // 2 Disabled
  m_LightCookieSprite: unknown;
}

/** Renderer2DData 的混合樣式（Light2DBlendStyle.blendFactors：Additive (0,1)、Multiply (1,0)、Subtractive (0,−1)） */
export interface BlendStyle {
  name: string;
  maskTextureChannel: number;
  blendMode: number; // 0 Additive、1 Multiply、2 Subtractive
}

export function blendFactors(style: BlendStyle): [number, number] {
  if (style.blendMode === 0) return [0, 1];
  if (style.blendMode === 2) return [0, -1];
  return [1, 0];
}

/** m_ApplyToSortingLayers：sorting layer 的 uniqueID 陣列（int32 little-endian 十六進位，或已解開的陣列） */
export function applyToSortingLayers(v: string | number[]): number[] {
  if (Array.isArray(v)) return v.map((x) => x >>> 0);
  const out: number[] = [];
  for (let i = 0; i + 8 <= v.length; i += 8) {
    const b = v.slice(i, i + 8).match(/../g)!.map((h) => parseInt(h, 16));
    out.push((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
  }
  return out;
}

/** Light2DLookupTexture.CreatePointLightLookupTexture：256×256，r = 距離衰減、g = 角度、b／a = 指向中心的方向。
 *  原版在支援時用 R16G16B16A16_SFloat（PC 上是），這裡同樣用半精度。SetPixel(x, y) 的 y = 0 在下，跟 GL 的列順序一樣。 */
export function lightLookupData(): Float32Array {
  const W = 256;
  const H = 256;
  const data = new Float32Array(W * H * 4);
  const cx = W / 2;
  const cy = H / 2;
  const normalize = (x: number, y: number): [number, number] => {
    const m = Math.hypot(x, y);
    return m > 1e-5 ? [x / m, y / m] : [0, 0]; // Vector2.Normalize：太小就是 0
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const distance = Math.hypot(x - cx, y - cy);
      const [dx, dy] = normalize(cx - x, cy - y);
      const red = x === W - 1 || y === H - 1 ? 0 : Math.min(1, Math.max(0, 1 - (2 * distance) / W));
      const [rx, ry] = normalize(x - cx, y - cy);
      const cosAngle = 0 * rx + -1 * ry; // Vector2.Dot(Vector2.down, relPos.normalized)
      const angle = Math.acos(Math.min(1, Math.max(-1, cosAngle))) / Math.PI;
      const green = Math.min(1, Math.max(0, 1 - angle));
      data.set([red, green, dx, dy], (y * W + x) * 4);
    }
  }
  return data;
}

export function lightLookupTexture(): THREE.DataTexture {
  const f = lightLookupData();
  const half = new Uint16Array(f.length);
  for (let i = 0; i < f.length; i++) half[i] = THREE.DataUtils.toHalfFloat(f[i]);
  const tex = new THREE.DataTexture(half, 256, 256, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** LightUtility.GenerateParametricMesh(light, 1.412135, 0, 0, 4)：點光源的網格。falloffDistance 0，外圈與內圈重合，
 *  所以就是 4 個角在半徑 1.412135、從 45° 起算的正方形（約 ±0.9985），中心一個點。三角形照原始碼排 */
export function pointLightMesh(): { positions: number[]; indices: number[] } {
  const radius = 1.412135;
  const sides = 4;
  const angleOffset = Math.PI / 4;
  const center = 2 * sides;
  const positions = new Array((1 + 2 * sides) * 3).fill(0);
  const indices: number[] = [];
  const perSide = (2 * Math.PI) / sides;
  for (let i = 0; i < sides; i++) {
    const end = (i + 1) * perSide;
    const px = radius * Math.cos(end + angleOffset);
    const py = radius * Math.sin(end + angleOffset);
    const vi = (2 * i + 2) % (2 * sides);
    positions.splice(vi * 3, 3, px, py, 0);
    positions.splice((vi + 1) * 3, 3, px, py, 0);
    indices.push(vi + 1, 2 * i + 1, center, vi, 2 * i, 2 * i + 1, vi + 1, vi, 2 * i + 1);
  }
  return { positions, indices };
}

// 色彩空間換算。原版是 linear 色彩空間（ProjectSettings 的 m_ActiveColorSpace: 1）：
// 序列化的顏色（Graphic.m_Color、SpriteRenderer.m_Color、材質的 Color 屬性）是 gamma 值，送進 shader 前要轉成線性。
// UI 頂點色同樣要轉（Canvas 的 m_VertexColorAlwaysGammaSpace: 0）。
// 公式是 IEC 61966-2-1 的 sRGB 曲線（Unity 的 Mathf.GammaToLinearSpace 在 0–1 用同一條，未逐字查證引擎原始碼）。

import type { ColorRGBA } from './types';

export function gammaToLinear(c: number): number {
  if (c <= 0.04045) return c / 12.92;
  return Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToGamma(c: number): number {
  if (c <= 0.0031308) return c * 12.92;
  return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** RGB 轉線性，alpha 不變 */
export function colorToLinear(c: ColorRGBA): ColorRGBA {
  return { r: gammaToLinear(c.r), g: gammaToLinear(c.g), b: gammaToLinear(c.b), a: c.a };
}

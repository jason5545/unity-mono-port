// TMP_ShaderUtilities.cs（GetPadding 385、UpdateShaderRatios 277、IsMaskingEnabled 372）與
// TMP_MaterialManager.cs（GetFallbackMaterial 343/397、CopyMaterialPresetProperties 601）的純函式移植。

import type { ExternalRef } from '../unity/types';
import { f32 } from './utils';
import { MaterialView } from './assets';

const ID_MainTex = '_MainTex';
const ID_FaceDilate = '_FaceDilate';
const ID_OutlineSoftness = '_OutlineSoftness';
const ID_OutlineWidth = '_OutlineWidth';
const ID_GlowOffset = '_GlowOffset';
const ID_GlowOuter = '_GlowOuter';
const ID_UnderlaySoftness = '_UnderlaySoftness';
const ID_UnderlayOffset = '_UnderlayOffset';
const ID_UnderlayOffsetX = '_UnderlayOffsetX';
const ID_UnderlayOffsetY = '_UnderlayOffsetY';
const ID_UnderlayDilate = '_UnderlayDilate';
const ID_GradientScale = '_GradientScale';
const ID_WeightNormal = '_WeightNormal';
const ID_WeightBold = '_WeightBold';
const ID_ScaleRatio_A = '_ScaleRatioA';
const ID_ScaleRatio_B = '_ScaleRatioB';
const ID_ScaleRatio_C = '_ScaleRatioC';
const ID_Padding = '_Padding';
const ID_IsoPerimeter = '_IsoPerimeter';
const ID_Softness = '_Softness';
const ID_OutlineOffset1 = '_OutlineOffset1';
const ID_OutlineOffset2 = '_OutlineOffset2';
const ID_OutlineOffset3 = '_OutlineOffset3';
const ID_OutlineMode = '_OutlineMode';
const ID_TextureWidth = '_TextureWidth';
const ID_TextureHeight = '_TextureHeight';
const ID_ClipRect = '_ClipRect';

const Keyword_Glow = 'GLOW_ON';
const Keyword_Underlay = 'UNDERLAY_ON';
const Keyword_Ratios = 'RATIOS_OFF';
const Keyword_MASK_SOFT = 'MASK_SOFT';
const Keyword_MASK_HARD = 'MASK_HARD';
const Keyword_MASK_TEX = 'MASK_TEX';

const m_clamp = 1.0;

/** TMP_ShaderUtilities.UpdateShaderRatios（TMP_ShaderUtilities.cs:277）：直接改 material 的 _ScaleRatioA/B/C */
export function updateShaderRatios(mat: MaterialView): void {
  let ratio_A = 1;
  let ratio_B = 1;
  let ratio_C = 1;

  const isRatioEnabled = !mat.shaderKeywords.includes(Keyword_Ratios);

  if (!mat.hasProperty(ID_GradientScale) || !mat.hasProperty(ID_FaceDilate)) return;

  // Compute Ratio A
  const scale = mat.getFloat(ID_GradientScale);
  const faceDilate = mat.getFloat(ID_FaceDilate);
  const outlineThickness = mat.getFloat(ID_OutlineWidth);
  const outlineSoftness = mat.getFloat(ID_OutlineSoftness);

  const weight = Math.max(mat.getFloat(ID_WeightNormal), mat.getFloat(ID_WeightBold)) / 4.0;

  let t = Math.max(1, f32(weight + faceDilate + outlineThickness + outlineSoftness));

  ratio_A = isRatioEnabled ? f32(f32(scale - m_clamp) / f32(scale * t)) : 1;

  mat.setFloat(ID_ScaleRatio_A, ratio_A);

  // Compute Ratio B
  if (mat.hasProperty(ID_GlowOffset)) {
    const glowOffset = mat.getFloat(ID_GlowOffset);
    const glowOuter = mat.getFloat(ID_GlowOuter);

    const range = f32(f32(weight + faceDilate) * f32(scale - m_clamp));

    t = Math.max(1, f32(glowOffset + glowOuter));

    ratio_B = isRatioEnabled ? Math.max(0, f32(f32(f32(scale - m_clamp) - range) / f32(scale * t))) : 1;

    mat.setFloat(ID_ScaleRatio_B, ratio_B);
  }

  // Compute Ratio C
  if (mat.hasProperty(ID_UnderlayOffsetX)) {
    const underlayOffsetX = mat.getFloat(ID_UnderlayOffsetX);
    const underlayOffsetY = mat.getFloat(ID_UnderlayOffsetY);
    const underlayDilate = mat.getFloat(ID_UnderlayDilate);
    const underlaySoftness = mat.getFloat(ID_UnderlaySoftness);

    const range = f32(f32(weight + faceDilate) * f32(scale - m_clamp));

    t = Math.max(1, f32(f32(Math.max(Math.abs(underlayOffsetX), Math.abs(underlayOffsetY)) + underlayDilate) + underlaySoftness));

    ratio_C = isRatioEnabled ? Math.max(0, f32(f32(f32(scale - m_clamp) - range) / f32(scale * t))) : 1;

    mat.setFloat(ID_ScaleRatio_C, ratio_C);
  }
}

/** ComputePaddingForProperties（TMP_ShaderUtilities.cs:530）：新版 SRP shader（有 _IsoPerimeter）用 */
function computePaddingForProperties(mat: MaterialView): number {
  const dilation = mat.getVector(ID_IsoPerimeter);
  const outlineOffset1 = mat.getVector(ID_OutlineOffset1);
  const outlineOffset2 = mat.getVector(ID_OutlineOffset2);
  const outlineOffset3 = mat.getVector(ID_OutlineOffset3);
  const isOutlineModeEnabled = mat.getFloat(ID_OutlineMode) !== 0;

  const softness = mat.getVector(ID_Softness);
  const gradientScale = mat.getFloat(ID_GradientScale);

  // Face
  let padding = Math.max(0, f32(dilation.x + softness.x * 0.5));

  // Outlines
  if (!isOutlineModeEnabled) {
    padding = Math.max(padding, f32(f32(f32(dilation.y + softness.y * 0.5) + Math.max(Math.abs(outlineOffset1.x), Math.abs(outlineOffset1.y)))));
    padding = Math.max(padding, f32(f32(f32(dilation.z + softness.z * 0.5) + Math.max(Math.abs(outlineOffset2.x), Math.abs(outlineOffset2.y)))));
    padding = Math.max(padding, f32(f32(f32(dilation.w + softness.w * 0.5) + Math.max(Math.abs(outlineOffset3.x), Math.abs(outlineOffset3.y)))));
  } else {
    const offsetOutline1 = Math.max(Math.abs(outlineOffset1.x), Math.abs(outlineOffset1.y));
    const offsetOutline2 = Math.max(Math.abs(outlineOffset2.x), Math.abs(outlineOffset2.y));

    padding = Math.max(padding, f32(f32(dilation.y + softness.y * 0.5) + offsetOutline1));
    padding = Math.max(padding, f32(f32(dilation.z + softness.z * 0.5) + offsetOutline2));

    const maxOffset = Math.max(offsetOutline1, offsetOutline2);
    padding = f32(padding + Math.max(0, f32(f32(dilation.w + softness.w * 0.5) - Math.max(0, f32(padding - maxOffset)))));
  }

  // Underlay
  const underlayOffset = mat.getVector(ID_UnderlayOffset);
  const underlayDilation = mat.getFloat(ID_UnderlayDilate);
  const underlaySoftness = mat.getFloat(ID_UnderlaySoftness);
  padding = Math.max(padding, f32(f32(underlayDilation + underlaySoftness * 0.5) + Math.max(Math.abs(underlayOffset.x), Math.abs(underlayOffset.y))));

  return f32(padding * gradientScale);
}

/** TMP_ShaderUtilities.GetPadding（TMP_ShaderUtilities.cs:385） */
export function getPadding(material: MaterialView | null, enableExtraPadding: boolean, _isBold: boolean): number {
  // Return if Material is null
  if (material == null) return 0;

  let extraPadding = enableExtraPadding ? 4 : 0;

  // Check if we are using a non Distance Field Shader
  if (!material.hasProperty(ID_GradientScale)) {
    if (material.hasProperty(ID_Padding)) extraPadding += Math.trunc(material.getFloat(ID_Padding));

    return f32(extraPadding + 1.0);
  }

  // Special handling for new SRP Shaders
  if (material.hasProperty(ID_IsoPerimeter)) {
    return f32(computePaddingForProperties(material) + 0.25 + extraPadding);
  }

  const padding = { x: 0, y: 0, z: 0, w: 0 };
  const maxPadding = { x: 0, y: 0, z: 0, w: 0 };

  let faceDilate = 0;
  let faceSoftness = 0;
  let outlineThickness = 0;
  let scaleRatio_A = 0;
  let scaleRatio_B = 0;
  let scaleRatio_C = 0;

  let glowOffset = 0;
  let glowOuter = 0;

  let gradientScale = 0;
  let uniformPadding = 0;

  // Update Shader Ratios prior to computing padding
  updateShaderRatios(material);

  const shaderKeywords = material.shaderKeywords;

  if (material.hasProperty(ID_ScaleRatio_A)) scaleRatio_A = material.getFloat(ID_ScaleRatio_A);

  if (material.hasProperty(ID_FaceDilate)) faceDilate = f32(material.getFloat(ID_FaceDilate) * scaleRatio_A);

  if (material.hasProperty(ID_OutlineSoftness)) faceSoftness = f32(material.getFloat(ID_OutlineSoftness) * scaleRatio_A);

  if (material.hasProperty(ID_OutlineWidth)) outlineThickness = f32(material.getFloat(ID_OutlineWidth) * scaleRatio_A);

  uniformPadding = f32(outlineThickness + faceSoftness + faceDilate);

  // Glow padding contribution
  if (material.hasProperty(ID_GlowOffset) && shaderKeywords.includes(Keyword_Glow)) {
    if (material.hasProperty(ID_ScaleRatio_B)) scaleRatio_B = material.getFloat(ID_ScaleRatio_B);

    glowOffset = f32(material.getFloat(ID_GlowOffset) * scaleRatio_B);
    glowOuter = f32(material.getFloat(ID_GlowOuter) * scaleRatio_B);
  }

  uniformPadding = Math.max(uniformPadding, f32(f32(faceDilate + glowOffset) + glowOuter));

  // Underlay padding contribution
  if (material.hasProperty(ID_UnderlaySoftness) && shaderKeywords.includes(Keyword_Underlay)) {
    if (material.hasProperty(ID_ScaleRatio_C)) scaleRatio_C = material.getFloat(ID_ScaleRatio_C);

    let offsetX = 0;
    let offsetY = 0;
    let dilate = 0;
    let softness = 0;

    if (material.hasProperty(ID_UnderlayOffset)) {
      const underlayOffset = material.getVector(ID_UnderlayOffset);
      offsetX = underlayOffset.x;
      offsetY = underlayOffset.y;

      dilate = material.getFloat(ID_UnderlayDilate);
      softness = material.getFloat(ID_UnderlaySoftness);
    } else if (material.hasProperty(ID_UnderlayOffsetX)) {
      offsetX = f32(material.getFloat(ID_UnderlayOffsetX) * scaleRatio_C);
      offsetY = f32(material.getFloat(ID_UnderlayOffsetY) * scaleRatio_C);
      dilate = f32(material.getFloat(ID_UnderlayDilate) * scaleRatio_C);
      softness = f32(material.getFloat(ID_UnderlaySoftness) * scaleRatio_C);
    }

    padding.x = Math.max(padding.x, f32(f32(f32(faceDilate + dilate) + softness) - offsetX));
    padding.y = Math.max(padding.y, f32(f32(f32(faceDilate + dilate) + softness) - offsetY));
    padding.z = Math.max(padding.z, f32(f32(f32(faceDilate + dilate) + softness) + offsetX));
    padding.w = Math.max(padding.w, f32(f32(f32(faceDilate + dilate) + softness) + offsetY));
  }

  padding.x = Math.max(padding.x, uniformPadding);
  padding.y = Math.max(padding.y, uniformPadding);
  padding.z = Math.max(padding.z, uniformPadding);
  padding.w = Math.max(padding.w, uniformPadding);

  padding.x = f32(padding.x + extraPadding);
  padding.y = f32(padding.y + extraPadding);
  padding.z = f32(padding.z + extraPadding);
  padding.w = f32(padding.w + extraPadding);

  padding.x = Math.min(padding.x, 1);
  padding.y = Math.min(padding.y, 1);
  padding.z = Math.min(padding.z, 1);
  padding.w = Math.min(padding.w, 1);

  maxPadding.x = maxPadding.x < padding.x ? padding.x : maxPadding.x;
  maxPadding.y = maxPadding.y < padding.y ? padding.y : maxPadding.y;
  maxPadding.z = maxPadding.z < padding.z ? padding.z : maxPadding.z;
  maxPadding.w = maxPadding.w < padding.w ? padding.w : maxPadding.w;

  gradientScale = material.getFloat(ID_GradientScale);
  padding.x = f32(padding.x * gradientScale);
  padding.y = f32(padding.y * gradientScale);
  padding.z = f32(padding.z * gradientScale);
  padding.w = f32(padding.w * gradientScale);

  // Set UniformPadding to the maximum value of any of its components.
  uniformPadding = Math.max(padding.x, padding.y);
  uniformPadding = Math.max(padding.z, uniformPadding);
  uniformPadding = Math.max(padding.w, uniformPadding);

  return f32(uniformPadding + 1.25);
}

/** TMP_ShaderUtilities.IsMaskingEnabled（TMP_ShaderUtilities.cs:372） */
export function isMaskingEnabled(material: MaterialView | null): boolean {
  if (material == null || !material.hasProperty(ID_ClipRect)) return false;

  if (material.shaderKeywords.includes(Keyword_MASK_SOFT) || material.shaderKeywords.includes(Keyword_MASK_HARD) || material.shaderKeywords.includes(Keyword_MASK_TEX)) return true;

  return false;
}

// ───────── TMP_MaterialManager ─────────

/** TMP_MaterialManager.CopyMaterialPresetProperties（TMP_MaterialManager.cs:601） */
export function copyMaterialPresetProperties(source: MaterialView, destination: MaterialView): void {
  if (!source.hasProperty(ID_GradientScale) || !destination.hasProperty(ID_GradientScale)) return;

  // Save unique material properties
  const dst_texture = destination.getTexture(ID_MainTex);
  const dst_gradientScale = destination.getFloat(ID_GradientScale);
  const dst_texWidth = destination.getFloat(ID_TextureWidth);
  const dst_texHeight = destination.getFloat(ID_TextureHeight);
  const dst_weightNormal = destination.getFloat(ID_WeightNormal);
  const dst_weightBold = destination.getFloat(ID_WeightBold);

  // Make sure the same shader is used + Copy all material properties + keywords
  destination.shaderRef = source.shaderRef;
  destination.floats = { ...source.floats };
  destination.colors = { ...source.colors };
  destination.textures = { ...source.textures };
  destination.keywords = [...source.keywords];

  // Restore unique material properties
  destination.setTexture(ID_MainTex, dst_texture);
  destination.setFloat(ID_GradientScale, dst_gradientScale);
  destination.setFloat(ID_TextureWidth, dst_texWidth);
  destination.setFloat(ID_TextureHeight, dst_texHeight);
  destination.setFloat(ID_WeightNormal, dst_weightNormal);
  destination.setFloat(ID_WeightBold, dst_weightBold);
}

/** fallback material 的快取（m_fallbackMaterials）：key = sourceMaterialID << 32 | texID（材質實例在排版期間不變，不需要 CRC 重檢） */
const fallbackMaterials = new Map<string, MaterialView>();

/**
 * TMP_MaterialManager.GetFallbackMaterial(Material sourceMaterial, Material targetMaterial)（TMP_MaterialManager.cs:397）。
 * targetMaterial 是 fallback 字型自己的材質（提供 atlas 貼圖與 GradientScale 等字型固有屬性）。
 */
export function getFallbackMaterial(sourceMaterial: MaterialView, targetMaterial: MaterialView): MaterialView {
  const tex = targetMaterial.getTexture(ID_MainTex);
  const key = `${sourceMaterial.instanceId}|${tex?.guid ?? 'null'}`;

  const cached = fallbackMaterials.get(key);
  if (cached) return cached;

  // Create new material from the source material and copy properties if using distance field shaders.
  let fallbackMaterial: MaterialView;
  if (sourceMaterial.hasProperty(ID_GradientScale) && targetMaterial.hasProperty(ID_GradientScale)) {
    fallbackMaterial = sourceMaterial.clone();
    fallbackMaterial.setTexture(ID_MainTex, tex);
    // Retain material properties unique to target material.
    fallbackMaterial.setFloat(ID_GradientScale, targetMaterial.getFloat(ID_GradientScale));
    fallbackMaterial.setFloat(ID_TextureWidth, targetMaterial.getFloat(ID_TextureWidth));
    fallbackMaterial.setFloat(ID_TextureHeight, targetMaterial.getFloat(ID_TextureHeight));
    fallbackMaterial.setFloat(ID_WeightNormal, targetMaterial.getFloat(ID_WeightNormal));
    fallbackMaterial.setFloat(ID_WeightBold, targetMaterial.getFloat(ID_WeightBold));
  } else {
    fallbackMaterial = targetMaterial.clone();
    fallbackMaterial.setTexture(ID_MainTex, tex);
  }

  fallbackMaterials.set(key, fallbackMaterial);

  return fallbackMaterial;
}

/**
 * GetFallbackMaterial(TMP_FontAsset fontAsset, Material sourceMaterial, int atlasIndex)（TMP_MaterialManager.cs:343）：
 * 多 atlas 貼圖。atlas 貼圖清單不在 TextAssets 介面裡（m_AtlasTextures 只有參照），呼叫端要傳解析過的貼圖 ref。
 */
export function getFallbackMaterialForAtlas(sourceMaterial: MaterialView, atlasTexture: ExternalRef | null): MaterialView {
  const key = `${sourceMaterial.instanceId}|${atlasTexture?.guid ?? 'null'}`;
  const cached = fallbackMaterials.get(key);
  if (cached) return cached;

  const fallbackMaterial = sourceMaterial.clone();
  fallbackMaterial.setTexture(ID_MainTex, atlasTexture);

  fallbackMaterials.set(key, fallbackMaterial);
  return fallbackMaterial;
}

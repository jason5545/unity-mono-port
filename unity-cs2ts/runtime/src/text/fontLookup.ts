// TMP_FontAssetUtilities.cs（GetCharacterFromFontAsset 47、GetCharacterFromFontAssets 224、GetTextElementFromTextAssets 260、
// GetSpriteCharacterFromSpriteAsset 316）、TMP_SpriteAsset.cs 的 SearchForSpriteByHashCode（354）、
// MaterialReferenceManager.cs 的 TryGetFontAsset／TryGetMaterial／TryGetSpriteAsset／TryGetColorGradientPreset（用資產名稱 hash 的 registry 近似）。

import type { TextAssets } from './types';
import { FontStyles, FontWeight } from './enums';
import { AtlasPopulationMode, FontAssetData, SpriteAssetData, type TextElementData } from './assets';
import { getHashCode } from './utils';

// ───────── MaterialReferenceManager 的 registry（字型的 Awake 註冊用「第一次解析時註冊」近似） ─────────

interface Registry {
  fonts: Map<number, FontAssetData>;
  spriteAssets: Map<number, SpriteAssetData>;
}
const registries = new WeakMap<TextAssets, Registry>();

function registryOf(assets: TextAssets): Registry {
  let r = registries.get(assets);
  if (!r) registries.set(assets, (r = { fonts: new Map(), spriteAssets: new Map() }));
  return r;
}

/** 註冊（MaterialReferenceManager.AddFontAsset）：以名稱的 GetHashCode 為 key */
export function registerFontAsset(assets: TextAssets, font: FontAssetData): void {
  const r = registryOf(assets);
  const h = getHashCode(font.name);
  if (!r.fonts.has(h)) r.fonts.set(h, font);
}

/** MaterialReferenceManager.TryGetFontAsset */
export function tryGetFontAsset(assets: TextAssets, hashCode: number): FontAssetData | null {
  return registryOf(assets).fonts.get(hashCode) ?? null;
}

// ───────── TMP_FontAssetUtilities ─────────

const k_SearchedAssets = new Set<string>();

/**
 * GetCharacterFromFontAsset（TMP_FontAssetUtilities.cs:47）。
 * 找字順序：weight/style 的替代 typeface → 來源字型（動態則 TryAddCharacterInternal）→ fallback 鏈（遞迴）。
 */
export function getCharacterFromFontAsset(
  unicode: number,
  sourceFontAsset: FontAssetData,
  includeFallbacks: boolean,
  fontStyle: FontStyles,
  fontWeight: FontWeight,
): { character: TextElementData | null; isAlternativeTypeface: boolean } {
  if (includeFallbacks) k_SearchedAssets.clear();

  return getCharacterFromFontAssetInternal(unicode, sourceFontAsset, includeFallbacks, fontStyle, fontWeight);
}

function getCharacterFromFontAssetInternal(
  unicode: number,
  sourceFontAsset: FontAssetData,
  includeFallbacks: boolean,
  fontStyle: FontStyles,
  fontWeight: FontWeight,
): { character: TextElementData | null; isAlternativeTypeface: boolean } {
  let isAlternativeTypeface = false;
  let character: TextElementData | null = null;

  // #region FONT WEIGHT AND FONT STYLE HANDLING（TMP_FontAssetUtilities.cs:70）
  const isItalic = (fontStyle & FontStyles.Italic) === FontStyles.Italic;

  if (isItalic || fontWeight !== FontWeight.Regular) {
    let fontWeightIndex = 4;
    switch (fontWeight) {
      case FontWeight.Thin: fontWeightIndex = 1; break;
      case FontWeight.ExtraLight: fontWeightIndex = 2; break;
      case FontWeight.Light: fontWeightIndex = 3; break;
      case FontWeight.Regular: fontWeightIndex = 4; break;
      case FontWeight.Medium: fontWeightIndex = 5; break;
      case FontWeight.SemiBold: fontWeightIndex = 6; break;
      case FontWeight.Bold: fontWeightIndex = 7; break;
      case FontWeight.Heavy: fontWeightIndex = 8; break;
      case FontWeight.Black: fontWeightIndex = 9; break;
    }

    const temp = isItalic ? sourceFontAsset.fontWeightAt(fontWeightIndex).italicTypeface : sourceFontAsset.fontWeightAt(fontWeightIndex).regularTypeface;

    if (temp != null) {
      const hit = temp.characterLookupTable.get(unicode);
      if (hit !== undefined) {
        if (hit.textAsset != null) {
          isAlternativeTypeface = true;
          return { character: hit, isAlternativeTypeface };
        }
        temp.characterLookupTable.delete(unicode);
      }

      if (temp.atlasPopulationMode === AtlasPopulationMode.Dynamic || temp.atlasPopulationMode === AtlasPopulationMode.DynamicOS) {
        character = temp.tryAddCharacterInternal(unicode);
        if (character) {
          isAlternativeTypeface = true;
          return { character, isAlternativeTypeface };
        }
      }
    }
  }
  // #endregion

  // Search the source font asset for the requested character.
  const direct = sourceFontAsset.characterLookupTable.get(unicode);
  if (direct !== undefined) {
    if (direct.textAsset != null) return { character: direct, isAlternativeTypeface };
    sourceFontAsset.characterLookupTable.delete(unicode);
  }

  if (sourceFontAsset.atlasPopulationMode === AtlasPopulationMode.Dynamic || sourceFontAsset.atlasPopulationMode === AtlasPopulationMode.DynamicOS) {
    character = sourceFontAsset.tryAddCharacterInternal(unicode);
    if (character) return { character, isAlternativeTypeface };
  }

  // Search fallback font assets
  if (character == null && includeFallbacks && sourceFontAsset.fallbackFontAssetTable != null) {
    const fallbackFontAssets = sourceFontAsset.fallbackFontAssetTable;
    const fallbackCount = fallbackFontAssets.length;

    if (fallbackCount === 0) return { character: null, isAlternativeTypeface };

    for (let i = 0; i < fallbackCount; i++) {
      const temp = fallbackFontAssets[i];
      if (temp == null) continue;

      const id = temp.id;
      if (k_SearchedAssets.has(id)) continue;
      k_SearchedAssets.add(id);

      const result = getCharacterFromFontAssetInternal(unicode, temp, true, fontStyle, fontWeight);
      if (result.character != null) return result;
      isAlternativeTypeface = result.isAlternativeTypeface;
    }
  }

  return { character: null, isAlternativeTypeface };
}

/** GetCharacterFromFontAssets（TMP_FontAssetUtilities.cs:224） */
export function getCharacterFromFontAssets(
  unicode: number,
  _sourceFontAsset: FontAssetData,
  fontAssets: (FontAssetData | null)[] | null,
  includeFallbacks: boolean,
  fontStyle: FontStyles,
  fontWeight: FontWeight,
): { character: TextElementData | null; isAlternativeTypeface: boolean } {
  let isAlternativeTypeface = false;

  if (fontAssets == null || fontAssets.length === 0) return { character: null, isAlternativeTypeface };

  if (includeFallbacks) k_SearchedAssets.clear();

  for (const fontAsset of fontAssets) {
    if (fontAsset == null) continue;

    const result = getCharacterFromFontAssetInternal(unicode, fontAsset, includeFallbacks, fontStyle, fontWeight);
    if (result.character != null) return result;
  }

  return { character: null, isAlternativeTypeface };
}

/** GetTextElementFromTextAssets（TMP_FontAssetUtilities.cs:260）：emoji fallback 清單（FontAsset 與 SpriteAsset 混雜） */
export function getTextElementFromTextAssets(
  unicode: number,
  _sourceFontAsset: FontAssetData,
  textAssets: (FontAssetData | SpriteAssetData | null)[],
  includeFallbacks: boolean,
  fontStyle: FontStyles,
  fontWeight: FontWeight,
): { element: TextElementData | null; isAlternativeTypeface: boolean } {
  let isAlternativeTypeface = false;

  if (textAssets == null || textAssets.length === 0) return { element: null, isAlternativeTypeface };

  if (includeFallbacks) k_SearchedAssets.clear();

  for (const textAsset of textAssets) {
    if (textAsset == null) continue;

    if (textAsset instanceof FontAssetData) {
      const result = getCharacterFromFontAssetInternal(unicode, textAsset, includeFallbacks, fontStyle, fontWeight);
      if (result.character != null) return { element: result.character, isAlternativeTypeface: result.isAlternativeTypeface };
    } else {
      const spriteCharacter = getSpriteCharacterFromSpriteAssetInternal(unicode, textAsset, true);
      if (spriteCharacter != null) return { element: spriteCharacter, isAlternativeTypeface };
    }
  }

  return { element: null, isAlternativeTypeface };
}

// ───────── Sprite asset 查詢 ─────────

const k_SearchedSpriteAssets = new Set<string>();

/** GetSpriteCharacterFromSpriteAsset（TMP_FontAssetUtilities.cs:316） */
export function getSpriteCharacterFromSpriteAsset(unicode: number, spriteAsset: SpriteAssetData | null, includeFallbacks: boolean): TextElementData | null {
  if (spriteAsset == null) return null;

  const spriteCharacter = spriteAsset.spriteCharacterLookupTable.get(unicode);
  if (spriteCharacter !== undefined) return spriteCharacter;

  if (includeFallbacks) {
    k_SearchedSpriteAssets.clear();
    k_SearchedSpriteAssets.add(spriteAsset.id);

    const fallbackSpriteAsset = spriteAsset.fallbackSpriteAssets;
    if (fallbackSpriteAsset != null && fallbackSpriteAsset.length > 0) {
      for (const temp of fallbackSpriteAsset) {
        if (temp == null) continue;
        if (k_SearchedSpriteAssets.has(temp.id)) continue;
        k_SearchedSpriteAssets.add(temp.id);

        const hit = getSpriteCharacterFromSpriteAssetInternal(unicode, temp, true);
        if (hit != null) return hit;
      }
    }
  }

  return null;
}

/** GetSpriteCharacterFromSpriteAsset_Internal（TMP_FontAssetUtilities.cs:376） */
function getSpriteCharacterFromSpriteAssetInternal(unicode: number, spriteAsset: SpriteAssetData, includeFallbacks: boolean): TextElementData | null {
  const spriteCharacter = spriteAsset.spriteCharacterLookupTable.get(unicode);
  if (spriteCharacter !== undefined) return spriteCharacter;

  if (includeFallbacks) {
    const fallbackSpriteAsset = spriteAsset.fallbackSpriteAssets;
    if (fallbackSpriteAsset != null && fallbackSpriteAsset.length > 0) {
      for (const temp of fallbackSpriteAsset) {
        if (temp == null) continue;
        if (k_SearchedSpriteAssets.has(temp.id)) continue;
        k_SearchedSpriteAssets.add(temp.id);

        const hit = getSpriteCharacterFromSpriteAssetInternal(unicode, temp, true);
        if (hit != null) return hit;
      }
    }
  }

  return null;
}

// ───────── TMP_SpriteAsset.SearchForSpriteByHashCode（TMP_SpriteAsset.cs:354） ─────────

export interface SpriteSearchResult {
  spriteAsset: SpriteAssetData | null;
  spriteIndex: number;
}

export function searchForSpriteByHashCode(
  assets: TextAssets,
  spriteAsset: SpriteAssetData | null,
  hashCode: number,
  includeFallbacks: boolean,
  settingsDefaultSpriteAsset: () => SpriteAssetData | null,
  missingCharacterSpriteUnicode: number,
): SpriteSearchResult {
  if (spriteAsset == null) return { spriteAsset: null, spriteIndex: -1 };

  let spriteIndex = spriteAsset.getSpriteIndexFromHashcode(hashCode);
  if (spriteIndex !== -1) return { spriteAsset, spriteIndex };

  k_SearchedSpriteAssets.clear();
  k_SearchedSpriteAssets.add(spriteAsset.id);

  // Search potential fallbacks assigned to local sprite asset.
  if (includeFallbacks && spriteAsset.fallbackSpriteAssets != null && spriteAsset.fallbackSpriteAssets.length > 0) {
    const result = searchForSpriteByHashCodeInternalList(assets, spriteAsset.fallbackSpriteAssets, hashCode, true, settingsDefaultSpriteAsset, missingCharacterSpriteUnicode);
    if (result.spriteIndex !== -1) return result;
  }

  // Search default sprite asset potentially assigned in the TMP Settings.
  const defaultSpriteAsset = settingsDefaultSpriteAsset();
  if (includeFallbacks && defaultSpriteAsset != null) {
    const result = searchForSpriteByHashCodeInternal(assets, defaultSpriteAsset, hashCode, true, settingsDefaultSpriteAsset, missingCharacterSpriteUnicode);
    if (result.spriteIndex !== -1) return result;
  }

  // Clear search list since we are now looking for the missing sprite character.
  k_SearchedSpriteAssets.clear();

  // Get sprite index for the given unicode
  spriteIndex = spriteAsset.getSpriteIndexFromUnicode(missingCharacterSpriteUnicode);
  if (spriteIndex !== -1) return { spriteAsset, spriteIndex };

  k_SearchedSpriteAssets.add(spriteAsset.id);

  if (includeFallbacks && spriteAsset.fallbackSpriteAssets != null && spriteAsset.fallbackSpriteAssets.length > 0) {
    const result = searchForSpriteByUnicodeInternalList(spriteAsset.fallbackSpriteAssets, missingCharacterSpriteUnicode, true);
    if (result.spriteIndex !== -1) return result;
  }

  if (includeFallbacks && defaultSpriteAsset != null) {
    const result = searchForSpriteByUnicodeInternalSpriteAsset(defaultSpriteAsset, missingCharacterSpriteUnicode, true);
    if (result.spriteIndex !== -1) return result;
  }

  return { spriteAsset: null, spriteIndex: -1 };
}

function searchForSpriteByHashCodeInternalList(
  assets: TextAssets,
  spriteAssets: (SpriteAssetData | null)[],
  hashCode: number,
  searchFallbacks: boolean,
  settingsDefaultSpriteAsset: () => SpriteAssetData | null,
  missingCharacterSpriteUnicode: number,
): SpriteSearchResult {
  for (const temp0 of spriteAssets) {
    if (temp0 == null) continue;
    if (k_SearchedSpriteAssets.has(temp0.id)) continue;
    k_SearchedSpriteAssets.add(temp0.id);

    const result = searchForSpriteByHashCodeInternal(assets, temp0, hashCode, searchFallbacks, settingsDefaultSpriteAsset, missingCharacterSpriteUnicode);
    if (result.spriteAsset != null) return result;
  }
  return { spriteAsset: null, spriteIndex: -1 };
}

function searchForSpriteByHashCodeInternal(
  assets: TextAssets,
  spriteAsset: SpriteAssetData,
  hashCode: number,
  searchFallbacks: boolean,
  settingsDefaultSpriteAsset: () => SpriteAssetData | null,
  missingCharacterSpriteUnicode: number,
): SpriteSearchResult {
  const spriteIndex = spriteAsset.getSpriteIndexFromHashcode(hashCode);
  if (spriteIndex !== -1) return { spriteAsset, spriteIndex };

  if (searchFallbacks && spriteAsset.fallbackSpriteAssets != null && spriteAsset.fallbackSpriteAssets.length > 0)
    return searchForSpriteByHashCodeInternalList(assets, spriteAsset.fallbackSpriteAssets, hashCode, true, settingsDefaultSpriteAsset, missingCharacterSpriteUnicode);

  return { spriteAsset: null, spriteIndex: -1 };
}

function searchForSpriteByUnicodeInternalList(spriteAssets: (SpriteAssetData | null)[], unicode: number, searchFallbacks: boolean): SpriteSearchResult {
  for (const temp0 of spriteAssets) {
    if (temp0 == null) continue;
    if (k_SearchedSpriteAssets.has(temp0.id)) continue;
    k_SearchedSpriteAssets.add(temp0.id);

    const result = searchForSpriteByUnicodeInternalSpriteAsset(temp0, unicode, searchFallbacks);
    if (result.spriteAsset != null) return result;
  }
  return { spriteAsset: null, spriteIndex: -1 };
}

function searchForSpriteByUnicodeInternalSpriteAsset(spriteAsset: SpriteAssetData, unicode: number, searchFallbacks: boolean): SpriteSearchResult {
  const spriteIndex = spriteAsset.getSpriteIndexFromUnicode(unicode);
  if (spriteIndex !== -1) return { spriteAsset, spriteIndex };

  if (searchFallbacks && spriteAsset.fallbackSpriteAssets != null && spriteAsset.fallbackSpriteAssets.length > 0)
    return searchForSpriteByUnicodeInternalList(spriteAsset.fallbackSpriteAssets, unicode, true);

  return { spriteAsset: null, spriteIndex: -1 };
}

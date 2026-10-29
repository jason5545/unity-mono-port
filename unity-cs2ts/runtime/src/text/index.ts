// 對外介面（types.ts 檔頭的四個函式）。把元件 JSON＋TextContext 組成 TextObject，跑 TMP 的流程。
// 流程照 Unity 的呼叫順序：LoadFontAsset → GetPaddingForMaterial（TMP_Text.cs:1797）→ ComputeMarginSize（TMPro_UGUI_Private.cs:1553）→
// OnPreRenderCanvas（TMPro_UGUI_Private.cs:1686）／OnPreRenderObject（TMPro_Private.cs:1556）的 auto size 迴圈。

import type { ExternalRef } from '../unity/types';
import type { TextAssets, TextContext, TextMeshResult, TextSubMesh, TmpComponentData, TmpTextInfo } from './types';
import { TextObject } from './textObject';
import { getFontAsset, getMaterial, getSpriteAsset } from './assets';
import { clamp, f32 } from './utils';
import type { TmpCharacterInfo } from './textInfo';
import { computeRenderedValues } from './textBounds';

export type { TextObject } from './textObject';

/** 準備一個 TextObject：解析素材、margin、padding（還沒 parse） */
function prepare(component: TmpComponentData, ctx: TextContext, assets: TextAssets): TextObject {
  const ui = (component.script as { class?: string } | null)?.class !== 'TextMeshPro';
  const t = new TextObject({ ui, data: component }, assets);

  t.ctx = ctx;

  // LoadFontAsset（TMPro_UGUI_Private.cs:512／TMPro_Private.cs:398）：解析字型與材質
  t.m_fontAsset = getFontAsset(assets, t.m_fontAssetRef, t.warnings);
  t.m_sharedMaterial = getMaterial(assets, t.m_sharedMaterialRef) ?? t.m_fontAsset?.material ?? null;
  // TMP_Text.LoadSpriteAsset（TMP_Text.cs:1878-1891）：元件沒指定 m_spriteAsset 時用
  // TMP_Settings.m_defaultSpriteAsset（這個專案＝ ManaSheetForTMP，裡面有 D4／D6／D8／D12／D20、
  // Block、Injure、coin 等 sprite）。卡牌說明與敵人意圖的 <sprite name="D6"> 靠這條才畫得出來。
  const spriteRef =
    t.m_spriteAssetRef ??
    ((assets.settings as { m_defaultSpriteAsset?: ExternalRef | null }).m_defaultSpriteAsset as ExternalRef | null | undefined) ??
    null;
  t.m_spriteAsset = getSpriteAsset(assets, spriteRef, t.warnings);

  // GetPaddingForMaterial（TMP_Text.cs:1797）
  t.getPaddingForMaterial();

  // ComputeMarginSize（TMPro_UGUI_Private.cs:1553／TMPro_Private.cs:1460）
  const rect = ctx.rect;
  t.m_marginWidth = f32(f32(rect.width - t.m_margin.x) - t.m_margin.z);
  t.m_marginHeight = f32(f32(rect.height - t.m_margin.y) - t.m_margin.w);
  // RectTransform.GetLocalCorners
  t.m_RectTransformCorners = [
    { x: rect.x, y: rect.y, z: 0 },
    { x: rect.x, y: f32(rect.y + rect.height), z: 0 },
    { x: f32(rect.x + rect.width), y: f32(rect.y + rect.height), z: 0 },
    { x: f32(rect.x + rect.width), y: rect.y, z: 0 },
  ];

  // LoadDefaultSettings 的對齊轉換（TMP_Text.cs:5949）
  t.applyAlignmentConversion();

  return t;
}

/** generateText：TMP_Text.text setter → OnPreRenderCanvas 的流程（parse + auto size 迴圈） */
export function generateText(component: TmpComponentData, ctx: TextContext, assets: TextAssets): TextMeshResult {
  const warnings: string[] = [];
  const t = prepare(component, ctx, assets);
  t.warnings = warnings;

  if (t.m_fontAsset == null || t.m_sharedMaterial == null) {
    warnings.push(`元件沒有字型或材質（fontAsset=${t.m_fontAssetRef?.guid ?? 'null'}，material=${t.m_sharedMaterialRef?.guid ?? 'null'}）`);
    return emptyResult(t, warnings);
  }

  // OnPreRenderCanvas（TMPro_UGUI_Private.cs:1686）／OnPreRenderObject（TMPro_Private.cs:1556）
  t.parseInputText();

  // Reset Font min / max used with Auto-sizing
  if (t.m_enableAutoSizing) t.m_fontSize = clamp(t.m_fontSizeBase, t.m_fontSizeMin, t.m_fontSizeMax);

  t.m_maxFontSize = t.m_fontSizeMax;
  t.m_minFontSize = t.m_fontSizeMin;
  t.m_lineSpacingDelta = 0;
  t.m_charWidthAdjDelta = 0;

  t.m_isTextTruncated = false;

  // Reset Text Auto Size iteration tracking.
  t.m_IsAutoSizePointSizeSet = false;
  t.m_AutoSizeIterationCount = 0;

  // The GenerateTextMesh function is potentially called repeatedly when text auto size is enabled.
  while (t.m_IsAutoSizePointSizeSet === false) {
    t.generateTextMesh();
    t.m_AutoSizeIterationCount += 1;
  }
  if (t.m_AutoSizeIterationCount > t.m_AutoSizeMaxIterationCount) warnings.push(`auto size 迭代 ${t.m_AutoSizeIterationCount} 次，超過 m_AutoSizeMaxIterationCount ${t.m_AutoSizeMaxIterationCount}`);

  const result = buildResult(t, warnings);

  // preferredWidth／Height：TMP 的 preferredWidth property（版面系統在 GenerateTextMesh 之外呼叫）
  result.preferredWidth = t.getPreferredWidthMain();
  result.preferredHeight = t.getPreferredHeightMain();

  return result;
}

/** getPreferredWidth：TMP_Text.preferredWidth（TMP_Text.cs:3624） */
export function getPreferredWidth(component: TmpComponentData, ctx: TextContext, assets: TextAssets): number {
  const warnings: string[] = [];
  const t = prepare(component, ctx, assets);
  t.warnings = warnings;

  if (t.m_fontAsset == null || t.m_sharedMaterial == null) return 0;

  return t.getPreferredWidthMain();
}

/** getPreferredHeight：TMP_Text.preferredHeight（TMP_Text.cs:3698） */
export function getPreferredHeight(component: TmpComponentData, ctx: TextContext, assets: TextAssets): number {
  const warnings: string[] = [];
  const t = prepare(component, ctx, assets);
  t.warnings = warnings;

  if (t.m_fontAsset == null || t.m_sharedMaterial == null) return 0;

  return t.getPreferredHeightMain();
}

/** getPreferredValues：TMP_Text.GetPreferredValues(width, height)（TMP_Text.cs:3554） */
export function getPreferredValues(component: TmpComponentData, width: number, height: number, ctx: TextContext, assets: TextAssets): { x: number; y: number } {
  const warnings: string[] = [];
  const t = prepare(component, ctx, assets);
  t.warnings = warnings;

  if (t.m_fontAsset == null || t.m_sharedMaterial == null) return { x: 0, y: 0 };

  return t.getPreferredValuesWH(width, height);
}

// ───────── 輸出轉換 ─────────

function emptyResult(t: TextObject, warnings: string[]): TextMeshResult {
  return {
    subMeshes: [],
    textInfo: emptyTextInfo(),
    fontSize: t.m_fontSize,
    preferredWidth: 0,
    preferredHeight: 0,
    renderedWidth: 0,
    renderedHeight: 0,
    characterCount: 0,
    lineCount: 0,
    isTextOverflowing: false,
    isTextTruncated: false,
    warnings,
  };
}

function emptyTextInfo(): TmpTextInfo {
  return { characterCount: 0, spriteCount: 0, spaceCount: 0, wordCount: 0, linkCount: 0, lineCount: 0, pageCount: 0, materialCount: 0, characterInfo: [], lineInfo: [], wordInfo: [], linkInfo: [], pageInfo: [] };
}

function buildResult(t: TextObject, warnings: string[]): TextMeshResult {
  const ti = t.m_textInfo;
  const materialCount = ti.materialCount;

  // 裝飾（底線／刪除線／highlight）寫在 meshInfo[m_Underline.materialIndex]，從 referenceCount*4 開始
  const decorationMaterialIndex = t.m_Underline.materialIndex;
  const decorationStartQuad = materialCount > 0 ? t.m_materialReferences[decorationMaterialIndex]?.referenceCount ?? 0 : 0;

  const subMeshes: TextSubMesh[] = [];
  for (let mi = 0; mi < materialCount; mi++) {
    const mesh = ti.meshInfo[mi];
    const matRef = t.m_materialReferences[mi];
    if (!mesh || !matRef) continue;

    // 用到的四邊形：字元 [0, vertexCount/4)＋裝飾 [decorationStartQuad, lastVertIndex/4)（只有裝飾材質那個子網格）
    const charQuads = mesh.vertexCount / 4;
    const quadRanges: [number, number][] = [];
    if (charQuads > 0) quadRanges.push([0, charQuads]);
    if (mi === decorationMaterialIndex && t.m_lastVertIndex > decorationStartQuad * 4) quadRanges.push([decorationStartQuad, t.m_lastVertIndex / 4]);

    let totalVerts = 0;
    for (const [a, b] of quadRanges) totalVerts += (b - a) * 4;

    const positions = new Float32Array(totalVerts * 3);
    const colors = new Uint8Array(totalVerts * 4);
    const uvs0 = new Float32Array(totalVerts * 4);
    const uvs2 = new Float32Array(totalVerts * 2);
    const indices = new Uint32Array((totalVerts / 4) * 6);

    let w = 0; // 寫入的頂點 index
    let iw = 0;
    for (const [qa, qb] of quadRanges) {
      for (let q = qa; q < qb; q++) {
        for (let v = 0; v < 4; v++) {
          const src = q * 4 + v;
          const p = mesh.vertices[src] ?? { x: 0, y: 0, z: 0 };
          positions[(w + v) * 3] = p.x;
          positions[(w + v) * 3 + 1] = p.y;
          positions[(w + v) * 3 + 2] = p.z;
          const c = mesh.colors32[src] ?? { r: 0, g: 0, b: 0, a: 0 };
          colors[(w + v) * 4] = c.r;
          colors[(w + v) * 4 + 1] = c.g;
          colors[(w + v) * 4 + 2] = c.b;
          colors[(w + v) * 4 + 3] = c.a;
          const u0 = mesh.uvs0[src] ?? { x: 0, y: 0, z: 0, w: 0 };
          uvs0[(w + v) * 4] = u0.x;
          uvs0[(w + v) * 4 + 1] = u0.y;
          uvs0[(w + v) * 4 + 2] = u0.z;
          uvs0[(w + v) * 4 + 3] = u0.w;
          const u2 = mesh.uvs2[src] ?? { x: 0, y: 0 };
          uvs2[(w + v) * 2] = u2.x;
          uvs2[(w + v) * 2 + 1] = u2.y;
        }
        // 三角形順序照 TMP_MeshInfo.cs:102–107：0,1,2, 2,3,0
        indices[iw++] = w + 0;
        indices[iw++] = w + 1;
        indices[iw++] = w + 2;
        indices[iw++] = w + 2;
        indices[iw++] = w + 3;
        indices[iw++] = w + 0;
        w += 4;
      }
    }

    const mat = matRef.material;
    subMeshes.push({
      materialIndex: mi,
      fontAsset: matRef.fontAsset?.ref ?? null,
      spriteAsset: matRef.spriteAsset?.ref ?? null,
      material: {
        source: mat.ref,
        shader: mat.shaderRef ?? null,
        floats: { ...mat.floats },
        colors: { ...mat.colors },
        textures: { ...mat.textures },
        keywords: [...mat.keywords],
      },
      positions,
      colors,
      uvs0,
      uvs2,
      indices,
    });
  }

  const rendered = computeRenderedValues(ti.characterInfo, ti.characterCount);

  const textInfo: TmpTextInfo = {
    characterCount: ti.characterCount,
    spriteCount: ti.spriteCount,
    spaceCount: ti.spaceCount,
    wordCount: ti.wordCount,
    linkCount: ti.linkCount,
    lineCount: ti.lineCount,
    pageCount: ti.pageCount,
    materialCount: ti.materialCount,
    characterInfo: ti.characterInfo.slice(0, ti.characterCount).map(characterInfoOut),
    lineInfo: ti.lineInfo.slice(0, ti.lineCount).map((l) => ({
      characterCount: l.characterCount,
      visibleCharacterCount: l.visibleCharacterCount,
      spaceCount: l.spaceCount,
      visibleSpaceCount: l.visibleSpaceCount,
      wordCount: l.wordCount,
      firstCharacterIndex: l.firstCharacterIndex,
      firstVisibleCharacterIndex: l.firstVisibleCharacterIndex,
      lastCharacterIndex: l.lastCharacterIndex,
      lastVisibleCharacterIndex: l.lastVisibleCharacterIndex,
      length: l.length,
      lineHeight: l.lineHeight,
      ascender: l.ascender,
      baseline: l.baseline,
      descender: l.descender,
      maxAdvance: l.maxAdvance,
      width: l.width,
      marginLeft: l.marginLeft,
      marginRight: l.marginRight,
      alignment: l.alignment,
      lineExtents: { min: { ...l.lineExtents.min }, max: { ...l.lineExtents.max } },
    })),
    wordInfo: ti.wordInfo.slice(0, ti.wordCount).map((wd) => ({ firstCharacterIndex: wd.firstCharacterIndex, lastCharacterIndex: wd.lastCharacterIndex, characterCount: wd.characterCount })),
    linkInfo: ti.linkInfo.slice(0, ti.linkCount).map((l) => ({
      hashCode: l.hashCode,
      linkIdFirstCharacterIndex: l.linkIdFirstCharacterIndex,
      linkIdLength: l.linkIdLength,
      linkTextfirstCharacterIndex: l.linkTextfirstCharacterIndex,
      linkTextLength: l.linkTextLength,
      linkId: l.getLinkID(),
      linkText: ti.characterInfo
        .slice(l.linkTextfirstCharacterIndex, l.linkTextfirstCharacterIndex + l.linkTextLength)
        .map((c) => String.fromCharCode(c.character))
        .join(''),
    })),
    pageInfo: ti.pageInfo.slice(0, ti.pageCount).map((p) => ({ firstCharacterIndex: p.firstCharacterIndex, lastCharacterIndex: p.lastCharacterIndex, ascender: p.ascender, baseLine: p.baseLine, descender: p.descender })),
  };

  return {
    subMeshes,
    textInfo,
    fontSize: t.m_fontSize,
    preferredWidth: 0,
    preferredHeight: 0,
    renderedWidth: rendered.x,
    renderedHeight: rendered.y,
    characterCount: ti.characterCount,
    lineCount: ti.lineCount,
    isTextOverflowing: t.m_firstOverflowCharacterIndex !== -1,
    isTextTruncated: t.m_isTextTruncated,
    warnings,
  };
}

function characterInfoOut(c: TmpCharacterInfo): TmpTextInfo['characterInfo'][number] {
  return {
    character: c.character,
    index: c.index,
    stringLength: c.stringLength,
    elementType: c.elementType,
    materialReferenceIndex: c.materialReferenceIndex,
    lineNumber: c.lineNumber,
    pageNumber: c.pageNumber,
    vertexIndex: c.vertexIndex,
    isVisible: c.isVisible,
    origin: c.origin,
    xAdvance: c.xAdvance,
    ascender: c.ascender,
    baseLine: c.baseLine,
    descender: c.descender,
    pointSize: c.pointSize,
    scale: c.scale,
    style: c.style,
    color: { ...c.color },
    bottomLeft: { ...c.bottomLeft },
    topLeft: { ...c.topLeft },
    topRight: { ...c.topRight },
    bottomRight: { ...c.bottomRight },
  };
}

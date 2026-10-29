// TMP_TextInfo 相關結構：對應 TMP_CharacterInfo.cs、TMP_LineInfo.cs、TMPro_MeshUtilities.cs（TMP_WordInfo、TMP_LinkInfo、TMP_PageInfo、Extents、WordWrapState）、TMP_TextInfo.cs、TMP_MeshInfo.cs、MaterialReferenceManager.cs 的 MaterialReference。
// C# 的結構是值型別，這裡用 class，需要複製的地方明確 clone。

import type { Color32 } from './utils';
import { color32, k_LargeNegativeVector2, k_LargePositiveVector2, s_colorWhite } from './utils';
import type { FontStyles, HorizontalAlignmentOptions, TmpTextElementType } from './enums';
import type { FontAssetData, MaterialView, SpriteAssetData, TextElementData } from './assets';
import type { TmpFontStyleStack, TmpTextProcessingStack } from './stacks';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

/** TMP_Vertex（TMP_CharacterInfo.cs:8） */
export interface TmpVertex {
  position: Vec3;
  uv: { x: number; y: number; z: number; w: number };
  uv2: { x: number; y: number };
  color: Color32;
}
export const tmpVertex = (): TmpVertex => ({ position: vec3(), uv: { x: 0, y: 0, z: 0, w: 0 }, uv2: { x: 0, y: 0 }, color: color32(0, 0, 0, 0) });

/** TMP_Offset（TMP_CharacterInfo.cs:27） */
export interface TmpOffset {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
export const tmpOffset = (left = 0, right = 0, top = 0, bottom = 0): TmpOffset => ({ left, right, top, bottom });
export const tmpOffsetEqual = (a: TmpOffset, b: TmpOffset): boolean => a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;

/** HighlightState（TMP_CharacterInfo.cs:123） */
export interface HighlightState {
  color: Color32;
  padding: TmpOffset;
}
export const highlightState = (color: Color32, padding: TmpOffset): HighlightState => ({ color, padding });
export const highlightStateEqual = (a: HighlightState, b: HighlightState): boolean =>
  a.color.r === b.color.r && a.color.g === b.color.g && a.color.b === b.color.b && a.color.a === b.color.a && tmpOffsetEqual(a.padding, b.padding);

/** Extents（Extents.cs） */
export interface Extents {
  min: { x: number; y: number };
  max: { x: number; y: number };
}
export const extents = (): Extents => ({ min: { ...k_LargePositiveVector2 }, max: { ...k_LargeNegativeVector2 } });

/** TMP_CharacterInfo（TMP_CharacterInfo.cs:163）。位置相關欄位是對齊「之前」還是「之後」照 C# 的寫入時機。 */
export class TmpCharacterInfo {
  elementType: TmpTextElementType = 0;
  character = 0; // C# char（UTF-16 單元）
  index = 0;
  stringLength = 0;
  textElement: TextElementData | null = null;
  alternativeGlyph: import('./assets').GlyphData | null = null;
  fontAsset: FontAssetData | null = null;
  material: MaterialView | null = null;
  materialReferenceIndex = 0;
  isUsingAlternateTypeface = false;
  pointSize = 0;
  lineNumber = 0;
  pageNumber = 0;
  vertexIndex = 0;
  vertex_BL = tmpVertex();
  vertex_TL = tmpVertex();
  vertex_TR = tmpVertex();
  vertex_BR = tmpVertex();
  topLeft = vec3();
  bottomLeft = vec3();
  topRight = vec3();
  bottomRight = vec3();
  origin = 0;
  xAdvance = 0;
  ascender = 0;
  baseLine = 0;
  descender = 0;
  adjustedAscender = 0;
  adjustedDescender = 0;
  adjustedHorizontalAdvance = 0;
  aspectRatio = 0;
  scale = 0;
  color: Color32 = color32(0, 0, 0, 0);
  underlineColor: Color32 = color32(0, 0, 0, 0);
  underlineVertexIndex = 0;
  strikethroughColor: Color32 = color32(0, 0, 0, 0);
  strikethroughVertexIndex = 0;
  highlightColor: Color32 = color32(0, 0, 0, 0);
  highlightState: HighlightState = highlightState(color32(0, 0, 0, 0), tmpOffset());
  style: FontStyles = 0 as FontStyles;
  isVisible = false;
}

/** TMP_LineInfo（TMP_LineInfo.cs:7） */
export class TmpLineInfo {
  controlCharacterCount = 0;
  characterCount = 0;
  visibleCharacterCount = 0;
  spaceCount = 0;
  visibleSpaceCount = 0;
  wordCount = 0;
  firstCharacterIndex = 0;
  firstVisibleCharacterIndex = 0;
  lastCharacterIndex = 0;
  lastVisibleCharacterIndex = 0;
  length = 0;
  lineHeight = 0;
  ascender = 0;
  baseline = 0;
  descender = 0;
  maxAdvance = 0;
  width = 0;
  marginLeft = 0;
  marginRight = 0;
  alignment: HorizontalAlignmentOptions = 0 as HorizontalAlignmentOptions;
  lineExtents: Extents = extents();

  clone(): TmpLineInfo {
    const l = new TmpLineInfo();
    Object.assign(l, this);
    l.lineExtents = { min: { ...this.lineExtents.min }, max: { ...this.lineExtents.max } };
    return l;
  }
}

/** TMP_WordInfo（TMPro_MeshUtilities.cs:184） */
export class TmpWordInfo {
  firstCharacterIndex = 0;
  lastCharacterIndex = 0;
  characterCount = 0;
}

/** TMP_LinkInfo（TMPro_MeshUtilities.cs:118） */
export class TmpLinkInfo {
  hashCode = 0;
  linkIdFirstCharacterIndex = 0;
  linkIdLength = 0;
  linkTextfirstCharacterIndex = 0;
  linkTextLength = 0;
  linkID = '';

  /** SetLinkID（TMPro_MeshUtilities.cs:132） */
  setLinkID(text: string[], startIndex: number, length: number): void {
    this.linkID = text.slice(startIndex, startIndex + length).join('');
    this.linkIdLength = length;
  }

  /** GetLinkID（TMPro_MeshUtilities.cs:172） */
  getLinkID(): string {
    return this.linkID.slice(0, this.linkIdLength);
  }
}

/** TMP_PageInfo（TMPro_MeshUtilities.cs:104） */
export class TmpPageInfo {
  firstCharacterIndex = 0;
  lastCharacterIndex = 0;
  ascender = 0;
  baseLine = 0;
  descender = 0;
}

/** TMP_MeshInfo（TMP_MeshInfo.cs）：頂點緩衝（還沒壓成 typed array） */
export class TmpMeshInfo {
  vertices: Vec3[] = [];
  uvs0: { x: number; y: number; z: number; w: number }[] = [];
  uvs2: { x: number; y: number }[] = [];
  colors32: Color32[] = [];
  vertexCount = 0;
  material: MaterialView | null = null;

  /** ResizeMeshInfo(size)：size 是「四邊形數」 */
  resizeMeshInfo(size: number): void {
    const v = size * 4;
    this.vertices.length = v;
    this.uvs0.length = v;
    this.uvs2.length = v;
    this.colors32.length = v;
    for (let i = 0; i < v; i++) {
      this.vertices[i] ??= vec3();
      this.uvs0[i] ??= { x: 0, y: 0, z: 0, w: 0 };
      this.uvs2[i] ??= { x: 0, y: 0 };
      this.colors32[i] ??= color32(0, 0, 0, 0);
    }
  }

  /** Clear(false)：vertexCount 歸零（TMP_MeshInfo.cs 的 Clear(bool)） */
  clear(): void {
    this.vertexCount = 0;
  }

  /** ClearUnusedVertices：把 vertexCount 之後的頂點清成 0（避免舊資料留到下一輪） */
  clearUnusedVertices(): void {
    for (let i = this.vertexCount; i < this.vertices.length; i++) {
      const v = this.vertices[i];
      if (v) { v.x = 0; v.y = 0; v.z = 0; }
      const u = this.uvs0[i];
      if (u) { u.x = 0; u.y = 0; u.z = 0; u.w = 0; }
      const u2 = this.uvs2[i];
      if (u2) { u2.x = 0; u2.y = 0; }
      const c = this.colors32[i];
      if (c) { c.r = 0; c.g = 0; c.b = 0; c.a = 0; }
    }
  }
}

/** MaterialReference（MaterialReferenceManager.cs:497） */
export class MaterialReference {
  constructor(
    public index: number,
    public fontAsset: FontAssetData | null,
    public spriteAsset: SpriteAssetData | null,
    public material: MaterialView,
    public padding: number,
  ) {}
  isDefaultMaterial = false;
  isFallbackMaterial = false;
  fallbackMaterial: MaterialView | null = null;
  referenceCount = 0;
}

/** SpecialCharacter（TMP_Text.cs:1573） */
export class SpecialCharacter {
  character: TextElementData | null = null;
  fontAsset: FontAssetData | null = null;
  material: MaterialView | null = null;
  materialIndex = 0;

  static create(character: TextElementData, materialIndex: number): SpecialCharacter {
    const s = new SpecialCharacter();
    s.character = character;
    s.fontAsset = (character.textAsset as FontAssetData | null) ?? null;
    s.material = s.fontAsset ? s.fontAsset.material : null;
    s.materialIndex = materialIndex;
    return s;
  }
}

/** CharacterSubstitution（TMP_Text.cs:1520） */
export interface CharacterSubstitution {
  index: number;
  unicode: number;
}

/** WordWrapState（TMPro_MeshUtilities.cs:354）。C# struct：複製用 clone()。stack 欄位是淺拷貝（共享 itemStack、各自 index） */
export class WordWrapState {
  previous_WordBreak = 0;
  total_CharacterCount = 0;
  visible_CharacterCount = 0;
  visibleSpaceCount = 0;
  visible_SpriteCount = 0;
  visible_LinkCount = 0;
  firstCharacterIndex = 0;
  firstVisibleCharacterIndex = 0;
  lastCharacterIndex = 0;
  lastVisibleCharIndex = 0;
  lineNumber = 0;
  maxCapHeight = 0;
  maxAscender = 0;
  maxDescender = 0;
  startOfLineAscender = 0;
  maxLineAscender = 0;
  maxLineDescender = 0;
  pageAscender = 0;
  horizontalAlignment: HorizontalAlignmentOptions = 0 as HorizontalAlignmentOptions;
  marginLeft = 0;
  marginRight = 0;
  xAdvance = 0;
  preferredWidth = 0;
  preferredHeight = 0;
  renderedWidth = 0;
  renderedHeight = 0;
  previousLineScale = 0;
  wordCount = 0;
  fontStyle: FontStyles = 0 as FontStyles;
  italicAngle = 0;
  fontScaleMultiplier = 0;
  currentFontSize = 0;
  baselineOffset = 0;
  lineOffset = 0;
  isDrivenLineSpacing = false;
  lastBaseGlyphIndex = 0;
  cSpace = 0;
  mSpace = 0;
  lineInfo: TmpLineInfo | null = null;
  vertexColor: Color32 = color32(0, 0, 0, 0);
  underlineColor: Color32 = color32(0, 0, 0, 0);
  strikethroughColor: Color32 = color32(0, 0, 0, 0);
  highlightState: HighlightState = highlightState(s_colorWhite, tmpOffset());
  basicStyleStack!: TmpFontStyleStack;
  italicAngleStack!: TmpTextProcessingStack<number>;
  colorStack!: TmpTextProcessingStack<Color32>;
  underlineColorStack!: TmpTextProcessingStack<Color32>;
  strikethroughColorStack!: TmpTextProcessingStack<Color32>;
  highlightStateStack!: TmpTextProcessingStack<HighlightState>;
  colorGradientStack!: TmpTextProcessingStack<import('./assets').ColorGradientData | null>;
  sizeStack!: TmpTextProcessingStack<number>;
  indentStack!: TmpTextProcessingStack<number>;
  fontWeightStack!: TmpTextProcessingStack<number>;
  baselineStack!: TmpTextProcessingStack<number>;
  actionStack!: TmpTextProcessingStack<number>;
  materialReferenceStack!: TmpTextProcessingStack<MaterialReference>;
  lineJustificationStack!: TmpTextProcessingStack<HorizontalAlignmentOptions>;
  spriteAnimationID = 0;
  currentFontAsset: FontAssetData | null = null;
  currentSpriteAsset: SpriteAssetData | null = null;
  currentMaterial: MaterialView | null = null;
  currentMaterialIndex = 0;
  meshExtents: Extents = extents();
  tagNoParsing = false;
  isNonBreakingSpace = false;
  fxRotation: { angle: number } = { angle: 0 }; // 只用 z 軸旋轉（Quaternion.Euler(0,0,value)）
  fxScale: Vec3 = vec3(1, 1, 1);

  /** C# struct 賦值：淺拷貝。stack 照 C# struct 複製：共享 itemStack 陣列、各自的 index/count（snapshot） */
  copyFrom(o: WordWrapState): void {
    Object.assign(this, o);
    this.lineInfo = o.lineInfo ? o.lineInfo.clone() : null;
    this.vertexColor = { ...o.vertexColor };
    this.underlineColor = { ...o.underlineColor };
    this.strikethroughColor = { ...o.strikethroughColor };
    this.highlightState = { color: { ...o.highlightState.color }, padding: { ...o.highlightState.padding } };
    this.meshExtents = { min: { ...o.meshExtents.min }, max: { ...o.meshExtents.max } };
    this.fxRotation = { ...o.fxRotation };
    this.fxScale = { ...o.fxScale };
    this.basicStyleStack = o.basicStyleStack?.snapshot();
    this.italicAngleStack = o.italicAngleStack?.snapshot();
    this.colorStack = o.colorStack?.snapshot();
    this.underlineColorStack = o.underlineColorStack?.snapshot();
    this.strikethroughColorStack = o.strikethroughColorStack?.snapshot();
    this.highlightStateStack = o.highlightStateStack?.snapshot();
    this.colorGradientStack = o.colorGradientStack?.snapshot();
    this.sizeStack = o.sizeStack?.snapshot();
    this.indentStack = o.indentStack?.snapshot();
    this.fontWeightStack = o.fontWeightStack?.snapshot();
    this.baselineStack = o.baselineStack?.snapshot();
    this.actionStack = o.actionStack?.snapshot();
    this.materialReferenceStack = o.materialReferenceStack?.snapshot();
    this.lineJustificationStack = o.lineJustificationStack?.snapshot();
  }

  clone(): WordWrapState {
    const w = new WordWrapState();
    w.copyFrom(this);
    return w;
  }
}

/** TMP_TextInfo（TMP_TextInfo.cs）。陣列長度照 C# 預先配置，計數另外記。 */
export class TmpTextInfo {
  characterCount = 0;
  spriteCount = 0;
  spaceCount = 0;
  wordCount = 0;
  linkCount = 0;
  lineCount = 0;
  pageCount = 0;
  materialCount = 0;
  characterInfo: TmpCharacterInfo[] = [];
  wordInfo: TmpWordInfo[] = [];
  linkInfo: TmpLinkInfo[] = [];
  lineInfo: TmpLineInfo[] = [];
  pageInfo: TmpPageInfo[] = [];
  meshInfo: TmpMeshInfo[] = [];

  constructor(characterCount = 8) {
    for (let i = 0; i < characterCount; i++) this.characterInfo.push(new TmpCharacterInfo());
    for (let i = 0; i < 16; i++) this.wordInfo.push(new TmpWordInfo());
    for (let i = 0; i < 2; i++) this.lineInfo.push(new TmpLineInfo());
    for (let i = 0; i < 4; i++) this.pageInfo.push(new TmpPageInfo());
    this.meshInfo = [new TmpMeshInfo()];
  }

  /** Clear（TMP_TextInfo.cs:97） */
  clear(): void {
    this.characterCount = 0;
    this.spaceCount = 0;
    this.wordCount = 0;
    this.linkCount = 0;
    this.lineCount = 0;
    this.pageCount = 0;
    this.spriteCount = 0;
    for (const m of this.meshInfo) m.vertexCount = 0;
  }

  /** ClearLineInfo（TMP_TextInfo.cs:172）：只清 C# 有清的欄位 */
  clearLineInfo(): void {
    for (const l of this.lineInfo) {
      l.characterCount = 0;
      l.spaceCount = 0;
      l.wordCount = 0;
      l.controlCharacterCount = 0;
      l.visibleCharacterCount = 0;
      l.visibleSpaceCount = 0;
      l.ascender = -32767;
      l.baseline = 0;
      l.descender = 32767;
      l.maxAdvance = 0;
      l.marginLeft = 0;
      l.marginRight = 0;
      l.lineExtents.min = { x: 32767, y: 32767 };
      l.lineExtents.max = { x: -32767, y: -32767 };
      l.width = 0;
    }
  }

  /** ClearPageInfo（TMP_TextInfo.cs:203） */
  clearPageInfo(): void {
    for (const p of this.pageInfo) {
      p.firstCharacterIndex = 0;
      p.lastCharacterIndex = 0;
      p.ascender = -32767;
      p.baseLine = 0;
      p.descender = 32767;
    }
  }

  static resizeCharacterInfo(arr: TmpCharacterInfo[], size: number): void {
    while (arr.length < size) arr.push(new TmpCharacterInfo());
  }
  static resizeWordInfo(arr: TmpWordInfo[], size: number): void {
    while (arr.length < size) arr.push(new TmpWordInfo());
  }
  static resizeLinkInfo(arr: TmpLinkInfo[], size: number): void {
    while (arr.length < size) arr.push(new TmpLinkInfo());
  }
  static resizeLineInfo(arr: TmpLineInfo[], size: number): void {
    while (arr.length < size) arr.push(new TmpLineInfo());
  }
  static resizePageInfo(arr: TmpPageInfo[], size: number): void {
    while (arr.length < size) arr.push(new TmpPageInfo());
  }
  static resizeMeshInfo(arr: TmpMeshInfo[], size: number): void {
    while (arr.length < size) arr.push(new TmpMeshInfo());
  }
}

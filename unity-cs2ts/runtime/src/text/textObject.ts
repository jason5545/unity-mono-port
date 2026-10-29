// TMP_Text（TMP_Text.cs）＋ TextMeshProUGUI（TMPro_UGUI_Private.cs）＋ TextMeshPro（TMPro_Private.cs）的排版本體。
// 一個 TextObject 對應一個 TMP 元件的一次排版呼叫；m_* 欄位名稱照 C#。
// 兩個版本的差異用註解標兩邊行號（UGUI 在前、3D 在後）。

import type { ExternalRef } from '../unity/types';
import type { RawObject, TextAssets, TextContext } from './types';
import {
  CodePoint,
  FontStyles,
  FontWeight,
  HorizontalAlignmentOptions,
  MarkupTag,
  OTL_FeatureTag,
  parseActiveFontFeatures,
  TextOverflowModes,
  TextProcessingElementType,
  TextWrappingModes,
  TextureMappingOptions,
  TmpTextElementType,
  VerticalAlignmentOptions,
  type TextProcessingElement,
} from './enums';
import {
  charIsControl,
  charIsLetterOrDigit,
  charIsLower,
  charIsPunctuation,
  charIsSeparator,
  charIsUpper,
  charIsWhiteSpace,
  charToLower,
  charToUpper,
  clamp,
  color32,
  color32Compare,
  color32Multiply,
  colorMinAlpha,
  colorToColor32,
  convertToUTF32,
  f32,
  gammaToLinearColor32,
  getHashCode,
  intCast,
  isBaseGlyph,
  isCJK,
  isEmoji,
  isHangul,
  k_LargeNegativeFloat,
  k_LargeNegativeVector2,
  k_LargePositiveFloat,
  k_LargePositiveVector2,
  nextPowerOfTwo,
  s_colorWhite,
  TMP_MATH,
  tmpApproximately,
  toUpperFast,
  type Color32,
} from './utils';
import { TmpFontStyleStack, TmpTextProcessingStack } from './stacks';
import {
  Extents,
  extents,
  HighlightState,
  highlightState,
  highlightStateEqual,
  MaterialReference,
  SpecialCharacter,
  TmpCharacterInfo,
  TmpTextInfo,
  tmpOffset,
  WordWrapState,
  type CharacterSubstitution,
  type Vec3,
} from './textInfo';
import {
  FontAssetData,
  getColorGradient,
  getFontAsset,
  getSettings,
  getSpriteAsset,
  getStyleSheet,
  MaterialView,
  SettingsData,
  SpriteAssetData,
  StyleSheetData,
  TextElementType,
  warningsOf,
  type ColorGradientData,
  type StyleData,
  type TextElementData,
} from './assets';
import { getFallbackMaterial, getFallbackMaterialForAtlas, getPadding, isMaskingEnabled } from './materials';
import {
  getCharacterFromFontAsset,
  getCharacterFromFontAssets,
  getSpriteCharacterFromSpriteAsset,
  getTextElementFromTextAssets,
  registerFontAsset,
  searchForSpriteByHashCode,
  tryGetFontAsset,
} from './fontLookup';

/** RichTextTagAttribute（TMPro_MeshUtilities.cs:452） */
interface RichTextTagAttribute {
  nameHashCode: number;
  valueHashCode: number;
  valueType: number; // TagValueType
  valueStartIndex: number;
  valueLength: number;
  unitType: number; // TagUnitType
}

const TagValueType_None = 0x0;
const TagValueType_NumericalValue = 0x1;
const TagValueType_StringValue = 0x2;
const TagValueType_ColorValue = 0x4;
const TagUnitType_Pixels = 0x0;
const TagUnitType_FontUnits = 0x1;
const TagUnitType_Percentage = 0x2;

/** TextBackingContainer（TMP_Text.cs:1933） */
class TextBackingContainer {
  array: number[] = [];
  count = 0;

  get capacity(): number {
    return this.array.length;
  }

  get(index: number): number {
    return this.array[index];
  }

  set(index: number, value: number): void {
    if (index >= this.array.length) this.resize(index);
    this.array[index] = value;
  }

  resize(size: number): void {
    const newSize = nextPowerOfTwo(size + 1);
    this.array.length = newSize;
  }
}

/** TMP_Text 的建構參數（元件 JSON 已攤平） */
export interface TextObjectInit {
  ui: boolean; // TextMeshProUGUI = true；TextMeshPro（3D）= false
  data: RawObject;
}

export class TextObject {
  readonly assets: TextAssets;
  warnings: string[];
  readonly ui: boolean;

  // ───────── 元件序列化欄位（m_*，值來自 JSON） ─────────
  m_text: string;
  m_isRightToLeft: boolean;
  m_fontAssetRef: ExternalRef | null;
  m_sharedMaterialRef: ExternalRef | null;
  m_fontAsset: FontAssetData | null = null;
  m_sharedMaterial: MaterialView | null = null;
  m_fontColor32: Color32;
  m_fontColor: { r: number; g: number; b: number; a: number };
  m_enableVertexGradient: boolean;
  m_colorMode: number;
  m_fontColorGradient: { topLeft: Color32; topRight: Color32; bottomLeft: Color32; bottomRight: Color32 };
  m_fontColorGradientPresetRef: ExternalRef | null;
  m_fontColorGradientPreset: ColorGradientData | null = null;
  m_spriteAssetRef: ExternalRef | null;
  m_spriteAsset: SpriteAssetData | null = null;
  m_tintAllSprites: boolean;
  m_StyleSheetRef: ExternalRef | null;
  m_StyleSheet: StyleSheetData | null = null;
  m_TextStyleHashCode: number;
  m_overrideHtmlColors: boolean;
  m_faceColor: Color32;
  m_fontSize: number;
  m_fontSizeBase: number;
  m_fontWeight: FontWeight;
  m_enableAutoSizing: boolean;
  m_fontSizeMin: number;
  m_fontSizeMax: number;
  m_fontStyle: FontStyles;
  m_HorizontalAlignment: HorizontalAlignmentOptions;
  m_VerticalAlignment: VerticalAlignmentOptions;
  m_textAlignment: number;
  m_characterSpacing: number;
  m_wordSpacing: number;
  m_lineSpacing: number;
  m_lineSpacingMax: number;
  m_paragraphSpacing: number;
  m_charWidthMaxAdj: number;
  m_TextWrappingMode: TextWrappingModes;
  m_wordWrappingRatios: number;
  m_overflowMode: TextOverflowModes;
  m_linkedTextComponentRef: ExternalRef | null;
  m_enableKerning: boolean;
  m_ActiveFontFeatures: number[];
  m_enableExtraPadding: boolean;
  m_isRichText: boolean;
  m_EmojiFallbackSupport: boolean;
  m_parseCtrlCharacters: boolean;
  m_isOrthographic: boolean;
  m_horizontalMapping: TextureMappingOptions;
  m_verticalMapping: TextureMappingOptions;
  m_uvLineOffset: number;
  m_geometrySortingOrder: number;
  m_IsTextObjectScaleStatic: boolean;
  m_VertexBufferAutoSizeReduction: boolean;
  m_useMaxVisibleDescender: boolean;
  m_pageToDisplay: number;
  m_margin: { x: number; y: number; z: number; w: number };
  m_isUsingLegacyAnimationComponent: boolean;
  m_isVolumetricText: boolean;

  // 非序列化欄位的 TMP 預設（TMP_Text.cs 的欄位初始值）
  m_maxVisibleCharacters = 99999;
  m_maxVisibleWords = 99999;
  m_maxVisibleLines = 99999;
  m_firstVisibleCharacter = 0;
  m_AutoSizeMaxIterationCount = 100;
  m_renderMode = 0xff; // TextRenderFlags.Render

  // ───────── 排版狀態（m_* 照 C#） ─────────
  m_padding = 0;
  m_isMaskingEnabled = false;
  m_isSDFShader = true;
  m_currentFontAsset: FontAssetData | null = null;
  m_currentMaterial: MaterialView | null = null;
  m_currentSpriteAsset: SpriteAssetData | null = null;
  m_defaultSpriteAsset: SpriteAssetData | null = null;
  m_currentMaterialIndex = 0;
  m_currentFontSize = 0;
  m_fontScaleMultiplier = 1;
  m_FontStyleInternal: FontStyles = 0 as FontStyles;
  m_FontWeightInternal: FontWeight = FontWeight.Regular;
  m_fontStyleStack = new TmpFontStyleStack();
  m_FontWeightStack = new TmpTextProcessingStack<number>(8);
  m_sizeStack = new TmpTextProcessingStack<number>(16);
  m_indentStack = new TmpTextProcessingStack<number>(8);
  m_baselineOffsetStack = new TmpTextProcessingStack<number>(8);
  m_actionStack = new TmpTextProcessingStack<number>(8);
  m_colorStack = new TmpTextProcessingStack<Color32>(8);
  m_underlineColorStack = new TmpTextProcessingStack<Color32>(8);
  m_strikethroughColorStack = new TmpTextProcessingStack<Color32>(8);
  m_HighlightStateStack = new TmpTextProcessingStack<HighlightState>(8);
  m_colorGradientStack = new TmpTextProcessingStack<ColorGradientData | null>(8);
  m_ItalicAngleStack = new TmpTextProcessingStack<number>(8);
  m_materialReferenceStack = new TmpTextProcessingStack<MaterialReference>(16);
  m_lineJustificationStack = new TmpTextProcessingStack<HorizontalAlignmentOptions>(8);
  m_TextStyleStacks: TmpTextProcessingStack<number>[] = [];
  m_TextStyleStackDepth = 0;
  m_ItalicAngle = 0;
  m_htmlColor: Color32 = s_colorWhite;
  m_underlineColor: Color32 = s_colorWhite;
  m_strikethroughColor: Color32 = s_colorWhite;
  m_HighlightState: HighlightState = highlightState(s_colorWhite, tmpOffset());
  m_colorGradientPreset: ColorGradientData | null = null;
  m_colorGradientPresetIsTinted = false;
  m_isUsingBold = false;
  m_isTextLayoutPhase = false;
  m_isCalculatingPreferredValues = false;
  m_textElementType: TmpTextElementType = TmpTextElementType.Character;
  m_cached_TextElement: TextElementData | null = null;
  m_spriteIndex = 0;
  m_spriteColor: Color32 = s_colorWhite;
  m_tintSprite = false;
  m_FXScale: Vec3 = { x: 1, y: 1, z: 1 };
  /** 只用 z 旋轉：存角度（度）。identity 用 null 表示（Quaternion.identity） */
  m_FXRotationAngle: number | null = null;
  m_lineOffset = 0;
  m_lineHeight = TMP_MATH.FLOAT_UNSET;
  m_lineSpacingDelta = 0;
  m_cSpacing = 0;
  m_monoSpacing = 0;
  m_duoSpace = false;
  m_xAdvance = 0;
  tag_LineIndent = 0;
  tag_Indent = 0;
  tag_NoParsing = false;
  m_isNonBreakingSpace = false;
  m_isIgnoringAlignment = false;
  m_characterCount = 0;
  m_totalCharacterCount = 0;
  m_firstCharacterOfLine = 0;
  m_lastCharacterOfLine = 0;
  m_firstVisibleCharacterOfLine = 0;
  m_lastVisibleCharacterOfLine = 0;
  m_maxLineAscender = k_LargeNegativeFloat;
  m_maxLineDescender = k_LargePositiveFloat;
  m_lineNumber = 0;
  m_startOfLineAscender = 0;
  m_startOfLineDescender = 0;
  m_lineVisibleCharacterCount = 0;
  m_lineVisibleSpaceCount = 0;
  m_IsDrivenLineSpacing = false;
  m_firstOverflowCharacterIndex = -1;
  m_LastBaseGlyphIndex = -2147483648;
  m_pageNumber = 0;
  m_marginLeft = 0;
  m_marginRight = 0;
  m_width = -1;
  m_marginWidth = 0;
  m_marginHeight = 0;
  m_meshExtents: Extents = extents();
  m_maxCapHeight = 0;
  m_maxTextAscender = 0;
  m_ElementDescender = 0;
  m_PageAscender = 0;
  m_isNewPage = false;
  m_preferredWidth = 0;
  m_preferredHeight = 0;
  m_RenderedWidth = 0;
  m_RenderedHeight = 0;
  m_isTextTruncated = false;
  m_IsAutoSizePointSizeSet = false;
  m_AutoSizeIterationCount = 0;
  m_minFontSize = 0;
  m_maxFontSize = 0;
  m_charWidthAdjDelta = 0;
  m_baselineOffset = 0;
  m_spriteCount = 0;
  m_spriteAnimationID = 0;
  m_previousLossyScaleY = 1;
  m_ConvertToLinearSpace = false;

  m_textInfo = new TmpTextInfo();
  m_internalCharacterInfo: TmpCharacterInfo[] = [];
  m_TextProcessingArray: TextProcessingElement[] = [];
  m_InternalTextProcessingArraySize = 0;
  m_TextBackingArray = new TextBackingContainer();
  m_materialReferences: MaterialReference[] = [];
  m_materialReferenceIndexLookup = new Map<number, number>();
  m_SavedWordWrapState = new WordWrapState();
  m_SavedLineState = new WordWrapState();
  m_SavedEllipsisState = new WordWrapState();
  m_SavedLastValidState = new WordWrapState();
  m_SavedSoftLineBreakState = new WordWrapState();
  m_EllipsisInsertionCandidateStack = new TmpTextProcessingStack<WordWrapState>(8, 8);
  m_Underline = new SpecialCharacter();
  m_Ellipsis = new SpecialCharacter();
  m_xmlAttribute: RichTextTagAttribute[] = Array.from({ length: 8 }, () => ({ nameHashCode: 0, valueHashCode: 0, valueType: 0, valueStartIndex: 0, valueLength: 0, unitType: 0 }));
  m_attributeParameterValues: number[] = new Array(16).fill(0);
  m_htmlTag: string[] = new Array(128).fill('\0');

  /** TMP_SubMeshUI/TMP_SubMesh 的對應：每個 materialReference 的子網格 padding */
  m_subObjectPadding = new Map<number, number>();

  /** 元件的 RectTransform 四角（GetTextContainerLocalCorners）與排版上下文 */
  ctx: TextContext | null = null;
  m_RectTransformCorners: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 0 },
  ];

  constructor(init: TextObjectInit, assets: TextAssets, warnings?: string[]) {
    this.ui = init.ui;
    this.assets = assets;
    this.warnings = warnings ?? warningsOf(assets);
    const d = init.data;

    this.m_text = (d.m_text as string) ?? '';
    this.m_isRightToLeft = !!d.m_isRightToLeft;
    this.m_fontAssetRef = (d.m_fontAsset as ExternalRef | null)?.guid ? (d.m_fontAsset as ExternalRef) : null;
    this.m_sharedMaterialRef = (d.m_sharedMaterial as ExternalRef | null)?.guid ? (d.m_sharedMaterial as ExternalRef) : null;
    this.m_fontColor = (d.m_fontColor as { r: number; g: number; b: number; a: number }) ?? { r: 1, g: 1, b: 1, a: 1 };
    this.m_fontColor32 = colorToColor32(this.m_fontColor);
    this.m_enableVertexGradient = !!d.m_enableVertexGradient;
    this.m_colorMode = (d.m_colorMode as number) ?? 0;
    const grad = (d.m_fontColorGradient ?? {}) as RawObject;
    const gc = (c: unknown): Color32 => {
      const o = (c ?? {}) as { r?: number; g?: number; b?: number; a?: number };
      return colorToColor32({ r: o.r ?? 1, g: o.g ?? 1, b: o.b ?? 1, a: o.a ?? 1 });
    };
    this.m_fontColorGradient = { topLeft: gc(grad.topLeft), topRight: gc(grad.topRight), bottomLeft: gc(grad.bottomLeft), bottomRight: gc(grad.bottomRight) };
    this.m_fontColorGradientPresetRef = (d.m_fontColorGradientPreset as ExternalRef | null)?.guid ? (d.m_fontColorGradientPreset as ExternalRef) : null;
    this.m_spriteAssetRef = (d.m_spriteAsset as ExternalRef | null)?.guid ? (d.m_spriteAsset as ExternalRef) : null;
    this.m_tintAllSprites = !!d.m_tintAllSprites;
    this.m_StyleSheetRef = (d.m_StyleSheet as ExternalRef | null)?.guid ? (d.m_StyleSheet as ExternalRef) : null;
    this.m_TextStyleHashCode = (d.m_TextStyleHashCode as number) ?? -1183493901;
    this.m_overrideHtmlColors = !!d.m_overrideHtmlColors;
    const fc = (d.m_faceColor ?? {}) as { rgba?: number };
    this.m_faceColor = fc.rgba !== undefined ? color32(fc.rgba & 0xff, (fc.rgba >>> 8) & 0xff, (fc.rgba >>> 16) & 0xff, (fc.rgba >>> 24) & 0xff) : s_colorWhite;
    this.m_fontSize = (d.m_fontSize as number) ?? 36;
    this.m_fontSizeBase = (d.m_fontSizeBase as number) ?? this.m_fontSize;
    this.m_fontWeight = ((d.m_fontWeight as number) ?? 400) as FontWeight;
    this.m_enableAutoSizing = !!d.m_enableAutoSizing;
    this.m_fontSizeMin = (d.m_fontSizeMin as number) ?? 18;
    this.m_fontSizeMax = (d.m_fontSizeMax as number) ?? 72;
    this.m_fontStyle = ((d.m_fontStyle as number) ?? 0) as FontStyles;
    this.m_HorizontalAlignment = ((d.m_HorizontalAlignment as number) ?? 1) as HorizontalAlignmentOptions;
    this.m_VerticalAlignment = ((d.m_VerticalAlignment as number) ?? 0x100) as VerticalAlignmentOptions;
    this.m_textAlignment = (d.m_textAlignment as number) ?? 65535;
    this.m_characterSpacing = (d.m_characterSpacing as number) ?? 0;
    this.m_wordSpacing = (d.m_wordSpacing as number) ?? 0;
    this.m_lineSpacing = (d.m_lineSpacing as number) ?? 0;
    this.m_lineSpacingMax = (d.m_lineSpacingMax as number) ?? 0;
    this.m_paragraphSpacing = (d.m_paragraphSpacing as number) ?? 0;
    this.m_charWidthMaxAdj = (d.m_charWidthMaxAdj as number) ?? 0;
    // TMP 3.0 的元件沒有 m_TextWrappingMode，只有布林的 m_enableWordWrapping（MT2 的 Unity.TextMeshPro.dll 是 3.0 系列）。
    // 3.2 的欄位是 [FormerlySerializedAs("m_enableWordWrapping")]（TMP_Text.cs:746），舊資料的 0／1 照數值讀成 NoWrap／Normal；
    // 3.0 的 GenerateTextMesh 與 CalculatePreferredValues 也只分開、關兩種。以前沒有 m_TextWrappingMode 一律當 Normal，MT2 關掉換行的元件都會換行
    this.m_TextWrappingMode = Number(d.m_TextWrappingMode ?? d.m_enableWordWrapping ?? TextWrappingModes.Normal) as TextWrappingModes;
    this.m_wordWrappingRatios = (d.m_wordWrappingRatios as number) ?? 0.4;
    this.m_overflowMode = ((d.m_overflowMode as number) ?? 0) as TextOverflowModes;
    this.m_linkedTextComponentRef = (d.m_linkedTextComponent as ExternalRef | null)?.guid ? (d.m_linkedTextComponent as ExternalRef) : null;
    this.m_enableKerning = d.m_enableKerning !== undefined ? !!d.m_enableKerning : true;
    // TMP 3.0 的元件沒有 m_ActiveFontFeatures（3.2 才有；MT2 的 Unity.TextMeshPro.dll 沒有這個欄位），GenerateTextMesh 的字距調整看 m_enableKerning。
    // 以前當成空清單：產生網格不做字距調整、偏好尺寸有做，ContentSizeFitter 給的寬度比實際排的窄（關鍵字提示框的標題「圖示 Valor」被擠成兩行）
    this.m_ActiveFontFeatures = d.m_ActiveFontFeatures === undefined ? (this.m_enableKerning ? [OTL_FeatureTag.kern] : []) : parseActiveFontFeatures(d.m_ActiveFontFeatures);
    this.m_enableExtraPadding = !!d.m_enableExtraPadding;
    this.m_isRichText = d.m_isRichText !== undefined ? !!d.m_isRichText : true;
    this.m_EmojiFallbackSupport = d.m_EmojiFallbackSupport !== undefined ? !!d.m_EmojiFallbackSupport : true;
    this.m_parseCtrlCharacters = d.m_parseCtrlCharacters !== undefined ? !!d.m_parseCtrlCharacters : true;
    this.m_isOrthographic = d.m_isOrthographic !== undefined ? !!d.m_isOrthographic : true;
    this.m_horizontalMapping = ((d.m_horizontalMapping as number) ?? 0) as TextureMappingOptions;
    this.m_verticalMapping = ((d.m_verticalMapping as number) ?? 0) as TextureMappingOptions;
    this.m_uvLineOffset = (d.m_uvLineOffset as number) ?? 0;
    this.m_geometrySortingOrder = (d.m_geometrySortingOrder as number) ?? 0;
    this.m_IsTextObjectScaleStatic = !!d.m_IsTextObjectScaleStatic;
    this.m_VertexBufferAutoSizeReduction = !!d.m_VertexBufferAutoSizeReduction;
    this.m_useMaxVisibleDescender = d.m_useMaxVisibleDescender !== undefined ? !!d.m_useMaxVisibleDescender : true;
    this.m_pageToDisplay = (d.m_pageToDisplay as number) ?? 1;
    // 沒序列化、腳本設的（TMP_Text.firstVisibleCharacter／maxVisibleCharacters／maxVisibleLines，相容層 unityTmp.ts 寫進元件資料）
    this.m_firstVisibleCharacter = (d.m_firstVisibleCharacter as number) ?? 0;
    this.m_maxVisibleCharacters = (d.m_maxVisibleCharacters as number) ?? 99999;
    this.m_maxVisibleLines = (d.m_maxVisibleLines as number) ?? 99999;
    this.m_margin = (d.m_margin as { x: number; y: number; z: number; w: number }) ?? { x: 0, y: 0, z: 0, w: 0 };
    this.m_isUsingLegacyAnimationComponent = !!d.m_isUsingLegacyAnimationComponent;
    this.m_isVolumetricText = !!d.m_isVolumetricText;

    for (let i = 0; i < 8; i++) this.m_TextStyleStacks.push(new TmpTextProcessingStack<number>(0));
  }

  get settings(): SettingsData {
    return getSettings(this.assets);
  }

  /** LoadDefaultSettings 的文字對齊轉換（TMP_Text.cs:5949）：m_textAlignment 65535 = Converted 就不用轉 */
  applyAlignmentConversion(): void {
    if (this.m_textAlignment !== 65535) {
      this.m_HorizontalAlignment = (this.m_textAlignment & 0xff) as HorizontalAlignmentOptions;
      this.m_VerticalAlignment = (this.m_textAlignment & 0xff00) as VerticalAlignmentOptions;
      this.m_textAlignment = 65535;
    }
  }

  /** textStyle（TMP_Text.cs:362） */
  get textStyle(): StyleData {
    let style = this.getStyle(this.m_TextStyleHashCode);
    if (style == null) {
      style = { name: 'Normal', hashCode: getHashCode('Normal'), styleOpeningTagArray: [], styleClosingTagArray: [] };
      this.m_TextStyleHashCode = style.hashCode;
    }
    return style;
  }

  /** GetStyle（TMP_Text.cs:2809） */
  private getStyle(hashCode: number): StyleData | null {
    if (this.m_StyleSheet == null && this.m_StyleSheetRef) this.m_StyleSheet = getStyleSheet(this.assets, this.m_StyleSheetRef);
    if (this.m_StyleSheet != null) {
      const style = this.m_StyleSheet.getStyle(hashCode);
      if (style != null) return style;
    }
    const settings = this.settings;
    const defaultSheet = getStyleSheet(this.assets, settings.defaultStyleSheetRef);
    if (defaultSheet != null) return defaultSheet.getStyle(hashCode);
    return null;
  }

  // ════════════════════════ 文字解析（TMP_Text.cs） ════════════════════════

  /** ParseInputText（TMP_Text.cs:1990）：只走 TextString 路徑（元件的 m_text） */
  parseInputText(): void {
    this.populateTextBackingArray(this.m_text, 0, this.m_text.length);
    this.populateTextProcessingArray();
    this.setArraySizes(this.m_TextProcessingArray);
  }

  /** PopulateTextBackingArray(string)（TMP_Text.cs:2030） */
  private populateTextBackingArray(sourceText: string | null, start: number, length: number): void {
    let readIndex: number;
    let writeIndex = 0;

    if (sourceText == null) {
      readIndex = 0;
      length = 0;
    } else {
      readIndex = clamp(start, 0, sourceText.length);
      length = clamp(length, 0, start + length < sourceText.length ? length : sourceText.length - start);
    }

    if (length >= this.m_TextBackingArray.capacity) this.m_TextBackingArray.resize(length);

    const end = readIndex + length;
    for (; readIndex < end; readIndex++) {
      this.m_TextBackingArray.set(writeIndex, sourceText!.charCodeAt(readIndex));
      writeIndex += 1;
    }

    this.m_TextBackingArray.set(writeIndex, 0);
    this.m_TextBackingArray.count = writeIndex;
  }

  /** PopulateTextProcessingArray（TMP_Text.cs:2144） */
  private populateTextProcessingArray(): void {
    const srcLength = this.m_TextBackingArray.count;

    if (this.m_TextProcessingArray.length < srcLength) this.resizeTextProcessingArray(srcLength);

    // Reset Style stack back to default
    for (const s of this.m_TextStyleStacks) s.setDefault(0);

    this.m_TextStyleStackDepth = 0;
    let writeIndex = 0;

    // Insert Opening Style
    if (this.textStyle.hashCode !== MarkupTag.NORMAL) writeIndex = this.insertOpeningStyleTagRet(this.textStyle, writeIndex);

    this.tag_NoParsing = false;

    let readIndex = 0;
    for (; readIndex < srcLength; readIndex++) {
      const c = this.m_TextBackingArray.get(readIndex);

      if (c === 0) break;

      if (c === 0x5c /* \ */ && readIndex < srcLength - 1) {
        const next = this.m_TextBackingArray.get(readIndex + 1);
        if (next === 92) {
          // \\ escape
          if (!this.m_parseCtrlCharacters) {
            // fall through（原版的 break 是跳出 switch，不是跳過這個字元）
          } else {
            readIndex += 1;
            // 繼續把第二個 backslash 當字元寫入
            this.ensureTextProcessingArray(writeIndex);
            this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 1, unicode: 92 };
            writeIndex += 1;
            continue;
          }
        } else if (next === 110) {
          // \n LineFeed
          if (this.m_parseCtrlCharacters) {
            this.ensureTextProcessingArray(writeIndex);
            this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 1, unicode: 10 };
            readIndex += 1;
            writeIndex += 1;
            continue;
          }
        } else if (next === 114) {
          // \r Carriage Return
          if (this.m_parseCtrlCharacters) {
            this.ensureTextProcessingArray(writeIndex);
            this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 1, unicode: 13 };
            readIndex += 1;
            writeIndex += 1;
            continue;
          }
        } else if (next === 116) {
          // \t Tab
          if (this.m_parseCtrlCharacters) {
            this.ensureTextProcessingArray(writeIndex);
            this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 1, unicode: 9 };
            readIndex += 1;
            writeIndex += 1;
            continue;
          }
        } else if (next === 118) {
          // \v Vertical tab used as soft line break
          if (this.m_parseCtrlCharacters) {
            this.ensureTextProcessingArray(writeIndex);
            this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 1, unicode: 11 };
            readIndex += 1;
            writeIndex += 1;
            continue;
          }
        } else if (next === 117) {
          // \u0000 for UTF-16 Unicode
          if (srcLength > readIndex + 5 && this.isValidUTF16(readIndex + 2)) {
            this.ensureTextProcessingArray(writeIndex);
            this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 6, unicode: this.getUTF16(readIndex + 2) };
            readIndex += 5;
            writeIndex += 1;
            continue;
          }
        } else if (next === 85) {
          // \U00000000 for UTF-32 Unicode
          if (srcLength > readIndex + 9 && this.isValidUTF32(readIndex + 2)) {
            this.ensureTextProcessingArray(writeIndex);
            this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 10, unicode: this.getUTF32(readIndex + 2) };
            readIndex += 9;
            writeIndex += 1;
            continue;
          }
        }
      }

      // Handle surrogate pair conversion
      if (c >= CodePoint.HIGH_SURROGATE_START && c <= CodePoint.HIGH_SURROGATE_END && srcLength > readIndex + 1 && this.m_TextBackingArray.get(readIndex + 1) >= CodePoint.LOW_SURROGATE_START && this.m_TextBackingArray.get(readIndex + 1) <= CodePoint.LOW_SURROGATE_END) {
        this.ensureTextProcessingArray(writeIndex);
        this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 2, unicode: convertToUTF32(c, this.m_TextBackingArray.get(readIndex + 1)) };
        readIndex += 1;
        writeIndex += 1;
        continue;
      }

      // Handle inline replacement of <style> and <br> tags.
      if (c === 0x3c /* < */ && this.m_isRichText) {
        const hashCode = this.getMarkupTagHashCodeBacking(readIndex + 1);

        switch (hashCode as MarkupTag) {
          case MarkupTag.NO_PARSE:
            this.tag_NoParsing = true;
            break;
          case MarkupTag.SLASH_NO_PARSE:
            this.tag_NoParsing = false;
            break;
          case MarkupTag.BR:
            if (!this.tag_NoParsing) {
              this.ensureTextProcessingArray(writeIndex);
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 4, unicode: 10 };
              writeIndex += 1;
              readIndex += 3;
              continue;
            }
            break;
          case MarkupTag.CR:
            if (!this.tag_NoParsing) {
              this.ensureTextProcessingArray(writeIndex);
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 4, unicode: 13 };
              writeIndex += 1;
              readIndex += 3;
              continue;
            }
            break;
          case MarkupTag.NBSP:
            if (!this.tag_NoParsing) {
              this.ensureTextProcessingArray(writeIndex);
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 6, unicode: 0xa0 };
              writeIndex += 1;
              readIndex += 5;
              continue;
            }
            break;
          case MarkupTag.ZWSP:
            if (!this.tag_NoParsing) {
              this.ensureTextProcessingArray(writeIndex);
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 6, unicode: 0x200b };
              writeIndex += 1;
              readIndex += 5;
              continue;
            }
            break;
          case MarkupTag.ZWJ:
            if (!this.tag_NoParsing) {
              this.ensureTextProcessingArray(writeIndex);
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 5, unicode: 0x200d };
              writeIndex += 1;
              readIndex += 4;
              continue;
            }
            break;
          case MarkupTag.SHY:
            if (!this.tag_NoParsing) {
              this.ensureTextProcessingArray(writeIndex);
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 5, unicode: 0xad };
              writeIndex += 1;
              readIndex += 4;
              continue;
            }
            break;
          case MarkupTag.A: {
            // Additional check
            if (this.m_TextBackingArray.count > readIndex + 4 && this.m_TextBackingArray.get(readIndex + 3) === 0x68 /* h */ && this.m_TextBackingArray.get(readIndex + 4) === 0x72 /* r */) {
              writeIndex = this.insertOpeningTextStyle(this.getStyle(MarkupTag.A), writeIndex);
            }
            break;
          }
          case MarkupTag.STYLE:
            if (!this.tag_NoParsing) {
              let openWriteIndex = writeIndex;
              const result = this.replaceOpeningStyleTag(readIndex, writeIndex);
              if (result) {
                // Update potential text elements added by the opening style.
                for (; openWriteIndex < result.writeIndex; openWriteIndex++) {
                  this.m_TextProcessingArray[openWriteIndex].stringIndex = readIndex;
                  this.m_TextProcessingArray[openWriteIndex].length = result.srcOffset - readIndex + 1;
                }
                readIndex = result.srcOffset;
                writeIndex = result.writeIndex;
                continue;
              }
            }
            break;
          case MarkupTag.SLASH_A:
            writeIndex = this.insertClosingTextStyle(this.getStyle(MarkupTag.A), writeIndex);
            break;
          case MarkupTag.SLASH_STYLE:
            if (!this.tag_NoParsing) {
              let closeWriteIndex = writeIndex;
              writeIndex = this.replaceClosingStyleTag(writeIndex);

              // Update potential text elements added by the closing style.
              for (; closeWriteIndex < writeIndex; closeWriteIndex++) {
                this.m_TextProcessingArray[closeWriteIndex].stringIndex = readIndex;
                this.m_TextProcessingArray[closeWriteIndex].length = 8;
              }

              readIndex += 7;
              continue;
            }
            break;
        }
      }

      // Lookup character and glyph data
      this.ensureTextProcessingArray(writeIndex);
      this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: readIndex, length: 1, unicode: c };
      writeIndex += 1;
    }

    this.m_TextStyleStackDepth = 0;

    // Insert Closing Style
    if (this.textStyle.hashCode !== MarkupTag.NORMAL) writeIndex = this.insertClosingStyleTag(writeIndex);

    this.ensureTextProcessingArray(writeIndex);
    this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.Undefined, stringIndex: 0, length: 0, unicode: 0 };
    this.m_InternalTextProcessingArraySize = writeIndex;
  }

  private resizeTextProcessingArray(size: number): void {
    const newSize = nextPowerOfTwo(size + 1);
    while (this.m_TextProcessingArray.length < newSize) this.m_TextProcessingArray.push({ elementType: TextProcessingElementType.Undefined, stringIndex: 0, length: 0, unicode: 0 });
  }

  private ensureTextProcessingArray(writeIndex: number): void {
    if (writeIndex >= this.m_TextProcessingArray.length) this.resizeTextProcessingArray(writeIndex);
  }

  /** GetMarkupTagHashCode(TextBackingContainer)（TMP_Text.cs:3169） */
  private getMarkupTagHashCodeBacking(readIndex: number): number {
    let hashCode = 0;
    const maxReadIndex = readIndex + 16;
    const styleDefinitionLength = this.m_TextBackingArray.capacity;

    for (; readIndex < maxReadIndex && readIndex < styleDefinitionLength; readIndex++) {
      const c = this.m_TextBackingArray.get(readIndex);
      if (c === 0x3e /* > */ || c === 0x3d /* = */ || c === 0x20) return hashCode;
      hashCode = (Math.imul(hashCode, 33) ^ toUpperFast(c)) | 0;
    }
    return hashCode;
  }

  /** GetMarkupTagHashCode(uint[])（TMP_Text.cs:3144）：style 定義陣列用 */
  private getMarkupTagHashCodeArray(styleDefinition: number[], readIndex: number): number {
    let hashCode = 0;
    const maxReadIndex = readIndex + 16;
    const styleDefinitionLength = styleDefinition.length;

    for (; readIndex < maxReadIndex && readIndex < styleDefinitionLength; readIndex++) {
      const c = styleDefinition[readIndex];
      if (c === 0x3e || c === 0x3d || c === 0x20) return hashCode;
      hashCode = (Math.imul(hashCode, 33) ^ toUpperFast(c)) | 0;
    }
    return hashCode;
  }

  /** GetStyleHashCode(TextBackingContainer)（TMP_Text.cs:3221） */
  private getStyleHashCode(index: number): { hashCode: number; closeIndex: number } {
    let hashCode = 0;
    let closeIndex = 0;
    for (let i = index; i < this.m_TextBackingArray.capacity; i++) {
      const c = this.m_TextBackingArray.get(i);
      if (c === 34) continue;
      if (c === 62) {
        closeIndex = i;
        break;
      }
      hashCode = (Math.imul(hashCode, 33) ^ toUpperFast(c)) | 0;
    }
    return { hashCode, closeIndex };
  }

  /** GetStyleHashCode(uint[])（TMP_Text.cs:3195） */
  private getStyleHashCodeArray(text: number[], index: number): { hashCode: number; closeIndex: number } {
    let hashCode = 0;
    let closeIndex = 0;
    for (let i = index; i < text.length; i++) {
      if (text[i] === 34) continue;
      if (text[i] === 62) {
        closeIndex = i;
        break;
      }
      hashCode = (Math.imul(hashCode, 33) ^ toUpperFast(text[i])) | 0;
    }
    return { hashCode, closeIndex };
  }

  /** InsertOpeningStyleTag（TMP_Text.cs:3104）。回傳新的 writeIndex */
  private insertOpeningStyleTagRet(style: StyleData, writeIndex: number): number {
    if (style == null) return writeIndex;
    this.m_TextStyleStacks[0].push(style.hashCode);
    writeIndex = this.insertTextStyleInTextProcessingArray(writeIndex, style.styleOpeningTagArray);
    this.m_TextStyleStackDepth = 0;
    return writeIndex;
  }

  /** InsertClosingStyleTag（TMP_Text.cs:3124） */
  private insertClosingStyleTag(writeIndex: number): number {
    const styleHashCode = this.m_TextStyleStacks[0].pop() ?? 0;
    const style = this.getStyle(styleHashCode);
    if (style == null) return writeIndex;
    writeIndex = this.insertTextStyleInTextProcessingArray(writeIndex, style.styleClosingTagArray);
    this.m_TextStyleStackDepth = 0;
    return writeIndex;
  }

  /** InsertOpeningTextStyle（TMP_Text.cs:2828）：<a> 之類，帶 depth */
  private insertOpeningTextStyle(style: StyleData | null, writeIndex: number): number {
    if (style == null) return writeIndex;
    this.m_TextStyleStackDepth += 1;
    this.m_TextStyleStacks[this.m_TextStyleStackDepth].push(style.hashCode);
    writeIndex = this.insertTextStyleInTextProcessingArray(writeIndex, style.styleOpeningTagArray);
    this.m_TextStyleStackDepth -= 1;
    return writeIndex;
  }

  /** InsertClosingTextStyle（TMP_Text.cs:2844） */
  private insertClosingTextStyle(style: StyleData | null, writeIndex: number): number {
    if (style == null) return writeIndex;
    this.m_TextStyleStackDepth += 1;
    this.m_TextStyleStacks[this.m_TextStyleStackDepth].push(style.hashCode);
    writeIndex = this.insertTextStyleInTextProcessingArray(writeIndex, style.styleClosingTagArray);
    this.m_TextStyleStackDepth -= 1;
    return writeIndex;
  }

  /** InsertTextStyleInTextProcessingArray（TMP_Text.cs:2860） */
  private insertTextStyleInTextProcessingArray(writeIndex: number, styleDefinition: number[]): number {
    const styleLength = styleDefinition.length;

    this.ensureTextProcessingArray(writeIndex + styleLength);

    for (let i = 0; i < styleLength; i++) {
      let c = styleDefinition[i];

      if (c === 0x5c /* \ */ && i + 1 < styleLength) {
        switch (styleDefinition[i + 1]) {
          case 0x5c:
            i += 1;
            break;
          case 0x6e: // n
            c = 10;
            i += 1;
            break;
          case 0x72: // r
            break;
          case 0x74: // t
            break;
          case 0x75: // u
            if (i + 5 < styleLength) {
              c = this.getUTF16Array(styleDefinition, i + 2);
              i += 5;
            }
            break;
          case 0x55: // U
            if (i + 9 < styleLength) {
              c = this.getUTF32Array(styleDefinition, i + 2);
              i += 9;
            }
            break;
        }
      }

      if (c === 0x3c /* < */) {
        const hashCode = this.getMarkupTagHashCodeArray(styleDefinition, i + 1);

        switch (hashCode as MarkupTag) {
          case MarkupTag.NO_PARSE:
            this.tag_NoParsing = true;
            break;
          case MarkupTag.SLASH_NO_PARSE:
            this.tag_NoParsing = false;
            break;
          case MarkupTag.BR:
            if (!this.tag_NoParsing) {
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: 0, length: 0, unicode: 10 };
              writeIndex += 1;
              i += 3;
              continue;
            }
            break;
          case MarkupTag.CR:
            if (!this.tag_NoParsing) {
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: 0, length: 0, unicode: 13 };
              writeIndex += 1;
              i += 3;
              continue;
            }
            break;
          case MarkupTag.NBSP:
            if (!this.tag_NoParsing) {
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: 0, length: 0, unicode: 160 };
              writeIndex += 1;
              i += 5;
              continue;
            }
            break;
          case MarkupTag.ZWSP:
            if (!this.tag_NoParsing) {
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: 0, length: 0, unicode: 0x200b };
              writeIndex += 1;
              i += 5;
              continue;
            }
            break;
          case MarkupTag.ZWJ:
            if (!this.tag_NoParsing) {
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: 0, length: 0, unicode: 0x200d };
              writeIndex += 1;
              i += 4;
              continue;
            }
            break;
          case MarkupTag.SHY:
            if (!this.tag_NoParsing) {
              this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: 0, length: 0, unicode: 0xad };
              writeIndex += 1;
              i += 4;
              continue;
            }
            break;
          case MarkupTag.STYLE:
            if (!this.tag_NoParsing) {
              const result = this.replaceOpeningStyleTagArray(styleDefinition, i, writeIndex);
              if (result) {
                i = result.srcOffset;
                writeIndex = result.writeIndex;
                continue;
              }
            }
            break;
          case MarkupTag.SLASH_STYLE:
            if (!this.tag_NoParsing) {
              writeIndex = this.replaceClosingStyleTag(writeIndex);
              i += 7;
              continue;
            }
            break;
        }
      }

      this.m_TextProcessingArray[writeIndex] = { elementType: TextProcessingElementType.TextCharacterElement, stringIndex: 0, length: 0, unicode: c };
      writeIndex += 1;
    }
    return writeIndex;
  }

  /** ReplaceOpeningStyleTag(TextBackingContainer)（TMP_Text.cs:3009）。回傳 null 表示 style 無效 */
  private replaceOpeningStyleTag(srcIndex: number, writeIndex: number): { srcOffset: number; writeIndex: number } | null {
    const { hashCode: styleHashCode, closeIndex: srcOffset } = this.getStyleHashCode(srcIndex + 7);
    const style = this.getStyle(styleHashCode);

    if (style == null || srcOffset === 0) return null;

    this.m_TextStyleStackDepth += 1;
    this.m_TextStyleStacks[this.m_TextStyleStackDepth].push(style.hashCode);

    writeIndex = this.insertTextStyleInTextProcessingArray(writeIndex, style.styleOpeningTagArray);

    this.m_TextStyleStackDepth -= 1;

    return { srcOffset, writeIndex };
  }

  /** ReplaceOpeningStyleTag(uint[])（TMP_Text.cs:3043）：style 定義裡又巢狀 <style> */
  private replaceOpeningStyleTagArray(sourceText: number[], srcIndex: number, writeIndex: number): { srcOffset: number; writeIndex: number } | null {
    const { hashCode: styleHashCode, closeIndex: srcOffset } = this.getStyleHashCodeArray(sourceText, srcIndex + 7);
    const style = this.getStyle(styleHashCode);

    if (style == null || srcOffset === 0) return null;

    this.m_TextStyleStackDepth += 1;
    this.m_TextStyleStacks[this.m_TextStyleStackDepth].push(style.hashCode);

    writeIndex = this.insertTextStyleInTextProcessingArray(writeIndex, style.styleOpeningTagArray);

    this.m_TextStyleStackDepth -= 1;

    return { srcOffset, writeIndex };
  }

  /** ReplaceClosingStyleTag（TMP_Text.cs:3076） */
  private replaceClosingStyleTag(writeIndex: number): number {
    const styleHashCode = this.m_TextStyleStacks[this.m_TextStyleStackDepth + 1].pop() ?? 0;
    const style = this.getStyle(styleHashCode);

    if (style == null) return writeIndex;

    this.m_TextStyleStackDepth += 1;
    writeIndex = this.insertTextStyleInTextProcessingArray(writeIndex, style.styleClosingTagArray);
    this.m_TextStyleStackDepth -= 1;
    return writeIndex;
  }

  // ───────── 跳脫字元與 hex 工具 ─────────

  /** IsValidUTF16（TMP_Text.cs:6409） */
  private isValidUTF16(index: number): boolean {
    for (let i = 0; i < 4; i++) {
      const c = this.m_TextBackingArray.get(index + i);
      if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46))) return false;
    }
    return true;
  }

  /** GetUTF16(TextBackingContainer)（TMP_Text.cs:6431） */
  private getUTF16(i: number): number {
    return (hexToInt(this.m_TextBackingArray.get(i)) << 12) + (hexToInt(this.m_TextBackingArray.get(i + 1)) << 8) + (hexToInt(this.m_TextBackingArray.get(i + 2)) << 4) + hexToInt(this.m_TextBackingArray.get(i + 3));
  }

  private getUTF16Array(text: number[], i: number): number {
    return (hexToInt(text[i]) << 12) + (hexToInt(text[i + 1]) << 8) + (hexToInt(text[i + 2]) << 4) + hexToInt(text[i + 3]);
  }

  /** IsValidUTF32（TMP_Text.cs:6441） */
  private isValidUTF32(index: number): boolean {
    for (let i = 0; i < 8; i++) {
      const c = this.m_TextBackingArray.get(index + i);
      if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46))) return false;
    }
    return true;
  }

  /** GetUTF32(TextBackingContainer)（TMP_Text.cs:6467） */
  private getUTF32(i: number): number {
    return (
      (hexToInt(this.m_TextBackingArray.get(i)) << 28) + (hexToInt(this.m_TextBackingArray.get(i + 1)) << 24) + (hexToInt(this.m_TextBackingArray.get(i + 2)) << 20) + (hexToInt(this.m_TextBackingArray.get(i + 3)) << 16) +
      (hexToInt(this.m_TextBackingArray.get(i + 4)) << 12) + (hexToInt(this.m_TextBackingArray.get(i + 5)) << 8) + (hexToInt(this.m_TextBackingArray.get(i + 6)) << 4) + hexToInt(this.m_TextBackingArray.get(i + 7))
    ) >>> 0;
  }

  private getUTF32Array(text: number[], i: number): number {
    return (
      (hexToInt(text[i]) << 28) + (hexToInt(text[i + 1]) << 24) + (hexToInt(text[i + 2]) << 20) + (hexToInt(text[i + 3]) << 16) +
      (hexToInt(text[i + 4]) << 12) + (hexToInt(text[i + 5]) << 8) + (hexToInt(text[i + 6]) << 4) + hexToInt(text[i + 7])
    ) >>> 0;
  }

  /** HexCharsToColor(hexChars, tagCount)（TMP_Text.cs:6488） */
  protected hexCharsToColorByCount(hexChars: string[], tagCount: number): Color32 {
    if (tagCount === 4) {
      const r = hexToInt(hexChars[1].charCodeAt(0)) * 16 + hexToInt(hexChars[1].charCodeAt(0));
      const g = hexToInt(hexChars[2].charCodeAt(0)) * 16 + hexToInt(hexChars[2].charCodeAt(0));
      const b = hexToInt(hexChars[3].charCodeAt(0)) * 16 + hexToInt(hexChars[3].charCodeAt(0));
      return color32(r, g, b, 255);
    } else if (tagCount === 5) {
      const r = hexToInt(hexChars[1].charCodeAt(0)) * 16 + hexToInt(hexChars[1].charCodeAt(0));
      const g = hexToInt(hexChars[2].charCodeAt(0)) * 16 + hexToInt(hexChars[2].charCodeAt(0));
      const b = hexToInt(hexChars[3].charCodeAt(0)) * 16 + hexToInt(hexChars[3].charCodeAt(0));
      const a = hexToInt(hexChars[4].charCodeAt(0)) * 16 + hexToInt(hexChars[4].charCodeAt(0));
      return color32(r, g, b, a);
    } else if (tagCount === 7) {
      const r = hexToInt(hexChars[1].charCodeAt(0)) * 16 + hexToInt(hexChars[2].charCodeAt(0));
      const g = hexToInt(hexChars[3].charCodeAt(0)) * 16 + hexToInt(hexChars[4].charCodeAt(0));
      const b = hexToInt(hexChars[5].charCodeAt(0)) * 16 + hexToInt(hexChars[6].charCodeAt(0));
      return color32(r, g, b, 255);
    } else if (tagCount === 9) {
      const r = hexToInt(hexChars[1].charCodeAt(0)) * 16 + hexToInt(hexChars[2].charCodeAt(0));
      const g = hexToInt(hexChars[3].charCodeAt(0)) * 16 + hexToInt(hexChars[4].charCodeAt(0));
      const b = hexToInt(hexChars[5].charCodeAt(0)) * 16 + hexToInt(hexChars[6].charCodeAt(0));
      const a = hexToInt(hexChars[7].charCodeAt(0)) * 16 + hexToInt(hexChars[8].charCodeAt(0));
      return color32(r, g, b, a);
    } else if (tagCount === 10) {
      const r = hexToInt(hexChars[7].charCodeAt(0)) * 16 + hexToInt(hexChars[7].charCodeAt(0));
      const g = hexToInt(hexChars[8].charCodeAt(0)) * 16 + hexToInt(hexChars[8].charCodeAt(0));
      const b = hexToInt(hexChars[9].charCodeAt(0)) * 16 + hexToInt(hexChars[9].charCodeAt(0));
      return color32(r, g, b, 255);
    } else if (tagCount === 11) {
      const r = hexToInt(hexChars[7].charCodeAt(0)) * 16 + hexToInt(hexChars[7].charCodeAt(0));
      const g = hexToInt(hexChars[8].charCodeAt(0)) * 16 + hexToInt(hexChars[8].charCodeAt(0));
      const b = hexToInt(hexChars[9].charCodeAt(0)) * 16 + hexToInt(hexChars[9].charCodeAt(0));
      const a = hexToInt(hexChars[10].charCodeAt(0)) * 16 + hexToInt(hexChars[10].charCodeAt(0));
      return color32(r, g, b, a);
    } else if (tagCount === 13) {
      const r = hexToInt(hexChars[7].charCodeAt(0)) * 16 + hexToInt(hexChars[8].charCodeAt(0));
      const g = hexToInt(hexChars[9].charCodeAt(0)) * 16 + hexToInt(hexChars[10].charCodeAt(0));
      const b = hexToInt(hexChars[11].charCodeAt(0)) * 16 + hexToInt(hexChars[12].charCodeAt(0));
      return color32(r, g, b, 255);
    } else if (tagCount === 15) {
      const r = hexToInt(hexChars[7].charCodeAt(0)) * 16 + hexToInt(hexChars[8].charCodeAt(0));
      const g = hexToInt(hexChars[9].charCodeAt(0)) * 16 + hexToInt(hexChars[10].charCodeAt(0));
      const b = hexToInt(hexChars[11].charCodeAt(0)) * 16 + hexToInt(hexChars[12].charCodeAt(0));
      const a = hexToInt(hexChars[13].charCodeAt(0)) * 16 + hexToInt(hexChars[14].charCodeAt(0));
      return color32(r, g, b, a);
    }
    return color32(255, 255, 255, 255);
  }

  /** HexCharsToColor(hexChars, startIndex, length)（TMP_Text.cs:6570） */
  protected hexCharsToColorByRange(hexChars: string[], startIndex: number, length: number): Color32 {
    if (length === 7) {
      const r = hexToInt(hexChars[startIndex + 1].charCodeAt(0)) * 16 + hexToInt(hexChars[startIndex + 2].charCodeAt(0));
      const g = hexToInt(hexChars[startIndex + 3].charCodeAt(0)) * 16 + hexToInt(hexChars[startIndex + 4].charCodeAt(0));
      const b = hexToInt(hexChars[startIndex + 5].charCodeAt(0)) * 16 + hexToInt(hexChars[startIndex + 6].charCodeAt(0));
      return color32(r, g, b, 255);
    } else if (length === 9) {
      const r = hexToInt(hexChars[startIndex + 1].charCodeAt(0)) * 16 + hexToInt(hexChars[startIndex + 2].charCodeAt(0));
      const g = hexToInt(hexChars[startIndex + 3].charCodeAt(0)) * 16 + hexToInt(hexChars[startIndex + 4].charCodeAt(0));
      const b = hexToInt(hexChars[startIndex + 5].charCodeAt(0)) * 16 + hexToInt(hexChars[startIndex + 6].charCodeAt(0));
      const a = hexToInt(hexChars[startIndex + 7].charCodeAt(0)) * 16 + hexToInt(hexChars[startIndex + 8].charCodeAt(0));
      return color32(r, g, b, a);
    }
    return { ...s_colorWhite };
  }

  /** GetAttributeParameters（TMP_Text.cs:6602） */
  protected getAttributeParameters(chars: string[], startIndex: number, length: number, parameters: number[]): number {
    let endIndex = startIndex;
    let attributeCount = 0;

    while (endIndex < startIndex + length) {
      const r = this.convertToFloatOut(chars, startIndex, length);
      parameters[attributeCount] = r.value;
      endIndex = r.lastIndex;

      length -= endIndex - startIndex + 1;
      startIndex = endIndex + 1;

      attributeCount += 1;
    }

    return attributeCount;
  }

  /** ConvertToFloat(chars, startIndex, length)（TMP_Text.cs:6628） */
  protected convertToFloat(chars: string[], startIndex: number, length: number): number {
    return this.convertToFloatOut(chars, startIndex, length).value;
  }

  /** ConvertToFloat(chars, startIndex, length, out lastIndex)（TMP_Text.cs:6644） */
  protected convertToFloatOut(chars: string[], startIndex: number, length: number): { value: number; lastIndex: number } {
    if (startIndex === 0) {
      return { value: -32768, lastIndex: 0 };
    }

    const endIndex = startIndex + length;

    let isIntegerValue = true;
    let decimalPointMultiplier = 0;

    let valueSignMultiplier = 1;
    if (chars[startIndex] === '+') {
      valueSignMultiplier = 1;
      startIndex += 1;
    } else if (chars[startIndex] === '-') {
      valueSignMultiplier = -1;
      startIndex += 1;
    }

    let value = 0;

    for (let i = startIndex; i < endIndex; i++) {
      const c = chars[i].charCodeAt(0);

      if ((c >= 0x30 && c <= 0x39) || c === 0x2e /* . */) {
        if (c === 0x2e) {
          isIntegerValue = false;
          decimalPointMultiplier = 0.1;
          continue;
        }

        if (isIntegerValue) value = f32(value * 10 + (c - 48) * valueSignMultiplier);
        else {
          value = f32(value + f32(f32((c - 48) * decimalPointMultiplier) * valueSignMultiplier));
          decimalPointMultiplier = f32(decimalPointMultiplier * 0.1);
        }

        continue;
      } else if (c === 0x2c /* , */) {
        const lastIndex = i + 1 < endIndex && chars[i + 1] === ' ' ? i + 1 : i;

        if (value > 32767) return { value: -32768, lastIndex };
        return { value, lastIndex };
      }
    }

    const lastIndex = endIndex;

    if (value > 32767) return { value: -32768, lastIndex };

    return { value, lastIndex };
  }

  /** ClearMarkupTagAttributes（TMP_Text.cs:6720） */
  protected clearMarkupTagAttributes(): void {
    for (let i = 0; i < this.m_xmlAttribute.length; i++) {
      this.m_xmlAttribute[i] = { nameHashCode: 0, valueHashCode: 0, valueType: 0, valueStartIndex: 0, valueLength: 0, unitType: 0 };
    }
  }

  // ════════════════════════ ValidateHtmlTag（TMP_Text.cs:6734–8337） ════════════════════════

  /**
   * ValidateHtmlTag（TMP_Text.cs:6734）。回傳 valid＋endIndex（C# 的 out 參數）。
   * m_htmlTag 是 tag 內容的字元陣列（去掉 '<'，到 '>' 為止），屬性解析進 m_xmlAttribute。
   */
  validateHtmlTag(chars: TextProcessingElement[], startIndex: number): { valid: boolean; endIndex: number } {
    let tagCharCount = 0;
    let attributeFlag = 0;

    let attributeIndex = 0;
    this.clearMarkupTagAttributes();
    let tagValueType = TagValueType_None;
    let tagUnitType = TagUnitType_Pixels;

    let endIndex = startIndex;
    let isTagSet = false;
    let isValidHtmlTag = false;

    for (let i = startIndex; i < chars.length && chars[i].unicode !== 0 && tagCharCount < this.m_htmlTag.length && chars[i].unicode !== 0x3c /* < */; i++) {
      const unicode = chars[i].unicode;

      if (unicode === 0x3e /* > */) {
        isValidHtmlTag = true;
        endIndex = i;
        this.m_htmlTag[tagCharCount] = '\0';
        break;
      }

      this.m_htmlTag[tagCharCount] = String.fromCharCode(unicode);
      tagCharCount += 1;

      if (attributeFlag === 1) {
        if (tagValueType === TagValueType_None) {
          // Check for attribute type
          if (unicode === 0x2b /* + */ || unicode === 0x2d /* - */ || unicode === 0x2e /* . */ || (unicode >= 0x30 && unicode <= 0x39)) {
            tagUnitType = TagUnitType_Pixels;
            tagValueType = this.m_xmlAttribute[attributeIndex].valueType = TagValueType_NumericalValue;
            this.m_xmlAttribute[attributeIndex].valueStartIndex = tagCharCount - 1;
            this.m_xmlAttribute[attributeIndex].valueLength += 1;
          } else if (unicode === 0x23 /* # */) {
            tagUnitType = TagUnitType_Pixels;
            tagValueType = this.m_xmlAttribute[attributeIndex].valueType = TagValueType_ColorValue;
            this.m_xmlAttribute[attributeIndex].valueStartIndex = tagCharCount - 1;
            this.m_xmlAttribute[attributeIndex].valueLength += 1;
          } else if (unicode === 0x22 /* " */) {
            tagUnitType = TagUnitType_Pixels;
            tagValueType = this.m_xmlAttribute[attributeIndex].valueType = TagValueType_StringValue;
            this.m_xmlAttribute[attributeIndex].valueStartIndex = tagCharCount;
          } else {
            tagUnitType = TagUnitType_Pixels;
            tagValueType = this.m_xmlAttribute[attributeIndex].valueType = TagValueType_StringValue;
            this.m_xmlAttribute[attributeIndex].valueStartIndex = tagCharCount - 1;
            this.m_xmlAttribute[attributeIndex].valueHashCode = (Math.imul(this.m_xmlAttribute[attributeIndex].valueHashCode, 33) ^ toUpperFast(unicode)) | 0;
            this.m_xmlAttribute[attributeIndex].valueLength += 1;
          }
        } else {
          if (tagValueType === TagValueType_NumericalValue) {
            // Check for termination of numerical value.
            if (unicode === 0x70 /* p */ || unicode === 0x65 /* e */ || unicode === 0x25 /* % */ || unicode === 0x20) {
              attributeFlag = 2;
              tagValueType = TagValueType_None;

              switch (unicode) {
                case 0x65: // e
                  this.m_xmlAttribute[attributeIndex].unitType = tagUnitType = TagUnitType_FontUnits;
                  break;
                case 0x25: // %
                  this.m_xmlAttribute[attributeIndex].unitType = tagUnitType = TagUnitType_Percentage;
                  break;
                default:
                  this.m_xmlAttribute[attributeIndex].unitType = tagUnitType = TagUnitType_Pixels;
                  break;
              }

              attributeIndex += 1;
              this.m_xmlAttribute[attributeIndex].nameHashCode = 0;
              this.m_xmlAttribute[attributeIndex].valueHashCode = 0;
              this.m_xmlAttribute[attributeIndex].valueType = TagValueType_None;
              this.m_xmlAttribute[attributeIndex].unitType = TagUnitType_Pixels;
              this.m_xmlAttribute[attributeIndex].valueStartIndex = 0;
              this.m_xmlAttribute[attributeIndex].valueLength = 0;
            } else {
              this.m_xmlAttribute[attributeIndex].valueLength += 1;
            }
          } else if (tagValueType === TagValueType_ColorValue) {
            if (unicode !== 0x20) {
              this.m_xmlAttribute[attributeIndex].valueLength += 1;
            } else {
              attributeFlag = 2;
              tagValueType = TagValueType_None;
              tagUnitType = TagUnitType_Pixels;
              attributeIndex += 1;
              this.m_xmlAttribute[attributeIndex].nameHashCode = 0;
              this.m_xmlAttribute[attributeIndex].valueType = TagValueType_None;
              this.m_xmlAttribute[attributeIndex].unitType = TagUnitType_Pixels;
              this.m_xmlAttribute[attributeIndex].valueHashCode = 0;
              this.m_xmlAttribute[attributeIndex].valueStartIndex = 0;
              this.m_xmlAttribute[attributeIndex].valueLength = 0;
            }
          } else if (tagValueType === TagValueType_StringValue) {
            // Compute HashCode value for the named tag.
            if (unicode !== 0x22 /* " */) {
              this.m_xmlAttribute[attributeIndex].valueHashCode = (Math.imul(this.m_xmlAttribute[attributeIndex].valueHashCode, 33) ^ toUpperFast(unicode)) | 0;
              this.m_xmlAttribute[attributeIndex].valueLength += 1;
            } else {
              attributeFlag = 2;
              tagValueType = TagValueType_None;
              tagUnitType = TagUnitType_Pixels;
              attributeIndex += 1;
              this.m_xmlAttribute[attributeIndex].nameHashCode = 0;
              this.m_xmlAttribute[attributeIndex].valueType = TagValueType_None;
              this.m_xmlAttribute[attributeIndex].unitType = TagUnitType_Pixels;
              this.m_xmlAttribute[attributeIndex].valueHashCode = 0;
              this.m_xmlAttribute[attributeIndex].valueStartIndex = 0;
              this.m_xmlAttribute[attributeIndex].valueLength = 0;
            }
          }
        }
      }

      if (unicode === 0x3d /* = */) attributeFlag = 1;

      // Compute HashCode for the name of the attribute
      if (attributeFlag === 0 && unicode === 0x20) {
        if (isTagSet) return { valid: false, endIndex };

        isTagSet = true;
        attributeFlag = 2;

        tagValueType = TagValueType_None;
        tagUnitType = TagUnitType_Pixels;
        attributeIndex += 1;
        this.m_xmlAttribute[attributeIndex].nameHashCode = 0;
        this.m_xmlAttribute[attributeIndex].valueType = TagValueType_None;
        this.m_xmlAttribute[attributeIndex].unitType = TagUnitType_Pixels;
        this.m_xmlAttribute[attributeIndex].valueHashCode = 0;
        this.m_xmlAttribute[attributeIndex].valueStartIndex = 0;
        this.m_xmlAttribute[attributeIndex].valueLength = 0;
      }

      if (attributeFlag === 0) this.m_xmlAttribute[attributeIndex].nameHashCode = (Math.imul(this.m_xmlAttribute[attributeIndex].nameHashCode, 33) ^ toUpperFast(unicode)) | 0;

      if (attributeFlag === 2 && unicode === 0x20) attributeFlag = 0;
    }

    if (!isValidHtmlTag) {
      return { valid: false, endIndex };
    }

    // #region Rich Text Tag Processing（TMP_Text.cs:6919）；RICH_TEXT_ENABLED 已定義（DLL 裡整段都有編進去）
    // Special handling of the no parsing tag </noparse> </NOPARSE> tag
    if (this.tag_NoParsing && this.m_xmlAttribute[0].nameHashCode !== MarkupTag.SLASH_NO_PARSE) return { valid: false, endIndex };

    if (this.m_xmlAttribute[0].nameHashCode === MarkupTag.SLASH_NO_PARSE) {
      this.tag_NoParsing = false;
      return { valid: true, endIndex };
    }

    // Color <#FFF> 3 Hex values (short form)
    if (this.m_htmlTag[0] === '#' && tagCharCount === 4) {
      this.m_htmlColor = this.hexCharsToColorByCount(this.m_htmlTag, tagCharCount);
      this.m_colorStack.add(this.m_htmlColor);
      return { valid: true, endIndex };
    }
    // Color <#FFF7> 4 Hex values with alpha (short form)
    else if (this.m_htmlTag[0] === '#' && tagCharCount === 5) {
      this.m_htmlColor = this.hexCharsToColorByCount(this.m_htmlTag, tagCharCount);
      this.m_colorStack.add(this.m_htmlColor);
      return { valid: true, endIndex };
    }
    // Color <#FF00FF>
    else if (this.m_htmlTag[0] === '#' && tagCharCount === 7) {
      this.m_htmlColor = this.hexCharsToColorByCount(this.m_htmlTag, tagCharCount);
      this.m_colorStack.add(this.m_htmlColor);
      return { valid: true, endIndex };
    }
    // Color <#FF00FF00> with alpha
    else if (this.m_htmlTag[0] === '#' && tagCharCount === 9) {
      this.m_htmlColor = this.hexCharsToColorByCount(this.m_htmlTag, tagCharCount);
      this.m_colorStack.add(this.m_htmlColor);
      return { valid: true, endIndex };
    } else {
      let value = 0;
      let fontScale: number;

      switch (this.m_xmlAttribute[0].nameHashCode as MarkupTag) {
        // case MarkupTag.BOLD（TMP_Text.cs:6966）
        case MarkupTag.BOLD:
          this.m_FontStyleInternal |= FontStyles.Bold;
          this.m_fontStyleStack.add(FontStyles.Bold);

          this.m_FontWeightInternal = FontWeight.Bold;
          return { valid: true, endIndex };
        // case MarkupTag.SLASH_BOLD（TMP_Text.cs:6972）
        case MarkupTag.SLASH_BOLD:
          if ((this.m_fontStyle & FontStyles.Bold) !== FontStyles.Bold) {
            if (this.m_fontStyleStack.remove(FontStyles.Bold) === 0) {
              this.m_FontStyleInternal &= ~FontStyles.Bold;
              this.m_FontWeightInternal = this.m_FontWeightStack.peek() ?? FontWeight.Regular;
            }
          }
          return { valid: true, endIndex };
        // case MarkupTag.ITALIC（TMP_Text.cs:6982）
        case MarkupTag.ITALIC:
          this.m_FontStyleInternal |= FontStyles.Italic;
          this.m_fontStyleStack.add(FontStyles.Italic);

          if (this.m_xmlAttribute[1].nameHashCode === MarkupTag.ANGLE) {
            this.m_ItalicAngle = Math.trunc(this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[1].valueStartIndex, this.m_xmlAttribute[1].valueLength));

            // Make sure angle is within valid range.
            if (this.m_ItalicAngle < -180 || this.m_ItalicAngle > 180) return { valid: false, endIndex };
          } else this.m_ItalicAngle = this.m_currentFontAsset?.italicStyle ?? 35;

          this.m_ItalicAngleStack.add(this.m_ItalicAngle);

          return { valid: true, endIndex };
        // case MarkupTag.SLASH_ITALIC（TMP_Text.cs:6999）
        case MarkupTag.SLASH_ITALIC:
          if ((this.m_fontStyle & FontStyles.Italic) !== FontStyles.Italic) {
            this.m_ItalicAngle = this.m_ItalicAngleStack.remove() ?? 0;

            if (this.m_fontStyleStack.remove(FontStyles.Italic) === 0) this.m_FontStyleInternal &= ~FontStyles.Italic;
          }
          return { valid: true, endIndex };
        // case MarkupTag.STRIKETHROUGH（TMP_Text.cs:7008）
        case MarkupTag.STRIKETHROUGH:
          this.m_FontStyleInternal |= FontStyles.Strikethrough;
          this.m_fontStyleStack.add(FontStyles.Strikethrough);

          if (this.m_xmlAttribute[1].nameHashCode === MarkupTag.COLOR) {
            this.m_strikethroughColor = this.hexCharsToColorByRange(this.m_htmlTag, this.m_xmlAttribute[1].valueStartIndex, this.m_xmlAttribute[1].valueLength);
            this.m_strikethroughColor.a = this.m_htmlColor.a < this.m_strikethroughColor.a ? this.m_htmlColor.a : this.m_strikethroughColor.a;
          } else this.m_strikethroughColor = { ...this.m_htmlColor };

          this.m_strikethroughColorStack.add(this.m_strikethroughColor);

          return { valid: true, endIndex };
        // case MarkupTag.SLASH_STRIKETHROUGH（TMP_Text.cs:7023）
        case MarkupTag.SLASH_STRIKETHROUGH:
          if ((this.m_fontStyle & FontStyles.Strikethrough) !== FontStyles.Strikethrough) {
            if (this.m_fontStyleStack.remove(FontStyles.Strikethrough) === 0) this.m_FontStyleInternal &= ~FontStyles.Strikethrough;
          }

          this.m_strikethroughColor = this.m_strikethroughColorStack.remove() ?? { ...s_colorWhite };
          return { valid: true, endIndex };
        // case MarkupTag.UNDERLINE（TMP_Text.cs:7032）
        case MarkupTag.UNDERLINE:
          this.m_FontStyleInternal |= FontStyles.Underline;
          this.m_fontStyleStack.add(FontStyles.Underline);

          if (this.m_xmlAttribute[1].nameHashCode === MarkupTag.COLOR) {
            this.m_underlineColor = this.hexCharsToColorByRange(this.m_htmlTag, this.m_xmlAttribute[1].valueStartIndex, this.m_xmlAttribute[1].valueLength);
            this.m_underlineColor.a = this.m_htmlColor.a < this.m_underlineColor.a ? this.m_htmlColor.a : this.m_underlineColor.a;
          } else this.m_underlineColor = { ...this.m_htmlColor };

          this.m_underlineColorStack.add(this.m_underlineColor);

          return { valid: true, endIndex };
        // case MarkupTag.SLASH_UNDERLINE（TMP_Text.cs:7047）
        case MarkupTag.SLASH_UNDERLINE:
          if ((this.m_fontStyle & FontStyles.Underline) !== FontStyles.Underline) {
            if (this.m_fontStyleStack.remove(FontStyles.Underline) === 0) this.m_FontStyleInternal &= ~FontStyles.Underline;
          }

          this.m_underlineColor = this.m_underlineColorStack.remove() ?? { ...s_colorWhite };
          return { valid: true, endIndex };
        // case MarkupTag.MARK（TMP_Text.cs:7056）
        case MarkupTag.MARK: {
          this.m_FontStyleInternal |= FontStyles.Highlight;
          this.m_fontStyleStack.add(FontStyles.Highlight);

          let highlightColor = color32(255, 255, 0, 64);
          let highlightPadding = tmpOffset();

          // Handle Mark Tag and potential attributes
          for (let i = 0; i < this.m_xmlAttribute.length && this.m_xmlAttribute[i].nameHashCode !== 0; i++) {
            switch (this.m_xmlAttribute[i].nameHashCode as MarkupTag) {
              // case MarkupTag.MARK（TMP_Text.cs:7069）
              case MarkupTag.MARK:
                if (this.m_xmlAttribute[i].valueType === TagValueType_ColorValue) highlightColor = this.hexCharsToColorByRange(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);
                break;

              // case MarkupTag.COLOR（TMP_Text.cs:7075）
              case MarkupTag.COLOR:
                highlightColor = this.hexCharsToColorByRange(this.m_htmlTag, this.m_xmlAttribute[i].valueStartIndex, this.m_xmlAttribute[i].valueLength);
                break;

              // case MarkupTag.PADDING（TMP_Text.cs:7080）
              case MarkupTag.PADDING: {
                const paramCount = this.getAttributeParameters(this.m_htmlTag, this.m_xmlAttribute[i].valueStartIndex, this.m_xmlAttribute[i].valueLength, this.m_attributeParameterValues);
                if (paramCount !== 4) return { valid: false, endIndex };

                highlightPadding = tmpOffset(this.m_attributeParameterValues[0], this.m_attributeParameterValues[1], this.m_attributeParameterValues[2], this.m_attributeParameterValues[3]);
                const hs = f32(this.m_fontSize * 0.01) * (this.m_isOrthographic ? 1 : 0.1);
                highlightPadding = tmpOffset(f32(highlightPadding.left * hs), f32(highlightPadding.right * hs), f32(highlightPadding.top * hs), f32(highlightPadding.bottom * hs));
                break;
              }
            }
          }

          highlightColor.a = this.m_htmlColor.a < highlightColor.a ? this.m_htmlColor.a : highlightColor.a;

          this.m_HighlightState = highlightState(highlightColor, highlightPadding);
          this.m_HighlightStateStack.push(this.m_HighlightState);

          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_MARK（TMP_Text.cs:7096）
        case MarkupTag.SLASH_MARK:
          if ((this.m_fontStyle & FontStyles.Highlight) !== FontStyles.Highlight) {
            this.m_HighlightStateStack.remove();
            this.m_HighlightState = this.m_HighlightStateStack.current ?? highlightState(s_colorWhite, tmpOffset());

            if (this.m_fontStyleStack.remove(FontStyles.Highlight) === 0) this.m_FontStyleInternal &= ~FontStyles.Highlight;
          }
          return { valid: true, endIndex };
        // case MarkupTag.SUBSCRIPT（TMP_Text.cs:7106）
        case MarkupTag.SUBSCRIPT: {
          const faceInfo = this.m_currentFontAsset!.faceInfo;
          this.m_fontScaleMultiplier = f32(this.m_fontScaleMultiplier * (faceInfo.subscriptSize > 0 ? faceInfo.subscriptSize : 1));
          this.m_baselineOffsetStack.push(this.m_baselineOffset);
          fontScale = f32(f32(this.m_currentFontSize / faceInfo.pointSize) * faceInfo.scale * (this.m_isOrthographic ? 1 : 0.1));
          this.m_baselineOffset = f32(this.m_baselineOffset + f32(f32(faceInfo.subscriptOffset * fontScale) * this.m_fontScaleMultiplier));

          this.m_fontStyleStack.add(FontStyles.Subscript);
          this.m_FontStyleInternal |= FontStyles.Subscript;
          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_SUBSCRIPT（TMP_Text.cs:7115）
        case MarkupTag.SLASH_SUBSCRIPT:
          if ((this.m_FontStyleInternal & FontStyles.Subscript) === FontStyles.Subscript) {
            if (this.m_fontScaleMultiplier < 1) {
              this.m_baselineOffset = this.m_baselineOffsetStack.pop() ?? 0;
              const subSize = this.m_currentFontAsset!.faceInfo.subscriptSize;
              this.m_fontScaleMultiplier = f32(this.m_fontScaleMultiplier / (subSize > 0 ? subSize : 1));
            }

            if (this.m_fontStyleStack.remove(FontStyles.Subscript) === 0) this.m_FontStyleInternal &= ~FontStyles.Subscript;
          }
          return { valid: true, endIndex };
        // case MarkupTag.SUPERSCRIPT（TMP_Text.cs:7128）
        case MarkupTag.SUPERSCRIPT: {
          const faceInfo = this.m_currentFontAsset!.faceInfo;
          this.m_fontScaleMultiplier = f32(this.m_fontScaleMultiplier * (faceInfo.superscriptSize > 0 ? faceInfo.superscriptSize : 1));
          this.m_baselineOffsetStack.push(this.m_baselineOffset);
          fontScale = f32(f32(this.m_currentFontSize / faceInfo.pointSize) * faceInfo.scale * (this.m_isOrthographic ? 1 : 0.1));
          this.m_baselineOffset = f32(this.m_baselineOffset + f32(f32(faceInfo.superscriptOffset * fontScale) * this.m_fontScaleMultiplier));

          this.m_fontStyleStack.add(FontStyles.Superscript);
          this.m_FontStyleInternal |= FontStyles.Superscript;
          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_SUPERSCRIPT（TMP_Text.cs:7137）
        case MarkupTag.SLASH_SUPERSCRIPT:
          if ((this.m_FontStyleInternal & FontStyles.Superscript) === FontStyles.Superscript) {
            if (this.m_fontScaleMultiplier < 1) {
              this.m_baselineOffset = this.m_baselineOffsetStack.pop() ?? 0;
              const supSize = this.m_currentFontAsset!.faceInfo.superscriptSize;
              this.m_fontScaleMultiplier = f32(this.m_fontScaleMultiplier / (supSize > 0 ? supSize : 1));
            }

            if (this.m_fontStyleStack.remove(FontStyles.Superscript) === 0) this.m_FontStyleInternal &= ~FontStyles.Superscript;
          }
          return { valid: true, endIndex };
        // case MarkupTag.FONT_WEIGHT（TMP_Text.cs:7150）
        case MarkupTag.FONT_WEIGHT: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (Math.trunc(value)) {
            case 100: this.m_FontWeightInternal = FontWeight.Thin; break;
            case 200: this.m_FontWeightInternal = FontWeight.ExtraLight; break;
            case 300: this.m_FontWeightInternal = FontWeight.Light; break;
            case 400: this.m_FontWeightInternal = FontWeight.Regular; break;
            case 500: this.m_FontWeightInternal = FontWeight.Medium; break;
            case 600: this.m_FontWeightInternal = FontWeight.SemiBold; break;
            case 700: this.m_FontWeightInternal = FontWeight.Bold; break;
            case 800: this.m_FontWeightInternal = FontWeight.Heavy; break;
            case 900: this.m_FontWeightInternal = FontWeight.Black; break;
          }

          this.m_FontWeightStack.add(this.m_FontWeightInternal);

          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_FONT_WEIGHT（TMP_Text.cs:7190）
        case MarkupTag.SLASH_FONT_WEIGHT:
          this.m_FontWeightStack.remove();

          if (this.m_FontStyleInternal === FontStyles.Bold) this.m_FontWeightInternal = FontWeight.Bold;
          else this.m_FontWeightInternal = this.m_FontWeightStack.peek() ?? FontWeight.Regular;

          return { valid: true, endIndex };
        // case MarkupTag.POSITION（TMP_Text.cs:7199）
        case MarkupTag.POSITION: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.m_xAdvance = f32(value * (this.m_isOrthographic ? 1.0 : 0.1));
              return { valid: true, endIndex };
            case TagUnitType_FontUnits:
              this.m_xAdvance = f32(f32(value * this.m_currentFontSize) * (this.m_isOrthographic ? 1.0 : 0.1));
              return { valid: true, endIndex };
            case TagUnitType_Percentage:
              this.m_xAdvance = f32(f32(this.m_marginWidth * value) / 100);
              return { valid: true, endIndex };
          }
          return { valid: false, endIndex };
        }
        // case MarkupTag.SLASH_POSITION（TMP_Text.cs:7221）
        case MarkupTag.SLASH_POSITION:
          this.m_isIgnoringAlignment = false;
          return { valid: true, endIndex };
        // case MarkupTag.VERTICAL_OFFSET（TMP_Text.cs:7224）
        case MarkupTag.VERTICAL_OFFSET: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.m_baselineOffset = f32(value * (this.m_isOrthographic ? 1 : 0.1));
              return { valid: true, endIndex };
            case TagUnitType_FontUnits:
              this.m_baselineOffset = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
              return { valid: true, endIndex };
            case TagUnitType_Percentage:
              return { valid: false, endIndex };
          }
          return { valid: false, endIndex };
        }
        // case MarkupTag.SLASH_VERTICAL_OFFSET（TMP_Text.cs:7243）
        case MarkupTag.SLASH_VERTICAL_OFFSET:
          this.m_baselineOffset = 0;
          return { valid: true, endIndex };
        // case MarkupTag.PAGE（TMP_Text.cs:7246）
        case MarkupTag.PAGE:
          // This tag only works when Overflow - Page mode is used.
          if (this.m_overflowMode === TextOverflowModes.Page) {
            this.m_xAdvance = f32(0 + this.tag_LineIndent + this.tag_Indent);
            this.m_lineOffset = 0;
            this.m_pageNumber += 1;
            this.m_isNewPage = true;
          }
          return { valid: true, endIndex };
        // case MarkupTag.NO_BREAK（TMP_Text.cs:7256）
        case MarkupTag.NO_BREAK:
          this.m_isNonBreakingSpace = true;
          return { valid: true, endIndex };
        // case MarkupTag.SLASH_NO_BREAK（TMP_Text.cs:7259）
        case MarkupTag.SLASH_NO_BREAK:
          this.m_isNonBreakingSpace = false;
          return { valid: true, endIndex };
        // case MarkupTag.SIZE（TMP_Text.cs:7262）
        case MarkupTag.SIZE: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              if (this.m_htmlTag[5] === '+') {
                // <size=+00>
                this.m_currentFontSize = f32(this.m_fontSize + value);
                this.m_sizeStack.add(this.m_currentFontSize);
                return { valid: true, endIndex };
              } else if (this.m_htmlTag[5] === '-') {
                // <size=-00>
                this.m_currentFontSize = f32(this.m_fontSize + value);
                this.m_sizeStack.add(this.m_currentFontSize);
                return { valid: true, endIndex };
              } else {
                // <size=00.0>
                this.m_currentFontSize = value;
                this.m_sizeStack.add(this.m_currentFontSize);
                return { valid: true, endIndex };
              }
            case TagUnitType_FontUnits:
              this.m_currentFontSize = f32(this.m_fontSize * value);
              this.m_sizeStack.add(this.m_currentFontSize);
              return { valid: true, endIndex };
            case TagUnitType_Percentage:
              this.m_currentFontSize = f32(f32(this.m_fontSize * value) / 100);
              this.m_sizeStack.add(this.m_currentFontSize);
              return { valid: true, endIndex };
          }
          return { valid: false, endIndex };
        }
        // case MarkupTag.SLASH_SIZE（TMP_Text.cs:7299）
        case MarkupTag.SLASH_SIZE:
          this.m_currentFontSize = this.m_sizeStack.remove() ?? 0;
          return { valid: true, endIndex };
        // case MarkupTag.FONT（TMP_Text.cs:7302）
        case MarkupTag.FONT: {
          const fontHashCode = this.m_xmlAttribute[0].valueHashCode;
          const materialAttributeHashCode = this.m_xmlAttribute[1].nameHashCode;
          const materialHashCode = this.m_xmlAttribute[1].valueHashCode;

          // Special handling for <font=default> or <font=Default>
          if (fontHashCode === MarkupTag.DEFAULT) {
            this.m_currentFontAsset = this.m_materialReferences[0].fontAsset;
            this.m_currentMaterial = this.m_materialReferences[0].material;
            this.m_currentMaterialIndex = 0;

            this.m_materialReferenceStack.add(this.m_materialReferences[0]);

            return { valid: true, endIndex };
          }

          // HANDLE NEW FONT ASSET
          let tempFont = tryGetFontAsset(this.assets, fontHashCode);

          // Try loading font asset from potential delegate or resources.
          if (tempFont == null) {
            // OnFontAssetRequest 是遊戲程式碼的 callback，移植版沒有；直接走 Resources.Load
            const fontName = this.m_htmlTag.slice(this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueStartIndex + this.m_xmlAttribute[0].valueLength).join('');
            const loaded = this.assets.resource(this.settings.defaultFontAssetPath + fontName, 'TMP_FontAsset');
            if (loaded) tempFont = getFontAsset(this.assets, loaded.ref, this.warnings);

            if (tempFont == null) return { valid: false, endIndex };

            // Add new reference to the font asset as well as default material to the MaterialReferenceManager
            registerFontAsset(this.assets, tempFont);
          }

          // HANDLE NEW MATERIAL
          if (materialAttributeHashCode === 0 && materialHashCode === 0) {
            // No material specified then use default font asset material.
            this.m_currentMaterial = tempFont.material;

            this.m_currentMaterialIndex = this.addMaterialReference(this.m_currentMaterial, tempFont);

            this.m_materialReferenceStack.add(this.m_materialReferences[this.m_currentMaterialIndex]);
          } else if (materialAttributeHashCode === MarkupTag.MATERIAL) {
            // using material attribute
            const materialName = this.m_htmlTag.slice(this.m_xmlAttribute[1].valueStartIndex, this.m_xmlAttribute[1].valueStartIndex + this.m_xmlAttribute[1].valueLength).join('');
            const loadedMat = this.assets.resource(this.settings.defaultFontAssetPath + materialName, 'Material');

            if (loadedMat == null) return { valid: false, endIndex };

            const tempMaterial = new MaterialView(loadedMat.ref, loadedMat.data);

            this.m_currentMaterial = tempMaterial;

            this.m_currentMaterialIndex = this.addMaterialReference(this.m_currentMaterial, tempFont);

            this.m_materialReferenceStack.add(this.m_materialReferences[this.m_currentMaterialIndex]);
          } else return { valid: false, endIndex };

          this.m_currentFontAsset = tempFont;

          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_FONT（TMP_Text.cs:7392）
        case MarkupTag.SLASH_FONT: {
          const materialReference = this.m_materialReferenceStack.remove()!;

          this.m_currentFontAsset = materialReference.fontAsset;
          this.m_currentMaterial = materialReference.material;
          this.m_currentMaterialIndex = materialReference.index;

          return { valid: true, endIndex };
        }
        // case MarkupTag.MATERIAL（TMP_Text.cs:7402）
        case MarkupTag.MATERIAL: {
          const materialHashCode = this.m_xmlAttribute[0].valueHashCode;

          // Special handling for <material=default> or <material=Default>
          if (materialHashCode === MarkupTag.DEFAULT) {
            this.m_currentMaterial = this.m_materialReferences[0].material;
            this.m_currentMaterialIndex = 0;

            this.m_materialReferenceStack.add(this.m_materialReferences[0]);

            return { valid: true, endIndex };
          }

          // Load material
          const materialName = this.m_htmlTag.slice(this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueStartIndex + this.m_xmlAttribute[0].valueLength).join('');
          const loadedMat = this.assets.resource(this.settings.defaultFontAssetPath + materialName, 'Material');
          if (loadedMat == null) return { valid: false, endIndex };
          const tempMaterial = new MaterialView(loadedMat.ref, loadedMat.data);

          this.m_currentMaterial = tempMaterial;

          this.m_currentMaterialIndex = this.addMaterialReference(this.m_currentMaterial, this.m_currentFontAsset!);

          this.m_materialReferenceStack.add(this.m_materialReferences[this.m_currentMaterialIndex]);
          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_MATERIAL（TMP_Text.cs:7453）
        case MarkupTag.SLASH_MATERIAL: {
          const materialReference = this.m_materialReferenceStack.remove()!;

          this.m_currentMaterial = materialReference.material;
          this.m_currentMaterialIndex = materialReference.index;

          return { valid: true, endIndex };
        }
        // case MarkupTag.SPACE（TMP_Text.cs:7465）
        case MarkupTag.SPACE: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.m_xAdvance = f32(this.m_xAdvance + f32(value * (this.m_isOrthographic ? 1 : 0.1)));
              return { valid: true, endIndex };
            case TagUnitType_FontUnits:
              this.m_xAdvance = f32(this.m_xAdvance + f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize));
              return { valid: true, endIndex };
            case TagUnitType_Percentage:
              // Not applicable
              return { valid: false, endIndex };
          }
          return { valid: false, endIndex };
        }
        // case MarkupTag.ALPHA（TMP_Text.cs:7484）
        case MarkupTag.ALPHA:
          if (this.m_xmlAttribute[0].valueLength !== 3) return { valid: false, endIndex };

          this.m_htmlColor = { ...this.m_htmlColor, a: hexToInt(this.m_htmlTag[7].charCodeAt(0)) * 16 + hexToInt(this.m_htmlTag[8].charCodeAt(0)) };
          return { valid: true, endIndex };

        // case MarkupTag.A（TMP_Text.cs:7490）
        case MarkupTag.A:
          if (this.m_isTextLayoutPhase && !this.m_isCalculatingPreferredValues) {
            if (this.m_xmlAttribute[1].nameHashCode === MarkupTag.HREF) {
              // Make sure linkInfo array is of appropriate size.
              const index = this.m_textInfo.linkCount;

              if (index + 1 > this.m_textInfo.linkInfo.length) TmpTextInfo.resizeLinkInfo(this.m_textInfo.linkInfo, index + 1);

              this.m_textInfo.linkInfo[index].hashCode = MarkupTag.HREF;
              this.m_textInfo.linkInfo[index].linkTextfirstCharacterIndex = this.m_characterCount;
              this.m_textInfo.linkInfo[index].setLinkID(this.m_htmlTag, this.m_xmlAttribute[1].valueStartIndex, this.m_xmlAttribute[1].valueLength);
            }
          }
          return { valid: true, endIndex };
        // case MarkupTag.SLASH_A（TMP_Text.cs:7508）
        case MarkupTag.SLASH_A:
          if (this.m_isTextLayoutPhase && !this.m_isCalculatingPreferredValues) {
            const index = this.m_textInfo.linkCount;

            this.m_textInfo.linkInfo[index].linkTextLength = this.m_characterCount - this.m_textInfo.linkInfo[index].linkTextfirstCharacterIndex;

            this.m_textInfo.linkCount += 1;
          }
          return { valid: true, endIndex };
        // case MarkupTag.LINK（TMP_Text.cs:7518）
        case MarkupTag.LINK:
          if (this.m_isTextLayoutPhase && !this.m_isCalculatingPreferredValues) {
            const index = this.m_textInfo.linkCount;

            if (index + 1 > this.m_textInfo.linkInfo.length) TmpTextInfo.resizeLinkInfo(this.m_textInfo.linkInfo, index + 1);

            this.m_textInfo.linkInfo[index].hashCode = this.m_xmlAttribute[0].valueHashCode;
            this.m_textInfo.linkInfo[index].linkTextfirstCharacterIndex = this.m_characterCount;

            this.m_textInfo.linkInfo[index].linkIdFirstCharacterIndex = startIndex + this.m_xmlAttribute[0].valueStartIndex;
            this.m_textInfo.linkInfo[index].linkIdLength = this.m_xmlAttribute[0].valueLength;
            this.m_textInfo.linkInfo[index].setLinkID(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);
          }
          return { valid: true, endIndex };
        // case MarkupTag.SLASH_LINK（TMP_Text.cs:7535）
        case MarkupTag.SLASH_LINK:
          if (this.m_isTextLayoutPhase && !this.m_isCalculatingPreferredValues) {
            if (this.m_textInfo.linkCount < this.m_textInfo.linkInfo.length) {
              this.m_textInfo.linkInfo[this.m_textInfo.linkCount].linkTextLength = this.m_characterCount - this.m_textInfo.linkInfo[this.m_textInfo.linkCount].linkTextfirstCharacterIndex;

              this.m_textInfo.linkCount += 1;
            }
          }
          return { valid: true, endIndex };
        // case MarkupTag.ALIGN（TMP_Text.cs:7546）
        case MarkupTag.ALIGN:
          switch (this.m_xmlAttribute[0].valueHashCode as MarkupTag) {
            // case MarkupTag.LEFT（TMP_Text.cs:7549）
            case MarkupTag.LEFT: // <align=left>
              this.m_lineJustification = HorizontalAlignmentOptions.Left;
              this.m_lineJustificationStack.add(this.m_lineJustification);
              return { valid: true, endIndex };
            // case MarkupTag.RIGHT（TMP_Text.cs:7553）
            case MarkupTag.RIGHT: // <align=right>
              this.m_lineJustification = HorizontalAlignmentOptions.Right;
              this.m_lineJustificationStack.add(this.m_lineJustification);
              return { valid: true, endIndex };
            // case MarkupTag.CENTER（TMP_Text.cs:7557）
            case MarkupTag.CENTER: // <align=center>
              this.m_lineJustification = HorizontalAlignmentOptions.Center;
              this.m_lineJustificationStack.add(this.m_lineJustification);
              return { valid: true, endIndex };
            // case MarkupTag.JUSTIFIED（TMP_Text.cs:7561）
            case MarkupTag.JUSTIFIED: // <align=justified>
              this.m_lineJustification = HorizontalAlignmentOptions.Justified;
              this.m_lineJustificationStack.add(this.m_lineJustification);
              return { valid: true, endIndex };
            // case MarkupTag.FLUSH（TMP_Text.cs:7565）
            case MarkupTag.FLUSH: // <align=flush>
              this.m_lineJustification = HorizontalAlignmentOptions.Flush;
              this.m_lineJustificationStack.add(this.m_lineJustification);
              return { valid: true, endIndex };
          }
          return { valid: false, endIndex };
        // case MarkupTag.SLASH_ALIGN（TMP_Text.cs:7571）
        case MarkupTag.SLASH_ALIGN:
          this.m_lineJustification = this.m_lineJustificationStack.remove() ?? HorizontalAlignmentOptions.Left;
          return { valid: true, endIndex };
        // case MarkupTag.WIDTH（TMP_Text.cs:7574）
        case MarkupTag.WIDTH: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.m_width = f32(value * (this.m_isOrthographic ? 1 : 0.1));
              break;
            case TagUnitType_FontUnits:
              return { valid: false, endIndex };
            case TagUnitType_Percentage:
              this.m_width = f32(f32(this.m_marginWidth * value) / 100);
              break;
          }
          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_WIDTH（TMP_Text.cs:7593）
        case MarkupTag.SLASH_WIDTH:
          this.m_width = -1;
          return { valid: true, endIndex };
        // case MarkupTag.COLOR（TMP_Text.cs:7635）
        case MarkupTag.COLOR:
          // <color=#FFF> 3 Hex (short hand)
          if (this.m_htmlTag[6] === '#' && tagCharCount === 10) {
            this.m_htmlColor = this.hexCharsToColorByCount(this.m_htmlTag, tagCharCount);
            this.m_colorStack.add(this.m_htmlColor);
            return { valid: true, endIndex };
          }
          // <color=#FFF7> 4 Hex (short hand)
          else if (this.m_htmlTag[6] === '#' && tagCharCount === 11) {
            this.m_htmlColor = this.hexCharsToColorByCount(this.m_htmlTag, tagCharCount);
            this.m_colorStack.add(this.m_htmlColor);
            return { valid: true, endIndex };
          }
          // <color=#FF00FF> 3 Hex pairs
          else if (this.m_htmlTag[6] === '#' && tagCharCount === 13) {
            this.m_htmlColor = this.hexCharsToColorByCount(this.m_htmlTag, tagCharCount);
            this.m_colorStack.add(this.m_htmlColor);
            return { valid: true, endIndex };
          }
          // <color=#FF00FF00> 4 Hex pairs
          else if (this.m_htmlTag[6] === '#' && tagCharCount === 15) {
            this.m_htmlColor = this.hexCharsToColorByCount(this.m_htmlTag, tagCharCount);
            this.m_colorStack.add(this.m_htmlColor);
            return { valid: true, endIndex };
          }

          // <color=name>
          switch (this.m_xmlAttribute[0].valueHashCode) {
            // case MarkupTag.RED（TMP_Text.cs:7668）
            case MarkupTag.RED: // <color=red>
              this.m_htmlColor = color32(255, 0, 0, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
            case -992792864: // <color=lightblue>（TMP_Text.cs:7672）
              this.m_htmlColor = color32(173, 216, 230, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
            // case MarkupTag.BLUE（TMP_Text.cs:7676）
            case MarkupTag.BLUE: // <color=blue>
              this.m_htmlColor = color32(0, 0, 255, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
            case 3680713: // <color=grey>（TMP_Text.cs:7680）
              this.m_htmlColor = color32(128, 128, 128, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
            // case MarkupTag.BLACK（TMP_Text.cs:7684）
            case MarkupTag.BLACK: // <color=black>
              this.m_htmlColor = color32(0, 0, 0, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
            // case MarkupTag.GREEN（TMP_Text.cs:7688）
            case MarkupTag.GREEN: // <color=green>
              this.m_htmlColor = color32(0, 255, 0, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
            // case MarkupTag.WHITE（TMP_Text.cs:7692）
            case MarkupTag.WHITE: // <color=white>
              this.m_htmlColor = color32(255, 255, 255, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
            // case MarkupTag.ORANGE（TMP_Text.cs:7696）
            case MarkupTag.ORANGE: // <color=orange>
              this.m_htmlColor = color32(255, 128, 0, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
            // case MarkupTag.PURPLE（TMP_Text.cs:7700）
            case MarkupTag.PURPLE: // <color=purple>
              this.m_htmlColor = color32(160, 32, 240, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
            // case MarkupTag.YELLOW（TMP_Text.cs:7704）
            case MarkupTag.YELLOW: // <color=yellow>
              this.m_htmlColor = color32(255, 255, 0, 255);
              this.m_colorStack.add(this.m_htmlColor);
              return { valid: true, endIndex };
          }
          return { valid: false, endIndex };

        // case MarkupTag.GRADIENT（TMP_Text.cs:7711）
        case MarkupTag.GRADIENT: {
          const gradientPresetHashCode = this.m_xmlAttribute[0].valueHashCode;
          let tempColorGradientPreset = this.findColorGradientPreset(gradientPresetHashCode);

          if (tempColorGradientPreset == null) {
            // Load Color Gradient Preset
            const presetName = this.m_htmlTag.slice(this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueStartIndex + this.m_xmlAttribute[0].valueLength).join('');
            const loaded = this.assets.resource(this.settings.defaultColorGradientPresetsPath + presetName, 'TMP_ColorGradient');
            if (loaded) tempColorGradientPreset = getColorGradient(this.assets, loaded.ref);

            if (tempColorGradientPreset == null) return { valid: false, endIndex };

            this.registerColorGradientPreset(gradientPresetHashCode, tempColorGradientPreset);
            this.m_colorGradientPreset = tempColorGradientPreset;
          } else {
            this.m_colorGradientPreset = tempColorGradientPreset;
          }

          this.m_colorGradientPresetIsTinted = false;

          // Check Attributes
          for (let i = 1; i < this.m_xmlAttribute.length && this.m_xmlAttribute[i].nameHashCode !== 0; i++) {
            // Get attribute name
            const nameHashCode = this.m_xmlAttribute[i].nameHashCode;

            switch (nameHashCode as MarkupTag) {
              // case MarkupTag.TINT（TMP_Text.cs:7745）
              case MarkupTag.TINT:
                this.m_colorGradientPresetIsTinted = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[i].valueStartIndex, this.m_xmlAttribute[i].valueLength) !== 0;
                break;
            }
          }

          this.m_colorGradientStack.add(this.m_colorGradientPreset);

          return { valid: true, endIndex };
        }

        // case MarkupTag.SLASH_GRADIENT（TMP_Text.cs:7757）
        case MarkupTag.SLASH_GRADIENT:
          this.m_colorGradientPreset = this.m_colorGradientStack.remove() ?? null;
          return { valid: true, endIndex };

        // case MarkupTag.CHARACTER_SPACE（TMP_Text.cs:7761）
        case MarkupTag.CHARACTER_SPACE: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.m_cSpacing = f32(value * (this.m_isOrthographic ? 1 : 0.1));
              break;
            case TagUnitType_FontUnits:
              this.m_cSpacing = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
              break;
            case TagUnitType_Percentage:
              return { valid: false, endIndex };
          }
          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_CHARACTER_SPACE（TMP_Text.cs:7779）
        case MarkupTag.SLASH_CHARACTER_SPACE:
          if (!this.m_isTextLayoutPhase) return { valid: true, endIndex };

          // Adjust xAdvance to remove extra space from last character.
          if (this.m_characterCount > 0) {
            this.m_xAdvance = f32(this.m_xAdvance - this.m_cSpacing);
            this.m_textInfo.characterInfo[this.m_characterCount - 1].xAdvance = this.m_xAdvance;
          }
          this.m_cSpacing = 0;
          return { valid: true, endIndex };
        // case MarkupTag.MONOSPACE（TMP_Text.cs:7790）
        case MarkupTag.MONOSPACE: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (this.m_xmlAttribute[0].unitType) {
            case TagUnitType_Pixels:
              this.m_monoSpacing = f32(value * (this.m_isOrthographic ? 1 : 0.1));
              break;
            case TagUnitType_FontUnits:
              this.m_monoSpacing = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
              break;
            case TagUnitType_Percentage:
              return { valid: false, endIndex };
          }

          // Check for potential DuoSpace attribute.
          if (this.m_xmlAttribute[1].nameHashCode === MarkupTag.DUOSPACE) this.m_duoSpace = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[1].valueStartIndex, this.m_xmlAttribute[1].valueLength) !== 0;

          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_MONOSPACE（TMP_Text.cs:7813）
        case MarkupTag.SLASH_MONOSPACE:
          this.m_monoSpacing = 0;
          this.m_duoSpace = false;
          return { valid: true, endIndex };
        // case MarkupTag.CLASS（TMP_Text.cs:7817）
        case MarkupTag.CLASS:
          return { valid: false, endIndex };
        // case MarkupTag.SLASH_COLOR（TMP_Text.cs:7819）
        case MarkupTag.SLASH_COLOR:
          this.m_htmlColor = this.m_colorStack.remove() ?? { ...s_colorWhite };
          return { valid: true, endIndex };
        // case MarkupTag.INDENT（TMP_Text.cs:7822）
        case MarkupTag.INDENT: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex }

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.tag_Indent = f32(value * (this.m_isOrthographic ? 1 : 0.1));
              break;
            case TagUnitType_FontUnits:
              this.tag_Indent = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
              break;
            case TagUnitType_Percentage:
              this.tag_Indent = f32(f32(this.m_marginWidth * value) / 100);
              break;
          }
          this.m_indentStack.add(this.tag_Indent);

          this.m_xAdvance = this.tag_Indent;
          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_INDENT（TMP_Text.cs:7844）
        case MarkupTag.SLASH_INDENT:
          this.tag_Indent = this.m_indentStack.remove() ?? 0;
          return { valid: true, endIndex };
        // case MarkupTag.LINE_INDENT（TMP_Text.cs:7848）
        case MarkupTag.LINE_INDENT: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.tag_LineIndent = f32(value * (this.m_isOrthographic ? 1 : 0.1));
              break;
            case TagUnitType_FontUnits:
              this.tag_LineIndent = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
              break;
            case TagUnitType_Percentage:
              this.tag_LineIndent = f32(f32(this.m_marginWidth * value) / 100);
              break;
          }

          this.m_xAdvance = f32(this.m_xAdvance + this.tag_LineIndent);
          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_LINE_INDENT（TMP_Text.cs:7869）
        case MarkupTag.SLASH_LINE_INDENT:
          this.tag_LineIndent = 0;
          return { valid: true, endIndex };
        // case MarkupTag.SPRITE（TMP_Text.cs:7872）
        case MarkupTag.SPRITE: {
          const spriteAssetHashCode = this.m_xmlAttribute[0].valueHashCode;
          this.m_spriteIndex = -1;

          // CHECK TAG FORMAT
          if (this.m_xmlAttribute[0].valueType === TagValueType_None || this.m_xmlAttribute[0].valueType === TagValueType_NumericalValue) {
            // No Sprite Asset is assigned to the text object
            if (this.m_spriteAsset != null) {
              this.m_currentSpriteAsset = this.m_spriteAsset;
            } else if (this.m_defaultSpriteAsset != null) {
              this.m_currentSpriteAsset = this.m_defaultSpriteAsset;
            } else if (this.m_defaultSpriteAsset == null) {
              const settings = this.settings;
              if (settings.defaultSpriteAssetRef != null) this.m_defaultSpriteAsset = getSpriteAsset(this.assets, settings.defaultSpriteAssetRef, this.warnings);
              else this.m_defaultSpriteAsset = getSpriteAsset(this.assets, this.assets.resource('Sprite Assets/Default Sprite Asset', 'TMP_SpriteAsset')?.ref ?? null, this.warnings);

              this.m_currentSpriteAsset = this.m_defaultSpriteAsset;
            }

            // No valid sprite asset available
            if (this.m_currentSpriteAsset == null) return { valid: false, endIndex };
          } else {
            // A Sprite Asset has been specified
            const spriteAssetName = this.m_htmlTag.slice(this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueStartIndex + this.m_xmlAttribute[0].valueLength).join('');
            let tempSpriteAsset = this.tryGetSpriteAsset(spriteAssetHashCode);
            if (tempSpriteAsset == null) {
              // OnSpriteAssetRequest 是遊戲程式碼的 callback，移植版沒有；直接走 Resources.Load
              const loaded = this.assets.resource(this.settings.defaultSpriteAssetPath + spriteAssetName, 'TMP_SpriteAsset');
              if (loaded) tempSpriteAsset = getSpriteAsset(this.assets, loaded.ref, this.warnings);

              if (tempSpriteAsset == null) return { valid: false, endIndex };

              this.registerSpriteAsset(spriteAssetHashCode, tempSpriteAsset);
            }
            this.m_currentSpriteAsset = tempSpriteAsset;
          }

          // Handling of <sprite=index> legacy tag format.
          if (this.m_xmlAttribute[0].valueType === TagValueType_NumericalValue) {
            // <sprite=index>
            const index = Math.trunc(this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength));

            // Reject tag if value is invalid.
            if (index === -32768) return { valid: false, endIndex };

            // Check to make sure sprite index is valid
            if (index > this.m_currentSpriteAsset.spriteCharacterTable.length - 1) return { valid: false, endIndex };

            this.m_spriteIndex = index;
          }

          this.m_spriteColor = { ...s_colorWhite };
          this.m_tintSprite = false;

          // Handle Sprite Tag Attributes
          for (let i = 0; i < this.m_xmlAttribute.length && this.m_xmlAttribute[i].nameHashCode !== 0; i++) {
            const nameHashCode = this.m_xmlAttribute[i].nameHashCode;

            switch (nameHashCode as MarkupTag) {
              // case MarkupTag.NAME（TMP_Text.cs:7957）
              case MarkupTag.NAME: {
                const settings = this.settings;
                const result = searchForSpriteByHashCode(
                  this.assets,
                  this.m_currentSpriteAsset,
                  this.m_xmlAttribute[i].valueHashCode,
                  true,
                  () => getSpriteAsset(this.assets, settings.defaultSpriteAssetRef, this.warnings),
                  settings.missingCharacterSpriteUnicode,
                );
                if (result.spriteIndex === -1) return { valid: false, endIndex };
                this.m_currentSpriteAsset = result.spriteAsset!;

                this.m_spriteIndex = result.spriteIndex;
                break;
              }
              // case MarkupTag.INDEX（TMP_Text.cs:7963）
              case MarkupTag.INDEX: {
                const index = Math.trunc(this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[1].valueStartIndex, this.m_xmlAttribute[1].valueLength));

                // Reject tag if value is invalid.
                if (index === -32768) return { valid: false, endIndex };

                // Check to make sure sprite index is valid
                if (index > this.m_currentSpriteAsset.spriteCharacterTable.length - 1) return { valid: false, endIndex };

                this.m_spriteIndex = index;
                break;
              }
              // case MarkupTag.TINT（TMP_Text.cs:7974）
              case MarkupTag.TINT:
                this.m_tintSprite = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[i].valueStartIndex, this.m_xmlAttribute[i].valueLength) !== 0;
                break;
              // case MarkupTag.COLOR（TMP_Text.cs:7977）
              case MarkupTag.COLOR:
                this.m_spriteColor = this.hexCharsToColorByRange(this.m_htmlTag, this.m_xmlAttribute[i].valueStartIndex, this.m_xmlAttribute[i].valueLength);
                break;
              // case MarkupTag.ANIM（TMP_Text.cs:7980）：sprite 動畫（DoSpriteAnimation）靠 Unity 的 TMP_SpriteAnimator，移植版不播放（靜態第一幀）
              case MarkupTag.ANIM: {
                const paramCount = this.getAttributeParameters(this.m_htmlTag, this.m_xmlAttribute[i].valueStartIndex, this.m_xmlAttribute[i].valueLength, this.m_attributeParameterValues);
                if (paramCount !== 3) return { valid: false, endIndex };

                this.m_spriteIndex = Math.trunc(this.m_attributeParameterValues[0]);

                if (this.m_isTextLayoutPhase) {
                  // TMP 的 spriteAnimator.DoSpriteAnimation：播放動畫，移植版固定第一幀
                  this.warnings.push(`<sprite anim> 的動畫沒有移植（TMP_SpriteAnimator 依賴 Unity），sprite 停在第一幀（index ${this.m_spriteIndex}）`);
                }

                break;
              }
              default:
                if (nameHashCode !== MarkupTag.SPRITE) return { valid: false, endIndex };
                break;
            }
          }

          if (this.m_spriteIndex === -1) return { valid: false, endIndex };

          // Material HashCode for the Sprite Asset is the Sprite Asset Hash Code
          this.m_currentMaterialIndex = this.addMaterialReferenceSprite(this.m_currentSpriteAsset.material, this.m_currentSpriteAsset);

          this.m_textElementType = TmpTextElementType.Sprite;
          return { valid: true, endIndex };
        }
        // case MarkupTag.LOWERCASE（TMP_Text.cs:8015）
        case MarkupTag.LOWERCASE:
          this.m_FontStyleInternal |= FontStyles.LowerCase;
          this.m_fontStyleStack.add(FontStyles.LowerCase);
          return { valid: true, endIndex };
        // case MarkupTag.SLASH_LOWERCASE（TMP_Text.cs:8019）
        case MarkupTag.SLASH_LOWERCASE:
          if ((this.m_fontStyle & FontStyles.LowerCase) !== FontStyles.LowerCase) {
            if (this.m_fontStyleStack.remove(FontStyles.LowerCase) === 0) this.m_FontStyleInternal &= ~FontStyles.LowerCase;
          }
          return { valid: true, endIndex };
        // case MarkupTag.ALLCAPS（TMP_Text.cs:8026）
        case MarkupTag.ALLCAPS:
        // case MarkupTag.UPPERCASE（TMP_Text.cs:8027）
        case MarkupTag.UPPERCASE:
          this.m_FontStyleInternal |= FontStyles.UpperCase;
          this.m_fontStyleStack.add(FontStyles.UpperCase);
          return { valid: true, endIndex };
        // case MarkupTag.SLASH_ALLCAPS（TMP_Text.cs:8031）
        case MarkupTag.SLASH_ALLCAPS:
        // case MarkupTag.SLASH_UPPERCASE（TMP_Text.cs:8032）
        case MarkupTag.SLASH_UPPERCASE:
          if ((this.m_fontStyle & FontStyles.UpperCase) !== FontStyles.UpperCase) {
            if (this.m_fontStyleStack.remove(FontStyles.UpperCase) === 0) this.m_FontStyleInternal &= ~FontStyles.UpperCase;
          }
          return { valid: true, endIndex };
        // case MarkupTag.SMALLCAPS（TMP_Text.cs:8039）
        case MarkupTag.SMALLCAPS:
          this.m_FontStyleInternal |= FontStyles.SmallCaps;
          this.m_fontStyleStack.add(FontStyles.SmallCaps);
          return { valid: true, endIndex };
        // case MarkupTag.SLASH_SMALLCAPS（TMP_Text.cs:8043）
        case MarkupTag.SLASH_SMALLCAPS:
          if ((this.m_fontStyle & FontStyles.SmallCaps) !== FontStyles.SmallCaps) {
            if (this.m_fontStyleStack.remove(FontStyles.SmallCaps) === 0) this.m_FontStyleInternal &= ~FontStyles.SmallCaps;
          }
          return { valid: true, endIndex };
        // case MarkupTag.MARGIN（TMP_Text.cs:8050）
        case MarkupTag.MARGIN: {
          // Check value type
          switch (this.m_xmlAttribute[0].valueType) {
            case TagValueType_NumericalValue: {
              value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength); // px

              // Reject tag if value is invalid.
              if (value === -32768) return { valid: false, endIndex };

              // Determine tag unit type
              switch (tagUnitType) {
                case TagUnitType_Pixels:
                  this.m_marginLeft = f32(value * (this.m_isOrthographic ? 1 : 0.1));
                  break;
                case TagUnitType_FontUnits:
                  this.m_marginLeft = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
                  break;
                case TagUnitType_Percentage:
                  this.m_marginLeft = f32(f32(this.m_marginWidth - (this.m_width !== -1 ? this.m_width : 0)) * value / 100);
                  break;
              }
              this.m_marginLeft = this.m_marginLeft >= 0 ? this.m_marginLeft : 0;
              this.m_marginRight = this.m_marginLeft;
              return { valid: true, endIndex };
            }

            case TagValueType_None:
              for (let i = 1; i < this.m_xmlAttribute.length && this.m_xmlAttribute[i].nameHashCode !== 0; i++) {
                // Get attribute name
                const nameHashCode = this.m_xmlAttribute[i].nameHashCode;

                switch (nameHashCode as MarkupTag) {
                  // case MarkupTag.LEFT（TMP_Text.cs:8085）
                  case MarkupTag.LEFT: {
                    value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[i].valueStartIndex, this.m_xmlAttribute[i].valueLength); // px

                    // Reject tag if value is invalid.
                    if (value === -32768) return { valid: false, endIndex };

                    switch (this.m_xmlAttribute[i].unitType) {
                      case TagUnitType_Pixels:
                        this.m_marginLeft = f32(value * (this.m_isOrthographic ? 1 : 0.1));
                        break;
                      case TagUnitType_FontUnits:
                        this.m_marginLeft = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
                        break;
                      case TagUnitType_Percentage:
                        this.m_marginLeft = f32(f32(this.m_marginWidth - (this.m_width !== -1 ? this.m_width : 0)) * value / 100);
                        break;
                    }
                    this.m_marginLeft = this.m_marginLeft >= 0 ? this.m_marginLeft : 0;
                    break;
                  }

                  // case MarkupTag.RIGHT（TMP_Text.cs:8106）
                  case MarkupTag.RIGHT: {
                    value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[i].valueStartIndex, this.m_xmlAttribute[i].valueLength); // px

                    // Reject tag if value is invalid.
                    if (value === -32768) return { valid: false, endIndex };

                    switch (this.m_xmlAttribute[i].unitType) {
                      case TagUnitType_Pixels:
                        this.m_marginRight = f32(value * (this.m_isOrthographic ? 1 : 0.1));
                        break;
                      case TagUnitType_FontUnits:
                        this.m_marginRight = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
                        break;
                      case TagUnitType_Percentage:
                        this.m_marginRight = f32(f32(this.m_marginWidth - (this.m_width !== -1 ? this.m_width : 0)) * value / 100);
                        break;
                    }
                    this.m_marginRight = this.m_marginRight >= 0 ? this.m_marginRight : 0;
                    break;
                  }
                }
              }
              return { valid: true, endIndex };
          }

          return { valid: false, endIndex };
        }
        // case MarkupTag.SLASH_MARGIN（TMP_Text.cs:8132）
        case MarkupTag.SLASH_MARGIN:
          this.m_marginLeft = 0;
          this.m_marginRight = 0;
          return { valid: true, endIndex };
        // case MarkupTag.MARGIN_LEFT（TMP_Text.cs:8136）
        case MarkupTag.MARGIN_LEFT: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength); // px

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.m_marginLeft = f32(value * (this.m_isOrthographic ? 1 : 0.1));
              break;
            case TagUnitType_FontUnits:
              this.m_marginLeft = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
              break;
            case TagUnitType_Percentage:
              this.m_marginLeft = f32(f32(this.m_marginWidth - (this.m_width !== -1 ? this.m_width : 0)) * value / 100);
              break;
          }
          this.m_marginLeft = this.m_marginLeft >= 0 ? this.m_marginLeft : 0;
          return { valid: true, endIndex };
        }
        // case MarkupTag.MARGIN_RIGHT（TMP_Text.cs:8156）
        case MarkupTag.MARGIN_RIGHT: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength); // px

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.m_marginRight = f32(value * (this.m_isOrthographic ? 1 : 0.1));
              break;
            case TagUnitType_FontUnits:
              this.m_marginRight = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
              break;
            case TagUnitType_Percentage:
              this.m_marginRight = f32(f32(this.m_marginWidth - (this.m_width !== -1 ? this.m_width : 0)) * value / 100);
              break;
          }
          this.m_marginRight = this.m_marginRight >= 0 ? this.m_marginRight : 0;
          return { valid: true, endIndex };
        }
        // case MarkupTag.LINE_HEIGHT（TMP_Text.cs:8176）
        case MarkupTag.LINE_HEIGHT: {
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          switch (tagUnitType) {
            case TagUnitType_Pixels:
              this.m_lineHeight = f32(value * (this.m_isOrthographic ? 1 : 0.1));
              break;
            case TagUnitType_FontUnits:
              this.m_lineHeight = f32(f32(value * (this.m_isOrthographic ? 1 : 0.1)) * this.m_currentFontSize);
              break;
            case TagUnitType_Percentage:
              fontScale = f32(f32(this.m_currentFontSize / this.m_currentFontAsset!.faceInfo.pointSize) * this.m_currentFontAsset!.faceInfo.scale * (this.m_isOrthographic ? 1 : 0.1));
              this.m_lineHeight = f32(f32(f32(this.m_fontAsset!.faceInfo.lineHeight * value) / 100) * fontScale);
              break;
          }
          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_LINE_HEIGHT（TMP_Text.cs:8196）
        case MarkupTag.SLASH_LINE_HEIGHT:
          this.m_lineHeight = TMP_MATH.FLOAT_UNSET;
          return { valid: true, endIndex };
        // case MarkupTag.NO_PARSE（TMP_Text.cs:8199）
        case MarkupTag.NO_PARSE:
          this.tag_NoParsing = true;
          return { valid: true, endIndex };
        // case MarkupTag.ACTION（TMP_Text.cs:8202）
        case MarkupTag.ACTION: {
          const actionID = this.m_xmlAttribute[0].valueHashCode;

          if (this.m_isTextLayoutPhase) {
            this.m_actionStack.add(actionID);
            // TMP 會 Debug.Log action ID；移植版不需要
          }
          return { valid: true, endIndex };
        }
        // case MarkupTag.SLASH_ACTION（TMP_Text.cs:8218）
        case MarkupTag.SLASH_ACTION:
          this.m_actionStack.remove();
          return { valid: true, endIndex };
        // case MarkupTag.SCALE（TMP_Text.cs:8226）
        case MarkupTag.SCALE:
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          this.m_FXScale = { x: value, y: 1, z: 1 };

          return { valid: true, endIndex };
        // case MarkupTag.SLASH_SCALE（TMP_Text.cs:8235）
        case MarkupTag.SLASH_SCALE:
          this.m_FXScale = { x: 1, y: 1, z: 1 };
          return { valid: true, endIndex };
        // case MarkupTag.ROTATE（TMP_Text.cs:8238）
        case MarkupTag.ROTATE:
          value = this.convertToFloat(this.m_htmlTag, this.m_xmlAttribute[0].valueStartIndex, this.m_xmlAttribute[0].valueLength);

          // Reject tag if value is invalid.
          if (value === -32768) return { valid: false, endIndex };

          // Quaternion.Euler(0, 0, value)：只記角度（z 軸）
          this.m_FXRotationAngle = value;

          return { valid: true, endIndex };
        // case MarkupTag.SLASH_ROTATE（TMP_Text.cs:8248）
        case MarkupTag.SLASH_ROTATE:
          this.m_FXRotationAngle = null;
          return { valid: true, endIndex };
        // case MarkupTag.TABLE（TMP_Text.cs:8251）：原版直接 return false（table 功能沒實作）
        case MarkupTag.TABLE:
          return { valid: false, endIndex };
        // case MarkupTag.SLASH_TABLE（TMP_Text.cs:8275）
        case MarkupTag.SLASH_TABLE:
          return { valid: false, endIndex };
        // case MarkupTag.TR（TMP_Text.cs:8277）
        case MarkupTag.TR:
          return { valid: false, endIndex };
        // case MarkupTag.SLASH_TR（TMP_Text.cs:8279）
        case MarkupTag.SLASH_TR:
          return { valid: false, endIndex };
        // case MarkupTag.TH（TMP_Text.cs:8281）
        case MarkupTag.TH:
          return { valid: false, endIndex };
        // case MarkupTag.SLASH_TH（TMP_Text.cs:8284）
        case MarkupTag.SLASH_TH:
          return { valid: false, endIndex };
        // case MarkupTag.TD（TMP_Text.cs:8286）
        case MarkupTag.TD:
          return { valid: false, endIndex };
        // case MarkupTag.SLASH_TD（TMP_Text.cs:8329）
        case MarkupTag.SLASH_TD:
          return { valid: false, endIndex };
      }
    }
    // #endregion

    return { valid: false, endIndex };
  }

  /** MaterialReference.AddMaterialReference（MaterialReferenceManager.cs:561）：以 material instanceId 當 key */
  protected addMaterialReference(material: MaterialView, fontAsset: FontAssetData): number {
    const materialID = material.instanceId;
    const hit = this.m_materialReferenceIndexLookup.get(materialID);
    if (hit !== undefined) return hit;

    const index = this.m_materialReferenceIndexLookup.size;
    this.m_materialReferenceIndexLookup.set(materialID, index);

    const ref = new MaterialReference(index, fontAsset, null, material, 0);
    ref.isDefaultMaterial = fontAsset.material != null && material.instanceId === fontAsset.material.instanceId;
    ref.referenceCount = 0;
    this.m_materialReferences[index] = ref;

    return index;
  }

  /** MaterialReference.AddMaterialReference 的 sprite 版（MaterialReferenceManager.cs:596） */
  protected addMaterialReferenceSprite(material: MaterialView, spriteAsset: SpriteAssetData): number {
    const materialID = material.instanceId;
    const hit = this.m_materialReferenceIndexLookup.get(materialID);
    if (hit !== undefined) return hit;

    const index = this.m_materialReferenceIndexLookup.size;
    this.m_materialReferenceIndexLookup.set(materialID, index);

    const ref = new MaterialReference(index, this.m_materialReferences[0]?.fontAsset ?? null, spriteAsset, material, 0);
    ref.isDefaultMaterial = true;
    ref.referenceCount = 0;
    this.m_materialReferences[index] = ref;

    return index;
  }

  // MaterialReferenceManager 的 sprite／gradient registry（TryGetSpriteAsset、TryGetColorGradientPreset）
  private spriteAssetRegistry = new Map<number, SpriteAssetData>();
  private colorGradientRegistry = new Map<number, ColorGradientData>();

  protected tryGetSpriteAsset(hashCode: number): SpriteAssetData | null {
    return this.spriteAssetRegistry.get(hashCode) ?? null;
  }
  protected registerSpriteAsset(hashCode: number, asset: SpriteAssetData): void {
    if (!this.spriteAssetRegistry.has(hashCode)) this.spriteAssetRegistry.set(hashCode, asset);
  }
  protected findColorGradientPreset(hashCode: number): ColorGradientData | null {
    return this.colorGradientRegistry.get(hashCode) ?? null;
  }
  protected registerColorGradientPreset(hashCode: number, preset: ColorGradientData): void {
    if (!this.colorGradientRegistry.has(hashCode)) this.colorGradientRegistry.set(hashCode, preset);
  }

  // ════════════════════════ GetPaddingForMaterial（TMP_Text.cs:1797/1815） ════════════════════════

  /** GetPaddingForMaterial（TMP_Text.cs:1797） */
  getPaddingForMaterial(): number {
    if (this.m_sharedMaterial == null) return 0;

    this.m_padding = getPadding(this.m_sharedMaterial, this.m_enableExtraPadding, this.m_isUsingBold);
    this.m_isMaskingEnabled = isMaskingEnabled(this.m_sharedMaterial);
    this.m_isSDFShader = this.m_sharedMaterial.hasProperty('_WeightNormal');

    return this.m_padding;
  }

  // ════════════════════════ GetTextElement（TMP_Text.cs:6077） ════════════════════════

  /**
   * GetTextElement（TMP_Text.cs:6077）：來源字型 → 字型的 fallback → 主要字型和它的 fallback →
   * 元件的 sprite asset → TMP Settings 的 fallback → 預設字型 → 預設 sprite asset。
   */
  getTextElement(unicode: number, fontAsset: FontAssetData, fontStyle: FontStyles, fontWeight: FontWeight): { element: TextElementData | null; isUsingAlternativeTypeface: boolean } {
    let isUsingAlternativeTypeface = false;

    const settings = this.settings;

    if (this.m_EmojiFallbackSupport && isEmoji(unicode)) {
      const emojiRefs = settings.emojiFallbackTextAssetRefs;
      if (emojiRefs.length > 0) {
        const list: (FontAssetData | SpriteAssetData | null)[] = emojiRefs.map((r) => {
          const f = getFontAsset(this.assets, r, this.warnings);
          return f ?? getSpriteAsset(this.assets, r, this.warnings);
        });
        const result = getTextElementFromTextAssets(unicode, fontAsset, list, true, fontStyle, fontWeight);
        if (result.element != null) return { element: result.element, isUsingAlternativeTypeface: result.isAlternativeTypeface };
      }
    }

    let result = getCharacterFromFontAsset(unicode, fontAsset, false, fontStyle, fontWeight);
    let character = result.character;
    isUsingAlternativeTypeface = result.isAlternativeTypeface;

    if (character != null) return { element: character, isUsingAlternativeTypeface };

    // Search potential list of fallback font assets assigned to the font asset.
    if (fontAsset.fallbackFontAssetTable != null && fontAsset.fallbackFontAssetTable.length > 0) {
      result = getCharacterFromFontAssets(unicode, fontAsset, fontAsset.fallbackFontAssetTable, true, fontStyle, fontWeight);
      character = result.character;
      isUsingAlternativeTypeface = result.isAlternativeTypeface;
    }

    if (character != null) return { element: character, isUsingAlternativeTypeface };

    // Search for the character in the primary font asset if not the current font asset
    if (fontAsset.id !== this.m_fontAsset!.id) {
      // Search primary font asset
      result = getCharacterFromFontAsset(unicode, this.m_fontAsset!, false, fontStyle, fontWeight);
      character = result.character;
      isUsingAlternativeTypeface = result.isAlternativeTypeface;

      // Use material and index of primary font asset.
      if (character != null) {
        this.m_currentMaterialIndex = 0;
        this.m_currentMaterial = this.m_materialReferences[0].material;

        return { element: character, isUsingAlternativeTypeface };
      }

      // Search list of potential fallback font assets assigned to the primary font asset.
      if (this.m_fontAsset!.fallbackFontAssetTable != null && this.m_fontAsset!.fallbackFontAssetTable.length > 0) {
        result = getCharacterFromFontAssets(unicode, fontAsset, this.m_fontAsset!.fallbackFontAssetTable, true, fontStyle, fontWeight);
        character = result.character;
        isUsingAlternativeTypeface = result.isAlternativeTypeface;
      }

      if (character != null) return { element: character, isUsingAlternativeTypeface };
    }

    // Search for the character in potential local Sprite Asset assigned to the text object.
    if (this.m_spriteAsset != null) {
      const spriteCharacter = getSpriteCharacterFromSpriteAsset(unicode, this.m_spriteAsset, true);
      if (spriteCharacter != null) return { element: spriteCharacter, isUsingAlternativeTypeface };
    }

    // Search for the character in the list of fallback assigned in the TMP Settings (General Fallbacks).
    const settingsFallbackRefs = settings.fallbackFontAssetRefs;
    if (settingsFallbackRefs.length > 0) {
      const list = settingsFallbackRefs.map((r) => getFontAsset(this.assets, r, this.warnings));
      result = getCharacterFromFontAssets(unicode, fontAsset, list, true, fontStyle, fontWeight);
      character = result.character;
      isUsingAlternativeTypeface = result.isAlternativeTypeface;
    }

    if (character != null) return { element: character, isUsingAlternativeTypeface };

    // Search for the character in the Default Font Asset assigned in the TMP Settings file.
    const defaultFontAsset = settings.defaultFontAssetRef ? getFontAsset(this.assets, settings.defaultFontAssetRef, this.warnings) : null;
    if (defaultFontAsset != null) {
      result = getCharacterFromFontAsset(unicode, defaultFontAsset, true, fontStyle, fontWeight);
      character = result.character;
      isUsingAlternativeTypeface = result.isAlternativeTypeface;
    }

    if (character != null) return { element: character, isUsingAlternativeTypeface };

    // Search for the character in the Default Sprite Asset assigned in the TMP Settings file.
    const defaultSpriteAsset = settings.defaultSpriteAssetRef ? getSpriteAsset(this.assets, settings.defaultSpriteAssetRef, this.warnings) : null;
    if (defaultSpriteAsset != null) {
      const spriteCharacter = getSpriteCharacterFromSpriteAsset(unicode, defaultSpriteAsset, true);
      if (spriteCharacter != null) return { element: spriteCharacter, isUsingAlternativeTypeface };
    }

    return { element: null, isUsingAlternativeTypeface };
  }

  // ════════════════════════ 特殊字元（TMP_Text.cs:5963/5971/6004） ════════════════════════

  /** GetEllipsisSpecialCharacter（TMP_Text.cs:5971） */
  protected getEllipsisSpecialCharacter(fontAsset: FontAssetData): void {
    // Search base font asset
    let character = getCharacterFromFontAsset(0x2026, fontAsset, false, this.m_FontStyleInternal, this.m_FontWeightInternal).character;

    if (character == null) {
      // Search primary fallback list
      if (fontAsset.fallbackFontAssetTable != null && fontAsset.fallbackFontAssetTable.length > 0)
        character = getCharacterFromFontAssets(0x2026, fontAsset, fontAsset.fallbackFontAssetTable, true, this.m_FontStyleInternal, this.m_FontWeightInternal).character;
    }

    const settings = this.settings;

    // Search TMP Settings general fallback list
    if (character == null) {
      const refs = settings.fallbackFontAssetRefs;
      if (refs.length > 0) character = getCharacterFromFontAssets(0x2026, fontAsset, refs.map((r) => getFontAsset(this.assets, r, this.warnings)), true, this.m_FontStyleInternal, this.m_FontWeightInternal).character;
    }

    // Search TMP Settings' default font asset
    if (character == null) {
      const def = settings.defaultFontAssetRef ? getFontAsset(this.assets, settings.defaultFontAssetRef, this.warnings) : null;
      if (def != null) character = getCharacterFromFontAsset(0x2026, def, true, this.m_FontStyleInternal, this.m_FontWeightInternal).character;
    }

    if (character != null) this.m_Ellipsis = SpecialCharacter.create(character, 0);
  }

  /** GetUnderlineSpecialCharacter（TMP_Text.cs:6004）：只搜主要字型（fallback 段在原版是註解掉的） */
  protected getUnderlineSpecialCharacter(fontAsset: FontAssetData): void {
    const character = getCharacterFromFontAsset(0x5f, fontAsset, false, FontStyles.Normal, FontWeight.Regular).character;

    if (character != null) this.m_Underline = SpecialCharacter.create(character, 0);
  }

  // ════════════════════════ SetArraySizes ════════════════════════
  // UGUI 版 TMPro_UGUI_Private.cs:1010–1539；3D 版 TMPro_Private.cs:936–1446。
  // 兩版邏輯相同，差異：linked 文字的清除（UGUI 1097–1109 清整條鏈；3D 1022–1028 只清第一個）、
  // 子網格物件（UGUI 1469 建 TMP_SubMeshUI；3D 1384 建 TMP_SubMesh）——移植版不建 Unity 物件，只算每個材質的 padding。

  /** SetArraySizes（UGUI：TMPro_UGUI_Private.cs:1010；3D：TMPro_Private.cs:936） */
  setArraySizes(textProcessingArray: TextProcessingElement[]): number {
    let spriteCount = 0;

    this.m_totalCharacterCount = 0;
    this.m_isUsingBold = false;
    this.m_isTextLayoutPhase = false;
    this.tag_NoParsing = false;
    this.m_FontStyleInternal = this.m_fontStyle;
    this.m_fontStyleStack.clear();

    this.m_FontWeightInternal = (this.m_FontStyleInternal & FontStyles.Bold) === FontStyles.Bold ? FontWeight.Bold : this.m_fontWeight;
    this.m_FontWeightStack.setDefault(this.m_FontWeightInternal);

    this.m_currentFontAsset = this.m_fontAsset!;
    this.m_currentMaterial = this.m_sharedMaterial!;
    this.m_currentMaterialIndex = 0;

    this.m_materialReferenceStack.setDefault(new MaterialReference(this.m_currentMaterialIndex, this.m_currentFontAsset, null, this.m_currentMaterial, this.m_padding));

    this.m_materialReferenceIndexLookup.clear();
    this.addMaterialReference(this.m_currentMaterial, this.m_currentFontAsset);

    // Set allocations for the text object's TextInfo
    if (this.m_textInfo.characterInfo.length < this.m_InternalTextProcessingArraySize) TmpTextInfo.resizeCharacterInfo(this.m_textInfo.characterInfo, this.m_InternalTextProcessingArraySize);

    this.m_textElementType = TmpTextElementType.Character;

    // #region Setup Underline Special Character（TMPro_UGUI_Private.cs:1044；TMPro_Private.cs:970）：原版整段註解掉，不做事
    // #endregion

    // #region Setup Ellipsis Special Character（TMPro_UGUI_Private.cs:1065；TMPro_Private.cs:991）
    if (this.m_overflowMode === TextOverflowModes.Ellipsis) {
      this.getEllipsisSpecialCharacter(this.m_currentFontAsset);

      if (this.m_Ellipsis.character != null) {
        if (this.m_Ellipsis.fontAsset!.id !== this.m_currentFontAsset.id) {
          const settings = this.settings;
          if (settings.matchMaterialPreset && this.m_currentMaterial!.instanceId !== this.m_Ellipsis.fontAsset!.material.instanceId)
            this.m_Ellipsis.material = getFallbackMaterial(this.m_currentMaterial!, this.m_Ellipsis.fontAsset!.material);
          else this.m_Ellipsis.material = this.m_Ellipsis.fontAsset!.material;

          this.m_Ellipsis.materialIndex = this.addMaterialReference(this.m_Ellipsis.material!, this.m_Ellipsis.fontAsset!);
          this.m_materialReferences[this.m_Ellipsis.materialIndex].referenceCount = 0;
        }
      } else {
        this.m_overflowMode = TextOverflowModes.Truncate;

        if (!this.settings.warningsDisabled) this.warnings.push(`Ellipsis 字元（0x2026）在字型 [${this.m_currentFontAsset.name}] 與其 fallback 都找不到，overflow 改成 Truncate`);
      }
    }
    // #endregion

    // Check if we should process Ligatures
    const ligature = this.m_ActiveFontFeatures.includes(OTL_FeatureTag.liga);

    // Clear Linked Text object content if we have any.
    // UGUI：TMPro_UGUI_Private.cs:1097；3D：TMPro_Private.cs:1021
    if (this.m_overflowMode === TextOverflowModes.Linked && this.m_linkedTextComponentRef != null && !this.m_isCalculatingPreferredValues) {
      // 原版會清掉 linked 元件的文字並觸發它重排；linked 元件是另一個元件，不在這個介面裡
      this.warnings.push('TextOverflowModes.Linked：linked 元件的連動重排不在這個模組裡（需要場景端串接）');
    }

    // Parsing XML tags in the text
    for (let i = 0; i < textProcessingArray.length && textProcessingArray[i].unicode !== 0; i++) {
      // Make sure the characterInfo array can hold the next text element.
      if (this.m_totalCharacterCount >= this.m_textInfo.characterInfo.length) TmpTextInfo.resizeCharacterInfo(this.m_textInfo.characterInfo, this.m_totalCharacterCount + 1);

      let unicode = textProcessingArray[i].unicode;

      // #region PARSE XML TAGS（TMPro_UGUI_Private.cs:1122；TMPro_Private.cs:1036）
      if (this.m_isRichText && unicode === 60) {
        // if Char '<'
        const prev_MaterialIndex = this.m_currentMaterialIndex;

        // Check if Tag is Valid
        const tagResult = this.validateHtmlTag(textProcessingArray, i + 1);
        if (tagResult.valid) {
          const tagStartIndex = textProcessingArray[i].stringIndex;
          i = tagResult.endIndex;

          if ((this.m_FontStyleInternal & FontStyles.Bold) === FontStyles.Bold) this.m_isUsingBold = true;

          const elementTypeAfterTag: TmpTextElementType = this.m_textElementType;
          if (Number(elementTypeAfterTag) === TmpTextElementType.Sprite) {
            this.m_materialReferences[this.m_currentMaterialIndex].referenceCount += 1;

            this.m_textInfo.characterInfo[this.m_totalCharacterCount].character = 57344 + this.m_spriteIndex;
            this.m_textInfo.characterInfo[this.m_totalCharacterCount].fontAsset = this.m_currentFontAsset;
            this.m_textInfo.characterInfo[this.m_totalCharacterCount].materialReferenceIndex = this.m_currentMaterialIndex;
            this.m_textInfo.characterInfo[this.m_totalCharacterCount].textElement = this.m_currentSpriteAsset!.spriteCharacterTable[this.m_spriteIndex];
            this.m_textInfo.characterInfo[this.m_totalCharacterCount].elementType = this.m_textElementType;
            this.m_textInfo.characterInfo[this.m_totalCharacterCount].index = tagStartIndex;
            this.m_textInfo.characterInfo[this.m_totalCharacterCount].stringLength = textProcessingArray[i].stringIndex - tagStartIndex + 1;

            // Restore element type and material index to previous values.
            this.m_textElementType = TmpTextElementType.Character;
            this.m_currentMaterialIndex = prev_MaterialIndex;

            spriteCount += 1;
            this.m_totalCharacterCount += 1;
          }

          continue;
        }
      }
      // #endregion

      let isUsingAlternativeTypeface = false;
      let isUsingFallbackOrAlternativeTypeface = false;

      const prev_fontAsset: FontAssetData | null = this.m_currentFontAsset;
      const prev_material: MaterialView | null = this.m_currentMaterial;
      const prev_materialIndex = this.m_currentMaterialIndex;

      // #region Handling of LowerCase, UpperCase and SmallCaps Font Styles（TMPro_UGUI_Private.cs:1170；TMPro_Private.cs:1084）
      if (this.m_textElementType === TmpTextElementType.Character) {
        if ((this.m_FontStyleInternal & FontStyles.UpperCase) === FontStyles.UpperCase) {
          // If this character is lowercase, switch to uppercase.
          if (charIsLower(unicode)) unicode = charToUpper(unicode);
        } else if ((this.m_FontStyleInternal & FontStyles.LowerCase) === FontStyles.LowerCase) {
          // If this character is uppercase, switch to lowercase.
          if (charIsUpper(unicode)) unicode = charToLower(unicode);
        } else if ((this.m_FontStyleInternal & FontStyles.SmallCaps) === FontStyles.SmallCaps) {
          // Only convert lowercase characters to uppercase.
          if (charIsLower(unicode)) unicode = charToUpper(unicode);
        }
      }
      // #endregion

      // #region LOOKUP GLYPH（TMPro_UGUI_Private.cs:1196；TMPro_Private.cs:1110）
      const lookup = this.getTextElement(unicode, this.m_currentFontAsset!, this.m_FontStyleInternal, this.m_FontWeightInternal);
      let character = lookup.element;
      isUsingAlternativeTypeface = lookup.isUsingAlternativeTypeface;

      // Special handling for missing character.
      // Replace missing glyph by the Square (9633) glyph or possibly the Space (32) glyph.
      if (character == null) {
        // Save the original unicode character
        const srcGlyph = unicode;

        // Try replacing the missing glyph character by TMP Settings Missing Glyph or Square (9633) character.
        unicode = textProcessingArray[i].unicode = this.settings.missingGlyphCharacter === 0 ? 9633 : this.settings.missingGlyphCharacter;

        // Check for the missing glyph character in the currently assigned font asset and its fallbacks
        let r = getCharacterFromFontAsset(unicode, this.m_currentFontAsset!, true, this.m_FontStyleInternal, this.m_FontWeightInternal);
        character = r.character;
        isUsingAlternativeTypeface = r.isAlternativeTypeface;

        if (character == null) {
          // Search for the missing glyph character in the TMP Settings Fallback list.
          const refs = this.settings.fallbackFontAssetRefs;
          if (refs.length > 0) {
            r = getCharacterFromFontAssets(unicode, this.m_currentFontAsset!, refs.map((x) => getFontAsset(this.assets, x, this.warnings)), true, this.m_FontStyleInternal, this.m_FontWeightInternal);
            character = r.character;
            isUsingAlternativeTypeface = r.isAlternativeTypeface;
          }
        }

        if (character == null) {
          // Search for the missing glyph in the TMP Settings Default Font Asset.
          const def = this.settings.defaultFontAssetRef ? getFontAsset(this.assets, this.settings.defaultFontAssetRef, this.warnings) : null;
          if (def != null) {
            r = getCharacterFromFontAsset(unicode, def, true, this.m_FontStyleInternal, this.m_FontWeightInternal);
            character = r.character;
            isUsingAlternativeTypeface = r.isAlternativeTypeface;
          }
        }

        if (character == null) {
          // Use Space (32) Glyph from the currently assigned font asset.
          unicode = textProcessingArray[i].unicode = 32;
          r = getCharacterFromFontAsset(unicode, this.m_currentFontAsset!, true, this.m_FontStyleInternal, this.m_FontWeightInternal);
          character = r.character;
          isUsingAlternativeTypeface = r.isAlternativeTypeface;
        }

        if (character == null) {
          // Use End of Text (0x03) Glyph from the currently assigned font asset.
          unicode = textProcessingArray[i].unicode = 0x03;
          r = getCharacterFromFontAsset(unicode, this.m_currentFontAsset!, true, this.m_FontStyleInternal, this.m_FontWeightInternal);
          character = r.character;
          isUsingAlternativeTypeface = r.isAlternativeTypeface;
        }

        if (!this.settings.warningsDisabled) {
          this.warnings.push(
            srcGlyph > 0xffff
              ? `字元 \\U${srcGlyph.toString(16).padStart(8, '0')} 在字型 [${this.m_fontAsset?.name}] 與其 fallback 都找不到，換成 \\u${character ? (character.unicode).toString(16).padStart(4, '0') : '????'}`
              : `字元 \\u${srcGlyph.toString(16).padStart(4, '0')} 在字型 [${this.m_fontAsset?.name}] 與其 fallback 都找不到，換成 \\u${character ? (character.unicode).toString(16).padStart(4, '0') : '????'}`,
          );
        }
      }

      this.m_textInfo.characterInfo[this.m_totalCharacterCount].alternativeGlyph = null;

      if (character != null && character.elementType === TextElementType.Character) {
        if (character.textAsset != null && (character.textAsset as FontAssetData).id !== this.m_currentFontAsset.id) {
          isUsingFallbackOrAlternativeTypeface = true;
          this.m_currentFontAsset = character.textAsset as FontAssetData;
        }

        // #region VARIATION SELECTOR（TMPro_UGUI_Private.cs:1278；TMPro_Private.cs:1192）
        const nextCharacter = i + 1 < textProcessingArray.length ? textProcessingArray[i + 1].unicode : 0;
        if (nextCharacter >= 0xfe00 && nextCharacter <= 0xfe0f) {
          // Get potential variant glyph index
          const variantGlyphIndex = this.m_currentFontAsset.getGlyphVariantIndex(unicode, nextCharacter);

          if (variantGlyphIndex !== 0) {
            const glyph = this.m_currentFontAsset.tryAddGlyphInternal(variantGlyphIndex);
            if (glyph) this.m_textInfo.characterInfo[this.m_totalCharacterCount].alternativeGlyph = glyph;
          }

          textProcessingArray[i + 1].unicode = 0x1a;
          i += 1;
        }
        // #endregion

        // #region LIGATURES（TMPro_UGUI_Private.cs:1298；TMPro_Private.cs:1212）
        if (ligature) {
          const records = this.m_currentFontAsset.featureTable.ligatureLookup.get(character.glyphIndex >>> 0);
          if (records != null) {
            for (let j = 0; j < records.length; j++) {
              const record = records[j];

              const componentCount = record.componentGlyphIDs.length;
              let ligatureGlyphID = record.ligatureGlyphID;

              for (let k = 1; k < componentCount; k++) {
                const componentUnicode = textProcessingArray[i + k].unicode;

                const glyphIndex = this.m_currentFontAsset.getGlyphIndex(componentUnicode);

                if (glyphIndex === record.componentGlyphIDs[k]) continue;

                ligatureGlyphID = 0;
                break;
              }

              if (ligatureGlyphID !== 0) {
                const glyph = this.m_currentFontAsset.tryAddGlyphInternal(ligatureGlyphID);
                if (glyph) {
                  this.m_textInfo.characterInfo[this.m_totalCharacterCount].alternativeGlyph = glyph;

                  // Update text processing array
                  for (let c = 0; c < componentCount; c++) {
                    if (c === 0) {
                      textProcessingArray[i + c].length = componentCount;
                      continue;
                    }

                    textProcessingArray[i + c].unicode = 0x1a;
                  }

                  i += componentCount - 1;
                  break;
                }
              }
            }
          }
        }
        // #endregion
      }
      // #endregion

      // Save text element data
      this.m_textInfo.characterInfo[this.m_totalCharacterCount].elementType = TmpTextElementType.Character;
      this.m_textInfo.characterInfo[this.m_totalCharacterCount].textElement = character;
      this.m_textInfo.characterInfo[this.m_totalCharacterCount].isUsingAlternateTypeface = isUsingAlternativeTypeface;
      this.m_textInfo.characterInfo[this.m_totalCharacterCount].character = unicode & 0xffff;
      this.m_textInfo.characterInfo[this.m_totalCharacterCount].index = textProcessingArray[i].stringIndex;
      this.m_textInfo.characterInfo[this.m_totalCharacterCount].stringLength = textProcessingArray[i].length;
      this.m_textInfo.characterInfo[this.m_totalCharacterCount].fontAsset = this.m_currentFontAsset;

      // Special handling if the character is a sprite.
      if (character != null && character.elementType === TextElementType.Sprite) {
        const spriteAssetRef = character.textAsset as SpriteAssetData;
        this.m_currentMaterialIndex = this.addMaterialReferenceSprite(spriteAssetRef.material, spriteAssetRef);
        this.m_materialReferences[this.m_currentMaterialIndex].referenceCount += 1;

        this.m_textInfo.characterInfo[this.m_totalCharacterCount].elementType = TmpTextElementType.Sprite;
        this.m_textInfo.characterInfo[this.m_totalCharacterCount].materialReferenceIndex = this.m_currentMaterialIndex;

        // Restore element type and material index to previous values.
        this.m_textElementType = TmpTextElementType.Character;
        this.m_currentMaterialIndex = prev_materialIndex;

        spriteCount += 1;
        this.m_totalCharacterCount += 1;

        continue;
      }

      if (isUsingFallbackOrAlternativeTypeface && this.m_currentFontAsset.id !== this.m_fontAsset!.id) {
        // Create Fallback material instance matching current material preset if necessary
        if (this.settings.matchMaterialPreset) this.m_currentMaterial = getFallbackMaterial(this.m_currentMaterial!, this.m_currentFontAsset.material);
        else this.m_currentMaterial = this.m_currentFontAsset.material;

        this.m_currentMaterialIndex = this.addMaterialReference(this.m_currentMaterial!, this.m_currentFontAsset);
      }

      // Handle Multi Atlas Texture support
      if (character != null && character.glyph.atlasIndex > 0) {
        // m_AtlasTextures 是貼圖參照清單，TextAssets 介面沒有；多 atlas 只會出現在動態字型（本遊戲的動態字型只有一張 atlas）
        const fontData = this.assets.object(this.m_currentFontAsset.ref);
        const atlasTextures = (fontData?.m_AtlasTextures as (ExternalRef | null)[]) ?? [];
        const texRef = atlasTextures[character.glyph.atlasIndex] ?? null;
        if (texRef?.guid) {
          this.m_currentMaterial = getFallbackMaterialForAtlas(this.m_currentMaterial!, texRef);
          this.m_currentMaterialIndex = this.addMaterialReference(this.m_currentMaterial, this.m_currentFontAsset);
          isUsingFallbackOrAlternativeTypeface = true;
        } else {
          this.warnings.push(`字型 ${this.m_currentFontAsset.name} 的字元 U+${unicode.toString(16)} 在 atlas ${character.glyph.atlasIndex}，但貼圖清單拿不到（多 atlas 沒有對應材質）`);
        }
      }

      if (!charIsWhiteSpace(unicode) && unicode !== 0x200b) {
        // Limit the mesh of the main text object to 65535 vertices and use sub objects for the overflow.
        if (this.m_materialReferences[this.m_currentMaterialIndex].referenceCount < 16383) this.m_materialReferences[this.m_currentMaterialIndex].referenceCount += 1;
        else {
          // 超過 16383 個字：原版複製材質開新子網格
          this.m_currentMaterialIndex = this.addMaterialReference(this.m_currentMaterial!.clone(), this.m_currentFontAsset);
          this.m_materialReferences[this.m_currentMaterialIndex].referenceCount += 1;
        }
      }

      this.m_textInfo.characterInfo[this.m_totalCharacterCount].material = this.m_currentMaterial;
      this.m_textInfo.characterInfo[this.m_totalCharacterCount].materialReferenceIndex = this.m_currentMaterialIndex;
      this.m_materialReferences[this.m_currentMaterialIndex].isFallbackMaterial = isUsingFallbackOrAlternativeTypeface;

      // Restore previous font asset and material if fallback font was used.
      if (isUsingFallbackOrAlternativeTypeface) {
        this.m_materialReferences[this.m_currentMaterialIndex].fallbackMaterial = prev_material;
        this.m_currentFontAsset = prev_fontAsset;
        this.m_currentMaterial = prev_material;
        this.m_currentMaterialIndex = prev_materialIndex;
      }

      this.m_totalCharacterCount += 1;
    }

    // Early return if we are calculating the preferred values.
    if (this.m_isCalculatingPreferredValues) {
      this.m_isCalculatingPreferredValues = false;

      return this.m_totalCharacterCount;
    }

    // Save material and sprite count.
    this.m_textInfo.spriteCount = spriteCount;
    const materialCount = (this.m_textInfo.materialCount = this.m_materialReferenceIndexLookup.size);

    // Check if we need to resize the MeshInfo array for handling different materials.
    if (materialCount > this.m_textInfo.meshInfo.length) TmpTextInfo.resizeMeshInfo(this.m_textInfo.meshInfo, materialCount);

    // Iterate through the material references to set the mesh buffer allocations
    for (let i = 0; i < materialCount; i++) {
      // UGUI 1462–1521／3D 1387–1450：建子網格物件、配頂點緩衝。移植版直接配緩衝＋算子網格 padding。
      const referenceCount = this.m_materialReferences[i].referenceCount;

      if (this.m_textInfo.meshInfo[i].vertices.length < referenceCount * 4) {
        this.m_textInfo.meshInfo[i].resizeMeshInfo(referenceCount > 1024 ? referenceCount + 256 : nextPowerOfTwo(referenceCount + 1));
      }

      // Assign material reference
      this.m_textInfo.meshInfo[i].material = this.m_materialReferences[i].material;

      // TMP_SubMeshUI.sharedMaterial setter 會算 padding（TMP_SubMeshUI.cs:394）；主網格用 m_padding
      this.m_subObjectPadding.set(i, i === 0 ? this.m_padding : getPadding(this.m_materialReferences[i].material, this.m_enableExtraPadding, this.m_isUsingBold));
    }

    return this.m_totalCharacterCount;
  }

  // ════════════════════════ 排版輔助（TMP_Text.cs） ════════════════════════

  /** SaveWordWrappingState（TMP_Text.cs:5027） */
  saveWordWrappingState(state: WordWrapState, index: number, count: number): void {
    // Multi Font & Material support related
    state.currentFontAsset = this.m_currentFontAsset;
    state.currentSpriteAsset = this.m_currentSpriteAsset;
    state.currentMaterial = this.m_currentMaterial;
    state.currentMaterialIndex = this.m_currentMaterialIndex;

    state.previous_WordBreak = index;
    state.total_CharacterCount = count;
    state.visible_CharacterCount = this.m_lineVisibleCharacterCount;
    state.visibleSpaceCount = this.m_lineVisibleSpaceCount;
    state.visible_LinkCount = this.m_textInfo.linkCount;

    state.firstCharacterIndex = this.m_firstCharacterOfLine;
    state.firstVisibleCharacterIndex = this.m_firstVisibleCharacterOfLine;
    state.lastVisibleCharIndex = this.m_lastVisibleCharacterOfLine;

    state.fontStyle = this.m_FontStyleInternal;
    state.italicAngle = this.m_ItalicAngle;
    state.fontScaleMultiplier = this.m_fontScaleMultiplier;
    state.currentFontSize = this.m_currentFontSize;

    state.xAdvance = this.m_xAdvance;
    state.maxCapHeight = this.m_maxCapHeight;
    state.maxAscender = this.m_maxTextAscender;
    state.maxDescender = this.m_ElementDescender;
    state.startOfLineAscender = this.m_startOfLineAscender;
    state.maxLineAscender = this.m_maxLineAscender;
    state.maxLineDescender = this.m_maxLineDescender;
    state.pageAscender = this.m_PageAscender;

    state.preferredWidth = this.m_preferredWidth;
    state.preferredHeight = this.m_preferredHeight;
    state.renderedWidth = this.m_RenderedWidth;
    state.renderedHeight = this.m_RenderedHeight;
    state.meshExtents = { min: { ...this.m_meshExtents.min }, max: { ...this.m_meshExtents.max } };

    state.lineNumber = this.m_lineNumber;
    state.lineOffset = this.m_lineOffset;
    state.baselineOffset = this.m_baselineOffset;
    state.isDrivenLineSpacing = this.m_IsDrivenLineSpacing;
    state.lastBaseGlyphIndex = this.m_LastBaseGlyphIndex;

    state.cSpace = this.m_cSpacing;
    state.mSpace = this.m_monoSpacing;

    state.horizontalAlignment = this.m_lineJustification;
    state.marginLeft = this.m_marginLeft;
    state.marginRight = this.m_marginRight;

    state.vertexColor = { ...this.m_htmlColor };
    state.underlineColor = { ...this.m_underlineColor };
    state.strikethroughColor = { ...this.m_strikethroughColor };
    state.highlightState = { color: { ...this.m_HighlightState.color }, padding: { ...this.m_HighlightState.padding } };

    state.isNonBreakingSpace = this.m_isNonBreakingSpace;
    state.tagNoParsing = this.tag_NoParsing;

    state.fxRotation = { angle: this.m_FXRotationAngle ?? 0 };
    state.fxScale = { ...this.m_FXScale };

    // XML Tag Stack
    state.basicStyleStack = this.m_fontStyleStack.snapshot();
    state.italicAngleStack = this.m_ItalicAngleStack.snapshot();
    state.colorStack = this.m_colorStack.snapshot();
    state.underlineColorStack = this.m_underlineColorStack.snapshot();
    state.strikethroughColorStack = this.m_strikethroughColorStack.snapshot();
    state.highlightStateStack = this.m_HighlightStateStack.snapshot();
    state.colorGradientStack = this.m_colorGradientStack.snapshot();
    state.sizeStack = this.m_sizeStack.snapshot();
    state.indentStack = this.m_indentStack.snapshot();
    state.fontWeightStack = this.m_FontWeightStack.snapshot();

    state.baselineStack = this.m_baselineOffsetStack.snapshot();
    state.actionStack = this.m_actionStack.snapshot();
    state.materialReferenceStack = this.m_materialReferenceStack.snapshot();
    state.lineJustificationStack = this.m_lineJustificationStack.snapshot();

    state.spriteAnimationID = this.m_spriteAnimationID;

    if (this.m_lineNumber < this.m_textInfo.lineInfo.length) state.lineInfo = this.m_textInfo.lineInfo[this.m_lineNumber].clone();
  }

  /** RestoreWordWrappingState（TMP_Text.cs:5122） */
  restoreWordWrappingState(state: WordWrapState): number {
    const index = state.previous_WordBreak;

    // Multi Font & Material support related
    this.m_currentFontAsset = state.currentFontAsset;
    this.m_currentSpriteAsset = state.currentSpriteAsset;
    this.m_currentMaterial = state.currentMaterial;
    this.m_currentMaterialIndex = state.currentMaterialIndex;

    this.m_characterCount = state.total_CharacterCount + 1;
    this.m_lineVisibleCharacterCount = state.visible_CharacterCount;
    this.m_lineVisibleSpaceCount = state.visibleSpaceCount;
    this.m_textInfo.linkCount = state.visible_LinkCount;

    this.m_firstCharacterOfLine = state.firstCharacterIndex;
    this.m_firstVisibleCharacterOfLine = state.firstVisibleCharacterIndex;
    this.m_lastVisibleCharacterOfLine = state.lastVisibleCharIndex;

    this.m_FontStyleInternal = state.fontStyle;
    this.m_ItalicAngle = state.italicAngle;
    this.m_fontScaleMultiplier = state.fontScaleMultiplier;
    this.m_currentFontSize = state.currentFontSize;

    this.m_xAdvance = state.xAdvance;
    this.m_maxCapHeight = state.maxCapHeight;
    this.m_maxTextAscender = state.maxAscender;
    this.m_ElementDescender = state.maxDescender;
    this.m_startOfLineAscender = state.startOfLineAscender;
    this.m_maxLineAscender = state.maxLineAscender;
    this.m_maxLineDescender = state.maxLineDescender;
    this.m_PageAscender = state.pageAscender;

    this.m_preferredWidth = state.preferredWidth;
    this.m_preferredHeight = state.preferredHeight;
    this.m_RenderedWidth = state.renderedWidth;
    this.m_RenderedHeight = state.renderedHeight;
    this.m_meshExtents = { min: { ...state.meshExtents.min }, max: { ...state.meshExtents.max } };

    this.m_lineNumber = state.lineNumber;
    this.m_lineOffset = state.lineOffset;
    this.m_baselineOffset = state.baselineOffset;
    this.m_IsDrivenLineSpacing = state.isDrivenLineSpacing;
    this.m_LastBaseGlyphIndex = state.lastBaseGlyphIndex;

    this.m_cSpacing = state.cSpace;
    this.m_monoSpacing = state.mSpace;

    this.m_lineJustification = state.horizontalAlignment;
    this.m_marginLeft = state.marginLeft;
    this.m_marginRight = state.marginRight;

    this.m_htmlColor = { ...state.vertexColor };
    this.m_underlineColor = { ...state.underlineColor };
    this.m_strikethroughColor = { ...state.strikethroughColor };
    this.m_HighlightState = { color: { ...state.highlightState.color }, padding: { ...state.highlightState.padding } };

    this.m_isNonBreakingSpace = state.isNonBreakingSpace;
    this.tag_NoParsing = state.tagNoParsing;

    this.m_FXRotationAngle = state.fxRotation.angle === 0 ? null : state.fxRotation.angle;
    this.m_FXScale = { ...state.fxScale };

    // XML Tag Stack
    if (state.basicStyleStack) this.m_fontStyleStack = state.basicStyleStack.snapshot();
    if (state.italicAngleStack) this.m_ItalicAngleStack = state.italicAngleStack.snapshot();
    if (state.colorStack) this.m_colorStack = state.colorStack.snapshot();
    if (state.underlineColorStack) this.m_underlineColorStack = state.underlineColorStack.snapshot();
    if (state.strikethroughColorStack) this.m_strikethroughColorStack = state.strikethroughColorStack.snapshot();
    if (state.highlightStateStack) this.m_HighlightStateStack = state.highlightStateStack.snapshot();
    if (state.colorGradientStack) this.m_colorGradientStack = state.colorGradientStack.snapshot();
    if (state.sizeStack) this.m_sizeStack = state.sizeStack.snapshot();
    if (state.indentStack) this.m_indentStack = state.indentStack.snapshot();
    if (state.fontWeightStack) this.m_FontWeightStack = state.fontWeightStack.snapshot();

    if (state.baselineStack) this.m_baselineOffsetStack = state.baselineStack.snapshot();
    if (state.actionStack) this.m_actionStack = state.actionStack.snapshot();
    if (state.materialReferenceStack) this.m_materialReferenceStack = state.materialReferenceStack.snapshot();
    if (state.lineJustificationStack) this.m_lineJustificationStack = state.lineJustificationStack.snapshot();

    this.m_spriteAnimationID = state.spriteAnimationID;

    if (this.m_lineNumber < this.m_textInfo.lineInfo.length && state.lineInfo) this.m_textInfo.lineInfo[this.m_lineNumber] = state.lineInfo.clone();

    return index;
  }

  /** AdjustLineOffset（TMP_Text.cs:4865）：減去（0, offset, 0） */
  adjustLineOffset(startIndex: number, endIndex: number, offset: number): void {
    for (let i = startIndex; i <= endIndex; i++) {
      const c = this.m_textInfo.characterInfo[i];
      c.bottomLeft.y = f32(c.bottomLeft.y - offset);
      c.topLeft.y = f32(c.topLeft.y - offset);
      c.topRight.y = f32(c.topRight.y - offset);
      c.bottomRight.y = f32(c.bottomRight.y - offset);

      c.ascender = f32(c.ascender - offset);
      c.baseLine = f32(c.baseLine - offset);
      c.descender = f32(c.descender - offset);

      if (c.isVisible) {
        c.vertex_BL.position.y = f32(c.vertex_BL.position.y - offset);
        c.vertex_TL.position.y = f32(c.vertex_TL.position.y - offset);
        c.vertex_TR.position.y = f32(c.vertex_TR.position.y - offset);
        c.vertex_BR.position.y = f32(c.vertex_BR.position.y - offset);
      }
    }
  }

  /** ResizeLineExtents（TMP_Text.cs:4895） */
  resizeLineExtents(size: number): void {
    const newSize = size > 1024 ? size + 256 : nextPowerOfTwo(size + 1);
    TmpTextInfo.resizeLineInfo(this.m_textInfo.lineInfo, newSize);
  }

  /** InsertNewLine（TMP_Text.cs:4937） */
  insertNewLine(
    i: number,
    baseScale: number,
    currentElementScale: number,
    currentEmScale: number,
    boldSpacingAdjustment: number,
    characterSpacingAdjustment: number,
    width: number,
    lineGap: number,
    state: { isMaxVisibleDescenderSet: boolean; maxVisibleDescender: number },
  ): void {
    // Adjust line spacing if necessary
    const baselineAdjustmentDelta = f32(this.m_maxLineAscender - this.m_startOfLineAscender);
    if (this.m_lineOffset > 0 && Math.abs(baselineAdjustmentDelta) > 0.01 && this.m_IsDrivenLineSpacing === false && !this.m_isNewPage) {
      this.adjustLineOffset(this.m_firstCharacterOfLine, this.m_characterCount, baselineAdjustmentDelta);
      this.m_ElementDescender = f32(this.m_ElementDescender - baselineAdjustmentDelta);
      this.m_lineOffset = f32(this.m_lineOffset + baselineAdjustmentDelta);
    }

    // Calculate lineAscender & make sure if last character is superscript or subscript that we check that as well.
    const lineAscender = f32(this.m_maxLineAscender - this.m_lineOffset);
    const lineDescender = f32(this.m_maxLineDescender - this.m_lineOffset);

    // Update maxDescender and maxVisibleDescender
    this.m_ElementDescender = this.m_ElementDescender < lineDescender ? this.m_ElementDescender : lineDescender;
    if (!state.isMaxVisibleDescenderSet) state.maxVisibleDescender = this.m_ElementDescender;

    if (this.m_useMaxVisibleDescender && (this.m_characterCount >= this.m_maxVisibleCharacters || this.m_lineNumber >= this.m_maxVisibleLines)) state.isMaxVisibleDescenderSet = true;

    // Track & Store lineInfo for the new line
    this.m_textInfo.lineInfo[this.m_lineNumber].firstCharacterIndex = this.m_firstCharacterOfLine;
    this.m_textInfo.lineInfo[this.m_lineNumber].firstVisibleCharacterIndex = this.m_firstVisibleCharacterOfLine = this.m_firstCharacterOfLine > this.m_firstVisibleCharacterOfLine ? this.m_firstCharacterOfLine : this.m_firstVisibleCharacterOfLine;
    this.m_textInfo.lineInfo[this.m_lineNumber].lastCharacterIndex = this.m_lastCharacterOfLine = this.m_characterCount - 1 > 0 ? this.m_characterCount - 1 : 0;
    this.m_textInfo.lineInfo[this.m_lineNumber].lastVisibleCharacterIndex = this.m_lastVisibleCharacterOfLine = this.m_lastVisibleCharacterOfLine < this.m_firstVisibleCharacterOfLine ? this.m_firstVisibleCharacterOfLine : this.m_lastVisibleCharacterOfLine;

    this.m_textInfo.lineInfo[this.m_lineNumber].characterCount = this.m_textInfo.lineInfo[this.m_lineNumber].lastCharacterIndex - this.m_textInfo.lineInfo[this.m_lineNumber].firstCharacterIndex + 1;
    this.m_textInfo.lineInfo[this.m_lineNumber].visibleCharacterCount = this.m_lineVisibleCharacterCount;
    this.m_textInfo.lineInfo[this.m_lineNumber].visibleSpaceCount = this.m_lineVisibleSpaceCount;
    this.m_textInfo.lineInfo[this.m_lineNumber].lineExtents.min = { x: this.m_textInfo.characterInfo[this.m_firstVisibleCharacterOfLine].bottomLeft.x, y: lineDescender };
    this.m_textInfo.lineInfo[this.m_lineNumber].lineExtents.max = { x: this.m_textInfo.characterInfo[this.m_lastVisibleCharacterOfLine].topRight.x, y: lineAscender };
    this.m_textInfo.lineInfo[this.m_lineNumber].length = this.m_textInfo.lineInfo[this.m_lineNumber].lineExtents.max.x;
    this.m_textInfo.lineInfo[this.m_lineNumber].width = width;

    const glyphAdjustment = this.m_textInfo.characterInfo[this.m_lastVisibleCharacterOfLine].adjustedHorizontalAdvance;
    const maxAdvanceOffset = f32(f32(f32(glyphAdjustment * currentElementScale) + f32((this.m_currentFontAsset!.normalSpacingOffset + characterSpacingAdjustment + boldSpacingAdjustment) * currentEmScale)) + this.m_cSpacing) * f32(1 - this.m_charWidthAdjDelta);
    const adjustedHorizontalAdvance = (this.m_textInfo.lineInfo[this.m_lineNumber].maxAdvance = f32(
      this.m_textInfo.characterInfo[this.m_lastVisibleCharacterOfLine].xAdvance + (this.m_isRightToLeft ? maxAdvanceOffset : -maxAdvanceOffset),
    ));
    this.m_textInfo.characterInfo[this.m_lastVisibleCharacterOfLine].xAdvance = adjustedHorizontalAdvance;

    this.m_textInfo.lineInfo[this.m_lineNumber].baseline = f32(0 - this.m_lineOffset);
    this.m_textInfo.lineInfo[this.m_lineNumber].ascender = lineAscender;
    this.m_textInfo.lineInfo[this.m_lineNumber].descender = lineDescender;
    this.m_textInfo.lineInfo[this.m_lineNumber].lineHeight = f32(f32(lineAscender - lineDescender) + f32(lineGap * baseScale));

    this.m_firstCharacterOfLine = this.m_characterCount; // Store first character of the next line.
    this.m_lineVisibleCharacterCount = 0;
    this.m_lineVisibleSpaceCount = 0;

    // Store the state of the line before starting on the new line.
    this.saveWordWrappingState(this.m_SavedLineState, i, this.m_characterCount - 1);

    this.m_lineNumber += 1;

    // Check to make sure Array is large enough to hold a new line.
    if (this.m_lineNumber >= this.m_textInfo.lineInfo.length) this.resizeLineExtents(this.m_lineNumber);

    // Apply Line Spacing based on scale of the last character of the line.
    if (this.m_lineHeight === TMP_MATH.FLOAT_UNSET) {
      const ascender = this.m_textInfo.characterInfo[this.m_characterCount].adjustedAscender;
      const lineOffsetDelta = f32(f32(f32(f32(0 - this.m_maxLineDescender) + ascender) + f32((lineGap + this.m_lineSpacingDelta) * baseScale)) + f32(this.m_lineSpacing * currentEmScale));
      this.m_lineOffset = f32(this.m_lineOffset + lineOffsetDelta);

      this.m_startOfLineAscender = ascender;
    } else {
      this.m_lineOffset = f32(this.m_lineOffset + f32(this.m_lineHeight + f32(this.m_lineSpacing * currentEmScale)));
    }

    this.m_maxLineAscender = k_LargeNegativeFloat;
    this.m_maxLineDescender = k_LargePositiveFloat;

    this.m_xAdvance = f32(0 + this.tag_Indent);
  }

  // ════════════════════════ 頂點儲存（TMP_Text.cs） ════════════════════════

  /** SaveGlyphVertexInfo（TMP_Text.cs:5220） */
  saveGlyphVertexInfo(padding: number, style_padding: number, vertexColor: Color32): void {
    const ci = this.m_textInfo.characterInfo[this.m_characterCount];

    // Save the Vertex Position for the Character
    // #region Setup Mesh Vertices（TMP_Text.cs:5224）
    ci.vertex_BL.position = { ...ci.bottomLeft };
    ci.vertex_TL.position = { ...ci.topLeft };
    ci.vertex_TR.position = { ...ci.topRight };
    ci.vertex_BR.position = { ...ci.bottomRight };
    // #endregion

    // #region Setup Vertex Colors（TMP_Text.cs:5232）
    // Alpha is the lower of the vertex color or tag color alpha used.
    vertexColor = { ...vertexColor, a: this.m_fontColor32.a < vertexColor.a ? this.m_fontColor32.a : vertexColor.a };

    // TEXTCORE_FONT_ENGINE_1_5_OR_NEWER：DLL 裡有編進去（用舊的 GlyphRenderMode 列舉，RASTER_MODE_COLOR = 0x10000）
    const isColorGlyph = ((this.m_currentFontAsset!.atlasRenderMode & 0x10000) === 0x10000); // GlyphRenderMode.RASTER_MODE_COLOR（DLL）

    // Handle Vertex Colors & Vertex Color Gradient
    if (!this.m_enableVertexGradient || isColorGlyph) {
      // Special handling for color glyphs
      const vc = isColorGlyph ? color32(255, 255, 255, vertexColor.a) : vertexColor;

      ci.vertex_BL.color = { ...vc };
      ci.vertex_TL.color = { ...vc };
      ci.vertex_TR.color = { ...vc };
      ci.vertex_BR.color = { ...vc };
    } else {
      if (!this.m_overrideHtmlColors && this.m_colorStack.index > 1) {
        ci.vertex_BL.color = { ...vertexColor };
        ci.vertex_TL.color = { ...vertexColor };
        ci.vertex_TR.color = { ...vertexColor };
        ci.vertex_BR.color = { ...vertexColor };
      } else {
        // Handle Vertex Color Gradient
        // Use Vertex Color Gradient Preset (if one is assigned)
        if (this.m_fontColorGradientPreset != null) {
          ci.vertex_BL.color = color32Multiply(this.m_fontColorGradientPreset.bottomLeft, vertexColor);
          ci.vertex_TL.color = color32Multiply(this.m_fontColorGradientPreset.topLeft, vertexColor);
          ci.vertex_TR.color = color32Multiply(this.m_fontColorGradientPreset.topRight, vertexColor);
          ci.vertex_BR.color = color32Multiply(this.m_fontColorGradientPreset.bottomRight, vertexColor);
        } else {
          ci.vertex_BL.color = color32Multiply(this.m_fontColorGradient.bottomLeft, vertexColor);
          ci.vertex_TL.color = color32Multiply(this.m_fontColorGradient.topLeft, vertexColor);
          ci.vertex_TR.color = color32Multiply(this.m_fontColorGradient.topRight, vertexColor);
          ci.vertex_BR.color = color32Multiply(this.m_fontColorGradient.bottomRight, vertexColor);
        }
      }
    }

    if (this.m_colorGradientPreset != null && !isColorGlyph) {
      if (this.m_colorGradientPresetIsTinted) {
        ci.vertex_BL.color = color32Multiply(ci.vertex_BL.color, this.m_colorGradientPreset.bottomLeft);
        ci.vertex_TL.color = color32Multiply(ci.vertex_TL.color, this.m_colorGradientPreset.topLeft);
        ci.vertex_TR.color = color32Multiply(ci.vertex_TR.color, this.m_colorGradientPreset.topRight);
        ci.vertex_BR.color = color32Multiply(ci.vertex_BR.color, this.m_colorGradientPreset.bottomRight);
      } else {
        ci.vertex_BL.color = colorMinAlpha(this.m_colorGradientPreset.bottomLeft, vertexColor);
        ci.vertex_TL.color = colorMinAlpha(this.m_colorGradientPreset.topLeft, vertexColor);
        ci.vertex_TR.color = colorMinAlpha(this.m_colorGradientPreset.topRight, vertexColor);
        ci.vertex_BR.color = colorMinAlpha(this.m_colorGradientPreset.bottomRight, vertexColor);
      }
    }
    // #endregion

    // Apply style_padding only if this is a SDF Shader.
    if (!this.m_isSDFShader) style_padding = 0;

    // Setup UVs for the Character
    // #region Setup UVs（TMP_Text.cs:5315）
    const altGlyph = ci.alternativeGlyph;
    const glyphRect = altGlyph == null ? this.m_cached_TextElement!.glyph.glyphRect : altGlyph.glyphRect;

    const uv0 = {
      x: f32(f32(glyphRect.x - padding - style_padding) / this.m_currentFontAsset!.atlasWidth),
      y: f32(f32(glyphRect.y - padding - style_padding) / this.m_currentFontAsset!.atlasHeight),
    };

    const uv1 = {
      x: uv0.x,
      y: f32(f32(f32(glyphRect.y + padding + style_padding) + glyphRect.height) / this.m_currentFontAsset!.atlasHeight),
    };

    const uv2 = {
      x: f32(f32(f32(glyphRect.x + padding + style_padding) + glyphRect.width) / this.m_currentFontAsset!.atlasWidth),
      y: uv1.y,
    };

    const uv3 = {
      x: uv2.x,
      y: uv0.y,
    };

    // Store UV Information
    ci.vertex_BL.uv.x = uv0.x; ci.vertex_BL.uv.y = uv0.y;
    ci.vertex_TL.uv.x = uv1.x; ci.vertex_TL.uv.y = uv1.y;
    ci.vertex_TR.uv.x = uv2.x; ci.vertex_TR.uv.y = uv2.y;
    ci.vertex_BR.uv.x = uv3.x; ci.vertex_BR.uv.y = uv3.y;
    // #endregion Setup UVs

    // #region Setup Normals & Tangents（TMP_Text.cs:5340）：原版註解掉了
    // #endregion end Normals & Tangents
  }

  /** SaveSpriteVertexInfo（TMP_Text.cs:5359） */
  saveSpriteVertexInfo(vertexColor: Color32): void {
    const ci = this.m_textInfo.characterInfo[this.m_characterCount];

    // Save the Vertex Position for the Character
    // #region Setup Mesh Vertices（TMP_Text.cs:5365）
    ci.vertex_BL.position = { ...ci.bottomLeft };
    ci.vertex_TL.position = { ...ci.topLeft };
    ci.vertex_TR.position = { ...ci.topRight };
    ci.vertex_BR.position = { ...ci.bottomRight };
    // #endregion

    // Vertex Color Alpha
    if (this.m_tintAllSprites) this.m_tintSprite = true;
    const spriteColor = this.m_tintSprite ? color32Multiply(this.m_spriteColor, vertexColor) : { ...this.m_spriteColor };
    spriteColor.a = spriteColor.a < this.m_fontColor32.a ? (spriteColor.a < vertexColor.a ? spriteColor.a : vertexColor.a) : this.m_fontColor32.a;

    let c0 = spriteColor;
    let c1 = spriteColor;
    let c2 = spriteColor;
    let c3 = spriteColor;

    if (this.m_enableVertexGradient) {
      if (this.m_fontColorGradientPreset != null) {
        c0 = this.m_tintSprite ? color32Multiply(c0, this.m_fontColorGradientPreset.bottomLeft) : c0;
        c1 = this.m_tintSprite ? color32Multiply(c1, this.m_fontColorGradientPreset.topLeft) : c1;
        c2 = this.m_tintSprite ? color32Multiply(c2, this.m_fontColorGradientPreset.topRight) : c2;
        c3 = this.m_tintSprite ? color32Multiply(c3, this.m_fontColorGradientPreset.bottomRight) : c3;
      } else {
        c0 = this.m_tintSprite ? color32Multiply(c0, this.m_fontColorGradient.bottomLeft) : c0;
        c1 = this.m_tintSprite ? color32Multiply(c1, this.m_fontColorGradient.topLeft) : c1;
        c2 = this.m_tintSprite ? color32Multiply(c2, this.m_fontColorGradient.topRight) : c2;
        c3 = this.m_tintSprite ? color32Multiply(c3, this.m_fontColorGradient.bottomRight) : c3;
      }
    }

    if (this.m_colorGradientPreset != null) {
      c0 = this.m_tintSprite ? color32Multiply(c0, this.m_colorGradientPreset.bottomLeft) : c0;
      c1 = this.m_tintSprite ? color32Multiply(c1, this.m_colorGradientPreset.topLeft) : c1;
      c2 = this.m_tintSprite ? color32Multiply(c2, this.m_colorGradientPreset.topRight) : c2;
      c3 = this.m_tintSprite ? color32Multiply(c3, this.m_colorGradientPreset.bottomRight) : c3;
    }

    ci.vertex_BL.color = { ...c0 };
    ci.vertex_TL.color = { ...c1 };
    ci.vertex_TR.color = { ...c2 };
    ci.vertex_BR.color = { ...c3 };

    // Setup UVs for the Character
    // #region Setup UVs（TMP_Text.cs:5422）
    const glyphRect = this.m_cached_TextElement!.glyph.glyphRect;
    const sheet = this.m_currentSpriteAsset!.spriteSheetSize;

    const uv0 = { x: f32(glyphRect.x / sheet.width), y: f32(glyphRect.y / sheet.height) }; // bottom left
    const uv1 = { x: uv0.x, y: f32(f32(glyphRect.y + glyphRect.height) / sheet.height) }; // top left
    const uv2 = { x: f32(f32(glyphRect.x + glyphRect.width) / sheet.width), y: uv1.y }; // top right
    const uv3 = { x: uv2.x, y: uv0.y }; // bottom right

    // Store UV Information
    ci.vertex_BL.uv.x = uv0.x; ci.vertex_BL.uv.y = uv0.y;
    ci.vertex_TL.uv.x = uv1.x; ci.vertex_TL.uv.y = uv1.y;
    ci.vertex_TR.uv.x = uv2.x; ci.vertex_TR.uv.y = uv2.y;
    ci.vertex_BR.uv.x = uv3.x; ci.vertex_BR.uv.y = uv3.y;
    // #endregion Setup UVs

    // #region Setup Normals & Tangents（TMP_Text.cs:5441）：原版註解掉了
    // #endregion end Normals & Tangents
  }

  /** FillCharacterVertexBuffers(int i)（TMP_Text.cs:5452） */
  fillCharacterVertexBuffers(i: number): void {
    const materialIndex = this.m_textInfo.characterInfo[i].materialReferenceIndex;
    const meshInfo = this.m_textInfo.meshInfo[materialIndex];
    const index_X4 = meshInfo.vertexCount;

    // Check to make sure our current mesh buffer allocations can hold these new Quads.
    if (index_X4 >= meshInfo.vertices.length) meshInfo.resizeMeshInfo(nextPowerOfTwo((index_X4 + 4) / 4));

    const ci = this.m_textInfo.characterInfo[i];
    ci.vertexIndex = index_X4;

    // Setup Vertices for Characters
    meshInfo.vertices[0 + index_X4] = { ...ci.vertex_BL.position };
    meshInfo.vertices[1 + index_X4] = { ...ci.vertex_TL.position };
    meshInfo.vertices[2 + index_X4] = { ...ci.vertex_TR.position };
    meshInfo.vertices[3 + index_X4] = { ...ci.vertex_BR.position };

    // Setup UVS0
    meshInfo.uvs0[0 + index_X4] = { ...ci.vertex_BL.uv };
    meshInfo.uvs0[1 + index_X4] = { ...ci.vertex_TL.uv };
    meshInfo.uvs0[2 + index_X4] = { ...ci.vertex_TR.uv };
    meshInfo.uvs0[3 + index_X4] = { ...ci.vertex_BR.uv };

    // Setup UVS2
    meshInfo.uvs2[0 + index_X4] = { ...ci.vertex_BL.uv2 };
    meshInfo.uvs2[1 + index_X4] = { ...ci.vertex_TL.uv2 };
    meshInfo.uvs2[2 + index_X4] = { ...ci.vertex_TR.uv2 };
    meshInfo.uvs2[3 + index_X4] = { ...ci.vertex_BR.uv2 };

    // setup Vertex Colors
    meshInfo.colors32[0 + index_X4] = this.m_ConvertToLinearSpace ? gammaToLinearColor32(ci.vertex_BL.color) : { ...ci.vertex_BL.color };
    meshInfo.colors32[1 + index_X4] = this.m_ConvertToLinearSpace ? gammaToLinearColor32(ci.vertex_TL.color) : { ...ci.vertex_TL.color };
    meshInfo.colors32[2 + index_X4] = this.m_ConvertToLinearSpace ? gammaToLinearColor32(ci.vertex_TR.color) : { ...ci.vertex_TR.color };
    meshInfo.colors32[3 + index_X4] = this.m_ConvertToLinearSpace ? gammaToLinearColor32(ci.vertex_BR.color) : { ...ci.vertex_BR.color };

    meshInfo.vertexCount = index_X4 + 4;
  }

  /** FillSpriteVertexBuffers（TMP_Text.cs:5591） */
  fillSpriteVertexBuffers(i: number): void {
    const materialIndex = this.m_textInfo.characterInfo[i].materialReferenceIndex;
    const meshInfo = this.m_textInfo.meshInfo[materialIndex];
    const index_X4 = meshInfo.vertexCount;

    // Check to make sure our current mesh buffer allocations can hold these new Quads.
    if (index_X4 >= meshInfo.vertices.length) meshInfo.resizeMeshInfo(nextPowerOfTwo((index_X4 + 4) / 4));

    const ci = this.m_textInfo.characterInfo[i];
    ci.vertexIndex = index_X4;

    // Setup Vertices for Characters
    meshInfo.vertices[0 + index_X4] = { ...ci.vertex_BL.position };
    meshInfo.vertices[1 + index_X4] = { ...ci.vertex_TL.position };
    meshInfo.vertices[2 + index_X4] = { ...ci.vertex_TR.position };
    meshInfo.vertices[3 + index_X4] = { ...ci.vertex_BR.position };

    // Setup UVS0
    meshInfo.uvs0[0 + index_X4] = { ...ci.vertex_BL.uv };
    meshInfo.uvs0[1 + index_X4] = { ...ci.vertex_TL.uv };
    meshInfo.uvs0[2 + index_X4] = { ...ci.vertex_TR.uv };
    meshInfo.uvs0[3 + index_X4] = { ...ci.vertex_BR.uv };

    // Setup UVS2
    meshInfo.uvs2[0 + index_X4] = { ...ci.vertex_BL.uv2 };
    meshInfo.uvs2[1 + index_X4] = { ...ci.vertex_TL.uv2 };
    meshInfo.uvs2[2 + index_X4] = { ...ci.vertex_TR.uv2 };
    meshInfo.uvs2[3 + index_X4] = { ...ci.vertex_BR.uv2 };

    // setup Vertex Colors
    meshInfo.colors32[0 + index_X4] = this.m_ConvertToLinearSpace ? gammaToLinearColor32(ci.vertex_BL.color) : { ...ci.vertex_BL.color };
    meshInfo.colors32[1 + index_X4] = this.m_ConvertToLinearSpace ? gammaToLinearColor32(ci.vertex_TL.color) : { ...ci.vertex_TL.color };
    meshInfo.colors32[2 + index_X4] = this.m_ConvertToLinearSpace ? gammaToLinearColor32(ci.vertex_TR.color) : { ...ci.vertex_TR.color };
    meshInfo.colors32[3 + index_X4] = this.m_ConvertToLinearSpace ? gammaToLinearColor32(ci.vertex_BR.color) : { ...ci.vertex_BR.color };

    meshInfo.vertexCount = index_X4 + 4;
  }

  /** DrawUnderlineMesh（TMP_Text.cs:5650）。index 用 holder 模擬 ref。 */
  drawUnderlineMesh(start: Vec3, end: Vec3, index: { v: number }, startScale: number, endScale: number, maxScale: number, sdfScale: number, underlineColor: Color32): void {
    // Get Underline special character from the primary font asset.
    this.getUnderlineSpecialCharacter(this.m_fontAsset!);

    if (this.m_Underline.character == null) {
      if (!this.settings.warningsDisabled) this.warnings.push(`底線／刪除線用的字元 [0x5F] 不在字型 [${this.m_fontAsset?.name}] 裡，跳過底線`);
      return;
    }

    const underlineMaterialIndex = this.m_Underline.materialIndex;
    const meshInfo = this.m_textInfo.meshInfo[underlineMaterialIndex];

    const verticesCount = index.v + 12;

    // Check to make sure our current mesh buffer allocations can hold these new Quads.
    if (verticesCount > meshInfo.vertices.length) {
      meshInfo.resizeMeshInfo(Math.trunc(verticesCount / 4));
    }

    // Adjust the position of the underline based on the lowest character. This matters for subscript character.
    start = { ...start, y: Math.min(start.y, end.y) };
    end = { ...end, y: Math.min(start.y, end.y) };

    const underlineGlyphMetrics = this.m_Underline.character.glyph.metrics;
    const underlineGlyphRect = this.m_Underline.character.glyph.glyphRect;

    let segmentWidth = f32(f32(underlineGlyphMetrics.width / 2) * maxScale);

    if (end.x - start.x < f32(underlineGlyphMetrics.width * maxScale)) {
      segmentWidth = f32((end.x - start.x) / 2);
    }

    const startPadding = f32(f32(this.m_padding * startScale) / maxScale);
    const endPadding = f32(f32(this.m_padding * endScale) / maxScale);

    const underlineThickness = this.m_Underline.fontAsset!.faceInfo.underlineThickness;

    // UNDERLINE VERTICES FOR (3) LINE SEGMENTS
    // #region UNDERLINE VERTICES（TMP_Text.cs:5694）
    const vertices = meshInfo.vertices;
    const i0 = index.v;

    const vAdd = (v: Vec3, dx: number, dy: number): Vec3 => ({ x: f32(v.x + dx), y: f32(v.y + dy), z: 0 });

    // Front Part of the Underline
    vertices[i0 + 0] = vAdd(start, 0, f32(0 - f32(underlineThickness + this.m_padding) * maxScale)); // BL
    vertices[i0 + 1] = vAdd(start, 0, f32(this.m_padding * maxScale)); // TL
    vertices[i0 + 2] = vAdd(vertices[i0 + 1], segmentWidth, 0); // TR
    vertices[i0 + 3] = vAdd(vertices[i0 + 0], segmentWidth, 0); // BR

    // Middle Part of the Underline
    vertices[i0 + 4] = { ...vertices[i0 + 3] }; // BL
    vertices[i0 + 5] = { ...vertices[i0 + 2] }; // TL
    vertices[i0 + 6] = vAdd(end, -segmentWidth, f32(this.m_padding * maxScale)); // TR
    vertices[i0 + 7] = vAdd(end, -segmentWidth, f32(-f32(underlineThickness + this.m_padding) * maxScale)); // BR

    // End Part of the Underline
    vertices[i0 + 8] = { ...vertices[i0 + 7] }; // BL
    vertices[i0 + 9] = { ...vertices[i0 + 6] }; // TL
    vertices[i0 + 10] = vAdd(end, 0, f32(this.m_padding * maxScale)); // TR
    vertices[i0 + 11] = vAdd(end, 0, f32(-f32(underlineThickness + this.m_padding) * maxScale)); // BR
    // #endregion

    // UNDERLINE UV0
    // #region HANDLE UV0（TMP_Text.cs:5717）
    const uvs0 = meshInfo.uvs0;

    const atlasWidth = this.m_Underline.fontAsset!.atlasWidth;
    const atlasHeight = this.m_Underline.fontAsset!.atlasHeight;

    const xScale = Math.abs(sdfScale);

    // Calculate UV required to setup the 3 Quads for the Underline.
    const uv0 = { x: f32(f32(underlineGlyphRect.x - startPadding) / atlasWidth), y: f32(f32(underlineGlyphRect.y - this.m_padding) / atlasHeight), z: 0, w: xScale }; // bottom left
    const uv1 = { x: uv0.x, y: f32(f32(f32(underlineGlyphRect.y + underlineGlyphRect.height) + this.m_padding) / atlasHeight), z: 0, w: xScale }; // top left
    const uv2 = { x: f32(f32(f32(underlineGlyphRect.x - startPadding) + f32(underlineGlyphRect.width / 2)) / atlasWidth), y: uv1.y, z: 0, w: xScale }; // Mid Top Left
    const uv3 = { x: uv2.x, y: uv0.y, z: 0, w: xScale }; // Mid Bottom Left
    const uv4 = { x: f32(f32(f32(underlineGlyphRect.x + endPadding) + f32(underlineGlyphRect.width / 2)) / atlasWidth), y: uv1.y, z: 0, w: xScale }; // Mid Top Right
    const uv5 = { x: uv4.x, y: uv0.y, z: 0, w: xScale }; // Mid Bottom right
    const uv6 = { x: f32(f32(f32(underlineGlyphRect.x + endPadding) + underlineGlyphRect.width) / atlasWidth), y: uv1.y, z: 0, w: xScale }; // End Part - Bottom Right
    const uv7 = { x: uv6.x, y: uv0.y, z: 0, w: xScale }; // End Part - Top Right

    // Left Part of the Underline
    uvs0[0 + i0] = uv0; // BL
    uvs0[1 + i0] = uv1; // TL
    uvs0[2 + i0] = uv2; // TR
    uvs0[3 + i0] = uv3; // BR

    // Middle Part of the Underline
    uvs0[4 + i0] = { x: f32(uv2.x - f32(uv2.x * 0.001)), y: uv0.y, z: 0, w: xScale };
    uvs0[5 + i0] = { x: f32(uv2.x - f32(uv2.x * 0.001)), y: uv1.y, z: 0, w: xScale };
    uvs0[6 + i0] = { x: f32(uv2.x + f32(uv2.x * 0.001)), y: uv1.y, z: 0, w: xScale };
    uvs0[7 + i0] = { x: f32(uv2.x + f32(uv2.x * 0.001)), y: uv0.y, z: 0, w: xScale };

    // Right Part of the Underline
    uvs0[8 + i0] = uv5;
    uvs0[9 + i0] = uv4;
    uvs0[10 + i0] = uv6;
    uvs0[11 + i0] = uv7;
    // #endregion

    // UNDERLINE UV2
    // #region HANDLE UV2 - SDF SCALE（TMP_Text.cs:5755）
    const uvs2 = meshInfo.uvs2;
    let max_UvX = f32(f32(vertices[i0 + 2].x - start.x) / f32(end.x - start.x));

    uvs2[0 + i0] = { x: 0, y: 0 };
    uvs2[1 + i0] = { x: 0, y: 1 };
    uvs2[2 + i0] = { x: max_UvX, y: 1 };
    uvs2[3 + i0] = { x: max_UvX, y: 0 };

    let min_UvX = f32(f32(vertices[i0 + 4].x - start.x) / f32(end.x - start.x));
    max_UvX = f32(f32(vertices[i0 + 6].x - start.x) / f32(end.x - start.x));

    uvs2[4 + i0] = { x: min_UvX, y: 0 };
    uvs2[5 + i0] = { x: min_UvX, y: 1 };
    uvs2[6 + i0] = { x: max_UvX, y: 1 };
    uvs2[7 + i0] = { x: max_UvX, y: 0 };

    min_UvX = f32(f32(vertices[i0 + 8].x - start.x) / f32(end.x - start.x));

    uvs2[8 + i0] = { x: min_UvX, y: 0 };
    uvs2[9 + i0] = { x: min_UvX, y: 1 };
    uvs2[10 + i0] = { x: 1, y: 1 };
    uvs2[11 + i0] = { x: 1, y: 0 };
    // #endregion

    // UNDERLINE VERTEX COLORS
    // #region UNDERLINE VERTEX COLORS（TMP_Text.cs:5784）
    // Alpha is the lower of the vertex color or tag color alpha used.
    const uc = { ...underlineColor, a: this.m_fontColor32.a < underlineColor.a ? this.m_fontColor32.a : underlineColor.a };

    const colors32 = meshInfo.colors32;
    for (let k = 0; k < 12; k++) colors32[k + i0] = { ...uc };
    // #endregion

    index.v += 12;
  }

  /** DrawTextHighlight（TMP_Text.cs:5809） */
  drawTextHighlight(start: Vec3, end: Vec3, index: { v: number }, highlightColor: Color32): void {
    if (this.m_Underline.character == null) {
      this.getUnderlineSpecialCharacter(this.m_fontAsset!);

      if (this.m_Underline.character == null) {
        if (!this.settings.warningsDisabled) this.warnings.push(`主要字型沒有底線字元，highlight 跳過`);
        return;
      }
    }

    const underlineMaterialIndex = this.m_Underline.materialIndex;
    const meshInfo = this.m_textInfo.meshInfo[underlineMaterialIndex];

    const verticesCount = index.v + 4;

    // Check to make sure our current mesh buffer allocations can hold these new Quads.
    if (verticesCount > meshInfo.vertices.length) {
      meshInfo.resizeMeshInfo(Math.trunc(verticesCount / 4));
    }

    // UNDERLINE VERTICES FOR (3) LINE SEGMENTS
    // #region HIGHLIGHT VERTICES（TMP_Text.cs:5836）
    const vertices = meshInfo.vertices;
    const i0 = index.v;

    // Front Part of the Underline
    vertices[i0 + 0] = { ...start }; // BL
    vertices[i0 + 1] = { x: start.x, y: end.y, z: 0 }; // TL
    vertices[i0 + 2] = { ...end }; // TR
    vertices[i0 + 3] = { x: end.x, y: start.y, z: 0 }; // BR
    // #endregion

    // UNDERLINE UV0
    // #region HANDLE UV0（TMP_Text.cs:5847）
    const uvs0 = meshInfo.uvs0;

    const atlasWidth = this.m_Underline.fontAsset!.atlasWidth;
    const atlasHeight = this.m_Underline.fontAsset!.atlasHeight;
    const glyphRect = this.m_Underline.character!.glyph.glyphRect;

    // Calculate UV
    const uvGlyphCenter = { x: f32(f32(glyphRect.x + f32(glyphRect.width / 2)) / atlasWidth), y: f32(f32(glyphRect.y + f32(glyphRect.height / 2)) / atlasHeight) };
    const uvTexelSize = { x: f32(1.0 / atlasWidth), y: f32(1.0 / atlasHeight) };

    // UVs for the Quad
    uvs0[i0 + 0] = { x: f32(uvGlyphCenter.x - uvTexelSize.x), y: f32(uvGlyphCenter.y - uvTexelSize.y), z: 0, w: 0 }; // BL
    uvs0[i0 + 1] = { x: f32(uvGlyphCenter.x - uvTexelSize.x), y: f32(uvGlyphCenter.y + uvTexelSize.y), z: 0, w: 0 }; // TL
    uvs0[i0 + 2] = { x: f32(uvGlyphCenter.x + uvTexelSize.x), y: f32(uvGlyphCenter.y + uvTexelSize.y), z: 0, w: 0 }; // TR
    uvs0[i0 + 3] = { x: f32(uvGlyphCenter.x + uvTexelSize.x), y: f32(uvGlyphCenter.y - uvTexelSize.y), z: 0, w: 0 }; // BR
    // #endregion

    // HIGHLIGHT UV2
    // #region HANDLE UV2 - SDF SCALE（TMP_Text.cs:5866）
    const uvs2 = meshInfo.uvs2;
    const customUV = { x: 0, y: 1 };
    uvs2[i0 + 0] = { ...customUV };
    uvs2[i0 + 1] = { ...customUV };
    uvs2[i0 + 2] = { ...customUV };
    uvs2[i0 + 3] = { ...customUV };
    // #endregion

    // HIGHLIGHT VERTEX COLORS
    // #region HIGHLIGHT VERTEX COLORS（TMP_Text.cs:5876）
    // Alpha is the lower of the vertex color or tag color alpha used.
    const hc = { ...highlightColor, a: this.m_fontColor32.a < highlightColor.a ? this.m_fontColor32.a : highlightColor.a };

    const colors32 = meshInfo.colors32;
    colors32[i0 + 0] = { ...hc };
    colors32[i0 + 1] = { ...hc };
    colors32[i0 + 2] = { ...hc };
    colors32[i0 + 3] = { ...hc };
    // #endregion

    index.v += 4;
  }

  // ════════════════════════ GenerateTextMesh ════════════════════════
  // UGUI 版 TMPro_UGUI_Private.cs:1749–4672；3D 版 TMPro_Private.cs:1625–4517。
  // 差異點（行號 UGUI／3D）：
  //   - ClearMesh() vs ClearMesh(true)（1770／1646 與 3732／3592）
  //   - xScale：UGUI 4069–4083 依 Canvas renderMode 乘；3D 3941 直接 × |lossyScale|
  //   - m_ConvertToLinearSpace：只有 3D 版（TMPro_Private.cs:3984，QualitySettings.activeColorSpace == Linear → 頂點色轉 linear）
  //   - Phase III 的 mesh 上傳（UGUI 4594–4657／3D 4434–4479）：移植版直接輸出陣列

  /** GenerateTextMesh（UGUI：TMPro_UGUI_Private.cs:1749；3D：TMPro_Private.cs:1625） */
  generateTextMesh(): void {
    // Early exit if no font asset was assigned.
    if (this.m_fontAsset == null) {
      this.m_IsAutoSizePointSizeSet = true;
      return;
    }

    // Clear TextInfo
    this.m_textInfo.clear();

    // Early exit if we don't have any Text to generate.
    if (this.m_TextProcessingArray == null || this.m_TextProcessingArray.length === 0 || this.m_TextProcessingArray[0].unicode === 0) {
      // Clear mesh and upload changes to the mesh.
      this.clearMesh();

      this.m_preferredWidth = 0;
      this.m_preferredHeight = 0;

      this.m_IsAutoSizePointSizeSet = true;
      return;
    }

    this.m_currentFontAsset = this.m_fontAsset;
    this.m_currentMaterial = this.m_sharedMaterial!;
    this.m_currentMaterialIndex = 0;
    this.m_materialReferenceStack.setDefault(this.m_materialReferences[0] ?? new MaterialReference(this.m_currentMaterialIndex, this.m_currentFontAsset, null, this.m_currentMaterial, this.m_padding));

    this.m_currentSpriteAsset = this.m_spriteAsset;

    // Total character count is computed when the text is parsed.
    const totalCharacterCount = this.m_totalCharacterCount;

    // Calculate the scale of the font based on selected font size and sampling point size.
    // baseScale is calculated using the font asset assigned to the text object.
    const baseScale = f32(f32(f32(this.m_fontSize / this.m_fontAsset.faceInfo.pointSize) * this.m_fontAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));
    let currentElementScale = baseScale;
    const currentEmScale = f32(f32(this.m_fontSize * 0.01) * (this.m_isOrthographic ? 1 : 0.1));
    this.m_fontScaleMultiplier = 1;

    this.m_currentFontSize = this.m_fontSize;
    this.m_sizeStack.setDefault(this.m_currentFontSize);
    let fontSizeDelta = 0;

    let charCode = 0; // Holds the character code of the currently being processed character.

    this.m_FontStyleInternal = this.m_fontStyle; // Set the default style.
    this.m_FontWeightInternal = (this.m_FontStyleInternal & FontStyles.Bold) === FontStyles.Bold ? FontWeight.Bold : this.m_fontWeight;
    this.m_FontWeightStack.setDefault(this.m_FontWeightInternal);
    this.m_fontStyleStack.clear();

    this.m_lineJustification = this.m_HorizontalAlignment; // Sets the line justification mode to match editor alignment.
    this.m_lineJustificationStack.setDefault(this.m_lineJustification);

    let padding = 0;

    this.m_baselineOffset = 0; // Used by subscript characters.
    this.m_baselineOffsetStack.clear();

    // Underline
    let beginUnderline = false;
    let underline_start: Vec3 = { x: 0, y: 0, z: 0 }; // Used to track where underline starts & ends.
    let underline_end: Vec3 = { x: 0, y: 0, z: 0 };

    // Strike-through
    let beginStrikethrough = false;
    let strikethrough_start: Vec3 = { x: 0, y: 0, z: 0 };
    let strikethrough_end: Vec3 = { x: 0, y: 0, z: 0 };

    // Text Highlight
    let beginHighlight = false;
    let highlight_start: { x: number; y: number } = { x: 0, y: 0 };
    let highlight_end: { x: number; y: number } = { x: 0, y: 0 };

    this.m_fontColor32 = colorToColor32(this.m_fontColor);
    this.m_htmlColor = { ...this.m_fontColor32 };
    this.m_underlineColor = { ...this.m_htmlColor };
    this.m_strikethroughColor = { ...this.m_htmlColor };

    this.m_colorStack.setDefault({ ...this.m_htmlColor });
    this.m_underlineColorStack.setDefault({ ...this.m_htmlColor });
    this.m_strikethroughColorStack.setDefault({ ...this.m_htmlColor });
    this.m_HighlightStateStack.setDefault(highlightState({ ...this.m_htmlColor }, tmpOffset()));

    this.m_colorGradientPreset = null;
    this.m_colorGradientStack.setDefault(null);

    this.m_ItalicAngle = this.m_currentFontAsset.italicStyle;
    this.m_ItalicAngleStack.setDefault(this.m_ItalicAngle);

    // Clear the Action stack.
    this.m_actionStack.clear();

    this.m_FXScale = { x: 1, y: 1, z: 1 };
    this.m_FXRotationAngle = null;

    this.m_lineOffset = 0; // Amount of space between lines (font line spacing + m_linespacing).
    this.m_lineHeight = TMP_MATH.FLOAT_UNSET;
    const lineGap = f32(this.m_currentFontAsset.faceInfo.lineHeight - f32(this.m_currentFontAsset.faceInfo.ascentLine - this.m_currentFontAsset.faceInfo.descentLine));

    this.m_cSpacing = 0; // Amount of space added between characters as a result of the use of the <cspace> tag.
    this.m_monoSpacing = 0;
    this.m_xAdvance = 0; // Used to track the position of each character.

    this.tag_LineIndent = 0; // Used for indentation of text.
    this.tag_Indent = 0;
    this.m_indentStack.setDefault(0);
    this.tag_NoParsing = false;

    this.m_characterCount = 0; // Total characters in the char[]

    // Tracking of line information
    this.m_firstCharacterOfLine = this.m_firstVisibleCharacter;
    this.m_lastCharacterOfLine = 0;
    this.m_firstVisibleCharacterOfLine = 0;
    this.m_lastVisibleCharacterOfLine = 0;
    this.m_maxLineAscender = k_LargeNegativeFloat;
    this.m_maxLineDescender = k_LargePositiveFloat;
    this.m_lineNumber = 0;
    this.m_startOfLineAscender = 0;
    this.m_startOfLineDescender = 0;
    this.m_lineVisibleCharacterCount = 0;
    this.m_lineVisibleSpaceCount = 0;
    let isStartOfNewLine = true;
    this.m_IsDrivenLineSpacing = false;
    this.m_firstOverflowCharacterIndex = -1;
    this.m_LastBaseGlyphIndex = -2147483648; // int.MinValue

    const kerning = this.m_ActiveFontFeatures.includes(OTL_FeatureTag.kern);
    const markToBase = this.m_ActiveFontFeatures.includes(OTL_FeatureTag.mark);
    const markToMark = this.m_ActiveFontFeatures.includes(OTL_FeatureTag.mkmk);

    this.m_pageNumber = 0;
    const pageToDisplay = clamp(this.m_pageToDisplay - 1, 0, this.m_textInfo.pageInfo.length - 1);
    this.m_textInfo.clearPageInfo();

    const margins = this.m_margin;
    const marginWidth = this.m_marginWidth > 0 ? this.m_marginWidth : 0;
    const marginHeight = this.m_marginHeight > 0 ? this.m_marginHeight : 0;
    this.m_marginLeft = 0;
    this.m_marginRight = 0;
    this.m_width = -1;
    let widthOfTextArea = f32(f32(f32(marginWidth + 0.0001) - this.m_marginLeft) - this.m_marginRight);

    // Need to initialize these Extents structures
    this.m_meshExtents.min = { ...k_LargePositiveVector2 };
    this.m_meshExtents.max = { ...k_LargeNegativeVector2 };

    // Initialize lineInfo
    this.m_textInfo.clearLineInfo();

    // Tracking of the highest Ascender
    this.m_maxCapHeight = 0;
    this.m_maxTextAscender = 0;
    this.m_ElementDescender = 0;
    this.m_PageAscender = 0;
    const visState = { isMaxVisibleDescenderSet: false, maxVisibleDescender: 0 };
    this.m_isNewPage = false;

    // Initialize struct to track states of word wrapping
    let isFirstWordOfLine = true;
    this.m_isNonBreakingSpace = false;
    let ignoreNonBreakingSpace = false;
    let lastSoftLineBreak = 0;

    const characterToSubstitute: CharacterSubstitution = { index: -1, unicode: 0 };
    let isSoftHyphenIgnored = false;

    // Save character and line state before we begin layout.
    this.saveWordWrappingState(this.m_SavedWordWrapState, -1, -1);
    this.saveWordWrappingState(this.m_SavedLineState, -1, -1);
    this.saveWordWrappingState(this.m_SavedEllipsisState, -1, -1);
    this.saveWordWrappingState(this.m_SavedLastValidState, -1, -1);
    this.saveWordWrappingState(this.m_SavedSoftLineBreakState, -1, -1);

    this.m_EllipsisInsertionCandidateStack.clear();

    // Safety Tracker
    let restoreCount = 0;

    // Parse through Character buffer to read HTML tags and begin creating mesh.
    for (let i = 0; i < this.m_TextProcessingArray.length && this.m_TextProcessingArray[i].unicode !== 0; i++) {
      charCode = this.m_TextProcessingArray[i].unicode;

      if (restoreCount > 5) {
        // Line breaking recursion max threshold hit
        this.warnings.push(`換行還原超過 5 次（字元 ${charCode}，index ${i}），強制結束`);
        characterToSubstitute.index = this.m_characterCount;
        characterToSubstitute.unicode = 0x03;
      }

      // Skip characters that have been substituted.
      if (charCode === 0x1a) continue;

      // #region Parse Rich Text Tag（TMPro_UGUI_Private.cs:1967；TMPro_Private.cs:1843）
      if (this.m_isRichText && charCode === 60) {
        this.m_isTextLayoutPhase = true;
        this.m_textElementType = TmpTextElementType.Character;

        // Check if Tag is valid. If valid, skip to the end of the validated tag.
        const tagResult = this.validateHtmlTag(this.m_TextProcessingArray, i + 1);
        if (tagResult.valid) {
          i = tagResult.endIndex;

          // Continue to next character or handle the sprite element
          if (this.m_textElementType === TmpTextElementType.Character) {
            continue;
          }
        }
      } else {
        this.m_textElementType = this.m_textInfo.characterInfo[this.m_characterCount].elementType;
        this.m_currentMaterialIndex = this.m_textInfo.characterInfo[this.m_characterCount].materialReferenceIndex;
        this.m_currentFontAsset = this.m_textInfo.characterInfo[this.m_characterCount].fontAsset!;
      }
      // #endregion End Parse Rich Text Tag

      const previousMaterialIndex = this.m_currentMaterialIndex;
      const isUsingAltTypeface = this.m_textInfo.characterInfo[this.m_characterCount].isUsingAlternateTypeface;

      this.m_isTextLayoutPhase = false;

      // #region Character Substitutions（TMPro_UGUI_Private.cs:2004；TMPro_Private.cs:1880）
      let isInjectedCharacter = false;

      if (characterToSubstitute.index === this.m_characterCount) {
        charCode = characterToSubstitute.unicode;
        this.m_textElementType = TmpTextElementType.Character;
        isInjectedCharacter = true;

        switch (charCode) {
          case 0x03:
            this.m_textInfo.characterInfo[this.m_characterCount].textElement = this.m_currentFontAsset.characterLookupTable.get(0x03) ?? null;
            this.m_isTextTruncated = true;
            break;
          case 0x2d:
            break;
          case 0x2026:
            this.m_textInfo.characterInfo[this.m_characterCount].textElement = this.m_Ellipsis.character;
            this.m_textInfo.characterInfo[this.m_characterCount].elementType = TmpTextElementType.Character;
            this.m_textInfo.characterInfo[this.m_characterCount].fontAsset = this.m_Ellipsis.fontAsset;
            this.m_textInfo.characterInfo[this.m_characterCount].material = this.m_Ellipsis.material;
            this.m_textInfo.characterInfo[this.m_characterCount].materialReferenceIndex = this.m_Ellipsis.materialIndex;

            // Need to increase reference count in the event the primary mesh has no characters.
            this.m_materialReferences[this.m_Underline.materialIndex].referenceCount += 1;

            // Indicates the source parsing data has been modified.
            this.m_isTextTruncated = true;

            // End Of Text
            characterToSubstitute.index = this.m_characterCount + 1;
            characterToSubstitute.unicode = 0x03;
            break;
        }
      }
      // #endregion

      // #region Linked Text（TMPro_UGUI_Private.cs:2045；TMPro_Private.cs:1921）
      if (this.m_characterCount < this.m_firstVisibleCharacter && charCode !== 0x03) {
        this.m_textInfo.characterInfo[this.m_characterCount].isVisible = false;
        this.m_textInfo.characterInfo[this.m_characterCount].character = 0x200b;
        this.m_textInfo.characterInfo[this.m_characterCount].lineNumber = 0;
        this.m_characterCount += 1;
        continue;
      }
      // #endregion

      // #region Handling of LowerCase, UpperCase and SmallCaps Font Styles（TMPro_UGUI_Private.cs:2058；TMPro_Private.cs:1934）
      let smallCapsMultiplier = 1.0;

      if (this.m_textElementType === TmpTextElementType.Character) {
        if ((this.m_FontStyleInternal & FontStyles.UpperCase) === FontStyles.UpperCase) {
          // If this character is lowercase, switch to uppercase.
          if (charIsLower(charCode)) charCode = charToUpper(charCode);
        } else if ((this.m_FontStyleInternal & FontStyles.LowerCase) === FontStyles.LowerCase) {
          // If this character is uppercase, switch to lowercase.
          if (charIsUpper(charCode)) charCode = charToLower(charCode);
        } else if ((this.m_FontStyleInternal & FontStyles.SmallCaps) === FontStyles.SmallCaps) {
          if (charIsLower(charCode)) {
            smallCapsMultiplier = 0.8;
            charCode = charToUpper(charCode);
          }
        }
      }
      // #endregion

      // #region Look up Character Data（TMPro_UGUI_Private.cs:2090；TMPro_Private.cs:1966）
      let baselineOffset = 0;
      let elementAscentLine = 0;
      let elementDescentLine = 0;
      if (this.m_textElementType === TmpTextElementType.Sprite) {
        // If a sprite is used as a fallback then get a reference to it and set the color to white.
        this.m_currentSpriteAsset = this.m_textInfo.characterInfo[this.m_characterCount].textElement!.textAsset as SpriteAssetData;
        this.m_spriteIndex = this.m_textInfo.characterInfo[this.m_characterCount].textElement!.glyphIndex;

        const sprite = this.m_currentSpriteAsset.spriteCharacterTable[this.m_spriteIndex];
        if (sprite == null) {
          continue;
        }

        // Sprites are assigned in the E000 Private Area + sprite Index
        if (charCode === 60) charCode = 57344 + this.m_spriteIndex;
        else this.m_spriteColor = { ...s_colorWhite };

        const fontScale = f32(f32(f32(this.m_currentFontSize / this.m_currentFontAsset.faceInfo.pointSize) * this.m_currentFontAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));

        // The sprite scale calculations are based on the font asset assigned to the text object.
        if (this.m_currentSpriteAsset.faceInfo.pointSize > 0) {
          const spriteScale = f32(f32(f32(this.m_currentFontSize / this.m_currentSpriteAsset.faceInfo.pointSize) * this.m_currentSpriteAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));
          currentElementScale = f32(f32(sprite.scale * sprite.glyph.scale) * spriteScale);
          elementAscentLine = this.m_currentSpriteAsset.faceInfo.ascentLine;
          baselineOffset = f32(f32(f32(this.m_currentSpriteAsset.faceInfo.baseline * fontScale) * this.m_fontScaleMultiplier) * this.m_currentSpriteAsset.faceInfo.scale);
          elementDescentLine = this.m_currentSpriteAsset.faceInfo.descentLine;
        } else {
          const spriteScale = f32(f32(f32(this.m_currentFontSize / this.m_currentFontAsset.faceInfo.pointSize) * this.m_currentFontAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));
          currentElementScale = f32(f32(f32(this.m_currentFontAsset.faceInfo.ascentLine / sprite.glyph.metrics.height) * sprite.scale) * f32(sprite.glyph.scale * spriteScale));
          const scaleDelta = f32(spriteScale / currentElementScale);
          elementAscentLine = f32(this.m_currentFontAsset.faceInfo.ascentLine * scaleDelta);
          baselineOffset = f32(f32(f32(this.m_currentFontAsset.faceInfo.baseline * fontScale) * this.m_fontScaleMultiplier) * this.m_currentFontAsset.faceInfo.scale);
          elementDescentLine = f32(this.m_currentFontAsset.faceInfo.descentLine * scaleDelta);
        }

        this.m_cached_TextElement = sprite;

        this.m_textInfo.characterInfo[this.m_characterCount].elementType = TmpTextElementType.Sprite;
        this.m_textInfo.characterInfo[this.m_characterCount].scale = currentElementScale;
        this.m_textInfo.characterInfo[this.m_characterCount].fontAsset = this.m_currentFontAsset;
        this.m_textInfo.characterInfo[this.m_characterCount].materialReferenceIndex = this.m_currentMaterialIndex;

        this.m_currentMaterialIndex = previousMaterialIndex;

        padding = 0;
      } else if (this.m_textElementType === TmpTextElementType.Character) {
        this.m_cached_TextElement = this.m_textInfo.characterInfo[this.m_characterCount].textElement;
        if (this.m_cached_TextElement == null) {
          continue;
        }

        this.m_currentFontAsset = this.m_textInfo.characterInfo[this.m_characterCount].fontAsset!;
        this.m_currentMaterial = this.m_textInfo.characterInfo[this.m_characterCount].material!;
        this.m_currentMaterialIndex = this.m_textInfo.characterInfo[this.m_characterCount].materialReferenceIndex;

        // Special handling if replaced character was a line feed where in this case we have to use the scale of the previous character.
        let adjustedScale: number;
        if (isInjectedCharacter && this.m_TextProcessingArray[i].unicode === 0x0a && this.m_characterCount !== this.m_firstCharacterOfLine)
          adjustedScale = f32(f32(f32(f32(this.m_textInfo.characterInfo[this.m_characterCount - 1].pointSize * smallCapsMultiplier) / this.m_currentFontAsset.faceInfo.pointSize) * this.m_currentFontAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));
        else adjustedScale = f32(f32(f32(f32(this.m_currentFontSize * smallCapsMultiplier) / this.m_currentFontAsset.faceInfo.pointSize) * this.m_currentFontAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));

        // Special handling for injected Ellipsis
        if (isInjectedCharacter && charCode === 0x2026) {
          elementAscentLine = 0;
          elementDescentLine = 0;
        } else {
          elementAscentLine = this.m_currentFontAsset.faceInfo.ascentLine;
          elementDescentLine = this.m_currentFontAsset.faceInfo.descentLine;
        }

        currentElementScale = f32(f32(adjustedScale * this.m_fontScaleMultiplier) * f32(this.m_cached_TextElement.scale * this.m_cached_TextElement.glyph.scale));
        baselineOffset = f32(f32(f32(this.m_currentFontAsset.faceInfo.baseline * adjustedScale) * this.m_fontScaleMultiplier) * this.m_currentFontAsset.faceInfo.scale);

        this.m_textInfo.characterInfo[this.m_characterCount].elementType = TmpTextElementType.Character;
        this.m_textInfo.characterInfo[this.m_characterCount].scale = currentElementScale;

        padding = this.m_currentMaterialIndex === 0 ? this.m_padding : this.m_subObjectPadding.get(this.m_currentMaterialIndex) ?? 0;
      }
      // #endregion

      // #region Handle Soft Hyphen（TMPro_UGUI_Private.cs:2192；TMPro_Private.cs:2068）
      const currentElementUnmodifiedScale = currentElementScale;
      if (charCode === 0xad || charCode === 0x03) currentElementScale = 0;
      // #endregion

      // Store some of the text object's information
      this.m_textInfo.characterInfo[this.m_characterCount].character = charCode & 0xffff;
      this.m_textInfo.characterInfo[this.m_characterCount].pointSize = this.m_currentFontSize;
      this.m_textInfo.characterInfo[this.m_characterCount].color = { ...this.m_htmlColor };
      this.m_textInfo.characterInfo[this.m_characterCount].underlineColor = { ...this.m_underlineColor };
      this.m_textInfo.characterInfo[this.m_characterCount].strikethroughColor = { ...this.m_strikethroughColor };
      this.m_textInfo.characterInfo[this.m_characterCount].highlightState = { color: { ...this.m_HighlightState.color }, padding: { ...this.m_HighlightState.padding } };
      this.m_textInfo.characterInfo[this.m_characterCount].style = this.m_FontStyleInternal;

      // Cache glyph metrics
      const altGlyph = this.m_textInfo.characterInfo[this.m_characterCount].alternativeGlyph;
      const currentGlyphMetrics = altGlyph == null ? this.m_cached_TextElement!.glyph.metrics : altGlyph.metrics;

      // Optimization to avoid calling this more than once per character.
      const isWhiteSpace = charCode <= 0xffff && charIsWhiteSpace(charCode);

      // #region Handle Kerning（TMPro_UGUI_Private.cs:2216；TMPro_Private.cs:2092）
      let glyphAdjustments = { xPlacement: 0, yPlacement: 0, xAdvance: 0, yAdvance: 0 };
      let characterSpacingAdjustment = this.m_characterSpacing;
      if (kerning) {
        let adjustmentPair;
        const baseGlyphIndex = this.m_cached_TextElement!.glyphIndex;

        if (this.m_characterCount < totalCharacterCount - 1) {
          const nextGlyphIndex = this.m_textInfo.characterInfo[this.m_characterCount + 1].textElement!.glyphIndex;
          const key = ((nextGlyphIndex << 16) | baseGlyphIndex) >>> 0;

          adjustmentPair = this.m_currentFontAsset!.featureTable.pairLookup.get(key);
          if (adjustmentPair !== undefined) {
            glyphAdjustments = { ...adjustmentPair.firstAdjustmentRecord.glyphValueRecord };
            characterSpacingAdjustment = (adjustmentPair.featureLookupFlags & 0x00000200) !== 0 ? 0 : characterSpacingAdjustment; // FontFeatureLookupFlags.IgnoreSpacingAdjustments
          }
        }

        if (this.m_characterCount >= 1) {
          const previousGlyphIndex = this.m_textInfo.characterInfo[this.m_characterCount - 1].textElement!.glyphIndex;
          const key = ((baseGlyphIndex << 16) | previousGlyphIndex) >>> 0;

          adjustmentPair = this.m_currentFontAsset!.featureTable.pairLookup.get(key);
          if (adjustmentPair !== undefined) {
            const gvr = adjustmentPair.secondAdjustmentRecord.glyphValueRecord;
            glyphAdjustments = {
              xPlacement: f32(glyphAdjustments.xPlacement + gvr.xPlacement),
              yPlacement: f32(glyphAdjustments.yPlacement + gvr.yPlacement),
              xAdvance: f32(glyphAdjustments.xAdvance + gvr.xAdvance),
              yAdvance: f32(glyphAdjustments.yAdvance + gvr.yAdvance),
            };
            characterSpacingAdjustment = (adjustmentPair.featureLookupFlags & 0x00000200) !== 0 ? 0 : characterSpacingAdjustment;
          }
        }
      }

      this.m_textInfo.characterInfo[this.m_characterCount].adjustedHorizontalAdvance = glyphAdjustments.xAdvance;
      // #endregion

      // #region Handle Diacritical Marks（TMPro_UGUI_Private.cs:2258；TMPro_Private.cs:2134）
      const isBaseGlyphNow = isBaseGlyph(charCode);

      if (isBaseGlyphNow) this.m_LastBaseGlyphIndex = this.m_characterCount;

      if (this.m_characterCount > 0 && !isBaseGlyphNow) {
        // Check for potential Mark-to-Base lookup if previous glyph was a base glyph
        if (markToBase && this.m_LastBaseGlyphIndex !== -2147483648 && this.m_LastBaseGlyphIndex === this.m_characterCount - 1) {
          const baseGlyphIndex = this.m_textInfo.characterInfo[this.m_LastBaseGlyphIndex].textElement!.glyph.index;
          const markGlyphIndex = this.m_cached_TextElement!.glyphIndex;
          const key = ((markGlyphIndex << 16) | baseGlyphIndex) >>> 0;

          const glyphAdjustmentRecord = this.m_currentFontAsset!.featureTable.markBaseLookup.get(key);
          if (glyphAdjustmentRecord !== undefined) {
            const advanceOffset = f32(f32(this.m_textInfo.characterInfo[this.m_LastBaseGlyphIndex].origin - this.m_xAdvance) / currentElementScale);

            glyphAdjustments.xPlacement = f32(f32(advanceOffset + glyphAdjustmentRecord.baseGlyphAnchorPoint.xCoordinate) - glyphAdjustmentRecord.markPositionAdjustment.xPositionAdjustment);
            glyphAdjustments.yPlacement = f32(glyphAdjustmentRecord.baseGlyphAnchorPoint.yCoordinate - glyphAdjustmentRecord.markPositionAdjustment.yPositionAdjustment);

            characterSpacingAdjustment = 0;
          }
        } else {
          // Iterate from previous glyph to last base glyph checking for any potential Mark-to-Mark lookups to apply. Otherwise check for potential Mark-to-Base lookup between the current glyph and last base glyph
          let wasLookupApplied = false;

          // Check for any potential Mark-to-Mark lookups
          if (markToMark) {
            for (let characterLookupIndex = this.m_characterCount - 1; characterLookupIndex >= 0 && characterLookupIndex !== this.m_LastBaseGlyphIndex; characterLookupIndex--) {
              // Handle any potential Mark-to-Mark lookup
              const baseGlyphIndex = this.m_textInfo.characterInfo[characterLookupIndex].textElement!.glyph.index;
              const combiningMarkGlyphIndex = this.m_cached_TextElement!.glyphIndex;
              const key = ((combiningMarkGlyphIndex << 16) | baseGlyphIndex) >>> 0;

              const glyphAdjustmentRecord = this.m_currentFontAsset!.featureTable.markMarkLookup.get(key);
              if (glyphAdjustmentRecord !== undefined) {
                const baseMarkOrigin = f32(f32(this.m_textInfo.characterInfo[characterLookupIndex].origin - this.m_xAdvance) / currentElementScale);
                const currentBaseline = f32(f32(baselineOffset - this.m_lineOffset) + this.m_baselineOffset);
                const baseMarkBaseline = f32(f32(this.m_textInfo.characterInfo[characterLookupIndex].baseLine - currentBaseline) / currentElementScale);

                glyphAdjustments.xPlacement = f32(f32(baseMarkOrigin + glyphAdjustmentRecord.baseMarkGlyphAnchorPoint.xCoordinate) - glyphAdjustmentRecord.combiningMarkPositionAdjustment.xPositionAdjustment);
                glyphAdjustments.yPlacement = f32(f32(baseMarkBaseline + glyphAdjustmentRecord.baseMarkGlyphAnchorPoint.yCoordinate) - glyphAdjustmentRecord.combiningMarkPositionAdjustment.yPositionAdjustment);

                characterSpacingAdjustment = 0;
                wasLookupApplied = true;
                break;
              }
            }
          }

          // If no Mark-to-Mark lookups were applied, check for potential Mark-to-Base lookup.
          if (markToBase && this.m_LastBaseGlyphIndex !== -2147483648 && !wasLookupApplied) {
            // Handle lookup for Mark-to-Base
            const baseGlyphIndex = this.m_textInfo.characterInfo[this.m_LastBaseGlyphIndex].textElement!.glyph.index;
            const markGlyphIndex = this.m_cached_TextElement!.glyphIndex;
            const key = ((markGlyphIndex << 16) | baseGlyphIndex) >>> 0;

            const glyphAdjustmentRecord = this.m_currentFontAsset!.featureTable.markBaseLookup.get(key);
            if (glyphAdjustmentRecord !== undefined) {
              const advanceOffset = f32(f32(this.m_textInfo.characterInfo[this.m_LastBaseGlyphIndex].origin - this.m_xAdvance) / currentElementScale);

              glyphAdjustments.xPlacement = f32(f32(advanceOffset + glyphAdjustmentRecord.baseGlyphAnchorPoint.xCoordinate) - glyphAdjustmentRecord.markPositionAdjustment.xPositionAdjustment);
              glyphAdjustments.yPlacement = f32(glyphAdjustmentRecord.baseGlyphAnchorPoint.yCoordinate - glyphAdjustmentRecord.markPositionAdjustment.yPositionAdjustment);

              characterSpacingAdjustment = 0;
            }
          }
        }
      }

      // Adjust relevant text metrics
      elementAscentLine = f32(elementAscentLine + glyphAdjustments.yPlacement);
      elementDescentLine = f32(elementDescentLine + glyphAdjustments.yPlacement);
      // #endregion

      // #region Handle Right-to-Left（TMPro_UGUI_Private.cs:2345；TMPro_Private.cs:2221）
      if (this.m_isRightToLeft) {
        this.m_xAdvance = f32(this.m_xAdvance - f32(f32(currentGlyphMetrics.horizontalAdvance * f32(1 - this.m_charWidthAdjDelta)) * currentElementScale));

        if (isWhiteSpace || charCode === 0x200b) this.m_xAdvance = f32(this.m_xAdvance - f32(this.m_wordSpacing * currentEmScale));
      }
      // #endregion

      // #region Handle Mono Spacing（TMPro_UGUI_Private.cs:2357；TMPro_Private.cs:2233）
      let monoAdvance = 0;
      if (this.m_monoSpacing !== 0) {
        if (this.m_duoSpace && (charCode === 0x2e || charCode === 0x3a || charCode === 0x2c))
          monoAdvance = f32(f32(this.m_monoSpacing / 4 - f32(f32(currentGlyphMetrics.width / 2 + currentGlyphMetrics.horizontalBearingX) * currentElementScale)) * f32(1 - this.m_charWidthAdjDelta));
        else monoAdvance = f32(f32(this.m_monoSpacing / 2 - f32(f32(currentGlyphMetrics.width / 2 + currentGlyphMetrics.horizontalBearingX) * currentElementScale)) * f32(1 - this.m_charWidthAdjDelta));

        this.m_xAdvance = f32(this.m_xAdvance + monoAdvance);
      }
      // #endregion

      // #region Handle Style Padding（TMPro_UGUI_Private.cs:2372；TMPro_Private.cs:2248）
      let boldSpacingAdjustment: number;
      let style_padding: number;
      if (this.m_textElementType === TmpTextElementType.Character && !isUsingAltTypeface && (this.m_FontStyleInternal & FontStyles.Bold) === FontStyles.Bold) {
        // Checks for any combination of Bold Style.
        if (this.m_currentMaterial != null && this.m_currentMaterial.hasProperty('_GradientScale')) {
          const gradientScale = this.m_currentMaterial.getFloat('_GradientScale');
          style_padding = f32(f32(f32(f32(this.m_currentFontAsset!.boldStyle / 4.0) * gradientScale) * this.m_currentMaterial.getFloat('_ScaleRatioA')));

          // Clamp overall padding to Gradient Scale size.
          if (style_padding + padding > gradientScale) padding = f32(gradientScale - style_padding);
        } else style_padding = 0;

        boldSpacingAdjustment = this.m_currentFontAsset!.boldSpacing;
      } else {
        if (this.m_currentMaterial != null && this.m_currentMaterial.hasProperty('_GradientScale') && this.m_currentMaterial.hasProperty('_ScaleRatioA')) {
          const gradientScale = this.m_currentMaterial.getFloat('_GradientScale');
          style_padding = f32(f32(f32(f32(this.m_currentFontAsset!.normalStyle / 4.0) * gradientScale) * this.m_currentMaterial.getFloat('_ScaleRatioA')));

          // Clamp overall padding to Gradient Scale size.
          if (style_padding + padding > gradientScale) padding = f32(gradientScale - style_padding);
        } else style_padding = 0;

        boldSpacingAdjustment = 0;
      }
      // #endregion Handle Style Padding

      // Determine the position of the vertices of the Character or Sprite.
      // #region Calculate Vertices Position（TMPro_UGUI_Private.cs:2411；TMPro_Private.cs:2287）
      const top_left: Vec3 = {
        x: f32(this.m_xAdvance + f32(f32(f32(f32(f32(currentGlyphMetrics.horizontalBearingX * this.m_FXScale.x) - padding) - style_padding) + glyphAdjustments.xPlacement) * currentElementScale * f32(1 - this.m_charWidthAdjDelta))),
        y: f32(f32(baselineOffset + f32(f32(currentGlyphMetrics.horizontalBearingY + padding) + glyphAdjustments.yPlacement) * currentElementScale) - this.m_lineOffset + this.m_baselineOffset),
        z: 0,
      };

      const bottom_left: Vec3 = {
        x: top_left.x,
        y: f32(top_left.y - f32(f32(currentGlyphMetrics.height + padding * 2) * currentElementScale)),
        z: 0,
      };

      const top_right: Vec3 = {
        x: f32(bottom_left.x + f32(f32(f32(f32(currentGlyphMetrics.width * this.m_FXScale.x) + padding * 2) + style_padding * 2) * currentElementScale * f32(1 - this.m_charWidthAdjDelta))),
        y: top_left.y,
        z: 0,
      };

      const bottom_right: Vec3 = {
        x: top_right.x,
        y: bottom_left.y,
        z: 0,
      };
      // #endregion

      // Check if we need to Shear the rectangles for Italic styles
      // #region Handle Italic & Shearing（TMPro_UGUI_Private.cs:2438；TMPro_Private.cs:2314）
      if (this.m_textElementType === TmpTextElementType.Character && !isUsingAltTypeface && (this.m_FontStyleInternal & FontStyles.Italic) === FontStyles.Italic) {
        // Shift Top vertices forward by half (Shear Value * height of character) and Bottom vertices back by same amount.
        const shear_value = f32(this.m_ItalicAngle * 0.01);
        const midPoint = f32(f32(f32(this.m_currentFontAsset!.faceInfo.capLine - f32(this.m_currentFontAsset!.faceInfo.baseline + this.m_baselineOffset)) / 2) * this.m_fontScaleMultiplier * this.m_currentFontAsset!.faceInfo.scale);
        const topShearX = f32(shear_value * f32(f32(f32(f32(currentGlyphMetrics.horizontalBearingY + padding) + style_padding) - midPoint) * currentElementScale));
        const bottomShearX = f32(shear_value * f32(f32(f32(f32(currentGlyphMetrics.horizontalBearingY - currentGlyphMetrics.height) - padding) - style_padding) - midPoint) * currentElementScale);

        top_left.x = f32(top_left.x + topShearX);
        bottom_left.x = f32(bottom_left.x + bottomShearX);
        top_right.x = f32(top_right.x + topShearX);
        bottom_right.x = f32(bottom_right.x + bottomShearX);
      }
      // #endregion Handle Italics & Shearing

      // Handle Character FX Rotation
      // #region Handle Character FX Rotation（TMPro_UGUI_Private.cs:2456；TMPro_Private.cs:2332）
      if (this.m_FXRotationAngle !== null) {
        // Matrix4x4.Rotate(Quaternion.Euler(0,0,angle))：繞 z 軸
        const rad = f32(this.m_FXRotationAngle * (Math.PI / 180));
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const positionOffset = { x: f32(f32(top_right.x + bottom_left.x) / 2), y: f32(f32(top_right.y + bottom_left.y) / 2), z: 0 };

        const rot = (v: Vec3): Vec3 => {
          const dx = f32(v.x - positionOffset.x);
          const dy = f32(v.y - positionOffset.y);
          return { x: f32(f32(f32(dx * cos) - f32(dy * sin)) + positionOffset.x), y: f32(f32(f32(dx * sin) + f32(dy * cos)) + positionOffset.y), z: 0 };
        };
        const rtl = rot(top_left);
        const rbl = rot(bottom_left);
        const rtr = rot(top_right);
        const rbr = rot(bottom_right);
        top_left.x = rtl.x; top_left.y = rtl.y;
        bottom_left.x = rbl.x; bottom_left.y = rbl.y;
        top_right.x = rtr.x; top_right.y = rtr.y;
        bottom_right.x = rbr.x; bottom_right.y = rbr.y;
      }
      // #endregion

      // Store vertex information for the character or sprite.
      this.m_textInfo.characterInfo[this.m_characterCount].bottomLeft = { ...bottom_left };
      this.m_textInfo.characterInfo[this.m_characterCount].topLeft = { ...top_left };
      this.m_textInfo.characterInfo[this.m_characterCount].topRight = { ...top_right };
      this.m_textInfo.characterInfo[this.m_characterCount].bottomRight = { ...bottom_right };

      this.m_textInfo.characterInfo[this.m_characterCount].origin = f32(this.m_xAdvance + f32(glyphAdjustments.xPlacement * currentElementScale));
      this.m_textInfo.characterInfo[this.m_characterCount].baseLine = f32(f32(f32(baselineOffset - this.m_lineOffset) + this.m_baselineOffset) + f32(glyphAdjustments.yPlacement * currentElementScale));
      this.m_textInfo.characterInfo[this.m_characterCount].aspectRatio = f32(f32(top_right.x - bottom_left.x) / f32(top_left.y - bottom_left.y));

      // #region Compute Ascender & Descender values（TMPro_UGUI_Private.cs:2482；TMPro_Private.cs:2358）
      // Element Ascender in line space
      const elementAscender =
        this.m_textElementType === TmpTextElementType.Character
          ? f32(f32(f32(elementAscentLine * currentElementScale) / smallCapsMultiplier) + this.m_baselineOffset)
          : f32(f32(elementAscentLine * currentElementScale) + this.m_baselineOffset);

      // Element Descender in line space
      const elementDescender =
        this.m_textElementType === TmpTextElementType.Character
          ? f32(f32(f32(elementDescentLine * currentElementScale) / smallCapsMultiplier) + this.m_baselineOffset)
          : f32(f32(elementDescentLine * currentElementScale) + this.m_baselineOffset);

      let adjustedAscender = elementAscender;
      let adjustedDescender = elementDescender;

      // Max line ascender and descender in line space
      const isFirstCharacterOfLine = this.m_characterCount === this.m_firstCharacterOfLine;
      if (isFirstCharacterOfLine || isWhiteSpace === false) {
        // Special handling for Superscript and Subscript where we use the unadjusted line ascender and descender
        if (this.m_baselineOffset !== 0) {
          adjustedAscender = Math.max(f32(f32(elementAscender - this.m_baselineOffset) / this.m_fontScaleMultiplier), adjustedAscender);
          adjustedDescender = Math.min(f32(f32(elementDescender - this.m_baselineOffset) / this.m_fontScaleMultiplier), adjustedDescender);
        }

        this.m_maxLineAscender = Math.max(adjustedAscender, this.m_maxLineAscender);
        this.m_maxLineDescender = Math.min(adjustedDescender, this.m_maxLineDescender);
      }

      // Element Ascender and Descender in object space
      if (isFirstCharacterOfLine || isWhiteSpace === false) {
        this.m_textInfo.characterInfo[this.m_characterCount].adjustedAscender = adjustedAscender;
        this.m_textInfo.characterInfo[this.m_characterCount].adjustedDescender = adjustedDescender;

        this.m_ElementAscender = this.m_textInfo.characterInfo[this.m_characterCount].ascender = f32(elementAscender - this.m_lineOffset);
        this.m_ElementDescender = this.m_textInfo.characterInfo[this.m_characterCount].descender = f32(elementDescender - this.m_lineOffset);
      } else {
        this.m_textInfo.characterInfo[this.m_characterCount].adjustedAscender = this.m_maxLineAscender;
        this.m_textInfo.characterInfo[this.m_characterCount].adjustedDescender = this.m_maxLineDescender;

        this.m_ElementAscender = this.m_textInfo.characterInfo[this.m_characterCount].ascender = f32(this.m_maxLineAscender - this.m_lineOffset);
        this.m_ElementDescender = this.m_textInfo.characterInfo[this.m_characterCount].descender = f32(this.m_maxLineDescender - this.m_lineOffset);
      }

      // Max text object ascender and cap height
      if (this.m_lineNumber === 0 || this.m_isNewPage) {
        if (isFirstCharacterOfLine || isWhiteSpace === false) {
          this.m_maxTextAscender = this.m_maxLineAscender;
          this.m_maxCapHeight = Math.max(this.m_maxCapHeight, f32(f32(this.m_currentFontAsset!.faceInfo.capLine * currentElementScale) / smallCapsMultiplier));
        }
      }

      // Page ascender
      if (this.m_lineOffset === 0) {
        if (isFirstCharacterOfLine || isWhiteSpace === false) this.m_PageAscender = this.m_PageAscender > elementAscender ? this.m_PageAscender : elementAscender;
      }
      // #endregion

      // Set Characters to not visible by default.
      this.m_textInfo.characterInfo[this.m_characterCount].isVisible = false;

      const isJustifiedOrFlush = (this.m_lineJustification & HorizontalAlignmentOptions.Flush) === HorizontalAlignmentOptions.Flush || (this.m_lineJustification & HorizontalAlignmentOptions.Justified) === HorizontalAlignmentOptions.Justified;

      // #region Handle Visible Characters（TMPro_UGUI_Private.cs:2556；TMPro_Private.cs:2432）
      if (
        charCode === 9 ||
        ((this.m_TextWrappingMode === TextWrappingModes.PreserveWhitespace || this.m_TextWrappingMode === TextWrappingModes.PreserveWhitespaceNoWrap) && (isWhiteSpace || charCode === 0x200b)) ||
        (isWhiteSpace === false && charCode !== 0x200b && charCode !== 0xad && charCode !== 0x03) ||
        (charCode === 0xad && isSoftHyphenIgnored === false) ||
        this.m_textElementType === TmpTextElementType.Sprite
      ) {
        this.m_textInfo.characterInfo[this.m_characterCount].isVisible = true;

        // #region Experimental Margin Shaper（TMPro_UGUI_Private.cs:2563；TMPro_Private.cs:2439）：原版註解掉了（marginShaper 功能關閉）
        // #endregion

        let marginLeft = this.m_marginLeft;
        let marginRight = this.m_marginRight;

        // Injected characters do not override margins
        if (isInjectedCharacter) {
          marginLeft = this.m_textInfo.lineInfo[this.m_lineNumber].marginLeft;
          marginRight = this.m_textInfo.lineInfo[this.m_lineNumber].marginRight;
        }

        widthOfTextArea = this.m_width !== -1 ? Math.min(f32(f32(f32(marginWidth + 0.0001) - marginLeft) - marginRight), this.m_width) : f32(f32(f32(marginWidth + 0.0001) - marginLeft) - marginRight);

        // Calculate the line breaking width of the text.
        const textWidth = f32(
          Math.abs(this.m_xAdvance) + f32(f32((!this.m_isRightToLeft ? currentGlyphMetrics.horizontalAdvance : 0) * f32(1 - this.m_charWidthAdjDelta)) * (charCode === 0xad ? currentElementUnmodifiedScale : currentElementScale)),
        );
        const textHeight = f32(
          f32(this.m_maxTextAscender - f32(this.m_maxLineDescender - this.m_lineOffset)) +
            (this.m_lineOffset > 0 && this.m_IsDrivenLineSpacing === false ? f32(this.m_maxLineAscender - this.m_startOfLineAscender) : 0),
        );

        const testedCharacterCount = this.m_characterCount;

        // #region Current Line Vertical Bounds Check（TMPro_UGUI_Private.cs:2617；TMPro_Private.cs:2493）
        if (textHeight > f32(marginHeight + 0.0001)) {
          // Set isTextOverflowing and firstOverflowCharacterIndex
          if (this.m_firstOverflowCharacterIndex === -1) this.m_firstOverflowCharacterIndex = this.m_characterCount;

          // Check if Auto-Size is enabled
          if (this.m_enableAutoSizing) {
            // #region Line Spacing Adjustments（TMPro_UGUI_Private.cs:2630；TMPro_Private.cs:2506）
            if (this.m_lineSpacingDelta > this.m_lineSpacingMax && this.m_lineOffset > 0 && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
              const adjustmentDelta = f32(f32(marginHeight - textHeight) / this.m_lineNumber);

              this.m_lineSpacingDelta = Math.max(f32(this.m_lineSpacingDelta + f32(adjustmentDelta / baseScale)), this.m_lineSpacingMax);

              return;
            }
            // #endregion

            // #region Text Auto-Sizing (Text greater than vertical bounds)（TMPro_UGUI_Private.cs:2648；TMPro_Private.cs:2524）
            if (this.m_fontSize > this.m_fontSizeMin && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
              this.m_maxFontSize = this.m_fontSize;

              const sizeDelta = Math.max(f32(f32(this.m_fontSize - this.m_minFontSize) / 2), 0.05);
              this.m_fontSize = f32(this.m_fontSize - sizeDelta);
              this.m_fontSize = Math.max(f32(intCast(f32(f32(this.m_fontSize * 20) + 0.5)) / 20), this.m_fontSizeMin);

              return;
            }
            // #endregion Text Auto-Sizing
          }

          // Handle Vertical Overflow on current line
          switch (this.m_overflowMode) {
            case TextOverflowModes.Overflow:
            case TextOverflowModes.ScrollRect:
            case TextOverflowModes.Masking:
              // Nothing happens as vertical bounds are ignored in this mode.
              break;

            case TextOverflowModes.Truncate:
              i = this.restoreWordWrappingState(this.m_SavedLastValidState);

              characterToSubstitute.index = testedCharacterCount;
              characterToSubstitute.unicode = 0x03;
              continue;

            case TextOverflowModes.Ellipsis:
              if (this.m_EllipsisInsertionCandidateStack.count === 0) {
                i = -1;
                this.m_characterCount = 0;
                characterToSubstitute.index = 0;
                characterToSubstitute.unicode = 0x03;
                this.m_firstCharacterOfLine = 0;
                continue;
              }

              {
                const ellipsisState = this.m_EllipsisInsertionCandidateStack.pop()!;
                i = this.restoreWordWrappingState(ellipsisState);

                i -= 1;
                this.m_characterCount -= 1;
                characterToSubstitute.index = this.m_characterCount;
                characterToSubstitute.unicode = 0x2026;

                restoreCount += 1;
                continue;
              }

            case TextOverflowModes.Linked:
              i = this.restoreWordWrappingState(this.m_SavedLastValidState);

              if (this.m_linkedTextComponentRef != null) {
                // 原版會把剩下的文字交給 linked 元件重排；linked 元件不在這個介面裡
                this.warnings.push('TextOverflowModes.Linked：超出高度的文字沒有交給 linked 元件（需要場景端串接）');

                this.m_isTextTruncated = true;
              }

              // Truncate remaining text
              characterToSubstitute.index = testedCharacterCount;
              characterToSubstitute.unicode = 0x03;
              continue;

            case TextOverflowModes.Page:
              // End layout of text if first character / page doesn't fit.
              if (i < 0 || testedCharacterCount === 0) {
                i = -1;
                this.m_characterCount = 0;
                characterToSubstitute.index = 0;
                characterToSubstitute.unicode = 0x03;
                continue;
              } else if (f32(this.m_maxLineAscender - this.m_maxLineDescender) > f32(marginHeight + 0.0001)) {
                // Current line exceeds the height of the text container
                // as such we stop on the previous line.
                i = this.restoreWordWrappingState(this.m_SavedLineState);

                characterToSubstitute.index = testedCharacterCount;
                characterToSubstitute.unicode = 0x03;
                continue;
              }

              // Go back to previous line and re-layout
              i = this.restoreWordWrappingState(this.m_SavedLineState);

              this.m_isNewPage = true;
              this.m_firstCharacterOfLine = this.m_characterCount;
              this.m_maxLineAscender = k_LargeNegativeFloat;
              this.m_maxLineDescender = k_LargePositiveFloat;
              this.m_startOfLineAscender = 0;

              this.m_xAdvance = f32(0 + this.tag_Indent);
              this.m_lineOffset = 0;
              this.m_maxTextAscender = 0;
              this.m_PageAscender = 0;
              this.m_lineNumber += 1;
              this.m_pageNumber += 1;

              continue;
          }
        }
        // #endregion

        // #region Current Line Horizontal Bounds Check（TMPro_UGUI_Private.cs:2784；TMPro_Private.cs:2660）
        if (isBaseGlyphNow && textWidth > f32(widthOfTextArea * (isJustifiedOrFlush ? 1.05 : 1.0))) {
          // Handle Line Breaking (if still possible)
          if (this.m_TextWrappingMode !== TextWrappingModes.NoWrap && this.m_TextWrappingMode !== TextWrappingModes.PreserveWhitespaceNoWrap && this.m_characterCount !== this.m_firstCharacterOfLine) {
            // Restore state to previous safe line breaking
            i = this.restoreWordWrappingState(this.m_SavedWordWrapState);

            // Compute potential new line offset in the event a line break is needed.
            let lineOffsetDelta = 0;
            if (this.m_lineHeight === TMP_MATH.FLOAT_UNSET) {
              const ascender = this.m_textInfo.characterInfo[this.m_characterCount].adjustedAscender;
              lineOffsetDelta = f32(
                f32(
                  f32((this.m_lineOffset > 0 && this.m_IsDrivenLineSpacing === false ? f32(this.m_maxLineAscender - this.m_startOfLineAscender) : 0) - this.m_maxLineDescender) +
                    ascender +
                    f32(f32(lineGap + this.m_lineSpacingDelta) * baseScale),
                ) + f32(this.m_lineSpacing * currentEmScale),
              );
            } else {
              lineOffsetDelta = f32(this.m_lineHeight + f32(this.m_lineSpacing * currentEmScale));
              this.m_IsDrivenLineSpacing = true;
            }

            // Calculate new text height
            const newTextHeight = f32(f32(f32(this.m_maxTextAscender + lineOffsetDelta) + this.m_lineOffset) - this.m_textInfo.characterInfo[this.m_characterCount].adjustedDescender);

            // #region Handle Soft Hyphenation（TMPro_UGUI_Private.cs:2812；TMPro_Private.cs:2688）
            if (this.m_textInfo.characterInfo[this.m_characterCount - 1].character === 0xad && isSoftHyphenIgnored === false) {
              // Only inject Hyphen Minus if new line is possible
              if (this.m_overflowMode === TextOverflowModes.Overflow || newTextHeight < f32(marginHeight + 0.0001)) {
                characterToSubstitute.index = this.m_characterCount - 1;
                characterToSubstitute.unicode = 0x2d;

                i -= 1;
                this.m_characterCount -= 1;
                continue;
              }
            }

            isSoftHyphenIgnored = false;

            // Ignore Soft Hyphen to prevent it from wrapping
            if (this.m_textInfo.characterInfo[this.m_characterCount].character === 0xad) {
              isSoftHyphenIgnored = true;
              continue;
            }
            // #endregion

            // Adjust character spacing before breaking up word if auto size is enabled
            if (this.m_enableAutoSizing && isFirstWordOfLine) {
              // #region Character Width Adjustments（TMPro_UGUI_Private.cs:2845；TMPro_Private.cs:2721）
              if (this.m_charWidthAdjDelta < this.m_charWidthMaxAdj / 100 && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
                let adjustedTextWidth = textWidth;

                // Determine full width of the text
                if (this.m_charWidthAdjDelta > 0) adjustedTextWidth = f32(adjustedTextWidth / f32(1 - this.m_charWidthAdjDelta));

                const adjustmentDelta = f32(textWidth - f32(f32(widthOfTextArea - 0.0001) * (isJustifiedOrFlush ? 1.05 : 1.0)));
                this.m_charWidthAdjDelta = f32(this.m_charWidthAdjDelta + f32(adjustmentDelta / adjustedTextWidth));
                this.m_charWidthAdjDelta = Math.min(this.m_charWidthAdjDelta, this.m_charWidthMaxAdj / 100);

                return;
              }
              // #endregion

              // #region Text Auto-Sizing (Text greater than vertical bounds)（TMPro_UGUI_Private.cs:2868；TMPro_Private.cs:2744）
              if (this.m_fontSize > this.m_fontSizeMin && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
                this.m_maxFontSize = this.m_fontSize;

                const sizeDelta = Math.max(f32(f32(this.m_fontSize - this.m_minFontSize) / 2), 0.05);
                this.m_fontSize = f32(this.m_fontSize - sizeDelta);
                this.m_fontSize = Math.max(f32(intCast(f32(f32(this.m_fontSize * 20) + 0.5)) / 20), this.m_fontSizeMin);

                return;
              }
              // #endregion Text Auto-Sizing
            }

            // Special handling if first word of line and non breaking space
            const savedSoftLineBreakingSpace = this.m_SavedSoftLineBreakState.previous_WordBreak;
            if (isFirstWordOfLine && savedSoftLineBreakingSpace !== -1) {
              if (savedSoftLineBreakingSpace !== lastSoftLineBreak) {
                i = this.restoreWordWrappingState(this.m_SavedSoftLineBreakState);
                lastSoftLineBreak = savedSoftLineBreakingSpace;

                // check if soft hyphen
                if (this.m_textInfo.characterInfo[this.m_characterCount - 1].character === 0xad) {
                  characterToSubstitute.index = this.m_characterCount - 1;
                  characterToSubstitute.unicode = 0x2d;

                  i -= 1;
                  this.m_characterCount -= 1;
                  continue;
                }
              }
            }

            // Determine if new line of text would exceed the vertical bounds of text container
            if (newTextHeight > f32(marginHeight + 0.0001)) {
              // Set isTextOverflowing and firstOverflowCharacterIndex
              if (this.m_firstOverflowCharacterIndex === -1) this.m_firstOverflowCharacterIndex = this.m_characterCount;

              // Check if Auto-Size is enabled
              if (this.m_enableAutoSizing) {
                // #region Line Spacing Adjustments（TMPro_UGUI_Private.cs:2925；TMPro_Private.cs:2801）
                if (this.m_lineSpacingDelta > this.m_lineSpacingMax && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
                  const adjustmentDelta = f32(f32(marginHeight - newTextHeight) / (this.m_lineNumber + 1));

                  this.m_lineSpacingDelta = Math.max(f32(this.m_lineSpacingDelta + f32(adjustmentDelta / baseScale)), this.m_lineSpacingMax);

                  return;
                }
                // #endregion

                // #region Character Width Adjustments（TMPro_UGUI_Private.cs:2943；TMPro_Private.cs:2819）
                if (this.m_charWidthAdjDelta < this.m_charWidthMaxAdj / 100 && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
                  let adjustedTextWidth = textWidth;

                  // Determine full width of the text
                  if (this.m_charWidthAdjDelta > 0) adjustedTextWidth = f32(adjustedTextWidth / f32(1 - this.m_charWidthAdjDelta));

                  const adjustmentDelta = f32(textWidth - f32(f32(widthOfTextArea - 0.0001) * (isJustifiedOrFlush ? 1.05 : 1.0)));
                  this.m_charWidthAdjDelta = f32(this.m_charWidthAdjDelta + f32(adjustmentDelta / adjustedTextWidth));
                  this.m_charWidthAdjDelta = Math.min(this.m_charWidthAdjDelta, this.m_charWidthMaxAdj / 100);

                  return;
                }
                // #endregion

                // #region Text Auto-Sizing (Text greater than vertical bounds)（TMPro_UGUI_Private.cs:2967；TMPro_Private.cs:2843）
                if (this.m_fontSize > this.m_fontSizeMin && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
                  this.m_maxFontSize = this.m_fontSize;

                  const sizeDelta = Math.max(f32(f32(this.m_fontSize - this.m_minFontSize) / 2), 0.05);
                  this.m_fontSize = f32(this.m_fontSize - sizeDelta);
                  this.m_fontSize = Math.max(f32(intCast(f32(f32(this.m_fontSize * 20) + 0.5)) / 20), this.m_fontSizeMin);

                  return;
                }
                // #endregion Text Auto-Sizing
              }

              // Check Text Overflow Modes
              switch (this.m_overflowMode) {
                case TextOverflowModes.Overflow:
                case TextOverflowModes.ScrollRect:
                case TextOverflowModes.Masking:
                  this.insertNewLine(i, baseScale, currentElementScale, currentEmScale, boldSpacingAdjustment, characterSpacingAdjustment, widthOfTextArea, lineGap, visState);
                  isStartOfNewLine = true;
                  isFirstWordOfLine = true;
                  continue;

                case TextOverflowModes.Truncate:
                  i = this.restoreWordWrappingState(this.m_SavedLastValidState);

                  characterToSubstitute.index = testedCharacterCount;
                  characterToSubstitute.unicode = 0x03;
                  continue;

                case TextOverflowModes.Ellipsis:
                  if (this.m_EllipsisInsertionCandidateStack.count === 0) {
                    i = -1;
                    this.m_characterCount = 0;
                    characterToSubstitute.index = 0;
                    characterToSubstitute.unicode = 0x03;
                    this.m_firstCharacterOfLine = 0;
                    continue;
                  }

                  {
                    const ellipsisState = this.m_EllipsisInsertionCandidateStack.pop()!;
                    i = this.restoreWordWrappingState(ellipsisState);

                    i -= 1;
                    this.m_characterCount -= 1;
                    characterToSubstitute.index = this.m_characterCount;
                    characterToSubstitute.unicode = 0x2026;

                    restoreCount += 1;
                    continue;
                  }

                case TextOverflowModes.Linked:
                  if (this.m_linkedTextComponentRef != null) {
                    this.warnings.push('TextOverflowModes.Linked：超出高度的文字沒有交給 linked 元件（需要場景端串接）');

                    this.m_isTextTruncated = true;
                  }

                  // Truncate remaining text
                  characterToSubstitute.index = this.m_characterCount;
                  characterToSubstitute.unicode = 0x03;
                  continue;

                case TextOverflowModes.Page:
                  // Add new page
                  this.m_isNewPage = true;

                  this.insertNewLine(i, baseScale, currentElementScale, currentEmScale, boldSpacingAdjustment, characterSpacingAdjustment, widthOfTextArea, lineGap, visState);

                  this.m_startOfLineAscender = 0;
                  this.m_lineOffset = 0;
                  this.m_maxTextAscender = 0;
                  this.m_PageAscender = 0;
                  this.m_pageNumber += 1;

                  isStartOfNewLine = true;
                  isFirstWordOfLine = true;
                  continue;
              }
            } else {
              // New line of text does not exceed vertical bounds of text container
              this.insertNewLine(i, baseScale, currentElementScale, currentEmScale, boldSpacingAdjustment, characterSpacingAdjustment, widthOfTextArea, lineGap, visState);
              isStartOfNewLine = true;
              isFirstWordOfLine = true;
              continue;
            }
          } else {
            if (this.m_enableAutoSizing && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
              // #region Character Width Adjustments（TMPro_UGUI_Private.cs:3119；TMPro_Private.cs:2995）
              if (this.m_charWidthAdjDelta < this.m_charWidthMaxAdj / 100) {
                let adjustedTextWidth = textWidth;

                // Determine full width of the text
                if (this.m_charWidthAdjDelta > 0) adjustedTextWidth = f32(adjustedTextWidth / f32(1 - this.m_charWidthAdjDelta));

                const adjustmentDelta = f32(textWidth - f32(f32(widthOfTextArea - 0.0001) * (isJustifiedOrFlush ? 1.05 : 1.0)));
                this.m_charWidthAdjDelta = f32(this.m_charWidthAdjDelta + f32(adjustmentDelta / adjustedTextWidth));
                this.m_charWidthAdjDelta = Math.min(this.m_charWidthAdjDelta, this.m_charWidthMaxAdj / 100);

                return;
              }
              // #endregion

              // #region Text Exceeds Horizontal Bounds - Reducing Point Size（TMPro_UGUI_Private.cs:3142；TMPro_Private.cs:3018）
              if (this.m_fontSize > this.m_fontSizeMin) {
                // Adjust Point Size
                this.m_maxFontSize = this.m_fontSize;

                const sizeDelta = Math.max(f32(f32(this.m_fontSize - this.m_minFontSize) / 2), 0.05);
                this.m_fontSize = f32(this.m_fontSize - sizeDelta);
                this.m_fontSize = Math.max(f32(intCast(f32(f32(this.m_fontSize * 20) + 0.5)) / 20), this.m_fontSizeMin);

                return;
              }
              // #endregion
            }

            // Check Text Overflow Modes
            switch (this.m_overflowMode) {
              case TextOverflowModes.Overflow:
              case TextOverflowModes.ScrollRect:
              case TextOverflowModes.Masking:
                // Nothing happens as horizontal bounds are ignored in this mode.
                break;

              case TextOverflowModes.Truncate:
                i = this.restoreWordWrappingState(this.m_SavedWordWrapState);

                characterToSubstitute.index = testedCharacterCount;
                characterToSubstitute.unicode = 0x03;
                continue;

              case TextOverflowModes.Ellipsis:
                if (this.m_EllipsisInsertionCandidateStack.count === 0) {
                  i = -1;
                  this.m_characterCount = 0;
                  characterToSubstitute.index = 0;
                  characterToSubstitute.unicode = 0x03;
                  this.m_firstCharacterOfLine = 0;
                  continue;
                }

                {
                  const ellipsisState = this.m_EllipsisInsertionCandidateStack.pop()!;
                  i = this.restoreWordWrappingState(ellipsisState);

                  i -= 1;
                  this.m_characterCount -= 1;
                  characterToSubstitute.index = this.m_characterCount;
                  characterToSubstitute.unicode = 0x2026;

                  restoreCount += 1;
                  continue;
                }

              case TextOverflowModes.Linked:
                i = this.restoreWordWrappingState(this.m_SavedWordWrapState);

                if (this.m_linkedTextComponentRef != null) {
                  this.warnings.push('TextOverflowModes.Linked：超出寬度的文字沒有交給 linked 元件（需要場景端串接）');

                  this.m_isTextTruncated = true;
                }

                // Truncate text the overflows the vertical bounds
                characterToSubstitute.index = this.m_characterCount;
                characterToSubstitute.unicode = 0x03;
                continue;
            }
          }
        }
        // #endregion

        // Special handling of characters that are not ignored at the end of a line.
        if (isWhiteSpace) {
          this.m_textInfo.characterInfo[this.m_characterCount].isVisible = false;
          this.m_lastVisibleCharacterOfLine = this.m_characterCount;
          this.m_lineVisibleSpaceCount = this.m_textInfo.lineInfo[this.m_lineNumber].spaceCount += 1;
          this.m_textInfo.lineInfo[this.m_lineNumber].marginLeft = marginLeft;
          this.m_textInfo.lineInfo[this.m_lineNumber].marginRight = marginRight;
          this.m_textInfo.spaceCount += 1;

          if (charCode === 0xa0) this.m_textInfo.lineInfo[this.m_lineNumber].controlCharacterCount += 1;
        } else if (charCode === 0xad) {
          this.m_textInfo.characterInfo[this.m_characterCount].isVisible = false;
        } else {
          // Determine Vertex Color
          const vertexColor = this.m_overrideHtmlColors ? { ...this.m_fontColor32 } : { ...this.m_htmlColor };

          // Store Character & Sprite Vertex Information
          if (this.m_textElementType === TmpTextElementType.Character) {
            // Save Character Vertex Data
            this.saveGlyphVertexInfo(padding, style_padding, vertexColor);
          } else if (this.m_textElementType === TmpTextElementType.Sprite) {
            this.saveSpriteVertexInfo(vertexColor);
          }

          if (isStartOfNewLine) {
            isStartOfNewLine = false;
            this.m_firstVisibleCharacterOfLine = this.m_characterCount;
          }

          this.m_lineVisibleCharacterCount += 1;
          this.m_lastVisibleCharacterOfLine = this.m_characterCount;
          this.m_textInfo.lineInfo[this.m_lineNumber].marginLeft = marginLeft;
          this.m_textInfo.lineInfo[this.m_lineNumber].marginRight = marginRight;
        }
      } else {
        // #region Check Vertical Bounds（TMPro_UGUI_Private.cs:3296；TMPro_Private.cs:3172）：Linked 模式的空白字元高度檢查
        if (this.m_overflowMode === TextOverflowModes.Linked && (charCode === 10 || charCode === 11)) {
          const textHeight = f32(
            f32(this.m_maxTextAscender - f32(this.m_maxLineDescender - this.m_lineOffset)) +
              (this.m_lineOffset > 0 && this.m_IsDrivenLineSpacing === false ? f32(this.m_maxLineAscender - this.m_startOfLineAscender) : 0),
          );

          const testedCharacterCount = this.m_characterCount;

          if (textHeight > f32(marginHeight + 0.0001)) {
            // Set isTextOverflowing and firstOverflowCharacterIndex
            if (this.m_firstOverflowCharacterIndex === -1) this.m_firstOverflowCharacterIndex = this.m_characterCount;

            i = this.restoreWordWrappingState(this.m_SavedLastValidState);

            if (this.m_linkedTextComponentRef != null) {
              this.warnings.push('TextOverflowModes.Linked：換行字元超出高度，沒有交給 linked 元件（需要場景端串接）');

              this.m_isTextTruncated = true;
            }

            // Truncate remaining text
            characterToSubstitute.index = testedCharacterCount;
            characterToSubstitute.unicode = 0x03;
            continue;
          }
        }
        // #endregion

        // Track # of spaces per line which is used for line justification.
        if (
          (charCode === 10 || charCode === 11 || charCode === 0xa0 || charCode === 0x2007 || charCode === 0x2028 || charCode === 0x2029 || charIsSeparator(charCode)) &&
          charCode !== 0xad &&
          charCode !== 0x200b &&
          charCode !== 0x2060
        ) {
          this.m_textInfo.lineInfo[this.m_lineNumber].spaceCount += 1;
          this.m_textInfo.spaceCount += 1;
        }

        // Special handling for control characters like <NBSP>
        if (charCode === 0xa0) this.m_textInfo.lineInfo[this.m_lineNumber].controlCharacterCount += 1;
      }
      // #endregion Handle Visible Characters

      // #region Track Potential Insertion Location for Ellipsis（TMPro_UGUI_Private.cs:3347；TMPro_Private.cs:3223）
      if (this.m_overflowMode === TextOverflowModes.Ellipsis && (isInjectedCharacter === false || charCode === 0x2d)) {
        let fontScale = f32(f32(f32(this.m_currentFontSize / this.m_Ellipsis.fontAsset!.faceInfo.pointSize) * this.m_Ellipsis.fontAsset!.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));
        let scale = f32(f32(fontScale * this.m_fontScaleMultiplier) * f32(this.m_Ellipsis.character!.scale * this.m_Ellipsis.character!.glyph.scale));
        let marginLeft = this.m_marginLeft;
        let marginRight = this.m_marginRight;

        // Use the scale and margins of the previous character if Line Feed (LF) is not the first character of a line.
        if (charCode === 0x0a && this.m_characterCount !== this.m_firstCharacterOfLine) {
          fontScale = f32(
            f32(f32(this.m_textInfo.characterInfo[this.m_characterCount - 1].pointSize / this.m_Ellipsis.fontAsset!.faceInfo.pointSize) * this.m_Ellipsis.fontAsset!.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1),
          );
          scale = f32(f32(fontScale * this.m_fontScaleMultiplier) * f32(this.m_Ellipsis.character!.scale * this.m_Ellipsis.character!.glyph.scale));
          marginLeft = this.m_textInfo.lineInfo[this.m_lineNumber].marginLeft;
          marginRight = this.m_textInfo.lineInfo[this.m_lineNumber].marginRight;
        }

        const textHeightE = f32(
          f32(this.m_maxTextAscender - f32(this.m_maxLineDescender - this.m_lineOffset)) + (this.m_lineOffset > 0 && this.m_IsDrivenLineSpacing === false ? f32(this.m_maxLineAscender - this.m_startOfLineAscender) : 0),
        );
        const textWidthE = f32(Math.abs(this.m_xAdvance) + f32(f32((!this.m_isRightToLeft ? this.m_Ellipsis.character!.glyph.metrics.horizontalAdvance : 0) * f32(1 - this.m_charWidthAdjDelta)) * scale));
        const widthOfTextAreaForEllipsis = this.m_width !== -1 ? Math.min(f32(f32(f32(marginWidth + 0.0001) - marginLeft) - marginRight), this.m_width) : f32(f32(f32(marginWidth + 0.0001) - marginLeft) - marginRight);

        if (textWidthE < f32(widthOfTextAreaForEllipsis * (isJustifiedOrFlush ? 1.05 : 1.0)) && textHeightE < f32(marginHeight + 0.0001)) {
          this.saveWordWrappingState(this.m_SavedEllipsisState, i, this.m_characterCount);
          this.m_EllipsisInsertionCandidateStack.push(this.m_SavedEllipsisState.clone());
        }
      }
      // #endregion

      // #region Store Character Data（TMPro_UGUI_Private.cs:3378；TMPro_Private.cs:3254）
      this.m_textInfo.characterInfo[this.m_characterCount].lineNumber = this.m_lineNumber;
      this.m_textInfo.characterInfo[this.m_characterCount].pageNumber = this.m_pageNumber;

      if ((charCode !== 10 && charCode !== 11 && charCode !== 13 && isInjectedCharacter === false) || this.m_textInfo.lineInfo[this.m_lineNumber].characterCount === 1)
        this.m_textInfo.lineInfo[this.m_lineNumber].alignment = this.m_lineJustification;
      // #endregion Store Character Data

      // #region XAdvance, Tabulation & Stops（TMPro_UGUI_Private.cs:3388；TMPro_Private.cs:3264）
      if (charCode === 9) {
        const tabSize = f32(f32(this.m_currentFontAsset!.faceInfo.tabWidth * this.m_currentFontAsset!.tabSize) * currentElementScale);
        const tabs = f32(Math.ceil(f32(this.m_xAdvance / tabSize)) * tabSize);
        this.m_xAdvance = tabs > this.m_xAdvance ? tabs : f32(this.m_xAdvance + tabSize);
      } else if (this.m_monoSpacing !== 0) {
        let monoAdjustment: number;
        if (this.m_duoSpace && (charCode === 0x2e || charCode === 0x3a || charCode === 0x2c)) monoAdjustment = f32(this.m_monoSpacing / 2 - monoAdvance);
        else monoAdjustment = f32(this.m_monoSpacing - monoAdvance);

        this.m_xAdvance = f32(
          this.m_xAdvance +
            f32(f32(monoAdjustment + f32(f32(this.m_currentFontAsset!.normalSpacingOffset + characterSpacingAdjustment) * currentEmScale)) + this.m_cSpacing) * f32(1 - this.m_charWidthAdjDelta),
        );

        if (isWhiteSpace || charCode === 0x200b) this.m_xAdvance = f32(this.m_xAdvance + f32(this.m_wordSpacing * currentEmScale));
      } else if (this.m_isRightToLeft) {
        this.m_xAdvance = f32(
          this.m_xAdvance -
            f32(f32(f32(glyphAdjustments.xAdvance * currentElementScale) + f32(f32(this.m_currentFontAsset!.normalSpacingOffset + characterSpacingAdjustment + boldSpacingAdjustment) * currentEmScale)) + this.m_cSpacing) *
              f32(1 - this.m_charWidthAdjDelta),
        );

        if (isWhiteSpace || charCode === 0x200b) this.m_xAdvance = f32(this.m_xAdvance - f32(this.m_wordSpacing * currentEmScale));
      } else {
        this.m_xAdvance = f32(
          this.m_xAdvance +
            f32(
              f32(f32(f32(currentGlyphMetrics.horizontalAdvance * this.m_FXScale.x) + glyphAdjustments.xAdvance) * currentElementScale) +
                f32(f32(this.m_currentFontAsset!.normalSpacingOffset + characterSpacingAdjustment + boldSpacingAdjustment) * currentEmScale) +
                this.m_cSpacing,
            ) * f32(1 - this.m_charWidthAdjDelta),
        );

        if (isWhiteSpace || charCode === 0x200b) this.m_xAdvance = f32(this.m_xAdvance + f32(this.m_wordSpacing * currentEmScale));
      }

      // Store xAdvance information
      this.m_textInfo.characterInfo[this.m_characterCount].xAdvance = this.m_xAdvance;
      // #endregion Tabulation & Stops

      // #region Carriage Return（TMPro_UGUI_Private.cs:3431；TMPro_Private.cs:3307）
      if (charCode === 13) {
        this.m_xAdvance = f32(0 + this.tag_Indent);
      }
      // #endregion Carriage Return

      // #region Save PageInfo（TMPro_UGUI_Private.cs:3442；TMPro_Private.cs:3318）
      if (this.m_overflowMode === TextOverflowModes.Page && charCode !== 10 && charCode !== 11 && charCode !== 13 && charCode !== 0x2028 && charCode !== 0x2029) {
        // Check if we need to increase allocations for the pageInfo array.
        if (this.m_pageNumber + 1 > this.m_textInfo.pageInfo.length) TmpTextInfo.resizePageInfo(this.m_textInfo.pageInfo, this.m_pageNumber + 1);

        this.m_textInfo.pageInfo[this.m_pageNumber].ascender = this.m_PageAscender;
        this.m_textInfo.pageInfo[this.m_pageNumber].descender =
          this.m_ElementDescender < this.m_textInfo.pageInfo[this.m_pageNumber].descender ? this.m_ElementDescender : this.m_textInfo.pageInfo[this.m_pageNumber].descender;

        if (this.m_isNewPage) {
          this.m_isNewPage = false;
          this.m_textInfo.pageInfo[this.m_pageNumber].firstCharacterIndex = this.m_characterCount;
        }

        // Last index
        this.m_textInfo.pageInfo[this.m_pageNumber].lastCharacterIndex = this.m_characterCount;
      }
      // #endregion Save PageInfo

      // #region Check for Line Feed and Last Character（TMPro_UGUI_Private.cs:3469；TMPro_Private.cs:3345）
      if (charCode === 10 || charCode === 11 || charCode === 0x03 || charCode === 0x2028 || charCode === 0x2029 || (charCode === 0x2d && isInjectedCharacter) || this.m_characterCount === totalCharacterCount - 1) {
        // Adjust current line spacing (if necessary) before inserting new line
        const baselineAdjustmentDelta = f32(this.m_maxLineAscender - this.m_startOfLineAscender);
        if (this.m_lineOffset > 0 && Math.abs(baselineAdjustmentDelta) > 0.01 && this.m_IsDrivenLineSpacing === false && !this.m_isNewPage) {
          this.adjustLineOffset(this.m_firstCharacterOfLine, this.m_characterCount, baselineAdjustmentDelta);
          this.m_ElementDescender = f32(this.m_ElementDescender - baselineAdjustmentDelta);
          this.m_lineOffset = f32(this.m_lineOffset + baselineAdjustmentDelta);

          // Adjust saved ellipsis state only if we are adjusting the same line number
          if (this.m_SavedEllipsisState.lineNumber === this.m_lineNumber && this.m_EllipsisInsertionCandidateStack.count > 0) {
            const s = this.m_EllipsisInsertionCandidateStack.pop()!;
            s.startOfLineAscender = f32(s.startOfLineAscender + baselineAdjustmentDelta);
            s.lineOffset = f32(s.lineOffset + baselineAdjustmentDelta);
            this.m_SavedEllipsisState = s;
            this.m_EllipsisInsertionCandidateStack.push(s);
          }
        }
        this.m_isNewPage = false;

        // Calculate lineAscender & make sure if last character is superscript or subscript that we check that as well.
        const lineAscender = f32(this.m_maxLineAscender - this.m_lineOffset);
        const lineDescender = f32(this.m_maxLineDescender - this.m_lineOffset);

        // Update maxDescender and maxVisibleDescender
        this.m_ElementDescender = this.m_ElementDescender < lineDescender ? this.m_ElementDescender : lineDescender;
        if (!visState.isMaxVisibleDescenderSet) visState.maxVisibleDescender = this.m_ElementDescender;

        if (this.m_useMaxVisibleDescender && (this.m_characterCount >= this.m_maxVisibleCharacters || this.m_lineNumber >= this.m_maxVisibleLines)) visState.isMaxVisibleDescenderSet = true;

        // Save Line Information
        this.m_textInfo.lineInfo[this.m_lineNumber].firstCharacterIndex = this.m_firstCharacterOfLine;
        this.m_textInfo.lineInfo[this.m_lineNumber].firstVisibleCharacterIndex = this.m_firstVisibleCharacterOfLine =
          this.m_firstCharacterOfLine > this.m_firstVisibleCharacterOfLine ? this.m_firstCharacterOfLine : this.m_firstVisibleCharacterOfLine;
        this.m_textInfo.lineInfo[this.m_lineNumber].lastCharacterIndex = this.m_lastCharacterOfLine = this.m_characterCount;
        this.m_textInfo.lineInfo[this.m_lineNumber].lastVisibleCharacterIndex = this.m_lastVisibleCharacterOfLine =
          this.m_lastVisibleCharacterOfLine < this.m_firstVisibleCharacterOfLine ? this.m_firstVisibleCharacterOfLine : this.m_lastVisibleCharacterOfLine;

        this.m_textInfo.lineInfo[this.m_lineNumber].characterCount = this.m_textInfo.lineInfo[this.m_lineNumber].lastCharacterIndex - this.m_textInfo.lineInfo[this.m_lineNumber].firstCharacterIndex + 1;
        this.m_textInfo.lineInfo[this.m_lineNumber].visibleCharacterCount = this.m_lineVisibleCharacterCount;
        this.m_textInfo.lineInfo[this.m_lineNumber].visibleSpaceCount = this.m_textInfo.lineInfo[this.m_lineNumber].lastVisibleCharacterIndex + 1 - this.m_lineVisibleCharacterCount;
        this.m_textInfo.lineInfo[this.m_lineNumber].lineExtents.min = { x: this.m_textInfo.characterInfo[this.m_firstVisibleCharacterOfLine].bottomLeft.x, y: lineDescender };
        this.m_textInfo.lineInfo[this.m_lineNumber].lineExtents.max = { x: this.m_textInfo.characterInfo[this.m_lastVisibleCharacterOfLine].topRight.x, y: lineAscender };
        this.m_textInfo.lineInfo[this.m_lineNumber].length = f32(this.m_textInfo.lineInfo[this.m_lineNumber].lineExtents.max.x - f32(padding * currentElementScale));
        this.m_textInfo.lineInfo[this.m_lineNumber].width = widthOfTextArea;

        if (this.m_textInfo.lineInfo[this.m_lineNumber].characterCount === 1) this.m_textInfo.lineInfo[this.m_lineNumber].alignment = this.m_lineJustification;

        const maxAdvanceOffset = f32(f32(f32(this.m_currentFontAsset!.normalSpacingOffset + characterSpacingAdjustment + boldSpacingAdjustment) * currentEmScale) + this.m_cSpacing) * f32(1 - this.m_charWidthAdjDelta);
        if (this.m_textInfo.characterInfo[this.m_lastVisibleCharacterOfLine].isVisible)
          this.m_textInfo.lineInfo[this.m_lineNumber].maxAdvance = f32(this.m_textInfo.characterInfo[this.m_lastVisibleCharacterOfLine].xAdvance + (this.m_isRightToLeft ? maxAdvanceOffset : -maxAdvanceOffset));
        else this.m_textInfo.lineInfo[this.m_lineNumber].maxAdvance = f32(this.m_textInfo.characterInfo[this.m_lastCharacterOfLine].xAdvance + (this.m_isRightToLeft ? maxAdvanceOffset : -maxAdvanceOffset));

        this.m_textInfo.lineInfo[this.m_lineNumber].baseline = f32(0 - this.m_lineOffset);
        this.m_textInfo.lineInfo[this.m_lineNumber].ascender = lineAscender;
        this.m_textInfo.lineInfo[this.m_lineNumber].descender = lineDescender;
        this.m_textInfo.lineInfo[this.m_lineNumber].lineHeight = f32(f32(lineAscender - lineDescender) + f32(lineGap * baseScale));

        // Add new line if not last line or character.
        if (charCode === 10 || charCode === 11 || (charCode === 0x2d && isInjectedCharacter) || charCode === 0x2028 || charCode === 0x2029) {
          // Store the state of the line before starting on the new line.
          this.saveWordWrappingState(this.m_SavedLineState, i, this.m_characterCount);

          this.m_lineNumber += 1;
          isStartOfNewLine = true;
          ignoreNonBreakingSpace = false;
          isFirstWordOfLine = true;

          this.m_firstCharacterOfLine = this.m_characterCount + 1;
          this.m_lineVisibleCharacterCount = 0;
          this.m_lineVisibleSpaceCount = 0;

          // Check to make sure Array is large enough to hold a new line.
          if (this.m_lineNumber >= this.m_textInfo.lineInfo.length) this.resizeLineExtents(this.m_lineNumber);

          const lastVisibleAscender = this.m_textInfo.characterInfo[this.m_characterCount].adjustedAscender;

          // Apply Line Spacing with special handling for VT char(11)
          if (this.m_lineHeight === TMP_MATH.FLOAT_UNSET) {
            const lineOffsetDelta = f32(
              f32(f32(f32(0 - this.m_maxLineDescender) + lastVisibleAscender) + f32(f32(lineGap + this.m_lineSpacingDelta) * baseScale)) +
                f32((this.m_lineSpacing + (charCode === 10 || charCode === 0x2029 ? this.m_paragraphSpacing : 0)) * currentEmScale),
            );
            this.m_lineOffset = f32(this.m_lineOffset + lineOffsetDelta);
            this.m_IsDrivenLineSpacing = false;
          } else {
            this.m_lineOffset = f32(this.m_lineOffset + f32(this.m_lineHeight + f32((this.m_lineSpacing + (charCode === 10 || charCode === 0x2029 ? this.m_paragraphSpacing : 0)) * currentEmScale)));
            this.m_IsDrivenLineSpacing = true;
          }

          this.m_maxLineAscender = k_LargeNegativeFloat;
          this.m_maxLineDescender = k_LargePositiveFloat;
          this.m_startOfLineAscender = lastVisibleAscender;

          this.m_xAdvance = f32(f32(0 + this.tag_LineIndent) + this.tag_Indent);

          this.saveWordWrappingState(this.m_SavedWordWrapState, i, this.m_characterCount);
          this.saveWordWrappingState(this.m_SavedLastValidState, i, this.m_characterCount);

          this.m_characterCount += 1;

          continue;
        }

        // If End of Text
        if (charCode === 0x03) i = this.m_TextProcessingArray.length;
      }
      // #endregion Check for Linefeed or Last Character

      // #region Track Text Extents（TMPro_UGUI_Private.cs:3594；TMPro_Private.cs:3470）
      // Determine the bounds of the Mesh.
      if (this.m_textInfo.characterInfo[this.m_characterCount].isVisible) {
        this.m_meshExtents.min.x = Math.min(this.m_meshExtents.min.x, this.m_textInfo.characterInfo[this.m_characterCount].bottomLeft.x);
        this.m_meshExtents.min.y = Math.min(this.m_meshExtents.min.y, this.m_textInfo.characterInfo[this.m_characterCount].bottomLeft.y);

        this.m_meshExtents.max.x = Math.max(this.m_meshExtents.max.x, this.m_textInfo.characterInfo[this.m_characterCount].topRight.x);
        this.m_meshExtents.max.y = Math.max(this.m_meshExtents.max.y, this.m_textInfo.characterInfo[this.m_characterCount].topRight.y);
      }
      // #endregion Track Text Extents

      // #region Save Word Wrapping State（TMPro_UGUI_Private.cs:3613；TMPro_Private.cs:3489）
      if (
        (this.m_TextWrappingMode !== TextWrappingModes.NoWrap && this.m_TextWrappingMode !== TextWrappingModes.PreserveWhitespaceNoWrap) ||
        this.m_overflowMode === TextOverflowModes.Truncate ||
        this.m_overflowMode === TextOverflowModes.Ellipsis ||
        this.m_overflowMode === TextOverflowModes.Linked
      ) {
        let shouldSaveHardLineBreak = false;
        let shouldSaveSoftLineBreak = false;

        if (
          (isWhiteSpace || charCode === 0x200b || charCode === 0x2d || charCode === 0xad) &&
          (!this.m_isNonBreakingSpace || ignoreNonBreakingSpace) &&
          charCode !== 0xa0 &&
          charCode !== 0x2007 &&
          charCode !== 0x2011 &&
          charCode !== 0x202f &&
          charCode !== 0x2060
        ) {
          // Ignore Hyphen (0x2D) when preceded by a whitespace
          if (!(charCode === 0x2d && this.m_characterCount > 0 && charIsWhiteSpace(this.m_textInfo.characterInfo[this.m_characterCount - 1].character))) {
            isFirstWordOfLine = false;
            shouldSaveHardLineBreak = true;

            // Reset soft line breaking point since we now have a valid hard break point.
            this.m_SavedSoftLineBreakState.previous_WordBreak = -1;
          }
        }
        // Handling for East Asian scripts
        else if (this.m_isNonBreakingSpace === false && ((isHangul(charCode) && this.settings.useModernHangulLineBreakingRules === false) || isCJK(charCode))) {
          const isCurrentLeadingCharacter = this.settings.linebreakingRules(this.assets).leadingCharacters.has(charCode);
          const isNextFollowingCharacter =
            this.m_characterCount < totalCharacterCount - 1 && this.settings.linebreakingRules(this.assets).followingCharacters.has(this.m_textInfo.characterInfo[this.m_characterCount + 1].character);

          if (isCurrentLeadingCharacter === false) {
            if (isNextFollowingCharacter === false) {
              isFirstWordOfLine = false;
              shouldSaveHardLineBreak = true;
            }

            if (isFirstWordOfLine) {
              // Special handling for non-breaking space and soft line breaks
              if (isWhiteSpace) shouldSaveSoftLineBreak = true;

              shouldSaveHardLineBreak = true;
            }
          } else {
            if (isFirstWordOfLine && isFirstCharacterOfLine) {
              // Special handling for non-breaking space and soft line breaks
              if (isWhiteSpace) shouldSaveSoftLineBreak = true;

              shouldSaveHardLineBreak = true;
            }
          }
        }
        // Special handling for Latin characters followed by a CJK character.
        else if (this.m_isNonBreakingSpace === false && this.m_characterCount + 1 < totalCharacterCount && isCJK(this.m_textInfo.characterInfo[this.m_characterCount + 1].character)) {
          shouldSaveHardLineBreak = true;
        } else if (isFirstWordOfLine) {
          // Special handling for non-breaking space and soft line breaks
          if ((isWhiteSpace && charCode !== 0xa0) || (charCode === 0xad && isSoftHyphenIgnored === false)) shouldSaveSoftLineBreak = true;

          shouldSaveHardLineBreak = true;
        }

        // Save potential Hard lines break
        if (shouldSaveHardLineBreak) this.saveWordWrappingState(this.m_SavedWordWrapState, i, this.m_characterCount);

        // Save potential Soft line break
        if (shouldSaveSoftLineBreak) this.saveWordWrappingState(this.m_SavedSoftLineBreakState, i, this.m_characterCount);
      }
      // #endregion Save Word Wrapping State

      // Consider only saving state on base glyphs
      this.saveWordWrappingState(this.m_SavedLastValidState, i, this.m_characterCount);

      this.m_characterCount += 1;
    }

    // #region Check Auto-Sizing (Upper Font Size Bounds)（TMPro_UGUI_Private.cs:3701；TMPro_Private.cs:3577）
    fontSizeDelta = f32(this.m_maxFontSize - this.m_minFontSize);
    if (this.m_enableAutoSizing && fontSizeDelta > 0.051 && this.m_fontSize < this.m_fontSizeMax && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
      // Reset character width adjustment delta
      if (this.m_charWidthAdjDelta < this.m_charWidthMaxAdj / 100) this.m_charWidthAdjDelta = 0;

      this.m_minFontSize = this.m_fontSize;

      const sizeDelta = Math.max(f32(f32(this.m_maxFontSize - this.m_fontSize) / 2), 0.05);
      this.m_fontSize = f32(this.m_fontSize + sizeDelta);
      this.m_fontSize = Math.min(f32(intCast(f32(f32(this.m_fontSize * 20) + 0.5)) / 20), this.m_fontSizeMax);

      return;
    }
    // #endregion End Auto-sizing Check

    this.m_IsAutoSizePointSizeSet = true;

    // If there are no visible characters or only character is End of Text (0x03)... no need to continue
    if (this.m_characterCount === 0 || (this.m_characterCount === 1 && charCode === 0x03)) {
      this.clearMesh();

      return;
    }

    // *** PHASE II of Text Generation ***
    const last_vert_index = { v: this.m_materialReferences[this.m_Underline.materialIndex].referenceCount * 4 };

    // Partial clear of the vertices array to mark unused vertices as degenerate.
    this.m_textInfo.meshInfo[0].clear();

    // #region Text Vertical Alignment（TMPro_UGUI_Private.cs:3750；TMPro_Private.cs:3626）
    let anchorOffset: Vec3 = { x: 0, y: 0, z: 0 };
    const corners = this.m_RectTransformCorners;

    // Handle Vertical Text Alignment
    switch (this.m_VerticalAlignment) {
      // Top Vertically
      case VerticalAlignmentOptions.Top:
        if (this.m_overflowMode !== TextOverflowModes.Page)
          anchorOffset = { x: f32(corners[1].x + f32(0 + margins.x)), y: f32(corners[1].y + f32(f32(0 - this.m_maxTextAscender) - margins.y)), z: 0 };
        else anchorOffset = { x: f32(corners[1].x + f32(0 + margins.x)), y: f32(corners[1].y + f32(f32(0 - this.m_textInfo.pageInfo[pageToDisplay].ascender) - margins.y)), z: 0 };
        break;

      // Middle Vertically
      case VerticalAlignmentOptions.Middle:
        if (this.m_overflowMode !== TextOverflowModes.Page)
          anchorOffset = {
            x: f32(f32(f32(corners[0].x + corners[1].x) / 2) + f32(0 + margins.x)),
            y: f32(f32(f32(corners[0].y + corners[1].y) / 2) + f32(f32(0 - f32(f32(f32(this.m_maxTextAscender + margins.y) + visState.maxVisibleDescender) - margins.w)) / 2)),
            z: 0,
          };
        else
          anchorOffset = {
            x: f32(f32(f32(corners[0].x + corners[1].x) / 2) + f32(0 + margins.x)),
            y: f32(f32(f32(corners[0].y + corners[1].y) / 2) + f32(f32(0 - f32(f32(f32(this.m_textInfo.pageInfo[pageToDisplay].ascender + margins.y) + this.m_textInfo.pageInfo[pageToDisplay].descender) - margins.w)) / 2)),
            z: 0,
          };
        break;

      // Bottom Vertically
      case VerticalAlignmentOptions.Bottom:
        if (this.m_overflowMode !== TextOverflowModes.Page) anchorOffset = { x: f32(corners[0].x + f32(0 + margins.x)), y: f32(corners[0].y + f32(f32(0 - visState.maxVisibleDescender) + margins.w)), z: 0 };
        else anchorOffset = { x: f32(corners[0].x + f32(0 + margins.x)), y: f32(corners[0].y + f32(f32(0 - this.m_textInfo.pageInfo[pageToDisplay].descender) + margins.w)), z: 0 };
        break;

      // Baseline Vertically
      case VerticalAlignmentOptions.Baseline:
        anchorOffset = { x: f32(f32(f32(corners[0].x + corners[1].x) / 2) + f32(0 + margins.x)), y: f32(f32(corners[0].y + corners[1].y) / 2), z: 0 };
        break;

      // Midline Vertically
      case VerticalAlignmentOptions.Geometry:
        anchorOffset = {
          x: f32(f32(f32(corners[0].x + corners[1].x) / 2) + f32(0 + margins.x)),
          y: f32(f32(f32(corners[0].y + corners[1].y) / 2) + f32(f32(0 - f32(f32(f32(this.m_meshExtents.max.y + margins.y) + this.m_meshExtents.min.y) - margins.w)) / 2)),
          z: 0,
        };
        break;

      // Capline Vertically
      case VerticalAlignmentOptions.Capline:
        anchorOffset = { x: f32(f32(f32(corners[0].x + corners[1].x) / 2) + f32(0 + margins.x)), y: f32(f32(f32(corners[0].y + corners[1].y) / 2) + f32(f32(0 - f32(f32(this.m_maxCapHeight - margins.y) - margins.w)) / 2)), z: 0 };
        break;
    }
    // #endregion

    // Initialization for Second Pass
    let justificationOffset: Vec3 = { x: 0, y: 0, z: 0 };
    let offset: Vec3 = { x: 0, y: 0, z: 0 };

    let wordCount = 0;
    let lineCount = 0;
    let lastLine = 0;
    let isFirstSeperator = false;

    let isStartOfWord = false;
    let wordFirstChar = 0;
    let wordLastChar = 0;

    // Second Pass : Line Justification, UV Mapping, Character & Line Visibility & more.
    // UGUI 3806–3809：Canvas render mode 與攝影機決定 xScale 的乘數；3D（TMPro_Private.cs:3690）直接用 lossyScale
    const isCameraAssigned = this.ctx?.canvas ? this.ctx.canvas.worldCameraAssigned : false;
    const lossyScale = (this.m_previousLossyScaleY = this.ctx?.lossyScaleY ?? 1);
    const canvasRenderMode = this.ctx?.canvas?.renderMode ?? 0;
    const canvasScaleFactor = this.ctx?.canvas?.scaleFactor ?? 1;

    let underlineColor: Color32 = color32(255, 255, 255, 255);
    let strikethroughColor: Color32 = color32(255, 255, 255, 255);
    let highlightStateCur: HighlightState = highlightState(color32(255, 255, 0, 64), tmpOffset());
    let xScale = 0;
    let xScaleMax = 0;
    let underlineStartScale = 0;
    let underlineEndScale = 0;
    let underlineMaxScale = 0;
    let underlineBaseLine = k_LargePositiveFloat;
    let lastPage = 0;

    let strikethroughPointSize = 0;
    let strikethroughScale = 0;
    let strikethroughBaseline = 0;

    const characterInfos = this.m_textInfo.characterInfo;
    // #region Handle Line Justification & UV Mapping & Character Visibility & More（TMPro_UGUI_Private.cs:3836；TMPro_Private.cs:3708）
    for (let i = 0; i < this.m_characterCount; i++) {
      const currentFontAsset = characterInfos[i].fontAsset!;

      const unicode = characterInfos[i].character;
      const isWhiteSpace = charIsWhiteSpace(unicode);

      const currentLine = characterInfos[i].lineNumber;
      const lineInfo = this.m_textInfo.lineInfo[currentLine];
      lineCount = currentLine + 1;

      const lineAlignment = lineInfo.alignment;

      // #region Handle Line Justification（TMPro_UGUI_Private.cs:3851；TMPro_Private.cs:3723）
      switch (lineAlignment) {
        case HorizontalAlignmentOptions.Left:
          if (!this.m_isRightToLeft) justificationOffset = { x: f32(0 + lineInfo.marginLeft), y: 0, z: 0 };
          else justificationOffset = { x: f32(0 - lineInfo.maxAdvance), y: 0, z: 0 };
          break;

        case HorizontalAlignmentOptions.Center:
          justificationOffset = { x: f32(f32(lineInfo.marginLeft + f32(lineInfo.width / 2)) - f32(lineInfo.maxAdvance / 2)), y: 0, z: 0 };
          break;

        case HorizontalAlignmentOptions.Geometry:
          justificationOffset = { x: f32(f32(lineInfo.marginLeft + f32(lineInfo.width / 2)) - f32(f32(lineInfo.lineExtents.min.x + lineInfo.lineExtents.max.x) / 2)), y: 0, z: 0 };
          break;

        case HorizontalAlignmentOptions.Right:
          if (!this.m_isRightToLeft) justificationOffset = { x: f32(f32(lineInfo.marginLeft + lineInfo.width) - lineInfo.maxAdvance), y: 0, z: 0 };
          else justificationOffset = { x: f32(lineInfo.marginLeft + lineInfo.width), y: 0, z: 0 };
          break;

        case HorizontalAlignmentOptions.Justified:
        case HorizontalAlignmentOptions.Flush:
          // Skip Zero Width Characters and spaces outside of the margins.
          if (i > lineInfo.lastVisibleCharacterIndex || unicode === 0x0a || unicode === 0xad || unicode === 0x200b || unicode === 0x2060 || unicode === 0x03) break;

          {
            const lastCharOfCurrentLine = characterInfos[lineInfo.lastCharacterIndex].character;

            const isFlush = (lineAlignment & HorizontalAlignmentOptions.Flush) === HorizontalAlignmentOptions.Flush;

            // In Justified mode, all lines are justified except the last one.
            // In Flush mode, all lines are justified.
            if ((charIsControl(lastCharOfCurrentLine) === false && currentLine < this.m_lineNumber) || isFlush || lineInfo.maxAdvance > lineInfo.width) {
              // First character of each line.
              if (currentLine !== lastLine || i === 0 || i === this.m_firstVisibleCharacter) {
                if (!this.m_isRightToLeft) justificationOffset = { x: lineInfo.marginLeft, y: 0, z: 0 };
                else justificationOffset = { x: f32(lineInfo.marginLeft + lineInfo.width), y: 0, z: 0 };

                if (charIsSeparator(unicode)) isFirstSeperator = true;
                else isFirstSeperator = false;
              } else {
                const gap = !this.m_isRightToLeft ? f32(lineInfo.width - lineInfo.maxAdvance) : f32(lineInfo.width + lineInfo.maxAdvance);
                let visibleCount = lineInfo.visibleCharacterCount - 1 + lineInfo.controlCharacterCount;
                let spaces = lineInfo.visibleSpaceCount - lineInfo.controlCharacterCount;

                if (isFirstSeperator) {
                  spaces -= 1;
                  visibleCount += 1;
                }

                const ratio = spaces > 0 ? this.m_wordWrappingRatios : 1;

                if (spaces < 1) spaces = 1;

                if (unicode !== 0xa0 && (unicode === 9 || charIsSeparator(unicode))) {
                  if (!this.m_isRightToLeft) justificationOffset = { x: f32(justificationOffset.x + f32(f32(gap * (1 - ratio)) / spaces)), y: 0, z: 0 };
                  else justificationOffset = { x: f32(justificationOffset.x - f32(f32(gap * (1 - ratio)) / spaces)), y: 0, z: 0 };
                } else {
                  if (!this.m_isRightToLeft) justificationOffset = { x: f32(justificationOffset.x + f32(f32(gap * ratio) / visibleCount)), y: 0, z: 0 };
                  else justificationOffset = { x: f32(justificationOffset.x - f32(f32(gap * ratio) / visibleCount)), y: 0, z: 0 };
                }
              }
            } else {
              if (!this.m_isRightToLeft) justificationOffset = { x: lineInfo.marginLeft, y: 0, z: 0 }; // Keep last line left justified.
              else justificationOffset = { x: f32(lineInfo.marginLeft + lineInfo.width), y: 0, z: 0 }; // Keep last line right justified.
            }
          }
          break;
      }
      // #endregion End Text Justification

      offset = { x: f32(anchorOffset.x + justificationOffset.x), y: f32(anchorOffset.y + justificationOffset.y), z: f32(anchorOffset.z + justificationOffset.z) };

      // #region Handling of UV2 mapping & Scale packing（TMPro_UGUI_Private.cs:3945；TMPro_Private.cs:3817）
      const isCharacterVisible = characterInfos[i].isVisible;
      if (isCharacterVisible) {
        const elementType = characterInfos[i].elementType;
        switch (elementType) {
          // CHARACTERS
          case TmpTextElementType.Character: {
            const lineExtents = lineInfo.lineExtents;
            const uvOffset = f32((this.m_uvLineOffset * currentLine) % 1);

            // #region Handle UV Mapping Options（TMPro_UGUI_Private.cs:3958；TMPro_Private.cs:3830）
            switch (this.m_horizontalMapping) {
              case TextureMappingOptions.Character:
                characterInfos[i].vertex_BL.uv2.x = 0;
                characterInfos[i].vertex_TL.uv2.x = 0;
                characterInfos[i].vertex_TR.uv2.x = 1;
                characterInfos[i].vertex_BR.uv2.x = 1;
                break;

              case TextureMappingOptions.Line:
                if (this.m_textAlignment !== 8 /* TextAlignmentOptions.Justified */) {
                  characterInfos[i].vertex_BL.uv2.x = f32(f32(f32(characterInfos[i].vertex_BL.position.x - lineExtents.min.x) / f32(lineExtents.max.x - lineExtents.min.x)) + uvOffset);
                  characterInfos[i].vertex_TL.uv2.x = f32(f32(f32(characterInfos[i].vertex_TL.position.x - lineExtents.min.x) / f32(lineExtents.max.x - lineExtents.min.x)) + uvOffset);
                  characterInfos[i].vertex_TR.uv2.x = f32(f32(f32(characterInfos[i].vertex_TR.position.x - lineExtents.min.x) / f32(lineExtents.max.x - lineExtents.min.x)) + uvOffset);
                  characterInfos[i].vertex_BR.uv2.x = f32(f32(f32(characterInfos[i].vertex_BR.position.x - lineExtents.min.x) / f32(lineExtents.max.x - lineExtents.min.x)) + uvOffset);
                  break;
                } else {
                  // Special Case if Justified is used in Line Mode.
                  characterInfos[i].vertex_BL.uv2.x = f32(f32(f32(f32(characterInfos[i].vertex_BL.position.x + justificationOffset.x) - this.m_meshExtents.min.x) / f32(this.m_meshExtents.max.x - this.m_meshExtents.min.x)) + uvOffset);
                  characterInfos[i].vertex_TL.uv2.x = f32(f32(f32(f32(characterInfos[i].vertex_TL.position.x + justificationOffset.x) - this.m_meshExtents.min.x) / f32(this.m_meshExtents.max.x - this.m_meshExtents.min.x)) + uvOffset);
                  characterInfos[i].vertex_TR.uv2.x = f32(f32(f32(f32(characterInfos[i].vertex_TR.position.x + justificationOffset.x) - this.m_meshExtents.min.x) / f32(this.m_meshExtents.max.x - this.m_meshExtents.min.x)) + uvOffset);
                  characterInfos[i].vertex_BR.uv2.x = f32(f32(f32(f32(characterInfos[i].vertex_BR.position.x + justificationOffset.x) - this.m_meshExtents.min.x) / f32(this.m_meshExtents.max.x - this.m_meshExtents.min.x)) + uvOffset);
                  break;
                }

              case TextureMappingOptions.Paragraph:
                characterInfos[i].vertex_BL.uv2.x = f32(f32(f32(f32(characterInfos[i].vertex_BL.position.x + justificationOffset.x) - this.m_meshExtents.min.x) / f32(this.m_meshExtents.max.x - this.m_meshExtents.min.x)) + uvOffset);
                characterInfos[i].vertex_TL.uv2.x = f32(f32(f32(f32(characterInfos[i].vertex_TL.position.x + justificationOffset.x) - this.m_meshExtents.min.x) / f32(this.m_meshExtents.max.x - this.m_meshExtents.min.x)) + uvOffset);
                characterInfos[i].vertex_TR.uv2.x = f32(f32(f32(f32(characterInfos[i].vertex_TR.position.x + justificationOffset.x) - this.m_meshExtents.min.x) / f32(this.m_meshExtents.max.x - this.m_meshExtents.min.x)) + uvOffset);
                characterInfos[i].vertex_BR.uv2.x = f32(f32(f32(f32(characterInfos[i].vertex_BR.position.x + justificationOffset.x) - this.m_meshExtents.min.x) / f32(this.m_meshExtents.max.x - this.m_meshExtents.min.x)) + uvOffset);
                break;

              case TextureMappingOptions.MatchAspect: {
                switch (this.m_verticalMapping) {
                  case TextureMappingOptions.Character:
                    characterInfos[i].vertex_BL.uv2.y = 0;
                    characterInfos[i].vertex_TL.uv2.y = 1;
                    characterInfos[i].vertex_TR.uv2.y = 0;
                    characterInfos[i].vertex_BR.uv2.y = 1;
                    break;

                  case TextureMappingOptions.Line:
                    characterInfos[i].vertex_BL.uv2.y = f32(f32(f32(characterInfos[i].vertex_BL.position.y - lineExtents.min.y) / f32(lineExtents.max.y - lineExtents.min.y)) + uvOffset);
                    characterInfos[i].vertex_TL.uv2.y = f32(f32(f32(characterInfos[i].vertex_TL.position.y - lineExtents.min.y) / f32(lineExtents.max.y - lineExtents.min.y)) + uvOffset);
                    characterInfos[i].vertex_TR.uv2.y = characterInfos[i].vertex_BL.uv2.y;
                    characterInfos[i].vertex_BR.uv2.y = characterInfos[i].vertex_TL.uv2.y;
                    break;

                  case TextureMappingOptions.Paragraph:
                    characterInfos[i].vertex_BL.uv2.y = f32(f32(f32(characterInfos[i].vertex_BL.position.y - this.m_meshExtents.min.y) / f32(this.m_meshExtents.max.y - this.m_meshExtents.min.y)) + uvOffset);
                    characterInfos[i].vertex_TL.uv2.y = f32(f32(f32(characterInfos[i].vertex_TL.position.y - this.m_meshExtents.min.y) / f32(this.m_meshExtents.max.y - this.m_meshExtents.min.y)) + uvOffset);
                    characterInfos[i].vertex_TR.uv2.y = characterInfos[i].vertex_BL.uv2.y;
                    characterInfos[i].vertex_BR.uv2.y = characterInfos[i].vertex_TL.uv2.y;
                    break;

                  case TextureMappingOptions.MatchAspect:
                    this.warnings.push('水平與垂直 UV mapping 不能同時是 MatchAspect');
                    break;
                }

                // Center of Rectangle
                const xDelta = f32(f32(1 - f32(f32(characterInfos[i].vertex_BL.uv2.y + characterInfos[i].vertex_TL.uv2.y) * characterInfos[i].aspectRatio)) / 2);

                characterInfos[i].vertex_BL.uv2.x = f32(f32(f32(characterInfos[i].vertex_BL.uv2.y * characterInfos[i].aspectRatio) + xDelta) + uvOffset);
                characterInfos[i].vertex_TL.uv2.x = characterInfos[i].vertex_BL.uv2.x;
                characterInfos[i].vertex_TR.uv2.x = f32(f32(f32(characterInfos[i].vertex_TL.uv2.y * characterInfos[i].aspectRatio) + xDelta) + uvOffset);
                characterInfos[i].vertex_BR.uv2.x = characterInfos[i].vertex_TR.uv2.x;
                break;
              }
            }

            switch (this.m_verticalMapping) {
              case TextureMappingOptions.Character:
                characterInfos[i].vertex_BL.uv2.y = 0;
                characterInfos[i].vertex_TL.uv2.y = 1;
                characterInfos[i].vertex_TR.uv2.y = 1;
                characterInfos[i].vertex_BR.uv2.y = 0;
                break;

              case TextureMappingOptions.Line:
                characterInfos[i].vertex_BL.uv2.y = f32(f32(characterInfos[i].vertex_BL.position.y - lineInfo.descender) / f32(lineInfo.ascender - lineInfo.descender));
                characterInfos[i].vertex_TL.uv2.y = f32(f32(characterInfos[i].vertex_TL.position.y - lineInfo.descender) / f32(lineInfo.ascender - lineInfo.descender));
                characterInfos[i].vertex_TR.uv2.y = characterInfos[i].vertex_TL.uv2.y;
                characterInfos[i].vertex_BR.uv2.y = characterInfos[i].vertex_BL.uv2.y;
                break;

              case TextureMappingOptions.Paragraph:
                characterInfos[i].vertex_BL.uv2.y = f32(f32(characterInfos[i].vertex_BL.position.y - this.m_meshExtents.min.y) / f32(this.m_meshExtents.max.y - this.m_meshExtents.min.y));
                characterInfos[i].vertex_TL.uv2.y = f32(f32(characterInfos[i].vertex_TL.position.y - this.m_meshExtents.min.y) / f32(this.m_meshExtents.max.y - this.m_meshExtents.min.y));
                characterInfos[i].vertex_TR.uv2.y = characterInfos[i].vertex_TL.uv2.y;
                characterInfos[i].vertex_BR.uv2.y = characterInfos[i].vertex_BL.uv2.y;
                break;

              case TextureMappingOptions.MatchAspect: {
                const yDelta = f32(f32(1 - f32(f32(characterInfos[i].vertex_BL.uv2.x + characterInfos[i].vertex_TR.uv2.x) / characterInfos[i].aspectRatio)) / 2);

                characterInfos[i].vertex_BL.uv2.y = f32(yDelta + f32(characterInfos[i].vertex_BL.uv2.x / characterInfos[i].aspectRatio));
                characterInfos[i].vertex_TL.uv2.y = f32(yDelta + f32(characterInfos[i].vertex_TR.uv2.x / characterInfos[i].aspectRatio));
                characterInfos[i].vertex_BR.uv2.y = characterInfos[i].vertex_BL.uv2.y;
                characterInfos[i].vertex_TR.uv2.y = characterInfos[i].vertex_TL.uv2.y;
                break;
              }
            }
            // #endregion

            // #region Pack Scale into UV2（TMPro_UGUI_Private.cs:4068；TMPro_Private.cs:3940）
            // UGUI：xScale = scale * (1 - charWidthAdjDelta)，再依 Canvas renderMode 乘（4072–4083）
            // 3D：xScale = scale * |lossyScale| * (1 - charWidthAdjDelta)（TMPro_Private.cs:3941）
            if (this.ui) {
              xScale = f32(characterInfos[i].scale * f32(1 - this.m_charWidthAdjDelta));
              if (!characterInfos[i].isUsingAlternateTypeface && (characterInfos[i].style & FontStyles.Bold) === FontStyles.Bold) xScale = f32(xScale * -1);

              switch (canvasRenderMode) {
                case 0: // RenderMode.ScreenSpaceOverlay
                  xScale = f32(xScale * f32(Math.abs(lossyScale) / canvasScaleFactor));
                  break;
                case 1: // RenderMode.ScreenSpaceCamera
                  xScale = f32(xScale * (isCameraAssigned ? Math.abs(lossyScale) : 1));
                  break;
                case 2: // RenderMode.WorldSpace
                  xScale = f32(xScale * Math.abs(lossyScale));
                  break;
              }
            } else {
              xScale = f32(f32(characterInfos[i].scale * Math.abs(lossyScale)) * f32(1 - this.m_charWidthAdjDelta));
              if (!characterInfos[i].isUsingAlternateTypeface && (characterInfos[i].style & FontStyles.Bold) === FontStyles.Bold) xScale = f32(xScale * -1);
            }

            // Set SDF Scale
            characterInfos[i].vertex_BL.uv.w = xScale;
            characterInfos[i].vertex_TL.uv.w = xScale;
            characterInfos[i].vertex_TR.uv.w = xScale;
            characterInfos[i].vertex_BR.uv.w = xScale;
            // #endregion
            break;
          }

          // SPRITES
          case TmpTextElementType.Sprite:
            // Nothing right now
            break;
        }

        // 3D 版獨有（TMPro_Private.cs:3984）：linear 色彩空間時頂點色轉 linear（在 FillCharacterVertexBuffers 裡套用）
        if (!this.ui) {
          this.m_ConvertToLinearSpace = this.ctx?.linearColorSpace ?? false;
        }

        // #region Handle maxVisibleCharacters / maxVisibleLines / Page Mode（TMPro_UGUI_Private.cs:4100；TMPro_Private.cs:3959）
        if ((i < this.m_maxVisibleCharacters && wordCount < this.m_maxVisibleWords && currentLine < this.m_maxVisibleLines && this.m_overflowMode !== TextOverflowModes.Page) ||
            (i < this.m_maxVisibleCharacters && wordCount < this.m_maxVisibleWords && currentLine < this.m_maxVisibleLines && this.m_overflowMode === TextOverflowModes.Page && characterInfos[i].pageNumber === pageToDisplay)) {
          characterInfos[i].vertex_BL.position = { x: f32(characterInfos[i].vertex_BL.position.x + offset.x), y: f32(characterInfos[i].vertex_BL.position.y + offset.y), z: characterInfos[i].vertex_BL.position.z };
          characterInfos[i].vertex_TL.position = { x: f32(characterInfos[i].vertex_TL.position.x + offset.x), y: f32(characterInfos[i].vertex_TL.position.y + offset.y), z: characterInfos[i].vertex_TL.position.z };
          characterInfos[i].vertex_TR.position = { x: f32(characterInfos[i].vertex_TR.position.x + offset.x), y: f32(characterInfos[i].vertex_TR.position.y + offset.y), z: characterInfos[i].vertex_TR.position.z };
          characterInfos[i].vertex_BR.position = { x: f32(characterInfos[i].vertex_BR.position.x + offset.x), y: f32(characterInfos[i].vertex_BR.position.y + offset.y), z: characterInfos[i].vertex_BR.position.z };
        } else {
          characterInfos[i].vertex_BL.position = { x: 0, y: 0, z: 0 };
          characterInfos[i].vertex_TL.position = { x: 0, y: 0, z: 0 };
          characterInfos[i].vertex_TR.position = { x: 0, y: 0, z: 0 };
          characterInfos[i].vertex_BR.position = { x: 0, y: 0, z: 0 };
          characterInfos[i].isVisible = false;
        }
        // #endregion

        // Fill Vertex Buffers for the various types of element
        if (elementType === TmpTextElementType.Character) {
          this.fillCharacterVertexBuffers(i);
        } else if (elementType === TmpTextElementType.Sprite) {
          this.fillSpriteVertexBuffers(i);
        }
      }
      // #endregion

      // Apply Alignment and Justification Offset
      this.m_textInfo.characterInfo[i].bottomLeft = { x: f32(this.m_textInfo.characterInfo[i].bottomLeft.x + offset.x), y: f32(this.m_textInfo.characterInfo[i].bottomLeft.y + offset.y), z: this.m_textInfo.characterInfo[i].bottomLeft.z };
      this.m_textInfo.characterInfo[i].topLeft = { x: f32(this.m_textInfo.characterInfo[i].topLeft.x + offset.x), y: f32(this.m_textInfo.characterInfo[i].topLeft.y + offset.y), z: this.m_textInfo.characterInfo[i].topLeft.z };
      this.m_textInfo.characterInfo[i].topRight = { x: f32(this.m_textInfo.characterInfo[i].topRight.x + offset.x), y: f32(this.m_textInfo.characterInfo[i].topRight.y + offset.y), z: this.m_textInfo.characterInfo[i].topRight.z };
      this.m_textInfo.characterInfo[i].bottomRight = { x: f32(this.m_textInfo.characterInfo[i].bottomRight.x + offset.x), y: f32(this.m_textInfo.characterInfo[i].bottomRight.y + offset.y), z: this.m_textInfo.characterInfo[i].bottomRight.z };

      this.m_textInfo.characterInfo[i].origin = f32(this.m_textInfo.characterInfo[i].origin + offset.x);
      this.m_textInfo.characterInfo[i].xAdvance = f32(this.m_textInfo.characterInfo[i].xAdvance + offset.x);

      this.m_textInfo.characterInfo[i].ascender = f32(this.m_textInfo.characterInfo[i].ascender + offset.y);
      this.m_textInfo.characterInfo[i].descender = f32(this.m_textInfo.characterInfo[i].descender + offset.y);
      this.m_textInfo.characterInfo[i].baseLine = f32(this.m_textInfo.characterInfo[i].baseLine + offset.y);

      // Need to recompute lineExtent to account for the offset from justification.
      // #region Adjust lineExtents resulting from alignment offset（TMPro_UGUI_Private.cs:4159；TMPro_Private.cs:4022）
      if (currentLine !== lastLine || i === this.m_characterCount - 1) {
        // Update the previous line's extents
        if (currentLine !== lastLine) {
          this.m_textInfo.lineInfo[lastLine].baseline = f32(this.m_textInfo.lineInfo[lastLine].baseline + offset.y);
          this.m_textInfo.lineInfo[lastLine].ascender = f32(this.m_textInfo.lineInfo[lastLine].ascender + offset.y);
          this.m_textInfo.lineInfo[lastLine].descender = f32(this.m_textInfo.lineInfo[lastLine].descender + offset.y);

          this.m_textInfo.lineInfo[lastLine].maxAdvance = f32(this.m_textInfo.lineInfo[lastLine].maxAdvance + offset.x);

          this.m_textInfo.lineInfo[lastLine].lineExtents.min = { x: this.m_textInfo.characterInfo[this.m_textInfo.lineInfo[lastLine].firstCharacterIndex].bottomLeft.x, y: this.m_textInfo.lineInfo[lastLine].descender };
          this.m_textInfo.lineInfo[lastLine].lineExtents.max = { x: this.m_textInfo.characterInfo[this.m_textInfo.lineInfo[lastLine].lastVisibleCharacterIndex].topRight.x, y: this.m_textInfo.lineInfo[lastLine].ascender };
        }

        // Update the current line's extents
        if (i === this.m_characterCount - 1) {
          this.m_textInfo.lineInfo[currentLine].baseline = f32(this.m_textInfo.lineInfo[currentLine].baseline + offset.y);
          this.m_textInfo.lineInfo[currentLine].ascender = f32(this.m_textInfo.lineInfo[currentLine].ascender + offset.y);
          this.m_textInfo.lineInfo[currentLine].descender = f32(this.m_textInfo.lineInfo[currentLine].descender + offset.y);

          this.m_textInfo.lineInfo[currentLine].maxAdvance = f32(this.m_textInfo.lineInfo[currentLine].maxAdvance + offset.x);

          this.m_textInfo.lineInfo[currentLine].lineExtents.min = { x: this.m_textInfo.characterInfo[this.m_textInfo.lineInfo[currentLine].firstCharacterIndex].bottomLeft.x, y: this.m_textInfo.lineInfo[currentLine].descender };
          this.m_textInfo.lineInfo[currentLine].lineExtents.max = { x: this.m_textInfo.characterInfo[this.m_textInfo.lineInfo[currentLine].lastVisibleCharacterIndex].topRight.x, y: this.m_textInfo.lineInfo[currentLine].ascender };
        }
      }
      // #endregion

      // #region Track Word Count（TMPro_UGUI_Private.cs:4192；TMPro_Private.cs:4055）
      if (charIsLetterOrDigit(unicode) || unicode === 0x2d || unicode === 0xad || unicode === 0x2010 || unicode === 0x2011) {
        if (isStartOfWord === false) {
          isStartOfWord = true;
          wordFirstChar = i;
        }

        // If last character is a word
        if (isStartOfWord && i === this.m_characterCount - 1) {
          const size = this.m_textInfo.wordInfo.length;
          const index = this.m_textInfo.wordCount;

          if (this.m_textInfo.wordCount + 1 > size) TmpTextInfo.resizeWordInfo(this.m_textInfo.wordInfo, size + 1);

          wordLastChar = i;

          this.m_textInfo.wordInfo[index].firstCharacterIndex = wordFirstChar;
          this.m_textInfo.wordInfo[index].lastCharacterIndex = wordLastChar;
          this.m_textInfo.wordInfo[index].characterCount = wordLastChar - wordFirstChar + 1;

          wordCount += 1;
          this.m_textInfo.wordCount += 1;
          this.m_textInfo.lineInfo[currentLine].wordCount += 1;
        }
      } else if (isStartOfWord || (i === 0 && (!charIsPunctuation(unicode) || isWhiteSpace || unicode === 0x200b || i === this.m_characterCount - 1))) {
        if (i > 0 && i < characterInfos.length - 1 && i < this.m_characterCount && (unicode === 39 || unicode === 8217) && charIsLetterOrDigit(characterInfos[i - 1].character) && charIsLetterOrDigit(characterInfos[i + 1].character)) {
          // apostrophe 在兩個字母之間：不切字
        } else {
          wordLastChar = i === this.m_characterCount - 1 && charIsLetterOrDigit(unicode) ? i : i - 1;
          isStartOfWord = false;

          const size = this.m_textInfo.wordInfo.length;
          const index = this.m_textInfo.wordCount;

          if (this.m_textInfo.wordCount + 1 > size) TmpTextInfo.resizeWordInfo(this.m_textInfo.wordInfo, size + 1);

          this.m_textInfo.wordInfo[index].firstCharacterIndex = wordFirstChar;
          this.m_textInfo.wordInfo[index].lastCharacterIndex = wordLastChar;
          this.m_textInfo.wordInfo[index].characterCount = wordLastChar - wordFirstChar + 1;

          wordCount += 1;
          this.m_textInfo.wordCount += 1;
          this.m_textInfo.lineInfo[currentLine].wordCount += 1;
        }
      }
      // #endregion

      // #region Underline（TMPro_UGUI_Private.cs:4253；TMPro_Private.cs:4116）
      const isUnderline = (this.m_textInfo.characterInfo[i].style & FontStyles.Underline) === FontStyles.Underline;
      if (isUnderline) {
        let isUnderlineVisible = true;
        const currentPage = this.m_textInfo.characterInfo[i].pageNumber;
        this.m_textInfo.characterInfo[i].underlineVertexIndex = last_vert_index.v;

        if (i > this.m_maxVisibleCharacters || currentLine > this.m_maxVisibleLines || (this.m_overflowMode === TextOverflowModes.Page && currentPage + 1 !== this.m_pageToDisplay)) isUnderlineVisible = false;

        // We only use the scale of visible characters.
        if (!isWhiteSpace && unicode !== 0x200b) {
          underlineMaxScale = Math.max(underlineMaxScale, this.m_textInfo.characterInfo[i].scale);
          xScaleMax = Math.max(xScaleMax, Math.abs(xScale));
          underlineBaseLine = Math.min(currentPage === lastPage ? underlineBaseLine : k_LargePositiveFloat, f32(this.m_textInfo.characterInfo[i].baseLine + f32(this.m_fontAsset!.faceInfo.underlineOffset * underlineMaxScale)));
          lastPage = currentPage; // Need to track pages to ensure we reset baseline for the new pages.
        }

        if (beginUnderline === false && isUnderlineVisible === true && i <= lineInfo.lastVisibleCharacterIndex && unicode !== 10 && unicode !== 11 && unicode !== 13) {
          if (i === lineInfo.lastVisibleCharacterIndex && charIsSeparator(unicode)) {
            // 空白結尾：不開始底線
          } else {
            beginUnderline = true;
            underlineStartScale = this.m_textInfo.characterInfo[i].scale;
            if (underlineMaxScale === 0) {
              underlineMaxScale = underlineStartScale;
              xScaleMax = xScale;
            }
            underline_start = { x: this.m_textInfo.characterInfo[i].bottomLeft.x, y: underlineBaseLine, z: 0 };
            underlineColor = { ...this.m_textInfo.characterInfo[i].underlineColor };
          }
        }

        // End Underline if text only contains one character.
        if (beginUnderline && this.m_characterCount === 1) {
          beginUnderline = false;
          underline_end = { x: this.m_textInfo.characterInfo[i].topRight.x, y: underlineBaseLine, z: 0 };
          underlineEndScale = this.m_textInfo.characterInfo[i].scale;

          this.drawUnderlineMesh(underline_start, underline_end, last_vert_index, underlineStartScale, underlineEndScale, underlineMaxScale, xScaleMax, underlineColor);
          underlineMaxScale = 0;
          xScaleMax = 0;
          underlineBaseLine = k_LargePositiveFloat;
        } else if (beginUnderline && (i === lineInfo.lastCharacterIndex || i >= lineInfo.lastVisibleCharacterIndex)) {
          // Terminate underline at previous visible character if space or carriage return.
          if (isWhiteSpace || unicode === 0x200b) {
            const lastVisibleCharacterIndex = lineInfo.lastVisibleCharacterIndex;
            underline_end = { x: this.m_textInfo.characterInfo[lastVisibleCharacterIndex].topRight.x, y: underlineBaseLine, z: 0 };
            underlineEndScale = this.m_textInfo.characterInfo[lastVisibleCharacterIndex].scale;
          } else {
            // End underline if last character of the line.
            underline_end = { x: this.m_textInfo.characterInfo[i].topRight.x, y: underlineBaseLine, z: 0 };
            underlineEndScale = this.m_textInfo.characterInfo[i].scale;
          }

          beginUnderline = false;
          this.drawUnderlineMesh(underline_start, underline_end, last_vert_index, underlineStartScale, underlineEndScale, underlineMaxScale, xScaleMax, underlineColor);
          underlineMaxScale = 0;
          xScaleMax = 0;
          underlineBaseLine = k_LargePositiveFloat;
        } else if (beginUnderline && !isUnderlineVisible) {
          beginUnderline = false;
          underline_end = { x: this.m_textInfo.characterInfo[i - 1].topRight.x, y: underlineBaseLine, z: 0 };
          underlineEndScale = this.m_textInfo.characterInfo[i - 1].scale;

          this.drawUnderlineMesh(underline_start, underline_end, last_vert_index, underlineStartScale, underlineEndScale, underlineMaxScale, xScaleMax, underlineColor);
          underlineMaxScale = 0;
          xScaleMax = 0;
          underlineBaseLine = k_LargePositiveFloat;
        } else if (beginUnderline && i < this.m_characterCount - 1 && !color32Compare(underlineColor, this.m_textInfo.characterInfo[i + 1].underlineColor)) {
          // End underline if underline color has changed.
          beginUnderline = false;
          underline_end = { x: this.m_textInfo.characterInfo[i].topRight.x, y: underlineBaseLine, z: 0 };
          underlineEndScale = this.m_textInfo.characterInfo[i].scale;

          this.drawUnderlineMesh(underline_start, underline_end, last_vert_index, underlineStartScale, underlineEndScale, underlineMaxScale, xScaleMax, underlineColor);
          underlineMaxScale = 0;
          xScaleMax = 0;
          underlineBaseLine = k_LargePositiveFloat;
        }
      } else {
        // End Underline
        if (beginUnderline === true) {
          beginUnderline = false;
          underline_end = { x: this.m_textInfo.characterInfo[i - 1].topRight.x, y: underlineBaseLine, z: 0 };
          underlineEndScale = this.m_textInfo.characterInfo[i - 1].scale;

          this.drawUnderlineMesh(underline_start, underline_end, last_vert_index, underlineStartScale, underlineEndScale, underlineMaxScale, xScaleMax, underlineColor);
          underlineMaxScale = 0;
          xScaleMax = 0;
          underlineBaseLine = k_LargePositiveFloat;
        }
      }
      // #endregion

      // #region Strikethrough（TMPro_UGUI_Private.cs:4368；TMPro_Private.cs:4231）
      const isStrikethrough = (this.m_textInfo.characterInfo[i].style & FontStyles.Strikethrough) === FontStyles.Strikethrough;
      const strikethroughOffset = currentFontAsset.faceInfo.strikethroughOffset;

      if (isStrikethrough) {
        let isStrikeThroughVisible = true;
        this.m_textInfo.characterInfo[i].strikethroughVertexIndex = last_vert_index.v;

        if (i > this.m_maxVisibleCharacters || currentLine > this.m_maxVisibleLines || (this.m_overflowMode === TextOverflowModes.Page && this.m_textInfo.characterInfo[i].pageNumber + 1 !== this.m_pageToDisplay)) isStrikeThroughVisible = false;

        if (beginStrikethrough === false && isStrikeThroughVisible && i <= lineInfo.lastVisibleCharacterIndex && unicode !== 10 && unicode !== 11 && unicode !== 13) {
          if (i === lineInfo.lastVisibleCharacterIndex && charIsSeparator(unicode)) {
            // 空白結尾：不開始刪除線
          } else {
            beginStrikethrough = true;
            strikethroughPointSize = this.m_textInfo.characterInfo[i].pointSize;
            strikethroughScale = this.m_textInfo.characterInfo[i].scale;
            strikethrough_start = { x: this.m_textInfo.characterInfo[i].bottomLeft.x, y: f32(this.m_textInfo.characterInfo[i].baseLine + f32(strikethroughOffset * strikethroughScale)), z: 0 };
            strikethroughColor = { ...this.m_textInfo.characterInfo[i].strikethroughColor };
            strikethroughBaseline = this.m_textInfo.characterInfo[i].baseLine;
          }
        }

        // End Strikethrough if text only contains one character.
        if (beginStrikethrough && this.m_characterCount === 1) {
          beginStrikethrough = false;
          strikethrough_end = { x: this.m_textInfo.characterInfo[i].topRight.x, y: f32(this.m_textInfo.characterInfo[i].baseLine + f32(strikethroughOffset * strikethroughScale)), z: 0 };

          this.drawUnderlineMesh(strikethrough_start, strikethrough_end, last_vert_index, strikethroughScale, strikethroughScale, strikethroughScale, xScale, strikethroughColor);
        } else if (beginStrikethrough && i === lineInfo.lastCharacterIndex) {
          // Terminate Strikethrough at previous visible character if space or carriage return.
          if (isWhiteSpace || unicode === 0x200b) {
            const lastVisibleCharacterIndex = lineInfo.lastVisibleCharacterIndex;
            strikethrough_end = { x: this.m_textInfo.characterInfo[lastVisibleCharacterIndex].topRight.x, y: f32(this.m_textInfo.characterInfo[lastVisibleCharacterIndex].baseLine + f32(strikethroughOffset * strikethroughScale)), z: 0 };
          } else {
            // Terminate Strikethrough at last character of line.
            strikethrough_end = { x: this.m_textInfo.characterInfo[i].topRight.x, y: f32(this.m_textInfo.characterInfo[i].baseLine + f32(strikethroughOffset * strikethroughScale)), z: 0 };
          }

          beginStrikethrough = false;
          this.drawUnderlineMesh(strikethrough_start, strikethrough_end, last_vert_index, strikethroughScale, strikethroughScale, strikethroughScale, xScale, strikethroughColor);
        } else if (beginStrikethrough && i < this.m_characterCount && (this.m_textInfo.characterInfo[i + 1].pointSize !== strikethroughPointSize || !tmpApproximately(f32(this.m_textInfo.characterInfo[i + 1].baseLine + offset.y), strikethroughBaseline))) {
          // Terminate Strikethrough if scale changes.
          beginStrikethrough = false;

          const lastVisibleCharacterIndex = lineInfo.lastVisibleCharacterIndex;
          if (i > lastVisibleCharacterIndex)
            strikethrough_end = { x: this.m_textInfo.characterInfo[lastVisibleCharacterIndex].topRight.x, y: f32(this.m_textInfo.characterInfo[lastVisibleCharacterIndex].baseLine + f32(strikethroughOffset * strikethroughScale)), z: 0 };
          else strikethrough_end = { x: this.m_textInfo.characterInfo[i].topRight.x, y: f32(this.m_textInfo.characterInfo[i].baseLine + f32(strikethroughOffset * strikethroughScale)), z: 0 };

          this.drawUnderlineMesh(strikethrough_start, strikethrough_end, last_vert_index, strikethroughScale, strikethroughScale, strikethroughScale, xScale, strikethroughColor);
        } else if (beginStrikethrough && i < this.m_characterCount && currentFontAsset.id !== characterInfos[i + 1].fontAsset?.id) {
          // Terminate Strikethrough if font asset changes.
          beginStrikethrough = false;
          strikethrough_end = { x: this.m_textInfo.characterInfo[i].topRight.x, y: f32(this.m_textInfo.characterInfo[i].baseLine + f32(strikethroughOffset * strikethroughScale)), z: 0 };

          this.drawUnderlineMesh(strikethrough_start, strikethrough_end, last_vert_index, strikethroughScale, strikethroughScale, strikethroughScale, xScale, strikethroughColor);
        } else if (beginStrikethrough && !isStrikeThroughVisible) {
          // Terminate Strikethrough if character is not visible.
          beginStrikethrough = false;
          strikethrough_end = { x: this.m_textInfo.characterInfo[i - 1].topRight.x, y: f32(this.m_textInfo.characterInfo[i - 1].baseLine + f32(strikethroughOffset * strikethroughScale)), z: 0 };

          this.drawUnderlineMesh(strikethrough_start, strikethrough_end, last_vert_index, strikethroughScale, strikethroughScale, strikethroughScale, xScale, strikethroughColor);
        }
      } else {
        // End Strikethrough
        if (beginStrikethrough === true) {
          beginStrikethrough = false;
          strikethrough_end = { x: this.m_textInfo.characterInfo[i - 1].topRight.x, y: f32(this.m_textInfo.characterInfo[i - 1].baseLine + f32(strikethroughOffset * strikethroughScale)), z: 0 };

          this.drawUnderlineMesh(strikethrough_start, strikethrough_end, last_vert_index, strikethroughScale, strikethroughScale, strikethroughScale, xScale, strikethroughColor);
        }
      }
      // #endregion

      // #region Text Highlighting（TMPro_UGUI_Private.cs:4468；TMPro_Private.cs:4331）
      const isHighlight = (this.m_textInfo.characterInfo[i].style & FontStyles.Highlight) === FontStyles.Highlight;
      if (isHighlight) {
        let isHighlightVisible = true;
        const currentPage = this.m_textInfo.characterInfo[i].pageNumber;

        if (i > this.m_maxVisibleCharacters || currentLine > this.m_maxVisibleLines || (this.m_overflowMode === TextOverflowModes.Page && currentPage + 1 !== this.m_pageToDisplay)) isHighlightVisible = false;

        if (beginHighlight === false && isHighlightVisible === true && i <= lineInfo.lastVisibleCharacterIndex && unicode !== 10 && unicode !== 11 && unicode !== 13) {
          if (i === lineInfo.lastVisibleCharacterIndex && charIsSeparator(unicode)) {
            // 空白結尾：不開始 highlight
          } else {
            beginHighlight = true;
            highlight_start = { ...k_LargePositiveVector2 };
            highlight_end = { ...k_LargeNegativeVector2 };
            highlightStateCur = this.m_textInfo.characterInfo[i].highlightState;
          }
        }

        if (beginHighlight) {
          const currentCharacter = this.m_textInfo.characterInfo[i];
          const currentState = currentCharacter.highlightState;

          let isColorTransition = false;

          // Handle Highlight color changes
          if (!highlightStateEqual(highlightStateCur, currentState)) {
            // Adjust previous highlight section to prevent a gaps between sections.
            if (isWhiteSpace) highlight_end.x = f32(f32(highlight_end.x - highlightStateCur.padding.right + currentCharacter.origin) / 2);
            else highlight_end.x = f32(f32(highlight_end.x - highlightStateCur.padding.right + currentCharacter.bottomLeft.x) / 2);

            highlight_start.y = Math.min(highlight_start.y, currentCharacter.descender);
            highlight_end.y = Math.max(highlight_end.y, currentCharacter.ascender);

            this.drawTextHighlight({ x: highlight_start.x, y: highlight_start.y, z: 0 }, { x: highlight_end.x, y: highlight_end.y, z: 0 }, last_vert_index, highlightStateCur.color);

            beginHighlight = true;
            highlight_start = { x: highlight_end.x, y: f32(currentCharacter.descender - currentState.padding.bottom) };

            if (isWhiteSpace) highlight_end = { x: f32(currentCharacter.xAdvance + currentState.padding.right), y: f32(currentCharacter.ascender + currentState.padding.top) };
            else highlight_end = { x: f32(currentCharacter.topRight.x + currentState.padding.right), y: f32(currentCharacter.ascender + currentState.padding.top) };

            highlightStateCur = currentState;

            isColorTransition = true;
          }

          if (!isColorTransition) {
            if (isWhiteSpace) {
              // Use the Min / Max of glyph metrics if white space.
              highlight_start.x = Math.min(highlight_start.x, f32(currentCharacter.origin - highlightStateCur.padding.left));
              highlight_end.x = Math.max(highlight_end.x, f32(currentCharacter.xAdvance + highlightStateCur.padding.right));
            } else {
              // Use the Min / Max of character bounds
              highlight_start.x = Math.min(highlight_start.x, f32(currentCharacter.bottomLeft.x - highlightStateCur.padding.left));
              highlight_end.x = Math.max(highlight_end.x, f32(currentCharacter.topRight.x + highlightStateCur.padding.right));
            }

            highlight_start.y = Math.min(highlight_start.y, f32(currentCharacter.descender - highlightStateCur.padding.bottom));
            highlight_end.y = Math.max(highlight_end.y, f32(currentCharacter.ascender + highlightStateCur.padding.top));
          }
        }

        // End Highlight if text only contains one character.
        if (beginHighlight && this.m_characterCount === 1) {
          beginHighlight = false;

          this.drawTextHighlight({ x: highlight_start.x, y: highlight_start.y, z: 0 }, { x: highlight_end.x, y: highlight_end.y, z: 0 }, last_vert_index, highlightStateCur.color);
        } else if (beginHighlight && (i === lineInfo.lastCharacterIndex || i >= lineInfo.lastVisibleCharacterIndex)) {
          beginHighlight = false;
          this.drawTextHighlight({ x: highlight_start.x, y: highlight_start.y, z: 0 }, { x: highlight_end.x, y: highlight_end.y, z: 0 }, last_vert_index, highlightStateCur.color);
        } else if (beginHighlight && !isHighlightVisible) {
          beginHighlight = false;
          this.drawTextHighlight({ x: highlight_start.x, y: highlight_start.y, z: 0 }, { x: highlight_end.x, y: highlight_end.y, z: 0 }, last_vert_index, highlightStateCur.color);
        }
      } else {
        // End Highlight
        if (beginHighlight === true) {
          beginHighlight = false;
          this.drawTextHighlight({ x: highlight_start.x, y: highlight_start.y, z: 0 }, { x: highlight_end.x, y: highlight_end.y, z: 0 }, last_vert_index, highlightStateCur.color);
        }
      }
      // #endregion

      lastLine = currentLine;
    }
    // #endregion

    // METRICS ABOUT THE TEXT OBJECT
    this.m_textInfo.characterCount = this.m_characterCount;
    this.m_textInfo.spriteCount = this.m_spriteCount;
    this.m_textInfo.lineCount = lineCount;
    this.m_textInfo.wordCount = wordCount !== 0 && this.m_characterCount > 0 ? wordCount : 1;
    this.m_textInfo.pageCount = this.m_pageNumber + 1;

    // Phase III（UGUI 4594–4657／3D 4434–4479）：mesh 上傳與子物件，移植版由輸出端處理
    for (let i = 1; i < this.m_textInfo.materialCount; i++) {
      // Clear unused vertices
      this.m_textInfo.meshInfo[i].clearUnusedVertices();
    }

    this.m_lastVertIndex = last_vert_index.v;
  }

  /** ClearMesh：UGUI 版沒有參數（TMPro_UGUI_Private.cs:1770 呼叫點）；3D 版 ClearMesh(true)（TMPro_Private.cs:1646 呼叫點）。移植版只需要把網格清成空。 */
  clearMesh(): void {
    for (const m of this.m_textInfo.meshInfo) m.clear();
  }

  /** 底線／highlight 結束時的頂點寫入位置（GenerateTextMesh 的 last_vert_index） */
  m_lastVertIndex = 0;

  m_ElementAscender = 0;
  m_lineJustification: HorizontalAlignmentOptions = HorizontalAlignmentOptions.Left;

  // ════════════════════════ 偏好尺寸（TMP_Text.cs:3554–4779） ════════════════════════

  /** GetPreferredValues(width, height)（TMP_Text.cs:3554） */
  getPreferredValuesWH(width: number, height: number): { x: number; y: number } {
    // Reparse input text
    this.m_isCalculatingPreferredValues = true;
    this.parseInputText();

    const margin = { x: width, y: height };

    // CALCULATE PREFERRED WIDTH
    const preferredWidth = this.getPreferredWidthMargin(margin);

    // CALCULATE PREFERRED HEIGHT
    const preferredHeight = this.getPreferredHeightMargin(margin);

    return { x: preferredWidth, y: preferredHeight };
  }

  /** GetPreferredWidth()（TMP_Text.cs:3624）：preferredWidth property 的內容 */
  getPreferredWidthMain(): number {
    let fontSize = this.m_enableAutoSizing ? this.m_fontSizeMax : this.m_fontSize;

    // Reset auto sizing point size bounds
    this.m_minFontSize = this.m_fontSizeMin;
    this.m_maxFontSize = this.m_fontSizeMax;
    this.m_charWidthAdjDelta = 0;

    // Set Margins to Infinity
    const margin = { ...k_LargePositiveVector2 };

    this.m_isCalculatingPreferredValues = true;
    this.parseInputText();

    this.m_AutoSizeIterationCount = 0;
    const wrapMode = this.m_TextWrappingMode === TextWrappingModes.Normal || this.m_TextWrappingMode === TextWrappingModes.NoWrap ? TextWrappingModes.NoWrap : TextWrappingModes.PreserveWhitespaceNoWrap;
    const fs = { v: fontSize };
    const preferredWidth = this.calculatePreferredValues(fs, margin, false, wrapMode).x;
    fontSize = fs.v;

    this.m_preferredWidth = preferredWidth;

    return preferredWidth;
  }

  /** GetPreferredWidth(Vector2 margin)（TMP_Text.cs:3657） */
  private getPreferredWidthMargin(margin: { x: number; y: number }): number {
    const fontSize = this.m_enableAutoSizing ? this.m_fontSizeMax : this.m_fontSize;

    // Reset auto sizing point size bounds
    this.m_minFontSize = this.m_fontSizeMin;
    this.m_maxFontSize = this.m_fontSizeMax;
    this.m_charWidthAdjDelta = 0;

    this.m_AutoSizeIterationCount = 0;
    const wrapMode = this.m_TextWrappingMode === TextWrappingModes.Normal || this.m_TextWrappingMode === TextWrappingModes.NoWrap ? TextWrappingModes.NoWrap : TextWrappingModes.PreserveWhitespaceNoWrap;
    const fs = { v: fontSize };
    const preferredWidth = this.calculatePreferredValues(fs, margin, false, wrapMode).x;

    return preferredWidth;
  }

  /** GetPreferredHeight()（TMP_Text.cs:3698）：preferredHeight property 的內容 */
  getPreferredHeightMain(): number {
    const fontSizeInit = this.m_enableAutoSizing ? this.m_fontSizeMax : this.m_fontSize;

    // Reset auto sizing point size bounds
    this.m_minFontSize = this.m_fontSizeMin;
    this.m_maxFontSize = this.m_fontSizeMax;
    this.m_charWidthAdjDelta = 0;

    const margin = { x: this.m_marginWidth !== 0 ? this.m_marginWidth : TMP_MATH.FLOAT_MAX, y: TMP_MATH.FLOAT_MAX };

    this.m_isCalculatingPreferredValues = true;
    this.parseInputText();

    // Reset Text Auto Size iteration tracking.
    this.m_IsAutoSizePointSizeSet = false;
    this.m_AutoSizeIterationCount = 0;

    // The CalculatePreferredValues function is potentially called repeatedly when text auto size is enabled.
    let preferredHeight = 0;

    while (this.m_IsAutoSizePointSizeSet === false) {
      const fs = { v: fontSizeInit };
      preferredHeight = this.calculatePreferredValues(fs, margin, this.m_enableAutoSizing, this.m_TextWrappingMode).y;
      this.m_AutoSizeIterationCount += 1;
    }

    this.m_preferredHeight = preferredHeight;

    return preferredHeight;
  }

  /** GetPreferredHeight(Vector2 margin)（TMP_Text.cs:3745） */
  private getPreferredHeightMargin(margin: { x: number; y: number }): number {
    const fontSizeInit = this.m_enableAutoSizing ? this.m_fontSizeMax : this.m_fontSize;

    // Reset auto sizing point size bounds
    this.m_minFontSize = this.m_fontSizeMin;
    this.m_maxFontSize = this.m_fontSizeMax;
    this.m_charWidthAdjDelta = 0;

    // Reset Text Auto Size iteration tracking.
    this.m_IsAutoSizePointSizeSet = false;
    this.m_AutoSizeIterationCount = 0;

    let preferredHeight = 0;

    while (this.m_IsAutoSizePointSizeSet === false) {
      const fs = { v: fontSizeInit };
      preferredHeight = this.calculatePreferredValues(fs, margin, this.m_enableAutoSizing, this.m_TextWrappingMode).y;
      this.m_AutoSizeIterationCount += 1;
    }

    return preferredHeight;
  }

  /** CalculatePreferredValues（TMP_Text.cs:3835–4779）。fontSize 用 holder 模擬 ref。回傳 Vector2。 */
  calculatePreferredValues(fontSize: { v: number }, marginSize: { x: number; y: number }, isTextAutoSizingEnabled: boolean, textWrapMode: TextWrappingModes): { x: number; y: number } {
    // Early exit if no font asset was assigned.
    if (this.m_fontAsset == null) {
      this.m_IsAutoSizePointSizeSet = true;
      return { x: 0, y: 0 };
    }

    // Early exit if we don't have any Text to generate.
    if (this.m_TextProcessingArray == null || this.m_TextProcessingArray.length === 0 || this.m_TextProcessingArray[0].unicode === 0) {
      this.m_IsAutoSizePointSizeSet = true;
      return { x: 0, y: 0 };
    }

    this.m_currentFontAsset = this.m_fontAsset;
    this.m_currentMaterial = this.m_sharedMaterial!;
    this.m_currentMaterialIndex = 0;
    this.m_materialReferenceStack.setDefault(new MaterialReference(0, this.m_currentFontAsset, null, this.m_currentMaterial, this.m_padding));

    // Total character count is computed when the text is parsed.
    const totalCharacterCount = this.m_totalCharacterCount;

    if (this.m_internalCharacterInfo == null || totalCharacterCount > this.m_internalCharacterInfo.length) {
      const newSize = totalCharacterCount > 1024 ? totalCharacterCount + 256 : nextPowerOfTwo(totalCharacterCount);
      this.m_internalCharacterInfo = [];
      for (let k = 0; k < newSize; k++) this.m_internalCharacterInfo.push(new TmpCharacterInfo());
    }

    // Calculate the scale of the font based on selected font size and sampling point size.
    // baseScale is calculated using the font asset assigned to the text object.
    const baseScale = f32(f32(f32(fontSize.v / this.m_fontAsset.faceInfo.pointSize) * this.m_fontAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));
    let currentElementScale = baseScale;
    const currentEmScale = f32(f32(fontSize.v * 0.01) * (this.m_isOrthographic ? 1 : 0.1));
    this.m_fontScaleMultiplier = 1;

    this.m_currentFontSize = fontSize.v;
    this.m_sizeStack.setDefault(this.m_currentFontSize);
    let fontSizeDelta = 0;

    this.m_FontStyleInternal = this.m_fontStyle; // Set the default style.

    this.m_lineJustification = this.m_HorizontalAlignment;
    this.m_lineJustificationStack.setDefault(this.m_lineJustification);

    this.m_baselineOffset = 0; // Used by subscript characters.
    this.m_baselineOffsetStack.clear();

    this.m_FXScale = { x: 1, y: 1, z: 1 };

    this.m_lineOffset = 0; // Amount of space between lines (font line spacing + m_linespacing).
    this.m_lineHeight = TMP_MATH.FLOAT_UNSET;
    const lineGap = f32(this.m_currentFontAsset.faceInfo.lineHeight - f32(this.m_currentFontAsset.faceInfo.ascentLine - this.m_currentFontAsset.faceInfo.descentLine));

    this.m_cSpacing = 0; // Amount of space added between characters as a result of the use of the <cspace> tag.
    this.m_monoSpacing = 0;
    this.m_xAdvance = 0; // Used to track the position of each character.

    this.tag_LineIndent = 0; // Used for indentation of text.
    this.tag_Indent = 0;
    this.m_indentStack.setDefault(0);
    this.tag_NoParsing = false;

    this.m_characterCount = 0; // Total characters in the char[]

    // Tracking of line information
    this.m_firstCharacterOfLine = 0;
    this.m_maxLineAscender = k_LargeNegativeFloat;
    this.m_maxLineDescender = k_LargePositiveFloat;
    this.m_lineNumber = 0;
    this.m_startOfLineAscender = 0;
    this.m_IsDrivenLineSpacing = false;
    this.m_LastBaseGlyphIndex = -2147483648;

    const marginWidth = marginSize.x;

    this.m_marginLeft = 0;
    this.m_marginRight = 0;

    this.m_width = -1;
    let widthOfTextArea = f32(f32(f32(marginWidth + 0.0001) - this.m_marginLeft) - this.m_marginRight);

    // Used by Unity's Auto Layout system.
    this.m_RenderedWidth = 0;
    this.m_RenderedHeight = 0;

    this.m_isCalculatingPreferredValues = true;

    // Tracking of the highest Ascender
    this.m_maxCapHeight = 0;
    this.m_maxTextAscender = 0;
    this.m_ElementDescender = 0;

    // Initialize struct to track states of word wrapping
    let isFirstWordOfLine = true;
    this.m_isNonBreakingSpace = false;
    let ignoreNonBreakingSpace = false;

    const characterToSubstitute: CharacterSubstitution = { index: -1, unicode: 0 };
    let isSoftHyphenIgnored = false;

    const internalWordWrapState = new WordWrapState();
    const internalLineState = new WordWrapState();
    const internalSoftLineBreak = new WordWrapState();

    // Counter to prevent recursive lockup when computing preferred values.
    this.m_AutoSizeIterationCount += 1;

    // Parse through Character buffer to read HTML tags and begin creating mesh.
    for (let i = 0; i < this.m_TextProcessingArray.length && this.m_TextProcessingArray[i].unicode !== 0; i++) {
      let charCode = this.m_TextProcessingArray[i].unicode;

      // Skip characters that have been substituted.
      if (charCode === 0x1a) continue;

      // #region Parse Rich Text Tag（TMP_Text.cs:3959）
      if (this.m_isRichText && charCode === 60) {
        // '<'
        this.m_isTextLayoutPhase = true;
        this.m_textElementType = TmpTextElementType.Character;

        // Check if Tag is valid. If valid, skip to the end of the validated tag.
        const tagResult = this.validateHtmlTag(this.m_TextProcessingArray, i + 1);
        if (tagResult.valid) {
          i = tagResult.endIndex;

          // Continue to next character or handle the sprite element
          if (this.m_textElementType === TmpTextElementType.Character) continue;
        }
      } else {
        this.m_textElementType = this.m_textInfo.characterInfo[this.m_characterCount].elementType;
        this.m_currentMaterialIndex = this.m_textInfo.characterInfo[this.m_characterCount].materialReferenceIndex;
        this.m_currentFontAsset = this.m_textInfo.characterInfo[this.m_characterCount].fontAsset!;
      }
      // #endregion End Parse Rich Text Tag

      const prev_MaterialIndex = this.m_currentMaterialIndex;
      const isUsingAltTypeface = this.m_textInfo.characterInfo[this.m_characterCount].isUsingAlternateTypeface;

      this.m_isTextLayoutPhase = false;

      // #region Character Substitutions（TMP_Text.cs:3990）
      let isInjectedCharacter = false;

      if (characterToSubstitute.index === this.m_characterCount) {
        charCode = characterToSubstitute.unicode;
        this.m_textElementType = TmpTextElementType.Character;
        isInjectedCharacter = true;

        switch (charCode) {
          case 0x03:
            this.m_internalCharacterInfo[this.m_characterCount].textElement = this.m_currentFontAsset.characterLookupTable.get(0x03) ?? null;
            this.m_isTextTruncated = true;
            break;
          case 0x2d:
            break;
          case 0x2026:
            this.m_internalCharacterInfo[this.m_characterCount].textElement = this.m_Ellipsis.character;
            this.m_internalCharacterInfo[this.m_characterCount].elementType = TmpTextElementType.Character;
            this.m_internalCharacterInfo[this.m_characterCount].fontAsset = this.m_Ellipsis.fontAsset;
            this.m_internalCharacterInfo[this.m_characterCount].material = this.m_Ellipsis.material;
            this.m_internalCharacterInfo[this.m_characterCount].materialReferenceIndex = this.m_Ellipsis.materialIndex;

            // Indicates the source parsing data has been modified.
            this.m_isTextTruncated = true;

            // End Of Text
            characterToSubstitute.index = this.m_characterCount + 1;
            characterToSubstitute.unicode = 0x03;
            break;
        }
      }
      // #endregion

      // #region Linked Text（TMP_Text.cs:4028）
      if (this.m_characterCount < this.m_firstVisibleCharacter && charCode !== 0x03) {
        this.m_internalCharacterInfo[this.m_characterCount].isVisible = false;
        this.m_internalCharacterInfo[this.m_characterCount].character = 0x200b;
        this.m_internalCharacterInfo[this.m_characterCount].lineNumber = 0;
        this.m_characterCount += 1;
        continue;
      }
      // #endregion

      // #region Handling of LowerCase, UpperCase and SmallCaps Font Styles（TMP_Text.cs:4041）
      let smallCapsMultiplier = 1.0;

      if (this.m_textElementType === TmpTextElementType.Character) {
        if ((this.m_FontStyleInternal & FontStyles.UpperCase) === FontStyles.UpperCase) {
          // If this character is lowercase, switch to uppercase.
          if (charIsLower(charCode)) charCode = charToUpper(charCode);
        } else if ((this.m_FontStyleInternal & FontStyles.LowerCase) === FontStyles.LowerCase) {
          // If this character is uppercase, switch to lowercase.
          if (charIsUpper(charCode)) charCode = charToLower(charCode);
        } else if ((this.m_FontStyleInternal & FontStyles.SmallCaps) === FontStyles.SmallCaps) {
          if (charIsLower(charCode)) {
            smallCapsMultiplier = 0.8;
            charCode = charToUpper(charCode);
          }
        }
      }
      // #endregion

      // #region Look up Character Data（TMP_Text.cs:4073）
      const baselineOffset = 0;
      let elementAscentLine = 0;
      let elementDescentLine = 0;
      if (this.m_textElementType === TmpTextElementType.Sprite) {
        // If a sprite is used as a fallback then get a reference to it and set the color to white.
        this.m_currentSpriteAsset = this.m_textInfo.characterInfo[this.m_characterCount].textElement!.textAsset as SpriteAssetData;
        this.m_spriteIndex = this.m_textInfo.characterInfo[this.m_characterCount].textElement!.glyphIndex;

        const sprite = this.m_currentSpriteAsset.spriteCharacterTable[this.m_spriteIndex];
        if (sprite == null) continue;

        // Sprites are assigned in the E000 Private Area + sprite Index
        if (charCode === 60) charCode = 57344 + this.m_spriteIndex;

        // The sprite scale calculations are based on the font asset assigned to the text object.
        if (this.m_currentSpriteAsset.faceInfo.pointSize > 0) {
          const spriteScale = f32(f32(f32(this.m_currentFontSize / this.m_currentSpriteAsset.faceInfo.pointSize) * this.m_currentSpriteAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));
          currentElementScale = f32(f32(sprite.scale * sprite.glyph.scale) * spriteScale);
          elementAscentLine = this.m_currentSpriteAsset.faceInfo.ascentLine;
          elementDescentLine = this.m_currentSpriteAsset.faceInfo.descentLine;
        } else {
          const spriteScale = f32(f32(f32(this.m_currentFontSize / this.m_currentFontAsset.faceInfo.pointSize) * this.m_currentFontAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));
          currentElementScale = f32(f32(f32(this.m_currentFontAsset.faceInfo.ascentLine / sprite.glyph.metrics.height) * sprite.scale) * f32(sprite.glyph.scale * spriteScale));
          const scaleDelta = f32(spriteScale / currentElementScale);
          elementAscentLine = f32(this.m_currentFontAsset.faceInfo.ascentLine * scaleDelta);
          elementDescentLine = f32(this.m_currentFontAsset.faceInfo.descentLine * scaleDelta);
        }

        this.m_cached_TextElement = sprite;

        this.m_internalCharacterInfo[this.m_characterCount].elementType = TmpTextElementType.Sprite;
        this.m_internalCharacterInfo[this.m_characterCount].scale = currentElementScale;

        this.m_currentMaterialIndex = prev_MaterialIndex;
      } else if (this.m_textElementType === TmpTextElementType.Character) {
        this.m_cached_TextElement = this.m_textInfo.characterInfo[this.m_characterCount].textElement;
        if (this.m_cached_TextElement == null) continue;

        this.m_currentMaterialIndex = this.m_textInfo.characterInfo[this.m_characterCount].materialReferenceIndex;

        let adjustedScale: number;
        if (isInjectedCharacter && this.m_TextProcessingArray[i].unicode === 0x0a && this.m_characterCount !== this.m_firstCharacterOfLine)
          adjustedScale = f32(f32(f32(f32(this.m_textInfo.characterInfo[this.m_characterCount - 1].pointSize * smallCapsMultiplier) / this.m_currentFontAsset.faceInfo.pointSize) * this.m_currentFontAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));
        else adjustedScale = f32(f32(f32(f32(this.m_currentFontSize * smallCapsMultiplier) / this.m_currentFontAsset.faceInfo.pointSize) * this.m_currentFontAsset.faceInfo.scale) * (this.m_isOrthographic ? 1 : 0.1));

        // Special handling for injected Ellipsis
        if (isInjectedCharacter && charCode === 0x2026) {
          elementAscentLine = 0;
          elementDescentLine = 0;
        } else {
          elementAscentLine = this.m_currentFontAsset.faceInfo.ascentLine;
          elementDescentLine = this.m_currentFontAsset.faceInfo.descentLine;
        }

        currentElementScale = f32(f32(adjustedScale * this.m_fontScaleMultiplier) * this.m_cached_TextElement.scale);

        this.m_internalCharacterInfo[this.m_characterCount].elementType = TmpTextElementType.Character;
      }
      // #endregion

      // #region Handle Soft Hyphen（TMP_Text.cs:4149）
      const currentElementUnmodifiedScale = currentElementScale;
      if (charCode === 0xad || charCode === 0x03) currentElementScale = 0;
      // #endregion

      // Store some of the text object's information
      this.m_internalCharacterInfo[this.m_characterCount].character = charCode & 0xffff;

      // Cache glyph metrics
      const altGlyph = this.m_textInfo.characterInfo[this.m_characterCount].alternativeGlyph;
      const currentGlyphMetrics = altGlyph == null ? this.m_cached_TextElement!.glyph.metrics : altGlyph.metrics;

      // Optimization to avoid calling this more than once per character.
      const isWhiteSpace = charCode <= 0xffff && charIsWhiteSpace(charCode);

      // #region Handle Kerning（TMP_Text.cs:4168）：偏好尺寸走 m_enableKerning（跟 GenerateTextMesh 的 m_ActiveFontFeatures 不同，照原版）
      let glyphAdjustments = { xPlacement: 0, yPlacement: 0, xAdvance: 0, yAdvance: 0 };
      let characterSpacingAdjustment = this.m_characterSpacing;
      if (this.m_enableKerning) {
        let adjustmentPair;
        const baseGlyphIndex = this.m_cached_TextElement!.glyphIndex;

        if (this.m_characterCount < totalCharacterCount - 1) {
          const nextGlyphIndex = this.m_textInfo.characterInfo[this.m_characterCount + 1].textElement!.glyphIndex;
          const key = ((nextGlyphIndex << 16) | baseGlyphIndex) >>> 0;

          adjustmentPair = this.m_currentFontAsset!.featureTable.pairLookup.get(key);
          if (adjustmentPair !== undefined) {
            glyphAdjustments = { ...adjustmentPair.firstAdjustmentRecord.glyphValueRecord };
            characterSpacingAdjustment = (adjustmentPair.featureLookupFlags & 0x00000200) !== 0 ? 0 : characterSpacingAdjustment;
          }
        }

        if (this.m_characterCount >= 1) {
          const previousGlyphIndex = this.m_textInfo.characterInfo[this.m_characterCount - 1].textElement!.glyphIndex;
          const key = ((baseGlyphIndex << 16) | previousGlyphIndex) >>> 0;

          adjustmentPair = this.m_currentFontAsset!.featureTable.pairLookup.get(key);
          if (adjustmentPair !== undefined) {
            const gvr = adjustmentPair.secondAdjustmentRecord.glyphValueRecord;
            glyphAdjustments = {
              xPlacement: f32(glyphAdjustments.xPlacement + gvr.xPlacement),
              yPlacement: f32(glyphAdjustments.yPlacement + gvr.yPlacement),
              xAdvance: f32(glyphAdjustments.xAdvance + gvr.xAdvance),
              yAdvance: f32(glyphAdjustments.yAdvance + gvr.yAdvance),
            };
            characterSpacingAdjustment = (adjustmentPair.featureLookupFlags & 0x00000200) !== 0 ? 0 : characterSpacingAdjustment;
          }
        }

        this.m_internalCharacterInfo[this.m_characterCount].adjustedHorizontalAdvance = glyphAdjustments.xAdvance;
      }
      // #endregion

      // #region Handle Diacritical Marks（TMP_Text.cs:4206）
      const isBaseGlyphNow = isBaseGlyph(charCode);

      if (isBaseGlyphNow) this.m_LastBaseGlyphIndex = this.m_characterCount;

      if (this.m_characterCount > 0 && !isBaseGlyphNow) {
        // Check for potential Mark-to-Base lookup if previous glyph was a base glyph
        if (this.m_LastBaseGlyphIndex !== -2147483648 && this.m_LastBaseGlyphIndex === this.m_characterCount - 1) {
          const baseGlyphIndex = this.m_textInfo.characterInfo[this.m_LastBaseGlyphIndex].textElement!.glyph.index;
          const markGlyphIndex = this.m_cached_TextElement!.glyphIndex;
          const key = ((markGlyphIndex << 16) | baseGlyphIndex) >>> 0;

          const glyphAdjustmentRecord = this.m_currentFontAsset!.featureTable.markBaseLookup.get(key);
          if (glyphAdjustmentRecord !== undefined) {
            const advanceOffset = f32(f32(this.m_internalCharacterInfo[this.m_LastBaseGlyphIndex].origin - this.m_xAdvance) / currentElementScale);

            glyphAdjustments.xPlacement = f32(f32(advanceOffset + glyphAdjustmentRecord.baseGlyphAnchorPoint.xCoordinate) - glyphAdjustmentRecord.markPositionAdjustment.xPositionAdjustment);
            glyphAdjustments.yPlacement = f32(glyphAdjustmentRecord.baseGlyphAnchorPoint.yCoordinate - glyphAdjustmentRecord.markPositionAdjustment.yPositionAdjustment);

            characterSpacingAdjustment = 0;
          }
        } else {
          // Iterate from previous glyph to last base glyph checking for any potential Mark-to-Mark lookups to apply. Otherwise check for potential Mark-to-Base lookup between the current glyph and last base glyph
          let wasLookupApplied = false;

          // Check for any potential Mark-to-Mark lookups
          for (let characterLookupIndex = this.m_characterCount - 1; characterLookupIndex >= 0 && characterLookupIndex !== this.m_LastBaseGlyphIndex; characterLookupIndex--) {
            // Handle any potential Mark-to-Mark lookup
            const baseGlyphIndex = this.m_textInfo.characterInfo[characterLookupIndex].textElement!.glyph.index;
            const combiningMarkGlyphIndex = this.m_cached_TextElement!.glyphIndex;
            const key = ((combiningMarkGlyphIndex << 16) | baseGlyphIndex) >>> 0;

            const glyphAdjustmentRecord = this.m_currentFontAsset!.featureTable.markMarkLookup.get(key);
            if (glyphAdjustmentRecord !== undefined) {
              const baseMarkOrigin = f32(f32(this.m_textInfo.characterInfo[characterLookupIndex].origin - this.m_xAdvance) / currentElementScale);
              const currentBaseline = f32(f32(baselineOffset - this.m_lineOffset) + this.m_baselineOffset);
              const baseMarkBaseline = f32(f32(this.m_internalCharacterInfo[characterLookupIndex].baseLine - currentBaseline) / currentElementScale);

              glyphAdjustments.xPlacement = f32(f32(baseMarkOrigin + glyphAdjustmentRecord.baseMarkGlyphAnchorPoint.xCoordinate) - glyphAdjustmentRecord.combiningMarkPositionAdjustment.xPositionAdjustment);
              glyphAdjustments.yPlacement = f32(f32(baseMarkBaseline + glyphAdjustmentRecord.baseMarkGlyphAnchorPoint.yCoordinate) - glyphAdjustmentRecord.combiningMarkPositionAdjustment.yPositionAdjustment);

              characterSpacingAdjustment = 0;
              wasLookupApplied = true;
              break;
            }
          }

          // If no Mark-to-Mark lookups were applied, check for potential Mark-to-Base lookup.
          if (this.m_LastBaseGlyphIndex !== -2147483648 && !wasLookupApplied) {
            // Handle lookup for Mark-to-Base
            const baseGlyphIndex = this.m_textInfo.characterInfo[this.m_LastBaseGlyphIndex].textElement!.glyph.index;
            const markGlyphIndex = this.m_cached_TextElement!.glyphIndex;
            const key = ((markGlyphIndex << 16) | baseGlyphIndex) >>> 0;

            const glyphAdjustmentRecord = this.m_currentFontAsset!.featureTable.markBaseLookup.get(key);
            if (glyphAdjustmentRecord !== undefined) {
              const advanceOffset = f32(f32(this.m_internalCharacterInfo[this.m_LastBaseGlyphIndex].origin - this.m_xAdvance) / currentElementScale);

              glyphAdjustments.xPlacement = f32(f32(advanceOffset + glyphAdjustmentRecord.baseGlyphAnchorPoint.xCoordinate) - glyphAdjustmentRecord.markPositionAdjustment.xPositionAdjustment);
              glyphAdjustments.yPlacement = f32(glyphAdjustmentRecord.baseGlyphAnchorPoint.yCoordinate - glyphAdjustmentRecord.markPositionAdjustment.yPositionAdjustment);

              characterSpacingAdjustment = 0;
            }
          }
        }
      }

      // Adjust relevant text metrics
      elementAscentLine = f32(elementAscentLine + glyphAdjustments.yPlacement);
      elementDescentLine = f32(elementDescentLine + glyphAdjustments.yPlacement);
      // #endregion

      // #region Handle Right-to-Left（TMP_Text.cs:4290）：原版整段註解掉了
      // #endregion

      // #region Handle Mono Spacing（TMP_Text.cs:4302）
      let monoAdvance = 0;
      if (this.m_monoSpacing !== 0) {
        monoAdvance = f32(f32(this.m_monoSpacing / 2 - f32(f32(this.m_cached_TextElement!.glyph.metrics.width / 2 + this.m_cached_TextElement!.glyph.metrics.horizontalBearingX) * currentElementScale)) * f32(1 - this.m_charWidthAdjDelta));
        this.m_xAdvance = f32(this.m_xAdvance + monoAdvance);
      }
      // #endregion

      // #region Handle Style Padding（TMP_Text.cs:4313）：偏好尺寸只算 boldSpacingAdjustment
      let boldSpacingAdjustment = 0;
      if (this.m_textElementType === TmpTextElementType.Character && !isUsingAltTypeface && (this.m_FontStyleInternal & FontStyles.Bold) === FontStyles.Bold)
        boldSpacingAdjustment = this.m_currentFontAsset!.boldSpacing;
      // #endregion Handle Style Padding

      this.m_internalCharacterInfo[this.m_characterCount].origin = f32(this.m_xAdvance + f32(glyphAdjustments.xPlacement * currentElementScale));
      this.m_internalCharacterInfo[this.m_characterCount].baseLine = f32(f32(f32(baselineOffset - this.m_lineOffset) + this.m_baselineOffset) + f32(glyphAdjustments.yPlacement * currentElementScale));

      // #region Compute Ascender & Descender values（TMP_Text.cs:4323）
      // Element Ascender in line space
      const elementAscender =
        this.m_textElementType === TmpTextElementType.Character
          ? f32(f32(f32(elementAscentLine * currentElementScale) / smallCapsMultiplier) + this.m_baselineOffset)
          : f32(f32(elementAscentLine * currentElementScale) + this.m_baselineOffset);

      // Element Descender in line space
      const elementDescender =
        this.m_textElementType === TmpTextElementType.Character
          ? f32(f32(f32(elementDescentLine * currentElementScale) / smallCapsMultiplier) + this.m_baselineOffset)
          : f32(f32(elementDescentLine * currentElementScale) + this.m_baselineOffset);

      let adjustedAscender = elementAscender;
      let adjustedDescender = elementDescender;

      // Max line ascender and descender in line space
      const isFirstCharacterOfLine = this.m_characterCount === this.m_firstCharacterOfLine;
      if (isFirstCharacterOfLine || isWhiteSpace === false) {
        // Special handling for Superscript and Subscript where we use the unadjusted line ascender and descender
        if (this.m_baselineOffset !== 0) {
          adjustedAscender = Math.max(f32(f32(elementAscender - this.m_baselineOffset) / this.m_fontScaleMultiplier), adjustedAscender);
          adjustedDescender = Math.min(f32(f32(elementDescender - this.m_baselineOffset) / this.m_fontScaleMultiplier), adjustedDescender);
        }

        this.m_maxLineAscender = Math.max(adjustedAscender, this.m_maxLineAscender);
        this.m_maxLineDescender = Math.min(adjustedDescender, this.m_maxLineDescender);
      }

      // Element Ascender and Descender in object space
      if (isFirstCharacterOfLine || isWhiteSpace === false) {
        this.m_internalCharacterInfo[this.m_characterCount].adjustedAscender = adjustedAscender;
        this.m_internalCharacterInfo[this.m_characterCount].adjustedDescender = adjustedDescender;

        this.m_ElementAscender = this.m_internalCharacterInfo[this.m_characterCount].ascender = f32(elementAscender - this.m_lineOffset);
        this.m_ElementDescender = this.m_internalCharacterInfo[this.m_characterCount].descender = f32(elementDescender - this.m_lineOffset);
      } else {
        this.m_internalCharacterInfo[this.m_characterCount].adjustedAscender = this.m_maxLineAscender;
        this.m_internalCharacterInfo[this.m_characterCount].adjustedDescender = this.m_maxLineDescender;

        this.m_ElementAscender = this.m_internalCharacterInfo[this.m_characterCount].ascender = f32(this.m_maxLineAscender - this.m_lineOffset);
        this.m_ElementDescender = this.m_internalCharacterInfo[this.m_characterCount].descender = f32(this.m_maxLineDescender - this.m_lineOffset);
      }

      // Max text object ascender and cap height
      if (this.m_lineNumber === 0 || this.m_isNewPage) {
        if (isFirstCharacterOfLine || isWhiteSpace === false) {
          this.m_maxTextAscender = this.m_maxLineAscender;
          this.m_maxCapHeight = Math.max(this.m_maxCapHeight, f32(f32(this.m_currentFontAsset!.faceInfo.capLine * currentElementScale) / smallCapsMultiplier));
        }
      }

      // Page ascender
      if (this.m_lineOffset === 0) {
        if (!isWhiteSpace || this.m_characterCount === this.m_firstCharacterOfLine) this.m_PageAscender = this.m_PageAscender > elementAscender ? this.m_PageAscender : elementAscender;
      }
      // #endregion

      const isJustifiedOrFlush = (this.m_lineJustification & HorizontalAlignmentOptions.Flush) === HorizontalAlignmentOptions.Flush || (this.m_lineJustification & HorizontalAlignmentOptions.Justified) === HorizontalAlignmentOptions.Justified;

      // #region Handle Visible Characters（TMP_Text.cs:4391）
      if (
        charCode === 9 ||
        ((textWrapMode === TextWrappingModes.PreserveWhitespace || textWrapMode === TextWrappingModes.PreserveWhitespaceNoWrap) && (isWhiteSpace || charCode === 0x200b)) ||
        (isWhiteSpace === false && charCode !== 0x200b && charCode !== 0xad && charCode !== 0x03) ||
        (charCode === 0xad && isSoftHyphenIgnored === false) ||
        this.m_textElementType === TmpTextElementType.Sprite
      ) {
        widthOfTextArea = this.m_width !== -1 ? Math.min(f32(f32(f32(marginWidth + 0.0001) - this.m_marginLeft) - this.m_marginRight), this.m_width) : f32(f32(f32(marginWidth + 0.0001) - this.m_marginLeft) - this.m_marginRight);

        // Calculate the line breaking width of the text.
        const textWidth = f32(Math.abs(this.m_xAdvance) + f32(f32(currentGlyphMetrics.horizontalAdvance * f32(1 - this.m_charWidthAdjDelta)) * (charCode === 0xad ? currentElementUnmodifiedScale : currentElementScale)));

        // #region Current Line Horizontal Bounds Check（TMP_Text.cs:4412）
        if (isBaseGlyphNow && textWidth > f32(widthOfTextArea * (isJustifiedOrFlush ? 1.05 : 1.0))) {
          // Handle Line Breaking (if still possible)
          if (textWrapMode !== TextWrappingModes.NoWrap && textWrapMode !== TextWrappingModes.PreserveWhitespaceNoWrap && this.m_characterCount !== this.m_firstCharacterOfLine) {
            // Restore state to previous safe line breaking
            i = this.restoreWordWrappingState(internalWordWrapState);

            // Replace Soft Hyphen by Hyphen Minus 0x2D
            // #region Handle Soft Hyphenation（TMP_Text.cs:4422）
            if (this.m_internalCharacterInfo[this.m_characterCount - 1].character === 0xad && isSoftHyphenIgnored === false && this.m_overflowMode === TextOverflowModes.Overflow) {
              characterToSubstitute.index = this.m_characterCount - 1;
              characterToSubstitute.unicode = 0x2d;

              i -= 1;
              this.m_characterCount -= 1;
              continue;
            }

            isSoftHyphenIgnored = false;

            // Ignore Soft Hyphen to prevent it from wrapping
            if (this.m_internalCharacterInfo[this.m_characterCount].character === 0xad) {
              isSoftHyphenIgnored = true;
              continue;
            }
            // #endregion

            // Adjust character spacing before breaking up word if auto size is enabled
            // #region Handle Text Auto Size (if word wrapping is no longer possible)（TMP_Text.cs:4444）
            if (isTextAutoSizingEnabled && isFirstWordOfLine) {
              // #region Character Width Adjustments（TMP_Text.cs:4448）
              if (this.m_charWidthAdjDelta < this.m_charWidthMaxAdj / 100 && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
                let adjustedTextWidth = textWidth;

                // Determine full width of the text
                if (this.m_charWidthAdjDelta > 0) adjustedTextWidth = f32(adjustedTextWidth / f32(1 - this.m_charWidthAdjDelta));

                const adjustmentDelta = f32(textWidth - f32(f32(widthOfTextArea - 0.0001) * (isJustifiedOrFlush ? 1.05 : 1.0)));
                this.m_charWidthAdjDelta = f32(this.m_charWidthAdjDelta + f32(adjustmentDelta / adjustedTextWidth));
                this.m_charWidthAdjDelta = Math.min(this.m_charWidthAdjDelta, this.m_charWidthMaxAdj / 100);

                return { x: 0, y: 0 };
              }
              // #endregion

              // #region Text Auto-Sizing (Text greater than vertical bounds)（TMP_Text.cs:4467）
              if (fontSize.v > this.m_fontSizeMin && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
                this.m_maxFontSize = fontSize.v;

                const sizeDelta = Math.max(f32(f32(fontSize.v - this.m_minFontSize) / 2), 0.05);
                fontSize.v = f32(fontSize.v - sizeDelta);
                fontSize.v = Math.max(f32(intCast(f32(f32(fontSize.v * 20) + 0.5)) / 20), this.m_fontSizeMin);

                return { x: 0, y: 0 };
              }
              // #endregion Text Auto-Sizing
            }
            // #endregion

            // Adjust line spacing if necessary
            const baselineAdjustmentDelta = f32(this.m_maxLineAscender - this.m_startOfLineAscender);
            if (this.m_lineOffset > 0 && Math.abs(baselineAdjustmentDelta) > 0.01 && this.m_IsDrivenLineSpacing === false && !this.m_isNewPage) {
              //AdjustLineOffset(m_firstCharacterOfLine, m_characterCount, baselineAdjustmentDelta);
              this.m_ElementDescender = f32(this.m_ElementDescender - baselineAdjustmentDelta);
              this.m_lineOffset = f32(this.m_lineOffset + baselineAdjustmentDelta);
            }

            // Update maxDescender and maxVisibleDescender
            const lineDescender = f32(this.m_maxLineDescender - this.m_lineOffset);
            this.m_ElementDescender = this.m_ElementDescender < lineDescender ? this.m_ElementDescender : lineDescender;

            // Store first character of the next line.
            this.m_firstCharacterOfLine = this.m_characterCount;
            this.m_lineVisibleCharacterCount = 0;

            // Store the state of the line before starting on the new line.
            this.saveWordWrappingState(internalLineState, i, this.m_characterCount - 1);

            this.m_lineNumber += 1;

            const ascender = this.m_internalCharacterInfo[this.m_characterCount].adjustedAscender;

            // Compute potential new line offset in the event a line break is needed.
            if (this.m_lineHeight === TMP_MATH.FLOAT_UNSET) {
              this.m_lineOffset = f32(this.m_lineOffset + f32(f32(f32(f32(0 - this.m_maxLineDescender) + ascender) + f32(f32(lineGap + this.m_lineSpacingDelta) * baseScale)) + f32(this.m_lineSpacing * currentEmScale)));
              this.m_IsDrivenLineSpacing = false;
            } else {
              this.m_lineOffset = f32(this.m_lineOffset + f32(this.m_lineHeight + f32(this.m_lineSpacing * currentEmScale)));
              this.m_IsDrivenLineSpacing = true;
            }

            this.m_maxLineAscender = k_LargeNegativeFloat;
            this.m_maxLineDescender = k_LargePositiveFloat;
            this.m_startOfLineAscender = ascender;

            this.m_xAdvance = f32(0 + this.tag_Indent);
            isFirstWordOfLine = true;
            continue;
          }
        }
        // #endregion

        // Compute Preferred Width & Height
        this.m_RenderedWidth = Math.max(this.m_RenderedWidth, f32(textWidth + this.m_marginLeft + this.m_marginRight));
        this.m_RenderedHeight = f32(this.m_maxTextAscender - this.m_ElementDescender);
      }
      // #endregion Handle Visible Characters

      // #region Adjust Line Spacing（TMP_Text.cs:4548）：原版整段註解掉了
      // #endregion

      // #region XAdvance, Tabulation & Stops（TMP_Text.cs:4564）
      if (charCode === 9) {
        const tabSize = f32(f32(this.m_currentFontAsset!.faceInfo.tabWidth * this.m_currentFontAsset!.tabSize) * currentElementScale);
        const tabs = f32(Math.ceil(f32(this.m_xAdvance / tabSize)) * tabSize);
        this.m_xAdvance = tabs > this.m_xAdvance ? tabs : f32(this.m_xAdvance + tabSize);
      } else if (this.m_monoSpacing !== 0) {
        this.m_xAdvance = f32(
          this.m_xAdvance + f32(f32(f32(this.m_monoSpacing - monoAdvance) + f32(f32(this.m_currentFontAsset!.normalSpacingOffset + characterSpacingAdjustment) * currentEmScale)) + this.m_cSpacing) * f32(1 - this.m_charWidthAdjDelta),
        );

        if (isWhiteSpace || charCode === 0x200b) this.m_xAdvance = f32(this.m_xAdvance + f32(this.m_wordSpacing * currentEmScale));
      } else {
        this.m_xAdvance = f32(
          this.m_xAdvance +
            f32(
              f32(f32(f32(currentGlyphMetrics.horizontalAdvance * this.m_FXScale.x) + glyphAdjustments.xAdvance) * currentElementScale) +
                f32(f32(this.m_currentFontAsset!.normalSpacingOffset + characterSpacingAdjustment + boldSpacingAdjustment) * currentEmScale) +
                this.m_cSpacing,
            ) * f32(1 - this.m_charWidthAdjDelta),
        );

        if (isWhiteSpace || charCode === 0x200b) this.m_xAdvance = f32(this.m_xAdvance + f32(this.m_wordSpacing * currentEmScale));
      }
      // #endregion Tabulation & Stops

      // #region Carriage Return（TMP_Text.cs:4589）
      if (charCode === 13) {
        this.m_xAdvance = f32(0 + this.tag_Indent);
      }
      // #endregion Carriage Return

      // #region Check for Line Feed and Last Character（TMP_Text.cs:4598）
      if (charCode === 10 || charCode === 11 || charCode === 0x03 || charCode === 0x2028 || charCode === 0x2029 || this.m_characterCount === totalCharacterCount - 1) {
        // Check if Line Spacing of previous line needs to be adjusted.
        const baselineAdjustmentDelta = f32(this.m_maxLineAscender - this.m_startOfLineAscender);
        if (this.m_lineOffset > 0 && Math.abs(baselineAdjustmentDelta) > 0.01 && this.m_IsDrivenLineSpacing === false && !this.m_isNewPage) {
          this.m_ElementDescender = f32(this.m_ElementDescender - baselineAdjustmentDelta);
          this.m_lineOffset = f32(this.m_lineOffset + baselineAdjustmentDelta);
        }
        this.m_isNewPage = false;

        // Calculate lineAscender & make sure if last character is superscript or subscript that we check that as well.
        const lineDescender = f32(this.m_maxLineDescender - this.m_lineOffset);

        // Update maxDescender and maxVisibleDescender
        this.m_ElementDescender = this.m_ElementDescender < lineDescender ? this.m_ElementDescender : lineDescender;

        // Add new line if not last lines or character.
        if (charCode === 10 || charCode === 11 || (charCode === 0x2d && isInjectedCharacter) || charCode === 0x2028 || charCode === 0x2029) {
          // Store the state of the line before starting on the new line.
          this.saveWordWrappingState(internalLineState, i, this.m_characterCount);
          // Store the state of the last Character before the new line.
          this.saveWordWrappingState(internalWordWrapState, i, this.m_characterCount);

          this.m_lineNumber += 1;
          this.m_firstCharacterOfLine = this.m_characterCount + 1;

          const ascender = this.m_internalCharacterInfo[this.m_characterCount].adjustedAscender;

          // Apply Line Spacing with special handling for VT char(11)
          if (this.m_lineHeight === TMP_MATH.FLOAT_UNSET) {
            const lineOffsetDelta = f32(
              f32(f32(f32(0 - this.m_maxLineDescender) + ascender) + f32(f32(lineGap + this.m_lineSpacingDelta) * baseScale)) +
                f32(f32(this.m_lineSpacing + (charCode === 10 || charCode === 0x2029 ? this.m_paragraphSpacing : 0)) * currentEmScale),
            );
            this.m_lineOffset = f32(this.m_lineOffset + lineOffsetDelta);
            this.m_IsDrivenLineSpacing = false;
          } else {
            this.m_lineOffset = f32(this.m_lineOffset + f32(this.m_lineHeight + f32((this.m_lineSpacing + (charCode === 10 || charCode === 0x2029 ? this.m_paragraphSpacing : 0)) * currentEmScale)));
            this.m_IsDrivenLineSpacing = true;
          }

          this.m_maxLineAscender = k_LargeNegativeFloat;
          this.m_maxLineDescender = k_LargePositiveFloat;
          this.m_startOfLineAscender = ascender;

          this.m_xAdvance = f32(f32(0 + this.tag_LineIndent) + this.tag_Indent);

          this.m_characterCount += 1;
          continue;
        }

        // If End of Text
        if (charCode === 0x03) i = this.m_TextProcessingArray.length;
      }
      // #endregion Check for Linefeed or Last Character

      // #region Save Word Wrapping State（TMP_Text.cs:4661）
      if ((textWrapMode !== TextWrappingModes.NoWrap && textWrapMode !== TextWrappingModes.PreserveWhitespaceNoWrap) || this.m_overflowMode === TextOverflowModes.Truncate || this.m_overflowMode === TextOverflowModes.Ellipsis) {
        let shouldSaveHardLineBreak = false;
        let shouldSaveSoftLineBreak = false;

        if (
          (isWhiteSpace || charCode === 0x200b || charCode === 0x2d || charCode === 0xad) &&
          (!this.m_isNonBreakingSpace || ignoreNonBreakingSpace) &&
          charCode !== 0xa0 &&
          charCode !== 0x2007 &&
          charCode !== 0x2011 &&
          charCode !== 0x202f &&
          charCode !== 0x2060
        ) {
          // Ignore Hyphen (0x2D) when preceded by a whitespace
          if (!(charCode === 0x2d && this.m_characterCount > 0 && charIsWhiteSpace(this.m_textInfo.characterInfo[this.m_characterCount - 1].character))) {
            isFirstWordOfLine = false;
            shouldSaveHardLineBreak = true;

            // Reset soft line breaking point since we now have a valid hard break point.
            internalSoftLineBreak.previous_WordBreak = -1;
          }
        }
        // Handling for East Asian scripts
        else if (this.m_isNonBreakingSpace === false && ((isHangul(charCode) && this.settings.useModernHangulLineBreakingRules === false) || isCJK(charCode))) {
          const isCurrentLeadingCharacter = this.settings.linebreakingRules(this.assets).leadingCharacters.has(charCode);
          const isNextFollowingCharacter =
            this.m_characterCount < totalCharacterCount - 1 && this.settings.linebreakingRules(this.assets).followingCharacters.has(this.m_internalCharacterInfo[this.m_characterCount + 1].character);

          if (isCurrentLeadingCharacter === false) {
            if (isNextFollowingCharacter === false) {
              isFirstWordOfLine = false;
              shouldSaveHardLineBreak = true;
            }

            if (isFirstWordOfLine) {
              // Special handling for non-breaking space and soft line breaks
              if (isWhiteSpace) shouldSaveSoftLineBreak = true;

              shouldSaveHardLineBreak = true;
            }
          } else {
            if (isFirstWordOfLine && isFirstCharacterOfLine) {
              // Special handling for non-breaking space and soft line breaks
              if (isWhiteSpace) shouldSaveSoftLineBreak = true;

              shouldSaveHardLineBreak = true;
            }
          }
        }
        // Special handling for Latin characters followed by a CJK character.
        else if (this.m_isNonBreakingSpace === false && this.m_characterCount + 1 < totalCharacterCount && isCJK(this.m_textInfo.characterInfo[this.m_characterCount + 1].character)) {
          shouldSaveHardLineBreak = true;
        } else if (isFirstWordOfLine) {
          // Special handling for non-breaking space and soft line breaks
          if ((isWhiteSpace && charCode !== 0xa0) || (charCode === 0xad && isSoftHyphenIgnored === false)) shouldSaveSoftLineBreak = true;

          shouldSaveHardLineBreak = true;
        }

        // Save potential Hard lines break
        if (shouldSaveHardLineBreak) this.saveWordWrappingState(internalWordWrapState, i, this.m_characterCount);

        // Save potential Soft line break
        if (shouldSaveSoftLineBreak) this.saveWordWrappingState(internalSoftLineBreak, i, this.m_characterCount);
      }
      // #endregion Save Word Wrapping State

      this.m_characterCount += 1;
    }

    // #region Check Auto-Sizing (Upper Font Size Bounds)（TMP_Text.cs:4742）
    fontSizeDelta = f32(this.m_maxFontSize - this.m_minFontSize);
    if (isTextAutoSizingEnabled && fontSizeDelta > 0.051 && fontSize.v < this.m_fontSizeMax && this.m_AutoSizeIterationCount < this.m_AutoSizeMaxIterationCount) {
      // Reset character width adjustment delta
      if (this.m_charWidthAdjDelta < this.m_charWidthMaxAdj / 100) this.m_charWidthAdjDelta = 0;

      this.m_minFontSize = fontSize.v;

      const sizeDelta = Math.max(f32(f32(this.m_maxFontSize - fontSize.v) / 2), 0.05);
      fontSize.v = f32(fontSize.v + sizeDelta);
      fontSize.v = Math.min(f32(intCast(f32(f32(fontSize.v * 20) + 0.5)) / 20), this.m_fontSizeMax);

      return { x: 0, y: 0 };
    }
    // #endregion End Auto-sizing Check

    this.m_IsAutoSizePointSizeSet = true;

    this.m_isCalculatingPreferredValues = false;

    // Adjust Preferred Width and Height to account for Margins.
    this.m_RenderedWidth += this.m_margin.x > 0 ? this.m_margin.x : 0;
    this.m_RenderedWidth += this.m_margin.z > 0 ? this.m_margin.z : 0;

    this.m_RenderedHeight += this.m_margin.y > 0 ? this.m_margin.y : 0;
    this.m_RenderedHeight += this.m_margin.w > 0 ? this.m_margin.w : 0;

    // Round Preferred Values to nearest 5/100.
    this.m_RenderedWidth = f32(intCast(f32(f32(this.m_RenderedWidth * 100) + 1)) / 100);
    this.m_RenderedHeight = f32(intCast(f32(f32(this.m_RenderedHeight * 100) + 1)) / 100);

    return { x: this.m_RenderedWidth, y: this.m_RenderedHeight };
  }
}

/** HexToInt（TMP_Text.cs:6379） */
export function hexToInt(hex: number): number {
  switch (hex) {
    case 0x30: return 0;
    case 0x31: return 1;
    case 0x32: return 2;
    case 0x33: return 3;
    case 0x34: return 4;
    case 0x35: return 5;
    case 0x36: return 6;
    case 0x37: return 7;
    case 0x38: return 8;
    case 0x39: return 9;
    case 0x41: return 10;
    case 0x42: return 11;
    case 0x43: return 12;
    case 0x44: return 13;
    case 0x45: return 14;
    case 0x46: return 15;
    case 0x61: return 10;
    case 0x62: return 11;
    case 0x63: return 12;
    case 0x64: return 13;
    case 0x65: return 14;
    case 0x66: return 15;
  }
  return 15;
}

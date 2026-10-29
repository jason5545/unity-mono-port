// 素材資料層：把 public/game/assets 的 RawObject 包成 TMP 執行時用的結構。
// 對應：TMP_FontAsset.cs、TMP_SpriteAsset.cs、TMP_FontAssetUtilities.cs、TMP_MaterialManager.cs（GetFallbackMaterial）、
//       TMP_ShaderUtilities.cs（GetPadding、UpdateShaderRatios、IsMaskingEnabled）、TMP_Settings.cs、TMP_StyleSheet.cs、TMP_Style.cs。
// RawObject 的欄位名稱照 Unity 序列化（m_FaceInfo.m_AscentLine 等）。

import type { ExternalRef } from '../unity/types';
import type { RawObject, TextAssets } from './types';
import { color32, f32, getHashCode, type Color32 } from './utils';
import { SHADER_PROPERTIES } from './shaderProps';

// ───────── Glyph／TextElement（Glyph、TMP_Character、TMP_SpriteCharacter） ─────────

/** UnityEngine.TextCore.GlyphMetrics */
export interface GlyphMetrics {
  width: number;
  height: number;
  horizontalBearingX: number;
  horizontalBearingY: number;
  horizontalAdvance: number;
}

/** UnityEngine.TextCore.GlyphRect */
export interface GlyphRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** UnityEngine.TextCore.Glyph */
export interface GlyphData {
  index: number;
  metrics: GlyphMetrics;
  glyphRect: GlyphRect;
  scale: number;
  atlasIndex: number;
}

/** TextElementType（TMP_TextElement.cs:7） */
export const enum TextElementType {
  Character = 0x1,
  Sprite = 0x2,
}

/** TMP_TextElement（TMP_Character／TMP_SpriteCharacter 共用） */
export interface TextElementData {
  elementType: TextElementType;
  unicode: number;
  glyphIndex: number;
  scale: number;
  glyph: GlyphData;
  /** character.textAsset：這個字元屬於哪個資產（fallback 找到的就是 fallback 資產） */
  textAsset: FontAssetData | SpriteAssetData | null;
  /** TMP_SpriteCharacter 的名字 */
  name?: string;
}

function glyphFromJson(g: RawObject): GlyphData {
  const m = g.m_Metrics as RawObject;
  const r = g.m_GlyphRect as RawObject;
  return {
    index: g.m_Index as number,
    metrics: {
      width: m.m_Width as number,
      height: m.m_Height as number,
      horizontalBearingX: m.m_HorizontalBearingX as number,
      horizontalBearingY: m.m_HorizontalBearingY as number,
      horizontalAdvance: m.m_HorizontalAdvance as number,
    },
    glyphRect: { x: r.m_X as number, y: r.m_Y as number, width: r.m_Width as number, height: r.m_Height as number },
    scale: (g.m_Scale as number) ?? 1,
    atlasIndex: (g.m_AtlasIndex as number) ?? 0,
  };
}

// ───────── FaceInfo ─────────

/** UnityEngine.TextCore.FaceInfo */
export interface FaceInfo {
  faceIndex: number;
  familyName: string | null;
  styleName: string | null;
  pointSize: number;
  scale: number;
  unitsPerEM: number;
  lineHeight: number;
  ascentLine: number;
  capLine: number;
  meanLine: number;
  baseline: number;
  descentLine: number;
  superscriptOffset: number;
  superscriptSize: number;
  subscriptOffset: number;
  subscriptSize: number;
  underlineOffset: number;
  underlineThickness: number;
  strikethroughOffset: number;
  strikethroughThickness: number;
  tabWidth: number;
}

function faceInfoFromJson(fi: RawObject | undefined | null): FaceInfo {
  const f = fi ?? {};
  return {
    faceIndex: (f.m_FaceIndex as number) ?? 0,
    familyName: (f.m_FamilyName as string | null) ?? null,
    styleName: (f.m_StyleName as string | null) ?? null,
    pointSize: (f.m_PointSize as number) ?? 0,
    scale: (f.m_Scale as number) ?? 0,
    unitsPerEM: (f.m_UnitsPerEM as number) ?? 0,
    lineHeight: (f.m_LineHeight as number) ?? 0,
    ascentLine: (f.m_AscentLine as number) ?? 0,
    capLine: (f.m_CapLine as number) ?? 0,
    meanLine: (f.m_MeanLine as number) ?? 0,
    baseline: (f.m_Baseline as number) ?? 0,
    descentLine: (f.m_DescentLine as number) ?? 0,
    superscriptOffset: (f.m_SuperscriptOffset as number) ?? 0,
    superscriptSize: (f.m_SuperscriptSize as number) ?? 0,
    subscriptOffset: (f.m_SubscriptOffset as number) ?? 0,
    subscriptSize: (f.m_SubscriptSize as number) ?? 0,
    underlineOffset: (f.m_UnderlineOffset as number) ?? 0,
    underlineThickness: (f.m_UnderlineThickness as number) ?? 0,
    strikethroughOffset: (f.m_StrikethroughOffset as number) ?? 0,
    strikethroughThickness: (f.m_StrikethroughThickness as number) ?? 0,
    tabWidth: (f.m_TabWidth as number) ?? 0,
  };
}

// ───────── Material（MaterialView：UnityEngine.Material 的屬性存取） ─────────

let nextMaterialInstanceId = 1;

/**
 * UnityEngine.Material 的資料檢視。HasProperty 用「m_Floats／m_Colors／m_TexEnvs 有這個 key」近似
 * （Unity 序列化 .mat 時會把 shader 的全部屬性寫進 m_SavedProperties）。
 */
export class MaterialView {
  instanceId: number;
  ref: ExternalRef | null;
  floats: Record<string, number>;
  colors: Record<string, { r: number; g: number; b: number; a: number }>;
  textures: Record<string, ExternalRef | null>;
  keywords: string[];
  shaderRef: ExternalRef | null;

  constructor(ref: ExternalRef | null, src?: RawObject | null) {
    this.instanceId = nextMaterialInstanceId++;
    this.ref = ref ?? null;
    const saved = (src?.m_SavedProperties ?? {}) as RawObject;
    this.floats = { ...((saved.m_Floats as Record<string, number>) ?? {}) };
    this.colors = { ...((saved.m_Colors as Record<string, { r: number; g: number; b: number; a: number }>) ?? {}) };
    const texEnvs = (saved.m_TexEnvs ?? {}) as Record<string, { m_Texture: ExternalRef | null }>;
    this.textures = {};
    for (const [k, v] of Object.entries(texEnvs)) this.textures[k] = v?.m_Texture ?? null;
    this.keywords = [...((src?.m_ValidKeywords as string[]) ?? [])];
    this.shaderRef = (src?.m_Shader as ExternalRef | null) ?? null;
  }

  /** 複製（new Material(source)）：執行時實例，沒有序列化來源（ref = null） */
  clone(): MaterialView {
    const m = Object.create(MaterialView.prototype) as MaterialView;
    m.instanceId = nextMaterialInstanceId++;
    m.ref = null;
    m.floats = { ...this.floats };
    m.colors = { ...this.colors };
    m.textures = { ...this.textures };
    m.keywords = [...this.keywords];
    m.shaderRef = this.shaderRef;
    return m;
  }

  hasProperty(name: string): boolean {
    // Unity 的 HasProperty 查 shader 宣告的屬性；不在表裡的 shader（不該出現在文字上）退回序列化欄位
    const props = this.shaderRef ? SHADER_PROPERTIES[this.shaderRef.guid] : undefined;
    if (props) return props.includes(name);
    return name in this.floats || name in this.colors || name in this.textures;
  }
  getFloat(name: string): number {
    return this.floats[name] ?? 0;
  }
  setFloat(name: string, v: number): void {
    this.floats[name] = v;
  }
  getVector(name: string): { x: number; y: number; z: number; w: number } {
    const c = this.colors[name];
    return c ? { x: c.r, y: c.g, z: c.b, w: c.a } : { x: 0, y: 0, z: 0, w: 0 };
  }
  setTexture(name: string, tex: ExternalRef | null): void {
    this.textures[name] = tex;
  }
  getTexture(name: string): ExternalRef | null {
    return this.textures[name] ?? null;
  }
  get shaderKeywords(): string[] {
    return this.keywords;
  }
}

// ───────── TMP_FontFeatureTable ─────────

/** GlyphValueRecord（FontFeatureCommonGPOS.cs） */
export interface GlyphValueRecord {
  xPlacement: number;
  yPlacement: number;
  xAdvance: number;
  yAdvance: number;
}

export const glyphValueRecordZero = (): GlyphValueRecord => ({ xPlacement: 0, yPlacement: 0, xAdvance: 0, yAdvance: 0 });

/** GlyphPairAdjustmentRecord */
export interface GlyphPairAdjustmentRecord {
  firstAdjustmentRecord: { glyphIndex: number; glyphValueRecord: GlyphValueRecord };
  secondAdjustmentRecord: { glyphIndex: number; glyphValueRecord: GlyphValueRecord };
  featureLookupFlags: number;
}

/** MarkToBaseAdjustmentRecord */
export interface MarkToBaseAdjustmentRecord {
  baseGlyphID: number;
  baseGlyphAnchorPoint: { xCoordinate: number; yCoordinate: number };
  markGlyphID: number;
  markPositionAdjustment: { xPositionAdjustment: number; yPositionAdjustment: number };
}

/** MarkToMarkAdjustmentRecord */
export interface MarkToMarkAdjustmentRecord {
  baseMarkGlyphID: number;
  baseMarkGlyphAnchorPoint: { xCoordinate: number; yCoordinate: number };
  combiningMarkGlyphID: number;
  combiningMarkPositionAdjustment: { xPositionAdjustment: number; yPositionAdjustment: number };
}

/** LigatureSubstitutionRecord（FontFeatureCommonGSUB.cs:57） */
export interface LigatureSubstitutionRecord {
  componentGlyphIDs: number[];
  ligatureGlyphID: number;
}

/** TMP_FontFeatureTable：序列化清單＋執行時 lookup（lookup key 的組法照 TMP_FontAsset.cs:938/961/984/908） */
export class FontFeatureTable {
  pairLookup = new Map<number, GlyphPairAdjustmentRecord>();
  markBaseLookup = new Map<number, MarkToBaseAdjustmentRecord>();
  markMarkLookup = new Map<number, MarkToMarkAdjustmentRecord>();
  ligatureLookup = new Map<number, LigatureSubstitutionRecord[]>();

  constructor(ft: RawObject | undefined | null) {
    const t = ft ?? {};
    for (const r of (t.m_GlyphPairAdjustmentRecords as RawObject[]) ?? []) {
      const first = r.m_FirstAdjustmentRecord as RawObject;
      const second = r.m_SecondAdjustmentRecord as RawObject;
      const rec: GlyphPairAdjustmentRecord = {
        firstAdjustmentRecord: { glyphIndex: first.m_GlyphIndex as number, glyphValueRecord: valueRecordFromJson(first.m_GlyphValueRecord as RawObject) },
        secondAdjustmentRecord: { glyphIndex: second.m_GlyphIndex as number, glyphValueRecord: valueRecordFromJson(second.m_GlyphValueRecord as RawObject) },
        featureLookupFlags: (r.m_FeatureLookupFlags as number) ?? 0,
      };
      const key = ((rec.secondAdjustmentRecord.glyphIndex << 16) | rec.firstAdjustmentRecord.glyphIndex) >>> 0;
      if (!this.pairLookup.has(key)) this.pairLookup.set(key, rec);
    }
    for (const r of (t.m_MarkToBaseAdjustmentRecords as RawObject[]) ?? []) {
      const rec: MarkToBaseAdjustmentRecord = {
        baseGlyphID: r.m_BaseGlyphID as number,
        baseGlyphAnchorPoint: anchorFromJson(r.m_BaseGlyphAnchorPoint as RawObject),
        markGlyphID: r.m_MarkGlyphID as number,
        markPositionAdjustment: markAdjFromJson(r.m_MarkPositionAdjustment as RawObject),
      };
      const key = ((rec.markGlyphID << 16) | rec.baseGlyphID) >>> 0;
      if (!this.markBaseLookup.has(key)) this.markBaseLookup.set(key, rec);
    }
    for (const r of (t.m_MarkToMarkAdjustmentRecords as RawObject[]) ?? []) {
      const rec: MarkToMarkAdjustmentRecord = {
        baseMarkGlyphID: r.m_BaseMarkGlyphID as number,
        baseMarkGlyphAnchorPoint: anchorFromJson(r.m_BaseMarkGlyphAnchorPoint as RawObject),
        combiningMarkGlyphID: r.m_CombiningMarkGlyphID as number,
        combiningMarkPositionAdjustment: markAdjFromJson(r.m_CombiningMarkPositionAdjustment as RawObject),
      };
      const key = ((rec.combiningMarkGlyphID << 16) | rec.baseMarkGlyphID) >>> 0;
      if (!this.markMarkLookup.has(key)) this.markMarkLookup.set(key, rec);
    }
    for (const r of (t.m_LigatureSubstitutionRecords as RawObject[]) ?? []) {
      const rec: LigatureSubstitutionRecord = {
        componentGlyphIDs: [...((r.m_ComponentGlyphIDs as number[]) ?? [])],
        ligatureGlyphID: r.m_LigatureGlyphID as number,
      };
      if (rec.componentGlyphIDs.length === 0) continue;
      const key = rec.componentGlyphIDs[0] >>> 0;
      const list = this.ligatureLookup.get(key);
      if (list) list.push(rec);
      else this.ligatureLookup.set(key, [rec]);
    }
  }
}

function valueRecordFromJson(v: RawObject | undefined): GlyphValueRecord {
  return {
    xPlacement: (v?.m_XPlacement as number) ?? 0,
    yPlacement: (v?.m_YPlacement as number) ?? 0,
    xAdvance: (v?.m_XAdvance as number) ?? 0,
    yAdvance: (v?.m_YAdvance as number) ?? 0,
  };
}
function anchorFromJson(v: RawObject | undefined): { xCoordinate: number; yCoordinate: number } {
  return { xCoordinate: (v?.m_XCoordinate as number) ?? 0, yCoordinate: (v?.m_YCoordinate as number) ?? 0 };
}
function markAdjFromJson(v: RawObject | undefined): { xPositionAdjustment: number; yPositionAdjustment: number } {
  return { xPositionAdjustment: (v?.m_XPositionAdjustment as number) ?? 0, yPositionAdjustment: (v?.m_YPositionAdjustment as number) ?? 0 };
}

// ───────── TMP_FontAsset ─────────

/** AtlasPopulationMode（UnityEngine.TextCore） */
export const enum AtlasPopulationMode {
  Static = 0,
  Dynamic = 1,
  DynamicOS = 2,
}

export class FontAssetData {
  readonly id: string; // guid，當 GetInstanceID 用
  readonly ref: ExternalRef;
  readonly name: string;
  readonly faceInfo: FaceInfo;
  readonly material: MaterialView;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly atlasPadding: number;
  readonly atlasRenderMode: number;
  readonly atlasPopulationMode: number;
  readonly normalStyle: number;
  readonly normalSpacingOffset: number;
  readonly boldStyle: number;
  readonly boldSpacing: number;
  readonly italicStyle: number;
  readonly tabSize: number;
  readonly featureTable: FontFeatureTable;
  readonly characterLookupTable = new Map<number, TextElementData>();
  readonly glyphLookupTable = new Map<number, GlyphData>();
  /** m_FallbackFontAssetTable 的 ref（lazy resolve） */
  readonly fallbackFontAssetRefs: (ExternalRef | null)[];
  private readonly fallbackFontAssetTableCache: (FontAssetData | null)[] = [];
  private fallbackResolved = false;
  private readonly fontWeightRefs: { regularTypeface: ExternalRef | null; italicTypeface: ExternalRef | null }[];

  constructor(
    readonly assets: TextAssets,
    ref: ExternalRef,
    data: RawObject,
    private readonly warnings: string[],
  ) {
    this.ref = ref;
    this.id = ref.guid;
    this.name = (data.m_Name as string) ?? ref.guid;
    this.faceInfo = faceInfoFromJson(data.m_FaceInfo as RawObject);
    const matRef = assetMaterialRef(data);
    this.material = new MaterialView(matRef, matRef ? assets.material(matRef) : null);
    this.atlasWidth = (data.m_AtlasWidth as number) ?? 0;
    this.atlasHeight = (data.m_AtlasHeight as number) ?? 0;
    this.atlasPadding = (data.m_AtlasPadding as number) ?? 0;
    this.atlasRenderMode = (data.m_AtlasRenderMode as number) ?? 0;
    this.atlasPopulationMode = (data.m_AtlasPopulationMode as number) ?? 0;
    this.normalStyle = (data.normalStyle as number) ?? 0;
    this.normalSpacingOffset = (data.normalSpacingOffset as number) ?? 0;
    this.boldStyle = (data.boldStyle as number) ?? 0.75;
    this.boldSpacing = (data.boldSpacing as number) ?? 7;
    this.italicStyle = (data.italicStyle as number) ?? 35;
    this.tabSize = (data.tabSize as number) ?? 10;
    this.featureTable = new FontFeatureTable(data.m_FontFeatureTable as RawObject);
    const glyphs = new Map<number, GlyphData>();
    for (const g of (data.m_GlyphTable as RawObject[]) ?? []) {
      const gd = glyphFromJson(g);
      glyphs.set(gd.index, gd);
      this.glyphLookupTable.set(gd.index, gd);
    }
    for (const c of (data.m_CharacterTable as RawObject[]) ?? []) {
      const glyphIndex = c.m_GlyphIndex as number;
      const glyph = glyphs.get(glyphIndex);
      if (!glyph) continue;
      this.characterLookupTable.set(c.m_Unicode as number, {
        elementType: TextElementType.Character,
        unicode: c.m_Unicode as number,
        glyphIndex,
        scale: (c.m_Scale as number) ?? 1,
        glyph,
        textAsset: this,
      });
    }
    this.fallbackFontAssetRefs = ((data.m_FallbackFontAssetTable as (ExternalRef | null)[]) ?? []).map((r) => (r && r.guid ? r : null));
    this.fontWeightRefs = ((data.m_FontWeightTable as RawObject[]) ?? []).map((w) => ({
      regularTypeface: (w.regularTypeface as ExternalRef | null)?.guid ? (w.regularTypeface as ExternalRef) : null,
      italicTypeface: (w.italicTypeface as ExternalRef | null)?.guid ? (w.italicTypeface as ExternalRef) : null,
    }));

    // ReadFontAssetDefinition（TMP_FontAsset.cs:727）的後半：
    // capLine／meanLine 從 X／x 補（746–759）、scale 0→1（762）、strikethroughOffset 0→capLine/2.5（767）、atlasPadding 0→gradientScale−1（771–775）。
    if (this.faceInfo.capLine === 0) {
      const x = this.characterLookupTable.get(0x58);
      if (x) this.faceInfo.capLine = x.glyph.metrics.horizontalBearingY;
    }
    if (this.faceInfo.meanLine === 0) {
      const x = this.characterLookupTable.get(0x78);
      if (x) this.faceInfo.meanLine = x.glyph.metrics.horizontalBearingY;
    }
    if (this.faceInfo.scale === 0) this.faceInfo.scale = 1;
    if (this.faceInfo.strikethroughOffset === 0) this.faceInfo.strikethroughOffset = f32(this.faceInfo.capLine / 2.5);

    // AddSynthesizedCharactersAndFaceMetrics（TMP_FontAsset.cs:988）：控制字元補零 metrics 的合成字。
    // 靜態字型（isFontFaceLoaded false → 直接補零 glyph）；動態字型在 tryAddCharacterInternal 缺字時補（store 有就用真的 metrics）。
    this.addSynthesizedCharacters();
  }

  /** 零 metrics 的合成字元（Glyph(0, zero, GlyphRect.zero, 1.0, 0)） */
  private synthesizeCharacter(unicode: number): void {
    if (this.characterLookupTable.has(unicode)) return;
    const glyph: GlyphData = { index: 0, metrics: { width: 0, height: 0, horizontalBearingX: 0, horizontalBearingY: 0, horizontalAdvance: 0 }, glyphRect: { x: 0, y: 0, width: 0, height: 0 }, scale: 1, atlasIndex: 0 };
    this.characterLookupTable.set(unicode, {
      elementType: TextElementType.Character,
      unicode,
      glyphIndex: 0,
      scale: 1,
      glyph,
      textAsset: this,
    });
  }

  /** AddSynthesizedCharactersAndFaceMetrics（TMP_FontAsset.cs:988）。addImmediately=true 的（0x03、0x09）動態字型用真 glyph，其餘照一般順序 */
  private addSynthesizedCharacters(): void {
    if (this.atlasPopulationMode === AtlasPopulationMode.Static) {
      // isFontFaceLoaded = false：全部補零 glyph
      for (const u of [0x03, 0x09, 0x0a, 0x0b, 0x0d, 0x061c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x2060]) this.synthesizeCharacter(u);
    }
    // 動態字型：LoadFontFace 成功時，0x03／0x09 若字型檔有就加真 glyph（否則補零）；其餘等 TryAddCharacterInternal。
    // 移植版的動態加字在第一次缺字查詢時做（store 有 cmap 就用真 metrics，沒有才補零）。
  }

  /** 動態字型缺字時的合成字元（對應 AddSynthesizedCharacter 在動態字型的行為） */
  private trySynthesizeDynamic(unicode: number): TextElementData | null {
    const SYNTH = [0x03, 0x09, 0x0a, 0x0b, 0x0d, 0x061c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x2060];
    if (!SYNTH.includes(unicode)) return null;
    this.synthesizeCharacter(unicode);
    return this.characterLookupTable.get(unicode) ?? null;
  }

  get fallbackFontAssetTable(): (FontAssetData | null)[] {
    if (!this.fallbackResolved) {
      for (const r of this.fallbackFontAssetRefs) this.fallbackFontAssetTableCache.push(r ? getFontAsset(this.assets, r, this.warnings) : null);
      this.fallbackResolved = true;
    }
    return this.fallbackFontAssetTableCache;
  }

  /** fontWeightTable（TMP_FontAsset.cs:390）：索引 1–9 對應 Thin–Black */
  fontWeightAt(weightIndex: number): { regularTypeface: FontAssetData | null; italicTypeface: FontAssetData | null } {
    const w = this.fontWeightRefs[weightIndex];
    if (!w) return { regularTypeface: null, italicTypeface: null };
    return {
      regularTypeface: w.regularTypeface ? getFontAsset(this.assets, w.regularTypeface, this.warnings) : null,
      italicTypeface: w.italicTypeface ? getFontAsset(this.assets, w.italicTypeface, this.warnings) : null,
    };
  }

  /** GetGlyphIndex（TMP_FontAsset.cs:1535）：查不到（靜態字型沒有 FontEngine 可問）回 0 */
  getGlyphIndex(unicode: number): number {
    return this.characterLookupTable.get(unicode)?.glyphIndex ?? 0;
  }

  /** GetGlyphVariantIndex（TMP_FontAsset.cs:1551）：需要 FontEngine，移植版拿不到變體，回 0 */
  getGlyphVariantIndex(_unicode: number, _variantSelectorUnicode: number): number {
    return 0;
  }

  /**
   * TryAddCharacterInternal（TMP_FontAsset.cs:2434）：動態字型缺字時即時加字。
   * 字形產生（FontEngine.TryAddGlyphToTexture）由 assets.addDynamicCharacter 做。
   */
  tryAddCharacterInternal(unicode: number): TextElementData | null {
    if (this.atlasPopulationMode !== AtlasPopulationMode.Dynamic && this.atlasPopulationMode !== AtlasPopulationMode.DynamicOS) return null;
    const added = this.assets.addDynamicCharacter(this.ref, unicode);
    if (!added) return this.trySynthesizeDynamic(unicode);
    const glyph = glyphFromJson(added.glyph);
    this.glyphLookupTable.set(glyph.index, glyph);
    const character: TextElementData = {
      elementType: TextElementType.Character,
      unicode: added.character.m_Unicode as number,
      glyphIndex: added.character.m_GlyphIndex as number,
      scale: (added.character.m_Scale as number) ?? 1,
      glyph,
      textAsset: this,
    };
    this.characterLookupTable.set(unicode, character);
    return character;
  }

  /** TryAddGlyphInternal（TMP_FontAsset.cs:2291）：只能加已在表裡的；動態字型的 FontEngine 加字移植版不做（變體選擇子用的） */
  tryAddGlyphInternal(glyphIndex: number): GlyphData | null {
    return this.glyphLookupTable.get(glyphIndex) ?? null;
  }
}

// ───────── TMP_SpriteAsset ─────────

export class SpriteAssetData {
  readonly id: string;
  readonly ref: ExternalRef;
  readonly name: string;
  readonly faceInfo: FaceInfo;
  readonly material: MaterialView;
  readonly spriteSheet: ExternalRef | null;
  readonly spriteCharacterTable: TextElementData[] = [];
  readonly spriteCharacterLookupTable = new Map<number, TextElementData>();
  private readonly nameLookup = new Map<number, number>();
  readonly fallbackSpriteAssetRefs: (ExternalRef | null)[];
  private fallbackCache: (SpriteAssetData | null)[] = [];
  private fallbackResolved = false;

  constructor(
    readonly assets: TextAssets,
    ref: ExternalRef,
    data: RawObject,
    private readonly warnings: string[],
  ) {
    this.ref = ref;
    this.id = ref.guid;
    this.name = (data.m_Name as string) ?? ref.guid;
    this.faceInfo = faceInfoFromJson(data.m_FaceInfo as RawObject);
    const matRef = assetMaterialRef(data);
    this.material = new MaterialView(matRef, matRef ? assets.material(matRef) : null);
    const sheet = data.spriteSheet as ExternalRef | null;
    this.spriteSheet = sheet?.guid ? sheet : null;
    const glyphs = new Map<number, GlyphData>();
    // 字形表的欄位名：TMP 3.x（MT2，Unity 2022.3）序列化成 m_SpriteGlyphTable，新版（TMP_Asset 基底）是 m_GlyphTable。
    // 以前只讀後者，MT2 的 sprite asset 整張表是空的，<sprite name="Gold"> 變成原始文字
    for (const g of ((data.m_GlyphTable ?? data.m_SpriteGlyphTable) as RawObject[]) ?? []) {
      const gd = glyphFromJson(g);
      glyphs.set(gd.index, gd);
    }
    for (const c of (data.m_SpriteCharacterTable as RawObject[]) ?? []) {
      const glyphIndex = c.m_GlyphIndex as number;
      const glyph = glyphs.get(glyphIndex);
      if (!glyph) continue;
      const el: TextElementData = {
        elementType: TextElementType.Sprite,
        unicode: c.m_Unicode as number,
        glyphIndex,
        scale: (c.m_Scale as number) ?? 1,
        glyph,
        textAsset: this,
        name: c.m_Name as string,
      };
      this.spriteCharacterTable.push(el);
      if (!this.spriteCharacterLookupTable.has(el.unicode)) this.spriteCharacterLookupTable.set(el.unicode, el);
      if (el.name) {
        const h = getHashCode(el.name);
        if (!this.nameLookup.has(h)) this.nameLookup.set(h, this.spriteCharacterTable.length - 1);
      }
    }
    this.fallbackSpriteAssetRefs = ((data.fallbackSpriteAssets as (ExternalRef | null)[]) ?? []).map((r) => (r && r.guid ? r : null));
  }

  get fallbackSpriteAssets(): (SpriteAssetData | null)[] {
    if (!this.fallbackResolved) {
      for (const r of this.fallbackSpriteAssetRefs) this.fallbackCache.push(r ? getSpriteAsset(this.assets, r, this.warnings) : null);
      this.fallbackResolved = true;
    }
    return this.fallbackCache;
  }

  /** GetSpriteIndexFromHashcode（TMP_SpriteAsset.cs:196） */
  getSpriteIndexFromHashcode(hashCode: number): number {
    return this.nameLookup.get(hashCode) ?? -1;
  }

  /** GetSpriteIndexFromUnicode（TMP_SpriteAsset.cs:215） */
  getSpriteIndexFromUnicode(unicode: number): number {
    const el = this.spriteCharacterLookupTable.get(unicode);
    return el ? this.spriteCharacterTable.indexOf(el) : -1;
  }

  /**
   * spriteSheet 的像素尺寸。TextAssets 介面拿不到 textures.json（0b 沒有從這個介面露貼圖尺寸），
   * 先問 assets.object(spriteSheet)（之後介面擴充時優先），否則用 glyph rect 的最大範圍
   * （本遊戲四個 sprite asset 的 glyph 都剛好鋪滿 sheet，實測 768×512／512×512 一致），並記 warning。
   */
  private sheetSizeCache: { width: number; height: number } | null = null;
  get spriteSheetSize(): { width: number; height: number } {
    if (this.sheetSizeCache) return this.sheetSizeCache;
    const texObj = this.spriteSheet ? this.assets.object(this.spriteSheet) : null;
    if (texObj && typeof texObj.width === 'number' && typeof texObj.height === 'number') {
      this.sheetSizeCache = { width: texObj.width as number, height: texObj.height as number };
      return this.sheetSizeCache;
    }
    let w = 0;
    let h = 0;
    for (const g of this.glyphLookupTableValues()) {
      w = Math.max(w, g.glyphRect.x + g.glyphRect.width);
      h = Math.max(h, g.glyphRect.y + g.glyphRect.height);
    }
    this.warnings.push(`TMP_SpriteAsset ${this.name} 的 spriteSheet 尺寸從 TextAssets 介面拿不到，用 glyph rect 最大範圍 ${w}×${h} 代替`);
    this.sheetSizeCache = { width: w, height: h };
    return this.sheetSizeCache;
  }
  private glyphLookupTableValues(): GlyphData[] {
    const out: GlyphData[] = [];
    for (const el of this.spriteCharacterTable) out.push(el.glyph);
    return out;
  }
}

// ───────── TMP_ColorGradient ─────────

/** TMP_ColorGradient（TMP_ColorGradient.cs） */
export interface ColorGradientData {
  topLeft: Color32;
  topRight: Color32;
  bottomLeft: Color32;
  bottomRight: Color32;
}

// ───────── TMP_StyleSheet／TMP_Style ─────────

/** TMP_Style（TMP_Style.cs）：tag 陣列是 uint 清單（匯入時是 hex 字串，4 bytes LE 一個 uint） */
export interface StyleData {
  name: string;
  hashCode: number;
  styleOpeningTagArray: number[];
  styleClosingTagArray: number[];
}

function tagArrayFromJson(v: unknown): number[] {
  if (typeof v === 'string') {
    const out: number[] = [];
    for (let i = 0; i + 8 <= v.length; i += 8) out.push(parseInt(v.slice(i, i + 8), 16) >>> 0);
    return out;
  }
  if (Array.isArray(v)) return v as number[];
  return [];
}

export class StyleSheetData {
  private readonly lookup = new Map<number, StyleData>();

  constructor(data: RawObject | null) {
    for (const s of (data?.m_StyleList as RawObject[]) ?? []) {
      // m_HashCode 匯入後可能是字串（MT2 的 TMP 3.x 樣式表："2451216"），以前直接當數字查，Body 樣式永遠找不到，
      // <style="Body"> 整段畫成缺字符號、後面的上色位置也跟著偏。tag 陣列照 TMP_Style.RefreshStyle（TMP_Style.cs:97）由定義字串逐字算：
      // 匯出的 m_OpeningTagArray 只有前 10 個（"<color=#F2"），定義字串是完整的
      const name = s.m_Name as string;
      const hash = Number(s.m_HashCode);
      const codes = (def: unknown, raw: unknown) => (typeof def === 'string' ? Array.from({ length: def.length }, (_, i) => def.charCodeAt(i)) : tagArrayFromJson(raw));
      const style: StyleData = {
        name,
        hashCode: Number.isFinite(hash) ? hash : getHashCode(name),
        styleOpeningTagArray: codes(s.m_OpeningDefinition, s.m_OpeningTagArray),
        styleClosingTagArray: codes(s.m_ClosingDefinition, s.m_ClosingTagArray),
      };
      if (!this.lookup.has(style.hashCode)) this.lookup.set(style.hashCode, style);
    }
    // LoadStyleDictionaryInternal（TMP_StyleSheet.cs:77）：沒有 Normal 就補一個空的
    const normalHash = getHashCode('Normal');
    if (!this.lookup.has(normalHash)) this.lookup.set(normalHash, { name: 'Normal', hashCode: normalHash, styleOpeningTagArray: [], styleClosingTagArray: [] });
  }

  getStyle(hashCode: number): StyleData | null {
    return this.lookup.get(hashCode) ?? null;
  }
}

// ───────── TMP_Settings ─────────

export class SettingsData {
  readonly data: RawObject;
  constructor(data: RawObject) {
    this.data = data;
  }
  get missingGlyphCharacter(): number {
    return (this.data.m_missingGlyphCharacter as number) ?? 0;
  }
  get warningsDisabled(): boolean {
    return !!this.data.m_warningsDisabled;
  }
  get matchMaterialPreset(): boolean {
    return !!this.data.m_matchMaterialPreset;
  }
  get useModernHangulLineBreakingRules(): boolean {
    return !!this.data.m_UseModernHangulLineBreakingRules;
  }
  get defaultFontAssetRef(): ExternalRef | null {
    const r = this.data.m_defaultFontAsset as ExternalRef | null;
    return r?.guid ? r : null;
  }
  get defaultFontAssetPath(): string {
    return (this.data.m_defaultFontAssetPath as string) ?? '';
  }
  get defaultSpriteAssetRef(): ExternalRef | null {
    const r = this.data.m_defaultSpriteAsset as ExternalRef | null;
    return r?.guid ? r : null;
  }
  get defaultSpriteAssetPath(): string {
    return (this.data.m_defaultSpriteAssetPath as string) ?? '';
  }
  get defaultColorGradientPresetsPath(): string {
    return (this.data.m_defaultColorGradientPresetsPath as string) ?? '';
  }
  get defaultStyleSheetRef(): ExternalRef | null {
    const r = this.data.m_defaultStyleSheet as ExternalRef | null;
    return r?.guid ? r : null;
  }
  get fallbackFontAssetRefs(): ExternalRef[] {
    return ((this.data.m_fallbackFontAssets as ExternalRef[]) ?? []).filter((r) => r?.guid);
  }
  get emojiFallbackTextAssetRefs(): ExternalRef[] {
    return ((this.data.m_EmojiFallbackTextAssets as ExternalRef[]) ?? []).filter((r) => r?.guid);
  }
  get missingCharacterSpriteUnicode(): number {
    return (this.data.m_MissingCharacterSpriteUnicode as number) ?? 0;
  }
  /** linebreakingRules（TMP_Settings.cs:394）：leading／following characters 的 HashSet（texts.json；去掉 BOM，TextAsset.text 會去 BOM） */
  private linebreakingRulesCache: { leadingCharacters: Set<number>; followingCharacters: Set<number> } | null = null;
  linebreakingRules(assets: TextAssets): { leadingCharacters: Set<number>; followingCharacters: Set<number> } {
    if (!this.linebreakingRulesCache) {
      const read = (r: ExternalRef | null): Set<number> => {
        const set = new Set<number>();
        const text = r?.guid ? assets.textAsset(r) : null;
        if (text) {
          const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
          for (let i = 0; i < t.length; i++) set.add(t.charCodeAt(i));
        }
        return set;
      };
      this.linebreakingRulesCache = {
        leadingCharacters: read(this.data.m_leadingCharacters as ExternalRef | null),
        followingCharacters: read(this.data.m_followingCharacters as ExternalRef | null),
      };
    }
    return this.linebreakingRulesCache;
  }
}

// ───────── 資產 cache（GetInstanceID 語義：同 guid 同一份） ─────────

const fontAssetCache = new WeakMap<TextAssets, Map<string, FontAssetData | null>>();
const spriteAssetCache = new WeakMap<TextAssets, Map<string, SpriteAssetData | null>>();
const styleSheetCache = new WeakMap<TextAssets, Map<string, StyleSheetData | null>>();
const colorGradientCache = new WeakMap<TextAssets, Map<string, ColorGradientData | null>>();
const materialCache = new WeakMap<TextAssets, Map<string, MaterialView | null>>();
const settingsCache = new WeakMap<TextAssets, SettingsData>();
/** 每個 TextAssets 實例的 warning 清單（generateText 會收進 TextMeshResult.warnings） */
const assetWarnings = new WeakMap<TextAssets, string[]>();

export function warningsOf(assets: TextAssets): string[] {
  let w = assetWarnings.get(assets);
  if (!w) assetWarnings.set(assets, (w = []));
  return w;
}

export function getSettings(assets: TextAssets): SettingsData {
  let s = settingsCache.get(assets);
  if (!s) settingsCache.set(assets, (s = new SettingsData(assets.settings)));
  return s;
}

export function getMaterial(assets: TextAssets, ref: ExternalRef | null): MaterialView | null {
  if (!ref?.guid) return null;
  let cache = materialCache.get(assets);
  if (!cache) materialCache.set(assets, (cache = new Map()));
  if (!cache.has(ref.guid)) {
    const rec = assets.material(ref);
    cache.set(ref.guid, rec ? new MaterialView(ref, rec) : null);
  }
  return cache.get(ref.guid) ?? null;
}

/**
 * TMP_Asset 的材質參照。TMP 3.2 預覽版（Diceomancer 的 reference/tmp-src/pre.4，TMP_Asset.cs:23 internal Material m_Material）
 * 序列化成 m_Material；MT2 的 Unity.TextMeshPro 匯出的字型資產欄位是 material（舊版的 public Material material）。兩個都認
 *（MT2 的粗體字重 PTSansNarrowBold SDF 以前讀不到材質，GetFallbackMaterial 複製出空材質，粗體字整段沒畫）
 */
function assetMaterialRef(data: RawObject): ExternalRef | null {
  const r = (data.m_Material ?? data.material) as ExternalRef | null | undefined;
  return r?.guid ? r : null;
}

export function getFontAsset(assets: TextAssets, ref: ExternalRef | null, warnings = warningsOf(assets)): FontAssetData | null {
  if (!ref?.guid) return null;
  let cache = fontAssetCache.get(assets);
  if (!cache) fontAssetCache.set(assets, (cache = new Map()));
  if (!cache.has(ref.guid)) {
    const data = assets.object(ref);
    cache.set(ref.guid, data ? new FontAssetData(assets, ref, data, warnings) : null);
    if (!data) warnings.push(`TMP_FontAsset ${ref.guid} 找不到`);
  }
  return cache.get(ref.guid) ?? null;
}

export function getSpriteAsset(assets: TextAssets, ref: ExternalRef | null, warnings = warningsOf(assets)): SpriteAssetData | null {
  if (!ref?.guid) return null;
  let cache = spriteAssetCache.get(assets);
  if (!cache) spriteAssetCache.set(assets, (cache = new Map()));
  if (!cache.has(ref.guid)) {
    const data = assets.object(ref);
    cache.set(ref.guid, data ? new SpriteAssetData(assets, ref, data, warnings) : null);
    if (!data) warnings.push(`TMP_SpriteAsset ${ref.guid} 找不到`);
  }
  return cache.get(ref.guid) ?? null;
}

export function getStyleSheet(assets: TextAssets, ref: ExternalRef | null): StyleSheetData | null {
  if (!ref?.guid) return null;
  let cache = styleSheetCache.get(assets);
  if (!cache) styleSheetCache.set(assets, (cache = new Map()));
  if (!cache.has(ref.guid)) {
    const data = assets.object(ref);
    cache.set(ref.guid, data ? new StyleSheetData(data) : null);
  }
  return cache.get(ref.guid) ?? null;
}

export function getColorGradient(assets: TextAssets, ref: ExternalRef | null): ColorGradientData | null {
  if (!ref?.guid) return null;
  let cache = colorGradientCache.get(assets);
  if (!cache) colorGradientCache.set(assets, (cache = new Map()));
  if (!cache.has(ref.guid)) {
    const data = assets.object(ref);
    cache.set(
      ref.guid,
      data
        ? {
            topLeft: colorFromJson(data.topLeft),
            topRight: colorFromJson(data.topRight),
            bottomLeft: colorFromJson(data.bottomLeft),
            bottomRight: colorFromJson(data.bottomRight),
          }
        : null,
    );
  }
  return cache.get(ref.guid) ?? null;
}

function colorFromJson(c: unknown): Color32 {
  const o = (c ?? {}) as { r?: number; g?: number; b?: number; a?: number };
  return color32(o.r ?? 0, o.g ?? 0, o.b ?? 0, o.a ?? 0);
}

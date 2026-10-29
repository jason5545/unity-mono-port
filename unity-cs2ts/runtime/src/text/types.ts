// TMP 排版模組的邊界（Claude Code 定）。資料都是 0b／0c 匯出的原始 JSON，欄位名稱照 Unity 序列化。
//
// 模組要匯出（名稱固定，繪製端與排版端照這個接）：
//   generateText(component, ctx, assets): TextMeshResult
//     TextMeshProUGUI／TextMeshPro 的 GenerateTextMesh（含外圍的 auto size 迴圈）
//   getPreferredWidth(component, ctx, assets): number
//   getPreferredHeight(component, ctx, assets): number
//     TMP_Text.preferredWidth／preferredHeight（TMP_Text.cs:3624、3698），uGUI 的 LayoutGroup／ContentSizeFitter 用
//   getPreferredValues(component, width, height, ctx, assets): { x: number; y: number }
//     TMP_Text.GetPreferredValues(width, height)（TMP_Text.cs:3554），遊戲程式碼用
import type { ColorRGBA, ExternalRef } from '../unity/types';

export type RawObject = Record<string, unknown>;

/** TextMeshProUGUI／TextMeshPro 元件（public/game/scenes/*.json，在地化已套用） */
export type TmpComponentData = RawObject;

export interface TextAssets {
  /** monobehaviours 的物件（TMP_FontAsset、TMP_SpriteAsset、TMP_StyleSheet、TMP_ColorGradient），即 public/game/assets/objects/<guid>.json */
  object(ref: ExternalRef): RawObject | null;
  /** materials.json 的記錄 */
  material(ref: ExternalRef): RawObject | null;
  /** texts.json 的 text（換行規則的 TextAsset） */
  textAsset(ref: ExternalRef): string | null;
  /** Resources.Load：路徑不分大小寫、不含副檔名，例如 'Fonts & Materials/Jua-Regular SDF'；找不到回 null */
  resource(path: string, kind: 'TMP_FontAsset' | 'Material' | 'TMP_SpriteAsset' | 'TMP_ColorGradient' | 'TMP_StyleSheet'): { ref: ExternalRef; data: RawObject } | null;
  /** TMP Settings（monobehaviours 的 1ef33ef2ba3054448b22726c1476ec0e） */
  settings: RawObject;
  /** 動態字型缺字時呼叫：繪製端產生 glyph，回傳要加進字型的 character 與 glyph（欄位格式同 m_CharacterTable／m_GlyphTable），做不到回 null */
  addDynamicCharacter(font: ExternalRef, unicode: number): { character: RawObject; glyph: RawObject } | null;
}

export interface TextContext {
  /** RectTransform.rect（pivot 是原點） */
  rect: { x: number; y: number; width: number; height: number };
  /** transform.lossyScale.y */
  lossyScaleY: number;
  /** UGUI：所在 Canvas；3D 版（TextMeshPro）給 null */
  canvas: { renderMode: 0 | 1 | 2; scaleFactor: number; worldCameraAssigned: boolean } | null;
  /** 3D 版用：攝影機是否正交（UGUI 版原始碼一律 true） */
  isOrthographic: boolean;
  /** QualitySettings.activeColorSpace == Linear。3D 版靠它決定 m_ConvertToLinearSpace（TMPro_Private.cs:3984）；本專案是 true */
  linearColorSpace: boolean;
}

export interface TextSubMesh {
  /** 0 = 主網格（元件的材質），其他 = TMP_SubMeshUI／TMP_SubMesh（fallback 字型、sprite），照 TMP 的 materialReferenceIndex */
  materialIndex: number;
  fontAsset: ExternalRef | null;
  spriteAsset: ExternalRef | null;
  /** 這個子網格實際用的材質：fallback 照 GetFallbackMaterial 複製過、_ScaleRatioA/B/C 照 UpdateShaderRatios 算過 */
  material: {
    source: ExternalRef | null;
    /** 材質的 shader（m_Shader）。fallback 的執行時實例保留來源材質的 shader（GetFallbackMaterial），source 是 null 時用這個解析 */
    shader: ExternalRef | null;
    floats: Record<string, number>;
    colors: Record<string, ColorRGBA>;
    textures: Record<string, ExternalRef | null>;
    keywords: string[];
  };
  positions: Float32Array; // xyz，物件區域座標
  colors: Uint8Array; // rgba（Color32）
  uvs0: Float32Array; // xyzw
  uvs2: Float32Array; // xy
  indices: Uint32Array;
}

type V2 = { x: number; y: number };
type V3 = { x: number; y: number; z: number };

/** TMP_CharacterInfo（TMP_CharacterInfo.cs），名稱照 C# 的 public 欄位。位置是對齊之後的（GenerateTextMesh 第二階段加過 offset） */
export interface TmpCharacterInfo {
  /** char（UTF-16 單位） */
  character: number;
  index: number;
  stringLength: number;
  elementType: number;
  materialReferenceIndex: number;
  lineNumber: number;
  pageNumber: number;
  vertexIndex: number;
  isVisible: boolean;
  origin: number;
  xAdvance: number;
  ascender: number;
  baseLine: number;
  descender: number;
  pointSize: number;
  scale: number;
  style: number;
  color: { r: number; g: number; b: number; a: number };
  bottomLeft: V3;
  topLeft: V3;
  topRight: V3;
  bottomRight: V3;
}

/** TMP_LineInfo（TMP_LineInfo.cs） */
export interface TmpLineInfo {
  characterCount: number;
  visibleCharacterCount: number;
  spaceCount: number;
  visibleSpaceCount: number;
  wordCount: number;
  firstCharacterIndex: number;
  firstVisibleCharacterIndex: number;
  lastCharacterIndex: number;
  lastVisibleCharacterIndex: number;
  length: number;
  lineHeight: number;
  ascender: number;
  baseline: number;
  descender: number;
  maxAdvance: number;
  width: number;
  marginLeft: number;
  marginRight: number;
  alignment: number;
  lineExtents: { min: V2; max: V2 };
}

/** TMP_WordInfo、TMP_LinkInfo、TMP_PageInfo（TMPro_MeshUtilities.cs）照 C# 的 public 欄位；linkId／linkText 是 GetLinkID()／GetLinkText() 的結果。
 *  遊戲程式碼用 linkInfo 做 <link> 的提示框 */
export interface TmpTextInfo {
  characterCount: number;
  spriteCount: number;
  spaceCount: number;
  wordCount: number;
  linkCount: number;
  lineCount: number;
  pageCount: number;
  materialCount: number;
  characterInfo: TmpCharacterInfo[];
  lineInfo: TmpLineInfo[];
  wordInfo: { firstCharacterIndex: number; lastCharacterIndex: number; characterCount: number }[];
  linkInfo: { hashCode: number; linkIdFirstCharacterIndex: number; linkIdLength: number; linkTextfirstCharacterIndex: number; linkTextLength: number; linkId: string; linkText: string }[];
  pageInfo: { firstCharacterIndex: number; lastCharacterIndex: number; ascender: number; baseLine: number; descender: number }[];
}

export interface TextMeshResult {
  subMeshes: TextSubMesh[];
  /** TMP_Text.textInfo（長度照 characterCount、lineCount 等截掉，不含 TMP 預先配置的空位） */
  textInfo: TmpTextInfo;
  /** auto size 之後實際的字級 */
  fontSize: number;
  preferredWidth: number;
  preferredHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  characterCount: number;
  lineCount: number;
  isTextOverflowing: boolean;
  isTextTruncated: boolean;
  /** 沒移植或做不到的功能、缺字（含字元與字型）。不准默默略過 */
  warnings: string[];
}

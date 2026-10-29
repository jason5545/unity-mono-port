// 匯入產物（public/game/scenes、public/game/assets）的 JSON 形狀。欄位名稱照 Unity 序列化，只列用到的，用到哪裡補到哪裡。
// 格式說明在 scripts/import/scenes.py、assets.py 的檔頭。
import type { MeshAssetRecord } from './meshes';

export interface Vec2 {
  x: number;
  y: number;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Vec4 {
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface ColorRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}
export interface RectData {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** PPtr：外部 {guid, fileID}、同檔 {fileID}、空 null。fileID 一律是字串（常超過 2^53） */
export type Ref = { guid: string; fileID: string } | { fileID: string } | null;
export type ExternalRef = { guid: string; fileID: string };

export function isExternal(r: Ref): r is ExternalRef {
  return r !== null && 'guid' in r;
}

// ───────── 場景 ─────────

export interface ScriptInfo {
  assembly?: string;
  namespace?: string;
  class?: string;
  source?: string;
  missing?: string;
}

export interface ComponentData {
  type: string;
  classID: number;
  gameObject: string;
  script?: ScriptInfo | null;
  m_Enabled?: number;
  [field: string]: unknown;
}

export interface GameObjectData {
  m_Name: string;
  m_IsActive: number;
  m_Layer: number;
  m_TagString: string;
  transform: string;
  parent: string | null;
  children: string[];
  components: string[];
}

export interface SceneFile {
  guid: string;
  name: string;
  src: string;
  roots: string[];
  gameObjects: Record<string, GameObjectData>;
  components: Record<string, ComponentData>;
  settings: Record<string, unknown>;
}

export interface TransformData extends ComponentData {
  m_LocalPosition: Vec3;
  m_LocalRotation: Quat;
  m_LocalScale: Vec3;
  m_Father: Ref;
  m_Children: Ref[];
}

export interface RectTransformData extends TransformData {
  m_AnchorMin: Vec2;
  m_AnchorMax: Vec2;
  m_AnchoredPosition: Vec2;
  m_SizeDelta: Vec2;
  m_Pivot: Vec2;
}

// ───────── 素材 ─────────

export interface TextureRecord {
  name: string;
  file: string;
  width: number;
  height: number;
  /** Texture2DArray 的層數（從原版 build 讀；PNG 是各層由上往下直排，width × height 是整張圖） */
  depth?: number;
  importer: {
    filterMode?: number; // 0 Point、1 Bilinear、2 Trilinear
    wrapU?: number; // 0 Repeat、1 Clamp、2 Mirror
    wrapV?: number;
    sRGBTexture?: number;
    enableMipMap?: number;
    textureShape?: number; // 2 Texture2D、4 Texture2DArray
  };
}

export interface SpriteRecord {
  m_Name: string;
  m_Rect: RectData;
  m_Pivot: Vec2;
  m_Border: Vec4;
  m_PixelsToUnits: number;
  m_Extrude: number;
  /** 所屬 SpriteAtlas 名稱；非空代表已打包（Sprite.packed 的代理欄位，0b 匯出沒給 m_Packed） */
  m_SpriteAtlas?: string | null;
  m_RD: {
    texture: ExternalRef;
    textureRect: RectData;
    textureRectOffset: Vec2;
    uvTransform: Vec4;
  };
  vertexCount: number;
  mesh: string;
}

export interface SpriteMeshRecord {
  vertexCount: number;
  indices: number[];
  position: number[]; // x, y, z 交錯，單位是 Unity 世界單位（像素 / ppu）
}

export interface MaterialRecord {
  m_Name: string;
  shaderName: string | null;
  builtinShader?: { resources: string; fileID: string };
  m_CustomRenderQueue: number;
  m_ValidKeywords?: string[];
  m_SavedProperties: {
    m_TexEnvs: Record<string, { m_Texture: Ref; m_Scale: Vec2; m_Offset: Vec2 }>;
    m_Floats: Record<string, number>;
    m_Colors: Record<string, ColorRGBA>;
    m_Ints?: Record<string, number>;
  };
}

export interface BuiltinRecord {
  type: 'Sprite' | 'Material' | 'Mesh';
  name: string;
  build: string;
  texture?: { name: string; file: string; width: number; height: number; filterMode: number; wrapU: number; wrapV: number; colorSpace: number };
  mesh?: { vertexCount: number; indices: number[]; position: number[] };
  sprite?: Omit<SpriteRecord, 'vertexCount' | 'mesh' | 'm_RD'> & { m_RD: Omit<SpriteRecord['m_RD'], 'texture'> };
  shaderName?: string;
  material?: Omit<MaterialRecord, 'shaderName'>;
  /** 內建網格（unity default resources 的 Quad、Cube…）：同 meshes.json 的格式 */
  meshAsset?: MeshAssetRecord;
}

export interface SortingLayer {
  name: string;
  uniqueID: number;
}

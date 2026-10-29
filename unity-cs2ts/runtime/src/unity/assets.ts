// 素材資料庫：讀 public/game/assets 的表，依 PPtr（guid + fileID）找素材。
// Unity 內建資源（guid 0000000000000000f000000000000000）查 builtin.json，key 是 "<guid>:<fileID>"。

import * as THREE from 'three';
import type { SpriteForMesh } from '../ui/imageMesh';
import { meshKeyOf, registerMeshAssets, type MeshAssetRecord } from './meshes';
import { fetchJsonCached } from './packs';
import { registerPhysicMaterials, type PhysicMaterialRecord } from './physicMaterials';
import { decodePngRgba8, stackedLayers } from './png';
import type {
  BuiltinRecord,
  MaterialRecord,
  Ref,
  SortingLayer,
  SpriteMeshRecord,
  SpriteRecord,
  TextureRecord,
} from './types';
import { isExternal } from './types';

export interface ProjectSettings {
  TagManager: { TagManager: { m_SortingLayers: SortingLayer[] } };
  QualitySettings: { QualitySettings: { m_CurrentQuality: number; m_QualitySettings: { name: string; customRenderPipeline: Ref }[] } };
  GraphicsSettings: { GraphicsSettings: { m_CustomRenderPipeline: Ref } };
}

/**
 * 2D 貼圖的影像載入（render thread 開著時換成 RenderThread.loadImage：主執行緒只抓 PNG 位元組，解碼在 worker）。
 * null 是照舊用 THREE.TextureLoader（<img>）
 */
let imageLoader: ((url: string) => Promise<{ width: number; height: number }>) | null = null;
export function setImageLoader(fn: typeof imageLoader): void {
  imageLoader = fn;
}

/** 跟 THREE.TextureLoader.load 一樣的順序：Texture 先建（id 照呼叫順序配），影像到了才設 image、needsUpdate */
function loadTexture(url: string): Promise<THREE.Texture> {
  if (!imageLoader) return new THREE.TextureLoader().loadAsync(url);
  const tex = new THREE.Texture();
  return imageLoader(url).then((img) => {
    tex.image = img;
    tex.needsUpdate = true;
    return tex;
  });
}

/** 繪製用的 sprite：網格生成要的欄位 + 貼圖 + SpriteRenderer 用的網格 */
export interface SpriteInfo extends SpriteForMesh {
  name: string;
  pivot: { x: number; y: number };
  uvTransform: { x: number; y: number; z: number; w: number };
  textureKey: string;
  meshUrl?: string; // sprite-meshes/<guid>.json
  inlineMesh?: SpriteMeshRecord; // 內建 sprite 的網格直接在 builtin.json
}

export interface TextureInfo {
  url: string;
  width: number;
  height: number;
  filterMode: number;
  wrapU: number;
  wrapV: number;
  sRGB: boolean;
  mipmaps: boolean;
  /** Texture2DArray（匯入設定 textureShape 4）才有：層數；沒有層數的 Texture2DArray 是 null（舊的匯入，要重跑 npm run import） */
  depth?: number | null;
}

export interface MaterialInfo {
  name: string;
  shaderName: string | null;
  record: Omit<MaterialRecord, 'shaderName'>;
}

// 表與 MonoBehaviour 資產跟物件庫、TMP 素材共用同一份（packs.ts）
const fetchJson = fetchJsonCached;

/** textureKeysIn 查資產用的介面（AssetDB 實作；測試給假的） */
export interface TextureKeyLookup {
  sprite(ref: Ref): { textureKey: string } | null;
  material(ref: Ref): { record: Pick<MaterialRecord, 'm_SavedProperties'> } | null;
  hasTexture(guid: string): boolean;
}

/**
 * 元件資料裡參照到的貼圖 key：Sprite 的圖（m_RD.texture）、Material 各貼圖屬性的圖、直接參照的 Texture。
 * 執行期新增的子樹排進建置佇列時先開始讀（SceneRenderer.prefetchSubtree）：讀貼圖不必跟著佇列一個一個等。
 * 只往下走 depth 層、走過的物件不重走（腳本元件的欄位可能指到執行期的大物件）。
 */
export function textureKeysIn(value: unknown, db: TextureKeyLookup, out: Set<string> = new Set(), seen: Set<object> = new Set(), depth = 6): Set<string> {
  if (!value || typeof value !== 'object' || depth < 0 || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) textureKeysIn(v, db, out, seen, depth - 1);
    return out;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.guid === 'string' && 'fileID' in rec) {
    const ref = rec as unknown as Ref;
    const guid = rec.guid;
    const sprite = db.sprite(ref);
    if (sprite) {
      out.add(sprite.textureKey);
      return out;
    }
    const mat = db.material(ref);
    if (mat) {
      for (const env of Object.values(mat.record.m_SavedProperties?.m_TexEnvs ?? {})) {
        const t = env?.m_Texture as { guid?: unknown } | null | undefined;
        if (t && typeof t.guid === 'string' && db.hasTexture(t.guid)) out.add(t.guid);
      }
      return out;
    }
    if (db.hasTexture(guid)) out.add(guid);
    return out;
  }
  for (const v of Object.values(rec)) textureKeysIn(v, db, out, seen, depth - 1);
  return out;
}

export class AssetDB {
  private textureCache = new Map<string, Promise<THREE.Texture>>();
  private objectCache = new Map<string, Promise<Record<string, unknown>>>();
  private monoIndex: Promise<Record<string, { name: string; file: string; kind: string | null }>> | null = null;
  private shaderNames: Promise<Record<string, { name: string }>> | null = null;
  private meshCache = new Map<string, Promise<SpriteMeshRecord>>();

  private constructor(
    readonly base: string,
    private textures: Record<string, TextureRecord>,
    private sprites: Record<string, SpriteRecord>,
    private materials: Record<string, MaterialRecord>,
    private builtin: Record<string, BuiltinRecord>,
    readonly sortingLayers: SortingLayer[],
    readonly project: ProjectSettings,
  ) {}

  /** base 是 public/game/assets 的網址，例如 "./game/assets/" */
  static async load(base: string): Promise<AssetDB> {
    const [textures, sprites, materials, builtin, project] = await Promise.all([
      fetchJson<Record<string, TextureRecord>>(`${base}textures.json`),
      fetchJson<Record<string, SpriteRecord>>(`${base}sprites.json`),
      fetchJson<Record<string, MaterialRecord>>(`${base}materials.json`),
      fetchJson<Record<string, BuiltinRecord>>(`${base}builtin.json`),
      fetchJson<ProjectSettings>(`${base}project.json`),
    ]);
    // 內建網格（Quad、Cube…）跟 builtin.json 一起到，先登記：MeshFilter.mesh 是同步的，不等 meshes.json
    const builtinMeshes: Record<string, MeshAssetRecord> = {};
    for (const [k, b] of Object.entries(builtin)) if (b.type === 'Mesh' && b.meshAsset) builtinMeshes[k] = b.meshAsset;
    registerMeshAssets(builtinMeshes);
    return new AssetDB(base, textures, sprites, materials, builtin, project.TagManager.TagManager.m_SortingLayers, project);
  }

  private meshesPromise: Promise<Record<string, MeshAssetRecord>> | null = null;
  private meshIndexPromise: Promise<Set<string> | null> | null = null;
  private physicMaterialsPromise: Promise<Record<string, PhysicMaterialRecord>> | null = null;

  /** 舊的匯入：整包 meshes.json（guid → Mesh）。讀進來同時登記給同步取用（unity/meshes.ts） */
  meshes(): Promise<Record<string, MeshAssetRecord>> {
    this.meshesPromise ??= fetchJson<Record<string, MeshAssetRecord>>(`${this.base}meshes.json`).then((rec) => {
      registerMeshAssets(rec);
      return rec;
    });
    return this.meshesPromise;
  }

  /** meshes/index.json（一個網格一個檔的匯入）的 guid；舊的匯入沒有這個檔，回 null */
  private meshIndex(): Promise<Set<string> | null> {
    this.meshIndexPromise ??= fetchJson<string[]>(`${this.base}meshes/index.json`).then(
      (list) => new Set(list),
      () => null,
    );
    return this.meshIndexPromise;
  }

  /**
   * 確保這個網格參照的資產已經登記（meshAssetOf 同步取得到）：已經登記的（內建網格、物件庫預載的閉包）直接回；
   * 一個網格一個檔的匯入只抓這一個（meshes/<guid>.json），舊的匯入整包 meshes.json 讀一次
   */
  async mesh(ref: { guid?: string; fileID?: string | number } | null | undefined): Promise<void> {
    if (!ref?.guid || meshKeyOf(ref)) return;
    const index = await this.meshIndex();
    if (!index) {
      await this.meshes();
      return;
    }
    if (!index.has(ref.guid)) return;
    const guid = ref.guid;
    const rec = await fetchJson<MeshAssetRecord>(`${this.base}meshes/${guid}.json`);
    registerMeshAssets({ [guid]: rec });
  }

  /** PhysicMaterial（physicMaterials.json）。讀進來同時登記給物理（engine/physics.ts） */
  physicMaterials(): Promise<Record<string, PhysicMaterialRecord>> {
    this.physicMaterialsPromise ??= fetchJson<Record<string, PhysicMaterialRecord>>(`${this.base}physicMaterials.json`).then((rec) => {
      registerPhysicMaterials(rec);
      return rec;
    });
    return this.physicMaterialsPromise;
  }

  /** MonoBehaviour 資產（objects/<guid>.json），例如 URP 設定、Renderer2DData */
  object<T = Record<string, unknown>>(guid: string): Promise<T> {
    let p = this.objectCache.get(guid);
    if (!p) {
      this.monoIndex ??= fetchJson(`${this.base}monobehaviours.json`);
      p = this.monoIndex.then((idx) => {
        const m = idx[guid];
        if (!m) throw new Error(`monobehaviours.json 裡沒有 ${guid}`);
        return fetchJson<Record<string, unknown>>(`${this.base}${m.file}`);
      });
      this.objectCache.set(guid, p);
    }
    return p as Promise<T>;
  }

  /** shader 的 GUID（主匯出的）→ 名稱 */
  async shaderName(guid: string): Promise<string | null> {
    this.shaderNames ??= fetchJson(`${this.base}shaders.json`);
    return (await this.shaderNames)[guid]?.name ?? null;
  }

  /**
   * 攝影機實際用的 renderer 設定（ScriptableRendererData）：
   * 目前品質等級的 URP 資產（沒有就用 GraphicsSettings 的）→ m_RendererDataList[攝影機的 m_RendererIndex，-1 用預設]。
   * level1 是品質 Ultra → URP2D → URP2D_Renderer（Renderer2DData）。
   */
  async rendererData(cameraRendererIndex: number): Promise<Record<string, unknown> | null> {
    const q = this.project.QualitySettings.QualitySettings;
    const pipeline = q.m_QualitySettings[q.m_CurrentQuality]?.customRenderPipeline ?? this.project.GraphicsSettings.GraphicsSettings.m_CustomRenderPipeline;
    if (!pipeline || !('guid' in pipeline)) return null;
    const urp = await this.object<{ m_RendererDataList: Ref[]; m_DefaultRendererIndex: number }>(pipeline.guid);
    const index = cameraRendererIndex < 0 ? urp.m_DefaultRendererIndex : cameraRendererIndex;
    const ref = urp.m_RendererDataList[index];
    return isExternal(ref) ? this.object(ref.guid) : null;
  }

  /** m_SortingLayerID（有號 int32）→ sorting layer 在清單裡的順序。uniqueID 是無號 32 位元，要轉 */
  sortingLayerIndex(id: number): number {
    const u = id >>> 0;
    const i = this.sortingLayers.findIndex((l) => l.uniqueID >>> 0 === u);
    return i < 0 ? 0 : i;
  }

  private builtinOf(ref: Ref): BuiltinRecord | undefined {
    return isExternal(ref) ? this.builtin[`${ref.guid}:${ref.fileID}`] : undefined;
  }

  /**
   * 素材的名字（Object.name）：材質（fileID 2100000）是 m_Name，貼圖（2800000）是貼圖名，其他照 sprite 的 m_Name（sprite 是貼圖的子資產，
   * 同一個 guid；sprites.json 只照 guid 記），沒有 sprite 再退回貼圖名。內建資源照 builtin.json。都不是回 null
   */
  assetName(ref: Ref): string | null {
    if (!isExternal(ref)) return null;
    const b = this.builtinOf(ref);
    if (b) return b.name;
    const fileID = String(ref.fileID);
    if (fileID === '2100000') return this.materials[ref.guid]?.m_Name ?? null;
    if (fileID === '2800000') return this.textures[ref.guid]?.name ?? null;
    return this.sprites[ref.guid]?.m_Name ?? this.textures[ref.guid]?.name ?? null;
  }

  sprite(ref: Ref): SpriteInfo | null {
    if (!isExternal(ref)) return null;
    const b = this.builtinOf(ref);
    if (b?.type === 'Sprite' && b.sprite && b.texture && b.mesh) {
      const s = b.sprite;
      return {
        name: b.name,
        m_Rect: s.m_Rect,
        m_Border: s.m_Border,
        m_PixelsToUnits: s.m_PixelsToUnits,
        pivot: s.m_Pivot,
        uvTransform: s.m_RD.uvTransform,
        textureRect: s.m_RD.textureRect,
        textureRectOffset: s.m_RD.textureRectOffset ?? { x: 0, y: 0 },
        textureWidth: b.texture.width,
        textureHeight: b.texture.height,
        textureKey: `builtin:${b.name}`,
        // GenerateTiledSprite :791 的分支條件：內建 sprite 不進圖集、不 Repeat
        packed: false,
        textureWrapMode: b.texture.wrapU,
        inlineMesh: b.mesh,
      };
    }
    const s = this.sprites[ref.guid];
    if (!s) return null;
    const t = this.textures[s.m_RD.texture.guid];
    if (!t) return null;
    return {
      name: s.m_Name,
      m_Rect: s.m_Rect,
      m_Border: s.m_Border,
      m_PixelsToUnits: s.m_PixelsToUnits,
      pivot: s.m_Pivot,
      uvTransform: s.m_RD.uvTransform,
      textureRect: s.m_RD.textureRect,
      textureRectOffset: s.m_RD.textureRectOffset,
      textureWidth: t.width,
      textureHeight: t.height,
      textureKey: s.m_RD.texture.guid,
      packed: s.m_SpriteAtlas != null,
      textureWrapMode: t.importer.wrapU ?? 1,
      meshUrl: s.mesh,
    };
  }

  material(ref: Ref): MaterialInfo | null {
    // 遊戲在執行期建的材質（new Material、Instantiate(material)；csport/unityNative.ts 的 MaterialObj）：直接用它的屬性
    const rt = ref as unknown as { $type?: string; $record?: MaterialInfo['record'] & { m_Name?: string }; shaderName?: string | null };
    if (rt?.$type === 'Material' && rt.$record) return { name: rt.$record.m_Name ?? 'Material', shaderName: rt.shaderName ?? null, record: rt.$record };
    if (!isExternal(ref)) return null;
    const b = this.builtinOf(ref);
    if (b?.type === 'Material' && b.material) return { name: b.name, shaderName: b.shaderName ?? null, record: b.material };
    const m = this.materials[ref.guid];
    return m ? { name: m.m_Name, shaderName: m.shaderName, record: m } : null;
  }

  /** 元件資料參照到的貼圖 key（textureKeysIn） */
  textureKeysIn(value: unknown, out: Set<string> = new Set()): Set<string> {
    return textureKeysIn(value, { sprite: (r) => this.sprite(r), material: (r) => this.material(r), hasTexture: (g) => g in this.textures }, out);
  }

  textureInfo(key: string): TextureInfo | null {
    if (key.startsWith('builtin:')) {
      const b = Object.values(this.builtin).find((x) => x.type === 'Sprite' && `builtin:${x.name}` === key);
      if (!b?.texture) return null;
      const t = b.texture;
      // 內建 sprite 的貼圖：colorSpace 1 = sRGB（Texture2D.m_ColorSpace）
      return { url: `${this.base}${t.file}`, width: t.width, height: t.height, filterMode: t.filterMode, wrapU: t.wrapU, wrapV: t.wrapV, sRGB: t.colorSpace === 1, mipmaps: false };
    }
    const t = this.textures[key];
    if (!t) return null;
    const imp = t.importer;
    return {
      url: `${this.base}${t.file}`,
      width: t.width,
      height: t.height,
      filterMode: imp.filterMode ?? 1,
      wrapU: imp.wrapU ?? 1,
      wrapV: imp.wrapV ?? 1,
      sRGB: imp.sRGBTexture !== 0,
      mipmaps: imp.enableMipMap === 1,
      ...(imp.textureShape === 4 ? { depth: t.depth ?? null } : {}),
    };
  }

  /**
   * 依匯入設定建 three.js 貼圖。flipY 保留預設 true：v = 0 在圖的下緣，跟 Unity 的 UV 一樣。
   * Texture2DArray 建成 DataArrayTexture（arrayTexture）：shader 裡是 sampler2DArray，綁 2D 貼圖 WebGL 會丟
   * INVALID_OPERATION（bindTexture: textures can not be used with multiple targets），那次取樣讀不到東西。
   */
  texture(key: string): Promise<THREE.Texture> {
    let p = this.textureCache.get(key);
    if (!p) {
      const info = this.textureInfo(key);
      if (!info) return Promise.reject(new Error(`找不到貼圖 ${key}`));
      if (info.depth === null) return Promise.reject(new Error(`Texture2DArray ${key} 沒有層數（textures.json 的 depth），重跑 npm run import`));
      const load: Promise<THREE.Texture> = info.depth ? this.arrayTexture(info.url, info.depth) : loadTexture(info.url);
      p = load.then((tex) => {
        tex.name = key; // 除錯用（clip-check 比對 SpriteSwap 換了哪張貼圖）
        tex.colorSpace = info.sRGB ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
        const wrap = (w: number) => (w === 0 ? THREE.RepeatWrapping : w === 2 ? THREE.MirroredRepeatWrapping : THREE.ClampToEdgeWrapping);
        tex.wrapS = wrap(info.wrapU);
        tex.wrapT = wrap(info.wrapV);
        tex.generateMipmaps = info.mipmaps;
        tex.magFilter = info.filterMode === 0 ? THREE.NearestFilter : THREE.LinearFilter;
        tex.minFilter = info.filterMode === 0 ? THREE.NearestFilter : info.mipmaps ? (info.filterMode === 2 ? THREE.LinearMipmapLinearFilter : THREE.LinearMipmapNearestFilter) : THREE.LinearFilter;
        tex.needsUpdate = true;
        return tex;
      });
      this.textureCache.set(key, p);
    }
    return p;
  }

  private cubeCache = new Map<string, Promise<THREE.CubeTexture>>();
  /**
   * Cubemap（匯入設定 textureShape 2）：AssetRipper 匯出成六面直條的 PNG（寬:高 ＝ 1:6），由上到下 +X、−X、+Y、−Y、+Z、−Z
   *（Unity 匯入 FullCubemap 時認得的直條排法）。每一面照 PNG 的列序（第 0 列在上）上傳，three.js 的 CubeTexture 也是不翻 Y，
   * 跟 D3D 編譯的 shader 用 Unity 世界方向取樣的面方向對得上（未查證，看畫面）。原版是 BC6H 的 HDR，PNG 匯出時已經夾在 0～1
   */
  cubeTexture(key: string): Promise<THREE.CubeTexture> {
    let p = this.cubeCache.get(key);
    if (!p) {
      const info = this.textureInfo(key);
      if (!info) return Promise.reject(new Error(`找不到貼圖 ${key}`));
      const shape = this.textures[key]?.importer?.textureShape;
      if (shape !== 2) return Promise.reject(new Error(`貼圖 ${key} 不是 cubemap（textureShape ${shape}）`));
      p = (async () => {
        const res = await fetch(info.url);
        if (!res.ok) throw new Error(`${info.url}：HTTP ${res.status}`);
        const img = await decodePngRgba8(await res.arrayBuffer());
        const size = img.width;
        if (img.height !== size * 6) throw new Error(`cubemap ${key}：${img.width}×${img.height} 不是六面直條`);
        const faces = Array.from({ length: 6 }, (_, i) => {
          const t = new THREE.DataTexture(img.data.slice(i * size * size * 4, (i + 1) * size * size * 4), size, size, THREE.RGBAFormat);
          t.needsUpdate = true;
          return t;
        });
        const cube = new THREE.CubeTexture(faces as unknown as HTMLImageElement[]);
        cube.name = key;
        cube.format = THREE.RGBAFormat;
        cube.colorSpace = info.sRGB ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
        cube.generateMipmaps = info.mipmaps;
        cube.magFilter = THREE.LinearFilter;
        cube.minFilter = info.mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        cube.needsUpdate = true;
        return cube;
      })();
      this.cubeCache.set(key, p);
    }
    return p;
  }

  /** PNG 自己解成位元組再切層（png.ts）：DataArrayTexture 不能用 UNPACK_FLIP_Y，flipY 的方向在切層時排好 */
  private async arrayTexture(url: string, depth: number): Promise<THREE.DataArrayTexture> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}：HTTP ${res.status}`);
    const img = await decodePngRgba8(await res.arrayBuffer());
    return new THREE.DataArrayTexture(stackedLayers(img, depth), img.width, img.height / depth, depth);
  }

  spriteMesh(sprite: SpriteInfo): Promise<SpriteMeshRecord> {
    if (sprite.inlineMesh) return Promise.resolve(sprite.inlineMesh);
    const url = sprite.meshUrl!;
    let p = this.meshCache.get(url);
    if (!p) {
      p = fetchJson<SpriteMeshRecord>(`${this.base}${url}`);
      this.meshCache.set(url, p);
    }
    return p;
  }
}

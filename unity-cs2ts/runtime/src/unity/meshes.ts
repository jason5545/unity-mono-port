// Unity 的 Mesh：資產（public/game/assets/meshes.json，0b 匯入的頂點資料：indices 與 channels 的 position、normal、tangent、
// color、uv0、uv1…）與執行期的複本（MeshFilter.mesh）。
//
// Unity 的 MeshFilter.mesh 第一次讀時把 sharedMesh 複製一份給這個 MeshFilter，之後改 uv、colors 只影響它
//（DiceObject.InitializeMesh／ManipulateResult／SetHighlightFace 就是這樣改骰子的點數與高亮面）。
// 繪製端（sceneRenderer 的 MeshRenderer）有複本就畫複本，version 變了重傳頂點；沒有就畫資產。
// 碰撞器（MeshCollider.sharedMesh）一律用資產。

import type { ComponentData } from './types';

export interface MeshChannel {
  dimension: number;
  values: number[];
}

export interface MeshAssetRecord {
  m_Name: string;
  vertexCount: number;
  indices: number[];
  channels: Record<string, MeshChannel>;
  m_SubMeshes: { firstByte: number; indexCount: number; topology: number; baseVertex: number; vertexCount: number }[];
  m_LocalAABB: { m_Center: { x: number; y: number; z: number }; m_Extent: { x: number; y: number; z: number } };
}

const assets = new Map<string, MeshAssetRecord>();

/** meshes.json 讀進來之後登記（同步取用：碰撞器與 MeshFilter.mesh 都是同步的） */
export function registerMeshAssets(rec: Record<string, MeshAssetRecord>): void {
  for (const [guid, m] of Object.entries(rec)) assets.set(guid, m);
}

export function meshAsset(guid: string): MeshAssetRecord | null {
  return assets.get(guid) ?? null;
}

/** 網格參照 → 資產的 key：內建網格（unity default resources 的 Quad、Cube…，builtin.json）是 "<guid>:<fileID>"，一般的 .asset 一個檔一個網格，照 guid */
export function meshKeyOf(ref: { guid?: string; fileID?: string | number } | null | undefined): string | null {
  if (!ref?.guid) return null;
  const k = `${ref.guid}:${ref.fileID}`;
  return assets.has(k) ? k : assets.has(ref.guid) ? ref.guid : null;
}
export function meshAssetOf(ref: { guid?: string; fileID?: string | number } | null | undefined): MeshAssetRecord | null {
  const k = meshKeyOf(ref);
  return k ? assets.get(k)! : null;
}

/** Bounds（csport 的形狀：center、extents） */
export interface MeshBounds {
  center: { x: number; y: number; z: number };
  extents: { x: number; y: number; z: number };
}
/** Mesh.bounds（sharedMesh 的資產）：匯入的 m_LocalAABB */
export function assetBounds(asset: MeshAssetRecord): MeshBounds {
  const a = asset.m_LocalAABB;
  return { center: { ...a.m_Center }, extents: { ...a.m_Extent } };
}

/** MeshFilter.mesh 的執行期複本：每個 channel 一份 Float32Array（維度同資產）。改了就 version++ */
export interface MeshInstance {
  source: string;
  vertexCount: number;
  channels: Record<string, { dimension: number; values: Float32Array }>;
  indices: number[];
  version: number;
  /** Mesh.bounds：複製時是資產的 m_LocalAABB；Unity 設 vertices 時會自動重算，寫 position 時這裡也重算 */
  bounds: MeshBounds;
  /** 執行期 new Mesh() 的子網格（SetTriangles 照子網格存；indices 是全部接起來，繪製端用） */
  submeshes?: number[][];
}

const instances = new WeakMap<ComponentData, MeshInstance>();

/** 這個 MeshFilter 有沒有執行期複本（繪製端用；沒有就畫資產） */
export function meshInstanceOf(meshFilter: ComponentData): MeshInstance | null {
  return instances.get(meshFilter) ?? null;
}

/** MeshFilter.sharedMesh 設成執行期的網格（new Mesh()，Spine 的 SkeletonRenderer）：繪製端照它畫 */
export function setMeshInstance(meshFilter: ComponentData, inst: MeshInstance): void {
  instances.set(meshFilter, inst);
}

/** MeshFilter.sharedMesh 換了：舊的複本丟掉（下次讀 mesh 從新的 sharedMesh 複製） */
export function dropMeshInstance(meshFilter: ComponentData): void {
  instances.delete(meshFilter);
}

/** MeshFilter.mesh：沒有複本就從 sharedMesh（m_Mesh）複製一份 */
export function ensureMeshInstance(meshFilter: ComponentData): MeshInstance {
  let inst = instances.get(meshFilter);
  if (inst) return inst;
  const ref = meshFilter.m_Mesh as { guid?: string; fileID?: string } | null;
  const key = meshKeyOf(ref);
  const asset = key ? assets.get(key) : undefined;
  if (!asset) throw new Error(`MeshFilter.mesh：網格 ${ref?.guid ?? '（空）'} 沒有預載（registerMeshAssets）`);
  const channels: MeshInstance['channels'] = {};
  for (const [name, ch] of Object.entries(asset.channels)) channels[name] = { dimension: ch.dimension, values: Float32Array.from(ch.values) };
  inst = { source: key!, vertexCount: asset.vertexCount, channels, indices: asset.indices, version: 0, bounds: assetBounds(asset) };
  instances.set(meshFilter, inst);
  return inst;
}

/** 一個 channel 讀成物件陣列（Mesh.vertices／uv／colors 的 getter 回的是新陣列） */
export function channelRead<T>(inst: MeshInstance, name: string, make: (v: Float32Array, i: number) => T): T[] {
  const ch = inst.channels[name];
  if (!ch) return [];
  const out: T[] = [];
  for (let i = 0; i < inst.vertexCount; i++) out.push(make(ch.values, i * ch.dimension));
  return out;
}

/** 一個 channel 整批寫回（Mesh.uv／colors 的 setter；長度不對 Unity 會丟錯，這裡也丟） */
export function channelWrite(inst: MeshInstance, name: string, dimension: number, items: ArrayLike<Record<string, number>>, keys: string[]): void {
  if (items.length !== inst.vertexCount) throw new Error(`Mesh.${name}：長度 ${items.length} 跟頂點數 ${inst.vertexCount} 不同`);
  const values = new Float32Array(inst.vertexCount * dimension);
  for (let i = 0; i < items.length; i++) for (let k = 0; k < dimension; k++) values[i * dimension + k] = items[i][keys[k]];
  inst.channels[name] = { dimension, values };
  inst.version++;
  if (name === 'position') inst.bounds = boundsOf(values, dimension, inst.vertexCount);
}

/** 頂點位置的外框（Mesh.RecalculateBounds）；沒有頂點是零 */
export function boundsOf(values: ArrayLike<number>, dimension: number, count: number): MeshBounds {
  if (!count) return { center: { x: 0, y: 0, z: 0 }, extents: { x: 0, y: 0, z: 0 } };
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++)
    for (let k = 0; k < 3; k++) {
      const v = k < dimension ? values[i * dimension + k] : 0;
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
  return {
    center: { x: (mn[0] + mx[0]) / 2, y: (mn[1] + mx[1]) / 2, z: (mn[2] + mx[2]) / 2 },
    extents: { x: (mx[0] - mn[0]) / 2, y: (mx[1] - mn[1]) / 2, z: (mx[2] - mn[2]) / 2 },
  };
}

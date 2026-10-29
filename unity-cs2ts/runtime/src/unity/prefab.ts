// 執行時期從 prefab 檔生出物件：讀 public/game/scenes/prefabs/<guid>.json（0c 匯出，格式同場景檔），
// 把整棵子樹放進執行中的場景。對應原版 Object.Instantiate(Resources.Load(prefab)／Addressables)：
// 來源是資源不是場景節點，所以不是 unity/instantiate.ts 的「同場景子樹複製」——
// 這裡全部 id 重新編號（prefab 檔的 id 跟場景 id 會撞，生兩份彼此也會撞），
// parent null ＝ 場景根（instantiate.ts 的 instantiate 同義）。
// 生命週期照 instantiate.ts 的 startBehaviours：全部建好、算好子樹的 rect 與世界矩陣（World.refreshSubtree）→ Awake →
// 啟用的 OnEnable → Start，再通知 SubtreeHooks（該檔檔頭「與原版的差異」對它同樣成立，時機一字不改地沿用）。

import type { World } from '../engine/world';
import type { SceneNode } from './scene';
import { hooksOf, linkTransform, nextCompId, nextGoId, remapRefs, startBehaviours, subtree } from './instantiate';
import type { ComponentData, GameObjectData, SceneFile } from './types';

/** prefab 索引（public/game/scenes/index.json 的 prefabs 段；scripts/import/scenes.py 產出） */
export interface PrefabEntry {
  file: string; // 相對 public/game/ 的路徑，例 scenes/prefabs/<guid>.json
  name: string;
  src: string;
  roots: number;
  counts: Record<string, number>;
}

/** 找不到指定名稱／guid 的 prefab（檢視頁 ?spawn= 要的是具名錯誤，不是 undefined） */
export class PrefabNotFoundError extends Error {
  constructor(public readonly key: string, public readonly known: number) {
    super(`找不到 prefab「${key}」（索引裡 ${known} 個沒有對應名稱）`);
    this.name = 'PrefabNotFoundError';
  }
}

/**
 * Resources／Addressables 的 prefab 端等價：載入並快取 public/game/scenes/index.json 的 prefabs，
 * 依名稱或 guid 取原始檔。原始檔唯讀（spawnPrefab 逐個 structuredClone 後才進場景），
 * 所以執行時期對生成物的改動（文字、位置、m_Enabled）永遠不會回頭髒到這裡的快取。
 */
export class PrefabSource {
  private readonly byName = new Map<string, PrefabEntry>();
  private readonly byGuid = new Map<string, PrefabEntry>();
  private readonly files = new Map<string, SceneFile>();

  // public：測試直接以 entries 建模，不必走 fetch；正式入口仍是 load()
  constructor(entries: Record<string, PrefabEntry>, private readonly base: string) {
    for (const [guid, e] of Object.entries(entries)) {
      this.byGuid.set(guid, e);
      if (!this.byName.has(e.name)) this.byName.set(e.name, e);
    }
  }

  /** base ＝ public/game/ 的 URL（例 './game/'）；索引在 base + scenes/index.json */
  static async load(base: string): Promise<PrefabSource> {
    const index = (await fetch(`${base}scenes/index.json`).then((r) => r.json())) as { prefabs: Record<string, PrefabEntry> };
    return new PrefabSource(index.prefabs, base);
  }

  /** 依名稱或 guid 取；沒有就丟 PrefabNotFoundError */
  entry(nameOrGuid: string): PrefabEntry {
    const e = this.byName.get(nameOrGuid) ?? this.byGuid.get(nameOrGuid);
    if (!e) throw new PrefabNotFoundError(nameOrGuid, this.byGuid.size);
    return e;
  }

  /** 原始 prefab 檔（快取，唯讀；spawnPrefab 會先深拷貝） */
  async file(nameOrGuid: string): Promise<SceneFile> {
    const e = this.entry(nameOrGuid);
    let f = this.files.get(e.file);
    if (!f) {
      f = (await fetch(`${this.base}${e.file}`).then((r) => r.json())) as SceneFile;
      this.files.set(e.file, f);
    }
    return f;
  }

}

/**
 * Object.Instantiate(prefab)：把整個 prefab 檔生一份進場景，接在 parent 底下（null ＝ 場景根）。
 * 全部 id（GameObject、Transform、每個元件）都換成新 id：用 instantiate.ts 的 nextGoId／nextCompId
 * （字母前綴不會跟場景的數字 fileID 撞，兩份生成物之間也不會），這跟「同場景子樹複製只重映射
 * 子樹內部引用」不同——prefab 自帶一套完整 id，全部都要重新編號。同檔 PPtr 照 id 表重映射
 * （remapRefs，instantiate.ts 同一支），外部素材（{guid,fileID}）保持原樣。
 * 來源資料純讀取：每個 go／元件都 structuredClone 後才改，同一份 PrefabSource 再生第二份不受
 * 第一份執行期間改動的影響。回傳生成子樹的根節點。
 */
export function spawnPrefab(world: World, data: SceneFile, parent: SceneNode | null): SceneNode {
  return spawnPrefabMapped(world, data, parent).root;
}

/**
 * 同 spawnPrefab，另外回傳 prefab 檔的 id → 生成物的 id（GameObject、Transform、元件）。
 * Object.Instantiate(元件) 要回傳生成物裡「同一個」元件（csport 的 Object_Instantiate 用 prefab 參照的 fileID 找）。
 */
export function spawnPrefabMapped(world: World, data: SceneFile, parent: SceneNode | null): { root: SceneNode; ids: Map<string, string> } {
  const { rootGoId, ids } = copyPrefabData(world, data, parent ? parent.id : null);
  const root = world.graph.attach(rootGoId, parent);
  linkTransform(root, parent);
  if (parent) parent.go.children.push(rootGoId);
  world.refreshSubtree(root);
  startBehaviours(world, subtree(root));
  hooksOf(world).added?.(root);
  return { root, ids };
}

/**
 * prefab 資產本身（還沒 Instantiate 的 prefab，csport 的 prefab 資產物件用）：Unity 的 prefab 資產是載入記憶體、
 * 不在任何場景裡的物件樹，遊戲可以直接對它 GetComponentInChildren、讀元件屬性。資料照 spawnPrefabMapped 重新編號放進 file，
 * 建成休眠的物件樹（SceneGraph.buildDormant）：不 Awake、不排版、不通知繪製端、Find 找不到。
 */
export function materializePrefabAsset(world: World, data: SceneFile): { root: SceneNode; ids: Map<string, string> } {
  const { rootGoId, ids } = copyPrefabData(world, data, null);
  return { root: world.graph.buildDormant(rootGoId), ids };
}

/** prefab 檔的資料全部重新編號、深拷貝進 world 的 file（同檔 PPtr 照 id 表重映射，外部素材不動） */
function copyPrefabData(world: World, data: SceneFile, parentId: string | null): { rootGoId: string; ids: Map<string, string> } {
  const file = world.graph.file;
  if (!data.roots.length) throw new Error(`prefab ${data.name} 沒有根物件`);
  const rootSrcId = data.roots[0];

  const ids = new Map<string, string>();
  for (const gid of Object.keys(data.gameObjects)) {
    ids.set(gid, nextGoId());
    const go = data.gameObjects[gid];
    ids.set(go.transform, nextCompId());
    for (const cid of go.components) if (!ids.has(cid)) ids.set(cid, nextCompId());
  }

  let rootGoId = '';
  for (const gid of Object.keys(data.gameObjects)) {
    const go = structuredClone(data.gameObjects[gid]) as GameObjectData;
    const goId = ids.get(gid)!;
    if (gid === rootSrcId) rootGoId = goId;
    go.transform = ids.get(go.transform)!;
    go.children = go.children.map((c) => ids.get(c)!);
    go.components = go.components.map((c) => ids.get(c)!);
    go.parent = gid === rootSrcId ? parentId : go.parent ? (ids.get(go.parent) ?? null) : null;
    file.gameObjects[goId] = go;
    for (const cid of data.gameObjects[gid].components) {
      const comp = structuredClone(data.components[cid]) as ComponentData;
      comp.gameObject = goId;
      // remapRefs 就地改寫拷貝（instantiate 的用法相同：先 structuredClone 再 remapRefs）
      file.components[ids.get(cid)!] = remapRefs(comp, ids) as ComponentData;
    }
  }
  return { rootGoId, ids };
}

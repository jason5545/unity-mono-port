// 執行時期的資產物件庫：場景、prefab、ScriptableObject（匯入器的 scenes/index.json 與 assets/monobehaviours.json）。
//
// Unity 載入場景或 prefab 時，序列化欄位參照到的資產（ScriptableObject、prefab、Mesh，再往下參照的）全部一起同步載好，
// 腳本裡的 Object.Instantiate(prefab)、讀 ScriptableObject 的欄位、MeshFilter.mesh 都是同步的。這裡照同一個規則：
// 載場景之前（loadScene）先把依賴閉包抓下來（preload），之後 soRecord／prefabFile 同步取用。
// Resources 資料夾的資產（Resources.Load 是同步的）開機時一次預載（preloadResources）。
//
// ScriptableObject 換成產生類別的資料物件在 csport/core.ts（materializeScriptableObject），這裡只放原始資料。
// 檔案經 packs.ts 抓：匯入器打包過的（開機與各場景的閉包）從包裡拿，一包幾百個檔。

import { registerMeshAssets, type MeshAssetRecord } from './meshes';
import { fetchJsonCached, fetchJsonOnce, installPacks } from './packs';
import type { SceneFile } from './types';

export interface SceneEntry {
  guid: string;
  /** 相對匯出根目錄的場景檔（scenes/<名>.json） */
  file: string;
  name: string;
  /** Build Settings 的順序；不在 build 裡的是 -1 */
  buildIndex: number;
  /** Assets 底下的路徑（Scenes/start.unity） */
  src: string;
}

export interface PrefabIndexEntry {
  file: string;
  name: string;
  src: string;
}

export interface MonoEntry {
  name: string | null;
  src: string;
  kind: string | null;
  /** 腳本的類別名（GUID 指到 .cs）；指到 DLL 時是 null，用 kind */
  script: string | null;
  file: string;
}

/** ScriptableObject 的參照（{guid, fileID: 11400000}）與 prefab 的參照（{guid, fileID: 根物件或元件}） */
export interface AssetRef {
  guid: string;
  fileID: string | number;
}

export class ObjectStore {
  readonly scenes = new Map<string, SceneEntry>();
  readonly buildOrder: string[];
  private readonly prefabs: Record<string, PrefabIndexEntry>;
  private readonly mono: Record<string, MonoEntry>;
  private readonly soData = new Map<string, Record<string, unknown>>();
  private readonly prefabData = new Map<string, SceneFile>();
  /** 抓檔（只抓一次）：key 是 so:<guid> 或 prefab:<guid>，值是檔案內容 */
  private readonly inflight = new Map<string, Promise<unknown>>();
  /** 每個檔的參照（collectRefs 的結果，算一次） */
  private readonly refsOf = new Map<string, AssetRef[]>();
  /** Resources.Load 的路徑（Resources/ 之後、去掉副檔名）→ guid */
  private readonly resources = new Map<string, string>();
  /** TextAsset（匯入器的 assets/texts.json：guid → 名字與內容） */
  private texts: Record<string, { name: string; src: string; text?: string; file?: string }> = {};
  /** 二進位 TextAsset 的內容（texts.json 有 file 的；preload 抓，TextAsset.bytes 同步取） */
  private readonly binData = new Map<string, Uint8Array>();
  /** Addressables 的 key → 匯出的 GUID（匯入器的 assets/addressables.json：原專案的 GUID、位址字串） */
  private addressables: { guids: Record<string, string>; addresses: Record<string, string> } = { guids: {}, addresses: {} };
  /** Mesh 資產的 guid（匯入器的 assets/meshes/index.json，一個網格一個檔）；舊的匯入是整包 meshes.json，閉包不管網格 */
  private meshes = new Set<string>();

  constructor(
    private readonly base: string,
    index: { scenes: Record<string, SceneEntry>; prefabs: Record<string, PrefabIndexEntry>; buildOrder?: string[] },
    mono: Record<string, MonoEntry>,
  ) {
    // index.json 的 scenes 以場景名為鍵、項目自己帶 guid（舊格式以 guid 為鍵、沒有 guid 欄位）
    for (const [key, e] of Object.entries(index.scenes)) this.scenes.set(e.name, { ...e, guid: e.guid ?? key });
    this.buildOrder = index.buildOrder ?? [...this.scenes.values()].filter((s) => s.buildIndex >= 0).sort((a, b) => a.buildIndex - b.buildIndex).map((s) => s.name);
    this.prefabs = index.prefabs;
    this.mono = mono;
    for (const [guid, e] of Object.entries(mono)) this.addResource(e.src, guid);
    for (const [guid, e] of Object.entries(index.prefabs)) this.addResource(e.src, guid);
  }

  private addResource(src: string, guid: string): void {
    // TextAsset 的 src 帶兩層副檔名（Foo.json.txt、Foo.bytes）：Resources.Load 的路徑去掉全部副檔名
    const m = /(?:^|\/)Resources\/(.+?)(?:\.[^./]+)+$/.exec(src);
    if (m && !this.resources.has(m[1])) this.resources.set(m[1], guid);
  }

  /** base：匯入器輸出的網址（例如 "./game/"） */
  static async load(base: string): Promise<ObjectStore> {
    await installPacks(base);
    const [index, mono, texts, addressables, meshes] = await Promise.all([
      fetchJsonCached<ConstructorParameters<typeof ObjectStore>[1]>(`${base}scenes/index.json`),
      fetchJsonCached<Record<string, MonoEntry>>(`${base}assets/monobehaviours.json`),
      fetchJsonCached<ObjectStore['texts']>(`${base}assets/texts.json`).catch(() => ({})),
      fetchJsonCached<ObjectStore['addressables']>(`${base}assets/addressables.json`).catch(() => null),
      fetchJsonCached<string[]>(`${base}assets/meshes/index.json`).catch(() => [] as string[]),
    ]);
    const store = new ObjectStore(base, index, mono);
    store.texts = texts;
    if (addressables) store.addressables = addressables;
    store.meshes = new Set(meshes);
    for (const [guid, t] of Object.entries(store.texts)) store.addResource(t.src, guid);
    return store;
  }

  /**
   * Addressables 的 key（原專案的 GUID 或位址字串）→ 匯出的 GUID。bundle 裡的資產 AssetRipper 換了 GUID，原本的只留在 catalog；
   * 表裡沒有的 GUID 照原樣（不在 bundle 裡的資產，GUID 本來就一樣）
   */
  addressableGuid(key: string): string | null {
    const k = key.toLowerCase();
    if (/^[0-9a-f]{32}$/.test(k)) return this.addressables.guids[k] ?? k;
    return this.addressables.addresses[key] ?? null;
  }

  /** TextAsset 的內容；沒有回 null */
  text(guid: string): string | null {
    return this.texts[guid]?.text ?? null;
  }
  /** 二進位 TextAsset 的位元組（要先 preload 到它）；不是二進位的或還沒抓回 null */
  textBytes(guid: string): Uint8Array | null {
    return this.binData.get(guid) ?? null;
  }
  isTextAsset(guid: string): boolean {
    return guid in this.texts;
  }

  // ───────── 場景 ─────────

  /** 場景的名字、Assets 路徑或 build 順序 → 項目 */
  /** 這個 GUID 是場景檔 */
  isScene(guid: string): boolean {
    for (const s of this.scenes.values()) if (s.guid === guid) return true;
    return false;
  }
  sceneInfo(key: string | number): SceneEntry | null {
    if (typeof key === 'number') {
      const name = this.buildOrder[key];
      return name ? (this.scenes.get(name) ?? null) : null;
    }
    const byName = this.scenes.get(key);
    if (byName) return byName;
    const k = key.replace(/^Assets\//, '').replace(/\.unity$/, '');
    for (const s of this.scenes.values()) if (s.src.replace(/\.unity$/, '') === k || s.src.endsWith(`/${k}.unity`)) return s;
    return null;
  }

  /** 讀場景檔並把依賴閉包載好 */
  async loadScene(key: string | number): Promise<{ file: SceneFile; info: SceneEntry }> {
    const info = this.sceneInfo(key);
    if (!info) throw new Error(`找不到場景 ${key}`);
    // 場景檔不留快取：載入時會被改（在地化、場景樹），再載一次要拿新的
    const file = await fetchJsonOnce<SceneFile>(`${this.base}${info.file}`);
    await this.preload(file);
    return { file, info };
  }

  // ───────── 依賴閉包 ─────────

  /**
   * 物件（場景檔、prefab 檔、ScriptableObject 的資料）參照到的 ScriptableObject 與 prefab，連同它們再參照的全部載好。
   * 廣度優先一層一層抓：資產之間常常互相參照（循環），不能用「等子節點的閉包載完」的遞迴寫法。
   */
  async preload(root: unknown): Promise<void> {
    const seen = new Set<string>();
    let frontier = collectRefs(root);
    while (frontier.length) {
      const next: AssetRef[] = [];
      await Promise.all(
        frontier.map(async (ref) => {
          const key = this.keyOf(ref);
          if (!key || seen.has(key)) return;
          seen.add(key);
          await this.fetchRef(ref, key);
          next.push(...this.refsOf.get(key)!);
        }),
      );
      frontier = next;
    }
  }

  /** Resources 資料夾的全部 ScriptableObject 與 prefab（連同依賴） */
  async preloadResources(): Promise<void> {
    await this.preload([...this.resources.values()].map((guid) => ({ guid, fileID: this.mono[guid] ? '11400000' : '0' })));
  }

  private keyOf(ref: AssetRef): string | null {
    if (this.mono[ref.guid] && String(ref.fileID) === '11400000') return `so:${ref.guid}`;
    if (this.prefabs[ref.guid]) return `prefab:${ref.guid}`;
    if (this.texts[ref.guid]?.file) return `bin:${ref.guid}`;
    if (this.meshes.has(ref.guid)) return `mesh:${ref.guid}`;
    return null;
  }

  /** 抓一個檔（只抓一次），存進 soData／prefabData，記下它的參照 */
  private fetchRef(ref: AssetRef, key: string): Promise<unknown> {
    let p = this.inflight.get(key);
    if (p) return p;
    const isSo = key.startsWith('so:');
    const { guid } = ref;
    if (key.startsWith('bin:')) {
      p = limit(async () => {
        const url = `${this.base}assets/${this.texts[guid].file}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${url}：HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      }).then((bytes) => {
        this.binData.set(guid, bytes);
        this.refsOf.set(key, []);
        return bytes;
      });
      this.inflight.set(key, p);
      return p;
    }
    if (key.startsWith('mesh:')) {
      // 網格跟素材庫（AssetDB.mesh）共用同一份，登記給同步取用（unity/meshes.ts）
      p = limit(() => fetchJsonCached<MeshAssetRecord>(`${this.base}assets/meshes/${guid}.json`)).then((rec) => {
        registerMeshAssets({ [guid]: rec });
        this.refsOf.set(key, []);
        return rec;
      });
      this.inflight.set(key, p);
      return p;
    }
    // ScriptableObject 跟素材庫、TMP 素材共用同一份（不可以改內容）；prefab 只有這裡用
    p = limit(() => {
      const url = `${this.base}${isSo ? `assets/${this.mono[guid].file}` : this.prefabs[guid].file}`;
      return isSo ? fetchJsonCached<unknown>(url) : fetchJsonOnce<unknown>(url);
    }).then((data) => {
      if (isSo) this.soData.set(guid, data as Record<string, unknown>);
      else this.prefabData.set(guid, data as SceneFile);
      this.refsOf.set(key, collectRefs(data));
      return data;
    });
    this.inflight.set(key, p);
    return p;
  }

  // ───────── 同步取用（要先 preload） ─────────

  /** ScriptableObject 的原始資料；沒有預載回 null */
  soRecord(guid: string): Record<string, unknown> | null {
    return this.soData.get(guid) ?? null;
  }

  /** ScriptableObject 的類別名（腳本是 .cs 的類別；DLL 裡的用 kind，例如 TMP_FontAsset） */
  soClass(guid: string): string | null {
    const m = this.mono[guid];
    return m ? (m.script ?? m.kind) : null;
  }

  isScriptableObject(guid: string): boolean {
    return !!this.mono[guid];
  }

  isPrefab(guid: string): boolean {
    return !!this.prefabs[guid];
  }

  /** prefab 檔（Object.Instantiate 用）；沒有預載丟錯（C# 這裡是同步的，載不到代表依賴閉包漏了） */
  prefabFile(guid: string): SceneFile {
    const f = this.prefabData.get(guid);
    if (!f) throw new Error(`prefab ${this.prefabs[guid]?.name ?? guid} 沒有預載（依賴閉包漏了？）`);
    return f;
  }

  /** 已經預載的 prefab 檔（開機流程準備字型用） */
  loadedPrefabs(): SceneFile[] {
    return [...this.prefabData.values()];
  }

  /** Resources.Load(path)：路徑 → guid（沒有回 null） */
  resourceGuid(path: string): string | null {
    return this.resources.get(path) ?? null;
  }

  /**
   * 資產參照的名字（Object.name）：prefab 是 prefab 名（根物件的名字），ScriptableObject 是 m_Name。
   * prefab 裡元件的參照（fileID 不是根物件）也給 prefab 名：Unity 的元件 name 就是它的 GameObject 的名字。
   */
  assetName(ref: AssetRef): string | null {
    const p = this.prefabs[ref.guid];
    if (p) {
      const f = this.prefabData.get(ref.guid);
      const id = String(ref.fileID);
      if (f) {
        const go = f.gameObjects[id] ?? f.gameObjects[f.components[id]?.gameObject ?? ''];
        if (go) return go.m_Name;
      }
      return p.name;
    }
    const m = this.mono[ref.guid];
    if (m) return (this.soData.get(ref.guid)?.m_Name as string | undefined) ?? m.name;
    const t = this.texts[ref.guid];
    if (t) return t.name;
    return null;
  }
}

/** 物件裡的全部 {guid, fileID} 參照 */
export function collectRefs(root: unknown): AssetRef[] {
  const out: AssetRef[] = [];
  const seen = new Set<string>();
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.guid === 'string' && 'fileID' in o) {
      const k = `${o.guid}:${o.fileID}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push({ guid: o.guid, fileID: o.fileID as string });
      }
      return;
    }
    for (const x of Object.values(o)) visit(x);
  };
  visit(root);
  return out;
}

/** 同時最多 24 個請求（4000 個 ScriptableObject 的閉包不要一次全丟給瀏覽器） */
let running = 0;
const queue: (() => void)[] = [];
function limit<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = (): void => {
      running++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < 24) run();
    else queue.push(run);
  });
}

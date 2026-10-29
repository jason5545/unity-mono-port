// 轉換器（converter/，ui 樣式）產生的類別在執行環境裡跑的核心：實體（Ctx）、場景物件的 handle（H）、產生類別的登記與分派、
// 把產生的 MonoBehaviour 接成 World 的 Behaviour（genBehaviour）。
// 來源是 diceomancer-web 的 src/runtime/csport/runtime.ts 與 host.ts 的通用部分；遊戲專屬的相容層放在遊戲專案的 runtime.ts，
// 那份 `export * from` 這裡與 unity.ts（轉換器的 ReadExports 會跟進去，名字在這裡就算相容層有）。
//
// 物件的表示：
//   - 元件、Transform、GameObject 都是 H（場景節點＋元件）。同一個元件／節點永遠拿到同一個 H（DOKill 等用物件身分比對）。
//   - Vector2／Vector3／Quaternion／Color 是一般物件 { x, y, z }（值型別；轉換器在需要複製的地方寫 R.cloneData）。
//   - 產生類別的實體每個一份 Ctx：ed＝元件存檔值（同檔參照換成 H），ai＝執行期欄位（initAi，沿基底鏈合併）。
//     資料物件（new 出來的、[Serializable] 的類別）沒有場景元件：ed 與 ai 都是物件本身（{ $type, …欄位 }）。

import type { Behaviour, BehaviourContext, World } from '../engine/world';
import { setComponentVirtualGet } from '../engine/events';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import type { ObjectStore } from '../unity/objectStore';

/** 轉換器看到這個名字（相容層帶工具包的 core）就用工具包的寫法：isInstance、callIface、staticInit、同類別別的實體走 callGen… */
export const __cs2ts_core = 1;

// ───────── 實體與 Ctx ─────────

/** 場景裡的一個 Unity 物件：元件（comp）、Transform（kind 'transform'）或 GameObject（kind 'go'） */
export class H {
  constructor(
    readonly node: SceneNode,
    readonly comp: ComponentData | null,
    readonly kind: 'comp' | 'transform' | 'go',
  ) {}
}

/** 產生的類別的一個實體 */
export interface Ctx {
  /** 所在的 World；資料物件與靜態方法可能是 null */
  w: World | null;
  self: any;
  /** 存檔值（參照已換成 H） */
  ed: any;
  /** 執行期欄位（initAi） */
  ai: any;
  cls: string;
  bound: Map<string, (...a: any[]) => any>;
}

/** 產生的類別（gen/<類別>.ts 的 export） */
export interface GenClassImpl {
  name: string;
  file: string;
  initAi(c: Ctx): Record<string, any>;
  /** C# 的靜態建構子：registerGen 登記完全部類別後跑一次（C# 是第一次用到才跑，這裡提早） */
  cctor?: (c: Ctx) => any;
  overrides: Record<string, unknown>;
  delegates: Record<string, unknown>;
  methods: Record<string, (c: Ctx, ...a: any[]) => any>;
  statics?: Record<string, { get(): any; set(v: any): void }>;
  /** 基底類別（原始碼裡宣告的；callGen 的虛擬分派、genBehaviour 的方法合併沿這條鏈） */
  base?: string;
  /** 實作的介面（轉換器在相容層有 isInstance 時寫；isInstance 判斷 x is 介面用） */
  interfaces?: string[];
  /**
   * 同一個泛型介面實作了兩種以上封閉型別（RelicInfoUI 的 IDataView<RelicState>、IDataView<RelicData>、IDataView<CollectableRelicData>）：
   * "介面<型別引數>$成員" → 實作方法的產生名（C# 的介面對應；callIfaceT 照呼叫端的型別引數查）
   */
  ifaceImpls?: Record<string, string>;
  fields?: Record<string, string>;
  ctor0?: string;
  /** Unity 會序列化的欄位（宣告順序，只有這個類別自己宣告的；JsonUtility.ToJson 沿基底鏈合併） */
  serialized?: string[];
  /** C# 的 struct（值型別） */
  struct?: boolean;
  /** 傳給泛型基底的型別引數（型別名；"$targ:i" 是自己的第 i 個型別引數） */
  baseTargs?: string[];
  /** 基底是 .NET 的集合（Dictionary$2、List$1…）：實體本身就是那個集合（newGen 建 CsDict／陣列再掛欄位） */
  extBase?: string;
  /** 直接基底是 DLL 裡的型別（沒有原始碼）：整條 DLL 基底鏈（ScriptableObject、Object）；typeNames 照它判斷 */
  dllBases?: string[];
  /** [RequireComponent] 的元件型別（AddComponent 先補上） */
  requires?: string[];
  /** 覆寫 System.Object 的 Equals(object)／GetHashCode／ToString 的產生名：相容層的 Object.Equals、Dictionary 的鍵比較、字串化照這個分派 */
  objectMethods?: Partial<Record<ObjectMethod, string>>;
  /** MonoBehaviour 裡單一參數方法的參數種類（產生名 → f／i／s／o／e，其他型別 ?）：動畫事件照它帶值 */
  msgArgs?: Record<string, string>;
}
export type ObjectMethod = 'Equals' | 'GetHashCode' | 'ToString';

export class NotPorted extends Error {
  constructor(where: string, src: string, need?: string) {
    super(`還沒移植：${where}「${src}」${need ? `（缺 ${need}）` : ''}`);
    this.name = 'NotPorted';
  }
}

/** 執行時的紀錄：走到的 notPorted（位置 → 次數）、遊戲 Log 的輸出 */
export const trace = { notPorted: new Map<string, number>(), log: [] as { level: string; msg: string }[] };

const GEN: Record<string, GenClassImpl> = {};
/** scriptGenName 的快取（有 namespace 的 script 物件 → 產生名） */
let scriptGenNames = new WeakMap<object, string>();

/**
 * 目前作用中的 World（開機流程換場景時設定）。Unity 的 Time、Screen、Input 等是全域的：
 * 靜態欄位建的資料物件、靜態方法的 Ctx 沒有 World，相容層用這個（unity.ts 的 w(c)）。
 */
let activeWorld: World | null = null;
export function setActiveWorld(w: World | null): void {
  activeWorld = w;
}
export function getActiveWorld(): World | null {
  return activeWorld;
}

/** 靜態方法、靜態初始式用的 Ctx */
export const staticCtx: Ctx = { w: null, self: null, ed: {}, ai: {}, cls: '', bound: new Map() };

/**
 * gen/index.ts 的登記表登記進來。靜態建構子（含延到 cctor 的靜態欄位初始式）不在這裡跑：照 C# 的語意，型別第一次用到
 * （genClass：呼叫方法、讀寫靜態欄位、new、建實體）才跑一次。還沒移植完的靜態建構子記進 trace，不擋住呼叫端。
 */
export function registerGen(map: Record<string, GenClassImpl>): void {
  Object.assign(GEN, map);
  for (const k of Object.keys(map)) cctorDone.delete(k);
  scriptGenNames = new WeakMap();
  objectOverrideCache.clear();
  collectionKinds.clear();
}
const cctorDone = new Set<string>();
function runCctor(g: GenClassImpl): void {
  cctorDone.add(g.name);
  if (!g.cctor) return;
  try {
    g.cctor(staticCtx);
  } catch (e) {
    if (!(e instanceof NotPorted)) throw e;
    trace.notPorted.set(`${g.name} 的靜態建構子：${e.message}`, 1);
  }
}
/**
 * 靜態欄位的初始式裡有還沒移植的部分（轉換器這時包成 R.staticInit）：模組載入時不丟錯，欄位先是 undefined，記進 trace；
 * 真的用到那個欄位時才會出錯（C# 是型別初始化失敗）。部分移植的類別才載得進來。
 */
export function staticInit<T>(fn: () => T, where: string): T | undefined {
  try {
    return fn();
  } catch (e) {
    if (!(e instanceof NotPorted)) throw e;
    trace.notPorted.set(`${where}：${e.message}`, 1);
    return undefined;
  }
}
export function genClass(name: string): GenClassImpl {
  const g = GEN[name];
  if (!g) throw new Error(`轉換器沒有產生 ${name}`);
  if (!cctorDone.has(name)) runCctor(g);
  return g;
}
/**
 * 場景元件的腳本 → 產生名。不同 namespace 的同名類別，轉換器給有 namespace 的那幾個加上 namespace（Ink_Runtime_Path）：
 * 先找 namespace 版本，沒有再用類別名。
 */
export function scriptGenName(script: { namespace?: string | null; class?: string } | null | undefined): string | undefined {
  if (!script?.class) return undefined;
  if (!script.namespace) return script.class;
  // 每次分派都會問（callGen、ctxOf），有 namespace 的照 script 物件記住，不要每次組字串（registerGen 清掉）
  let hit = scriptGenNames.get(script);
  if (hit === undefined) {
    const q = `${script.namespace.replace(/\./g, '_')}_${script.class}`;
    hit = q in GEN ? q : script.class;
    scriptGenNames.set(script, hit);
  }
  return hit;
}
export function hasGen(name: string): boolean {
  return name in GEN;
}
/** 產生的類別（沿基底鏈）有沒有這個方法；有就回傳 */
export function genMethodOf(cls: string, method: string): ((c: Ctx, ...a: any[]) => any) | undefined {
  for (let k: string | undefined = cls; k && GEN[k]; k = GEN[k].base) if (GEN[k].methods[method]) return GEN[k].methods[method];
  return undefined;
}

// ───────── 場景物件的 handle ─────────

const compHandles = new WeakMap<ComponentData, H>();
const tfHandles = new WeakMap<SceneNode, H>();
const goHandles = new WeakMap<SceneNode, H>();
const ctxs = new WeakMap<object, Ctx>();

export function compHandle(w: World, comp: ComponentData): H {
  let h = compHandles.get(comp);
  if (!h) {
    const node = w.graph.nodeById(comp.gameObject);
    if (!node) throw new Error(`元件 ${comp.script?.class ?? comp.type} 找不到所在的節點`);
    h = new H(node, comp, 'comp');
    compHandles.set(comp, h);
  }
  return h;
}
export function transformOf(node: SceneNode): H {
  let h = tfHandles.get(node);
  if (!h) {
    h = new H(node, null, 'transform');
    tfHandles.set(node, h);
  }
  return h;
}
export function gameObjectOf(node: SceneNode): H {
  let h = goHandles.get(node);
  if (!h) {
    h = new H(node, null, 'go');
    goHandles.set(node, h);
  }
  return h;
}

// ───────── prefab 資產上的物件（{guid, fileID}）當物件用 ─────────
// unity.ts 登記：照 Unity，prefab 資產是一棵載入記憶體、不在任何場景裡的物件樹（SceneGraph.dormant）。
// 需要真物件的地方（叫腳本方法、讀寫欄位、原生屬性、往子物件找）先換成那棵樹上的 H。

let prefabLive: (x: object) => H | null = () => null;
let prefabRef: (h: H) => { guid: string; fileID: string } | null = () => null;
export function setPrefabAssetHooks(live: (x: object) => H | null, ref: (h: H) => { guid: string; fileID: string } | null): void {
  prefabLive = live;
  prefabRef = ref;
}
/** prefab 資產上的物件（{guid, fileID}）→ 休眠物件樹上的 H；其他照舊 */
export function liveObj<T>(x: T): T | H {
  if (!x || typeof x !== 'object' || x instanceof H) return x;
  const r = x as { guid?: unknown; fileID?: unknown; $type?: unknown };
  if (typeof r.guid !== 'string' || r.fileID === undefined || r.$type !== undefined) return x;
  return prefabLive(x) ?? x;
}
/** 休眠物件樹（prefab 資產）上的 H → {guid, fileID}；不是就 null */
export function prefabAssetRef(h: H): { guid: string; fileID: string } | null {
  return prefabRef(h);
}

/** 節點上某個型別（元件型別或 MonoBehaviour 類別名）的第一個元件 */
export function componentOn(w: World, node: SceneNode, kind: string): ComponentData | null {
  for (const id of node.go.components) {
    const c = w.graph.file.components[id];
    if (c && (c.type === kind || c.script?.class === kind)) return c;
  }
  return null;
}

/** 存檔裡的 {fileID} 參照 → H（0 → null）。Transform／RectTransform 給 Transform 的 H，GameObject 給 GameObject 的 H */
export function refHandle(w: World, id: string): H | null {
  if (!id || id === '0') return null;
  const c = w.graph.file.components[id];
  if (c) {
    const node = w.graph.nodeById(c.gameObject);
    if (!node) return null;
    if (c.type === 'Transform' || c.type === 'RectTransform') return transformOf(node);
    return compHandle(w, c);
  }
  const node = w.graph.nodeById(id);
  return node ? gameObjectOf(node) : null;
}

/** ScriptableObject 的參照（{guid, fileID: 11400000}）→ 資料物件：遊戲專案登記（素材要先載好，這裡同步取用） */
let scriptableObjectOf: (guid: string) => object | null = () => null;
export function setScriptableObjectResolver(fn: (guid: string) => object | null): void {
  scriptableObjectOf = fn;
}

// ───────── 資產物件庫與 ScriptableObject ─────────

let objectStore: ObjectStore | null = null;
/** 開機流程設定物件庫；ScriptableObject 的參照從此照 materializeScriptableObject 換成資料物件 */
export function setObjectStore(store: ObjectStore | null): void {
  objectStore = store;
  soCache.clear();
  scriptableObjectOf = store ? materializeScriptableObject : () => null;
}
export function getObjectStore(): ObjectStore | null {
  return objectStore;
}
/** 存檔裡 ScriptableObject 自己的欄位以外的東西（匯入器加的、Object 的內部欄位） */
const SO_META = new Set(['src', 'fileID', 'm_GameObject', 'm_Enabled', 'm_EditorHideFlags', 'm_Script', 'm_EditorClassIdentifier', '$subObjects', '$script']);
/** 主物件用 guid 當鍵；同檔的子物件（Timeline 的 track、clip）用 guid#fileID */
const soCache = new Map<string, Record<string, unknown>>();
const MAIN_FILE_ID = '11400000';
/**
 * ScriptableObject（guid）→ 資料物件，同一個 guid 永遠是同一個物件（C# 的參照）。照 Unity 反序列化：
 * 欄位初始式（initAi）→ 無參數建構子（ctor0）→ 蓋上存檔值（參照到的 ScriptableObject 也換成物件，可以互相參照）→
 * ISerializationCallbackReceiver.OnAfterDeserialize → OnEnable（Unity 載入 ScriptableObject 時呼叫；Awake 未查證，不叫）。
 * 一次載入連帶建出來的物件（參照到的其他 ScriptableObject、同檔的子物件）欄位全部填好之後，才依序跑 OnAfterDeserialize，再跑 OnEnable：
 * 回呼裡碰到互相參照的物件時，對方的欄位已經在（Timeline 的 track 在 OnAfterDeserialize 裡經由 parent 碰到 TimelineAsset）。
 * 類別沒有轉的（TMP_FontAsset 這類 DLL 裡的）：存檔值原樣（參照照樣解析），$type 是類別名或種類。
 * 物件帶 $asset（guid），同檔的子物件另帶 $fileID：Object.name、== 比較、Instantiate、PlayableDirector 的綁定用。
 */
let soDepth = 0;
const soPending: { c: Ctx; cls: string; obj: Record<string, unknown>; name: unknown }[] = [];
export function materializeScriptableObject(guid: string, fileID: string = MAIN_FILE_ID): Record<string, unknown> | null {
  const sub = String(fileID) !== MAIN_FILE_ID;
  const key = sub ? `${guid}#${fileID}` : guid;
  const hit = soCache.get(key);
  if (hit) return hit;
  const file = objectStore?.soRecord(guid);
  if (!file) return null;
  // 同檔的子物件（匯入器的 $subObjects）：類別在 $script
  const rec = sub ? (file.$subObjects as Record<string, Record<string, unknown>> | undefined)?.[String(fileID)] : file;
  if (!rec) return null;
  const cls = sub ? ((rec.$script as string | null) ?? null) : objectStore!.soClass(guid);
  const obj: Record<string, unknown> = { $type: cls ?? 'ScriptableObject', $asset: guid };
  if (sub) obj.$fileID = String(fileID);
  soCache.set(key, obj);
  const fields = Object.entries(rec).filter(([k]) => !SO_META.has(k));
  soDepth++;
  try {
    if (cls && GEN[cls]) {
      // 跟場景元件同一套：存檔值放 ed，initAi 照欄位型別建（巢狀的 [Serializable] 類別建成產生類別、跑它的 OnAfterDeserialize）
      const raw: Record<string, unknown> = {};
      for (const [k, v] of fields) raw[k] = resolveAssetValue(v, guid);
      const c: Ctx = { w: null, self: obj, ed: raw, ai: obj, cls: '', bound: new Map() };
      ctxs.set(obj, c);
      mergeClassChain(c, cls);
      // 欄位初始式 → C# 的無參數建構子 → 蓋上序列化的值
      const snapshot = { ...obj };
      baseCtor0(c, cls);
      for (const k of serializedFieldsOf(cls)) if (k in raw && k in snapshot) obj[k] = snapshot[k];
      // 產生類別沒宣告的（m_Name、沒轉的基底的欄位）照存檔值
      for (const k of Object.keys(raw)) if (!(k in obj)) obj[k] = raw[k];
      soPending.push({ c, cls, obj, name: rec.m_Name });
    } else {
      for (const [k, v] of fields) obj[k] = resolveAssetValue(v, guid);
    }
  } finally {
    soDepth--;
  }
  if (soDepth === 0) flushScriptableObjects();
  return obj;
}
/** 這次載入建出來的物件：全部 OnAfterDeserialize → 接場景參照 → 全部 OnEnable */
function flushScriptableObjects(): void {
  const list = soPending.splice(0);
  for (const p of list) afterDeserialize(p.c, p.cls);
  for (const p of list) collectSceneRefs(p.obj);
  for (const p of list) {
    const onEnable = methodsWithBase(p.cls).OnEnable;
    if (!onEnable) continue;
    try {
      onEnable(p.c);
    } catch (e) {
      if (!(e instanceof NotPorted)) throw e;
      trace.notPorted.set(`${p.cls}.OnEnable（ScriptableObject ${String(p.name)}）：${e.message}`, 1);
    }
  }
}
/** 資產參照（{guid, fileID}）是不是 ScriptableObject 或它同檔的子物件 */
function isSoRef(guid: string, fileID: string): boolean {
  if (!objectStore?.isScriptableObject(guid)) return false;
  if (fileID === MAIN_FILE_ID) return true;
  const subs = objectStore.soRecord(guid)?.$subObjects as Record<string, unknown> | undefined;
  return !!subs && fileID in subs;
}
// ───────── 資產裡指向場景物件的參照 ─────────
// 原版嵌在場景裡的 ScriptableObject（I2 的 LocalizeTarget 這類），AssetRipper 匯出成獨立資產，欄位指回場景裡的物件（{guid: 場景, fileID}）。
// 場景載入時（Awake 之前）換成那個場景物件的 handle；ScriptableObject 在場景載入之後才實體化的，當場接上。

type SceneRefSlot = { obj: Record<string | number, unknown>; key: string | number; fileID: string };
const sceneRefSlots = new Map<string, SceneRefSlot[]>();
function collectSceneRefs(root: object): void {
  const store = objectStore;
  if (!store) return;
  const seen = new Set<object>();
  const visit = (o: Record<string | number, unknown>): void => {
    if (seen.has(o)) return;
    seen.add(o);
    for (const key of Object.keys(o)) {
      const v = o[key];
      if (!v || typeof v !== 'object' || v instanceof H) continue;
      const r = v as { guid?: unknown; fileID?: unknown; $type?: unknown; $asset?: unknown };
      if (typeof r.guid === 'string' && 'fileID' in r && !('$type' in r) && store.isScene(r.guid)) {
        const slot = { obj: o, key: Array.isArray(o) ? Number(key) : key, fileID: String(r.fileID) };
        let list = sceneRefSlots.get(r.guid);
        if (!list) sceneRefSlots.set(r.guid, (list = []));
        list.push(slot);
        const w = getActiveWorld();
        const scene = w?.scenes.loaded.find((s) => s.guid === r.guid);
        if (w && scene) patchSceneRef(w, scene, slot);
        continue;
      }
      if (r.$asset && v !== root) continue; // 別的 ScriptableObject 自己收
      visit(v as Record<string | number, unknown>);
    }
  };
  visit(root as Record<string | number, unknown>);
}
function patchSceneRef(w: World, scene: { fileIds?: Map<string, string> }, slot: SceneRefSlot): void {
  const id = scene.fileIds?.get(slot.fileID) ?? slot.fileID;
  slot.obj[slot.key] = resolveValue(w, { fileID: id });
}
/** 場景併進樹之後（Scenes.merged）：ScriptableObject 裡指向這個場景的參照接上 */
export function resolveSceneRefs(w: World, scene: { guid?: string; fileIds?: Map<string, string> }): void {
  if (!scene.guid) return;
  for (const slot of sceneRefSlots.get(scene.guid) ?? []) patchSceneRef(w, scene, slot);
}

/**
 * 資產資料裡的參照：ScriptableObject（含同檔的子物件）換成資料物件；prefab 等其他資產的 {guid, fileID} 原樣（相容層的 Object_* 認得它）。
 * owner：這份資料所在的資產；同檔參照（只有 {fileID}）指的是它的主物件或子物件
 */
function resolveAssetValue(v: unknown, owner?: string): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => resolveAssetValue(x, owner));
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (owner && keys.length === 1 && keys[0] === 'fileID') {
    const id = String(o.fileID);
    return id !== '0' && isSoRef(owner, id) ? (materializeScriptableObject(owner, id) ?? o) : o;
  }
  if (typeof o.guid === 'string' && 'fileID' in o) {
    if (isSoRef(o.guid, String(o.fileID))) return materializeScriptableObject(o.guid, String(o.fileID)) ?? o;
    return o;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = resolveAssetValue(x, owner);
  return out;
}
/** ISerializationCallbackReceiver.OnAfterDeserialize（明確介面實作或一般方法）：Unity 反序列化完呼叫 */
function afterDeserialize(c: Ctx, cls: string): void {
  const m = methodsWithBase(cls);
  const fn = m['ISerializationCallbackReceiver$OnAfterDeserialize'] ?? m.OnAfterDeserialize;
  if (!fn) return;
  try {
    fn(c);
  } catch (e) {
    if (!(e instanceof NotPorted)) throw e;
    trace.notPorted.set(`${cls}.OnAfterDeserialize：${e.message}`, 1);
  }
}

/** 存檔值 → 執行期的值：同檔參照換成 H，ScriptableObject 換成資料物件，外部素材（{guid, fileID}）原樣 */
export function resolveValue(w: World, v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => resolveValue(w, x));
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === 'fileID') return refHandle(w, String(o.fileID));
  if (typeof o.guid === 'string' && keys.length === 2 && String(o.fileID) === '11400000') return scriptableObjectOf(o.guid) ?? o;
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = resolveValue(w, o[k]);
  return out;
}

/** 已經建好的 Ctx（沒有就回 undefined，不建新的） */
export function existingCtx(h: object): Ctx | undefined {
  return ctxs.get(h);
}

/**
 * 實體的 Ctx（第一次用到才建：ed 由元件存檔值解析，ai 跑 initAi）。
 * cls：用哪個產生的類別（沒給就照元件的 script.class 或資料物件的 $type）。同一個實體用到兩個產生的類別時 ai 合在一起（C# 是同一個物件）。
 */
export function ctxOf(w: World | null, h: object, cls?: string): Ctx {
  if (!(h instanceof H)) h = liveObj(h);
  const comp = h instanceof H ? h.comp : null;
  const name = cls ?? scriptGenName(comp?.script) ?? (h as { $type?: string }).$type;
  if (!name) throw new Error('ctxOf：要元件或指定類別');
  let c = ctxs.get(h);
  if (!c) {
    genClass(name);
    const isScene = h instanceof H;
    // 場景元件的 ctx 第一次是被靜態方法或資料物件（ctx.w 是 null）叫到時（MT2 拖卡經過房間：Signal 的監聽者叫到還沒建 ctx 的 CharacterUI），
    // 元件一定在作用中的 World 裡
    if (isScene && !w) w = getActiveWorld();
    if (isScene && !w) throw new Error(`ctxOf ${name}：場景元件要有 World`);
    c = { w, self: h, ed: isScene ? (comp ? resolveValue(w!, comp) : {}) : h, ai: isScene ? {} : h, cls: '', bound: new Map() };
    ctxs.set(h, c);
    mergeClassChain(c, name);
    if (isScene && scriptGenName(comp?.script) === name) {
      // Unity 建元件：欄位初始式 → C# 的無參數建構子 → 蓋上序列化的值（建構子改到的序列化欄位以存檔為準）
      const snapshot = { ...c.ai };
      baseCtor0(c, name);
      for (const k of serializedFieldsOf(name)) if (k in c.ed && k in snapshot) c.ai[k] = snapshot[k];
      // 反序列化完（Awake 之前）：ISerializationCallbackReceiver.OnAfterDeserialize
      afterDeserialize(c, name);
    }
    return c;
  }
  mergeClassChain(c, name);
  return c;
}
/** 把產生類別與它（產生的）基底鏈的執行期欄位併進 ai：已經有的欄位不蓋；c.cls 記併過的類別（'+' 分隔） */
function mergeClassChain(c: Ctx, name: string): void {
  // 併過 name 就併過它整條基底鏈（下面的迴圈不會中途停）：每次方法呼叫都會走到這裡，先不配置地查一次
  if (hasClassIn(c.cls, name)) return;
  const have = c.cls ? c.cls.split('+') : [];
  for (let k: string | undefined = name; k && GEN[k]; k = GEN[k].base) {
    if (have.includes(k)) continue;
    // 建實體：這個類別與基底的靜態建構子先跑（C# 的實體建構子會先觸發型別初始化）
    const extra = genClass(k).initAi(c);
    for (const key of Object.keys(extra)) if (!(key in c.ai)) c.ai[key] = extra[key];
    have.push(k);
  }
  c.cls = have.join('+');
}

/** list（'+' 分隔的類別名）裡有沒有 name：同 list.split('+').includes(name)，不配置 */
function hasClassIn(list: string, name: string): boolean {
  for (let i = list.indexOf(name); i >= 0; i = list.indexOf(name, i + 1)) {
    const end = i + name.length;
    if ((i === 0 || list.charCodeAt(i - 1) === 43) && (end === list.length || list.charCodeAt(end) === 43)) return true;
  }
  return false;
}

// ───────── 產生的程式碼直接用到的 ─────────

export function notPorted(c: Ctx, where: string, src: string, need?: string): never {
  void c;
  trace.notPorted.set(`${where} ${need ?? src}`, (trace.notPorted.get(`${where} ${need ?? src}`) ?? 0) + 1);
  throw new NotPorted(where, src, need);
}

/** 迴圈保護（cs2ts.json 目標的 loopGuard）：同一個迴圈跑了一千萬圈，當作無窮迴圈丟例外（Unity 會卡住；網頁上不丟會讓分頁當掉） */
export function loopRunaway(where: string): never {
  throw new Error(`${where}：迴圈超過一千萬圈，當作無窮迴圈中止（loopGuard）`);
}

/** 結構的複製（值型別從欄位拿出來是複本）：一般物件與陣列深拷貝；H、產生類別的實體（有 $type）、類別實體原樣 */
export function cloneData<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => cloneData(x)) as T;
  if (Object.getPrototypeOf(v) !== Object.prototype) return v;
  // 產生類別的實體是參照（不複製）；產生的 struct 是值型別，照欄位複製一份（C# 的指定、傳參、放進集合都是複製）
  const t = (v as { $type?: unknown }).$type;
  if (t !== undefined && !(typeof t === 'string' && GEN[t]?.struct)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object)) out[k] = cloneData((v as Record<string, unknown>)[k]);
  return out as T;
}

/** 方法當委派：同一個實體同一個方法拿到同一個函式（event 的 −= 才拿得掉） */
export function bound(c: Ctx, name: string, fn: (c: Ctx, ...a: any[]) => any): (...a: any[]) => any {
  let f = c.bound.get(name);
  if (!f) {
    f = (...a: any[]) => fn(c, ...a);
    c.bound.set(name, f);
  }
  return f;
}

/** 方法群組當委派（產生的實體方法，照實際類別分派）：同一個實體同一個方法拿到同一個函式（event 的 −= 才拿得掉） */
const boundGens = new WeakMap<object, Map<string, (...a: any[]) => any>>();
export function boundGen(c: Ctx, cls: string, method: string, recv: object | null): ((...a: any[]) => any) | null {
  if (!recv) throw new Error(`${cls}.${method} 當委派：對象是 null（C# 會 NullReferenceException）`);
  let m = boundGens.get(recv);
  if (!m) boundGens.set(recv, (m = new Map()));
  const key = `${cls}.${method}`;
  let f = m.get(key);
  if (!f) {
    f = (...a: any[]) => callGen(c, cls, method, recv, ...a);
    m.set(key, f);
  }
  return f;
}
/** base.M 當委派：固定叫指定類別那一版（C# 用 base 建的委派不分派）；同一個實體同一個方法拿到同一個函式 */
export function boundAs(c: Ctx, cls: string, method: string, recv: object | null): ((...a: any[]) => any) | null {
  if (!recv) throw new Error(`base.${method} 當委派：對象是 null`);
  let m = boundGens.get(recv);
  if (!m) boundGens.set(recv, (m = new Map()));
  const key = `base:${cls}.${method}`;
  let f = m.get(key);
  if (!f) {
    f = (...a: any[]) => callAs(c, cls, method, recv, ...a);
    m.set(key, f);
  }
  return f;
}
export function boundIface(c: Ctx, iface: string, method: string, recv: object | null): ((...a: any[]) => any) | null {
  if (!recv) throw new Error(`${iface}.${method} 當委派：對象是 null（C# 會 NullReferenceException）`);
  let m = boundGens.get(recv);
  if (!m) boundGens.set(recv, (m = new Map()));
  const key = `${iface}#${method}`;
  let f = m.get(key);
  if (!f) {
    f = (...a: any[]) => callIface(c, iface, method, recv, ...a);
    m.set(key, f);
  }
  return f;
}
/** 實體的實際類別：元件看 script.class；資料物件看 $type */
function actualClassOf(recv: object): string | null {
  if (recv instanceof H) return scriptGenName(recv.comp?.script) ?? null;
  const t = (recv as { $type?: unknown }).$type;
  return typeof t === 'string' ? t : null;
}
const objectOverrideCache = new Map<string, { cls: string; method: string } | null>();
/**
 * 實體的類別鏈上覆寫 System.Object 的 Equals(object)／GetHashCode／ToString（轉換器寫的 objectMethods）：回一個呼叫它的函式，
 * 沒覆寫（或不是產生類別的實體）是 null。相容層的 Object.Equals、Dictionary 的鍵比較、字串化用
 */
export function objectOverride(o: unknown, which: ObjectMethod): ((...a: any[]) => any) | null {
  if (!o || typeof o !== 'object') return null;
  const k0 = actualClassOf(o);
  if (!k0 || !GEN[k0]) return null;
  const key = `${k0}|${which}`;
  let hit = objectOverrideCache.get(key);
  if (hit === undefined) {
    hit = null;
    for (let k: string | null = k0; k && GEN[k]; k = GEN[k].base ?? null) {
      const m = GEN[k].objectMethods?.[which];
      if (m) {
        hit = { cls: k, method: m };
        break;
      }
    }
    objectOverrideCache.set(key, hit);
  }
  if (!hit) return null;
  const { cls, method } = hit;
  return (...a: any[]) => genCall(activeWorld, cls, o, method, ...a);
}

/** 虛擬分派：從實體的實際類別沿產生的基底鏈往上，第一個有這個方法的類別；實際類別沒產生就照靜態型別 cls */
function dispatchClass(recv: object, cls: string, method: string): string {
  for (let k = actualClassOf(recv); k; k = GEN[k]?.base ?? null) {
    const g = GEN[k];
    if (!g) break;
    if (g.methods[method]) return k;
  }
  return cls;
}

/**
 * 場景元件上 DLL 基底的虛擬屬性：元件的產生類別（含產生的基底鏈）覆寫了 get_屬性 就叫它（C# 的 virtual 分派），沒有回 undefined。
 * 給執行環境自己讀屬性的地方用（EventSystem 的 graphic.raycastTarget）
 */
export function componentVirtualGet(comp: ComponentData, prop: string): unknown {
  const cls = scriptGenName(comp.script);
  if (!cls || !GEN[cls]) return undefined;
  const getter = `get_${prop}`;
  if (!methodsWithBase(cls)[getter]) return undefined;
  const w = getActiveWorld();
  if (!w) return undefined;
  return genCallVirtual(w, cls, compHandle(w, comp), getter);
}
setComponentVirtualGet(componentVirtualGet);

/** TS 這邊呼叫產生的方法（指定類別，不分派） */
export function genCall(w: World | null, cls: string, h: object, method: string, ...args: any[]): any {
  const fn = genClass(cls).methods[method];
  if (!fn) throw new Error(`${cls} 沒有轉出方法 ${method}`);
  return fn(ctxOf(w, h, cls), ...args);
}
/** TS 這邊呼叫產生的方法，照實體的實際類別分派 */
export function genCallVirtual(w: World | null, cls: string, h: object, method: string, ...args: any[]): any {
  return genCall(w, dispatchClass(h, cls, method), h, method, ...args);
}
/** TS 這邊呼叫產生的靜態方法 */
export function genStaticCall(cls: string, method: string, ...args: any[]): any {
  return callStatic(staticCtx, cls, method, ...args);
}
/** 同一次轉的類別的實體方法（R.callGen）：照對象的實際類別分派（C# 的 virtual／override） */
export function callGen(c: Ctx, cls: string, method: string, recv: object | null, ...args: any[]): any {
  if (!recv) throw new Error(`callGen ${cls}.${method}：對象是 null（C# 這裡會 NullReferenceException）`);
  recv = liveObj(recv);
  return genCall(c.w, dispatchClass(recv, cls, method), recv, method, ...args);
}
/** base.X()：指定類別的版本（不分派） */
export function callAs(c: Ctx, cls: string, method: string, recv: object | null, ...args: any[]): any {
  if (!recv) throw new Error(`callAs ${cls}.${method}：對象是 null`);
  return genCall(c.w, cls, recv, method, ...args);
}
/** 同一次轉的別的類別的靜態方法：產生的函式第一個參數照樣是 Ctx，用呼叫端的 */
export function callStatic(c: Ctx, cls: string, method: string, ...args: any[]): any {
  const fn = genClass(cls).methods[method];
  if (!fn) throw new Error(`${cls} 沒有轉出靜態方法 ${method}`);
  return fn(c, ...args);
}
/**
 * 泛型類別的靜態方法（StateMachine<State>.Initialize）：方法裡的 R.typeArg 讀 Ctx 的 self.$targs，
 * 呼叫端的 self 是別的實體，這裡換成帶這個類別型別引數的 self（靜態方法不碰實體欄位）
 */
export function callStaticT(c: Ctx, cls: string, targs: string[], method: string, ...args: any[]): any {
  const fn = genClass(cls).methods[method];
  if (!fn) throw new Error(`${cls} 沒有轉出靜態方法 ${method}`);
  return fn({ ...c, self: { $type: cls, $targs: targs } }, ...args);
}
export function genStatic(c: Ctx, cls: string, name: string): any {
  void c;
  const st = genClass(cls).statics?.[name];
  if (!st) throw new Error(`${cls} 沒有轉出靜態欄位 ${name}`);
  return st.get();
}
export function genStaticSet(c: Ctx, cls: string, name: string, v: any): void {
  void c;
  const st = genClass(cls).statics?.[name];
  if (!st) throw new Error(`${cls} 沒有轉出靜態欄位 ${name}`);
  st.set(v);
}
/** 委派呼叫：函式直接叫；事件（訂閱者陣列）逐一叫；null 不叫（呼叫端是 ?.Invoke） */
export function invokeDelegate(c: Ctx, d: unknown, ...args: any[]): any {
  void c;
  if (d == null) return undefined;
  if (typeof d === 'function') return d(...args);
  if (Array.isArray(d)) {
    let r: any;
    for (const f of [...d]) r = (f as (...a: any[]) => any)(...args);
    return r;
  }
  throw new Error('invokeDelegate：不是委派');
}
// ───────── 外部型別（DLL）的 new ─────────

const EXTERNAL_CTORS: Record<string, (...a: any[]) => object> = {};
/** 登記外部型別的建構（欄位的預設值、建構子參數的意思）；沒登記的 new 是帶 $type 的一般物件 */
export function registerExternalCtor(type: string, fn: (...a: any[]) => object): void {
  EXTERNAL_CTORS[type] = fn;
}
/**
 * DLL 裡的結構（Hash128、Resolution…：相容層用 { $type, 欄位 } 物件表示）登記成值型別：Equals、GetHashCode、Dictionary 的鍵照值比。
 * equals／hash 沒給就照欄位（跟產生的 struct 一樣）
 */
export interface ExternalValueType {
  equals?: (a: any, b: any) => boolean;
  hash?: (a: any) => number;
  /** 原型別的 ToString（字串插值、Object.ToString 用） */
  format?: (a: any) => string;
}
const VALUE_TYPES = new Map<string, ExternalValueType>();
export function registerValueType(type: string, impl: ExternalValueType = {}): void {
  VALUE_TYPES.set(type, impl);
}
export function externalValueType(x: unknown): ExternalValueType | undefined {
  const t = x && typeof x === 'object' ? (x as { $type?: unknown }).$type : undefined;
  return typeof t === 'string' ? VALUE_TYPES.get(t) : undefined;
}
/** new X(…)（X 是 DLL 裡的型別、相容層沒有專門的建構函式；轉換器寫）：登記的工廠，或 { $type } 加初始式 */
export function newExternal(c: Ctx, type: string, ...args: any[]): object {
  void c;
  const f = EXTERNAL_CTORS[type];
  if (f) return f(...args);
  if (args.length) throw new NotPorted(`new ${type}(…)`, '外部型別的建構子參數還沒對應', `new_${type}`);
  return { $type: type };
}

/** 泛型類別：實體記住型別引數（$targs，型別名字串），typeof(T) 用 typeArg 讀 */
export function newGenT(c: Ctx, cls: string, targs: string[], ctor: string | null, ...args: any[]): any {
  const obj = newInstanceObj(cls);
  obj.$targs = targs;
  const cc = ctxOf(c.w, obj, cls);
  if (ctor) {
    const fn = genClass(cls).methods[ctor];
    if (!fn) throw new Error(`${cls} 沒有轉出建構子 ${ctor}`);
    fn(cc, ...args);
  } else baseCtor0(cc, cls);
  return obj;
}
/** 型別值（型別名字串）的預設值：default(T) */
const NUMERIC_TYPES = new Set(['Int32', 'UInt32', 'Int64', 'UInt64', 'Int16', 'UInt16', 'Byte', 'SByte', 'Single', 'Double', 'Decimal', 'IntPtr', 'int', 'float', 'double', 'long', 'short', 'byte']);
const UNITY_STRUCT_DEFAULTS: Record<string, () => unknown> = {
  Vector2: () => ({ x: 0, y: 0 }),
  Vector3: () => ({ x: 0, y: 0, z: 0 }),
  Vector4: () => ({ x: 0, y: 0, z: 0, w: 0 }),
  Quaternion: () => ({ x: 0, y: 0, z: 0, w: 0 }),
  Color: () => ({ r: 0, g: 0, b: 0, a: 0 }),
  Color32: () => ({ r: 0, g: 0, b: 0, a: 0, $color32: true }),
  Vector2Int: () => ({ x: 0, y: 0 }),
  Vector3Int: () => ({ x: 0, y: 0, z: 0 }),
  Rect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
};
let isEnumType: (t: string) => boolean = () => false;
/** 列舉的底層型別（十六進位陣列的格式：i32、u8…），不是列舉回 null */
let enumKindOf: (t: string) => string | null = () => null;
/** dotnet.ts 登記列舉的判斷（core 不 import dotnet，免得循環） */
export function setEnumTypeCheck(fn: (t: string) => boolean, kind?: (t: string) => string | null): void {
  isEnumType = fn;
  if (kind) enumKindOf = kind;
}
export function defaultOf(t: string): unknown {
  t = baseTypeName(t);
  if (NUMERIC_TYPES.has(t) || isEnumType(t)) return 0;
  if (t === 'Boolean' || t === 'bool') return false;
  if (t === 'Char' || t === 'char') return '\0';
  const u = UNITY_STRUCT_DEFAULTS[t];
  if (u) return u();
  if (GEN[t]?.struct) return newGen(staticCtx, t, null);
  return null;
}
/** Dictionary 的建構（dotnet.ts 的 CsDict；core 不 import dotnet） */
let newDictHook: () => unknown = () => new Map();
export function setNewDictHook(fn: () => unknown): void {
  newDictHook = fn;
}
/** new T()（T 是型別參數）：產生的類別照無參數建構子；值型別給預設值 */
export function newT(c: Ctx, t: string): unknown {
  const full = t;
  t = baseTypeName(t);
  if (GEN[t]) return /<.+>$/.test(full) ? newGenT(c, t, splitTypeArgs(full), GEN[t].ctor0 ?? null) : newGen(c, t, GEN[t].ctor0 ?? null);
  const d = defaultOf(t);
  if (d !== null) return d;
  if (/^(List|HashSet|Queue|Stack)\$1$/.test(t)) return [];
  if (/^Dictionary\$2$/.test(t)) return newDictHook();
  throw new NotPorted('new T()', `${t} 沒有轉出`, `new_${t}`);
}
/** "Name<A, B<C, D>>" 的型別引數（照最外層的逗號切） */
export function splitTypeArgs(t: string): string[] {
  const i = t.indexOf('<');
  if (i < 0) return [];
  const inner = t.slice(i + 1, -1);
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** typeof(T)（T 是類別的第 i 個型別參數）：實體帶的型別引數；靜態方法或沒記到時給型別參數的名字 */
export function typeArg(c: Ctx, i: number, name: string, owner?: string): string {
  const self = c.self as ({ $targs?: string[] } & object) | null;
  if (!self) return name;
  const actual = actualClassOf(self);
  if (!owner || actual === owner) return self.$targs?.[i] ?? name;
  // 實際類別沿基底鏈往上：哪一層的基底是 owner，就用那一層傳給基底的型別引數
  for (let k = actual; k && GEN[k]; k = GEN[k].base ?? null) {
    if (GEN[k].base !== owner) continue;
    const t = GEN[k].baseTargs?.[i];
    if (!t) break;
    const m = /^\$targ:(\d+)$/.exec(t);
    return m ? (self.$targs?.[Number(m[1])] ?? name) : t;
  }
  return self.$targs?.[i] ?? name;
}
/** new 一個產生類別的資料物件：{ $type }、補初始值（沿基底鏈）、跑建構子 */
/** 產生類別的實體物件：一般是 { $type }；基底鏈上有 .NET 集合（extBase）就是那個集合本身再掛 $type 與欄位 */
// ───────── 實作集合介面的產生類別：JS 陣列的外觀 ─────────
// 轉換器把 IList<T>、IEnumerable<T> 這類介面型別的值當 JS 陣列寫（.length、[i]、for…of、LINQ 的陣列方法）。
// 實際傳進來的是產生類別（Malee 的 ReorderableArray<T>）時，實體本身包一層 Proxy：length、數字索引、for…of、
// 陣列方法照 C# 的介面成員分派（get_Count、get_Item、set_Item、Add、Insert、RemoveAt、Clear；不改內容的方法在快照上跑）。
// 只實作 IEnumerable 的（沒有索引子）加 Symbol.iterator，照 GetEnumerator 走。實體自己的欄位（c.ai 就是實體）照常讀寫。

const LIST_IFACES = new Set(['IList$1', 'IReadOnlyList$1', 'IList']);
const ENUM_IFACES = new Set(['IEnumerable$1', 'IEnumerable', 'ICollection$1', 'IReadOnlyCollection$1', 'ICollection']);
const collectionKinds = new Map<string, 'list' | 'enum' | null>();
function collectionKind(cls: string): 'list' | 'enum' | null {
  let kind = collectionKinds.get(cls);
  if (kind !== undefined) return kind;
  kind = null;
  for (let k: string | undefined = cls; k && GEN[k]; k = GEN[k].base) {
    for (const i of GEN[k].interfaces ?? []) {
      if (LIST_IFACES.has(i)) kind = 'list';
      else if (ENUM_IFACES.has(i) && !kind) kind = 'enum';
    }
    if (kind === 'list') break;
  }
  collectionKinds.set(cls, kind);
  return kind;
}
/** C# 的列舉器（產生的、相容層的、JS 的 iterator）照順序走完：dotnetLinq 登記（IEnumerator_MoveNext／get_Current 那一套） */
let enumerateHook: (e: unknown) => Iterable<unknown> = (e) => e as Iterable<unknown>;
export function setEnumerateHook(fn: (e: unknown) => Iterable<unknown>): void {
  enumerateHook = fn;
}
const isIndex = (p: string): boolean => p.length > 0 && p.length < 16 && /^(0|[1-9]\d*)$/.test(p);
function listFacade(obj: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line prefer-const
  let proxy: Record<string, unknown>;
  const call = (m: string, ...a: unknown[]): any => callIface(staticCtx, 'IList$1', m, proxy, ...a);
  const count = (): number => call('get_Count');
  const snapshot = (): unknown[] => Array.from({ length: count() }, (_, i) => call('get_Item', i));
  const mutators: Record<string, (...a: any[]) => unknown> = {
    push: (...xs: unknown[]) => {
      for (const x of xs) call('Add', x);
      return count();
    },
    splice: (start: number, del = count() - start, ...xs: unknown[]) => {
      const removed: unknown[] = [];
      for (let i = 0; i < del; i++) {
        removed.push(call('get_Item', start));
        call('RemoveAt', start);
      }
      xs.forEach((x, i) => call('Insert', start + i, x));
      return removed;
    },
  };
  proxy = new Proxy(obj, {
    get(t, p, r) {
      if (typeof p === 'string' && !(p in t)) {
        if (p === 'length') return count();
        if (isIndex(p)) return call('get_Item', Number(p));
        if (p in mutators) return mutators[p];
        const am = (Array.prototype as unknown as Record<string, unknown>)[p];
        if (typeof am === 'function') return (...a: unknown[]) => (am as (...x: unknown[]) => unknown).apply(snapshot(), a);
      } else if (p === Symbol.iterator && !(p in t)) {
        return function* () {
          const n = count();
          for (let i = 0; i < n; i++) yield call('get_Item', i);
        };
      }
      return Reflect.get(t, p, r);
    },
    set(t, p, v, r) {
      if (typeof p === 'string' && !(p in t)) {
        if (isIndex(p)) {
          call('set_Item', Number(p), v);
          return true;
        }
        if (p === 'length' && v === 0) {
          call('Clear');
          return true;
        }
      }
      return Reflect.set(t, p, v, r);
    },
  });
  return proxy;
}
function enumerableFacade(obj: Record<string, unknown>): Record<string, unknown> {
  Object.defineProperty(obj, Symbol.iterator, {
    enumerable: false,
    value: function* () {
      yield* enumerateHook(callIface(staticCtx, 'IEnumerable$1', 'GetEnumerator', obj));
    },
  });
  return obj;
}

function newInstanceObj(cls: string): Record<string, unknown> {
  let ext: string | undefined;
  for (let k: string | undefined = cls; k && GEN[k]; k = GEN[k].base) if (GEN[k].extBase) ext = GEN[k].extBase;
  if (!ext) {
    const kind = collectionKind(cls);
    return kind === 'list' ? listFacade({ $type: cls }) : kind === 'enum' ? enumerableFacade({ $type: cls }) : { $type: cls };
  }
  const backing = (/^(Sorted)?Dictionary\$2$|^SortedList\$2$/.test(ext) ? newDictHook() : []) as Record<string, unknown>;
  backing.$type = cls;
  return backing;
}
export function newGen(c: Ctx, cls: string, ctor: string | null, ...args: any[]): any {
  const obj = newInstanceObj(cls);
  const cc = ctxOf(c.w, obj, cls);
  if (ctor) {
    const fn = genClass(cls).methods[ctor];
    if (!fn) throw new Error(`${cls} 沒有轉出建構子 ${ctor}`);
    fn(cc, ...args);
  } else baseCtor0(cc, cls);
  return obj;
}
/**
 * tuple 的具名元素（轉換器的 TupleItem）：C# 的 tuple 名字只在編譯期，有名字的型別可能接到沒名字建的 { Item1, Item2 }（或別的名字），
 * 物件有這個名字照名字取，沒有照位置取（產生的 tuple 物件欄位照元素順序）
 */
export function tupleItem(t: unknown, name: string, i: number): unknown {
  const o = t as Record<string, unknown>;
  return name in o ? o[name] : Object.values(o)[i];
}
/**
 * 直接基底是 DLL 型別的資料類別（MT2 的 FakePointerEventData : PointerEventData）：轉換器把建構子的 : base(…) 寫成相容層的建構子，
 * 建出來的基底欄位併進這個實體（相容層的屬性讀的就是它們，PointerEventData_get_button 讀 button）。$type、$isa 與同名的欄位留產生類別自己的。
 * 基底是集合（InkList : Dictionary 的 base(otherList)）：實體本身就是那個集合（newInstanceObj 的 extBase），把建好的內容抄進來
 */
export function dllBaseInit(c: Ctx, base: unknown): void {
  if (!base || typeof base !== 'object') return;
  const self = c.self as Record<string, unknown>;
  if (self instanceof Map && base instanceof Map) {
    for (const [k, v] of base) self.set(k, v);
    return;
  }
  if (Array.isArray(self) && Array.isArray(base)) {
    self.push(...base);
    return;
  }
  for (const [k, v] of Object.entries(base)) if (k !== '$type' && k !== '$isa' && !(k in self)) self[k] = v;
}
/**
 * 無參數建構子（含 C# 隱含的 base()）：從 cls 往基底找第一個有 ctor0 的類別跑它（它自己會再往上叫，轉換器在建構子開頭寫 R.baseCtor0）。
 * 沒有任何一層有明寫的建構子就什麼都不做（欄位初始式已經在 initAi）。
 */
export function baseCtor0(c: Ctx, cls: string): void {
  for (let k: string | undefined = cls; k && GEN[k]; k = GEN[k].base) {
    const g = genClass(k);
    if (g.ctor0 && g.methods[g.ctor0]) {
      g.methods[g.ctor0](c);
      return;
    }
  }
}
/**
 * 產生方法自己的 out 參數（轉換器在方法開頭寫 p = R.outBox(p)）：呼叫端傳的是回呼 (v) => { x = v; }，包成 { v } 盒子，
 * 寫 .v 的時候也叫回呼；已經是盒子（ref 的 { get v, set v }）就照用
 */
export function outBox(p: unknown): { v: unknown } {
  if (typeof p !== 'function') return p && typeof p === 'object' && 'v' in p ? (p as { v: unknown }) : { v: undefined };
  let cur: unknown;
  return {
    get v() {
      return cur;
    },
    set v(x: unknown) {
      cur = x;
      (p as (v: unknown) => void)(x);
    },
  };
}
/** x as T：型別符合就是 x，不符合是 null（值型別與 object 轉換器不寫這個） */
export function asType(c: Ctx, x: unknown, type: string): unknown {
  return isInstance(c, x, type) ? x : null;
}
/** 型別值去掉泛型引數（"List$1<Int32>" → "List$1"）：找產生的類別、判斷種類時用 */
export function baseTypeName(t: string): string {
  const i = t.indexOf('<');
  return i < 0 ? t : t.slice(0, i);
}

// ───────── 型別判斷與介面分派 ─────────

/** 類別名 → 它與基底鏈、介面的全部名字（產生的類別看 base／interfaces，沒產生的看 World 的 hierarchy） */
function typeNamesOf(w: World | null, cls: string): Set<string> {
  const out = new Set<string>([cls]);
  for (let k: string | undefined = cls; k; ) {
    const g: GenClassImpl | undefined = GEN[k];
    if (!g) {
      for (const b of w?.services.hierarchy?.[k] ?? []) out.add(b);
      break;
    }
    for (const i of g.interfaces ?? []) out.add(i);
    if (g.extBase) out.add(g.extBase);
    for (const b of g.dllBases ?? []) out.add(b);
    if (!g.base) {
      for (const b of w?.services.hierarchy?.[k] ?? []) out.add(b);
      break;
    }
    out.add(g.base);
    k = g.base;
  }
  return out;
}
/**
 * 元件是不是某個型別（GetComponent<T> 等）：元件型別（Image、Camera…）、腳本類別（含帶 namespace 的產生名）、
 * 產生類別的基底鏈與介面、或 World 的 hierarchy（沒有轉的 DLL 類別的基底鏈）
 */
export function compIsType(w: World, comp: ComponentData, type: string): boolean {
  if (comp.type === type) return true;
  const script = comp.script;
  if (!script?.class) return false;
  if (script.class === type) return true;
  const g = scriptGenName(script)!;
  if (g === type) return true;
  if (GEN[g] && typeNamesOf(w, g).has(type)) return true;
  return (w.services.hierarchy?.[script.class] ?? []).includes(type);
}
/** 型別的全部名字（自己、基底鏈、介面）：反射的 IsAssignableFrom／IsSubclassOf 用 */
export function typeNames(w: World | null, cls: string): Set<string> {
  return typeNamesOf(w, cls);
}
/** 產生類別的基底（原始碼裡宣告的）；沒有回 null */
/** [RequireComponent]：類別與（產生的）基底鏈要求的元件型別 */
export function requiredComponentsOf(cls: string): string[] {
  const out: string[] = [];
  for (let k: string | undefined = cls; k && GEN[k]; k = GEN[k].base) for (const r of GEN[k].requires ?? []) if (!out.includes(r)) out.push(r);
  return out;
}
export function genBaseOf(cls: string): string | null {
  return GEN[cls]?.base ?? null;
}
const PRIMITIVE_TYPES: Record<string, string> = { string: 'String', number: 'Single', boolean: 'Boolean', function: 'Delegate' };
/**
 * C# 的 `x is T`（轉換器在相容層有這個函式時寫）：null 是 false；場景物件照元件的類別（含基底鏈、介面）；
 * Transform／GameObject 的 H 照種類；資料物件照 $type；基本型別照 JS 型別。
 */
let assetTypeCheck: (x: object, type: string) => boolean | null = () => null;
/** 資產參照的型別判斷（unity.ts 登記：prefab 裡的物件照它的元件型別） */
export function setAssetTypeCheck(fn: (x: object, type: string) => boolean | null): void {
  assetTypeCheck = fn;
}
export function isInstance(c: Ctx, x: unknown, type: string): boolean {
  if (x == null) return false;
  type = baseTypeName(type);
  if (x instanceof H) {
    if (x.kind === 'go') return type === 'GameObject' || type === 'Object';
    if (x.kind === 'transform') return type === 'Transform' || type === 'Component' || type === 'Object' || (type === 'RectTransform' && x.node.transform.type === 'RectTransform');
    const comp = x.comp!;
    const cls = scriptGenName(comp.script) ?? comp.type;
    if (type === 'Component' || type === 'Object') return true;
    if (type === 'MonoBehaviour' || type === 'Behaviour') return !!comp.script || type === 'Behaviour';
    return typeNamesOf(c.w, cls).has(type);
  }
  if (typeof x === 'object') {
    const t = (x as { $type?: string }).$type;
    if ((x as { $isa?: string[] }).$isa?.includes(type)) return true;
    if (typeof t === 'string') return typeNamesOf(c.w, t).has(type);
    // JS 內建的集合：Dictionary 是 Map、List 與陣列是 JS 陣列
    if (x instanceof Map) return MAP_TYPES.has(type);
    if (Array.isArray(x)) return ARRAY_TYPES.has(type) || type.endsWith('[]');
    // 資產上的物件（{ guid, fileID }：prefab 裡的 GameObject／元件、Sprite…）：相容層看資產判斷
    if (typeof (x as { guid?: unknown }).guid === 'string' && 'fileID' in x) {
      const r = assetTypeCheck(x, type);
      if (r !== null) return r;
    }
    // C# 的迭代器方法（yield return）轉成 JS 的產生器：編譯器產生的類別實作 IEnumerator<T>、IEnumerator、IDisposable
    // （回傳 IEnumerable 的迭代器另外實作 IEnumerable，從產生器分不出來，不算）
    if (isJsGenerator(x)) return GENERATOR_TYPES.has(type);
    return type === 'Object';
  }
  if (type === 'Object') return true;
  // 委派（產生碼裡是 JS 函式）：簽章分不出來，System 的委派家族與 Delegate 都算
  if (typeof x === 'function') return DELEGATE_TYPES.has(type) || /^(Action|Func)(\$\d+)?$/.test(type);
  if (typeof x === 'number') return NUMBER_TYPES.has(type) && (!INT_TYPES.has(type) || Number.isInteger(x));
  if (typeof x === 'string') return STRING_TYPES.has(type);
  return PRIMITIVE_TYPES[typeof x] === type;
}
const MAP_TYPES = new Set(['Dictionary$2', 'IDictionary$2', 'IDictionary', 'IReadOnlyDictionary$2', 'ICollection$1', 'ICollection', 'IEnumerable$1', 'IEnumerable', 'IReadOnlyCollection$1']);
const ARRAY_TYPES = new Set(['List$1', 'IList$1', 'IList', 'ICollection$1', 'ICollection', 'IEnumerable$1', 'IEnumerable', 'IReadOnlyList$1', 'IReadOnlyCollection$1', 'Array', 'HashSet$1', 'ISet$1', 'Queue$1', 'Stack$1']);
const GENERATOR_TYPES = new Set(['IEnumerator$1', 'IEnumerator', 'IDisposable', 'Object']);
const DELEGATE_TYPES = new Set(['Delegate', 'MulticastDelegate', 'ICloneable', 'Predicate$1', 'Comparison$1', 'Converter$2', 'EventHandler', 'EventHandler$1', 'UnityAction', 'UnityAction$1', 'UnityAction$2', 'UnityAction$3', 'UnityAction$4']);
const GeneratorProto = Object.getPrototypeOf(function* () {}.prototype);
/** C# 的迭代器方法轉成的 JS 產生器物件 */
export const isJsGenerator = (x: unknown): x is Generator => typeof x === 'object' && x !== null && GeneratorProto.isPrototypeOf(x);
const INT_TYPES = new Set(['Int32', 'Int64', 'Int16', 'UInt32', 'UInt64', 'UInt16', 'Byte', 'SByte']);
const NUMBER_TYPES = new Set([...INT_TYPES, 'Single', 'Double', 'Decimal', 'ValueType', 'IComparable', 'IConvertible', 'IFormattable']);
const STRING_TYPES = new Set(['String', 'IEnumerable', 'IEnumerable$1', 'IComparable', 'ICloneable', 'IConvertible']);

/**
 * 泛型介面的方法（IDataView<DataType>.Set）：targs 是呼叫端的型別引數（執行期的型別名，同 R.typeArg）。
 * 類別實作了同一個泛型介面的好幾種封閉型別時，照 ifaceImpls 找對應的實作（照實際類別虛擬分派）；
 * 沒有對照表的類別只實作一種，跟 callIface 一樣找
 */
export function callIfaceT(c: Ctx, iface: string, targs: string[], method: string, recv: object | null, ...args: any[]): any {
  if (recv) {
    const live = liveObj(recv);
    const key = `${iface}<${targs.join(', ')}>$${method}`;
    for (let k = actualClassOf(live); k; k = GEN[k]?.base ?? null) {
      const impl = GEN[k]?.ifaceImpls?.[key];
      if (impl) return genCall(c.w, dispatchClass(live, k, impl), live, impl, ...args);
    }
  }
  return callIface(c, iface, method, recv, ...args);
}

/**
 * 介面方法與屬性（轉換器在相容層有這個函式時寫）：照實體的實際類別沿產生的基底鏈找實作。
 * 先找明確介面實作（產生名「介面$方法」），再找同名（多載時 名字$…）。屬性（get_／set_名字）沒有產生的方法時是自動屬性：讀寫實體的欄位。
 */
export function callIface(c: Ctx, iface: string, method: string, recv: object | null, ...args: any[]): any {
  if (!recv) throw new Error(`${iface}.${method}：對象是 null（C# 這裡會 NullReferenceException）`);
  recv = liveObj(recv);
  const explicit = `${iface}$${method}`;
  for (let k = actualClassOf(recv); k; k = GEN[k]?.base ?? null) {
    const g = GEN[k];
    if (!g) break;
    const names = Object.keys(g.methods);
    const key = g.methods[explicit]
      ? explicit
      : (names.find((n) => n.startsWith(`${explicit}$`)) ?? (g.methods[method] ? method : names.find((n) => n.startsWith(`${method}$`))));
    if (key) return genCall(c.w, k, recv, key, ...args);
  }
  // 對象是 JS 內建的集合（Dictionary 是 Map、List／陣列）：照 IDictionary／IList／ICollection 的語意
  const builtin = builtinIface(recv, method, args);
  if (builtin !== NO_BUILTIN) return builtin;
  const m = /^(get|set)_(.+)$/.exec(method);
  if (m && actualClassOf(recv) && GEN[actualClassOf(recv)!]) {
    if (m[1] === 'get') return mbGet(c, recv as H, m[2]);
    mbSet(c, recv as H, m[2], args[0]);
    return undefined;
  }
  throw new NotPorted(`${iface}.${method}`, `${actualClassOf(recv) ?? '?'} 沒有產生的實作`, `${iface}_${method}`);
}

const NO_BUILTIN = Symbol('no-builtin');
/** 介面方法打到 JS 內建的 Map（IDictionary）或陣列（IList、ICollection、IReadOnlyList…） */
function builtinIface(recv: object, method: string, args: any[]): any {
  if (recv instanceof Map) {
    const k = args[0];
    switch (method) {
      case 'ContainsKey': return recv.has(k);
      case 'Add':
        if (recv.has(k)) throw new Error(`C# ArgumentException：An item with the same key has already been added. Key: ${String(k)}`);
        recv.set(k, args[1]);
        return undefined;
      case 'Remove': return recv.delete(k);
      case 'TryGetValue':
        (args[1] as (v: unknown) => void)(recv.has(k) ? recv.get(k) : null);
        return recv.has(k);
      case 'get_Item':
        if (!recv.has(k)) throw new Error(`C# KeyNotFoundException：The given key '${String(k)}' was not present in the dictionary.`);
        return recv.get(k);
      case 'set_Item': recv.set(k, args[1]); return undefined;
      case 'get_Count': return recv.size;
      case 'get_Keys': return [...recv.keys()];
      case 'get_Values': return [...recv.values()];
      case 'Clear': recv.clear(); return undefined;
      case 'GetEnumerator': return [...recv.entries()].map(([Key, Value]) => ({ Key, Value }))[Symbol.iterator]();
    }
    return NO_BUILTIN;
  }
  if (Array.isArray(recv)) {
    const x = args[0];
    switch (method) {
      case 'Add': recv.push(x); return undefined;
      case 'Contains': return recv.includes(x);
      case 'Remove': {
        const i = recv.indexOf(x);
        if (i < 0) return false;
        recv.splice(i, 1);
        return true;
      }
      case 'IndexOf': return recv.indexOf(x);
      case 'Insert': recv.splice(x, 0, args[1]); return undefined;
      case 'RemoveAt': recv.splice(x, 1); return undefined;
      case 'get_Count': return recv.length;
      case 'get_Item': return recv[x];
      case 'set_Item': recv[x] = args[1]; return undefined;
      case 'Clear': recv.length = 0; return undefined;
      case 'CopyTo': for (let i = 0; i < recv.length; i++) (x as unknown[])[args[1] + i] = recv[i]; return undefined;
      case 'get_IsReadOnly': return false;
      case 'GetEnumerator': return recv[Symbol.iterator]();
    }
    return NO_BUILTIN;
  }
  // 執行環境自己的物件（Addressables 的非同步操作這類）：方法照名字、get_／set_ 照屬性名
  if (!(recv instanceof H) && !(typeof (recv as { $type?: unknown }).$type === 'string' && GEN[(recv as { $type: string }).$type])) {
    const r = recv as Record<string, unknown>;
    if (typeof r[method] === 'function') return (r[method] as (...a: unknown[]) => unknown)(...args);
    const pm = /^(get|set)_(.+)$/.exec(method);
    if (pm && pm[1] === 'get' && pm[2] in r) return r[pm[2]];
    if (pm && pm[1] === 'set') {
      r[pm[2]] = args[0];
      return undefined;
    }
  }
  return NO_BUILTIN;
}

// ───────── C# 的事件與委派 ─────────
// 委派：函式（單一）或函式陣列（多播，照加入順序）；null 是空。事件（field-like event）存在 eventAdd 的表裡，key 是「型別.事件名」。
// 實例事件照接收者分表，表裡只用事件名：透過介面訂閱（IVideoPlayer.LoopPointReached）跟實作類別自己發（VideoPlayerUnity.LoopPointReached）
// 是同一個事件，產生碼只看得到宣告型別。同一個物件上兩個同名事件（new 遮蔽、兩個介面的明確實作）會併在一起，遊戲碼很少這樣寫。
// 靜態事件沒有接收者，照「型別.事件名」分。

const events = new WeakMap<object, Map<string, ((...a: any[]) => any)[]>>();
const staticEvents = new Map<string, ((...a: any[]) => any)[]>();
function eventList(key: string, recv: object | null, create: boolean): ((...a: any[]) => any)[] | null {
  let byKey: Map<string, ((...a: any[]) => any)[]> | undefined;
  if (recv) {
    key = key.slice(key.lastIndexOf('.') + 1);
    byKey = events.get(recv);
    if (!byKey) {
      if (!create) return null;
      events.set(recv, (byKey = new Map()));
    }
  } else byKey = staticEvents;
  let list = byKey.get(key);
  if (!list) {
    if (!create) return null;
    byKey.set(key, (list = []));
  }
  return list;
}
/**
 * 事件 += h：h 可以是多播委派（另一個事件讀出來的呼叫清單，MT2 CoroutineSignal.Clone 的 `copy.Listener += Listener`），
 * 照 Delegate.Combine 把它的呼叫清單接上去（10/17 以前整個陣列塞成一個元素，呼叫時「不是函式」）
 */
export function eventAdd(c: Ctx, key: string, recv: object | null, h: unknown): void {
  void c;
  const add = delegateList(h);
  if (add.length) eventList(key, recv, true)!.push(...add);
}
/** 事件 -= h：照 Delegate.Remove 拿掉最後一段跟 h 的呼叫清單相同的連續元素 */
export function eventRemove(c: Ctx, key: string, recv: object | null, h: unknown): void {
  void c;
  const list = eventList(key, recv, false);
  const sub = delegateList(h);
  if (!list || sub.length === 0) return;
  for (let i = list.length - sub.length; i >= 0; i--) {
    if (sub.every((f, j) => list[i + j] === f)) {
      list.splice(i, sub.length);
      return;
    }
  }
}
/** 宣告事件的類別裡把事件當委派欄位指定（Listener = AddUnique(Listener, callback)）：呼叫清單整個換掉 */
export function eventSet(c: Ctx, key: string, recv: object | null, d: unknown): void {
  void c;
  const list = eventList(key, recv, true)!;
  list.length = 0;
  list.push(...delegateList(d));
}
/** 事件當成委派讀（handler?.Invoke()）：沒有訂閱者是 null */
export function eventGet(c: Ctx, key: string, recv: object | null): ((...a: any[]) => any)[] | null {
  void c;
  const list = eventList(key, recv, false);
  return list && list.length > 0 ? [...list] : null;
}
function delegateList(d: unknown): ((...a: any[]) => any)[] {
  if (d == null) return [];
  if (Array.isArray(d)) return d as ((...a: any[]) => any)[];
  if (typeof d === 'function') return [d as (...a: any[]) => any];
  throw new Error('不是委派');
}
/** Delegate.Combine(a, b)：a 的呼叫清單接上 b 的；結果只剩一個時回函式本身 */
export function Delegate_Combine(c: Ctx, a: unknown, b: unknown): unknown {
  void c;
  const all = [...delegateList(a), ...delegateList(b)];
  return all.length === 0 ? null : all.length === 1 ? all[0] : all;
}
/** Delegate.Remove(a, b)：從 a 的呼叫清單拿掉最後一段等於 b 的（b 是單一委派時就是最後一個相同的函式） */
export function Delegate_Remove(c: Ctx, a: unknown, b: unknown): unknown {
  void c;
  const list = [...delegateList(a)];
  const sub = delegateList(b);
  if (sub.length === 0) return a ?? null;
  for (let i = list.length - sub.length; i >= 0; i--) {
    if (sub.every((f, j) => list[i + j] === f)) {
      list.splice(i, sub.length);
      break;
    }
  }
  return list.length === 0 ? null : list.length === 1 ? list[0] : list;
}
export function MulticastDelegate_GetInvocationList(c: Ctx, d: unknown): ((...a: any[]) => any)[] {
  void c;
  return [...delegateList(d)];
}

// ───────── Unity 反序列化：存檔值 → 產生類別的資料物件 ─────────

/**
 * 十六進位字串（Unity 的數字陣列）→ 數字陣列：i32、u32、i16、u16、u8、i8、f32、i64。
 * AssetRipper 匯出的 YAML 把 ffffffff（−1）寫成 ffffff/f：MT2 的 3300 多處 SerializableDictionary 的 _keys 全是這個形狀，
 * 「/」只出現在全是 f 的那 8 個字裡，當 f 讀（為什麼寫成「/」未查證）。以前 parseInt('/f') 是 NaN 存成 0，−1 變成 16777215，
 * 以 MasteryFrameType.None（−1）查 sprite 的 MasterySpriteSelector 找不到東西，把卡名底板整個關掉
 */
export function decodeHexArray(hex: string, kind: string): number[] {
  if (hex.includes('/')) hex = hex.replace(/\//g, 'f');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  const dv = new DataView(bytes.buffer);
  const size = { i32: 4, u32: 4, f32: 4, i16: 2, u16: 2, u8: 1, i8: 1, i64: 8 }[kind] ?? 4;
  const out: number[] = [];
  for (let o = 0; o + size <= bytes.length; o += size) {
    switch (kind) {
      case 'u32': out.push(dv.getUint32(o, true)); break;
      case 'f32': out.push(dv.getFloat32(o, true)); break;
      case 'i16': out.push(dv.getInt16(o, true)); break;
      case 'u16': out.push(dv.getUint16(o, true)); break;
      case 'u8': out.push(dv.getUint8(o)); break;
      case 'i8': out.push(dv.getInt8(o)); break;
      case 'i64': out.push(Number(dv.getBigInt64(o, true))); break;
      default: out.push(dv.getInt32(o, true));
    }
  }
  return out;
}
/** 資料類別的欄位型別描述（沿產生的基底鏈找；GenClassImpl.fields 只列要特別處理的：@類別、[x]、{x}） */
export function fieldDescOf(cls: string, field: string): string | undefined {
  return fieldDescIn(cls, field)?.[0];
}
/** 欄位描述與宣告它的類別（描述裡的 $targ:i 是宣告類別的第 i 個型別參數） */
function fieldDescIn(cls: string, field: string): [string, string] | undefined {
  for (let k: string | undefined = cls; k && GEN[k]; k = GEN[k].base) {
    const d = GEN[k].fields?.[field];
    if (d) return [d, k];
  }
  return undefined;
}
/** 實體的類別（cls、自己的型別引數 own）沿基底鏈往上，到宣告類別 decl 時它的型別引數（照每一層的 baseTargs 換） */
function targsAt(cls: string, own: readonly string[] | undefined, decl: string): string[] | null {
  let targs: readonly string[] = own ?? [];
  for (let k: string | undefined = cls; k && GEN[k]; k = GEN[k].base) {
    if (k === decl) return [...targs];
    const bt: string[] | undefined = GEN[k].baseTargs;
    targs = bt ? bt.map((a) => (a.startsWith('$targ:') ? targs[Number(a.slice(6))] : a)) : [];
  }
  return null;
}
/** 型別引數 → 欄位描述：字串 $s、數字（List<int> 的十六進位）、產生的資料類別 @名字，其他照原樣複製（-） */
const PRIM_DESC: Record<string, string> = { String: '$s', Int32: '$i32', UInt32: '$u32', Int16: '$i16', UInt16: '$u16', Byte: '$u8', SByte: '$i8', Single: '$f32', Int64: '$i64' };
function targDesc(t: string | undefined): string {
  if (!t) return '-';
  if (PRIM_DESC[t]) return PRIM_DESC[t];
  // 列舉（SerializableDictionary<列舉, X> 的 TKey[] _keys）：照底層型別解十六進位陣列，同非泛型欄位的列舉陣列
  const ek = enumKindOf(t);
  if (ek) return `$${ek}`;
  return t in GEN ? `@${t}` : '-';
}
function substTargs(desc: string, cls: string | undefined, own: readonly string[] | undefined, decl: string | undefined): string {
  const targs = cls && decl ? targsAt(cls, own, decl) : null;
  return desc.replace(/\$targ:(\d+)/g, (_, i: string) => targDesc(targs?.[Number(i)]));
}
/** 存檔裡的物件參照（{fileID}、{guid, fileID, type}）：不是資料物件 */
function isPPtr(raw: object): boolean {
  const keys = Object.keys(raw);
  return keys.includes('fileID') && keys.every((k) => k === 'fileID' || k === 'guid' || k === 'type');
}
/**
 * 場景／prefab 存檔值 → 產生類別的資料物件，照 Unity 反序列化 [Serializable] 類別與結構的做法：先 new（欄位初始式、宣告的無參數建構子），
 * 再蓋上存檔裡有的欄位。desc 是轉換器的欄位型別描述（@類別、[x] 陣列或 List、{x} Dictionary）。
 * 推定 Unity 會跑無參數建構子（diceomancer-web 的 PlayerCareerUpgradeInfo 的三顆能量球就是建構子放的）。
 */
let deserializeDepth = 0;
/**
 * 資料類別（不是 UnityEngine.Object）沒有初值的 List 欄位的預設值（轉換器在 initAi 產生）：Unity 反序列化建的物件是空清單，
 * 程式碼 new 出來的是 null（C# 的預設）
 */
export function serializedListDefault(): unknown[] | null {
  return deserializeDepth > 0 ? [] : null;
}
/** 在 Unity 序列化器的情境裡建物件（JsonUtility.FromJson 等）：期間 new 的資料類別，沒有初值的 List 欄位是空清單 */
export function asDeserializing<T>(fn: () => T): T {
  deserializeDepth++;
  try {
    return fn();
  } finally {
    deserializeDepth--;
  }
}

export function unityData(c: Ctx, desc: string, raw: unknown, decl?: string): any {
  // 宣告在泛型基底的欄位（ReorderableArray<T> 的 List<T> array）：$targ:i 照實體的型別引數換成實際的描述
  if (desc.includes('$targ:')) {
    const self = c.self as { $type?: string; $targs?: string[] } | null;
    const cls = self instanceof H ? scriptGenName(self.comp?.script) : self?.$type;
    desc = substTargs(desc, cls, self instanceof H ? undefined : self?.$targs, decl);
  }
  // 字串：Unity 反序列化不會給 null。YAML 把只有數字的字串（對話指令的參數 `- 500`）讀成數字，這裡換回字串
  //（前導零、小數的寫法在匯入時已經沒了，例如 "007" 會變成 "7"：差異清單）
  if (desc === '$s') return raw === null || raw === undefined ? '' : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : raw;
  // char：YAML 存的是 UTF-16 碼（數字），產生碼裡的 char 是長度 1 的字串
  if (desc === '$c') return typeof raw === 'number' ? String.fromCharCode(raw) : (raw ?? '\0');
  // 陣列與 List：Unity 反序列化不會給 null（YAML 寫成空值的 `additionalTriggerStages:` 是空的十六進位陣列）
  if ((raw === null || raw === undefined) && desc.startsWith('[')) return [];
  if (raw === null || raw === undefined) return raw;
  // 數字陣列：Unity 的 YAML 存成十六進位字串（小端序）
  // （char[] 的 YAML 格式未查證：不當十六進位解，照原樣複製）
  if (desc.startsWith('[$') && typeof raw === 'string' && desc !== '[$c]') return decodeHexArray(raw, desc.slice(2, -1));
  if (desc.startsWith('[')) return Array.isArray(raw) ? raw.map((x) => unityData(c, desc.slice(1, -1), x)) : cloneData(raw);
  if (desc.startsWith('@') && typeof raw === 'object' && !isPPtr(raw as object)) {
    const cls = desc.slice(1);
    deserializeDepth++;
    let obj: Record<string, unknown>;
    try {
      obj = newGen(c, cls, genClass(cls).ctor0 ?? null) as Record<string, unknown>;
    } finally {
      deserializeDepth--;
    }
    const oc = ctxOf(c.w, obj, cls);
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const fd = fieldDescIn(cls, k);
      obj[k] = fd ? unityData(oc, fd[0], v, fd[1]) : cloneData(v);
    }
    afterDeserialize(ctxOf(c.w, obj, cls), cls);
    return obj;
  }
  // {x}：Unity 不序列化 Dictionary，存檔裡不會有；其他照舊複製
  return cloneData(raw);
}

// ───────── 元件欄位的通用存取（相容層沒有專門名字的元件欄位） ─────────

/** 沒轉的元件被寫過的欄位：蓋在存檔值上 */
const overlay = new WeakMap<H, Record<string, unknown>>();
/** 元件欄位讀：轉過的類別讀它的 ai；沒轉的讀被寫過的值，再來是存檔值（參照解析成 H） */
export function mbGet(c: Ctx, h: H | null, name: string): any {
  if (!h) throw new Error(`讀 ${name}：對象是 null（C# 會 NullReferenceException）`);
  h = liveObj(h);
  if (!(h instanceof H)) return (h as Record<string, unknown>)[name];
  const cls = scriptGenName(h.comp?.script);
  const g = cls && GEN[cls] ? ctxOf(c.w, h, cls) : ctxs.get(h);
  if (g && name in g.ai) return g.ai[name];
  const o = overlay.get(h);
  if (o && name in o) return o[name];
  if (!h.comp) throw new Error(`讀 ${name}：不是元件`);
  return resolveValue(c.w!, h.comp[name]);
}
/** 元件欄位寫：轉過的類別寫進它的 ai；沒轉的記在 overlay */
export function mbSet(c: Ctx, h: H | null, name: string, v: unknown): void {
  if (!h) throw new Error(`寫 ${name}：對象是 null（C# 會 NullReferenceException）`);
  h = liveObj(h);
  if (!(h instanceof H)) {
    (h as Record<string, unknown>)[name] = v;
    return;
  }
  const cls = scriptGenName(h.comp?.script);
  const g = cls && GEN[cls] ? ctxOf(c.w, h, cls) : ctxs.get(h);
  if (g && name in g.ai) {
    g.ai[name] = v;
    return;
  }
  let o = overlay.get(h);
  if (!o) overlay.set(h, (o = {}));
  o[name] = v;
}

// ───────── 時間 ─────────

let currentDelta = 0;
/** Time.deltaTime：genBehaviour 在叫 Update／FixedUpdate 之前設 */
export function setCurrentDelta(dt: number): void {
  currentDelta = dt;
}
export function currentDeltaTime(): number {
  return currentDelta;
}

// ───────── 產生的 MonoBehaviour → World 的 Behaviour ─────────

/** Time.fixedDeltaTime 與 Maximum Allowed Timestep 的 Unity 預設（ProjectSettings/TimeManager）；遊戲不同時用 setFixedTimestep 改 */
let FIXED_DT = 0.02;
let MAX_DT = 0.33333334;
export function setFixedTimestep(fixed: number, maxAllowed: number): void {
  FIXED_DT = fixed;
  MAX_DT = maxAllowed;
}

/** Unity 會序列化的欄位，沿產生的基底鏈（基底的在前） */
export function serializedFieldsOf(cls: string): string[] {
  const chain: string[][] = [];
  for (let k: string | undefined = cls; k && GEN[k]; k = GEN[k].base) chain.unshift(GEN[k].serialized ?? []);
  return chain.flat();
}

/** 沿產生的基底鏈合併方法（衍生類別的同名方法蓋掉基底的） */
/** Unity 叫的沒有參數的訊息（genBehaviour 照名字掛） */
const LIFECYCLE_MESSAGES = ['Awake', 'Start', 'OnEnable', 'OnDisable', 'OnDestroy', 'Update', 'LateUpdate', 'FixedUpdate', 'OnBecameVisible', 'OnBecameInvisible', 'OnApplicationQuit'];
/**
 * 原生基底自己有的訊息（Graphic.OnEnable 登記重建、OnDisable 清掉 CanvasRenderer）：產生的類別（含基底鏈）沒覆寫時，Unity 叫的是原生基底那一版。
 * unityNative 登記查法（原生類別 → 它的 base.X() 實作）；只看這兩個
 */
const NATIVE_FALLBACK_MESSAGES = ['OnEnable', 'OnDisable'];
let nativeMessageLookup: (nativeClass: string, message: string) => ((c: Ctx, self: unknown) => unknown) | undefined = () => undefined;
export function setNativeMessageLookup(fn: typeof nativeMessageLookup): void {
  nativeMessageLookup = fn;
}
/** 產生的基底鏈接到的第一個原生類別（UIPrimitiveBase → MaskableGraphic）；沒有回 null */
export function genNativeBaseOf(cls: string): string | null {
  let k: string | undefined = cls;
  while (k && GEN[k]) k = GEN[k].base;
  return k ?? null;
}
function methodsWithBase(cls: string): Record<string, (c: Ctx, ...a: any[]) => any> {
  const chain: GenClassImpl[] = [genClass(cls)];
  for (let k = chain[0].base; k && GEN[k]; k = chain[chain.length - 1].base) chain.push(GEN[k]);
  const m: Record<string, (c: Ctx, ...a: any[]) => any> = {};
  for (const g of chain.reverse()) Object.assign(m, g.methods);
  return m;
}

/**
 * 訊息（動畫事件、SendMessage）的接收方法：類別（含基底鏈）裡叫這個名字的方法。沒有多載就是那一個；
 * 有多載（產生名「名字$參數…」）時先找沒有參數的，再找參數是 Unity 能帶的型別的。回傳產生名、參數個數與參數種類（msgArgs）。
 */
export function messageReceiver(cls: string, name: string): { method: string; arity: number; kind?: string } | null {
  if (!GEN[cls]) return null;
  const m = methodsWithBase(cls);
  const kindOf = (method: string): string | undefined => {
    for (let k: string | undefined = cls; k && GEN[k]; k = GEN[k].base) if (GEN[k].msgArgs?.[method]) return GEN[k].msgArgs![method];
    return undefined;
  };
  const found = Object.keys(m).filter((k) => k === name || k.startsWith(`${name}$`));
  if (!found.length) return null;
  const info = (method: string) => ({ method, arity: Math.max(0, m[method].length - 1), kind: kindOf(method) });
  if (found.length === 1) return info(found[0]);
  const all = found.map(info);
  return all.find((x) => x.arity === 0) ?? all.find((x) => x.arity === 1 && x.kind && x.kind !== '?') ?? all[0];
}

/** uGUI 事件給產生碼的 PointerEventData／BaseEventData：只帶 button 與 eligibleForClick（相容層的 PointerEventData_* 讀它） */
export interface EventDataLike {
  /** 型別與基底鏈（isInstance 看：x is PointerEventData、x is BaseEventData） */
  $type: string;
  $isa: string[];
  button: number;
  eligibleForClick: boolean;
  used: boolean;
  /** 螢幕位置（Unity 的像素，原點左下）：事件當下的滑鼠位置 */
  position: { x: number; y: number };
}
const POINTER_ISA = ['PointerEventData', 'BaseEventData', 'AbstractEventData'];
export function pointerEventData(world: World, button = 0): EventDataLike {
  return { $type: 'PointerEventData', $isa: POINTER_ISA, button, eligibleForClick: true, used: false, position: { x: world.mouse.x, y: world.mouse.y } };
}
/**
 * 拖曳、放開、捲動的 PointerEventData：事件系統（engine/events.ts）那一份的位置、按下位置、捲動量、拖曳門檻都帶上
 * （ShinyShoe 的 CoreInputDataAxis.BeginWith／UpdateWith 讀 position；Slider 類的 OnInitializePotentialDrag 改 useDragThreshold）
 */
export function pointerEventDataFrom(
  ev: { button: number; position: { x: number; y: number }; screenPosition: { x: number; y: number }; scrollDelta: { x: number; y: number }; useDragThreshold: boolean },
  dragging: boolean,
): EventDataLike & Record<string, unknown> {
  return {
    $type: 'PointerEventData',
    $isa: POINTER_ISA,
    button: ev.button,
    eligibleForClick: false,
    used: false,
    position: { ...ev.position },
    pressPosition: { ...ev.screenPosition },
    scrollDelta: { ...ev.scrollDelta },
    useDragThreshold: ev.useDragThreshold,
    dragging,
  };
}
/** EventSystem 自己的 BaseEventData（SetSelectedGameObject 沒帶資料時的 m_DummyData） */
export function baseEventData(): { $type: string; $isa: string[]; used: boolean } {
  return { $type: 'BaseEventData', $isa: ['BaseEventData', 'AbstractEventData'], used: false };
}

/** uGUI 的事件介面與方法（ExecuteEvents 叫的是介面方法，明確介面實作也算） */
const EVENT_IFACES: [string, string][] = [
  ['IPointerEnterHandler', 'OnPointerEnter'],
  ['IPointerExitHandler', 'OnPointerExit'],
  ['IPointerDownHandler', 'OnPointerDown'],
  ['IPointerUpHandler', 'OnPointerUp'],
  ['IPointerClickHandler', 'OnPointerClick'],
  ['ISelectHandler', 'OnSelect'],
  ['IDeselectHandler', 'OnDeselect'],
  ['IInitializePotentialDragHandler', 'OnInitializePotentialDrag'],
  ['IBeginDragHandler', 'OnBeginDrag'],
  ['IDragHandler', 'OnDrag'],
  ['IEndDragHandler', 'OnEndDrag'],
  ['IDropHandler', 'OnDrop'],
  ['IScrollHandler', 'OnScroll'],
];

/**
 * 產生的 MonoBehaviour → Behaviour（Unity 訊息照名字對到產生的方法，產生版沒有的訊息就不掛）。
 * cls：用哪個產生的類別。FixedUpdate：每格累積時間，照固定步長在 Update 之前跑，一格最多補 MAX_DT 秒。
 * uGUI 的事件介面（IPointerEnterHandler…、ISelectHandler…）照名字對到 OnPointerEnter 等。
 */
export function genBehaviour(cls: string): (ctx: BehaviourContext) => Behaviour {
  return ({ world, comp }) => {
    const m = methodsWithBase(cls);
    // 有多載的訊息方法（Spine 的 SkeletonAnimation：Update() 與 Update(float)）產生名是「名字$參數個數」：Unity 叫的是沒有參數的那個
    for (const name of LIFECYCLE_MESSAGES) if (!m[name] && m[`${name}$0`]) m[name] = m[`${name}$0`];
    // uGUI 的事件介面用明確介面實作寫的（void IPointerDownHandler.OnPointerDown(…)）：產生名是「介面$方法」，也當成那個訊息
    for (const [iface, name] of EVENT_IFACES) if (!m[name] && m[`${iface}$${name}`]) m[name] = m[`${iface}$${name}`];
    const nativeBase = genNativeBaseOf(cls);
    if (nativeBase)
      for (const name of NATIVE_FALLBACK_MESSAGES) {
        const fb = m[name] ? undefined : nativeMessageLookup(nativeBase, name);
        if (fb) m[name] = (cc: Ctx) => fb(cc, cc.self);
      }
    let h: H | null = null;
    const self = () => (h ??= compHandle(world, comp));
    const c = () => ctxOf(world, self(), cls);
    const msg = (name: string) => (m[name] ? () => void m[name](c()) : undefined);
    const evt = (name: string) => (m[name] ? (button?: number) => void m[name](c(), pointerEventData(world, button ?? 0)) : undefined);
    const sel = (name: string) => (m[name] ? (data?: unknown) => void m[name](c(), data ?? baseEventData()) : undefined);
    // 拖曳系列：送完把 useDragThreshold 寫回事件系統那一份（C# 是同一個 PointerEventData 物件）
    type DragEv = Parameters<typeof pointerEventDataFrom>[0];
    const drag = (name: string, dragging: boolean) =>
      m[name]
        ? (ev: DragEv) => {
            const d = pointerEventDataFrom(ev, dragging);
            void m[name](c(), d);
            ev.useDragThreshold = d.useDragThreshold as boolean;
          }
        : undefined;
    let acc = 0;
    const update =
      m.Update || m.FixedUpdate
        ? (dt: number) => {
            if (m.FixedUpdate) {
              acc += Math.min(dt, MAX_DT);
              while (acc >= FIXED_DT) {
                acc -= FIXED_DT;
                setCurrentDelta(FIXED_DT);
                void m.FixedUpdate(c());
              }
            }
            setCurrentDelta(dt);
            if (m.Update) void m.Update(c());
          }
        : undefined;
    // LateUpdate 另外一趟：World 在全部 Update、補間、協程、動畫之後叫（Unity 的執行順序）
    const lateUpdate = m.LateUpdate
      ? (dt: number) => {
          setCurrentDelta(dt);
          void m.LateUpdate(c());
        }
      : undefined;
    const b: Behaviour & Record<string, unknown> = {
      awake: msg('Awake'),
      start: msg('Start'),
      update,
      lateUpdate,
      onEnable: msg('OnEnable'),
      onDisable: msg('OnDisable'),
      onDestroy: msg('OnDestroy'),
      onMouseDown: msg('OnMouseDown'),
      onMouseUp: msg('OnMouseUp'),
      onMouseUpAsButton: msg('OnMouseUpAsButton'),
      onMouseEnter: msg('OnMouseEnter'),
      onMouseOver: msg('OnMouseOver'),
      onMouseExit: msg('OnMouseExit'),
      onMouseDrag: msg('OnMouseDrag'),
      onPointerEnter: evt('OnPointerEnter'),
      onPointerExit: evt('OnPointerExit'),
      onPointerDown: evt('OnPointerDown'),
      onPointerUp: evt('OnPointerUp'),
      onPointerClick: evt('OnPointerClick'),
      onSelect: sel('OnSelect'),
      onDeselect: sel('OnDeselect'),
      onInitializePotentialDrag: drag('OnInitializePotentialDrag', false),
      onBeginDrag: drag('OnBeginDrag', true),
      onDrag: drag('OnDrag', true),
      onEndDrag: drag('OnEndDrag', true),
      onDrop: drag('OnDrop', true),
      onScroll: drag('OnScroll', false),
    };
    // 場景綁的 UnityEvent（Button 的 m_OnClick）用 C# 方法名呼叫（unity/unityEvents.ts）：產生的方法全部照原名掛上；
    // 參數是場景元件的資料時換成 H（產生的程式碼一律拿 H）
    const arg = (x: unknown): unknown => (x && typeof x === 'object' && !(x instanceof H) && 'classID' in x && 'gameObject' in x ? compHandle(world, x as ComponentData) : x);
    for (const name of Object.keys(m)) if (!(name in b)) b[name] = (...a: unknown[]) => m[name](c(), ...a.map(arg));
    return b;
  };
}

/** 登記表裡的每個產生類別都接成 Behaviour（遊戲專案的 BootOptions.registry 用）；資料類別（沒有 Unity 訊息）也無妨 */
export function genRegistry(map: Record<string, GenClassImpl>): Record<string, (ctx: BehaviourContext) => Behaviour> {
  return Object.fromEntries(Object.keys(map).map((k) => [k, genBehaviour(k)]));
}

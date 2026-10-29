// 相容層：Unity 物件的生命週期與場景（UnityEngine.Object、GameObject、Transform 的階層與座標、SceneManagement、Resources、
// AsyncOperation），以及開機流程會碰到的全域服務（Application、Time、Screen、Debug、PlayerPrefs、SystemInfo）。
// 名字規則見 converter/Program.cs 檔頭；unity.ts 會 export * 這裡，遊戲專案的相容層只要 re-export unity.ts。
//
// Unity 物件在 TS 這邊的三種樣子：
//   - 場景物件（GameObject、Transform、元件）：core 的 H。
//   - ScriptableObject：產生類別的資料物件（core.materializeScriptableObject），帶 $asset（guid）。
//   - 還沒實體化的資產參照（prefab、貼圖…）：存檔原樣的 { guid, fileID }。
// 已銷毀的物件照 Unity 的假 null：objAlive 是 false、objEq(x, null) 是 true（轉換器在工具包模式把 == null 與隱含 bool 寫成這兩個）。

import { Matrix4, Quaternion, Vector3, Euler } from 'three';
import { setAnimationEventSink, type World } from '../engine/world';
import type { SceneNode } from '../unity/scene';
import type { ComponentData, RectTransformData, TransformData } from '../unity/types';
import { addComponent, createGameObject, destroy, destroyedObjects, instantiate, setParent, subtree } from '../unity/instantiate';
import { spawnPrefabMapped } from '../unity/prefab';
import { LoadSceneMode, type LoadedScene } from '../unity/scenes';
import { setAddressablesInstantiate } from './unityAssets';
import { flushPersistent } from './dotnetIO';
import { nativeGet, new_Material$Material } from './unityNative';
import { baseTypeName, callGen, genMethodOf, messageReceiver, newGenT, registerExternalCtor, registerValueType, requiredComponentsOf, resolveSceneRefs, splitTypeArgs, typeNames, asDeserializing } from './core';
import { layoutRect, ZERO_RECT } from '../ui/rectTransform';
import {
  cloneData,
  compHandle,
  compIsType,
  liveObj,
  prefabAssetRef,
  scriptGenName,
  ctxOf,
  fieldDescOf,
  genClass,
  mbGet,
  mbSet,
  newGen,
  serializedFieldsOf,
  unityData,
  eventGet,
  gameObjectOf,
  getActiveWorld,
  getObjectStore,
  H,
  hasGen,
  materializeScriptableObject,
  staticCtx,
  trace,
  transformOf,
  type Ctx,
} from './core';

type V3 = { x: number; y: number; z: number };
type Q = { x: number; y: number; z: number; w: number };

function w(c: Ctx): World {
  const world = c.w ?? getActiveWorld();
  if (!world) throw new Error('這個呼叫要在場景裡（沒有作用中的 World）');
  return world;
}
function need<T>(v: T | null | undefined, what: string): T {
  if (v == null) throw new Error(`${what}：對象是 null（C# 會 NullReferenceException）`);
  return v;
}
function aliveH(h: H | null | undefined, what: string): H {
  // prefab 資產上的物件（{guid, fileID}）：換成休眠物件樹上的 H（Unity 可以直接對 prefab 資產 GetComponentInChildren）
  if (h && !(h instanceof H)) h = liveObj(h) as H;
  if (!h || !objAlive(h)) throw new Error(`${what}：對象是 null 或已銷毀（C# 會 NullReferenceException／MissingReferenceException）`);
  return h;
}

// ───────── 假 null 與比較 ─────────

type AssetRefLike = { guid: string; fileID: string | number };
function isAssetRef(x: unknown): x is AssetRefLike {
  return !!x && typeof x === 'object' && !(x instanceof H) && typeof (x as AssetRefLike).guid === 'string' && 'fileID' in (x as object) && !('$type' in (x as object));
}
/** UnityEngine.Object 的隱含 bool（沒被銷毀）：H 看節點與元件是否已銷毀；資產參照與資料物件只看是不是 null */
export function objAlive(x: unknown): boolean {
  if (x == null) return false;
  if (x instanceof H) return !destroyedObjects.has(x.node) && !(x.comp && destroyedObjects.has(x.comp));
  if (typeof x === 'object' && destroyedObjects.has(x)) return false;
  return true;
}
/** UnityEngine.Object 的 ==：已銷毀的當 null；同一個資產的兩份參照（{guid, fileID}）相等 */
export function objEq(a: unknown, b: unknown): boolean {
  const x = objAlive(a) ? a : null;
  const y = objAlive(b) ? b : null;
  if (x === y) return true;
  if (x == null || y == null) return false;
  if (isAssetRef(x) && isAssetRef(y)) return x.guid === y.guid && String(x.fileID) === String(y.fileID);
  // prefab 資產的休眠物件樹上的 H，跟同一個物件的 {guid, fileID} 參照相等
  const rx = x instanceof H ? prefabAssetRef(x) : isAssetRef(x) ? x : null;
  const ry = y instanceof H ? prefabAssetRef(y) : isAssetRef(y) ? y : null;
  if (rx && ry) return rx.guid === ry.guid && String(rx.fileID) === String(ry.fileID);
  return false;
}
export function Object_op_Equality(c: Ctx, a: unknown, b: unknown): boolean {
  void c;
  return objEq(a, b);
}
export function Object_op_Inequality(c: Ctx, a: unknown, b: unknown): boolean {
  void c;
  return !objEq(a, b);
}
export function Object_op_Implicit(c: Ctx, a: unknown): boolean {
  void c;
  return objAlive(a);
}
const hashes = new WeakMap<object, number>();
let hashSeq = 1;
/** instanceID → 物件（JsonUtility.FromJson 把 {"instanceID": N} 換回同一次執行裡的那個物件，跟 Unity 一樣） */
const byInstanceId = new Map<number, WeakRef<object> | AssetRefLike>();
/** Object.GetInstanceID：同一個物件同一個數字（H 是 core 保證同一個；資產參照照 guid）。GameObject 是負數（Unity 也是） */
export function Object_GetInstanceID(c: Ctx, o: unknown): number {
  void c;
  if (o == null) return 0;
  if (isAssetRef(o)) {
    let h = 0;
    for (const ch of `${o.guid}:${o.fileID}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
    if (!byInstanceId.has(h)) byInstanceId.set(h, { guid: o.guid, fileID: o.fileID });
    return h;
  }
  const key = o instanceof H ? (o.comp ?? o.node) : (o as object);
  let v = hashes.get(key);
  if (!v) hashes.set(key, (v = hashSeq++));
  const id = o instanceof H && o.kind === 'go' ? -v : v;
  if (!byInstanceId.has(id)) byInstanceId.set(id, new WeakRef(o as object));
  return id;
}
/** instanceID 找回物件：0、沒發過的、已回收或已銷毀的是 null（Unity 的 FromJson 找不到也是 null） */
function objectOfInstanceId(id: number): unknown {
  const r = byInstanceId.get(id);
  const o = r instanceof WeakRef ? r.deref() : r;
  return o != null && objAlive(o) ? o : null;
}

// ───────── 名字 ─────────

/**
 * Object.name。資產參照先問物件庫（prefab、ScriptableObject、文字檔），再問素材庫（sprite、貼圖、材質）。
 * 以前只問物件庫，sprite 的名字是空的：關鍵字提示框的標題印出 `<sprite name="" tint=1>`（StatusEffectsDisplayData.GetTMPSpriteTag）
 */
export function Object_get_name(c: Ctx, o: unknown): string {
  need(o, 'Object.name');
  if (o instanceof H) return o.node.go.m_Name;
  if (isAssetRef(o)) return getObjectStore()?.assetName(o) ?? (c.w ?? getActiveWorld())?.services.render?.assetName?.(o as never) ?? '';
  const rec = o as Record<string, unknown>;
  return (rec.m_Name as string | undefined) ?? (rec.name as string | undefined) ?? '';
}
export function Object_set_name(c: Ctx, o: unknown, v: string): void {
  void c;
  need(o, 'Object.name');
  if (o instanceof H) o.node.go.m_Name = v;
  else if (!isAssetRef(o)) (o as Record<string, unknown>).m_Name = v;
}
export function Object_get_hideFlags(c: Ctx, o: unknown): number {
  void c;
  return ((o as { $hideFlags?: number })?.$hideFlags as number) ?? 0;
}
export function Object_set_hideFlags(c: Ctx, o: unknown, v: number): void {
  void c;
  if (o && typeof o === 'object') (o as { $hideFlags?: number }).$hideFlags = v;
}

// ───────── 銷毀與常駐 ─────────

/** Object.Destroy：GameObject 連子樹、元件只拿掉那個元件，幀尾生效（World.destroyDeferred）。資產與資料物件不動 */
export function Object_Destroy$Object(c: Ctx, o: unknown): void {
  if (!(o instanceof H) || !objAlive(o)) return;
  if (o.kind === 'go') w(c).destroyDeferred(o.node);
  else if (o.kind === 'transform') w(c).notes.add(`不能 Destroy Transform（${o.node.go.m_Name}）`);
  else if (o.comp) w(c).destroyDeferred(o.comp);
}
/** Object.Destroy(obj, t)：t 秒後 */
export function Object_Destroy$Object_float(c: Ctx, o: unknown, t: number): void {
  if (t <= 0) return Object_Destroy$Object(c, o);
  const world = w(c);
  let left = t;
  world.coroutines.add({
    step(dt: number) {
      left -= dt;
      if (left > 0) return true;
      Object_Destroy$Object(c, o);
      return false;
    },
  });
}
export function Object_DestroyImmediate$Object(c: Ctx, o: unknown): void {
  if (!(o instanceof H) || !objAlive(o)) return;
  const world = w(c);
  if (o.kind === 'go') destroy(world, o.node);
  else if (o.comp) {
    world.destroyDeferred(o.comp);
    (world as unknown as { flushDestroy(): void }).flushDestroy();
  }
}
export const Object_DestroyImmediate$Object_bool = (c: Ctx, o: unknown): void => Object_DestroyImmediate$Object(c, o);

/** Object.DontDestroyOnLoad：根物件（或根物件上的元件）移到 DontDestroyOnLoad 場景 */
export function Object_DontDestroyOnLoad(c: Ctx, o: unknown): void {
  if (!(o instanceof H)) return;
  w(c).scenes.dontDestroyOnLoad(o.node);
}

// ───────── Instantiate ─────────

/** 節點在子樹裡的路徑（child index 串）與元件在節點上的序號：複製出來的那份照同一條路徑找回來 */
function pathOf(root: SceneNode, node: SceneNode): number[] {
  const out: number[] = [];
  for (let n = node; n !== root; n = n.parent!) out.unshift(n.parent!.children.indexOf(n));
  return out;
}
function follow(root: SceneNode, path: number[]): SceneNode {
  let n = root;
  for (const i of path) n = n.children[i];
  return n;
}
/** 原物件在 src 子樹裡的對應物 → 在 dst 子樹裡同一個位置的對應物（GameObject、Transform、元件） */
function counterpart(world: World, src: H, srcRoot: SceneNode, dstRoot: SceneNode): H {
  const node = follow(dstRoot, pathOf(srcRoot, src.node));
  if (src.kind === 'go') return gameObjectOf(node);
  if (src.kind === 'transform') return transformOf(node);
  const idx = src.node.go.components.findIndex((id) => world.graph.file.components[id] === src.comp);
  return compHandle(world, world.graph.file.components[node.go.components[idx]]);
}

/**
 * Object.Instantiate 的本體：原型是 prefab 參照（{guid, fileID}）、場景物件（H）或 ScriptableObject（資料物件）。
 * 回傳跟原型同一種東西（GameObject → GameObject、元件 → 生成物上的同一個元件）。名字照 Unity 加上 (Clone)。
 * 生出來的 Animator 從預設狀態開始跑；Awake、OnEnable 立刻跑，Start 在下一次 Update 之前（instantiate.ts）。
 */
export function instantiateAny(c: Ctx, original: unknown, parent: H | null, worldStays = false): unknown {
  if (original == null) throw new Error('Object.Instantiate：原型是 null（C# 會 ArgumentException）');
  const world = w(c);
  const pnode = parent ? aliveH(parent, 'Instantiate 的 parent').node : null;
  let root: SceneNode;
  let result: unknown;
  if (original instanceof H) {
    aliveH(original, 'Object.Instantiate');
    let src = original.node;
    if (original.kind !== 'go' && original.kind !== 'transform') src = original.node;
    root = instantiate(world, src, pnode);
    result = counterpart(world, original, src, root);
  } else if (isAssetRef(original)) {
    const store = getObjectStore();
    if (!store?.isPrefab(original.guid)) {
      // 材質資產的複本（new Material 一樣：屬性複製一份，名字加 (Clone)）
      if (String(original.fileID) === '2100000' || world.services.render?.sharedMaterial(original as never)) {
        const m = new_Material$Material(c, original);
        m.$record.m_Name = `${m.$record.m_Name ?? 'Material'}(Clone)`;
        return m;
      }
      // ScriptableObject 資產：實體化後照下面的資料物件複製
      const so = String(original.fileID) === '11400000' ? materializeScriptableObject(original.guid) : null;
      if (!so) throw new Error(`Object.Instantiate：${original.guid} 不是 prefab、材質或 ScriptableObject`);
      return instantiateAny(c, so, parent, worldStays);
    }
    const mapped = spawnPrefabMapped(world, store.prefabFile(original.guid), pnode);
    root = mapped.root;
    const id = mapped.ids.get(String(original.fileID));
    const comp = id ? world.graph.file.components[id] : undefined;
    if (comp) {
      const node = world.graph.nodeById(comp.gameObject)!;
      result = comp.type === 'Transform' || comp.type === 'RectTransform' ? transformOf(node) : compHandle(world, comp);
    } else {
      const node = id ? world.graph.nodeById(id) : undefined;
      result = gameObjectOf(node ?? root);
    }
  } else if (typeof original === 'object' && '$type' in (original as object)) {
    // ScriptableObject 的複本：欄位複製一份（參照到的別的資產照舊是同一份）
    const src = original as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) copy[k] = k === '$asset' ? undefined : cloneData(v);
    delete copy.$asset;
    copy.m_Name = `${src.m_Name ?? ''}(Clone)`;
    return copy;
  } else throw new Error('Object.Instantiate：不認得的原型');
  root.go.m_Name = `${root.go.m_Name}(Clone)`;
  if (worldStays && pnode) void 0; // 生成物的本地座標本來就是 prefab 的值；worldPositionStays 只影響場景物件的複製（未做）
  world.startAnimatorsIn(subtree(root));
  return result;
}
// Addressables.Instantiate 用同一套（unityAssets.ts 不 import 這裡，免得循環）
setAddressablesInstantiate((c, prefab, parent, pos, rot) => {
  const r = instantiateAny(c, prefab, (parent as H | null) ?? null);
  if (pos && r instanceof H) {
    const t = transformOf(r.node);
    Transform_set_position(c, t, pos as V3);
    if (rot) Transform_set_rotation(c, t, rot as Q);
  }
  return r;
});
export function Object_Instantiate$T(c: Ctx, original: unknown): unknown {
  return instantiateAny(c, original, null);
}
export const Object_Instantiate$Object = Object_Instantiate$T;
export function Object_Instantiate$T_Transform(c: Ctx, original: unknown, parent: H | null): unknown {
  return instantiateAny(c, original, parent);
}
export const Object_Instantiate$Object_Transform = Object_Instantiate$T_Transform;
export function Object_Instantiate$T_Transform_bool(c: Ctx, original: unknown, parent: H | null, worldPositionStays: boolean): unknown {
  return instantiateAny(c, original, parent, worldPositionStays);
}
export const Object_Instantiate$Object_Transform_bool = Object_Instantiate$T_Transform_bool;
export function Object_Instantiate$T_Vector3_Quaternion(c: Ctx, original: unknown, pos: V3, rot: Q): unknown {
  return Object_Instantiate$T_Vector3_Quaternion_Transform(c, original, pos, rot, null);
}
export const Object_Instantiate$Object_Vector3_Quaternion = Object_Instantiate$T_Vector3_Quaternion;
export function Object_Instantiate$T_Vector3_Quaternion_Transform(c: Ctx, original: unknown, pos: V3, rot: Q, parent: H | null): unknown {
  const r = instantiateAny(c, original, parent);
  if (r instanceof H) {
    const t = transformOf(r.node);
    Transform_set_position(c, t, pos);
    Transform_set_rotation(c, t, rot);
  }
  return r;
}
export const Object_Instantiate$Object_Vector3_Quaternion_Transform = Object_Instantiate$T_Vector3_Quaternion_Transform;

// ───────── 尋找 ─────────

/** 全部節點（場景樹的順序；Unity 的 Find 系列順序未定義，這裡用樹的順序） */
function allNodes(world: World): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (n: SceneNode): void => {
    out.push(n);
    for (const ch of n.children) visit(ch);
  };
  for (const r of world.graph.roots) visit(r);
  return out;
}
/** GameObject.Find：啟用中的物件，名字或「A/B」路徑（開頭 / 表示從根開始） */
export function GameObject_Find(c: Ctx, name: string): H | null {
  const world = w(c);
  if (name.includes('/')) {
    const abs = name.startsWith('/');
    const parts = name.split('/').filter(Boolean);
    const starts = abs ? world.graph.roots : allNodes(world);
    for (const s of starts) {
      if (s.go.m_Name !== parts[0] || !s.activeInHierarchy) continue;
      let n: SceneNode | undefined = s;
      for (const p of parts.slice(1)) n = n?.children.find((ch) => ch.go.m_Name === p);
      if (n && n.activeInHierarchy) return gameObjectOf(n);
    }
    return null;
  }
  for (const n of allNodes(world)) if (n.activeInHierarchy && n.go.m_Name === name) return gameObjectOf(n);
  return null;
}
export function GameObject_FindWithTag(c: Ctx, tag: string): H | null {
  for (const n of allNodes(w(c))) if (n.activeInHierarchy && n.go.m_TagString === tag) return gameObjectOf(n);
  return null;
}
export const GameObject_FindGameObjectWithTag = GameObject_FindWithTag;
export function GameObject_FindGameObjectsWithTag(c: Ctx, tag: string): H[] {
  return allNodes(w(c))
    .filter((n) => n.activeInHierarchy && n.go.m_TagString === tag)
    .map(gameObjectOf);
}
export function GameObject_CompareTag(c: Ctx, go: H, tag: string): boolean {
  void c;
  return aliveH(go, 'CompareTag').node.go.m_TagString === tag;
}
export const Component_CompareTag = GameObject_CompareTag;
export function GameObject_get_tag(c: Ctx, go: H): string {
  void c;
  return aliveH(go, 'GameObject.tag').node.go.m_TagString;
}
export const Component_get_tag = GameObject_get_tag;
export function GameObject_set_tag(c: Ctx, go: H, v: string): void {
  void c;
  aliveH(go, 'GameObject.tag').node.go.m_TagString = v;
}
function compMatches(world: World, comp: ComponentData, type: string): boolean {
  if (type === 'Component' || type === 'Object') return true;
  if ((type === 'MonoBehaviour' || type === 'Behaviour') && comp.script) return true;
  if (type === 'Transform' && (comp.type === 'Transform' || comp.type === 'RectTransform')) return true;
  return compIsType(world, comp, type);
}
function handleFor(world: World, node: SceneNode, comp: ComponentData): H {
  return comp.type === 'Transform' || comp.type === 'RectTransform' ? transformOf(node) : compHandle(world, comp);
}
/** Object.FindObjectsOfType<T>(includeInactive)：啟用中（activeInHierarchy、元件啟用）的元件，或全部 */
function findObjects(c: Ctx, type: string, includeInactive: boolean): H[] {
  const world = w(c);
  const out: H[] = [];
  for (const n of allNodes(world)) {
    if (!includeInactive && !n.activeInHierarchy) continue;
    if (type === 'GameObject') {
      out.push(gameObjectOf(n));
      continue;
    }
    for (const comp of world.graph.components(n)) {
      if (!comp || !compMatches(world, comp, type)) continue;
      if (!includeInactive && comp.m_Enabled === 0 && comp.script) continue;
      out.push(handleFor(world, n, comp));
    }
  }
  return out;
}
export function Object_FindObjectOfType$(c: Ctx, type: string): H | null {
  return findObjects(c, type, false)[0] ?? null;
}
export function Object_FindObjectOfType$Type(c: Ctx, type: string): H | null {
  return findObjects(c, type, false)[0] ?? null;
}
export function Object_FindObjectOfType$bool(c: Ctx, includeInactive: boolean, type: string): H | null {
  return findObjects(c, type, includeInactive)[0] ?? null;
}
export function Object_FindObjectsOfType$(c: Ctx, type: string): H[] {
  return findObjects(c, type, false);
}
export function Object_FindObjectsOfType$Type(c: Ctx, type: string): H[] {
  return findObjects(c, type, false);
}
export function Object_FindObjectsOfType$bool(c: Ctx, includeInactive: boolean, type: string): H[] {
  return findObjects(c, type, includeInactive);
}
export function Object_FindAnyObjectByType$(c: Ctx, type: string): H | null {
  return findObjects(c, type, false)[0] ?? null;
}
export const Object_FindFirstObjectByType$ = Object_FindAnyObjectByType$;
export function Resources_FindObjectsOfTypeAll$Type(c: Ctx, type: string): H[] {
  return findObjects(c, type, true);
}
export const Resources_FindObjectsOfTypeAll$ = Resources_FindObjectsOfTypeAll$Type;

// ───────── GameObject ─────────

export function GameObject_get_gameObject(c: Ctx, go: H): H {
  void c;
  return gameObjectOf(aliveH(go, 'GameObject.gameObject').node);
}
export function GameObject_get_scene(c: Ctx, go: H): LoadedScene {
  return w(c).scenes.sceneOf(aliveH(go, 'GameObject.scene').node) ?? INVALID_SCENE;
}
export function GameObject_get_layer(c: Ctx, go: H): number {
  void c;
  return aliveH(go, 'GameObject.layer').node.go.m_Layer;
}
export function GameObject_set_layer(c: Ctx, go: H, v: number): void {
  void c;
  aliveH(go, 'GameObject.layer').node.go.m_Layer = v;
}
export function GameObject_get_activeSelf(c: Ctx, go: H): boolean {
  void c;
  return aliveH(go, 'GameObject.activeSelf').node.go.m_IsActive === 1;
}
export function GameObject_get_isStatic(c: Ctx, go: H): boolean {
  void c;
  void go;
  return false;
}
/** new GameObject(name)：空物件（Transform 一個），放在 active 場景的根 */
export function new_GameObject$string(c: Ctx, name: string): H {
  return gameObjectOf(newGameObject(w(c), name, []));
}
export function new_GameObject$(c: Ctx): H {
  return new_GameObject$string(c, 'New Game Object');
}
export function new_GameObject$string_Type_arr(c: Ctx, name: string, types: string[]): H {
  const world = w(c);
  const node = newGameObject(world, name, []);
  for (const t of types ?? []) addComponentByName(world, node, t);
  return gameObjectOf(node);
}
function newGameObject(world: World, name: string, comps: ComponentData[]): SceneNode {
  const tf = { type: 'Transform', classID: 4, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_Children: [], m_Father: null } as unknown as ComponentData;
  return createGameObject(world, name, null, [tf, ...comps]);
}

/** 元件型別名 → 要加進物件的存檔值：產生的類別是 MonoBehaviour（script.class），其他是 Unity 原生元件（type） */
function addComponentByName(world: World, node: SceneNode, type: string): ComponentData {
  if (type === 'RectTransform') {
    // Transform 換成 RectTransform（Unity 的 AddComponent<RectTransform> 會換掉 Transform）
    const tf = node.transform as unknown as Record<string, unknown>;
    if (tf.type !== 'RectTransform') {
      Object.assign(tf, { type: 'RectTransform', classID: 224, m_AnchorMin: { x: 0.5, y: 0.5 }, m_AnchorMax: { x: 0.5, y: 0.5 }, m_AnchoredPosition: { x: 0, y: 0 }, m_SizeDelta: { x: 100, y: 100 }, m_Pivot: { x: 0.5, y: 0.5 } });
      node.isRect = true;
    }
    return node.transform as unknown as ComponentData;
  }
  // [RequireComponent]：Unity 先補上缺的元件
  if (hasGen(type))
    for (const req of requiredComponentsOf(type))
      if (!world.graph.components(node).some((x) => x && compMatches(world, x, req))) addComponentByName(world, node, req);
  const data: Record<string, unknown> = hasGen(type) || world.services.hierarchy?.[type]
    ? { type: 'MonoBehaviour', classID: 114, m_Enabled: 1, script: { assembly: 'Assembly-CSharp', namespace: '', class: type, source: '' } }
    : { type, m_Enabled: 1, ...structuredClone(NATIVE_COMPONENT_DEFAULTS[type] ?? {}) };
  return addComponent(world, node, data as unknown as ComponentData);
}
/**
 * 執行期 AddComponent 的 Unity 原生元件：存檔欄位的初始值（Unity 新加元件時 Inspector 上的預設；欄位名照場景存檔）。
 * 沒列的原生元件只有 m_Enabled，讀取端要自己給預設。
 * 10/16：MT2 的 UIScreen.Awake 找不到 CanvasGroup 就自己加，原本沒有 m_Alpha，繪製端算出 NaN（畫面過曝或全黑）、
 * 沒有 m_BlocksRaycasts，射線檢測當作擋掉
 */
const NATIVE_COMPONENT_DEFAULTS: Record<string, Record<string, unknown>> = {
  CanvasGroup: { classID: 225, m_Alpha: 1, m_Interactable: 1, m_BlocksRaycasts: 1, m_IgnoreParentGroups: 0 },
  AudioSource: { classID: 82, m_audioClip: null, m_PlayOnAwake: 1, m_Volume: 1, m_Pitch: 1, Loop: 0, Mute: 0, Priority: 128, DopplerLevel: 1, MinDistance: 1, MaxDistance: 500, Pan2D: 0 },
};
export function GameObject_AddComponent$(c: Ctx, go: H, type: string): H {
  const world = w(c);
  const node = aliveH(go, 'AddComponent').node;
  const comp = addComponentByName(world, node, type);
  return handleFor(world, node, comp);
}
export const GameObject_AddComponent$Type = GameObject_AddComponent$;
export function GameObject_TryGetComponent$T(c: Ctx, go: H, out: (v: H | null) => void, type: string): boolean {
  const world = w(c);
  const node = aliveH(go, 'TryGetComponent').node;
  const comp = world.graph.components(node).find((x) => x && compMatches(world, x, type));
  const h = comp ? handleFor(world, node, comp) : null;
  out(h);
  return !!h;
}
export const Component_TryGetComponent$T = GameObject_TryGetComponent$T;
export function GameObject_GetComponent$Type(c: Ctx, go: H, type: string): H | null {
  const world = w(c);
  const node = aliveH(go, 'GetComponent').node;
  const comp = world.graph.components(node).find((x) => x && compMatches(world, x, type));
  return comp ? handleFor(world, node, comp) : null;
}
export const Component_GetComponent$Type = GameObject_GetComponent$Type;
export const Component_GetComponent$string = GameObject_GetComponent$Type;
export function GameObject_GetComponents$(c: Ctx, go: H, type: string): H[] {
  const world = w(c);
  const node = aliveH(go, 'GetComponents').node;
  return world.graph.components(node).filter((x) => x && compMatches(world, x, type)).map((x) => handleFor(world, node, x));
}
export const Component_GetComponents$ = GameObject_GetComponents$;
export const Component_GetComponents$Type = GameObject_GetComponents$;
export function GameObject_GetComponents$List(c: Ctx, go: H, results: H[], type: string): void {
  results.length = 0;
  results.push(...GameObject_GetComponents$(c, go, type));
}
export function Component_GetComponents$Type_List(c: Ctx, h: H, type: string, results: H[]): void {
  results.length = 0;
  results.push(...GameObject_GetComponents$(c, h, type));
}
function inParents(c: Ctx, h: H, type: string, includeInactive: boolean): H[] {
  const world = w(c);
  const out: H[] = [];
  for (let n: SceneNode | null = aliveH(h, 'GetComponentsInParent').node; n; n = n.parent) {
    if (!includeInactive && !n.activeInHierarchy) continue;
    for (const comp of world.graph.components(n)) if (comp && compMatches(world, comp, type)) out.push(handleFor(world, n, comp));
  }
  return out;
}
function inChildren(c: Ctx, h: H, type: string, includeInactive: boolean): H[] {
  const world = w(c);
  const out: H[] = [];
  const root = aliveH(h, 'GetComponentsInChildren').node;
  const visit = (n: SceneNode): void => {
    if (!includeInactive && !n.activeInHierarchy) return;
    for (const comp of world.graph.components(n)) if (comp && compMatches(world, comp, type)) out.push(handleFor(world, n, comp));
    for (const ch of n.children) visit(ch);
  };
  visit(root);
  return out;
}
export function GameObject_GetComponentInParent$(c: Ctx, h: H, type: string): H | null {
  return inParents(c, h, type, false)[0] ?? null;
}
export function GameObject_GetComponentInParent$bool(c: Ctx, h: H, includeInactive: boolean, type: string): H | null {
  return inParents(c, h, type, includeInactive)[0] ?? null;
}
export const Component_GetComponentInParent$bool = GameObject_GetComponentInParent$bool;
export function GameObject_GetComponentsInParent$bool_List(c: Ctx, h: H, includeInactive: boolean, results: H[], type: string): void {
  results.length = 0;
  results.push(...inParents(c, h, type, includeInactive));
}
export const Component_GetComponentsInParent$bool_List = GameObject_GetComponentsInParent$bool_List;
export function Component_GetComponentsInParent$(c: Ctx, h: H, type: string): H[] {
  return inParents(c, h, type, false);
}
export const GameObject_GetComponentsInParent$ = Component_GetComponentsInParent$;
export function Component_GetComponentsInParent$bool(c: Ctx, h: H, includeInactive: boolean, type: string): H[] {
  return inParents(c, h, type, includeInactive);
}
export const GameObject_GetComponentsInParent$bool = Component_GetComponentsInParent$bool;
export function GameObject_GetComponentInChildren$(c: Ctx, h: H, type: string): H | null {
  return inChildren(c, h, type, false)[0] ?? null;
}
export function GameObject_GetComponentInChildren$bool(c: Ctx, h: H, includeInactive: boolean, type: string): H | null {
  return inChildren(c, h, type, includeInactive)[0] ?? null;
}
export function GameObject_GetComponentsInChildren$(c: Ctx, h: H, type: string): H[] {
  return inChildren(c, h, type, false);
}
export function GameObject_GetComponentsInChildren$bool(c: Ctx, h: H, includeInactive: boolean, type: string): H[] {
  return inChildren(c, h, type, includeInactive);
}
export function Component_GetComponentsInChildren$List(c: Ctx, h: H, results: H[], type: string): void {
  results.length = 0;
  results.push(...inChildren(c, h, type, false));
}
export const GameObject_GetComponentsInChildren$List = Component_GetComponentsInChildren$List;
export function Component_GetComponentsInChildren$bool_List(c: Ctx, h: H, includeInactive: boolean, results: H[], type: string): void {
  results.length = 0;
  results.push(...inChildren(c, h, type, includeInactive));
}
export const GameObject_GetComponentsInChildren$bool_List = Component_GetComponentsInChildren$bool_List;
/** GameObject.SendMessage：物件上每個元件有這個方法就叫（genBehaviour 把產生的方法照原名掛在 behaviour 上） */
export function GameObject_SendMessage$string_Object_SendMessageOptions(c: Ctx, go: H, method: string, value: unknown): void {
  const world = w(c);
  for (const comp of world.graph.components(aliveH(go, 'SendMessage').node)) {
    const b = world.behaviours.get(comp) as Record<string, unknown> | undefined;
    const fn = b?.[method];
    if (typeof fn === 'function') world.guard(`SendMessage ${method}`, () => (value === undefined ? fn() : fn(value)));
  }
}
export const GameObject_SendMessage$string = (c: Ctx, go: H, method: string): void => GameObject_SendMessage$string_Object_SendMessageOptions(c, go, method, undefined);
export const GameObject_SendMessage$string_Object = GameObject_SendMessage$string_Object_SendMessageOptions;
export const Component_SendMessage$string = GameObject_SendMessage$string;

/**
 * 動畫事件（AnimationClip 的 m_Events，World 每格更新 Animator 後交過來）：Animator 所在物件上的每個腳本，有叫這個名字的方法就呼叫
 * （同 SendMessage，不往父物件傳）。參數照方法的參數型別帶（Unity 文件：float、int、string、Object、AnimationEvent）：
 * floatParameter、intParameter、stringParameter（匯入的 data）、objectReferenceParameter、整個 AnimationEvent。
 * 沒有接收者而且 messageOptions 是 RequireReceiver（0）：Unity 記錯誤，這裡記在 notes。停用的腳本照樣收到（未查證，同 SendMessage 的做法）。
 */
setAnimationEventSink((world, node, ev, clip) => {
  let received = false;
  for (const comp of world.graph.components(node)) {
    const cls = scriptGenName(comp.script);
    const r = cls ? messageReceiver(cls, ev.functionName) : null;
    if (!cls || !r) continue;
    received = true;
    if (r.arity > 1 || (r.arity === 1 && (!r.kind || r.kind === '?'))) {
      world.notes.add(`動畫事件 ${clip}.${ev.functionName}：${cls} 的方法參數型別 Unity 帶不了`);
      continue;
    }
    const h = compHandle(world, comp);
    const animEvent = () => ({
      $type: 'AnimationEvent',
      functionName: ev.functionName,
      time: ev.time,
      stringParameter: ev.data ?? '',
      floatParameter: ev.floatParameter,
      intParameter: ev.intParameter,
      objectReferenceParameter: ev.objectReferenceParameter ?? null,
      messageOptions: ev.messageOptions,
    });
    const arg = r.arity === 0 ? [] : [{ f: ev.floatParameter, i: ev.intParameter, s: ev.data ?? '', o: ev.objectReferenceParameter ?? null, e: animEvent() }[r.kind as 'f']];
    callGen(ctxOf(world, h, cls), cls, r.method, h, ...arg);
  }
  if (!received && !ev.messageOptions) world.notes.add(`AnimationEvent '${ev.functionName}' on animation '${clip}' has no receiver! Are you missing a component?`);
});

// ───────── Transform：階層 ─────────

/** 讀世界矩陣之前：沿父物件鏈算好這個物件（World.refreshTransform，Unity 讀 transform 時的算法），不整棵樹重排 */
function fresh(c: Ctx, t: H, what: string): SceneNode {
  const node = aliveH(t, what).node;
  w(c).refreshTransform(node);
  return node;
}
export function Transform_get_childCount(c: Ctx, t: H): number {
  void c;
  return aliveH(t, 'Transform.childCount').node.children.length;
}
export function Transform_GetChild(c: Ctx, t: H, i: number): H {
  void c;
  const ch = aliveH(t, 'Transform.GetChild').node.children[i];
  if (!ch) throw new Error(`Transform.GetChild(${i})：超出範圍（C# 會 UnityException）`);
  return transformOf(ch);
}
/** foreach (Transform child in transform)：直接子物件 */
export function Transform_toArray(c: Ctx, t: H): H[] {
  void c;
  return aliveH(t, 'Transform 的列舉').node.children.map(transformOf);
}
/** Transform.Find：子物件的名字，或「A/B」路徑（不管啟用與否） */
export function Transform_Find(c: Ctx, t: H, name: string): H | null {
  void c;
  let n: SceneNode | undefined = aliveH(t, 'Transform.Find').node;
  for (const p of name.split('/')) {
    if (p === '') continue;
    if (p === '..') {
      n = n?.parent ?? undefined;
      continue;
    }
    n = n?.children.find((ch) => ch.go.m_Name === p);
    if (!n) return null;
  }
  return n ? transformOf(n) : null;
}
export const Transform_FindChild = Transform_Find;
export function Transform_get_root(c: Ctx, t: H): H {
  void c;
  let n = aliveH(t, 'Transform.root').node;
  while (n.parent) n = n.parent;
  return transformOf(n);
}
export function Transform_IsChildOf(c: Ctx, t: H, p: H): boolean {
  void c;
  if (!p) return false;
  for (let n: SceneNode | null = aliveH(t, 'Transform.IsChildOf').node; n; n = n.parent) if (n === p.node) return true;
  return false;
}
export function Transform_GetSiblingIndex(c: Ctx, t: H): number {
  const n = aliveH(t, 'Transform.GetSiblingIndex').node;
  return (n.parent ? n.parent.children : w(c).graph.roots.filter((r) => r.scene === n.scene)).indexOf(n);
}
export function Transform_SetSiblingIndex(c: Ctx, t: H, i: number): void {
  const world = w(c);
  // 兄弟順序不影響 transform；uGUI 自動排版（LayoutGroup 照子物件順序）等這一格結尾的 relayout，同 Unity
  world.graph.setSiblingIndex(aliveH(t, 'Transform.SetSiblingIndex').node, i);
}
export function Transform_SetAsLastSibling(c: Ctx, t: H): void {
  const n = aliveH(t, 'Transform.SetAsLastSibling').node;
  Transform_SetSiblingIndex(c, t, (n.parent ? n.parent.children : w(c).graph.roots).length - 1);
}
export function Transform_SetAsFirstSibling(c: Ctx, t: H): void {
  Transform_SetSiblingIndex(c, t, 0);
}
/** Transform.SetParent(parent, worldPositionStays)：true（預設）保持世界座標，改寫本地座標 */
export function Transform_SetParent$Transform_bool(c: Ctx, t: H, parent: H | null, worldPositionStays: boolean): void {
  const world = w(c);
  const node = aliveH(t, 'Transform.SetParent').node;
  const pnode = parent ? aliveH(parent, 'SetParent 的 parent').node : null;
  if (node.parent === pnode) return;
  if (worldPositionStays) {
    world.refreshTransform(node);
    const before = node.world.clone();
    setParent(world, node, pnode);
    if (pnode) world.refreshTransform(pnode);
    const pw = pnode ? pnode.world.clone() : new Matrix4();
    const local = pw.invert().multiply(before);
    const pos = new Vector3();
    const rot = new Quaternion();
    const scl = new Vector3();
    local.decompose(pos, rot, scl);
    const tf = node.transform as TransformData;
    tf.m_LocalRotation = { x: rot.x, y: rot.y, z: rot.z, w: rot.w };
    tf.m_LocalScale = { x: scl.x, y: scl.y, z: scl.z };
    setLocalPosition(world, node, { x: pos.x, y: pos.y, z: pos.z });
    world.refreshSubtree(node);
  } else setParent(world, node, pnode);
}
export function Transform_SetParent$Transform(c: Ctx, t: H, parent: H | null): void {
  Transform_SetParent$Transform_bool(c, t, parent, true);
}
export function Transform_set_parent(c: Ctx, t: H, parent: H | null): void {
  Transform_SetParent$Transform_bool(c, t, parent, true);
}
export function Transform_DetachChildren(c: Ctx, t: H): void {
  for (const ch of [...aliveH(t, 'Transform.DetachChildren').node.children]) Transform_SetParent$Transform_bool(c, transformOf(ch), null, true);
}

// ───────── Transform：座標 ─────────

function v3(v: { x: number; y: number; z: number }): V3 {
  return { x: v.x, y: v.y, z: v.z };
}
/** 本地位置：Transform 是 m_LocalPosition；RectTransform 的 xy 由錨點與 anchoredPosition 算（scene.ts 的 layout 同一套） */
function localPositionOf(node: SceneNode): V3 {
  const tf = node.transform as TransformData;
  if (!node.isRect) return v3(tf.m_LocalPosition);
  const r = layoutRect(node.parent?.rect ?? ZERO_RECT, tf as unknown as RectTransformData);
  return { x: r.localPosition.x, y: r.localPosition.y, z: tf.m_LocalPosition.z };
}
/** 設本地位置：RectTransform 改 anchoredPosition（差多少補多少），z 寫進 m_LocalPosition */
function setLocalPosition(world: World, node: SceneNode, p: V3): void {
  void world;
  const tf = node.transform as TransformData;
  if (!node.isRect) {
    tf.m_LocalPosition = v3(p);
    return;
  }
  const cur = localPositionOf(node);
  const rt = tf as unknown as RectTransformData;
  rt.m_AnchoredPosition = { x: rt.m_AnchoredPosition.x + (p.x - cur.x), y: rt.m_AnchoredPosition.y + (p.y - cur.y) };
  tf.m_LocalPosition = { x: tf.m_LocalPosition.x, y: tf.m_LocalPosition.y, z: p.z };
}
function parentWorld(world: World, node: SceneNode): Matrix4 {
  if (!node.parent) return new Matrix4();
  world.refreshTransform(node.parent);
  return node.parent.world.clone();
}
/**
 * Screen Space 的根 Canvas：RectTransform 由 Canvas 驅動（Overlay 放在螢幕像素空間、Screen Space - Camera 放在攝影機前），
 * 序列化的 m_LocalScale 是 build 存的 0。Unity 讀 localPosition／localRotation／localScale 拿到的是驅動後的值
 *（UIParticle 用根 Canvas 的 localScale 算粒子縮放），這裡從排版算好的 world 反推：parent⁻¹·world 拆成位移、旋轉、縮放
 */
function drivenLocal(world: World, node: SceneNode): { p: Vector3; q: Quaternion; s: Vector3 } | null {
  if (!world.graph.isScreenRoot(node)) return null;
  world.refreshTransform(node);
  const local = parentWorld(world, node).invert().multiply(node.world);
  const out = { p: new Vector3(), q: new Quaternion(), s: new Vector3() };
  local.decompose(out.p, out.q, out.s);
  return out;
}
export function Transform_get_localPosition(c: Ctx, t: H): V3 {
  const node = aliveH(t, 'Transform.localPosition').node;
  const d = drivenLocal(w(c), node);
  return d ? { x: d.p.x, y: d.p.y, z: d.p.z } : localPositionOf(node);
}
export function Transform_set_localPosition(c: Ctx, t: H, p: V3): void {
  setLocalPosition(w(c), aliveH(t, 'Transform.localPosition').node, p);
}
export function Transform_get_position(c: Ctx, t: H): V3 {
  const p = new Vector3().setFromMatrixPosition(fresh(c, t, 'Transform.position').world);
  return { x: p.x, y: p.y, z: p.z };
}
export function Transform_set_position(c: Ctx, t: H, p: V3): void {
  const world = w(c);
  const node = aliveH(t, 'Transform.position').node;
  const local = new Vector3(p.x, p.y, p.z).applyMatrix4(parentWorld(world, node).invert());
  setLocalPosition(world, node, { x: local.x, y: local.y, z: local.z });
}
export function Transform_get_localScale(c: Ctx, t: H): V3 {
  const node = aliveH(t, 'Transform.localScale').node;
  const d = drivenLocal(w(c), node);
  return d ? { x: d.s.x, y: d.s.y, z: d.s.z } : v3((node.transform as TransformData).m_LocalScale);
}
export function Transform_set_localScale(c: Ctx, t: H, s: V3): void {
  void c;
  (aliveH(t, 'Transform.localScale').node.transform as TransformData).m_LocalScale = v3(s);
}
export function Transform_get_lossyScale(c: Ctx, t: H): V3 {
  const s = new Vector3();
  fresh(c, t, 'Transform.lossyScale').world.decompose(new Vector3(), new Quaternion(), s);
  return { x: s.x, y: s.y, z: s.z };
}
export function Transform_get_localRotation(c: Ctx, t: H): Q {
  const node = aliveH(t, 'Transform.localRotation').node;
  const d = drivenLocal(w(c), node);
  const q = d ? d.q : (node.transform as TransformData).m_LocalRotation;
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}
export function Transform_set_localRotation(c: Ctx, t: H, q: Q): void {
  void c;
  (aliveH(t, 'Transform.localRotation').node.transform as TransformData).m_LocalRotation = { x: q.x, y: q.y, z: q.z, w: q.w };
}
export function Transform_get_rotation(c: Ctx, t: H): Q {
  const q = new Quaternion();
  fresh(c, t, 'Transform.rotation').world.decompose(new Vector3(), q, new Vector3());
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}
export function Transform_set_rotation(c: Ctx, t: H, q: Q): void {
  const world = w(c);
  const node = aliveH(t, 'Transform.rotation').node;
  const pq = new Quaternion();
  parentWorld(world, node).decompose(new Vector3(), pq, new Vector3());
  const lq = pq.invert().multiply(new Quaternion(q.x, q.y, q.z, q.w));
  (node.transform as TransformData).m_LocalRotation = { x: lq.x, y: lq.y, z: lq.z, w: lq.w };
}
const RAD = 180 / Math.PI;
/** Unity 的尤拉角：ZXY 的順序（先 z、再 x、再 y），單位是度，0～360 */
function toEuler(q: Q): V3 {
  const e = new Euler().setFromQuaternion(new Quaternion(q.x, q.y, q.z, q.w), 'YXZ');
  const n = (d: number) => ((d % 360) + 360) % 360;
  return { x: n(e.x * RAD), y: n(e.y * RAD), z: n(e.z * RAD) };
}
function fromEuler(v: V3): Q {
  const q = new Quaternion().setFromEuler(new Euler(v.x / RAD, v.y / RAD, v.z / RAD, 'YXZ'));
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}
export function Transform_get_localEulerAngles(c: Ctx, t: H): V3 {
  return toEuler(Transform_get_localRotation(c, t));
}
export function Transform_set_localEulerAngles(c: Ctx, t: H, v: V3): void {
  Transform_set_localRotation(c, t, fromEuler(v));
}
export function Transform_get_eulerAngles(c: Ctx, t: H): V3 {
  return toEuler(Transform_get_rotation(c, t));
}
export function Transform_set_eulerAngles(c: Ctx, t: H, v: V3): void {
  Transform_set_rotation(c, t, fromEuler(v));
}
function dir(c: Ctx, t: H, x: number, y: number, z: number): V3 {
  const q = Transform_get_rotation(c, t);
  const r = new Vector3(x, y, z).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
  return { x: r.x, y: r.y, z: r.z };
}
export function Transform_get_forward(c: Ctx, t: H): V3 {
  return dir(c, t, 0, 0, 1);
}
export function Transform_get_right(c: Ctx, t: H): V3 {
  return dir(c, t, 1, 0, 0);
}
export function Transform_get_up(c: Ctx, t: H): V3 {
  return dir(c, t, 0, 1, 0);
}
export function Transform_TransformPoint$float_float_float(c: Ctx, t: H, x: number, y: number, z: number): V3 {
  const r = new Vector3(x, y, z).applyMatrix4(fresh(c, t, 'Transform.TransformPoint').world);
  return { x: r.x, y: r.y, z: r.z };
}
export function Transform_InverseTransformPoint$Vector3(c: Ctx, t: H, p: V3): V3 {
  const r = new Vector3(p.x, p.y, p.z).applyMatrix4(fresh(c, t, 'Transform.InverseTransformPoint').world.clone().invert());
  return { x: r.x, y: r.y, z: r.z };
}
export function Transform_InverseTransformPoint$float_float_float(c: Ctx, t: H, x: number, y: number, z: number): V3 {
  return Transform_InverseTransformPoint$Vector3(c, t, { x, y, z });
}
/** TransformVector：世界矩陣的線性部分（旋轉與縮放，不含位移） */
export function Transform_TransformVector$Vector3(c: Ctx, t: H, v: V3): V3 {
  const e = fresh(c, t, 'Transform.TransformVector').world.elements;
  return { x: e[0] * v.x + e[4] * v.y + e[8] * v.z, y: e[1] * v.x + e[5] * v.y + e[9] * v.z, z: e[2] * v.x + e[6] * v.y + e[10] * v.z };
}
export function Transform_InverseTransformVector$Vector3(c: Ctx, t: H, v: V3): V3 {
  const m = fresh(c, t, 'Transform.InverseTransformVector').world.clone().invert();
  const e = m.elements;
  return { x: e[0] * v.x + e[4] * v.y + e[8] * v.z, y: e[1] * v.x + e[5] * v.y + e[9] * v.z, z: e[2] * v.x + e[6] * v.y + e[10] * v.z };
}
export function Transform_TransformDirection$Vector3(c: Ctx, t: H, v: V3): V3 {
  const q = Transform_get_rotation(c, t);
  const r = new Vector3(v.x, v.y, v.z).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
  return { x: r.x, y: r.y, z: r.z };
}
export function Transform_InverseTransformDirection$Vector3(c: Ctx, t: H, v: V3): V3 {
  const q = Transform_get_rotation(c, t);
  const r = new Vector3(v.x, v.y, v.z).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w).invert());
  return { x: r.x, y: r.y, z: r.z };
}
function m4(m: Matrix4): Record<string, number> {
  const e = m.elements;
  const out: Record<string, number> = {};
  for (let r = 0; r < 4; r++) for (let col = 0; col < 4; col++) out[`m${r}${col}`] = e[col * 4 + r];
  return out;
}
export function Transform_get_localToWorldMatrix(c: Ctx, t: H): Record<string, number> {
  return m4(fresh(c, t, 'Transform.localToWorldMatrix').world);
}
export function Transform_get_worldToLocalMatrix(c: Ctx, t: H): Record<string, number> {
  return m4(fresh(c, t, 'Transform.worldToLocalMatrix').world.clone().invert());
}
export function Transform_Translate$Vector3(c: Ctx, t: H, v: V3): void {
  // Space.Self：沿自己的軸
  const d = Transform_TransformDirection$Vector3(c, t, v);
  const p = Transform_get_position(c, t);
  Transform_set_position(c, t, { x: p.x + d.x, y: p.y + d.y, z: p.z + d.z });
}
export function Transform_Rotate$Vector3(c: Ctx, t: H, e: V3): void {
  const q = Transform_get_localRotation(c, t);
  const d = fromEuler(e);
  const r = new Quaternion(q.x, q.y, q.z, q.w).multiply(new Quaternion(d.x, d.y, d.z, d.w));
  Transform_set_localRotation(c, t, { x: r.x, y: r.y, z: r.z, w: r.w });
}
export function Transform_Rotate$float_float_float(c: Ctx, t: H, x: number, y: number, z: number): void {
  Transform_Rotate$Vector3(c, t, { x, y, z });
}
export function Transform_SetPositionAndRotation(c: Ctx, t: H, p: V3, q: Q): void {
  Transform_set_position(c, t, p);
  Transform_set_rotation(c, t, q);
}
export function Transform_get_hasChanged(c: Ctx, t: H): boolean {
  void c;
  void t;
  return true;
}
export function Transform_set_hasChanged(c: Ctx, t: H, v: boolean): void {
  void c;
  void t;
  void v;
}
export function Transform_get_gameObject(c: Ctx, t: H): H {
  void c;
  return gameObjectOf(aliveH(t, 'Transform.gameObject').node);
}

// ───────── SceneManagement ─────────

/** 無效的 Scene（default(Scene)、找不到的場景） */
export const INVALID_SCENE: LoadedScene = { handle: 0, name: '', path: '', buildIndex: -1, isLoaded: false };
export function Scene_IsValid(c: Ctx, s: LoadedScene): boolean {
  void c;
  return !!s && s.handle !== 0;
}
export function Scene_get_name(c: Ctx, s: LoadedScene): string {
  void c;
  return s?.name ?? '';
}
export function Scene_get_path(c: Ctx, s: LoadedScene): string {
  void c;
  return s?.path ?? '';
}
export function Scene_get_buildIndex(c: Ctx, s: LoadedScene): number {
  void c;
  return s?.buildIndex ?? -1;
}
export function Scene_get_isLoaded(c: Ctx, s: LoadedScene): boolean {
  void c;
  return !!s?.isLoaded;
}
export function Scene_get_handle(c: Ctx, s: LoadedScene): number {
  void c;
  return s?.handle ?? 0;
}
export function Scene_get_rootCount(c: Ctx, s: LoadedScene): number {
  return w(c).scenes.rootsOf(s).length;
}
export function Scene_op_Equality(c: Ctx, a: LoadedScene, b: LoadedScene): boolean {
  void c;
  return (a?.handle ?? 0) === (b?.handle ?? 0);
}
export function Scene_op_Inequality(c: Ctx, a: LoadedScene, b: LoadedScene): boolean {
  return !Scene_op_Equality(c, a, b);
}
export function Scene_GetHashCode(c: Ctx, s: LoadedScene): number {
  void c;
  return s?.handle ?? 0;
}
export function Scene_GetRootGameObjects$(c: Ctx, s: LoadedScene): H[] {
  return w(c).scenes.rootsOf(s).map(gameObjectOf);
}
export function Scene_GetRootGameObjects$List(c: Ctx, s: LoadedScene, out: H[]): void {
  out.length = 0;
  out.push(...Scene_GetRootGameObjects$(c, s));
}
export function SceneManager_GetActiveScene(c: Ctx): LoadedScene {
  return w(c).scenes.active ?? INVALID_SCENE;
}
export function SceneManager_SetActiveScene(c: Ctx, s: LoadedScene): boolean {
  return w(c).scenes.setActive(s);
}
export function SceneManager_get_sceneCount(c: Ctx): number {
  return w(c).scenes.loaded.length;
}
export function SceneManager_get_loadedSceneCount(c: Ctx): number {
  return w(c).scenes.loaded.filter((s) => s.isLoaded).length;
}
export function SceneManager_get_sceneCountInBuildSettings(c: Ctx): number {
  void c;
  return getObjectStore()?.buildOrder.length ?? 0;
}
export function SceneManager_GetSceneAt(c: Ctx, i: number): LoadedScene {
  return w(c).scenes.loaded[i] ?? INVALID_SCENE;
}
export function SceneManager_GetSceneByName(c: Ctx, name: string): LoadedScene {
  return w(c).scenes.byName(name) ?? INVALID_SCENE;
}
export const SceneManager_GetSceneByPath = SceneManager_GetSceneByName;
export function SceneManager_GetSceneByBuildIndex(c: Ctx, i: number): LoadedScene {
  return w(c).scenes.byBuildIndex(i) ?? INVALID_SCENE;
}

/** AsyncOperation（LoadSceneAsync、UnloadSceneAsync 的回傳）：isDone 之後發 completed；協程 yield 它會等到 isDone */
export class AsyncOperationJs {
  readonly $type = 'AsyncOperation';
  isDone = false;
  progress = 0;
  allowSceneActivation = true;
  priority = 0;
  /** 完成時的結果（LoadSceneAsync：LoadedScene） */
  result: unknown = null;
  finish(result: unknown): void {
    this.isDone = true;
    this.progress = 1;
    this.result = result;
    const subs = eventGet(staticCtx, 'AsyncOperation.completed', this);
    if (subs) for (const f of subs) f(this);
  }
}
export function AsyncOperation_get_isDone(c: Ctx, op: AsyncOperationJs): boolean {
  void c;
  return need(op, 'AsyncOperation.isDone').isDone;
}
export function AsyncOperation_get_progress(c: Ctx, op: AsyncOperationJs): number {
  void c;
  return need(op, 'AsyncOperation.progress').progress;
}
export function AsyncOperation_get_allowSceneActivation(c: Ctx, op: AsyncOperationJs): boolean {
  void c;
  return op.allowSceneActivation;
}
export function AsyncOperation_set_allowSceneActivation(c: Ctx, op: AsyncOperationJs, v: boolean): void {
  void c;
  op.allowSceneActivation = v;
}
export function AsyncOperation_set_priority(c: Ctx, op: AsyncOperationJs, v: number): void {
  void c;
  op.priority = v;
}

function startLoad(c: Ctx, key: string | number, mode: number): AsyncOperationJs {
  const world = w(c);
  const op = new AsyncOperationJs();
  if (!world.services.loadScene) throw new Error('SceneManager.LoadScene：開機流程沒有接上場景載入（用 bootGame）');
  world.services.loadScene(key, mode).then(
    (scene) => op.finish(scene),
    (e) => world.reportException(`載入場景 ${key}`, e),
  );
  return op;
}
/** SceneManager.LoadScene：Unity 也不是立刻載入（下一格才換上），這裡跟 LoadSceneAsync 一樣在檔案載完的下一格併進來 */
export function SceneManager_LoadScene$string_LoadSceneMode(c: Ctx, name: string, mode: number): void {
  startLoad(c, name, mode);
}
export function SceneManager_LoadScene$string(c: Ctx, name: string): void {
  startLoad(c, name, LoadSceneMode.Single);
}
export function SceneManager_LoadScene$int(c: Ctx, i: number): void {
  startLoad(c, i, LoadSceneMode.Single);
}
export function SceneManager_LoadScene$int_LoadSceneMode(c: Ctx, i: number, mode: number): void {
  startLoad(c, i, mode);
}
export function SceneManager_LoadSceneAsync$string_LoadSceneMode(c: Ctx, name: string, mode: number): AsyncOperationJs {
  return startLoad(c, name, mode);
}
export function SceneManager_LoadSceneAsync$string(c: Ctx, name: string): AsyncOperationJs {
  return startLoad(c, name, LoadSceneMode.Single);
}
export function SceneManager_LoadSceneAsync$int(c: Ctx, i: number): AsyncOperationJs {
  return startLoad(c, i, LoadSceneMode.Single);
}
export function SceneManager_LoadSceneAsync$int_LoadSceneMode(c: Ctx, i: number, mode: number): AsyncOperationJs {
  return startLoad(c, i, mode);
}
/** UnloadSceneAsync：下一格卸載 */
export function SceneManager_UnloadSceneAsync$Scene(c: Ctx, s: LoadedScene): AsyncOperationJs {
  const world = w(c);
  const op = new AsyncOperationJs();
  world.beforeNextTick(() => {
    world.scenes.unload(s);
    op.finish(null);
  });
  return op;
}
export function SceneManager_UnloadSceneAsync$string(c: Ctx, name: string): AsyncOperationJs {
  return SceneManager_UnloadSceneAsync$Scene(c, SceneManager_GetSceneByName(c, name));
}
export function SceneManager_UnloadSceneAsync$int(c: Ctx, i: number): AsyncOperationJs {
  return SceneManager_UnloadSceneAsync$Scene(c, SceneManager_GetSceneByBuildIndex(c, i));
}
export function SceneManager_MoveGameObjectToScene(c: Ctx, go: H, s: LoadedScene): void {
  const node = aliveH(go, 'MoveGameObjectToScene').node;
  if (!node.parent) node.scene = s;
  void c;
}

/** World 的場景事件接到 C# 的靜態事件 SceneManager.sceneLoaded／sceneUnloaded／activeSceneChanged（產生碼用 R.eventAdd 訂閱） */
export function installSceneEvents(world: World): void {
  // ScriptableObject 裡指向場景物件的參照（core.ts 的 resolveSceneRefs）：已經載入的先接，之後每個場景併進樹時接
  world.scenes.merged.push((scene) => resolveSceneRefs(world, scene));
  for (const s of world.scenes.loaded) resolveSceneRefs(world, s);
  world.scenes.sceneLoaded.push((scene, mode) => {
    for (const f of eventGet(staticCtx, 'SceneManager.sceneLoaded', null) ?? []) world.guard('SceneManager.sceneLoaded', () => f(scene, mode));
  });
  world.scenes.sceneUnloaded.push((scene) => {
    for (const f of eventGet(staticCtx, 'SceneManager.sceneUnloaded', null) ?? []) world.guard('SceneManager.sceneUnloaded', () => f(scene));
  });
  world.scenes.activeSceneChanged.push((prev, next) => {
    for (const f of eventGet(staticCtx, 'SceneManager.activeSceneChanged', null) ?? []) world.guard('SceneManager.activeSceneChanged', () => f(prev ?? INVALID_SCENE, next));
  });
}

// ───────── Resources ─────────

/** Resources.Load(path)：Resources 資料夾的 ScriptableObject（資料物件）或 prefab（參照，可以 Instantiate）；沒有回 null */
export function Resources_Load$string(c: Ctx, path: string, type?: string): unknown {
  void c;
  void type;
  const store = getObjectStore();
  const guid = store?.resourceGuid(path);
  if (!store || !guid) return null;
  if (store.isScriptableObject(guid)) return materializeScriptableObject(guid);
  if (store.isPrefab(guid)) {
    const f = store.prefabFile(guid);
    return { guid, fileID: f.roots[0] };
  }
  return null;
}
export const Resources_Load$string_Type = Resources_Load$string;
export const Resources_Load$ = Resources_Load$string;
export function Resources_LoadAsync$string(c: Ctx, path: string): { asset: unknown; isDone: boolean } {
  return { asset: Resources_Load$string(c, path), isDone: true };
}
export function Resources_UnloadUnusedAssets(c: Ctx): AsyncOperationJs {
  void c;
  const op = new AsyncOperationJs();
  op.finish(null);
  return op;
}
export function Resources_UnloadAsset(c: Ctx, o: unknown): void {
  void c;
  void o;
}

// ───────── Application、Time、Screen、SystemInfo ─────────

export function Application_get_isPlaying(c: Ctx): boolean {
  void c;
  return true;
}
export function Application_get_isEditor(c: Ctx): boolean {
  void c;
  return false;
}
export function Application_get_isBatchMode(c: Ctx): boolean {
  void c;
  return false;
}
export function Application_get_isFocused(c: Ctx): boolean {
  void c;
  return typeof document === 'undefined' ? true : document.hasFocus();
}
/**
 * OnApplicationFocus(bool)：視窗拿到／失去焦點時，送給每個啟用中的 MonoBehaviour（物件啟用、元件啟用；停用的收不收得到未查證）。
 * 排在下一格開頭（Unity 在兩格之間送，腳本的 Update 之前）。MT2 的 SoundManager 照它重算音量（背景靜音的設定）
 */
export function installApplicationFocus(world: World): void {
  if (typeof window === 'undefined') return;
  const send = (hasFocus: boolean): void =>
    world.beforeNextTick(() => {
      for (const [comp, b] of [...world.behaviours]) {
        const fn = (b as unknown as Record<string, unknown>).OnApplicationFocus;
        if (typeof fn !== 'function' || comp.m_Enabled === 0) continue;
        if (!world.graph.nodeById(comp.gameObject as unknown as string)?.activeInHierarchy) continue;
        world.guard(`${comp.script?.class ?? comp.type}.OnApplicationFocus`, () => fn(hasFocus));
      }
    });
  window.addEventListener('focus', () => send(true));
  window.addEventListener('blur', () => send(false));
}
/** RuntimePlatform：原版是 Windows build（WindowsPlayer = 2）；網頁上照原版的平台回答，平台專屬的分支才走得跟原版一樣 */
let platform = 2;
export function setRuntimePlatform(p: number): void {
  platform = p;
}
export function Application_get_platform(c: Ctx): number {
  void c;
  return platform;
}
let appInfo = { version: '', productName: '', companyName: '', identifier: '', unityVersion: '' };
export function setApplicationInfo(info: Partial<typeof appInfo>): void {
  appInfo = { ...appInfo, ...info };
}
export function Application_get_version(c: Ctx): string {
  return c.w?.services.version || appInfo.version;
}
export function Application_get_productName(c: Ctx): string {
  void c;
  return appInfo.productName;
}
export function Application_get_companyName(c: Ctx): string {
  void c;
  return appInfo.companyName;
}
export function Application_get_identifier(c: Ctx): string {
  void c;
  return appInfo.identifier;
}
export function Application_get_unityVersion(c: Ctx): string {
  void c;
  return appInfo.unityVersion;
}
/** 存檔的路徑：網頁上沒有檔案系統，給虛擬路徑；System.IO 的相容層（dotnet.ts）把這些路徑對到瀏覽器的儲存空間 */
export function Application_get_persistentDataPath(c: Ctx): string {
  void c;
  return '/persistent';
}
export function Application_get_temporaryCachePath(c: Ctx): string {
  void c;
  return '/temp';
}
export function Application_get_streamingAssetsPath(c: Ctx): string {
  void c;
  return '/streaming';
}
export function Application_get_dataPath(c: Ctx): string {
  void c;
  return '/data';
}
/** SystemLanguage：照瀏覽器語言（English = 10）；遊戲自己的語言設定另外存 */
const SYSTEM_LANGUAGES: Record<string, number> = { en: 10, zh: 6, 'zh-tw': 41, 'zh-hant': 41, 'zh-cn': 40, 'zh-hans': 40, ja: 22, ko: 23, fr: 14, de: 15, es: 34, it: 21, pt: 28, ru: 30, pl: 27 };
export function Application_get_systemLanguage(c: Ctx): number {
  void c;
  const l = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase();
  return SYSTEM_LANGUAGES[l] ?? SYSTEM_LANGUAGES[l.split('-')[0]] ?? 10;
}
let targetFrameRate = -1;
export function Application_get_targetFrameRate(c: Ctx): number {
  void c;
  return targetFrameRate;
}
export function Application_set_targetFrameRate(c: Ctx, v: number): void {
  void c;
  targetFrameRate = v;
}
export function Application_get_runInBackground(c: Ctx): boolean {
  void c;
  return true;
}
export function Application_set_runInBackground(c: Ctx, v: boolean): void {
  void c;
  void v;
}
export function Application_SetStackTraceLogType(c: Ctx, ...a: unknown[]): void {
  void c;
  void a;
}
export function Application_OpenURL(c: Ctx, url: string): void {
  void c;
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
}
/** Application.Quit 最後真正關掉的做法：遊戲專案照平台登記（APK 殼關 Activity、瀏覽器關分頁）；沒登記就不關，只記一筆 */
let quitHandler: (() => void) | null = null;
export function setApplicationQuitHandler(fn: (() => void) | null): void {
  quitHandler = fn;
}
let quitPending = false;
/**
 * Application.Quit：Unity 在這一格結束才處理，排到下一格開頭。先問 Application.wantsToQuit 的每個訂閱者，有一個回 false 就取消
 * （MT2 LoadingScreen.WantsToQuit 先存檔，存完自己再叫一次 Application.Quit）；都放行才送 OnApplicationQuit 給啟用中的 MonoBehaviour、
 * 發 Application.quitting，等 /persistent 的寫入進了 IndexedDB 再交給 quitHandler（頁面先關掉的話剛存的檔還沒寫進去）
 */
export function Application_Quit$(c: Ctx): void {
  const world = w(c);
  if (quitPending) return;
  quitPending = true;
  world.beforeNextTick(() => {
    let allow = true;
    for (const h of eventGet(c, 'Application.wantsToQuit', null) ?? [])
      world.guard('Application.wantsToQuit', () => {
        if (h() === false) allow = false;
      });
    if (!allow) {
      quitPending = false;
      return;
    }
    for (const [comp, b] of [...world.behaviours]) {
      const fn = (b as unknown as Record<string, unknown>).OnApplicationQuit;
      if (typeof fn !== 'function' || comp.m_Enabled === 0) continue;
      if (!world.graph.nodeById(comp.gameObject as unknown as string)?.activeInHierarchy) continue;
      world.guard(`${comp.script?.class ?? comp.type}.OnApplicationQuit`, () => fn());
    }
    for (const h of eventGet(c, 'Application.quitting', null) ?? []) world.guard('Application.quitting', () => void h());
    if (!quitHandler) {
      world.notes.add('Application.Quit（沒有登記關法，不關）');
      quitPending = false;
      return;
    }
    const quit = quitHandler;
    void flushPersistent().then(quit);
  });
}
export const Application_Quit$int = Application_Quit$;
export function Application_get_internetReachability(c: Ctx): number {
  void c;
  return typeof navigator !== 'undefined' && navigator.onLine ? 2 : 0;
}

/** Time.timeScale：存在 World（World.tick 拿它乘 Time.time／deltaTime）。Unity 對超出範圍的值怎麼處理未查證，照設的值存 */
export function Time_get_timeScale(c: Ctx): number {
  return w(c).timeScale;
}
export function Time_set_timeScale(c: Ctx, v: number): void {
  w(c).timeScale = v;
}
const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
export function Time_get_realtimeSinceStartup(c: Ctx): number {
  void c;
  return ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0) / 1000;
}
export const Time_get_realtimeSinceStartupAsDouble = Time_get_realtimeSinceStartup;
export function Time_get_fixedDeltaTime(c: Ctx): number {
  void c;
  return 0.02;
}
export function Time_get_timeSinceLevelLoad(c: Ctx): number {
  return w(c).time;
}
export function Time_get_unscaledTimeAsDouble(c: Ctx): number {
  return w(c).unscaledTime;
}
export function Time_get_timeAsDouble(c: Ctx): number {
  return w(c).time;
}
export function Time_get_smoothDeltaTime(c: Ctx): number {
  return w(c).deltaTime;
}
export function Time_get_maximumDeltaTime(c: Ctx): number {
  void c;
  return 0.33333334;
}

export function Screen_get_fullScreen(c: Ctx): boolean {
  void c;
  return typeof document !== 'undefined' && !!document.fullscreenElement;
}
export function Screen_set_fullScreen(c: Ctx, v: boolean): void {
  void c;
  void v;
}
export function Screen_get_fullScreenMode(c: Ctx): number {
  void c;
  return 1; // FullScreenWindow
}
export function Screen_set_fullScreenMode(c: Ctx, v: number): void {
  void c;
  void v;
}
export function Screen_get_dpi(c: Ctx): number {
  void c;
  return 96 * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);
}
/**
 * Resolution（結構）：width、height、refreshRateRatio。Unity 2022 的 refreshRate（int）已經過時，是從 refreshRateRatio 四捨五入來的；
 * 以 refreshRateRatio 為準。10/18：原版 GetCurrentMonitorResolution 用 new Resolution { refreshRateRatio = … } 建，
 * 以前 get_refreshRateRatio 讀 refreshRate（建構預設 0），MT2 的更新率全變 0，目標幀率清單多一個「0」
 */
type RefreshRateJs = { numerator: number; denominator: number; value: number };
const refreshRateOf = (hz: number): RefreshRateJs => ({ numerator: hz, denominator: 1, value: hz });
export const Resolution_get_width = (_c: Ctx, r: { width: number }): number => r.width;
export const Resolution_get_height = (_c: Ctx, r: { height: number }): number => r.height;
export const Resolution_get_refreshRateRatio = (_c: Ctx, r: { refreshRate?: number; refreshRateRatio?: RefreshRateJs }): RefreshRateJs =>
  r.refreshRateRatio?.denominator ? r.refreshRateRatio : refreshRateOf(r.refreshRate ?? 0);
export const Resolution_get_refreshRate = (c: Ctx, r: { refreshRate?: number; refreshRateRatio?: RefreshRateJs }): number => {
  const q = Resolution_get_refreshRateRatio(c, r);
  return Math.round(q.numerator / q.denominator);
};
export const Resolution_ToString = (c: Ctx, r: { width: number; height: number; refreshRate?: number; refreshRateRatio?: RefreshRateJs }): string => `${r.width} x ${r.height} @ ${Resolution_get_refreshRate(c, r)}Hz`;

/**
 * 螢幕的更新率（Hz）：網頁查不到，遊戲專案開機時給（APK 殼回報、或量 requestAnimationFrame 的間隔，見 viewer/framePacing.ts）。沒給是 60。
 * Screen.currentResolution、Screen.resolutions 的 refreshRateRatio 與主迴圈的垂直同步都用它
 */
let displayRefreshRate = 60;
export function setDisplayRefreshRate(hz: number): void {
  if (hz > 0 && Number.isFinite(hz)) displayRefreshRate = hz;
}
export const getDisplayRefreshRate = (): number => displayRefreshRate;
/** 主迴圈的節流照這兩個（Unity：QualitySettings.vSyncCount 與 Application.targetFrameRate） */
export function frameRateSettings(): { vSyncCount: number; targetFrameRate: number } {
  return { vSyncCount: Number(nativeGet(staticCtx, null, 'QualitySettings', 'vSyncCount')) || 0, targetFrameRate };
}
/**
 * 螢幕（桌面）的解析度。Unity 的 Screen.currentResolution 在視窗模式回傳桌面解析度、Screen.resolutions 是螢幕支援的全螢幕解析度，
 * 兩個都跟視窗（繪圖緩衝）大小無關。網頁上就是 window.screen 乘 devicePixelRatio（實體像素）；更新率見 displayRefreshRate。
 * 沒有 window.screen（測試）或量到 0 時用繪圖緩衝的大小。
 * 10/16：原本拿繪圖緩衝，預覽窗隱藏時開機是 0×0，MT2 的 GraphicsSettingsManager 濾掉後清單變空，FindNearestSupportedResolution 讀 [0] 丟例外，存檔工作卡住
 */
function monitorResolution(c: Ctx): { $type: string; width: number; height: number; refreshRate: number; refreshRateRatio: RefreshRateJs } {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const scr = typeof screen !== 'undefined' ? screen : null;
  let width = scr ? Math.round(scr.width * dpr) : 0;
  let height = scr ? Math.round(scr.height * dpr) : 0;
  if (!width || !height) ({ w: width, h: height } = w(c).screen);
  const hz = Math.round(displayRefreshRate);
  return { $type: 'Resolution', width, height, refreshRate: hz, refreshRateRatio: refreshRateOf(hz) };
}
export function Screen_get_resolutions(c: Ctx): ReturnType<typeof monitorResolution>[] {
  return [monitorResolution(c)];
}
export function Screen_get_currentResolution(c: Ctx): ReturnType<typeof monitorResolution> {
  return monitorResolution(c);
}
export function Screen_SetResolution$int_int_FullScreenMode(c: Ctx, ...a: unknown[]): void {
  void c;
  void a;
}
export const Screen_SetResolution$int_int_bool = Screen_SetResolution$int_int_FullScreenMode;
export function Screen_get_safeArea(c: Ctx): { x: number; y: number; width: number; height: number } {
  const s = w(c).screen;
  return { x: 0, y: 0, width: s.w, height: s.h };
}
export function Screen_get_orientation(c: Ctx): number {
  const s = w(c).screen;
  return s.w >= s.h ? 3 : 1;
}
export function Screen_set_sleepTimeout(c: Ctx, v: number): void {
  void c;
  void v;
}

const SYSTEM_INFO: Record<string, unknown> = {
  operatingSystem: typeof navigator !== 'undefined' ? navigator.userAgent : 'web',
  operatingSystemFamily: 0,
  processorType: 'web',
  processorCount: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4,
  processorFrequency: 0,
  systemMemorySize: 8192,
  graphicsDeviceVendor: 'WebGL',
  graphicsDeviceName: 'WebGL',
  graphicsDeviceVersion: 'WebGL 2.0',
  graphicsShaderLevel: 45,
  graphicsMemorySize: 2048,
  deviceName: 'web',
  deviceModel: 'web',
  deviceUniqueIdentifier: 'web',
  deviceType: 3,
  supportsComputeShaders: false,
  supportsInstancing: true,
};
export const SystemInfo_get_operatingSystem = (): unknown => SYSTEM_INFO.operatingSystem;
export const SystemInfo_get_operatingSystemFamily = (): unknown => SYSTEM_INFO.operatingSystemFamily;
export const SystemInfo_get_processorType = (): unknown => SYSTEM_INFO.processorType;
export const SystemInfo_get_processorCount = (): unknown => SYSTEM_INFO.processorCount;
export const SystemInfo_get_processorFrequency = (): unknown => SYSTEM_INFO.processorFrequency;
export const SystemInfo_get_systemMemorySize = (): unknown => SYSTEM_INFO.systemMemorySize;
export const SystemInfo_get_graphicsDeviceVendor = (): unknown => SYSTEM_INFO.graphicsDeviceVendor;
export const SystemInfo_get_graphicsDeviceName = (): unknown => SYSTEM_INFO.graphicsDeviceName;
export const SystemInfo_get_graphicsDeviceVersion = (): unknown => SYSTEM_INFO.graphicsDeviceVersion;
export const SystemInfo_get_graphicsShaderLevel = (): unknown => SYSTEM_INFO.graphicsShaderLevel;
export const SystemInfo_get_graphicsMemorySize = (): unknown => SYSTEM_INFO.graphicsMemorySize;
export const SystemInfo_get_deviceName = (): unknown => SYSTEM_INFO.deviceName;
export const SystemInfo_get_deviceModel = (): unknown => SYSTEM_INFO.deviceModel;
export const SystemInfo_get_deviceUniqueIdentifier = (): unknown => SYSTEM_INFO.deviceUniqueIdentifier;
export const SystemInfo_get_deviceType = (): unknown => SYSTEM_INFO.deviceType;
export const SystemInfo_get_supportsComputeShaders = (): unknown => SYSTEM_INFO.supportsComputeShaders;
export const SystemInfo_get_supportsInstancing = (): unknown => SYSTEM_INFO.supportsInstancing;

// ───────── Debug ─────────

function logMsg(a: unknown[]): string {
  return a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? x.message : String(x))).join(' ');
}
export function Debug_Log$Object(c: Ctx, ...a: unknown[]): void {
  void c;
  trace.log.push({ level: 'Debug.Log', msg: logMsg(a) });
}
export const Debug_Log$Object_Object = Debug_Log$Object;
export function Debug_LogWarning$Object(c: Ctx, ...a: unknown[]): void {
  void c;
  trace.log.push({ level: 'Debug.LogWarning', msg: logMsg(a) });
}
export const Debug_LogWarning$Object_Object = Debug_LogWarning$Object;
export function Debug_LogError$Object(c: Ctx, ...a: unknown[]): void {
  void c;
  const msg = logMsg(a);
  trace.log.push({ level: 'Debug.LogError', msg });
  console.warn(`[Debug.LogError] ${msg}`);
}
export const Debug_LogError$Object_Object = Debug_LogError$Object;
export function Debug_LogException$Exception(c: Ctx, e: unknown): void {
  (c.w ?? getActiveWorld())?.reportException('Debug.LogException', e);
}
export const Debug_LogException$Exception_Object = Debug_LogException$Exception;
function fmt(f: string, args: unknown[]): string {
  return f.replace(/\{(\d+)(?:[:,][^}]*)?\}/g, (_, i) => String(args[Number(i)]));
}
export function Debug_LogFormat$string_Object_arr(c: Ctx, f: string, args: unknown[]): void {
  Debug_Log$Object(c, fmt(f, args ?? []));
}
export function Debug_LogWarningFormat$string_Object_arr(c: Ctx, f: string, args: unknown[]): void {
  Debug_LogWarning$Object(c, fmt(f, args ?? []));
}
export function Debug_LogErrorFormat$string_Object_arr(c: Ctx, f: string, args: unknown[]): void {
  Debug_LogError$Object(c, fmt(f, args ?? []));
}
export function Debug_LogErrorFormat$Object_string_Object_arr(c: Ctx, ctx: unknown, f: string, args: unknown[]): void {
  void ctx;
  Debug_LogError$Object(c, fmt(f, args ?? []));
}
export function Debug_Assert$bool(c: Ctx, cond: boolean, ...a: unknown[]): void {
  if (!cond) Debug_LogError$Object(c, 'Assertion failed', ...a);
}
export const Debug_Assert$bool_Object = Debug_Assert$bool;
export const Debug_Assert$bool_string = Debug_Assert$bool;
export function Debug_DrawLine$Vector3_Vector3_Color(c: Ctx, ...a: unknown[]): void {
  void c;
  void a;
}
export const Debug_DrawLine$Vector3_Vector3 = Debug_DrawLine$Vector3_Vector3_Color;
export const Debug_DrawRay$Vector3_Vector3 = Debug_DrawLine$Vector3_Vector3_Color;
export const Debug_DrawRay$Vector3_Vector3_Color = Debug_DrawLine$Vector3_Vector3_Color;
export function Debug_get_isDebugBuild(c: Ctx): boolean {
  void c;
  return false;
}
export function Debug_Break(c: Ctx): void {
  void c;
}
export function MonoBehaviour_print(c: Ctx, msg: unknown): void {
  Debug_Log$Object(c, msg);
}

// ───────── PlayerPrefs（瀏覽器的 localStorage，key 前綴 PlayerPrefs:） ─────────

const PP = 'PlayerPrefs:';
function ls(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
const ppMemory = new Map<string, string>();
function ppGet(k: string): string | null {
  const s = ls();
  return s ? s.getItem(PP + k) : (ppMemory.get(k) ?? null);
}
function ppSet(k: string, v: string): void {
  const s = ls();
  if (s) s.setItem(PP + k, v);
  else ppMemory.set(k, v);
}
export function PlayerPrefs_HasKey(c: Ctx, k: string): boolean {
  void c;
  return ppGet(k) !== null;
}
export function PlayerPrefs_DeleteKey(c: Ctx, k: string): void {
  void c;
  const s = ls();
  if (s) s.removeItem(PP + k);
  else ppMemory.delete(k);
}
export function PlayerPrefs_DeleteAll(c: Ctx): void {
  void c;
  const s = ls();
  if (s) for (const k of Object.keys(s)) if (k.startsWith(PP)) s.removeItem(k);
  ppMemory.clear();
}
export function PlayerPrefs_Save(c: Ctx): void {
  void c;
}
export function PlayerPrefs_GetString$string(c: Ctx, k: string): string {
  void c;
  return ppGet(k) ?? '';
}
export function PlayerPrefs_GetString$string_string(c: Ctx, k: string, d: string): string {
  void c;
  return ppGet(k) ?? d;
}
export function PlayerPrefs_SetString(c: Ctx, k: string, v: string): void {
  void c;
  ppSet(k, v);
}
export function PlayerPrefs_GetInt$string(c: Ctx, k: string): number {
  void c;
  const v = ppGet(k);
  return v === null ? 0 : parseInt(v, 10) | 0;
}
export function PlayerPrefs_GetInt$string_int(c: Ctx, k: string, d: number): number {
  void c;
  const v = ppGet(k);
  return v === null ? d : parseInt(v, 10) | 0;
}
export function PlayerPrefs_SetInt(c: Ctx, k: string, v: number): void {
  void c;
  ppSet(k, String(v | 0));
}
export function PlayerPrefs_GetFloat$string(c: Ctx, k: string): number {
  void c;
  const v = ppGet(k);
  return v === null ? 0 : Math.fround(parseFloat(v));
}
export function PlayerPrefs_GetFloat$string_float(c: Ctx, k: string, d: number): number {
  void c;
  const v = ppGet(k);
  return v === null ? d : Math.fround(parseFloat(v));
}
export function PlayerPrefs_SetFloat(c: Ctx, k: string, v: number): void {
  void c;
  ppSet(k, String(v));
}

// ───────── MonoBehaviour 的其他訊息 ─────────

/** MonoBehaviour.Invoke(方法名, 秒)：genBehaviour 把產生的方法照原名掛在 behaviour 上 */
export function MonoBehaviour_Invoke(c: Ctx, owner: H, method: string, delay: number): void {
  const world = w(c);
  let left = delay;
  const co = {
    owner,
    method,
    step(dt: number) {
      left -= dt;
      if (left > 0) return true;
      const b = owner.comp ? (world.behaviours.get(owner.comp) as Record<string, unknown> | undefined) : undefined;
      const fn = b?.[method];
      if (typeof fn === 'function' && objAlive(owner)) fn();
      return false;
    },
  };
  world.coroutines.add(co);
  invokes.add(co);
}
const invokes = new Set<{ owner: H; method: string; step(dt: number): boolean }>();
export function MonoBehaviour_CancelInvoke$(c: Ctx, owner: H): void {
  const world = w(c);
  for (const co of [...invokes]) if (co.owner === owner) {
    world.coroutines.delete(co);
    invokes.delete(co);
  }
}
export function MonoBehaviour_CancelInvoke$string(c: Ctx, owner: H, method: string): void {
  const world = w(c);
  for (const co of [...invokes]) if (co.owner === owner && co.method === method) {
    world.coroutines.delete(co);
    invokes.delete(co);
  }
}
export function MonoBehaviour_IsInvoking$(c: Ctx, owner: H): boolean {
  void c;
  for (const co of invokes) if (co.owner === owner && w(c).coroutines.has(co)) return true;
  return false;
}
export function MonoBehaviour_InvokeRepeating(c: Ctx, owner: H, method: string, delay: number, rate: number): void {
  const world = w(c);
  let left = delay;
  const co = {
    owner,
    method,
    step(dt: number) {
      left -= dt;
      while (left <= 0) {
        const b = owner.comp ? (world.behaviours.get(owner.comp) as Record<string, unknown> | undefined) : undefined;
        const fn = b?.[method];
        if (!objAlive(owner)) return false;
        if (typeof fn === 'function' && owner.node.activeInHierarchy) fn();
        left += rate > 0 ? rate : Infinity;
      }
      return true;
    },
  };
  world.coroutines.add(co);
  invokes.add(co);
}


// ───────── JsonUtility（Unity 的序列化規則：只有會序列化的欄位，巢狀的 [Serializable] 物件照欄位型別建） ─────────


/** JSON 裡的 UnityEngine.Object 參照（{"instanceID": N}）換回物件 */
function resolveInstanceIds(v: unknown): unknown {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(resolveInstanceIds);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === 'instanceID' && typeof o.instanceID === 'number') return objectOfInstanceId(o.instanceID);
  for (const k of keys) o[k] = resolveInstanceIds(o[k]);
  return o;
}
/** JSON 的值寫進物件（資料物件直接寫欄位；場景元件寫進它的執行期欄位） */
function overwrite(c: Ctx, obj: unknown, json: Record<string, unknown>): void {
  const data = resolveInstanceIds(json) as Record<string, unknown>;
  if (obj instanceof H) {
    const cls = scriptGenName(obj.comp?.script);
    for (const [k, v] of Object.entries(data)) {
      const fd = cls ? fieldDescOf(cls, k) : undefined;
      mbSet(c, obj, k, fd ? unityData(c, fd, v) : v);
    }
    return;
  }
  const o = obj as Record<string, unknown>;
  const cls = o.$type as string | undefined;
  const cc = cls && hasGen(cls) ? ctxOf(c.w, o, cls) : c;
  for (const [k, v] of Object.entries(data)) {
    const fd = cls && hasGen(cls) ? fieldDescOf(cls, k) : undefined;
    o[k] = fd ? unityData(cc, fd, v) : v;
  }
}
export function JsonUtility_FromJsonOverwrite(c: Ctx, json: string, obj: unknown): void {
  if (obj == null) throw new Error('JsonUtility.FromJsonOverwrite：對象是 null（C# 會 ArgumentNullException）');
  if (!json) return;
  asDeserializing(() => overwrite(c, obj, JSON.parse(json)));
}
/** JsonUtility.FromJson<T>(json)：型別名在最後（轉換器把泛型引數接在後面）；產生的類別照欄位初始式與無參數建構子 new，再蓋上 JSON */
export function JsonUtility_FromJson$string(c: Ctx, json: string, type: string): unknown {
  if (!json) return null;
  if (!hasGen(type)) throw new Error(`JsonUtility.FromJson：${type} 沒有轉出`);
  return asDeserializing(() => {
    const obj = newGen(c, type, genClass(type).ctor0 ?? null);
    overwrite(c, obj, JSON.parse(json));
    return obj;
  });
}
export const JsonUtility_FromJson$string_Type = JsonUtility_FromJson$string;
export const JsonUtility_FromJson$ = JsonUtility_FromJson$string;
/** 資料物件是不是 UnityEngine.Object：ScriptableObject 資產、資產參照（{guid, fileID}）、類別的基底鏈有 Object */
function isUnityObjectData(c: Ctx, o: Record<string, unknown>): boolean {
  if ('$asset' in o || isAssetRef(o)) return true;
  return typeof o.$type === 'string' && typeNames(c.w, o.$type).has('Object');
}
function toPlain(c: Ctx, v: unknown, depth: number): unknown {
  if (v == null) return null;
  if (typeof v !== 'object') return v;
  if (depth > 10) return null;
  if (Array.isArray(v)) return v.map((x) => toPlain(c, x, depth + 1));
  if (v instanceof H) return { instanceID: Object_GetInstanceID(c, v) };
  if (typeof (v as { valueOf(): unknown }).valueOf === 'function' && typeof (v as { valueOf(): unknown }).valueOf() === 'number') return (v as { valueOf(): number }).valueOf();
  const o = v as Record<string, unknown>;
  // 欄位裡的 UnityEngine.Object（ScriptableObject、Sprite…）只寫參照，不展開（Unity 的 JsonUtility）；最外層才寫欄位
  if (depth > 0 && isUnityObjectData(c, o)) return { instanceID: Object_GetInstanceID(c, o) };
  const cls = o.$type as string | undefined;
  if (cls && hasGen(cls)) {
    const out: Record<string, unknown> = {};
    for (const k of serializedFieldsOf(cls)) out[k] = toPlain(c, o[k], depth + 1);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) if (!k.startsWith('$')) out[k] = toPlain(c, x, depth + 1);
  return out;
}
/** JsonUtility.ToJson：會序列化的欄位，照宣告順序（場景元件讀它的執行期欄位） */
export function JsonUtility_ToJson$Object_bool(c: Ctx, obj: unknown, pretty: boolean): string {
  if (obj == null) return '';
  let plain: unknown;
  if (obj instanceof H) {
    const cls = scriptGenName(obj.comp?.script);
    const out: Record<string, unknown> = {};
    if (cls && hasGen(cls)) for (const k of serializedFieldsOf(cls)) out[k] = toPlain(c, mbGet(c, obj, k), 1);
    plain = out;
  } else plain = toPlain(c, obj, 0);
  return JSON.stringify(plain, null, pretty ? 4 : undefined);
}
export function JsonUtility_ToJson$Object(c: Ctx, obj: unknown): string {
  return JsonUtility_ToJson$Object_bool(c, obj, false);
}

// ───────── uGUI 裡執行環境原生做的元件（cs2ts.json 的 exclude）：遊戲設定的屬性先記著 ─────────

const nativeProps = new WeakMap<object, Record<string, unknown>>();
function nprops(h: H): Record<string, unknown> {
  const key = h.comp ?? h.node;
  let p = nativeProps.get(key);
  if (!p) nativeProps.set(key, (p = {}));
  return p;
}
/** BaseInputModule.inputOverride（遊戲換掉輸入來源）：執行環境的事件系統直接讀瀏覽器的指標，這裡只記著 */
export function BaseInputModule_set_inputOverride(c: Ctx, m: H, v: unknown): void {
  void c;
  nprops(m).inputOverride = v;
}
export function BaseInputModule_get_inputOverride(c: Ctx, m: H): unknown {
  void c;
  return nprops(m).inputOverride ?? null;
}

// ───────── 外部結構的預設值 ─────────

registerExternalCtor('Resolution', () => ({ $type: 'Resolution', width: 0, height: 0, refreshRate: 0, refreshRateRatio: { numerator: 0, denominator: 1, value: 0 } }));
registerExternalCtor('RefreshRate', () => ({ $type: 'RefreshRate', numerator: 0, denominator: 1, value: 0 }));
registerValueType('Resolution', { format: (r) => Resolution_ToString(staticCtx, r) });
registerValueType('RefreshRate');

// ───────── Cursor（滑鼠游標：網頁上用 CSS；自訂游標圖還沒接） ─────────

let cursorVisible = true;
export function Cursor_get_visible(c: Ctx): boolean {
  void c;
  return cursorVisible;
}
export function Cursor_set_visible(c: Ctx, v: boolean): void {
  cursorVisible = v;
  w(c).services.sceneManager?.setCursorVisible(v);
  if (typeof document !== 'undefined') document.body.style.cursor = v ? '' : 'none';
}
export const Cursor_get_lockState = (_c: Ctx): number => 0;
export const Cursor_set_lockState = (_c: Ctx, v: number): void => void v;
export const Cursor_SetCursor = (_c: Ctx, tex: unknown, hotspot: unknown, mode: number): void => void [tex, hotspot, mode];
registerExternalCtor('Scene', () => INVALID_SCENE);
export const RefreshRate_Equals = (_c: Ctx, a: { numerator: number; denominator: number }, b: { numerator: number; denominator: number }): boolean =>
  !!a && !!b && a.numerator * b.denominator === b.numerator * a.denominator;
export const RefreshRate_get_value = (_c: Ctx, r: { numerator: number; denominator: number }): number => (r.denominator ? r.numerator / r.denominator : 0);
export const QualitySettings_GetQualityLevel = (_c: Ctx): number => 0;
export const QualitySettings_SetQualityLevel$int = (_c: Ctx, v: number): void => void v;
export const QualitySettings_SetQualityLevel$int_bool = (_c: Ctx, v: number, b: boolean): void => void [v, b];

// ───────── Profiler（遊戲只拿來記 log：瀏覽器有 performance.memory 就用它，沒有回 0） ─────────

const jsHeap = (): number => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
export const Profiler_GetTotalAllocatedMemoryLong = (_c: Ctx): number => jsHeap();
export const Profiler_GetTotalReservedMemoryLong = (_c: Ctx): number => (performance as unknown as { memory?: { totalJSHeapSize: number } }).memory?.totalJSHeapSize ?? 0;
export const Profiler_GetMonoHeapSizeLong = Profiler_GetTotalReservedMemoryLong;
export const Profiler_GetMonoUsedSizeLong = Profiler_GetTotalAllocatedMemoryLong;
export const Profiler_GetAllocatedMemoryForGraphicsDriver = (_c: Ctx): number => 0;
export const Profiler_BeginSample$string = (_c: Ctx, name: string): void => void name;
export const Profiler_EndSample = (_c: Ctx): void => undefined;

// ───────── ScriptableObject.CreateInstance、Camera.allCameras ─────────

/** ScriptableObject.CreateInstance：建構子 → Awake → OnEnable（Unity 建立 ScriptableObject 的順序） */
export function ScriptableObject_CreateInstance$(c: Ctx, type: string): unknown {
  const t = baseTypeName(type);
  if (!hasGen(t)) return { $type: t };
  const targs = splitTypeArgs(type);
  const ctor = genClass(t).ctor0 ?? null;
  const obj = (targs.length ? newGenT(c, t, targs, ctor) : newGen(c, t, ctor)) as object;
  const cc = ctxOf(c.w, obj, t);
  for (const m of ['Awake', 'OnEnable']) {
    const fn = genMethodOf(t, m);
    if (fn) fn(cc);
  }
  return obj;
}
export const ScriptableObject_CreateInstance$Type = ScriptableObject_CreateInstance$;
export const ScriptableObject_CreateInstance$string = ScriptableObject_CreateInstance$;

/** Camera.allCameras：啟用中（GameObject 在階層裡啟用、元件 enabled）的 Camera，照場景順序 */
export function Camera_get_allCameras(c: Ctx): H[] {
  const world = w(c);
  return world.graph.cameras.filter((cam) => cam.node.activeInHierarchy && (cam.data.m_Enabled as number) !== 0).map((cam) => compHandle(world, cam.data));
}
export const Camera_get_allCamerasCount = (c: Ctx): number => Camera_get_allCameras(c).length;
export function Camera_GetAllCameras(c: Ctx, out: H[]): number {
  const all = Camera_get_allCameras(c);
  for (let i = 0; i < all.length && i < out.length; i++) out[i] = all[i];
  return Math.min(all.length, out.length);
}

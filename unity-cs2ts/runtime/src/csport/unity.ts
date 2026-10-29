// 相容層：UnityEngine（引擎原生、沒有 C# 原始碼的部分）產生碼用到的 API。名字規則見 converter/Program.cs 檔頭。
// uGUI（UnityEngine.UI）是 managed C#：遊戲專案用轉換器的 sourceAssemblies 把 Selectable、Button 等一起轉，這裡只補它呼叫到的原生部分
// （Animator、EventSystem 的狀態、Graphic 的 CrossFadeColor、CanvasGroup、Transform…）。
// 來源是 diceomancer-web 的 src/runtime/csport/runtime.ts 的通用部分；用到時補，不整包搬。

import { Matrix4, Vector3 } from 'three';
import type { World } from '../engine/world';
import type { SceneNode } from '../unity/scene';
import type { ColorRGBA, ComponentData } from '../unity/types';
import { crossFadeColor } from '../ui/selectable';
import { componentOn, compHandle, compIsType, gameObjectOf, genCallVirtual, genMethodOf, getActiveWorld, getObjectStore, H, hasGen, invokeDelegate, liveObj, refHandle, setAssetTypeCheck, setPrefabAssetHooks, transformOf, type Ctx } from './core';
import type { SceneFile } from '../unity/types';
import { materializePrefabAsset } from '../unity/prefab';
import { clearRuntimeListeners, runtimeListenersOf } from '../unity/unityEvents';
import { subtree } from '../unity/instantiate';
import { new_Dictionary$ } from './dotnet';
import { registerNativeDataProp, registerNativeProp } from './unityNative';
import { GameObject_AddComponent$ } from './unityScene';

export * from './unityScene';
export * from './unityNative';
export * from './unityMath';
export * from './unityInput';
export * from './unityAssets';
export * from './unityVideo';
export * from './unityControls';
export * from './unityTmp';
export * from './unityCamera';
export * from './unityPlayables';
export * from './unityMesh';
export * from './unityGraphicMesh';
export * from './unityAudio';
export * from './unityParticles';

type V2 = { x: number; y: number };
type V3 = { x: number; y: number; z: number };
type RectV = { x: number; y: number; width: number; height: number };

/** 呼叫端的 World；資料物件與靜態方法的 Ctx 沒有時用目前作用中的（Unity 的 Time、Screen、Input 是全域的） */
function w(c: Ctx): World {
  const world = c.w ?? getActiveWorld();
  if (!world) throw new Error('這個呼叫要在場景裡（沒有作用中的 World）');
  return world;
}
function need<T>(v: T | null | undefined, what: string): T {
  if (v == null) throw new Error(`${what}：對象是 null（C# 會 NullReferenceException）`);
  // prefab 資產上的物件（{guid, fileID}）：換成休眠物件樹上的 H
  return liveObj(v) as T;
}

// ───────── prefab 資產上的物件（場景外的 GameObject／元件：{ guid, fileID }） ─────────
// 遊戲讀 prefab 欄位的 .gameObject、.transform、GetComponent<T>()（例如 Instantiate 之前先看 prefab 上的設定）：
// 回傳同一個 prefab 檔裡對應物件的參照，Instantiate、name、== 都認得它。

type AssetObj = { guid: string; fileID: string | number };
function isAssetObj(x: unknown): x is AssetObj {
  return !!x && typeof x === 'object' && !(x instanceof H) && typeof (x as AssetObj).guid === 'string' && 'fileID' in (x as object) && !('$type' in (x as object));
}
function prefabOf(a: AssetObj): SceneFile {
  const store = getObjectStore();
  if (!store?.isPrefab(a.guid)) throw new Error(`資產 ${a.guid} 不是 prefab（還沒做其他資產的 GameObject）`);
  return store.prefabFile(a.guid);
}
function assetGoId(a: AssetObj): string {
  const f = prefabOf(a);
  const id = String(a.fileID);
  return f.gameObjects[id] ? id : (f.components[id]?.gameObject ?? f.roots[0]);
}
function assetGameObject(a: AssetObj): AssetObj {
  return { guid: a.guid, fileID: assetGoId(a) };
}
function assetTransform(a: AssetObj): AssetObj {
  const f = prefabOf(a);
  return { guid: a.guid, fileID: f.gameObjects[assetGoId(a)].transform };
}
function assetGetComponent(world: World, a: AssetObj, type: string): AssetObj | null {
  const f = prefabOf(a);
  const go = f.gameObjects[assetGoId(a)];
  for (const id of go.components) {
    const comp = f.components[id];
    if (compIsType(world, comp, type)) return { guid: a.guid, fileID: id };
  }
  return null;
}

// prefab 資產本身當物件用（GetComponentInChildren、讀元件屬性、叫腳本方法）：照 Unity，prefab 資產是一棵載入記憶體、
// 不在任何場景裡的物件樹。每個 World 每個 prefab 建一份休眠的物件樹（unity/prefab.ts 的 materializePrefabAsset：
// 不 Awake、不排版、不畫、Find 找不到），記下 prefab 檔 id ↔ 休眠樹 id。core 的 liveObj 把 {guid, fileID} 換成樹上的 H，
// prefabAssetRef 反過來（objEq 用：樹上的 H 跟同一個物件的參照相等）。
interface DormantPrefab {
  guid: string;
  ids: Map<string, string>;
  back: Map<string, string>;
}
const dormantByWorld = new WeakMap<World, Map<string, DormantPrefab>>();
const dormantOfNode = new WeakMap<SceneNode, DormantPrefab>();
function dormantPrefab(world: World, guid: string): DormantPrefab {
  let byGuid = dormantByWorld.get(world);
  if (!byGuid) dormantByWorld.set(world, (byGuid = new Map()));
  let d = byGuid.get(guid);
  if (!d) {
    const { root, ids } = materializePrefabAsset(world, prefabOf({ guid, fileID: 0 }));
    d = { guid, ids, back: new Map([...ids].map(([a, b]) => [b, a])) };
    for (const n of subtree(root)) dormantOfNode.set(n, d);
    byGuid.set(guid, d);
  }
  return d;
}
setPrefabAssetHooks(
  (x) => {
    const a = x as AssetObj;
    const world = getActiveWorld();
    if (!world || !getObjectStore()?.isPrefab(a.guid)) return null;
    const d = dormantPrefab(world, a.guid);
    const id = d.ids.get(String(a.fileID)) ?? d.ids.get(prefabOf(a).roots[0])!;
    const comp = world.graph.file.components[id];
    if (comp) {
      const node = world.graph.nodeById(comp.gameObject)!;
      return comp.type === 'Transform' || comp.type === 'RectTransform' ? transformOf(node) : compHandle(world, comp);
    }
    return gameObjectOf(world.graph.nodeById(id)!);
  },
  (h) => {
    const d = dormantOfNode.get(h.node);
    if (!d) return null;
    const world = getActiveWorld();
    let id: string | undefined = h.kind === 'go' ? h.node.id : h.kind === 'transform' ? h.node.go.transform : undefined;
    if (h.kind === 'comp' && world) id = h.node.go.components.find((cid) => world.graph.file.components[cid] === h.comp);
    const src = id ? d.back.get(id) : undefined;
    return src ? { guid: d.guid, fileID: src } : null;
  },
);

// x is T／x as T：prefab 裡的物件照它在 prefab 檔的種類與元件型別；其他資產照 fileID 的類別編號（Unity 的 本地 ID = classID × 100000）
const ASSET_CLASS_IDS: Record<number, string[]> = {
  213: ['Sprite'],
  28: ['Texture2D', 'Texture'],
  21: ['Material'],
  49: ['TextAsset'],
  83: ['AudioClip'],
  48: ['Shader'],
  128: ['Font'],
  74: ['AnimationClip', 'Motion'],
  91: ['RuntimeAnimatorController', 'AnimatorController'],
  114: ['ScriptableObject', 'MonoBehaviour'],
};
setAssetTypeCheck((x, type) => {
  if (!isAssetObj(x)) return null;
  if (type === 'Object') return true;
  const store = getObjectStore();
  if (store?.isPrefab(x.guid)) {
    const f = store.prefabFile(x.guid);
    const id = String(x.fileID);
    if (f.gameObjects[id]) return type === 'GameObject';
    const comp = f.components[id];
    if (!comp) return false;
    if (type === 'Component') return true;
    if (Object.values(f.gameObjects).some((g) => g.transform === id)) return type === 'Transform' || (type === 'RectTransform' && comp.type === 'RectTransform');
    if (type === 'MonoBehaviour' || type === 'Behaviour') return !!comp.script || type === 'Behaviour';
    const world = getActiveWorld();
    return world ? compIsType(world, comp, type) : comp.type === type;
  }
  const n = Number(x.fileID);
  return Number.isInteger(n) && n % 100000 < 1000 ? (ASSET_CLASS_IDS[Math.floor(n / 100000)]?.includes(type) ?? null) : null;
});

// ───────── 元件、GameObject、Transform ─────────

export function Component_get_gameObject(c: Ctx, h: H): H | AssetObj {
  void c;
  if (isAssetObj(h)) return assetGameObject(h);
  return gameObjectOf(need(h, 'Component.gameObject').node);
}
export function Component_get_transform(c: Ctx, h: H): H | AssetObj {
  void c;
  if (isAssetObj(h)) return assetTransform(h);
  return transformOf(need(h, 'Component.transform').node);
}
export function GameObject_get_transform(c: Ctx, go: H): H | AssetObj {
  void c;
  if (isAssetObj(go)) return assetTransform(go);
  return transformOf(need(go, 'GameObject.transform').node);
}
/** GameObject.SetActive：狀態一樣就不動（Unity 也是），變了才切、跑 OnEnable／OnDisable */
export function GameObject_SetActive(c: Ctx, go: H | null, on: boolean): void {
  need(go, 'GameObject.SetActive');
  if ((go!.node.go.m_IsActive === 1) === on) return;
  w(c).graph.setActive(go!.node, on);
  w(c).refreshEnables(go!.node);
}
export function GameObject_get_activeInHierarchy(c: Ctx, go: H): boolean {
  void c;
  return need(go, 'GameObject.activeInHierarchy').node.activeInHierarchy;
}
export function Behaviour_get_enabled(c: Ctx, h: H): boolean {
  void c;
  return need(h, 'Behaviour.enabled').comp?.m_Enabled !== 0;
}
export function Behaviour_set_enabled(c: Ctx, h: H, on: boolean): void {
  need(h, 'Behaviour.enabled');
  if (!h.comp || (h.comp.m_Enabled !== 0) === on) return;
  h.comp.m_Enabled = on ? 1 : 0;
  const wc = w(c);
  // m_Enabled 變了：refreshEnables 的「整段跳過」要失效（見 SceneGraph.enabledVersion）
  if (wc.graph) wc.graph.enabledVersion++;
  wc.refreshEnables(h.comp);
  if (h.comp.type === 'CanvasGroup') canvasGroupChanged(w(c), h.node);
}

/**
 * CanvasGroup 改了 interactable／ignoreParentGroups 或元件開關：Unity 對這個物件與底下的 UIBehaviour 發 OnCanvasGroupChanged
 *（UnityEngine.UI Selectable.OnCanvasGroupChanged 照它重算 m_GroupsAllowInteraction；MT2 的腳本沒有覆寫）。只發給啟用中的。
 * alpha、blocksRaycasts 改的時候 Unity 也發，但聽的人（Selectable）不看這兩個，這裡不發（差異清單）
 */
function canvasGroupChanged(world: World, node: SceneNode): void {
  const ids = subtree(node).filter((n) => n.activeInHierarchy).map((n) => n.id);
  for (const [comp, b] of world.behaviours.entriesOn(ids)) {
    if (comp.m_Enabled === 0) continue;
    const fn = (b as unknown as Record<string, unknown>).OnCanvasGroupChanged;
    if (typeof fn === 'function') world.guard(`${comp.script?.class ?? comp.type}.OnCanvasGroupChanged`, () => void fn());
  }
}
for (const [prop, field] of [
  ['interactable', 'm_Interactable'],
  ['ignoreParentGroups', 'm_IgnoreParentGroups'],
] as const) {
  registerNativeProp('CanvasGroup', prop, {
    get: (_c, h) => !!(h.comp?.[field] ?? (prop === 'interactable' ? 1 : 0)),
    set: (c, h, v) => {
      const next = v ? 1 : 0;
      if (!h.comp || (h.comp[field] ?? (prop === 'interactable' ? 1 : 0)) === next) return;
      h.comp[field] = next;
      if (h.node.activeInHierarchy && h.comp.m_Enabled !== 0) canvasGroupChanged(w(c), h.node);
    },
  });
}
/** Behaviour.isActiveAndEnabled（UIBehaviour.IsActive 也是這個） */
export function Behaviour_get_isActiveAndEnabled(c: Ctx, h: H): boolean {
  void c;
  need(h, 'Behaviour.isActiveAndEnabled');
  return h.node.activeInHierarchy && h.comp?.m_Enabled !== 0;
}

/** 元件符合型別名：元件型別、MonoBehaviour 類別、或它的基底鏈與介面（World 的 hierarchy；TMP_Text 等基底類別） */
function compMatches(world: World, comp: ComponentData, type: string): boolean {
  return compIsType(world, comp, type);
}
function compsOn(world: World, node: SceneNode, type: string): ComponentData[] {
  return world.graph.components(node).filter((comp) => compMatches(world, comp, type));
}
function handleFor(world: World, node: SceneNode, comp: ComponentData): H {
  return comp.type === 'Transform' || comp.type === 'RectTransform' ? transformOf(node) : compHandle(world, comp);
}
/** GetComponent<T>()（轉換器把 T 的名字接在最後） */
export function Component_GetComponent$(c: Ctx, h: H, type: string): H | AssetObj | null {
  if (isAssetObj(h)) return assetGetComponent(w(c), h, type);
  const node = need(h, 'GetComponent').node;
  if (type === 'Transform' || type === 'RectTransform') return transformOf(node);
  const comp = compsOn(w(c), node, type)[0];
  return comp ? handleFor(w(c), node, comp) : null;
}
export const GameObject_GetComponent$ = Component_GetComponent$;
/** GetComponentInParent<T>()：自己與往上的父節點，第一個符合的元件 */
export function Component_GetComponentInParent$(c: Ctx, h: H, type: string): H | null {
  for (let n: SceneNode | null = need(h, 'GetComponentInParent').node; n; n = n.parent) {
    const comp = compsOn(w(c), n, type)[0];
    if (comp) return handleFor(w(c), n, comp);
  }
  return null;
}
/** 自己與子孫（深度優先）；includeInactive false 跳過「從自己往下」關著的子物件（自己或上層關著時照樣找） */
function visitChildren(root: SceneNode, includeInactive: boolean, fn: (n: SceneNode) => boolean | void): void {
  const visit = (n: SceneNode): boolean => {
    if (n !== root && !includeInactive && !n.go.m_IsActive) return false;
    if (fn(n)) return true;
    for (const ch of n.children) if (visit(ch)) return true;
    return false;
  };
  visit(root);
}
export function Component_GetComponentInChildren$(c: Ctx, h: H, type: string): H | null {
  let out: H | null = null;
  visitChildren(need(h, 'GetComponentInChildren').node, false, (n) => {
    const comp = compsOn(w(c), n, type)[0];
    if (comp) out = handleFor(w(c), n, comp);
    return !!comp;
  });
  return out;
}
export function Component_GetComponentInChildren$bool(c: Ctx, h: H, includeInactive: boolean, type: string): H | null {
  let out: H | null = null;
  visitChildren(need(h, 'GetComponentInChildren').node, includeInactive, (n) => {
    const comp = compsOn(w(c), n, type)[0];
    if (comp) out = handleFor(w(c), n, comp);
    return !!comp;
  });
  return out;
}
export function Component_GetComponentsInChildren$(c: Ctx, h: H, type: string): H[] {
  const out: H[] = [];
  visitChildren(need(h, 'GetComponentsInChildren').node, false, (n) => void out.push(...compsOn(w(c), n, type).map((comp) => handleFor(w(c), n, comp))));
  return out;
}
export function Component_GetComponentsInChildren$bool(c: Ctx, h: H, includeInactive: boolean, type: string): H[] {
  const out: H[] = [];
  visitChildren(need(h, 'GetComponentsInChildren').node, includeInactive, (n) => void out.push(...compsOn(w(c), n, type).map((comp) => handleFor(w(c), n, comp))));
  return out;
}
/** GetComponents<T>(List<T> results)：清單先清空再放 */
export function Component_GetComponents$List(c: Ctx, h: H, results: H[], type: string): void {
  const node = need(h, 'GetComponents').node;
  results.length = 0;
  for (const comp of compsOn(w(c), node, type)) results.push(handleFor(w(c), node, comp));
}

export function Transform_get_parent(c: Ctx, t: H): H | null {
  void c;
  const p = need(t, 'Transform.parent').node.parent;
  return p ? transformOf(p) : null;
}
function worldMatrix(n: SceneNode): Matrix4 {
  return n.world as unknown as Matrix4;
}
/** Transform.TransformPoint：本地點 → 世界 */
export function Transform_TransformPoint$Vector3(c: Ctx, t: H, p: V3): V3 {
  const node = need(t, 'Transform.TransformPoint').node;
  w(c).refreshTransform(node);
  const r = new Vector3(p.x, p.y, p.z).applyMatrix4(worldMatrix(node));
  return { x: r.x, y: r.y, z: r.z };
}
/** RectTransform.rect（本地空間的矩形；沿父物件鏈算，World.refreshTransform） */
export function RectTransform_get_rect(c: Ctx, t: H): RectV {
  const node = need(t, 'RectTransform.rect').node;
  w(c).refreshTransform(node);
  const r = node.rect;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

// ───────── Animator ─────────

function animatorOf(world: World, h: H) {
  return world.animators.find((a) => a.component === h.comp) ?? null;
}
export function Animator_SetTrigger$string(c: Ctx, h: H, name: string): void {
  animatorOf(w(c), need(h, 'Animator.SetTrigger'))?.setTrigger(name);
}
export function Animator_ResetTrigger$string(c: Ctx, h: H, name: string): void {
  animatorOf(w(c), need(h, 'Animator.ResetTrigger'))?.resetTrigger(name);
}
export function Animator_SetBool$string_bool(c: Ctx, h: H, name: string, v: boolean): void {
  animatorOf(w(c), need(h, 'Animator.SetBool'))?.setBool(name, v);
}
/** Animator.runtimeAnimatorController：controller 資產的參照（{guid, fileID}），沒有是 null；set 換掉 controller、從預設狀態重新開始 */
registerNativeProp('Animator', 'runtimeAnimatorController', {
  get: (_c, h) => (h.comp?.m_Controller as { guid?: string } | null)?.guid ? h.comp!.m_Controller : null,
  set: (c, h, v) => {
    const ref = v && typeof v === 'object' && typeof (v as { guid?: unknown }).guid === 'string' ? (v as { guid: string; fileID: string }) : null;
    if (v != null && !ref) throw new Error('Animator.runtimeAnimatorController：只認得資產參照（{guid, fileID}）');
    w(c).setAnimatorController(h.node, need(h, 'Animator.runtimeAnimatorController').comp!, ref);
  },
});
/** Animator.hasBoundPlayables：有 controller 才有（Selectable.TriggerAnimation 檢查它） */
export function Animator_get_hasBoundPlayables(c: Ctx, h: H): boolean {
  const a = animatorOf(w(c), need(h, 'Animator.hasBoundPlayables'));
  return !!a && a.node.activeInHierarchy && h.comp?.m_Enabled !== 0;
}

// ───────── uGUI 用到的原生部分 ─────────

/**
 * Graphic.canvasRenderer（反編譯的 UnityEngine.UI Graphic.cs:172）：GetComponent<CanvasRenderer>()，沒有就 AddComponent<CanvasRenderer>()。
 * Unity 把結果記在 m_CanvasRenderer，這裡每次重找：同一個物件上找到的是同一個元件；CanvasRenderer 被刪掉之後 Unity 回的是記著的那個，這裡會再加一個
 */
registerNativeProp('Graphic', 'canvasRenderer', {
  get: (c: Ctx, h: H) => Component_GetComponent$(c, h, 'CanvasRenderer') ?? GameObject_AddComponent$(c, h, 'CanvasRenderer'),
});

/** Graphic.CrossFadeColor（Graphic.cs：CanvasRenderer 顏色漸變；實作在 ui/selectable.ts，跟手寫的 Selectable 共用） */
export function Graphic_CrossFadeColor$Color_float_bool_bool(c: Ctx, g: H | null, target: ColorRGBA, duration: number, ignoreTimeScale: boolean, useAlpha: boolean): void {
  if (!g?.comp) return;
  crossFadeColor(w(c), g.comp, g.node, target, duration, useAlpha, true, ignoreTimeScale);
}
/** Image.sprite／overrideSprite：寫進元件欄位（sprite 是外部素材參照 {guid, fileID}），繪製端照欄位重產 */
export function Image_set_sprite(c: Ctx, img: H, sprite: unknown): void {
  void c;
  need(img, 'Image.sprite').comp!.m_Sprite = sprite ?? null;
}
export function Image_set_overrideSprite(c: Ctx, img: H, sprite: unknown): void {
  void c;
  need(img, 'Image.overrideSprite').comp!.m_OverrideSprite = sprite ?? null;
}
/** TMP_Text.alpha：字色的 alpha */
export function TMP_Text_set_alpha(c: Ctx, t: H, a: number): void {
  void c;
  const comp = need(t, 'TMP_Text.alpha').comp!;
  comp.m_fontColor = { ...(comp.m_fontColor as ColorRGBA), a };
}
export function CanvasGroup_get_interactable(c: Ctx, h: H): boolean {
  void c;
  return need(h, 'CanvasGroup.interactable').comp?.m_Interactable !== 0;
}
export function CanvasGroup_get_ignoreParentGroups(c: Ctx, h: H): boolean {
  void c;
  return !!need(h, 'CanvasGroup.ignoreParentGroups').comp?.m_IgnoreParentGroups;
}
export function UISystemProfilerApi_AddMarker(c: Ctx, ...a: unknown[]): void {
  void c;
  void a;
}

// ───────── EventSystem ─────────
// EventSystem 的狀態在執行環境（engine/events.ts，指標與選取由它驅動）；這裡把 C# 的介面接上去。

export function EventSystem_get_current(c: Ctx): object {
  return w(c).events;
}
export function EventSystem_get_currentSelectedGameObject(c: Ctx, es: { currentSelected: SceneNode | null }): H | null {
  void c;
  return es.currentSelected ? gameObjectOf(es.currentSelected) : null;
}
export function EventSystem_get_alreadySelecting(c: Ctx, es: object): boolean {
  void c;
  return !!(es as { selecting?: boolean }).selecting;
}
export function EventSystem_SetSelectedGameObject$GameObject(c: Ctx, es: { setSelected(n: SceneNode | null, data?: unknown): void }, go: H | null): void {
  void c;
  es.setSelected(go?.node ?? null);
}
/** SetSelectedGameObject(go, eventData)：事件資料傳給 OnDeselect／OnSelect（Selectable.OnPointerDown 傳 PointerEventData） */
export function EventSystem_SetSelectedGameObject$GameObject_BaseEventData(c: Ctx, es: { setSelected(n: SceneNode | null, data?: unknown): void }, go: H | null, data: unknown): void {
  void c;
  es.setSelected(go?.node ?? null, data);
}
/** PointerEventData.button：InputButton 是 Left 0、Right 1、Middle 2；事件系統送的是 DOM 的編號（0 左、1 中、2 右） */
export function PointerEventData_get_button(c: Ctx, ev: { button: number }): number {
  void c;
  return ev.button === 2 ? 1 : ev.button === 1 ? 2 : ev.button;
}
export function PointerEventData_get_eligibleForClick(c: Ctx, ev: { eligibleForClick: boolean }): boolean {
  void c;
  return ev.eligibleForClick;
}
export function PointerEventData_set_eligibleForClick(c: Ctx, ev: { eligibleForClick: boolean }, v: boolean): void {
  void c;
  ev.eligibleForClick = v;
}
export function BaseEventData_set_selectedObject(c: Ctx, ev: object, go: H | null): void {
  void c;
  (ev as { selectedObject?: H | null }).selectedObject = go;
}
export function AxisEventData_get_moveDir(c: Ctx, ev: { moveDir?: number }): number {
  void c;
  return ev.moveDir ?? 4; // MoveDirection.None
}

// ───────── UnityEvent ─────────


/**
 * UnityEvent.Invoke：序列化的持久呼叫（m_PersistentCalls.m_Calls；m_Target 已經解析成 H）照目標的 behaviour 方法名呼叫，
 * 再叫執行期的監聽（AddListener）。目標或方法不存在時 Unity 不呼叫，這裡記一筆 note。
 */
export function UnityEvent_Invoke(c: Ctx, ev: { m_PersistentCalls?: { m_Calls?: { m_Target: unknown; m_MethodName: string; m_Mode: number }[] } } | null, ...args: unknown[]): void {
  for (const call of ev?.m_PersistentCalls?.m_Calls ?? []) {
    // 目標：解析過的 H，或原生元件存檔裡那份事件物件的 {fileID}
    const rawTarget = call.m_Target as { fileID?: string | number } | null;
    const target = call.m_Target instanceof H ? call.m_Target : rawTarget?.fileID != null ? refHandle(w(c), String(rawTarget.fileID)) : null;
    const behaviour = target?.comp ? w(c).behaviours.get(target.comp) : undefined;
    const fn = behaviour ? (behaviour as unknown as Record<string, unknown>)[call.m_MethodName] : undefined;
    if (typeof fn !== 'function') {
      w(c).notes.add(`UnityEvent → ${call.m_MethodName}：目標或方法不存在，不呼叫`);
      continue;
    }
    if (call.m_Mode === 1) (fn as () => void).call(behaviour);
    else (fn as (...a: unknown[]) => void).call(behaviour, ...args);
  }
  for (const f of [...(ev ? runtimeListenersOf(ev) : [])]) invokeDelegate(c, f, ...args);
}
type PersistentCalls = { m_PersistentCalls?: { m_Calls?: { m_Target: unknown; m_MethodName: string; m_CallState?: number }[] } } | null;
/** UnityEventBase.GetPersistentEventCount 等：Inspector 設定的持久呼叫（存檔的 m_PersistentCalls） */
export const UnityEventBase_GetPersistentEventCount = (_c: Ctx, ev: PersistentCalls): number => ev?.m_PersistentCalls?.m_Calls?.length ?? 0;
export const UnityEventBase_GetPersistentTarget = (_c: Ctx, ev: PersistentCalls, i: number): unknown => ev?.m_PersistentCalls?.m_Calls?.[i]?.m_Target ?? null;
export const UnityEventBase_GetPersistentMethodName = (_c: Ctx, ev: PersistentCalls, i: number): string => ev?.m_PersistentCalls?.m_Calls?.[i]?.m_MethodName ?? '';
export function UnityEventBase_RemoveAllListeners(c: Ctx, ev: object): void {
  void c;
  clearRuntimeListeners(ev);
}
export const UnityEvent_RemoveAllListeners = UnityEventBase_RemoveAllListeners;
export function UnityEvent_AddListener(c: Ctx, ev: object, f: (...a: any[]) => any): void {
  void c;
  runtimeListenersOf(ev).push(f);
}
export function UnityEvent_RemoveListener(c: Ctx, ev: object, f: (...a: any[]) => any): void {
  void c;
  const list = runtimeListenersOf(ev);
  const i = list.lastIndexOf(f);
  if (i >= 0) list.splice(i, 1);
}

// ───────── 協程 ─────────

type GenIter = Iterator<unknown>;
function isIter(v: unknown): v is GenIter {
  return !!v && typeof (v as GenIter).next === 'function';
}
/** new WaitForSeconds(s) */
export class WaitSeconds {
  constructor(readonly seconds: number) {}
}
export function new_WaitForSeconds(c: Ctx, s: number): WaitSeconds {
  void c;
  return new WaitSeconds(s);
}
/** WaitUntil／WaitWhile／WaitForSecondsRealtime：條件成立才繼續 */
export class WaitUntilJs {
  constructor(readonly until: () => boolean) {}
}
export function new_WaitUntil(c: Ctx, pred: () => boolean): WaitUntilJs {
  void c;
  return new WaitUntilJs(() => !!invokeDelegate(c, pred));
}
export function new_WaitWhile(c: Ctx, pred: () => boolean): WaitUntilJs {
  void c;
  return new WaitUntilJs(() => !invokeDelegate(c, pred));
}
/** WaitForSecondsRealtime：照實際時間（不受 timeScale 影響） */
export function new_WaitForSecondsRealtime(c: Ctx, s: number): WaitUntilJs {
  void c;
  const end = performance.now() + s * 1000;
  return new WaitUntilJs(() => performance.now() >= end);
}
/** WaitForEndOfFrame、WaitForFixedUpdate：這裡的協程在 Update 之後推進，下一格繼續（近似） */
export function new_WaitForEndOfFrame(c: Ctx): null {
  void c;
  return null;
}
export function new_WaitForFixedUpdate(c: Ctx): null {
  void c;
  return null;
}
/** 產生的 CustomYieldInstruction 子類別：有 get_keepWaiting */
function hasCustomYield(o: object): boolean {
  const t = (o as { $type?: string }).$type;
  return !!t && hasGen(t) && !!genMethodOf(t, 'get_keepWaiting');
}
function keepWaiting(world: World, o: object): boolean {
  return !!genCallVirtual(world, (o as { $type: string }).$type, o, 'get_keepWaiting');
}

/**
 * CustomYieldInstruction.keepWaiting（DLL 的抽象屬性，產生碼讀它走 nativeGet）：WaitUntil／WaitWhile 照條件；
 * 產生的子類別（ShinyShoe 的 ManualCoroutine.WaitForSeconds）照它的覆寫
 */
registerNativeDataProp('CustomYieldInstruction', 'keepWaiting', {
  get: (_c, o) => {
    if (o instanceof WaitUntilJs) return !o.until();
    if (hasCustomYield(o)) return keepWaiting(getActiveWorld()!, o);
    throw new Error(`CustomYieldInstruction.keepWaiting：${String((o as { $type?: unknown }).$type ?? o)} 沒有覆寫`);
  },
});

/** MonoBehaviour.StartCoroutine 的協程：每格在 Update 之後推進（World.coroutines），擁有者關掉或銷毀就停 */
export class GenCoroutine {
  private readonly stack: GenIter[];
  private wait = 0;
  private waitFor: GenCoroutine | null = null;
  /** 等到這個條件成立（AsyncOperation.isDone、WaitUntil、WaitWhile、CustomYieldInstruction.keepWaiting） */
  private waitUntil: (() => boolean) | null = null;
  done = false;
  /** 剛開始的那一格不推進（yield return null 在下一格才繼續） */
  private fresh = true;
  constructor(
    private readonly world: World,
    readonly owner: H | null,
    gen: GenIter,
  ) {
    this.stack = [gen];
    this.root = gen;
  }
  private readonly root: GenIter;
  /** 跑到需要等待的 yield；整個結束回 false */
  advance(): boolean {
    for (let guard = 0; guard < 100000; guard++) {
      const top = this.stack[this.stack.length - 1];
      if (!top) {
        this.done = true;
        return false;
      }
      const r = top.next();
      if (r.done) {
        this.stack.pop();
        if (this.stack.length === 0) {
          this.done = true;
          return false;
        }
        continue;
      }
      const v = r.value;
      if (isIter(v)) {
        this.stack.push(v);
        continue;
      }
      if (v instanceof WaitSeconds) {
        this.wait = v.seconds;
        return true;
      }
      if (v instanceof GenCoroutine) {
        if (v.done) continue;
        this.waitFor = v;
        return true;
      }
      if (v instanceof WaitUntilJs) {
        this.waitUntil = v.until;
        return true;
      }
      // AsyncOperation（LoadSceneAsync…）與 Addressables 的 handle：等 isDone
      if (v && typeof v === 'object' && 'isDone' in v) {
        const op = v as { isDone: boolean };
        if (op.isDone) return true; // 已經完成的：Unity 也要等到下一格
        this.waitUntil = () => op.isDone;
        return true;
      }
      // CustomYieldInstruction：keepWaiting 是產生的屬性（get_keepWaiting）
      if (v && typeof v === 'object' && '$type' in v && hasCustomYield(v as object)) {
        const y = v as object;
        this.waitUntil = () => !keepWaiting(this.world, y);
        return true;
      }
      return true; // null 與其他值：下一格
    }
    throw new Error('協程推進超過 100000 次沒有 yield');
  }
  private ownerAlive(): boolean {
    if (!this.owner) return true;
    const n = this.owner.node;
    return this.world.graph.nodes.has(n.id) && n.activeInHierarchy;
  }
  step(dt: number): boolean {
    if (this.done) return false;
    if (!this.ownerAlive()) {
      this.done = true;
      return false;
    }
    if (this.fresh) {
      this.fresh = false;
      return true;
    }
    if (this.wait > 0) {
      this.wait -= dt;
      if (this.wait > 0) return true;
      this.wait = 0;
    }
    if (this.waitFor) {
      if (!this.waitFor.done) return true;
      this.waitFor = null;
    }
    if (this.waitUntil) {
      if (!this.waitUntil()) return true;
      this.waitUntil = null;
    }
    return this.advance();
  }
  stop(): void {
    this.done = true;
  }
  /** 這個協程是不是從這個列舉器開始的 */
  startedWith(gen: unknown): boolean {
    return this.root === gen;
  }
}
const ownerCoroutines = new WeakMap<H, Set<GenCoroutine>>();
/**
 * MonoBehaviour.StartCoroutine：當下先跑到第一個 yield。沒碰到 yield 就跑完時回 null（Unity 文件 MonoBehaviour.StartCoroutine 明寫）：
 * ShinyShoe 的 CoroutineController 靠這個判斷 IsRunning（Run() 同步跑完時 Stop() 先把 _coroutine 清掉，再被 StartCoroutine 的回傳值蓋回去）。
 * 以前回協程物件，角色的 IsMovementDone 一直是 false，新手戰鬥的第一回合停在 RoomUI.CenterCharacters
 */
export function MonoBehaviour_StartCoroutine$IEnumerator(c: Ctx, owner: H | null, gen: unknown): GenCoroutine | null {
  if (!isIter(gen)) return null; // yield break 的空協程
  const co = new GenCoroutine(w(c), owner, gen);
  if (!co.advance()) return null;
  w(c).coroutines.add(co);
  if (owner) {
    let set = ownerCoroutines.get(owner);
    if (!set) ownerCoroutines.set(owner, (set = new Set()));
    set.add(co);
  }
  return co;
}
export function MonoBehaviour_StopCoroutine$Coroutine(c: Ctx, owner: H | null, co: GenCoroutine | null): void {
  void c;
  if (!co) return;
  co.stop();
  if (owner) ownerCoroutines.get(owner)?.delete(co);
}
/** StopCoroutine(IEnumerator)：停掉這個擁有者從這個列舉器開始的協程（StartCoroutine 給的同一個產生器） */
export function MonoBehaviour_StopCoroutine$IEnumerator(c: Ctx, owner: H | null, gen: unknown): void {
  void c;
  if (!owner || gen == null) return;
  const set = ownerCoroutines.get(owner);
  for (const co of [...(set ?? [])]) {
    if (!co.startedWith(gen)) continue;
    co.stop();
    set!.delete(co);
  }
}
export function MonoBehaviour_StopAllCoroutines(c: Ctx, owner: H | null): void {
  void c;
  if (!owner) return;
  for (const co of ownerCoroutines.get(owner) ?? []) co.stop();
  ownerCoroutines.get(owner)?.clear();
}

// ───────── DOTween（原生部分：補間的生命週期在執行環境的 Tweens） ─────────

/** transform.DOKill()：這個目標上的補間全部停 */
export function ShortcutExtensions_DOKill$Component_bool(c: Ctx, t: H, complete = false): number {
  w(c).tweens.kill(t, complete);
  return 0;
}

// ───────── UnityEngine.Random ─────────
// Unity 原生（沒有 C# 原始碼）：Xorshift128。2026/10/15 在 mt2-web 對 Unity 2022.3.62f2 跑原版 MT2 HadesRNG／RandomManager 的標準答案
// （mt2-web 的 tools/unity-ref.sh、public/ref/rng-unity.json）驗證過：InitState、Range(int) 含 min > max 與 int.MaxValue、Range(float) 的位元、state 的四個欄位，269/269 相同。

interface RandomState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}
let unityRandom: RandomState = { s0: 0, s1: 0, s2: 0, s3: 0 };

function initState(seed: number): RandomState {
  const s0 = seed >>> 0;
  const s1 = (Math.imul(s0, 1812433253) + 1) >>> 0;
  const s2 = (Math.imul(s1, 1812433253) + 1) >>> 0;
  const s3 = (Math.imul(s2, 1812433253) + 1) >>> 0;
  return { s0, s1, s2, s3 };
}
function nextU32(): number {
  const st = unityRandom;
  let t = st.s0;
  t = (t ^ (t << 11)) >>> 0;
  t = (t ^ (t >>> 8)) >>> 0;
  st.s0 = st.s1;
  st.s1 = st.s2;
  st.s2 = st.s3;
  st.s3 = (st.s3 ^ (st.s3 >>> 19) ^ t) >>> 0;
  return st.s3;
}
/** Random.value 的 [0, 1]：低 23 位元除以 2^23 − 1 */
function next01(): number {
  return Math.fround((nextU32() & 0x7fffff) / 8388607);
}

export function Random_InitState(c: Ctx, seed: number): void {
  void c;
  unityRandom = initState(seed);
}
/** Random.state 是結構：讀出來是複本；HadesRNG 的 _state 一開始是 default（全 0） */
export function Random_get_state(c: Ctx): RandomState {
  void c;
  return { ...unityRandom };
}
export function Random_set_state(c: Ctx, s: RandomState | null): void {
  void c;
  unityRandom = s ? { s0: s.s0 >>> 0, s1: s.s1 >>> 0, s2: s.s2 >>> 0, s3: s.s3 >>> 0 } : { s0: 0, s1: 0, s2: 0, s3: 0 };
}
/** Random.Range(int min, int max)：上界不含；min > max 時往下 */
export function Random_Range$int_int(c: Ctx, min: number, max: number): number {
  void c;
  if (min < max) return min + ((nextU32() % ((max - min) >>> 0)) | 0);
  if (min > max) return min - ((nextU32() % ((min - max) >>> 0)) | 0);
  return min;
}
/** Random.value：[0, 1]，兩端都含（Unity 手冊；跟 Range(float) 共用同一個亂數序列） */
export function Random_get_value(c: Ctx): number {
  void c;
  return next01();
}
/** Random.Range(float min, float max)：兩端都含 */
export function Random_Range$float_float(c: Ctx, min: number, max: number): number {
  void c;
  const t = next01();
  return Math.fround(Math.fround(t * min) + Math.fround(Math.fround(1 - t) * max));
}

// ───────── Time ─────────

export function Time_get_frameCount(c: Ctx): number {
  return w(c).frameCount;
}
/** Time.time／deltaTime 乘過 timeScale；unscaledTime／unscaledDeltaTime 沒有（World.tick） */
export function Time_get_time(c: Ctx): number {
  return w(c).time;
}
export function Time_get_unscaledTime(c: Ctx): number {
  return w(c).unscaledTime;
}
export function Time_get_deltaTime(c: Ctx): number {
  return w(c).deltaTime;
}
export function Time_get_unscaledDeltaTime(c: Ctx): number {
  return w(c).unscaledDeltaTime;
}

// ───────── 值型別：Mathf、Vector2、Vector3、Quaternion、Color、Rect ─────────






/** 元件的第一個同型元件（遊戲專案的橋接用） */
export function firstComponent(world: World, node: SceneNode, type: string): H | null {
  const comp = componentOn(world, node, type);
  return comp ? compHandle(world, comp) : null;
}

// ───────── 補充：Screen、Rect、LayerMask、Vector2、Mathf ─────────

/** Screen.width／height：繪圖緩衝的像素（World.screen） */
export function Screen_get_width(c: Ctx): number {
  return w(c).screen.w;
}
export function Screen_get_height(c: Ctx): number {
  return w(c).screen.h;
}
/** LayerMask.NameToLayer／LayerToName／GetMask：圖層名稱照 ProjectSettings 的 TagManager（WorldServices.layerNames） */
export function LayerMask_NameToLayer(c: Ctx, name: string): number {
  return name ? (w(c).services.layerNames ?? []).indexOf(name) : -1;
}
export const LayerMask_LayerToName = (c: Ctx, i: number): string => (w(c).services.layerNames ?? [])[i] ?? '';
export function LayerMask_GetMask(c: Ctx, names: string[]): number {
  let m = 0;
  for (const n of names ?? []) {
    const i = LayerMask_NameToLayer(c, n);
    if (i >= 0) m |= 1 << i;
  }
  return m;
}
/** LayerMask 與 int 之間的隱含轉型：LayerMask 就是位元遮罩 */
export function LayerMask_op_Implicit$int(c: Ctx, v: number): number {
  void c;
  return v | 0;
}
export function LayerMask_op_Implicit$LayerMask(c: Ctx, v: number | { m_Bits?: number }): number {
  void c;
  return typeof v === 'number' ? v : (v?.m_Bits ?? 0);
}
/** PointerEventData.position：事件的螢幕位置（genBehaviour 給的事件資料帶，沒有時用目前的滑鼠位置） */
export function PointerEventData_get_position(c: Ctx, ev: { position?: V2 }): V2 {
  return ev.position ? { ...ev.position } : { x: w(c).mouse.x, y: w(c).mouse.y };
}

// ───────── 遊戲自己做射線（CoreInput 的 EventSystem.RaycastAll） ─────────

/** new PointerEventData(eventSystem)：跟事件系統送的事件資料同一種形狀 */
export function new_PointerEventData(c: Ctx, es: unknown): Record<string, unknown> {
  void es;
  return { $type: 'PointerEventData', $isa: ['PointerEventData', 'BaseEventData', 'AbstractEventData'], button: 0, eligibleForClick: false, used: false, position: { x: w(c).mouse.x, y: w(c).mouse.y } };
}
/**
 * BaseEventData.currentInputModule（反編譯的 UnityEngine.UI BaseEventData.cs:7：m_EventSystem.currentInputModule）。
 * 這裡的事件資料沒有記是哪個 EventSystem：照啟用中的 EventSystem 元件，找同一個物件上啟用的 BaseInputModule
 * （EventSystem.UpdateModules 收的是同物件的模組）。Unity 從裡面挑 ShouldActivateModule 的那個，這裡取第一個啟用的（差異清單）
 */
registerNativeDataProp('BaseEventData', 'currentInputModule', {
  get: (c) => {
    const world = w(c);
    for (const node of world.graph.nodes.values()) {
      if (!node.activeInHierarchy) continue;
      const es = world.graph.component(node, 'EventSystem');
      if (!es || es.m_Enabled === 0) continue;
      const mod = world.graph.components(node).find((x) => x && x.m_Enabled !== 0 && compIsType(world, x, 'BaseInputModule'));
      if (mod) return compHandle(world, mod);
    }
    return null;
  },
});
export function AbstractEventData_Reset(c: Ctx, ev: { used: boolean }): void {
  void c;
  ev.used = false;
}
/** EventSystem.RaycastAll(eventData, results)：照 eventData.position（螢幕像素，原點左下）打全部 Raycaster，結果照 RaycastComparer 排 */
export function EventSystem_RaycastAll(c: Ctx, es: unknown, ev: { position: { x: number; y: number } }, results: unknown[]): void {
  void es;
  const world = w(c);
  results.length = 0;
  const nodes = world.events.raycastAll(ev.position.x, ev.position.y, world.screen.w, world.screen.h);
  nodes.forEach((node, i) => results.push({ $type: 'RaycastResult', gameObject: gameObjectOf(node), module: null, distance: 0, index: i, depth: node.order, sortingLayer: 0, sortingOrder: 0, screenPosition: { ...ev.position }, worldPosition: { x: 0, y: 0, z: 0 }, worldNormal: { x: 0, y: 0, z: 0 } }));
}

/** Camera.main：第一個啟用中、tag 是 MainCamera 的 Camera */
export function Camera_get_main(c: Ctx): H | null {
  const world = w(c);
  const cam = world.graph.mainCamera;
  return cam ? compHandle(world, cam.data) : null;
}

// ───────── UnityEngine.Pool.CollectionPool<TCollection, TItem>（CoreModule 的 Pool/CollectionPool.cs） ─────────
// 轉換器對 DLL 的泛型靜態類別把型別引數接在後面傳（"List$1<UIVertex>"、"UIVertex"），照集合的種類建空的。
// 原版的池子 Release 時 Clear 再放回去、Get 拿回來重用；這裡不重用（交給垃圾回收），Release 照樣 Clear：
// 呼叫端在 Release 之後還拿著舊參照的話讀到的是空的，跟原版一樣
function emptyCollection(c: Ctx, tCollection: string): unknown {
  return /^(Dictionary|SortedDictionary)(\$\d+)?</.test(tCollection ?? '') ? new_Dictionary$(c) : [];
}
function clearCollection(v: unknown): void {
  if (v instanceof Map) v.clear();
  else if (Array.isArray(v)) v.length = 0;
}
/** CollectionPool.Get()（UnityEngine.UI 的 Shadow／Outline.ModifyMesh） */
export const CollectionPool_Get$ = (c: Ctx, tCollection: string, tItem: string): unknown => (void tItem, emptyCollection(c, tCollection));
/** CollectionPool.Get(out value)：回 PooledObject，using 結束時（Dispose）Release */
export function CollectionPool_Get$TCollection(c: Ctx, out: (v: unknown) => void, tCollection: string, tItem: string): { $type: 'PooledObject'; value: unknown } {
  void tItem;
  const value = emptyCollection(c, tCollection);
  out(value);
  return { $type: 'PooledObject', value };
}
export const CollectionPool_Release = (_c: Ctx, v: unknown): void => clearCollection(v);
export const PooledObject_Dispose = (_c: Ctx, p: { value?: unknown } | null): void => clearCollection(p?.value);

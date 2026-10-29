// 執行時期的物件複製與銷毀：Object.Instantiate（一棵子樹）、Object.Destroy、
// GameObject.AddComponent、Transform.SetParent、new GameObject。
// 對應 UnityEngine.Object／UnityEngine.GameObject／UnityEngine.Transform 的上述成員（行為依
// reference/decompiled 與 reference/tmp-src 裡 TMP_Dropdown 的用法；10/6 讀）。
// TMP_Dropdown 的 CreateDropdownList／CreateItem／CreateBlocker／SetupTemplate 全部走這裡；
// 之後卡牌、敵人、道具的執行時期物件也是，所以做成通用的，不寫死給下拉選單。
//
// PPtr 重映射：複製出來的子樹「內部」互相指到的（Item 的 Toggle.m_Graphic 指 Item Checkmark 的 Image、
// DropdownItem 指 Item Label 的 TMP）要改成指向複製出來的那一份；指向子樹外的（外部素材 {guid,fileID}、
// 場景裡別的元件）保持原樣。Unity 的 Instantiate 就是這個行為。
//
// Awake／OnEnable／Start 的順序照 World.awakeBatch：全部建好 → 物件一個一個 Awake、緊接 OnEnable（沒啟用的物件 Awake 延到第一次啟用）。
// Unity 的 Instantiate 對 active 物件立刻跑 Awake 與 OnEnable，Start 等到第一次 Update 之前（World.flushStarts）。

import type { Behaviour, World } from '../engine/world';
import { sceneTagOf, type SceneNode } from './scene';
import type { ComponentData, GameObjectData, TransformData } from './types';

/**
 * 執行時期新增／移除節點時要通知誰。World 沒有 renderer 的參照（架構上沒有這條依賴），
 * 由檢視頁（src/viewer/main.ts）把繪製端的子樹新增／移除接上來。
 */
export interface SubtreeHooks {
  added?(root: SceneNode): void;
  removed?(root: SceneNode): void;
}

// export 給 unity/prefab.ts：spawnPrefab 生完子樹要通知同一組繪製端掛勾
export let subtreeHooks: SubtreeHooks = {};

export function setSubtreeHooks(hooks: SubtreeHooks): void {
  subtreeHooks = hooks;
}

/** 這個 World 用的掛勾：World 自己有（檢視頁換場景後每個場景各一份）就用它，沒有就用全域的 */
export function hooksOf(world: World): SubtreeHooks {
  return world.subtreeHooks ?? subtreeHooks;
}

/** 已銷毀的節點與元件（Unity 的假 null：csport 的 objAlive／objEq 看這個） */
export const destroyedObjects = new WeakSet<object>();

// 場景檔的 id 全是數字字串（Unity 的 fileID），這裡用字母前綴，不會撞到。
// 匯出給 unity/prefab.ts：prefab 生出來的節點跟場景節點共用同一套 id 空間。
let seq = 0;
export const nextGoId = (): string => `g${++seq}`;
export const nextCompId = (): string => `c${++seq}`;
export const subtreeHookCount = (): number => (subtreeHooks.added ? 1 : 0) + (subtreeHooks.removed ? 1 : 0);
/** 子樹的全部節點（深度優先，含自己） */
export function subtree(root: SceneNode): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (n: SceneNode): void => {
    out.push(n);
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

/** 同檔 PPtr（{fileID}、沒有 guid）指向複製範圍內的東西就換成新 id；外部素材（{guid,fileID}）不動 */
export function remapRefs(value: unknown, ids: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = remapRefs(value[i], ids);
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  if (typeof o.fileID === 'string' && !('guid' in o)) {
    const mapped = ids.get(o.fileID);
    return mapped ? { fileID: mapped } : o;
  }
  for (const k of Object.keys(o)) o[k] = remapRefs(o[k], ids);
  return o;
}

/** node 的 Transform 接到 parent 底下（m_Father 與 parent 的 m_Children）；parent null ＝ 場景根。
 *  export 給 unity/prefab.ts（spawnPrefab 與 instantiate 共用同一個接法） */
export function linkTransform(node: SceneNode, parent: SceneNode | null): void {
  (node.transform as TransformData).m_Father = parent ? { fileID: parent.go.transform } : null;
  if (!parent) return;
  const ptf = parent.transform as TransformData;
  if (!ptf.m_Children.some((c) => c?.fileID === node.go.transform)) ptf.m_Children.push({ fileID: node.go.transform });
}

/** node 從舊 parent 的 m_Children 拔出來（SetParent／Destroy 用） */
function unlinkTransform(node: SceneNode): void {
  const p = node.parent;
  if (!p) return;
  const ptf = p.transform as TransformData;
  const i = ptf.m_Children.findIndex((c) => c?.fileID === node.go.transform);
  if (i >= 0) ptf.m_Children.splice(i, 1);
}

/** 新增／複製出來的元件建 behaviour，順序照 World.start()。已經建過的元件跳過（AddComponent 之後整棵重掃時用）。
 *  export 給 unity/prefab.ts：prefab 生成走同一個生命週期（檔頭對 Start 時機的說明同樣成立） */
export function startBehaviours(world: World, nodes: SceneNode[], order?: ReadonlyMap<ComponentData, number>): void {
  const made: [ComponentData, Behaviour][] = [];
  for (const n of nodes) {
    for (const c of world.graph.components(n)) {
      if (world.behaviours.has(c)) continue;
      const factory = world.factoryForScript(c.script);
      if (!factory) continue;
      const b = factory({ world, node: n, comp: c });
      world.behaviours.set(c, b);
      made.push([c, b]);
    }
  }
  // 場景載入：照場景檔的物件順序（原版 build 的 pathID，Scenes.load 給）。沒有順序的排在後面，維持樹的順序
  if (order) made.sort((a, b) => (order.get(a[0]) ?? Infinity) - (order.get(b[0]) ?? Infinity));
  // Awake／OnEnable 照 Unity 的順序（World.awakeBatch）；Start 在下一次 Update 之前（World.flushStarts）
  world.awakeBatch(made);
}

/**
 * Object.Instantiate(source)：複製一棵子樹並接在 parent 底下（parent null ＝ 場景根）。
 * 回傳複製出來的根節點。複製完算那棵子樹的 rect 與世界矩陣（World.refreshSubtree，10/17 以前整棵樹 relayout）：
 * Unity 的 RectTransform.rect 讀取時就算好，uGUI 自動排版等這一格結尾的 relayout。
 */
export function instantiate(world: World, source: SceneNode, parent: SceneNode | null): SceneNode {
  const graph = world.graph;
  const file = graph.file;
  const nodes = subtree(source);

  const ids = new Map<string, string>();
  for (const n of nodes) {
    ids.set(n.id, nextGoId());
    ids.set(n.go.transform, nextCompId());
    for (const cid of n.go.components) if (!ids.has(cid)) ids.set(cid, nextCompId());
  }

  let rootGoId = '';
  for (const n of nodes) {
    const goId = ids.get(n.id)!;
    if (n === source) rootGoId = goId;
    const go = structuredClone(n.go) as GameObjectData;
    go.transform = ids.get(n.go.transform)!;
    go.children = n.go.children.map((c) => ids.get(c)!);
    go.components = n.go.components.map((c) => ids.get(c)!);
    go.parent = n === source ? (parent ? parent.id : null) : (ids.get(n.go.parent ?? '') ?? null);
    file.gameObjects[goId] = go;
    for (const cid of n.go.components) {
      const comp = structuredClone(file.components[cid]) as ComponentData;
      comp.gameObject = goId;
      file.components[ids.get(cid)!] = remapRefs(comp, ids) as ComponentData;
    }
  }

  const root = graph.attach(rootGoId, parent);
  linkTransform(root, parent);
  if (parent) parent.go.children.push(rootGoId);
  world.refreshSubtree(root);
  startBehaviours(world, subtree(root));
  hooksOf(world).added?.(root);
  return root;
}

/**
 * Object.Destroy(node)：連子物件一起銷毀。從場景樹、World 的 behaviour 與匯入資料裡清乾淨，
 * 並通知繪製端把子樹的網格與受管元件丟掉。
 */
export function destroy(world: World, node: SceneNode): void {
  const graph = world.graph;
  const file = graph.file;
  const nodes = subtree(node);
  const ids = nodes.flatMap((n) => [n.id, ...n.go.components]);

  hooksOf(world).removed?.(node);
  // RectMask2D 的登錄（clips／culled／recs／lastMaskRect／forceClip）不會被下一格 cullAll 清掉
  // （cullAll 只清 recs 的死籍；clips 要等「換掛勾」分支才刪），銷毀時必須主動拔，否則殘留。
  world.clips.forget(ids);
  // C# 的 Destroy 先 OnDisable 再 OnDestroy。activeInHierarchy 由 detach 設成 false，
  // 還在跑的 ColorTween／coroutine 每格檢查它就會自己收尾，不會再寫到已銷毀的節點。
  // 整棵子樹先叫完 OnDisable 再叫 OnDestroy（Unity 的子樹內順序未查證），都在拆節點之前：OnDestroy 裡還讀得到自己與兄弟元件
  const dying: [ComponentData, Behaviour][] = [];
  for (const n of nodes) {
    for (const c of graph.components(n)) {
      const b = world.behaviours.get(c);
      if (!b) continue;
      if (world.enabled.has(b)) {
        world.enabled.delete(b);
        b.onDisable?.();
      }
      dying.push([c, b]);
    }
  }
  for (const [c, b] of dying) {
    world.destroyBehaviour(c, b);
    world.behaviours.delete(c);
  }
  // OnDestroy 跑完才標成已銷毀（== null）：回呼期間自己與同一批的物件還是有效的（CharacterDialogueScreen.OnDestroy 會 TryGetComponent）
  for (const n of nodes) {
    destroyedObjects.add(n);
    for (const c of graph.components(n)) if (c) destroyedObjects.add(c);
  }

  unlinkTransform(node);
  const parent = node.parent;
  if (parent) {
    const i = parent.go.children.indexOf(node.id);
    if (i >= 0) parent.go.children.splice(i, 1);
  }
  graph.detach(node);
  for (const id of ids) {
    delete file.gameObjects[id];
    delete file.components[id];
  }
}

/** GameObject.AddComponent：把元件加進既有物件，回傳註冊進場景檔的那一份 */
export function addComponent(world: World, node: SceneNode, comp: ComponentData): ComponentData {
  const file = world.graph.file;
  const cid = nextCompId();
  const c = structuredClone(comp) as ComponentData;
  c.gameObject = node.id;
  file.components[cid] = c;
  node.go.components.push(cid);
  world.graph.bumpStructure(); // 元件增加：候選清單的快取失效（scene.ts structureVersion）
  startBehaviours(world, [node]);
  return c;
}

/**
 * new GameObject(name) ＋ AddComponent：程式建的物件（TMP_Dropdown.CreateBlocker 用）。
 * components 裡要有一個 RectTransform（或 Transform），它的 id 會被當成物件的 transform。
 */
export function createGameObject(world: World, name: string, parent: SceneNode | null, components: ComponentData[]): SceneNode {
  const file = world.graph.file;
  const goId = nextGoId();
  const go: GameObjectData = {
    m_Name: name,
    m_IsActive: 1,
    m_Layer: parent?.go.m_Layer ?? 0,
    m_TagString: 'Untagged',
    transform: '',
    parent: parent ? parent.id : null,
    children: [],
    components: [],
  };
  for (const src of components) {
    const cid = nextCompId();
    const comp = structuredClone(src) as ComponentData;
    comp.gameObject = goId;
    file.components[cid] = comp;
    go.components.push(cid);
    if (comp.type === 'RectTransform' || comp.type === 'Transform') go.transform = cid;
  }
  file.gameObjects[goId] = go;
  const node = world.graph.attach(goId, parent);
  linkTransform(node, parent);
  if (parent) parent.go.children.push(goId);
  world.refreshSubtree(node);
  startBehaviours(world, [node]);
  hooksOf(world).added?.(node);
  return node;
}

/**
 * Transform.SetParent(parent, false)：worldPositionStays false ＝ 本地座標原封不動，只換父物件。
 * TMP_Dropdown.Show 把清單與 item 接回 Template 的 parent（Content）時用的就是這個。
 */
export function setParent(world: World, node: SceneNode, parent: SceneNode | null): void {
  const graph = world.graph;
  if (node.parent === parent) return;
  const old = node.parent;
  // GameObject.scene：拔成根物件時留在原本的場景；接到別的物件底下就跟著那邊（根的標記拿掉）
  const tag = sceneTagOf(node);
  unlinkTransform(node);
  if (old) {
    const i = old.children.indexOf(node);
    if (i >= 0) old.children.splice(i, 1);
    const j = old.go.children.indexOf(node.id);
    if (j >= 0) old.go.children.splice(j, 1);
  } else {
    const i = graph.roots.indexOf(node);
    if (i >= 0) graph.roots.splice(i, 1);
  }
  node.parent = parent;
  node.go.parent = parent ? parent.id : null;
  if (parent) {
    parent.children.push(node);
    parent.go.children.push(node.id);
    delete node.scene;
  } else {
    graph.roots.push(node);
    node.scene = tag;
  }
  linkTransform(node, parent);
  graph.bumpHierarchy(); // 根的順序的快取失效；候選清單（有哪種元件）不變（scene.ts membershipVersion）
  graph.refreshHierarchy();
  world.refreshSubtree(node);
}

/** GameObject.SetActive ＋ 立刻補跑 OnEnable／OnDisable（C# 的 SetActive 同步觸發，不等下一格） */
export function setActive(world: World, node: SceneNode, active: boolean): void {
  world.graph.setActive(node, active);
  world.refreshEnables(node);
}

// 同時載入多個場景：UnityEngine.SceneManagement 的 Scene／SceneManager 與 Object.DontDestroyOnLoad 的對應。
//
// Unity 只有一個物件空間：每個 GameObject 屬於一個場景（GameObject.scene），場景是一組根物件。這裡照同一個模型：
// 一個 World、一棵 SceneGraph，根物件身上的 scene 標記（SceneNode.scene）指到 LoadedScene，子物件沿 parent 往上找。
//   - 載入（Single／Additive）：場景檔的全部 id 重新編號後併進同一棵樹（prefab 生成的同一套做法，場景檔的 fileID 彼此會撞），
//     接著照 Unity 的順序：全部 Awake → OnEnable → sceneLoaded 事件 → Start（下一次 Update 之前，World.flushStarts）。
//     Single 先把目前所有場景（DontDestroyOnLoad 除外）的根物件銷毀。
//   - 卸載：銷毀這個場景的全部根物件（OnDisable），再發 sceneUnloaded。
//   - DontDestroyOnLoad(物件)：根物件移到專用的 DontDestroyOnLoad 場景（buildIndex -1，不算在 sceneCount 裡）。
//   - 執行時期新增的根物件（Instantiate 到場景根、new GameObject）放進目前的 active 場景（SceneGraph.rootSceneTag）。
//
// 與原版的差異：
//   - Unity 的 Single 載入是新場景的 Awake 先、舊場景的 OnDestroy 後（常見的單例陷阱）還是反過來，未查證；這裡先卸載舊的再載入新的。
//   - LoadSceneAsync 的 allowSceneActivation、progress 的細節沒做：檔案載完（含依賴）就在下一格開頭啟用。

import type { World } from '../engine/world';
import { destroy, hooksOf, linkTransform, nextCompId, nextGoId, remapRefs, startBehaviours, subtree } from './instantiate';
import { sceneTagOf, type SceneNode } from './scene';
import type { ComponentData, GameObjectData, SceneFile } from './types';

/** LoadSceneMode */
export const LoadSceneMode = { Single: 0, Additive: 1 } as const;

/** 一個已載入的場景（UnityEngine.SceneManagement.Scene 的內容；Scene 結構本身在相容層用這個物件當 handle） */
export interface LoadedScene {
  readonly handle: number;
  readonly name: string;
  /** Assets/… 的路徑（Scene.path） */
  readonly path: string;
  /** Build Settings 的順序；DontDestroyOnLoad 場景是 -1 */
  readonly buildIndex: number;
  isLoaded: boolean;
  /** Scene.isSubScene 等沒做 */
  readonly dontDestroyOnLoad?: boolean;
  /** 場景檔的 GUID（資產裡指向場景物件的參照 {guid, fileID} 用它對） */
  readonly guid?: string;
  /** 場景檔的 fileID → World 裡的 id（合併時重新編號；開機場景沒重編，沒有這張表） */
  fileIds?: Map<string, string>;
  /** 場景檔的設定（RenderSettings、LightmapSettings…；匯入器的 settings）。Unity 的光照與霧照 active 場景的（繪製端讀） */
  readonly settings?: Record<string, unknown>;
}

export type SceneLoadedHandler = (scene: LoadedScene, mode: number) => void;
export type SceneUnloadedHandler = (scene: LoadedScene) => void;
export type ActiveSceneChangedHandler = (previous: LoadedScene | null, next: LoadedScene) => void;

let handleSeq = 0;
/**
 * LoadedScene 物件的原型：Scene 在 C# 是結構，指定、傳參時會複製（相容層的 cloneData 會複製一般物件）。
 * 這裡讓它不是一般物件，複製時拿到同一份；就算拿到複本，Scenes 也照 handle 找回原本那一份（resolve）。
 */
const SCENE_PROTO = Object.freeze({ $sceneHandle: true });
function newScene(fields: LoadedScene): LoadedScene {
  return Object.assign(Object.create(SCENE_PROTO) as LoadedScene, fields);
}

export class Scenes {
  /** 已載入的場景，照載入順序（SceneManager.GetSceneAt）；不含 DontDestroyOnLoad 場景 */
  readonly loaded: LoadedScene[] = [];
  readonly dontDestroyOnLoadScene: LoadedScene = newScene({ handle: --handleSeq, name: 'DontDestroyOnLoad', path: '', buildIndex: -1, isLoaded: true, dontDestroyOnLoad: true });
  private activeScene: LoadedScene | null = null;
  readonly sceneLoaded: SceneLoadedHandler[] = [];
  readonly sceneUnloaded: SceneUnloadedHandler[] = [];
  readonly activeSceneChanged: ActiveSceneChangedHandler[] = [];
  /** 場景的物件併進樹之後、Awake 之前（相容層在這裡把 ScriptableObject 裡指向這個場景的參照接上） */
  readonly merged: ((scene: LoadedScene) => void)[] = [];

  constructor(private readonly world: World) {}

  get active(): LoadedScene | null {
    return this.activeScene;
  }

  /** SceneManager.SetActiveScene：場景要已經載入。回傳是否成功 */
  setActive(target: LoadedScene): boolean {
    const scene = this.resolve(target);
    if (!scene || !scene.isLoaded || scene.dontDestroyOnLoad) return false;
    const prev = this.activeScene;
    this.activeScene = scene;
    this.world.graph.rootSceneTag = scene;
    if (prev !== scene) for (const h of [...this.activeSceneChanged]) this.world.guard('activeSceneChanged', () => h(prev, scene));
    return true;
  }

  /** 開機時的第一個場景（World 建構時的場景檔已經在樹裡）：登記並設成 active */
  registerInitial(info: { name: string; path: string; buildIndex: number; guid?: string }): LoadedScene {
    const scene: LoadedScene = newScene({ handle: --handleSeq, ...info, isLoaded: true, settings: this.world.graph.file.settings });
    for (const r of this.world.graph.roots) r.scene = scene;
    this.loaded.push(scene);
    this.activeScene = scene;
    this.world.graph.rootSceneTag = scene;
    return scene;
  }

  /** GameObject.scene */
  sceneOf(node: SceneNode): LoadedScene | null {
    return (sceneTagOf(node) as LoadedScene | undefined) ?? null;
  }

  /** Scene.GetRootGameObjects：這個場景的根物件，照樹的順序 */
  rootsOf(target: LoadedScene): SceneNode[] {
    const scene = this.resolve(target) ?? target;
    return this.world.graph.roots.filter((r) => r.scene === scene);
  }

  byName(name: string): LoadedScene | null {
    return this.loaded.find((s) => s.name === name || s.path === name) ?? null;
  }

  byBuildIndex(i: number): LoadedScene | null {
    return this.loaded.find((s) => s.buildIndex === i) ?? null;
  }

  /** Object.DontDestroyOnLoad：只對根物件有效（Unity 對子物件只出警告）。回傳是否移動 */
  dontDestroyOnLoad(node: SceneNode): boolean {
    if (node.parent) {
      this.world.notes.add(`DontDestroyOnLoad 只對根物件有效：${node.go.m_Name}`);
      return false;
    }
    node.scene = this.dontDestroyOnLoadScene;
    return true;
  }

  /**
   * 載入一個場景檔（依賴的 prefab、ScriptableObject 要先載好，unity/objectStore.ts）。
   * 回傳新場景；Awake／OnEnable 已經跑完、sceneLoaded 已經發出，Start 排在下一次 Update 之前。
   */
  load(data: SceneFile, info: { name: string; path: string; buildIndex: number; guid?: string }, mode: number): LoadedScene {
    if (mode === LoadSceneMode.Single) for (const s of [...this.loaded]) this.unload(s);
    const scene: LoadedScene = newScene({ handle: --handleSeq, ...info, isLoaded: true, settings: data.settings });
    this.loaded.push(scene);
    const roots = mergeSceneFile(this.world, data, scene);
    for (const h of [...this.merged]) this.world.guard('sceneMerged', () => h(scene));
    const nodes = roots.flatMap((r) => subtree(r));
    this.world.startAnimatorsIn(nodes);
    startBehaviours(this.world, nodes, loadOrder(this.world, scene));
    for (const r of roots) hooksOf(this.world).added?.(r);
    if (mode === LoadSceneMode.Single || !this.activeScene) this.setActive(scene);
    for (const h of [...this.sceneLoaded]) this.world.guard('sceneLoaded', () => h(scene, mode));
    return scene;
  }

  /** Scene 的複本（handle 相同）→ 清單裡原本那一份；不是已載入的場景回 null */
  resolve(scene: LoadedScene | null | undefined): LoadedScene | null {
    if (!scene) return null;
    if (scene === this.dontDestroyOnLoadScene || this.loaded.includes(scene)) return scene;
    if (scene.handle === this.dontDestroyOnLoadScene.handle) return this.dontDestroyOnLoadScene;
    return this.loaded.find((s) => s.handle === scene.handle) ?? null;
  }

  /** 卸載：銷毀場景的全部根物件，從清單拿掉，發 sceneUnloaded。active 場景被卸載時換成清單裡的第一個 */
  unload(target: LoadedScene): void {
    const scene = this.resolve(target);
    if (!scene || !scene.isLoaded || scene.dontDestroyOnLoad) return;
    for (const r of this.rootsOf(scene)) destroy(this.world, r);
    scene.isLoaded = false;
    this.loaded.splice(this.loaded.indexOf(scene), 1);
    if (this.activeScene === scene) {
      this.activeScene = null;
      if (this.loaded[0]) this.setActive(this.loaded[0]);
    }
    for (const h of [...this.sceneUnloaded]) this.world.guard('sceneUnloaded', () => h(scene));
  }
}

/**
 * 場景載入時 Awake／OnEnable／Start 的順序：照場景檔的元件 fileID 由小到大。AssetRipper 匯出的 fileID 就是原版 build 的 pathID
 * （UnityPy 讀 level7 對過：HandUI 1729、RoomManager 1734、CardSelectionBehaviour 1743），也就是 level 檔物件表的順序。
 * Unity 文件說物件之間的 Awake 順序不保證；照載入順序是推定（未查證），但原版的新手戰鬥要 HandUI.Start 早於 RoomManager.Start
 * （CommonSelectionBehavior 的 DepInjector.AddClient 照 provider 登記順序通知），樹的順序做不到，物件表的順序做得到。
 */
function loadOrder(world: World, scene: LoadedScene): Map<ComponentData, number> {
  const order = new Map<ComponentData, number>();
  for (const [orig, id] of scene.fileIds ?? []) {
    const comp = world.graph.file.components[id];
    const n = Number(orig);
    if (comp && Number.isFinite(n)) order.set(comp, n);
  }
  return order;
}

/**
 * 場景檔的全部根物件併進 World 的樹（id 全部重新編號，同檔 PPtr 照新 id 重映射，外部素材不動），根物件標記為 scene。
 * 只建節點與排版，不跑生命週期（Scenes.load 接著跑）。回傳根節點，照場景檔的順序。
 */
export function mergeSceneFile(world: World, data: SceneFile, scene: unknown): SceneNode[] {
  const file = world.graph.file;
  const ids = new Map<string, string>();
  if (scene && typeof scene === 'object') (scene as LoadedScene).fileIds = ids;
  for (const gid of Object.keys(data.gameObjects)) {
    ids.set(gid, nextGoId());
    const go = data.gameObjects[gid];
    ids.set(go.transform, nextCompId());
    for (const cid of go.components) if (!ids.has(cid)) ids.set(cid, nextCompId());
  }
  for (const gid of Object.keys(data.gameObjects)) {
    const go = structuredClone(data.gameObjects[gid]) as GameObjectData;
    const goId = ids.get(gid)!;
    go.transform = ids.get(go.transform)!;
    go.children = go.children.map((c) => ids.get(c)!);
    go.components = go.components.map((c) => ids.get(c)!);
    go.parent = go.parent ? (ids.get(go.parent) ?? null) : null;
    file.gameObjects[goId] = go;
    for (const cid of data.gameObjects[gid].components) {
      const comp = structuredClone(data.components[cid]) as ComponentData;
      comp.gameObject = goId;
      file.components[ids.get(cid)!] = remapRefs(comp, ids) as ComponentData;
    }
  }
  const roots: SceneNode[] = [];
  for (const r of data.roots) {
    const root = world.graph.attach(ids.get(r)!, null);
    root.scene = scene;
    linkTransform(root, null);
    roots.push(root);
  }
  world.relayout();
  return roots;
}

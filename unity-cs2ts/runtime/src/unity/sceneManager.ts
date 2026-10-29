// 換場景與常駐物件：UnityEngine.SceneManagement.SceneManager（LoadSceneAsync、目前的場景）與
// Object.DontDestroyOnLoad 的對應（第 3 階段第六段，Claude Code 10/10）。
//
// 檢視頁（src/viewer/main.ts）一頁可以換場景：loadSceneAsync 在背景建好新場景（新的 World、新的繪製端、
// 新的 canvas 元素；新場景的 Awake／OnEnable／Start 都跑完）才換上，舊場景整個丟掉。載入期間舊場景照常每格跑
// （LevelLoader 的 loadingIcon 會動），跟 LoadSceneMode.Single 一樣：舊場景在新場景啟用時才卸載。
//
// 常駐物件：原版 Awake 裡 `if (Instance != null) { Destroy(gameObject); return; } Instance = this; DontDestroyOnLoad(this);`
// 這裡對應成：
//   const sm = world.services.sceneManager;
//   if (sm?.persistent('AudioManager')) { world.destroyDeferred(node); return {}; }
//   … 建 behaviour …
//   sm?.dontDestroyOnLoad('AudioManager', self, world);
// key 用 C# 類別名：這個專案的常駐物件都是單例。沒有 sceneManager（vitest）時照舊。
//
// 常駐 behaviour 換場景後由新的 World 每格呼叫 update（World.tick）。它的 tween、coroutine、time 一律用
// `activeWorld`，不要用建立時的 world：舊的 world 換場景後就不再 tick。
// 常駐物件的節點留在舊的場景樹裡（不畫、不收事件）；需要畫面的常駐物件（LevelLoader 的轉場）改用新場景裡
// 同一份 prefab 的節點（LevelLoader 自己的 adopt，見 game/levelLoader.ts）。

import type { Behaviour, World } from '../engine/world';

interface PersistentEntry {
  behaviour: Behaviour;
  /** Awake 時所在的 World（常駐物件「原本的場景」） */
  origin: World;
}

export type SceneLoader = (name: string) => Promise<void>;

export class SceneManagerService {
  private readonly entries = new Map<string, PersistentEntry>();
  private world: World | null = null;
  private sceneName = '';

  constructor(
    /** 檢視頁的網址參數（seed 等，給遊戲腳本讀） */
    readonly params: URLSearchParams,
    private readonly loader: SceneLoader,
    private readonly cursor: (visible: boolean) => void = () => {},
  ) {}

  /** SceneManager.GetActiveScene() 對應的 World；檢視頁每次換上新場景時更新 */
  get activeWorld(): World {
    if (!this.world) throw new Error('SceneManagerService：還沒有 active 的場景');
    return this.world;
  }

  get activeSceneName(): string {
    return this.sceneName;
  }

  /** 檢視頁用：新場景換上的那一刻呼叫 */
  activate(name: string, world: World): void {
    this.sceneName = name;
    this.world = world;
  }

  /** SceneManager.LoadSceneAsync(name)（LoadSceneMode.Single）。resolve 時新場景已經是 active、舊場景已丟掉 */
  loadSceneAsync(name: string): Promise<void> {
    return this.loader(name);
  }

  /** Object.DontDestroyOnLoad(this)。同一個 key 只能登記一次（第二份應該在 Awake 就被 Destroy） */
  dontDestroyOnLoad(key: string, behaviour: Behaviour, origin: World): void {
    if (this.entries.has(key)) throw new Error(`DontDestroyOnLoad：${key} 已經有常駐實例`);
    this.entries.set(key, { behaviour, origin });
  }

  /** 已登記的常駐實例（C# 的 `Instance != null`） */
  persistent<T extends Behaviour>(key: string): T | undefined {
    return this.entries.get(key)?.behaviour as T | undefined;
  }

  /** 不屬於 world 的常駐 behaviour（World.tick 用：自己場景的常駐物件已經在 world.behaviours 裡） */
  persistentFor(world: World): Behaviour[] {
    const out: Behaviour[] = [];
    for (const e of this.entries.values()) if (e.origin !== world) out.push(e.behaviour);
    return out;
  }

  /** Cursor.visible */
  setCursorVisible(visible: boolean): void {
    this.cursor(visible);
  }
}

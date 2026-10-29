// 執行中切換語言：LocalizationSettings.SelectedLocale 的 setter ＋ SelectedLocaleChanged 事件的等價，
// 以及「重新套用到已經建好的場景」的流程。啟動時套一次是 applyLocalization（localization.ts，載入場景前呼叫），
// 這裡是之後的每一次切換（設定面板的 Language 下拉選單、依存檔 localeName）。
//
// 對應（10/6 讀 reference/decompiled/Unity.Localization、reference/decompiled/Unity.TextMeshPro、reference/csharp）：
//   Settings/LocalizationSettings.cs：SelectedLocale（:137-148）、SetSelectedLocale（:396-412，設成同一個 locale
//     直接 return、不送事件）、SendLocaleChangedEvents（:294-311）、InvokeSelectedLocaleChanged（:319-343，
//     照訂閱順序）、SelectedLocaleChanged（:210-219）
//   CallbackArray.cs：Add 附加到尾端（:31-67）、RemoveByMovingTail 把尾端搬進洞（:69-108）、
//     LockForChanges／UnlockForChanges 通知中增刪延後（:110-113, :115-141）
//   PropertyVariants/GameObjectLocalizer.cs：OnEnable 訂閱（:24-35）、SelectedLocaleChanged（:55-62）、
//     ApplyLocaleVariant（:108-111, :113-150，逐個 TrackedObject 呼叫 ApplyLocale）
//   PropertyVariants.TrackedObjects/JsonSerializerTrackedObject.cs：ApplyLocale（:131-261）、
//     ApplyJson → PostApplyTrackedProperties（:289-293）
//   PropertyVariants.TrackedObjects/TrackedTmpDropdown.cs（:11-15）：PostApplyTrackedProperties →
//     TMP_Dropdown.RefreshShownValue（:13）
//   PropertyVariants.TrackedObjects/TrackedMonoBehaviourObject.cs（:15-19）：PostApplyTrackedProperties →
//     m_Changed.Invoke（:18）
//   PropertyVariants.TrackedObjects/TrackedObject.cs（:110-112）：PostApplyTrackedProperties 基底是空的
//     （TrackedUGuiGraphic／TrackedRectTransform 沒覆寫，套完不用多做什麼）
//   TMPro/TMP_Dropdown.cs：RefreshShownValue（:459-495）、Start（:440-446）、
//     Show 用當下的 options 建清單項目（:631-…，AddItem 呼叫在 :726）
//   Components/LocalizeStringEvent.cs：OnEnable（:72-75）→ RegisterChangeHandler（:97-116）；
//     LocalizedString.cs：StringChanged 的第一個 handler 把 HandleLocaleChange 掛上 SelectedLocaleChanged
//     （:145-174，掛在 :158）、HandleLocaleChange（:514-535）
//   MainMenu.cs：Start 訂閱（:89-90）、OnDestroy 解除（:155）、ReorderAndRenamePlayPrologueButton（:194-207）、
//     SetNewRunButtonBySave（:224-228）
//   UI/PauseMenu.cs：OnLocaleValueChange（:278-285）、ToggleLocale（:287-294）、GetLocaleByLocaleName（:296-307）、
//     SetGames（:333-350，SelectedLocale.LocaleName ≠ 存檔 localeName 才切）
//
// 跟原版的差異（逐條見回報）：表格改成「要切才載」（原版 PreloadBehavior 3 ＝ PreloadAllLocales，全部預載）；
// Localization 的 strings／assets 是 private，換語言時重建一個實例並換掉 world.services.localization。

import type { Behaviour, World } from '../engine/world';
import type { ComponentData, Ref, SceneFile } from '../unity/types';
import { invokePersistentCalls } from '../unity/unityEvents';
import { applyLocalization, Localization } from './localization';

/** LocalizationSettings.SelectedLocaleChanged 的訂閱者（C# 是 Action<Locale>，這裡給 locale code） */
export type LocaleChangedHandler = (locale: string) => void;

/** 取一個「該語言的表格都載好了」的 Localization 實例（Localization.load 的等價；測試可給讀檔的版本） */
export type LocaleLoader = (code: string) => Promise<Localization>;

export interface LocaleSwitchReport {
  /** applyLocalization 的結果：套用了幾個追蹤屬性、跳過哪些 */
  applied: number;
  skipped: string[];
  /** 套完之後場景裡 TMP 指到的字型 GUID。LocalizedTmpFont 會隨語言換 m_fontAsset，呼叫端要
   *  GameTextAssets.prepare 這些才有字形（level1 的字型不隨語言變，只有 prefab b43f81e5… 有）。 */
  fontGuids: string[];
}

/**
 * LocalizationSettings.m_SelectedLocaleChanged 用的 CallbackArray<Action<Locale>>（CallbackArray.cs）。
 * 順序語意照原版：Add 附加到尾端，RemoveByMovingTail 把尾端搬進被移走的洞（後面的順序會變），
 * 通知中（LockForChanges）的增刪延後到 UnlockForChanges 才套用，且這一輪不會被呼叫到。
 */
class CallbackArray {
  private items: LocaleChangedHandler[] = [];
  private locked = false;
  private mutated = false;
  private pendingAdd: LocaleChangedHandler[] = [];
  private pendingRemove: LocaleChangedHandler[] = [];

  /** CallbackArray.Add（:31-67）。single／multi 的分別只是記憶體配置，順序一樣是附加到尾端 */
  add(h: LocaleChangedHandler): void {
    if (this.locked) {
      this.pendingAdd.push(h);
      this.mutated = true;
      return;
    }
    this.items.push(h);
  }

  /** CallbackArray.RemoveByMovingTail（:69-108） */
  remove(h: LocaleChangedHandler): void {
    if (this.locked) {
      this.pendingRemove.push(h);
      this.mutated = true;
      return;
    }
    const i = this.items.indexOf(h);
    if (i < 0) return;
    this.items[i] = this.items[this.items.length - 1];
    this.items.pop();
  }

  /** InvokeSelectedLocaleChanged（LocalizationSettings.cs:319-343）：照訂閱順序呼叫。
   *  length 先抓（:324），通知中新訂閱的這一輪不會被呼叫到。 */
  invoke(locale: string): void {
    this.locked = true;
    const length = this.items.length;
    for (let i = 0; i < length; i++) this.items[i](locale);
    // UnlockForChanges（CallbackArray.cs:115-141）
    this.locked = false;
    if (!this.mutated) return;
    for (const h of this.pendingAdd) this.add(h);
    this.pendingAdd = [];
    for (const h of this.pendingRemove) this.remove(h);
    this.pendingRemove = [];
  }
}

interface TrackedObjectData {
  $type: string;
  m_Target: Ref;
  m_Changed?: { m_PersistentCalls: { m_Calls: unknown[] } };
}

/**
 * TrackedObject.PostApplyTrackedProperties：JsonSerializerTrackedObject.ApplyJson（:289-293）在
 * JsonUtility.FromJsonOverwrite 之後呼叫，各 TrackedObject 子類別自己覆寫。
 * TrackedTmpDropdown → TMP_Dropdown.RefreshShownValue（TrackedTmpDropdown.cs:11-15）；
 * TrackedMonoBehaviourObject → m_Changed.Invoke（TrackedMonoBehaviourObject.cs:15-19）；
 * TrackedUGuiGraphic／TrackedRectTransform 用基底的空實作（TrackedObject.cs:110-112）。
 * 走法跟 applyLocalization 一樣（同樣只處理 m_Enabled 的元件、同樣的 m_Target 解法），
 * 在它回傳之後呼叫＝原版「每個 GameObjectLocalizer 套完自己的屬性就 PostApply」的結果。
 */
function postApplyTrackedProperties(world: World, file: SceneFile): void {
  const comps = file.components as Record<string, ComponentData>;
  for (const c of Object.values(comps)) {
    if (!c.m_Enabled) continue;
    if (c.script?.class !== 'GameObjectLocalizer') continue;
    for (const t of (c.m_TrackedObjects as TrackedObjectData[] | undefined) ?? []) {
      const ref = t?.m_Target as Ref;
      const target = ref && 'fileID' in ref ? comps[ref.fileID] : undefined;
      if (!target) continue; // applyLocalization 已經把這種記進 skipped
      if (t.$type === 'TrackedTmpDropdown') {
        // TrackedTmpDropdown.PostApplyTrackedProperties（:13）呼叫的是 TMP_Dropdown 元件自己的
        // RefreshShownValue，所以走 behaviour（src/runtime/ui/tmpDropdown.ts，含 m_MultiSelect 的完整版）；
        // 這裡不再留一份自己的實作，兩份會分歧。behaviour 沒註冊就記 note。
        const dd = world.behaviour<Behaviour & { refreshShownValue?(): void }>(target);
        if (dd?.refreshShownValue) dd.refreshShownValue();
        else world.notes.add('TrackedTmpDropdown 要呼叫 TMP_Dropdown.RefreshShownValue，但 TMP_Dropdown 的 behaviour 沒註冊');
      }
      else if (t.$type === 'TrackedMonoBehaviourObject') invokePersistentCalls(world, t as unknown as ComponentData, 'm_Changed', undefined, 'GameObjectLocalizer 套用 → m_Changed');
    }
  }
}

/** 場景裡 TMP 目前指到的字型 GUID（跟 viewer/main.ts 啟動時收集的方式一樣） */
export function tmpFontGuids(file: SceneFile): string[] {
  const out = new Set<string>();
  for (const c of Object.values(file.components)) {
    const k = c.script?.class ?? c.type;
    if (k !== 'TextMeshProUGUI' && k !== 'TextMeshPro') continue;
    const f = c.m_fontAsset as Ref;
    if (f && 'guid' in f) out.add(f.guid);
  }
  return [...out];
}

/**
 * LocalizationSettings 的 SelectedLocale／SelectedLocaleChanged（一個 World 一個；原版是 process 單例，
 * 這裡的 World 就是一個場景）。用 localeSwitcherOf(world) 取。
 */
export class LocaleSwitcher {
  private readonly callbacks = new CallbackArray();
  private readonly cache = new Map<string, Localization>();
  private changing = false;

  constructor(
    private readonly world: World,
    private readonly load: LocaleLoader = (code) => Localization.load('./game/', code),
  ) {
    // 啟動時載好的那個實例直接進 cache：切回原本的語言不用重載
    this.cache.set(world.services.localization.locale, world.services.localization);
  }

  get localization(): Localization {
    return this.world.services.localization;
  }

  /** LocalizationSettings.SelectedLocale（Locale.Identifier.Code） */
  get locale(): string {
    return this.localization.locale;
  }

  /** LocalizationSettings.SelectedLocale.LocaleName（Locale.cs:70-88），存檔的 localeName 是這個格式 */
  get localeName(): string {
    return this.localization.locales[this.locale]?.name ?? this.locale;
  }

  /** PauseMenu._inChangingLocale（:59）的來源：切換還在跑（await 表格）時是 true */
  get inChangingLocale(): boolean {
    return this.changing;
  }

  /** LocalizationSettings.SelectedLocaleChanged += （:210-215 → CallbackArray.Add） */
  addSelectedLocaleChanged(handler: LocaleChangedHandler): void {
    this.callbacks.add(handler);
  }

  /** LocalizationSettings.SelectedLocaleChanged -= （:216-218 → CallbackArray.RemoveByMovingTail） */
  removeSelectedLocaleChanged(handler: LocaleChangedHandler): void {
    this.callbacks.remove(handler);
  }

  /** PauseMenu.GetLocaleByLocaleName（:296-307）：找不到記 warning（原版 Debug.LogWarning）並回 undefined */
  localeCodeOf(localeName: string): string | undefined {
    const hit = Object.entries(this.localization.locales).find(([, l]) => l.name === localeName);
    if (hit) return hit[0];
    this.world.notes.add(`Could not find locale for ${localeName}`);
    return undefined;
  }

  /**
   * PauseMenu.ToggleLocale（:287-294）：存檔的 localeName 與語言下拉選單（_localeDict）都是 LocaleName，
   * 先換成 code。找不到時原版把 SelectedLocale 設回自己 → SetSelectedLocale 直接 return，不送事件。
   */
  setSelectedLocaleByName(localeName: string): Promise<LocaleSwitchReport | null> {
    return this.setSelectedLocale(this.localeCodeOf(localeName) ?? this.locale);
  }

  /**
   * LocalizationSettings.SelectedLocale = locale（:137-148）→ SetSelectedLocale（:396-412）→
   * SendLocaleChangedEvents（:294-311）→ InvokeSelectedLocaleChanged（:319-343）。
   * 同一個語言直接 return null（:398-401），跟原版一樣不送事件。
   *
   * 順序照原版：場景裡全部 GameObjectLocalizer 與 LocalizeStringEvent 先重新套用（它們在 OnEnable 訂閱，
   * 早於 behaviour 在 Start 的訂閱），再通知之後訂閱的（MainMenu）。最後重排（RectTransform 變體與
   * TMP 文字長度都會改版面；TMP 的網格由 sceneRenderer 每格的 key 比對重產）。
   */
  async setSelectedLocale(code: string): Promise<LocaleSwitchReport | null> {
    if (code === this.locale) return null;
    this.changing = true;
    const loc = await this.tablesOf(code);
    // Localization 的字串／資產表是 private，只能換實例（WorldServices.localization 不是 readonly）。
    // 原版 SendLocaleChangedEvents 先呼叫 StringDatabase／AssetDatabase 的 OnLocaleChanged（:296-297），
    // 那是 ReleaseAllTables（LocalizedDatabase.cs:448-451，把舊語言的表格放掉、新語言重載）——換實例就是同一件事
    this.world.services.localization = loc;
    const file = this.world.graph.file;
    const result = applyLocalization(file, loc);
    postApplyTrackedProperties(this.world, file);
    this.callbacks.invoke(code);
    this.world.relayout();
    this.changing = false; // PauseMenu.ToggleLocale（:293）在 SelectedLocale 指派完（事件都送完）才放掉
    return { applied: result.applied, skipped: result.skipped, fontGuids: tmpFontGuids(file) };
  }

  /** 這個語言的表格（原版 PreloadBehavior 3 ＝ PreloadAllLocales 全部預載；這裡要切才載，載過的留著） */
  private async tablesOf(code: string): Promise<Localization> {
    const hit = this.cache.get(code);
    if (hit) return hit;
    const loc = await this.load(code);
    this.cache.set(code, loc);
    return loc;
  }
}

// C# 的 LocalizationSettings.Instance 是 process 單例；這裡一個 World（場景）一個，用 WeakMap 存，
// 換場景（換 World）自然換一份，測試之間也不會互相留狀態。
const switchers = new WeakMap<World, LocaleSwitcher>();

/** 取這個 World 的 LocaleSwitcher（還沒裝就用預設的 LocaleLoader 裝一份） */
export function localeSwitcherOf(world: World): LocaleSwitcher {
  let s = switchers.get(world);
  if (!s) {
    s = new LocaleSwitcher(world);
    switchers.set(world, s);
  }
  return s;
}

/** 自己指定表格怎麼載（檢視頁要換 base、測試要讀檔）。要在任何 behaviour 的 start() 之前呼叫 */
export function installLocaleSwitcher(world: World, load: LocaleLoader): LocaleSwitcher {
  const s = new LocaleSwitcher(world, load);
  switchers.set(world, s);
  return s;
}

// TMP_Dropdown（ui/tmpDropdown.ts）的測試。用 level1 真資料的 5 個下拉選單：
//   Language       元件 1472／物件 397，6 個選項，m_Value 0，onValueChanged → PauseMenu.OnLocaleValueChange
//   ExchangeMana   元件 1322／物件 112，3 個選項，m_Value 1，→ ManaConvertValueChanged
//   Resolutions    元件 1275／物件 269，5 個選項，m_Value 0，→ ResolutionDropdownValueChanged
//   FullScreenModes元件 1383／物件 325，2 個選項，m_Value 0，→ FullScreenDropdownValueChanged
//   MaxFPS         元件 1323／物件 305，4 個選項，m_Value 0，→ MaxFPSDropdownValueChanged
//   5 個的 onValueChanged target 都是元件 1516（UI.PauseMenu，物件 211 SettingPanel）。
// SettingPanel 在場景資料裡是啟用的（靠 Animator 的 In／Out 顯示與隱藏，不是 SetActive），
// 所以 world.start() 會跑 TMP_Dropdown.Start（:475-482）→ RefreshShownValue。
// 期望值逐條對照 TMP_Dropdown.cs（3.2.0-pre.4，10/6 讀），行號標在每個 it。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClipAsset, ControllerAsset } from '../engine/animator';
import { World } from '../engine/world';
import { applyLocalization, Localization, type LocalizationSettings } from '../localization/localization';
import { SceneGraph } from '../unity/scene';
import type { ComponentData, RectTransformData, SceneFile } from '../unity/types';
import { UI_BEHAVIOURS } from './selectable';
import { TOGGLE_BEHAVIOURS, type ToggleBehaviour } from './toggle';
import { DROPDOWN_BEHAVIOURS, type TMPDropdownBehaviour } from './tmpDropdown';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

/** PauseMenu 的元件（5 個下拉選單的 onValueChanged 都指它）；測試裡裝間諜 behaviour 收事件 */
const PAUSE_MENU_COMP = '1516';
const LOCALE_DROPDOWN = '1472';
const MANA_DROPDOWN = '1322';
const FPS_DROPDOWN = '1323';

function setup(locale = 'en') {
  const loc = Localization.fromData(
    load<LocalizationSettings>('localization/settings.json'),
    load('localization/tables.json'),
    { en: load('data/i18n/en.json'), 'zh-Hans': load('data/i18n/zh-Hans.json') },
    { en: load('localization/assets/en.json') },
    locale,
  );
  const file = load<SceneFile>('scenes/level1.json');
  applyLocalization(file, loc);
  const graph = new SceneGraph(file);
  const world = new World(graph, {
    localization: loc,
    version: load<{ gameVersion: string }>('data/manifest.json').gameVersion,
    controllers: load<Record<string, ControllerAsset>>('assets/animators.json'),
    clips: load<Record<string, ClipAsset>>('assets/animations.json'),
    registry: { ...UI_BEHAVIOURS, ...TOGGLE_BEHAVIOURS, ...DROPDOWN_BEHAVIOURS },
    layout: {},
    sortingLayerIndex: (id: number) => (id === -810080303 ? 1 : 0),
  });
  world.screen = { w: 1920, h: 1080 };
  world.events.screenSize = { w: 1920, h: 1080 };
  const before = { nodes: graph.nodes.size, gameObjects: Object.keys(file.gameObjects).length, components: Object.keys(file.components).length };
  world.start();
  world.relayout();

  // PauseMenu 不在這題的 registry 裡，裝一個只記錄呼叫的 behaviour 當間諜（invokePersistentCalls 用 world.behaviour 找目標）。
  // Unity 的生命週期與指標 handler 要回 undefined：World.refreshEnables／tick 會對每個 behaviour 呼叫它們，
  // 記進 calls 會把 onValueChanged 的觀察洗掉。
  const calls: [string, unknown][] = [];
  const LIFECYCLE = new Set(['awake', 'start', 'update', 'onEnable', 'onDisable', 'onPointerDown', 'onPointerUp', 'onPointerEnter', 'onPointerExit', 'onPointerClick', 'onSelect', 'onDeselect', 'onBeginDrag', 'onDrag', 'onEndDrag', 'onScroll', 'onInitializePotentialDrag', 'mayInteract']);
  const spy = new Proxy(
    {},
    {
      get: (_t, prop: string) => (LIFECYCLE.has(prop) ? undefined : (arg: unknown) => void calls.push([prop, arg])) as unknown,
    },
  ) as Record<string, unknown>;
  world.behaviours.set(file.components[PAUSE_MENU_COMP] as ComponentData, spy);

  const dropdown = (compId: string) => world.behaviour<TMPDropdownBehaviour>(file.components[compId] as ComponentData)!;
  /** 下拉選單的標籤文字（m_CaptionText 指的那個 TMP 的 m_text） */
  const captionOf = (compId: string): string => {
    const dd = file.components[compId] as ComponentData;
    const cap = file.components[(dd.m_CaptionText as { fileID: string }).fileID] as ComponentData;
    return cap.m_text as string;
  };
  return { world, graph, file, before, calls, dropdown, captionOf };
}

const optionTexts = (file: SceneFile, compId: string): (string | null)[] =>
  ((file.components[compId] as ComponentData).m_Options as { m_Options: { m_Text: string | null }[] }).m_Options.map((o) => o.m_Text);

describe('TMP_Dropdown：標籤（RefreshShownValue :515-558）', () => {
  it('Start（:475-482）跑完，標籤是 options[m_Value] 的文字', () => {
    const s = setup();
    // ExchangeMana：applyLocalization 已把 m_Options 套成英文，m_Value 1 → 'Right Click or Drag'
    expect(optionTexts(s.file, MANA_DROPDOWN)).toEqual(['Drag Only', 'Right Click or Drag', 'Right Click Only']);
    expect(s.captionOf(MANA_DROPDOWN)).toBe('Right Click or Drag');
    // Language 的選項沒有在地化綁定（各語言自名），m_Value 0 → 存檔的第一個
    expect(s.captionOf(LOCALE_DROPDOWN)).toBe('简体中文');
  });

  it('SetValue 值相同不觸發 onValueChanged（:437）', () => {
    const s = setup();
    const dd = s.dropdown(MANA_DROPDOWN);
    expect(dd.value).toBe(1);
    dd.setValue(1);
    expect(s.calls).toEqual([]); // 值相同直接 return
    expect(s.captionOf(MANA_DROPDOWN)).toBe('Right Click or Drag');
  });

  it('SetValue 不同值：clamp、refresh、觸發 onValueChanged（:435-453）', () => {
    const s = setup();
    const dd = s.dropdown(MANA_DROPDOWN);
    dd.setValue(0);
    expect(dd.value).toBe(0);
    expect(s.captionOf(MANA_DROPDOWN)).toBe('Drag Only');
    expect(s.calls).toEqual([['ManaConvertValueChanged', 0]]);
    // Mathf.Clamp(value, 0, options.Count - 1)（:443，m_Placeholder 是 null）
    s.calls.length = 0;
    dd.setValue(99);
    expect(dd.value).toBe(2);
    expect(s.captionOf(MANA_DROPDOWN)).toBe('Right Click Only');
    expect(s.calls).toEqual([['ManaConvertValueChanged', 2]]);
  });

  it('SetValueWithoutNotify 不觸發事件（:430-433）', () => {
    const s = setup();
    const dd = s.dropdown(MANA_DROPDOWN);
    dd.setValueWithoutNotify(2);
    expect(dd.value).toBe(2);
    expect(s.captionOf(MANA_DROPDOWN)).toBe('Right Click Only');
    expect(s.calls).toEqual([]);
  });

  it('options 沒有選項時 SetValue 直接 return（:437）', () => {
    const s = setup();
    const dd = s.dropdown(MANA_DROPDOWN);
    dd.clearOptions();
    dd.setValue(2);
    expect(s.calls).toEqual([]);
    expect(dd.value).toBe(0); // ClearOptions（:637）把 m_Value 設回 0（m_Placeholder null）
    // options.Count === 0 → data 是 s_NoOptionData（:369），text null → 標籤空字串（:543-544）
    expect(s.captionOf(MANA_DROPDOWN)).toBe('');
  });

  it('ClearOptions ＋ AddOptions 之後 refresh（:634-639、:608-614）；數字選項轉字串', () => {
    const s = setup();
    const dd = s.dropdown(FPS_DROPDOWN);
    // PauseMenu.GenerateDropDownOptions（UI/PauseMenu.cs:593-594）：_maxFpsDict.Values.Select(fps => fps.ToString())
    dd.clearOptions();
    dd.addOptions([24, 30, 60, 120].map((fps) => fps.toString()));
    expect(optionTexts(s.file, FPS_DROPDOWN)).toEqual(['24', '30', '60', '120']);
    expect(dd.value).toBe(0);
    expect(s.captionOf(FPS_DROPDOWN)).toBe('24'); // AddOptions 結尾的 RefreshShownValue（:613）
    dd.setValue(2);
    expect(s.captionOf(FPS_DROPDOWN)).toBe('60');
    expect(s.calls).toEqual([['MaxFPSDropdownValueChanged', 2]]);
  });

  it('存檔的數字 m_Text 照 C# 型別轉字串：MaxFPS 的選項在 level1.json 裡是 JSON 整數（24/30/60/120）', () => {
    const s = setup();
    const dd = s.dropdown(FPS_DROPDOWN);
    // OptionData.m_Text 是 string（TMP_Dropdown.cs:59-60）；AssetRipper 把 C# 的 string 匯出成 JSON number，
    // options 讀出來時轉回字串，TMP 才產得出網格（text-check 的 a 驗這個）
    expect(dd.options.map((o) => o.m_Text)).toEqual(['24', '30', '60', '120']);
    expect(typeof dd.options[0].m_Text).toBe('string');
    // 標籤是 options[m_Value 0]（Start 的 RefreshShownValue）
    expect(s.captionOf(FPS_DROPDOWN)).toBe('24');
  });

  it('setOptions 換掉整個陣列也會 refresh（options setter :299-303）', () => {
    const s = setup();
    const dd = s.dropdown(FPS_DROPDOWN);
    dd.setOptions([{ m_Text: 'AAA', m_Image: null, m_Color: { r: 1, g: 1, b: 1, a: 1 } }]);
    expect(dd.options.length).toBe(1);
    // m_Value 0 仍在範圍內 → 標籤變新選項（setter 不 clamp，RefreshShownValue 才 clamp）
    expect(s.captionOf(FPS_DROPDOWN)).toBe('AAA');
  });
});

describe('TMP_Dropdown：展開與收合（Show :777-975、Hide :1190-1209）', () => {
  it('Show 建出清單：每個選項一個 item，Content 的第 0 個子物件是範本', () => {
    const s = setup();
    const dd = s.dropdown(LOCALE_DROPDOWN);
    expect(dd.isExpanded).toBe(false);
    dd.show();
    expect(dd.isExpanded).toBe(true); // IsExpanded（:455）＝ m_Dropdown != null
    const list = s.graph.nodes.values();
    const dropdownList = [...list].find((n) => n.go.m_Name === 'Dropdown List')!;
    expect(dropdownList).toBeDefined();
    // Content ＝ item 的父物件；子物件 ＝ [範本 Item（關掉）、Item 0…Item 5]
    const content = dropdownList.children.find((n) => n.go.m_Name === 'Viewport')!.children.find((n) => n.go.m_Name === 'Content')!;
    const itemTemplate = content.children[0];
    expect(itemTemplate.go.m_Name).toBe('Item');
    expect(content.children.length).toBe(7);
    expect(content.children[0]).toBe(itemTemplate);
    expect(itemTemplate.activeInHierarchy).toBe(false); // :972 itemTemplate.gameObject.SetActive(false)
    expect(content.children.slice(1).map((n) => n.go.m_Name)).toEqual([
      'Item 0: 简体中文',
      'Item 1: English',
      'Item 2: Español',
      'Item 3: Português (Brasil)',
      'Item 4: Русский',
      'Item 5: 日本語 (beta)',
    ]);
    // 每個 item 的 TMP 文字是選項文字（AddItem :1147-1148）
    const labels = content.children.slice(1).map((n) => {
      const label = n.children.find((c) => c.go.m_Name === 'Item Label')!;
      return (s.graph.component(label, 'TextMeshProUGUI') as ComponentData).m_text;
    });
    expect(labels).toEqual(optionTexts(s.file, LOCALE_DROPDOWN));
    // 目前選到的那個 toggle isOn（:897）；Language 的 m_Value 0 → 第 0 個
    const isOn = content.children.slice(1).map((n) => {
      const c = s.graph.component(n, 'Toggle') as ComponentData;
      return !!c.m_IsOn;
    });
    expect(isOn).toEqual([true, false, false, false, false, false]);
  });

  it('Show 把 Content 高度設成 itemSize.y × 項目數 ＋ offsetMin.y − offsetMax.y（:924-927）', () => {
    const s = setup();
    const dd = s.dropdown(LOCALE_DROPDOWN);
    dd.show();
    const list = [...s.graph.nodes.values()].find((n) => n.go.m_Name === 'Dropdown List')!;
    const content = list.children.find((n) => n.go.m_Name === 'Viewport')!.children.find((n) => n.go.m_Name === 'Content')!;
    const tf = content.transform as RectTransformData;
    // item 高 45、6 個選項；offsetMin.y 與 offsetMax.y 都是 0（item 的 pivot 0.5 對 Content 的 pivot 0.5,1）
    expect(tf.m_SizeDelta.y).toBeCloseTo(45 * 6, 3);
    // extraSpace ＝ 清單高 − 內容高 ＝ 291.18 − 270 ＝ 21.18 ＞ 0 → 清單 sizeDelta.y 扣掉（:929-931）
    const listTf = list.transform as RectTransformData;
    expect(listTf.m_SizeDelta.y).toBeCloseTo(291.18 - 21.18, 2);
    expect(list.rect.height).toBeCloseTo(270, 2);
  });

  it('Show 之後 Template 關掉、範本上有 Canvas（sortingOrder 30000）與 CanvasGroup（SetupTemplate :701-723）', () => {
    const s = setup();
    const dd = s.dropdown(LOCALE_DROPDOWN);
    const template = s.graph.nodeOfComponent(((s.file.components[LOCALE_DROPDOWN] as ComponentData).m_Template as { fileID: string }).fileID)!;
    expect(template.activeInHierarchy).toBe(false); // 存檔裡就是關的
    dd.show();
    expect(template.activeInHierarchy).toBe(false); // :971 m_Template.gameObject.SetActive(false)
    const canvas = s.graph.component(template, 'Canvas') as ComponentData;
    expect(canvas).toBeDefined();
    expect(canvas.m_OverrideSorting).toBe(1);
    expect(canvas.m_SortingOrder).toBe(30000); // :702-703
    expect(s.graph.component(template, 'GraphicRaycaster')).toBeDefined(); // :706-721 照父 Canvas 的 raycaster 種類
    expect(s.graph.component(template, 'CanvasGroup')).toBeDefined(); // :723
    // SetupTemplate 在範本的 Item 上加了 DropdownItem（:683）
    const item = template.children[0].children[0].children[0]; // Viewport/Content/Item
    expect(item.go.m_Name).toBe('Item');
    expect(s.graph.component(item, 'DropdownItem')).toBeDefined();
    // 複製出來的清單也有自己的 Canvas（複製範本的），sortingLayerID 照根 Canvas（:816）
    const list = [...s.graph.nodes.values()].find((n) => n.go.m_Name === 'Dropdown List')!;
    const rootCanvas = s.graph.nodes.get('335')!; // SettingCanvasMainMenu
    expect((s.graph.component(list, 'Canvas') as ComponentData).m_SortingLayerID).toBe(
      (s.graph.component(rootCanvas, 'Canvas') as ComponentData).m_SortingLayerID,
    );
  });

  it('CreateBlocker（:1008-1068）：蓋滿根 Canvas、Canvas 排在清單下一層、Image 全透明可擋射線、Button 接 Hide', () => {
    const s = setup();
    const dd = s.dropdown(LOCALE_DROPDOWN);
    dd.show();
    const rootCanvas = s.graph.nodes.get('335')!;
    const blocker = rootCanvas.children.find((n) => n.go.m_Name === 'Blocker')!;
    expect(blocker).toBeDefined();
    const btf = blocker.transform as RectTransformData;
    expect(btf.m_AnchorMin).toEqual({ x: 0, y: 0 }); // :1016-1018 anchorMin 0、anchorMax 1、sizeDelta 0
    expect(btf.m_AnchorMax).toEqual({ x: 1, y: 1 });
    expect(btf.m_SizeDelta).toEqual({ x: 0, y: 0 });
    expect(blocker.rect.width).toBeCloseTo(rootCanvas.rect.width, 3);
    expect(blocker.rect.height).toBeCloseTo(rootCanvas.rect.height, 3);
    const canvas = s.graph.component(blocker, 'Canvas') as ComponentData;
    expect(canvas.m_OverrideSorting).toBe(1);
    expect(canvas.m_SortingOrder).toBe(29999); // :1025 dropdownCanvas.sortingOrder - 1
    const image = s.graph.component(blocker, 'Image') as ComponentData;
    expect(image.m_Color).toEqual({ r: 0, g: 0, b: 0, a: 0 }); // :1061 Color.clear
    expect(image.m_RaycastTarget).toBe(1);
    expect(s.graph.component(blocker, 'Button')).toBeDefined(); // :1064
    // 點 blocker → Hide（:1065 onClick.AddListener(Hide)）。直接呼叫 Button 的 OnPointerClick：
    // blocker 的 Canvas 是 World Space 根 Canvas 的子 Canvas，射線座標換算不是這條測試要驗的東西
    const nodesBefore = s.graph.nodes.size;
    const button = s.world.behaviour<{ onPointerClick?(b: number): void }>(s.graph.component(blocker, 'Button') as ComponentData)!;
    button.onPointerClick?.(0);
    expect(dd.isExpanded).toBe(true); // Hide 是延後銷毀（DelayedDestroyDropdownList），當下還在
    for (let i = 0; i < 20; i++) s.world.tick(1 / 60);
    expect(dd.isExpanded).toBe(false);
    expect(s.graph.nodes.size).toBeLessThan(nodesBefore);
  });

  it('選一個選項：value 改變、觸發 onValueChanged、清單收合（OnSelectItem :1293-1301）', () => {
    const s = setup();
    const dd = s.dropdown(MANA_DROPDOWN);
    expect(dd.value).toBe(1);
    dd.show();
    const list = [...s.graph.nodes.values()].find((n) => n.go.m_Name === 'Dropdown List')!;
    const content = list.children.find((n) => n.go.m_Name === 'Viewport')!.children.find((n) => n.go.m_Name === 'Content')!;
    expect(content.children.length).toBe(4); // 範本 ＋ 3 個選項
    const item0 = content.children[1];
    expect(item0.go.m_Name).toBe('Item 0: Drag Only');
    const toggle = s.world.behaviour<ToggleBehaviour>(s.graph.component(item0, 'Toggle') as ComponentData)!;
    expect(toggle.isOn).toBe(false);
    // Toggle.OnPointerClick → InternalToggle → Set(true) → onValueChanged → OnSelectItem
    toggle.isOn = true;
    expect(dd.value).toBe(0);
    expect(s.captionOf(MANA_DROPDOWN)).toBe('Drag Only');
    expect(s.calls).toEqual([['ManaConvertValueChanged', 0]]);
    // Hide：先淡出，alphaFadeSpeed（0.15）之後才銷毀（:1196-1200、:1211-1215）
    expect(dd.isExpanded).toBe(true);
    for (let i = 0; i < 20; i++) s.world.tick(1 / 60);
    expect(dd.isExpanded).toBe(false);
  });

  it('展開收合各一次之後節點數回到展開前（ImmediateDestroyDropdownList :1217-1235）', () => {
    const s = setup();
    const dd = s.dropdown(LOCALE_DROPDOWN);
    const nodes0 = s.graph.nodes.size;
    const gos0 = Object.keys(s.file.gameObjects).length;
    const comps0 = Object.keys(s.file.components).length;
    dd.show();
    expect(s.graph.nodes.size).toBeGreaterThan(nodes0);
    dd.hide();
    for (let i = 0; i < 30; i++) s.world.tick(1 / 60);
    expect(dd.isExpanded).toBe(false);
    // 清單與 blocker 都清乾淨。範本上 SetupTemplate 加的元件（Canvas／GraphicRaycaster／CanvasGroup／DropdownItem）
    // 照原版留著——SetupTemplate 只跑一次（validTemplate），第二次 Show 直接重用
    const list = [...s.graph.nodes.values()].find((n) => n.go.m_Name === 'Dropdown List');
    expect(list).toBeUndefined();
    expect([...s.graph.nodes.values()].find((n) => n.go.m_Name === 'Blocker')).toBeUndefined();
    expect(s.graph.nodes.size).toBe(nodes0);
    expect(Object.keys(s.file.gameObjects).length).toBe(gos0);
    // 元件多了 SetupTemplate 加的 4 個：Template 的 Canvas、GraphicRaycaster、CanvasGroup，Item 的 DropdownItem
    expect(Object.keys(s.file.components).length).toBe(comps0 + 4);
    // 再展開一次：不再加元件，節點數與第一次相同
    const nodes1 = s.graph.nodes.size;
    dd.show();
    expect(s.graph.nodes.size).toBeGreaterThan(nodes1);
    dd.hide();
    for (let i = 0; i < 30; i++) s.world.tick(1 / 60);
    expect(s.graph.nodes.size).toBe(nodes1);
    expect(Object.keys(s.file.components).length).toBe(comps0 + 4);
  });

  it('AlphaFadeList（:1161-1176）：CanvasGroup 的 alpha 從 0 淡到 1，收合時淡回 0', () => {
    const s = setup();
    const dd = s.dropdown(LOCALE_DROPDOWN);
    dd.show();
    const list = [...s.graph.nodes.values()].find((n) => n.go.m_Name === 'Dropdown List')!;
    const group = s.graph.component(list, 'CanvasGroup') as ComponentData;
    // TweenRunner.StartTween 當下就跑到第一個 yield，用的是「這一幀」的 deltaTime；
    // 這裡 show() 是在任何 tick 之前呼叫的，world.deltaTime 還是 0 → alpha 仍在起始值 0
    expect(group.m_Alpha as number).toBe(0);
    s.world.tick(1 / 60);
    expect(group.m_Alpha as number).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) s.world.tick(1 / 60);
    expect(group.m_Alpha as number).toBeCloseTo(1, 5);
    dd.hide();
    for (let i = 0; i < 5; i++) s.world.tick(1 / 60);
    expect(group.m_Alpha as number).toBeLessThan(1);
    expect(group.m_Alpha as number).toBeGreaterThan(0);
  });

  it('OnDisable（:496-507）：物件停用時立刻銷毀清單與 blocker', () => {
    const s = setup();
    const dd = s.dropdown(LOCALE_DROPDOWN);
    dd.show();
    expect(dd.isExpanded).toBe(true);
    const dropdownNode = s.graph.nodes.get('397')!;
    s.graph.setActive(dropdownNode, false);
    s.world.refreshEnables(); // C# 的 SetActive 同步觸發 OnDisable
    expect(dd.isExpanded).toBe(false); // ImmediateDestroyDropdownList，不等 alphaFadeSpeed
    expect([...s.graph.nodes.values()].find((n) => n.go.m_Name === 'Blocker')).toBeUndefined();
  });
});

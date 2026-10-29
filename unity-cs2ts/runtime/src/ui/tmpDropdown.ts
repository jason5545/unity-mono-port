// TMP_Dropdown：設定面板 5 個下拉選單（語言、操作方式、解析度、全螢幕、FPS）的標籤、展開與收合。
// 對應 reference/tmp-src/pre.4/package/Scripts/Runtime/TMP_Dropdown.cs（3.2.0-pre.4，10/6 讀全文）：
//   DropdownItem（:24-51）、OptionData（:57-105）、options（:299-303）、value／SetValue（:414-453）、
//   IsExpanded（:455）、Awake（:461-473）、Start（:475-482）、OnDisable（:496-507）、
//   RefreshShownValue（:515-558）、AddOptions（:567-629）、ClearOptions（:634-639）、
//   SetupTemplate（:641-727）、GetOrAddComponent（:729-735）、OnPointerClick（:741-744）、
//   OnSubmit（:750-753）、OnCancel（:762-765）、Show（:777-975）、IsEverythingValue（:977-987）、
//   EverythingValue（:989-998）、CreateBlocker（:1008-1068）、DestroyBlocker（:1077-1080）、
//   CreateDropdownList（:1090-1093）、DestroyDropdownList（:1102-1105）、CreateItem（:1116-1119）、
//   DestroyItem（:1129）、AddItem（:1132-1159）、AlphaFadeList（:1161-1176）、SetAlpha（:1178-1185）、
//   Hide（:1190-1209）、DelayedDestroyDropdownList（:1211-1215）、ImmediateDestroyDropdownList（:1217-1235）、
//   OnSelectItem（:1238-1302）、FirstActiveFlagIndex（:1304-1315）。
// 其他原始碼依據：
//   RectTransformUtility.FlipLayoutOnAxis — reference/decompiled/UnityEngine.UIModule/UnityEngine/RectTransformUtility.cs:128-160；
//   Selectable.Select — reference/decompiled/UnityEngine.UI/UnityEngine.UI/Selectable.cs:684-690；
//   Navigation.Mode.Explicit ＝ 4（UnityEngine.UI/Selectable.cs 的 Navigation 列舉）；
//   FloatTween／TweenRunner — UnityEngine.UI.CoroutineTween，做法同 src/runtime/ui/colorTween.ts。
// 執行時期的複製、銷毀、AddComponent、程式建物件用 src/runtime/unity/instantiate.ts。
// 與原版的差異：OnSubmit／OnCancel（ISubmitHandler／ICancelHandler）沒有輸入路徑——events.ts 目前
// 只派送指標事件，沒有 Submit／Cancel；這兩個方法照原始碼實作出來放在 behaviour 上，等輸入模組接。

import { Vector3 } from 'three';
import type { BehaviourContext, BehaviourRegistry, Coroutine, World } from '../engine/world';
import type { SceneNode } from '../unity/scene';
import type { ColorRGBA, ComponentData, Ref, RectTransformData } from '../unity/types';
import { addComponent, createGameObject, destroy, instantiate, setActive } from '../unity/instantiate';
import { invokePersistentCalls } from '../unity/unityEvents';
import { layoutRect } from './rectTransform';
import { selectableBehaviour, type SelectableBase } from './selectable';
import type { ToggleBehaviour } from './toggle';

/** TMP_Dropdown.OptionData（:57-105）。欄位名稱照場景 JSON（m_Text／m_Image／m_Color） */
export interface DropdownOptionData {
  m_Text: string | null;
  m_Image: Ref;
  m_Color: ColorRGBA;
}

/** s_NoOptionData（:369）＝ new OptionData()：text 與 image 是 null，m_Color 的欄位初始值是 Color.white（:64） */
const NO_OPTION_DATA = (): DropdownOptionData => ({ m_Text: null, m_Image: null, m_Color: { r: 1, g: 1, b: 1, a: 1 } });
/** k_NothingOption／k_EverythingOption／k_MixedOption（:137-139），多選模式用 */
const NOTHING_OPTION = (): DropdownOptionData => ({ ...NO_OPTION_DATA(), m_Text: 'Nothing' });
const EVERYTHING_OPTION = (): DropdownOptionData => ({ ...NO_OPTION_DATA(), m_Text: 'Everything' });
const MIXED_OPTION = (): DropdownOptionData => ({ ...NO_OPTION_DATA(), m_Text: 'Mixed...' });

const clamp = (v: number, min: number, max: number): number => Math.min(Math.max(v, min), max);
const clamp01 = (v: number): number => clamp(v, 0, 1);

/** Mathf.Approximately（UnityEngine.CoreModule）：Abs(b-a) < Max(1e-6 * Max(Abs(a),Abs(b)), Epsilon * 8) */
function approximately(a: number, b: number): boolean {
  return Math.abs(b - a) < Math.max(1e-6 * Math.max(Math.abs(a), Math.abs(b)), 1.401298e-45 * 8);
}

/** Mathf.IsPowerOfTwo（UnityEngine.CoreModule） */
function isPowerOfTwo(v: number): boolean {
  return v > 0 && (v & (v - 1)) === 0;
}

/** FirstActiveFlagIndex（:1304-1315） */
function firstActiveFlagIndex(value: number): number {
  if (value === 0) return 0;
  for (let i = 0; i < 32; i++) if ((value & (1 << i)) !== 0) return i;
  return 0;
}

/** IsEverythingValue（:977-987） */
function isEverythingValue(count: number, value: number): boolean {
  let result = true;
  for (let i = 0; i < count; i++) if ((value & (1 << i)) === 0) result = false;
  return result;
}

/** EverythingValue（:989-998） */
function everythingValue(count: number): number {
  let result = 0;
  for (let i = 0; i < count; i++) result |= 1 << i;
  return result;
}

/** RectTransformUtility.FlipLayoutOnAxis(rect, axis, keepPositioning: false, recursive: false)
 *  （RectTransformUtility.cs:128-160）：pivot 與 anchoredPosition 該軸翻號、anchorMin/Max 該軸對調，sizeDelta 不動 */
function flipLayoutOnAxis(tf: RectTransformData, axis: 0 | 1): void {
  const pivot = { ...tf.m_Pivot };
  const ap = { ...tf.m_AnchoredPosition };
  const amin = { ...tf.m_AnchorMin };
  const amax = { ...tf.m_AnchorMax };
  if (axis === 0) {
    pivot.x = 1 - pivot.x;
    ap.x = -ap.x;
    const min = amin.x;
    amin.x = 1 - amax.x;
    amax.x = 1 - min;
  } else {
    pivot.y = 1 - pivot.y;
    ap.y = -ap.y;
    const min = amin.y;
    amin.y = 1 - amax.y;
    amax.y = 1 - min;
  }
  tf.m_Pivot = pivot;
  tf.m_AnchoredPosition = ap;
  tf.m_AnchorMin = amin;
  tf.m_AnchorMax = amax;
}

/** RectTransform.GetWorldCorners：rect 四角經世界矩陣（順序照 Unity：左下、左上、右上、右下） */
function worldCorners(n: SceneNode): Vector3[] {
  const r = n.rect;
  return [
    new Vector3(r.x, r.y, 0),
    new Vector3(r.x, r.y + r.height, 0),
    new Vector3(r.x + r.width, r.y + r.height, 0),
    new Vector3(r.x + r.width, r.y, 0),
  ].map((v) => v.applyMatrix4(n.world));
}

/** TweenRunner<FloatTween>（UnityEngine.UI.CoroutineTween）：跑在 world.coroutines 裡。
 *  結構照 colorTween.ts 的 ColorTweenRunner——StartTween 當下先跑到第一個 yield（用這一幀的 deltaTime），
 *  之後每幀恢復；容器（TMP_Dropdown 自己）沒啟用時直接跳到結束值。 */
class FloatTweenRunner implements Coroutine {
  private start = 0;
  private target = 0;
  private duration = 0;
  private elapsed = 0;
  private apply: ((v: number) => void) | null = null;

  constructor(
    private readonly world: World,
    private readonly host: SceneNode,
  ) {}

  /** TweenRunner.StartTween ＋ Start 協程跑到第一個 yield 之前（FloatTween.TweenValue ＝ Mathf.Lerp） */
  startTween(duration: number, start: number, target: number, apply: (v: number) => void): void {
    this.stopTween();
    this.apply = apply;
    this.duration = duration;
    this.start = start;
    this.target = target;
    if (!this.host.activeInHierarchy) {
      apply(target);
      return;
    }
    if (!(0 < duration)) {
      apply(target);
      return;
    }
    this.elapsed = this.world.deltaTime;
    apply(this.start + (this.target - this.start) * clamp01(this.elapsed / this.duration));
    this.world.coroutines.add(this);
  }

  /** 協程每幀恢復：回 false 表示結束（World.tick 會把它從 coroutines 移除） */
  step(dt: number): boolean {
    if (!this.apply) return false;
    if (this.elapsed < this.duration) {
      this.elapsed += dt;
      this.apply(this.start + (this.target - this.start) * clamp01(this.elapsed / this.duration));
      return true;
    }
    this.apply(this.target);
    this.stopTween();
    return false;
  }

  stopTween(): void {
    this.apply = null;
    this.world.coroutines.delete(this);
  }
}

/** 清單裡的一個選項（TMP_Dropdown.DropdownItem，:24-51） */
interface ItemInfo {
  node: SceneNode;
  comp: ComponentData;
  toggleComp: ComponentData | null;
  textComp: ComponentData | null;
  imageComp: ComponentData | null;
}

export interface TMPDropdownBehaviour extends SelectableBase {
  /** C# value getter（m_Value 原值；多選模式是位元旗標） */
  readonly value: number;
  /** C# value setter ＝ SetValue(v, sendCallback: true) */
  setValue(v: number): void;
  /** C# SetValueWithoutNotify（:430-433） */
  setValueWithoutNotify(v: number): void;
  /** C# IsExpanded（:455） */
  readonly isExpanded: boolean;
  /** C# options（:299-303）：m_Options.m_Options 那個陣列本身（AddRange／Clear 直接作用在它上面） */
  readonly options: DropdownOptionData[];
  /** C# options setter：換掉整個陣列再 RefreshShownValue */
  setOptions(list: DropdownOptionData[]): void;
  /** C# AddOptions(List<string>)（:608-614）：PauseMenu.GenerateDropDownOptions 用的是這個 */
  addOptions(list: string[]): void;
  /** C# ClearOptions（:634-639） */
  clearOptions(): void;
  /** C# RefreshShownValue（:515-558） */
  refreshShownValue(): void;
  /** C# Show（:777-975） */
  show(): void;
  /** C# Hide（:1190-1209） */
  hide(): void;
  /** C# OnSubmit（:750-753）；輸入模組還沒派送 Submit */
  submit(): void;
  /** C# OnCancel（:762-765）；輸入模組還沒派送 Cancel */
  cancel(): void;
}

export function tmpDropdown(ctx: BehaviourContext): TMPDropdownBehaviour {
  const { world, node, comp } = ctx;
  const graph = world.graph;
  const base = selectableBehaviour(ctx, 'extended');
  const baseStart = base.start;
  const baseDisable = base.onDisable;

  let dropdownNode: SceneNode | null = null; // m_Dropdown
  let blockerNode: SceneNode | null = null; // m_Blocker
  let items: ItemInfo[] = []; // m_Items
  let validTemplate = false;
  let delayedDestroy: Coroutine | null = null; // m_Coroutine
  let alphaTween: FloatTweenRunner | null = null; // m_AlphaTweenRunner

  // ───────── PPtr 存取 ─────────

  function compOf(ref: unknown): ComponentData | null {
    const fileID = (ref as { fileID?: string } | null)?.fileID;
    return fileID ? ((graph.file.components[fileID] as ComponentData) ?? null) : null;
  }
  function nodeOf(ref: unknown): SceneNode | null {
    const c = compOf(ref);
    return c ? (graph.nodes.get(c.gameObject) ?? null) : null;
  }
  /** 元件在它所在物件上的 id（建 {fileID} 參照用） */
  function compIdOf(c: ComponentData): string | null {
    const n = graph.nodes.get(c.gameObject);
    return n?.go.components.find((id) => graph.file.components[id] === c) ?? null;
  }

  const templateNode = (): SceneNode | null => nodeOf(comp.m_Template);
  const captionTextComp = (): ComponentData | null => compOf(comp.m_CaptionText);
  const captionImageComp = (): ComponentData | null => compOf(comp.m_CaptionImage);
  const placeholderComp = (): ComponentData | null => compOf(comp.m_Placeholder);
  const itemTextComp = (): ComponentData | null => compOf(comp.m_ItemText);
  const itemImageComp = (): ComponentData | null => compOf(comp.m_ItemImage);

  const isMultiSelect = (): boolean => !!comp.m_MultiSelect;
  /** C# 的 options（:299-303）。MaxFPS 的存檔 m_Options.m_Options[i].m_Text 是 JSON 數字
   *  （AssetRipper 把 C# 的 string 匯出成 number；OptionData.m_Text 是 string，:59-60），
   *  照 C# 型別就地轉字串一次，TMP 才拿得到字串 */
  function optionsList(): DropdownOptionData[] {
    const list = (comp.m_Options as { m_Options: DropdownOptionData[] }).m_Options;
    for (const o of list) if (o.m_Text !== null && typeof o.m_Text !== 'string') o.m_Text = String(o.m_Text);
    return list;
  }

  /** Transform.IsChildOf：自己或任一層父物件是 target */
  function isChildOf(n: SceneNode | null | undefined, target: SceneNode): boolean {
    for (let p = n; p; p = p.parent) if (p === target) return true;
    return false;
  }

  /** GetComponentInChildren<T>（includeInactive: false）：深度優先找第一個 script.class／type 符合的元件 */
  function componentInChildren<T extends ComponentData>(root: SceneNode, kind: string): { comp: T; node: SceneNode } | null {
    const visit = (n: SceneNode): { comp: T; node: SceneNode } | null => {
      if (n.activeInHierarchy) {
        const c = graph.component(n, kind) as T | undefined;
        if (c) return { comp: c, node: n };
      }
      for (const ch of n.children) {
        const found = visit(ch);
        if (found) return found;
      }
      return null;
    };
    return visit(root);
  }

  /** SetupTemplate（:689-699）與 CreateBlocker（:1027-1037）用的「往上第一個有 Canvas 的父物件」（不含自己） */
  function parentCanvasOf(n: SceneNode): SceneNode | null {
    for (let p = n.parent; p; p = p.parent) if (graph.component(p, 'Canvas')) return p;
    return null;
  }

  /** Show（:788-804）：GetComponentsInParent<Canvas> 裡 isRootCanvas 的那個＝最上層那個 */
  function rootCanvasOf(n: SceneNode): SceneNode | null {
    let found: SceneNode | null = null;
    for (let p: SceneNode | null = n; p; p = p.parent) if (graph.component(p, 'Canvas')) found = p;
    return found;
  }

  /** GetOrAddComponent<T>（:729-735） */
  function getOrAddComponent(n: SceneNode, kind: string, make: () => ComponentData): ComponentData {
    const existing = graph.component(n, kind);
    return existing ?? addComponent(world, n, make());
  }

  /** 新增一個 Canvas（巢狀、overrideSorting）。m_RenderMode 與 m_AdditionalShaderChannelsFlag 照父 Canvas：
   *  SceneGraph.layout 對巢狀 Canvas 用的是父 Canvas 的 renderMode，這裡把資料也對齊免得除錯時誤導。 */
  function makeCanvas(parentCanvas: SceneNode | null, sortingOrder: number): ComponentData {
    const pc = parentCanvas ? (graph.component(parentCanvas, 'Canvas') as ComponentData) : null;
    return {
      type: 'Canvas',
      classID: 223,
      gameObject: '',
      m_Enabled: 1,
      m_RenderMode: (pc?.m_RenderMode as number) ?? 2,
      m_Camera: null,
      m_PlaneDistance: 0,
      m_PixelPerfect: 0,
      m_ReceivesEvents: 1,
      m_OverrideSorting: 1,
      m_OverridePixelPerfect: 0,
      m_SortingBucketNormalizedSize: 0,
      m_VertexColorAlwaysGammaSpace: 0,
      m_AdditionalShaderChannelsFlag: (pc?.m_AdditionalShaderChannelsFlag as number) ?? 25,
      m_UpdateRectTransformForStandalone: 0,
      m_SortingLayerID: (pc?.m_SortingLayerID as number) ?? 0,
      m_SortingOrder: sortingOrder,
      m_TargetDisplay: (pc?.m_TargetDisplay as number) ?? 0,
    } as ComponentData;
  }

  /** AddComponent(raycasterType)：照父 Canvas 上 BaseRaycaster 的「種類」各加一個（:706-717、:1040-1051）；
   *  沒有父 Canvas 才補一個 GraphicRaycaster（:718-721、:1052-1056）。
   *  UnityEngine.UI 的 BaseRaycaster 子類只有 GraphicRaycaster 與 PhysicalRaycaster2D（本場景用前者）。
   *  欄位用 Unity 的預設值；events.ts 的 raycasterEnabled 只看元件在不在與 m_Enabled。 */
  function addRaycasters(target: SceneNode, parentCanvas: SceneNode | null): void {
    const addOne = (kind: string): void => {
      if (graph.component(target, kind)) return;
      addComponent(world, target, {
        type: 'MonoBehaviour',
        classID: 114,
        gameObject: '',
        m_Enabled: 1,
        script: { assembly: 'UnityEngine.UI', namespace: 'UnityEngine.UI', class: kind },
        m_IgnoreReversedGraphics: 1,
        m_BlockingObjects: 0,
        m_BlockingMask: { serializedVersion: 2, m_Bits: 4294967295 },
      } as ComponentData);
    };
    if (!parentCanvas) {
      addOne('GraphicRaycaster');
      return;
    }
    for (const c of graph.components(parentCanvas)) {
      const cls = c.script?.class ?? '';
      if (cls === 'GraphicRaycaster' || cls === 'PhysicalRaycaster2D') addOne(cls);
    }
  }

  /** GetOrAddComponent<CanvasGroup>（:723）；欄位形狀照場景資料裡既有的 CanvasGroup */
  function makeCanvasGroup(): ComponentData {
    return {
      type: 'CanvasGroup',
      classID: 225,
      gameObject: '',
      m_Enabled: 1,
      m_Alpha: 1,
      m_Interactable: 1,
      m_BlocksRaycasts: 1,
      m_IgnoreParentGroups: 0,
    } as ComponentData;
  }

  function canvasGroupAlpha(): number {
    const g = dropdownNode ? graph.component(dropdownNode, 'CanvasGroup') : null;
    return g ? ((g.m_Alpha as number) ?? 1) : 1;
  }

  /** SetAlpha（:1178-1185） */
  function setAlpha(alpha: number): void {
    if (!dropdownNode) return;
    const g = graph.component(dropdownNode, 'CanvasGroup');
    if (g) g.m_Alpha = alpha;
  }

  /** AlphaFadeList（:1161-1176）：end 等於 start 直接 return */
  function alphaFadeList(duration: number, start: number, end: number): void {
    if (end === start) return;
    alphaTween?.startTween(duration, start, end, setAlpha);
  }

  // ───────── value／options ─────────

  /** SetValue（:435-453）。Application.isPlaying 在這個移植裡恆真 */
  function setValue(value: number, sendCallback = true): void {
    if (value === (comp.m_Value as number) || optionsList().length === 0) return;
    if (isMultiSelect()) comp.m_Value = value;
    else comp.m_Value = clamp(value, comp.m_Placeholder ? -1 : 0, optionsList().length - 1);
    refreshShownValue();
    if (sendCallback) invokePersistentCalls(world, comp, 'm_OnValueChanged', comp.m_Value as number, 'onValueChanged');
  }

  /** RefreshShownValue（:515-558） */
  function refreshShownValue(): void {
    const opts = optionsList();
    const value = comp.m_Value as number;
    let data: DropdownOptionData = NO_OPTION_DATA();
    if (opts.length > 0) {
      if (isMultiSelect()) {
        const firstActiveFlag = firstActiveFlagIndex(value);
        if (value === 0 || firstActiveFlag >= opts.length) data = NOTHING_OPTION();
        else if (isEverythingValue(opts.length, value)) data = EVERYTHING_OPTION();
        else if (isPowerOfTwo(value) && value > 0) data = opts[firstActiveFlag];
        else data = MIXED_OPTION();
      } else if (value >= 0) {
        data = opts[clamp(value, 0, opts.length - 1)];
      }
    }
    const caption = captionTextComp();
    // TMP_Text.text 不接受 null；:541-544 也是「data.text 是 null 就設空字串」
    if (caption) caption.m_text = data.m_Text ?? '';
    const captionImage = captionImageComp();
    if (captionImage) {
      captionImage.m_Sprite = data.m_Image;
      captionImage.m_Color = { ...data.m_Color };
      captionImage.m_Enabled = data.m_Image !== null && data.m_Color.a > 0 ? 1 : 0;
    }
    const placeholder = placeholderComp();
    if (placeholder) placeholder.m_Enabled = opts.length === 0 || value === -1 ? 1 : 0;
  }

  // ───────── SetupTemplate ─────────

  /** SetupTemplate（:641-727）：驗範本、在範本的 Item 上加 DropdownItem、給範本加 Canvas／Raycaster／CanvasGroup。
   *  注意它會改場景裡的 Template（加元件），而且只在第一次 Show 時跑一次（validTemplate）。 */
  function setupTemplate(): void {
    validTemplate = false;
    const t = templateNode();
    if (!t) {
      world.notes.add('TMP_Dropdown 沒有指定 Template（:645-649 的 Debug.LogError）');
      return;
    }
    setActive(world, t, true);
    const itemToggle = componentInChildren(t, 'Toggle');
    validTemplate = true;
    const itemText = itemTextComp();
    const itemImage = itemImageComp();
    if (!itemToggle || itemToggle.node === t) {
      validTemplate = false;
      world.notes.add('TMP_Dropdown 的 Template 裡沒有當 item 的 Toggle（:656-660）');
    } else if (!itemToggle.node.parent?.isRect) {
      validTemplate = false;
      world.notes.add('TMP_Dropdown 的 item 父物件沒有 RectTransform（:661-665）');
    } else if (itemText && !isChildOf(graph.nodes.get(itemText.gameObject), itemToggle.node)) {
      validTemplate = false;
      world.notes.add('TMP_Dropdown 的 Item Text 不在 item 底下（:666-670）');
    } else if (itemImage && !isChildOf(graph.nodes.get(itemImage.gameObject), itemToggle.node)) {
      validTemplate = false;
      world.notes.add('TMP_Dropdown 的 Item Image 不在 item 底下（:671-675）');
    }
    if (!validTemplate || !itemToggle) {
      setActive(world, t, false);
      return;
    }

    // itemToggle.gameObject.AddComponent<DropdownItem>()（:683-687）
    addComponent(world, itemToggle.node, {
      type: 'MonoBehaviour',
      classID: 114,
      gameObject: '',
      m_Enabled: 1,
      script: { assembly: 'Unity.TextMeshPro', namespace: 'TMPro', class: 'DropdownItem' },
      m_Text: (comp.m_ItemText as Ref) ?? null,
      m_Image: (comp.m_ItemImage as Ref) ?? null,
      m_RectTransform: { fileID: itemToggle.node.go.transform },
      m_Toggle: { fileID: compIdOf(itemToggle.comp) ?? '' },
    } as ComponentData);

    const parentCanvas = parentCanvasOf(t);
    const popupCanvas = getOrAddComponent(t, 'Canvas', () => makeCanvas(parentCanvas, 30000));
    popupCanvas.m_OverrideSorting = 1;
    popupCanvas.m_SortingOrder = 30000;
    addRaycasters(t, parentCanvas);
    getOrAddComponent(t, 'CanvasGroup', makeCanvasGroup);
    setActive(world, t, false);
    validTemplate = true;
  }

  // ───────── 清單與項目 ─────────

  /** AddItem（:1132-1159）：CreateItem ＝ Instantiate(itemTemplate)，接在 itemTemplate 的父物件（Content）底下 */
  function addItem(data: DropdownOptionData, itemTemplate: ItemInfo, out: ItemInfo[]): ItemInfo | null {
    const clone = instantiate(world, itemTemplate.node, itemTemplate.node.parent);
    const di = graph.component(clone, 'DropdownItem');
    if (!di) return null;
    const item: ItemInfo = {
      node: clone,
      comp: di,
      toggleComp: compOf(di.m_Toggle),
      textComp: compOf(di.m_Text),
      imageComp: compOf(di.m_Image),
    };
    setActive(world, clone, true);
    clone.go.m_Name = `Item ${out.length}` + (data.m_Text !== null ? `: ${data.m_Text}` : '');
    const toggle = toggleOf(item);
    if (toggle) toggle.isOn = false; // :1141-1144 是 setter（會跑 Set），此時還沒接監聽
    if (item.textComp) item.textComp.m_text = data.m_Text ?? '';
    if (item.imageComp) {
      item.imageComp.m_Sprite = data.m_Image;
      item.imageComp.m_Color = { ...data.m_Color };
      item.imageComp.m_Enabled = data.m_Image !== null && data.m_Color.a > 0 ? 1 : 0;
    }
    out.push(item);
    return item;
  }

  function toggleOf(item: ItemInfo): ToggleBehaviour | undefined {
    return item.toggleComp ? world.behaviour<ToggleBehaviour>(item.toggleComp) : undefined;
  }

  /** Show（:905-920）的 explicit navigation：prev 與 item 互指，mode ＝ Explicit（4） */
  function linkNavigation(a: ComponentData, b: ComponentData): void {
    const an = a.m_Navigation as Record<string, unknown>;
    const bn = b.m_Navigation as Record<string, unknown>;
    an.m_Mode = 4;
    bn.m_Mode = 4;
    an.m_SelectOnDown = { fileID: compIdOf(b) };
    an.m_SelectOnRight = { fileID: compIdOf(b) };
    bn.m_SelectOnLeft = { fileID: compIdOf(a) };
    bn.m_SelectOnUp = { fileID: compIdOf(a) };
  }

  /** CreateBlocker（:1008-1068）：程式建一個蓋滿根 Canvas 的物件，Canvas 排在清單下面一層，
   *  Image 全透明（擋射線用）、Button 的 onClick 接 Hide。 */
  function createBlocker(rootCanvas: SceneNode): SceneNode {
    const listCanvas = dropdownNode ? (graph.component(dropdownNode, 'Canvas') as ComponentData) : null;
    const blocker = createGameObject(world, 'Blocker', rootCanvas, [
      {
        type: 'RectTransform',
        classID: 224,
        gameObject: '',
        m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
        m_LocalPosition: { x: 0, y: 0, z: 0 },
        m_LocalScale: { x: 1, y: 1, z: 1 },
        m_ConstrainProportionsScale: 0,
        m_Children: [],
        m_Father: null,
        m_RootOrder: 0,
        m_LocalEulerAnglesHint: { x: 0, y: 0, z: 0 },
        m_AnchorMin: { x: 0, y: 0 },
        m_AnchorMax: { x: 1, y: 1 },
        m_AnchoredPosition: { x: 0, y: 0 },
        m_SizeDelta: { x: 0, y: 0 },
        m_Pivot: { x: 0.5, y: 0.5 },
      } as ComponentData,
      makeCanvas(rootCanvas, ((listCanvas?.m_SortingOrder as number) ?? 30000) - 1),
      {
        type: 'MonoBehaviour',
        classID: 114,
        gameObject: '',
        m_Enabled: 1,
        script: { assembly: 'UnityEngine.UI', namespace: 'UnityEngine.UI', class: 'Image' },
        m_Material: null,
        m_Color: { r: 0, g: 0, b: 0, a: 0 },
        m_RaycastTarget: 1,
        m_RaycastPadding: { x: 0, y: 0, z: 0, w: 0 },
        m_Maskable: 1,
        m_OnCullStateChanged: { m_PersistentCalls: { m_Calls: [] } },
        m_Sprite: null,
        m_Type: 0,
        m_PreserveAspect: 0,
        m_FillCenter: 1,
        m_FillMethod: 4,
        m_FillAmount: 1,
        m_FillClockwise: 1,
        m_FillOrigin: 0,
        m_UseSpriteMesh: 0,
        m_PixelsPerUnitMultiplier: 1,
      } as ComponentData,
      {
        type: 'MonoBehaviour',
        classID: 114,
        gameObject: '',
        m_Enabled: 1,
        script: { assembly: 'UnityEngine.UI', namespace: 'UnityEngine.UI', class: 'Button' },
        m_Navigation: { m_Mode: 3, m_WrapAround: 0, m_SelectOnUp: null, m_SelectOnDown: null, m_SelectOnLeft: null, m_SelectOnRight: null },
        m_Transition: 1,
        m_Colors: {
          m_NormalColor: { r: 1, g: 1, b: 1, a: 1 },
          m_HighlightedColor: { r: 0.9607843, g: 0.9607843, b: 0.9607843, a: 1 },
          m_PressedColor: { r: 0.78431374, g: 0.78431374, b: 0.78431374, a: 1 },
          m_SelectedColor: { r: 0.9607843, g: 0.9607843, b: 0.9607843, a: 1 },
          m_DisabledColor: { r: 0.78431374, g: 0.78431374, b: 0.78431374, a: 0.5019608 },
          m_ColorMultiplier: 1,
          m_FadeDuration: 0.1,
        },
        m_SpriteState: { m_HighlightedSprite: null, m_PressedSprite: null, m_SelectedSprite: null, m_DisabledSprite: null },
        m_AnimationTriggers: { m_NormalTrigger: 'Normal', m_HighlightedTrigger: 'Highlighted', m_PressedTrigger: 'Pressed', m_SelectedTrigger: 'Selected', m_DisabledTrigger: 'Disabled' },
        m_Interactable: 1,
        m_TargetGraphic: null,
        m_OnClick: { m_PersistentCalls: { m_Calls: [] } },
      } as ComponentData,
    ]);
    const listCanvasData = dropdownNode ? graph.component(dropdownNode, 'Canvas') : null;
    const blockerCanvas = graph.component(blocker, 'Canvas') as ComponentData;
    blockerCanvas.m_OverrideSorting = 1;
    blockerCanvas.m_SortingLayerID = (listCanvasData?.m_SortingLayerID as number) ?? 0;
    blockerCanvas.m_SortingOrder = ((listCanvasData?.m_SortingOrder as number) ?? 30000) - 1;
    addRaycasters(blocker, parentCanvasOf(templateNode() ?? blocker));
    // Button.onClick.AddListener(Hide)（:1064-1065）：原版是執行時期加的監聽，這裡把既有 behaviour 的
    // onPointerClick 包一層（selectable.ts 的 Button 只派送 m_OnClick 的 persistent calls）
    const btn = graph.component(blocker, 'Button') as ComponentData;
    btn.m_TargetGraphic = { fileID: compIdOf(graph.component(blocker, 'Image') as ComponentData) ?? '' };
    const buttonBehaviour = world.behaviour<SelectableBase>(btn);
    if (buttonBehaviour) {
      const press = buttonBehaviour.onPointerClick;
      buttonBehaviour.onPointerClick = (button: number) => {
        press?.(button);
        hide();
      };
    }
    return blocker;
  }

  /** OnSelectItem（:1238-1302）：由 parent 的子物件序號推選項索引（第 0 個是範本 item，所以要減一） */
  function onSelectItem(toggleNode: SceneNode): void {
    let selectedIndex = -1;
    const parent = toggleNode.parent;
    if (!parent) return;
    for (let i = 1; i < parent.children.length; i++) {
      if (parent.children[i] === toggleNode) {
        selectedIndex = i - 1;
        break;
      }
    }
    if (selectedIndex < 0) return;
    const toggleComp = graph.component(toggleNode, 'Toggle');
    const toggle = toggleComp ? world.behaviour<ToggleBehaviour>(toggleComp) : undefined;
    if (isMultiSelect()) {
      if (selectedIndex === 0) {
        // Nothing
        setValue(0);
        for (let i = 3; i < parent.children.length; i++) {
          const c = graph.component(parent.children[i], 'Toggle');
          const t = c ? world.behaviour<ToggleBehaviour>(c) : undefined;
          t?.setIsOnWithoutNotify(false);
        }
        toggle?.setIsOnWithoutNotify(true);
      } else if (selectedIndex === 1) {
        // Everything
        setValue(everythingValue(optionsList().length));
        for (let i = 3; i < parent.children.length; i++) {
          const c = graph.component(parent.children[i], 'Toggle');
          const t = c ? world.behaviour<ToggleBehaviour>(c) : undefined;
          t?.setIsOnWithoutNotify(i > 2);
        }
      } else {
        const flagValue = 1 << (selectedIndex - 2);
        const wasSelected = ((comp.m_Value as number) & flagValue) !== 0;
        toggle?.setIsOnWithoutNotify(!wasSelected);
        comp.m_Value = wasSelected ? (comp.m_Value as number) & ~flagValue : (comp.m_Value as number) | flagValue;
      }
    } else {
      if (toggle && !toggle.isOn) toggle.setIsOnWithoutNotify(true);
      setValue(selectedIndex);
    }
    hide();
  }

  /** Show（:777-975） */
  function show(): void {
    if (delayedDestroy) {
      world.coroutines.delete(delayedDestroy);
      delayedDestroy = null;
      immediateDestroyDropdownList();
    }
    if (!base.mayInteract() || dropdownNode) return;

    const rootCanvas = rootCanvasOf(node);
    if (!rootCanvas) return; // GetComponentsInParent<Canvas> 是空的（:789-792）

    if (!validTemplate) {
      setupTemplate();
      if (!validTemplate) return;
    }

    const t = templateNode()!;
    setActive(world, t, true);
    // :816 popupCanvas.sortingLayerID ＝ rootCanvas.sortingLayerID
    const tCanvas = graph.component(t, 'Canvas') as ComponentData;
    const rootCanvasComp = graph.component(rootCanvas, 'Canvas') as ComponentData;
    tCanvas.m_SortingLayerID = rootCanvasComp.m_SortingLayerID as number;

    // CreateDropdownList（:1090-1093）＝ Instantiate(template)；:825 SetParent(m_Template.transform.parent, false)
    // 一次做完：直接複製到 Template 的父物件底下，worldPositionStays false 所以本地座標不動
    const list = instantiate(world, t, t.parent);
    list.go.m_Name = 'Dropdown List';
    setActive(world, list, true);
    dropdownNode = list;

    const itemTemplateFound = componentInChildren<ItemInfo['comp']>(list, 'DropdownItem');
    if (!itemTemplateFound) return;
    const itemTemplateNode = itemTemplateFound.node;
    const itemTemplate: ItemInfo = {
      node: itemTemplateNode,
      comp: itemTemplateFound.comp,
      toggleComp: graph.component(itemTemplateNode, 'Toggle') ?? null,
      textComp: compOf(itemTemplateFound.comp.m_Text),
      imageComp: compOf(itemTemplateFound.comp.m_Image),
    };
    const contentNode = itemTemplateNode.parent!;
    setActive(world, itemTemplateNode, true);
    world.relayout(); // 讀 rect 之前要刷新（Unity 的 RectTransform.rect 是讀取時就算好的）

    // :836-843 內容與 item 的 rect、視覺偏移
    const dropdownContentRect = contentNode.rect;
    const itemTemplateRect = itemTemplateNode.rect;
    const localPos = layoutRect(contentNode.rect, itemTemplateNode.transform as RectTransformData).localPosition;
    const offsetMin = {
      x: itemTemplateRect.x - dropdownContentRect.x + localPos.x,
      y: itemTemplateRect.y - dropdownContentRect.y + localPos.y,
    };
    const offsetMax = {
      x: itemTemplateRect.x + itemTemplateRect.width - (dropdownContentRect.x + dropdownContentRect.width) + localPos.x,
      y: itemTemplateRect.y + itemTemplateRect.height - (dropdownContentRect.y + dropdownContentRect.height) + localPos.y,
    };
    const itemSize = { x: itemTemplateRect.width, y: itemTemplateRect.height };

    items = [];
    const opts = optionsList();
    const value = comp.m_Value as number;
    let prevToggle: ComponentData | null = null;

    if (isMultiSelect() && opts.length > 0) {
      // :848-884 Nothing／Everything 兩項
      const nothing = addItem(NOTHING_OPTION(), itemTemplate, items);
      if (nothing?.imageComp) {
        const n = graph.nodes.get(nothing.imageComp.gameObject);
        if (n) setActive(world, n, false);
      }
      const nothingToggle = nothing ? toggleOf(nothing) : undefined;
      if (nothingToggle) {
        nothingToggle.isOn = value === 0;
        nothingToggle.addListener(() => onSelectItem(nothing!.node));
        prevToggle = nothing!.toggleComp;
      }
      const everything = addItem(EVERYTHING_OPTION(), itemTemplate, items);
      if (everything?.imageComp) {
        const n = graph.nodes.get(everything.imageComp.gameObject);
        if (n) setActive(world, n, false);
      }
      const everythingToggle = everything ? toggleOf(everything) : undefined;
      if (everythingToggle) {
        everythingToggle.isOn = isEverythingValue(opts.length, value);
        everythingToggle.addListener(() => onSelectItem(everything!.node));
      }
      if (prevToggle && everything?.toggleComp) linkNavigation(prevToggle, everything.toggleComp);
    }

    // :886-922 每個選項一個 item
    for (let i = 0; i < opts.length; i++) {
      const item = addItem(opts[i], itemTemplate, items);
      if (!item) continue;
      const toggle = toggleOf(item);
      if (!toggle) continue;
      toggle.isOn = isMultiSelect() ? (value & (1 << i)) !== 0 : value === i;
      toggle.addListener(() => onSelectItem(item.node));
      if (toggle.isOn) world.events.setSelected(item.node); // :902-903 item.toggle.Select()
      if (prevToggle && item.toggleComp) linkNavigation(prevToggle, item.toggleComp);
      prevToggle = item.toggleComp;
    }

    // :924-931 內容高度＝項目數 × item 高，範本多出來的高度從清單扣掉
    const contentTf = contentNode.transform as RectTransformData;
    contentTf.m_SizeDelta = { x: contentTf.m_SizeDelta.x, y: itemSize.y * items.length + offsetMin.y - offsetMax.y };
    world.relayout();
    const listTf = list.transform as RectTransformData;
    const extraSpace = list.rect.height - contentNode.rect.height;
    if (extraSpace > 0) listTf.m_SizeDelta = { x: listTf.m_SizeDelta.x, y: listTf.m_SizeDelta.y - extraSpace };
    world.relayout();

    // :933-956 清單超出根 Canvas 就把該軸的錨點與 pivot 翻過來（變成往上開）
    const corners = worldCorners(list);
    const rootTf = rootCanvas;
    const rootRect = rootTf.rect;
    const inverse = rootTf.world.clone().invert();
    for (let axis = 0; axis < 2; axis++) {
      let outside = false;
      for (const c of corners) {
        const p = c.clone().applyMatrix4(inverse);
        const v = axis === 0 ? p.x : p.y;
        const min = axis === 0 ? rootRect.x : rootRect.y;
        const max = axis === 0 ? rootRect.x + rootRect.width : rootRect.y + rootRect.height;
        if ((v < min && !approximately(v, min)) || (v > max && !approximately(v, max))) {
          outside = true;
          break;
        }
      }
      if (outside) flipLayoutOnAxis(list.transform as RectTransformData, axis as 0 | 1);
    }

    // :958-965 項目由下往上排（錨點改成底部）
    for (let i = 0; i < items.length; i++) {
      const tf = items[i].node.transform as RectTransformData;
      tf.m_AnchorMin = { x: tf.m_AnchorMin.x, y: 0 };
      tf.m_AnchorMax = { x: tf.m_AnchorMax.x, y: 0 };
      tf.m_AnchoredPosition = { x: tf.m_AnchoredPosition.x, y: offsetMin.y + itemSize.y * (items.length - 1 - i) + itemSize.y * tf.m_Pivot.y };
      tf.m_SizeDelta = { x: tf.m_SizeDelta.x, y: itemSize.y };
    }
    world.relayout();

    alphaFadeList(comp.m_AlphaFadeSpeed as number, 0, 1); // :968
    setActive(world, t, false); // :971
    setActive(world, itemTemplateNode, false); // :972
    blockerNode = createBlocker(rootCanvas); // :974
  }

  /** ImmediateDestroyDropdownList（:1217-1235）。DestroyItem（:1129）是空的：銷毀清單就會銷毀裡面的項目 */
  function immediateDestroyDropdownList(): void {
    items = [];
    if (dropdownNode) destroy(world, dropdownNode);
    alphaTween?.stopTween();
    dropdownNode = null;
    delayedDestroy = null;
  }

  /** DelayedDestroyDropdownList（:1211-1215）：WaitForSecondsRealtime(delay) 之後立刻銷毀 */
  function startDelayedDestroy(delay: number): void {
    let elapsed = 0;
    const c: Coroutine = {
      step(dt: number) {
        elapsed += dt;
        if (elapsed < delay) return true;
        immediateDestroyDropdownList();
        return false;
      },
    };
    delayedDestroy = c;
    world.coroutines.add(c);
  }

  /** Hide（:1190-1209） */
  function hide(): void {
    if (delayedDestroy !== null) return;
    if (dropdownNode) {
      alphaFadeList(comp.m_AlphaFadeSpeed as number, canvasGroupAlpha(), 0);
      if (node.activeInHierarchy && comp.m_Enabled !== 0) startDelayedDestroy(comp.m_AlphaFadeSpeed as number);
    }
    if (blockerNode) destroy(world, blockerNode);
    blockerNode = null;
    world.events.setSelected(node); // Select()（Selectable.cs:684-690）
  }

  const self = Object.assign(base, {
    // Awake（:461-473）：captionImage 的啟用狀態、Template 關掉。
    // 這裡不呼叫 refreshEnables：World.start() 的 Awake 階段之後才統一跑 OnEnable／Start，
    // 中途重掃會讓別的元件的啟用事件亂序（Template 在場景資料裡本來就是未啟用，SetActive(false) 是 no-op）。
    awake() {
      const captionImage = captionImageComp();
      if (captionImage) captionImage.m_Enabled = captionImage.m_Sprite !== null && (captionImage.m_Color as ColorRGBA).a > 0 ? 1 : 0;
      const t = templateNode();
      if (t) graph.setActive(t, false);
    },
    // Start（:475-482）：建 TweenRunner → base.Start()（Selectable.OnEnable）→ RefreshShownValue
    start() {
      alphaTween = new FloatTweenRunner(world, node);
      baseStart?.();
      refreshShownValue();
    },
    // OnDisable（:496-507）
    onDisable() {
      immediateDestroyDropdownList();
      if (blockerNode) destroy(world, blockerNode);
      blockerNode = null;
      baseDisable?.();
    },
    // OnPointerClick（:741-744）
    onPointerClick(button: number) {
      if (button === 0) show();
    },
    setValue(v: number) {
      setValue(v, true);
    },
    setValueWithoutNotify(v: number) {
      setValue(v, false);
    },
    setOptions(list: DropdownOptionData[]) {
      (comp.m_Options as { m_Options: DropdownOptionData[] }).m_Options = list;
      refreshShownValue();
    },
    // AddOptions(List<string>)（:608-614）
    addOptions(list: string[]) {
      const opts = optionsList();
      for (const text of list) opts.push({ m_Text: text, m_Image: null, m_Color: { r: 1, g: 1, b: 1, a: 1 } });
      refreshShownValue();
    },
    // ClearOptions（:634-639）
    clearOptions() {
      optionsList().length = 0;
      comp.m_Value = comp.m_Placeholder ? -1 : 0;
      refreshShownValue();
    },
    refreshShownValue,
    show,
    hide,
    submit() {
      show();
    },
    cancel() {
      hide();
    },
  }) as unknown as TMPDropdownBehaviour;

  Object.defineProperty(self, 'value', {
    get: () => comp.m_Value as number,
    set: (v: number) => setValue(v),
    enumerable: true,
  });
  Object.defineProperty(self, 'isExpanded', { get: () => dropdownNode !== null, enumerable: true });
  Object.defineProperty(self, 'options', { get: optionsList, enumerable: true });
  return self;
}

/** TMP_Dropdown.DropdownItem（:24-51） */
export function dropdownItem({ world, node, comp }: BehaviourContext): Record<string, unknown> {
  return {
    // OnPointerEnter（:40-43）：滑鼠移到選項上就把自己設成 EventSystem 的選取物件
    onPointerEnter() {
      world.events.setSelected(node);
    },
    // OnCancel（:45-50）：GetComponentInParent<TMP_Dropdown>().Hide()
    onCancel() {
      for (let p: SceneNode | null = node; p; p = p.parent) {
        const c = world.graph.component(p, 'TMP_Dropdown');
        const d = c ? world.behaviour<TMPDropdownBehaviour>(c) : undefined;
        if (d) {
          d.cancel();
          return;
        }
      }
    },
    get text() {
      return comp.m_Text;
    },
  };
}

export const DROPDOWN_BEHAVIOURS: BehaviourRegistry = {
  TMP_Dropdown: (ctx) => tmpDropdown(ctx),
  DropdownItem: (ctx) => dropdownItem(ctx),
};

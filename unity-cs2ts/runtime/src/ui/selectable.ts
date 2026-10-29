// uGUI Selectable 的狀態顏色（ColorTint 過渡）與按下、放開、選取事件。
// 對應 reference/csharp 的反編譯原始碼（10/5 讀）：
//   UnityEngine.UI/Selectable.cs（currentSelectionState、ParentGroupAllowsInteraction、IsInteractable、
//     OnEnable、DoStateTransition、StartColorTween、EvaluateAndTransitionToSelectionState、OnPointerDown/Up/Enter/Exit、OnSelect/OnDeselect）
//   UnityEngine.UI/Button.cs（Press、OnPointerClick）
//   UnityEngine.UI/Graphic.cs（CrossFadeColor）
// 狀態由 src/runtime/engine/events.ts 的指標、選取事件驅動。

import type { Behaviour, BehaviourContext, BehaviourRegistry, World } from '../engine/world';
import type { SceneNode } from '../unity/scene';
import type { ColorRGBA, ComponentData } from '../unity/types';
import { getCanvasRendererColor, setCanvasRendererColor } from './canvasRenderer';
import { colorTweenRunnerOf, type ColorTweenMode } from './colorTween';
import { invokePersistentCalls } from '../unity/unityEvents';
import { componentKind } from '../unity/componentKind';

type SelectionState = 'Normal' | 'Highlighted' | 'Pressed' | 'Selected' | 'Disabled';

// 原版欄位是 Unity YAML 轉的 JSON（索引簽名 unknown），以下型別照 ScriptableObject 欄位（types.ts 只列用到的）
interface SelectableColors {
  m_NormalColor: ColorRGBA;
  m_HighlightedColor: ColorRGBA;
  m_PressedColor: ColorRGBA;
  m_SelectedColor: ColorRGBA;
  m_DisabledColor: ColorRGBA;
  m_ColorMultiplier: number;
  m_FadeDuration: number;
}

interface NavigationData {
  m_Mode: number;
}


const GRAPHIC_CLASSES: Record<string, true> = { Image: true, RawImage: true, TextMeshProUGUI: true, Text: true };

/** Graphic.CrossFadeColor（Graphic.cs:654）：目前的 CanvasRenderer 顏色漸變到 target */
export function crossFadeColor(world: World, graphicComp: ComponentData, graphicNode: SceneNode, target: ColorRGBA, duration: number, useAlpha: boolean, useRGB: boolean, ignoreTimeScale = true): void {
  const graph = world.graph;
  const current = getCanvasRendererColor(graph, graphicNode);
  if (!current || (!useRGB && !useAlpha)) return;
  if (current.r === target.r && current.g === target.g && current.b === target.b && current.a === target.a) {
    colorTweenRunnerOf(world, graphicComp, graphicNode).stopTween();
    return;
  }
  const mode: ColorTweenMode = useRGB && useAlpha ? 'All' : useRGB ? 'RGB' : 'Alpha';
  colorTweenRunnerOf(world, graphicComp, graphicNode).startTween({ start: current, target, mode, duration, ignoreTimeScale }, (c) => setCanvasRendererColor(graph, graphicNode, c));
}

/**
 * Selectable 基底。kind ＝ 'button' 加 Button.OnPointerClick → Press（m_OnClick persistent calls）；
 * 'extended' 額外 expose mayInteract()（＝ IsActive() && IsInteractable()）給 Toggle／Slider 包车；
 * 'plain' 只有狀態顏色（Scrollbar、TMP_Dropdown、TMP_InputField）。
 */
export type SelectableBase = Behaviour & {
  mayInteract: () => boolean;
  /** Selectable.interactable 的 setter 的行為（第 3 階段第九段第 1 輪，裁決 3）：欄位改了就馬上依狀態切色（見 setSelectableInteractable） */
  setInteractable: (on: boolean) => void;
};
export function selectableBehaviour({ world, node, comp }: BehaviourContext, kind: 'button' | 'extended' | 'plain' = 'plain'): SelectableBase {
  const graph = world.graph;
  let isPointerInside = false;
  let isPointerDown = false;
  let hasSelection = false;
  let groupsAllowInteraction = true;

  // Awake：m_TargetGraphic 沒指定就拿自己身上第一個 Graphic
  const tg = comp.m_TargetGraphic as { fileID: string } | null | undefined;
  let graphic: ComponentData | null;
  let graphicNode: SceneNode | null;
  if (tg?.fileID) {
    graphic = graph.file.components[tg.fileID] ?? null;
    graphicNode = graph.nodeOfComponent(tg.fileID) ?? null;
  } else {
    graphic = graph.components(node).find((c) => (c.script?.class ? GRAPHIC_CLASSES[componentKind(c)] === true : false)) ?? null;
    graphicNode = graphic ? node : null;
  }

  const isActive = () => node.activeInHierarchy && comp.m_Enabled !== 0;
  const isInteractable = () => groupsAllowInteraction && comp.m_Interactable !== 0;

  /** Selectable.ParentGroupAllowsInteraction：往上每層看 CanvasGroup；ignoreParentGroups 不看 enabled */
  function parentGroupAllowsInteraction(): boolean {
    for (let p: SceneNode | null = node; p; p = p.parent) {
      for (const cg of graph.components(p)) {
        if (cg.type !== 'CanvasGroup') continue;
        if (cg.m_Enabled !== 0 && cg.m_Interactable === 0) return false;
        if (cg.m_IgnoreParentGroups !== 0) return true;
      }
    }
    return true;
  }

  /** Selectable.currentSelectionState */
  function currentSelectionState(): SelectionState {
    if (!isInteractable()) return 'Disabled';
    if (isPointerDown) return 'Pressed';
    if (hasSelection) return 'Selected';
    if (isPointerInside) return 'Highlighted';
    return 'Normal';
  }

  /** Selectable.DoStateTransition（:381-433）：SpriteSwap 換 targetGraphic 的 overrideSprite（DoSpriteSwap :587-592） */
  function doStateTransition(state: SelectionState, instant: boolean): void {
    if (!node.activeInHierarchy) return;
    const colors = comp.m_Colors as SelectableColors;
    const spriteState = (comp.m_SpriteState ?? {}) as Record<string, unknown>;
    const color = { Normal: colors.m_NormalColor, Highlighted: colors.m_HighlightedColor, Pressed: colors.m_PressedColor, Selected: colors.m_SelectedColor, Disabled: colors.m_DisabledColor }[state];
    // SpriteState 各狀態的替換 sprite（Selectable.cs:396-416 取 highlightedSprite／pressedSprite／
    // selectedSprite／disabledSprite；SpriteState.cs:10-20 的序列化欄位是 m_HighlightedSprite 等，
    // 匯入 JSON 照存這些名字）：Normal 是 null（:394 走 DoSpriteSwap(null)，換回 m_Sprite）
    const newSprite = { Normal: null, Highlighted: spriteState.m_HighlightedSprite ?? null, Pressed: spriteState.m_PressedSprite ?? null, Selected: spriteState.m_SelectedSprite ?? null, Disabled: spriteState.m_DisabledSprite ?? null }[state];
    // Color * float：四個分量都乘
    const tinted: ColorRGBA = { r: color.r * colors.m_ColorMultiplier, g: color.g * colors.m_ColorMultiplier, b: color.b * colors.m_ColorMultiplier, a: color.a * colors.m_ColorMultiplier };
    switch (comp.m_Transition as number) {
      case 1:
        startColorTween(tinted, instant);
        break;
      case 2:
        // DoSpriteSwap（:587-592）：image.overrideSprite = newSprite。image ＝ m_TargetGraphic as Image
        // （:206）：匯入的 Image 元件 type 是 MonoBehaviour，類別在 script.class（Button 2693 →
        // Image 2712 即此結構），設進元件欄位後 refreshKeyOf 自動重產網格與貼圖
        if (graphic && graphicNode && graphic.script?.class === 'Image') {
          if (graphic.m_OverrideSprite !== newSprite) graphic.m_OverrideSprite = newSprite;
        }
        break;
      case 3:
        world.notes.add('Selectable 的 Animation 過渡還沒做');
        break;
    }
  }

  function startColorTween(target: ColorRGBA, instant: boolean): void {
    if (!graphic || !graphicNode) return;
    const colors = comp.m_Colors as SelectableColors;
    crossFadeColor(world, graphic, graphicNode, target, instant ? 0 : colors.m_FadeDuration, true, true);
  }

  /** Selectable.EvaluateAndTransitionToSelectionState */
  function evaluate(): void {
    if (isActive() && isInteractable()) doStateTransition(currentSelectionState(), false);
  }

  const self: Behaviour = {
    // OnEnable
    start() {
      hasSelection = world.events.currentSelected === node;
      isPointerDown = false;
      groupsAllowInteraction = parentGroupAllowsInteraction();
      doStateTransition(currentSelectionState(), true);
      if (kind === 'plain') world.notes.add(`${comp.script?.class} 的專屬行為（點擊、拖曳）還沒做，只有狀態顏色`);
    },
    onPointerDown(button) {
      if (button !== 0) return;
      // OnPointerDown：可互動且 navigation 不是 None 才把自己設成 EventSystem 選取物件
      const nav = comp.m_Navigation as NavigationData;
      if (isInteractable() && nav.m_Mode !== 0) world.events.setSelected(node);
      isPointerDown = true;
      evaluate();
    },
    onPointerUp(button) {
      if (button !== 0) return;
      isPointerDown = false;
      evaluate();
    },
    onPointerEnter() {
      isPointerInside = true;
      evaluate();
    },
    onPointerExit() {
      isPointerInside = false;
      evaluate();
    },
    onSelect() {
      hasSelection = true;
      evaluate();
    },
    onDeselect() {
      hasSelection = false;
      evaluate();
    },
  };
  // Button.OnPointerClick → Press：呼叫場景綁定的 m_OnClick（Button.cs:100-125）
  if (kind === 'button') {
    self.onPointerClick = (button) => {
      if (button !== 0) return;
      if (isActive() && isInteractable()) invokePersistentCalls(world, comp, 'm_OnClick', undefined, '點擊');
    };
  }
  const out = self as SelectableBase;
  out.mayInteract = () => isActive() && isInteractable();
  // 改 m_Interactable 之後立刻切色（Unity 的 Selectable.interactable setter：OnSetProperty → EvaluateAndTransitionToSelectionState，
  // 不管 interactable 是 true 或 false 都會過渡；Disabled 也走 DoStateTransition）。現有的直接改欄位的地方（sceneState.ts、desk.ts）不動。
  out.setInteractable = (on: boolean) => {
    comp.m_Interactable = on ? 1 : 0;
    if (isActive()) doStateTransition(currentSelectionState(), false);
  };
  return out;
}

/**
 * Selectable.interactable 的 setter（第 3 階段第九段第 1 輪，裁決 3）：故事的選項按鈕用。
 * 有行為就走 setInteractable（馬上切色）；沒有行為（例如節點還沒登記）就只改欄位。
 */
export function setSelectableInteractable(world: World, comp: ComponentData, on: boolean): void {
  const sel = world.behaviour<SelectableBase>(comp);
  if (sel) sel.setInteractable(on);
  else comp.m_Interactable = on ? 1 : 0;
}

/** 按鈕的 Selectable 行為（UI 的 Button；onPointerClick 由 selectable.ts 派送） */
type ClickableSelectable = { onPointerClick?: (button: number) => void; mayInteract(): boolean };

/**
 * 在按鈕上加一個 onClick（C# 的 onClick.AddListener：場景沒有綁定的 m_OnClick 就從程式加）。按鈕不存在就什麼都不做。
 * 原本在 tutorial.ts（第 3 輪）；第 3 階段第九段第 1 輪搬到這裡，教學與故事共用（裁決 3）。
 */
export function addClickListener(world: World, buttonNode: SceneNode | null, onClick: () => void): void {
  if (!buttonNode) return;
  const btnComp = componentOfNode(world, buttonNode, 'Button');
  const sel = btnComp ? (world.behaviour<SelectableBase>(btnComp) as unknown as ClickableSelectable | undefined) : undefined;
  if (!sel) return;
  const base = sel.onPointerClick;
  sel.onPointerClick = (button: number) => {
    base?.(button); // 場景綁的 m_OnClick（沒有就空）
    if (button === 0 && sel.mayInteract()) onClick();
  };
}

/** 節點上第一個種類是 kind 的元件（類型名或 script 類別名；nodeOps.componentOf 的同一套判斷） */
function componentOfNode(world: World, node: SceneNode, kind: string): ComponentData | null {
  for (const c of world.graph.components(node)) if (c.type === kind || c.script?.class === kind) return c;
  return null;
}

export const UI_BEHAVIOURS: BehaviourRegistry = {
  // Selectable 本身也登記：遊戲直接繼承 Selectable 的類別（MT2 的 GameUISelectableWithNavigation）沿繼承鏈用它（World.factoryFor）
  Selectable: (ctx) => selectableBehaviour(ctx),
  Button: (ctx) => selectableBehaviour(ctx, 'button'),
  TMP_InputField: (ctx) => selectableBehaviour(ctx),
};

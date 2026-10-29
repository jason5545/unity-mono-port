// uGUI Scrollbar 的互動與雙向連動（0g 製作人員名單）。
// 對應 reference/decompiled/UnityEngine.UI/UnityEngine.UI/Scrollbar.cs（10/6 讀）：
//   value／size／numberOfSteps（:97-143）、axis（:169-179）、reverseValue（:181-191）、
//   SetValueWithoutNotify（:197-200）、OnEnable（:214-220 → onEnable）、UpdateCachedReferences（:237-247）、
//   Set（:249-262）、UpdateVisuals（:273-295，錨點計算重用 drivenControls.scrollbarUpdateVisuals）、
//   UpdateDrag（:297-313）、DoUpdateDrag（:315-332）、MayDrag（:334-341）、
//   OnBeginDrag（:343-354）、OnDrag（:356-362）、OnPointerDown（:364-372）、
//   ClickRepeat（:379-393）、OnPointerUp（:395-399）、OnInitializePotentialDrag（:489-492）。
// 拖曳座標換算（ScreenPointToLocalPointInRectangle／RectangleContainsScreenPoint）用 events.ts 的 screenPointToLocal。
// OnMove（方向鍵逐步移動）不做：這題不要鍵盤／手把導覽，與原版的差異列在回報。

import type { BehaviourContext, BehaviourRegistry } from '../engine/world';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { axisOf, mathfRound, reverseOf, scrollbarUpdateVisuals } from './drivenControls';
import { invokePersistentCalls } from '../unity/unityEvents';
import { selectableBehaviour, type SelectableBase } from './selectable';

/** UpdateDrag／OnBeginDrag／ClickRepeat 用的事件（events.ts 的 PointerEventDataLike 子集） */
interface DragEv {
  position: { x: number; y: number };
  screenPosition: { x: number; y: number };
  button: number;
}

export interface ScrollbarBehaviour extends SelectableBase {
  /** C# value getter（numberOfSteps > 1 時取整；Set 存的是未取整原值） */
  readonly value: number;
  /** C# value setter ＝ Set(v, sendCallback: true) */
  setValue(v: number): void;
  /** C# SetValueWithoutNotify（:197-200）：Set(input, sendCallback: false) */
  setValueWithoutNotify(v: number): void;
  /** C# size setter（:114-127）：Clamp01 後更新視覺 */
  setSize(s: number): void;
  /** onValueChanged 的程式端監聽（ScrollRect.OnEnable 接 SetVerticalNormalizedPosition） */
  addValueListener(fn: (value: number) => void): void;
  removeValueListener(fn: (value: number) => void): void;
  /** C# isPointerDownAndNotDragging（:62）：點空白處重複捲動的旗標 */
  pointerDownAndNotDragging: boolean;
}

export function scrollbarBehaviour(ctx: BehaviourContext): ScrollbarBehaviour {
  const { world, node, comp } = ctx;
  const base = selectableBehaviour(ctx, 'plain');
  // Object.assign 會蓋掉 base 的 onPointerDown／onPointerUp，先把基底原函數抓下來（Selectable 的選取與按下放開），否則會無限遞迴。
  const baseDown = base.onPointerDown;
  const baseUp = base.onPointerUp;
  const listeners: ((value: number) => void)[] = [];

  let handleNode: SceneNode | null = null;
  let container: SceneNode | null = null;
  let offset = { x: 0, y: 0 };
  let repeatScreen: { x: number; y: number } | null = null;

  function pptrNode(ref: unknown): SceneNode | null {
    const fileID = (ref as { fileID?: string } | null)?.fileID;
    if (!fileID) return null;
    const c = world.graph.file.components[fileID] as ComponentData | undefined;
    return c ? (world.graph.nodes.get(c.gameObject) ?? null) : null;
  }

  // UpdateCachedReferences（:237-247）：m_HandleRect（RectTransform PPtr）→ 節點，parent 作 container
  function updateCachedReferences(): void {
    handleNode = pptrNode(comp.m_HandleRect);
    container = handleNode?.parent ?? null;
  }

  // value getter（:97-112）：取整只發生在讀取時
  function getValue(): number {
    let v = comp.m_Value as number;
    const steps = (comp.m_NumberOfSteps as number) ?? 0;
    if (steps > 1) v = mathfRound(v * (steps - 1)) / (steps - 1);
    return v;
  }

  // UpdateVisuals（:273-295）：算式在 drivenControls.scrollbarUpdateVisuals
  function updateVisuals(): void {
    scrollbarUpdateVisuals(world.graph, node, comp);
  }

  // Set（:249-262）：舊 m_Value 與取整後的 value 不同才更新與派送
  function set(input: number, sendCallback = true): void {
    const num = comp.m_Value as number;
    comp.m_Value = input;
    if (num !== getValue()) {
      updateVisuals();
      if (sendCallback) {
        const v = getValue();
        for (const fn of listeners) fn(v);
        invokePersistentCalls(world, comp, 'm_OnValueChanged', v, 'onValueChanged');
      }
    }
  }

  const ax = () => axisOf(comp.m_Direction as number);
  const reverse = () => reverseOf(comp.m_Direction as number);

  /** MayDrag（:334-341） */
  function mayDrag(ev: DragEv): boolean {
    return base.mayInteract() && ev.button === 0;
  }

  /**
   * UpdateDrag（:297-313）。GetRelativeMousePositionForDrag 單螢幕恆真，position 即當前指標位置。
   * handleCorner ＝ localPoint − m_Offset − container.rect.position − (handle.rect.size − handle.sizeDelta)·0.5。
   */
  function updateDrag(ev: DragEv): void {
    if (ev.button !== 0 || !container) return;
    const handle = handleNode;
    if (!handle) return;
    const s = world.events.screenSize;
    const local = world.events.screenPointToLocal(container, ev.position.x, ev.position.y, s.w, s.h);
    if (!local) return;
    const c = container.rect;
    const h = handle.rect;
    const hd = handle.transform as unknown as { m_SizeDelta: { x: number; y: number } };
    const corner = {
      x: local.x - offset.x - c.x - (h.width - hd.m_SizeDelta.x) * 0.5,
      y: local.y - offset.y - c.y - (h.height - hd.m_SizeDelta.y) * 0.5,
    };
    const remaining = (ax() === 0 ? c.width : c.height) * (1 - (comp.m_Size as number));
    if (remaining <= 0) return;
    doUpdateDrag(corner, remaining);
  }

  /** DoUpdateDrag（:315-332） */
  function doUpdateDrag(corner: { x: number; y: number }, remaining: number): void {
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    const dir = comp.m_Direction as number;
    if (dir === 0) set(clamp01(corner.x / remaining));
    else if (dir === 1) set(clamp01(1 - corner.x / remaining));
    else if (dir === 2) set(clamp01(corner.y / remaining));
    else set(clamp01(1 - corner.y / remaining));
  }

  /** ClickRepeat（:379-393）：按下點不在 handle 上時，沿軸往按下那側移動一個 size。協程改成每幀由 update() 輪詢。 */
  function clickRepeat(screenPosition: { x: number; y: number }): void {
    const handle = handleNode;
    if (!handle) return;
    const s = world.events.screenSize;
    const local = world.events.screenPointToLocal(handle, screenPosition.x, screenPosition.y, s.w, s.h);
    if (!local) return;
    const r = handle.rect;
    if (local.x >= r.x && local.x <= r.x + r.width && local.y >= r.y && local.y <= r.y + r.height) return;
    const a = ax();
    const size = comp.m_Size as number;
    const num = (a === 0 ? local.x : local.y) < 0 ? size : 0 - size;
    let v = getValue() + (reverse() ? num : 0 - num);
    v = Math.min(Math.max(v, 0), 1); // Clamp01
    v = mathfRound(v * 10000) / 10000; // Round(value * 10000) / 10000
    set(v);
  }

  const self = Object.assign(base, {
    // OnEnable（:214-220）：UpdateCachedReferences → Set(m_Value, false) → UpdateVisuals
    onEnable() {
      updateCachedReferences();
      set(comp.m_Value as number, false);
      updateVisuals();
    },
    onDisable() {
      self.pointerDownAndNotDragging = false;
    },
    setValue(v: number) {
      set(v);
    },
    setValueWithoutNotify(v: number) {
      set(v, false);
    },
    setSize(s: number) {
      const clamped = Math.min(Math.max(s, 0), 1);
      if ((comp.m_Size as number) !== clamped) {
        comp.m_Size = clamped;
        updateVisuals();
      }
    },
    addValueListener(fn: (value: number) => void) {
      listeners.push(fn);
    },
    removeValueListener(fn: (value: number) => void) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    pointerDownAndNotDragging: false,
    // OnBeginDrag（:343-354）：記 m_Offset ＝ handle 本地點 − handle.rect.center
    onBeginDrag(ev?: DragEv) {
      self.pointerDownAndNotDragging = false;
      if (!ev || !mayDrag(ev) || !container) return;
      offset = { x: 0, y: 0 };
      const handle = handleNode;
      if (!handle) return;
      const s = world.events.screenSize;
      const local = world.events.screenPointToLocal(handle, ev.screenPosition.x, ev.screenPosition.y, s.w, s.h);
      if (!local) return;
      const r = handle.rect;
      // RectangleContainsScreenPoint(handle, screenPosition)
      if (local.x >= r.x && local.x <= r.x + r.width && local.y >= r.y && local.y <= r.y + r.height) {
        offset = { x: local.x - (r.x + r.width * 0.5), y: local.y - (r.y + r.height * 0.5) };
      }
    },
    // OnDrag（:356-362）
    onDrag(ev?: DragEv) {
      if (ev && mayDrag(ev) && container) updateDrag(ev);
    },
    // OnPointerDown（:364-372）：走 Selectable 選取／顏色，然後起 ClickRepeat（先立即跑一次）
    onPointerDown(button: number, ev?: DragEv) {
      if (!ev || !mayDrag(ev)) return;
      baseDown?.(button, ev as never);
      self.pointerDownAndNotDragging = true;
      repeatScreen = { ...ev.screenPosition };
      clickRepeat(ev.screenPosition);
    },
    // OnPointerUp（:395-399）
    onPointerUp(button: number) {
      baseUp?.(button);
      self.pointerDownAndNotDragging = false;
    },
    // OnInitializePotentialDrag（:489-492）
    onInitializePotentialDrag(ev?: { useDragThreshold: boolean }) {
      if (ev) ev.useDragThreshold = false;
    },
    // ClickRepeat 協程：按住空白處每幀再移一個 size（OnPointerUp／OnBeginDrag 停）
    update() {
      if (self.pointerDownAndNotDragging && repeatScreen) clickRepeat(repeatScreen);
    },
  }) as unknown as ScrollbarBehaviour;

  // Object.assign 只取 getter 當下值，value 用 defineProperty 掛回存取器
  Object.defineProperty(self, 'value', { get: () => getValue(), enumerable: true });
  return self;
}

export const SCROLLBAR_BEHAVIOURS: BehaviourRegistry = {
  Scrollbar: (ctx) => scrollbarBehaviour(ctx),
};

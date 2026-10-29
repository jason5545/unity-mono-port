// uGUI Slider 的互動行為：按下（m_Offset）、拖曳（UpdateDrag）、OnInitializePotentialDrag 關拖曳門檻。
// 對應 reference/decompiled/UnityEngine.UI/UnityEngine.UI/Slider.cs（10/5 讀）：
//   value／normalizedValue（:168-205）、ClampValue（:345-354）、Set（:356-372）、
//   UpdateVisuals（:388-429，錨點計算已在 drivenControls.ts 的 sliderUpdateVisuals，這裡直接重用）、
//   UpdateDrag（:416-430）、MayDrag（:431-438）、OnPointerDown（:440-459）、OnDrag（:461-466）、
//   OnInitializePotentialDrag（:557-560）、UpdateCachedReferences（:303-343 附近，用欄位引用找 Handle）。
// 螢幕點→本地點：events.ts 的 screenPointToLocal（＝ RectTransformUtility.ScreenPointToLocalPointInRectangle）。
// OnMove（方向鍵調整值）不做：設定流程只用滑鼠／觸控，與原版的差異列在回報。

import type { BehaviourContext, BehaviourRegistry } from '../engine/world';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { axisOf, mathfRound, reverseOf, sliderUpdateVisuals } from './drivenControls';
import { invokePersistentCalls } from '../unity/unityEvents';
import { selectableBehaviour, type SelectableBase } from './selectable';

/** UpdateDrag／OnPointerDown 用的事件（events.ts 的 PointerEventDataLike 子集） */
interface DragEv {
  position: { x: number; y: number };
  screenPosition: { x: number; y: number };
  button: number;
}

export interface SliderBehaviour extends SelectableBase {
  /** C# value getter（wholeNumbers 時取整；Set 存的是未取整的原值） */
  readonly value: number;
  /** C# normalizedValue getter */
  readonly normalizedValue: number;
  /** C# value setter：Set(v)（會走 onValueChanged） */
  setValue(v: number): void;
  /** SetValueWithoutNotify：Set(v, false)（不觸發 onValueChanged） */
  setValueWithoutNotify(v: number): void;
  setNormalized(v: number): void;
  /** Awake 程式接的 onValueChanged（原版：slider.onValueChanged.AddListener(...)） */
  addListener(fn: (value: number) => void): void;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function sliderBehaviour(ctx: BehaviourContext): SliderBehaviour {
  const { world, node, comp } = ctx;
  const base = selectableBehaviour(ctx, 'extended');
  const listeners: ((value: number) => void)[] = [];

  let handleContainer: SceneNode | null = null;
  let handleNode: SceneNode | null = null;
  let fillContainer: SceneNode | null = null;
  let offset = { x: 0, y: 0 };

  function pptrNode(ref: unknown): SceneNode | null {
    const fileID = (ref as { fileID?: string } | null)?.fileID;
    if (!fileID) return null;
    const c = world.graph.file.components[fileID] as ComponentData | undefined;
    return c ? (world.graph.nodes.get(c.gameObject) ?? null) : null;
  }

  // UpdateCachedReferences：m_HandleRect／m_FillRect（RectTransform PPtr）→ 節點，父分別作 container
  function updateCachedReferences(): void {
    handleNode = pptrNode(comp.m_HandleRect);
    handleContainer = handleNode?.parent ?? null;
    fillContainer = pptrNode(comp.m_FillRect)?.parent ?? null;
  }

  function clampValue(input: number): number {
    const min = comp.m_MinValue as number;
    const max = comp.m_MaxValue as number;
    const num = Math.min(Math.max(input, min), max);
    return comp.m_WholeNumbers ? mathfRound(num) : num;
  }

  function axisIndex(): number {
    return axisOf(comp.m_Direction as number);
  }

  function size(n: SceneNode): number {
    const r = n.rect;
    return axisIndex() === 0 ? r.width : r.height;
  }

  // UpdateVisuals：Set 之後重算錨點（同一份算式在 sliderUpdateVisuals，不重複實作）
  function updateVisuals(): void {
    sliderUpdateVisuals(world.graph, node, comp);
  }

  /** Set（:356-372）：值沒變不觸發 onValueChanged */
  function set(input: number, sendCallback = true): void {
    const num = clampValue(input);
    if ((comp.m_Value as number) !== num) {
      comp.m_Value = num;
      updateVisuals();
      if (sendCallback) {
        for (const fn of listeners) fn(num);
        invokePersistentCalls(world, comp, 'm_OnValueChanged', num, 'onValueChanged');
      }
    }
  }

  function getNormalized(): number {
    const min = comp.m_MinValue as number;
    const max = comp.m_MaxValue as number;
    if (Math.abs(min - max) < 1e-6) return 0; // Mathf.Approximately
    return Math.min(Math.max(((comp.m_Value as number) - min) / (max - min), 0), 1); // InverseLerp
  }

  function setNormalized(v: number): void {
    const min = comp.m_MinValue as number;
    const max = comp.m_MaxValue as number;
    set(lerp(min, max, v)); // this.value ＝ Lerp → Set
  }

  /** UpdateDrag（:416-430）：GetRelativeMousePositionForDrag 單螢幕恆真，position 即當前指標位置 */
  function updateDrag(ev: DragEv): void {
    const container = handleContainer ?? fillContainer; // C# ＝ m_HandleContainerRect ?? m_FillContainerRect（:417）
    if (!container || size(container) <= 0) return;
    const s = world.events.screenSize;
    const local = world.events.screenPointToLocal(container, ev.position.x, ev.position.y, s.w, s.h);
    if (!local) return;
    const r = container.rect;
    const ax = axisIndex();
    const l = (ax === 0 ? local.x - r.x : local.y - r.y) - (ax === 0 ? offset.x : offset.y);
    const num = Math.min(Math.max(l / size(container), 0), 1); // Clamp01
    setNormalized(reverseOf(comp.m_Direction as number) ? 1 - num : num);
  }

  /** MayDrag（:431-438） */
  function mayDrag(ev: DragEv): boolean {
    return base.mayInteract() && ev.button === 0;
  }

  // Object.assign 會蓋掉 base 上的同名方法，先把基底原函數抓下來（start ＝ Selectable.OnEnable、onPointerDown ＝ Selectable 的選取）
  const baseStart = base.start;
  const baseDown = base.onPointerDown;
  const self = Object.assign(base, {
    // OnEnable：UpdateCachedReferences → Set(m_Value, false) → UpdateVisuals
    start() {
      baseStart?.();
      updateCachedReferences();
      set(comp.m_Value as number, false);
      updateVisuals();
    },
    setNormalized,
    // value setter ＝ Set(v, sendCallback: true)（SetMusicVolume 把它設回時不會重複觸發）
    setValue(v: number) {
      set(v);
    },
    setValueWithoutNotify(v: number) {
      set(v, false);
    },
    addListener(fn: (value: number) => void) {
      listeners.push(fn);
    },
    // OnPointerDown（:440-459）
    onPointerDown(button: number, ev?: DragEv) {
      if (!ev || !mayDrag(ev)) return;
      baseDown?.(button, ev as never);
      offset = { x: 0, y: 0 };
      // RectangleContainsScreenPoint(m_HandleRect, pointerPressRaycast.screenPosition, enterEventCamera)
      let inHandle = false;
      let handleLocal: { x: number; y: number } | null = null;
      if (handleNode) {
        const s = world.events.screenSize;
        handleLocal = world.events.screenPointToLocal(handleNode, ev.screenPosition.x, ev.screenPosition.y, s.w, s.h);
        if (handleLocal) {
          const r = handleNode.rect;
          inHandle = handleLocal.x >= r.x && handleLocal.x <= r.x + r.width && handleLocal.y >= r.y && handleLocal.y <= r.y + r.height;
        }
      }
      if (handleContainer && inHandle && handleLocal) {
        offset = handleLocal; // m_Offset ＝ localPoint（pivot 相對）
      } else {
        updateDrag(ev);
      }
    },
    // OnDrag（:461-466）
    onDrag(ev?: DragEv) {
      if (ev && mayDrag(ev)) updateDrag(ev);
    },
    // OnInitializePotentialDrag（:557-560）
    onInitializePotentialDrag(ev?: { useDragThreshold: boolean }) {
      if (ev) ev.useDragThreshold = false;
    },
  }) as SliderBehaviour; // value／normalizedValue 用 defineProperty 補上，型別在此收斂
  // value／normalizedValue：Object.assign 只會取 getter 的當下值，必須用 defineProperty 掛回存取器
  Object.defineProperty(self, 'value', {
    get: () => (comp.m_WholeNumbers ? mathfRound(comp.m_Value as number) : (comp.m_Value as number)),
    enumerable: true,
  });
  Object.defineProperty(self, 'normalizedValue', { get: () => getNormalized(), enumerable: true });
  return self;
}

export const SLIDER_BEHAVIOURS: BehaviourRegistry = {
  Slider: (ctx) => sliderBehaviour(ctx),
};

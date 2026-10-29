// uGUI Toggle 的互動行為：點擊切換、勾勾圖示的 CrossFadeAlpha、onValueChanged。
// 對應 reference/decompiled/UnityEngine.UI/UnityEngine.UI/Toggle.cs（10/5 讀）：
//   Set（:137-155，m_IsOn 相同直接回、不觸發事件）、PlayEffect（:156-162）、
//   Start（:164-167 → PlayEffect(instant: true)）、InternalToggle（:169-175，IsActive()&&IsInteractable()）、
//   OnPointerClick（:177-182，只有左鍵）。
// OnEnable（:85-90）的 SetToggleGroup：ToggleGroup 還沒移植，m_Group 有值就記 notes。
// CrossFadeAlpha ＝ Graphic.CrossFadeColor(白, a, duration, ignoreTimeScale, useAlpha:true, useRGB:false)，
//   用 selectable.ts 的 crossFadeColor（驅動 colorTween）；ignoreTimeScale 是 true（Toggle.cs:160），漸變照 unscaledDeltaTime。

import type { BehaviourContext, BehaviourRegistry } from '../engine/world';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { invokePersistentCalls } from '../unity/unityEvents';
import { crossFadeColor, selectableBehaviour, type SelectableBase } from './selectable';

export interface ToggleBehaviour extends SelectableBase {
  /** C# isOn：getter 讀 m_IsOn、setter 走 Set(value, sendCallback: true) */
  isOn: boolean;
  /** SetIsOnWithoutNotify（:132-135） */
  setIsOnWithoutNotify(value: boolean): void;
  /** Awake 程式接的 onValueChanged（如有）；場景 persistent calls 由 unityEvents 處理 */
  addListener(fn: (isOn: boolean) => void): void;
}

export function toggleBehaviour(ctx: BehaviourContext): ToggleBehaviour {
  const { world, comp } = ctx;
  const base = selectableBehaviour(ctx, 'extended');
  const listeners: ((isOn: boolean) => void)[] = [];

  // Toggle.graphic：勾勾圖示（m_Graphic PPtr → Image 元件與其節點）
  function graphicRef(): { comp: ComponentData; node: SceneNode } | null {
    const fileID = (comp.graphic as { fileID?: string } | null)?.fileID;
    if (!fileID) return null;
    const c = world.graph.file.components[fileID] as ComponentData | undefined;
    if (!c) return null;
    const n = world.graph.nodes.get(c.gameObject);
    return n ? { comp: c, node: n } : null;
  }

  /** PlayEffect（:156-162）：graphic.CrossFadeAlpha(m_IsOn ? 1 : 0, instant ? 0 : 0.1, true) */
  function playEffect(instant: boolean): void {
    const g = graphicRef();
    if (!g) return;
    crossFadeColor(world, g.comp, g.node, { r: 1, g: 1, b: 1, a: comp.m_IsOn ? 1 : 0 }, instant ? 0 : 0.1, true, false);
  }

  /** Set（:137-155）：m_IsOn 相同時整個跳過（不觸發 onValueChanged） */
  function set(value: boolean, sendCallback = true): void {
    if ((comp.m_IsOn ? 1 : 0) !== (value ? 1 : 0)) {
      comp.m_IsOn = value ? 1 : 0;
      // m_Group 的排他邏輯（AnyTogglesOn／NotifyToggleOn）ToggleGroup 還沒移植
      if (comp.m_Group) world.notes.add('Toggle 有 ToggleGroup，排他邏輯還沒做');
      playEffect((comp.m_ToggleTransition as number) === 2); // ToggleTransition.None ＝ 瞬切
      if (sendCallback) {
        for (const fn of listeners) fn(!!comp.m_IsOn);
        // 場景 YAML 的欄位是 onValueChanged（Button 是 onClick、Slider 是 m_OnValueChanged，匯出保持一致）
        invokePersistentCalls(world, comp, 'onValueChanged', !!comp.m_IsOn, 'onValueChanged');
      }
    }
  }

  /** InternalToggle（:169-175） */
  function internalToggle(): void {
    if (base.mayInteract()) set(!comp.m_IsOn);
  }
  // Object.assign 會蓋掉 base 上的同名方法，先把基底原函數抓下來（start ＝ Selectable.OnEnable）
  const baseStart = base.start;
  const self = Object.assign(base, {
    start() {
      baseStart?.();
      if (comp.m_Group) world.notes.add('Toggle 有 ToggleGroup，SetToggleGroup 還沒做');
      playEffect(true); // Start（:164-167）→ PlayEffect(instant: true)
    },
    setIsOnWithoutNotify(value: boolean) {
      set(value, false);
    },
    addListener(fn: (isOn: boolean) => void) {
      listeners.push(fn);
    },
    // OnPointerClick（:177-182）
    onPointerClick(button: number) {
      if (button === 0) internalToggle();
    },
  }) as ToggleBehaviour; // isOn 用 defineProperty 補上，型別在此收斂
  // isOn：Object.assign 只會取 getter 的當下值，必須用 defineProperty 把存取器掛回 self
  Object.defineProperty(self, 'isOn', {
    get: () => !!comp.m_IsOn,
    set: (v: boolean) => set(v),
    enumerable: true,
  });
  return self;
}

export const TOGGLE_BEHAVIOURS: BehaviourRegistry = {
  Toggle: (ctx) => toggleBehaviour(ctx),
};

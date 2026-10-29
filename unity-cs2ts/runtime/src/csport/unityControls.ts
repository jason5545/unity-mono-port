// 相容層：執行環境原生做的 uGUI 控制項（Slider、Toggle、ScrollRect）的屬性與方法 → ui/*.ts 的 behaviour（拖曳、Set、onValueChanged 都在那裡）。
// unity.ts 會 export * 這裡。behaviour 還沒建（元件所在的物件從沒啟用過）時直接讀寫元件資料，跟 Unity 的序列化欄位一樣。
// onValueChanged 這類 UnityEvent 屬性在 unityNative 的 nativeGet 統一處理（回元件資料裡那一份事件物件）。

import { getActiveWorld, H, type Ctx } from './core';
import { registerNativeProp } from './unityNative';
import type { SliderBehaviour } from '../ui/slider';
import type { ToggleBehaviour } from '../ui/toggle';
import type { ScrollRectBehaviour } from '../ui/scrollRect';

type Vec2 = { x: number; y: number };

function behaviourOf<T>(c: Ctx, h: H): T | null {
  const world = c.w ?? getActiveWorld();
  return h.comp && world ? ((world.behaviours.get(h.comp) as T | undefined) ?? null) : null;
}

// ───────── Slider ─────────
registerNativeProp('Slider', 'value', {
  get: (c, h) => behaviourOf<SliderBehaviour>(c, h)?.value ?? (h.comp?.m_Value as number),
  set: (c, h, v) => {
    const b = behaviourOf<SliderBehaviour>(c, h);
    if (b) b.setValue(v as number);
    else if (h.comp) h.comp.m_Value = v;
  },
});
registerNativeProp('Slider', 'normalizedValue', {
  get: (c, h) => behaviourOf<SliderBehaviour>(c, h)?.normalizedValue ?? 0,
  set: (c, h, v) => behaviourOf<SliderBehaviour>(c, h)?.setNormalized(v as number),
});
export function Slider_SetValueWithoutNotify(c: Ctx, h: H, v: number): void {
  const b = behaviourOf<SliderBehaviour>(c, h);
  if (b) b.setValueWithoutNotify(v);
  else if (h.comp) h.comp.m_Value = v;
}

// ───────── Toggle ─────────
registerNativeProp('Toggle', 'isOn', {
  get: (c, h) => behaviourOf<ToggleBehaviour>(c, h)?.isOn ?? !!h.comp?.m_IsOn,
  set: (c, h, v) => {
    const b = behaviourOf<ToggleBehaviour>(c, h);
    if (b) b.isOn = !!v;
    else if (h.comp) h.comp.m_IsOn = v ? 1 : 0;
  },
});
export function Toggle_SetIsOnWithoutNotify(c: Ctx, h: H, v: boolean): void {
  const b = behaviourOf<ToggleBehaviour>(c, h);
  if (b) b.setIsOnWithoutNotify(v);
  else if (h.comp) h.comp.m_IsOn = v ? 1 : 0;
}

// ───────── ScrollRect ─────────
registerNativeProp('ScrollRect', 'normalizedPosition', {
  get: (c, h) => {
    const b = behaviourOf<ScrollRectBehaviour>(c, h);
    return b ? { x: b.normalizedPosition.x, y: b.normalizedPosition.y } : { x: 0, y: 0 };
  },
  set: (c, h, v) => {
    const b = behaviourOf<ScrollRectBehaviour>(c, h);
    b?.setHorizontalNormalizedPosition((v as Vec2).x);
    b?.setVerticalNormalizedPosition((v as Vec2).y);
  },
});
registerNativeProp('ScrollRect', 'horizontalNormalizedPosition', {
  get: (c, h) => behaviourOf<ScrollRectBehaviour>(c, h)?.horizontalNormalizedPosition ?? 0,
  set: (c, h, v) => behaviourOf<ScrollRectBehaviour>(c, h)?.setHorizontalNormalizedPosition(v as number),
});
registerNativeProp('ScrollRect', 'verticalNormalizedPosition', {
  get: (c, h) => behaviourOf<ScrollRectBehaviour>(c, h)?.verticalNormalizedPosition ?? 0,
  set: (c, h, v) => behaviourOf<ScrollRectBehaviour>(c, h)?.setVerticalNormalizedPosition(v as number),
});
registerNativeProp('ScrollRect', 'velocity', {
  get: (c, h) => {
    const b = behaviourOf<ScrollRectBehaviour>(c, h);
    return b ? { x: b.velocity.x, y: b.velocity.y } : { x: 0, y: 0 };
  },
  set: (c, h, v) => {
    const b = behaviourOf<ScrollRectBehaviour>(c, h);
    if (!b) return;
    b.velocity.x = (v as Vec2).x;
    b.velocity.y = (v as Vec2).y;
  },
});
/** ScrollRect.OnBeginDrag／OnDrag／OnEndDrag：遊戲把拖曳轉給捲動區（子物件攔了拖曳事件時常見） */
type DragHandlers = { onBeginDrag?(ev: unknown): void; onDrag?(ev: unknown): void; onEndDrag?(ev: unknown): void };
export const ScrollRect_OnBeginDrag = (c: Ctx, h: H, ev: unknown): void => behaviourOf<DragHandlers>(c, h)?.onBeginDrag?.(ev);
export const ScrollRect_OnDrag = (c: Ctx, h: H, ev: unknown): void => behaviourOf<DragHandlers>(c, h)?.onDrag?.(ev);
export const ScrollRect_OnEndDrag = (c: Ctx, h: H, ev: unknown): void => behaviourOf<DragHandlers>(c, h)?.onEndDrag?.(ev);

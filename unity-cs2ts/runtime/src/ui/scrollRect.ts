// uGUI ScrollRect：內容拖曳／滾輪／慣性／回彈（Elastic）與捲軸雙向連動（0g 製作人員名單）。
// 對應 reference/decompiled/UnityEngine.UI/UnityEngine.UI/ScrollRect.cs（10/6 讀）：
//   normalizedPosition／verticalNormalizedPosition（:380-425）、viewRect（:340-354）、velocity（:356-366）、
//   IsActive（:542-549）、OnEnable（:507-520 → onEnable）、OnDisable（:522-540 → onDisable）、
//   OnScroll（:564-602）、OnInitializePotentialDrag（:604-610）、OnBeginDrag（:612-622）、
//   OnEndDrag（:624-630）、OnDrag（:632-655）、SetContentAnchoredPosition（:657-672）、
//   LateUpdate（:674-742 → update，unscaledDeltaTime ＝ world.deltaTime）、UpdateScrollbars（:758-784）、
//   SetNormalizedPosition（:796-811）、RubberDelta（:813-816）、UpdateBounds（:931-979）、
//   AdjustBounds（:981-994）、GetBounds（:996-1005）、InternalGetBounds（:1007-1020）、
//   InternalCalculateOffset（:1027-1067）。
// 座標換算：GetBounds 用節點世界矩陣與 viewRect.worldToLocalMatrix；拖曳的本地點用 events.ts 的 screenPointToLocal
// （＝ RectTransformUtility.ScreenPointToLocalPointInRectangle）。
// 通用控制項，不寫死給名單：Template（下拉選單的 ScrollRect）也走同一條，只是 Content／Viewport 不同。
// EnsureLayoutHasRebuilt（:551-557）：啟用之後還沒排過版（m_HasRebuiltLayout，PostLayout 才設、OnDisable 清掉）就先排一次，
// Canvas.ForceUpdateCanvases 換成 world.relayout。「排過版」用 world.layoutCount 比 OnEnable 當時的值（排版之後 Rebuild(PostLayout) 設旗標）。
// 以前沒做：DeckScreen 剛放進卡片就 ScrollToRow 設 verticalNormalizedPosition，內容尺寸還是舊的，網格停在置中，第一排被標題蓋住。

import { Vector3 } from 'three';
import type { Behaviour, BehaviourContext, BehaviourRegistry } from '../engine/world';
import type { SceneGraph, SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { mathfPow, mathfSmoothDamp } from '../unity/mathf';
import type { ScrollbarBehaviour } from './scrollbar';

interface Vec2 {
  x: number;
  y: number;
}
interface Bounds {
  min: Vec2;
  max: Vec2;
  size: Vec2;
  center: Vec2;
}

/** 軸存取（C# 用 Vector2[i]，JS 的物件要用 x／y） */
function ax(v: Vec2, axis: number): number {
  return axis === 0 ? v.x : v.y;
}
function setAx(v: Vec2, axis: number, value: number): void {
  if (axis === 0) v.x = value;
  else v.y = value;
}

/** ScrollRect.RubberDelta（:813-816）：橡皮筋拖曳，超 stretch 越多、增量越小 */
export function rubberDelta(overStretching: number, viewSize: number): number {
  const f = Math.fround;
  const inner = f(f(f(f(Math.abs(overStretching)) * f(0.55)) / viewSize) + f(1));
  const oneMinus = f(f(1) - f(f(1) / inner));
  return f(f(oneMinus * f(viewSize)) * f(Math.sign(overStretching)));
}

function boundsFrom(min: Vec2, max: Vec2): Bounds {
  const size = { x: max.x - min.x, y: max.y - min.y };
  return { min, max, size, center: { x: min.x + size.x / 2, y: min.y + size.y / 2 } };
}

export interface ScrollRectBehaviour extends Behaviour {
  readonly normalizedPosition: Vec2;
  readonly verticalNormalizedPosition: number;
  readonly velocity: Vec2;
  readonly horizontalNormalizedPosition: number;
  setHorizontalNormalizedPosition(value: number): void;
  setVerticalNormalizedPosition(value: number): void;
}

export function scrollRectBehaviour(ctx: BehaviourContext): ScrollRectBehaviour {
  const { world, node, comp } = ctx;
  const g: SceneGraph = world.graph;

  let contentNode: SceneNode | null = null;
  let viewNode: SceneNode | null = null;
  let scrollbarComp: ComponentData | undefined;
  let scrollbarNode: SceneNode | null = null;

  let viewBounds: Bounds = boundsFrom({ x: 0, y: 0 }, { x: 0, y: 0 });
  let contentBounds: Bounds = boundsFrom({ x: 0, y: 0 }, { x: 0, y: 0 });
  const velocity: Vec2 = { x: 0, y: 0 };
  let pointerStart: Vec2 = { x: 0, y: 0 };
  let contentStart: Vec2 = { x: 0, y: 0 };
  let dragging = false;
  let scrolling = false;
  let prevPosition: Vec2 = { x: 0, y: 0 };
  /** OnEnable 當時的 world.layoutCount；之後又排過版就是 m_HasRebuiltLayout（-1：還沒啟用過，跟 m_HasRebuiltLayout 的初值 false 一樣要排） */
  let layoutAtEnable = -1;

  function pptrNode(ref: unknown): SceneNode | null {
    const fileID = (ref as { fileID?: string } | null)?.fileID;
    if (!fileID) return null;
    const c = g.file.components[fileID] as ComponentData | undefined;
    return c ? (g.nodes.get(c.gameObject) ?? null) : null;
  }

  // OnEnable（:507-520）的快取部分：content／viewport／捲軸參照。建立時即綁一次
  // （C# m_Content 等欄位是序列化的，未啟用也可讀）；OnEnable 重綁以反映執行期改欄位。
  function bindRefs(): void {
    contentNode = pptrNode(comp.m_Content);
    viewNode = pptrNode(comp.m_Viewport);
    const sbRef = (comp.m_VerticalScrollbar as { fileID?: string } | null)?.fileID;
    scrollbarComp = sbRef ? g.file.components[sbRef] : undefined;
    scrollbarNode = pptrNode(comp.m_VerticalScrollbar);
  }
  bindRefs();

  // viewRect（:340-354）：m_Viewport，沒有就自己
  function viewRect(): SceneNode | null {
    return viewNode ?? node;
  }

  function refScrollbar(): ScrollbarBehaviour | undefined {
    return scrollbarComp ? world.behaviour<ScrollbarBehaviour>(scrollbarComp) : undefined;
  }

  function anchoredPosition(): Vec2 {
    if (!contentNode) return { x: 0, y: 0 };
    const ap = (contentNode.transform as unknown as { m_AnchoredPosition: Vec2 }).m_AnchoredPosition;
    return { x: ap.x, y: ap.y };
  }

  // GetBounds（:996-1005）＋ InternalGetBounds（:1007-1020）：content 世界四角換到 viewRect 本地空间的 AABB
  function getBounds(): Bounds {
    if (!contentNode) return boundsFrom({ x: 0, y: 0 }, { x: 0, y: 0 });
    const r = contentNode.rect;
    const corners: Vec2[] = [
      { x: r.x, y: r.y },
      { x: r.x + r.width, y: r.y },
      { x: r.x, y: r.y + r.height },
      { x: r.x + r.width, y: r.y + r.height },
    ];
    const v = viewRect();
    const toLocal = v ? v.world.clone().invert() : null;
    const min = { x: Infinity, y: Infinity };
    const max = { x: -Infinity, y: -Infinity };
    for (const p of corners) {
      const w = new Vector3(p.x, p.y, 0).applyMatrix4(contentNode!.world);
      if (toLocal) w.applyMatrix4(toLocal);
      min.x = Math.min(min.x, w.x);
      min.y = Math.min(min.y, w.y);
      max.x = Math.max(max.x, w.x);
      max.y = Math.max(max.y, w.y);
    }
    return boundsFrom(min, max);
  }

  // AdjustBounds（:981-994）：content 比 view 小的軸拉伸到 view 大小、按 pivot 位移
  function adjustBounds(view: Bounds, pivot: Vec2, size: Vec2, pos: Vec2): void {
    const dx = view.size.x - size.x;
    const dy = view.size.y - size.y;
    if (dx > 0) {
      pos.x -= dx * (pivot.x - 0.5);
      size.x = view.size.x;
    }
    if (dy > 0) {
      pos.y -= dy * (pivot.y - 0.5);
      size.y = view.size.y;
    }
  }

  // UpdateBounds（:931-979）：Clamped 時把越界的 content 推回 view 裡面（:945-979）
  function updateBounds(): void {
    const v = viewRect();
    if (!v) return;
    const vr = v.rect;
    viewBounds = boundsFrom({ x: vr.x, y: vr.y }, { x: vr.x + vr.width, y: vr.y + vr.height });
    contentBounds = getBounds();
    if (!contentNode) return;
    const size = { ...contentBounds.size };
    let pos = { ...contentBounds.center };
    const pivot = (contentNode.transform as unknown as { m_Pivot: Vec2 }).m_Pivot;
    adjustBounds(viewBounds, pivot, size, pos);
    // C# :942-943 先寫回 m_ContentBounds（Clamped 段要讀 adjust 後的 bounds）
    contentBounds = { min: { x: pos.x - size.x / 2, y: pos.y - size.y / 2 }, max: { x: pos.x + size.x / 2, y: pos.y + size.y / 2 }, size, center: pos };
    if ((comp.m_MovementType as number) === 2) {
      const vb = viewBounds;
      const cb = contentBounds;
      let zx = 0;
      let zy = 0;
      if (vb.max.x > cb.max.x) zx = Math.min(vb.min.x - cb.min.x, vb.max.x - cb.max.x);
      else if (vb.min.x < cb.min.x) zx = Math.max(vb.min.x - cb.min.x, vb.max.x - cb.max.x);
      if (vb.min.y < cb.min.y) zy = Math.max(vb.min.y - cb.min.y, vb.max.y - cb.max.y);
      else if (vb.max.y > cb.max.y) zy = Math.min(vb.min.y - cb.min.y, vb.max.y - cb.max.y);
      if (zx * zx + zy * zy > Number.EPSILON) {
        const cur = anchoredPosition();
        pos = { x: cur.x + zx, y: cur.y + zy };
        if (!comp.m_Horizontal) pos.x = cur.x;
        if (!comp.m_Vertical) pos.y = cur.y;
        adjustBounds(viewBounds, pivot, size, pos);
      }
    }
    // C# 的 Clamped 段（:945-979）算 contentPos＝anchoredPosition＋zero 後只再 AdjustBounds，
    // 不寫回 m_ContentBounds（:966-978 是區域變數）；這裡一樣保留上面 adjust 後的寫回
  }

  // InternalCalculateOffset（:1027-1067）：把 content 移回 view 邊界要補的位移
  function internalCalculateOffset(delta: Vec2): Vec2 {
    const zero = { x: 0, y: 0 };
    if ((comp.m_MovementType as number) === 0) return zero; // Unrestricted
    const cmin = { x: contentBounds.min.x, y: contentBounds.min.y };
    const cmax = { x: contentBounds.max.x, y: contentBounds.max.y };
    if (comp.m_Horizontal) {
      cmin.x += delta.x;
      cmax.x += delta.x;
      const right = viewBounds.max.x - cmax.x;
      const left = viewBounds.min.x - cmin.x;
      if (left < -0.001) zero.x = left;
      else if (right > 0.001) zero.x = right;
    }
    if (comp.m_Vertical) {
      cmin.y += delta.y;
      cmax.y += delta.y;
      const top = viewBounds.max.y - cmax.y;
      const bottom = viewBounds.min.y - cmin.y;
      if (top > 0.001) zero.y = top;
      else if (bottom < -0.001) zero.y = bottom;
    }
    return zero;
  }

  // SetContentAnchoredPosition（:657-672）
  function setContentAnchoredPosition(position: Vec2): void {
    if (!contentNode) return;
    const cur = anchoredPosition();
    if (!comp.m_Horizontal) position.x = cur.x;
    if (!comp.m_Vertical) position.y = cur.y;
    if (position.x !== cur.x || position.y !== cur.y) {
      (contentNode.transform as unknown as { m_AnchoredPosition: Vec2 }).m_AnchoredPosition = { x: position.x, y: position.y };
      updateBounds();
    }
  }

  // normalizedPosition（:380-391）／horizontalNormalizedPosition（:393-409）／verticalNormalizedPosition（:411-427）：
  // 軸向共用一個算法；content 不比 view 大時比 min 邊（垂直 top＝1、水平右＝1，照原文比較方向）
  function axisNormalized(axis: number): number {
    updateBounds();
    const key = axis === 0 ? 'x' : 'y';
    if (contentBounds.size[key] <= viewBounds.size[key] || Math.abs(contentBounds.size[key] - viewBounds.size[key]) < 1e-6) {
      return viewBounds.min[key] > contentBounds.min[key] ? 1 : 0;
    }
    return (viewBounds.min[key] - contentBounds.min[key]) / (contentBounds.size[key] - viewBounds.size[key]);
  }

  function verticalNormalized(): number {
    return axisNormalized(1);
  }

  // EnsureLayoutHasRebuilt（:551-557）
  function ensureLayoutHasRebuilt(): void {
    const hasRebuiltLayout = layoutAtEnable >= 0 && world.layoutCount > layoutAtEnable;
    if (!hasRebuiltLayout && !world.inLayout) world.relayout();
  }

  // SetNormalizedPosition（:796-811）
  function setNormalizedPosition(value: number, axis: number): void {
    ensureLayoutHasRebuilt();
    updateBounds();
    const range = ax(contentBounds.size, axis) - ax(viewBounds.size, axis);
    const viewMin = ax(viewBounds.min, axis) - value * range;
    const cur = anchoredPosition();
    const target = ax(cur, axis) + viewMin - ax(contentBounds.min, axis);
    if (Math.abs(ax(cur, axis) - target) > 0.01) {
      setAx(cur, axis, target);
      (contentNode!.transform as unknown as { m_AnchoredPosition: Vec2 }).m_AnchoredPosition = { x: cur.x, y: cur.y };
      setAx(velocity, axis, 0);
      updateBounds();
    }
  }

  // UpdateScrollbars（:758-784）：由 ScrollRect 驅動捲軸 size 與 value（setValueWithoutNotify 不回填 → 不成環）
  function updateScrollbars(offset: Vec2): void {
    const sb = refScrollbar();
    if (!sb) return;
    const ratio = contentBounds.size.y > 0 ? (viewBounds.size.y - Math.abs(offset.y)) / contentBounds.size.y : 1;
    sb.setSize(Math.min(Math.max(ratio, 0), 1));
    sb.setValueWithoutNotify(verticalNormalized());
  }

  // UpdateOneScrollbarVisibility（:878-895），Permanent 且垂直：捲軸跟 vertical 同開關
  function updateScrollbarVisibility(): void {
    const sbComp = scrollbarComp;
    if (!sbComp || (comp.m_VerticalScrollbarVisibility as number) !== 0) return;
    const sbNode = scrollbarNode;
    const want = !!comp.m_Vertical;
    if (sbNode && !!sbNode.go.m_IsActive !== want) g.setActive(sbNode, want);
  }

  function isActive(): boolean {
    return node.activeInHierarchy && comp.m_Enabled !== 0 && !!contentNode;
  }

  function setVerticalNormalizedPosition(value: number): void {
    setNormalizedPosition(value, 1);
  }

  const self: ScrollRectBehaviour = {
    // OnEnable（:507-520）：vertical 且有垂直捲軸 → 接 onValueChanged 回連；快取 content／viewport／捲軸。
    // 快取同時在建立時就跑一次（見下方 bindRefs）：C# 的 m_Content 是序列化欄位、任何時候可讀
    // （normalizedPosition getter 在未啟用時照樣 UpdateBounds），不能等 OnEnable 才綁。
    onEnable() {
      layoutAtEnable = world.layoutCount;
      bindRefs();
      if (comp.m_Vertical && scrollbarComp) refScrollbar()?.addValueListener(setVerticalNormalizedPosition);
      prevPosition = anchoredPosition();
    },
    // OnDisable（:522-540）：卸連、清拖曳與速度
    onDisable() {
      layoutAtEnable = -1;
      if (scrollbarComp) refScrollbar()?.removeValueListener(setVerticalNormalizedPosition);
      dragging = false;
      scrolling = false;
      velocity.x = 0;
      velocity.y = 0;
    },
    // LateUpdate（:674-742）：慣性＋回彈，照原版用 Time.unscaledDeltaTime（ScrollRect.cs:682）
    update() {
      if (!contentNode) return;
      ensureLayoutHasRebuilt();
      updateBounds();
      const udt = world.unscaledDeltaTime;
      const offset = internalCalculateOffset({ x: 0, y: 0 });
      if (udt > 0 && !dragging && (offset.x !== 0 || offset.y !== 0 || velocity.x !== 0 || velocity.y !== 0)) {
        const ap = anchoredPosition();
        for (let i = 0; i < 2; i++) {
          if ((comp.m_MovementType as number) === 1 && ax(offset, i) !== 0) {
            // Elastic 回彈：SmoothDamp 往邊界，smoothTime ＝ elasticity（捲動中 ×3）
            const num = (comp.m_Elasticity as number) * (scrolling ? 3 : 1);
            const cur = anchoredPosition();
            const r = mathfSmoothDamp(ax(cur, i), ax(cur, i) + ax(offset, i), ax(velocity, i), num, Infinity, udt);
            setAx(ap, i, r.value);
            setAx(velocity, i, Math.abs(r.velocity) < 1 ? 0 : r.velocity);
          } else if (comp.m_Inertia) {
            const decayed = Math.fround(Math.fround(ax(velocity, i)) * mathfPow(comp.m_DecelerationRate as number, udt));
            setAx(velocity, i, Math.abs(decayed) < 1 ? 0 : decayed);
            setAx(ap, i, Math.fround(ax(ap, i) + Math.fround(ax(velocity, i) * Math.fround(udt))));
          } else {
            setAx(velocity, i, 0);
          }
        }
        if ((comp.m_MovementType as number) === 2) {
          // Clamped（:720-724）：慣性落點再算一次偏移拉回 view 內
          const cur0 = anchoredPosition();
          const off2 = internalCalculateOffset({ x: ap.x - cur0.x, y: ap.y - cur0.y });
          ap.x += off2.x;
          ap.y += off2.y;
        }
        setContentAnchoredPosition(ap);
      }
      if (udt > 0 && dragging && comp.m_Inertia) {
        // m_Velocity ＝ Vector3.Lerp(velocity, (content − prev)/dt, dt×10)
        const ap = anchoredPosition();
        const bx = (ap.x - prevPosition.x) / udt;
        const by = (ap.y - prevPosition.y) / udt;
        const t = Math.min(udt * 10, 1);
        velocity.x += (bx - velocity.x) * t;
        velocity.y += (by - velocity.y) * t;
      }
      updateScrollbars(offset);
      prevPosition = anchoredPosition();
      updateScrollbarVisibility();
      scrolling = false;
    },
    // OnScroll（:564-602）：content += −scrollDelta × sensitivity（垂直時 x 歸零）
    onScroll(ev) {
      if (!isActive()) return;
      ensureLayoutHasRebuilt();
      updateBounds();
      const sd = { x: ev.scrollDelta.x, y: -ev.scrollDelta.y };
      const vertical = !!comp.m_Vertical;
      const horizontal = !!comp.m_Horizontal;
      if (vertical && !horizontal) {
        if (Math.abs(sd.x) > Math.abs(sd.y)) sd.y = sd.x;
        sd.x = 0;
      }
      if (horizontal && !vertical) {
        if (Math.abs(sd.y) > Math.abs(sd.x)) sd.x = sd.y;
        sd.y = 0;
      }
      scrolling = true;
      const cur = anchoredPosition();
      const sens = comp.m_ScrollSensitivity as number;
      const target = { x: cur.x + sd.x * sens, y: cur.y + sd.y * sens };
      if ((comp.m_MovementType as number) === 2) {
        // Clamped（:596-599）：目的地先算出來，再補上「把它拉回 view 內」的偏移一起設
        const off = internalCalculateOffset({ x: target.x - cur.x, y: target.y - cur.y });
        target.x += off.x;
        target.y += off.y;
      }
      setContentAnchoredPosition(target);
      updateBounds();
    },
    // OnInitializePotentialDrag（:604-610）：左鍵起拖先停速度
    onInitializePotentialDrag(ev) {
      if (ev && (ev as { button?: number }).button === 0) {
        velocity.x = 0;
        velocity.y = 0;
      }
    },
    // OnBeginDrag（:612-622）
    onBeginDrag(ev) {
      if (!isActive() || !contentNode) return;
      updateBounds();
      const v = viewRect();
      const s = world.events.screenSize;
      const local = v ? world.events.screenPointToLocal(v, ev.position.x, ev.position.y, s.w, s.h) : null;
      pointerStart = local ? { x: local.x, y: local.y } : { x: 0, y: 0 };
      contentStart = anchoredPosition();
      dragging = true;
    },
    // OnEndDrag（:624-630）
    onEndDrag() {
      dragging = false;
    },
    // OnDrag（:632-655）：Elastic 超界用 RubberDelta 阻尼
    onDrag(ev) {
      if (!dragging || !isActive() || !contentNode) return;
      const v = viewRect();
      const s = world.events.screenSize;
      const local = v ? world.events.screenPointToLocal(v, ev.position.x, ev.position.y, s.w, s.h) : null;
      if (!local) return;
      updateBounds();
      const cur = anchoredPosition();
      const vec2 = { x: contentStart.x + (local.x - pointerStart.x), y: contentStart.y + (local.y - pointerStart.y) };
      const off = internalCalculateOffset({ x: vec2.x - cur.x, y: vec2.y - cur.y });
      vec2.x += off.x;
      vec2.y += off.y;
      if ((comp.m_MovementType as number) === 1) {
        if (off.x !== 0) vec2.x -= rubberDelta(off.x, viewBounds.size.x);
        if (off.y !== 0) vec2.y -= rubberDelta(off.y, viewBounds.size.y);
      }
      setContentAnchoredPosition(vec2);
    },
    get normalizedPosition() {
      return { x: axisNormalized(0), y: axisNormalized(1) };
    },
    get verticalNormalizedPosition() {
      return verticalNormalized();
    },
    // horizontalNormalizedPosition（:393-409）：content 比 view 寬時值不是 0（LootScene/Scroller 水平捲動用）
    get horizontalNormalizedPosition() {
      return axisNormalized(0);
    },
    setHorizontalNormalizedPosition(value: number) {
      setNormalizedPosition(value, 0);
    },
    // velocity（:356-366）：C# 的 m_Velocity 是 Vector2 struct，property 回傳拷貝；這裡回傳複本，
    // 呼叫端改動不會寫回內部狀態
    get velocity() {
      return { x: velocity.x, y: velocity.y };
    },
    setVerticalNormalizedPosition,
  };
  return self;
}

export const SCROLLRECT_BEHAVIOURS: BehaviourRegistry = {
  ScrollRect: (ctx) => scrollRectBehaviour(ctx),
};

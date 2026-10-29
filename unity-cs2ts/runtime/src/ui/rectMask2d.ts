// RectMask2D 裁切。對應（10/6 讀原文）：
//   reference/decompiled/UnityEngine.UI/UnityEngine.UI/RectMask2D.cs
//     （Canvas 屬性 :76-97、canvasRect :97、IsRaycastLocationValid :147-154、
//      PerformClipping :156-212、UpdateClipSoftness :214-228）
//   reference/decompiled/UnityEngine.UI/UnityEngine.UI/ClipperRegistry.cs（Cull :37-45）
//   reference/decompiled/UnityEngine.UI/UnityEngine.UI/MaskUtilities.cs
//     （GetRectMaskForClippable :108-144、GetRectMasksForClip :146-176）
//   reference/decompiled/UnityEngine.UI/UnityEngine.UI/Clipping.cs（FindCullAndClipWorldRect）
//   reference/decompiled/UnityEngine.UI/UnityEngine.UI/RectangularVertexClipper.cs（GetCanvasRect）
//   reference/decompiled/UnityEngine.UI/UnityEngine.UI/MaskableGraphic.cs
//     （Cull :143-148、UpdateCull :150-159、SetClipRect :160-170、SetClipSoftness :171-175、
//      UpdateClipParent :231-247）
//   reference/tmp-src/pre.4/package/Scripts/Runtime/TextMeshProUGUI.cs（Cull 覆寫 :365-420）
//   reference/tmp-src/pre.4/package/Scripts/Runtime/TMPro_UGUI_Private.cs（GetCanvasSpaceClippingRect :4738）
//
// 原版是事件式：RectMask2D.OnEnable 註冊進 ClipperRegistry、ClipperRegistry.Cull 在排版之後、
// Graphic 重建之前跑（CanvasUpdateRegistry.cs:113）、Notify2DMaskStateChanged 叫所有 MaskableGraphic
// 重抓 parent mask。這邊沒有元件 OnEnable 掛鉤可攔，改成每格排版後全量重算：parent mask 查詢
// （UpdateClipParent 的等價）、PerformClipping、Cull 都照原版公式逐格重跑，結果與原版逐格一致。
//
// 座標空間：算出的是原版同一個空間——RectMask2D 所屬「最頂 Canvas」（Canvas 屬性取
// GetComponentsInParent 的 list[Count-1]，即 rootCanvas）。繪製端在填 cbuffer 時把 rect 變換到
// Graphic 自己的空間（轉換只在旋轉為 90 度倍數時等價，不等價的物件記進繪製報告，見 sceneRenderer）。
//
// canvasRenderer.hasMoved 的對應：Cull 每格全算，不需要位移偵測（說明在 cullAll 註解）。

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { SceneGraph, SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { componentKind } from '../unity/componentKind';
import type { Rect } from './rectTransform';

/** 一個 Graphic 的裁切狀態。rect 在 root（最頂 Canvas）的空間；valid false ＝ DisableRectClipping */
export interface ClipState {
  root: SceneNode;
  rect: Rect;
  valid: boolean;
  /** MaskableGraphic.SetClipSoftness 寫進 canvasRenderer.clippingSoftness 的值（原版 Vector2Int，取整） */
  softness: { x: number; y: number };
}

interface Padding {
  x: number;
  y: number;
  z: number;
  w: number;
}

const NO_PADDING: Padding = { x: 0, y: 0, z: 0, w: 0 };

/** RectMask2D 元件（啟用、物件 activeInHierarchy）；兩個會餵 tryRectMask 的呼叫端都要 active 檢查，留參 */
export function rectMaskComp(graph: SceneGraph, node: SceneNode, requireActive: boolean): { m_Padding?: Padding; m_Softness?: { x: number; y: number } } | null {
  if (requireActive && !node.activeInHierarchy) return null;
  const c = graph.component(node, 'RectMask2D');
  return c && c.m_Enabled !== 0 ? (c as { m_Padding?: Padding; m_Softness?: { x: number; y: number } }) : null;
}

/** 往上最頂的 Canvas（RectMask2D.Canvas :76-97 ＝ list[Count-1]；Graphic 端 canvas.rootCanvas 同一個） */
export function topCanvas(graph: SceneGraph, node: SceneNode): SceneNode | null {
  let found: SceneNode | null = null;
  for (let n: SceneNode | null = node; n; n = n.parent) if (graph.component(n, 'Canvas')) found = n;
  return found;
}

/**
 * RectangularVertexClipper.GetCanvasRect：rect 四角 → 世界 → canvas 空間，角 0 與角 2 張成 rect。
 * 有旋轉時跟原版一樣只看對角（矩形會擰斜，原版也這樣）。
 */
export function getCanvasRect(node: SceneNode, rootCanvas: SceneNode): Rect {
  const inv = rootCanvas.world.clone().invert();
  const r = node.rect;
  const p0 = new Vector3(r.x, r.y, 0).applyMatrix4(node.world).applyMatrix4(inv);
  const p2 = new Vector3(r.x + r.width, r.y + r.height, 0).applyMatrix4(node.world).applyMatrix4(inv);
  return { x: p0.x, y: p0.y, width: p2.x - p0.x, height: p2.y - p0.y };
}

/**
 * MaskUtilities.GetRectMasksForClip（:146-176）：從 clipper 往上收集生效的 RectMask2D（含自己），
 * 照 worlds 由外往內排。中間隔著一個「不包含該 mask」的 overrideSorting Canvas 就跳過該 mask。
 */
export function getRectMasksForClip(graph: SceneGraph, clipper: SceneNode): SceneNode[] {
  const masks: SceneNode[] = [];
  for (let n: SceneNode | null = clipper; n; n = n.parent) {
    if (!rectMaskComp(graph, n, true)) continue;
    // clipper 自己一定是 mask；上面的每個 RectMask2D 都要 isActiveAndEnabled（:163 IsActive）
    let blocked = false;
    for (let c: SceneNode | null = clipper; c && c !== n; c = c.parent) {
      const cv = graph.component(c, 'Canvas');
      if (cv && (cv.m_OverrideSorting as number) !== 0) {
        blocked = true;
        break;
      }
    }
    if (!blocked) masks.unshift(n);
  }
  return masks;
}

/**
 * MaskUtilities.GetRectMaskForClippable（:108-144）：Graphic 往上第一個生效的 RectMask2D 是 parent
 * mask（自己在 rectMask2D 屬同一 Canvas 時不裁自己：:119-123 跳過後才繼續往上）。 Graphic 與該 mask
 * 之間隔著一個不包含 mask 的 overrideSorting Canvas 時，mask 擋掉（:129-137）。
 */
export function parentMaskOf(graph: SceneGraph, graphicNode: SceneNode): SceneNode | null {
  for (let n: SceneNode | null = graphicNode.parent; n; n = n.parent) {
    if (!rectMaskComp(graph, n, true)) continue;
    // mask 生效；Graphic 往上到 mask 之間（含 Graphic 自己）的 Canvas 若有 overrideSorting 且 mask
    // 不在它裡面（往上走遇到 Canvas 在 mask 之下就是這種），擋掉
    for (let c: SceneNode | null = graphicNode; c && c !== n; c = c.parent) {
      const cv = graph.component(c, 'Canvas');
      if (cv && (cv.m_OverrideSorting as number) !== 0) return null;
    }
    return n;
  }
  return null;
}

/**
 * Clipping.FindCullAndClipWorldRect：所有 RectMask2D 的 canvasRect 扣 padding 取交集。
 * 交集空 → cull true（回傳的 rect 範圍無效）。
 */
export function findCullAndClipWorldRect(graph: SceneGraph, clippers: SceneNode[]): { rect: Rect; cull: boolean } {
  if (!clippers.length) return { rect: { x: 0, y: 0, width: 0, height: 0 }, cull: true };
  let xMin = Number.NEGATIVE_INFINITY;
  let yMin = Number.NEGATIVE_INFINITY;
  let xMax = Number.POSITIVE_INFINITY;
  let yMax = Number.POSITIVE_INFINITY;
  for (const m of clippers) {
    const root = topCanvas(graph, m)!;
    const r = getCanvasRect(m, root);
    const p = (rectMaskComp(graph, m, false)?.m_Padding as Padding) ?? NO_PADDING;
    xMin = Math.max(xMin, r.x + p.x);
    yMin = Math.max(yMin, r.y + p.y);
    xMax = Math.min(xMax, r.x + r.width - p.z);
    yMax = Math.min(yMax, r.y + r.height - p.w);
  }
  // Clipping.cs:42-47：validRect ＝ xMax > xMin && yMax > yMin（寬或高為 0 即無效），
  // 無效回 default(Rect) ＝ 零矩形（不是零寬但保留高）
  const valid = xMax > xMin && yMax > yMin;
  return { rect: valid ? { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin } : { x: 0, y: 0, width: 0, height: 0 }, cull: !valid };
}

/**
 * Rect.Overlaps(other, allowInverse: true)（MaskableGraphic.cs:146、RectMask2D.cs:170）：
 * 負寬高先翻正（xMin＝min(x, x＋width)、xMax＝max(x, x＋width)，y 同）再嚴格比較——
 * 邊界相接（重疊面積 0）算 false。
 */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  const ax0 = Math.min(a.x, a.x + a.width);
  const ax1 = Math.max(a.x, a.x + a.width);
  const ay0 = Math.min(a.y, a.y + a.height);
  const ay1 = Math.max(a.y, a.y + a.height);
  const bx0 = Math.min(b.x, b.x + b.width);
  const bx1 = Math.max(b.x, b.x + b.width);
  const by0 = Math.min(b.y, b.y + b.height);
  const by1 = Math.max(b.y, b.y + b.height);
  return ax1 > bx0 && bx1 > ax0 && ay1 > by0 && by1 > ay0;
}

/** MaskableGraphic.rootCanvasRect：rect 四角在根 Canvas 空間的 AABB（Graphic.rootCanvasRect :） */
export function rootCanvasRectOf(node: SceneNode, root: SceneNode, inv: Matrix4 = root.world.clone().invert()): Rect {
  const r = node.rect;
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  const p = SCRATCH;
  for (let i = 0; i < 4; i++) {
    p.set(i & 1 ? r.x + r.width : r.x, i & 2 ? r.y + r.height : r.y, 0).applyMatrix4(node.world).applyMatrix4(inv);
    xMin = Math.min(xMin, p.x);
    yMin = Math.min(yMin, p.y);
    xMax = Math.max(xMax, p.x);
    yMax = Math.max(yMax, p.y);
  }
  return { x: xMin, y: yMin, width: xMax - xMin, height: yMax - yMin };
}
const SCRATCH = new Vector3();
const NO_MASK = { mask: null, blocked: false };

/**
 * TextMeshProUGUI.GetCanvasSpaceClippingRect（TMPro_UGUI_Private.cs:4738）：文字複合 bounds
 * （自己空間）換到根 Canvas 空間。position 是 Graphic 原點在 Canvas 空間的位置，
 * lossyScale ＝ Graphic lossyScale ／ Canvas lossyScale（各軸相除）。
 * 注意跟 rect 版不同：bounds 的角是 min／max，不是對角。
 */
function textClippingRect(node: SceneNode, root: SceneNode, min: Vector3, max: Vector3): Rect {
  const pos = new Vector3().setFromMatrixPosition(node.world).applyMatrix4(root.world.clone().invert());
  const s = new Vector3();
  node.world.decompose(new Vector3(), new Quaternion(), s);
  const cs = new Vector3();
  root.world.decompose(new Vector3(), new Quaternion(), cs);
  const sx = cs.x === 0 ? 1 : s.x / cs.x;
  const sy = cs.y === 0 ? 1 : s.y / cs.y;
  return { x: pos.x + min.x * sx, y: pos.y + min.y * sy, width: (max.x - min.x) * sx, height: (max.y - min.y) * sy };
}

/** Mathf.Round（banker's rounding；softness 進 canvasRenderer.clippingSoftness 的 Vector2Int） */
function round(v: number): number {
  const f = Math.floor(v);
  const d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/**
 * RectMask2D.IsRaycastLocationValid（:147-154）＝ RectangleContainsScreenPoint（含 padding）。
 * p 是射線在該 Graphic 的 Canvas 平面上的世界點；正交攝影機、Canvas 都跟攝影機平行，
 * 所以同一直線上的點在 mask 平面跟 Graphic 平面座標一致，直接換到 mask 空間比 rect（扣 padding）。
 * padding 方向同 findCullAndClipWorldRect：正值讓可命中範圍變小。
 */
export function rectMaskRaycastValid(graph: SceneGraph, maskNode: SceneNode, p: Vector3): boolean {
  const c = rectMaskComp(graph, maskNode, true);
  if (!c) return true;
  const q = p.clone().applyMatrix4(maskNode.world.clone().invert());
  const r = maskNode.rect;
  const pad = (c.m_Padding as Padding) ?? NO_PADDING;
  return q.x >= r.x + pad.x && q.x <= r.x + r.width - pad.z && q.y >= r.y + pad.y && q.y <= r.y + r.height - pad.w;
}

/** 每個 Graphic（有 CanvasRenderer 的節點）一格的狀態追蹤 */
interface GraphicRec {
  /** parent mask 節點 id；null ＝ 沒掛勾（GetRectMaskForClippable 回 null） */
  parent: string | null;
  /** TMP 的文字複合 bounds（自己空間，繪製端產好網格回報）；非 TMP 是 null → cull 用 rect 四角 */
  textBounds: { min: Vector3; max: Vector3 } | null;
}

const GRAPHICS = new Set(['Image', 'RawImage', 'TextMeshProUGUI', 'Text']);

/**
 * 裁切管理器。每格排版後呼叫 cullAll（ClipperRegistry.Cull 的時機：排版之後、Graphic 重建之前）。
 * 狀態存在這邊，不在元件上：clips（canvasRenderer 的 clip rect 對應）、culled（canvasRenderer.cull）。
 */
export class RectClipRegistry {
  private clips = new Map<string, ClipState>();
  private culled = new Set<string>();
  private recs = new Map<string, GraphicRec>();
  /** mask 節點 id → 上一格發給 targets 的 rect（m_LastClipRectCanvasSpace；決定 SetClipRect／Cull 分支） */
  private lastMaskRect = new Map<string, string>();
  /** PerformClipping 的 m_ForceClip：上一格有 target 掛勾變化 */
  private forceClip = new Set<string>();
  /** 除錯：這一格 cull 翻轉的節點 id */
  public culledChanged = new Set<string>();
  /** 除錯：每格逐格記憶的 parent mask 跟 parentMaskOf 逐個比對，不一樣的次數記在 verifyMismatches */
  public verify = false;
  public verifyMismatches = 0;

  constructor(readonly graph: SceneGraph) {}

  /** 繪製端產好 TMP 網格後回報複合 bounds（自己空間）。下一格 cullAll 的 Cull 用它取代 rect 四角（TMP Cull :365-420）。 */
  setTextBounds(nodeId: string, min: Vector3, max: Vector3): void {
    const rec = this.recs.get(nodeId);
    if (rec) rec.textBounds = { min, max };
  }

  clipOf(nodeId: string): ClipState | null {
    return this.clips.get(nodeId) ?? null;
  }

  isCulled(nodeId: string): boolean {
    return this.culled.has(nodeId);
  }

  /** 除錯介面：全部狀態快照 */
  snapshot(): { clips: [string, { rect: Rect; valid: boolean; softness: { x: number; y: number }; root: string }][]; culled: string[] } {
    return {
      clips: [...this.clips.entries()].map(([id, s]) => [id, { rect: s.rect, valid: s.valid, softness: s.softness, root: s.root.id }]),
      culled: [...this.culled],
    };
  }

  /**
   * Object.Destroy（unity/instantiate.ts destroy）用的除名：cullAll 只清 recs 的死籍
   * （`if (!alive.has(id)) this.recs.delete(id)`），clips／culled／lastMaskRect／forceClip 要等
   * 「換掛勾」分支才動，已銷毀節點不會再進 cullAll 的迴圈，必須主動拔掉。
   */
  forget(nodeIds: Iterable<string>): void {
    for (const id of nodeIds) {
      this.clips.delete(id);
      this.culled.delete(id);
      this.recs.delete(id);
      this.lastMaskRect.delete(id);
      this.forceClip.delete(id);
    }
  }

  /**
   * ClipperRegistry.Cull（:37-45）＋ 每個生效 RectMask2D 的 PerformClipping（:156-212）。
   * 回傳「裁切狀態這一格有變」的 Graphic 節點 id：對應 SetClipRect／Cull 觸發的 canvasRenderer 重建
   * （原版 SetClipRect 改 renderer → 下一格重建；keyword 開關要重產網格的呼叫端拿它換材質）。
   *
   * canvasRenderer.hasMoved 的對應（回報裡有寫）：原版靠它在 rect 沒變時少算 Cull（:202-207 分支），
   * 這裡每格無條件重算 Cull（輸入相同結果相同），所以不需要對應的位移偵測。
   */
  cullAll(): Set<string> {
    const dirty = new Set<string>();
    this.culledChanged.clear();
    // 1. Graphic 記錄與掛勾（UpdateClipParent :231-247）
    const alive = new Set<string>();
    const targetIdsByMask = new Map<string, string[]>();
    // 候選（有 CanvasRenderer 與 Graphic 元件的 RectTransform；mask 是有 RectMask2D 的節點）只隨節點與元件增減變
    // （SceneGraph.cached 的 membership），順序跟掃全樹一樣；啟用、canvas、元件開關每次照舊判斷
    // 每個候選也記下它的 Graphic 元件（照元件順序）與節點上的 RectMask2D／Canvas 元件：元件增減才會變（membership），
    // 以前每格每個候選重找一次、parentMaskOf 往上每一層再掃一次元件（MT2 戰鬥，10/18）
    const { graphics, masks, maskComps, canvasComps } = this.graph.cached(
      'rectMask2d.candidates',
      () => {
        const graphics: { node: SceneNode; comps: ComponentData[] }[] = [];
        const maskComps = new Map<SceneNode, ComponentData>();
        const canvasComps = new Map<SceneNode, ComponentData>();
        for (const n of this.graph.nodes.values()) {
          if (n.isRect && !!this.graph.component(n, 'CanvasRenderer')) {
            const comps = this.graph.components(n).filter((c) => !!c.script && GRAPHICS.has(componentKind(c)));
            if (comps.length) graphics.push({ node: n, comps });
          }
          const m = this.graph.component(n, 'RectMask2D');
          if (m) maskComps.set(n, m);
          const cv = this.graph.component(n, 'Canvas');
          if (cv) canvasComps.set(n, cv);
        }
        return { graphics, masks: [...maskComps.keys()], maskComps, canvasComps };
      },
      'membership',
    );
    // parentMaskOf 的逐格記憶（同一格裡啟用狀態、元件開關不變）：up(n) ＝ n 與它的祖先裡第一個生效的 RectMask2D，
    // 加上從 n 往上到它（不含）之間有沒有 overrideSorting 的 Canvas。結果同 parentMaskOf
    const up = new Map<SceneNode, { mask: SceneNode | null; blocked: boolean }>();
    const overrides = (n: SceneNode): boolean => {
      const cv = canvasComps.get(n);
      return !!cv && (cv.m_OverrideSorting as number) !== 0;
    };
    const upOf = (n: SceneNode | null): { mask: SceneNode | null; blocked: boolean } => {
      if (!n) return NO_MASK;
      let hit = up.get(n);
      if (hit) return hit;
      const mc = n.activeInHierarchy ? maskComps.get(n) : undefined;
      if (mc && mc.m_Enabled !== 0) hit = { mask: n, blocked: false };
      else {
        const p = upOf(n.parent);
        hit = p.mask && !p.blocked && overrides(n) ? { mask: p.mask, blocked: true } : p;
      }
      up.set(n, hit);
      return hit;
    };
    for (const { node, comps } of graphics) {
      if (!node.activeInHierarchy || !node.canvas) continue;
      let g: ComponentData | undefined;
      for (const c of comps) if (c.m_Enabled !== 0) { g = c; break; }
      if (!g) continue;
      // m_Maskable 0 不裁（UpdateClipParent :233 的 maskable 條件；GetRectMaskForClippable 的 call site）
      const canClip = g.m_Maskable !== 0;
      alive.add(node.id);
      let pm: SceneNode | null = null;
      if (canClip) {
        const u = upOf(node.parent);
        pm = u.mask && !u.blocked && !overrides(node) ? u.mask : null;
        if (this.verify && pm !== parentMaskOf(this.graph, node)) this.verifyMismatches++;
      }
      let rec = this.recs.get(node.id);
      if (!rec) {
        rec = { parent: null, textBounds: null };
        this.recs.set(node.id, rec);
      }
      const pmId = pm ? pm.id : null;
      if (rec.parent !== pmId) {
        // 換掛勾：舊的 RemoveClippable＋UpdateCull(false)，新的 AddClippable（:235-244）
        if (rec.parent !== null) {
          this.clips.delete(node.id);
          if (this.culled.delete(node.id)) this.culledChanged.add(node.id);
        }
        rec.parent = pmId;
        if (pmId !== null) this.forceClip.add(pmId);
        dirty.add(node.id);
      }
      if (pmId !== null) {
        const list = targetIdsByMask.get(pmId) ?? [];
        list.push(node.id);
        targetIdsByMask.set(pmId, list);
      } else if (this.clips.has(node.id)) {
        this.clips.delete(node.id);
        dirty.add(node.id);
      }
    }
    for (const id of [...this.recs.keys()]) if (!alive.has(id)) this.recs.delete(id);

    // 2. 每個生效 RectMask2D 跑 PerformClipping
    // 根 Canvas 的反矩陣（rootCanvasRectOf 每個 target 都要；同一格同一個根算一次，值一樣）
    const invs = new Map<SceneNode, Matrix4>();
    const invOf = (root: SceneNode): Matrix4 => {
      let m = invs.get(root);
      if (!m) invs.set(root, (m = root.world.clone().invert()));
      return m;
    };
    for (const node of masks) {
      if (!rectMaskComp(this.graph, node, true)) continue;
      if (!topCanvas(this.graph, node)) continue; // Canvas == null 直接 return（:158-161）
      const targets = targetIdsByMask.get(node.id) ?? [];
      if (!targets.length) continue;
      const clippers = getRectMasksForClip(this.graph, node);
      if (!clippers.length) continue;
      const root = topCanvas(this.graph, node)!;
      const { rect, cull } = findCullAndClipWorldRect(this.graph, clippers);
      let valid = !cull;
      let clipRect = rect;
      const renderMode = this.graph.component(root, 'Canvas')!.m_RenderMode as number;
      // 根 Canvas 是 Screen Space 才跟整個 Canvas 比（:169-174）；World Space 不做
      if ((renderMode === 0 || renderMode === 1) && !rectsOverlap(clipRect, rootCanvasRectOf(root, root))) {
        clipRect = { x: 0, y: 0, width: 0, height: 0 };
        valid = false;
      }
      const soft = rectMaskComp(this.graph, node, false)?.m_Softness ?? { x: 0, y: 0 };
      const softness = { x: round(Math.max(0, soft.x)), y: round(Math.max(0, soft.y)) };
      const key = `${clipRect.x},${clipRect.y},${clipRect.width},${clipRect.height},${valid},${softness.x},${softness.y}`;
      const changed = this.lastMaskRect.get(node.id) !== key;
      const force = this.forceClip.delete(node.id);
      this.lastMaskRect.set(node.id, key);
      for (const id of targets) {
        const target = this.graph.nodes.get(id);
        if (!target) continue;
        const rec = this.recs.get(id)!;
        const cr = this.graph.component(target, 'CanvasRenderer');
        if (cr) cr.$clippingSoftness = softness; // MaskableGraphic.SetClipSoftness :171-175 → canvasRenderer.clippingSoftness
        if (changed || force) {
          // SetClipRect（:160-170：valid 才 EnableRectClipping）
          this.clips.set(id, { root, rect: clipRect, valid, softness });
          dirty.add(id);
        }
        // Cull（MaskableGraphic.Cull :143-148／TextMeshProUGUI.Cull 覆寫 :365-420）：
        // TMP 用文字複合 bounds（GetCanvasSpaceClippingRect），其他用 rect 四角（rootCanvasRect）
        const bounds = rec.textBounds
          ? textClippingRect(target, root, rec.textBounds.min, rec.textBounds.max)
          : rootCanvasRectOf(target, root, invOf(root));
        const c = !valid || !rectsOverlap(clipRect, bounds);
        const was = this.culled.has(id);
        if (c) this.culled.add(id);
        else this.culled.delete(id);
        if (was !== c) this.culledChanged.add(id);
      }
    }
    // mask 停用／被移掉：targets 這一格在 parentMaskOf 重算後換掛勾或除名（GetRectMasksForClippable 只收 active）
    return dirty;
  }
}

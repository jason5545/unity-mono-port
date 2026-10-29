// uGUI 的自動排版（LayoutRebuilder、LayoutGroup、HorizontalOrVerticalLayoutGroup、ContentSizeFitter、LayoutElement、LayoutUtility）。
// 依據：反編譯原版 build 的 UnityEngine.UI.dll（reference/decompiled/UnityEngine.UI/，10/5）。
//
// 流程（LayoutRebuilder.Rebuild）：對每個 layout root，先「算橫向輸入」（子到父，ILayoutElement.CalculateLayoutInputHorizontal）、
// 「做橫向控制」（父到子，ILayoutController.SetLayoutHorizontal），再對縱向做一次。layout root 照 MarkLayoutForRebuild：
// 從有 ILayoutController 的物件往上，父物件有啟用的 ILayoutGroup 就繼續往上；多個 root 依深度由淺到深（CanvasUpdateRegistry.SortLayoutList）。
// 排版會改子物件的 anchor、sizeDelta、anchoredPosition（直接改場景資料），改完由 SceneGraph.layout 重算 rect 與世界矩陣。
//
// GridLayoutGroup（GridLayoutGroup.cs）與 AspectRatioFitter（AspectRatioFitter.cs）10/17 補上（MT2 的商人商品格、各種圖示；Diceomancer 沒有）。
// AspectRatioFitter 在 Unity 是 OnEnable 與尺寸改變時 UpdateRect（SetLayoutHorizontal／Vertical 不做事）；這裡每次排版都整棵重算，
// 就在控制的縱向那一趟套 UpdateRect（寬已經是這一趟定好的）。
// 還沒做：ScrollRect 的 SetLayoutHorizontal／Vertical（捲軸自動隱藏時調 viewport）、TMP_InputField 的偏好尺寸。遇到記在回報裡。

import type { SceneGraph, SceneNode } from '../unity/scene';
import type { ComponentData, RectTransformData } from '../unity/types';
import { componentKind } from '../unity/componentKind';
import { layoutRect, type Rect, ZERO_RECT } from './rectTransform';

type Axis = 0 | 1;
type RectField = 'm_SizeDelta' | 'm_AnchorMin' | 'm_AnchorMax' | 'm_AnchoredPosition';
type Prop = 'min' | 'preferred' | 'flexible';

/** 外部提供的 ILayoutElement（TMP 文字的偏好尺寸由排版模組算）。回傳 null 表示不提供 */
export type ExternalLayoutElement = (comp: ComponentData, node: SceneNode, axis: Axis, prop: Prop) => number | null;

/**
 * 遊戲腳本自己實作的 ILayoutElement（MT2 的 LayoutGroupReplacementElement：關掉 LayoutGroup 之前把它的尺寸記成 minWidth／minHeight，
 * 交給上層排版）。相容層登記怎麼認、怎麼問值（產生碼的屬性）；沒登記時腳本元件不參與排版
 */
export interface ScriptLayoutElements {
  isElement(c: ComponentData): boolean;
  /** CalculateLayoutInputHorizontal（axis 0）／Vertical（axis 1） */
  calculate(c: ComponentData, node: SceneNode, axis: Axis): void;
  value(c: ComponentData, node: SceneNode, axis: Axis, prop: Prop): number;
  priority(c: ComponentData, node: SceneNode): number;
}
let scriptElements: ScriptLayoutElements | null = null;
export function registerScriptLayoutElements(s: ScriptLayoutElements | null): void {
  scriptElements = s;
}

export interface LayoutReport {
  roots: number;
  unsupported: Record<string, number>;
  /** rebuildAll 照 defer 跳過、沒排的 root（World 記下來，腳本讀到底下的 RectTransform 時補排） */
  deferred?: SceneNode[];
}

/** 一個節點上跟排版有關的元件（照元件順序；啟用與否每次照舊判斷） */
interface NodeRoles {
  elements: ComponentData[];
  controllers: ComponentData[];
  groups: ComponentData[];
  layoutElements: ComponentData[];
}

interface GroupState {
  rectChildren: SceneNode[];
  totalMin: [number, number];
  totalPreferred: [number, number];
  totalFlexible: [number, number];
}
/**
 * 每個群組元件上一次算好的 total（LayoutGroup 的 m_TotalMinSize／m_TotalPreferredSize／m_TotalFlexibleSize）：
 * 原版只在 CalculateLayoutInput 時更新，群組關掉之後 minWidth／preferredWidth 讀到的還是關掉前的值。
 * LayoutGroupReplacementElement.DisableLayoutGroup 每次滑到別張卡都會再讀一次 preferredWidth／Height，
 * 以前群組關掉就回 0，牌組畫面的網格被 ContentSizeFitter 縮成 0×0，卡片整片往右下偏
 */
const lastTotals = new WeakMap<ComponentData, GroupState>();

/**
 * 每個節點的排版元件分類（UILayout.roles）。元件清單（GameObject 的元件 id）變了才重分；啟用與否每次照舊判斷。
 * 以前每次問都 graph.components（每次 map 一個新陣列）再逐個判斷種類，一個節點一次排版要問十幾次，每格幾千個節點（MT2 戰鬥，10/18）
 */
const roleCache = new WeakMap<SceneNode, { ids: string[]; file: unknown; roles: NodeRoles }>();

const GROUPS = new Set(['HorizontalLayoutGroup', 'VerticalLayoutGroup', 'GridLayoutGroup']);
const SELF_CONTROLLERS = new Set(['ContentSizeFitter', 'AspectRatioFitter']);

/** Mathf.Clamp：先比 min 再比 max，min > max 時回傳 min（跟 Math.min(Math.max()) 不同） */
function mathfClamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 元件種類：繼承 TMP 的遊戲類別（ExtendedTextMeshProUGUI）照 TMP 的 ILayoutElement（unity/componentKind.ts） */
function cls(c: ComponentData): string {
  return componentKind(c);
}

export class UILayout {
  private groups = new Map<ComponentData, GroupState>();

  readonly report: LayoutReport = { roots: 0, unsupported: {} };

  constructor(
    private readonly graph: SceneGraph,
    private readonly external: ExternalLayoutElement | null = null,
    /** 根 Canvas 的 rect（Screen Space 的根由螢幕大小決定，SceneGraph.layout 第一遍算好） */
    private readonly rootRect: (node: SceneNode) => Rect | null = () => null,
  ) {}

  private note(what: string) {
    this.report.unsupported[what] = (this.report.unsupported[what] ?? 0) + 1;
  }

  // ───────── RectTransform（即時算，排版過程中資料會變） ─────────

  private rt(node: SceneNode): RectTransformData {
    return node.transform as unknown as RectTransformData;
  }

  /** 寫過的 RectTransform 欄位第一次寫之前的值（wrote 比淨變化用） */
  private readonly original = new Map<RectTransformData, Partial<Record<RectField, { x: number; y: number }>>>();
  /** 跑過腳本的 CalculateLayoutInput（腳本可能自己改 transform，CurvedLayout 就會） */
  private scriptRan = false;

  /**
   * 這次排版結束時有沒有改到任何 RectTransform（跟排版前比，值真的變了才算），或跑過腳本的 CalculateLayoutInput。
   * layoutWithUI 看它決定要不要再算一遍 rect 與世界矩陣：沒改就跟第一遍一樣。比淨變化：MT2 卡上的 Button hint 每次排版
   * 都被兩個控制器先寫 60 再寫回 50（26 張卡，10/18），只看有沒有寫過的話每格都要再算一遍
   */
  get wrote(): boolean {
    if (this.scriptRan) return true;
    for (const [rt, fields] of this.original) {
      for (const k in fields) {
        const before = fields[k as RectField];
        const now = rt[k as RectField];
        if (!before || now.x !== before.x || now.y !== before.y) return true;
      }
    }
    return false;
  }

  /** 寫 RectTransform 的二維欄位：值一樣就不換 */
  private put(rt: RectTransformData, field: RectField, v: { x: number; y: number }) {
    const old = rt[field];
    if (old && old.x === v.x && old.y === v.y) return;
    let rec = this.original.get(rt);
    if (!rec) this.original.set(rt, (rec = {}));
    if (!(field in rec)) rec[field] = old;
    rt[field] = v;
  }

  rectOf(node: SceneNode): Rect {
    const root = this.rootRect(node);
    if (root) return root;
    if (!node.isRect) return ZERO_RECT;
    const parent = node.parent && node.parent.isRect ? this.rectOf(node.parent) : ZERO_RECT;
    return layoutRect(parent, this.rt(node)).rect;
  }

  /** RectTransform.SetSizeWithCurrentAnchors（原生；公式同 AspectRatioFitter.GetSizeDeltaToProduceSize） */
  private setSizeWithCurrentAnchors(node: SceneNode, axis: Axis, size: number) {
    const rt = this.rt(node);
    const parent = node.parent && node.parent.isRect ? this.rectOf(node.parent) : ZERO_RECT;
    const parentSize = axis === 0 ? parent.width : parent.height;
    const k = axis === 0 ? 'x' : 'y';
    this.put(rt, 'm_SizeDelta', { ...rt.m_SizeDelta, [k]: size - parentSize * (rt.m_AnchorMax[k] - rt.m_AnchorMin[k]) });
  }

  // ───────── 元件 ─────────

  private activeAndEnabled(node: SceneNode, c: ComponentData): boolean {
    return node.activeInHierarchy && c.m_Enabled !== 0;
  }

  private isLayoutElement(c: ComponentData): boolean {
    const k = cls(c);
    return (
      k === 'Image' ||
      k === 'LayoutElement' ||
      GROUPS.has(k) ||
      k === 'ScrollRect' ||
      k === 'TextMeshProUGUI' ||
      k === 'TextMeshPro' ||
      k === 'TMP_InputField' ||
      k === 'InputField' ||
      k === 'Text' ||
      (!!c.script && !!scriptElements?.isElement(c))
    );
  }

  private isLayoutController(c: ComponentData): boolean {
    const k = cls(c);
    return GROUPS.has(k) || SELF_CONTROLLERS.has(k) || k === 'ScrollRect';
  }

  private isLayoutGroup(c: ComponentData): boolean {
    const k = cls(c);
    return GROUPS.has(k) || k === 'ScrollRect';
  }

  private roles(node: SceneNode): NodeRoles {
    const ids = node.go.components;
    const hit = roleCache.get(node);
    if (hit && hit.ids.length === ids.length && hit.ids.every((id, i) => id === ids[i]) && hit.file === this.graph.file) return hit.roles;
    const comps = this.graph.components(node);
    const roles = {
      elements: comps.filter((c) => this.isLayoutElement(c)),
      controllers: comps.filter((c) => this.isLayoutController(c)),
      groups: comps.filter((c) => this.isLayoutGroup(c)),
      layoutElements: comps.filter((c) => cls(c) === 'LayoutElement'),
    };
    roleCache.set(node, { ids: [...ids], file: this.graph.file, roles });
    return roles;
  }

  /** list（roles 的一類）裡啟用中的 */
  private enabledIn(node: SceneNode, list: ComponentData[]): ComponentData[] {
    if (!node.activeInHierarchy || list.length === 0) return [];
    return list.filter((c) => c.m_Enabled !== 0);
  }

  /** ILayoutElement 的各個值 */
  private elementValue(c: ComponentData, node: SceneNode, axis: Axis, prop: Prop): number {
    const k = cls(c);
    if (k === 'LayoutElement') {
      const f = { min: ['m_MinWidth', 'm_MinHeight'], preferred: ['m_PreferredWidth', 'm_PreferredHeight'], flexible: ['m_FlexibleWidth', 'm_FlexibleHeight'] }[prop][axis];
      return c[f] as number;
    }
    if (GROUPS.has(k)) {
      const g = this.groups.get(c);
      if (!g) return prop === 'flexible' ? 0 : 0;
      return (prop === 'min' ? g.totalMin : prop === 'preferred' ? g.totalPreferred : g.totalFlexible)[axis];
    }
    if (k === 'Image') {
      if (prop === 'min') return 0;
      if (prop === 'flexible') return -1;
      return this.imagePreferred(c, node, axis);
    }
    if (k === 'ScrollRect') return -1;
    if (k === 'TextMeshProUGUI' || k === 'TextMeshPro') {
      if (prop === 'min') return 0;
      if (prop === 'flexible') return -1;
      const v = this.external?.(c, node, axis, prop);
      if (v === null || v === undefined) {
        this.note(`${k} 的偏好尺寸（沒有排版模組）`);
        return 0;
      }
      return v;
    }
    if (c.script && scriptElements?.isElement(c)) return scriptElements.value(c, node, axis, prop);
    this.note(`${k} 的偏好尺寸`);
    return -1;
  }

  private layoutPriority(c: ComponentData): number {
    const k = cls(c);
    if (k === 'LayoutElement') return c.m_LayoutPriority as number;
    if (k === 'ScrollRect') return -1;
    if (c.script && scriptElements?.isElement(c)) return this.scriptPriority(c);
    return 0;
  }
  private scriptPriority(c: ComponentData): number {
    const node = this.graph.nodes.get(c.gameObject);
    return node && scriptElements ? scriptElements.priority(c, node) : 0;
  }

  /** Image.preferredWidth／Height：sprite 大小 ÷ pixelsPerUnit；Sliced／Tiled 用邊框（DataUtility.GetMinSize） */
  private imagePreferred(c: ComponentData, node: SceneNode, axis: Axis): number {
    const sprite = this.spriteOf?.(c);
    if (!sprite) return 0;
    const refPpu = node.canvas?.referencePixelsPerUnit ?? 100;
    const ppu = sprite.m_PixelsToUnits / refPpu;
    const type = c.m_Type as number;
    if (type === 1 || type === 2) {
      const b = sprite.m_Border;
      return (axis === 0 ? b.x + b.z : b.y + b.w) / ppu;
    }
    return (axis === 0 ? sprite.m_Rect.width : sprite.m_Rect.height) / ppu;
  }

  /** Image 的 sprite（由使用端提供，排版模組不碰素材庫） */
  spriteOf: ((c: ComponentData) => { m_Rect: Rect; m_Border: { x: number; y: number; z: number; w: number }; m_PixelsToUnits: number } | null) | null = null;

  /** LayoutUtility.GetLayoutProperty */
  private layoutProperty(node: SceneNode, axis: Axis, prop: Prop, defaultValue: number): number {
    if (!node.isRect) return 0;
    let value = defaultValue;
    let priority = -2147483648;
    for (const c of this.roles(node).elements) {
      if (!this.activeAndEnabled(node, c)) continue;
      const p = this.layoutPriority(c);
      if (p < priority) continue;
      const v = this.elementValue(c, node, axis, prop);
      if (v < 0) continue;
      if (p > priority) {
        value = v;
        priority = p;
      } else if (v > value) value = v;
    }
    return value;
  }

  private minSize(node: SceneNode, axis: Axis) {
    return this.layoutProperty(node, axis, 'min', 0);
  }
  private preferredSize(node: SceneNode, axis: Axis) {
    return Math.max(this.layoutProperty(node, axis, 'min', 0), this.layoutProperty(node, axis, 'preferred', 0));
  }
  private flexibleSize(node: SceneNode, axis: Axis) {
    return this.layoutProperty(node, axis, 'flexible', 0);
  }

  // ───────── LayoutGroup ─────────

  private calculateInput(c: ComponentData, node: SceneNode, axis: Axis) {
    const k = cls(c);
    if (!GROUPS.has(k)) {
      if (k === 'LayoutElement' || k === 'Image' || k === 'ScrollRect' || k.startsWith('TextMeshPro') || k === 'TMP_InputField') return; // 值是即時算的
      if (c.script && scriptElements?.isElement(c)) {
        this.scriptRan = true;
        scriptElements.calculate(c, node, axis);
      }
      return;
    }
    if (axis === 0) {
      // LayoutGroup.CalculateLayoutInputHorizontal：收集要排的子物件
      const rectChildren: SceneNode[] = [];
      for (const ch of node.children) {
        if (!ch.isRect || !ch.activeInHierarchy) continue;
        const ignorers = this.roles(ch).layoutElements;
        if (ignorers.length === 0 || ignorers.some((x) => !x.m_IgnoreLayout)) rectChildren.push(ch);
      }
      const state: GroupState = { rectChildren, totalMin: [0, 0], totalPreferred: [0, 0], totalFlexible: [0, 0] };
      this.groups.set(c, state);
      lastTotals.set(c, state);
    }
    if (k === 'GridLayoutGroup') this.gridInput(c, node, axis);
    else this.calcAlongAxis(c, axis, k === 'VerticalLayoutGroup');
  }

  /** GridLayoutGroup.CalculateLayoutInputHorizontal／Vertical（GridLayoutGroup.cs）：照 constraint 算欄列數，flexible 是 −1 */
  private gridInput(c: ComponentData, node: SceneNode, axis: Axis) {
    const g = this.groups.get(c);
    if (!g) return;
    const pad = c.m_Padding as { m_Left: number; m_Right: number; m_Top: number; m_Bottom: number };
    const cell = (c.m_CellSize as { x: number; y: number } | undefined) ?? { x: 100, y: 100 };
    const spacing = (c.m_Spacing as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    const constraint = (c.m_Constraint as number | undefined) ?? 0;
    const count = Math.max(1, (c.m_ConstraintCount as number | undefined) ?? 2);
    const n = g.rectChildren.length;
    const set = (min: number, preferred: number) => {
      g.totalMin[axis] = min;
      g.totalPreferred[axis] = preferred;
      g.totalFlexible[axis] = -1;
    };
    if (axis === 0) {
      let minColumns: number;
      let preferredColumns: number;
      if (constraint === 1) minColumns = preferredColumns = count;
      else if (constraint === 2) minColumns = preferredColumns = Math.ceil(Math.fround(n / count) - 0.001);
      else {
        minColumns = 1;
        preferredColumns = Math.ceil(Math.sqrt(n));
      }
      const h = pad.m_Left + pad.m_Right;
      set(h + (cell.x + spacing.x) * minColumns - spacing.x, h + (cell.x + spacing.x) * preferredColumns - spacing.x);
      return;
    }
    let minRows: number;
    if (constraint === 1) minRows = Math.ceil(Math.fround(n / count) - 0.001);
    else if (constraint === 2) minRows = count;
    else {
      const width = this.rectOf(node).width;
      const cellCountX = Math.max(1, Math.floor((width - (pad.m_Left + pad.m_Right) + spacing.x + 0.001) / (cell.x + spacing.x)));
      minRows = Math.ceil(n / cellCountX);
    }
    const minSpace = pad.m_Top + pad.m_Bottom + (cell.y + spacing.y) * minRows - spacing.y;
    set(minSpace, minSpace);
  }

  /** GridLayoutGroup.SetCellsAlongAxis（GridLayoutGroup.cs）：橫向那趟設 anchor 與 cellSize，縱向那趟排兩個方向的位置 */
  private setCellsAlongAxis(c: ComponentData, node: SceneNode, axis: Axis) {
    const g = this.groups.get(c);
    if (!g) return;
    const children = g.rectChildren;
    const count = children.length;
    const cell = (c.m_CellSize as { x: number; y: number } | undefined) ?? { x: 100, y: 100 };
    if (axis === 0) {
      for (const ch of children) {
        const rt = this.rt(ch);
        this.put(rt, 'm_AnchorMin', { x: 0, y: 1 });
        this.put(rt, 'm_AnchorMax', { x: 0, y: 1 });
        this.put(rt, 'm_SizeDelta', { x: cell.x, y: cell.y });
      }
      return;
    }
    const pad = c.m_Padding as { m_Left: number; m_Right: number; m_Top: number; m_Bottom: number };
    const spacing = (c.m_Spacing as { x: number; y: number } | undefined) ?? { x: 0, y: 0 };
    const constraint = (c.m_Constraint as number | undefined) ?? 0;
    const constraintCount = Math.max(1, (c.m_ConstraintCount as number | undefined) ?? 2);
    const startCorner = (c.m_StartCorner as number | undefined) ?? 0;
    const startAxis = (c.m_StartAxis as number | undefined) ?? 0;
    const rect = this.rectOf(node);
    const width = rect.width;
    const height = rect.height;
    let cellCountX = 1;
    let cellCountY = 1;
    if (constraint === 1) {
      cellCountX = constraintCount;
      if (count > cellCountX) cellCountY = Math.trunc(count / cellCountX) + (count % cellCountX > 0 ? 1 : 0);
    } else if (constraint === 2) {
      cellCountY = constraintCount;
      if (count > cellCountY) cellCountX = Math.trunc(count / cellCountY) + (count % cellCountY > 0 ? 1 : 0);
    } else {
      cellCountX = cell.x + spacing.x <= 0 ? 2147483647 : Math.max(1, Math.floor((width - (pad.m_Left + pad.m_Right) + spacing.x + 0.001) / (cell.x + spacing.x)));
      cellCountY = cell.y + spacing.y <= 0 ? 2147483647 : Math.max(1, Math.floor((height - (pad.m_Top + pad.m_Bottom) + spacing.y + 0.001) / (cell.y + spacing.y)));
    }
    const cornerX = startCorner % 2;
    const cornerY = Math.trunc(startCorner / 2);
    let cellsPerMainAxis: number;
    let actualCellCountX: number;
    let actualCellCountY: number;
    if (startAxis === 0) {
      cellsPerMainAxis = cellCountX;
      actualCellCountX = mathfClamp(cellCountX, 1, count);
      actualCellCountY = constraint !== 2 ? mathfClamp(cellCountY, 1, Math.ceil(count / cellsPerMainAxis)) : Math.min(cellCountY, count);
    } else {
      cellsPerMainAxis = cellCountY;
      actualCellCountY = mathfClamp(cellCountY, 1, count);
      actualCellCountX = constraint !== 1 ? mathfClamp(cellCountX, 1, Math.ceil(count / cellsPerMainAxis)) : Math.min(cellCountX, count);
    }
    const requiredX = actualCellCountX * cell.x + (actualCellCountX - 1) * spacing.x;
    const requiredY = actualCellCountY * cell.y + (actualCellCountY - 1) * spacing.y;
    const startX = this.startOffset(c, node, 0, requiredX);
    const startY = this.startOffset(c, node, 1, requiredY);
    // 最後一行不滿時的補位（原版的寫法照抄）
    let lastRowOffset = 0;
    if (count > constraintCount && Math.ceil(count / cellsPerMainAxis) < constraintCount) {
      lastRowOffset = constraintCount - Math.ceil(count / cellsPerMainAxis);
      lastRowOffset += Math.floor(lastRowOffset / (cellsPerMainAxis - 1));
      if (count % cellsPerMainAxis === 1) lastRowOffset++;
    }
    for (let i = 0; i < count; i++) {
      let posX: number;
      let posY: number;
      if (startAxis === 0) {
        if (constraint === 2 && count - i <= lastRowOffset) {
          posX = 0;
          posY = constraintCount - (count - i);
        } else {
          posX = i % cellsPerMainAxis;
          posY = Math.trunc(i / cellsPerMainAxis);
        }
      } else if (constraint === 1 && count - i <= lastRowOffset) {
        posX = constraintCount - (count - i);
        posY = 0;
      } else {
        posX = Math.trunc(i / cellsPerMainAxis);
        posY = i % cellsPerMainAxis;
      }
      if (cornerX === 1) posX = actualCellCountX - 1 - posX;
      if (cornerY === 1) posY = actualCellCountY - 1 - posY;
      this.setChildAlongAxis(children[i], 0, startX + (cell.x + spacing.x) * posX, cell.x, 1);
      this.setChildAlongAxis(children[i], 1, startY + (cell.y + spacing.y) * posY, cell.y, 1);
    }
  }

  /** AspectRatioFitter.UpdateRect（AspectRatioFitter.cs）：AspectMode 1 寬決定高、2 高決定寬、3 FitInParent、4 EnvelopeParent */
  private aspectRatioFit(c: ComponentData, node: SceneNode) {
    // IsComponentValidOnObject：根 Canvas（非 World Space）上的不作用
    const canvas = this.graph.component(node, 'Canvas');
    if (canvas && node.canvas?.node === node && (!node.parent || !node.parent.canvas) && (canvas.m_RenderMode as number) !== 2) return;
    const mode = (c.m_AspectMode as number | undefined) ?? 0;
    const ratio = (c.m_AspectRatio as number | undefined) ?? 1;
    const rt = this.rt(node);
    const rect = this.rectOf(node);
    if (mode === 1) this.setSizeWithCurrentAnchors(node, 1, rect.width / ratio);
    else if (mode === 2) this.setSizeWithCurrentAnchors(node, 0, rect.height * ratio);
    else if (mode === 3 || mode === 4) {
      // IsAspectModeValid：沒有父物件的 Start 時就關掉
      if (!node.parent || !node.parent.isRect) return;
      this.put(rt, 'm_AnchorMin', { x: 0, y: 0 });
      this.put(rt, 'm_AnchorMax', { x: 1, y: 1 });
      this.put(rt, 'm_AnchoredPosition', { x: 0, y: 0 });
      const parent = this.rectOf(node.parent);
      const sizeDelta = { x: 0, y: 0 };
      // GetSizeDeltaToProduceSize：size − 父的尺寸 ×（anchorMax − anchorMin）；anchor 剛設成 0～1
      if ((parent.height * ratio < parent.width) !== (mode === 3)) sizeDelta.y = parent.width / ratio - parent.height;
      else sizeDelta.x = parent.height * ratio - parent.width;
      this.put(rt, 'm_SizeDelta', sizeDelta);
    }
  }

  /** HorizontalOrVerticalLayoutGroup.CalcAlongAxis */
  private calcAlongAxis(c: ComponentData, axis: Axis, isVertical: boolean) {
    const g = this.groups.get(c)!;
    const pad = c.m_Padding as { m_Left: number; m_Right: number; m_Top: number; m_Bottom: number };
    const combinedPadding = axis === 0 ? pad.m_Left + pad.m_Right : pad.m_Top + pad.m_Bottom;
    const controlSize = !!(axis === 0 ? c.m_ChildControlWidth : c.m_ChildControlHeight);
    const useScale = !!(axis === 0 ? c.m_ChildScaleWidth : c.m_ChildScaleHeight);
    const forceExpand = !!(axis === 0 ? c.m_ChildForceExpandWidth : c.m_ChildForceExpandHeight);
    const spacing = c.m_Spacing as number;
    let totalMin = combinedPadding;
    let totalPreferred = combinedPadding;
    let totalFlexible = 0;
    const alongOtherAxis = isVertical !== (axis === 1);
    for (const child of g.rectChildren) {
      let [min, preferred, flexible] = this.childSizes(child, axis, controlSize, forceExpand);
      if (useScale) {
        const s = axis === 0 ? child.transform.m_LocalScale.x : child.transform.m_LocalScale.y;
        min *= s;
        preferred *= s;
        flexible *= s;
      }
      if (alongOtherAxis) {
        totalMin = Math.max(min + combinedPadding, totalMin);
        totalPreferred = Math.max(preferred + combinedPadding, totalPreferred);
        totalFlexible = Math.max(flexible, totalFlexible);
      } else {
        totalMin += min + spacing;
        totalPreferred += preferred + spacing;
        totalFlexible += flexible;
      }
    }
    if (!alongOtherAxis && g.rectChildren.length > 0) {
      totalMin -= spacing;
      totalPreferred -= spacing;
    }
    totalPreferred = Math.max(totalMin, totalPreferred);
    g.totalMin[axis] = totalMin;
    g.totalPreferred[axis] = totalPreferred;
    g.totalFlexible[axis] = totalFlexible;
  }

  /** HorizontalOrVerticalLayoutGroup.GetChildSizes */
  private childSizes(child: SceneNode, axis: Axis, controlSize: boolean, forceExpand: boolean): [number, number, number] {
    let min: number;
    let preferred: number;
    let flexible: number;
    if (!controlSize) {
      min = axis === 0 ? this.rt(child).m_SizeDelta.x : this.rt(child).m_SizeDelta.y;
      preferred = min;
      flexible = 0;
    } else {
      min = this.minSize(child, axis);
      preferred = this.preferredSize(child, axis);
      flexible = this.flexibleSize(child, axis);
    }
    if (forceExpand) flexible = Math.max(flexible, 1);
    return [min, preferred, flexible];
  }

  private alignmentOnAxis(c: ComponentData, axis: Axis): number {
    const a = c.m_ChildAlignment as number;
    return axis === 0 ? (a % 3) * 0.5 : Math.floor(a / 3) * 0.5;
  }

  private startOffset(c: ComponentData, node: SceneNode, axis: Axis, requiredSpaceWithoutPadding: number): number {
    const pad = c.m_Padding as { m_Left: number; m_Right: number; m_Top: number; m_Bottom: number };
    const required = requiredSpaceWithoutPadding + (axis === 0 ? pad.m_Left + pad.m_Right : pad.m_Top + pad.m_Bottom);
    const rect = this.rectOf(node);
    const available = (axis === 0 ? rect.width : rect.height) - required;
    return (axis === 0 ? pad.m_Left : pad.m_Top) + available * this.alignmentOnAxis(c, axis);
  }

  /** LayoutGroup.SetChildAlongAxisWithScale（有給 size 的版本會一起設大小） */
  private setChildAlongAxis(child: SceneNode, axis: Axis, pos: number, size: number | null, scaleFactor: number) {
    const rt = this.rt(child);
    this.put(rt, 'm_AnchorMin', { x: 0, y: 1 });
    this.put(rt, 'm_AnchorMax', { x: 0, y: 1 });
    const k = axis === 0 ? 'x' : 'y';
    if (size !== null) this.put(rt, 'm_SizeDelta', { ...rt.m_SizeDelta, [k]: size });
    const s = size ?? rt.m_SizeDelta[k];
    const value = axis === 0 ? pos + s * rt.m_Pivot.x * scaleFactor : -pos - s * (1 - rt.m_Pivot.y) * scaleFactor;
    this.put(rt, 'm_AnchoredPosition', { ...rt.m_AnchoredPosition, [k]: value });
  }

  /** HorizontalOrVerticalLayoutGroup.SetChildrenAlongAxis */
  private setChildrenAlongAxis(c: ComponentData, node: SceneNode, axis: Axis, isVertical: boolean) {
    const g = this.groups.get(c);
    if (!g) return;
    const rect = this.rectOf(node);
    const size = axis === 0 ? rect.width : rect.height;
    const controlSize = !!(axis === 0 ? c.m_ChildControlWidth : c.m_ChildControlHeight);
    const useScale = !!(axis === 0 ? c.m_ChildScaleWidth : c.m_ChildScaleHeight);
    const forceExpand = !!(axis === 0 ? c.m_ChildForceExpandWidth : c.m_ChildForceExpandHeight);
    const alignment = this.alignmentOnAxis(c, axis);
    const pad = c.m_Padding as { m_Left: number; m_Right: number; m_Top: number; m_Bottom: number };
    const spacing = c.m_Spacing as number;
    const reverse = !!c.m_ReverseArrangement;
    const n = g.rectChildren.length;
    const order = reverse ? [...Array(n).keys()].reverse() : [...Array(n).keys()];
    const scaleOf = (ch: SceneNode) => (useScale ? (axis === 0 ? ch.transform.m_LocalScale.x : ch.transform.m_LocalScale.y) : 1);
    if (isVertical !== (axis === 1)) {
      const innerSize = size - (axis === 0 ? pad.m_Left + pad.m_Right : pad.m_Top + pad.m_Bottom);
      for (const i of order) {
        const child = g.rectChildren[i];
        const [min, preferred, flexible] = this.childSizes(child, axis, controlSize, forceExpand);
        const scaleFactor = scaleOf(child);
        const requiredSpace = mathfClamp(innerSize, min, flexible > 0 ? size : preferred);
        const start = this.startOffset(c, node, axis, requiredSpace * scaleFactor);
        if (controlSize) this.setChildAlongAxis(child, axis, start, requiredSpace, scaleFactor);
        else {
          const offset = (requiredSpace - (axis === 0 ? this.rt(child).m_SizeDelta.x : this.rt(child).m_SizeDelta.y)) * alignment;
          this.setChildAlongAxis(child, axis, start + offset, null, scaleFactor);
        }
      }
      return;
    }
    let pos = axis === 0 ? pad.m_Left : pad.m_Top;
    let itemFlexibleMultiplier = 0;
    const surplus = size - g.totalPreferred[axis];
    if (surplus > 0) {
      if (g.totalFlexible[axis] === 0) pos = this.startOffset(c, node, axis, g.totalPreferred[axis] - (axis === 0 ? pad.m_Left + pad.m_Right : pad.m_Top + pad.m_Bottom));
      else if (g.totalFlexible[axis] > 0) itemFlexibleMultiplier = surplus / g.totalFlexible[axis];
    }
    let minMaxLerp = 0;
    if (g.totalMin[axis] !== g.totalPreferred[axis]) minMaxLerp = Math.min(1, Math.max(0, (size - g.totalMin[axis]) / (g.totalPreferred[axis] - g.totalMin[axis])));
    for (const i of order) {
      const child = g.rectChildren[i];
      const [min, preferred, flexible] = this.childSizes(child, axis, controlSize, forceExpand);
      const scaleFactor = scaleOf(child);
      let childSize = min + (preferred - min) * minMaxLerp;
      childSize += flexible * itemFlexibleMultiplier;
      if (controlSize) this.setChildAlongAxis(child, axis, pos, childSize, scaleFactor);
      else {
        const offset = (childSize - (axis === 0 ? this.rt(child).m_SizeDelta.x : this.rt(child).m_SizeDelta.y)) * alignment;
        this.setChildAlongAxis(child, axis, pos + offset, null, scaleFactor);
      }
      pos += childSize * scaleFactor + spacing;
    }
  }

  private setLayout(c: ComponentData, node: SceneNode, axis: Axis) {
    const k = cls(c);
    if (k === 'HorizontalLayoutGroup' || k === 'VerticalLayoutGroup') this.setChildrenAlongAxis(c, node, axis, k === 'VerticalLayoutGroup');
    else if (k === 'GridLayoutGroup') this.setCellsAlongAxis(c, node, axis);
    else if (k === 'AspectRatioFitter') {
      if (axis === 1) this.aspectRatioFit(c, node);
    } else if (k === 'ContentSizeFitter') {
      // ContentSizeFitter.HandleSelfFittingAlongAxis：0 Unconstrained、1 MinSize、2 PreferredSize
      const fit = (axis === 0 ? c.m_HorizontalFit : c.m_VerticalFit) as number;
      if (fit === 1) this.setSizeWithCurrentAnchors(node, axis, this.minSize(node, axis));
      else if (fit === 2) this.setSizeWithCurrentAnchors(node, axis, this.preferredSize(node, axis));
    } else if (k === 'ScrollRect') this.note('ScrollRect 的 SetLayout');
    else this.note(k);
  }

  // ───────── LayoutRebuilder ─────────

  private performCalculation(node: SceneNode, axis: Axis) {
    if (!node.isRect) return;
    const roles = this.roles(node);
    const elements = this.enabledIn(node, roles.elements);
    const hasGroup = roles.groups.length > 0;
    if (elements.length > 0 || hasGroup) {
      for (const ch of node.children) this.performCalculation(ch, axis);
      for (const c of elements) this.calculateInput(c, node, axis);
    }
  }

  private performControl(node: SceneNode, axis: Axis) {
    if (!node.isRect) return;
    const controllers = this.enabledIn(node, this.roles(node).controllers);
    if (controllers.length === 0) return;
    for (const c of controllers) if (SELF_CONTROLLERS.has(cls(c))) this.setLayout(c, node, axis);
    for (const c of controllers) {
      if (SELF_CONTROLLERS.has(cls(c))) continue;
      if (cls(c) === 'ScrollRect' && (c.m_Content as { fileID: string } | null)?.fileID === node.go.transform) continue;
      this.setLayout(c, node, axis);
    }
    for (const ch of node.children) this.performControl(ch, axis);
  }

  rebuild(root: SceneNode) {
    this.performCalculation(root, 0);
    this.performControl(root, 0);
    this.performCalculation(root, 1);
    this.performControl(root, 1);
  }

  /**
   * LayoutUtility.GetPreferredWidth／Height（原生）：rect 上啟用中的 ILayoutElement 偏好值的最大值（沒有就 0）。
   * 偏好值依賴 groups 的計算結果，要先對這個物件所在的 layout root 跑過 rebuild（呼叫端負責）。
   */
  preferredSizeOf(node: SceneNode, axis: Axis): number {
    return this.layoutProperty(node, axis, 'preferred', 0);
  }

  /** 群組元件自己算好的 total 值：這次沒算到（群組關著）讀上一次算好的，從沒算過或不是群組是 0 */
  groupValue(comp: ComponentData, axis: Axis, prop: Prop): number {
    const g = this.groups.get(comp) ?? lastTotals.get(comp);
    if (!g) return 0;
    return (prop === 'min' ? g.totalMin : prop === 'preferred' ? g.totalPreferred : g.totalFlexible)[axis];
  }

  /** 場景載入時：每個啟用的 layout 控制器（OnEnable 會 SetDirty）找到自己的 root，依深度排序後各重排一次。
   *  defer 回 true 的 root 不排，記進 report.deferred（World 每格的排版用：所在的 Canvas 關掉的，見 World.relayout） */
  rebuildAll(defer?: (root: SceneNode) => boolean): void {
    const roots = new Set<SceneNode>();
    // 有 layout 控制器元件的節點只隨節點與元件增減變（SceneGraph.cached 的 membership）；啟用與否每次照舊判斷
    const candidates = this.graph.cached(
      'layout.controllers',
      () => [...this.graph.nodes.values()].filter((n) => n.isRect && this.graph.components(n).some((c) => this.isLayoutController(c))),
      'membership',
    );
    for (const node of candidates) {
      if (!node.isRect || !node.activeInHierarchy) continue;
      if (this.enabledIn(node, this.roles(node).controllers).length === 0) continue;
      let root = node;
      for (let p = node.parent; p && p.isRect; p = p.parent) {
        if (this.enabledIn(p, this.roles(p).groups).length === 0) break;
        root = p;
      }
      roots.add(root);
    }
    const depth = (n: SceneNode) => {
      let d = 0;
      for (let p = n.parent; p; p = p.parent) d++;
      return d;
    };
    const sorted = [...roots].sort((a, b) => depth(a) - depth(b) || a.order - b.order);
    this.report.roots = sorted.length;
    for (const r of sorted) {
      if (defer?.(r)) {
        (this.report.deferred ??= []).push(r);
        continue;
      }
      this.rebuild(r);
    }
  }
}

/**
 * LayoutGroup 的 minWidth／preferredWidth／flexibleWidth（與 Height）：Unity 回傳上一次 CalculateLayoutInput 算好的 m_TotalMinSize 等
 *（LayoutGroup.cs 的 GetTotalMinSize／GetTotalPreferredSize／GetTotalFlexibleSize）。這裡對這個節點重算一次再讀那個群組自己的值
 *（呼叫端通常剛 ForceRebuildLayoutImmediate 過，MT2 的 LayoutGroupReplacementElement）；不是群組的元件回 0
 */
export function layoutGroupSize(
  graph: SceneGraph,
  node: SceneNode,
  comp: ComponentData,
  axis: Axis,
  prop: Prop,
  options: { external?: ExternalLayoutElement | null; spriteOf?: UILayout['spriteOf'] },
): number {
  const ui = new UILayout(graph, options.external ?? null, (n) => (graph.isScreenRoot(n) ? n.rect : null));
  ui.spriteOf = options.spriteOf ?? null;
  ui.rebuild(node);
  return ui.groupValue(comp, axis, prop);
}

/**
 * 對 root 重排一次，回傳 node 的偏好尺寸（LayoutUtility.GetPreferredHeight 的移植，tooltip 的 RelocateTooltipsY 用）。
 * 不改場景的排版結果（只讀偏好值）；rect 與世界矩陣要已經是最近一次排版後的狀態（呼叫端先跑過 world.relayout）。
 */
export function preferredSizeAfterRebuild(
  graph: SceneGraph,
  root: SceneNode,
  node: SceneNode,
  axis: 0 | 1,
  options: { external?: ExternalLayoutElement | null; spriteOf?: UILayout['spriteOf'] },
): number {
  const ui = new UILayout(graph, options.external ?? null, (n) => (graph.isScreenRoot(n) ? n.rect : null));
  ui.spriteOf = options.spriteOf ?? null;
  ui.rebuild(root);
  return ui.preferredSizeOf(node, axis);
}

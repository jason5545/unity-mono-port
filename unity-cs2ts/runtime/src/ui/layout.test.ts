// layout.ts 的測試。Unity 存檔時被 LayoutGroup 驅動的屬性存成 0，沒有存檔值可對，期望值照反編譯原始碼手算，每條註明怎麼算的。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutWithUI, SceneGraph } from '../unity/scene';
import { setClassHierarchy } from '../unity/componentKind';
import { layoutGroupSize } from './layout';
import type { SceneFile } from '../unity/types';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

/** 最小的場景：一個 Screen Space Overlay Canvas（1000×1000）底下一個容器與幾個子物件 */
function scene(container: Record<string, unknown>[], children: { rt: Record<string, unknown>; comps?: Record<string, unknown>[] }[]): SceneFile {
  const rect = (o: Record<string, unknown>) => ({
    type: 'RectTransform',
    classID: 224,
    m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
    m_LocalPosition: { x: 0, y: 0, z: 0 },
    m_LocalScale: { x: 1, y: 1, z: 1 },
    m_AnchorMin: { x: 0.5, y: 0.5 },
    m_AnchorMax: { x: 0.5, y: 0.5 },
    m_AnchoredPosition: { x: 0, y: 0 },
    m_SizeDelta: { x: 100, y: 100 },
    m_Pivot: { x: 0.5, y: 0.5 },
    ...o,
  });
  const mono = (cls: string, o: Record<string, unknown>) => ({ type: 'MonoBehaviour', classID: 114, m_Enabled: 1, script: { class: cls }, ...o });
  const components: Record<string, unknown> = {};
  const gameObjects: Record<string, unknown> = {};
  let id = 1;
  const add = (name: string, rt: Record<string, unknown>, comps: Record<string, unknown>[], parent: string | null) => {
    const go = String(id++);
    const tf = String(id++);
    components[tf] = { ...rect(rt), gameObject: go };
    const ids = [tf];
    for (const c of comps) {
      const cid = String(id++);
      components[cid] = { ...c, gameObject: go };
      ids.push(cid);
    }
    gameObjects[go] = { m_Name: name, m_IsActive: 1, m_Layer: 5, m_TagString: 'Untagged', components: ids, transform: tf, parent, children: [] };
    if (parent) (gameObjects[parent] as { children: string[] }).children.push(go);
    return go;
  };
  const root = add('Canvas', {}, [{ type: 'Canvas', classID: 223, m_Enabled: 1, m_RenderMode: 0, m_Camera: null, m_PlaneDistance: 100 }], null);
  const box = add('Box', {}, container.map((c) => mono(c.cls as string, c)), root);
  children.forEach((ch, i) => add(`Child${i}`, ch.rt, (ch.comps ?? []).map((c) => mono(c.cls as string, c)), box));
  return { guid: 'test', name: 'test', src: 'test', roots: [root], gameObjects, components } as unknown as SceneFile;
}

const vlg = (o: Record<string, unknown> = {}) => ({
  cls: 'VerticalLayoutGroup',
  m_Padding: { m_Left: 10, m_Right: 20, m_Top: 5, m_Bottom: 15 },
  m_ChildAlignment: 0,
  m_Spacing: 4,
  m_ChildForceExpandWidth: 0,
  m_ChildForceExpandHeight: 0,
  m_ChildControlWidth: 1,
  m_ChildControlHeight: 1,
  m_ChildScaleWidth: 0,
  m_ChildScaleHeight: 0,
  m_ReverseArrangement: 0,
  ...o,
});
const element = (pw: number, ph: number, fw = -1, fh = -1) => ({
  cls: 'LayoutElement',
  m_IgnoreLayout: 0,
  m_MinWidth: -1,
  m_MinHeight: -1,
  m_PreferredWidth: pw,
  m_PreferredHeight: ph,
  m_FlexibleWidth: fw,
  m_FlexibleHeight: fh,
  m_LayoutPriority: 1,
});

describe('uGUI 自動排版', () => {
  it('level1 主選單（VerticalLayoutGroup：不控子物件大小、間距 14.16、靠下置中）：x = 34.95 + 286 × 0.5；第一顆 y = −72.77 − 28.5，之後每顆 −71.16', () => {
    const g = new SceneGraph(load<SceneFile>('scenes/level1.json'));
    layoutWithUI(g, 1920, 1080);
    const mm = [...g.nodes.values()].find((n) => n.go.m_Name === 'Main Menu')!;
    // 容器 355.9 × 414.41；5 顆 × 57 + 4 × 14.16 = 341.64，剩 72.77 全放上面（靠下對齊）；橫向剩 69.9，一半 34.95 在左
    const pos = mm.children.map((c) => (c.transform as unknown as { m_AnchoredPosition: { x: number; y: number } }).m_AnchoredPosition);
    pos.forEach((p, i) => {
      expect(p.x).toBeCloseTo(177.95, 4);
      expect(p.y).toBeCloseTo(-101.27 - 71.16 * i, 4);
    });
  });

  it('VerticalLayoutGroup 控子物件大小：寬 = 容器寬 − 左右 padding（沒有 flexible 時夾在 preferred）、高照 preferred，依序往下', () => {
    const g = new SceneGraph(
      scene([vlg()], [
        { rt: {}, comps: [element(50, 30)] },
        { rt: {}, comps: [element(200, 20)] },
      ]),
    );
    layoutWithUI(g, 1000, 1000);
    const [a, b] = [...g.nodes.values()].filter((n) => n.go.m_Name.startsWith('Child'));
    const rt = (n: typeof a) => n.transform as unknown as { m_SizeDelta: { x: number; y: number }; m_AnchoredPosition: { x: number; y: number } };
    // 橫向（另一軸）：innerSize = 100 − 30 = 70；子 A preferred 50 → Clamp(70, 0, 50) = 50；子 B → Clamp(70, 0, 200) = 70
    expect(rt(a).m_SizeDelta.x).toBe(50);
    expect(rt(b).m_SizeDelta.x).toBe(70);
    // 靠左上（alignment 0）：x = left 10 + 0 + size × pivot 0.5
    expect(rt(a).m_AnchoredPosition.x).toBe(10 + 25);
    // 縱向：總 preferred = 5 + 15 + 30 + 4 + 20 = 74 < 100，沒有 flexible → 起點 = top 5 + (100 − 74) × 0（靠上）= 5
    expect(rt(a).m_SizeDelta.y).toBe(30);
    expect(rt(a).m_AnchoredPosition.y).toBe(-5 - 30 * 0.5);
    expect(rt(b).m_AnchoredPosition.y).toBe(-(5 + 30 + 4) - 20 * 0.5);
  });

  it('強制展開高度：多出來的 26 依 flexible（各 1）平分；ContentSizeFitter 把容器高度設成 preferred', () => {
    const g = new SceneGraph(
      scene([vlg({ m_ChildForceExpandHeight: 1 })], [
        { rt: {}, comps: [element(50, 30)] },
        { rt: {}, comps: [element(50, 20)] },
      ]),
    );
    layoutWithUI(g, 1000, 1000);
    const [a, b] = [...g.nodes.values()].filter((n) => n.go.m_Name.startsWith('Child'));
    const h = (n: typeof a) => (n.transform as unknown as { m_SizeDelta: { y: number } }).m_SizeDelta.y;
    expect(h(a)).toBe(30 + 13);
    expect(h(b)).toBe(20 + 13);

    const fitted = new SceneGraph(
      scene([vlg(), { cls: 'ContentSizeFitter', m_HorizontalFit: 0, m_VerticalFit: 2 }], [
        { rt: {}, comps: [element(50, 30)] },
        { rt: {}, comps: [element(50, 20)] },
      ]),
    );
    layoutWithUI(fitted, 1000, 1000);
    const box = [...fitted.nodes.values()].find((n) => n.go.m_Name === 'Box')!;
    // preferred 高 = 5 + 15 + 30 + 4 + 20 = 74；錨點是點（0.5），sizeDelta = 74 − 父高 × 0
    expect((box.transform as unknown as { m_SizeDelta: { y: number } }).m_SizeDelta.y).toBe(74);
  });
});

describe('GridLayoutGroup 與 AspectRatioFitter（10/17）', () => {
  const grid = (o: Record<string, unknown> = {}) => ({
    cls: 'GridLayoutGroup',
    m_Padding: { m_Left: 0, m_Right: 0, m_Top: 0, m_Bottom: 0 },
    m_ChildAlignment: 0,
    m_CellSize: { x: 40, y: 30 },
    m_Spacing: { x: 10, y: 5 },
    m_StartCorner: 0,
    m_StartAxis: 0,
    m_Constraint: 1,
    m_ConstraintCount: 2,
    ...o,
  });
  type RT = { m_SizeDelta: { x: number; y: number }; m_AnchoredPosition: { x: number; y: number }; m_AnchorMin: { x: number; y: number } };
  const rtOf = (n: { transform: unknown }) => n.transform as unknown as RT;

  it('固定 2 欄、3 格（cell 40×30、間距 10×5、從左上橫排）：第二格在右邊、第三格換行；anchor 改成左上、大小是 cell', () => {
    const g = new SceneGraph(scene([grid()], [{ rt: {} }, { rt: {} }, { rt: {} }]));
    layoutWithUI(g, 1000, 1000);
    const [a, b, c] = [...g.nodes.values()].filter((n) => n.go.m_Name.startsWith('Child')).map(rtOf);
    // SetChildAlongAxis：x = 位置 + 40 × pivot 0.5，y = −位置 − 30 × (1 − 0.5)；第二欄位置 50、第二列位置 35
    expect(a.m_AnchorMin).toEqual({ x: 0, y: 1 });
    expect(a.m_SizeDelta).toEqual({ x: 40, y: 30 });
    expect(a.m_AnchoredPosition).toEqual({ x: 20, y: -15 });
    expect(b.m_AnchoredPosition).toEqual({ x: 70, y: -15 });
    expect(c.m_AnchoredPosition).toEqual({ x: 20, y: -50 });
  });

  it('從右下角開始（StartCorner 3）：第一格在右下', () => {
    const g = new SceneGraph(scene([grid({ m_StartCorner: 3 })], [{ rt: {} }, { rt: {} }, { rt: {} }]));
    layoutWithUI(g, 1000, 1000);
    const [a] = [...g.nodes.values()].filter((n) => n.go.m_Name.startsWith('Child')).map(rtOf);
    // 欄 1 − 0 = 1、列 1 − 0 = 1
    expect(a.m_AnchoredPosition).toEqual({ x: 70, y: -50 });
  });

  it('AspectRatioFitter：寬決定高（比例 2，寬 100 → 高 50）；EnvelopeParent 蓋滿父物件（100×100、比例 2 → 200×100）', () => {
    const fitter = (mode: number) => ({ cls: 'AspectRatioFitter', m_AspectMode: mode, m_AspectRatio: 2 });
    const g = new SceneGraph(scene([], [{ rt: {}, comps: [fitter(1)] }, { rt: {}, comps: [fitter(4)] }]));
    layoutWithUI(g, 1000, 1000);
    const [a, b] = [...g.nodes.values()].filter((n) => n.go.m_Name.startsWith('Child'));
    expect(rtOf(a).m_SizeDelta).toEqual({ x: 100, y: 50 });
    expect(rtOf(b).m_AnchorMin).toEqual({ x: 0, y: 0 });
    expect(rtOf(b).m_SizeDelta).toEqual({ x: 100, y: 0 });
    expect(b.rect.width).toBe(200);
    expect(b.rect.height).toBe(100);
  });
});

describe('LayoutGroup 關掉之後的 total 與 TMP 子類別（10/17）', () => {
  const grid = {
    cls: 'GridLayoutGroup',
    m_Padding: { m_Left: 0, m_Right: 0, m_Top: 0, m_Bottom: 0 },
    m_ChildAlignment: 0,
    m_CellSize: { x: 40, y: 30 },
    m_Spacing: { x: 10, y: 5 },
    m_StartCorner: 0,
    m_StartAxis: 0,
    m_Constraint: 1,
    m_ConstraintCount: 2,
  };

  it('GridLayoutGroup 關掉之後 preferredWidth／Height 讀關掉前算好的（LayoutGroupReplacementElement.DisableLayoutGroup 每次 hover 都會再讀）', () => {
    const g = new SceneGraph(scene([grid], [{ rt: {} }, { rt: {} }, { rt: {} }]));
    layoutWithUI(g, 1000, 1000);
    const box = [...g.nodes.values()].find((n) => n.go.m_Name === 'Box')!;
    const comp = g.components(box).find((c) => c.script?.class === 'GridLayoutGroup')!;
    // 2 欄：40 + 10 + 40 ＝ 90；2 列：30 + 5 + 30 ＝ 65
    expect(layoutGroupSize(g, box, comp, 0, 'preferred', {})).toBe(90);
    expect(layoutGroupSize(g, box, comp, 1, 'preferred', {})).toBe(65);
    comp.m_Enabled = 0;
    expect(layoutGroupSize(g, box, comp, 0, 'preferred', {})).toBe(90);
    expect(layoutGroupSize(g, box, comp, 1, 'preferred', {})).toBe(65);
  });

  it('繼承 TextMeshProUGUI 的遊戲類別（ExtendedTextMeshProUGUI）照 TMP 的偏好尺寸排（hierarchy.json 的基底鏈）', () => {
    setClassHierarchy({ ExtendedTextMeshProUGUI: ['TextMeshProUGUI', 'TMP_Text', 'MaskableGraphic', 'Graphic'] });
    try {
      const g = new SceneGraph(scene([vlg({ m_ChildControlHeight: 1 })], [{ rt: {}, comps: [{ cls: 'ExtendedTextMeshProUGUI', m_text: 'Fel' }] }]));
      // TMP 的偏好尺寸由排版模組給（external）：高 37
      layoutWithUI(g, 1000, 1000, { external: (_c, _n, axis, prop) => (prop === 'preferred' ? (axis === 1 ? 37 : 80) : null) });
      const child = [...g.nodes.values()].find((n) => n.go.m_Name === 'Child0')!;
      expect(child.rect.height).toBe(37);
    } finally {
      setClassHierarchy(null);
    }
  });
});

// Mask 的 stencil 參數（ui/mask.ts）的測試。
// 期望值全部照 reference/decompiled/UnityEngine.UI/UnityEngine.UI/ 手算，行號標在每個 it：
//   Mask.cs:113-149（GetModifiedMaterial）、MaskableGraphic.cs:117-141、
//   StencilMaterial.cs:42-45（readMask／writeMask 預設 255）、55-131（Add）、112（useAlphaClip）、114-120（寫入的七個 float）、
//   MaskUtilities.cs:36-55（FindRootSortOverrideCanvas）、57-85（GetStencilDepth）。
// 枚舉值（UnityEngine.Rendering）：StencilOp.Keep 0／Zero 1／Replace 2；CompareFunction.Equal 3／Always 8；ColorWriteMask.All 15。
// 真資料那幾條用 level1 的 Language 下拉範本：Viewport（物件 282）上有 Mask（元件 1350，m_ShowMaskGraphic 0）
// 與 Image（元件 1417）。巢狀深度用底下手搭的場景樹。SceneGraph 本身滿足 MaskLookup（component／components）。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SceneGraph, type SceneNode } from '../unity/scene';
import type { ComponentData, GameObjectData, SceneFile } from '../unity/types';
import {
  COLOR_WRITE_ALL,
  COMPARE_ALWAYS,
  COMPARE_EQUAL,
  DEFAULT_STENCIL,
  STENCIL_OP_KEEP,
  STENCIL_OP_REPLACE,
  STENCIL_OP_ZERO,
  activeMaskNodes,
  findRootSortOverrideCanvas,
  getStencilDepth,
  graphicStencil,
  isDefaultStencil,
  maskEnabled,
  maskGetModifiedMaterial,
  maskNodesOf,
  maskSubtree,
  maskableGetModifiedMaterial,
  stencilFromMaterial,
  stencilKey,
  stencilMaterialAdd,
  subtreeLastOrder,
} from './mask';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

// ───────── 真資料：level1 的 Language 下拉範本 ─────────

const VIEWPORT_GO = '282'; // Mask 1350 所在物件
const TEMPLATE_GO = '384';
const ROOT_CANVAS_GO = '335'; // SettingCanvasMainMenu（Canvas 742，m_OverrideSorting 1）

function level1() {
  const graph = new SceneGraph(load<SceneFile>('scenes/level1.json'));
  const template = graph.nodes.get(TEMPLATE_GO)!;
  // 範本在場景資料裡是關的（TMP_Dropdown.Show 才 SetActive(true)）；MaskEnabled 要 activeInHierarchy
  graph.setActive(template, true);
  return { graph, viewport: graph.nodes.get(VIEWPORT_GO)!, template };
}

// ───────── 合成場景樹：巢狀 Mask 的 depth 1／2／8 ─────────

interface Spec {
  name: string;
  /** 加一個 Mask（m_ShowMaskGraphic 用這個值） */
  mask?: number;
  /** 加一個 Image（m_Maskable 用這個值，預設 1） */
  image?: number;
  /** 加一個 Canvas（m_OverrideSorting 用這個值） */
  canvas?: number;
  active?: boolean;
  children?: Spec[];
}

let uid = 0;

/** 手搭一棵場景樹。mask.ts 只用 component／components／parent／activeInHierarchy／order，所以 RectTransform 給基本欄位就夠 */
function synth(root: Spec): { graph: SceneGraph; byName: Map<string, SceneNode> } {
  const gameObjects: Record<string, GameObjectData> = {};
  const components: Record<string, ComponentData> = {};
  const byName = new Map<string, SceneNode>();
  const build = (spec: Spec, parentGo: string | null): string => {
    const goId = `go${++uid}`;
    const tfId = `tf${uid}`;
    const comps: string[] = [tfId];
    components[tfId] = {
      type: 'RectTransform',
      classID: 224,
      gameObject: goId,
      m_LocalPosition: { x: 0, y: 0, z: 0 },
      m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
      m_LocalScale: { x: 1, y: 1, z: 1 },
      m_Children: [],
      m_Father: null,
      m_AnchorMin: { x: 0, y: 0 },
      m_AnchorMax: { x: 1, y: 1 },
      m_AnchoredPosition: { x: 0, y: 0 },
      m_SizeDelta: { x: 0, y: 0 },
      m_Pivot: { x: 0.5, y: 0.5 },
    } as ComponentData;
    if (spec.canvas !== undefined) {
      const id = `cv${uid}`;
      comps.push(id);
      components[id] = { type: 'Canvas', classID: 223, gameObject: goId, m_Enabled: 1, m_RenderMode: 2, m_OverrideSorting: spec.canvas, m_SortingOrder: 0, m_SortingLayerID: 0 } as ComponentData;
    }
    if (spec.image !== undefined) {
      const id = `im${uid}`;
      comps.push(id);
      components[id] = { type: 'MonoBehaviour', classID: 114, gameObject: goId, m_Enabled: 1, m_Maskable: spec.image, m_Color: { r: 1, g: 1, b: 1, a: 1 }, script: { class: 'Image' } } as ComponentData;
    }
    if (spec.mask !== undefined) {
      const id = `mk${uid}`;
      comps.push(id);
      components[id] = { type: 'MonoBehaviour', classID: 114, gameObject: goId, m_Enabled: 1, m_ShowMaskGraphic: spec.mask, script: { class: 'Mask' } } as ComponentData;
    }
    const childIds = (spec.children ?? []).map((c) => build(c, goId));
    gameObjects[goId] = {
      m_Name: spec.name,
      m_IsActive: spec.active === false ? 0 : 1,
      m_Layer: 5,
      m_TagString: 'Untagged',
      transform: tfId,
      parent: parentGo,
      children: childIds,
      components: comps,
    };
    (components[tfId] as unknown as { m_Children: { fileID: string }[] }).m_Children = childIds.map((c) => ({ fileID: gameObjects[c].transform }));
    return goId;
  };
  const rootId = build(root, null);
  const graph = new SceneGraph({ guid: 'synth', name: 'synth', src: 'synth', roots: [rootId], gameObjects, components, settings: {} });
  graph.refreshHierarchy();
  for (const n of graph.nodes.values()) byName.set(n.go.m_Name, n);
  return { graph, byName };
}

describe('StencilMaterial.Add（StencilMaterial.cs:55-131）', () => {
  it('stencilID <= 0 且 colorWriteMask All → 回傳原材質（:57-60）', () => {
    expect(stencilMaterialAdd(DEFAULT_STENCIL, 0, STENCIL_OP_KEEP, COMPARE_ALWAYS, COLOR_WRITE_ALL)).toBe(DEFAULT_STENCIL);
    expect(stencilMaterialAdd(DEFAULT_STENCIL, -1, STENCIL_OP_REPLACE, COMPARE_EQUAL, COLOR_WRITE_ALL)).toBe(DEFAULT_STENCIL);
  });

  it('stencilID <= 0 但 colorWriteMask 不是 All → 照樣做一份（:57-60 是 && ）', () => {
    expect(stencilMaterialAdd(DEFAULT_STENCIL, 0, STENCIL_OP_KEEP, COMPARE_ALWAYS, 0)).toEqual({
      ref: 0,
      op: STENCIL_OP_KEEP,
      comp: COMPARE_ALWAYS,
      readMask: 255,
      writeMask: 255,
      colorMask: 0,
      alphaClip: false,
    });
  });

  it('材質缺那六個屬性 → 回傳原材質（:61-90 的 HasProperty 檢查）', () => {
    expect(stencilMaterialAdd(DEFAULT_STENCIL, 1, STENCIL_OP_REPLACE, COMPARE_ALWAYS, COLOR_WRITE_ALL, 255, 255, false)).toBe(DEFAULT_STENCIL);
  });

  it('useAlphaClip ＝ operation != Keep && writeMask > 0（:112）', () => {
    expect(stencilMaterialAdd(DEFAULT_STENCIL, 1, STENCIL_OP_KEEP, COMPARE_EQUAL, COLOR_WRITE_ALL, 1, 0).alphaClip).toBe(false);
    expect(stencilMaterialAdd(DEFAULT_STENCIL, 1, STENCIL_OP_KEEP, COMPARE_EQUAL, COLOR_WRITE_ALL, 1, 255).alphaClip).toBe(false);
    expect(stencilMaterialAdd(DEFAULT_STENCIL, 1, STENCIL_OP_REPLACE, COMPARE_ALWAYS, COLOR_WRITE_ALL).alphaClip).toBe(true);
    expect(stencilMaterialAdd(DEFAULT_STENCIL, 1, STENCIL_OP_ZERO, COMPARE_ALWAYS, 0).alphaClip).toBe(true);
    expect(stencilMaterialAdd(DEFAULT_STENCIL, 1, STENCIL_OP_REPLACE, COMPARE_EQUAL, COLOR_WRITE_ALL, 1, 0).alphaClip).toBe(false);
  });

  it('readMask／writeMask 不給就是 255（:42-45 的預設參數）', () => {
    const s = stencilMaterialAdd(DEFAULT_STENCIL, 1, STENCIL_OP_REPLACE, COMPARE_ALWAYS, COLOR_WRITE_ALL);
    expect(s.readMask).toBe(255);
    expect(s.writeMask).toBe(255);
  });
});

describe('Mask.GetModifiedMaterial（Mask.cs:113-149）', () => {
  it('第一層、m_ShowMaskGraphic 0：mask ＝ Add(1, Replace, Always, colorMask 0)、unmask ＝ Add(1, Zero, Always, 0)（:126-138）', () => {
    const { graph, viewport } = level1();
    expect((graph.component(viewport, 'Mask') as ComponentData).m_ShowMaskGraphic).toBe(0); // level1 存值
    const r = maskGetModifiedMaterial(graph, viewport, DEFAULT_STENCIL, true)!;
    // :126 num ＝ 1 << 0 ＝ 1 → 走 :127-138；:129 colorMask ＝ showMaskGraphic ? All : 0 ＝ 0
    expect(r.mask).toEqual({ ref: 1, op: STENCIL_OP_REPLACE, comp: COMPARE_ALWAYS, readMask: 255, writeMask: 255, colorMask: 0, alphaClip: true });
    // :132 unmask 固定 colorMask 0、op Zero
    expect(r.unmask).toEqual({ ref: 1, op: STENCIL_OP_ZERO, comp: COMPARE_ALWAYS, readMask: 255, writeMask: 255, colorMask: 0, alphaClip: true });
  });

  it('第一層、m_ShowMaskGraphic 1：只有 colorMask 從 0 變 15，stencil 照樣寫（:129）', () => {
    const { graph, viewport } = level1();
    (graph.component(viewport, 'Mask') as ComponentData).m_ShowMaskGraphic = 1;
    const r = maskGetModifiedMaterial(graph, viewport, DEFAULT_STENCIL, true)!;
    expect(r.mask).toEqual({ ref: 1, op: STENCIL_OP_REPLACE, comp: COMPARE_ALWAYS, readMask: 255, writeMask: 255, colorMask: COLOR_WRITE_ALL, alphaClip: true });
  });

  it('巢狀 depth 1：mask ＝ Add(num|(num-1)＝3, Replace, Equal, readMask 1, writeMask 3)、unmask ＝ Add(1, Replace, Equal, 0, 1, 3)（:139-148）', () => {
    const { graph, byName } = synth({
      name: 'Root',
      canvas: 1,
      children: [{ name: 'Outer', mask: 1, image: 1, children: [{ name: 'Inner', mask: 1, image: 1 }] }],
    });
    const inner = byName.get('Inner')!;
    expect(getStencilDepth(graph, inner, findRootSortOverrideCanvas(graph, inner))).toBe(1);
    const r = maskGetModifiedMaterial(graph, inner, DEFAULT_STENCIL, true)!;
    // num ＝ 1 << 1 ＝ 2；:139 num|(num-1) ＝ 3、readMask ＝ num-1 ＝ 1、writeMask ＝ 3
    expect(r.mask).toEqual({ ref: 3, op: STENCIL_OP_REPLACE, comp: COMPARE_EQUAL, readMask: 1, writeMask: 3, colorMask: COLOR_WRITE_ALL, alphaClip: true });
    // :143 unmask：stencilID ＝ num-1 ＝ 1、colorMask 0
    expect(r.unmask).toEqual({ ref: 1, op: STENCIL_OP_REPLACE, comp: COMPARE_EQUAL, readMask: 1, writeMask: 3, colorMask: 0, alphaClip: true });
  });

  it('MaskEnabled 不成立 → 回傳 baseMaterial，這裡回 null（:115-118）', () => {
    const { graph, viewport } = level1();
    (graph.component(viewport, 'Mask') as ComponentData).m_Enabled = 0;
    expect(maskGetModifiedMaterial(graph, viewport, DEFAULT_STENCIL, true)).toBeNull();
  });

  it('沒有 Graphic 的 Mask 不算 MaskEnabled（Mask.cs:55-62）', () => {
    const { graph, byName } = synth({ name: 'Root', canvas: 1, children: [{ name: 'NoGraphic', mask: 1 }] });
    expect(maskEnabled(graph, byName.get('NoGraphic')!)).toBe(false);
    expect(maskGetModifiedMaterial(graph, byName.get('NoGraphic')!, DEFAULT_STENCIL, true)).toBeNull();
  });

  it('depth >= 8 → 只警告並回傳原材質，這裡回 null（:121-125）', () => {
    // 疊 9 層 Mask（Root 的 Canvas 是 stopAfter），最裡面那層往上有 8 個 → depth 8
    let spec: Spec = { name: 'M8', mask: 1, image: 1 };
    for (let i = 7; i >= 0; i--) spec = { name: `M${i}`, mask: 1, image: 1, children: [spec] };
    const { graph, byName } = synth({ name: 'Root', canvas: 1, children: [spec] });
    const deepest = byName.get('M8')!;
    expect(getStencilDepth(graph, deepest, findRootSortOverrideCanvas(graph, deepest))).toBe(8);
    expect(maskGetModifiedMaterial(graph, deepest, DEFAULT_STENCIL, true)).toBeNull();
    // 少一層（depth 7）就照樣算
    const seven = byName.get('M7')!;
    expect(getStencilDepth(graph, seven, findRootSortOverrideCanvas(graph, seven))).toBe(7);
    expect(maskGetModifiedMaterial(graph, seven, DEFAULT_STENCIL, true)).not.toBeNull();
  });
});

describe('MaskableGraphic.GetModifiedMaterial（MaskableGraphic.cs:117-141）', () => {
  it('depth 1、不是遮罩圖形：Add((1<<1)-1＝1, Keep, Equal, All, readMask 1, writeMask 0)（:133-139）', () => {
    const { graph, viewport } = level1();
    const content = viewport.children[0]; // Content
    expect(getStencilDepth(graph, content, findRootSortOverrideCanvas(graph, content))).toBe(1);
    expect(maskableGetModifiedMaterial(graph, content, { m_Maskable: 1 } as unknown as ComponentData, DEFAULT_STENCIL, false, true)).toEqual({
      ref: 1,
      op: STENCIL_OP_KEEP,
      comp: COMPARE_EQUAL,
      readMask: 1,
      writeMask: 0,
      colorMask: COLOR_WRITE_ALL,
      alphaClip: false, // op ＝ Keep → :112 的 operation != Keep 不成立
    });
  });

  it('depth 2（巢狀）：ref 與 readMask 都是 (1<<2)-1 ＝ 3（:135）', () => {
    const { graph, byName } = synth({
      name: 'Root',
      canvas: 1,
      children: [{ name: 'Outer', mask: 1, image: 1, children: [{ name: 'Inner', mask: 1, image: 1, children: [{ name: 'Leaf', image: 1 }] }] }],
    });
    const leaf = byName.get('Leaf')!;
    expect(getStencilDepth(graph, leaf, findRootSortOverrideCanvas(graph, leaf))).toBe(2);
    const s = maskableGetModifiedMaterial(graph, leaf, { m_Maskable: 1 } as unknown as ComponentData, DEFAULT_STENCIL, false, true);
    expect(s.ref).toBe(3);
    expect(s.readMask).toBe(3);
    expect(s.writeMask).toBe(0);
    expect(s.comp).toBe(COMPARE_EQUAL);
    expect(s.op).toBe(STENCIL_OP_KEEP);
  });

  it('m_Maskable 0 → stencilValue 0 → 回傳 base（:122、:127-131）', () => {
    const { graph, viewport } = level1();
    const content = viewport.children[0];
    expect(maskableGetModifiedMaterial(graph, content, { m_Maskable: 0 } as unknown as ComponentData, DEFAULT_STENCIL, false, true)).toBe(DEFAULT_STENCIL);
  });

  it('自己就是遮罩圖形（isMaskingGraphic，Mask.cs:76-79）→ 不套被遮罩的 stencil（:133 的 && ）', () => {
    const { graph, viewport } = level1();
    const image = graph.component(viewport, 'Image') as ComponentData;
    expect(maskableGetModifiedMaterial(graph, viewport, image, DEFAULT_STENCIL, true, true)).toBe(DEFAULT_STENCIL);
  });

  it('depth 0（上面沒有 Mask）→ 回傳 base', () => {
    const { graph } = level1();
    const root = graph.nodes.get(ROOT_CANVAS_GO)!;
    expect(getStencilDepth(graph, root, findRootSortOverrideCanvas(graph, root))).toBe(0);
    expect(maskableGetModifiedMaterial(graph, root, { m_Maskable: 1 } as unknown as ComponentData, DEFAULT_STENCIL, false, true)).toBe(DEFAULT_STENCIL);
  });
});

describe('Graphic.materialForRendering 的鏈（Graphic.cs:210-224）', () => {
  it('Viewport（Mask ＋ Image）：masking true、state 是 mask 材質、pop 是 unmask 材質（Mask.cs:135-136）', () => {
    const { graph, viewport } = level1();
    const r = graphicStencil(graph, viewport, DEFAULT_STENCIL, true);
    expect(r.masking).toBe(true);
    expect(r.state).toEqual({ ref: 1, op: STENCIL_OP_REPLACE, comp: COMPARE_ALWAYS, readMask: 255, writeMask: 255, colorMask: 0, alphaClip: true });
    expect(r.pop).toEqual({ ref: 1, op: STENCIL_OP_ZERO, comp: COMPARE_ALWAYS, readMask: 255, writeMask: 255, colorMask: 0, alphaClip: true });
  });

  it('遮罩子樹裡的 Graphic：state 是被遮罩的 Keep／Equal，pop 是 null', () => {
    const { graph, viewport } = level1();
    const label = viewport.children[0].children[0].children.find((n) => n.go.m_Name === 'Item Label')!;
    const r = graphicStencil(graph, label, DEFAULT_STENCIL, true);
    expect(r.masking).toBe(false);
    expect(r.pop).toBeNull();
    expect(r.state).toEqual({ ref: 1, op: STENCIL_OP_KEEP, comp: COMPARE_EQUAL, readMask: 1, writeMask: 0, colorMask: COLOR_WRITE_ALL, alphaClip: false });
  });

  it('只有 RectTransform、沒有 Graphic 的節點（Content）：不受影響', () => {
    const { graph, viewport } = level1();
    const r = graphicStencil(graph, viewport.children[0], DEFAULT_STENCIL, true);
    expect(r.masking).toBe(false);
    expect(r.pop).toBeNull();
  });

  it('遮罩外的節點（SettingPanel 的 Image）：stencil 是預設、stencilKey 空字串', () => {
    const { graph } = level1();
    const panel = graph.nodes.get('211')!; // SettingPanel
    const r = graphicStencil(graph, panel, DEFAULT_STENCIL, true);
    expect(isDefaultStencil(r.state)).toBe(true);
    expect(stencilKey(r.state)).toBe('');
  });

  it('stencilKey 對不同狀態給不同 key（重產偵測用）', () => {
    const { graph, viewport } = level1();
    const a = graphicStencil(graph, viewport, DEFAULT_STENCIL, true).state;
    expect(stencilKey(a)).not.toBe('');
    expect(stencilKey(a)).not.toBe(stencilKey(DEFAULT_STENCIL));
  });
});

describe('MaskUtilities（MaskUtilities.cs:36-85）', () => {
  it('FindRootSortOverrideCanvas：level1 的 stopAfter 是 SettingCanvasMainMenu（m_OverrideSorting 1）', () => {
    const { graph, viewport } = level1();
    const stop = findRootSortOverrideCanvas(graph, viewport);
    expect(stop?.id).toBe(ROOT_CANVAS_GO);
    expect((graph.component(stop!, 'Canvas') as ComponentData).m_OverrideSorting).toBe(1);
  });

  it('FindRootSortOverrideCanvas：遇到 overrideSorting 0 的 Canvas 不停，繼續往上（:36-55）', () => {
    const { graph, byName } = synth({
      name: 'Root',
      canvas: 1,
      children: [{ name: 'Nested', canvas: 0, children: [{ name: 'Leaf', mask: 1, image: 1 }] }],
    });
    expect(findRootSortOverrideCanvas(graph, byName.get('Leaf')!)?.go.m_Name).toBe('Root');
  });

  it('GetStencilDepth：Viewport 自己 0、它的子物件與孫物件都是 1（只數祖先）', () => {
    const { graph, viewport } = level1();
    const stop = findRootSortOverrideCanvas(graph, viewport);
    expect(getStencilDepth(graph, viewport, stop)).toBe(0);
    expect(getStencilDepth(graph, viewport.children[0], stop)).toBe(1);
    expect(getStencilDepth(graph, viewport.children[0].children[0], stop)).toBe(1);
  });

  it('GetStencilDepth：stopAfter 自己就是 node 時回 0（:60-63）', () => {
    const { graph } = level1();
    const root = graph.nodes.get(ROOT_CANVAS_GO)!;
    expect(getStencilDepth(graph, root, root)).toBe(0);
  });

  it('MaskEnabled 只看有沒有 Graphic；graphic 的 m_Enabled 是 GetStencilDepth 的計數條件（MaskUtilities.cs:71）', () => {
    const { graph, viewport } = level1();
    expect(maskEnabled(graph, viewport)).toBe(true);
    (graph.component(viewport, 'Image') as ComponentData).m_Enabled = 0;
    expect(maskEnabled(graph, viewport)).toBe(true);
    expect(getStencilDepth(graph, viewport.children[0], findRootSortOverrideCanvas(graph, viewport.children[0]))).toBe(0);
  });

  it('maskNodesOf／activeMaskNodes：level1 只有一個 Mask，Template 關掉時不算啟用', () => {
    const graph = new SceneGraph(load<SceneFile>('scenes/level1.json'));
    const masks = maskNodesOf(graph, graph.nodes.values());
    expect(masks.length).toBe(1);
    expect(masks[0].id).toBe(VIEWPORT_GO);
    expect(activeMaskNodes(graph, masks).length).toBe(0); // Template 存檔裡是關的
    graph.setActive(graph.nodes.get(TEMPLATE_GO)!, true);
    expect(activeMaskNodes(graph, masks).length).toBe(1);
  });

  it('maskSubtree／subtreeLastOrder：pop 繪製要排在子樹之後（scene.ts 的深度優先 order）', () => {
    const { viewport } = level1();
    const sub = maskSubtree(viewport);
    // Viewport、Content、Item、Item Background、Item Checkmark、Item Label
    expect(sub.map((n) => n.go.m_Name)).toEqual(['Viewport', 'Content', 'Item', 'Item Background', 'Item Checkmark', 'Item Label']);
    const last = subtreeLastOrder(viewport);
    expect(last).toBe(Math.max(...sub.map((n) => n.order)));
    // 子樹是連續的 order 區間：最後一個之後就是子樹外的下一個節點
    expect(last - viewport.order).toBe(sub.length - 1);
  });
});

describe('stencilFromMaterial（材質自己的 _Stencil* 欄位）', () => {
  it('TMP 材質 Biko_Bold SDF 的序列化值就是預設值（0／8／0／255／255／15、無 keyword）', () => {
    const s = stencilFromMaterial({ _Stencil: 0, _StencilComp: 8, _StencilOp: 0, _StencilReadMask: 255, _StencilWriteMask: 255, _ColorMask: 15, _UseUIAlphaClip: 0 }, []);
    expect(s).toEqual(DEFAULT_STENCIL);
    expect(isDefaultStencil(s)).toBe(true);
    expect(stencilKey(s)).toBe('');
  });

  it('遊戲資產裡真的有預先設好 stencil 的材質：ALIBABA-PUHUITI-BOLD Atlas（_Stencil 1、_StencilComp 3）', () => {
    const s = stencilFromMaterial({ _Stencil: 1, _StencilComp: 3, _StencilOp: 0, _StencilReadMask: 255, _StencilWriteMask: 255, _ColorMask: 15 }, []);
    expect(isDefaultStencil(s)).toBe(false);
    expect(s.ref).toBe(1);
    expect(s.comp).toBe(COMPARE_EQUAL);
  });

  it('UNITY_UI_ALPHACLIP 是 keyword，_UseUIAlphaClip 是 StencilMaterial 另外寫的 float（StencilMaterial.cs:120-128）', () => {
    expect(stencilFromMaterial({}, ['UNITY_UI_ALPHACLIP']).alphaClip).toBe(true);
    expect(stencilFromMaterial({ _UseUIAlphaClip: 1 }, []).alphaClip).toBe(true);
    expect(stencilFromMaterial({}, []).alphaClip).toBe(false);
  });

  it('欄位缺掉時用預設值（Graphic 沒指定材質 → Canvas.GetDefaultCanvasMaterial，Graphic.cs:81-89）', () => {
    expect(stencilFromMaterial(undefined, undefined)).toEqual(DEFAULT_STENCIL);
    expect(stencilFromMaterial(null, null)).toEqual(DEFAULT_STENCIL);
  });
});

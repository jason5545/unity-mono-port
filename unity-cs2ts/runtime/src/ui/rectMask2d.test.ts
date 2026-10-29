// RectMask2D 裁切（ui/rectMask2d.ts）的測試。期望值逐條對照反編譯原始碼（10/6 讀），行號標在每個 it：
//   RectMask2D.cs（PerformClipping :156-212、IsRaycastLocationValid :147-154）、
//   MaskUtilities.cs（GetRectMaskForClippable :108-144、GetRectMasksForClip :146-176）、
//   Clipping.cs（FindCullAndClipWorldRect）、MaskableGraphic.cs（Cull :143-148、UpdateClipParent :231-247）、
//   TextMeshProUGUI.cs（Cull 覆寫 :365-420）。
// 真資料那條用 level2 的血條 bottom（RectMask2D 元件 2813）；合成樹那幾條自己搭座標，算式寫在斷言旁。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { SceneGraph, type SceneNode } from '../unity/scene';
import type { ComponentData, GameObjectData, SceneFile } from '../unity/types';
import {
  RectClipRegistry,
  findCullAndClipWorldRect,
  getRectMasksForClip,
  parentMaskOf,
  rectMaskRaycastValid,
  rectsOverlap,
} from './rectMask2d';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

// ───────── 真資料：level2 血條 bottom（RectMask2D 元件 2813） ─────────

describe('血條裁切（level2）', () => {
  it('bottom 的 _ClipRect ＝ (8.25, −15.82, 931.91, 25)、valid（padding 8.25/9.18/8.09/0 ＋ Canvas 空間 rect (0,−25)-(940,25)）', () => {
    const graph = new SceneGraph(load<SceneFile>('scenes/level2.json'));
    graph.layout(1920, 1080);
    const comp = graph.file.components['2813'] as ComponentData;
    const bottom = graph.nodeOfComponent('2813')!;
    const { rect, cull } = findCullAndClipWorldRect(graph, getRectMasksForClip(graph, bottom));
    expect(comp.m_Padding).toEqual({ x: 8.25, y: 9.18, z: 8.09, w: 0 });
    // Clipping.FindCullAndClipWorldRect：xMin＝0＋8.25、yMin＝−25＋9.18、xMax＝940−8.09、yMax＝25−0
    // （double 加法的 1e-14 級誤差，逐分量 toBeCloseTo）
    expect(rect.x).toBeCloseTo(8.25, 5);
    expect(rect.y).toBeCloseTo(-15.82, 5);
    expect(rect.x + rect.width).toBeCloseTo(931.91, 5);
    expect(rect.y + rect.height).toBeCloseTo(25, 5);
    expect(cull).toBe(false);
  });
});

// ───────── 合成場景樹 ─────────

interface Spec {
  name: string;
  /** anchor 中心、pivot 0.5；anchoredPosition 與尺寸（Canvas 空間就是父 rect 加這些偏移） */
  pos?: [number, number];
  size?: [number, number];
  rectMask?: [number, number, number, number]; // padding 左、下、右、上
  image?: number; // m_Maskable
  canvas?: number; // m_OverrideSorting
  active?: boolean;
  children?: Spec[];
}

let uid = 0;

/** 手搭場景樹：根是 Screen Space Overlay Canvas（rect 由螢幕決定） */
function synth(root: Spec): { graph: SceneGraph; byName: Map<string, SceneNode> } {
  const gameObjects: Record<string, GameObjectData> = {};
  const components: Record<string, ComponentData> = {};
  const byName = new Map<string, SceneNode>();
  const build = (spec: Spec, parentGo: string | null): string => {
    const goId = `go${++uid}`;
    const tfId = `tf${uid}`;
    const comps: string[] = [tfId];
    const [px, py] = spec.pos ?? [0, 0];
    const [w, h] = spec.size ?? [0, 0];
    components[tfId] = {
      type: 'RectTransform',
      classID: 224,
      gameObject: goId,
      m_LocalPosition: { x: 0, y: 0, z: 0 },
      m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
      m_LocalScale: { x: 1, y: 1, z: 1 },
      m_Children: [],
      m_Father: null,
      m_AnchorMin: { x: 0.5, y: 0.5 },
      m_AnchorMax: { x: 0.5, y: 0.5 },
      m_AnchoredPosition: { x: px, y: py },
      m_SizeDelta: { x: w, y: h },
      m_Pivot: { x: 0.5, y: 0.5 },
    } as ComponentData;
    if (spec.canvas !== undefined) {
      const id = `cv${uid}`;
      comps.push(id);
      components[id] = { type: 'Canvas', classID: 223, gameObject: goId, m_Enabled: 1, m_RenderMode: 0, m_OverrideSorting: spec.canvas, m_SortingOrder: 0, m_SortingLayerID: 0 } as ComponentData;
    }
    if (spec.image !== undefined) {
      const id = `im${uid}`;
      comps.push(id);
      components[id] = { type: 'MonoBehaviour', classID: 114, gameObject: goId, m_Enabled: 1, m_Maskable: spec.image, m_Color: { r: 1, g: 1, b: 1, a: 1 }, script: { class: 'Image' } } as ComponentData;
    }
    if (spec.rectMask !== undefined) {
      const [pl, pb, pr, pt] = spec.rectMask;
      const id = `rk${uid}`;
      comps.push(id);
      components[id] = { type: 'MonoBehaviour', classID: 114, gameObject: goId, m_Enabled: 1, m_Padding: { x: pl, y: pb, z: pr, w: pt }, script: { class: 'RectMask2D' } } as ComponentData;
    }
    // CanvasRenderer：RectClipRegistry 只認「有 CanvasRenderer ＋ Graphic 元件」
    if (spec.image !== undefined) {
      const id = `cr${uid}`;
      comps.push(id);
      components[id] = { type: 'CanvasRenderer', classID: 222, gameObject: goId } as ComponentData;
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
  const graph = new SceneGraph({ guid: 'synth', name: 'synth', src: 'synth', roots: [rootId], gameObjects, components, settings: {} } as unknown as SceneFile);
  graph.refreshHierarchy();
  graph.layout(1920, 1080);
  for (const n of graph.nodes.values()) byName.set(n.go.m_Name, n);
  return { graph, byName };
}

describe('RectMask2D 掛勾與裁切（MaskUtilities／Clipping／MaskableGraphic）', () => {
  it('兩層 RectMask2D 取交集（Clipping.FindCullAndClipWorldRect）', () => {
    // Canvas ⊃ M1（中心、400×300、padding 10/5/20/15）⊃ M2（相對中心 (50,40)、200×100、padding 0）⊃ G
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0, size: [0, 0],
      children: [{
        name: 'M1', size: [400, 300], rectMask: [10, 5, 20, 15],
        children: [{
          name: 'M2', pos: [50, 40], size: [200, 100], rectMask: [0, 0, 0, 0],
          children: [{ name: 'G', size: [50, 50], image: 1 }],
        }],
      }],
    });
    const M2 = byName.get('M2')!;
    const G = byName.get('G')!;
    // parentMaskOf ＝ 最近的一個（GetRectMaskForClippable :124 往上第一個）
    expect(parentMaskOf(graph, G)?.id).toBe(M2.id);
    // getRectMasksForClip(M2) ＝ [M2, M1]（由外往內）
    expect(getRectMasksForClip(graph, M2).map((n) => n.go.m_Name)).toEqual(['M1', 'M2']);
    // M1 canvas rect（pivot 0.5、螢幕中心）＝ (−200,−150)-(200,150)，扣 padding → (−190,−145)-(180,135)
    // M2 中心相對父 +（50,40）→ canvas rect (−50,−10)-(150,90)，padding 0
    // 交集：x max(−190,−50)=−50、y max(−145,−10)=−10、x 側 min(180,150)=150、min(135,90)=90
    const { rect, cull } = findCullAndClipWorldRect(graph, getRectMasksForClip(graph, M2));
    expect(rect.x).toBeCloseTo(-50, 3);
    expect(rect.y).toBeCloseTo(-10, 3);
    expect(rect.width).toBeCloseTo(200, 3);
    expect(rect.height).toBeCloseTo(100, 3);
    expect(cull).toBe(false);
    // cullAll 端到端：G 拿到的就是交集
    const clips = new RectClipRegistry(graph);
    clips.cullAll();
    const st = clips.clipOf(G.id)!;
    expect(st.rect.x).toBeCloseTo(-50, 3);
    expect(st.rect.y).toBeCloseTo(-10, 3);
    expect(st.rect.width).toBeCloseTo(200, 3);
    expect(st.rect.height).toBeCloseTo(100, 3);
    expect(st.valid).toBe(true);
  });

  it('中間隔一個 overrideSorting 的 Canvas → 不裁（GetRectMaskForClippable :129-137）', () => {
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0,
      children: [
        { name: 'M', size: [400, 300], rectMask: [0, 0, 0, 0] },
        { name: 'C', canvas: 1, size: [200, 200], children: [{ name: 'G', size: [50, 50], image: 1 }] },
      ],
    });
    expect(parentMaskOf(graph, byName.get('G')!)).toBe(null);
    const clips = new RectClipRegistry(graph);
    clips.cullAll();
    expect(clips.clipOf(byName.get('G')!.id)).toBe(null);
  });

  it('m_Maskable 0 的 Graphic 不裁（UpdateClipParent :233）', () => {
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0,
      children: [{
        name: 'M', size: [400, 300], rectMask: [10, 5, 20, 15],
        children: [{ name: 'G', size: [50, 50], image: 0 }],
      }],
    });
    const clips = new RectClipRegistry(graph);
    clips.cullAll();
    expect(clips.clipOf(byName.get('G')!.id)).toBe(null);
  });

  it('RectMask2D 不裁自己身上的 Image（GetRectMaskForClippable :119：從 parent 往上走）', () => {
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0,
      children: [{ name: 'M', size: [400, 300], rectMask: [0, 0, 0, 0], children: [{ name: 'Inner', size: [50, 50], image: 1 }] }],
    });
    // 同節點：RectMask2D 與 Image 掛在同一 GO 時，往上走跳過自己（:119 從 transform.parent 開始）
    const shared = synth({
      name: 'Canvas2', canvas: 0,
      children: [{ name: 'Both', size: [400, 300], rectMask: [0, 0, 0, 0], image: 1 }],
    });
    expect(parentMaskOf(graph, byName.get('Inner')!)?.id).toBe(byName.get('M')!.id);
    expect(parentMaskOf(shared.graph, shared.byName.get('Both')!)).toBe(null);
  });

  it('完全在裁切範圍外：cull，射線也打不到（MaskableGraphic.Cull :143-148、GraphicRaycaster :280）', () => {
    // M 在螢幕中心偏右 600，G 偏左 600，互不重疊
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0,
      children: [{
        name: 'M', pos: [600, 0], size: [200, 100], rectMask: [0, 0, 0, 0],
        children: [{ name: 'G', pos: [-600, 0], size: [100, 50], image: 1 }],
      }],
    });
    const clips = new RectClipRegistry(graph);
    clips.cullAll();
    const G = byName.get('G')!;
    expect(clips.isCulled(G.id)).toBe(true);
    // 射線：GraphicRaycaster.Raycast :280 檢查 canvasRenderer.cull ＝ isCulled；
    // 帶入 events.ts 的路徑是 cullCheck（isCulled 為 true 時跳過該 Graphic）
  });

  it('RectMask2D 停用後，子物件的裁切關掉（ClipperRegistry 移除 ＋ DisableRectClipping）', () => {
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0,
      children: [{
        name: 'M', size: [400, 300], rectMask: [10, 5, 20, 15],
        children: [{ name: 'G', size: [50, 50], image: 1 }],
      }],
    });
    const clips = new RectClipRegistry(graph);
    clips.cullAll();
    const G = byName.get('G')!;
    expect(clips.clipOf(G.id)!.valid).toBe(true);
    // 關掉 RectMask2D 元件（m_Enabled 0）→ parentMaskOf 回 null → clip 移除、dirty 記 G
    const maskComp = graph.component(byName.get('M')!, 'RectMask2D')!;
    maskComp.m_Enabled = 0;
    const dirty = clips.cullAll();
    expect(clips.clipOf(G.id)).toBe(null);
    expect(dirty.has(G.id)).toBe(true);
  });

  it('TextMeshProUGUI.Cull：文字 bounds 跟裁切範圍重疊 → 不 cull；不重疊 → cull（TextMeshProUGUI.cs:365-420）', () => {
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0,
      children: [{
        name: 'M', pos: [600, 0], size: [200, 100], rectMask: [0, 0, 0, 0],
        children: [{ name: 'TMP', size: [100, 50], image: 1 }],
      }],
    });
    const clips = new RectClipRegistry(graph);
    const TMP = byName.get('TMP')!;
    // 第一格先建 rec（原版：TMP 網格產生時回報 SetText，下一格 Cull 才用）
    clips.cullAll();
    // 覆寫版 Cull 用 GetCanvasSpaceClippingRect（文字複合 bounds，不是 rect）：
    // TMP 中心在 canvas (600,0)、rect 550..650 跟 M（500..700）其實重疊；故意把 rect 想遠一點不如反過來——
    // 文字 bounds 給 canvas 1180..1240（自己空間 580..640）→ 跟 M（500..700）不重疊 → cull true
    clips.setTextBounds(TMP.id, new Vector3(580, -10, 0), new Vector3(640, 10, 0));
    clips.cullAll();
    expect(clips.isCulled(TMP.id)).toBe(true);
    // 文字往回放到 M 內（canvas 580..640，自己空間 −20..40）→ 重疊，不 cull
    clips.setTextBounds(TMP.id, new Vector3(-20, -10, 0), new Vector3(40, 10, 0));
    clips.cullAll();
    expect(clips.isCulled(TMP.id)).toBe(false);
    // 文字挪回左邊 → 不重疊，cull
    clips.setTextBounds(TMP.id, new Vector3(-650, -25, 0), new Vector3(-550, 25, 0));
    clips.cullAll();
    expect(clips.isCulled(TMP.id)).toBe(true);
  });
});

describe('RectMask2D.IsRaycastLocationValid（:147-154，RectangleContainsScreenPoint 含 padding）', () => {
  it('padding 撐大的邊界內通過、外不通過', () => {
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0,
      children: [{ name: 'M', size: [400, 300], rectMask: [-10, -5, -20, -15] }],
    });
    const M = byName.get('M')!;
    // p 是世界點：Overlay Canvas 的世界原點在螢幕左下（layout()：translate(960,540)），
    // 所以 canvas 座標 (x,y) 的世界點是 (960＋x, 540＋y)。
    // padding 負值往外擴：可射區 x −200＋10..200＋20、y −150＋5..150＋15
    expect(rectMaskRaycastValid(graph, M, new Vector3(960 - 189, 540 - 144, 0))).toBe(true);
    expect(rectMaskRaycastValid(graph, M, new Vector3(960 - 211, 540, 0))).toBe(false);
    expect(rectMaskRaycastValid(graph, M, new Vector3(960 + 219, 540 + 164, 0))).toBe(true);
    expect(rectMaskRaycastValid(graph, M, new Vector3(960 + 221, 540, 0))).toBe(false);
  });
});

describe('邊界行為（Clipping.cs:42-47 validRect、Rect.Overlaps allowInverse:true）', () => {
  it('rect 10×10 加右 padding 10 → 寬 0 → 無效，回零矩形（Clipping.cs:42-47：xMax > xMin 不成立）', () => {
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0,
      children: [{ name: 'M', size: [10, 10], rectMask: [0, 0, 10, 0] }],
    });
    const M = byName.get('M')!;
    const { rect, cull } = findCullAndClipWorldRect(graph, getRectMasksForClip(graph, M));
    // Clipping.cs:44-47：!validRect 回 default(Rect) ＝ 全 0（不是 x=−5、寬 0 但高 10）
    expect(rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(cull).toBe(true);
  });

  it('高為 0 同樣無效（Clipping.cs:42：yMax > yMin）', () => {
    const { graph, byName } = synth({
      name: 'Canvas', canvas: 0,
      children: [{ name: 'M', size: [20, 0], rectMask: [0, 0, 0, 0] }],
    });
    const { rect, cull } = findCullAndClipWorldRect(graph, getRectMasksForClip(graph, byName.get('M')!));
    expect(rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(cull).toBe(true);
  });

  it('Overlaps(allowInverse:true)：負寬高翻正後重疊 → true（MaskableGraphic.cs:146）', () => {
    // (10,10,−10,−10) 的 x 跨 0..10、y 跨 0..10；(1,1,2,2) 跨 1..3 → 重疊面積 > 0
    expect(rectsOverlap({ x: 10, y: 10, width: -10, height: -10 }, { x: 1, y: 1, width: 2, height: 2 })).toBe(true);
  });

  it('負寬高但實際不重疊 → false', () => {
    // (30,10,−10,−10) 的 x 跨 20..30，跟 (1,1,2,2) 的 1..3 不相交
    expect(rectsOverlap({ x: 30, y: 10, width: -10, height: -10 }, { x: 1, y: 1, width: 2, height: 2 })).toBe(false);
  });

  it('邊界相接但沒有面積重疊 → false（Overlaps 用嚴格比較）', () => {
    expect(rectsOverlap({ x: 10, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 })).toBe(false);
    // (30,0,−10,10) 的 x 跨 20..30、(10,0,10,10) 跨 10..20：在 x＝20 相接，面積 0
    expect(rectsOverlap({ x: 30, y: 0, width: -10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});


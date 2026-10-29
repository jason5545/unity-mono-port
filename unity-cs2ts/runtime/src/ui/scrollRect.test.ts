// ScrollRect 的 EnsureLayoutHasRebuilt（2026/10/17，ScrollRect.cs:551-557、796-811）：啟用之後還沒排過版就先 Canvas.ForceUpdateCanvases。
// MT2 的 DeckScreen 打開時同一格放進卡片、ScrollToRow 設 verticalNormalizedPosition；以前用舊的內容尺寸算，網格停在置中，第一排被標題蓋住。
import { describe, expect, it } from 'vitest';
import { World } from '../engine/world';
import { SceneGraph } from '../unity/scene';
import type { ComponentData, SceneFile } from '../unity/types';
import { SCROLLRECT_BEHAVIOURS, type ScrollRectBehaviour } from './scrollRect';

/** Overlay Canvas（1000×1000）→ ScrollRect（100×100）→ Viewport（撐滿）→ Content（VerticalLayoutGroup＋ContentSizeFitter，6 格各高 50，前 2 格啟用） */
function setup() {
  const rect = (go: string, parent: string | null, o: Record<string, unknown> = {}) => ({
    type: 'RectTransform',
    classID: 224,
    gameObject: go,
    m_Father: parent,
    m_Children: [],
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
  const mono = (go: string, cls: string, o: Record<string, unknown> = {}) => ({ type: 'MonoBehaviour', classID: 114, gameObject: go, m_Enabled: 1, script: { class: cls }, ...o });
  const components: Record<string, unknown> = {};
  const gameObjects: Record<string, unknown> = {};
  let id = 1;
  const add = (name: string, parent: string | null, rt: Record<string, unknown>, comps: ((go: string) => Record<string, unknown>)[], active = 1) => {
    const go = String(id++);
    const tf = String(id++);
    const parentTf = parent ? (gameObjects[parent] as { transform: string }).transform : null;
    components[tf] = rect(go, parentTf, rt);
    const ids = [tf];
    for (const c of comps) {
      const cid = String(id++);
      components[cid] = c(go);
      ids.push(cid);
    }
    gameObjects[go] = { m_Name: name, m_IsActive: active, m_Layer: 5, m_TagString: 'Untagged', components: ids, transform: tf, parent, children: [] };
    if (parent) (gameObjects[parent] as { children: string[] }).children.push(go);
    return go;
  };
  const canvas = add('Canvas', null, {}, [(go) => ({ type: 'Canvas', classID: 223, gameObject: go, m_Enabled: 1, m_RenderMode: 0, m_Camera: null, m_PlaneDistance: 100 })]);
  // ScrollRect 的參照要先知道 Content／Viewport 的 RectTransform id：Viewport 是 id 7、8，Content 是 9、10（照 add 的編號）
  const scroll = add('Scroll', canvas, {}, [
    (go) =>
      mono(go, 'ScrollRect', {
        m_Content: { fileID: '10' },
        m_Viewport: { fileID: '8' },
        m_Horizontal: 0,
        m_Vertical: 1,
        m_MovementType: 2,
        m_Elasticity: 0.1,
        m_Inertia: 0,
        m_DecelerationRate: 0.135,
        m_ScrollSensitivity: 1,
        m_VerticalScrollbar: null,
        m_HorizontalScrollbar: null,
        m_VerticalScrollbarVisibility: 0,
      }),
  ]);
  const viewport = add('Viewport', scroll, { m_AnchorMin: { x: 0, y: 0 }, m_AnchorMax: { x: 1, y: 1 }, m_SizeDelta: { x: 0, y: 0 } }, []);
  const content = add('Content', viewport, { m_AnchorMin: { x: 0, y: 0.5 }, m_AnchorMax: { x: 1, y: 0.5 }, m_SizeDelta: { x: 0, y: 0 } }, [
    (go) =>
      mono(go, 'VerticalLayoutGroup', {
        m_Padding: { m_Left: 0, m_Right: 0, m_Top: 0, m_Bottom: 0 },
        m_ChildAlignment: 0,
        m_Spacing: 0,
        m_ChildForceExpandWidth: 0,
        m_ChildForceExpandHeight: 0,
        m_ChildControlWidth: 1,
        m_ChildControlHeight: 1,
        m_ChildScaleWidth: 0,
        m_ChildScaleHeight: 0,
        m_ReverseArrangement: 0,
      }),
    (go) => mono(go, 'ContentSizeFitter', { m_HorizontalFit: 0, m_VerticalFit: 2 }),
  ]);
  const items: string[] = [];
  for (let i = 0; i < 6; i++) {
    items.push(
      add(`Item${i}`, content, {}, [
        (go) => mono(go, 'LayoutElement', { m_IgnoreLayout: 0, m_MinWidth: -1, m_MinHeight: -1, m_PreferredWidth: -1, m_PreferredHeight: 50, m_FlexibleWidth: -1, m_FlexibleHeight: -1, m_LayoutPriority: 1 }),
      ], i < 2 ? 1 : 0),
    );
  }
  const file = { guid: 't', name: 't', src: 't', settings: {}, roots: [canvas], gameObjects, components } as unknown as SceneFile;
  const world = new World(new SceneGraph(file), {
    localization: undefined as never,
    version: 'test',
    controllers: {},
    clips: {},
    registry: { ...SCROLLRECT_BEHAVIOURS },
    layout: {},
    sortingLayerIndex: () => 0,
  });
  world.screen = { w: 1000, h: 1000 };
  world.start();
  world.relayout();
  const node = (go: string) => world.graph.nodes.get(go)!;
  const setActive = (go: string, on: boolean) => {
    world.graph.setActive(node(go), on);
    world.refreshEnables(node(go));
  };
  const sr = world.behaviour<ScrollRectBehaviour>(components['6'] as ComponentData)!;
  return { world, node, setActive, sr, scroll, content, items };
}

describe('ScrollRect.SetNormalizedPosition 前的 EnsureLayoutHasRebuilt', () => {
  it('停用後同一格重新啟用、加進 4 格再設 verticalNormalizedPosition 1：先排版，內容（高 300）的上緣對齊 viewport 上緣', () => {
    const { world, node, setActive, sr, scroll, content, items } = setup();
    expect(node(content).rect.height).toBe(100);
    setActive(scroll, false);
    world.relayout();
    // 下面這幾步是同一格（DeckScreen.SetScreenActive → Initialize → ScrollToRow），中間沒有排版
    setActive(scroll, true);
    for (const it of items.slice(2)) setActive(it, true);
    sr.setVerticalNormalizedPosition(1);
    // 排過版：內容高 6 × 50；位置照新的尺寸算：anchoredPosition.y ＝ viewport 半高 50 − 內容半高 150 ＝ −100
    expect(node(content).rect.height).toBe(300);
    const ap = (node(content).transform as unknown as { m_AnchoredPosition: { y: number } }).m_AnchoredPosition;
    expect(ap.y).toBeCloseTo(-100, 6);
    // 節點的世界矩陣在下一次排版才更新（讀 transform 只沿父物件鏈算，scrollRect 的 getBounds 讀 node.world）
    world.relayout();
    expect(sr.verticalNormalizedPosition).toBeCloseTo(1, 6);
  });

  it('啟用之後已經排過版：不再強制排版（m_HasRebuiltLayout），照目前的內容尺寸算', () => {
    const { world, node, setActive, sr, items, content } = setup();
    let forced = 0;
    const relayout = world.relayout.bind(world);
    world.relayout = () => {
      forced++;
      relayout();
    };
    for (const it of items.slice(2)) setActive(it, true);
    sr.setVerticalNormalizedPosition(1);
    expect(forced).toBe(0);
    expect(node(content).rect.height).toBe(100);
  });
});

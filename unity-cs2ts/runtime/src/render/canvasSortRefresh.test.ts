// 換父物件到別的 Canvas 之後的排序（2026/10/17 Jason：開局畫面按確定，起始牌只剩文字飛走）。
// 原版 RunOpeningScreen.Close → FloatingRewardManager.CreateFloatingRewardFromObject 把牌本身 SetParent 到
// Tooltip Canvas（order 43）的 FloatingRewardsContainer 再飛向牌組。牌的 CardCanvas 是巢狀 Canvas、沒開 overrideSorting，
// 排序跟著上層 Canvas。以前排序鍵的 layer／order 只在建網格時算，Image 還排在開局畫面的 order 11，被淡出中的畫面蓋住。
import { describe, expect, it } from 'vitest';
import { canvasSortLayerOrder, refreshCanvasSortKey } from './sceneRenderer';
import type { CanvasInfo, SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';

const OVERLAY_LAYER = 1e6;

function canvasNode(name: string, order: number, override: number, parent: SceneNode | null): SceneNode {
  const node = { go: { m_Name: name }, parent, canvas: null } as unknown as SceneNode;
  const info: CanvasInfo = {
    node,
    data: { type: 'Canvas', m_SortingOrder: order, m_SortingLayerID: 0, m_OverrideSorting: override } as unknown as ComponentData,
    renderMode: 0,
    scaleFactor: 1,
    referencePixelsPerUnit: 100,
    planeDistance: 100,
  };
  node.canvas = info;
  return node;
}

describe('Canvas 底下的繪製物件：換父物件之後照新的 Canvas 排', () => {
  const db = { sortingLayerIndex: () => 0 };
  const runOpening = canvasNode('Canvas（RunOpeningScreen）', 11, 0, null);
  const tooltip = canvasNode('Tooltip Canvas', 43, 0, null);
  // CardUI → CardCanvas（巢狀、沒開 overrideSorting）→ 牌框的 Image
  const cardUI = { go: { m_Name: 'CardUI' }, parent: runOpening, canvas: runOpening.canvas } as unknown as SceneNode;
  const cardCanvas = canvasNode('CardCanvas', 0, 0, cardUI);
  const image = { go: { m_Name: 'Cardframe backing' }, parent: cardCanvas, canvas: cardCanvas.canvas } as unknown as SceneNode;
  const imageComp = { type: 'MonoBehaviour', script: { class: 'Image' } } as unknown as ComponentData;

  it('巢狀 Canvas 沒開 overrideSorting：order 照上層的 Canvas', () => {
    expect(canvasSortLayerOrder(cardCanvas.canvas!, () => 0)).toEqual([OVERLAY_LAYER, 11]);
  });

  it('牌換到 Tooltip Canvas 底下：每格重算後 Image 排到 order 43；沒換就不動', () => {
    const d = { key: [...canvasSortLayerOrder(image.canvas!, () => 0), 3000, -100, 5] as [number, number, number, number, number], node: image, comp: imageComp };
    expect(refreshCanvasSortKey(d, db)).toBe(false);
    cardUI.parent = tooltip;
    cardUI.canvas = tooltip.canvas;
    expect(refreshCanvasSortKey(d, db)).toBe(true);
    expect(d.key.slice(0, 2)).toEqual([OVERLAY_LAYER, 43]);
    expect(refreshCanvasSortKey(d, db)).toBe(false);
  });

  it('不是 Canvas 的繪製物件（SpriteRenderer 等）不管', () => {
    const sprite = { type: 'SpriteRenderer' } as unknown as ComponentData;
    const d = { key: [0, 7, 3000, -1, 1] as [number, number, number, number, number], node: image, comp: sprite };
    expect(refreshCanvasSortKey(d, db)).toBe(false);
    expect(d.key[1]).toBe(7);
  });
});

// 覆寫 Rebuild 的 TMP 子類別（2026/10/17）：文字、字距、顏色變了，Canvas 畫之前叫腳本的 Rebuild(PreRender)
// （Unity 的 CanvasUpdateRegistry.PerformUpdate）。ExtendedTextMeshProUGUI 在這裡 WarpText；以前只有 OnEnable 那一次，
// 之後地圖設區域名稱，彎曲的掛勾字數對不上就不蓋，標籤變直的。
import { describe, expect, it } from 'vitest';
import { World } from '../engine/world';
import { SceneGraph } from '../unity/scene';
import type { ComponentData, SceneFile } from '../unity/types';
import { compHandle, ctxOf, registerGen, type GenClassImpl } from './core';
import { nativeBase } from './unityNative';
import './unityTmp';

const calls: number[] = [];
const TestWarp: GenClassImpl = {
  name: 'TestWarpTMP',
  file: 'TestWarpTMP.cs',
  dllBases: ['TextMeshProUGUI', 'TMP_Text', 'MaskableGraphic', 'Graphic', 'UIBehaviour', 'MonoBehaviour', 'Behaviour', 'Component', 'Object'],
  initAi: () => ({}),
  overrides: { Rebuild: (_c: unknown, update: number) => void calls.push(update) },
  delegates: {},
  methods: { Rebuild: (_c: unknown, update: number) => void calls.push(update) },
};
registerGen({ TestWarpTMP: TestWarp });

function setup() {
  const rect = (go: string, parent: string | null) => ({
    type: 'RectTransform', classID: 224, gameObject: go, m_Father: parent, m_Children: [],
    m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalScale: { x: 1, y: 1, z: 1 },
    m_AnchorMin: { x: 0.5, y: 0.5 }, m_AnchorMax: { x: 0.5, y: 0.5 }, m_AnchoredPosition: { x: 0, y: 0 }, m_SizeDelta: { x: 200, y: 50 }, m_Pivot: { x: 0.5, y: 0.5 },
  });
  const file = {
    guid: 't', name: 't', src: 't', settings: {}, roots: ['1'],
    gameObjects: {
      '1': { m_Name: 'Canvas', m_IsActive: 1, m_Layer: 5, m_TagString: 'Untagged', components: ['2', '3'], transform: '2', parent: null, children: ['4'] },
      '4': { m_Name: 'Label', m_IsActive: 1, m_Layer: 5, m_TagString: 'Untagged', components: ['5', '6'], transform: '5', parent: '1', children: [] },
    },
    components: {
      '2': rect('1', null),
      '3': { type: 'Canvas', classID: 223, gameObject: '1', m_Enabled: 1, m_RenderMode: 0, m_Camera: null, m_PlaneDistance: 100 },
      '5': rect('4', '2'),
      '6': { type: 'MonoBehaviour', classID: 114, gameObject: '4', m_Enabled: 1, script: { class: 'TestWarpTMP' }, m_text: 'Limbo', m_fontSize: 36, m_fontColor: { r: 1, g: 1, b: 1, a: 1 }, m_characterSpacing: 0 },
    },
  } as unknown as SceneFile;
  const world = new World(new SceneGraph(file), { localization: undefined as never, version: 'test', controllers: {}, clips: {}, registry: {}, layout: {}, sortingLayerIndex: () => 0 });
  world.start();
  const comp = file.components['6'] as ComponentData;
  const h = compHandle(world, comp);
  // 產生碼的 OnEnable 先叫 base.OnEnable（R.nativeBase(c, c.self, "TextMeshProUGUI", "OnEnable")）
  nativeBase(ctxOf(world, h, 'TestWarpTMP'), h, 'TextMeshProUGUI', 'OnEnable');
  calls.length = 0;
  return { world, comp, node: world.graph.nodes.get('4')! };
}

describe('TMP 子類別的 Rebuild(PreRender)', () => {
  it('啟用後第一次畫之前叫一次；沒變不再叫；文字、顏色、字距改了各叫一次', () => {
    const { world, comp } = setup();
    world.tick(1 / 60);
    expect(calls).toEqual([3]);
    world.tick(1 / 60);
    expect(calls).toEqual([3]);
    comp.m_text = 'Heaven\'s Gate';
    world.tick(1 / 60);
    expect(calls).toEqual([3, 3]);
    comp.m_fontColor = { r: 1, g: 0, b: 0, a: 1 };
    world.tick(1 / 60);
    comp.m_characterSpacing = -6;
    world.tick(1 / 60);
    expect(calls).toEqual([3, 3, 3, 3]);
  });

  it('物件停用時不叫，重新啟用後照變過的文字叫', () => {
    const { world, comp, node } = setup();
    world.tick(1 / 60);
    calls.length = 0;
    world.graph.setActive(node, false);
    comp.m_text = 'The Aviary';
    world.tick(1 / 60);
    expect(calls).toEqual([]);
    world.graph.setActive(node, true);
    world.tick(1 / 60);
    expect(calls).toEqual([3]);
  });
});

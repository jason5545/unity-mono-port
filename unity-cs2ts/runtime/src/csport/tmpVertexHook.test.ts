// UpdateVertexData 的掛勾（10/18）：頂點與顏色跟上一次一樣就沿用同一個掛勾（版本不變，繪製端不重產）；
// MT2 戰鬥的 Chatter 文字每格呼叫一次、內容不變，以前每格整個重產。
import { describe, expect, it } from 'vitest';
import { World, type RenderServices } from '../engine/world';
import { SceneGraph } from '../unity/scene';
import type { ComponentData, SceneFile } from '../unity/types';
import type { TextMeshResult } from '../text/types';
import type { TmpVertexHook } from '../text/vertexHooks';
import { compHandle, ctxOf, registerGen, type GenClassImpl } from './core';
import { TMP_Text_UpdateVertexData$ } from './unityTmp';
import { nativeGet } from './unityNative';

const TestTmp: GenClassImpl = {
  name: 'TestVertexTMP',
  file: 'TestVertexTMP.cs',
  dllBases: ['TextMeshProUGUI', 'TMP_Text', 'MaskableGraphic', 'Graphic', 'UIBehaviour', 'MonoBehaviour', 'Behaviour', 'Component', 'Object'],
  initAi: () => ({}),
  overrides: {},
  delegates: {},
  methods: {},
};
registerGen({ TestVertexTMP: TestTmp });

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
      '6': { type: 'MonoBehaviour', classID: 114, gameObject: '4', m_Enabled: 1, script: { class: 'TestVertexTMP' }, m_text: 'Hi', m_fontSize: 36 },
    },
  } as unknown as SceneFile;
  const world = new World(new SceneGraph(file), { localization: undefined as never, version: 'test', controllers: {}, clips: {}, registry: {}, layout: {}, sortingLayerIndex: () => 0 });
  // 一個字（四個頂點）的假排版結果
  const result = (): TextMeshResult =>
    ({
      characterCount: 1,
      textInfo: { characterCount: 1, spriteCount: 0, spaceCount: 0, wordCount: 1, linkCount: 0, lineCount: 1, pageCount: 1, materialCount: 1, characterInfo: [], lineInfo: [], wordInfo: [], linkInfo: [], pageInfo: [] },
      subMeshes: [{ materialIndex: 0, positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), colors: new Uint8Array(16).fill(255), uvs0: new Float32Array(16), uvs2: new Float32Array(8), indices: [0, 1, 2, 2, 3, 0] }],
    }) as unknown as TextMeshResult;
  const hooks: TmpVertexHook[] = [];
  (world.services as { render?: Partial<RenderServices> }).render = {
    layoutText: () => result(),
    setTextHook: (_comp: ComponentData, hook: TmpVertexHook | null) => void (hook && hooks.push(hook)),
    textResultOf: () => null,
  };
  const comp = file.components['6'] as ComponentData;
  const h = compHandle(world, comp);
  const c = ctxOf(world, h, 'TestVertexTMP');
  return { c, h, hooks };
}

describe('TMP UpdateVertexData 的掛勾', () => {
  it('頂點與顏色沒變：沿用同一個掛勾（版本不變）；改了才換新的版本', () => {
    const { c, h, hooks } = setup();
    const info = nativeGet(c, h, 'TMP_Text', 'textInfo') as { meshInfo: { vertices: { x: number }[]; colors32: { a: number }[] }[] };
    TMP_Text_UpdateVertexData$(c, h);
    TMP_Text_UpdateVertexData$(c, h);
    expect(hooks.length).toBe(2);
    expect(hooks[1]).toBe(hooks[0]);
    info.meshInfo[0].vertices[2].x = 5;
    TMP_Text_UpdateVertexData$(c, h);
    expect(hooks[2].version).not.toBe(hooks[0].version);
    info.meshInfo[0].colors32[1].a = 10;
    TMP_Text_UpdateVertexData$(c, h);
    expect(hooks[3].version).not.toBe(hooks[2].version);
    TMP_Text_UpdateVertexData$(c, h);
    expect(hooks[4]).toBe(hooks[3]);
  });
});

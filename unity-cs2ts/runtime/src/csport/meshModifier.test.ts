// 原生 Image 的 IMeshModifier（2026/10/17）：MT2 設定選單的底是淺灰的 DP_Bg_Banner 乘上 Gradient2 的深紅漸層，
// Image 由繪製端照元件欄位產網格，以前不叫同一個物件上的 ModifyMesh，漸層與 UIFlippable 的翻轉都沒套。
// 現在照 Graphic.DoMeshGeneration：Image.OnPopulateMesh 的結果（位置、m_Color、uv0）進 VertexHelper，依元件順序叫產生碼的 ModifyMesh。
// 另外：UnityEngine.Pool.CollectionPool（Shadow／Outline 的 ModifyMesh 用）、Steam 介面語言照瀏覽器語言。
import { describe, expect, it } from 'vitest';
import { World } from '../engine/world';
import { graphicMeshModifier } from '../ui/graphicMeshModifier';
import { SceneGraph } from '../unity/scene';
import type { SceneFile } from '../unity/types';
import { compHandle, ctxOf, genBehaviour, registerGen, setActiveWorld, staticCtx, type Ctx, type GenClassImpl } from './core';
import { browserSteamLanguage } from './steamworks';
import * as R from './unity';

/** 每個頂點往右 ai.dx；ai.dx 是序列化欄位 */
const Shift: GenClassImpl = {
  name: 'TestShiftX',
  file: 'TestShiftX.cs',
  base: 'BaseMeshEffect',
  interfaces: ['IMeshModifier'],
  initAi: () => ({ dx: 10 }),
  overrides: {},
  delegates: {},
  methods: {
    ModifyMesh$VertexHelper: (c: Ctx, vh: R.VertexHelper) => {
      for (let i = 0; i < vh.currentVertCount; i++) {
        let v = R.newUIVertex();
        R.VertexHelper_PopulateUIVertex(c, vh, { get v() { return v; }, set v(x) { v = x; } }, i);
        v.position.x += c.ai.dx as number;
        v.color = { ...v.color, g: 0 };
        R.VertexHelper_SetUIVertex(c, vh, v, i);
      }
    },
  },
};
registerGen({ TestShiftX: Shift });

function setup(withEffect: boolean) {
  const file = {
    guid: 'g', name: 'g', src: 'g', settings: {}, roots: ['1'],
    gameObjects: { '1': { m_Name: 'Image bg banner', m_IsActive: 1, m_Layer: 5, m_TagString: 'Untagged', components: withEffect ? ['2', '3', '4'] : ['2', '3'], transform: '2', parent: null, children: [] } },
    components: {
      '2': { type: 'RectTransform', classID: 224, gameObject: '1', m_Father: null, m_Children: [], m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_AnchorMin: { x: 0.5, y: 0.5 }, m_AnchorMax: { x: 0.5, y: 0.5 }, m_AnchoredPosition: { x: 0, y: 0 }, m_SizeDelta: { x: 100, y: 50 }, m_Pivot: { x: 0.5, y: 0.5 } },
      '3': { type: 'MonoBehaviour', classID: 114, gameObject: '1', m_Enabled: 1, script: { class: 'Image' }, m_Color: { r: 1, g: 1, b: 1, a: 1 }, m_Sprite: null, m_Type: 0 },
      '4': { type: 'MonoBehaviour', classID: 114, gameObject: '1', m_Enabled: 1, script: { class: 'TestShiftX' } },
    },
  } as unknown as SceneFile;
  const world = new World(new SceneGraph(file), { localization: undefined as never, version: 'test', controllers: {}, clips: {}, registry: { TestShiftX: genBehaviour('TestShiftX') }, layout: {}, sortingLayerIndex: () => 0 });
  setActiveWorld(world);
  world.start();
  return { world, node: world.graph.nodes.get('1')! };
}
const quad = () => ({ positions: [-50, -25, 0, -50, 25, 0, 50, 25, 0, 50, -25, 0], uvs: [0, 0, 0, 1, 1, 1, 1, 0], colors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], indices: [0, 1, 2, 2, 3, 0] });

describe('原生 Image 的 IMeshModifier（Graphic.DoMeshGeneration）', () => {
  it('同一個物件上的修改器改位置與頂點色（Color32 進、÷ 255 出）', () => {
    const { node } = setup(true);
    const out = graphicMeshModifier()!.modify(node, quad())!;
    expect(out.positions.slice(0, 3)).toEqual([-40, -25, 0]);
    expect(out.colors.slice(0, 4)).toEqual([1, 0, 1, 1]);
    expect(out.uvs).toEqual(quad().uvs);
    expect(out.indices).toEqual([0, 1, 2, 2, 3, 0]);
  });

  it('沒有修改器回 null（照原本的網格畫），簽章是空的', () => {
    const { node } = setup(false);
    expect(graphicMeshModifier()!.modify(node, quad())).toBeNull();
    expect(graphicMeshModifier()!.signature(node)).toBe('');
  });

  it('簽章跟著修改器的欄位與啟用變（繪製端照它重產網格）', () => {
    const { world, node } = setup(true);
    const sig0 = graphicMeshModifier()!.signature(node);
    const fx = world.graph.components(node).find((c) => c.script?.class === 'TestShiftX')!;
    const ctx = ctxOf(world, compHandle(world, fx), 'TestShiftX');
    ctx.ai.dx = 20;
    const sig1 = graphicMeshModifier()!.signature(node);
    expect(sig1).not.toBe(sig0);
    fx.m_Enabled = 0;
    expect(graphicMeshModifier()!.signature(node)).not.toBe(sig1);
  });
});

describe('UnityEngine.Pool.CollectionPool', () => {
  it('Get 照型別名給空的 List（陣列）或 Dictionary；Release 清空', () => {
    const list = R.CollectionPool_Get$(staticCtx, 'List$1<UIVertex>', 'UIVertex') as unknown[];
    expect(list).toEqual([]);
    list.push(1);
    R.CollectionPool_Release(staticCtx, list);
    expect(list).toEqual([]);
    expect(R.CollectionPool_Get$(staticCtx, 'Dictionary$2<String, Int32>', 'KeyValuePair$2<String, Int32>')).toBeInstanceOf(Map);
  });
  it('Get(out x) 給 PooledObject，Dispose 時清空', () => {
    let got: unknown[] = [9];
    const p = R.CollectionPool_Get$TCollection(staticCtx, (v) => (got = v as unknown[]), 'List$1<CharacterState>', 'CharacterState');
    got.push('a');
    R.PooledObject_Dispose(staticCtx, p);
    expect(got).toEqual([]);
  });
});

describe('Steam 介面語言（瀏覽器語言 → Steam 的語言名）', () => {
  it('中文照文字分：繁體（台灣、香港、澳門、Hant）是 tchinese，其他是 schinese', () => {
    expect(browserSteamLanguage(['zh-TW'])).toBe('tchinese');
    expect(browserSteamLanguage(['zh-Hant-TW'])).toBe('tchinese');
    expect(browserSteamLanguage(['zh-HK'])).toBe('tchinese');
    expect(browserSteamLanguage(['zh-CN'])).toBe('schinese');
    expect(browserSteamLanguage(['zh'])).toBe('schinese');
  });
  it('其他：pt-BR、拉丁美洲西班牙文、韓文、沒有對應的回 english', () => {
    expect(browserSteamLanguage(['pt-BR'])).toBe('brazilian');
    expect(browserSteamLanguage(['es-MX'])).toBe('latam');
    expect(browserSteamLanguage(['es-ES'])).toBe('spanish');
    expect(browserSteamLanguage(['ko-KR'])).toBe('koreana');
    expect(browserSteamLanguage(['ja'])).toBe('japanese');
    expect(browserSteamLanguage(['xx'])).toBe('english');
    expect(browserSteamLanguage([])).toBe('english');
  });
});

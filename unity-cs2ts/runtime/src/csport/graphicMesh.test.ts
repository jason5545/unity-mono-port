// 腳本自己產網格的 Graphic（2026/10/17）：MT2 出牌的瞄準曲線是 UI Extensions 的 UILineRenderer（MaskableGraphic 的子類別，覆寫 OnPopulateMesh），
// 以前執行環境不跑 OnPopulateMesh、VertexHelper 也沒有，曲線完全沒畫。現在照 UnityEngine.UI 的 Graphic.Rebuild → UpdateGeometry
// （OnPopulateMesh、IMeshModifier、FillMesh、CanvasRenderer.SetMesh）→ UpdateMaterial 走，繪製端照 CanvasRenderer 的網格畫。
import { describe, expect, it } from 'vitest';
import { World } from '../engine/world';
import { canvasMeshOf, existingCanvasRendererState, isCanvasMeshClass } from '../ui/canvasRenderer';
import type { MeshInstance } from '../unity/meshes';
import { SceneGraph } from '../unity/scene';
import type { ComponentData, SceneFile } from '../unity/types';
import { cloneData, compHandle, ctxOf, genBehaviour, newExternal, registerGen, setActiveWorld, staticCtx, type Ctx, type GenClassImpl } from './core';
import * as R from './unity';
import { nativeGet } from './unityNative';

type V4 = { x: number; y: number; z: number; w: number };
const white32 = { r: 255, g: 255, b: 255, a: 255, $color32: true as const };

describe('VertexHelper（UnityEngine.UI VertexHelper.cs）', () => {
  it('AddUIVertexQuad：四個頂點、三角形 (0,1,2)、(2,3,0)；uv2、uv3 不帶', () => {
    const vh = R.new_VertexHelper$(staticCtx);
    R.VertexHelper_AddVert$Vector3_Color32_Vector4(staticCtx, vh, { x: 9, y: 9, z: 0 }, white32, { x: 0, y: 0, z: 0, w: 0 });
    const v = (x: number, y: number) => ({ ...R.simpleVert(), position: { x, y, z: 0 }, uv2: { x: 5, y: 5, z: 5, w: 5 } });
    R.VertexHelper_AddUIVertexQuad(staticCtx, vh, [v(0, 0), v(0, 1), v(1, 1), v(1, 0)]);
    expect(nativeGet(staticCtx, vh, 'VertexHelper', 'currentVertCount')).toBe(5);
    expect(vh.indices).toEqual([1, 2, 3, 3, 4, 1]);
    expect(vh.uv2s[2]).toEqual({ x: 0, y: 0, z: 0, w: 0 });
  });

  it('AddVert(position, color, uv0)：法線 back、切線 (1, 0, 0, −1)；Vector2 的 uv 補 0', () => {
    const vh = R.new_VertexHelper$(staticCtx);
    R.VertexHelper_AddVert$Vector3_Color32_Vector4(staticCtx, vh, { x: 1, y: 2, z: 0 }, white32, { x: 0.5, y: 1 } as V4);
    expect(vh.normals[0]).toEqual({ x: 0, y: 0, z: -1 });
    expect(vh.tangents[0]).toEqual({ x: 1, y: 0, z: 0, w: -1 });
    expect(vh.uv0s[0]).toEqual({ x: 0.5, y: 1, z: 0, w: 0 });
  });

  it('PopulateUIVertex（ref 參數）與 SetUIVertex 改第 i 個頂點', () => {
    const vh = R.new_VertexHelper$(staticCtx);
    R.VertexHelper_AddVert$Vector3_Color32_Vector4(staticCtx, vh, { x: 1, y: 2, z: 0 }, white32, { x: 0, y: 0, z: 0, w: 0 });
    let vertex = R.newUIVertex();
    R.VertexHelper_PopulateUIVertex(staticCtx, vh, { get v() { return vertex; }, set v(x) { vertex = x; } }, 0);
    expect(vertex.position).toEqual({ x: 1, y: 2, z: 0 });
    vertex.position.x += 10;
    expect(vh.positions[0].x).toBe(1); // 拿出來的是複本
    R.VertexHelper_SetUIVertex(staticCtx, vh, vertex, 0);
    expect(vh.positions[0].x).toBe(11);
    expect(() => R.VertexHelper_SetUIVertex(staticCtx, vh, vertex, 1)).toThrow();
  });

  it('FillMesh：頂點、Color32 ÷ 255、uv 四個分量、三角形；65000 個頂點以上丟錯', () => {
    const vh = R.new_VertexHelper$(staticCtx);
    for (const [x, y] of [[0, 0], [0, 1], [1, 1]]) R.VertexHelper_AddVert$Vector3_Color32_Vector4(staticCtx, vh, { x, y, z: 0 }, { r: 255, g: 0, b: 0, a: 230, $color32: true }, { x, y, z: 0, w: 2 });
    R.VertexHelper_AddTriangle(staticCtx, vh, 0, 1, 2);
    const mesh = newExternal(staticCtx, 'Mesh') as MeshInstance;
    R.VertexHelper_FillMesh(staticCtx, vh, mesh);
    expect(mesh.vertexCount).toBe(3);
    expect(Array.from(mesh.channels.color.values.slice(0, 4))).toEqual([1, 0, 0, Math.fround(230 / 255)]);
    expect(mesh.channels.uv0.dimension).toBe(4);
    expect(mesh.channels.uv0.values[3]).toBe(2);
    expect(mesh.indices).toEqual([0, 1, 2]);
    const big = R.new_VertexHelper$(staticCtx);
    for (let i = 0; i < 65000; i++) big.addVert({ x: i, y: 0, z: 0 }, white32, {}, {}, {}, {}, {}, {});
    expect(() => R.VertexHelper_FillMesh(staticCtx, big, newExternal(staticCtx, 'Mesh'))).toThrow(/65000/);
  });

  it('GetUIVertexStream 照三角形展開，AddUIVertexTriangleStream 整份換成三個一組', () => {
    const vh = R.new_VertexHelper$(staticCtx);
    for (const x of [0, 1, 2, 3]) R.VertexHelper_AddVert$Vector3_Color32_Vector4(staticCtx, vh, { x, y: 0, z: 0 }, white32, { x: 0, y: 0, z: 0, w: 0 });
    vh.indices.push(0, 1, 2, 2, 3, 0);
    const stream: R.UIVertex[] = [R.newUIVertex()];
    R.VertexHelper_GetUIVertexStream(staticCtx, vh, stream);
    expect(stream.map((v) => v.position.x)).toEqual([0, 1, 2, 2, 3, 0]);
    R.VertexHelper_AddUIVertexTriangleStream(staticCtx, vh, stream);
    expect(vh.currentVertCount).toBe(6);
    expect(vh.indices).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('UIVertex', () => {
  it('UIVertex.simpleVert：白色、法線 back；每次讀都是新的一份', () => {
    const a = nativeGet(staticCtx, null, 'UIVertex', 'simpleVert') as R.UIVertex;
    a.position.x = 99;
    const b = nativeGet(staticCtx, null, 'UIVertex', 'simpleVert') as R.UIVertex;
    expect(b.position.x).toBe(0);
    expect(b.color).toEqual(white32);
    expect(b.normal).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('new UIVertex() 全部是 0；指定時照欄位複製（cloneData）', () => {
    const v = newExternal(staticCtx, 'UIVertex') as R.UIVertex;
    expect(v.color).toEqual({ r: 0, g: 0, b: 0, a: 0, $color32: true });
    const copy = cloneData(v);
    copy.position.x = 3;
    expect(v.position.x).toBe(0);
  });
});

describe('Sprites.DataUtility', () => {
  it('GetOuterUV／GetInnerUV 照 textureRect 與 border', () => {
    const sprite = { m_Rect: { x: 0, y: 0, width: 64, height: 64 }, m_Border: { x: 8, y: 8, z: 8, w: 8 }, textureRect: { x: 64, y: 0, width: 64, height: 64 }, textureRectOffset: { x: 0, y: 0 }, textureWidth: 256, textureHeight: 128, m_PixelsToUnits: 100 };
    const c = { w: { services: { render: { spriteInfo: () => sprite } } } } as unknown as Ctx;
    expect(R.DataUtility_GetOuterUV(c, { guid: 's', fileID: '21300000' })).toEqual({ x: 0.25, y: 0, z: 0.5, w: 0.5 });
    expect(R.DataUtility_GetInnerUV(c, { guid: 's', fileID: '21300000' })).toEqual({ x: 72 / 256, y: 8 / 128, z: 120 / 256, w: 56 / 128 });
  });
});

// ───────── Graphic 的重建 ─────────

const populated: number[] = [];
/** 測試用的 UILineRenderer：MaskableGraphic 的子類別，OnPopulateMesh 畫 rect 一片，顏色是 Graphic.color；沒有覆寫 OnEnable（Unity 叫原生的 Graphic.OnEnable） */
const TestQuad: GenClassImpl = {
  name: 'TestQuadGraphic',
  file: 'TestQuadGraphic.cs',
  base: 'MaskableGraphic',
  interfaces: ['ICanvasElement', 'IMaterialModifier'],
  initAi: () => ({}),
  overrides: {},
  delegates: {},
  methods: {
    OnPopulateMesh$VertexHelper: (c: Ctx, vh: R.VertexHelper) => {
      populated.push(1);
      R.VertexHelper_Clear(c, vh);
      const col = R.Color32_op_Implicit$Color(c, nativeGet(c, c.self, 'Graphic', 'color') as never);
      for (const [x, y] of [[-50, -10], [-50, 10], [50, 10], [50, -10]]) R.VertexHelper_AddVert$Vector3_Color32_Vector4(c, vh, { x, y, z: 0 }, col as never, { x: 0, y: 0, z: 0, w: 0 });
      R.VertexHelper_AddTriangle(c, vh, 0, 1, 2);
      R.VertexHelper_AddTriangle(c, vh, 2, 3, 0);
    },
    get_material: () => ({ guid: 'beam', fileID: '2100000' }),
    get_mainTexture: () => ({ guid: 'links', fileID: '2800000' }),
  },
};
/** 同一個物件上的 IMeshModifier（BaseMeshEffect 的子類別）：每個頂點往右 10 */
const TestShift: GenClassImpl = {
  name: 'TestShiftEffect',
  file: 'TestShiftEffect.cs',
  base: 'BaseMeshEffect',
  interfaces: ['IMeshModifier'],
  initAi: () => ({}),
  overrides: {},
  delegates: {},
  methods: {
    ModifyMesh$VertexHelper: (c: Ctx, vh: R.VertexHelper) => {
      for (let i = 0; i < vh.currentVertCount; i++) {
        let v = R.newUIVertex();
        R.VertexHelper_PopulateUIVertex(c, vh, { get v() { return v; }, set v(x) { v = x; } }, i);
        v.position.x += 10;
        R.VertexHelper_SetUIVertex(c, vh, v, i);
      }
    },
  },
};
const TestImageChild: GenClassImpl = { ...TestQuad, name: 'TestImageChild', base: 'Image' };
const TestPlainGraphic: GenClassImpl = { name: 'TestPlainGraphic', file: 'TestPlainGraphic.cs', base: 'Graphic', initAi: () => ({}), overrides: {}, delegates: {}, methods: {} };
registerGen({ TestQuadGraphic: TestQuad, TestShiftEffect: TestShift, TestImageChild, TestPlainGraphic });

function setup() {
  const rect = (go: string, parent: string | null) => ({
    type: 'RectTransform', classID: 224, gameObject: go, m_Father: parent, m_Children: [],
    m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalScale: { x: 1, y: 1, z: 1 },
    m_AnchorMin: { x: 0.5, y: 0.5 }, m_AnchorMax: { x: 0.5, y: 0.5 }, m_AnchoredPosition: { x: 0, y: 0 }, m_SizeDelta: { x: 200, y: 50 }, m_Pivot: { x: 0.5, y: 0.5 },
  });
  const file = {
    guid: 'g', name: 'g', src: 'g', settings: {}, roots: ['1'],
    gameObjects: {
      '1': { m_Name: 'Canvas', m_IsActive: 1, m_Layer: 5, m_TagString: 'Untagged', components: ['2', '3'], transform: '2', parent: null, children: ['4'] },
      '4': { m_Name: 'CurveRenderer', m_IsActive: 1, m_Layer: 5, m_TagString: 'Untagged', components: ['5', '6', '7', '8'], transform: '5', parent: '1', children: [] },
    },
    components: {
      '2': rect('1', null),
      '3': { type: 'Canvas', classID: 223, gameObject: '1', m_Enabled: 1, m_RenderMode: 0, m_Camera: null, m_PlaneDistance: 100 },
      '5': rect('4', '2'),
      '6': { type: 'CanvasRenderer', classID: 222, gameObject: '4' },
      '7': { type: 'MonoBehaviour', classID: 114, gameObject: '4', m_Enabled: 1, script: { class: 'TestQuadGraphic' }, m_Color: { r: 1, g: 1, b: 1, a: 1 }, m_RaycastTarget: 0 },
      '8': { type: 'MonoBehaviour', classID: 114, gameObject: '4', m_Enabled: 1, script: { class: 'TestShiftEffect' } },
    },
  } as unknown as SceneFile;
  const world = new World(new SceneGraph(file), {
    localization: undefined as never, version: 'test', controllers: {}, clips: {},
    registry: { TestQuadGraphic: genBehaviour('TestQuadGraphic'), TestShiftEffect: genBehaviour('TestShiftEffect') },
    layout: {}, sortingLayerIndex: () => 0,
  });
  setActiveWorld(world);
  world.start();
  const comp = file.components['7'] as ComponentData;
  const h = compHandle(world, comp);
  const c = ctxOf(world, h, 'TestQuadGraphic');
  const node = world.graph.nodes.get('4')!;
  const state = () => existingCanvasRendererState(file.components['6'] as ComponentData);
  populated.length = 0;
  return { world, comp, h, c, node, state };
}

describe('Graphic 的重建（覆寫 OnPopulateMesh 的 Graphic）', () => {
  it('啟用後第一次畫之前 OnPopulateMesh → IMeshModifier → CanvasRenderer 的網格、材質、貼圖', () => {
    const { world, state, node, comp } = setup();
    world.tick(1 / 60);
    expect(populated.length).toBe(1);
    const mesh = state()!.mesh as MeshInstance;
    expect(mesh.vertexCount).toBe(4);
    expect(Array.from(mesh.channels.position.values.slice(0, 3))).toEqual([-40, -10, 0]); // 往右 10（IMeshModifier）
    expect(mesh.indices).toEqual([0, 1, 2, 2, 3, 0]);
    expect(state()!.materials[0]).toEqual({ guid: 'beam', fileID: '2100000' });
    expect(state()!.texture).toEqual({ guid: 'links', fileID: '2800000' });
    // 繪製端從 CanvasRenderer 拿
    expect(canvasMeshOf('TestQuadGraphic', node, comp)).toEqual({ mesh, material: { guid: 'beam', fileID: '2100000' }, texture: { guid: 'links', fileID: '2800000' } });
  });

  it('沒變不重建；SetVerticesDirty、顏色、rect 變了各重建一次', () => {
    const { world, h, c, comp, node } = setup();
    world.tick(1 / 60);
    world.tick(1 / 60);
    expect(populated.length).toBe(1);
    R.Graphic_SetVerticesDirty(c, h);
    world.tick(1 / 60);
    expect(populated.length).toBe(2);
    comp.m_Color = { r: 1, g: 0, b: 0, a: 0.9 };
    world.tick(1 / 60);
    expect(populated.length).toBe(3);
    (world.graph.components(node).find((x) => x.type === 'RectTransform') as ComponentData).m_SizeDelta = { x: 300, y: 50 };
    world.relayout();
    world.tick(1 / 60);
    expect(populated.length).toBe(4);
  });

  it('關掉時清掉 CanvasRenderer 的網格、停用期間不重建；重新啟用再重建', () => {
    const { world, h, c, state } = setup();
    world.tick(1 / 60);
    R.Behaviour_set_enabled(c, h, false);
    expect(state()!.mesh).toBeNull();
    R.Graphic_SetAllDirty(c, h);
    world.tick(1 / 60);
    expect(populated.length).toBe(1);
    R.Behaviour_set_enabled(c, h, true);
    world.tick(1 / 60);
    expect(populated.length).toBe(2);
    expect((state()!.mesh as MeshInstance).vertexCount).toBe(4);
  });

  it('繪製端只把「原生基底是 Graphic／MaskableGraphic、覆寫 OnPopulateMesh」的類別當 CanvasRenderer 網格', () => {
    expect(isCanvasMeshClass('TestQuadGraphic')).toBe(true);
    expect(isCanvasMeshClass('TestImageChild')).toBe(false); // Image 的子類別照舊由 Image 那條畫
    expect(isCanvasMeshClass('TestPlainGraphic')).toBe(false); // 沒覆寫 OnPopulateMesh
    expect(isCanvasMeshClass('TestShiftEffect')).toBe(false);
  });
});

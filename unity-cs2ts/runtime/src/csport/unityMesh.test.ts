// 執行期 new Mesh() 的資料面（Spine 的 MeshGenerator 寫網格的那組 API）
import { describe, expect, it } from 'vitest';
import { H, newExternal, staticCtx } from './core';
import { nativeGet, nativeSet } from './unityNative';
import {
  CanvasRenderer_Clear,
  CanvasRenderer_GetMaterial$,
  CanvasRenderer_GetMesh,
  CanvasRenderer_SetMaterial$Material_Texture,
  CanvasRenderer_SetMesh,
  Mesh_Clear$,
  Mesh_RecalculateNormals$,
  Mesh_SetTriangles$Int32_arr_int_int_int_bool_int,
} from './unityMesh';
import './unity';

const c = staticCtx;
const quad = () => [
  { x: 0, y: 0, z: 0 },
  { x: 2, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 2, y: 1, z: 0 },
];

describe('new Mesh()', () => {
  it('寫 vertices 頂點數跟著變、bounds 自動重算；uv 與 colors32 長度相同才寫', () => {
    const m = newExternal(c, 'Mesh') as Record<string, unknown>;
    nativeSet(c, m, 'Mesh', 'vertices', quad());
    expect(nativeGet(c, m, 'Mesh', 'vertexCount')).toBe(4);
    expect(nativeGet(c, m, 'Mesh', 'bounds')).toEqual({ center: { x: 1, y: 0.5, z: 0 }, extents: { x: 1, y: 0.5, z: 0 } });
    nativeSet(c, m, 'Mesh', 'uv', [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]);
    nativeSet(c, m, 'Mesh', 'colors32', [0, 1, 2, 3].map(() => ({ r: 255, g: 0, b: 51, a: 255, $color32: true })));
    const ch = (m as { channels: Record<string, { values: Float32Array }> }).channels;
    expect([...ch.uv0.values]).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
    expect([...ch.color.values.slice(0, 4)]).toEqual([1, 0, 0.20000000298023224, 1]);
    // 長度不對：Unity 記錯誤、不寫入
    nativeSet(c, m, 'Mesh', 'uv', [{ x: 9, y: 9 }]);
    expect([...ch.uv0.values]).toEqual([0, 0, 1, 0, 0, 1, 1, 1]);
  });

  it('subMeshCount 與 SetTriangles(陣列, 起點, 長度, 子網格, calculateBounds, baseVertex)', () => {
    const m = newExternal(c, 'Mesh') as Record<string, unknown>;
    nativeSet(c, m, 'Mesh', 'vertices', quad());
    nativeSet(c, m, 'Mesh', 'subMeshCount', 2);
    Mesh_SetTriangles$Int32_arr_int_int_int_bool_int(c, m, [9, 0, 2, 1, 2, 3, 1, 9], 1, 6, 1, false, 0);
    expect(nativeGet(c, m, 'Mesh', 'subMeshCount')).toBe(2);
    expect((m as { submeshes: number[][] }).submeshes).toEqual([[], [0, 2, 1, 2, 3, 1]]);
    expect(nativeGet(c, m, 'Mesh', 'triangles')).toEqual([0, 2, 1, 2, 3, 1]);
  });

  it('RecalculateNormals：xy 平面上逆時針的三角形法線朝 +z；Clear 清掉頂點與三角形', () => {
    const m = newExternal(c, 'Mesh') as Record<string, unknown>;
    nativeSet(c, m, 'Mesh', 'vertices', quad());
    nativeSet(c, m, 'Mesh', 'triangles', [0, 1, 2, 2, 1, 3]);
    Mesh_RecalculateNormals$(c, m);
    expect(nativeGet(c, m, 'Mesh', 'normals')).toEqual(quad().map(() => ({ x: 0, y: 0, z: 1 })));
    Mesh_Clear$(c, m);
    expect(nativeGet(c, m, 'Mesh', 'vertexCount')).toBe(0);
    expect(nativeGet(c, m, 'Mesh', 'triangles')).toEqual([]);
  });
});

describe('unityData（場景／資產的存檔值 → 產生類別的欄位）', () => {
  it('陣列與 List 寫成空值（YAML 的 null）時是空陣列；char 是字', async () => {
    const { unityData } = await import('./core');
    expect(unityData(staticCtx, '[$u8]', null)).toEqual([]);
    expect(unityData(staticCtx, '[$u8]', '1b1e')).toEqual([0x1b, 0x1e]);
    expect(unityData(staticCtx, '$c', 60)).toBe('<');
  });
});

describe('CanvasRenderer 的網格與材質', () => {
  it('SetMaterial(material, texture)：materialCount 至少 1、材質放第 0 格；GetMaterial() 讀第 0 格；Clear 只丟網格', () => {
    const h = new H({} as never, { type: 'CanvasRenderer' } as never, 'comp');
    const mat = { $type: 'Material' };
    const tex = { $type: 'Texture2D' };
    const mesh = newExternal(c, 'Mesh');
    expect(nativeGet(c, h, 'CanvasRenderer', 'materialCount')).toBe(0);
    CanvasRenderer_SetMaterial$Material_Texture(c, h, mat, tex);
    expect(nativeGet(c, h, 'CanvasRenderer', 'materialCount')).toBe(1);
    expect(CanvasRenderer_GetMaterial$(c, h)).toBe(mat);
    nativeSet(c, h, 'CanvasRenderer', 'materialCount', 3);
    CanvasRenderer_SetMaterial$Material_Texture(c, h, mat, tex);
    expect(nativeGet(c, h, 'CanvasRenderer', 'materialCount')).toBe(3);
    CanvasRenderer_SetMesh(c, h, mesh);
    expect(CanvasRenderer_GetMesh(c, h)).toBe(mesh);
    CanvasRenderer_Clear(c, h);
    expect(CanvasRenderer_GetMesh(c, h)).toBe(null);
    expect(CanvasRenderer_GetMaterial$(c, h)).toBe(mat);
  });
});

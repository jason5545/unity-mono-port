// SpriteRenderer 的 Sliced／Tiled 繪製模式（m_DrawMode 1、2）。
//
// 這是引擎原生程式碼，沒有 C# 原始碼可對照，照 Unity 手冊的 9-slicing 定義：網格大小 = m_Size（世界單位），
// 依 sprite 的 pivot 擺放；四角維持邊框大小（border 像素 ÷ pixelsPerUnit），四邊與中間拉伸。
// 未查證的細節：m_Size 比左右（上下）邊框加起來還小時，這裡照 uGUI 的 GetAdjustedBorders 等比縮小邊框；
// m_Size 是負的時鏡像（level0 的 BG 是 19.1 × −12.12）。
// Tiled 是中間與四邊重複鋪而不是拉伸。這裡先畫成 Sliced：中間與四邊在鋪的方向上均勻的圖兩者結果相同
// （level0 的 BG 用的 9-Sliced，10/5 檢查過像素：中間全是 255、四邊沿鋪的方向沒有變化）。

import { innerUV, outerUV, spritePadding, type SpriteForMesh } from '../ui/imageMesh';

export interface SlicedSprite extends SpriteForMesh {
  pivot: { x: number; y: number };
}

export interface SpriteMesh {
  positions: number[]; // x, y, z
  uvs: number[];
  indices: number[];
  /** 做不到的部分（例如有透明 padding 的 sprite），畫面照近似畫並記錄 */
  note?: string;
}

export function slicedSpriteMesh(sprite: SlicedSprite, size: { x: number; y: number }): SpriteMesh {
  const w = Math.abs(size.x);
  const h = Math.abs(size.y);
  const sx = size.x < 0 ? -1 : 1;
  const sy = size.y < 0 ? -1 : 1;
  const ppu = sprite.m_PixelsToUnits;
  const b = [sprite.m_Border.x / ppu, sprite.m_Border.y / ppu, sprite.m_Border.z / ppu, sprite.m_Border.w / ppu];
  for (let axis = 0; axis <= 1; axis++) {
    const total = b[axis] + b[axis + 2];
    const len = axis === 0 ? w : h;
    if (len < total && total !== 0) {
      b[axis] *= len / total;
      b[axis + 2] *= len / total;
    }
  }
  const x0 = -sprite.pivot.x * w;
  const y0 = -sprite.pivot.y * h;
  const xs = [x0, x0 + b[0], x0 + w - b[2], x0 + w];
  const ys = [y0, y0 + b[1], y0 + h - b[3], y0 + h];
  const outer = outerUV(sprite);
  const inner = innerUV(sprite);
  const us = [outer[0], inner[0], inner[2], outer[2]];
  const vs = [outer[1], inner[1], inner[3], outer[3]];
  const mesh: SpriteMesh = { positions: [], uvs: [], indices: [] };
  const flipWinding = sx * sy < 0;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const start = mesh.positions.length / 3;
      const quad = [
        [xs[i], ys[j], us[i], vs[j]],
        [xs[i], ys[j + 1], us[i], vs[j + 1]],
        [xs[i + 1], ys[j + 1], us[i + 1], vs[j + 1]],
        [xs[i + 1], ys[j], us[i + 1], vs[j]],
      ];
      for (const [x, y, u, v] of quad) {
        mesh.positions.push(x * sx, y * sy, 0);
        mesh.uvs.push(u, v);
      }
      mesh.indices.push(...(flipWinding ? [start, start + 2, start + 1, start + 2, start, start + 3] : [start, start + 1, start + 2, start + 2, start + 3, start]));
    }
  }
  const pad = spritePadding(sprite);
  if (pad.some((p) => p !== 0)) mesh.note = '有透明 padding 的 sprite（Sliced 沒處理 padding）';
  return mesh;
}

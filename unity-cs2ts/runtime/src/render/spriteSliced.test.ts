// spriteSliced.ts 的測試：level0 的 BG（9-Sliced，256 px、邊框 64、ppu 256、pivot 置中，m_Size 19.1 × −12.12）
import { describe, expect, it } from 'vitest';
import { slicedSpriteMesh, type SlicedSprite } from './spriteSliced';

const nineSliced: SlicedSprite = {
  m_Rect: { x: 0, y: 0, width: 256, height: 256 },
  m_Border: { x: 64, y: 64, z: 64, w: 64 },
  m_PixelsToUnits: 256,
  textureRect: { x: 0, y: 0, width: 256, height: 256 },
  textureRectOffset: { x: 0, y: 0 },
  textureWidth: 256,
  textureHeight: 256,
  pivot: { x: 0.5, y: 0.5 },
};

describe('SpriteRenderer 的 Sliced', () => {
  it('level0 BG：9 個四邊形、範圍 ±9.55 × ±6.06，邊框 64/256 = 0.25 單位，uv 內框 0.25–0.75', () => {
    const m = slicedSpriteMesh(nineSliced, { x: 19.1, y: -12.12 });
    expect(m.indices).toHaveLength(9 * 6);
    const xs = [...new Set(m.positions.filter((_, i) => i % 3 === 0).map((v) => +v.toFixed(4)))].sort((a, b) => a - b);
    const ys = [...new Set(m.positions.filter((_, i) => i % 3 === 1).map((v) => +v.toFixed(4)))].sort((a, b) => a - b);
    expect(xs).toEqual([-9.55, -9.3, 9.3, 9.55]);
    expect(ys).toEqual([-6.06, -5.81, 5.81, 6.06]);
    expect([...new Set(m.uvs)].sort()).toEqual([0, 0.25, 0.75, 1]);
    expect(m.note).toBeUndefined();
  });

  it('尺寸比左右邊框加起來還小：邊框等比縮（0.3 寬 → 每邊 0.15）', () => {
    const m = slicedSpriteMesh(nineSliced, { x: 0.3, y: 1 });
    const xs = [...new Set(m.positions.filter((_, i) => i % 3 === 0).map((v) => +v.toFixed(4)))].sort((a, b) => a - b);
    expect(xs).toEqual([-0.15, 0, 0.15]);
  });
});

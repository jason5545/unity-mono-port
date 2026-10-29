// lineMesh.ts 的測試：LineRenderer 網格（規格 4.1、R1 的數字，裁決 3）。
// 期望值照規格的公式直接算在測試裡，不從 lineMesh.ts 讀。
import { describe, expect, it } from 'vitest';
import { buildLineMesh, evalGradient, evalWidthCurve, localBoundsCenter, type LineStyle, type Vec3 } from './lineMesh';

const WIDTH = 0.06526453;

/** 單位矩陣加位移（column-major，同 THREE.Matrix4.elements） */
function worldOf(tx: number, ty: number, tz: number, sx = 1, sy = 1, sz = 1): number[] {
  return [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, tx, ty, tz, 1];
}

function styleOf(over: Partial<LineStyle> = {}): LineStyle {
  return {
    widthMultiplier: 1,
    widthKeys: [{ time: 0.07072695, value: WIDTH }],
    colorKeys: [
      { time: 0, r: 1, g: 1, b: 1 },
      { time: 1, r: 1, g: 1, b: 1 },
    ],
    alphaKeys: [
      { time: 0, a: 1 },
      { time: 1, a: 1 },
    ],
    gradientMode: 0,
    alignment: 0,
    textureMode: 1,
    textureScaleX: 1.5,
    numCornerVertices: 0,
    numCapVertices: 0,
    loop: false,
    useWorldSpace: false,
    ...over,
  };
}

const FORWARD: Vec3 = [0, 0, 1];

describe('LineRenderer 網格：R1 的數字（LinePrefab 在 SpawnRoot (0, 4, 0)，SetPosition (−2,0,0)、(2,1,0)）', () => {
  const r = buildLineMesh({ points: [[-2, 0, 0], [2, 1, 0]], world: worldOf(0, 4, 0), viewForward: FORWARD, style: styleOf() });

  it('畫出一段、四個頂點、兩個三角形', () => {
    expect(r.drawn).toBe(true);
    expect(r.segments).toBe(1);
    expect(r.positions.length / 3).toBe(4);
    expect(r.indices).toEqual([0, 1, 2, 2, 1, 3]);
    expect(r.skipped).toEqual([]);
  });

  it('側向量照規格公式：side ＝ normalize((dy, −dx, 0))，半寬 ＝ 寬度／2，本地座標（縮放 1）', () => {
    const d = [4, 1, 0];
    const len = Math.hypot(d[0], d[1]);
    const side = [d[1] / len, -d[0] / len, 0];
    const half = WIDTH / 2;
    const off = [side[0] * half, side[1] * half, 0];
    const p0 = [-2, 0, 0];
    const p1 = [2, 1, 0];
    const expect4 = [
      [p0[0] + off[0], p0[1] + off[1], 0],
      [p0[0] - off[0], p0[1] - off[1], 0],
      [p1[0] + off[0], p1[1] + off[1], 0],
      [p1[0] - off[0], p1[1] - off[1], 0],
    ];
    for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) expect(r.positions[i * 3 + k]).toBeCloseTo(expect4[i][k], 9);
  });

  it('Tile：u 是世界距離 × textureScale.x（0 與 √17 × 1.5），v 橫跨寬度（+side 那側 0、−side 那側 1）', () => {
    const uEnd = Math.sqrt(17) * 1.5;
    expect(r.uvs[0]).toBeCloseTo(0, 12);
    expect(r.uvs[2]).toBeCloseTo(0, 12);
    expect(r.uvs[4]).toBeCloseTo(uEnd, 9);
    expect(r.uvs[6]).toBeCloseTo(uEnd, 9);
    expect([r.uvs[1], r.uvs[3], r.uvs[5], r.uvs[7]]).toEqual([0, 1, 0, 1]);
  });

  it('白色漸層的頂點色是線性白（gammaToLinear(1) ＝ 1，alpha 1）', () => {
    for (let i = 0; i < 4; i++) expect(Array.from(r.colors.slice(i * 4, i * 4 + 4))).toEqual([1, 1, 1, 1]);
  });

  it('世界包圍盒含寬度，中心 ＝ 本地包圍盒中心 ＋ 位移（軸對齊）', () => {
    const c = localBoundsCenter(r.positions);
    expect(c).not.toBeNull();
    expect(r.worldMin).not.toBeNull();
    expect(r.worldMax).not.toBeNull();
    const wc = [0, 1, 2].map((k) => (r.worldMin![k] + r.worldMax![k]) / 2);
    expect(wc[0]).toBeCloseTo(c![0], 9);
    expect(wc[1]).toBeCloseTo(c![1] + 4, 9);
    expect(wc[2]).toBeCloseTo(c![2], 9);
  });
});

describe('寬度不吃縮放（裁決 3）：節點縮放 0.1 的父物件底下，端點縮 10 倍、寬度仍是 WIDTH', () => {
  const r = buildLineMesh({ points: [[-2, 0, 0], [2, 1, 0]], world: worldOf(0, 0, 0, 0.1, 0.1, 0.1), viewForward: FORWARD, style: styleOf() });

  it('世界中的端點是本地的 0.1 倍，世界半寬仍是 WIDTH／2', () => {
    // 世界端點：A ＝ (−0.2, 0, 0)、B ＝ (0.2, 0.1, 0)；世界的側向量在世界算
    const dWorld = [0.4, 0.1, 0];
    const len = Math.hypot(dWorld[0], dWorld[1]);
    const sideWorld = [dWorld[1] / len, -dWorld[0] / len, 0];
    const worldOff = [sideWorld[0] * (WIDTH / 2), sideWorld[1] * (WIDTH / 2), 0];
    // 本地偏移 ＝ 世界偏移 ÷ 縮放（0.1），shader 乘回 0.1 後就是世界偏移
    const localOff = worldOff.map((v) => v / 0.1);
    const A = [-2, 0, 0];
    expect(r.positions[0]).toBeCloseTo(A[0] + localOff[0], 9);
    expect(r.positions[1]).toBeCloseTo(A[1] + localOff[1], 9);
    // 回到世界後：0.1 × (本地頂點 − 本地端點) 的長度 ＝ 世界半寬
    const back = [r.positions[0] - A[0], r.positions[1] - A[1], r.positions[2] - A[2]].map((v) => v * 0.1);
    expect(Math.hypot(back[0], back[1], back[2])).toBeCloseTo(WIDTH / 2, 9);
  });
});

describe('旋轉與平移', () => {
  it('位移不改本地頂點，世界包圍盒跟著平移（8.75, 4.75, −15）', () => {
    const base = buildLineMesh({ points: [[-1, 0, 0], [1, 0, 0]], world: worldOf(0, 0, 0), viewForward: FORWARD, style: styleOf({ textureMode: 0 }) });
    const moved = buildLineMesh({ points: [[-1, 0, 0], [1, 0, 0]], world: worldOf(8.75, 4.75, -15), viewForward: FORWARD, style: styleOf({ textureMode: 0 }) });
    expect(Array.from(moved.positions)).toEqual(Array.from(base.positions));
    expect(moved.worldMin![0]).toBeCloseTo(base.worldMin![0] + 8.75, 9);
    expect(moved.worldMin![2]).toBeCloseTo(-15, 9);
  });

  it('節點矩陣有旋轉（繞 z 轉 90 度）時記 skipped「LineRenderer 有旋轉，寬度近似」', () => {
    // 繞 z 轉 90 度：x 軸 ＝ (0,1,0)、y 軸 ＝ (−1,0,0)
    const m = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const r = buildLineMesh({ points: [[-1, 0, 0], [1, 0, 0]], world: m, viewForward: FORWARD, style: styleOf() });
    expect(r.rotated).toBe(true);
    expect(r.skipped.some((s) => s.includes('有旋轉，寬度近似'))).toBe(true);
  });
});

describe('不畫與跳過的情況', () => {
  it('alignment 不是 View：整條不畫，記 skipped', () => {
    const r = buildLineMesh({ points: [[0, 0, 0], [1, 0, 0]], world: worldOf(0, 0, 0), viewForward: FORWARD, style: styleOf({ alignment: 1 }) });
    expect(r.drawn).toBe(false);
    expect(r.skipped.some((s) => s.includes('alignment'))).toBe(true);
  });

  it('textureMode 不是 Stretch 或 Tile：整條不畫，記 skipped', () => {
    const r = buildLineMesh({ points: [[0, 0, 0], [1, 0, 0]], world: worldOf(0, 0, 0), viewForward: FORWARD, style: styleOf({ textureMode: 2 }) });
    expect(r.drawn).toBe(false);
    expect(r.skipped.some((s) => s.includes('textureMode'))).toBe(true);
  });

  it('線段與視線平行（沿 z 走）：不畫，記 skipped', () => {
    const r = buildLineMesh({ points: [[0, 0, 0], [0, 0, 5]], world: worldOf(0, 0, 0), viewForward: FORWARD, style: styleOf() });
    expect(r.drawn).toBe(false);
    expect(r.skipped.some((s) => s.includes('平行'))).toBe(true);
  });

  it('點少於兩個：不畫', () => {
    const r = buildLineMesh({ points: [[0, 0, 0]], world: worldOf(0, 0, 0), viewForward: FORWARD, style: styleOf() });
    expect(r.drawn).toBe(false);
    expect(r.positions.length).toBe(0);
  });

  it('節點縮放為 0：不畫', () => {
    const r = buildLineMesh({ points: [[0, 0, 0], [1, 0, 0]], world: worldOf(0, 0, 0, 0, 1, 1), viewForward: FORWARD, style: styleOf() });
    expect(r.drawn).toBe(false);
    expect(r.skipped.some((s) => s.includes('縮放為 0'))).toBe(true);
  });

  it('多於兩點：每段各畫一片（段數 ＝ 點數 − 1），記 skipped（接頭未做）', () => {
    const r = buildLineMesh({ points: [[0, 0, 0], [1, 0, 0], [2, 1, 0]], world: worldOf(0, 0, 0), viewForward: FORWARD, style: styleOf() });
    expect(r.segments).toBe(2);
    expect(r.positions.length / 3).toBe(8);
    expect(r.indices.length).toBe(12);
    expect(r.skipped.some((s) => s.includes('接頭未做'))).toBe(true);
  });
});

describe('貼圖與顏色', () => {
  it('Stretch：u 是距離比例 × textureScale.x（端點 0 與 2）', () => {
    const r = buildLineMesh({ points: [[0, 0, 0], [2, 0, 0]], world: worldOf(0, 0, 0), viewForward: FORWARD, style: styleOf({ textureMode: 0, textureScaleX: 2 }) });
    expect(r.uvs[0]).toBeCloseTo(0, 12);
    expect(r.uvs[4]).toBeCloseTo(2, 12);
  });

  it('gradient 兩端：起點白、終點黑（線性轉線性：黑 ＝ 0，白 ＝ 1）', () => {
    const r = buildLineMesh({
      points: [[0, 0, 0], [2, 0, 0]],
      world: worldOf(0, 0, 0),
      viewForward: FORWARD,
      style: styleOf({
        colorKeys: [
          { time: 0, r: 1, g: 1, b: 1 },
          { time: 1, r: 0, g: 0, b: 0 },
        ],
      }),
    });
    expect(Array.from(r.colors.slice(0, 4))).toEqual([1, 1, 1, 1]);
    expect(Array.from(r.colors.slice(8, 12))).toEqual([0, 0, 0, 1]);
  });

  it('evalGradient：中點是兩端的線性內插（rgb 與 alpha 分開的 key）', () => {
    const g = evalGradient(
      [
        { time: 0, r: 1, g: 0, b: 0 },
        { time: 1, r: 0, g: 0, b: 1 },
      ],
      [
        { time: 0, a: 1 },
        { time: 1, a: 0 },
      ],
      0.5,
    );
    expect(g.r).toBeCloseTo(0.5, 12);
    expect(g.b).toBeCloseTo(0.5, 12);
    expect(g.a).toBeCloseTo(0.5, 12);
  });

  it('evalGradient 沒有 key：白色不透明', () => {
    expect(evalGradient([], [], 0.3)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });
});

describe('寬度曲線', () => {
  it('單一 key：任何 t 都是那個值', () => {
    expect(evalWidthCurve([{ time: 0.07, value: 0.5 }], 0)).toBe(0.5);
    expect(evalWidthCurve([{ time: 0.07, value: 0.5 }], 0.9)).toBe(0.5);
  });

  it('多個 key：線性內插，兩端夾住，並記 skipped（線性近似）', () => {
    const keys = [
      { time: 0, value: 1 },
      { time: 1, value: 3 },
    ];
    expect(evalWidthCurve(keys, 0.5)).toBeCloseTo(2, 12);
    expect(evalWidthCurve(keys, -1)).toBe(1);
    expect(evalWidthCurve(keys, 2)).toBe(3);
    const r = buildLineMesh({ points: [[0, 0, 0], [2, 0, 0]], world: worldOf(0, 0, 0), viewForward: FORWARD, style: styleOf({ widthKeys: keys }) });
    expect(r.skipped.some((s) => s.includes('線性近似'))).toBe(true);
  });
});

describe('useWorldSpace：點是世界座標（節點在 (1, 0, 0)）', () => {
  it('世界座標的點換成本地座標（減去位移）', () => {
    const r = buildLineMesh({ points: [[1, 0, 0], [3, 0, 0]], world: worldOf(1, 0, 0), viewForward: FORWARD, style: styleOf({ useWorldSpace: true, textureMode: 0 }) });
    expect(r.positions[0]).toBeCloseTo(0, 9);
    expect(r.positions[6]).toBeCloseTo(2, 9);
  });
});

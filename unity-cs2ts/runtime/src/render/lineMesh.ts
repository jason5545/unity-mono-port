// LineRenderer 的網格（純函式：只用陣列與數學，不碰 three.js、DOM）。
//
// 對應 C#：Unity 的 LineRenderer 是原生元件，reference/ 沒有它的原始碼。呼叫端在 C# 的位置：
//   reference/csharp/World/LineConnection.cs:23-33（SetColor 寫 startColor／endColor、SetMaterial）、
//   reference/csharp/World/MapView.cs:188-189（SetPosition）、reference/csharp/World/NewMap/MinimapManager.cs:86-89（小地圖的 SetPosition）。
// 網格的做法（規格 4.1，2026-10-10 裁決 3）：
//   - 網格建在節點的本地座標。m_UseWorldSpace 0 時 m_Positions 就是本地座標；1 時先換成本地座標。
//   - 側向量在世界座標算（寬度是世界單位，不吃 Transform 縮放）：side ＝ normalize(cross(d, f))，f 是攝影機往前的方向。
//     正交攝影機往 +z 看、線在 xy 平面上時，side ＝ normalize((dy, −dx, 0))（規格 4.1 的公式）。
//   - 世界的半寬（w／2）再除以節點世界矩陣的縮放（逐軸，用對角元素，帶正負號）換回本地；shader 乘回節點矩陣後寬度就是世界單位。
//   - 節點矩陣有旋轉時逐軸除法只是近似，呼叫端要記 skipped「LineRenderer 有旋轉，寬度近似」（這裡回傳 rotated 旗標）。
//   - 貼圖座標：Stretch 的 u ＝ 距離比例 × textureScale.x；Tile 的 u ＝ 世界距離 × textureScale.x（Tile 公式未查證，Jason 看畫面）。
//     v 橫跨寬度，+side 那一側是 0（哪一側是 0 未查證，點狀線上下對稱，看不出差別）。
//   - 頂點色：colorGradient 沿線的距離比例取值（線性內插，rgb 轉線性、alpha 不轉，照 SpriteRenderer.m_Color 的規則）。
// 刻意不做（回傳的 skipped 會寫原因）：
//   - 多點接頭（joins）：每段各畫一片，段與段之間沒有接頭。
//   - numCornerVertices、numCapVertices：沒有圓角與圓頭。
//   - 多於 1 個 key 的寬度曲線：線性近似（Unity 是切線插值）。
//   - m_Loop：當成不閉合。
//   - 漸層模式 m_Mode：一律照線性內插。m_Mode 1 依 Unity 2022.3 文件的列舉順序（Blend、Fixed、PerceptualBlend）推定是 Fixed。
//     LinePrefab 兩端同色，所以沒有差別；MiniLine 兩端不同色（(0.96, 0.50, 0.02) → (1, 0.62, 0)），若真的是 Fixed，線中間會有一道階梯，
//     這個差異留到第 2 輪小地圖上場時再決定；其他值記 skipped「未查證」。
//   - alignment ≠ 0（非 View）與 textureMode 不是 0／1：整條不畫。

import { gammaToLinear } from '../unity/color';

export type Vec3 = readonly [number, number, number];

/** 線的參數（從 m_Parameters 與 m_UseWorldSpace、m_Loop 整理出來的） */
export interface LineStyle {
  widthMultiplier: number;
  /** widthCurve.m_Curve 的 key（time 0 到 1、value） */
  widthKeys: readonly { time: number; value: number }[];
  /** gradient 的顏色 key：time ＝ ctime／65535，rgb 是 key 的 r g b（sRGB 值） */
  colorKeys: readonly { time: number; r: number; g: number; b: number }[];
  /** gradient 的 alpha key：time ＝ atime／65535，a 是 key 的 a */
  alphaKeys: readonly { time: number; a: number }[];
  gradientMode: number;
  alignment: number;
  textureMode: number;
  textureScaleX: number;
  numCornerVertices: number;
  numCapVertices: number;
  loop: boolean;
  useWorldSpace: boolean;
}

export interface LineBuildInput {
  /** m_Positions（m_UseWorldSpace 0 是本地座標，1 是世界座標） */
  points: readonly Vec3[];
  /** 節點的世界矩陣（THREE.Matrix4.elements，column-major：0–2 是 x 軸、4–6 是 y 軸、8–10 是 z 軸、12–14 是位移） */
  world: ArrayLike<number>;
  /** 攝影機往前的方向（世界座標；正交攝影機是 (0, 0, 1)） */
  viewForward: Vec3;
  style: LineStyle;
}

export interface LineBuildResult {
  /** 有畫出至少一段 */
  drawn: boolean;
  /** 本地座標，每頂點 3 個數字 */
  positions: number[];
  /** 每頂點 2 個數字（u、v） */
  uvs: number[];
  /** 每頂點 4 個數字（線性 rgba） */
  colors: number[];
  indices: number[];
  /** 世界包圍盒（含寬度） */
  worldMin: Vec3 | null;
  worldMax: Vec3 | null;
  /** 節點矩陣有旋轉（寬度是近似） */
  rotated: boolean;
  /** 實際畫出的段數 */
  segments: number;
  /** 不支援或近似的原因（呼叫端照記進繪製報告的 skipped） */
  skipped: string[];
}

const EPS = 1e-9;

/** 寬度曲線的值（單一 key 是常數；多個 key 線性內插，兩端夾住） */
export function evalWidthCurve(keys: readonly { time: number; value: number }[], t: number): number {
  if (keys.length === 0) return 1;
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  if (sorted.length === 1 || t <= sorted[0].time) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (t >= last.time) return last.value;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const k = span > EPS ? (t - a.time) / span : 0;
      return a.value + (b.value - a.value) * k;
    }
  }
  return last.value;
}

/** 漸層在 t 的 sRGB rgb 與 alpha（線性內插；rgb 之後由呼叫端轉線性）。沒有 key 時是白色不透明。 */
export function evalGradient(
  colorKeys: readonly { time: number; r: number; g: number; b: number }[],
  alphaKeys: readonly { time: number; a: number }[],
  t: number,
): { r: number; g: number; b: number; a: number } {
  const c = sampleKeys(
    colorKeys.map((k) => ({ time: k.time, v: [k.r, k.g, k.b] })),
    t,
    [1, 1, 1],
  );
  const a = sampleKeys(
    alphaKeys.map((k) => ({ time: k.time, v: [k.a] })),
    t,
    [1],
  );
  return { r: c[0], g: c[1], b: c[2], a: a[0] };
}

/** 依時間線性內插一組 key（沒有 key 時回傳 fallback） */
function sampleKeys(keys: readonly { time: number; v: readonly number[] }[], t: number, fallback: readonly number[]): number[] {
  if (keys.length === 0) return [...fallback];
  const sorted = [...keys].sort((x, y) => x.time - y.time);
  if (sorted.length === 1 || t <= sorted[0].time) return [...sorted[0].v];
  const last = sorted[sorted.length - 1];
  if (t >= last.time) return [...last.v];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (t >= a.time && t <= b.time) {
      const span = b.time - a.time;
      const k = span > EPS ? (t - a.time) / span : 0;
      return a.v.map((x, j) => x + (b.v[j] - x) * k);
    }
  }
  return [...last.v];
}

/**
 * 建 LineRenderer 的網格。回傳的頂點是節點本地座標；shader 乘上節點矩陣後就是畫面上的位置。
 * 逐段四個頂點（A+、A−、B+、B−），兩個三角形：(A+, A−, B+) 與 (B+, A−, B−)。
 */
export function buildLineMesh(input: LineBuildInput): LineBuildResult {
  const { points, world, viewForward, style } = input;
  const skipped: string[] = [];
  const empty: LineBuildResult = {
    drawn: false,
    positions: [],
    uvs: [],
    colors: [],
    indices: [],
    worldMin: null,
    worldMax: null,
    rotated: false,
    segments: 0,
    skipped,
  };
  if (style.alignment !== 0) {
    skipped.push(`LineRenderer alignment ${style.alignment}（只支援 View，整條不畫）`);
    return empty;
  }
  if (style.textureMode !== 0 && style.textureMode !== 1) {
    skipped.push(`LineRenderer textureMode ${style.textureMode}（只支援 Stretch、Tile，整條不畫）`);
    return empty;
  }
  if (style.numCornerVertices !== 0) skipped.push(`LineRenderer numCornerVertices ${style.numCornerVertices}（未做，沒有圓角）`);
  if (style.numCapVertices !== 0) skipped.push(`LineRenderer numCapVertices ${style.numCapVertices}（未做，沒有圓頭）`);
  if (style.loop) skipped.push('LineRenderer m_Loop（未做，當成不閉合）');
  if (style.widthKeys.length > 1) skipped.push(`LineRenderer 寬度曲線 ${style.widthKeys.length} 個 key（線性近似，Unity 是切線插值）`);
  if (style.gradientMode === 1) skipped.push('LineRenderer 漸層 m_Mode 1（依文件順序推定 Fixed，照線性內插；兩端同色時沒有差別）');
  else if (style.gradientMode !== 0) skipped.push(`LineRenderer 漸層 m_Mode ${style.gradientMode}（未查證，照線性內插）`);
  if (points.length > 2) skipped.push(`LineRenderer ${points.length} 個點（每段各畫一片，接頭未做）`);
  if (points.length < 2) return empty;

  // 節點矩陣：對角（帶正負號）與旋轉判定
  const m = world;
  const tx = m[12];
  const ty = m[13];
  const tz = m[14];
  const rotated = Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6 || Math.abs(m[4]) > 1e-6 || Math.abs(m[6]) > 1e-6 || Math.abs(m[8]) > 1e-6 || Math.abs(m[9]) > 1e-6;
  if (rotated) skipped.push('LineRenderer 有旋轉，寬度近似');
  // 逐軸縮放：沒有旋轉時是對角元素（帶正負號，負縮放要翻向）；有旋轉時對角元素不是縮放，改用三根軸的長度（近似）
  const diag: [number, number, number] = rotated
    ? [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])]
    : [m[0], m[5], m[10]];
  if (Math.abs(diag[0]) < EPS || Math.abs(diag[1]) < EPS) {
    skipped.push('LineRenderer 節點縮放為 0（不畫）');
    return { ...empty, rotated };
  }
  if (Math.abs(diag[2]) < EPS) diag[2] = 1; // z 縮放為 0 時 z 的偏移恆為 0，這裡只避免除以 0

  const toWorld = (p: Vec3): [number, number, number] => [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + tx,
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + ty,
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + tz,
  ];
  const toLocal = (p: Vec3): [number, number, number] => [(p[0] - tx) / diag[0], (p[1] - ty) / diag[1], (p[2] - tz) / diag[2]];

  // 世界座標的點與本地座標的點
  const W: [number, number, number][] = points.map((p) => (style.useWorldSpace ? [p[0], p[1], p[2]] : toWorld(p)));
  const P: [number, number, number][] = points.map((p) => (style.useWorldSpace ? toLocal(p) : [p[0], p[1], p[2]]));

  // 沿線的世界距離
  const D: number[] = [0];
  for (let i = 0; i + 1 < W.length; i++) D.push(D[i] + dist(W[i], W[i + 1]));
  const total = D[D.length - 1];
  if (total < EPS) {
    skipped.push('LineRenderer 兩端重合（不畫）');
    return { ...empty, rotated };
  }

  const f = normalize(viewForward) ?? [0, 0, 1];
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let worldMin: Vec3 | null = null;
  let worldMax: Vec3 | null = null;
  let segments = 0;
  let parallel = 0;
  const widthAt = (frac: number) => style.widthMultiplier * evalWidthCurve(style.widthKeys, frac);
  const colorAt = (frac: number): number[] => {
    const g = evalGradient(style.colorKeys, style.alphaKeys, frac);
    return [gammaToLinear(g.r), gammaToLinear(g.g), gammaToLinear(g.b), g.a];
  };
  const uOf = (frac: number, dist: number) => (style.textureMode === 0 ? frac : dist) * style.textureScaleX;

  for (let i = 0; i + 1 < W.length; i++) {
    const a = W[i];
    const b = W[i + 1];
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    if (dist(a, b) < EPS) continue;
    const c = cross(d, f);
    const cl = Math.hypot(c[0], c[1], c[2]);
    if (cl < EPS) {
      parallel++;
      continue;
    }
    const side: Vec3 = [c[0] / cl, c[1] / cl, c[2] / cl];
    const fracA = D[i] / total;
    const fracB = D[i + 1] / total;
    const wA = widthAt(fracA) / 2;
    const wB = widthAt(fracB) / 2;
    // 世界的半寬偏移，再除以對角縮放換回本地
    const oA: Vec3 = [side[0] * wA, side[1] * wA, side[2] * wA];
    const oB: Vec3 = [side[0] * wB, side[1] * wB, side[2] * wB];
    const oAL: Vec3 = [oA[0] / diag[0], oA[1] / diag[1], oA[2] / diag[2]];
    const oBL: Vec3 = [oB[0] / diag[0], oB[1] / diag[1], oB[2] / diag[2]];
    const base = positions.length / 3;
    const pushVertex = (pl: [number, number, number], off: Vec3, sign: number, u: number, v: number, col: number[]) => {
      positions.push(pl[0] + sign * off[0], pl[1] + sign * off[1], pl[2] + sign * off[2]);
      uvs.push(u, v);
      colors.push(col[0], col[1], col[2], col[3]);
    };
    const colA = colorAt(fracA);
    const colB = colorAt(fracB);
    const uA = uOf(fracA, D[i]);
    const uB = uOf(fracB, D[i + 1]);
    pushVertex(P[i], oAL, 1, uA, 0, colA);
    pushVertex(P[i], oAL, -1, uA, 1, colA);
    pushVertex(P[i + 1], oBL, 1, uB, 0, colB);
    pushVertex(P[i + 1], oBL, -1, uB, 1, colB);
    indices.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    // 世界包圍盒（含寬度）
    for (const [w, o] of [
      [a, oA],
      [b, oB],
    ] as const) {
      for (const sg of [1, -1]) {
        const p: Vec3 = [w[0] + sg * o[0], w[1] + sg * o[1], w[2] + sg * o[2]];
        worldMin = minVec(worldMin, p);
        worldMax = maxVec(worldMax, p);
      }
    }
    segments++;
  }
  if (parallel > 0) skipped.push(`LineRenderer ${parallel} 段與視線平行（不畫）`);
  if (segments === 0) return { ...empty, rotated, skipped };
  return { drawn: true, positions, uvs, colors, indices, worldMin, worldMax, rotated, segments, skipped };
}

/** 本地座標頂點的包圍盒中心（depth 用：世界包圍盒中心 ＝ 節點矩陣 × 這個中心，在軸對齊時精確） */
export function localBoundsCenter(positions: ArrayLike<number>): Vec3 | null {
  const n = Math.floor(positions.length / 3);
  if (n === 0) return null;
  let min: Vec3 = [positions[0], positions[1], positions[2]];
  let max: Vec3 = [positions[0], positions[1], positions[2]];
  for (let i = 1; i < n; i++) {
    const p: Vec3 = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    min = minVec(min, p)!;
    max = maxVec(max, p)!;
  }
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function cross(a: Vec3, b: readonly number[]): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: readonly number[]): Vec3 | null {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < EPS) return null;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function minVec(a: Vec3 | null, b: Vec3): Vec3 {
  if (!a) return b;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}

function maxVec(a: Vec3 | null, b: Vec3): Vec3 {
  if (!a) return b;
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}

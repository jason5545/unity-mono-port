// 粒子系統的 MinMaxCurve／MinMaxGradient 求值與每顆粒子的穩定亂數（2026/10/17，MT2 的粒子）。
//
// 序列化形式（UnityCsReference 2022.3 Modules/ParticleSystemEditor/SerializedMinMaxCurve.cs、SerializedMinMaxGradient.cs）：
//   MinMaxCurve：minMaxState（0 常數、1 曲線、2 兩曲線之間、3 兩常數之間）、scalar（常數，曲線模式是倍率）、minScalar、maxCurve、minCurve。
//   MinMaxGradient：minMaxState（0 顏色、1 漸層、2 兩顏色之間、3 兩漸層之間、4 隨機顏色＝在 maxGradient 上隨機取一點）、
//     maxColor、minColor、maxGradient、minGradient。
// 曲線的時間軸是 0～1（粒子的年齡比例或系統時間比例，看模組）。「兩者之間」的隨機值每顆粒子固定（Unity 文件 MinMaxCurve：
// 每顆粒子用自己的亂數，整個生命期不變），這裡用粒子的 seed 加上模組編號雜湊出來；Unity 原生的亂數序列看不到，數值不會一樣。

import { evaluate, type Keyframe } from '../engine/curves';

export interface SerializedCurve {
  m_Curve: Keyframe[];
}
export interface MinMaxCurveData {
  minMaxState?: number;
  scalar?: number;
  minScalar?: number;
  maxCurve?: SerializedCurve | null;
  minCurve?: SerializedCurve | null;
}
export interface ColorData {
  r: number;
  g: number;
  b: number;
  a: number;
}
export type GradientData = Record<string, unknown> & { m_Mode?: number; m_NumColorKeys?: number; m_NumAlphaKeys?: number };
export interface MinMaxGradientData {
  minMaxState?: number;
  maxColor?: ColorData;
  minColor?: ColorData;
  maxGradient?: GradientData | null;
  minGradient?: GradientData | null;
}

function curveAt(c: SerializedCurve | null | undefined, t: number): number {
  const keys = c?.m_Curve;
  return keys && keys.length ? evaluate(keys, t) : 0;
}

/** MinMaxCurve 在 t（0～1）的值；r 是這顆粒子在這個模組的亂數（0～1） */
export function evalCurve(c: MinMaxCurveData | null | undefined, t: number, r: number): number {
  if (!c) return 0;
  const s = c.scalar ?? 0;
  switch (c.minMaxState ?? 0) {
    case 1:
      return s * curveAt(c.maxCurve, t);
    case 2: {
      const a = curveAt(c.minCurve, t);
      const b = curveAt(c.maxCurve, t);
      return s * (a + (b - a) * r);
    }
    case 3: {
      const lo = c.minScalar ?? 0;
      return lo + (s - lo) * r;
    }
    default:
      return s;
  }
}

/** 曲線模式（1、2）時曲線的最大值乘倍率：用來估生命期的上限（maxLifetime） */
export function curveMax(c: MinMaxCurveData | null | undefined): number {
  if (!c) return 0;
  const s = c.scalar ?? 0;
  const top = (k: SerializedCurve | null | undefined): number => (k?.m_Curve?.length ? Math.max(...k.m_Curve.map((x) => x.value)) : 0);
  switch (c.minMaxState ?? 0) {
    case 1:
      return s * top(c.maxCurve);
    case 2:
      return s * Math.max(top(c.minCurve), top(c.maxCurve));
    case 3:
      return Math.max(s, c.minScalar ?? 0);
    default:
      return s;
  }
}

// 欄位名稱先建好：`key${i}` 每次都組一個新字串，查屬性前還要先雜湊，粒子每顆每趟都要算（MT2 戰鬥手機上佔 2%，10/18）
const KEY_NAMES = Array.from({ length: 8 }, (_, i) => `key${i}`);
const CTIME_NAMES = Array.from({ length: 8 }, (_, i) => `ctime${i}`);
const ATIME_NAMES = Array.from({ length: 8 }, (_, i) => `atime${i}`);
const gradKey = (g: GradientData, i: number): ColorData => g[KEY_NAMES[i] ?? `key${i}`] as ColorData;
const gradCTime = (g: GradientData, i: number): number => ((g[CTIME_NAMES[i] ?? `ctime${i}`] as number) ?? 0) / 65535;
const gradATime = (g: GradientData, i: number): number => ((g[ATIME_NAMES[i] ?? `atime${i}`] as number) ?? 0) / 65535;

/** Gradient 在 t 的顏色（照 unityMath 的 Gradient_Evaluate：m_Mode 1 是 Fixed，不內插），寫進 out，不配置新物件 */
export function evalGradient(g: GradientData | null | undefined, t: number, out: Float32Array, o = 0): void {
  if (!g) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 1;
    return;
  }
  const fixed = g.m_Mode === 1;
  const nc = Math.max(1, g.m_NumColorKeys ?? 2);
  const na = Math.max(1, g.m_NumAlphaKeys ?? 2);
  // 顏色
  if (t <= gradCTime(g, 0)) {
    const k = gradKey(g, 0);
    out[o] = k.r;
    out[o + 1] = k.g;
    out[o + 2] = k.b;
  } else {
    let done = false;
    for (let i = 1; i < nc; i++) {
      const t1 = gradCTime(g, i);
      if (t <= t1) {
        const a = gradKey(g, i - 1);
        const b = gradKey(g, i);
        const t0 = gradCTime(g, i - 1);
        const u = fixed ? 1 : (t - t0) / (t1 - t0 || 1);
        out[o] = a.r + (b.r - a.r) * u;
        out[o + 1] = a.g + (b.g - a.g) * u;
        out[o + 2] = a.b + (b.b - a.b) * u;
        done = true;
        break;
      }
    }
    if (!done) {
      const k = gradKey(g, nc - 1);
      out[o] = k.r;
      out[o + 1] = k.g;
      out[o + 2] = k.b;
    }
  }
  // 透明度
  if (t <= gradATime(g, 0)) out[o + 3] = gradKey(g, 0).a;
  else {
    let done = false;
    for (let i = 1; i < na; i++) {
      const t1 = gradATime(g, i);
      if (t <= t1) {
        const a = gradKey(g, i - 1).a;
        const b = gradKey(g, i).a;
        const t0 = gradATime(g, i - 1);
        const u = fixed ? 1 : (t - t0) / (t1 - t0 || 1);
        out[o + 3] = a + (b - a) * u;
        done = true;
        break;
      }
    }
    if (!done) out[o + 3] = gradKey(g, na - 1).a;
  }
}

const tmpA = new Float32Array(4);
const tmpB = new Float32Array(4);

/** MinMaxGradient 在 t 的顏色（r 是粒子在這個模組的亂數），寫進 out[o..o+3] */
export function evalMinMaxGradient(g: MinMaxGradientData | null | undefined, t: number, r: number, out: Float32Array, o = 0): void {
  if (!g) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 1;
    return;
  }
  switch (g.minMaxState ?? 0) {
    case 1:
      evalGradient(g.maxGradient, t, out, o);
      return;
    case 2: {
      const a = g.minColor;
      const b = g.maxColor;
      if (!a || !b) return putColor(b ?? a, out, o);
      out[o] = a.r + (b.r - a.r) * r;
      out[o + 1] = a.g + (b.g - a.g) * r;
      out[o + 2] = a.b + (b.b - a.b) * r;
      out[o + 3] = a.a + (b.a - a.a) * r;
      return;
    }
    case 3:
      evalGradient(g.minGradient, t, tmpA);
      evalGradient(g.maxGradient, t, tmpB);
      for (let k = 0; k < 4; k++) out[o + k] = tmpA[k] + (tmpB[k] - tmpA[k]) * r;
      return;
    case 4:
      evalGradient(g.maxGradient, r, out, o);
      return;
    default:
      putColor(g.maxColor, out, o);
  }
}

/** evalMinMaxGradient 的單色（以前是每次呼叫配一個 closure） */
function putColor(c: ColorData | undefined, out: Float32Array, o: number): void {
  out[o] = c?.r ?? 1;
  out[o + 1] = c?.g ?? 1;
  out[o + 2] = c?.b ?? 1;
  out[o + 3] = c?.a ?? 1;
}

/** 32 位元雜湊（粒子 seed × 模組編號 → 0～1 的亂數，同一顆粒子同一個模組永遠同一個值） */
export function hash01(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** 系統層級的亂數（發射時的位置、方向、burst 機率…）：xorshift32，種子由 randomSeed 或 autoRandomSeed 決定 */
export class ParticleRandom {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x6d2b79f5;
  }
  reseed(seed: number): void {
    this.s = seed >>> 0 || 0x6d2b79f5;
  }
  /** [0, 1) */
  next(): number {
    let x = this.s;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 4294967296;
  }
  uint(): number {
    this.next();
    return this.s;
  }
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}

/** 模組各自的亂數通道（hash01 的 salt）。同一顆粒子不同模組的「兩者之間」要用不同的亂數 */
export const SALT = {
  lifetime: 1,
  speed: 2,
  size: 3,
  sizeY: 4,
  sizeZ: 5,
  rotation: 6,
  rotationY: 7,
  rotationZ: 8,
  color: 9,
  gravity: 10,
  velocityX: 11,
  velocityY: 12,
  velocityZ: 13,
  orbital: 14,
  radial: 15,
  speedModifier: 16,
  forceX: 17,
  forceY: 18,
  forceZ: 19,
  limit: 20,
  drag: 21,
  colorOverLifetime: 22,
  sizeOverLifetime: 23,
  rotationOverLifetime: 24,
  noise: 25,
  frameOverTime: 26,
  startFrame: 27,
  row: 28,
  trailLifetime: 29,
  trailWidth: 30,
  trailColor: 31,
  custom: 32,
  flip: 40,
  inherit: 41,
  burstProbability: 42,
} as const;

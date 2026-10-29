// AnimationCurve 的取樣（引擎原生，照 Unity 的定義）：兩個關鍵格之間是 cubic Hermite，切線 = outSlope／inSlope × 間隔；
// 任一邊的切線是無限大就是階梯（維持前一格的值）。關鍵格範圍以外夾住（clip 的曲線前後延伸都是 2，10/5 普查 121 條全部一樣）。
// 加權切線（weightedMode ≠ 0）專案裡沒有（10/5 普查 0 個），遇到照不加權算並記錄。
// PPtr 曲線（換 sprite 等）是離散的：取時間不超過 t 的最後一格。

export interface Keyframe<T = number> {
  time: number;
  value: T;
  inSlope: T | string;
  outSlope: T | string;
  weightedMode?: number;
}

export interface PPtrKey<R> {
  time: number;
  value: R;
}

/** JSON 把 ±Infinity 存成字串 */
export function num(v: number | string): number {
  if (typeof v === 'number') return v;
  if (v === 'Infinity') return Infinity;
  if (v === '-Infinity') return -Infinity;
  return Number(v);
}

export let weightedSeen = 0;

function hermite(t0: number, v0: number, m0: number, t1: number, v1: number, m1: number, time: number): number {
  const dx = t1 - t0;
  if (!Number.isFinite(m0) || !Number.isFinite(m1)) return v0;
  if (dx <= 0) return v0;
  const t = (time - t0) / dx;
  const t2 = t * t;
  const t3 = t2 * t;
  const a = 2 * t3 - 3 * t2 + 1;
  const b = t3 - 2 * t2 + t;
  const c = t3 - t2;
  const d = -2 * t3 + 3 * t2;
  return a * v0 + b * (m0 * dx) + c * (m1 * dx) + d * v1;
}

/** 純量曲線 */
export function evaluate(keys: Keyframe<number>[], time: number): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (n === 1 || time <= keys[0].time) return keys[0].value;
  if (time >= keys[n - 1].time) return keys[n - 1].value;
  let i = 0;
  while (i < n - 2 && keys[i + 1].time <= time) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  if (k0.weightedMode || k1.weightedMode) weightedSeen++;
  return hermite(k0.time, k0.value, num(k0.outSlope as number | string), k1.time, k1.value, num(k1.inSlope as number | string), time);
}

type V3 = { x: number; y: number; z: number };
type V4 = V3 & { w: number };

/** 向量曲線（位置、尤拉角、縮放、四元數）：每個分量各自取樣 */
export function evaluateVector<T extends V3 | V4>(keys: Keyframe<T>[], time: number, comps: (keyof T)[]): T {
  const out = {} as T;
  for (const c of comps) {
    const scalar = keys.map((k) => ({
      time: k.time,
      value: k.value[c] as unknown as number,
      inSlope: (k.inSlope as T)[c] as unknown as number | string,
      outSlope: (k.outSlope as T)[c] as unknown as number | string,
      weightedMode: k.weightedMode,
    }));
    (out as Record<keyof T, number>)[c] = evaluate(scalar, time);
  }
  return out;
}

export function samplePPtr<R>(keys: PPtrKey<R>[], time: number): R | undefined {
  if (keys.length === 0) return undefined;
  let v = keys[0].value;
  for (const k of keys) {
    if (k.time <= time) v = k.value;
    else break;
  }
  return v;
}

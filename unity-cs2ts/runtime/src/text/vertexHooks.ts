// TMP「網格產生後改頂點」的掛勾（第 2 輪，裁決 3：版本變了就整個重產）。
//
// 對應的 C#：
//   WarpTextExample（reference/csharp/TextMesh_Pro/Examples___Extras/Scripts/WarpTextExample.cs:37-87）：彎字。
//   DOTweenTMPAnimator.UpdateAlpha（reference/decompiled/Assembly-CSharp-firstpass/DG.Tweening/DOTweenTMPAnimator.cs:121-134）：每字 alpha。
//   TMP_Text.bounds → GetCompoundBounds（reference/tmp-src/pre.4/package/Scripts/Runtime/TMPro_Private.cs:4631-4650）：彎字用的 x 範圍。
//   AnimationCurve.Evaluate（Unity 內建，原始碼看不到）：曲線用 Hermite（非 weighted，weightedMode 0），WrapMode.Once（WarpTextExample.cs:39-40 在協程開始時設定）。
//
// 純函式：只改 TextMeshResult 的頂點與頂點色；textInfo 不動（C# 的 WarpText 也只改 meshInfo.vertices，characterInfo 不變）。
// 頂點索引：TmpCharacterInfo.vertexIndex 以頂點計（index×4，textObject.ts:3631）；positions 是 xyz 三個 float、colors 是 rgba 四個 byte，
// 所以第 v 個頂點的位置在 positions[v×3]、顏色在 colors[v×4]。
//
// 刻意不做：WrapMode 的 PingPong／Loop（WarpText 執行時一律是 Once）、weighted 曲線（遊戲的 VertexCurve 都是 weightedMode 0）、
// AngleMultiplier／SpeedMultiplier（WarpText 的程式碼沒有讀它們）、協程的每 0.025 秒重做（結果固定，每次產生網格後套一次就夠，見檔頭的理由）。

import type { TextMeshResult, TmpCharacterInfo } from './types';

/** 掛勾的介面。version 變了，繪製端的重產偵測（refreshKeyOf）就會讓這個元件整個重產 */
export interface TmpVertexHook {
  readonly version: string;
  /** 在 TMP 排版之後、建網格之前呼叫；只准改 result.subMeshes 的 positions 與 colors */
  apply(result: TextMeshResult): void;
}

/** AnimationCurve 的一個 key（序列化的 m_Curve 項目；只留計算用到的欄位） */
export interface CurveKey {
  time: number;
  value: number;
  inSlope: number;
  outSlope: number;
}

/**
 * AnimationCurve.Evaluate，WrapMode.Once（夾在第一個與最後一個 key 的值）。
 * 段內是 Hermite：m0 ＝ 左 key 的 outSlope × 段長、m1 ＝ 右 key 的 inSlope × 段長。
 */
export function evaluateCurveOnce(keys: readonly CurveKey[], t: number): number {
  if (keys.length === 0) return 0;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first.time) return first.value;
  if (t >= last.time) return last.value;
  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1].time) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const dt = k1.time - k0.time;
  if (dt === 0) return k1.value;
  const s = (t - k0.time) / dt;
  const m0 = k0.outSlope * dt;
  const m1 = k1.inSlope * dt;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * k0.value + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * k1.value + (s3 - s2) * m1;
}

/** 這個子網格（materialReferenceIndex）的 positions／colors */
function subMeshOf(result: TextMeshResult, materialIndex: number) {
  return result.subMeshes.find((s) => s.materialIndex === materialIndex) ?? null;
}

/**
 * 彎字（WarpTextExample.WarpText，WarpTextExample.cs:37-87）。
 * x、x2 ＝ TMP_Text.bounds 的 min.x、max.x（TMPro_Private.cs:4631-4650：主網格 AABB，再併入 subTextObjects 的 x、y 範圍）。
 * 每個可見字（WarpTextExample.cs:55-81）：把四個頂點減去「字的中點（x＝左右頂點中點，y＝baseLine）」，
 * 依中點的相對位置 num 取曲線值 y（與 num+0.0001 的 y2）決定位移與旋轉角，繞原點旋轉後再加回中點。
 */
export function applyWarp(result: TextMeshResult, keys: readonly CurveKey[], curveScale: number): void {
  // 每個字用的是「自己的」子網格（WarpTextExample.cs:58-59：textInfo.meshInfo[materialReferenceIndex]），不是子網格 0。
  // 標題的字在 materialIndex 1，子網格 0 是空的（headless 探針：quests／powers／journal 都是這樣）。
  // 舊版在這裡「子網格 0 沒有頂點就 return」，所以標題一個字都沒彎（第 2 輪 W5 的 maxDiff=0）。
  // WarpTextExample.cs:51-52（m_TextComponent.bounds，TMPro_Private.cs:4631-4650 的 GetCompoundBounds）：
  // 主網格（子網格 0）與子物件（materialIndex ≥ 1）併成一個 AABB，空的略過。
  let minX = Infinity;
  let maxX = -Infinity;
  const grow = (p: Float32Array) => {
    for (let i = 0; i + 2 < p.length; i += 3) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
    }
  };
  for (const s of result.subMeshes) if (s.materialIndex === 0 || (s.materialIndex >= 1 && s.indices.length > 0)) grow(s.positions);
  const x = minX;
  const x2 = maxX;
  // 沒有任何頂點（空字串）→ 不畫。x2 − x 是 0（只有一個字寬度的文字）時 C# 的 num 會是 NaN，這裡也不畫，免得頂點變成 NaN
  if (!(x2 - x > 0)) return;
  const chars: TmpCharacterInfo[] = result.textInfo.characterInfo;
  for (let i = 0; i < result.textInfo.characterCount && i < chars.length; i++) {
    const ch = chars[i];
    if (!ch.isVisible) continue; // WarpTextExample.cs:55
    const sub = subMeshOf(result, ch.materialReferenceIndex);
    if (!sub) continue;
    const P = sub.positions;
    const vi = ch.vertexIndex;
    if ((vi + 3) * 3 + 2 >= P.length) continue;
    // WarpTextExample.cs:60：vector ＝ ((v[vi].x + v[vi+2].x) / 2, baseLine)（z 是 0）
    const vx = (P[vi * 3] + P[(vi + 2) * 3]) / 2;
    const vy = ch.baseLine;
    // WarpTextExample.cs:61-64：四個頂點減掉 vector
    for (let k = 0; k < 4; k++) {
      P[(vi + k) * 3] -= vx;
      P[(vi + k) * 3 + 1] -= vy;
    }
    // WarpTextExample.cs:65-68：num、num2、曲線值（乘 CurveScale）
    const span = x2 - x;
    const num = (vx - x) / span;
    const num2 = num + 0.0001;
    const y = evaluateCurveOnce(keys, num) * curveScale;
    const y2 = evaluateCurveOnce(keys, num2) * curveScale;
    // WarpTextExample.cs:69-72：rhs ＝ (num2×(x2−x)+x, y2) − (vector.x, y)，lhs ＝ (1,0,0)；角度 ＝ acos(dot)×57.29578，cross.z＞0 時取它、否則 360 − 它
    const rx = num2 * span + x - vx;
    const ry = y2 - y;
    const len = Math.hypot(rx, ry);
    const nx = len > 0 ? rx / len : 0; // Vector3.normalized：長度 0 時是零向量
    const ny = len > 0 ? ry / len : 0;
    const dot = Math.min(1, Math.max(-1, nx));
    const deg = Math.acos(dot) * 57.29578;
    const angle = ny > 0 ? deg : 360 - deg; // Vector3.Cross(lhs, rhs).z ＝ rhs.y（lhs＝(1,0,0)）
    // WarpTextExample.cs:73-77：TRS(translate(0,y,0), Euler(0,0,angle))，MultiplyPoint3x4 逐頂點套用
    const rad = (angle * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    for (let k = 0; k < 4; k++) {
      const px = P[(vi + k) * 3];
      const py = P[(vi + k) * 3 + 1];
      P[(vi + k) * 3] = c * px - s * py;
      P[(vi + k) * 3 + 1] = s * px + c * py + y;
    }
    // WarpTextExample.cs:78-81：加回 vector
    for (let k = 0; k < 4; k++) {
      P[(vi + k) * 3] += vx;
      P[(vi + k) * 3 + 1] += vy;
    }
  }
}

/** 彎字掛勾：curve 是序列化的 VertexCurve（m_Curve），curveScale 是 CurveScale（WarpTextExample 的欄位） */
export function warpHook(keys: readonly CurveKey[], curveScale: number): TmpVertexHook {
  return {
    version: `warp:${curveScale}:${keys.map((k) => `${k.time},${k.value},${k.inSlope},${k.outSlope}`).join(';')}`,
    apply: (result) => applyWarp(result, keys, curveScale),
  };
}

/**
 * 每字 alpha（DOTweenTMPAnimator 的 UpdateAlpha，:121-134）。
 * 狀態在這個物件裡：DOFadeChar 的 setter 呼叫 set；值沒變就不動版本號（Sequence 每格會重複 seek 同一個值，不能每格都重產）。
 * 寫入：byte＝(byte)(a × 255)（C# 的強制轉型是截斷，不是四捨五入）；只寫這個字的四個頂點的 alpha。
 */
export class CharAlphaHook implements TmpVertexHook {
  private readonly alphas = new Map<number, number>();
  private generation = 0;

  get version(): string {
    return `alpha:${this.generation}`;
  }

  /** 設定第 index 個字的 alpha（0 到 1；超出範圍夾住）。值沒變回傳 false */
  set(index: number, alpha: number): boolean {
    const a = Math.min(1, Math.max(0, alpha));
    if (this.alphas.get(index) === a) return false;
    this.alphas.set(index, a);
    this.generation++;
    return true;
  }

  /** 讀回第 index 個字的 alpha（還沒設過回 undefined） */
  get(index: number): number | undefined {
    return this.alphas.get(index);
  }

  apply(result: TextMeshResult): void {
    const chars: TmpCharacterInfo[] = result.textInfo.characterInfo;
    for (const [index, alpha] of this.alphas) {
      const ch = chars[index];
      if (!ch || !ch.isVisible) continue; // ValidateChar（:300-323）：不可見的字不設
      const sub = subMeshOf(result, ch.materialReferenceIndex);
      if (!sub) continue;
      const byte = Math.min(255, Math.max(0, Math.trunc(alpha * 255)));
      for (let k = 0; k < 4; k++) sub.colors[(ch.vertexIndex + k) * 4 + 3] = byte;
    }
  }
}

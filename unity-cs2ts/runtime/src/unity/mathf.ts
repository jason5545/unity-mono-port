// UnityEngine.Mathf 的浮點函式（JS 只有 float64，一律先運算再 Math.fround 回到 float32，
// 才跟原版 C# 的 float 逐欄位對得上）。對應 reference/decompiled/UnityEngine.CoreModule/UnityEngine/Mathf.cs。

/** Mathf.Pow（Mathf.cs:218-221）：(float)Math.Pow(f, p) */
export function mathfPow(f: number, p: number): number {
  return Math.fround(Math.pow(Math.fround(f), Math.fround(p)));
}

/**
 * Mathf.SmoothDamp（Mathf.cs:397-417）：速度在 C# 是 ref 傳回，這裡回傳 { value, velocity }。
 * maxSpeed 預設 Mathf.Infinity、deltaTime 呼叫端傳 Time.unscaledDeltaTime。
 */
export function mathfSmoothDamp(
  current: number,
  target: number,
  currentVelocity: number,
  smoothTime: number,
  maxSpeed: number,
  deltaTime: number,
): { value: number; velocity: number } {
  const f = Math.fround;
  smoothTime = f(Math.max(f(0.0001), Math.fround(smoothTime)));
  const num = f(f(2) / smoothTime);
  const num2 = f(num * Math.fround(deltaTime));
  const num3 = f(f(1) / f(f(f(1) + num2) + f(f(f(0.48) * num2) * num2) + f(f(f(0.235) * num2) * num2) * num2));
  const max = target; // num4（原始 target）
  let value = f(current - target);
  const num5 = f(Math.fround(maxSpeed) * smoothTime);
  value = f(Math.min(Math.max(value, f(0) - num5), num5));
  target = f(current - value);
  const num6 = f((Math.fround(currentVelocity) + num * value) * Math.fround(deltaTime));
  const velocity = f((Math.fround(currentVelocity) - num * num6) * num3);
  let result = f(target + f((value + num6) * num3));
  if (f(max - current) > 0 === result > max) {
    result = max;
    return { value: result, velocity: f((result - max) / Math.fround(deltaTime)) };
  }
  return { value: result, velocity };
}

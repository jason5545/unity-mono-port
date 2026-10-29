// Mathf 移植（unity/mathf.ts）的測試。期望值逐條對照反編譯 UnityEngine.CoreModule/UnityEngine/Mathf.cs（10/6 讀），
// 並用 float32 手算（Claude Code 給的字面常數誤差 1e-3）。
import { describe, expect, it } from 'vitest';
import { mathfPow, mathfSmoothDamp } from './mathf';

describe('Mathf.Pow（Mathf.cs:218-221）', () => {
  it('Pow(0.135, 1/60) 的 float32 值', () => {
    expect(mathfPow(0.135, 1 / 60)).toBeCloseTo(0.96717615, 6);
  });
});

describe('Mathf.SmoothDamp（Mathf.cs:397-417）', () => {
  it('current 0、target 100、velocity 0、smoothTime 0.1、maxSpeed ∞、dt 1/60', () => {
    const r = mathfSmoothDamp(0, 100, 0, 0.1, Infinity, 1 / 60);
    expect(r.value).toBeCloseTo(4.4459076, 3);
    expect(r.velocity).toBeCloseTo(477.77048, 3);
  });

  it('current −50、target 0、velocity 0、smoothTime 0.1、maxSpeed ∞、dt 1/60', () => {
    const r = mathfSmoothDamp(-50, 0, 0, 0.1, Infinity, 1 / 60);
    expect(r.value).toBeCloseTo(-47.777046, 3);
    expect(r.velocity).toBeCloseTo(238.88524, 3);
  });
});

describe('慣性一步（ScrollRect.LateUpdate :708 的 velocity × Pow）', () => {
  it('velocity 1000、decelerationRate 0.135、unscaledDeltaTime 1/60 → 新速度與位置增量', () => {
    const dt = 1 / 60;
    const vel = Math.fround(Math.fround(1000) * mathfPow(0.135, dt));
    const pos = Math.fround(Math.fround(vel) * Math.fround(dt));
    expect(vel).toBeCloseTo(967.17615, 3);
    expect(pos).toBeCloseTo(16.119604, 3);
  });
});

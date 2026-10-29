import { describe, expect, it } from 'vitest';
import { framePacer, nearestRate } from './framePacing';

/** 用 refreshHz 的 rAF 跑 seconds 秒，回傳跑了幾格（rAF 時間加一點抖動） */
function framesIn(seconds: number, p: { vSyncCount: number; targetFrameRate: number; refreshHz: number }): number {
  const pace = framePacer();
  let n = 0;
  const vblank = 1000 / p.refreshHz;
  for (let i = 0; i * vblank < seconds * 1000; i++) if (pace(i * vblank + (i % 3) * 0.3, p)) n++;
  return n;
}

describe('framePacer', () => {
  it('垂直同步 1：每次 rAF 都跑（120 Hz 一秒 120 格）', () => {
    expect(framesIn(1, { vSyncCount: 1, targetFrameRate: 30, refreshHz: 120 })).toBe(120);
  });
  it('垂直同步 2：一半（120 Hz 一秒 60 格），不看 targetFrameRate', () => {
    expect(framesIn(1, { vSyncCount: 2, targetFrameRate: 120, refreshHz: 120 })).toBe(60);
  });
  it('垂直同步關：照目標幀率（120 Hz 上 60、30、20）', () => {
    expect(framesIn(2, { vSyncCount: 0, targetFrameRate: 60, refreshHz: 120 })).toBe(120);
    expect(framesIn(2, { vSyncCount: 0, targetFrameRate: 30, refreshHz: 120 })).toBe(60);
    expect(framesIn(3, { vSyncCount: 0, targetFrameRate: 20, refreshHz: 120 })).toBe(60);
  });
  it('垂直同步關、目標比更新率高或 -1：每次 rAF 都跑', () => {
    expect(framesIn(1, { vSyncCount: 0, targetFrameRate: 240, refreshHz: 120 })).toBe(120);
    expect(framesIn(1, { vSyncCount: 0, targetFrameRate: -1, refreshHz: 60 })).toBe(60);
  });
  it('目標 75、更新率 120：不整除時平均下來接近 75', () => {
    const n = framesIn(4, { vSyncCount: 0, targetFrameRate: 75, refreshHz: 120 });
    expect(n).toBeGreaterThanOrEqual(4 * 75 - 4);
    expect(n).toBeLessThanOrEqual(4 * 75 + 4);
  });
});

describe('nearestRate', () => {
  it('量到的值對到常見更新率', () => {
    expect(nearestRate(59.7)).toBe(60);
    expect(nearestRate(119.2)).toBe(120);
    expect(nearestRate(143)).toBe(144);
    expect(nearestRate(88)).toBe(90);
  });
});

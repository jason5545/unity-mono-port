// evalGradient 改用預先建好的欄位名稱（10/18）：跟原本每次組 `key${i}` 的寫法逐值相同
import { describe, expect, it } from 'vitest';
import { evalGradient, type ColorData, type GradientData } from './curves';

/** 改之前的寫法（參照） */
function reference(g: GradientData, t: number, out: Float32Array): void {
  const fixed = g.m_Mode === 1;
  const nc = Math.max(1, g.m_NumColorKeys ?? 2);
  const na = Math.max(1, g.m_NumAlphaKeys ?? 2);
  const key = (i: number): ColorData => g[`key${i}`] as ColorData;
  const ct = (i: number): number => ((g[`ctime${i}`] as number) ?? 0) / 65535;
  const at = (i: number): number => ((g[`atime${i}`] as number) ?? 0) / 65535;
  if (t <= ct(0)) [out[0], out[1], out[2]] = [key(0).r, key(0).g, key(0).b];
  else {
    let done = false;
    for (let i = 1; i < nc; i++) {
      const t1 = ct(i);
      if (t <= t1) {
        const a = key(i - 1);
        const b = key(i);
        const u = fixed ? 1 : (t - ct(i - 1)) / (t1 - ct(i - 1) || 1);
        [out[0], out[1], out[2]] = [a.r + (b.r - a.r) * u, a.g + (b.g - a.g) * u, a.b + (b.b - a.b) * u];
        done = true;
        break;
      }
    }
    if (!done) [out[0], out[1], out[2]] = [key(nc - 1).r, key(nc - 1).g, key(nc - 1).b];
  }
  if (t <= at(0)) out[3] = key(0).a;
  else {
    let done = false;
    for (let i = 1; i < na; i++) {
      const t1 = at(i);
      if (t <= t1) {
        const u = fixed ? 1 : (t - at(i - 1)) / (t1 - at(i - 1) || 1);
        out[3] = key(i - 1).a + (key(i).a - key(i - 1).a) * u;
        done = true;
        break;
      }
    }
    if (!done) out[3] = key(na - 1).a;
  }
}

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe('evalGradient', () => {
  it('跟原本的寫法逐值相同（隨機漸層、Fixed 與 Blend、鍵數 1～8、t 含邊界）', () => {
    const r = rng(11);
    for (let trial = 0; trial < 300; trial++) {
      const nc = 1 + Math.floor(r() * 8);
      const na = 1 + Math.floor(r() * 8);
      const g: GradientData = { m_Mode: r() < 0.3 ? 1 : 0, m_NumColorKeys: nc, m_NumAlphaKeys: na };
      const ct = Array.from({ length: 8 }, () => Math.floor(r() * 65536)).sort((a, b) => a - b);
      const at = Array.from({ length: 8 }, () => Math.floor(r() * 65536)).sort((a, b) => a - b);
      for (let i = 0; i < 8; i++) {
        g[`key${i}`] = { r: r(), g: r(), b: r(), a: r() };
        g[`ctime${i}`] = ct[i];
        g[`atime${i}`] = at[i];
      }
      for (const t of [0, 1, r(), r(), r(), ct[0] / 65535, at[1] / 65535]) {
        const want = new Float32Array(4);
        const got = new Float32Array(4);
        reference(g, t, want);
        evalGradient(g, t, got);
        expect(Array.from(got)).toEqual(Array.from(want));
      }
    }
  });
});

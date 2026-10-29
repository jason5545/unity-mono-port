import { describe, expect, it } from 'vitest';
import { sortDrawablesStable } from './sceneRenderer';

type K = [number, number, number, number, number];
const cmp = (a: { key: K }, b: { key: K }) => {
  for (let i = 0; i < 5; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
  return 0;
};

/** 可重現的亂數 */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe('sortDrawablesStable', () => {
  it('跟內建的穩定排序結果一樣（幾乎排好、整個亂、key 有 NaN）', () => {
    const r = rng(7);
    for (const mode of ['nearly', 'shuffled', 'nan', 'append']) {
      for (let trial = 0; trial < 30; trial++) {
        const n = 50 + Math.floor(r() * 400);
        let list = Array.from({ length: n }, (_, id) => ({ id, key: [Math.floor(r() * 3), Math.floor(r() * 4), 3000, Math.floor(r() * 5), Math.floor(r() * n)] as K }));
        list.sort(cmp);
        if (mode === 'nearly') for (let k = 0; k < 5; k++) list[Math.floor(r() * n)].key[4] = Math.floor(r() * n);
        if (mode === 'shuffled') list = list.map((x) => [r(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
        if (mode === 'nan') list[Math.floor(r() * n)].key[3] = NaN;
        if (mode === 'append') for (let k = 0; k < 3; k++) list.push({ id: n + k, key: [1, 1, 3000, 0, Math.floor(r() * n)] });
        const want = [...list].sort(cmp).map((x) => x.id);
        sortDrawablesStable(list);
        expect(list.map((x) => x.id)).toEqual(want);
      }
    }
  });
});

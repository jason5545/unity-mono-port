// 打包過的 JSON 從包裡拿、同一個網址只抓一次（packs.ts；匯入器的 importer/packs.py）。用假的 fetch 記下實際抓了哪些網址
import { beforeEach, describe, expect, it, vi } from 'vitest';

const files: Record<string, unknown> = {
  '/g/packs/index.json': { chunks: [{ file: 'boot-0.json', group: 'boot', boot: true, files: ['assets/objects/a.json', 'assets/objects/b.json'] }, { file: 'menu-0.json', group: 'menu', files: ['scenes/menu.json'] }] },
  '/g/packs/boot-0.json': { 'assets/objects/a.json': { m_Name: 'A' }, 'assets/objects/b.json': { m_Name: 'B' } },
  '/g/packs/menu-0.json': { 'scenes/menu.json': { from: 'pack' } },
  '/g/assets/objects/a.json': { m_Name: 'A（單檔）' },
  '/g/scenes/menu.json': { from: 'file' },
  '/g/assets/materials.json': { m: 1 },
};
let fetched: string[] = [];

beforeEach(() => {
  vi.resetModules();
  fetched = [];
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url);
    const body = files[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, json: async () => structuredClone(body) };
  });
});

describe('packs', () => {
  it('沒裝包時照舊抓單檔；同一個網址只抓一次、內容共用', async () => {
    const { fetchJsonCached } = await import('./packs');
    const [x, y] = await Promise.all([fetchJsonCached('/g/assets/materials.json'), fetchJsonCached('/g/assets/materials.json')]);
    expect(x).toBe(y);
    expect(fetched).toEqual(['/g/assets/materials.json']);
  });

  it('裝了包：開機那組立刻抓，包裡的檔從包裡拿，不抓單檔', async () => {
    const { installPacks, fetchJsonCached } = await import('./packs');
    await installPacks('/g/');
    expect(fetched).toEqual(['/g/packs/index.json', '/g/packs/boot-0.json']);
    expect(await fetchJsonCached('/g/assets/objects/a.json')).toEqual({ m_Name: 'A' });
    expect(await fetchJsonCached('/g/assets/objects/b.json')).toEqual({ m_Name: 'B' });
    expect(fetched).toEqual(['/g/packs/index.json', '/g/packs/boot-0.json']);
  });

  it('不是開機的組用到才抓；fetchJsonOnce 拿過一次之後改抓單檔（包裡的已經刪掉）', async () => {
    const { installPacks, fetchJsonOnce } = await import('./packs');
    await installPacks('/g/');
    expect(fetched).not.toContain('/g/packs/menu-0.json');
    expect(await fetchJsonOnce('/g/scenes/menu.json')).toEqual({ from: 'pack' });
    expect(await fetchJsonOnce('/g/scenes/menu.json')).toEqual({ from: 'file' });
    expect(fetched.slice(2)).toEqual(['/g/packs/menu-0.json', '/g/scenes/menu.json']);
  });

  it('沒有 packs/index.json（舊的匯入）：什麼都不做', async () => {
    const { installPacks, fetchJsonOnce } = await import('./packs');
    await installPacks('/old/');
    expect(fetched).toEqual(['/old/packs/index.json']);
    await expect(fetchJsonOnce('/old/x.json')).rejects.toThrow('HTTP 404');
  });
});

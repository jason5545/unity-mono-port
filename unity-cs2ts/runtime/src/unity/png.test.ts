// png.ts：期望值都是 Pillow 解同一個檔案得到的位元組（Claude Code 10/11 用 Python 算的）
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePngRgba8, stackedLayers } from './png';
import { TEST_GAME } from '../testData';

const TEXTURES = resolve(TEST_GAME, 'assets/textures');

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('decodePngRgba8', () => {
  it('五種濾波各一列、IDAT 分兩段：跟 Pillow 解出的位元組相同', async () => {
    // 3×5 RGBA，第 y 列用濾波類型 y（0 None、1 Sub、2 Up、3 Average、4 Paeth），像素是固定種子的亂數
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAACAcVaiAAAACklEQVR4nAFBAL7/APux/fTejwAAAEJJREFU/a2OHBS39RMHsAFvQfENkjSKQGJIbUgCmQaSyLLyICRTemtRAx/PbkRP5/5euQudUwRSHc4goaUdpCwSVpCdvBsK/8PqjQAAAABJRU5ErkJggg==',
      'base64',
    );
    const expected = Buffer.from('+7H9rY4cFLf1Ewewb0HxDQF1e01jveiVCEeD1bNnm3G2N1PmI/KvrrqTo+1xcBg8dQ99zlu0mpGHpW7M', 'base64');
    const img = await decodePngRgba8(bufferOf(png));
    expect([img.width, img.height]).toEqual([3, 5]);
    expect(Buffer.from(img.data).equals(expected)).toBe(true);
  });

  it('不支援的格式直接丟錯（不默默解錯）', async () => {
    // 同一張圖把 IHDR 的 colorType 改成 2（RGB）
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAACAcVaiAAAACklEQVR4nAFBAL7/APux/fTejwAAAEJJREFU/a2OHBS39RMHsAFvQfENkjSKQGJIbUgCmQaSyLLyICRTemtRAx/PbkRP5/5euQudUwRSHc4goaUdpCwSVpCdvBsK/8PqjQAAAABJRU5ErkJggg==',
      'base64',
    );
    png[25] = 2;
    await expect(decodePngRgba8(bufferOf(png))).rejects.toThrow('colorType 2');
  });

  // 卡面燃燒的兩張 Texture2DArray（public/game，npm run import）
  it.each([
    ['BurnFxTable', 'fd36985a0eff6ca499e4c18fd0f2bd7b', 'a12a60d5aa6925b65aa01fb1b69093485c924385151960acaf4cf065d3b0e566'],
    ['cardburnmaskTable', '113414b4d60df974db2727bac8212254', '8e503a4cb0ada7d7aeb43520e585057276a116ff75f22223997b644d12bc4c39'],
  ])('%s：512×4096，位元組的 sha256 跟 Pillow 相同', async (_name, guid, sha) => {
    const p = resolve(TEXTURES, `${guid}.png`);
    if (!existsSync(p)) throw new Error(`找不到 ${p}，先跑 npm run import`);
    const img = await decodePngRgba8(bufferOf(readFileSync(p)));
    expect([img.width, img.height]).toEqual([512, 4096]);
    expect(createHash('sha256').update(img.data).digest('hex')).toBe(sha);
  });
});

describe('stackedLayers', () => {
  it('直排的圖切成層：層序照由上往下，每層的列上下顛倒（第 0 列是那一格最下面）', () => {
    // 1×6 的圖分 2 層；像素的 R 是列號
    const data = new Uint8Array(6 * 4);
    for (let y = 0; y < 6; y++) data[y * 4] = y;
    const out = stackedLayers({ width: 1, height: 6, data }, 2);
    expect(Array.from({ length: 6 }, (_, i) => out[i * 4])).toEqual([2, 1, 0, 5, 4, 3]);
    expect(() => stackedLayers({ width: 1, height: 6, data }, 4)).toThrow('不能平分');
  });
});

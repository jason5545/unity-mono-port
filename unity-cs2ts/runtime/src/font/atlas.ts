// TMP 動態字型的 atlas：照 TMP_FontAsset.TryAddCharacterInternal 呼叫 FontEngine.TryAddGlyphToTexture 的方式排字。
//
// 排列：GlyphPackingMode.BestShortSideFit（MaxRects）。FontEngine 的實作是原生程式碼看不到，這裡用標準 MaxRects；
// 字放在哪不影響畫面（每個字都留了 padding），只影響 atlas 什麼時候滿。
// 每個字佔 (寬 + 2 × padding + 1) × (高 + 2 × padding + 1)，GlyphRect 從佔用區左下角往內 padding + 1
// （build 裡烘好的 atlas：江城圆体 600W 第一個字佔 0–61、GlyphRect 從 6 開始，padding 5；ConcertOne padding 9 是 0–83、從 10）。

import type { GlyphBitmap } from './sdf';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** MaxRects，Best Short Side Fit（Jukka Jylänki 的整理） */
export class MaxRectsPacker {
  readonly free: Rect[];
  readonly used: Rect[] = [];

  constructor(width: number, height: number) {
    this.free = [{ x: 0, y: 0, width, height }];
  }

  insert(width: number, height: number): Rect | null {
    let best: Rect | null = null;
    let bestShort = Infinity;
    let bestLong = Infinity;
    for (const f of this.free) {
      if (f.width >= width && f.height >= height) {
        const leftH = f.width - width;
        const leftV = f.height - height;
        const short = Math.min(leftH, leftV);
        const long = Math.max(leftH, leftV);
        if (short < bestShort || (short === bestShort && long < bestLong)) {
          best = { x: f.x, y: f.y, width, height };
          bestShort = short;
          bestLong = long;
        }
      }
    }
    if (!best) return null;
    this.place(best);
    return best;
  }

  /** 佔用一塊區域並切開空矩形（insert 與 GlyphAtlas.reserve 用；只從空區切，跟既有佔用重疊不影響空區表） */
  place(r: Rect): void {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (r.x >= f.x + f.width || r.x + r.width <= f.x || r.y >= f.y + f.height || r.y + r.height <= f.y) {
        next.push(f);
        continue;
      }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, width: r.x - f.x, height: f.height });
      if (r.x + r.width < f.x + f.width) next.push({ x: r.x + r.width, y: f.y, width: f.x + f.width - (r.x + r.width), height: f.height });
      if (r.y > f.y) next.push({ x: f.x, y: f.y, width: f.width, height: r.y - f.y });
      if (r.y + r.height < f.y + f.height) next.push({ x: f.x, y: r.y + r.height, width: f.width, height: f.y + f.height - (r.y + r.height) });
    }
    // 拿掉被別的空矩形完全包住的
    const contained = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
    this.free.length = 0;
    next.forEach((a, i) => {
      if (!next.some((b, j) => j !== i && contained(a, b) && !(contained(b, a) && j > i))) this.free.push(a);
    });
    this.used.push(r);
  }
}

/** 單張 atlas（Alpha8），列 0 在最下面，跟 Unity 貼圖一樣 */
export class GlyphAtlas {
  readonly data: Uint8Array;
  readonly packer: MaxRectsPacker;
  /** 有改動、還沒上傳到 GPU */
  dirty = true;
  /** 上次上傳之後改過的範圍（各次改動的外框聯集）；繪製端只同步並上傳這一塊 */
  dirtyRect: Rect;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly padding: number,
  ) {
    this.data = new Uint8Array(width * height);
    this.packer = new MaxRectsPacker(width, height);
    this.dirtyRect = { x: 0, y: 0, width, height };
  }

  /** 標記一塊範圍改過（不給就是整張） */
  markDirty(r: Rect = { x: 0, y: 0, width: this.width, height: this.height }): void {
    if (!this.dirty) this.dirtyRect = { ...r };
    else {
      const d = this.dirtyRect;
      const x0 = Math.min(d.x, r.x);
      const y0 = Math.min(d.y, r.y);
      this.dirtyRect = { x: x0, y: y0, width: Math.max(d.x + d.width, r.x + r.width) - x0, height: Math.max(d.y + d.height, r.y + r.height) - y0 };
    }
    this.dirty = true;
  }

  /** 繪製端上傳完呼叫 */
  clearDirty(): void {
    this.dirty = false;
    this.dirtyRect = { x: 0, y: 0, width: 0, height: 0 };
  }

  /** 放一個字，回傳 GlyphRect（不含 padding）；放不下回 null */
  add(bmp: GlyphBitmap): Rect | null {
    if (bmp.width === 0 || bmp.height === 0) return { x: 0, y: 0, width: 0, height: 0 };
    const p = this.padding;
    const slot = this.packer.insert(bmp.width + 2 * p + 1, bmp.height + 2 * p + 1);
    if (!slot) return null;
    const rect = { x: slot.x + p + 1, y: slot.y + p + 1, width: bmp.width, height: bmp.height };
    const W = bmp.width + 2 * p;
    const H = bmp.height + 2 * p;
    for (let j = 0; j < H; j++) {
      const dst = (rect.y - p + j) * this.width + rect.x - p;
      this.data.set(bmp.data.subarray(j * W, (j + 1) * W), dst);
    }
    this.markDirty({ x: rect.x - p, y: rect.y - p, width: W, height: H });
    return rect;
  }

  /**
   * 預先佔住一塊區域（動態字型烘好的內容）：TMP 的動態字型在 build 裡帶著烘好的
   * 內容（m_GlyphTable／m_CharacterTable 與 m_AtlasTextures），執行時加字是加進同一張 atlas；
   * 先把烘好的位置（含 padding，由呼叫端算好）佔住，之後新加的字才不會蓋到。
   * 重疊不影響空矩形表：place 只從空區切掉佔用。像素不在這裡放（這層不解碼圖片），
   * 由繪製端建貼圖時合進來（sceneRenderer.seedBakedAtlas）。
   */
  reserve(zone: Rect): void {
    this.packer.place(zone);
  }
}

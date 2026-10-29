// PNG 解碼成原始位元組（Texture2DArray 用）：瀏覽器的圖片解碼只能整張上傳成 2D 貼圖，Texture2DArray 要自己切層；
// 用 canvas 讀像素會經過預乘 alpha，半透明的像素會走樣，所以自己解。
// 只支援這個遊戲的 Texture2DArray 用到的格式：8 位元 RGBA、不交錯（BurnFxTable、cardburnmaskTable 都是）。
// 規格照 PNG（W3C）：IHDR、IDAT 串起來是一段 zlib（DecompressionStream 的 'deflate' 就是 zlib 格式），
// 每列開頭一個濾波類型（0 None、1 Sub、2 Up、3 Average、4 Paeth）。

export interface RgbaImage {
  width: number;
  height: number;
  /** 由上往下逐列，每像素 RGBA 4 個位元組（不預乘） */
  data: Uint8Array<ArrayBuffer>;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export async function decodePngRgba8(buffer: ArrayBuffer): Promise<RgbaImage> {
  const bytes = new Uint8Array(buffer);
  if (SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('不是 PNG');
  const view = new DataView(buffer);
  let width = 0;
  let height = 0;
  const idat: Uint8Array<ArrayBuffer>[] = [];
  for (let p = 8; p + 8 <= bytes.length; ) {
    const len = view.getUint32(p);
    const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    if (type === 'IHDR') {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      const [bitDepth, colorType, , , interlace] = bytes.subarray(p + 16, p + 21);
      if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`只支援 8 位元 RGBA、不交錯的 PNG（bitDepth ${bitDepth}、colorType ${colorType}、interlace ${interlace}）`);
      }
    } else if (type === 'IDAT') idat.push(bytes.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error(`PNG 解壓後長度 ${raw.length}，應為 ${(stride + 1) * height}`);

  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    const up = row - stride; // y = 0 時上一列當作全 0
    const a = (x: number) => (x >= 4 ? out[row + x - 4] : 0);
    const b = (x: number) => (y > 0 ? out[up + x] : 0);
    const c = (x: number) => (y > 0 && x >= 4 ? out[up + x - 4] : 0);
    switch (filter) {
      case 0:
        out.set(raw.subarray(src, src + stride), row);
        break;
      case 1:
        for (let x = 0; x < stride; x++) out[row + x] = raw[src + x] + a(x);
        break;
      case 2:
        for (let x = 0; x < stride; x++) out[row + x] = raw[src + x] + b(x);
        break;
      case 3:
        for (let x = 0; x < stride; x++) out[row + x] = raw[src + x] + ((a(x) + b(x)) >> 1);
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const pa0 = a(x);
          const pb0 = b(x);
          const pc0 = c(x);
          const p = pa0 + pb0 - pc0;
          const pa = Math.abs(p - pa0);
          const pb = Math.abs(p - pb0);
          const pc = Math.abs(p - pc0);
          out[row + x] = raw[src + x] + (pa <= pb && pa <= pc ? pa0 : pb <= pc ? pb0 : pc0);
        }
        break;
      default:
        throw new Error(`第 ${y} 列的濾波類型 ${filter} 不認得`);
    }
  }
  return { width, height, data: out };
}

/**
 * AssetRipper 匯出的 Texture2DArray（每層由上往下直排成一張圖）→ DataArrayTexture 的資料。
 * 每層裡的列順序反過來：第 0 列是那一格最下面的一列（v = 0），跟 2D 貼圖載入時 flipY 的方向一樣
 * （DataArrayTexture 不能用 UNPACK_FLIP_Y，只能自己排）。
 */
export function stackedLayers(img: RgbaImage, depth: number): Uint8Array<ArrayBuffer> {
  const h = img.height / depth;
  if (!Number.isInteger(h)) throw new Error(`圖高 ${img.height} 不能平分成 ${depth} 層`);
  const stride = img.width * 4;
  const out = new Uint8Array(img.data.length);
  for (let z = 0; z < depth; z++) {
    for (let r = 0; r < h; r++) {
      const from = (z * h + (h - 1 - r)) * stride;
      out.set(img.data.subarray(from, from + stride), (z * h + r) * stride);
    }
  }
  return out;
}

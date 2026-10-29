// TMP 動態字型的 SDF glyph（GlyphRenderMode.SDFAA，4165）：從 FreeType 的字形輪廓算距離場。
//
// 原版由 FontEngine（原生程式碼，看不到）產生。10/5 對 build 裡已烘好的 atlas 驗證（scripts/import/glyphs.py 檔頭）：
// 像素中心到輪廓的真實有號距離 d（像素），值 = 127.5 + d × 255 / (2 × (padding + 1))，夾在 0–255，
// 跟原版平均差 1 階左右。glyph 的範圍照 FreeType 點陣化：左 = floor(xMin)、右 = ceil(xMax)、下 = floor(yMin)、上 = ceil(yMax)，
// 也就是 TMP 存的 GlyphRect 寬高；atlas 裡再往外留 padding 圈。

/** FreeType 的輪廓：每個 contour 是 [x, y, tag]，座標 26.6 定點，tag 1 線上點、0 二次控制點、2 三次控制點 */
export type Outline = [number, number, number][][];

export interface GlyphBitmap {
  /** GlyphRect 的寬高（不含 padding） */
  width: number;
  height: number;
  /** 點陣左下角在字形座標（像素）的位置：floor(xMin)、floor(yMin) */
  left: number;
  bottom: number;
  padding: number;
  /** (width + 2 padding) × (height + 2 padding)，第一列是最下面（跟 Unity 貼圖一樣 y 往上） */
  data: Uint8Array;
}

const CONIC_STEPS = 16;
const CUBIC_STEPS = 24;

/** 曲線切成線段（像素單位）。回傳 [x0, y0, x1, y1, …] */
export function flatten(outline: Outline): Float64Array {
  const out: number[] = [];
  const seg = (ax: number, ay: number, bx: number, by: number) => out.push(ax, ay, bx, by);
  for (const contour of outline) {
    const n = contour.length;
    if (n === 0) continue;
    const pts = contour.map(([x, y, t]) => [x / 64, y / 64, t] as const);
    // 從一個線上點開始；全是二次控制點時用頭兩點的中點當起點（TrueType 的規則）
    let start = pts.findIndex((p) => p[2] === 1);
    let first: readonly [number, number, number];
    let order: (readonly [number, number, number])[];
    if (start < 0) {
      first = [(pts[0][0] + pts[1 % n][0]) / 2, (pts[0][1] + pts[1 % n][1]) / 2, 1];
      order = [...pts.slice(1), pts[0]];
      start = 0;
    } else {
      first = pts[start];
      order = [...pts.slice(start + 1), ...pts.slice(0, start)];
    }
    order.push(first);
    let cx = first[0];
    let cy = first[1];
    for (let k = 0; k < order.length; ) {
      const p = order[k];
      if (p[2] === 1) {
        seg(cx, cy, p[0], p[1]);
        cx = p[0];
        cy = p[1];
        k++;
      } else if (p[2] === 0) {
        let qx = p[0];
        let qy = p[1];
        k++;
        for (;;) {
          const q = order[k];
          const ex = q[2] === 1 ? q[0] : (qx + q[0]) / 2;
          const ey = q[2] === 1 ? q[1] : (qy + q[1]) / 2;
          let px = cx;
          let py = cy;
          for (let s = 1; s <= CONIC_STEPS; s++) {
            const t = s / CONIC_STEPS;
            const u = 1 - t;
            const x = u * u * cx + 2 * u * t * qx + t * t * ex;
            const y = u * u * cy + 2 * u * t * qy + t * t * ey;
            seg(px, py, x, y);
            px = x;
            py = y;
          }
          cx = ex;
          cy = ey;
          if (q[2] === 1) {
            k++;
            break;
          }
          qx = q[0];
          qy = q[1];
          k++;
        }
      } else {
        const c1 = p;
        const c2 = order[k + 1];
        const e = order[k + 2];
        let px = cx;
        let py = cy;
        for (let s = 1; s <= CUBIC_STEPS; s++) {
          const t = s / CUBIC_STEPS;
          const u = 1 - t;
          const x = u * u * u * cx + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0];
          const y = u * u * u * cy + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1];
          seg(px, py, x, y);
          px = x;
          py = y;
        }
        cx = e[0];
        cy = e[1];
        k += 3;
      }
    }
  }
  return Float64Array.from(out);
}

/** FreeType 點陣的範圍（像素）：由輪廓的控制框（含控制點，FT_Outline_Get_CBox）取整 */
export function bitmapBox(outline: Outline): { left: number; bottom: number; width: number; height: number } {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const c of outline) {
    for (const [x, y] of c) {
      xMin = Math.min(xMin, x);
      yMin = Math.min(yMin, y);
      xMax = Math.max(xMax, x);
      yMax = Math.max(yMax, y);
    }
  }
  if (xMin === Infinity) return { left: 0, bottom: 0, width: 0, height: 0 };
  // 26.6 → 像素，FT_PIX_FLOOR／FT_PIX_CEIL
  const left = Math.floor(xMin / 64);
  const bottom = Math.floor(yMin / 64);
  return { left, bottom, width: Math.ceil(xMax / 64) - left, height: Math.ceil(yMax / 64) - bottom };
}

/** 有號距離場。距離只在 ±(padding + 1) 內精確計算，外面本來就會夾到 0 或 255 */
export function renderSdf(outline: Outline, padding: number): GlyphBitmap {
  const box = bitmapBox(outline);
  const W = box.width + 2 * padding;
  const H = box.height + 2 * padding;
  const data = new Uint8Array(Math.max(0, W * H));
  if (box.width === 0 || box.height === 0) return { ...box, padding, data };
  const spread = padding + 1;
  const ox = box.left - padding; // 像素 (i, j) 的中心 = (ox + i + 0.5, oy + j + 0.5)
  const oy = box.bottom - padding;
  const segs = flatten(outline);
  const dist = new Float64Array(W * H).fill(spread);

  for (let s = 0; s < segs.length; s += 4) {
    const ax = segs[s];
    const ay = segs[s + 1];
    const bx = segs[s + 2];
    const by = segs[s + 3];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - spread - ox - 0.5));
    const i1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + spread - ox - 0.5));
    const j0 = Math.max(0, Math.floor(Math.min(ay, by) - spread - oy - 0.5));
    const j1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + spread - oy - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = oy + j + 0.5;
      for (let i = i0; i <= i1; i++) {
        const px = ox + i + 0.5;
        let t = len2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - (ax + t * dx);
        const ey = py - (ay + t * dy);
        const d = Math.sqrt(ex * ex + ey * ey);
        const k = j * W + i;
        if (d < dist[k]) dist[k] = d;
      }
    }
  }

  // 內外：每一列的像素中心做非零環繞數（FreeType 預設的填色規則）
  const crossings: [number, number][] = [];
  for (let j = 0; j < H; j++) {
    const py = oy + j + 0.5;
    crossings.length = 0;
    for (let s = 0; s < segs.length; s += 4) {
      const ay = segs[s + 1];
      const by = segs[s + 3];
      if (ay <= py && by > py) crossings.push([segs[s] + ((py - ay) / (by - ay)) * (segs[s + 2] - segs[s]), 1]);
      else if (ay > py && by <= py) crossings.push([segs[s] + ((py - ay) / (by - ay)) * (segs[s + 2] - segs[s]), -1]);
    }
    crossings.sort((a, b) => a[0] - b[0]);
    let c = 0;
    let wind = 0;
    for (let i = 0; i < W; i++) {
      const px = ox + i + 0.5;
      while (c < crossings.length && crossings[c][0] < px) wind += crossings[c++][1];
      const d = wind !== 0 ? dist[j * W + i] : -dist[j * W + i];
      const v = 127.5 + (d * 255) / (2 * spread);
      data[j * W + i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  }
  return { ...box, padding, data };
}

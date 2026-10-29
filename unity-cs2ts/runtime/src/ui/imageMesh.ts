// 對應 uGUI 的 UnityEngine.UI.Image.OnPopulateMesh 與 Graphic.OnPopulateMesh。
// 依據：反編譯原版 build 的 UnityEngine.UI.dll（reference/decompiled/UnityEngine.UI/，10/5，ilspycmd）。
// 最早照 GitHub uGUI 6000.0 移植，10/5 對過反編譯結果：2022.3 的 GenerateSlicedSprite 沒有 6000.0 跳過零面積四邊形的修正
// （UUM-71372），已改回照 build；畫面結果相同，只差網格裡多幾個零面積四邊形。
//
// 還沒移植：useSpriteMesh（GenerateSprite）。遇到時回傳 unsupported，畫面上照 Simple 畫並記錄。

import type { Rect } from './rectTransform';

/** Sprite 在網格生成會用到的欄位（Sprite 物件序列化的名稱） */
export interface SpriteForMesh {
  m_Rect: Rect;
  m_Border: { x: number; y: number; z: number; w: number }; // 左、下、右、上（像素）
  m_PixelsToUnits: number;
  textureRect: Rect;
  /** textureRect 在 sprite 範圍裡的位置（透明 padding 的左、下）。0b 從原版 build 讀，AssetRipper 匯出的是錯的 */
  textureRectOffset: { x: number; y: number };
  textureWidth: number;
  textureHeight: number;
  /** Sprite.packed：已打包進圖集（GenerateTiledSprite :791 的分支條件之一） */
  packed?: boolean;
  /** 所屬貼圖的 wrap mode（UnityEngine.TextureWrapMode：0 Repeat、1 ClampToEdge）；≠Repeat 時 Tiled 走逐格分支（:791） */
  textureWrapMode?: number;
}

export interface ImageForMesh {
  m_Type: number; // 0 Simple、1 Sliced、2 Tiled、3 Filled
  m_PreserveAspect: number;
  m_FillCenter: number;
  m_UseSpriteMesh: number;
  m_PixelsPerUnitMultiplier: number;
  m_FillMethod?: number; // 0 Horizontal、1 Vertical、2 Radial90、3 Radial180、4 Radial360
  m_FillAmount?: number;
  m_FillClockwise?: number;
  m_FillOrigin?: number;
}

/** UI 網格：位置在 RectTransform 自己的區域空間（原點是 pivot），uv 是貼圖座標（原點左下） */
export interface UIMesh {
  positions: number[]; // x, y 交錯
  uvs: number[]; // u, v 交錯
  indices: number[];
  unsupported?: string;
}

function emptyMesh(): UIMesh {
  return { positions: [], uvs: [], indices: [] };
}

/** Sprites.DataUtility.GetOuterUV：textureRect 換成 0–1 */
export function outerUV(s: SpriteForMesh): [number, number, number, number] {
  const t = s.textureRect;
  return [t.x / s.textureWidth, t.y / s.textureHeight, (t.x + t.width) / s.textureWidth, (t.y + t.height) / s.textureHeight];
}

/** Sprites.DataUtility.GetInnerUV：textureRect 往內縮 border。
 *  引擎沒有原始碼；有 padding 的 sprite 在這份資料裡都沒有 border（10/5 查過 3703 個），所以這裡不處理兩者同時存在的情況 */
export function innerUV(s: SpriteForMesh): [number, number, number, number] {
  const t = s.textureRect;
  const b = s.m_Border;
  return [
    (t.x + b.x) / s.textureWidth,
    (t.y + b.y) / s.textureHeight,
    (t.x + t.width - b.z) / s.textureWidth,
    (t.y + t.height - b.w) / s.textureHeight,
  ];
}

/** Sprites.DataUtility.GetPadding：sprite 範圍裡 textureRect 四周的透明邊（左、下、右、上）。
 *  引擎沒有原始碼，由定義推得：左下 = textureRectOffset，右上 = 範圍 − textureRect − offset */
export function spritePadding(s: SpriteForMesh): [number, number, number, number] {
  const o = s.textureRectOffset;
  const t = s.textureRect;
  return [o.x, o.y, s.m_Rect.width - t.width - o.x, s.m_Rect.height - t.height - o.y];
}

/** Mathf.RoundToInt（C# Math.Round 預設：剛好 .5 時取偶數） */
export function roundToInt(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function addQuad(mesh: UIMesh, x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number) {
  const start = mesh.positions.length / 2;
  mesh.positions.push(x0, y0, x0, y1, x1, y1, x1, y0);
  mesh.uvs.push(u0, v0, u0, v1, u1, v1, u1, v0);
  mesh.indices.push(start, start + 1, start + 2, start + 2, start + 3, start);
}

/** Graphic.OnPopulateMesh：沒有 sprite 時畫整個 rect，uv 0–1（貼圖是白色） */
export function graphicMesh(rect: Rect): UIMesh {
  const mesh = emptyMesh();
  addQuad(mesh, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height, 0, 0, 1, 1);
  return mesh;
}

/** Image.PreserveSpriteAspectRatio */
function preserveAspect(r: Rect, spriteW: number, spriteH: number, pivot: { x: number; y: number }): Rect {
  const spriteRatio = spriteW / spriteH;
  const rectRatio = r.width / r.height;
  const out = { ...r };
  if (spriteRatio > rectRatio) {
    const oldHeight = out.height;
    out.height = out.width * (1 / spriteRatio);
    out.y += (oldHeight - out.height) * pivot.y;
  } else {
    const oldWidth = out.width;
    out.width = out.height * spriteRatio;
    out.x += (oldWidth - out.width) * pivot.x;
  }
  return out;
}

/** Image.GetDrawingDimensions：整個 sprite 範圍對到 rect，再扣掉 padding 只留有圖的部分 */
export function drawingDimensions(rect: Rect, sprite: SpriteForMesh, keepAspect: boolean, pivot: { x: number; y: number }): [number, number, number, number] {
  const padding = spritePadding(sprite);
  const sizeX = sprite.m_Rect.width;
  const sizeY = sprite.m_Rect.height;
  const spriteW = roundToInt(sizeX);
  const spriteH = roundToInt(sizeY);
  const v = [padding[0] / spriteW, padding[1] / spriteH, (spriteW - padding[2]) / spriteW, (spriteH - padding[3]) / spriteH];
  let r = rect;
  if (keepAspect && sizeX * sizeX + sizeY * sizeY > 0) r = preserveAspect(r, sizeX, sizeY, pivot);
  return [r.x + r.width * v[0], r.y + r.height * v[1], r.x + r.width * v[2], r.y + r.height * v[3]];
}

/** Image.GenerateSimpleSprite */
function simpleMesh(rect: Rect, sprite: SpriteForMesh, keepAspect: boolean, pivot: { x: number; y: number }): UIMesh {
  const [x0, y0, x1, y1] = drawingDimensions(rect, sprite, keepAspect, pivot);
  const [u0, v0, u1, v1] = outerUV(sprite);
  const mesh = emptyMesh();
  addQuad(mesh, x0, y0, x1, y1, u0, v0, u1, v1);
  return mesh;
}

/** Image.GetAdjustedBorders：rect 比左右（上下）邊框加起來還小時，等比例縮小邊框。
 *  originalRect 與 adjustedRect 在 pixelPerfect 關閉時相同（level1 的 Canvas 都是 m_PixelPerfect: 0），第一段縮放比例是 1。 */
export function adjustedBorders(border: [number, number, number, number], rect: Rect): [number, number, number, number] {
  const b = [...border] as [number, number, number, number];
  const size = [rect.width, rect.height];
  for (let axis = 0; axis <= 1; axis++) {
    const combined = b[axis] + b[axis + 2];
    if (size[axis] < combined && combined !== 0) {
      const ratio = size[axis] / combined;
      b[axis] *= ratio;
      b[axis + 2] *= ratio;
    }
  }
  return b;
}

/** Image.GenerateSlicedSprite */
function slicedMesh(rect: Rect, sprite: SpriteForMesh, fillCenter: boolean, multipliedPixelsPerUnit: number): UIMesh {
  const bd = sprite.m_Border;
  const border = adjustedBorders(
    [bd.x / multipliedPixelsPerUnit, bd.y / multipliedPixelsPerUnit, bd.z / multipliedPixelsPerUnit, bd.w / multipliedPixelsPerUnit],
    rect,
  );
  const pad = spritePadding(sprite).map((x) => x / multipliedPixelsPerUnit);
  const xs = [pad[0], border[0], rect.width - border[2], rect.width - pad[2]].map((x) => x + rect.x);
  const ys = [pad[1], border[1], rect.height - border[3], rect.height - pad[3]].map((y) => y + rect.y);
  const outer = outerUV(sprite);
  const inner = innerUV(sprite);
  const us = [outer[0], inner[0], inner[2], outer[2]];
  const vs = [outer[1], inner[1], inner[3], outer[3]];
  const mesh = emptyMesh();
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 3; y++) {
      if (!fillCenter && x === 1 && y === 1) continue;
      addQuad(mesh, xs[x], ys[y], xs[x + 1], ys[y + 1], us[x], vs[y], us[x + 1], vs[y + 1]);
    }
  }
  return mesh;
}

/** Image.GenerateTiledSprite（:751-915）：中心區用整格平移鋪滿、有 border 時四週再補一圈邊框帶。
 *  pixelAdjustedRect 在非 pixelPerfect 的 Canvas 就是 rect 本身（Graphic.GetPixelAdjustedRect :640-646，
 *  level2 的 Canvas 全部 m_PixelPerfect: 0，與 slicedMesh 同一處理）。 */
function tiledMesh(
  rect: Rect,
  sprite: SpriteForMesh,
  fillCenter: boolean,
  multiplied: number,
  hasBorder: boolean,
): UIMesh {
  const outer = outerUV(sprite);
  const inner = innerUV(sprite);
  const bd = sprite.m_Border;
  // border 換算：先除以 effective ppu（:775 vector3 = border / multipliedPixelsPerUnit），再 GetAdjustedBorders
  const border = adjustedBorders(
    [bd.x / multiplied, bd.y / multiplied, bd.z / multiplied, bd.w / multiplied],
    rect,
  );
  // num／num2（:772-773）：中心一格的尺寸；rect.size 減掉左右（上下）border 再除以 ppu
  let tileW = (sprite.m_Rect.width - bd.x - bd.z) / multiplied;
  let tileH = (sprite.m_Rect.height - bd.y - bd.w) / multiplied;
  // x／num3／y／num4（:777-780）：中心區四邊（rect 原點座標系）
  const x = border[0];
  const x1 = rect.width - border[2];
  const y = border[1];
  const y1 = rect.height - border[3];
  const mesh = emptyMesh();
  if (tileW <= 0) tileW = x1 - x;
  if (tileH <= 0) tileH = y1 - y;
  // :791 packed／wrapMode≠Repeat 與 hasBorder 同走逐格鋪設；其餘走單 quad 拉伸 uv
  if (hasBorder || sprite.packed || (sprite.textureWrapMode !== undefined && sprite.textureWrapMode !== 0)) {
    let cols = 0;
    let rows = 0;
    if (fillCenter) {
      cols = Math.ceil((x1 - x) / tileW);
      rows = Math.ceil((y1 - y) / tileH);
      // :800-815 超過 65000 頂點就把格放大（double 精度照原文）
      const est = hasBorder ? (cols + 2) * (rows + 2) * 4 : cols * rows * 4;
      if (est > 65000) {
        const ratio = hasBorder ? (cols + 2) / (rows + 2) : cols / rows;
        let cw = Math.sqrt(16250 / ratio);
        let rh = cw * ratio;
        if (hasBorder) {
          cw -= 2;
          rh -= 2;
        }
        cols = Math.floor(cw);
        rows = Math.floor(rh);
        tileW = (x1 - x) / cols;
        tileH = (y1 - y) / rows;
      }
    } else if (hasBorder) {
      cols = Math.ceil((x1 - x) / tileW);
      rows = Math.ceil((y1 - y) / tileH);
      // :834 (rows+cols+2)*2*4：border-only 的頂點數檢查
      if ((rows + cols + 2) * 2 * 4 > 65000) {
        const ratio = cols / rows;
        const cw = (16250 - 4) / (2 * (1 + ratio));
        cols = Math.floor(cw);
        rows = Math.floor(cw * ratio);
        tileW = (x1 - x) / cols;
        tileH = (y1 - y) / rows;
      }
    }
    const quad = (px0: number, py0: number, px1: number, py1: number, u0: number, v0: number, u1: number, v1: number) =>
      addQuad(mesh, px0 + rect.x, py0 + rect.y, px1 + rect.x, py1 + rect.y, u0, v0, u1, v1);
    let uvMaxY = inner[3];
    if (fillCenter) {
      // :848-873 中心區逐格；最後一列／欄被裁到 x1／y1 時 uv 同比例截短（uvMax 逐格沿用原語意：先列後欄重設）
      for (let r = 0; r < rows; r++) {
        const py0 = y + r * tileH;
        let py1 = y + (r + 1) * tileH;
        if (py1 > y1) {
          uvMaxY = inner[1] + (inner[3] - inner[1]) * (y1 - py0) / (py1 - py0);
          py1 = y1;
        }
        let uvMaxX = inner[2];
        for (let c = 0; c < cols; c++) {
          const px0 = x + c * tileW;
          let px1 = x + (c + 1) * tileW;
          if (px1 > x1) {
            uvMaxX = inner[0] + (inner[2] - inner[0]) * (x1 - px0) / (px1 - px0);
            px1 = x1;
          }
          quad(px0, py0, px1, py1, inner[0], inner[1], uvMaxX, uvMaxY);
        }
      }
    }
    if (!hasBorder) return mesh;
    // :878-903 左右邊框帶：uv 用 outer 的左右邊（u0..inner.x／inner.z..outer.z），v 跟隨列
    uvMaxY = inner[3];
    for (let r = 0; r < rows; r++) {
      const py0 = y + r * tileH;
      let py1 = y + (r + 1) * tileH;
      if (py1 > y1) {
        uvMaxY = inner[1] + (inner[3] - inner[1]) * (y1 - py0) / (py1 - py0);
        py1 = y1;
      }
      quad(0, py0, x, py1, outer[0], inner[1], inner[0], uvMaxY);
      quad(x1, py0, rect.width, py1, inner[2], inner[1], outer[2], uvMaxY);
    }
    // :905-919 上下邊框帶與四角
    let uvMaxX = inner[2];
    for (let c = 0; c < cols; c++) {
      const px0 = x + c * tileW;
      let px1 = x + (c + 1) * tileW;
      if (px1 > x1) {
        uvMaxX = inner[0] + (inner[2] - inner[0]) * (x1 - px0) / (px1 - px0);
        px1 = x1;
      }
      quad(px0, 0, px1, y, inner[0], outer[1], uvMaxX, inner[1]);
      quad(px0, y1, px1, rect.height, inner[0], inner[3], uvMaxX, outer[3]);
    }
    quad(0, 0, x, y, outer[0], outer[1], inner[0], inner[1]);
    quad(x1, 0, rect.width, y, inner[2], outer[1], outer[2], inner[1]);
    quad(0, y1, x, rect.height, outer[0], inner[3], inner[0], outer[3]);
    quad(x1, y1, rect.width, rect.height, inner[2], inner[3], outer[2], outer[3]);
    return mesh;
  }
  // :921-931 else（無 border、未 packed、wrap 是 Repeat）：一格拉伸整個中心區，uv 乘格數
  if (fillCenter) {
    const bx = (x1 - x) / tileW;
    const by = (y1 - y) / tileH;
    addQuad(mesh, x + rect.x, y + rect.y, x1 + rect.x, y1 + rect.y, inner[0] * bx, inner[1] * by, inner[2] * bx, inner[3] * by);
  }
  return mesh;
}


type V2 = [number, number];

function addQuadPoints(mesh: UIMesh, xy: V2[], uv: V2[]) {
  const start = mesh.positions.length / 2;
  for (let i = 0; i < 4; i++) {
    mesh.positions.push(xy[i][0], xy[i][1]);
    mesh.uvs.push(uv[i][0], uv[i][1]);
  }
  mesh.indices.push(start, start + 1, start + 2, start + 2, start + 3, start);
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

/** Image.RadialCut（座標陣列版） */
function radialCutPoints(xy: V2[], cos: number, sin: number, invert: boolean, corner: number) {
  const i1 = (corner + 1) % 4;
  const i2 = (corner + 2) % 4;
  const i3 = (corner + 3) % 4;
  if ((corner & 1) === 1) {
    if (sin > cos) {
      cos /= sin;
      sin = 1;
      if (invert) {
        xy[i1][0] = lerp(xy[corner][0], xy[i2][0], cos);
        xy[i2][0] = xy[i1][0];
      }
    } else if (cos > sin) {
      sin /= cos;
      cos = 1;
      if (!invert) {
        xy[i2][1] = lerp(xy[corner][1], xy[i2][1], sin);
        xy[i3][1] = xy[i2][1];
      }
    } else {
      cos = 1;
      sin = 1;
    }
    if (!invert) xy[i3][0] = lerp(xy[corner][0], xy[i2][0], cos);
    else xy[i1][1] = lerp(xy[corner][1], xy[i2][1], sin);
    return;
  }
  if (cos > sin) {
    sin /= cos;
    cos = 1;
    if (!invert) {
      xy[i1][1] = lerp(xy[corner][1], xy[i2][1], sin);
      xy[i2][1] = xy[i1][1];
    }
  } else if (sin > cos) {
    cos /= sin;
    sin = 1;
    if (invert) {
      xy[i2][0] = lerp(xy[corner][0], xy[i2][0], cos);
      xy[i3][0] = xy[i2][0];
    }
  } else {
    cos = 1;
    sin = 1;
  }
  if (invert) xy[i3][1] = lerp(xy[corner][1], xy[i2][1], sin);
  else xy[i1][0] = lerp(xy[corner][0], xy[i2][0], cos);
}

/** Image.RadialCut：回傳 false 表示這一塊完全沒填（不畫） */
function radialCut(xy: V2[], uv: V2[], fill: number, invert: boolean, corner: number): boolean {
  if (fill < 0.001) return false;
  if ((corner & 1) === 1) invert = !invert;
  if (!invert && fill > 0.999) return true;
  let angle = Math.min(1, Math.max(0, fill));
  if (invert) angle = 1 - angle;
  angle *= Math.PI / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  radialCutPoints(xy, cos, sin, invert, corner);
  radialCutPoints(uv, cos, sin, invert, corner);
  return true;
}

/** Image.GenerateFilledSprite */
export function filledMesh(rect: Rect, sprite: SpriteForMesh, image: ImageForMesh, pivot: { x: number; y: number }): UIMesh {
  const mesh = emptyMesh();
  const amount = image.m_FillAmount ?? 1;
  if (amount < 0.001) return mesh;
  const method = image.m_FillMethod ?? 0;
  const origin = image.m_FillOrigin ?? 0;
  const clockwise = !!image.m_FillClockwise;
  const v = drawingDimensions(rect, sprite, !!image.m_PreserveAspect, pivot);
  let [tx0, ty0, tx1, ty1] = outerUV(sprite);
  if (method === 0) {
    const fill = (tx1 - tx0) * amount;
    if (origin === 1) {
      v[0] = v[2] - (v[2] - v[0]) * amount;
      tx0 = tx1 - fill;
    } else {
      v[2] = v[0] + (v[2] - v[0]) * amount;
      tx1 = tx0 + fill;
    }
  } else if (method === 1) {
    const fill = (ty1 - ty0) * amount;
    if (origin === 1) {
      v[1] = v[3] - (v[3] - v[1]) * amount;
      ty0 = ty1 - fill;
    } else {
      v[3] = v[1] + (v[3] - v[1]) * amount;
      ty1 = ty0 + fill;
    }
  }
  const quad = (): [V2[], V2[]] => [
    [[v[0], v[1]], [v[0], v[3]], [v[2], v[3]], [v[2], v[1]]],
    [[tx0, ty0], [tx0, ty1], [tx1, ty1], [tx1, ty0]],
  ];
  if (amount < 1 && method !== 0 && method !== 1) {
    if (method === 2) {
      const [xy, uv] = quad();
      if (radialCut(xy, uv, amount, clockwise, origin)) addQuadPoints(mesh, xy, uv);
    } else if (method === 3) {
      for (let side = 0; side < 2; side++) {
        const even = origin > 1 ? 1 : 0;
        let fy0: number, fy1: number, fx0: number, fx1: number;
        if (origin === 0 || origin === 2) {
          fy0 = 0;
          fy1 = 1;
          [fx0, fx1] = side === even ? [0, 0.5] : [0.5, 1];
        } else {
          fx0 = 0;
          fx1 = 1;
          [fy0, fy1] = side === even ? [0.5, 1] : [0, 0.5];
        }
        const xy: V2[] = [
          [lerp(v[0], v[2], fx0), lerp(v[1], v[3], fy0)],
          [lerp(v[0], v[2], fx0), lerp(v[1], v[3], fy1)],
          [lerp(v[0], v[2], fx1), lerp(v[1], v[3], fy1)],
          [lerp(v[0], v[2], fx1), lerp(v[1], v[3], fy0)],
        ];
        const uv: V2[] = [
          [lerp(tx0, tx1, fx0), lerp(ty0, ty1, fy0)],
          [lerp(tx0, tx1, fx0), lerp(ty0, ty1, fy1)],
          [lerp(tx0, tx1, fx1), lerp(ty0, ty1, fy1)],
          [lerp(tx0, tx1, fx1), lerp(ty0, ty1, fy0)],
        ];
        const val = clockwise ? amount * 2 - side : amount * 2 - (1 - side);
        if (radialCut(xy, uv, Math.min(1, Math.max(0, val)), clockwise, (side + origin + 3) % 4)) addQuadPoints(mesh, xy, uv);
      }
    } else if (method === 4) {
      for (let corner = 0; corner < 4; corner++) {
        const [fx0, fx1] = corner < 2 ? [0, 0.5] : [0.5, 1];
        const [fy0, fy1] = corner === 0 || corner === 3 ? [0, 0.5] : [0.5, 1];
        const xy: V2[] = [
          [lerp(v[0], v[2], fx0), lerp(v[1], v[3], fy0)],
          [lerp(v[0], v[2], fx0), lerp(v[1], v[3], fy1)],
          [lerp(v[0], v[2], fx1), lerp(v[1], v[3], fy1)],
          [lerp(v[0], v[2], fx1), lerp(v[1], v[3], fy0)],
        ];
        const uv: V2[] = [
          [lerp(tx0, tx1, fx0), lerp(ty0, ty1, fy0)],
          [lerp(tx0, tx1, fx0), lerp(ty0, ty1, fy1)],
          [lerp(tx0, tx1, fx1), lerp(ty0, ty1, fy1)],
          [lerp(tx0, tx1, fx1), lerp(ty0, ty1, fy0)],
        ];
        const val = clockwise ? amount * 4 - ((corner + origin) % 4) : amount * 4 - (3 - ((corner + origin) % 4));
        if (radialCut(xy, uv, Math.min(1, Math.max(0, val)), clockwise, (corner + 2) % 4)) addQuadPoints(mesh, xy, uv);
      }
    }
    return mesh;
  }
  const [xy, uv] = quad();
  addQuadPoints(mesh, xy, uv);
  return mesh;
}

/**
 * Image.OnPopulateMesh。
 * canvasReferencePixelsPerUnit 是 Canvas.referencePixelsPerUnit（CanvasScaler 的 m_ReferencePixelsPerUnit，level1 都是 100）。
 */
export function imageMesh(
  rect: Rect,
  pivot: { x: number; y: number },
  image: ImageForMesh,
  sprite: SpriteForMesh | null,
  canvasReferencePixelsPerUnit: number,
): UIMesh {
  if (!sprite) return graphicMesh(rect);
  const pixelsPerUnit = sprite.m_PixelsToUnits / canvasReferencePixelsPerUnit;
  const multiplied = pixelsPerUnit * image.m_PixelsPerUnitMultiplier; // 反序列化的值不經 setter，不會夾到 0.01
  const hasBorder = sprite.m_Border.x ** 2 + sprite.m_Border.y ** 2 + sprite.m_Border.z ** 2 + sprite.m_Border.w ** 2 > 0;
  switch (image.m_Type) {
    case 0: {
      const mesh = simpleMesh(rect, sprite, !!image.m_PreserveAspect, pivot);
      if (image.m_UseSpriteMesh) mesh.unsupported = 'useSpriteMesh';
      return mesh;
    }
    case 1:
      return hasBorder ? slicedMesh(rect, sprite, !!image.m_FillCenter, multiplied) : simpleMesh(rect, sprite, false, pivot);
    case 2:
      return tiledMesh(rect, sprite, !!image.m_FillCenter, multiplied, hasBorder);
    case 3:
      return filledMesh(rect, sprite, image, pivot);
    default:
      // 四種 Type 都已涵蓋；這裡只剩防呆（照 Simple 畫）
      return simpleMesh(rect, sprite, !!image.m_PreserveAspect, pivot);
  }
}

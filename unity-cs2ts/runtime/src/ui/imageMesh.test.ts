// imageMesh.ts 的測試。期望值照 uGUI Image.cs（反編譯原版 build 的 UnityEngine.UI.dll）的演算法手算，每條註明怎麼算的。
import { describe, expect, it } from 'vitest';
import { drawingDimensions, imageMesh, roundToInt, type ImageForMesh, type SpriteForMesh } from './imageMesh';

// UISprite（Unity 內建，0d 從 build 匯入）：32×32、邊框 10、ppu 200、沒有 padding
const uiSprite: SpriteForMesh = {
  m_Rect: { x: 0, y: 0, width: 32, height: 32 },
  m_Border: { x: 10, y: 10, z: 10, w: 10 },
  m_PixelsToUnits: 200,
  textureRect: { x: 0, y: 0, width: 32, height: 32 },
  textureRectOffset: { x: 0, y: 0 },
  textureWidth: 32,
  textureHeight: 32,
};
const sliced: ImageForMesh = { m_Type: 1, m_PreserveAspect: 0, m_FillCenter: 1, m_UseSpriteMesh: 0, m_PixelsPerUnitMultiplier: 1 };
const simple: ImageForMesh = { ...sliced, m_Type: 0 };
const center = { x: 0.5, y: 0.5 };

describe('Image 網格（uGUI Image.OnPopulateMesh）', () => {
  it('Sliced：pixelsPerUnit = 200 / 100 = 2，邊框 10 px → 5 個 UI 單位；9 個四邊形', () => {
    const mesh = imageMesh({ x: -50, y: -20, width: 100, height: 40 }, center, sliced, uiSprite, 100);
    expect(mesh.indices).toHaveLength(9 * 6);
    const xs = [...new Set(mesh.positions.filter((_, i) => i % 2 === 0))].sort((a, b) => a - b);
    const ys = [...new Set(mesh.positions.filter((_, i) => i % 2 === 1))].sort((a, b) => a - b);
    expect(xs).toEqual([-50, -45, 45, 50]);
    expect(ys).toEqual([-20, -15, 15, 20]);
    // 內框 UV = (10/32, 22/32)
    const us = [...new Set(mesh.uvs.filter((_, i) => i % 2 === 0))].sort((a, b) => a - b);
    expect(us).toEqual([0, 10 / 32, 22 / 32, 1]);
  });

  it('Sliced：rect 6×6 比左右邊框加起來（5 + 5）還小，邊框等比縮成 3；中間一欄寬度 0，2022.3 照樣加（沒有 6000.0 的 UUM-71372 修正）', () => {
    const mesh = imageMesh({ x: -3, y: -3, width: 6, height: 6 }, center, sliced, uiSprite, 100);
    expect(mesh.indices).toHaveLength(9 * 6);
    expect([...new Set(mesh.positions)].sort((a, b) => a - b)).toEqual([-3, 0, 3]);
  });

  it('Sliced：m_PixelsPerUnitMultiplier 3 → 邊框 10 / (2 × 3)', () => {
    const mesh = imageMesh({ x: -50, y: -20, width: 100, height: 40 }, center, { ...sliced, m_PixelsPerUnitMultiplier: 3 }, uiSprite, 100);
    const xs = [...new Set(mesh.positions.filter((_, i) => i % 2 === 0))].sort((a, b) => a - b);
    expect(xs[1]).toBeCloseTo(-50 + 10 / 6, 10);
  });

  it('Sliced 但 fillCenter 關掉：8 個四邊形', () => {
    const mesh = imageMesh({ x: -50, y: -20, width: 100, height: 40 }, center, { ...sliced, m_FillCenter: 0 }, uiSprite, 100);
    expect(mesh.indices).toHaveLength(8 * 6);
  });

  it('沒有 sprite：Graphic 的整個 rect，uv 0–1', () => {
    const mesh = imageMesh({ x: -10, y: -5, width: 20, height: 10 }, center, simple, null, 100);
    expect(mesh.positions).toEqual([-10, -5, -10, 5, 10, 5, 10, -5]);
    expect(mesh.uvs).toEqual([0, 0, 0, 1, 1, 1, 1, 0]);
  });

  it('Simple + preserveAspect：200×100 的 sprite 放進 100×100，高變 50、依 pivot 置中', () => {
    const wide: SpriteForMesh = { ...uiSprite, m_Rect: { x: 0, y: 0, width: 200, height: 100 }, m_Border: { x: 0, y: 0, z: 0, w: 0 }, textureRect: { x: 0, y: 0, width: 200, height: 100 }, textureWidth: 200, textureHeight: 100 };
    const [x0, y0, x1, y1] = drawingDimensions({ x: -50, y: -50, width: 100, height: 100 }, wide, true, center);
    expect([x0, y0, x1, y1]).toEqual([-50, -25, 50, 25]);
  });

  it('Simple 有 padding：level1 的 title_white_en（原版 sprite 範圍 1280×720，有圖的部分 1075.9×131.9，偏移 (102.08, 294.08)）', () => {
    // 數值是原版 build 的（0b rebase_sprites）。AssetRipper 匯出成 1075.9×131.9 的範圍，會被拉成 1280×720
    const title: SpriteForMesh = {
      m_Rect: { x: 0, y: 0, width: 1280, height: 720 },
      m_Border: { x: 0, y: 0, z: 0, w: 0 },
      m_PixelsToUnits: 100,
      textureRect: { x: 102.07611846923828, y: 294.07611083984375, width: 1075.8970947265625, height: 131.89712524414062 },
      textureRectOffset: { x: 102.07611846923828, y: 294.07611083984375 },
      textureWidth: 1280,
      textureHeight: 720,
    };
    // title 的 RectTransform 是 1280×720、pivot 置中，所以畫出來的四邊形 = textureRect 移到以中心為原點
    const [x0, y0, x1, y1] = drawingDimensions({ x: -640, y: -360, width: 1280, height: 720 }, title, false, center);
    expect(x0).toBeCloseTo(-640 + 102.076, 2);
    expect(y0).toBeCloseTo(-360 + 294.076, 2);
    expect(x1 - x0).toBeCloseTo(1075.897, 2);
    expect(y1 - y0).toBeCloseTo(131.897, 2);
  });

  it('Filled 水平填 0.5、從左（origin 0）：右邊界與 u 都只到一半', () => {
    const mesh = imageMesh({ x: 0, y: 0, width: 100, height: 40 }, { x: 0, y: 0 }, { ...simple, m_Type: 3, m_FillMethod: 0, m_FillAmount: 0.5, m_FillOrigin: 0, m_FillClockwise: 1 }, uiSprite, 100);
    expect(mesh.positions).toEqual([0, 0, 0, 40, 50, 40, 50, 0]);
    expect(mesh.uvs).toEqual([0, 0, 0, 1, 0.5, 1, 0.5, 0]);
  });

  it('Filled 水平填 0.25、從右（origin 1）', () => {
    const mesh = imageMesh({ x: 0, y: 0, width: 100, height: 40 }, { x: 0, y: 0 }, { ...simple, m_Type: 3, m_FillMethod: 0, m_FillAmount: 0.25, m_FillOrigin: 1, m_FillClockwise: 1 }, uiSprite, 100);
    expect(mesh.positions).toEqual([75, 0, 75, 40, 100, 40, 100, 0]);
    expect(mesh.uvs).toEqual([0.75, 0, 0.75, 1, 1, 1, 1, 0]);
  });

  it('Filled Radial90 填 0.5、左下起、順時針：RadialCut 角度 π/4、cos = sin → 第 4 點拉到右上，剩左上三角形', () => {
    const mesh = imageMesh({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0 }, { ...simple, m_Type: 3, m_FillMethod: 2, m_FillAmount: 0.5, m_FillOrigin: 0, m_FillClockwise: 1 }, uiSprite, 100);
    // 倍精度下 cos(π/4) 比 sin(π/4) 大 1 ulp，走另一個分支，結果差在 1e-16（C# 用 float，未必相等，畫面一樣）
    [0, 0, 0, 1, 1, 1, 1, 1].forEach((v, i) => expect(mesh.positions[i]).toBeCloseTo(v, 12));
  });

  it('Filled 填 0（< 0.001）不畫', () => {
    const mesh = imageMesh({ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0 }, { ...simple, m_Type: 3, m_FillMethod: 4, m_FillAmount: 0 }, uiSprite, 100);
    expect(mesh.indices).toEqual([]);
  });

  it('Mathf.RoundToInt 剛好 .5 時取偶數（C# Math.Round 預設）', () => {
    expect([0.5, 1.5, 2.5, 2.4, 2.6, -0.5].map(roundToInt)).toEqual([0, 2, 2, 2, 3, 0]) // RoundToInt 回傳 int，沒有負零;
  });

  it('Tiled：level2 血條底的 Health（icon_bg 285×131、border L123/R127、ppu 200／CanvasScaler 100 ×1 → multiplied 2；rect 207.7×65.4 pivot 0.5）', () => {
    // Image.cs:751-915 GenerateTiledSprite，值對照 Claude Code 10/6 float32 手算：
    //   中心格 num＝(285−123−127)/2＝17.5、num2＝131/2＝65.5
    //   border/2 → x＝61.5、num3＝207.7−63.5＝144.2、y＝0、num4＝65.4
    //   cols＝ceil(82.7/17.5)＝5、rows＝ceil(65.4/65.5)＝1
    //   quad＝中心 5＋左右帶 2×1＋上下帶 2×5＋四角 4＝21 → 84 頂點、126 索引
    const iconBg: SpriteForMesh = {
      m_Rect: { x: 0, y: 0, width: 285, height: 131 },
      m_Border: { x: 123, y: 0, z: 127, w: 0 },
      m_PixelsToUnits: 200,
      textureRect: { x: 0, y: 0, width: 285, height: 131 },
      textureRectOffset: { x: 0, y: 0 },
      textureWidth: 285,
      textureHeight: 131,
    };
    const tiled: ImageForMesh = { m_Type: 2, m_PreserveAspect: 0, m_FillCenter: 1, m_UseSpriteMesh: 0, m_PixelsPerUnitMultiplier: 1 };
    const mesh = imageMesh({ x: -103.85, y: -32.7, width: 207.7, height: 65.4 }, center, tiled, iconBg, 100);
    expect(mesh.positions.length / 2).toBe(84);
    expect(mesh.indices.length).toBe(126);
    expect(mesh.unsupported).toBeUndefined();
    // 中心第一格：x 61.5−103.85＝−42.35 起、寬 17.5
    expect(mesh.positions[0]).toBeCloseTo(-42.35, 3);
    expect(mesh.positions[4] - mesh.positions[0]).toBeCloseTo(17.5, 3);
    // 最後一欄中心格（q4）：px1 被截到 144.2 → x 27.65→40.35；uv 截短
    const o = 4 * 8;
    expect(mesh.positions[o]).toBeCloseTo(27.65, 3); // 131.5 − 103.85
    expect(mesh.positions[o + 4]).toBeCloseTo(40.35, 3); // 144.2 − 103.85
    // uvMax.x＝inner.x＋(inner.z−inner.x)×(144.2−131.5)/(149−131.5)，inner＝(123/285, 0, 158/285, 1)
    expect(mesh.uvs[o + 4]).toBeCloseTo(0.5207017, 5);
    // 列截短：uvMax.y＝0＋(1−0)×65.4/65.5＝0.9984733（第 2 頂點的 v）
    expect(mesh.uvs[o + 3]).toBeCloseTo(0.9984733, 5);
  });
});

// 對應 UnityEngine.RectTransform（引擎內建，沒有 C# 原始碼）：錨點、pivot、sizeDelta、anchoredPosition 換算成矩形與位置。
// 公式用存檔資料驗證：build 裡每個 RectTransform 都存了算好的 m_LocalPosition，見 rectTransform.test.ts。

export interface Vec2 {
  x: number;
  y: number;
}

/** 矩形，座標在物件自己的區域空間（原點是 pivot），跟 RectTransform.rect 一樣 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RectTransformData {
  m_AnchorMin: Vec2;
  m_AnchorMax: Vec2;
  m_AnchoredPosition: Vec2;
  m_SizeDelta: Vec2;
  m_Pivot: Vec2;
}

/** 父物件不是 RectTransform（或沒有父物件）時，錨點相對的是一個大小為 0 的矩形 */
export const ZERO_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * 子物件在父物件區域空間裡的 pivot 位置（= m_LocalPosition 的 x、y），以及子物件自己的 rect。
 *
 * 錨點框 = 父 rect 依 anchorMin／anchorMax 取的範圍；大小 = 錨點框大小 + sizeDelta；
 * pivot 位置 = 錨點框依 pivot 內插的點 + anchoredPosition。
 */
export function layoutRect(parent: Rect, rt: RectTransformData): { localPosition: Vec2; rect: Rect } {
  const minX = parent.x + rt.m_AnchorMin.x * parent.width;
  const minY = parent.y + rt.m_AnchorMin.y * parent.height;
  const maxX = parent.x + rt.m_AnchorMax.x * parent.width;
  const maxY = parent.y + rt.m_AnchorMax.y * parent.height;
  const width = maxX - minX + rt.m_SizeDelta.x;
  const height = maxY - minY + rt.m_SizeDelta.y;
  return {
    localPosition: {
      x: minX + (maxX - minX) * rt.m_Pivot.x + rt.m_AnchoredPosition.x,
      y: minY + (maxY - minY) * rt.m_Pivot.y + rt.m_AnchoredPosition.y,
    },
    rect: { x: -width * rt.m_Pivot.x, y: -height * rt.m_Pivot.y, width, height },
  };
}

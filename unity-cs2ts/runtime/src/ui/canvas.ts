// 對應 uGUI 的 UnityEngine.UI.CanvasScaler（uGUI 6000.0 分支 com.unity.ugui/Runtime/UGUI/UI/Core/Layout/CanvasScaler.cs）
// 與引擎內建的 Canvas（Screen Space - Camera 的擺放方式，沒有原始碼）。

export interface CanvasScalerData {
  m_UiScaleMode: number; // 0 ConstantPixelSize、1 ScaleWithScreenSize、2 ConstantPhysicalSize
  m_ScaleFactor?: number;
  m_ReferenceResolution: { x: number; y: number };
  m_ScreenMatchMode: number; // 0 MatchWidthOrHeight、1 Expand、2 Shrink
  m_MatchWidthOrHeight: number;
  m_ReferencePixelsPerUnit: number;
}

/**
 * 手機寬版（Jason 10/15 定，原版沒有）：畫面比 16:9 寬時不補黑邊、攝影機照實際比例拉寬（viewer/main.ts 的 fit）。
 * 這時 ScaleWithScreenSize 的 Canvas 一律照 Expand 算（取寬高比例的小者），高度永遠是參考解析度的 1080，
 * 多出來的寬度留在兩側；照原本的 match 值算（多半是 0＝看寬度），UI 會跟著寬度放大、上下超出畫面。
 */
let wideLayout = false;
export function setWideLayout(on: boolean): void {
  wideLayout = on;
}
export function isWideLayout(): boolean {
  return wideLayout;
}

/**
 * 寬版刻意移到兩側的節點（game/wideLayout.ts 登記）：加寬過的 World Space Canvas（底下貼邊錨點的 UI 照錨點移到螢幕邊）、
 * 往兩側推的 HUD。它們整棵子樹會落在 16:9 外面那兩條裡，繪製端的「16:9 外面不畫」不能套到它們
 *（render/sceneRenderer.ts 的 wideExempted）。
 */
const wideMoved = new WeakSet<object>();
let wideMovedGeneration = 0;
export function markWideMoved(node: object): void {
  if (wideMoved.has(node)) return;
  wideMoved.add(node);
  wideMovedGeneration++;
}
export function isWideMoved(node: object): boolean {
  return wideMoved.has(node);
}
export function wideMovedGenerationOf(): number {
  return wideMovedGeneration;
}

/** CanvasScaler.HandleScaleWithScreenSize 與 HandleConstantPixelSize 算出的 scaleFactor */
export function canvasScaleFactor(scaler: CanvasScalerData | undefined, screenW: number, screenH: number): number {
  if (!scaler) return 1;
  if (scaler.m_UiScaleMode === 0) return scaler.m_ScaleFactor ?? 1;
  if (scaler.m_UiScaleMode !== 1) return 1; // ConstantPhysicalSize：這個遊戲沒有用到（level1 只有 0 與 1）
  const ref = scaler.m_ReferenceResolution;
  if (wideLayout && screenW * ref.y > screenH * ref.x) return Math.min(screenW / ref.x, screenH / ref.y);
  switch (scaler.m_ScreenMatchMode) {
    case 0: {
      // 在對數空間內插，寬高比不同時才看得出差別（kLogBase = 2）
      const logW = Math.log2(screenW / ref.x);
      const logH = Math.log2(screenH / ref.y);
      return Math.pow(2, logW + (logH - logW) * scaler.m_MatchWidthOrHeight);
    }
    case 1:
      return Math.min(screenW / ref.x, screenH / ref.y);
    default:
      return Math.max(screenW / ref.x, screenH / ref.y);
  }
}

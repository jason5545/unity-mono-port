// 網格重產的偵測（純函式，方便單元測試；sceneRenderer 每格呼叫）。
// 時機照 TMP：屬性變更（TMP_Text 各 setter → m_havePropertiesChanged → SetVerticesDirty／SetLayoutDirty）與
// rect 尺寸變更（OnRectTransformDimensionsChange）在下一次繪製前重產（OnPreRenderCanvas／OnPreRenderObject）；
// Image 同理（Graphic 的 setter → SetVerticesDirty，rect 變更 → OnRectTransformDimensionsChange → 重產）。
// 遊戲腳本是直接改元件欄位的（m_text、m_fontColor…），沒有 setter 可攔，所以每格把「會影響網格的輸入」
// 整份序列化成 key 比對，變了就重產。key 用整個元件的 JSON：TMP／Image 讀的欄位遍布整個元件
// （GenerateTextMesh 單函式就讀八十幾個欄位），逐欄位列舉會漏；元件是 JSON 資料、腳本只改既有欄位的值
// （key 順序穩定），stringify 結果可直接比對。
//
// 位置（anchoredPosition）不在 key 裡：頂點座標相對自己的 rect，位置變更不影響網格內容（TMP 也是這樣，
// OnRectTransformDimensionsChange 只管尺寸）。rect 本身會隨尺寸／pivot 變，所以整個放進去。

import type { ColorRGBA, ComponentData } from '../unity/types';

export interface RefreshInput {
  /** RectTransform.rect（自己的區域空間，原點 pivot） */
  rect: { x: number; y: number; width: number; height: number };
  /** transform.lossyScale.y：TMP 的 uv0.w（TMPro_UGUI_Private.cs:4068-4090） */
  lossyScaleY: number;
  /** Canvas.scaleFactor（同上）；不在 Canvas 底下（3D）是 null */
  canvasScaleFactor: number | null;
  /** CanvasRenderer.GetColor（Selectable 的 ColorTint 存在 CanvasRenderer 上）；沒有 CanvasRenderer 是 null */
  tint: ColorRGBA | null;
  /** 往上 CanvasGroup 的 alpha 乘積（頂點 alpha 乘上它） */
  canvasAlpha: number;
  /** 啟用狀態不影響網格內容，但未啟用時 rect 可能是沒被自動排版處理過的舊值；啟用變化時重產一次 */
  active: boolean;
  enabled: boolean;
  /** Mask 的 stencil 狀態簽章（ui/mask.ts 的 stencilKey；含 unmask 材質）。狀態變了要換材質重產——
   *  Unity 是 SetMaterialDirty → Canvas 重建（Mask.cs:75、89，MaskableGraphic.cs:251-257 的 RecalculateMasking）。
   * 沒有 Mask 時是空字串 */
  stencil?: string;
  /** RectMask2D 掛勾且 valid 時是 '1'，否則 '0'（ui/rectMask2d.ts）。掛勾狀態變了要換材質
   *  （手寫換帶 clipKey 的）與換 K3 variant（UNITY_UI_CLIP_RECT keyword 在 createProgram 時定）——
   *  Unity 是 EnableRectClipping 寫 canvasRenderer → 重建。裁切 rect 值變動不重產（每格更新 uniform） */
  clip?: string;
  /** TMP 網格掛勾的版本（vertexHooks.ts，第 2 輪）：版本變了就重產（裁決 3）。沒有掛勾時是 '' 或不給，key 跟沒有這個欄位時一樣 */
  hook?: string;
  /** 繪製端每格直接讀的物件（K3 shader 的執行期材質的 m_Colors：fillCbuffers 每格從同一份 record 取值）。
   *  key 裡只記成佔位字，值變了不重產：Unity 的 Material.SetVector／SetColor 也只改常數，不讓 Graphic 重建網格。
   *  MT2 手牌的卡圖（AnimateCardEffects 每格 SetVector 卡圖分層的 _LayerNTransUVOrigins）原本因此每格重產（10/18 量） */
  live?: object | null;
}

/** TMP（UGUI／3D）與 Image 共用：輸入任一項變更 → key 不同 → 重產 */
export function meshRefreshKey(comp: ComponentData, i: RefreshInput): string {
  // 掛勾欄只在有掛勾時才放進 key：沒有掛勾的元件，key 字串跟加這個欄位之前完全一樣（meshRefresh.test.ts 不受影響）
  const hook = i.hook ? [i.hook] : [];
  const live = i.live;
  return JSON.stringify(
    [
      comp,
      i.rect.x,
      i.rect.y,
      i.rect.width,
      i.rect.height,
      i.lossyScaleY,
      i.canvasScaleFactor,
      i.tint,
      i.canvasAlpha,
      i.active,
      i.enabled,
      i.stencil ?? '',
      i.clip ?? '0',
      ...hook,
    ],
    live ? (_k, v) => (v === live ? '~live' : v) : undefined,
  );
}

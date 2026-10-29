// 元件的種類：繪製端、遮罩、RectMask2D、排版判斷「這是哪一種元件」用。
// 一般就是腳本類別名（uGUI、TMP 也是腳本）或原生元件的 type。遊戲自己繼承 TMP 文字元件的類別（MT2 卡名的 ExtendedTextMeshProUGUI）
// 換成它繼承的 TMP 類別：原版的繪製、Mask、裁切、ILayoutElement 都是基底 TextMeshProUGUI 做的，子類別只覆寫 Rebuild 去改頂點
// （WarpText 經 UpdateVertexData 的掛勾蓋進網格，csport/unityTmp.ts）。
// 基底鏈來自轉換器 --hierarchy 的輸出（scenes/hierarchy.json，直接基底在前），viewer/boot.ts 載入時登記。
// 只換 TMP：Image、RawImage 的子類別多半自己覆寫 OnPopulateMesh，照 Image 畫會畫錯，MT2 也沒有。

import type { ComponentData } from './types';

/** 繼承下來要照基底處理的類別 */
const INHERITED_KINDS = new Set(['TextMeshProUGUI', 'TextMeshPro']);

let hierarchy: Record<string, string[]> = {};
const cache = new Map<string, string>();

/** 登記類別 → 基底鏈（轉換器 --hierarchy 的輸出） */
export function setClassHierarchy(h: Record<string, string[]> | null | undefined): void {
  hierarchy = h ?? {};
  cache.clear();
}

/** 類別名的種類：本身或基底鏈上最近的 TMP 類別；都不是就是自己 */
export function classKind(cls: string): string {
  if (INHERITED_KINDS.has(cls)) return cls;
  let k = cache.get(cls);
  if (k === undefined) {
    k = (hierarchy[cls] ?? []).find((b) => INHERITED_KINDS.has(b)) ?? cls;
    cache.set(cls, k);
  }
  return k;
}

/** 元件的種類（腳本類別或原生 type，見檔頭） */
export function componentKind(comp: ComponentData): string {
  return classKind(comp.script?.class ?? comp.type);
}

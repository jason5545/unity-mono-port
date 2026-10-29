// TextContext 的共用算法（0d 驗收 4 的 ctx 從這裡出）：繪製端（render/sceneRenderer）與 uGUI 排版端
// （ui/layout 的 external，經 viewer 的 World services.layout）都用這裡，不各算各的。
// 數值來源：rect＝RectTransform.rect（SceneGraph.layout 算過）、lossyScaleY＝transform.lossyScale.y
// （世界矩陣 y 軸的長度）、canvas＝往上最近的 Canvas（renderMode／scaleFactor／有沒有指定攝影機）、
// isOrthographic（只有 3D 版 TextMeshPro 用攝影機的值；UGUI 版原始碼固定 true）、
// linearColorSpace＝QualitySettings.activeColorSpace == Linear（本專案 linear，assets/project.json m_ActiveColorSpace 1）。

import type { ComponentData } from '../unity/types';
import { getPreferredHeight, getPreferredWidth } from './index';
import type { TextAssets, TextContext, TmpComponentData } from './types';

/** textContextOf 要的節點資料（結構型別；unity/scene 的 SceneNode 直接符合，這個模組不依賴 three.js） */
export interface TextContextNode {
  rect: { x: number; y: number; width: number; height: number };
  world: { elements: ArrayLike<number> };
  canvas: { renderMode: number; scaleFactor: number; data: ComponentData } | null;
}

export interface TextContextEnv {
  /** 使用中攝影機是否正交；只有 3D 版（TextMeshPro）用得到（UGUI 版原始碼固定 true） */
  orthographic: boolean;
  /** QualitySettings.activeColorSpace == Linear */
  linearColorSpace: boolean;
}

/** 從場景節點算 TextContext。UGUI／3D 的判定照 index.ts 的 prepare：script.class 不是 'TextMeshPro' 就走 UGUI 版 */
export function textContextOf(node: TextContextNode, comp: TmpComponentData, env: TextContextEnv): TextContext {
  const ui = (comp.script as { class?: string } | null)?.class !== 'TextMeshPro';
  const e = node.world.elements;
  const c = node.canvas;
  return {
    rect: node.rect,
    lossyScaleY: Math.hypot(e[4], e[5], e[6]),
    canvas: ui && c ? { renderMode: c.renderMode as 0 | 1 | 2, scaleFactor: c.scaleFactor, worldCameraAssigned: !!c.data.m_Camera } : null,
    isOrthographic: ui ? true : env.orthographic,
    linearColorSpace: env.linearColorSpace,
  };
}

/**
 * uGUI 排版（ui/layout.ts 的 external）用的偏好尺寸函式：檢視頁的 World services.layout.external 就是它。
 * min／flexible 由 layout.ts 自己回 0／−1（elementValue 的 TextMeshProUGUI 分支），這裡只算 preferred。
 */
export function makePreferredExternal(assets: TextAssets, env: TextContextEnv) {
  return (comp: ComponentData, node: TextContextNode, axis: 0 | 1): number =>
    axis === 0 ? getPreferredWidth(comp, textContextOf(node, comp, env), assets) : getPreferredHeight(comp, textContextOf(node, comp, env), assets);
}

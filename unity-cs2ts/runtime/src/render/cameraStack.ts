// built-in 繪製管線的攝影機（GraphicsSettings 與目前品質等級都沒有自訂管線時，Unity 用內建管線；MT2 是這種）。
// 哪幾台畫到螢幕、照什麼順序、每台畫哪些物件、畫之前怎麼清。URP（Diceomancer）不走這裡，見 sceneRenderer 的 pipeline。
//
// 規則（Unity 2022.3 文件 Camera 元件、Camera.depth、Camera.cullingMask、Camera.clearFlags、Canvas 的 Render Mode）：
//   - 啟用中（物件與元件）、沒有 targetTexture 的攝影機畫到螢幕，照 depth 由小到大，後畫的蓋在前面。
//     有 targetTexture 的先畫進各自的貼圖（targetCameras），清除與裁切規則同下。
//     depth 相同時的順序文件沒寫（未查證）：照場景樹順序（SceneGraph.cameras 的順序，先載入的場景在前）。
//   - 每台只畫圖層在 cullingMask 裡的物件。Screen Space - Camera 的 Canvas 只由它指定的那台畫（Canvas 的圖層也要在那台的 cullingMask 裡），
//     Overlay 的 Canvas 不屬於任何攝影機，全部攝影機畫完之後疊在最上面。
//   - clearFlags：1 Skybox、2 Solid Color（清顏色、深度與 stencil）、3 Depth only、4 Don't Clear；
//     只清 viewport（m_NormalizedViewPortRect，夾在 0～1）那一塊。
//   - 投影照 OpenGL 慣例（z ∈ [-1, 1]）：正交的半高是 orthographicSize，透視的 fieldOfView 是垂直視角，寬高比是 viewport 的像素寬高比。
//     view 照 Camera.worldToCameraMatrix：翻轉 z × 攝影機世界矩陣的反矩陣（Unity 攝影機看 +z，view 空間看 -z）。

import * as THREE from 'three';
import type { CameraInfo } from '../unity/scene';
import type { ComponentData } from '../unity/types';

/**
 * 專案用哪條繪製管線：目前品質等級的 customRenderPipeline，沒有就 GraphicsSettings 的 m_CustomRenderPipeline；都沒有是 built-in
 * （Unity 文件 GraphicsSettings.currentRenderPipeline）。project 是匯入器的 project.json（ProjectSettings 原樣轉的）
 */
export function renderPipelineOf(project: Record<string, unknown>): 'srp' | 'builtin' {
  type Q = { m_CurrentQuality?: number; m_QualitySettings?: { customRenderPipeline?: { guid?: string } | null }[] };
  const gs = (project.GraphicsSettings as { GraphicsSettings?: { m_CustomRenderPipeline?: { guid?: string } | null } } | undefined)?.GraphicsSettings;
  const qs = (project.QualitySettings as { QualitySettings?: Q } | undefined)?.QualitySettings;
  const level = qs?.m_QualitySettings?.[qs.m_CurrentQuality ?? 0];
  const srp = level?.customRenderPipeline?.guid ?? gs?.m_CustomRenderPipeline?.guid;
  return srp ? 'srp' : 'builtin';
}

export const CLEAR_SKYBOX = 1;
export const CLEAR_SOLID_COLOR = 2;
export const CLEAR_DEPTH = 3;
export const CLEAR_NOTHING = 4;

const FLIP_Z = new THREE.Matrix4().makeScale(1, 1, -1);

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function cameraEnabled(cam: CameraInfo): boolean {
  return cam.node.activeInHierarchy && (cam.data.m_Enabled as number) !== 0;
}

export function cameraDepth(cam: CameraInfo): number {
  return (cam.data.m_Depth as number | undefined) ?? 0;
}

/** Camera.cullingMask（無號 32 位元，m_Bits；沒有欄位時是 Everything） */
export function cullingMask(cam: CameraInfo): number {
  const bits = (cam.data.m_CullingMask as { m_Bits?: number } | undefined)?.m_Bits;
  return bits === undefined ? 0xffffffff : bits >>> 0;
}

export function inCullingMask(mask: number, layer: number): boolean {
  return ((mask >>> 0) & (1 << (layer & 31))) !== 0;
}

export function clearFlagsOf(cam: CameraInfo): number {
  return (cam.data.m_ClearFlags as number | undefined) ?? CLEAR_SKYBOX;
}

/** 畫到螢幕的攝影機，照畫的順序。hasTarget：這台有沒有 targetTexture（執行期設的，存在相容層） */
export function screenCameras(cameras: readonly CameraInfo[], hasTarget: (comp: ComponentData) => boolean): CameraInfo[] {
  return cameras
    .map((cam, i) => ({ cam, i }))
    .filter(({ cam }) => cameraEnabled(cam) && !hasTarget(cam.data))
    .sort((a, b) => cameraDepth(a.cam) - cameraDepth(b.cam) || a.i - b.i)
    .map(({ cam }) => cam);
}

/**
 * 有 targetTexture 的攝影機（啟用中），照 depth 由小到大、同 depth 照場景樹順序。繪製端在畫到螢幕的攝影機之前先把它們畫進各自的貼圖
 *（Unity 是全部攝影機一起照 depth 排；顯示 RenderTexture 的攝影機排在畫它的攝影機前面時，Unity 顯示的是上一格的內容，這裡沒照做）
 */
export function targetCameras<T>(cameras: readonly CameraInfo[], targetOf: (comp: ComponentData) => T | null): { cam: CameraInfo; target: T }[] {
  return cameras
    .map((cam, i) => ({ cam, i, target: cameraEnabled(cam) ? targetOf(cam.data) : null }))
    .filter((x): x is { cam: CameraInfo; i: number; target: T } => x.target != null)
    .sort((a, b) => cameraDepth(a.cam) - cameraDepth(b.cam) || a.i - b.i)
    .map(({ cam, target }) => ({ cam, target }));
}

/** viewport 的像素範圍（原點左下）。m_NormalizedViewPortRect 夾在 0～1 */
export function viewportPixels(cam: CameraInfo, w: number, h: number): PixelRect {
  const r = (cam.data.m_NormalizedViewPortRect as PixelRect | undefined) ?? { x: 0, y: 0, width: 1, height: 1 };
  const x0 = Math.min(1, Math.max(0, r.x));
  const y0 = Math.min(1, Math.max(0, r.y));
  const x1 = Math.min(1, Math.max(0, r.x + r.width));
  const y1 = Math.min(1, Math.max(0, r.y + r.height));
  const x = Math.round(x0 * w);
  const y = Math.round(y0 * h);
  return { x, y, width: Math.max(0, Math.round(x1 * w) - x), height: Math.max(0, Math.round(y1 * h) - y) };
}

/** 整個畫面都會被這台清掉顏色（Skybox 或 Solid Color、viewport 蓋滿）：排在它前面的攝影機畫什麼都看不到 */
export function coversScreen(cam: CameraInfo, w: number, h: number): boolean {
  const f = clearFlagsOf(cam);
  if (f !== CLEAR_SKYBOX && f !== CLEAR_SOLID_COLOR) return false;
  const vp = viewportPixels(cam, w, h);
  return vp.x === 0 && vp.y === 0 && vp.width === w && vp.height === h;
}

/** 從哪一台開始畫：最後一台蓋滿畫面的（之前的畫了也會被清掉）。沒有就是 0 */
export function firstVisibleCamera(cams: readonly CameraInfo[], w: number, h: number): number {
  for (let i = cams.length - 1; i >= 0; i--) if (coversScreen(cams[i], w, h)) return i;
  return 0;
}

/** Camera.projectionMatrix（OpenGL 慣例） */
export function projectionOf(cam: CameraInfo, aspect: number): THREE.Matrix4 {
  const n = cam.near;
  const f = cam.far;
  if (cam.orthographic) {
    const s = cam.orthographicSize;
    return new THREE.Matrix4().makeOrthographic(-s * aspect, s * aspect, s, -s, n, f);
  }
  const top = n * Math.tan((cam.fieldOfView * Math.PI) / 360);
  return new THREE.Matrix4().makePerspective(-top * aspect, top * aspect, top, -top, n, f);
}

/** Camera.worldToCameraMatrix */
export function viewOf(cam: CameraInfo): THREE.Matrix4 {
  return FLIP_Z.clone().multiply(cam.node.world.clone().invert());
}

/**
 * Overlay Canvas 的投影：螢幕像素（原點左下）直接對到 NDC，z 不裁（Overlay 的 UI 不受遠近平面影響；Unity 實際用的範圍未查證）。
 * view 是單位矩陣再翻 z（跟攝影機一樣「看 +z」），K3 shader 讀到的 unity_MatrixV 與 _WorldSpaceCameraPos 才有一致的意義。
 */
export function overlayProjection(w: number, h: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeOrthographic(0, w, h, 0, -1e6, 1e6);
}
export function overlayView(): THREE.Matrix4 {
  return FLIP_Z.clone();
}

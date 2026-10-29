// 螢幕點 → 射線、射線打 RectTransform 平面（事件系統 events.ts 與舊版滑鼠事件 mouseEvents.ts 共用）。
//
// 依據：
//   - Camera.ScreenPointToRay（原生）：透視攝影機的射線從攝影機出發、穿過螢幕點，起點在近平面上；正交是攝影機前方。
//     相容層 csport/unityCamera.ts 的 Camera_ScreenPointToRay$Vector3 是同一套數學（給腳本叫的版本）。
//   - RectTransformUtility.ScreenPointToRay（UnityCsReference 2022.3 Modules/UI/ScriptBindings/RectTransformUtility.cs）：
//     攝影機是 null（Overlay）時，射線是 (x, y, −100) 沿 +Z。
//   - RectTransformUtility.ScreenPointToWorldPointInRectangle（同檔）：平面是 Plane(rect.rotation * back, rect.position)，
//     射線跟它交不到（平行，或交點在起點後面）就是 false；Plane.Raycast 的 enter 要 ＞0。
//   - Camera.pixelRect：m_NormalizedViewPortRect × 螢幕大小，原點左下。
//
// 與原版的差異：
//   - 正交攝影機的起點放在攝影機平面上（不加 near），這是 10/16 以前 events.ts／mouseEvents.ts 的寫法，照舊保留：
//     兩邊的距離（Graphic 與 2D 碰撞器）都從這個起點量，比大小不受影響；只有「起點後面的不算」這條在近平面以內會不一樣。
//     透視攝影機照 Unity 放在近平面上。

import { Quaternion, Vector3 } from 'three';
import type { CameraInfo, SceneNode } from '../unity/scene';

export interface Ray3 {
  origin: Vector3;
  /** 單位向量 */
  dir: Vector3;
}

export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Camera.pixelRect（m_NormalizedViewPortRect × 螢幕大小，原點左下） */
export function cameraPixelRect(cam: CameraInfo, screenW: number, screenH: number): PixelRect {
  const n = (cam.data.m_NormalizedViewPortRect as { x: number; y: number; width: number; height: number } | undefined) ?? { x: 0, y: 0, width: 1, height: 1 };
  return { x0: n.x * screenW, y0: n.y * screenH, x1: (n.x + n.width) * screenW, y1: (n.y + n.height) * screenH };
}

/** 攝影機的位置與三個軸（Unity 攝影機看 +Z） */
export function cameraBasis(cam: CameraInfo): { pos: Vector3; right: Vector3; up: Vector3; forward: Vector3 } {
  const pos = new Vector3();
  const rot = new Quaternion();
  cam.node.world.decompose(pos, rot, new Vector3());
  return {
    pos,
    right: new Vector3(1, 0, 0).applyQuaternion(rot),
    up: new Vector3(0, 1, 0).applyQuaternion(rot),
    forward: new Vector3(0, 0, 1).applyQuaternion(rot),
  };
}

/** Camera.ScreenPointToRay（sx、sy 是螢幕像素，原點左下） */
export function cameraRay(cam: CameraInfo, sx: number, sy: number, screenW: number, screenH: number): Ray3 {
  const rect = cameraPixelRect(cam, screenW, screenH);
  const rw = rect.x1 - rect.x0;
  const rh = rect.y1 - rect.y0;
  const u = rw ? ((sx - rect.x0) / rw) * 2 - 1 : 0;
  const v = rh ? ((sy - rect.y0) / rh) * 2 - 1 : 0;
  const aspect = rh ? rw / rh : 1;
  const { pos, right, up, forward } = cameraBasis(cam);
  if (cam.orthographic) {
    const halfH = cam.orthographicSize;
    const halfW = halfH * aspect;
    return { origin: pos.addScaledVector(right, u * halfW).addScaledVector(up, v * halfH), dir: forward };
  }
  const t = Math.tan((cam.fieldOfView * Math.PI) / 360);
  const dir = forward.clone().addScaledVector(right, u * t * aspect).addScaledVector(up, v * t).normalize();
  // 起點在近平面上：沿 dir 走到 forward 方向的深度是 near
  return { origin: pos.addScaledVector(dir, cam.near / dir.dot(forward)), dir };
}

/** RectTransformUtility.ScreenPointToRay(null, p)：Overlay（沒有攝影機）的射線 */
export function overlayRay(sx: number, sy: number): Ray3 {
  return { origin: new Vector3(sx, sy, -100), dir: new Vector3(0, 0, 1) };
}

/** 螢幕點在不在攝影機的 viewport 裡（GraphicRaycaster.Raycast 先用 ScreenToViewportPoint 擋掉 0～1 以外的） */
export function inCameraViewport(cam: CameraInfo, sx: number, sy: number, screenW: number, screenH: number): boolean {
  const r = cameraPixelRect(cam, screenW, screenH);
  return sx >= r.x0 && sx <= r.x1 && sy >= r.y0 && sy <= r.y1;
}

/**
 * RectTransformUtility.ScreenPointToWorldPointInRectangle 的平面交點：平面過 node 的位置、法線是它的 back。
 * 交不到（平行，或在起點後面）回 null。node 剛好在射線起點上時 Unity 不查 Plane.Raycast，交點是起點。
 */
export function rayRectPlane(ray: Ray3, node: SceneNode): Vector3 | null {
  const pos = new Vector3().setFromMatrixPosition(node.world);
  const normal = new Vector3(0, 0, -1).transformDirection(node.world);
  const toRect = pos.clone().sub(ray.origin);
  if (toRect.lengthSq() === 0) return ray.origin.clone();
  const vdot = ray.dir.dot(normal);
  if (Math.abs(vdot) < 1e-9) return null;
  const enter = toRect.dot(normal) / vdot;
  if (!(enter > 0)) return null;
  return ray.origin.clone().addScaledVector(ray.dir, enter);
}

/** Camera.WorldToScreenPoint：世界點 → 螢幕像素（原點左下）與深度（沿攝影機前方離攝影機的距離） */
export function cameraWorldToScreen(cam: CameraInfo, p: Vector3, screenW: number, screenH: number): { x: number; y: number; z: number } {
  const rect = cameraPixelRect(cam, screenW, screenH);
  const rw = rect.x1 - rect.x0;
  const rh = rect.y1 - rect.y0;
  const aspect = rh ? rw / rh : 1;
  const { pos, right, up, forward } = cameraBasis(cam);
  const q = p.clone().sub(pos);
  const depth = q.dot(forward);
  let nx: number;
  let ny: number;
  if (cam.orthographic) {
    nx = q.dot(right) / (cam.orthographicSize * aspect);
    ny = q.dot(up) / cam.orthographicSize;
  } else {
    const t = Math.tan((cam.fieldOfView * Math.PI) / 360);
    nx = depth ? q.dot(right) / (depth * t * aspect) : 0;
    ny = depth ? q.dot(up) / (depth * t) : 0;
  }
  return { x: rect.x0 + ((nx + 1) / 2) * rw, y: rect.y0 + ((ny + 1) / 2) * rh, z: depth };
}

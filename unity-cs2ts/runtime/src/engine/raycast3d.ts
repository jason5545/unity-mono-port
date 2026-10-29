// Physics.RaycastAll／Physics.Raycast 的場景查詢（3D 碰撞器）：uGUI 的 PhysicsRaycaster（MT2 的房間與 SpawnPointUI 是
// BoxCollider ＋ GameUISelectable，掛在 GameCamera 上的 PhysicsRaycaster 打它們）與腳本的 Physics.Raycast 共用。
// 跟 engine/physics.ts（Rapier 的剛體模擬）分開：這裡只讀碰撞器的形狀與節點的世界矩陣，不需要物理世界。
//
// 依據：
//   - Unity 手冊 Physics.RaycastAll：起點在碰撞器裡面的那個碰撞器不算（「Raycasts will not detect Colliders for which
//     the Raycast origin is inside the Collider」）；Physics.queriesHitTriggers 預設 true（觸發器也打得到）。
//   - BoxCollider：m_Center、m_Size 在碰撞器本地空間，跟著節點的世界矩陣（含縮放、旋轉）變成有方向的盒子。
//   - SphereCollider：m_Center、m_Radius；半徑乘世界縮放三軸絕對值的最大者（Unity 的球不會被非等比縮放壓扁）。
//   - 距離是沿射線（單位方向）從起點量的長度；回傳照距離由近到遠（PhysicsRaycaster 的 RaycastHitComparer）。
//
// 還沒做（記在 notes）：CapsuleCollider、MeshCollider、TerrainCollider、WheelCollider。

import { Matrix3, Vector3 } from 'three';
import type { ComponentData } from '../unity/types';
import type { SceneGraph, SceneNode } from '../unity/scene';

export interface RaycastHit3D {
  node: SceneNode;
  collider: ComponentData;
  distance: number;
  point: Vector3;
  normal: Vector3;
}

/** Physics.DefaultRaycastLayers：IgnoreRaycast（第 2 層）以外的全部 */
export const DEFAULT_RAYCAST_LAYERS = ~(1 << 2);

const NOT_DONE = new Set(['CapsuleCollider', 'MeshCollider', 'TerrainCollider', 'WheelCollider']);

/**
 * Physics.RaycastAll(ray, maxDistance, layerMask)：dir 必須是單位向量。回傳照距離排好（近的在前）。
 * notes 有給就把還沒做的碰撞器種類記進去（碰到才記）。
 */
export function raycastAll3D(
  graph: SceneGraph,
  origin: Vector3,
  dir: Vector3,
  maxDistance: number,
  layerMask: number,
  notes?: Set<string>,
): RaycastHit3D[] {
  const hits: RaycastHit3D[] = [];
  for (const node of graph.nodes.values()) {
    if (!node.activeInHierarchy) continue;
    if ((layerMask & (1 << ((node.go.m_Layer as number) ?? 0))) === 0) continue;
    for (const comp of graph.components(node)) {
      if (!comp || comp.m_Enabled === 0) continue;
      let hit: { t: number; normal: Vector3 } | null = null;
      if (comp.type === 'BoxCollider') hit = rayBox(node, comp, origin, dir);
      else if (comp.type === 'SphereCollider') hit = raySphere(node, comp, origin, dir);
      else if (NOT_DONE.has(comp.type)) {
        notes?.add(`Physics 射線：${comp.type} 還沒做（打不到）`);
        continue;
      } else continue;
      if (!hit || hit.t > maxDistance) continue;
      hits.push({ node, collider: comp, distance: hit.t, point: origin.clone().addScaledVector(dir, hit.t), normal: hit.normal });
    }
  }
  hits.sort((a, b) => a.distance - b.distance);
  return hits;
}

/** Physics.Raycast(ray, out hit, maxDistance, layerMask)：最近的一個，沒有就 null */
export function raycast3D(graph: SceneGraph, origin: Vector3, dir: Vector3, maxDistance = Infinity, layerMask = DEFAULT_RAYCAST_LAYERS, notes?: Set<string>): RaycastHit3D | null {
  return raycastAll3D(graph, origin, dir, maxDistance, layerMask, notes)[0] ?? null;
}

/**
 * 射線打有方向的盒子：把射線換到碰撞器本地空間（方向不重新正規化，參數 t 跟世界空間一樣），用 slab 法。
 * 起點在盒子裡面（進入點 ＜0）不算。
 */
function rayBox(node: SceneNode, comp: ComponentData, origin: Vector3, dir: Vector3): { t: number; normal: Vector3 } | null {
  if (Math.abs(node.world.determinant()) < 1e-12) return null;
  const inv = node.world.clone().invert();
  const lo = origin.clone().applyMatrix4(inv);
  const ld = origin.clone().add(dir).applyMatrix4(inv).sub(lo);
  const c = (comp.m_Center as { x: number; y: number; z: number } | undefined) ?? { x: 0, y: 0, z: 0 };
  const s = (comp.m_Size as { x: number; y: number; z: number } | undefined) ?? { x: 1, y: 1, z: 1 };
  const o = [lo.x - c.x, lo.y - c.y, lo.z - c.z];
  const d = [ld.x, ld.y, ld.z];
  const h = [Math.abs(s.x) / 2, Math.abs(s.y) / 2, Math.abs(s.z) / 2];
  let tEnter = -Infinity;
  let tExit = Infinity;
  let axis = -1;
  let sign = 0;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]!) < 1e-12) {
      if (o[i]! < -h[i]! || o[i]! > h[i]!) return null;
      continue;
    }
    let t1 = (-h[i]! - o[i]!) / d[i]!;
    let t2 = (h[i]! - o[i]!) / d[i]!;
    let s1 = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      s1 = 1;
    }
    if (t1 > tEnter) {
      tEnter = t1;
      axis = i;
      sign = s1;
    }
    tExit = Math.min(tExit, t2);
    if (tEnter > tExit) return null;
  }
  if (axis < 0 || tEnter < 0) return null;
  const ln = new Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
  // 法線從本地換到世界：用反矩陣的轉置（非等比縮放也對）
  const normal = ln.applyMatrix3(new Matrix3().getNormalMatrix(node.world)).normalize();
  return { t: tEnter, normal };
}

/** 射線打球：世界空間的球心與半徑（半徑 × 世界縮放三軸絕對值的最大者）。起點在球裡面不算 */
function raySphere(node: SceneNode, comp: ComponentData, origin: Vector3, dir: Vector3): { t: number; normal: Vector3 } | null {
  const c = (comp.m_Center as { x: number; y: number; z: number } | undefined) ?? { x: 0, y: 0, z: 0 };
  const center = new Vector3(c.x, c.y, c.z).applyMatrix4(node.world);
  const m = node.world.elements;
  const scale = Math.max(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!), Math.hypot(m[8]!, m[9]!, m[10]!));
  const r = ((comp.m_Radius as number | undefined) ?? 0.5) * scale;
  const oc = origin.clone().sub(center);
  if (oc.lengthSq() < r * r) return null;
  const b = oc.dot(dir);
  const disc = b * b - (oc.lengthSq() - r * r);
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0) return null;
  return { t, normal: origin.clone().addScaledVector(dir, t).sub(center).normalize() };
}

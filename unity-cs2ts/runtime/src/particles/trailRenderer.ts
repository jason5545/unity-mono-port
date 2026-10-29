// TrailRenderer（2026/10/17）：物件移動時沿路留下的點，與畫出來的帶狀網格。
//
// 依據（Unity 2022.3 手冊 Trail Renderer component、TrailRenderer 腳本 API）：
//   - 物件移動時留下點：跟上一個留下的點距離超過 minVertexDistance 才留新的點；頭一直接在物件目前的位置。
//   - 每個點活 time 秒，超過就拿掉（尾巴縮短）。emitting 關掉時不再留新點，舊的照樣老化。
//   - Clear() 清掉全部點；AddPosition(p) 手動加一點（世界座標）。
//   - 寬度：widthCurve × widthMultiplier，曲線的 0 是頭、1 是尾；顏色：colorGradient，一樣頭 0 尾 1。
//     沿著拖尾的比例用距離算（LineRenderer 同；TrailRenderer 是不是照距離：未查證）。
//   - alignment View（0）：帶子朝向攝影機；textureMode Stretch（0）：u 頭 0、尾 1，v 橫跨寬度。
// 這個專案的做法與差異：
//   - 物件停用、Renderer 關掉時點清掉（Unity 停用時保不保留未查證；MT2 的 CardTrail 每次 SetActive 之前都自己 Clear）。
//   - 時間用乘過 timeScale 的（未查證）。autodestruct、圓角（numCornerVertices）、圓頭（numCapVertices）、
//     alignment TransformZ、textureMode Tile／DistributePerSegment／RepeatPerSegment 沒做（MT2 的 TrailRenderer 全部是 View、Stretch、0、0）。

import { Vector3 } from 'three';
import type { World } from '../engine/world';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { evalCurve, evalGradient, type GradientData, type MinMaxCurveData, type SerializedCurve } from './curves';
import type { ParticleCamera, ParticleGeometry } from './particleMesh';

interface TrailPoint {
  x: number;
  y: number;
  z: number;
  /** 留下這個點時的時間（TrailWorld.time） */
  t: number;
}
interface TrailState {
  /** 老的在前 */
  points: TrailPoint[];
  /** 物件目前的位置（emitting 時帶子的頭接到這裡）；沒在發射時是 null */
  head: { x: number; y: number; z: number } | null;
}

interface TrailParams {
  widthMultiplier?: number;
  widthCurve?: SerializedCurve;
  colorGradient?: GradientData;
  alignment?: number;
  textureMode?: number;
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

export class TrailWorld {
  private readonly states = new Map<ComponentData, TrailState>();
  /** 乘過 timeScale 的累計時間 */
  time = 0;

  constructor(private readonly world: World) {}

  /** 場景裡全部的 TrailRenderer（只隨節點與元件增減變） */
  private all(): [SceneNode, ComponentData][] {
    const g = this.world.graph;
    return g.cached(
      'trails.renderers',
      () => {
        const out: [SceneNode, ComponentData][] = [];
        for (const node of g.nodes.values())
          for (const cid of node.go.components) {
            const c = g.file.components[cid];
            if (c?.type === 'TrailRenderer') out.push([node, c]);
          }
        return out;
      },
      'membership',
    );
  }

  private stateOf(comp: ComponentData): TrailState {
    let st = this.states.get(comp);
    if (!st) this.states.set(comp, (st = { points: [], head: null }));
    return st;
  }

  /** 每格（腳本的 LateUpdate 之後）：老化、留新點、頭跟著物件 */
  update(dt: number): void {
    this.time += dt;
    for (const [node, comp] of this.all()) {
      if (!node.activeInHierarchy || comp.m_Enabled === 0) {
        const st = this.states.get(comp);
        if (st) {
          st.points.length = 0;
          st.head = null;
        }
        continue;
      }
      const st = this.stateOf(comp);
      const life = (comp.m_Time as number | undefined) ?? 5;
      while (st.points.length && this.time - st.points[0].t > life) st.points.shift();
      if (comp.m_Emitting === 0) {
        st.head = null;
        continue;
      }
      this.world.refreshTransform(node);
      const e = node.world.elements;
      const p = { x: e[12], y: e[13], z: e[14] };
      const last = st.points[st.points.length - 1];
      const min = (comp.m_MinVertexDistance as number | undefined) ?? 0.1;
      if (!last || Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) > min) st.points.push({ ...p, t: this.time });
      st.head = p;
    }
    // 銷毀了的元件
    if (this.states.size) {
      const live = new Set(this.all().map(([, c]) => c));
      for (const c of this.states.keys()) if (!live.has(c)) this.states.delete(c);
    }
  }

  clear(comp: ComponentData): void {
    const st = this.states.get(comp);
    if (st) st.points.length = 0;
  }

  addPosition(comp: ComponentData, p: { x: number; y: number; z: number }): void {
    this.stateOf(comp).points.push({ x: p.x, y: p.y, z: p.z, t: this.time });
  }

  /** 目前的點數（TrailRenderer.positionCount） */
  positionCount(comp: ComponentData): number {
    return this.states.get(comp)?.points.length ?? 0;
  }

  /** 畫出來的點：頭（物件目前的位置）在前、最老的在後（世界座標） */
  pathOf(comp: ComponentData): { x: number; y: number; z: number }[] {
    const st = this.states.get(comp);
    if (!st) return [];
    const out: { x: number; y: number; z: number }[] = [];
    const last = st.points[st.points.length - 1];
    if (st.head && (!last || Math.hypot(st.head.x - last.x, st.head.y - last.y, st.head.z - last.z) > 1e-6)) out.push(st.head);
    for (let i = st.points.length - 1; i >= 0; i--) out.push(st.points[i]);
    return out;
  }
}

/**
 * 拖尾的帶狀網格（世界座標）：每個點兩個頂點，側向量 ＝ 沿線方向 × 往攝影機的方向（View 對齊）。
 * 頂點資料照粒子網格的形狀給（position、normal、color、TEXCOORD0 四個分量），繪製端共用寫入函式。
 * 三角形照 Unity 的正面（面向攝影機看順時針）排；帶子在畫面上翻面時逐片檢查
 */
export function buildTrailRendererGeometry(path: readonly { x: number; y: number; z: number }[], params: TrailParams, cam: ParticleCamera, linearColor: boolean): ParticleGeometry {
  const m = path.length;
  if (m < 2 || (params.alignment ?? 0) !== 0) return { vertexCount: 0, position: new Float32Array(0), normal: new Float32Array(0), color: new Float32Array(0), texcoords: [new Float32Array(0)], indices: new Uint32Array(0) };
  // 沿線的距離比例（頭 0、尾 1）
  const dist = new Float64Array(m);
  for (let k = 1; k < m; k++) dist[k] = dist[k - 1] + Math.hypot(path[k].x - path[k - 1].x, path[k].y - path[k - 1].y, path[k].z - path[k - 1].z);
  const total = dist[m - 1] || 1;
  const width: MinMaxCurveData = { minMaxState: 1, scalar: params.widthMultiplier ?? 1, maxCurve: params.widthCurve };
  const n = m * 2;
  const position = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const color = new Float32Array(n * 4);
  const uv = new Float32Array(n * 4);
  const indices = new Uint32Array((m - 1) * 6);
  const p = new Vector3();
  const seg = new Vector3();
  const toCam = new Vector3();
  const side = new Vector3();
  const col = new Float32Array(4);
  for (let k = 0; k < m; k++) {
    const f = dist[k] / total;
    p.set(path[k].x, path[k].y, path[k].z);
    const a = path[Math.max(0, k - 1)];
    const c = path[Math.min(m - 1, k + 1)];
    seg.set(c.x - a.x, c.y - a.y, c.z - a.z);
    if (cam.orthographic) toCam.copy(cam.forward).negate();
    else toCam.copy(cam.position).sub(p);
    side.crossVectors(seg, toCam);
    if (side.lengthSq() < 1e-12) side.copy(cam.right);
    side.normalize();
    toCam.normalize();
    const w = evalCurve(width, f, 0);
    evalGradient(params.colorGradient, f, col);
    for (let s = 0; s < 2; s++) {
      const vi = k * 2 + s;
      const off = (s === 0 ? 0.5 : -0.5) * w;
      position[vi * 3] = p.x + side.x * off;
      position[vi * 3 + 1] = p.y + side.y * off;
      position[vi * 3 + 2] = p.z + side.z * off;
      normal[vi * 3] = toCam.x;
      normal[vi * 3 + 1] = toCam.y;
      normal[vi * 3 + 2] = toCam.z;
      for (let ch = 0; ch < 4; ch++) color[vi * 4 + ch] = linearColor && ch < 3 ? toLinear(col[ch]) : col[ch];
      uv[vi * 4] = f;
      uv[vi * 4 + 1] = s;
    }
  }
  // 每片兩個三角形；(B−A)×(C−A) 要朝攝影機（面向攝影機看順時針，粒子的 billboard 同一個規則）
  const A = new Vector3();
  const B = new Vector3();
  const C = new Vector3();
  const nrm = new Vector3();
  const view = new Vector3();
  let idx = 0;
  const tri = (i0: number, i1: number, i2: number): void => {
    A.fromArray(position, i0 * 3);
    B.fromArray(position, i1 * 3);
    C.fromArray(position, i2 * 3);
    nrm.crossVectors(B.clone().sub(A), C.clone().sub(A));
    if (cam.orthographic) view.copy(cam.forward);
    else view.copy(A).sub(cam.position);
    if (nrm.dot(view) > 0) [i1, i2] = [i2, i1];
    indices[idx++] = i0;
    indices[idx++] = i1;
    indices[idx++] = i2;
  };
  for (let k = 1; k < m; k++) {
    const a0 = (k - 1) * 2;
    const c0 = k * 2;
    tri(a0, c0, c0 + 1);
    tri(a0, c0 + 1, a0 + 1);
  }
  return { vertexCount: n, position, normal, color, texcoords: [uv], indices };
}

// 粒子的網格（2026/10/17）：3D 的 ParticleSystemRenderer（繪製端每台攝影機畫之前產一次）與 BakeMesh／BakeTrailsMesh（UIParticle）共用。
//
// 依據（Unity 2022.3 手冊 Renderer module、ParticleSystemRenderer／ParticleSystemVertexStream 腳本 API）：
//   - renderMode（m_RenderMode）：0 Billboard、1 Stretch（沿速度拉長，長度 ＝ 大小 × lengthScale ＋ 速度 × velocityScale；
//     四邊形以粒子位置為中心，Unity 實際的錨點未查證）、
//     2 HorizontalBillboard（平躺在世界 XZ 平面）、3 VerticalBillboard（面向攝影機但保持直立）、4 Mesh、5 None（不畫粒子，拖尾照畫）。
//   - renderAlignment（m_RenderAlignment）：0 View（攝影機平面）、1 World、2 Local（系統的軸）、3 Facing（朝攝影機位置）、4 Velocity。
//   - 大小 ＝ 起始大小 × Size over Lifetime × 發射器的縮放（scalingMode）；顏色 ＝ 起始顏色 × Color over Lifetime；
//     Linear 色彩空間且 m_ApplyActiveColorSpace 時頂點色轉成線性。
//   - min／maxParticleSize：粒子在畫面上的大小（佔 viewport 高度的比例）夾在這之間。
//   - sortMode（m_SortMode）：0 照緩衝區順序、1 由遠到近、2 老的畫在前面（最後畫）、3 新的畫在前面。
//   - 自訂頂點資料流（m_UseCustomVertexStreams、m_VertexStreams）：Position、Normal、Tangent、Color 有自己的語意，其他依序塞進
//     TEXCOORD0、TEXCOORD1…（每個 4 個分量，跨格接著塞，手冊 Renderer module 的 Custom Vertex Streams 列表就是這樣標的）。
//     沒開自訂時是 Position、Normal、Color、UV。序列化的 m_VertexStreams 是位元組的十六進位字串；匯入時 YAML 把只含數字的當成整數，
//     開頭的 0 不見了（"000103040522" 變 103040522），這裡補回來（Position 一定在最前面）。
//   - Texture Sheet Animation（序列化 UVModule）：格子從左上角開始、一列一列；frameOverTime × 格數 × cycles；
//     SingleRow 照 rowIndex（rowMode 0）或隨機一列（rowMode 1）；AnimBlend／AnimFrame 資料流是小數部分與格號。
//   - 粒子的旋轉：正的角度是順時針（面向攝影機看；未查證）；3D 旋轉照 Unity 的 ZXY 順序。
//   - 拖尾（Trails module）：面向攝影機的長條，寬度 ＝ widthOverTrail ×（sizeAffectsWidth 時乘粒子大小），
//     顏色 ＝（inheritParticleColor 時乘粒子顏色）× colorOverLifetime（粒子年齡）× colorOverTrail（沿拖尾）；uv.x 頭 0 尾 1（Stretch）。
// 三角形照 Unity 的正面（面向攝影機看是順時針）。

import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { evalCurve, evalMinMaxGradient, hash01, SALT, type MinMaxCurveData, type MinMaxGradientData } from './curves';
import type { ParticleSim } from './system';

/** 畫粒子用的攝影機（Unity 世界座標） */
export interface ParticleCamera {
  position: Vector3;
  right: Vector3;
  up: Vector3;
  /** 攝影機看的方向（+Z） */
  forward: Vector3;
  orthographic: boolean;
  /** 透視：垂直視角（度）；正交：orthographicSize */
  fov: number;
  orthoSize: number;
}

/** 產出的網格：世界座標（BakeMesh 的 BakeRotationAndScale 時減掉發射器位置） */
export interface ParticleGeometry {
  vertexCount: number;
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  /** TEXCOORD0..n，每個 4 個分量 */
  texcoords: Float32Array[];
  indices: Uint32Array;
}

const STREAM_SIZE: Record<number, number> = {
  0: 3, 1: 3, 2: 4, 3: 4, 4: 2, 5: 2, 6: 2, 7: 2, 8: 1, 9: 1, 10: 3, 11: 1, 12: 1, 13: 2, 14: 3, 15: 1, 16: 3, 17: 1, 18: 3, 19: 3, 20: 1,
  21: 1, 22: 1, 23: 1, 24: 2, 25: 3, 26: 4, 27: 1, 28: 2, 29: 3, 30: 4, 31: 1, 32: 2, 33: 3, 34: 4, 35: 1, 36: 2, 37: 3, 38: 4, 39: 1, 40: 2,
  41: 3, 42: 1, 43: 2, 44: 3, 45: 1, 46: 1, 47: 2,
};

/** m_VertexStreams（十六進位字串，或被 YAML 讀成數字的）→ 資料流編號 */
export function parseVertexStreams(raw: unknown): number[] {
  if (raw == null) return [0, 1, 3, 4];
  let hex = typeof raw === 'number' ? String(Math.trunc(raw)) : String(raw);
  if (typeof raw === 'number') {
    if (hex.length % 2) hex = '0' + hex;
    if (!hex.startsWith('00')) hex = '00' + hex;
  }
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out.length ? out : [0, 1, 3, 4];
}

/** 一條資料流在 TEXCOORD 裡的位置：第幾個分量起（全部 TEXCOORD 攤平，4 個一組） */
export interface StreamLayout {
  streams: number[];
  /** 資料流 → 攤平後的起始分量（Position、Normal、Tangent、Color 不在這裡） */
  offset: Map<number, number>;
  /** 用到幾個 TEXCOORD */
  texcoordCount: number;
}
export function streamLayout(streams: number[]): StreamLayout {
  const offset = new Map<number, number>();
  let at = 0;
  for (const s of streams) {
    if (s <= 3) continue;
    offset.set(s, at);
    at += STREAM_SIZE[s] ?? 1;
  }
  return { streams, offset, texcoordCount: Math.ceil(at / 4) };
}

type Mod = Record<string, unknown> & { enabled?: number };
const on = (m: Mod | undefined): boolean => !!m && m.enabled === 1;

/** sRGB → 線性（Unity 的 GammaToLinearSpace，分段函式） */
function toLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export interface BuildOptions {
  camera: ParticleCamera;
  /** ParticleSystemRenderer 元件資料 */
  renderer: Record<string, unknown>;
  linearColor: boolean;
  /** mesh 粒子的網格（位置、法線、uv、顏色、三角形） */
  mesh?: { position: ArrayLike<number>; normal?: ArrayLike<number>; uv?: ArrayLike<number>; color?: ArrayLike<number>; indices: ArrayLike<number> } | null;
  /** BakeMesh 的 BakeRotationAndScale：結果減掉發射器的世界位置 */
  subtractEmitter?: boolean;
  /**
   * 結果放在共用的暫存陣列（不每次配新的）：下一次 scratch 產生就被蓋掉，呼叫端要馬上用完。
   * 繪製每一趟照攝影機重產、馬上抄進 GPU 屬性（sceneRenderer 的 beforePass），MT2 戰鬥一格幾十次（10/18）
   */
  scratch?: boolean;
}

const tmp = {
  c: new Vector3(),
  r: new Vector3(),
  u: new Vector3(),
  n: new Vector3(),
  v: new Vector3(),
  q: new Quaternion(),
  e: new Euler(),
  m: new Matrix4(),
  col: new Float32Array(4),
  col2: new Float32Array(4),
};

/** 第 i 顆的世界大小（x、y、z）：起始大小 × Size over Lifetime × 發射器縮放 */
function particleSize(sim: ParticleSim, i: number, out: Vector3): Vector3 {
  const t = sim.age[i] / sim.life[i];
  const seed = sim.seed[i];
  let x = sim.sx[i];
  let y = sim.sy[i];
  let z = sim.sz[i];
  const sol = sim.mod('SizeModule');
  if (on(sol)) {
    const r = hash01(seed, SALT.sizeOverLifetime);
    const kx = evalCurve(sol!.curve as MinMaxCurveData, t, r);
    if (sol!.separateAxes === 1) {
      x *= kx;
      y *= evalCurve(sol!.y as MinMaxCurveData, t, r);
      z *= evalCurve(sol!.z as MinMaxCurveData, t, r);
    } else {
      x *= kx;
      y *= kx;
      z *= kx;
    }
  }
  const noise = sim.mod('NoiseModule');
  if (on(noise)) {
    const sa = (noise!.sizeAmount as MinMaxCurveData | number | undefined) ?? 0;
    const amt = typeof sa === 'number' ? sa : evalCurve(sa, t, 0.5);
    if (amt) {
      const k = 1 + sim.nsz[i] * amt;
      x *= k;
      y *= k;
      z *= k;
    }
  }
  const s = sim.pose?.sizeScale;
  if (s) {
    x *= Math.abs(s.x);
    y *= Math.abs(s.y);
    z *= Math.abs(s.z);
  }
  return out.set(x, y, z);
}

/** 第 i 顆的顏色（Gamma 空間 RGBA） */
export function particleColor(sim: ParticleSim, i: number, out: Float32Array, o = 0): void {
  for (let k = 0; k < 4; k++) out[o + k] = sim.col[i * 4 + k];
  const col = sim.mod('ColorModule');
  if (on(col)) {
    evalMinMaxGradient(col!.gradient as MinMaxGradientData, sim.age[i] / sim.life[i], hash01(sim.seed[i], SALT.colorOverLifetime), tmp.col2);
    for (let k = 0; k < 4; k++) out[o + k] *= tmp.col2[k];
  }
}

/** 腳本的 GetCurrentSize（x 分量；不含發射器縮放，跟 Unity 的 Particle.GetCurrentSize 一樣是粒子自己的大小） */
export function currentSize(sim: ParticleSim, i: number): number {
  const save = sim.pose;
  sim.pose = null;
  const v = particleSize(sim, i, tmp.v).x;
  sim.pose = save;
  return v;
}

/** 貼圖格：回 [u0, v0, du, dv, blend, frame]（沒開 Texture Sheet Animation 是整張） */
function sheetFrame(sim: ParticleSim, i: number, out: number[]): number[] {
  const uv = sim.mod('UVModule');
  if (!on(uv) || ((uv!.mode as number) ?? 0) !== 0) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 1;
    out[3] = 1;
    out[4] = 0;
    out[5] = 0;
    return out;
  }
  const tx = Math.max(1, (uv!.tilesX as number) ?? 1);
  const ty = Math.max(1, (uv!.tilesY as number) ?? 1);
  const t = sim.age[i] / sim.life[i];
  const seed = sim.seed[i];
  const singleRow = (uv!.animationType as number) === 1;
  const frames = singleRow ? tx : tx * ty;
  const cycles = (uv!.cycles as number) ?? 1;
  const fot = evalCurve(uv!.frameOverTime as MinMaxCurveData, t, hash01(seed, SALT.frameOverTime));
  const start = evalCurve(uv!.startFrame as MinMaxCurveData, t, hash01(seed, SALT.startFrame));
  let f = fot * frames * cycles + start;
  const whole = Math.floor(f);
  const blend = f - whole;
  f = ((whole % frames) + frames) % frames;
  let col: number;
  let row: number;
  if (singleRow) {
    row = (uv!.rowMode as number) === 1 ? Math.floor(hash01(seed, SALT.row) * ty) : ((uv!.rowIndex as number) ?? 0);
    col = f;
  } else {
    col = f % tx;
    row = Math.floor(f / tx);
  }
  out[0] = col / tx;
  out[1] = 1 - (row + 1) / ty;
  out[2] = 1 / tx;
  out[3] = 1 / ty;
  out[4] = blend;
  out[5] = singleRow ? row * tx + f : f;
  return out;
}

/** 下一格的 uv 原點（UV2 資料流，畫格之間混合用） */
function nextFrameUV(sim: ParticleSim, frame: number, out: number[]): void {
  const uv = sim.mod('UVModule')!;
  const tx = Math.max(1, (uv.tilesX as number) ?? 1);
  const ty = Math.max(1, (uv.tilesY as number) ?? 1);
  const n = (frame + 1) % (tx * ty);
  out[0] = (n % tx) / tx;
  out[1] = 1 - (Math.floor(n / tx) + 1) / ty;
}

/** 畫面上的大小比例：min／maxParticleSize 夾住（佔 viewport 高度） */
function clampScreenSize(size: number, center: Vector3, cam: ParticleCamera, minF: number, maxF: number): number {
  let h: number;
  if (cam.orthographic) h = cam.orthoSize * 2;
  else {
    const d = Math.max(1e-4, tmp.v.copy(center).sub(cam.position).dot(cam.forward));
    h = 2 * d * Math.tan((cam.fov * Math.PI) / 360);
  }
  if (h <= 0) return size;
  const f = size / h;
  if (f > maxF) return maxF * h;
  if (f < minF) return minF * h;
  return size;
}

/** BuildOptions.scratch 的共用陣列（只增不減） */
const scratchPool = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  color: new Float32Array(0),
  texcoords: [] as Float32Array<ArrayBuffer>[],
  indices: new Uint32Array(0),
};
const grownF32 = (a: Float32Array<ArrayBuffer>, n: number): Float32Array<ArrayBuffer> => (a.length >= n ? a : new Float32Array(Math.max(n, a.length * 2)));

class Builder {
  vtx = 0;
  idx = 0;
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  texcoords: Float32Array[];
  indices: Uint32Array;
  constructor(
    maxVerts: number,
    maxIdx: number,
    readonly layout: StreamLayout,
    scratch = false,
  ) {
    const tcCount = Math.max(1, layout.texcoordCount);
    if (!scratch) {
      this.position = new Float32Array(maxVerts * 3);
      this.normal = new Float32Array(maxVerts * 3);
      this.color = new Float32Array(maxVerts * 4);
      this.texcoords = Array.from({ length: tcCount }, () => new Float32Array(maxVerts * 4));
      this.indices = new Uint32Array(maxIdx);
      return;
    }
    // 共用陣列：位置、顏色、三角形每個用到的頂點都會寫；法線（mesh 粒子沒有法線時）與 TEXCOORD（沒用到的分量）
    // 不一定寫，先清成 0，跟新配的一樣
    const P = scratchPool;
    this.position = P.position = grownF32(P.position, maxVerts * 3);
    this.normal = P.normal = grownF32(P.normal, maxVerts * 3);
    this.normal.fill(0, 0, maxVerts * 3);
    this.color = P.color = grownF32(P.color, maxVerts * 4);
    if (P.indices.length < maxIdx) P.indices = new Uint32Array(Math.max(maxIdx, P.indices.length * 2));
    this.indices = P.indices;
    this.texcoords = [];
    for (let k = 0; k < tcCount; k++) {
      const a = (P.texcoords[k] = grownF32(P.texcoords[k] ?? new Float32Array(0), maxVerts * 4));
      a.fill(0, 0, maxVerts * 4);
      this.texcoords.push(a);
    }
  }
  /** 攤平的 TEXCOORD 分量 k 寫值 */
  tc(v: number, k: number, value: number): void {
    this.texcoords[k >> 2][v * 4 + (k & 3)] = value;
  }
  stream(v: number, s: number, values: ArrayLike<number>): void {
    const at = this.layout.offset.get(s);
    if (at === undefined) return;
    const n = STREAM_SIZE[s] ?? 1;
    for (let k = 0; k < n; k++) this.tc(v, at + k, values[k] ?? 0);
  }
  done(): ParticleGeometry {
    return {
      vertexCount: this.vtx,
      position: this.position.subarray(0, this.vtx * 3),
      normal: this.normal.subarray(0, this.vtx * 3),
      color: this.color.subarray(0, this.vtx * 4),
      texcoords: this.texcoords.map((a) => a.subarray(0, this.vtx * 4)),
      indices: this.indices.subarray(0, this.idx),
    };
  }
}

/** 畫的順序（sortMode） */
function drawOrder(sim: ParticleSim, cam: ParticleCamera, sortMode: number): Uint32Array {
  const n = sim.n;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  if (sortMode === 1) {
    const d = new Float32Array(n);
    const p = new Vector3();
    for (let i = 0; i < n; i++) d[i] = sim.worldPos(i, p).distanceToSquared(cam.position);
    order.sort((a, b) => d[b] - d[a]);
  } else if (sortMode === 2) order.sort((a, b) => sim.age[a] - sim.age[b]);
  else if (sortMode === 3) order.sort((a, b) => sim.age[b] - sim.age[a]);
  return order;
}

const QUAD_CX = [-0.5, 0.5, 0.5, -0.5];
const QUAD_CY = [-0.5, -0.5, 0.5, 0.5];
const QUAD_U = [0, 1, 1, 0];
const QUAD_V = [0, 0, 1, 1];

/** 粒子本身（renderMode 0～4）的網格；None（5）回空 */
export function buildParticles(sim: ParticleSim, opt: BuildOptions): ParticleGeometry {
  const r = opt.renderer;
  const mode = (r.m_RenderMode as number) ?? 0;
  const streams = r.m_UseCustomVertexStreams === 1 ? parseVertexStreams(r.m_VertexStreams) : [0, 1, 3, 4];
  const layout = streamLayout(streams);
  const n = mode === 5 ? 0 : sim.n;
  const mesh = mode === 4 ? opt.mesh : null;
  const perV = mesh ? mesh.position.length / 3 : 4;
  const perI = mesh ? mesh.indices.length : 6;
  const b = new Builder(n * perV, n * perI, layout, opt.scratch);
  if (n === 0 || (mode === 4 && !mesh)) return b.done();
  const cam = opt.camera;
  const align = (r.m_RenderAlignment as number) ?? 0;
  const pivot = (r.m_Pivot as { x: number; y: number; z: number } | undefined) ?? { x: 0, y: 0, z: 0 };
  const flip = (r.m_Flip as { x: number; y: number; z: number } | undefined) ?? { x: 0, y: 0, z: 0 };
  const minF = (r.m_MinParticleSize as number) ?? 0;
  const maxF = (r.m_MaxParticleSize as number) ?? 0.5;
  const lengthScale = (r.m_LengthScale as number) ?? 2;
  const velocityScale = (r.m_VelocityScale as number) ?? 0;
  const linear = opt.linearColor && r.m_ApplyActiveColorSpace !== 0;
  const uvMod = sim.mod('UVModule');
  const uvFlipU = on(uvMod) ? ((uvMod!.flipU as number) ?? 0) : 0;
  const uvFlipV = on(uvMod) ? ((uvMod!.flipV as number) ?? 0) : 0;
  const custom = sim.mod('CustomDataModule');
  const rot3D = sim.initial.rotation3D === 1;
  const sub = opt.subtractEmitter && sim.pose ? sim.pose.position : null;
  const order = drawOrder(sim, cam, (r.m_SortMode as number) ?? 0);
  const frame = [0, 0, 1, 1, 0, 0];
  const next = [0, 0];
  const size = new Vector3();
  const center = new Vector3();
  const vel = new Vector3();
  const right = new Vector3();
  const up = new Vector3();
  const nrm = new Vector3();
  const corner = new Vector3();
  const col = tmp.col;
  const cvals = [0, 0, 0, 0];
  const cust = (slot: 0 | 1, i: number, t: number, out: number[]): number[] => {
    out[0] = out[1] = out[2] = out[3] = 0;
    if (!on(custom)) return out;
    const m = (custom![`mode${slot}`] as number) ?? 0;
    const rr = hash01(sim.seed[i], SALT.custom + slot * 8);
    if (m === 1) {
      const count = (custom![`vectorComponentCount${slot}`] as number) ?? 4;
      for (let k = 0; k < count; k++) out[k] = evalCurve(custom![`vector${slot}_${k}`] as MinMaxCurveData, t, hash01(sim.seed[i], SALT.custom + slot * 8 + k));
    } else if (m === 2) {
      evalMinMaxGradient(custom![`color${slot}`] as MinMaxGradientData, t, rr, tmp.col2);
      for (let k = 0; k < 4; k++) out[k] = tmp.col2[k];
    }
    return out;
  };
  const meshTRS = new Matrix4();
  // UV（資料流 4）、四邊形的角（11）每個頂點寫，直接寫進去（同 b.stream，不必每個頂點配陣列）
  const uvAt = layout.offset.get(4);
  const cornerAt = layout.offset.get(11);
  const flipAx = Math.abs(flip.x);
  const flipAy = Math.abs(flip.y);
  // mesh 粒子的網格資料（每顆都一樣，存成區域變數）
  const mPos = mesh?.position;
  const mNrm = mesh?.normal;
  const mCol = mesh?.color;
  const mUv = mesh?.uv;
  const mIdx = mesh?.indices;
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const t = sim.age[i] / sim.life[i];
    const seed = sim.seed[i];
    sim.worldPos(i, center);
    particleSize(sim, i, size);
    particleColor(sim, i, col);
    if (linear) {
      col[0] = toLinear(col[0]);
      col[1] = toLinear(col[1]);
      col[2] = toLinear(col[2]);
    }
    // 世界速度（stretch、Velocity 對齊、Velocity 資料流）
    vel.set(sim.vx[i] + sim.avx[i], sim.vy[i] + sim.avy[i], sim.vz[i] + sim.avz[i]);
    if (!sim.worldSpace && sim.pose) vel.transformDirection(sim.pose.toWorld).multiplyScalar(Math.hypot(sim.vx[i] + sim.avx[i], sim.vy[i] + sim.avy[i], sim.vz[i] + sim.avz[i]));
    sheetFrame(sim, i, frame);
    // hash01 是 [0, 1)：門檻 ≤ 0 時比較一定是 false，不用算雜湊（結果同每次都算）
    const flipU = (flipAx > 0 && hash01(seed, SALT.flip + 1) < flipAx) !== (uvFlipU > 0 && hash01(seed, SALT.flip + 3) < uvFlipU);
    const flipV = (flipAy > 0 && hash01(seed, SALT.flip + 2) < flipAy) !== (uvFlipV > 0 && hash01(seed, SALT.flip + 4) < uvFlipV);
    const v0 = b.vtx;
    if (mode === 4 && mesh) {
      // mesh 粒子：每顆一份網格，TRS ＝ 位置、3D 旋轉（ZXY）、大小
      if (rot3D) tmp.q.setFromEuler(tmp.e.set(-sim.rx[i], -sim.ry[i], -sim.rz[i], 'YXZ'));
      else tmp.q.setFromAxisAngle(nrm.set(0, 0, 1), -sim.rz[i]);
      if (align === 2 && sim.pose) tmp.q.premultiply(sim.pose.rotation);
      meshTRS.compose(center, tmp.q, size);
      const mv = mPos!.length / 3;
      for (let k = 0; k < mv; k++) {
        corner.set(mPos![k * 3], mPos![k * 3 + 1], mPos![k * 3 + 2]).applyMatrix4(meshTRS);
        if (sub) corner.sub(sub);
        const vi = b.vtx;
        b.position[vi * 3] = corner.x;
        b.position[vi * 3 + 1] = corner.y;
        b.position[vi * 3 + 2] = corner.z;
        if (mNrm) {
          nrm.set(mNrm[k * 3], mNrm[k * 3 + 1], mNrm[k * 3 + 2]).applyQuaternion(tmp.q);
          b.normal[vi * 3] = nrm.x;
          b.normal[vi * 3 + 1] = nrm.y;
          b.normal[vi * 3 + 2] = nrm.z;
        }
        for (let c = 0; c < 4; c++) b.color[vi * 4 + c] = col[c] * (mCol ? mCol[k * 4 + c] : 1);
        const mu = mUv ? mUv[k * 2] : 0;
        const mvv = mUv ? mUv[k * 2 + 1] : 0;
        if (uvAt !== undefined) {
          b.tc(vi, uvAt, frame[0] + mu * frame[2]);
          b.tc(vi, uvAt + 1, frame[1] + mvv * frame[3]);
        }
        b.vtx++;
      }
      const nIdx = mIdx!.length;
      const bi = b.indices;
      let at = b.idx;
      for (let k = 0; k < nIdx; k++) bi[at++] = v0 + mIdx![k];
      b.idx = at;
    } else {
      // 四邊形的兩個軸
      let w = size.x;
      let h = size.y;
      if (mode === 1) {
        // Stretch：沿速度（投影到畫面）；長度 ＝ 大小 × lengthScale ＋ 速度 × velocityScale
        const sp = vel.length();
        const dir = tmp.v.copy(vel);
        dir.addScaledVector(cam.forward, -dir.dot(cam.forward));
        if (dir.lengthSq() < 1e-12) dir.copy(cam.up);
        dir.normalize();
        right.copy(dir);
        up.crossVectors(cam.forward, dir).normalize();
        w = size.x * lengthScale + sp * velocityScale;
        h = size.y;
        nrm.copy(cam.forward).negate();
      } else {
        if (mode === 2) {
          right.set(1, 0, 0);
          up.set(0, 0, 1);
          nrm.set(0, 1, 0);
        } else if (mode === 3) {
          const toCam = tmp.v.copy(cam.position).sub(center);
          toCam.y = 0;
          if (toCam.lengthSq() < 1e-12) toCam.copy(cam.forward).negate();
          toCam.normalize();
          up.set(0, 1, 0);
          right.crossVectors(up, toCam).normalize();
          nrm.copy(toCam);
        } else if (align === 1) {
          right.set(1, 0, 0);
          up.set(0, 1, 0);
          nrm.set(0, 0, -1);
        } else if (align === 2 && sim.pose) {
          right.set(1, 0, 0).applyQuaternion(sim.pose.rotation);
          up.set(0, 1, 0).applyQuaternion(sim.pose.rotation);
          nrm.set(0, 0, -1).applyQuaternion(sim.pose.rotation);
        } else if (align === 3) {
          const toCam = tmp.v.copy(cam.position).sub(center).normalize();
          right.crossVectors(cam.up, toCam).normalize();
          up.crossVectors(toCam, right).normalize();
          nrm.copy(toCam);
        } else if (align === 4 && vel.lengthSq() > 1e-12) {
          nrm.copy(vel).normalize().negate();
          right.crossVectors(cam.up, nrm).normalize();
          up.crossVectors(nrm, right).normalize();
        } else {
          right.copy(cam.right);
          up.copy(cam.up);
          nrm.copy(cam.forward).negate();
        }
        // 畫面大小的上下限
        if (minF > 0 || maxF < 10) {
          const s0 = Math.max(w, h);
          const s1 = clampScreenSize(s0, center, cam, minF, maxF);
          if (s1 !== s0 && s0 > 0) {
            w *= s1 / s0;
            h *= s1 / s0;
          }
        }
        // 旋轉（順時針為正；3D 旋轉照 ZXY 套在這個平面的座標系）
        const ang = -sim.rz[i];
        if (rot3D && (sim.rx[i] || sim.ry[i])) {
          tmp.q.setFromEuler(tmp.e.set(-sim.rx[i], -sim.ry[i], ang, 'YXZ'));
          const basis = tmp.m.makeBasis(right, up, nrm);
          const rq = new Quaternion().setFromRotationMatrix(basis).multiply(tmp.q);
          right.set(1, 0, 0).applyQuaternion(rq);
          up.set(0, 1, 0).applyQuaternion(rq);
        } else if (ang) {
          const c = Math.cos(ang);
          const s = Math.sin(ang);
          const rx = right.clone();
          right.multiplyScalar(c).addScaledVector(up, s);
          up.multiplyScalar(c).addScaledVector(rx, -s);
        }
      }
      const px = pivot.x * w;
      const py = pivot.y * h;
      // 四個角：左下、右下、右上、左上（QUAD_CX、QUAD_CY、QUAD_U、QUAD_V）
      const cx = QUAD_CX;
      const cy = QUAD_CY;
      const us = QUAD_U;
      const vs = QUAD_V;
      for (let k = 0; k < 4; k++) {
        corner.copy(center).addScaledVector(right, cx[k] * w + px).addScaledVector(up, cy[k] * h + py);
        if (sub) corner.sub(sub);
        const vi = b.vtx;
        b.position[vi * 3] = corner.x;
        b.position[vi * 3 + 1] = corner.y;
        b.position[vi * 3 + 2] = corner.z;
        b.normal[vi * 3] = nrm.x;
        b.normal[vi * 3 + 1] = nrm.y;
        b.normal[vi * 3 + 2] = nrm.z;
        for (let c = 0; c < 4; c++) b.color[vi * 4 + c] = col[c];
        let u = us[k];
        let v = vs[k];
        if (flipU) u = 1 - u;
        if (flipV) v = 1 - v;
        if (uvAt !== undefined) {
          b.tc(vi, uvAt, frame[0] + u * frame[2]);
          b.tc(vi, uvAt + 1, frame[1] + v * frame[3]);
        }
        if (layout.offset.has(5)) {
          nextFrameUV(sim, frame[5], next);
          b.stream(vi, 5, [next[0] + u * frame[2], next[1] + v * frame[3]]);
        }
        if (cornerAt !== undefined) b.tc(vi, cornerAt, k);
        b.vtx++;
      }
      // 面向攝影機看順時針（Unity 的正面）：左下 → 左上 → 右上、左下 → 右上 → 右下
      b.indices[b.idx++] = v0;
      b.indices[b.idx++] = v0 + 3;
      b.indices[b.idx++] = v0 + 2;
      b.indices[b.idx++] = v0;
      b.indices[b.idx++] = v0 + 2;
      b.indices[b.idx++] = v0 + 1;
    }
    // 每顆粒子共用的資料流（四個角一樣）
    const sp = vel.length();
    for (let v = v0; v < b.vtx; v++) {
      if (layout.offset.size <= 1) break;
      b.stream(v, 8, [frame[4]]);
      b.stream(v, 9, [frame[5]]);
      b.stream(v, 10, [center.x - (sub?.x ?? 0), center.y - (sub?.y ?? 0), center.z - (sub?.z ?? 0)]);
      b.stream(v, 12, [size.x]);
      b.stream(v, 13, [size.x, size.y]);
      b.stream(v, 14, [size.x, size.y, size.z]);
      b.stream(v, 15, [sim.rz[i]]);
      b.stream(v, 16, [sim.rx[i], sim.ry[i], sim.rz[i]]);
      b.stream(v, 19, [vel.x, vel.y, vel.z]);
      b.stream(v, 20, [sp]);
      b.stream(v, 21, [t]);
      b.stream(v, 22, [1 / sim.life[i]]);
      const sr = [hash01(seed, 101), hash01(seed, 102), hash01(seed, 103), hash01(seed, 104)];
      b.stream(v, 23, sr);
      b.stream(v, 24, sr);
      b.stream(v, 25, sr);
      b.stream(v, 26, sr);
      const vr = [Math.random(), Math.random(), Math.random(), Math.random()];
      b.stream(v, 27, vr);
      b.stream(v, 28, vr);
      b.stream(v, 29, vr);
      b.stream(v, 30, vr);
      cust(0, i, t, cvals);
      b.stream(v, 31, cvals);
      b.stream(v, 32, cvals);
      b.stream(v, 33, cvals);
      b.stream(v, 34, cvals);
      cust(1, i, t, cvals);
      b.stream(v, 35, cvals);
      b.stream(v, 36, cvals);
      b.stream(v, 37, cvals);
      b.stream(v, 38, cvals);
      b.stream(v, 46, [i]);
    }
  }
  return b.done();
}

/** 拖尾的網格（Trails module；每顆粒子一條，加上粒子死掉後留下來的） */
export function buildTrails(sim: ParticleSim, opt: BuildOptions): ParticleGeometry {
  const trail = sim.mod('TrailModule');
  const r = opt.renderer;
  const streams = r.m_UseCustomTrailVertexStreams === 1 ? parseVertexStreams(r.m_TrailVertexStreams) : [0, 1, 3, 4];
  const layout = streamLayout(streams);
  if (!on(trail)) return new Builder(0, 0, layout).done();
  const linear = opt.linearColor && r.m_ApplyActiveColorSpace !== 0;
  const cam = opt.camera;
  const sub = opt.subtractEmitter && sim.pose ? sim.pose.position : null;
  const strips: { pts: { x: number; y: number; z: number }[]; color: Float32Array; size: number; t: number; seed: number }[] = [];
  const toWorld = (p: { x: number; y: number; z: number }, out: Vector3): Vector3 => {
    out.set(p.x, p.y, p.z);
    if (!sim.worldSpace && trail!.worldSpace !== 1 && sim.pose) out.applyMatrix4(sim.pose.toWorld);
    return out;
  };
  if ((trail!.mode as number) === 1) {
    // Ribbon：照粒子的出生順序（老的在前）連成一條（ribbonCount 條，輪流分配）
    const count = Math.max(1, (trail!.ribbonCount as number) ?? 1);
    const order = Array.from({ length: sim.n }, (_, i) => i).sort((a, b) => sim.id[a] - sim.id[b]);
    for (let g = 0; g < count; g++) {
      const pts: { x: number; y: number; z: number }[] = [];
      const color = new Float32Array(4);
      let size = 0;
      for (let k = g; k < order.length; k += count) {
        const i = order[k];
        pts.push(sim.worldPos(i, new Vector3()));
        particleColor(sim, i, color);
        size = particleSize(sim, i, tmp.v).x;
      }
      if (pts.length > 1) strips.push({ pts, color, size, t: 0, seed: g });
    }
  } else {
    for (let i = 0; i < sim.n; i++) {
      const tp = sim.trails[i];
      if (!tp || tp.length === 0) continue;
      const pts: { x: number; y: number; z: number }[] = tp.map((p) => toWorld(p, new Vector3()));
      pts.push(sim.worldPos(i, new Vector3()));
      const color = new Float32Array(4);
      particleColor(sim, i, color);
      strips.push({ pts, color, size: particleSize(sim, i, tmp.v).x, t: sim.age[i] / sim.life[i], seed: sim.seed[i] });
    }
    for (const o of sim.orphans) strips.push({ pts: o.points.map((p) => toWorld(p, new Vector3())), color: o.color, size: o.size, t: 1, seed: 0 });
  }
  const total = strips.reduce((s, x) => s + x.pts.length, 0);
  const b = new Builder(total * 2, total * 6, layout, opt.scratch);
  const side = new Vector3();
  const seg = new Vector3();
  const toCam = new Vector3();
  const p = new Vector3();
  const colTrail = new Float32Array(4);
  const colLife = new Float32Array(4);
  const lastSide = new Vector3();
  for (const s of strips) {
    const m = s.pts.length;
    if (m < 2) continue;
    const v0 = b.vtx;
    for (let k = 0; k < m; k++) {
      // u：頭（最新的點）0、尾 1
      const u = 1 - k / (m - 1);
      p.set(s.pts[k].x, s.pts[k].y, s.pts[k].z);
      const a = s.pts[Math.max(0, k - 1)];
      const c = s.pts[Math.min(m - 1, k + 1)];
      seg.set(c.x - a.x, c.y - a.y, c.z - a.z);
      toCam.copy(cam.position).sub(p);
      const prevSide = k > 0 ? lastSide : null;
      side.crossVectors(seg, toCam);
      // 兩點重合（最後記錄的點跟粒子目前位置相同）時沿用前一個點的側向：改用 cam.right 會轉 90 度，那一段的三角形反過來
      if (side.lengthSq() < 1e-12) side.copy(prevSide ?? cam.right);
      side.normalize();
      lastSide.copy(side);
      let width = evalCurve(trail!.widthOverTrail as MinMaxCurveData, u, hash01(s.seed, SALT.trailWidth));
      if (trail!.sizeAffectsWidth !== 0) width *= s.size;
      evalMinMaxGradient(trail!.colorOverTrail as MinMaxGradientData, u, hash01(s.seed, SALT.trailColor), colTrail);
      evalMinMaxGradient(trail!.colorOverLifetime as MinMaxGradientData, s.t, hash01(s.seed, SALT.trailColor + 1), colLife);
      for (let side2 = 0; side2 < 2; side2++) {
        const vi = b.vtx++;
        const off = (side2 === 0 ? -0.5 : 0.5) * width;
        const x = p.x + side.x * off - (sub?.x ?? 0);
        const y = p.y + side.y * off - (sub?.y ?? 0);
        const z = p.z + side.z * off - (sub?.z ?? 0);
        b.position[vi * 3] = x;
        b.position[vi * 3 + 1] = y;
        b.position[vi * 3 + 2] = z;
        toCam.normalize();
        b.normal[vi * 3] = toCam.x;
        b.normal[vi * 3 + 1] = toCam.y;
        b.normal[vi * 3 + 2] = toCam.z;
        for (let ch = 0; ch < 4; ch++) {
          let v = (trail!.inheritParticleColor !== 0 ? s.color[ch] : 1) * colTrail[ch] * colLife[ch];
          if (linear && ch < 3) v = toLinear(v);
          b.color[vi * 4 + ch] = v;
        }
        b.stream(vi, 4, [u, side2]);
      }
      if (k > 0) {
        // 面向攝影機看順時針（Unity 的正面，同 billboard）：side ＝ seg × toCam 指向畫面左邊（往前走的方向看），
        // 所以 −0.5 那排（a0、c0）在右、+0.5 那排（a1、c1）在左。以前是逆時針，材質 Cull Back（MT2 戰鬥房間火盆的 Sparks）整條被剔掉
        const a0 = v0 + (k - 1) * 2;
        const a1 = a0 + 1;
        const c0 = v0 + k * 2;
        const c1 = c0 + 1;
        b.indices[b.idx++] = a0;
        b.indices[b.idx++] = c1;
        b.indices[b.idx++] = c0;
        b.indices[b.idx++] = a0;
        b.indices[b.idx++] = a1;
        b.indices[b.idx++] = c1;
      }
    }
  }
  return b.done();
}

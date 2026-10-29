// 粒子 Shape 模組：發射點與初始方向（在粒子系統的區域空間，套過形狀自己的位移、旋轉、縮放）。
//
// 依據 Unity 2022.3 手冊 Particle System Shape module（各形狀的說明）：
//   - Sphere（0）／Hemisphere（2）：從球（半球朝 +Z）發射，方向朝外；radiusThickness 0 是只在表面、1 是整個體積。
//   - Cone（4）：從底面圓（XY 平面）發射，朝 +Z 張開 angle 度（邊緣的粒子沿圓錐面、中心的直直往 +Z，中間照半徑比例）；
//     ConeVolume（8）再沿方向往前隨機 0～length。
//   - Box（5）／BoxShell（15）／BoxEdge（16）：在 1×1×1 的方塊（形狀的 scale 決定大小）體積、表面、邊上發射，方向 +Z。
//   - Circle（10）：XY 平面上的圓（arc 段），方向朝外、只在圓的平面裡。
//   - SingleSidedEdge（12）：X 軸上 −radius～radius 的線段，方向 +Y（手冊：「The particles move in the emitter object's upward (Y) direction」）。
//   - Rectangle（18）：XY 平面上的矩形（scale 決定大小），方向 +Z。
//   - Mesh（6，MT2 只有 3 個）沒做：從原點朝隨機方向（差異清單）。
// arc／radius 的 mode：0 Random、1 Loop、2 PingPong、3 BurstSpread；spread > 0 時位置量化成 spread 的倍數；speed 是每秒繞幾圈（Loop／PingPong）。
// 朝向混合：randomDirectionAmount（往隨機方向）、sphericalDirectionAmount（往「從中心出去」的方向）、randomPositionAmount（隨機位移）。
// 圓與球的半徑取樣照面積／體積均勻（未查證 Unity 是否也是）。

import { Euler, Quaternion, Vector3 } from 'three';
import { evalCurve, type MinMaxCurveData, type ParticleRandom } from './curves';

interface ShapeParam {
  value?: number;
  mode?: number;
  spread?: number;
  speed?: MinMaxCurveData;
}
export interface ShapeData {
  enabled?: number;
  type?: number;
  angle?: number;
  length?: number;
  boxThickness?: { x: number; y: number; z: number };
  radiusThickness?: number;
  m_Position?: { x: number; y: number; z: number };
  m_Rotation?: { x: number; y: number; z: number };
  m_Scale?: { x: number; y: number; z: number };
  randomDirectionAmount?: number;
  sphericalDirectionAmount?: number;
  randomPositionAmount?: number;
  alignToDirection?: number;
  radius?: ShapeParam;
  arc?: ShapeParam;
}

const DEG = Math.PI / 180;

/** 這一次發射在 arc（或 edge 的 radius）上的位置比例 0～1 */
function paramFraction(p: ShapeParam | undefined, rng: ParticleRandom, systemTime: number, systemT: number, index: number, count: number): number {
  const mode = p?.mode ?? 0;
  let f: number;
  if (mode === 3) f = count > 1 ? index / count : 0;
  else if (mode === 1 || mode === 2) {
    const loops = systemTime * evalCurve(p?.speed, systemT, rng.next());
    if (mode === 1) f = loops - Math.floor(loops);
    else {
      const m = loops - 2 * Math.floor(loops / 2);
      f = m <= 1 ? m : 2 - m;
    }
  } else f = rng.next();
  const spread = p?.spread ?? 0;
  if (spread > 0) f = Math.floor(f / spread) * spread;
  return f;
}

function randomUnit(rng: ParticleRandom, out: Vector3): Vector3 {
  const z = rng.range(-1, 1);
  const a = rng.next() * Math.PI * 2;
  const s = Math.sqrt(Math.max(0, 1 - z * z));
  return out.set(s * Math.cos(a), s * Math.sin(a), z);
}

const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpV = new Vector3();
const tmpR = new Vector3();

/**
 * 發射一顆：pos、dir 寫進 out（區域空間；dir 是單位向量）。systemTime 是系統時間（秒）、systemT 是系統時間比例（0～1），
 * index／count 給 BurstSpread（同一次發射的第幾顆、共幾顆）
 */
export function emitFromShape(sh: ShapeData | undefined, rng: ParticleRandom, systemTime: number, systemT: number, index: number, count: number, pos: Vector3, dir: Vector3): void {
  if (!sh || sh.enabled === 0) {
    pos.set(0, 0, 0);
    dir.set(0, 0, 1);
    return;
  }
  const radius = sh.radius?.value ?? 1;
  const thick = Math.min(1, Math.max(0, sh.radiusThickness ?? 1));
  const arc = (sh.arc?.value ?? 360) * DEG;
  switch (sh.type ?? 4) {
    case 0:
    case 1:
    case 2:
    case 3: {
      // 球／半球（1、3 是舊版的 Shell，當作厚度 0）
      const t = sh.type === 1 || sh.type === 3 ? 0 : thick;
      randomUnit(rng, dir);
      if (sh.type === 2 || sh.type === 3) dir.z = Math.abs(dir.z);
      const inner = 1 - t;
      const r = radius * Math.cbrt(inner * inner * inner + (1 - inner * inner * inner) * rng.next());
      pos.copy(dir).multiplyScalar(r);
      break;
    }
    case 4:
    case 7:
    case 8:
    case 9: {
      // 圓錐（底面／體積）
      const theta = paramFraction(sh.arc, rng, systemTime, systemT, index, count) * arc;
      const inner = 1 - (sh.type === 7 || sh.type === 9 ? 0 : thick);
      const rho = Math.sqrt(inner * inner + (1 - inner * inner) * rng.next());
      const a = (sh.angle ?? 25) * DEG * rho;
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      pos.set(c * rho * radius, s * rho * radius, 0);
      dir.set(c * Math.sin(a), s * Math.sin(a), Math.cos(a));
      if (sh.type === 8 || sh.type === 9) pos.addScaledVector(dir, rng.next() * (sh.length ?? 5));
      break;
    }
    case 5:
    case 15:
    case 16: {
      // 方塊：1×1×1，形狀的 scale 在下面套
      if (sh.type === 5) pos.set(rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5);
      else if (sh.type === 15) {
        // 表面：挑一個面
        const face = Math.floor(rng.next() * 6);
        const u = rng.next() - 0.5;
        const v = rng.next() - 0.5;
        const w = face & 1 ? 0.5 : -0.5;
        const ax = face >> 1;
        pos.set(ax === 0 ? w : u, ax === 1 ? w : ax === 0 ? u : v, ax === 2 ? w : v);
      } else {
        // 邊：12 條邊挑一條
        const e = Math.floor(rng.next() * 12);
        const t = rng.next() - 0.5;
        const a = e & 1 ? 0.5 : -0.5;
        const b = e & 2 ? 0.5 : -0.5;
        const ax = e >> 2;
        pos.set(ax === 0 ? t : a, ax === 1 ? t : ax === 0 ? a : b, ax === 2 ? t : b);
      }
      dir.set(0, 0, 1);
      break;
    }
    case 10:
    case 11: {
      // 圓（XY 平面），11 是舊版的 CircleEdge
      const theta = paramFraction(sh.arc, rng, systemTime, systemT, index, count) * arc;
      const inner = 1 - (sh.type === 11 ? 0 : thick);
      const r = radius * Math.sqrt(inner * inner + (1 - inner * inner) * rng.next());
      dir.set(Math.cos(theta), Math.sin(theta), 0);
      pos.copy(dir).multiplyScalar(r);
      break;
    }
    case 12: {
      const f = paramFraction(sh.radius, rng, systemTime, systemT, index, count);
      pos.set((f * 2 - 1) * radius, 0, 0);
      dir.set(0, 1, 0);
      break;
    }
    case 18:
      pos.set(rng.next() - 0.5, rng.next() - 0.5, 0);
      dir.set(0, 0, 1);
      break;
    default:
      pos.set(0, 0, 0);
      randomUnit(rng, dir);
  }

  // 形狀自己的縮放、旋轉、位移（縮放對方向也有影響：非等比時方向跟著擠壓）
  const sc = sh.m_Scale ?? { x: 1, y: 1, z: 1 };
  pos.set(pos.x * sc.x, pos.y * sc.y, pos.z * sc.z);
  dir.set(dir.x * sc.x, dir.y * sc.y, dir.z * sc.z);
  const rot = sh.m_Rotation;
  if (rot && (rot.x || rot.y || rot.z)) {
    // Unity 的尤拉角順序 ZXY（Transform 同）
    tmpQ.setFromEuler(tmpE.set(rot.x * DEG, rot.y * DEG, rot.z * DEG, 'YXZ'));
    pos.applyQuaternion(tmpQ);
    dir.applyQuaternion(tmpQ);
  }
  const off = sh.m_Position;
  if (off) pos.set(pos.x + off.x, pos.y + off.y, pos.z + off.z);
  if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
  dir.normalize();

  const sph = sh.sphericalDirectionAmount ?? 0;
  if (sph > 0) {
    tmpV.copy(pos);
    if (off) tmpV.set(tmpV.x - off.x, tmpV.y - off.y, tmpV.z - off.z);
    if (tmpV.lengthSq() > 1e-12) dir.lerp(tmpV.normalize(), sph).normalize();
  }
  const rnd = sh.randomDirectionAmount ?? 0;
  if (rnd > 0) dir.lerp(randomUnit(rng, tmpR), rnd).normalize();
  const rp = sh.randomPositionAmount ?? 0;
  if (rp > 0) pos.addScaledVector(randomUnit(rng, tmpR), rp * rng.next());
}

// 一個 ParticleSystem 元件的模擬（2026/10/17，MT2 的粒子）。Unity 的粒子系統是原生程式（看不到原始碼），
// 這裡照 Unity 2022.3 手冊各模組的說明與 ParticleSystem 的腳本 API 文件實作；手冊沒寫清楚、自己推定的地方標「未查證」，列在 README 的差異清單。
//
// 時間：
//   - 系統時間 time 在 0～duration（lengthInSec）之間；looping 時繞回 0（burst 的次數重算），不循環的到 duration 停止發射，
//     粒子死光後停下來（isPlaying false）並執行 stopAction。startDelay 在 Play 時取一次，延遲期間不發射、系統時間不走。
//   - prewarm（只在 looping 時有效，手冊 Main module）：Play 時先模擬一整個 duration。
//   - simulationSpeed 乘在 dt 上；useUnscaledTime 用不受 timeScale 影響的時間（呼叫端給）。
// 發射（Emission module）：
//   - rateOverTime 照「系統時間比例」取曲線值，累積到整數就發；這一格裡發的粒子平均分散在這一格的時間點上，
//     新粒子只模擬它出生後剩下的那段時間（手冊沒寫，Unity 實際上也是平均分散，未查證細節）。
//   - rateOverDistance 照發射器這一格移動的世界距離。
//   - bursts：time、count（MinMaxCurve，取整數）、cycleCount（0 是無限）、repeatInterval、probability。
// 每顆粒子（存成 SoA）：位置與速度在模擬空間（Local：系統的區域空間；World：世界空間），
//   每格：年齡 → 重力（gravityModifier × Physics.gravity，Local 時換到區域空間）→ Force over Lifetime → Limit Velocity（限速、阻力）→
//   Velocity over Lifetime（另外加的速度，不累積；orbital 繞中心轉、radial 往外）→ Noise → 位置積分 → Rotation over Lifetime → 拖尾的點。
//   顏色、大小、貼圖格在畫的時候照年齡比例算（render/particleMesh.ts）。
// 子發射器（Sub Emitters module）：Birth（父粒子活著時，在它的位置照子系統自己的發射設定持續發）、Death（父粒子死掉時在那裡開一份
//   子系統的發射，跑一個 duration）。Collision、Trigger、Manual 沒做。繼承（properties）：顏色、大小、旋轉、生命期。
// 沒做：Collision、Triggers、External Forces、Lights、Color by Speed、Size by Speed、Rotation by Speed、Ring Buffer、Custom Simulation Space、
//   Mesh 形狀（見 shape.ts）。

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { curveMax, evalCurve, evalMinMaxGradient, hash01, ParticleRandom, SALT, type MinMaxCurveData, type MinMaxGradientData } from './curves';
import { fractal3 } from './noise';
import { emitFromShape, type ShapeData } from './shape';

type Mod = Record<string, unknown> & { enabled?: number };
const C = (m: Mod | undefined, k: string): MinMaxCurveData | undefined => m?.[k] as MinMaxCurveData | undefined;
const on = (m: Mod | undefined): boolean => !!m && m.enabled === 1;

export const GRAVITY = new Vector3(0, -9.81, 0);

/** 發射器這一格的姿態（manager 照 scalingMode 算） */
export interface EmitterPose {
  /** Local 模擬時區域 → 世界（含 scalingMode 決定的縮放） */
  toWorld: Matrix4;
  /** 世界位置、旋轉 */
  position: Vector3;
  rotation: Quaternion;
  /** 粒子大小的縮放（Hierarchy：lossy scale；Local：自己的 localScale；Shape：1） */
  sizeScale: Vector3;
  /** Shape 模式：只縮放發射位置 */
  shapeScale: Vector3 | null;
}

/** 子發射器的一次觸發（Death 是固定位置跑一個 duration；Birth 跟著父粒子） */
interface TriggerInstance {
  pos: Vector3;
  vel: Vector3;
  time: number;
  acc: number;
  burstDone: number[];
  /** Birth：跟著哪一顆父粒子（父系統的粒子 id）；Death 是 −1 */
  parentId: number;
  parent: ParticleSim | null;
  inherit: { color: Float32Array | null; size: number; rotation: number; lifetime: number };
}

/** 拖尾的一個點（模擬空間；trail.worldSpace 時是世界空間） */
export interface TrailPoint {
  x: number;
  y: number;
  z: number;
  /** 記下這個點時的系統累積時間 */
  t: number;
}
/** 粒子死掉、dieWithParticles 關掉時留下來淡出的拖尾 */
export interface OrphanTrail {
  points: TrailPoint[];
  color: Float32Array;
  size: number;
  life: number;
}

let nextParticleId = 1;

export class ParticleSim {
  // ── 粒子（SoA） ──
  cap = 0;
  n = 0;
  id = new Uint32Array(0);
  px = new Float32Array(0);
  py = new Float32Array(0);
  pz = new Float32Array(0);
  vx = new Float32Array(0);
  vy = new Float32Array(0);
  vz = new Float32Array(0);
  /** 這一格的附加速度（Velocity over Lifetime ＋ Noise），stretched billboard 與 totalVelocity 用 */
  avx = new Float32Array(0);
  avy = new Float32Array(0);
  avz = new Float32Array(0);
  age = new Float32Array(0);
  life = new Float32Array(0);
  sx = new Float32Array(0);
  sy = new Float32Array(0);
  sz = new Float32Array(0);
  rx = new Float32Array(0);
  ry = new Float32Array(0);
  rz = new Float32Array(0);
  /** 開始的顏色（RGBA，Gamma 空間，跟元件資料一樣） */
  col = new Float32Array(0);
  seed = new Uint32Array(0);
  /** Noise 的大小與旋轉分量（sizeAmount、rotationAmount 用） */
  nsz = new Float32Array(0);
  trails: (TrailPoint[] | null)[] = [];
  orphans: OrphanTrail[] = [];

  // ── 狀態 ──
  playing = false;
  paused = false;
  /** 還在發射（播放中、還沒過不循環的 duration、沒被 Stop） */
  emitting = false;
  /** 系統時間（0～duration） */
  time = 0;
  /** 從 Play 起累積的時間（拖尾的點、噪聲捲動用） */
  clock = 0;
  delay = 0;
  emitAcc = 0;
  distAcc = 0;
  lastEmitterPos: Vector3 | null = null;
  burstDone: number[] = [];
  readonly rng = new ParticleRandom(1);
  /** 由父系統的子發射器驅動：自己不發射 */
  subEmitterOf: ParticleSim | null = null;
  instances: TriggerInstance[] = [];
  /** 這一格發射器的姿態（update 開頭由 manager 用 setPose 設） */
  pose: EmitterPose | null = null;
  /** pose.toWorld 的反矩陣（世界向量換到 Local 模擬空間用） */
  private poseInv = new Matrix4();

  setPose(pose: EmitterPose): void {
    this.pose = pose;
    this.poseInv.copy(pose.toWorld).invert();
  }
  /** 發射器的速度（世界，Inherit Velocity 與 rateOverDistance 用） */
  emitterVel = new Vector3();
  /** stopAction 是否已經觸發過（這次 Play 之後） */
  stopNotified = true;
  /** 子發射器（Birth／Death）的對象，manager 解析 */
  subs: { sim: ParticleSim; type: number; properties: number; probability: number }[] = [];

  constructor(
    readonly comp: ComponentData,
    readonly node: SceneNode,
  ) {
    this.ensure(Math.min(64, this.maxParticles()));
  }

  // ── 序列化資料的捷徑 ──
  get initial(): Mod {
    return (this.comp.InitialModule as Mod) ?? {};
  }
  mod(name: string): Mod | undefined {
    return this.comp[name] as Mod | undefined;
  }
  get duration(): number {
    return Math.max(0.05, (this.comp.lengthInSec as number) ?? 5);
  }
  get looping(): boolean {
    return this.comp.looping === 1;
  }
  get worldSpace(): boolean {
    return this.comp.moveWithTransform === 1;
  }
  maxParticles(): number {
    return Math.max(0, ((this.initial.maxNumParticles as number) ?? 1000) | 0);
  }
  get systemT(): number {
    return Math.min(1, this.time / this.duration);
  }

  /** 陣列容量（不夠就倍增，最多 maxParticles） */
  private ensure(need: number): void {
    if (need <= this.cap) return;
    const cap = Math.max(need, this.cap * 2, 16);
    for (const k of ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'avx', 'avy', 'avz', 'age', 'life', 'sx', 'sy', 'sz', 'rx', 'ry', 'rz', 'nsz'] as const) {
      const a = this[k];
      const b = new Float32Array(cap);
      b.set(a);
      this[k] = b;
    }
    const col = new Float32Array(cap * 4);
    col.set(this.col);
    this.col = col;
    const seed = new Uint32Array(cap);
    seed.set(this.seed);
    this.seed = seed;
    const id = new Uint32Array(cap);
    id.set(this.id);
    this.id = id;
    this.cap = cap;
  }

  // ── 腳本 API ──

  get isPlaying(): boolean {
    return this.playing && !this.paused;
  }
  get isEmitting(): boolean {
    return this.playing && !this.paused && this.emitting;
  }
  get isPaused(): boolean {
    return this.paused;
  }
  get isStopped(): boolean {
    return !this.playing && !this.paused && this.n === 0;
  }
  isAlive(): boolean {
    return this.n > 0 || this.orphans.length > 0 || this.instances.length > 0 || (this.playing && this.emitting);
  }

  /** Play：停止中從頭開始（延遲、prewarm、burst 重算）；暫停中接著播；播放中不動 */
  play(globalRng: ParticleRandom): void {
    if (this.paused) {
      this.paused = false;
      return;
    }
    if (this.playing) return;
    this.playing = true;
    this.emitting = true;
    this.time = 0;
    this.emitAcc = 0;
    this.distAcc = 0;
    this.lastEmitterPos = null;
    this.burstDone = [];
    this.stopNotified = false;
    const seed = this.comp.autoRandomSeed === 0 ? ((this.comp.randomSeed as number) ?? 0) : globalRng.uint();
    this.rng.reseed(seed);
    this.delay = Math.max(0, evalCurve(this.comp.startDelay as MinMaxCurveData, 0, this.rng.next()));
    if (this.looping && this.comp.prewarm === 1 && !this.subEmitterOf && this.pose) this.prewarm();
  }

  /** Stop：停止發射；clear 時連粒子一起清掉（ParticleSystemStopBehavior.StopEmittingAndClear） */
  stop(clear: boolean): void {
    this.playing = false;
    this.paused = false;
    this.emitting = false;
    if (clear) this.clear();
  }

  pause(): void {
    if (this.playing) this.paused = true;
  }

  clear(): void {
    this.n = 0;
    this.trails.length = 0;
    this.orphans.length = 0;
    this.instances.length = 0;
  }

  /** prewarm：先模擬一整個 duration（粗一點的步長：最多 60 步） */
  private prewarm(): void {
    const steps = Math.min(60, Math.max(1, Math.ceil(this.duration * 30)));
    const dt = this.duration / steps;
    const delay = this.delay;
    this.delay = 0;
    for (let i = 0; i < steps; i++) this.step(dt);
    this.time = 0;
    this.burstDone = [];
    this.delay = delay;
  }

  // ── 模擬 ──

  /** 推進 dt 秒（已乘 simulationSpeed）。pose 要先設好 */
  step(dt: number): void {
    if (!this.pose || dt <= 0) return;
    if (this.paused) return;
    this.clock += dt;
    // 既有的粒子
    this.advanceAll(dt);
    // 子發射器的觸發實例
    if (this.instances.length) this.stepInstances(dt);
    // 自己的發射
    if (this.playing && this.emitting && !this.subEmitterOf) {
      let edt = dt;
      if (this.delay > 0) {
        const used = Math.min(this.delay, edt);
        this.delay -= used;
        edt -= used;
      }
      if (edt > 0) this.emitOverTime(edt, dt);
    }
    // 拖尾（沒有跟著粒子死掉的）
    if (this.orphans.length) this.ageOrphans();
    // 不循環的跑完、粒子死光：停下來
    if (this.playing && !this.emitting && this.n === 0 && this.instances.length === 0 && this.orphans.length === 0) this.playing = false;
  }

  /** 系統時間往前 edt（這一格的最後 edt 秒），照 rateOverTime、bursts、rateOverDistance 發射；dt 是整格的長度 */
  private emitOverTime(edt: number, dt: number): void {
    const em = this.mod('EmissionModule');
    const pose = this.pose!;
    // 距離
    let moved = 0;
    if (this.lastEmitterPos) moved = this.lastEmitterPos.distanceTo(pose.position);
    const prevPos = this.lastEmitterPos?.clone() ?? pose.position.clone();
    this.lastEmitterPos = pose.position.clone();
    let remaining = edt;
    let consumed = dt - edt;
    while (remaining > 1e-9) {
      const seg = Math.min(this.duration - this.time, remaining);
      if (on(em)) {
        const t0 = this.time;
        const t1 = this.time + seg;
        // rateOverTime：照這一段開頭的系統時間比例取值
        const rate = evalCurve(C(em, 'rateOverTime'), Math.min(1, t0 / this.duration), this.rng.next());
        this.emitAcc += rate * seg;
        // 每格加 rate×dt 的浮點累積誤差（10 × 1/60 加 30 次是 4.9999…）：取整時給一點容差
        const count = Math.floor(this.emitAcc + 1e-6);
        if (count > 0) {
          this.emitAcc -= count;
          for (let k = 0; k < count; k++) {
            const at = consumed + seg * ((k + 1) / count);
            this.emitOne(dt - at, t0 + seg * ((k + 1) / count), k, count, null);
          }
        }
        // bursts
        const bursts = (em!.m_Bursts as Mod[] | undefined) ?? [];
        for (let b = 0; b < bursts.length; b++) {
          const burst = bursts[b];
          const bt = (burst.time as number) ?? 0;
          const cycles = (burst.cycleCount as number) ?? 1;
          const interval = Math.max(0.0001, (burst.repeatInterval as number) ?? 0.01);
          let done = this.burstDone[b] ?? 0;
          // 系統時間 [0, t1) 裡還沒發的都在這一段發（每一段接著上一段的結尾，不會漏）
          while ((cycles <= 0 || done < cycles) && bt + done * interval < t1) {
            const when = bt + done * interval;
            done++;
            if (this.rng.next() > ((burst.probability as number) ?? 1)) continue;
            const n = Math.round(evalCurve(burst.countCurve as MinMaxCurveData, Math.min(1, when / this.duration), this.rng.next()));
            const at = consumed + Math.max(0, when - t0);
            for (let k = 0; k < n; k++) this.emitOne(dt - at, when, k, n, null);
          }
          this.burstDone[b] = done;
        }
      }
      this.time += seg;
      remaining -= seg;
      consumed += seg;
      if (this.time >= this.duration - 1e-9) {
        if (this.looping) {
          this.time = 0;
          this.burstDone = [];
        } else {
          this.time = this.duration;
          this.emitting = false;
          break;
        }
      }
    }
    // rateOverDistance（世界距離）：位置在上一格與這一格的發射器之間內插
    if (on(em) && moved > 0) {
      const rd = evalCurve(C(em, 'rateOverDistance'), this.systemT, this.rng.next());
      if (rd > 0) {
        this.distAcc += rd * moved;
        const count = Math.floor(this.distAcc + 1e-6);
        this.distAcc -= count;
        for (let k = 0; k < count; k++) {
          const f = (k + 1) / count;
          this.emitOne(dt * (1 - f), this.time, k, count, prevPos.clone().lerp(pose.position, f));
        }
      }
    }
  }

  /** Emit(count)：照 Shape 與起始設定立刻發 count 顆 */
  emit(count: number): void {
    for (let k = 0; k < count; k++) this.emitOne(0, this.time, k, count, null);
  }

  private tmpPos = new Vector3();
  private tmpDir = new Vector3();
  private tmpOrigin = new Vector3();
  private tmpInh = new Vector3();
  private tmpQ = new Quaternion();

  /**
   * 發一顆。remainingDt：這一格出生後還要模擬的時間；at：發射時的系統時間；worldAt：rateOverDistance 的內插位置（世界）；
   * instance：子發射器的觸發實例（位置在那裡）
   */
  private emitOne(remainingDt: number, at: number, index: number, count: number, worldAt: Vector3 | null, instance?: TriggerInstance): number {
    const max = this.maxParticles();
    if (this.n >= max) return -1;
    this.ensure(this.n + 1);
    const pose = this.pose!;
    const i = this.n++;
    const ini = this.initial;
    const seed = this.rng.uint();
    this.seed[i] = seed;
    this.id[i] = nextParticleId++;
    const sysT = Math.min(1, at / this.duration);
    const pos = this.tmpPos;
    const dir = this.tmpDir;
    emitFromShape(this.mod('ShapeModule') as ShapeData, this.rng, this.clock, sysT, index, count, pos, dir);
    if (pose.shapeScale) pos.multiply(pose.shapeScale);
    const speed = evalCurve(C(ini, 'startSpeed'), sysT, hash01(seed, SALT.speed));
    // 位置與方向換到模擬空間
    const origin = instance?.pos ?? worldAt;
    if (this.worldSpace) {
      dir.applyQuaternion(pose.rotation);
      if (origin) pos.applyQuaternion(pose.rotation).add(origin);
      else pos.applyMatrix4(pose.toWorld);
    } else if (origin) {
      // 區域模擬的觸發位置：世界 → 區域
      pos.add(this.tmpOrigin.copy(origin).applyMatrix4(this.poseInv));
    }
    this.px[i] = pos.x;
    this.py[i] = pos.y;
    this.pz[i] = pos.z;
    let vx = dir.x * speed;
    let vy = dir.y * speed;
    let vz = dir.z * speed;
    // Inherit Velocity（Initial：出生時加發射器速度 × 曲線）
    const inh = this.mod('InheritVelocityModule');
    if (on(inh) && (inh!.m_Mode as number) !== 1) {
      const k = evalCurve(inh!.m_Curve as MinMaxCurveData, 0, hash01(seed, SALT.inherit));
      const ev = this.simVector(this.emitterVel, this.tmpInh);
      vx += ev.x * k;
      vy += ev.y * k;
      vz += ev.z * k;
    }
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.avx[i] = this.avy[i] = this.avz[i] = 0;
    let life = evalCurve(C(ini, 'startLifetime'), sysT, hash01(seed, SALT.lifetime));
    if (instance && instance.inherit.lifetime > 0) life *= instance.inherit.lifetime;
    this.life[i] = Math.max(1e-4, life);
    this.age[i] = 0;
    const size3D = ini.size3D === 1;
    const s = evalCurve(C(ini, 'startSize'), sysT, hash01(seed, SALT.size));
    this.sx[i] = s;
    this.sy[i] = size3D ? evalCurve(C(ini, 'startSizeY'), sysT, hash01(seed, SALT.sizeY)) : s;
    this.sz[i] = size3D ? evalCurve(C(ini, 'startSizeZ'), sysT, hash01(seed, SALT.sizeZ)) : s;
    if (instance && instance.inherit.size > 0) {
      this.sx[i] *= instance.inherit.size;
      this.sy[i] *= instance.inherit.size;
      this.sz[i] *= instance.inherit.size;
    }
    const rot3D = ini.rotation3D === 1;
    let rz = evalCurve(C(ini, 'startRotation'), sysT, hash01(seed, SALT.rotation));
    // randomizeRotationDirection：這個比例的粒子旋轉方向相反（手冊 Main module「Flip Rotation」）
    if (hash01(seed, SALT.flip) < ((ini.randomizeRotationDirection as number) ?? 0)) rz = -rz;
    this.rz[i] = rz + (instance?.inherit.rotation ?? 0);
    this.rx[i] = rot3D ? evalCurve(C(ini, 'startRotationX'), sysT, hash01(seed, SALT.rotationY)) : 0;
    this.ry[i] = rot3D ? evalCurve(C(ini, 'startRotationY'), sysT, hash01(seed, SALT.rotationZ)) : 0;
    evalMinMaxGradient(ini.startColor as MinMaxGradientData, sysT, hash01(seed, SALT.color), this.col, i * 4);
    if (instance?.inherit.color) for (let k = 0; k < 4; k++) this.col[i * 4 + k] *= instance.inherit.color[k];
    this.nsz[i] = 0;
    this.trails[i] = null;
    // 子發射器：Birth 開始跟著這顆
    for (const sub of this.subs) if (sub.type === 0 && this.rng.next() <= sub.probability) sub.sim.trigger(this, i, sub.properties);
    if (remainingDt > 0) {
      if (!this.advance(i, remainingDt)) {
        this.kill(i);
        return -1;
      }
    }
    return i;
  }

  /** 世界向量 → 模擬空間（World 模擬原樣；Local 乘 toWorld 反矩陣的線性部分） */
  private simVector(v: Vector3, out: Vector3): Vector3 {
    if (this.worldSpace || !this.pose) return out.copy(v);
    const e = this.poseInv.elements;
    const x = v.x;
    const y = v.y;
    const z = v.z;
    return out.set(e[0] * x + e[4] * y + e[8] * z, e[1] * x + e[5] * y + e[9] * z, e[2] * x + e[6] * y + e[10] * z);
  }
  /** 區域向量（系統的區域軸） → 模擬空間 */
  private localToSim(v: Vector3): Vector3 {
    if (this.worldSpace && this.pose) v.applyQuaternion(this.pose.rotation);
    return v;
  }

  private advanceAll(dt: number): void {
    let i = 0;
    while (i < this.n) {
      if (this.advance(i, dt)) i++;
      else this.kill(i);
    }
  }

  private tmpV = new Vector3();
  private tmpV2 = new Vector3();

  /** 一顆粒子往前 dt；死了回 false（呼叫端 kill） */
  private advance(i: number, dt: number): boolean {
    const age = this.age[i] + dt;
    this.age[i] = age;
    const life = this.life[i];
    if (age >= life) return false;
    const t = age / life;
    const seed = this.seed[i];
    const ini = this.initial;
    let vx = this.vx[i];
    let vy = this.vy[i];
    let vz = this.vz[i];
    // 重力（世界的 Physics.gravity × gravityModifier；Local 模擬換到區域空間）
    const gm = evalCurve(C(ini, 'gravityModifier'), this.systemT, hash01(seed, SALT.gravity));
    if (gm !== 0) {
      const g = this.simVector(this.tmpV2.copy(GRAVITY).multiplyScalar(gm), this.tmpV);
      vx += g.x * dt;
      vy += g.y * dt;
      vz += g.z * dt;
    }
    // Force over Lifetime
    const force = this.mod('ForceModule');
    if (on(force)) {
      const rnd = force!.randomizePerFrame === 1;
      const f = this.tmpV.set(
        evalCurve(C(force, 'x'), t, rnd ? this.rng.next() : hash01(seed, SALT.forceX)),
        evalCurve(C(force, 'y'), t, rnd ? this.rng.next() : hash01(seed, SALT.forceY)),
        evalCurve(C(force, 'z'), t, rnd ? this.rng.next() : hash01(seed, SALT.forceZ)),
      );
      if (force!.inWorldSpace === 1) this.simVector(this.tmpV2.copy(f), f);
      else this.localToSim(f);
      vx += f.x * dt;
      vy += f.y * dt;
      vz += f.z * dt;
    }
    // Limit Velocity over Lifetime：超過上限時照 dampen 往上限拉（每 1/30 秒拉 dampen 的比例，未查證）；drag 照比例減速
    const clamp = this.mod('ClampVelocityModule');
    if (on(clamp)) {
      const damp = 1 - Math.pow(1 - Math.min(1, Math.max(0, (clamp!.dampen as number) ?? 0)), dt * 30);
      if (clamp!.separateAxis === 1) {
        const lim = [evalCurve(C(clamp, 'x'), t, hash01(seed, SALT.limit)), evalCurve(C(clamp, 'y'), t, hash01(seed, SALT.limit + 100)), evalCurve(C(clamp, 'z'), t, hash01(seed, SALT.limit + 200))];
        const pull = (v: number, l: number): number => (Math.abs(v) > l ? v - (v - Math.sign(v) * l) * damp : v);
        vx = pull(vx, Math.abs(lim[0]));
        vy = pull(vy, Math.abs(lim[1]));
        vz = pull(vz, Math.abs(lim[2]));
      } else {
        const lim = Math.abs(evalCurve(C(clamp, 'magnitude'), t, hash01(seed, SALT.limit)));
        const sp = Math.hypot(vx, vy, vz);
        if (sp > lim && sp > 0) {
          const ns = sp - (sp - lim) * damp;
          const k = ns / sp;
          vx *= k;
          vy *= k;
          vz *= k;
        }
      }
      const drag = evalCurve(C(clamp, 'drag'), t, hash01(seed, SALT.drag));
      if (drag > 0) {
        let d = drag;
        if (clamp!.multiplyDragByParticleSize === 1) d *= Math.max(this.sx[i], this.sy[i]);
        if (clamp!.multiplyDragByParticleVelocity === 1) d *= Math.hypot(vx, vy, vz);
        const k = Math.max(0, 1 - d * dt);
        vx *= k;
        vy *= k;
        vz *= k;
      }
    }
    // Inherit Velocity（Current：每格加發射器速度 × 曲線）
    const inh = this.mod('InheritVelocityModule');
    let ix = 0;
    let iy = 0;
    let iz = 0;
    if (on(inh) && (inh!.m_Mode as number) === 1) {
      const k = evalCurve(inh!.m_Curve as MinMaxCurveData, t, hash01(seed, SALT.inherit));
      const ev = this.simVector(this.emitterVel, this.tmpV2);
      ix = ev.x * k;
      iy = ev.y * k;
      iz = ev.z * k;
    }
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    // Velocity over Lifetime（附加的速度，不累積到 v）
    let ax = 0;
    let ay = 0;
    let az = 0;
    let speedMod = 1;
    const vol = this.mod('VelocityModule');
    if (on(vol)) {
      const a = this.tmpV.set(evalCurve(C(vol, 'x'), t, hash01(seed, SALT.velocityX)), evalCurve(C(vol, 'y'), t, hash01(seed, SALT.velocityY)), evalCurve(C(vol, 'z'), t, hash01(seed, SALT.velocityZ)));
      if (vol!.inWorldSpace === 1) this.simVector(this.tmpV2.copy(a), a);
      else this.localToSim(a);
      ax = a.x;
      ay = a.y;
      az = a.z;
      // orbital：繞系統中心（加 offset）轉，角速度是 弧度／秒（區域軸）；radial：從中心往外
      const ox = evalCurve(C(vol, 'orbitalX'), t, hash01(seed, SALT.orbital));
      const oy = evalCurve(C(vol, 'orbitalY'), t, hash01(seed, SALT.orbital + 1));
      const oz = evalCurve(C(vol, 'orbitalZ'), t, hash01(seed, SALT.orbital + 2));
      const radial = evalCurve(C(vol, 'radial'), t, hash01(seed, SALT.radial));
      if (ox || oy || oz || radial) {
        const cx = evalCurve(C(vol, 'orbitalOffsetX'), t, 0.5);
        const cy = evalCurve(C(vol, 'orbitalOffsetY'), t, 0.5);
        const cz = evalCurve(C(vol, 'orbitalOffsetZ'), t, 0.5);
        const center = this.tmpV2.set(cx, cy, cz);
        if (this.worldSpace && this.pose) center.applyMatrix4(this.pose.toWorld);
        const rel = new Vector3(this.px[i] - center.x, this.py[i] - center.y, this.pz[i] - center.z);
        if (ox || oy || oz) {
          const q = this.tmpQ.setFromAxisAngle(new Vector3(1, 0, 0), ox * dt);
          q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), oy * dt)).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), oz * dt));
          const before = rel.clone();
          rel.applyQuaternion(q);
          this.px[i] += rel.x - before.x;
          this.py[i] += rel.y - before.y;
          this.pz[i] += rel.z - before.z;
        }
        if (radial && rel.lengthSq() > 1e-12) {
          rel.normalize().multiplyScalar(radial);
          ax += rel.x;
          ay += rel.y;
          az += rel.z;
        }
      }
      speedMod = evalCurve(C(vol, 'speedModifier'), t, hash01(seed, SALT.speedModifier));
      if (vol!.speedModifier === undefined) speedMod = 1;
    }
    // Noise：取樣點是位置 × 頻率，加上捲動（scrollSpeed × 時間）；三個軸各取一份。damping 開著時強度除以頻率（未查證）
    const noise = this.mod('NoiseModule');
    let nx = 0;
    let ny = 0;
    let nz = 0;
    if (on(noise)) {
      const freq = Math.max(1e-4, (noise!.frequency as number) ?? 0.5);
      const scroll = evalCurve(C(noise, 'scrollSpeed'), t, 0.5) * this.clock;
      const oct = (noise!.octaves as number) ?? 1;
      const om = (noise!.octaveMultiplier as number) ?? 0.5;
      const os = (noise!.octaveScale as number) ?? 2;
      const sep = noise!.separateAxes === 1;
      const r = hash01(seed, SALT.noise);
      let sxN = evalCurve(C(noise, 'strength'), t, r);
      let syN = sep ? evalCurve(C(noise, 'strengthY'), t, r) : sxN;
      let szN = sep ? evalCurve(C(noise, 'strengthZ'), t, r) : sxN;
      if (noise!.damping === 1) {
        sxN /= freq;
        syN /= freq;
        szN /= freq;
      }
      const X = this.px[i] * freq + scroll;
      const Y = this.py[i] * freq + scroll;
      const Z = this.pz[i] * freq + scroll;
      nx = fractal3(X, Y, Z, oct, om, os) * sxN;
      ny = fractal3(X + 31.4, Y + 17.7, Z + 9.2, oct, om, os) * syN;
      nz = fractal3(X + 61.3, Y + 47.1, Z + 23.9, oct, om, os) * szN;
      const pa = (noise!.positionAmount as MinMaxCurveData | number | undefined) ?? 1;
      const pAmt = typeof pa === 'number' ? pa : evalCurve(pa, t, r);
      this.nsz[i] = nx;
      nx *= pAmt;
      ny *= pAmt;
      nz *= pAmt;
    }
    ax += nx;
    ay += ny;
    az += nz;
    this.avx[i] = ax + ix;
    this.avy[i] = ay + iy;
    this.avz[i] = az + iz;
    this.px[i] += (vx + ax + ix) * speedMod * dt;
    this.py[i] += (vy + ay + iy) * speedMod * dt;
    this.pz[i] += (vz + az + iz) * speedMod * dt;
    // Rotation over Lifetime（角速度，弧度／秒）
    const rol = this.mod('RotationModule');
    if (on(rol)) {
      this.rz[i] += evalCurve(C(rol, 'curve'), t, hash01(seed, SALT.rotationOverLifetime)) * dt;
      if (rol!.separateAxes === 1) {
        this.rx[i] += evalCurve(C(rol, 'x'), t, hash01(seed, SALT.rotationOverLifetime + 1)) * dt;
        this.ry[i] += evalCurve(C(rol, 'y'), t, hash01(seed, SALT.rotationOverLifetime + 2)) * dt;
      }
    }
    // 拖尾：離上一個點超過 minVertexDistance 就記一個點
    const trail = this.mod('TrailModule');
    if (on(trail) && (trail!.mode as number) !== 1) this.recordTrail(i, trail!);
    return true;
  }

  private recordTrail(i: number, trail: Mod): void {
    let pts = this.trails[i];
    if (!pts) {
      // ratio：這個比例的粒子才有拖尾
      if (hash01(this.seed[i], SALT.trailLifetime + 7) >= ((trail.ratio as number) ?? 1)) return;
      pts = this.trails[i] = [];
    }
    const p = this.trailPos(i, trail);
    const last = pts[pts.length - 1];
    const minD = (trail.minVertexDistance as number) ?? 0.2;
    if (!last || Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) >= minD) pts.push({ x: p.x, y: p.y, z: p.z, t: this.clock });
    // 點的壽命：lifetime 曲線（粒子生命期的比例）× 粒子生命期
    const lifeFrac = evalCurve(trail.lifetime as MinMaxCurveData, this.age[i] / this.life[i], hash01(this.seed[i], SALT.trailLifetime));
    const pointLife = lifeFrac * this.life[i];
    while (pts.length > 1 && this.clock - pts[0].t > pointLife) pts.shift();
  }

  /** 拖尾點的位置：trail.worldSpace 而且是 Local 模擬時存世界座標（之後系統移動，拖尾留在原地） */
  trailPos(i: number, trail: Mod): Vector3 {
    const p = this.tmpV2.set(this.px[i], this.py[i], this.pz[i]);
    if (trail.worldSpace === 1 && !this.worldSpace && this.pose) p.applyMatrix4(this.pose.toWorld);
    return p;
  }

  private ageOrphans(): void {
    this.orphans = this.orphans.filter((o) => {
      while (o.points.length && this.clock - o.points[0].t > o.life) o.points.shift();
      return o.points.length > 1;
    });
  }

  /** 拿掉第 i 顆（跟最後一顆交換；Death 子發射器、拖尾的 dieWithParticles） */
  private kill(i: number): void {
    const trail = this.mod('TrailModule');
    const pts = this.trails[i];
    if (pts && pts.length > 1 && on(trail) && trail!.dieWithParticles === 0) {
      const color = new Float32Array(4);
      color.set(this.col.subarray(i * 4, i * 4 + 4));
      const lifeFrac = evalCurve(trail!.lifetime as MinMaxCurveData, 1, hash01(this.seed[i], SALT.trailLifetime));
      this.orphans.push({ points: pts, color, size: this.sx[i], life: lifeFrac * this.life[i] });
    }
    if (this.subs.length) {
      const wp = this.worldPos(i, new Vector3());
      for (const sub of this.subs) {
        if (sub.type === 2 && this.rng.next() <= sub.probability) sub.sim.triggerAt(wp, this, i, sub.properties);
      }
    }
    const last = --this.n;
    if (i !== last) {
      for (const k of ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'avx', 'avy', 'avz', 'age', 'life', 'sx', 'sy', 'sz', 'rx', 'ry', 'rz', 'nsz'] as const) this[k][i] = this[k][last];
      this.seed[i] = this.seed[last];
      this.id[i] = this.id[last];
      this.col.copyWithin(i * 4, last * 4, last * 4 + 4);
      this.trails[i] = this.trails[last];
    }
    this.trails[last] = null;
  }

  /** 第 i 顆的世界位置 */
  worldPos(i: number, out: Vector3): Vector3 {
    out.set(this.px[i], this.py[i], this.pz[i]);
    if (!this.worldSpace && this.pose) out.applyMatrix4(this.pose.toWorld);
    return out;
  }

  // ── 子發射器 ──

  private inheritOf(parent: ParticleSim, i: number, properties: number): TriggerInstance['inherit'] {
    const color = properties & 1 ? new Float32Array(parent.col.subarray(i * 4, i * 4 + 4)) : null;
    return {
      color,
      size: properties & 2 ? parent.sx[i] : 0,
      rotation: properties & 4 ? parent.rz[i] : 0,
      lifetime: properties & 8 ? Math.max(0, 1 - parent.age[i] / parent.life[i]) : 0,
    };
  }

  /** Birth：跟著父系統的第 i 顆，持續到它死掉 */
  trigger(parent: ParticleSim, i: number, properties: number): void {
    this.instances.push({
      pos: parent.worldPos(i, new Vector3()),
      vel: new Vector3(),
      time: 0,
      acc: 0,
      burstDone: [],
      parentId: parent.id[i],
      parent,
      inherit: this.inheritOf(parent, i, properties),
    });
  }

  /** Death：在世界位置 wp 開一份發射，跑一個 duration */
  triggerAt(wp: Vector3, parent: ParticleSim, i: number, properties: number): void {
    this.instances.push({ pos: wp.clone(), vel: new Vector3(), time: 0, acc: 0, burstDone: [], parentId: -1, parent: null, inherit: this.inheritOf(parent, i, properties) });
  }

  private stepInstances(dt: number): void {
    const em = this.mod('EmissionModule');
    const keep: TriggerInstance[] = [];
    for (const inst of this.instances) {
      if (inst.parentId >= 0 && inst.parent) {
        // 跟著父粒子：找不到（死了）就結束
        const p = inst.parent;
        let j = -1;
        for (let k = 0; k < p.n; k++)
          if (p.id[k] === inst.parentId) {
            j = k;
            break;
          }
        if (j < 0) continue;
        p.worldPos(j, inst.pos);
      }
      const t0 = inst.time;
      const t1 = Math.min(this.duration, t0 + dt);
      if (on(em)) {
        const rate = evalCurve(C(em, 'rateOverTime'), Math.min(1, t0 / this.duration), this.rng.next());
        inst.acc += rate * (t1 - t0);
        const count = Math.floor(inst.acc + 1e-6);
        inst.acc -= count;
        for (let k = 0; k < count; k++) this.emitOne(dt * (1 - (k + 1) / count), t0, k, count, null, inst);
        const bursts = (em!.m_Bursts as Mod[] | undefined) ?? [];
        for (let b = 0; b < bursts.length; b++) {
          const burst = bursts[b];
          const cycles = (burst.cycleCount as number) ?? 1;
          const interval = Math.max(0.0001, (burst.repeatInterval as number) ?? 0.01);
          let done = inst.burstDone[b] ?? 0;
          const bt = (burst.time as number) ?? 0;
          while ((cycles <= 0 || done < cycles) && bt + done * interval < t1) {
            const when = bt + done * interval;
            done++;
            if (this.rng.next() > ((burst.probability as number) ?? 1)) continue;
            const n = Math.round(evalCurve(burst.countCurve as MinMaxCurveData, Math.min(1, when / this.duration), this.rng.next()));
            for (let k = 0; k < n; k++) this.emitOne(0, when, k, n, null, inst);
          }
          inst.burstDone[b] = done;
        }
      }
      inst.time = t1;
      // Birth 跟著父粒子一直發（looping 的子系統繞回）；Death 跑一個 duration
      if (inst.parentId >= 0) {
        if (inst.time >= this.duration && this.looping) {
          inst.time = 0;
          inst.burstDone = [];
        }
        keep.push(inst);
      } else if (inst.time < this.duration) keep.push(inst);
    }
    this.instances = keep;
  }

  /** 這次 Play 期間可能的最長生命期（估包圍盒、BakeMesh 不需要；給除錯介面） */
  maxLifetime(): number {
    return curveMax(C(this.initial, 'startLifetime'));
  }
}

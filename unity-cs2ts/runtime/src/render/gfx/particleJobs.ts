// 粒子網格工作（2026/10/18，照 Unity 的 ParticleSystem.GeometryJob 在 worker 執行緒產生粒子網格；Unity issue tracker 有
// Android 上「ParticleSystem.GeometryJob … in the worker thread」的紀錄）：ParticleSystemRenderer 每一趟畫之前的 buildParticles
// 改在 render thread 的 worker 跑，結果直接寫進 GPU 的 buffer，主執行緒只算頂點數與三角形數（drawRange、上傳範圍）。
//
// 主執行緒（ParticleJobs）：
//   - SIM_DEF：粒子系統第一次用、或 buildParticles 讀的設定改了（模組物件、模組的欄位、renderer 的欄位照身分比；腳本的 setter 換的是
//     新值，unityParticles.ts）才送：InitialModule、SizeModule、NoiseModule、ColorModule、UVModule、CustomDataModule、
//     moveWithTransform、renderer 欄位、mesh 粒子的網格（JSON，數字來回不失真）。
//   - SIM_STATE：每一格每個系統第一次畫之前送一次：粒子的 SoA 陣列（n 顆）與發射器的 pose（double）。
//   - PARTICLE_JOB：每一趟一筆：攝影機（double）。
//   - three.js 上傳屬性與三角形時（GfxContext 的 bufferData／bufferSubData）改成 BUFFER_SUB_DATA_JOB，worker 從工作的輸出抄。
// worker（ParticleJobRunner）：照 SIM_DEF 建一份 ParticleSim、SIM_STATE 抄進去、PARTICLE_JOB 跑同一份 buildParticles，
// 同樣的輸入、同樣的程式，輸出逐位元相同（particleJobs.test.ts）。拖尾（buildTrails）的頂點數要看拖尾的點，留在主執行緒；
// UIParticle 的 BakeMesh 是腳本同步要結果，也留在主執行緒。

import { Matrix4, Quaternion, Vector3 } from 'three';
import { buildParticles, type BuildOptions, type ParticleCamera, type ParticleGeometry } from '../../particles/particleMesh';
import { ParticleSim, type EmitterPose } from '../../particles/system';
import type { SceneNode } from '../../unity/scene';
import type { ComponentData } from '../../unity/types';
import type { CmdWriter, GfxContext } from './client';
import { JOB_STREAM, OP } from './protocol';

/** buildParticles 讀的模組（particleMesh.ts：particleSize、particleColor、sheetFrame、custom、rotation3D） */
const MODULES = ['InitialModule', 'SizeModule', 'NoiseModule', 'ColorModule', 'UVModule', 'CustomDataModule'] as const;
/** buildParticles 讀的 ParticleSystemRenderer 欄位 */
const RENDERER_FIELDS = [
  'm_RenderMode',
  'm_UseCustomVertexStreams',
  'm_VertexStreams',
  'm_RenderAlignment',
  'm_Pivot',
  'm_Flip',
  'm_MinParticleSize',
  'm_MaxParticleSize',
  'm_LengthScale',
  'm_VelocityScale',
  'm_ApplyActiveColorSpace',
  'm_SortMode',
] as const;
/** SoA 的 float 陣列（ParticleSim 的欄位），照這個順序寫 */
const F32_FIELDS = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'avx', 'avy', 'avz', 'age', 'life', 'sx', 'sy', 'sz', 'rx', 'ry', 'rz', 'nsz'] as const;

export type ParticleMesh = BuildOptions['mesh'];

/** 這一趟的網格大小（跟 buildParticles 一樣：每顆粒子四邊形 4 個頂點 6 個索引，mesh 粒子照網格；None 是 0） */
export function particleCounts(n: number, renderer: Record<string, unknown>, mesh: ParticleMesh): { vertexCount: number; indexCount: number } {
  const mode = (renderer.m_RenderMode as number) ?? 0;
  if (mode === 5 || n === 0 || (mode === 4 && !mesh)) return { vertexCount: 0, indexCount: 0 };
  const perV = mode === 4 ? mesh!.position.length / 3 : 4;
  const perI = mode === 4 ? mesh!.indices.length : 6;
  return { vertexCount: n * perV, indexCount: n * perI };
}

interface SimEntry {
  id: number;
  /** 上次送 SIM_DEF 時的設定（身分與值） */
  fp: unknown[];
  /** 上次送 SIM_STATE 的格號 */
  frame: number;
}

/** 主執行緒端 */
export class ParticleJobs {
  private nextJob = 1;
  private nextSim = 1;
  private frame = 1;
  private readonly sims = new WeakMap<ParticleSim, SimEntry>();
  /** 統計（除錯用） */
  readonly stats = { jobs: 0, defs: 0, states: 0 };
  constructor(readonly gl: GfxContext) {}

  /** 一格結束（RenderThread.endFrame） */
  endFrame(): void {
    this.frame++;
  }

  /**
   * 這一趟的粒子網格交給 worker 產：回傳工作編號與網格大小（vertexCount 0 是不畫）。
   * 呼叫端接著登記屬性陣列（bindJobArray）、設上傳範圍與 drawRange，three.js 畫的時候上傳就會變成從這個工作抄
   */
  job(sim: ParticleSim, renderer: ComponentData, mesh: ParticleMesh, camera: ParticleCamera, linearColor: boolean): { job: number; vertexCount: number; indexCount: number } {
    const counts = particleCounts(sim.n, renderer, mesh);
    if (!counts.vertexCount) return { job: 0, ...counts };
    const e = this.entry(sim, renderer, mesh);
    if (e.frame !== this.frame) {
      this.writeState(e.id, sim);
      e.frame = this.frame;
    }
    const job = this.nextJob++;
    const w = this.gl.writer;
    w.need(4);
    w.i32[w.p++] = OP.PARTICLE_JOB;
    w.i32[w.p++] = job;
    w.i32[w.p++] = e.id;
    w.i32[w.p++] = linearColor ? 1 : 0;
    for (const v of [camera.position, camera.right, camera.up, camera.forward]) {
      w.double(v.x);
      w.double(v.y);
      w.double(v.z);
    }
    w.double(camera.orthographic ? 1 : 0);
    w.double(camera.fov);
    w.double(camera.orthoSize);
    this.stats.jobs++;
    return { job, ...counts };
  }

  /** 設定的指紋：模組物件與它的欄位、moveWithTransform、renderer 欄位、mesh（照身分比） */
  private fingerprint(sim: ParticleSim, renderer: ComponentData, mesh: ParticleMesh): unknown[] {
    const comp = sim.comp as Record<string, unknown>;
    const out: unknown[] = [comp.moveWithTransform, mesh];
    for (const k of MODULES) {
      const m = comp[k] as Record<string, unknown> | undefined;
      out.push(m);
      if (m) for (const key in m) out.push(key, m[key]);
    }
    for (const k of RENDERER_FIELDS) out.push(renderer[k]);
    return out;
  }

  private entry(sim: ParticleSim, renderer: ComponentData, mesh: ParticleMesh): SimEntry {
    const fp = this.fingerprint(sim, renderer, mesh);
    let e = this.sims.get(sim);
    if (e && e.fp.length === fp.length && e.fp.every((v, i) => v === fp[i])) return e;
    if (!e) {
      e = { id: this.nextSim++, fp, frame: 0 };
      this.sims.set(sim, e);
    } else e.fp = fp;
    const comp = sim.comp as Record<string, unknown>;
    const def = {
      comp: Object.fromEntries([['moveWithTransform', comp.moveWithTransform], ...MODULES.map((k) => [k, comp[k]])]),
      renderer: Object.fromEntries(RENDERER_FIELDS.map((k) => [k, renderer[k]])),
      mesh: mesh
        ? {
            position: Array.from(mesh.position),
            normal: mesh.normal ? Array.from(mesh.normal) : undefined,
            uv: mesh.uv ? Array.from(mesh.uv) : undefined,
            color: mesh.color ? Array.from(mesh.color) : undefined,
            indices: Array.from(mesh.indices),
          }
        : null,
    };
    const w = this.gl.writer;
    w.need(2);
    w.i32[w.p++] = OP.SIM_DEF;
    w.i32[w.p++] = e.id;
    w.str(JSON.stringify(def));
    // 設定換了：狀態也重送（同一格裡之後的工作用新的 ParticleSim）
    e.frame = 0;
    this.stats.defs++;
    return e;
  }

  private writeState(id: number, sim: ParticleSim): void {
    const n = sim.n;
    const w = this.gl.writer;
    w.need(3 + n * (F32_FIELDS.length + 6));
    w.i32[w.p++] = OP.SIM_STATE;
    w.i32[w.p++] = id;
    w.i32[w.p++] = n;
    const f = w.f32;
    const u = w.u32;
    let p = w.p;
    for (const k of F32_FIELDS) {
      const a = sim[k];
      for (let i = 0; i < n; i++) f[p + i] = a[i];
      p += n;
    }
    const col = sim.col;
    for (let i = 0; i < n * 4; i++) f[p + i] = col[i];
    p += n * 4;
    const seed = sim.seed;
    for (let i = 0; i < n; i++) u[p + i] = seed[i];
    p += n;
    const idArr = sim.id;
    for (let i = 0; i < n; i++) u[p + i] = idArr[i];
    p += n;
    w.p = p;
    writePose(w, sim.pose);
    this.stats.states++;
  }
}

function writePose(w: CmdWriter, pose: EmitterPose | null): void {
  w.need(1);
  w.i32[w.p++] = pose ? (pose.shapeScale ? 2 : 1) : 0;
  if (!pose) return;
  for (const v of pose.toWorld.elements) w.double(v);
  for (const v of [pose.position.x, pose.position.y, pose.position.z, pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w, pose.sizeScale.x, pose.sizeScale.y, pose.sizeScale.z]) w.double(v);
  if (pose.shapeScale) for (const v of [pose.shapeScale.x, pose.shapeScale.y, pose.shapeScale.z]) w.double(v);
}

/** 重播端讀 SIM_STATE、PARTICLE_JOB 用的游標（replay.ts 給） */
export interface JobReader {
  i32(): number;
  u32s(n: number): Uint32Array;
  f32s(n: number): Float32Array;
  double(): number;
}

const NODE_STUB = {} as SceneNode;

/** worker 端：照指令建 ParticleSim、跑 buildParticles，留著輸出等 BUFFER_SUB_DATA_JOB 來抄 */
export class ParticleJobRunner {
  private readonly sims = new Map<number, { sim: ParticleSim; renderer: Record<string, unknown>; mesh: ParticleMesh }>();
  private readonly jobs = new Map<number, { frame: number; geo: ParticleGeometry }>();
  private frame = 0;

  def(simId: number, json: string): void {
    const d = JSON.parse(json) as { comp: ComponentData; renderer: Record<string, unknown>; mesh: ParticleMesh };
    this.sims.set(simId, { sim: new ParticleSim(d.comp, NODE_STUB), renderer: d.renderer, mesh: d.mesh });
  }

  state(simId: number, r: JobReader): void {
    const n = r.i32();
    const e = this.sims.get(simId);
    // 沒有 SIM_DEF（不該發生）：照樣把資料讀掉，游標才對得上
    const sim = e?.sim ?? new ParticleSim({} as ComponentData, NODE_STUB);
    for (const k of F32_FIELDS) sim[k] = r.f32s(n).slice();
    sim.col = r.f32s(n * 4).slice();
    sim.seed = r.u32s(n).slice();
    sim.id = r.u32s(n).slice();
    sim.n = n;
    sim.cap = n;
    const kind = r.i32();
    if (!kind) {
      sim.pose = null;
      return;
    }
    const m = new Matrix4();
    for (let i = 0; i < 16; i++) m.elements[i] = r.double();
    const position = new Vector3(r.double(), r.double(), r.double());
    const rotation = new Quaternion(r.double(), r.double(), r.double(), r.double());
    const sizeScale = new Vector3(r.double(), r.double(), r.double());
    const shapeScale = kind === 2 ? new Vector3(r.double(), r.double(), r.double()) : null;
    sim.setPose({ toWorld: m, position, rotation, sizeScale, shapeScale });
  }

  job(jobId: number, simId: number, r: JobReader): void {
    const linearColor = r.i32() === 1;
    const v = (): Vector3 => new Vector3(r.double(), r.double(), r.double());
    const camera: ParticleCamera = { position: v(), right: v(), up: v(), forward: v(), orthographic: r.double() === 1, fov: r.double(), orthoSize: r.double() };
    const e = this.sims.get(simId);
    if (!e) throw new Error(`粒子網格工作 ${jobId}：沒有系統 ${simId}`);
    this.jobs.set(jobId, { frame: this.frame, geo: buildParticles(e.sim, { camera, renderer: e.renderer, linearColor, mesh: e.mesh }) });
  }

  /** 工作的輸出（資料流：JOB_STREAM） */
  data(jobId: number, stream: number): Float32Array | Uint32Array | null {
    const g = this.jobs.get(jobId)?.geo;
    if (!g) return null;
    if (stream === JOB_STREAM.position) return g.position;
    if (stream === JOB_STREAM.normal) return g.normal;
    if (stream === JOB_STREAM.color) return g.color;
    if (stream === JOB_STREAM.indices) return g.indices;
    return g.texcoords[stream - JOB_STREAM.texcoord0] ?? null;
  }

  /** 一格結束：留這一格與上一格的輸出（陣列的登記指向最近一次工作；隔格才上傳的照樣找得到），更早的丟掉 */
  endFrame(): void {
    this.frame++;
    for (const [id, j] of this.jobs) if (j.frame < this.frame - 1) this.jobs.delete(id);
  }
}

// 粒子網格工作：同一個粒子系統跑多格，每隔幾格比「主執行緒的 buildParticles」跟「經指令（SIM_DEF、SIM_STATE、PARTICLE_JOB）
// 在重播端 ParticleJobRunner 產生的」，逐位元相同（Float32 照位元比）；three.js 上傳登記過的陣列時，GL 收到的是工作的輸出。
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { World } from '../../engine/world';
import { SceneGraph } from '../../unity/scene';
import type { ComponentData, GameObjectData, SceneFile } from '../../unity/types';
import { buildParticles, type ParticleCamera, type ParticleGeometry } from '../../particles/particleMesh';
import { GfxContext, type Segment, type ShadowGL } from './client';
import { ParticleJobRunner, ParticleJobs, particleCounts } from './particleJobs';
import { JOB_STREAM } from './protocol';
import { GfxReplayer } from './replay';

const K = (v: number) => ({ minMaxState: 0, scalar: v, minScalar: v, maxCurve: { m_Curve: [] }, minCurve: { m_Curve: [] } });
const RANGE = (a: number, b: number) => ({ minMaxState: 3, scalar: b, minScalar: a });
const CURVE = (pts: [number, number][]) => ({ minMaxState: 1, scalar: 1, maxCurve: { m_Curve: pts.map(([time, value]) => ({ time, value, inSlope: 0, outSlope: 0 })) } });
const GRAD = { m_Mode: 0, m_NumColorKeys: 3, m_NumAlphaKeys: 2, key0: { r: 1, g: 0, b: 0, a: 1 }, key1: { r: 0, g: 1, b: 0, a: 0.2 }, key2: { r: 0, g: 0, b: 1, a: 1 }, ctime0: 0, ctime1: 30000, ctime2: 65535, atime0: 0, atime1: 65535 };

function psData(id: string, modules: Record<string, Record<string, unknown>> = {}, over: Record<string, unknown> = {}): ComponentData {
  return {
    type: 'ParticleSystem',
    classID: 198,
    gameObject: id,
    lengthInSec: 2,
    simulationSpeed: 1,
    looping: 1,
    prewarm: 0,
    playOnAwake: 1,
    autoRandomSeed: 0,
    randomSeed: 7,
    startDelay: K(0),
    moveWithTransform: 0,
    scalingMode: 1,
    stopAction: 0,
    InitialModule: { enabled: 1, startLifetime: RANGE(0.5, 1.5), startSpeed: RANGE(1, 3), startColor: { minMaxState: 2, minColor: { r: 0.2, g: 0.4, b: 0.6, a: 0.5 }, maxColor: { r: 1, g: 1, b: 1, a: 1 } }, startSize: RANGE(0.2, 1), startSizeY: K(1), startSizeZ: K(1), startRotation: RANGE(-3, 3), startRotationX: K(0), startRotationY: K(0), maxNumParticles: 1000, gravityModifier: K(0.3), ...(modules.InitialModule ?? {}) },
    ShapeModule: { enabled: 1, type: 4, angle: 25, radius: { value: 1 }, radiusThickness: 1, arc: { value: 360, mode: 0 }, ...(modules.ShapeModule ?? {}) },
    EmissionModule: { enabled: 1, rateOverTime: K(40), rateOverDistance: K(0), m_Bursts: [], ...(modules.EmissionModule ?? {}) },
    ...Object.fromEntries(Object.entries(modules).filter(([k]) => !['InitialModule', 'ShapeModule', 'EmissionModule'].includes(k))),
    ...over,
  } as unknown as ComponentData;
}

const T = (go: string, pos = { x: 0, y: 0, z: 0 }) => ({ type: 'Transform', classID: 4, gameObject: go, m_LocalPosition: pos, m_LocalRotation: { x: 0.1, y: 0.2, z: 0, w: 0.97 }, m_LocalScale: { x: 1.5, y: 1, z: 0.8 }, m_Father: null, m_Children: [] });
const GO = (name: string, transform: string, components: string[]): GameObjectData => ({ m_Name: name, m_IsActive: 1, m_Layer: 0, m_TagString: 'Untagged', transform, parent: null, children: [], components: [transform, ...components] });

function worldOf(systems: ComponentData[]): World {
  const file: SceneFile = { guid: 'g', name: 's', src: 's.unity', settings: {}, roots: [], gameObjects: {}, components: {} };
  systems.forEach((ps, k) => {
    const go = String(100 + k * 10);
    file.roots.push(go);
    file.gameObjects[go] = GO(`FX${k}`, `${go}1`, [`${go}2`]);
    file.components[`${go}1`] = T(go, { x: k, y: 0.5 * k, z: 0 }) as unknown as ComponentData;
    file.components[`${go}2`] = { ...ps, gameObject: go } as ComponentData;
  });
  const w = new World(new SceneGraph(file), { localization: undefined as never, version: 'test', controllers: {}, clips: {}, registry: {}, layout: {}, sortingLayerIndex: () => 0 });
  w.start();
  return w;
}

const shadow = new Proxy({}, { get: () => () => null }) as unknown as ShadowGL;

/** 指令的往返：ParticleJobs 寫、GfxReplayer＋ParticleJobRunner 讀 */
function pipe() {
  const segs: Segment[] = [];
  const gl = new GfxContext({ constants: {}, shadow, attributes: null, extensions: [], params: {}, width: 1, height: 1, send: (s) => segs.push(s) });
  const jobs = new ParticleJobs(gl);
  const runner = new ParticleJobRunner();
  const uploads: { data: Uint8Array }[] = [];
  const fakeGl = new Proxy(
    {},
    {
      get: (_t, name: string) =>
        name === 'bufferSubData'
          ? (_target: number, _dst: number, data: ArrayBufferView, off: number, len: number) => {
              const el = (data as Float32Array).BYTES_PER_ELEMENT;
              uploads.push({ data: new Uint8Array(data.buffer, data.byteOffset + off * el, len * el).slice() });
            }
          : () => undefined,
    },
  ) as unknown as WebGL2RenderingContext;
  const replayer = new GfxReplayer(fakeGl, { jobs: runner });
  let frame = 0;
  const flush = () => {
    gl.endFrame(++frame);
    jobs.endFrame();
    for (const s of segs.splice(0)) replayer.run(s.buf, s.words, s.ext as never, []);
    runner.endFrame();
  };
  return { gl, jobs, runner, uploads, flush };
}

const bits = (a: Float32Array | Uint32Array): number[] => Array.from(new Uint32Array(a.buffer, a.byteOffset, a.length));
function same(main: ParticleGeometry, job: number, runner: ParticleJobRunner): void {
  expect(bits(runner.data(job, JOB_STREAM.position)!)).toEqual(bits(main.position));
  expect(bits(runner.data(job, JOB_STREAM.normal)!)).toEqual(bits(main.normal));
  expect(bits(runner.data(job, JOB_STREAM.color)!)).toEqual(bits(main.color));
  main.texcoords.forEach((tc, k) => expect(bits(runner.data(job, JOB_STREAM.texcoord0 + k)!)).toEqual(bits(tc)));
  expect(Array.from(runner.data(job, JOB_STREAM.indices)!)).toEqual(Array.from(main.indices));
}

const CAMS: ParticleCamera[] = [
  { position: new Vector3(1.25, 2.5, -10.1), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), forward: new Vector3(0, 0, 1), orthographic: false, fov: 60, orthoSize: 5 },
  { position: new Vector3(-3.3, 0.7, -7.9), right: new Vector3(0.98, 0, 0.199), up: new Vector3(0, 1, 0), forward: new Vector3(-0.199, 0, 0.98), orthographic: true, fov: 30, orthoSize: 6.1 },
];
const MESH = { position: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0.5], normal: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1], color: [1, 0.5, 0.5, 1, 1, 1, 1, 1, 0.2, 0.2, 1, 1, 1, 1, 1, 0.5], uv: [0, 0, 1, 0, 0, 1, 1, 1], indices: [0, 1, 2, 2, 1, 3] };

const SYSTEMS = (): { ps: ComponentData; renderer: Record<string, unknown>; mesh?: typeof MESH }[] => [
  { ps: psData('a', { ColorModule: { enabled: 1, gradient: { minMaxState: 1, maxGradient: GRAD } }, SizeModule: { enabled: 1, curve: CURVE([[0, 0.2], [1, 1.4]]), separateAxes: 0 } }), renderer: { m_RenderMode: 0, m_MaxParticleSize: 10, m_Flip: { x: 0.4, y: 0.7, z: 0 }, m_SortMode: 1 } },
  { ps: psData('b', { UVModule: { enabled: 1, mode: 0, tilesX: 2, tilesY: 3, animationType: 0, cycles: 2, frameOverTime: CURVE([[0, 0], [1, 1]]), startFrame: K(0), flipU: 0.5, flipV: 0.3 } }), renderer: { m_RenderMode: 1, m_MaxParticleSize: 10, m_LengthScale: 1.5, m_VelocityScale: 0.2, m_UseCustomVertexStreams: 1, m_VertexStreams: '000103040b0c0d1415', m_SortMode: 2 } },
  { ps: psData('c', { NoiseModule: { enabled: 1, strength: K(0.8), frequency: 0.7, scrollSpeed: K(0.3), octaves: 2, sizeAmount: K(0.5), rotationAmount: K(0.4), separateAxes: 0 }, InitialModule: { rotation3D: 1, startRotationX: RANGE(-1, 1), startRotationY: RANGE(-1, 1) } }), renderer: { m_RenderMode: 4, m_MaxParticleSize: 10, m_SortMode: 3, m_RenderAlignment: 1 }, mesh: MESH },
  { ps: psData('d', { CustomDataModule: { enabled: 1, mode0: 1, vectorComponentCount0: 3, vector0_0: CURVE([[0, 1], [1, 0]]), vector0_1: RANGE(0, 2), vector0_2: K(0.25), mode1: 2, color1: { minMaxState: 1, maxGradient: GRAD } } }, { moveWithTransform: 1 }), renderer: { m_RenderMode: 3, m_MaxParticleSize: 0.2, m_MinParticleSize: 0.01, m_UseCustomVertexStreams: 1, m_VertexStreams: '00010304181a', m_ApplyActiveColorSpace: 0, m_Pivot: { x: 0.2, y: -0.1, z: 0 } } },
];

describe('粒子網格工作：worker 產生的跟主執行緒的逐位元相同', () => {
  it('多格、兩台攝影機、四種設定（billboard、stretch、mesh、vertical＋自訂資料流）', () => {
    const sys = SYSTEMS();
    const w = worldOf(sys.map((s) => s.ps));
    const { jobs, runner, flush } = pipe();
    const comps = Object.values(w.graph.file.components).filter((c) => c.type === 'ParticleSystem');
    let checked = 0;
    for (let f = 1; f <= 90; f++) {
      w.tick(1 / 60);
      if (f % 7) continue;
      const results: { job: number; main: ParticleGeometry }[] = [];
      for (let k = 0; k < sys.length; k++) {
        const s = sys[k];
        const sim = w.particles.existing(comps[k])!;
        for (const cam of CAMS) {
          const j = jobs.job(sim, s.renderer as unknown as ComponentData, s.mesh ?? null, cam, true);
          const main = buildParticles(sim, { camera: cam, renderer: s.renderer, linearColor: true, mesh: s.mesh ?? null });
          expect(j.vertexCount).toBe(main.vertexCount);
          expect(j.indexCount).toBe(main.indices.length);
          if (j.vertexCount) results.push({ job: j.job, main });
        }
      }
      flush();
      for (const r of results) {
        same(r.main, r.job, runner);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('停止、清除、重新播放（亂數接著走）與中途換模組設定、renderer 欄位', () => {
    const sys = SYSTEMS().slice(0, 2);
    const w = worldOf(sys.map((s) => s.ps));
    const { jobs, runner, flush } = pipe();
    const comps = Object.values(w.graph.file.components).filter((c) => c.type === 'ParticleSystem');
    const sims = () => comps.map((c) => w.particles.existing(c)!);
    for (let f = 1; f <= 120; f++) {
      w.tick(1 / 60);
      if (f === 20) w.particles.stop(comps[0], false, false);
      if (f === 40) w.particles.clear(comps[1], false);
      if (f === 55) w.particles.play(comps[0], false);
      // 腳本的 setter 換新值（unityParticles.ts）：模組的欄位、整個模組
      if (f === 60) (comps[0].ColorModule as Record<string, unknown>).gradient = { minMaxState: 0, maxColor: { r: 0.3, g: 0.9, b: 0.1, a: 0.7 } };
      if (f === 75) (comps[1] as Record<string, unknown>).SizeModule = { enabled: 1, curve: CURVE([[0, 1], [1, 0]]), separateAxes: 0 };
      if (f === 90) sys[0].renderer.m_SortMode = 2;
      if (f % 5) continue;
      const results: { job: number; main: ParticleGeometry }[] = [];
      sims().forEach((sim, k) => {
        const j = jobs.job(sim, sys[k].renderer as unknown as ComponentData, null, CAMS[f % 2], f % 3 === 0);
        const main = buildParticles(sim, { camera: CAMS[f % 2], renderer: sys[k].renderer, linearColor: f % 3 === 0, mesh: null });
        expect(j.vertexCount).toBe(main.vertexCount);
        if (j.vertexCount) results.push({ job: j.job, main });
      });
      flush();
      for (const r of results) same(r.main, r.job, runner);
    }
    expect(jobs.stats.defs).toBeGreaterThanOrEqual(5); // 兩個系統各一次，加上三次改設定
  });

  it('登記成工作輸出的陣列：three.js 上傳時 GL 收到工作的輸出（bufferSubData 範圍、bufferData 整個陣列補 0）', () => {
    const sys = SYSTEMS().slice(0, 1);
    const w = worldOf(sys.map((s) => s.ps));
    for (let f = 0; f < 30; f++) w.tick(1 / 60);
    const sim = w.particles.existing(Object.values(w.graph.file.components).find((c) => c.type === 'ParticleSystem')!)!;
    const { gl, jobs, uploads, flush } = pipe();
    const j = jobs.job(sim, sys[0].renderer as unknown as ComponentData, null, CAMS[0], true);
    const main = buildParticles(sim, { camera: CAMS[0], renderer: sys[0].renderer, linearColor: true, mesh: null });
    const pos = new Float32Array(j.vertexCount * 3 * 2);
    const idx = new Uint32Array(j.indexCount * 2);
    gl.bindJobArray(pos, j.job, JOB_STREAM.position);
    gl.bindJobArray(idx, j.job, JOB_STREAM.indices);
    gl.bufferSubData(0x8892, 0, pos, 0, j.vertexCount * 3);
    gl.bufferData(0x8893, idx, 0x88e8);
    flush();
    expect(uploads[0].data).toEqual(new Uint8Array(main.position.buffer, main.position.byteOffset, main.position.byteLength));
    expect(uploads[1].data).toEqual(new Uint8Array(main.indices.buffer, main.indices.byteOffset, main.indices.byteLength));
  });

  it('頂點數：None、沒有網格的 mesh 模式、沒有粒子是 0', () => {
    expect(particleCounts(10, { m_RenderMode: 5 }, null).vertexCount).toBe(0);
    expect(particleCounts(10, { m_RenderMode: 4 }, null).vertexCount).toBe(0);
    expect(particleCounts(0, { m_RenderMode: 0 }, null).vertexCount).toBe(0);
    expect(particleCounts(10, { m_RenderMode: 4 }, MESH)).toEqual({ vertexCount: 40, indexCount: 60 });
  });
});

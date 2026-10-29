// 粒子系統（2026/10/17，MT2 的粒子）：模擬、形狀、網格、頂點資料流、管理器的生命週期。數值照 Unity 手冊的定義推算。
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { World } from '../engine/world';
import { SceneGraph } from '../unity/scene';
import { setActive } from '../unity/instantiate';
import type { ComponentData, GameObjectData, SceneFile } from '../unity/types';
import { ParticleRandom } from './curves';
import { emitFromShape } from './shape';
import { buildParticles, buildTrails, parseVertexStreams, streamLayout, type ParticleCamera } from './particleMesh';

const K = (v: number) => ({ minMaxState: 0, scalar: v, minScalar: v, maxCurve: { m_Curve: [] }, minCurve: { m_Curve: [] } });
const WHITE = { minMaxState: 0, maxColor: { r: 1, g: 1, b: 1, a: 1 }, minColor: { r: 1, g: 1, b: 1, a: 1 } };

function psData(over: Record<string, unknown> = {}, modules: Record<string, Record<string, unknown>> = {}): ComponentData {
  return {
    type: 'ParticleSystem',
    classID: 198,
    gameObject: '10',
    lengthInSec: 5,
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
    InitialModule: { enabled: 1, startLifetime: K(1), startSpeed: K(0), startColor: WHITE, startSize: K(1), startSizeY: K(1), startSizeZ: K(1), startRotation: K(0), startRotationX: K(0), startRotationY: K(0), maxNumParticles: 1000, gravityModifier: K(0), ...(modules.InitialModule ?? {}) },
    ShapeModule: { enabled: 0, type: 4, ...(modules.ShapeModule ?? {}) },
    EmissionModule: { enabled: 1, rateOverTime: K(10), rateOverDistance: K(0), m_Bursts: [], ...(modules.EmissionModule ?? {}) },
    ...over,
    ...Object.fromEntries(Object.entries(modules).filter(([k]) => !['InitialModule', 'ShapeModule', 'EmissionModule'].includes(k))),
  } as unknown as ComponentData;
}

const T = (go: string, parent: string | null = null) => ({ type: 'Transform', classID: 4, gameObject: go, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_Father: parent, m_Children: [] });
const GO = (name: string, transform: string, components: string[], children: string[] = [], parent: string | null = null, active = 1): GameObjectData => ({
  m_Name: name, m_IsActive: active, m_Layer: 0, m_TagString: 'Untagged', transform, parent, children, components: [transform, ...components],
});

function worldWith(ps: ComponentData, extra: { sub?: ComponentData } = {}): { w: World; file: SceneFile } {
  const file: SceneFile = {
    guid: 'g', name: 's', src: 's.unity', settings: {},
    roots: ['10'],
    gameObjects: { '10': GO('FX', '11', ['12'], extra.sub ? ['20'] : []) },
    components: { '11': T('10') as unknown as ComponentData, '12': ps },
  };
  if (extra.sub) {
    file.gameObjects['20'] = GO('Sub', '21', ['22'], [], '10');
    file.components['21'] = T('20', '11') as unknown as ComponentData;
    file.components['22'] = { ...extra.sub, gameObject: '20' } as ComponentData;
  }
  const w = new World(new SceneGraph(file), { localization: undefined as never, version: 'test', controllers: {}, clips: {}, registry: {}, layout: {}, sortingLayerIndex: () => 0 });
  w.start();
  return { w, file };
}
function run(w: World, seconds: number, dt = 1 / 60): void {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) w.tick(dt);
}

describe('粒子的模擬', () => {
  it('rateOverTime 10：一秒發 10 顆；生命期 1 秒，穩定在 10 顆左右', () => {
    const ps = psData();
    const { w } = worldWith(ps);
    run(w, 0.5);
    const sim = w.particles.existing(ps)!;
    expect(sim.isPlaying).toBe(true);
    expect(sim.n).toBe(5);
    run(w, 2);
    // 剛好滿 1 秒的那顆，浮點的年齡可能是 0.99999（還沒死）
    expect(sim.n).toBeGreaterThanOrEqual(9);
    expect(sim.n).toBeLessThanOrEqual(11);
  });

  it('burst：time 0 發 5 顆，repeatInterval 0.5、cycleCount 2；不循環的跑完、粒子死光後停下來並執行 stopAction（Disable）', () => {
    const burst = { time: 0, countCurve: K(5), cycleCount: 2, repeatInterval: 0.5, probability: 1 };
    const ps = psData({ looping: 0, lengthInSec: 1, stopAction: 1 }, { EmissionModule: { rateOverTime: K(0), m_Bursts: [burst] }, InitialModule: { startLifetime: K(0.3) } });
    const { w } = worldWith(ps);
    w.tick(1 / 60);
    const sim = w.particles.existing(ps)!;
    expect(sim.n).toBe(5);
    run(w, 0.5);
    expect(sim.n).toBe(5); // 第一批死了（0.3 秒），第二批在 0.5 秒出生
    run(w, 1.2);
    expect(sim.isPlaying).toBe(false);
    expect(sim.n).toBe(0);
    expect(w.graph.nodes.get('10')!.go.m_IsActive).toBe(0);
  });

  it('重力：gravityModifier 1，一秒後速度 −9.81（y）', () => {
    const ps = psData({}, { EmissionModule: { rateOverTime: K(0), m_Bursts: [{ time: 0, countCurve: K(1), cycleCount: 1, repeatInterval: 1, probability: 1 }] }, InitialModule: { startLifetime: K(5), gravityModifier: K(1) } });
    const { w } = worldWith(ps);
    run(w, 1, 1 / 100);
    const sim = w.particles.existing(ps)!;
    expect(sim.vy[0]).toBeCloseTo(-9.81, 1);
  });

  it('Local 模擬的粒子跟著發射器走；World 模擬的留在原地', () => {
    const one = { EmissionModule: { rateOverTime: K(0), m_Bursts: [{ time: 0, countCurve: K(1), cycleCount: 1, repeatInterval: 1, probability: 1 }] }, InitialModule: { startLifetime: K(5) } };
    for (const [space, expectX] of [
      [0, 3],
      [1, 0],
    ] as const) {
      const ps = psData({ moveWithTransform: space }, one);
      const { w, file } = worldWith(ps);
      w.tick(1 / 60);
      (file.components['11'] as unknown as { m_LocalPosition: { x: number; y: number; z: number } }).m_LocalPosition = { x: 3, y: 0, z: 0 };
      w.tick(1 / 60);
      const sim = w.particles.existing(ps)!;
      expect(sim.worldPos(0, new Vector3()).x).toBeCloseTo(expectX, 5);
    }
  });

  it('prewarm（looping）：Play 的那一格就像已經跑了一整個 duration', () => {
    const ps = psData({ prewarm: 1, lengthInSec: 2 }, { InitialModule: { startLifetime: K(1) } });
    const { w } = worldWith(ps);
    w.tick(1 / 60);
    expect(w.particles.existing(ps)!.n).toBeGreaterThanOrEqual(9);
  });

  it('物件停用：粒子清掉、停止；再啟用照 playOnAwake 從頭播', () => {
    const ps = psData();
    const { w } = worldWith(ps);
    run(w, 1);
    const sim = w.particles.existing(ps)!;
    expect(sim.n).toBeGreaterThan(0);
    setActive(w, w.graph.nodes.get('10')!, false);
    expect(sim.n).toBe(0);
    expect(sim.isPlaying).toBe(false);
    setActive(w, w.graph.nodes.get('10')!, true);
    expect(sim.isPlaying).toBe(true);
  });

  it('Death 子發射器：父粒子死掉的地方發子系統的 burst；子系統自己不照 playOnAwake 發射', () => {
    const sub = psData({}, { EmissionModule: { rateOverTime: K(0), m_Bursts: [{ time: 0, countCurve: K(3), cycleCount: 1, repeatInterval: 1, probability: 1 }] }, InitialModule: { startLifetime: K(2) } });
    const parent = psData(
      {},
      {
        EmissionModule: { rateOverTime: K(0), m_Bursts: [{ time: 0, countCurve: K(2), cycleCount: 1, repeatInterval: 1, probability: 1 }] },
        InitialModule: { startLifetime: K(0.5) },
        SubModule: { enabled: 1, subEmitters: [{ emitter: { fileID: '22' }, type: 2, properties: 0, emitProbability: 1 }] },
      },
    );
    const { w, file } = worldWith(parent, { sub });
    run(w, 0.3);
    const subSim = w.particles.existing(file.components['22'])!;
    expect(subSim.n).toBe(0);
    run(w, 0.4);
    expect(subSim.n).toBe(6);
  });
});

describe('粒子的形狀', () => {
  it('Circle（radiusThickness 0）：XY 平面、半徑 2、方向朝外', () => {
    const rng = new ParticleRandom(3);
    const pos = new Vector3();
    const dir = new Vector3();
    for (let i = 0; i < 20; i++) {
      emitFromShape({ enabled: 1, type: 10, radiusThickness: 0, radius: { value: 2 }, arc: { value: 360 } }, rng, 0, 0, 0, 1, pos, dir);
      expect(pos.length()).toBeCloseTo(2, 5);
      expect(pos.z).toBe(0);
      expect(dir.dot(pos.clone().normalize())).toBeCloseTo(1, 5);
    }
  });
  it('Cone（angle 0）：底面在 XY 平面、方向全部 +Z；BurstSpread 平均分布', () => {
    const rng = new ParticleRandom(5);
    const pos = new Vector3();
    const dir = new Vector3();
    const angles: number[] = [];
    for (let i = 0; i < 4; i++) {
      emitFromShape({ enabled: 1, type: 4, angle: 0, radiusThickness: 0, radius: { value: 1 }, arc: { value: 360, mode: 3 } }, rng, 0, 0, i, 4, pos, dir);
      expect(dir.z).toBeCloseTo(1, 6);
      angles.push(Math.round((Math.atan2(pos.y, pos.x) * 180) / Math.PI));
    }
    expect(angles).toEqual([0, 90, 180, -90]);
  });
});

describe('粒子的網格', () => {
  it('m_VertexStreams：十六進位字串照讀；被 YAML 讀成數字的補回開頭的 0 與 Position', () => {
    expect(parseVertexStreams('00010304')).toEqual([0, 1, 3, 4]);
    expect(parseVertexStreams(103040522)).toEqual([0, 1, 3, 4, 5, 0x22]);
    expect(parseVertexStreams(1030409)).toEqual([0, 1, 3, 4, 9]);
    // UV（2）→ TEXCOORD0.xy、UV2（2）→ TEXCOORD0.zw、Custom1XYZW（4）→ TEXCOORD1
    const l = streamLayout([0, 1, 3, 4, 5, 0x22]);
    expect([l.offset.get(4), l.offset.get(5), l.offset.get(0x22), l.texcoordCount]).toEqual([0, 2, 4, 2]);
  });

  it('billboard（View 對齊）：四個角在攝影機平面、大小 1；貼圖格 2×2 的第 0 格是左上', () => {
    const ps = psData({}, { EmissionModule: { rateOverTime: K(0), m_Bursts: [{ time: 0, countCurve: K(1), cycleCount: 1, repeatInterval: 1, probability: 1 }] }, InitialModule: { startLifetime: K(5) }, UVModule: { enabled: 1, mode: 0, tilesX: 2, tilesY: 2, animationType: 0, cycles: 1, frameOverTime: K(0), startFrame: K(0) } });
    const { w } = worldWith(ps);
    w.tick(1 / 60);
    const sim = w.particles.existing(ps)!;
    const cam: ParticleCamera = { position: new Vector3(0, 0, -10), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), forward: new Vector3(0, 0, 1), orthographic: false, fov: 60, orthoSize: 5 };
    const g = buildParticles(sim, { camera: cam, renderer: { m_RenderMode: 0, m_MaxParticleSize: 10 }, linearColor: false });
    expect(g.vertexCount).toBe(4);
    expect(Array.from(g.position)).toEqual([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    // 第 0 格 ＝ 左上：u 0～0.5、v 0.5～1
    expect(Array.from(g.texcoords[0]).filter((_, k) => k % 4 < 2)).toEqual([0, 0.5, 0.5, 0.5, 0.5, 1, 0, 1]);
    // 面向攝影機看順時針
    expect(Array.from(g.indices)).toEqual([0, 3, 2, 0, 2, 1]);
  });

  it('scratch（共用暫存陣列）：結果跟每次新配的一樣，前一次留下的較大資料不會混進來', () => {
    const burst = (count: number) =>
      psData({}, { EmissionModule: { rateOverTime: K(0), m_Bursts: [{ time: 0, countCurve: K(count), cycleCount: 1, repeatInterval: 1, probability: 1 }] }, InitialModule: { startLifetime: K(5), startSpeed: K(2) }, ShapeModule: { enabled: 1, type: 4, angle: 30, radius: { value: 1 }, radiusThickness: 1, arc: { value: 360, mode: 0 } } });
    const big = burst(30);
    const small = burst(3);
    const { w: wb } = worldWith(big);
    const { w: ws } = worldWith(small);
    for (let f = 0; f < 10; f++) {
      wb.tick(1 / 60);
      ws.tick(1 / 60);
    }
    const simBig = wb.particles.existing(big)!;
    const simSmall = ws.particles.existing(small)!;
    const cam: ParticleCamera = { position: new Vector3(0, 0, -10), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), forward: new Vector3(0, 0, 1), orthographic: false, fov: 60, orthoSize: 5 };
    // UV、角（11）、大小（12）、Custom1（0x22，沒開 Custom Data 寫 0）；mesh 粒子的網格沒有法線（法線不寫）
    const quad = { m_RenderMode: 0, m_MaxParticleSize: 10, m_UseCustomVertexStreams: 1, m_VertexStreams: '000103040b0c22' };
    const meshR = { m_RenderMode: 4, m_MaxParticleSize: 10 };
    const mesh = { position: [0, 0, 0, 1, 0, 0, 0, 1, 0], uv: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
    const flat = (g: ReturnType<typeof buildParticles>) => ({
      n: g.vertexCount,
      position: Array.from(g.position),
      normal: Array.from(g.normal),
      color: Array.from(g.color),
      texcoords: g.texcoords.map((a) => Array.from(a)),
      indices: Array.from(g.indices),
    });
    for (const renderer of [quad, meshR]) {
      const fresh = flat(buildParticles(simSmall, { camera: cam, renderer, linearColor: false, mesh }));
      // 先用大的把共用陣列填滿非 0 的資料（法線、TEXCOORD 全部寫過）
      buildParticles(simBig, { camera: cam, renderer: quad, linearColor: false, scratch: true });
      const reused = flat(buildParticles(simSmall, { camera: cam, renderer, linearColor: false, mesh, scratch: true }));
      expect(reused.n).toBeGreaterThan(0);
      expect(reused).toEqual(fresh);
    }
    // 拖尾也一樣
    const trailPs = psData({}, {
      InitialModule: { startLifetime: K(5), startSpeed: K(3) },
      TrailModule: { enabled: 1, mode: 0, ratio: 1, lifetime: K(1), minVertexDistance: 0.01, worldSpace: 0, dieWithParticles: 1, sizeAffectsWidth: 1, inheritParticleColor: 1, widthOverTrail: K(1), colorOverTrail: WHITE, colorOverLifetime: WHITE },
    });
    const { w: wt } = worldWith(trailPs);
    for (let f = 0; f < 20; f++) wt.tick(1 / 60);
    const simT = wt.particles.existing(trailPs)!;
    const tFresh = flat(buildTrails(simT, { camera: cam, renderer: { m_RenderMode: 5 }, linearColor: false }));
    buildParticles(simBig, { camera: cam, renderer: quad, linearColor: false, scratch: true });
    const tReused = flat(buildTrails(simT, { camera: cam, renderer: { m_RenderMode: 5 }, linearColor: false, scratch: true }));
    expect(tReused.n).toBeGreaterThan(0);
    expect(tReused).toEqual(tFresh);
  });

  it('粒子拖尾（TrailModule）：每個三角形面向攝影機看都是順時針（Unity 的正面；材質 Cull Back 才不會整條被剔掉）', () => {
    // MT2 戰鬥房間火盆的 Sparks：渲染模式 None、只畫拖尾，材質 Shader Graphs/ColorChannelParticle 是 Cull Back
    const ps = psData({}, {
      InitialModule: { startLifetime: K(5), startSpeed: K(3) },
      ShapeModule: { enabled: 1, type: 4, angle: 0, radius: { value: 0.0001 }, radiusThickness: 0, arc: { value: 360, mode: 0 } },
      TrailModule: { enabled: 1, mode: 0, ratio: 1, lifetime: K(1), minVertexDistance: 0.01, worldSpace: 0, dieWithParticles: 1, sizeAffectsWidth: 1, inheritParticleColor: 1, widthOverTrail: K(1), colorOverTrail: WHITE, colorOverLifetime: WHITE },
    });
    const { w } = worldWith(ps);
    for (let f = 0; f < 30; f++) w.tick(1 / 60);
    const sim = w.particles.existing(ps)!;
    // 粒子沿本地 +z 飛；攝影機在 x 軸上看 −x（右手邊是 −z… 照 Unity 左手系：看 +x 時 right 是 −z）
    const cam: ParticleCamera = { position: new Vector3(-10, 0, 0), right: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0), forward: new Vector3(1, 0, 0), orthographic: false, fov: 60, orthoSize: 5 };
    const g = buildTrails(sim, { camera: cam, renderer: { m_RenderMode: 5 }, linearColor: false });
    expect(g.indices.length).toBeGreaterThan(0);
    // 畫面座標：x ＝ 位置·right、y ＝ 位置·up；順時針（y 朝上）時有號面積 < 0
    const sx = (i: number) => -g.position[i * 3 + 2];
    const sy = (i: number) => g.position[i * 3 + 1];
    let cw = 0;
    let ccw = 0;
    for (let t = 0; t < g.indices.length; t += 3) {
      const [a, b, c] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
      const area = (sx(b) - sx(a)) * (sy(c) - sy(a)) - (sy(b) - sy(a)) * (sx(c) - sx(a));
      if (area < -1e-9) cw++;
      else if (area > 1e-9) ccw++;
    }
    expect(cw).toBeGreaterThan(0);
    expect(ccw).toBe(0);
  });
});

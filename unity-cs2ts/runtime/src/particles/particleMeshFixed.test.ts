// 粒子網格的固定輸出（10/18）：flip、UV 翻轉、網格粒子、自訂資料流、漸層與 Color over Lifetime 的組合，
// 快照在最佳化之前錄（改寫 buildParticles 的內圈與 evalMinMaxGradient 之後要逐值相同）
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { World } from '../engine/world';
import { SceneGraph } from '../unity/scene';
import type { ComponentData, GameObjectData, SceneFile } from '../unity/types';
import { buildParticles, type ParticleCamera } from './particleMesh';

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

const GRAD = { m_Mode: 0, m_NumColorKeys: 3, m_NumAlphaKeys: 2, key0: { r: 1, g: 0, b: 0, a: 1 }, key1: { r: 0, g: 1, b: 0, a: 0.2 }, key2: { r: 0, g: 0, b: 1, a: 1 }, ctime0: 0, ctime1: 30000, ctime2: 65535, atime0: 0, atime1: 65535 };

describe('粒子網格的固定輸出', () => {
  it('flip、UV 翻轉、網格粒子、自訂資料流', () => {
    const ps = psData({}, {
      EmissionModule: { rateOverTime: K(0), m_Bursts: [{ time: 0, countCurve: K(12), cycleCount: 1, repeatInterval: 1, probability: 1 }] },
      InitialModule: { startLifetime: K(5), startSpeed: K(2), startRotation: { minMaxState: 3, scalar: 3, minScalar: -3 }, startColor: { minMaxState: 2, minColor: { r: 0.2, g: 0.4, b: 0.6, a: 0.5 }, maxColor: { r: 1, g: 1, b: 1, a: 1 } } },
      ShapeModule: { enabled: 1, type: 4, angle: 30, radius: { value: 1 }, radiusThickness: 1, arc: { value: 360, mode: 0 } },
      ColorModule: { enabled: 1, gradient: { minMaxState: 1, maxGradient: GRAD } },
      UVModule: { enabled: 1, mode: 0, tilesX: 2, tilesY: 2, animationType: 0, cycles: 1, frameOverTime: { minMaxState: 1, scalar: 1, maxCurve: { m_Curve: [{ time: 0, value: 0, inSlope: 1, outSlope: 1 }, { time: 1, value: 1, inSlope: 1, outSlope: 1 }] } }, startFrame: K(0), flipU: 0.5, flipV: 0.3 },
    });
    const { w } = worldWith(ps);
    for (let f = 0; f < 20; f++) w.tick(1 / 60);
    const sim = w.particles.existing(ps)!;
    const cam: ParticleCamera = { position: new Vector3(1, 2, -10), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), forward: new Vector3(0, 0, 1), orthographic: false, fov: 60, orthoSize: 5 };
    const mesh = { position: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0.5], normal: [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1], color: [1, 0.5, 0.5, 1, 1, 1, 1, 1, 0.2, 0.2, 1, 1, 1, 1, 1, 0.5], uv: [0, 0, 1, 0, 0, 1, 1, 1], indices: [0, 1, 2, 2, 1, 3] };
    const round = (a: ArrayLike<number>) => Array.from(a, (x) => Math.round(x * 1e5) / 1e5);
    const flat = (g: ReturnType<typeof buildParticles>) => ({ n: g.vertexCount, position: round(g.position), normal: round(g.normal), color: round(g.color), texcoords: g.texcoords.map(round), indices: Array.from(g.indices) });
    const out: Record<string, unknown> = {};
    out.quadFlip = flat(buildParticles(sim, { camera: cam, renderer: { m_RenderMode: 0, m_MaxParticleSize: 10, m_Flip: { x: 0.4, y: 0.7, z: 0 } }, linearColor: true }));
    out.quadStreams = flat(buildParticles(sim, { camera: cam, renderer: { m_RenderMode: 0, m_MaxParticleSize: 10, m_UseCustomVertexStreams: 1, m_VertexStreams: '000103040b0c0d1415', m_SortMode: 1 }, linearColor: false }));
    out.mesh = flat(buildParticles(sim, { camera: cam, renderer: { m_RenderMode: 4, m_MaxParticleSize: 10, m_Flip: { x: 1, y: 0, z: 0 } }, linearColor: false, mesh }));
    out.meshNoNormal = flat(buildParticles(sim, { camera: cam, renderer: { m_RenderMode: 4, m_MaxParticleSize: 10 }, linearColor: true, mesh: { position: mesh.position, indices: mesh.indices } }));
    expect((out.quadFlip as { n: number }).n).toBe(48);
    expect(out).toMatchSnapshot();
  });
});

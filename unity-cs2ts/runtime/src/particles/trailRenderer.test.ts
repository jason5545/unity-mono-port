// TrailRenderer（2026/10/17，MT2 的卡片拖尾）與 World 的 LateUpdate 那一趟。數值照 Unity 手冊 Trail Renderer 的定義推算。
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { World, type Behaviour, type BehaviourRegistry } from '../engine/world';
import { SceneGraph } from '../unity/scene';
import { setActive } from '../unity/instantiate';
import type { ComponentData, GameObjectData, SceneFile } from '../unity/types';
import { buildTrailRendererGeometry } from './trailRenderer';
import type { ParticleCamera } from './particleMesh';

const T = (go: string, parent: string | null = null) => ({ type: 'Transform', classID: 4, gameObject: go, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_Father: parent, m_Children: [] });
const GO = (name: string, transform: string, components: string[], children: string[] = [], parent: string | null = null, active = 1): GameObjectData => ({
  m_Name: name, m_IsActive: active, m_Layer: 0, m_TagString: 'Untagged', transform, parent, children, components: [transform, ...components],
});

function trailData(over: Record<string, unknown> = {}): ComponentData {
  return {
    type: 'TrailRenderer',
    classID: 96,
    gameObject: '10',
    m_Enabled: 1,
    m_Time: 0.5,
    m_MinVertexDistance: 0,
    m_Emitting: 1,
    m_Parameters: {
      widthMultiplier: 2,
      widthCurve: { m_Curve: [{ time: 0, value: 1, inSlope: 0, outSlope: 0 }, { time: 1, value: 0.5, inSlope: 0, outSlope: 0 }] },
      colorGradient: { m_Mode: 0, m_NumColorKeys: 2, m_NumAlphaKeys: 2, key0: { r: 1, g: 1, b: 1, a: 1 }, key1: { r: 1, g: 1, b: 1, a: 0 }, ctime0: 0, ctime1: 65535, atime0: 0, atime1: 65535 },
      alignment: 0,
      textureMode: 0,
    },
    ...over,
  } as unknown as ComponentData;
}

function worldWith(comps: Record<string, ComponentData>, registry: BehaviourRegistry = {}, gos: Record<string, GameObjectData> = {}): World {
  const file: SceneFile = {
    guid: 'g', name: 's', src: 's.unity', settings: {},
    roots: ['10', ...Object.keys(gos).filter((k) => !gos[k].parent)],
    gameObjects: { '10': GO('Trail', '11', Object.keys(comps).filter((k) => comps[k].gameObject === '10')), ...gos },
    components: { '11': T('10') as unknown as ComponentData, ...comps },
  };
  for (const [id, go] of Object.entries(gos)) file.components[go.transform] = T(id, go.parent ? file.gameObjects[go.parent].transform : null) as unknown as ComponentData;
  const w = new World(new SceneGraph(file), { localization: undefined as never, version: 'test', controllers: {}, clips: {}, registry, layout: {}, sortingLayerIndex: () => 0 });
  w.start();
  return w;
}
const move = (w: World, x: number): void => {
  w.graph.nodes.get('10')!.transform.m_LocalPosition = { x, y: 0, z: 0 };
};

describe('TrailRenderer 的點', () => {
  it('移動時每格留一點（minVertexDistance 0），頭在最前面；停下來後點照 time 老化，尾巴縮短到只剩頭', () => {
    const tr = trailData();
    const w = worldWith({ '12': tr });
    for (let i = 0; i <= 10; i++) {
      move(w, i);
      w.tick(1 / 60);
    }
    const path = w.trails.pathOf(tr);
    expect(path.length).toBe(11);
    expect(path[0].x).toBe(10);
    expect(path[path.length - 1].x).toBe(0);
    // 不動：0.5 秒後只剩最後留下的那一點
    for (let i = 0; i < 40; i++) w.tick(1 / 60);
    expect(w.trails.pathOf(tr).length).toBe(1);
  });

  it('minVertexDistance：距離沒超過就不留新點；Clear 清掉；emitting 0 不留點', () => {
    const tr = trailData({ m_MinVertexDistance: 1.5 });
    const w = worldWith({ '12': tr });
    for (let i = 0; i <= 6; i++) {
      move(w, i);
      w.tick(1 / 60);
    }
    // x：0、2、4、6 留點（1、3、5 離上一點只有 1），頭在 6 跟最後一點重疊
    expect(w.trails.pathOf(tr).map((p) => p.x)).toEqual([6, 4, 2, 0]);
    w.trails.clear(tr);
    expect(w.trails.positionCount(tr)).toBe(0);
    tr.m_Emitting = 0;
    move(w, 10);
    w.tick(1 / 60);
    expect(w.trails.positionCount(tr)).toBe(0);
  });

  it('物件停用時點清掉', () => {
    const tr = trailData();
    const w = worldWith({ '12': tr });
    for (let i = 0; i < 3; i++) {
      move(w, i);
      w.tick(1 / 60);
    }
    expect(w.trails.positionCount(tr)).toBe(3);
    setActive(w, w.graph.nodes.get('10')!, false);
    w.tick(1 / 60);
    expect(w.trails.positionCount(tr)).toBe(0);
  });
});

describe('TrailRenderer 的網格', () => {
  const cam: ParticleCamera = { position: new Vector3(0, 0, -10), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), forward: new Vector3(0, 0, 1), orthographic: true, fov: 60, orthoSize: 5 };
  const params = trailData().m_Parameters as object;

  it('每點兩個頂點，寬度照曲線（頭 1×2、尾 0.5×2），u 是沿線距離比例（頭 0、尾 1），顏色照漸層（alpha 1 → 0）', () => {
    const g = buildTrailRendererGeometry([{ x: 4, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }], params, cam, false);
    expect(g.vertexCount).toBe(6);
    const half = (k: number) => Math.abs(g.position[k * 6 + 1] - g.position[k * 6 + 4]) / 2;
    expect(half(0)).toBeCloseTo(1);
    expect(half(2)).toBeCloseTo(0.5);
    expect(g.texcoords[0][0]).toBe(0);
    expect(g.texcoords[0][2 * 2 * 4]).toBe(1);
    expect(g.color[3]).toBeCloseTo(1);
    expect(g.color[2 * 2 * 4 + 3]).toBeCloseTo(0);
  });

  it('三角形面向攝影機看是順時針（(B−A)×(C−A) 朝攝影機）', () => {
    const g = buildTrailRendererGeometry([{ x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }, { x: 2, y: 5, z: 0 }], params, cam, false);
    for (let t = 0; t < g.indices.length; t += 3) {
      const p = (i: number) => new Vector3().fromArray(g.position, g.indices[t + i] * 3);
      const n = new Vector3().crossVectors(p(1).sub(p(0)), p(2).sub(p(0)));
      expect(n.dot(cam.forward)).toBeLessThan(0);
    }
  });

  it('少於兩點、或不是 View 對齊的不畫', () => {
    expect(buildTrailRendererGeometry([{ x: 0, y: 0, z: 0 }], params, cam, false).vertexCount).toBe(0);
    expect(buildTrailRendererGeometry([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], { ...params, alignment: 1 }, cam, false).vertexCount).toBe(0);
  });
});

describe('World 的 LateUpdate', () => {
  it('全部 Update 之後才跑 LateUpdate；這一格才啟用、沒有 Start 的 behaviour 同一格就跑 LateUpdate', () => {
    const log: string[] = [];
    const registry: BehaviourRegistry = {
      A: (): Behaviour => ({
        start: () => void 0,
        update: () => void log.push('A.update'),
        lateUpdate: () => void log.push('A.late'),
      }),
      B: (ctx): Behaviour => ({
        start: () => void 0,
        update: () => {
          log.push('B.update');
          const c = ctx.world.graph.nodes.get('30');
          if (c && !c.activeInHierarchy) setActive(ctx.world, c, true);
        },
      }),
      C: (): Behaviour => ({ lateUpdate: () => void log.push('C.late') }),
    };
    const mb = (go: string, cls: string): ComponentData => ({ type: 'MonoBehaviour', classID: 114, gameObject: go, m_Enabled: 1, script: { class: cls } }) as unknown as ComponentData;
    const gos: Record<string, GameObjectData> = {
      '20': GO('AB', '21', ['22', '23']),
      '30': GO('C', '31', ['32'], [], null, 0),
    };
    const w = worldWith({ '22': mb('20', 'A'), '23': mb('20', 'B'), '32': mb('30', 'C') }, registry, gos);
    log.length = 0;
    w.tick(1 / 60);
    expect(log.indexOf('A.late')).toBeGreaterThan(log.indexOf('B.update'));
    expect(log).toContain('C.late');
  });
});

// 生命週期的兩件事（2026/10/16，MT2 的 Spine 與新手戰鬥）：
//   - 場景載入時 Awake／Start 照場景檔的元件 fileID 由小到大（原版 build 的 pathID），不是樹的順序。
//   - 有多載的訊息方法（SkeletonAnimation 的 Update() 與 Update(float)）產生名是「Update$0」，Unity 叫的是沒有參數的那個。
import { describe, expect, it } from 'vitest';
import { World } from '../engine/world';
import { SceneGraph } from '../unity/scene';
import { setActive } from '../unity/instantiate';
import type { ComponentData, GameObjectData, SceneFile } from '../unity/types';
import { genBehaviour, registerGen, type GenClassImpl } from './core';

const T = (go: string) => ({ type: 'Transform', classID: 4, gameObject: go, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_Father: null, m_Children: [] });
const MB = (go: string, cls: string): ComponentData => ({ type: 'MonoBehaviour', classID: 114, gameObject: go, m_Enabled: 1, script: { assembly: 'Assembly-CSharp', namespace: '', class: cls, source: '' } });
const GO = (name: string, transform: string, components: string[], children: string[] = [], parent: string | null = null): GameObjectData => ({
  m_Name: name, m_IsActive: 1, m_Layer: 0, m_TagString: 'Untagged', transform, parent, children, components: [transform, ...components],
});

function world(file: SceneFile, registry: Record<string, ReturnType<typeof genBehaviour>>) {
  const w = new World(new SceneGraph(file), {
    localization: undefined as never,
    version: 'test',
    controllers: {},
    clips: {},
    registry,
    layout: {},
    sortingLayerIndex: () => 0,
  });
  return w;
}

describe('場景載入的 Awake／Start 順序', () => {
  it('照元件的 fileID 由小到大，不照樹的順序', () => {
    const calls: string[] = [];
    const mk = (name: string) => () => ({ awake: () => calls.push(`${name}.Awake`), start: () => calls.push(`${name}.Start`) });
    // 樹的順序：RoomManager 在前（根物件第一個）、Hand 在後；fileID：Hand 的元件 1729 比 RoomManager 的 1734 小（MT2 main 場景的實際值）
    const file: SceneFile = {
      guid: 'g', name: 's', src: 's.unity', settings: {},
      roots: ['10', '20'],
      gameObjects: { '10': GO('RoomManager', '11', ['1734']), '20': GO('Hand', '21', ['1729']) },
      components: { '11': T('10') as ComponentData, '21': T('20') as ComponentData, '1734': MB('10', 'RoomManager'), '1729': MB('20', 'HandUI') },
    };
    const w = world(file, { RoomManager: mk('RoomManager'), HandUI: mk('HandUI') });
    w.start();
    expect(calls).toEqual(['HandUI.Awake', 'RoomManager.Awake', 'HandUI.Start', 'RoomManager.Start']);
  });
});

describe('有多載的訊息方法', () => {
  it('Update 有多載時，Unity 叫的是沒有參數的 Update$0', () => {
    const calls: string[] = [];
    const g: GenClassImpl = {
      name: 'TestSkeletonAnimation',
      file: 'TestSkeletonAnimation.cs',
      initAi: () => ({}),
      overrides: {},
      delegates: {},
      methods: { Update$0: () => void calls.push('Update()'), Update$1: (_c, dt: number) => void calls.push(`Update(${dt})`) },
    };
    registerGen({ TestSkeletonAnimation: g });
    const file: SceneFile = {
      guid: 'g', name: 's', src: 's.unity', settings: {},
      roots: ['10'],
      gameObjects: { '10': GO('Spine', '11', ['12']) },
      components: { '11': T('10') as ComponentData, '12': MB('10', 'TestSkeletonAnimation') },
    };
    const w = world(file, { TestSkeletonAnimation: genBehaviour('TestSkeletonAnimation') });
    w.start();
    w.tick(1 / 60);
    expect(calls).toEqual(['Update()']);
  });
});

// SetActive／Behaviour.enabled 只處理受影響的 behaviour（10/17，以前每次全掃，MT2 戰鬥 1.8 萬個）
describe('SetActive 與 enabled 只處理受影響的 behaviour', () => {
  it('SetActive 只跑那棵子樹的 OnEnable／OnDisable，照登記順序；別處直接改 m_Enabled 的等 tick 開頭的全掃', () => {
    const calls: string[] = [];
    const mk = (name: string) => () => ({ onEnable: () => calls.push(`${name}.OnEnable`), onDisable: () => calls.push(`${name}.OnDisable`) });
    const file: SceneFile = {
      guid: 'g', name: 's', src: 's.unity', settings: {},
      roots: ['10', '40'],
      gameObjects: {
        '10': GO('Panel', '11', ['101'], ['20', '30']),
        '20': GO('Item1', '21', ['201'], [], '10'),
        '30': GO('Item2', '31', ['301'], [], '10'),
        '40': GO('Other', '41', ['401']),
      },
      components: {
        '11': T('10') as ComponentData, '21': T('20') as ComponentData, '31': T('30') as ComponentData, '41': T('40') as ComponentData,
        '101': MB('10', 'Panel'), '201': MB('20', 'Item1'), '301': MB('30', 'Item2'), '401': MB('40', 'Other'),
      },
    };
    const w = world(file, { Panel: mk('Panel'), Item1: mk('Item1'), Item2: mk('Item2'), Other: mk('Other') });
    w.start();
    calls.length = 0;
    const panel = w.graph.nodes.get('10')!;
    file.components['401'].m_Enabled = 0; // 不經過 Behaviour.enabled（像 Animator 曲線）
    setActive(w, panel, false);
    expect(calls).toEqual(['Panel.OnDisable', 'Item1.OnDisable', 'Item2.OnDisable']);
    w.refreshEnables();
    expect(calls.slice(3)).toEqual(['Other.OnDisable']);
    setActive(w, panel, true);
    expect(calls.slice(4)).toEqual(['Panel.OnEnable', 'Item1.OnEnable', 'Item2.OnEnable']);
    // Behaviour.enabled 只處理那個元件
    file.components['201'].m_Enabled = 0;
    file.components['401'].m_Enabled = 1;
    w.refreshEnables(file.components['201']);
    expect(calls.slice(7)).toEqual(['Item1.OnDisable']);
  });
});

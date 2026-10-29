// curves.ts、animator.ts 的測試。Hermite 與 Quaternion.Euler 照 Unity 的定義手算；animator 用 level1 背景的真資料。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SceneGraph } from '../unity/scene';
import type { SceneFile } from '../unity/types';
import { AnimatorRuntime, eulerToQuaternion, type ClipAsset, type ControllerAsset } from './animator';
import { evaluate, samplePPtr } from './curves';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

describe('AnimationCurve', () => {
  const key = (time: number, value: number, slope: number | string = 0) => ({ time, value, inSlope: slope, outSlope: slope });
  it('Hermite：斜率 0 的兩格在中點剛好一半；端點是關鍵格的值；範圍外夾住', () => {
    const k = [key(0, 0), key(2, 10)];
    expect(evaluate(k, 1)).toBeCloseTo(5, 10);
    expect(evaluate(k, 0)).toBe(0);
    expect(evaluate(k, 2)).toBe(10);
    expect(evaluate(k, -1)).toBe(0);
    expect(evaluate(k, 3)).toBe(10);
  });
  it('Hermite：斜率 = 直線斜率時就是直線（t = 0.25 → 2.5）', () => {
    expect(evaluate([key(0, 0, 5), key(2, 10, 5)], 0.5)).toBeCloseTo(2.5, 10);
  });
  it('無限斜率是階梯：維持前一格', () => {
    expect(evaluate([key(0, 1, 'Infinity'), key(1, 0, 'Infinity')], 0.99)).toBe(1);
  });
  it('PPtr：取時間不超過 t 的最後一格', () => {
    const k = [{ time: 0, value: 'a' }, { time: 0.5, value: 'b' }];
    expect([samplePPtr(k, 0), samplePPtr(k, 0.49), samplePPtr(k, 0.5), samplePPtr(k, 9)]).toEqual(['a', 'a', 'b', 'b']);
  });
  it('Quaternion.Euler(0, 90, 0) = (0, sin45°, 0, cos45°)；(90, 0, 0) = (sin45°, 0, 0, cos45°)', () => {
    const q = eulerToQuaternion({ x: 0, y: 90, z: 0 });
    expect([q.x, q.y, q.z, q.w].map((v) => +v.toFixed(6))).toEqual([0, 0.707107, 0, 0.707107]);
    const r = eulerToQuaternion({ x: 90, y: 0, z: 0 });
    expect([r.x, r.y, r.z, r.w].map((v) => +v.toFixed(6))).toEqual([0.707107, 0, 0, 0.707107]);
  });
});

describe('Animator（level1 背景）', () => {
  const controllers = load<Record<string, ControllerAsset>>('assets/animators.json');
  const clips = load<Record<string, ClipAsset>>('assets/animations.json');

  function runtime(goName: string) {
    const graph = new SceneGraph(load<SceneFile>('scenes/level1.json'));
    const node = [...graph.nodes.values()].find((n) => n.go.m_Name === goName)!;
    const anim = graph.component(node, 'Animator')!;
    const ctrl = controllers[(anim.m_Controller as { guid: string }).guid];
    const rt = new AnimatorRuntime(graph, node, anim, ctrl, controllers, clips);
    return { rt, sprite: () => (graph.component(node, 'SpriteRenderer')!.m_Sprite as { guid: string }).guid };
  }

  it('riverside草：override 換 clip、6 fps 4 格、循環長 0.6667 秒；0.6 秒是第 4 格，0.7 秒繞回第 1 格', () => {
    const { rt, sprite } = runtime('Background Layer 1 草动画');
    const clip = Object.values(clips).find((c) => c.m_Name === 'riverside草')!;
    const keys = (clip.m_PPtrCurves[0].curve as { value: { guid: string } }[]).map((k) => k.value.guid);
    expect(rt.currentStateName).toBe('forest');
    rt.update(0);
    expect(sprite()).toBe(keys[0]);
    rt.update(0.6);
    expect(sprite()).toBe(keys[3]);
    rt.update(0.1);
    expect(sprite()).toBe(keys[0]);
    expect(rt.notes).toEqual([]);
  });

  it('riverside宝石：不循環，播完停在最後一格', () => {
    const { rt, sprite } = runtime('Background Layer 2 宝石动画');
    const clip = Object.values(clips).find((c) => c.m_Name === 'riverside宝石')!;
    const keys = (clip.m_PPtrCurves[0].curve as { value: { guid: string } }[]).map((k) => k.value.guid);
    rt.update(5);
    expect(sprite()).toBe(keys[keys.length - 1]);
  });
});

describe('Animator 的動畫事件', () => {
  // 一層、一個狀態、一個 1 秒的 clip，沒有曲線：只看事件
  function runtime(loop: boolean, events: number[]) {
    const ctrl: ControllerAsset = {
      name: 'T',
      type: 'AnimatorController',
      root: '1',
      objects: {
        '1': { m_AnimatorParameters: [], m_AnimatorLayers: [{ m_StateMachine: { fileID: '2' } }] },
        '2': { type: 'AnimatorStateMachine', m_DefaultState: { fileID: '3' } },
        '3': { type: 'AnimatorState', m_Name: 'S', m_Speed: 1, m_CycleOffset: 0, m_Motion: { guid: 'c', fileID: '7400000' }, m_Transitions: [] },
      },
    };
    const clip = {
      m_Name: 'C',
      m_SampleRate: 60,
      m_AnimationClipSettings: { m_StartTime: 0, m_StopTime: 1, m_LoopTime: loop ? 1 : 0, m_CycleOffset: 0 },
      m_PositionCurves: [],
      m_EulerCurves: [],
      m_RotationCurves: [],
      m_ScaleCurves: [],
      m_FloatCurves: [],
      m_PPtrCurves: [],
      m_Events: events.map((time, i) => ({ time, functionName: `F${i}`, data: null, objectReferenceParameter: null, floatParameter: 0, intParameter: i, messageOptions: 0 })),
    } as ClipAsset;
    const rt = new AnimatorRuntime({} as SceneGraph, {} as never, {} as never, ctrl, { x: ctrl }, { c: clip });
    const step = (dt: number) => {
      rt.update(dt);
      return rt.fired.splice(0).map((f) => f.ev.functionName);
    };
    return step;
  }

  it('剛進狀態的那一格含時間 0 的事件；之後落在 (上一格, 這一格]', () => {
    const step = runtime(false, [0, 0.5, 1]);
    expect(step(0.25)).toEqual(['F0']);
    expect(step(0.25)).toEqual(['F1']);
    expect(step(0.25)).toEqual([]);
    expect(step(0.5)).toEqual(['F2']);
    expect(step(1)).toEqual([]);
  });
  it('loop 的 clip 每圈都發，一格跨過好幾圈也照順序發', () => {
    const step = runtime(true, [0.5]);
    expect(step(0.6)).toEqual(['F0']);
    expect(step(0.6)).toEqual([]);
    expect(step(2)).toEqual(['F0', 'F0']);
  });
});

describe('Animator 的 Has Exit Time（10/17）', () => {
  // A（clip 長 length、loop）→ B：exit time exit，trigger 給了就要 Go 也成立
  function runtime(length: number, loop: boolean, exit: number, trigger: boolean) {
    const ctrl: ControllerAsset = {
      name: 'T',
      type: 'AnimatorController',
      root: '1',
      objects: {
        '1': { m_AnimatorParameters: trigger ? [{ m_Name: 'Go', m_Type: 9, m_DefaultFloat: 0, m_DefaultInt: 0, m_DefaultBool: 0 }] : [], m_AnimatorLayers: [{ m_StateMachine: { fileID: '2' } }] },
        '2': { type: 'AnimatorStateMachine', m_DefaultState: { fileID: '3' } },
        '3': { type: 'AnimatorState', m_Name: 'A', m_Speed: 1, m_CycleOffset: 0, m_Motion: { guid: 'a', fileID: '7400000' }, m_Transitions: [{ fileID: '5' }] },
        '4': { type: 'AnimatorState', m_Name: 'B', m_Speed: 1, m_CycleOffset: 0, m_Motion: { guid: 'b', fileID: '7400000' }, m_Transitions: [] },
        '5': {
          type: 'AnimatorStateTransition',
          m_DstState: { fileID: '4' },
          m_HasExitTime: 1,
          m_ExitTime: exit,
          m_TransitionDuration: 0,
          m_Conditions: trigger ? [{ m_ConditionMode: 1, m_ConditionEvent: 'Go', m_EventTreshold: 0 }] : [],
        },
      },
    };
    const clip = (stop: number, lp: boolean) =>
      ({
        m_Name: 'C',
        m_SampleRate: 60,
        m_AnimationClipSettings: { m_StartTime: 0, m_StopTime: stop, m_LoopTime: lp ? 1 : 0, m_CycleOffset: 0 },
        m_PositionCurves: [],
        m_EulerCurves: [],
        m_RotationCurves: [],
        m_ScaleCurves: [],
        m_FloatCurves: [],
        m_PPtrCurves: [],
      }) as ClipAsset;
    return new AnimatorRuntime({} as SceneGraph, {} as never, {} as never, ctrl, { x: ctrl }, { a: clip(length, loop), b: clip(1, false) });
  }

  it('循環 clip、exit time 小於 1：第一圈錯過之後，下一圈跨過 k + exit 那一格才轉（以前拿總時間比，錯過就永遠不轉）', () => {
    const rt = runtime(1, true, 0.75, true);
    rt.update(0.8); // 第一圈跨過 0.75，但 trigger 還沒設
    expect(rt.currentStateName).toBe('A');
    rt.setTrigger('Go');
    rt.update(0.5); // 1.3：還沒到 1.75
    expect(rt.currentStateName).toBe('A');
    rt.update(0.5); // 1.8：跨過 1.75
    expect(rt.currentStateName).toBe('B');
  });
  it('非循環 clip：exit time 只判斷一次，錯過就不轉', () => {
    const rt = runtime(1, false, 0.75, true);
    rt.update(0.8);
    rt.setTrigger('Go');
    rt.update(1);
    rt.update(1);
    expect(rt.currentStateName).toBe('A');
  });
  it('長度 0 的循環 clip（WideBG_Init、Event_Init）：exit time 0 沒有條件，第一格就轉', () => {
    const rt = runtime(0, true, 0, false);
    rt.update(1 / 60);
    expect(rt.currentStateName).toBe('B');
  });
  it('長度 0 的循環 clip：trigger 晚設也照樣轉（故事事件的 DoorOpen）', () => {
    const rt = runtime(0, true, 0.75, true);
    for (let i = 0; i < 30; i++) rt.update(1 / 60);
    expect(rt.currentStateName).toBe('A');
    rt.setTrigger('Go');
    rt.update(1 / 60);
    expect(rt.currentStateName).toBe('B');
  });
});

describe('動畫曲線的屬性名只剩 CRC32（AssetRipper 認不出 DLL 類別的欄位）', () => {
  it('script_0x<CRC32>_… 照目標元件的欄位名對回原名：MT2 載入畫面的 Flames.anim 換 Image 的 m_Sprite', async () => {
    const { resolveCrcAttribute } = await import('./animator');
    const image = { m_Sprite: { guid: 'bd37505a', fileID: '21300000' }, m_Color: { r: 1, g: 1, b: 1, a: 1 }, m_Material: null };
    expect(resolveCrcAttribute('script_0x7822D856_UsmorHH', image)).toBe('m_Sprite');
    // 子欄位（float 曲線的 m_Color.a）
    const crc = (await import('./crc32')).crc32('m_Color.a').toString(16).toUpperCase().padStart(8, '0');
    expect(resolveCrcAttribute(`script_0x${crc}_xx`, image)).toBe('m_Color.a');
    // 一般的屬性名、對不到的 CRC 都照原字串
    expect(resolveCrcAttribute('m_IsActive', image)).toBe('m_IsActive');
    expect(resolveCrcAttribute('script_0x00000000_zz', image)).toBe('script_0x00000000_zz');
  });
});

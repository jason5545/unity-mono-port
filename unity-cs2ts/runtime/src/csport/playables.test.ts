import { describe, expect, it } from 'vitest';
import { newGen, registerGen, staticCtx, type Ctx, type GenClassImpl } from './core';
import {
  IPlayableAsset_get_duration,
  PlayableExtensions_GetTime,
  PlayableExtensions_Pause,
  PlayableExtensions_SetInputWeight$U_int_float,
  PlayableExtensions_SetTraversalMode,
  PlayableGraph_Connect,
  PlayableGraph_Create$string,
  PlayableGraph_Evaluate$float,
  PlayableOutputExtensions_SetSourcePlayable$U_V_int,
  PlayableOutputExtensions_SetUserData,
  Playable_Create,
  ScriptPlayableOutput_Create,
  ScriptPlayable_Create$PlayableGraph_T_int,
  ScriptPlayable_Create$PlayableGraph_int,
  ScriptPlayable_GetBehaviour,
} from './unityPlayables';
import { nativeBase } from './unityNative';

// 跟 MT2 的 CanvasGroupFadeMixerBehaviour／CanvasGroupFadeBehaviour 同一個形狀：PlayableBehaviour 的子類別（基底在 DLL），覆寫回呼
const calls: string[] = [];
const behaviour = (name: string, extra: Record<string, (c: Ctx, ...a: any[]) => any> = {}): GenClassImpl => {
  const log = (m: string) => (_c: Ctx, _p: unknown, info?: { deltaTime?: number }, playerData?: unknown) =>
    void calls.push(`${name}.${m}${playerData !== undefined ? `(${String((playerData as { name?: string } | null)?.name)})` : ''}${info && m === 'PrepareFrame' ? `@${info.deltaTime}` : ''}`);
  const methods: Record<string, (c: Ctx, ...a: any[]) => any> = {
    OnPlayableCreate: log('OnPlayableCreate'),
    OnGraphStart: log('OnGraphStart'),
    OnBehaviourPlay: log('OnBehaviourPlay'),
    OnBehaviourPause: log('OnBehaviourPause'),
    PrepareFrame: log('PrepareFrame'),
    ProcessFrame: log('ProcessFrame'),
    ...extra,
  };
  return { name, file: `${name}.cs`, dllBases: ['PlayableBehaviour'], initAi: () => ({ value: 0 }), overrides: { ...methods }, delegates: {}, methods };
};
registerGen({ TestMixer: behaviour('TestMixer'), TestClip: behaviour('TestClip'), TestRoot: behaviour('TestRoot') });
// 跟 MT2 的 TransformTweenMixerBehaviour 同一個形狀：覆寫 OnBehaviourPlay，裡面先叫 base.OnBehaviourPlay（產生碼是 R.nativeBase）
registerGen({
  TestBaseCaller: behaviour('TestBaseCaller', {
    OnBehaviourPlay: (c: Ctx, p: unknown, info: unknown) => {
      nativeBase(c, c.self, 'PlayableBehaviour', 'OnBehaviourPlay', p, info);
      calls.push('TestBaseCaller.OnBehaviourPlay');
    },
    OnBehaviourPause: (c: Ctx, p: unknown, info: unknown) => {
      nativeBase(c, c.self, 'PlayableBehaviour', 'OnBehaviourPause', p, info);
      calls.push('TestBaseCaller.OnBehaviourPause');
    },
  }),
});
// PlayableAsset 的子類別：duration 覆寫裡叫 base.duration（產生碼是同一個 DLL 成員）
const TestAsset: GenClassImpl = {
  name: 'TestAsset',
  file: 'TestAsset.cs',
  dllBases: ['PlayableAsset', 'ScriptableObject', 'Object'],
  initAi: () => ({}),
  overrides: {},
  delegates: {},
  methods: { get_duration: (c: Ctx) => Math.min(5, IPlayableAsset_get_duration(c, c.self)) },
};
registerGen({ TestAsset });

const c = staticCtx;
function build() {
  calls.length = 0;
  const g = PlayableGraph_Create$string(c, 'test');
  const mixer = ScriptPlayable_Create$PlayableGraph_int(c, g, 1, 'TestMixer');
  const template = newGen(c, 'TestClip', null) as Record<string, unknown>;
  template.value = 7;
  const clip = ScriptPlayable_Create$PlayableGraph_T_int(c, g, template, 0, 'TestClip');
  PlayableGraph_Connect(c, g, clip, 0, mixer, 0);
  PlayableExtensions_SetInputWeight$U_int_float(c, mixer, 0, 0.5);
  const out = ScriptPlayableOutput_Create(c, g, 'out');
  PlayableOutputExtensions_SetSourcePlayable$U_V_int(c, out, mixer, 0);
  PlayableOutputExtensions_SetUserData(c, out, { name: 'target' });
  return { g, mixer, clip, template };
}

describe('Playables：ScriptPlayable 與 graph 求值', () => {
  it('template 複製成新的 behaviour，建好就發 OnPlayableCreate', () => {
    const { clip, template } = build();
    const b = ScriptPlayable_GetBehaviour(c, clip) as Record<string, unknown>;
    expect(b).not.toBe(template);
    expect(b.value).toBe(7);
    expect(calls).toEqual(['TestMixer.OnPlayableCreate', 'TestClip.OnPlayableCreate']);
  });

  it('求值：時間前進，先 PrepareFrame（由 output 往輸入），再 ProcessFrame（playerData 是 output 的 UserData）', () => {
    const { g, mixer, clip } = build();
    calls.length = 0;
    PlayableGraph_Evaluate$float(c, g, 0.25);
    expect(PlayableExtensions_GetTime(c, mixer)).toBeCloseTo(0.25);
    expect(PlayableExtensions_GetTime(c, clip)).toBeCloseTo(0.25);
    expect(calls).toEqual([
      'TestMixer.OnGraphStart',
      'TestMixer.OnBehaviourPlay',
      'TestMixer.PrepareFrame@0.25',
      'TestClip.OnGraphStart',
      'TestClip.OnBehaviourPlay',
      'TestClip.PrepareFrame@0.25',
      'TestMixer.ProcessFrame(target)',
      'TestClip.ProcessFrame(target)',
    ]);
  });

  it('暫停的 playable 不走、時間不動；暫停後的下一次求值發 OnBehaviourPause', () => {
    const { g, clip } = build();
    PlayableGraph_Evaluate$float(c, g, 0.1);
    PlayableExtensions_Pause(c, clip);
    calls.length = 0;
    PlayableGraph_Evaluate$float(c, g, 0.1);
    expect(PlayableExtensions_GetTime(c, clip)).toBeCloseTo(0.1);
    // FrameData.deltaTime 是 float（原文 (float)m_DeltaTime）
    expect(calls).toEqual([`TestMixer.PrepareFrame@${Math.fround(0.1)}`, 'TestClip.OnBehaviourPause', 'TestMixer.ProcessFrame(target)']);
  });

  it('Passthrough：從 output 的 port 進來只走對應的輸入', () => {
    calls.length = 0;
    const g = PlayableGraph_Create$string(c, 'pass');
    const root = ScriptPlayable_Create$PlayableGraph_int(c, g, 2, 'TestRoot');
    PlayableExtensions_SetTraversalMode(c, root, 1);
    const a = ScriptPlayable_Create$PlayableGraph_int(c, g, 0, 'TestMixer');
    const b = ScriptPlayable_Create$PlayableGraph_int(c, g, 0, 'TestClip');
    PlayableGraph_Connect(c, g, a, 0, root, 0);
    PlayableGraph_Connect(c, g, b, 0, root, 1);
    const out = ScriptPlayableOutput_Create(c, g, 'second');
    PlayableOutputExtensions_SetSourcePlayable$U_V_int(c, out, root, 1);
    calls.length = 0;
    PlayableGraph_Evaluate$float(c, g, 0);
    expect(calls.filter((x) => x.includes('ProcessFrame'))).toEqual(['TestRoot.ProcessFrame(undefined)', 'TestClip.ProcessFrame(undefined)']);
  });

  it('Playable.Create 建的一般 playable 沒有 behaviour，照樣能接', () => {
    const g = PlayableGraph_Create$string(c, 'plain');
    const p = Playable_Create(c, g, 1);
    const clip = ScriptPlayable_Create$PlayableGraph_int(c, g, 0, 'TestClip');
    expect(PlayableGraph_Connect(c, g, clip, 0, p, 0)).toBe(true);
    expect(PlayableGraph_Connect(c, g, clip, 0, p, 3)).toBe(false);
  });
});

describe('DLL 基底的虛擬成員', () => {
  it('有覆寫叫覆寫；覆寫裡的 base.duration 回 PlayableAsset 的預設（正無限大）', () => {
    const a = newGen(c, 'TestAsset', null);
    expect(IPlayableAsset_get_duration(c, a)).toBe(5);
    expect(IPlayableAsset_get_duration(c, { $type: 'NotGenerated' })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('PlayableBehaviour 的 base.X()', () => {
  it('覆寫裡叫 base.OnBehaviourPlay／OnBehaviourPause 不丟例外（PlayableBehaviour.cs 的預設是空的），覆寫照跑', () => {
    calls.length = 0;
    const g = PlayableGraph_Create$string(c, 'base');
    const p = ScriptPlayable_Create$PlayableGraph_int(c, g, 0, 'TestBaseCaller');
    const out = ScriptPlayableOutput_Create(c, g, 'out');
    PlayableOutputExtensions_SetSourcePlayable$U_V_int(c, out, p, 0);
    calls.length = 0;
    PlayableGraph_Evaluate$float(c, g, 0.1);
    PlayableExtensions_Pause(c, p);
    PlayableGraph_Evaluate$float(c, g, 0.1);
    expect(calls.filter((x) => x.startsWith('TestBaseCaller.OnBehaviour'))).toEqual(['TestBaseCaller.OnBehaviourPlay', 'TestBaseCaller.OnBehaviourPause']);
  });

  it('其他回呼的 base 版本都不做事；base.Clone 是淺複製', () => {
    const b = { $type: 'TestBaseCaller', value: 3, obj: { x: 1 } };
    for (const m of ['OnGraphStart', 'OnGraphStop', 'OnPlayableCreate', 'OnPlayableDestroy', 'PrepareFrame', 'ProcessFrame'])
      expect(nativeBase(c, b, 'PlayableBehaviour', m, null, null)).toBeUndefined();
    const copy = nativeBase(c, b, 'PlayableBehaviour', 'Clone') as typeof b;
    expect(copy).not.toBe(b);
    expect(copy).toEqual(b);
    expect(copy.obj).toBe(b.obj);
  });
});

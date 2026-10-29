// Unity 內建聲音的相容層（unityAudio.ts，2026/10/17）：以前 AudioSource、AudioMixer 都是空殼，MT2 完全沒聲音。
// 這裡測不出聲的部分（vitest 沒有 AudioContext）：混音器的快照、過渡、曝露參數，AudioSource 的進度與播完，AudioClip 的長度。
// 混音器的資料照 MT2 的 MainMixer／MusicMixer（audiomixers.json 的格式），曝露參數的名稱是 AssetRipper 補的 CRC32 同值字串。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { World } from '../engine/world';
import { SceneGraph } from '../unity/scene';
import type { ComponentData, SceneFile } from '../unity/types';
import { compHandle, setActiveWorld, staticCtx } from './core';
import * as R from './unity';
import { nativeGet, nativeSet } from './unityNative';
import { crc32, setAudioTables, type MixerData } from './unityAudio';

const MAIN: MixerData = {
  name: 'MainMixer',
  output: null,
  master: '24300000',
  snapshotOrder: ['24500012'],
  startSnapshot: '24500012',
  updateMode: 0,
  exposed: [
    { guid: 'musicVol', name: 'mposwoH' },
    { guid: 'sfxVol', name: 'hkkpiSL' },
  ],
  groups: {
    '24300000': { name: 'Master', children: ['24300004', '24300008'], volume: 'masterVol', pitch: 'masterPitch', mute: 0 },
    '24300004': { name: 'Music', children: [], volume: 'musicVol', pitch: 'musicPitch', mute: 0 },
    '24300008': { name: 'SFX', children: [], volume: 'sfxVol', pitch: 'sfxPitch', mute: 0 },
  },
  snapshots: { '24500012': { name: 'Snapshot', values: { masterVol: -2.018035, musicVol: -4.2791185, sfxVol: -2.553892 } } },
};
const MUSIC: MixerData = {
  name: 'MusicMixer',
  output: { guid: 'main', fileID: '24300004' },
  master: '24300000',
  snapshotOrder: ['24500012', '24500014', '24500016'],
  startSnapshot: '24500012',
  updateMode: 0,
  exposed: [],
  groups: {
    '24300000': { name: 'Master', children: ['24300008', '24300004'], volume: 'm', pitch: 'mp', mute: 0 },
    '24300004': { name: 'Track2', children: [], volume: 't2', pitch: 't2p', mute: 0 },
    '24300008': { name: 'Track1', children: [], volume: 't1', pitch: 't1p', mute: 0 },
  },
  snapshots: {
    '24500012': { name: 'Track1', values: { t1: 0, t2: -80 } },
    '24500014': { name: 'Track2', values: { t1: -80, t2: 0 } },
    '24500016': { name: 'Nothing', values: { t1: -80, t2: -80 } },
  },
};
const CLIPS = { sfx: { name: 'Attack_AirPush', file: 'audioclips/sfx.ogg', channels: 2, frequency: 44100, samples: 81728 } };

function world(): World {
  const file = {
    guid: 'g', name: 'g', src: 'g', settings: {}, roots: ['1'],
    gameObjects: { '1': { m_Name: '_sfx_audio_pool', m_IsActive: 1, m_Layer: 0, m_TagString: 'Untagged', components: ['2', '3'], transform: '2', parent: null, children: [] } },
    components: {
      '2': { type: 'Transform', classID: 4, gameObject: '1', m_Father: null, m_Children: [], m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalScale: { x: 1, y: 1, z: 1 } },
      '3': { type: 'AudioSource', classID: 82, gameObject: '1', m_Enabled: 1, m_audioClip: null, m_PlayOnAwake: 1, m_Volume: 1, m_Pitch: 1, Loop: 0, Mute: 0 },
    },
  } as unknown as SceneFile;
  const w = new World(new SceneGraph(file), { localization: undefined as never, version: 'test', controllers: {}, clips: {}, registry: {}, layout: {}, sortingLayerIndex: () => 0 });
  setActiveWorld(w);
  w.start();
  return w;
}

afterEach(() => vi.useRealTimers());

describe('AudioMixer（.mixer 的群組、快照、曝露參數）', () => {
  it('CRC32 同 zlib；AssetRipper 補的曝露參數名稱跟原名 CRC32 相同', () => {
    expect(crc32('MusicVolume')).toBe(3575369835);
    expect(crc32('mposwoH')).toBe(3575369835);
    expect(crc32('SfxVolume')).toBe(1797338918);
  });

  it('GetFloat 讀起始快照的值；SetFloat 照原名設；不認得的名稱回 false', () => {
    setAudioTables({}, { main: MAIN });
    const mixer = { guid: 'main', fileID: '24100000' };
    let v = NaN;
    expect(R.AudioMixer_GetFloat(staticCtx, mixer, 'SfxVolume', (x) => (v = x))).toBe(true);
    expect(v).toBeCloseTo(-2.553892, 5);
    expect(R.AudioMixer_SetFloat(staticCtx, mixer, 'MusicVolume', -20)).toBe(true);
    R.AudioMixer_GetFloat(staticCtx, mixer, 'MusicVolume', (x) => (v = x));
    expect(v).toBe(-20);
    expect(R.AudioMixer_SetFloat(staticCtx, mixer, 'Nope', 0)).toBe(false);
    expect(R.AudioMixer_ClearFloat(staticCtx, mixer, 'MusicVolume')).toBe(true);
    R.AudioMixer_GetFloat(staticCtx, mixer, 'MusicVolume', (x) => (v = x));
    expect(v).toBeCloseTo(-4.2791185, 5);
  });

  it('FindSnapshot 回 {guid, fileID}（跟資料裡的參照相等）；找不到是 null', () => {
    setAudioTables({}, { music: MUSIC });
    const mixer = { guid: 'music', fileID: '24100000' };
    const snap = R.AudioMixer_FindSnapshot(staticCtx, mixer, 'Track2');
    expect(snap).toEqual({ guid: 'music', fileID: '24500014' });
    expect(R.objEq(snap, { guid: 'music', fileID: 24500014 })).toBe(true);
    expect(R.AudioMixer_FindSnapshot(staticCtx, mixer, 'Track3')).toBeNull();
  });

  it('TransitionTo(t)：t 秒內從目前的值線性插到目標快照（Time.time）；0 秒立刻換', () => {
    const w = world();
    setAudioTables({}, { music: MUSIC, main: MAIN });
    const mixer = { guid: 'music', fileID: '24100000' };
    const t1 = () => (R.audioDebug() as { mixers: { name: string; groups: string[] }[] }).mixers.find((m) => m.name === 'MusicMixer')!.groups;
    R.AudioMixerSnapshot_TransitionTo(staticCtx, { guid: 'music', fileID: '24500014' }, 2);
    w.tick(1);
    expect(t1()).toContain('Track1 -40.0dB');
    expect(t1()).toContain('Track2 -40.0dB');
    w.tick(1.5);
    expect(t1()).toContain('Track1 -80.0dB');
    expect(t1()).toContain('Track2 0.0dB');
    R.AudioMixerSnapshot_TransitionTo(staticCtx, R.AudioMixer_FindSnapshot(staticCtx, mixer, 'Track1'), 0);
    expect(t1()).toContain('Track1 0.0dB');
  });

  it('SetFloat 設過的參數不跟快照走', () => {
    const w = world();
    setAudioTables({}, { main: MAIN });
    const mixer = { guid: 'main', fileID: '24100000' };
    R.AudioMixer_SetFloat(staticCtx, mixer, 'SfxVolume', -30);
    R.AudioMixerSnapshot_TransitionTo(staticCtx, { guid: 'main', fileID: '24500012' }, 0);
    w.tick(0.1);
    let v = 0;
    R.AudioMixer_GetFloat(staticCtx, mixer, 'SfxVolume', (x) => (v = x));
    expect(v).toBe(-30);
  });

  it('outputAudioMixerGroup：資料的 m_OutputGroup，執行期可以改', () => {
    setAudioTables({}, { music: MUSIC, main: MAIN });
    const mixer = { guid: 'music', fileID: '24100000' };
    expect(nativeGet(staticCtx, mixer, 'AudioMixer', 'outputAudioMixerGroup')).toEqual({ guid: 'main', fileID: '24300004' });
    nativeSet(staticCtx, mixer, 'AudioMixer', 'outputAudioMixerGroup', { guid: 'main', fileID: '24300008' });
    expect(nativeGet(staticCtx, { guid: 'music', fileID: '24100000' }, 'AudioMixer', 'outputAudioMixerGroup')).toEqual({ guid: 'main', fileID: '24300008' });
  });
});

describe('AudioSource 與 AudioClip', () => {
  it('AudioClip.length ＝ samples / frequency（Ogg 標頭讀的）', () => {
    setAudioTables(CLIPS, {});
    expect(R.AudioClip_get_length(staticCtx, { guid: 'sfx', fileID: '8300000' })).toBeCloseTo(81728 / 44100, 6);
    expect(nativeGet(staticCtx, { guid: 'sfx', fileID: '8300000' }, 'AudioClip', 'frequency')).toBe(44100);
  });

  it('Play 之後 isPlaying、time 照邏輯時鐘走（沒有 AudioContext 也一樣），播完自己停；loop 不停', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const w = world();
    setAudioTables(CLIPS, {});
    const h = compHandle(w, w.graph.components(w.graph.nodes.get('1')!).find((c) => c.type === 'AudioSource') as ComponentData);
    nativeSet(staticCtx, h, 'AudioSource', 'clip', { guid: 'sfx', fileID: '8300000' });
    R.AudioSource_Play$(staticCtx, h);
    expect(R.AudioSource_get_isPlaying(staticCtx, h)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(R.AudioSource_get_time(staticCtx, h)).toBeCloseTo(1, 2);
    vi.advanceTimersByTime(1000);
    expect(R.AudioSource_get_isPlaying(staticCtx, h)).toBe(false);
    w.tick(1 / 60);
    expect(R.AudioSource_get_time(staticCtx, h)).toBe(0);
    nativeSet(staticCtx, h, 'AudioSource', 'loop', true);
    nativeSet(staticCtx, h, 'AudioSource', 'pitch', 2);
    R.AudioSource_Play$(staticCtx, h);
    vi.advanceTimersByTime(1000);
    expect(R.AudioSource_get_isPlaying(staticCtx, h)).toBe(true);
    expect(R.AudioSource_get_time(staticCtx, h)).toBeCloseTo(2 - 81728 / 44100, 2);
    R.AudioSource_Stop(staticCtx, h);
    expect(R.AudioSource_get_isPlaying(staticCtx, h)).toBe(false);
  });

  it('物件關掉時停止（Unity 的 AudioSource 停用就不播）', () => {
    const w = world();
    setAudioTables(CLIPS, {});
    const node = w.graph.nodes.get('1')!;
    const h = compHandle(w, w.graph.components(node).find((c) => c.type === 'AudioSource') as ComponentData);
    nativeSet(staticCtx, h, 'AudioSource', 'clip', { guid: 'sfx', fileID: '8300000' });
    nativeSet(staticCtx, h, 'AudioSource', 'loop', true);
    R.AudioSource_Play$(staticCtx, h);
    w.graph.setActive(node, false);
    w.tick(1 / 60);
    expect(R.AudioSource_get_isPlaying(staticCtx, h)).toBe(false);
  });

  it('PlayScheduled：排在 dspTime 之後，排定之前進度是 0', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const w = world();
    setAudioTables(CLIPS, {});
    const h = compHandle(w, w.graph.components(w.graph.nodes.get('1')!).find((c) => c.type === 'AudioSource') as ComponentData);
    nativeSet(staticCtx, h, 'AudioSource', 'clip', { guid: 'sfx', fileID: '8300000' });
    R.AudioSource_PlayScheduled(staticCtx, h, R.AudioSettings_get_dspTime(staticCtx) + 1);
    vi.advanceTimersByTime(500);
    expect(R.AudioSource_get_time(staticCtx, h)).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(R.AudioSource_get_time(staticCtx, h)).toBeCloseTo(0.5, 2);
  });
});

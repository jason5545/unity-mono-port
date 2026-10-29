// 開機時的 AudioContext（unityAudio.ts 的 mountAudio，2026/10/17 Jason：原版標題畫面一進去就有 BGM，網頁版要點一下）。
// 瀏覽器在 new AudioContext() 的當下決定能不能直接跑（Chrome：跟網域互動過、MEI 過門檻）。以前第一次點擊才建，
// 允許自動播放的瀏覽器也要點一下。vitest 沒有 AudioContext，這裡用假的：建立時的 state 照「瀏覽器允不允許」給。
// 模組層的 AudioContext 是單例，每個測試 resetModules 重新載入。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentData, SceneFile } from '../unity/types';

const BGM = { name: 'MUSIC_CovenantOutpost_Main', file: 'audioclips/bgm.ogg', channels: 2, frequency: 44100, samples: 44100 * 60 };

let initialState: 'running' | 'suspended' = 'running';
let made: FakeContext[] = [];
let started: { offset: number }[] = [];
class FakeContext {
  state: string;
  currentTime = 0;
  sampleRate = 48000;
  destination = { connect() {} };
  private onState: (() => void) | null = null;
  constructor() {
    this.state = initialState;
    made.push(this);
  }
  addEventListener(_t: string, f: () => void): void {
    this.onState = f;
  }
  createGain() {
    return { gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} };
  }
  createBufferSource() {
    return { buffer: null, loop: false, playbackRate: { value: 1 }, onended: null, connect() {}, disconnect() {}, stop() {}, start: (_when: number, offset: number) => started.push({ offset }) };
  }
  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData() {} };
  }
  decodeAudioData() {
    return Promise.resolve({ duration: 60 });
  }
  /** 瀏覽器允許之後（第一次手勢）：變 running、發 statechange */
  allow(): void {
    this.state = 'running';
    this.onState?.();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};
let clock = 1000;

async function boot() {
  vi.resetModules();
  const A = await import('./unityAudio');
  const R = await import('./unity');
  const { World } = await import('../engine/world');
  const { SceneGraph } = await import('../unity/scene');
  const { compHandle, setActiveWorld, staticCtx } = await import('./core');
  const { nativeSet } = await import('./unityNative');
  await A.mountAudio('/game/');
  const file = {
    guid: 'g', name: 'g', src: 'g', settings: {}, roots: ['1'],
    gameObjects: { '1': { m_Name: 'Music', m_IsActive: 1, m_Layer: 0, m_TagString: 'Untagged', components: ['2', '3'], transform: '2', parent: null, children: [] } },
    components: {
      '2': { type: 'Transform', classID: 4, gameObject: '1', m_Father: null, m_Children: [], m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalScale: { x: 1, y: 1, z: 1 } },
      '3': { type: 'AudioSource', classID: 82, gameObject: '1', m_Enabled: 1, m_audioClip: null, m_PlayOnAwake: 0, m_Volume: 1, m_Pitch: 1, Loop: 1, Mute: 0 },
    },
  } as unknown as SceneFile;
  const w = new World(new SceneGraph(file), { localization: undefined as never, version: 'test', controllers: {}, clips: {}, registry: {}, layout: {}, sortingLayerIndex: () => 0 });
  setActiveWorld(w);
  w.start();
  const h = compHandle(w, w.graph.components(w.graph.nodes.get('1')!).find((c) => c.type === 'AudioSource') as ComponentData);
  const playBgm = (): void => {
    nativeSet(staticCtx, h, 'AudioSource', 'clip', { guid: 'bgm', fileID: '8300000' });
    R.AudioSource_Play$(staticCtx, h);
  };
  return { playBgm, debug: () => A.audioDebug() as { context: string; playing: { node: boolean }[] } };
}

beforeEach(() => {
  made = [];
  started = [];
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('fetch', (url: string) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.endsWith('audioclips.json') ? { bgm: BGM } : {}),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('開機的 AudioContext 與自動播放', () => {
  it('瀏覽器允許自動播放：mountAudio 就建好 AudioContext，沒有任何手勢，循環的音樂一播就出聲', async () => {
    initialState = 'running';
    const { playBgm, debug } = await boot();
    expect(made.length).toBe(1);
    expect(debug().context).toBe('running');
    playBgm();
    await flush();
    expect(started).toEqual([{ offset: 0 }]);
    expect(debug().playing[0].node).toBe(true);
  });

  it('瀏覽器不允許：照樣在開機建（suspended），不出聲；第一次手勢之後循環的音樂照邏輯進度接上', async () => {
    initialState = 'suspended';
    const { playBgm, debug } = await boot();
    expect(debug().context).toBe('suspended');
    playBgm();
    await flush();
    expect(started).toEqual([]);
    clock += 2500;
    made[0].allow();
    await flush();
    expect(started.length).toBe(1);
    expect(started[0].offset).toBeCloseTo(2.5, 3);
  });
});

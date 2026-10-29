// 相容層：Unity 內建聲音（AudioSource、AudioClip、AudioMixer、AudioMixerGroup、AudioMixerSnapshot、AudioSettings.dspTime），用 Web Audio 播。
// unity.ts 會 export * 這裡；bootGame 叫 mountAudio 讀匯入器的 audioclips.json（原檔＋聲道、取樣率、樣本數）與 audiomixers.json（.mixer）。
//
// 時間：播放進度照邏輯時鐘（performance.now，跟 Unity 的 DSP 時鐘一樣不受 timeScale 影響）算，isPlaying、time 不看 AudioContext 有沒有在跑。
//   瀏覽器在使用者第一次點擊或按鍵之前不准出聲（AudioContext 是 suspended），Unity 這時照樣在播，所以遊戲的流程照邏輯時鐘走。
//   AudioContext 在 mountAudio（開機）就建：瀏覽器在建立的當下決定能不能直接跑（Chrome：跟這個網域互動過、桌面版的
//   Media Engagement Index 過門檻；WebView 關掉手勢要求），能的話標題畫面的音樂一開始就有聲音；不能的才等第一次點擊或按鍵。
// 出聲：AudioContext 能跑之後才建播放節點。不循環的聲音（音效）只在開始播的當下出聲，錯過的不補（不然第一次點擊會把之前排隊的音效一起放出來）；
//   循環的（音樂）在能出聲時照邏輯進度接上。第一次播某個 clip 要先下載、解碼，聲音會晚一點出來，進度照邏輯時鐘（未補償）。
// 混音器：每個群組一個 GainNode（音量 dB → 倍率，−80 dB 當 0），子群組接父群組，主群組接 m_OutputGroup 指的別的混音器的群組
//   （或執行期設的 AudioMixer.outputAudioMixerGroup），都沒有接 destination。參數值從起始快照開始；
//   AudioMixerSnapshot.TransitionTo(t) 在 t 秒內從目前的值線性插到目標快照（照 dB 插；Unity 的預設過渡曲線未查證）；
//   AudioMixer.SetFloat 設過的曝露參數不再跟快照走，ClearFloat 才回來（Unity 文件 AudioMixer.SetFloat／ClearFloat）。
//   曝露參數的名稱照 CRC32 比對：build 只存名稱的 CRC32，AssetRipper 補的名稱（MainMixer 的 mposwoH）跟原名（MusicVolume）CRC32 相同。
//   效果器只做 Attenuation（就是群組音量）；群組的音高、其他效果器、solo 沒做（MT2 的六個混音器只有 Attenuation，音高都是 1）。
// AudioSource：volume（0–1）、pitch（播放速度，負的當 0）、loop、mute、outputAudioMixerGroup；停用元件、物件或銷毀時停止（Unity 也是）。
// 沒做：3D 聲音（spatialBlend、距離衰減）、playOnAwake（MT2 的場景與 prefab 沒有 AudioSource 元件，都是執行期 AddComponent）、
//   PlayOneShot 不算進 isPlaying、Timeline 的 Audio track（AudioClipPlayable）；AudioListener.pause 只靜音、不暫停進度。

import { registerWillRenderCanvases, type World } from '../engine/world';
import type { ComponentData } from '../unity/types';
import { getActiveWorld, H, resolveValue, type Ctx } from './core';
import { registerNativeDataProp, registerNativeProp } from './unityNative';
import { crc32 } from '../engine/crc32';

type Ref = { guid: string; fileID: string | number };
export interface ClipInfo {
  name: string;
  file: string;
  channels?: number;
  frequency?: number;
  samples?: number;
}
export interface MixerGroupData {
  name: string;
  children: string[];
  volume: string;
  pitch: string;
  mute: number;
}
export interface MixerData {
  name: string;
  output: Ref | null;
  master: string;
  snapshotOrder: string[];
  startSnapshot: string;
  updateMode: number;
  exposed: { guid: string; name: string }[];
  groups: Record<string, MixerGroupData>;
  snapshots: Record<string, { name: string; values: Record<string, number> }>;
}

let assetsBase = '';
let clips: Record<string, ClipInfo> = {};
let mixerData: Record<string, MixerData> = {};

async function fetchJson<T>(url: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : fallback;
  } catch {
    return fallback;
  }
}
/** 開機時讀聲音的表（base 是匯入器輸出的網址，例如 "/game/"）；沒有表的遊戲照樣跑，只是沒聲音 */
export async function mountAudio(base: string): Promise<void> {
  assetsBase = `${base}assets/`;
  const [c, m] = await Promise.all([fetchJson<Record<string, ClipInfo>>(`${assetsBase}audioclips.json`, {}), fetchJson<Record<string, MixerData>>(`${assetsBase}audiomixers.json`, {})]);
  setAudioTables(c, m);
  installGestureResume();
  // 開機就建 AudioContext（以前第一次點擊才建，瀏覽器允許自動播放也要點一下才有聲音）。已經在跑就不會有 statechange，自己接一次
  if (audioCtx()?.state === 'running') resumePlaying();
}
/** 換掉聲音的表（mountAudio 用；測試直接給資料）。混音器的執行期狀態一起清掉 */
export function setAudioTables(c: Record<string, ClipInfo>, m: Record<string, MixerData>): void {
  clips = c;
  mixerData = m;
  mixers.clear();
}

// ───────── 時鐘與 AudioContext ─────────

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
let actx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  if (!actx && typeof AudioContext !== 'undefined') {
    actx = new AudioContext();
    actx.addEventListener('statechange', () => {
      if (actx?.state === 'running') resumePlaying();
    });
  }
  return actx;
}
const canSound = (): boolean => actx?.state === 'running';
/** AudioListener：全部輸出經過這個節點（AudioListener.volume；pause 時是 0，Unity 是暫停所有 AudioSource，這裡只靜音） */
let listenerGain: GainNode | null = null;
let listenerVolume = 1;
let listenerPaused = false;
function destination(): AudioNode | null {
  const ac = audioCtx();
  if (!ac) return null;
  if (!listenerGain) {
    listenerGain = ac.createGain();
    listenerGain.connect(ac.destination);
  }
  listenerGain.gain.value = listenerPaused ? 0 : listenerVolume;
  return listenerGain;
}
export const AudioListener_get_volume = (_c: Ctx): number => listenerVolume;
export function AudioListener_set_volume(_c: Ctx, v: number): void {
  listenerVolume = Math.max(0, v);
  destination();
}
export const AudioListener_get_pause = (_c: Ctx): boolean => listenerPaused;
export function AudioListener_set_pause(_c: Ctx, v: boolean): void {
  listenerPaused = !!v;
  destination();
}
export const AudioSettings_get_outputSampleRate = (_c: Ctx): number => actx?.sampleRate ?? 48000;
let gestureInstalled = false;
/** 第一次點擊、觸控或按鍵時讓 AudioContext 開始跑（瀏覽器的自動播放政策） */
function installGestureResume(): void {
  if (gestureInstalled || typeof window === 'undefined') return;
  gestureInstalled = true;
  const resume = (): void => void audioCtx()?.resume().catch(() => undefined);
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, resume, { capture: true });
}

// ───────── AudioClip ─────────

const buffers = new Map<string, Promise<AudioBuffer | null>>();
function clipInfo(clip: unknown): ClipInfo | null {
  const g = (clip as Ref | null)?.guid;
  return g ? (clips[g] ?? null) : null;
}
function clipLength(clip: unknown): number {
  const i = clipInfo(clip);
  return i?.samples !== undefined && i.frequency ? i.samples / i.frequency : 0;
}
/** 下載、解碼（同一個 clip 只做一次；UnloadAudioData 之後重來）。沒有 AudioContext 或檔案壞了回 null */
function loadBuffer(clip: unknown): Promise<AudioBuffer | null> {
  const g = (clip as Ref | null)?.guid;
  const info = clipInfo(clip);
  const ac = audioCtx();
  if (!g || !info || !ac) return Promise.resolve(null);
  let p = buffers.get(g);
  if (!p) {
    p = fetch(`${assetsBase}${info.file}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then((data) => ac.decodeAudioData(data))
      .catch((e) => {
        getActiveWorld()?.notes.add(`AudioClip ${info.name}（${info.file}）讀不到或解不開：${(e as Error).message}`);
        return null;
      });
    buffers.set(g, p);
  }
  return p;
}
export const AudioClip_get_length = (_c: Ctx, clip: unknown): number => clipLength(clip);
export const AudioClip_LoadAudioData = (_c: Ctx, clip: unknown): boolean => (void loadBuffer(clip), true);
/** UnloadAudioData：放掉解碼過的資料（音樂換曲時 CoreAudioSystem 會叫，一首幾 MB） */
export function AudioClip_UnloadAudioData(_c: Ctx, clip: unknown): boolean {
  const g = (clip as Ref | null)?.guid;
  if (g) buffers.delete(g);
  return true;
}
registerNativeDataProp('AudioClip', 'length', { get: (_c, o) => clipLength(o) });
registerNativeDataProp('AudioClip', 'samples', { get: (_c, o) => clipInfo(o)?.samples ?? 0 });
registerNativeDataProp('AudioClip', 'frequency', { get: (_c, o) => clipInfo(o)?.frequency ?? 0 });
registerNativeDataProp('AudioClip', 'channels', { get: (_c, o) => clipInfo(o)?.channels ?? 0 });
/** AudioDataLoadState.Loaded（2）：解碼是非同步的，遊戲沒有等它的流程 */
registerNativeDataProp('AudioClip', 'loadState', { get: () => 2 });
registerNativeDataProp('AudioClip', 'preloadAudioData', { get: () => true });

// ───────── AudioMixer ─────────

const dbToGain = (db: number): number => (db <= -80 ? 0 : Math.pow(10, db / 20));
/** CRC32：曝露參數的名稱比對（engine/crc32.ts） */
export { crc32 };

class MixerInstance {
  /** 參數 GUID → 目前的值（快照與過渡） */
  readonly values = new Map<string, number>();
  /** SetFloat 設過的曝露參數 */
  readonly overrides = new Map<string, number>();
  transition: { from: Map<string, number>; to: Map<string, number>; start: number; duration: number } | null = null;
  /** 執行期設的 outputAudioMixerGroup；undefined 是照資料的 m_OutputGroup */
  output: Ref | null | undefined = undefined;
  private nodes: Map<string, GainNode> | null = null;
  private connectedTo: AudioNode | null = null;
  constructor(
    readonly guid: string,
    readonly data: MixerData,
  ) {
    this.setValues(this.snapshotValues(data.startSnapshot));
  }
  /** 快照的參數值；快照沒列的參數用預設（音量 0 dB、音高 1） */
  snapshotValues(fileID: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const g of Object.values(this.data.groups)) {
      out.set(g.volume, 0);
      out.set(g.pitch, 1);
    }
    for (const [k, v] of Object.entries(this.data.snapshots[fileID]?.values ?? {})) out.set(k, v);
    return out;
  }
  setValues(v: Map<string, number>): void {
    for (const [k, x] of v) this.values.set(k, x);
    this.apply();
  }
  value(param: string): number {
    return this.overrides.get(param) ?? this.values.get(param) ?? 0;
  }
  exposedGuid(name: string): string | null {
    const h = crc32(name);
    return this.data.exposed.find((e) => e.name === name || crc32(e.name) === h)?.guid ?? null;
  }
  /** 群組的 GainNode（第一次要的時候整棵建起來） */
  node(groupFileID: string): GainNode | null {
    const ac = audioCtx();
    if (!ac) return null;
    if (!this.nodes) {
      this.nodes = new Map();
      for (const id of Object.keys(this.data.groups)) this.nodes.set(id, ac.createGain());
      for (const [id, g] of Object.entries(this.data.groups)) for (const ch of g.children) this.nodes.get(ch)?.connect(this.nodes.get(id)!);
      this.apply();
      this.connectOutput();
    }
    return this.nodes.get(groupFileID) ?? null;
  }
  connectOutput(): void {
    const master = this.nodes?.get(this.data.master);
    if (!master) return;
    const ref = this.output === undefined ? this.data.output : this.output;
    const target = (ref ? groupNode(ref) : null) ?? destination()!;
    if (target === this.connectedTo) return;
    if (this.connectedTo) master.disconnect();
    master.connect(target);
    this.connectedTo = target;
  }
  apply(): void {
    if (!this.nodes || !actx) return;
    for (const [id, g] of Object.entries(this.data.groups)) {
      const gain = g.mute ? 0 : dbToGain(this.value(g.volume));
      const p = this.nodes.get(id)!.gain;
      if (Math.abs(p.value - gain) > 1e-6) p.setTargetAtTime(gain, actx.currentTime, 0.01);
    }
  }
  /** 過渡：照混音器的 updateMode（0 Normal 用 Time.time、1 UnscaledTime 用 unscaledTime） */
  clock(w: World | null): number {
    if (!w) return now();
    return this.data.updateMode === 1 ? w.unscaledTime : w.time;
  }
  transitionTo(target: Map<string, number>, seconds: number): void {
    const w = getActiveWorld();
    if (!(seconds > 0)) {
      this.transition = null;
      this.setValues(target);
      return;
    }
    this.transition = { from: new Map(this.values), to: target, start: this.clock(w), duration: seconds };
  }
  tick(w: World): void {
    const tr = this.transition;
    if (!tr) return;
    const t = Math.min(1, (this.clock(w) - tr.start) / tr.duration);
    for (const [k, to] of tr.to) {
      const from = tr.from.get(k) ?? to;
      this.values.set(k, from + (to - from) * t);
    }
    if (t >= 1) this.transition = null;
    this.apply();
  }
}
const mixers = new Map<string, MixerInstance>();
function mixerOf(ref: unknown): MixerInstance | null {
  const g = (ref as Ref | null)?.guid;
  if (!g || !mixerData[g]) return null;
  let m = mixers.get(g);
  if (!m) mixers.set(g, (m = new MixerInstance(g, mixerData[g])));
  return m;
}
function groupNode(ref: Ref): GainNode | null {
  return mixerOf(ref)?.node(String(ref.fileID)) ?? null;
}

export function AudioMixer_SetFloat(_c: Ctx, mixer: unknown, name: string, value: number): boolean {
  const m = mixerOf(mixer);
  const p = m?.exposedGuid(name);
  if (!m || !p) return false;
  m.overrides.set(p, value);
  m.apply();
  return true;
}
export function AudioMixer_GetFloat(_c: Ctx, mixer: unknown, name: string, out: (v: number) => void): boolean {
  const m = mixerOf(mixer);
  const p = m?.exposedGuid(name);
  if (!m || !p) {
    out(0);
    return false;
  }
  out(m.value(p));
  return true;
}
export function AudioMixer_ClearFloat(_c: Ctx, mixer: unknown, name: string): boolean {
  const m = mixerOf(mixer);
  const p = m?.exposedGuid(name);
  if (!m || !p) return false;
  m.overrides.delete(p);
  m.apply();
  return true;
}
export function AudioMixer_FindSnapshot(_c: Ctx, mixer: unknown, name: string): Ref | null {
  const m = mixerOf(mixer);
  if (!m) return null;
  const id = m.data.snapshotOrder.find((f) => m.data.snapshots[f]?.name === name);
  return id ? { guid: m.guid, fileID: id } : null;
}
/** FindMatchingGroups(subPath)：名稱含 subPath 的群組（Unity 比的是路徑 Master/…；不分大小寫，未查證） */
export function AudioMixer_FindMatchingGroups(_c: Ctx, mixer: unknown, subPath: string): Ref[] {
  const m = mixerOf(mixer);
  if (!m) return [];
  const want = (subPath ?? '').toLowerCase();
  const out: Ref[] = [];
  const walk = (id: string, path: string): void => {
    const g = m.data.groups[id];
    if (!g) return;
    const p = path ? `${path}/${g.name}` : g.name;
    if (p.toLowerCase().includes(want)) out.push({ guid: m.guid, fileID: id });
    for (const ch of g.children) walk(ch, p);
  };
  walk(m.data.master, '');
  return out;
}
/** TransitionToSnapshots：各快照的值照權重平均（權重和是 0 時不動） */
export function AudioMixer_TransitionToSnapshots(_c: Ctx, mixer: unknown, snapshots: Ref[], weights: number[], seconds: number): void {
  const m = mixerOf(mixer);
  if (!m) return;
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return;
  const target = new Map<string, number>();
  snapshots.forEach((s, i) => {
    for (const [k, v] of m.snapshotValues(String(s.fileID))) target.set(k, (target.get(k) ?? 0) + (v * weights[i]) / total);
  });
  m.transitionTo(target, seconds);
}
export function AudioMixerSnapshot_TransitionTo(_c: Ctx, snapshot: unknown, seconds: number): void {
  const s = snapshot as Ref | null;
  const m = mixerOf(s);
  if (!m || !s) return;
  m.transitionTo(m.snapshotValues(String(s.fileID)), seconds);
}
registerNativeDataProp('AudioMixer', 'outputAudioMixerGroup', {
  get: (_c, o) => {
    const m = mixerOf(o);
    return m ? (m.output === undefined ? m.data.output : m.output) : null;
  },
  set: (_c, o, v) => {
    const m = mixerOf(o);
    if (!m) return;
    m.output = (v as Ref | null) ?? null;
    m.connectOutput();
  },
});
registerNativeDataProp('AudioMixer', 'updateMode', { get: (_c, o) => mixerOf(o)?.data.updateMode ?? 0 });
registerNativeDataProp('AudioMixerSnapshot', 'audioMixer', { get: (_c, o) => ({ guid: (o as Ref).guid, fileID: '24100000' }) });
registerNativeDataProp('AudioMixerGroup', 'audioMixer', { get: (_c, o) => ({ guid: (o as Ref).guid, fileID: '24100000' }) });

// ───────── AudioSource ─────────

interface SourceState {
  comp: ComponentData;
  clip: unknown;
  volume: number;
  pitch: number;
  loop: boolean;
  mute: boolean;
  playOnAwake: boolean;
  output: Ref | null;
  playing: boolean;
  paused: boolean;
  /** 進度 ＝ offset ＋ (now − startAt) × pitch（startAt 在未來是排定的開始） */
  startAt: number;
  offset: number;
  pausedPos: number;
  /** 每次 Play／Stop 加一（非同步的解碼回來時看還是不是同一次） */
  playId: number;
  node: AudioBufferSourceNode | null;
  gain: GainNode | null;
  gainTarget: AudioNode | null;
}
const sources = new WeakMap<ComponentData, SourceState>();
/** 正在播（或暫停中）的：每格檢查元件停用、物件關掉、銷毀、播完 */
const active = new Set<SourceState>();

function stateOf(h: H): SourceState {
  const comp = h.comp!;
  let s = sources.get(comp);
  if (!s) {
    const w = getActiveWorld();
    const ref = (v: unknown): unknown => (v && w ? resolveValue(w, v) : (v ?? null));
    s = {
      comp,
      clip: ref(comp.m_audioClip) ?? null,
      volume: (comp.m_Volume as number | undefined) ?? 1,
      pitch: (comp.m_Pitch as number | undefined) ?? 1,
      loop: !!comp.Loop,
      mute: !!comp.Mute,
      playOnAwake: comp.m_PlayOnAwake !== 0,
      output: (ref(comp.OutputAudioMixerGroup) as Ref | null) ?? null,
      playing: false,
      paused: false,
      startAt: 0,
      offset: 0,
      pausedPos: 0,
      playId: 0,
      node: null,
      gain: null,
      gainTarget: null,
    };
    sources.set(comp, s);
  }
  return s;
}
function position(s: SourceState): number {
  if (s.paused) return s.pausedPos;
  return s.offset + Math.max(0, now() - s.startAt) * Math.max(0, s.pitch);
}
function isPlaying(s: SourceState): boolean {
  if (!s.playing || s.paused) return false;
  return s.loop || position(s) < clipLength(s.clip);
}
/** 音量節點：source → gain → 輸出群組（或 destination） */
function ensureGain(s: SourceState): GainNode | null {
  const ac = audioCtx();
  if (!ac) return null;
  s.gain ??= ac.createGain();
  s.gain.gain.value = s.mute ? 0 : Math.min(1, Math.max(0, s.volume));
  const target = (s.output ? groupNode(s.output) : null) ?? destination()!;
  if (target !== s.gainTarget) {
    if (s.gainTarget) s.gain.disconnect();
    s.gain.connect(target);
    s.gainTarget = target;
  }
  return s.gain;
}
function stopNode(s: SourceState): void {
  if (!s.node) return;
  try {
    s.node.stop();
  } catch {
    /* 還沒 start 或已經停了 */
  }
  s.node.disconnect();
  s.node = null;
}
/** 照目前的邏輯進度建播放節點（能出聲而且還在播才建） */
function startNode(s: SourceState): void {
  if (!canSound() || !s.playing || s.paused || !s.clip) return;
  const id = s.playId;
  const intended = position(s);
  void loadBuffer(s.clip).then((buf) => {
    if (!buf || s.playId !== id || !s.playing || s.paused || s.node || !canSound()) return;
    const ac = actx!;
    let pos = position(s);
    const len = buf.duration;
    if (!s.loop) {
      if (pos >= len) return;
      // 解碼花的時間很短的話照頭開始播（音效的起音比對準進度重要）；拖太久就照進度接上
      if (pos - Math.max(0, intended) < 0.3) pos = Math.max(0, intended);
    } else pos %= len;
    const node = ac.createBufferSource();
    node.buffer = buf;
    node.loop = s.loop;
    node.playbackRate.value = Math.max(0, s.pitch);
    node.connect(ensureGain(s)!);
    const delay = Math.max(0, s.startAt - now());
    node.start(ac.currentTime + delay, Math.max(0, pos));
    node.onended = () => {
      if (s.node === node) s.node = null;
    };
    s.node = node;
  });
}
/** AudioContext 開始跑：循環中的照進度接上（不循環的錯過就算了，見檔頭） */
function resumePlaying(): void {
  for (const s of active) if (s.loop && !s.node) startNode(s);
}
function play(s: SourceState, startAt: number): void {
  stopNode(s);
  s.playId++;
  s.playing = true;
  s.paused = false;
  s.offset = 0;
  s.startAt = startAt;
  active.add(s);
  startNode(s);
}
function stop(s: SourceState): void {
  stopNode(s);
  s.playId++;
  s.playing = false;
  s.paused = false;
  s.offset = 0;
  active.delete(s);
}

export const AudioSource_Play$ = (_c: Ctx, h: H): void => play(stateOf(h), now());
export const AudioSource_Play$UInt64 = (_c: Ctx, h: H, delaySamples: number): void => play(stateOf(h), now() + Number(delaySamples) / 44100);
export const AudioSource_PlayDelayed = (_c: Ctx, h: H, delay: number): void => play(stateOf(h), now() + Math.max(0, delay));
/** PlayScheduled(time)：time 是 AudioSettings.dspTime 的時間軸（這裡的邏輯時鐘） */
export const AudioSource_PlayScheduled = (_c: Ctx, h: H, time: number): void => play(stateOf(h), Math.max(now(), time));
export function AudioSource_Stop(_c: Ctx, h: H): void {
  stop(stateOf(h));
}
export function AudioSource_Pause(_c: Ctx, h: H): void {
  const s = stateOf(h);
  if (!s.playing || s.paused) return;
  s.pausedPos = position(s);
  s.paused = true;
  stopNode(s);
}
export function AudioSource_UnPause(_c: Ctx, h: H): void {
  const s = stateOf(h);
  if (!s.paused) return;
  s.paused = false;
  s.offset = s.pausedPos;
  s.startAt = now();
  startNode(s);
}
/** PlayOneShot：另外一個節點，音量 ＝ volume × volumeScale，走同一個輸出；不影響 isPlaying、time（見檔頭） */
function oneShot(s: SourceState | null, clip: unknown, scale: number): void {
  if (!canSound() || !clip) return;
  void loadBuffer(clip).then((buf) => {
    if (!buf || !canSound()) return;
    const ac = actx!;
    const g = ac.createGain();
    g.gain.value = (s ? (s.mute ? 0 : s.volume) : 1) * scale;
    g.connect((s ? ensureGain(s) : null) ?? destination()!);
    const node = ac.createBufferSource();
    node.buffer = buf;
    if (s) node.playbackRate.value = Math.max(0, s.pitch);
    node.connect(g);
    node.onended = () => g.disconnect();
    node.start();
  });
}
export const AudioSource_PlayOneShot$AudioClip = (_c: Ctx, h: H, clip: unknown): void => oneShot(stateOf(h), clip, 1);
export const AudioSource_PlayOneShot$AudioClip_float = (_c: Ctx, h: H, clip: unknown, v: number): void => oneShot(stateOf(h), clip, v);
/** PlayClipAtPoint：位置不管（3D 聲音沒做） */
export const AudioSource_PlayClipAtPoint$AudioClip_Vector3 = (_c: Ctx, clip: unknown): void => oneShot(null, clip, 1);
export const AudioSource_PlayClipAtPoint$AudioClip_Vector3_float = (_c: Ctx, clip: unknown, _p: unknown, v: number): void => oneShot(null, clip, v);
export const AudioSource_get_isPlaying = (_c: Ctx, h: H): boolean => isPlaying(stateOf(h));
export function AudioSource_get_time(_c: Ctx, h: H): number {
  const s = stateOf(h);
  if (!s.playing) return 0;
  const len = clipLength(s.clip);
  const p = position(s);
  return len > 0 ? (s.loop ? p % len : Math.min(p, len)) : 0;
}
export function AudioSource_set_time(_c: Ctx, h: H, v: number): void {
  const s = stateOf(h);
  if (s.paused) {
    s.pausedPos = v;
    return;
  }
  s.offset = v;
  s.startAt = now();
  if (s.playing) {
    stopNode(s);
    s.playId++;
    startNode(s);
  }
}

const prop = (name: string, get: (s: SourceState) => unknown, set: (s: SourceState, v: unknown) => void): void =>
  registerNativeProp('AudioSource', name, { get: (_c, h) => get(stateOf(h)), set: (_c, h, v) => set(stateOf(h), v) });
prop(
  'clip',
  (s) => s.clip,
  (s, v) => {
    // 換 clip：Unity 會停掉正在播的（未查證）；先開始下載解碼，Play 時就比較快
    if (s.playing && v !== s.clip) stop(s);
    s.clip = v ?? null;
    if (s.clip && canSound()) void loadBuffer(s.clip);
  },
);
prop(
  'volume',
  (s) => s.volume,
  (s, v) => {
    s.volume = Math.min(1, Math.max(0, Number(v)));
    if (s.gain) s.gain.gain.value = s.mute ? 0 : s.volume;
  },
);
prop(
  'mute',
  (s) => s.mute,
  (s, v) => {
    s.mute = !!v;
    if (s.gain) s.gain.gain.value = s.mute ? 0 : s.volume;
  },
);
prop(
  'pitch',
  (s) => s.pitch,
  (s, v) => {
    // 進度換基準點，之後照新的速度走
    s.offset = position(s);
    s.startAt = Math.max(now(), s.startAt);
    s.pitch = Number(v);
    if (s.node) s.node.playbackRate.value = Math.max(0, s.pitch);
  },
);
prop(
  'loop',
  (s) => s.loop,
  (s, v) => {
    s.loop = !!v;
    if (s.node) s.node.loop = s.loop;
  },
);
prop(
  'playOnAwake',
  (s) => s.playOnAwake,
  (s, v) => void (s.playOnAwake = !!v),
);
prop(
  'outputAudioMixerGroup',
  (s) => s.output,
  (s, v) => {
    s.output = (v as Ref | null) ?? null;
    if (s.gain) ensureGain(s);
  },
);

// ───────── 每格 ─────────

/** AudioSettings.dspTime：邏輯時鐘（秒） */
export const AudioSettings_get_dspTime = (_c: Ctx): number => now();

/** Canvas.willRenderCanvases（每格一次）：混音器的過渡；AudioSource 停用、物件關掉、銷毀時停；不循環的播完就停 */
export function tickAudio(w: World): void {
  for (const m of mixers.values()) m.tick(w);
  for (const s of [...active]) {
    const node = w.graph.nodeById(s.comp.gameObject as unknown as string);
    const gone = !node || w.graph.nodes.get(node.id) !== node || !node.activeInHierarchy || s.comp.m_Enabled === 0;
    if (gone || (!s.paused && !s.loop && position(s) >= clipLength(s.clip))) stop(s);
  }
}
registerWillRenderCanvases(tickAudio);

let analyser: AnalyserNode | null = null;
/** 除錯：輸出端（AudioListener 之後）目前的 RMS（0–1）；第一次叫時才接上 AnalyserNode */
function outputLevel(): number | null {
  const out = actx ? destination() : null;
  if (!out || !actx) return null;
  if (!analyser) {
    analyser = actx.createAnalyser();
    analyser.fftSize = 2048;
    out.connect(analyser);
  }
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  return Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length);
}
/** 除錯：正在播的 AudioSource、混音器的參數、輸出電平（RMS） */
export function audioDebug(): unknown {
  return {
    context: actx?.state ?? 'none',
    level: outputLevel(),
    playing: [...active].map((s) => ({ clip: clipInfo(s.clip)?.name, loop: s.loop, volume: s.volume, pitch: s.pitch, pos: +position(s).toFixed(2), node: !!s.node, output: s.output ? `${mixerData[s.output.guid]?.name}/${mixerData[s.output.guid]?.groups[String(s.output.fileID)]?.name}` : null })),
    mixers: [...mixers.values()].map((m) => ({
      name: m.data.name,
      groups: Object.values(m.data.groups).map((g) => `${g.name} ${m.value(g.volume).toFixed(1)}dB`),
      transition: !!m.transition,
    })),
  };
}

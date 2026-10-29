// 相容層：UnityEngine.Video.VideoPlayer。影片照原版的檔案（StreamingAssets 的 url、或 VideoClip）用瀏覽器的 <video> 播，
// 播到結尾發 loopPointReached（C# 的事件，產生碼用 R.eventAdd 訂閱）。unity.ts 會 export * 這裡。
//   - 畫面：CameraFarPlane／CameraNearPlane 由 videoLayers() 交給繪製端（SceneRenderer.videoLayers，boot 接上），在 targetCamera 那一趟
//     畫（遠平面在它清完背景之後、近平面在它的場景之後），照 aspectRatio 縮放、乘 targetCameraAlpha；RenderTexture、MaterialOverride 還沒畫（只有聲音與流程）。
//   - 聲音：audioOutputMode 是 AudioSource 時音量照目標 AudioSource 的 volume；Direct 照 SetDirectAudioVolume。
//   - 瀏覽器不准有聲自動播放時改成靜音播（流程照走）；檔案讀不到時當作播完（Unity 會發 errorReceived，遊戲多半卡住，網頁上不卡）。

import { compHandle, eventGet, getActiveWorld, H, invokeDelegate, resolveValue, staticCtx, type Ctx } from './core';
import { streamingUrl } from './dotnetIO';
import { registerNativeProp } from './unityNative';
import type { ComponentData } from '../unity/types';
import type { VideoLayer } from '../render/sceneRenderer';

export interface VideoState {
  comp: ComponentData;
  el: HTMLVideoElement | null;
  url: string;
  playOnAwake: boolean;
  isLooping: boolean;
  playbackSpeed: number;
  prepared: boolean;
  paused: boolean;
  directVolume: number;
  directMute: boolean;
  audioSource: H | null;
  /** 跟這個 VideoPlayer 一起的設定（renderMode、targetCamera、aspectRatio…）：繪製端讀 */
  props: Record<string, unknown>;
}
const states = new WeakMap<ComponentData, VideoState>();
const playing = new Set<VideoState>();

/** 正在播（或暫停中）的影片：繪製端拿 <video> 元素畫到 targetCamera 的遠平面或 targetTexture */
export function activeVideos(): VideoState[] {
  return [...playing];
}

function stateOf(h: H): VideoState {
  const comp = h.comp!;
  let s = states.get(comp);
  if (!s) {
    s = {
      comp,
      el: null,
      url: (comp.m_Url as string | undefined) ?? '',
      playOnAwake: comp.m_PlayOnAwake !== 0,
      isLooping: comp.m_Looping === 1,
      playbackSpeed: (comp.m_PlaybackSpeed as number | undefined) ?? 1,
      prepared: false,
      paused: false,
      directVolume: 1,
      directMute: false,
      audioSource: null,
      props: {},
    };
    states.set(comp, s);
  }
  return s;
}
/** 原版的路徑（/streaming/intro_fmv.mp4、Application.streamingAssetsPath 底下）→ 網頁拿得到的網址 */
function resolveUrl(url: string): string {
  return streamingUrl(url) ?? url;
}
function volumeOf(c: Ctx, s: VideoState): number {
  const mode = (s.props.audioOutputMode as number | undefined) ?? (s.comp.m_AudioOutputMode as number | undefined) ?? 1;
  if (mode === 0) return 0; // None
  if (mode === 1 && s.audioSource?.comp) return ((s.audioSource.comp.m_Volume as number | undefined) ?? 1) * (s.audioSource.comp.m_Mute ? 0 : 1);
  void c;
  return s.directMute ? 0 : s.directVolume;
}
function fireLoopPoint(h: H): void {
  const world = getActiveWorld();
  for (const f of eventGet(staticCtx, 'VideoPlayer.loopPointReached', h) ?? []) {
    const call = (): void => void invokeDelegate(staticCtx, f, h);
    if (world) world.guard('VideoPlayer.loopPointReached', call);
    else call();
  }
}
function ensureElement(c: Ctx, h: H, s: VideoState): HTMLVideoElement {
  if (s.el) return s.el;
  const el = document.createElement('video');
  el.playsInline = true;
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  el.addEventListener('ended', () => {
    if (s.isLooping) return;
    playing.delete(s);
    // Unity 在下一次 Update 之間發事件；這裡排到下一格開頭，跟腳本的 Update 同一條時間線
    const world = getActiveWorld();
    if (world) world.beforeNextTick(() => fireLoopPoint(h));
    else fireLoopPoint(h);
  });
  el.addEventListener('error', () => {
    playing.delete(s);
    const world = getActiveWorld();
    world?.notes.add(`VideoPlayer：${s.url} 讀不到，當作播完`);
    if (world) world.beforeNextTick(() => fireLoopPoint(h));
  });
  el.addEventListener('loadeddata', () => {
    s.prepared = true;
    for (const f of eventGet(staticCtx, 'VideoPlayer.prepareCompleted', h) ?? []) invokeDelegate(c, f, h);
  });
  s.el = el;
  return el;
}
function load(c: Ctx, h: H, s: VideoState): HTMLVideoElement {
  const el = ensureElement(c, h, s);
  const src = resolveUrl(s.url);
  if (el.dataset.src !== src) {
    el.dataset.src = src;
    el.src = src;
    s.prepared = false;
  }
  return el;
}

export function VideoPlayer_Play(c: Ctx, h: H): void {
  const s = stateOf(h);
  const el = load(c, h, s);
  el.loop = s.isLooping;
  el.playbackRate = s.playbackSpeed;
  el.volume = Math.max(0, Math.min(1, volumeOf(c, s)));
  s.paused = false;
  playing.add(s);
  el.play().catch(() => {
    // 自動播放政策：有聲音的不准播時改靜音播
    el.muted = true;
    el.play().catch(() => void 0);
  });
}
export function VideoPlayer_Pause(c: Ctx, h: H): void {
  void c;
  const s = stateOf(h);
  s.paused = true;
  s.el?.pause();
}
export function VideoPlayer_Stop(c: Ctx, h: H): void {
  void c;
  const s = stateOf(h);
  s.paused = false;
  playing.delete(s);
  if (s.el) {
    s.el.pause();
    s.el.currentTime = 0;
  }
}
export function VideoPlayer_Prepare(c: Ctx, h: H): void {
  load(c, h, stateOf(h));
}
export const VideoPlayer_SetTargetAudioSource = (_c: Ctx, h: H, track: number, src: H | null): void => void (track === 0 && (stateOf(h).audioSource = src));
export const VideoPlayer_GetTargetAudioSource = (_c: Ctx, h: H, track: number): H | null => (track === 0 ? stateOf(h).audioSource : null);
export const VideoPlayer_SetDirectAudioVolume = (_c: Ctx, h: H, track: number, v: number): void => void (track === 0 && (stateOf(h).directVolume = v));
export const VideoPlayer_SetDirectAudioMute = (_c: Ctx, h: H, track: number, m: boolean): void => void (track === 0 && (stateOf(h).directMute = m));
export const VideoPlayer_GetDirectAudioVolume = (_c: Ctx, h: H, track: number): number => (track === 0 ? stateOf(h).directVolume : 1);

/** 設定值：腳本設過的（props）優先，再來是場景存檔的欄位（m_RenderMode、m_TargetCamera…），都沒有用 Unity 的預設 */
function setting(s: VideoState, name: string, def: unknown): unknown {
  if (name in s.props) return s.props[name];
  const raw = s.comp[`m_${name[0].toUpperCase()}${name.slice(1)}`];
  if (raw === undefined) return def;
  const world = getActiveWorld();
  return world ? resolveValue(world, raw) : raw;
}
// 屬性（R.nativeGet／nativeSet 的 VideoPlayer.*）
const prop = (name: string, def: unknown) =>
  registerNativeProp('VideoPlayer', name, {
    get: (_c, h) => setting(stateOf(h), name, def),
    set: (_c, h, v) => void (stateOf(h).props[name] = v),
  });
registerNativeProp('VideoPlayer', 'url', { get: (_c, h) => stateOf(h).url, set: (_c, h, v) => void (stateOf(h).url = (v as string) ?? '') });
registerNativeProp('VideoPlayer', 'playOnAwake', { get: (_c, h) => stateOf(h).playOnAwake, set: (_c, h, v) => void (stateOf(h).playOnAwake = !!v) });
registerNativeProp('VideoPlayer', 'isLooping', {
  get: (_c, h) => stateOf(h).isLooping,
  set: (_c, h, v) => {
    const s = stateOf(h);
    s.isLooping = !!v;
    if (s.el) s.el.loop = s.isLooping;
  },
});
registerNativeProp('VideoPlayer', 'playbackSpeed', {
  get: (_c, h) => stateOf(h).playbackSpeed,
  set: (_c, h, v) => {
    const s = stateOf(h);
    s.playbackSpeed = v as number;
    if (s.el) s.el.playbackRate = s.playbackSpeed;
  },
});
registerNativeProp('VideoPlayer', 'time', {
  get: (_c, h) => stateOf(h).el?.currentTime ?? 0,
  set: (_c, h, v) => void (stateOf(h).el && (stateOf(h).el!.currentTime = v as number)),
});
registerNativeProp('VideoPlayer', 'length', { get: (_c, h) => stateOf(h).el?.duration || 0 });
registerNativeProp('VideoPlayer', 'isPlaying', { get: (_c, h) => playing.has(stateOf(h)) && !stateOf(h).paused });
registerNativeProp('VideoPlayer', 'isPaused', { get: (_c, h) => stateOf(h).paused });
registerNativeProp('VideoPlayer', 'isPrepared', { get: (_c, h) => stateOf(h).prepared });
registerNativeProp('VideoPlayer', 'clip', { get: (c, h) => resolveValue(c.w ?? getActiveWorld()!, h.comp?.m_VideoClip ?? null), set: (_c, h, v) => void (h.comp && (h.comp.m_VideoClip = v)) });
for (const [name, def] of [
  ['renderMode', 0],
  ['targetCamera', null],
  ['targetCameraAlpha', 1],
  ['aspectRatio', 2],
  ['audioOutputMode', 1],
  ['source', 0],
  ['waitForFirstFrame', true],
  ['timeReference', 0],
  ['externalReferenceTime', 0],
  ['skipOnDrop', true],
  ['sendFrameReadyEvents', false],
] as const)
  prop(name, def);

/**
 * 給繪製端：畫在攝影機遠平面／近平面的影片（renderMode 0／1）。播放中或暫停中、物件與元件啟用、目標攝影機存在且啟用才畫
 * （Unity 的 targetCamera 是 null 時不畫）。播完（沒 loop）就不畫了：Unity 停在最後一格還是清掉，未查證。
 */
export function videoLayers(): VideoLayer[] {
  const world = getActiveWorld();
  if (!world) return [];
  const out: VideoLayer[] = [];
  for (const s of playing) {
    const mode = setting(s, 'renderMode', 0) as number;
    if ((mode !== 0 && mode !== 1) || !s.el || s.comp.m_Enabled === 0) continue;
    if (!world.graph.nodeById(s.comp.gameObject as unknown as string)?.activeInHierarchy) continue;
    const cam = setting(s, 'targetCamera', null) as H | null;
    if (!(cam instanceof H) || !cam.comp || !cam.node.activeInHierarchy || cam.comp.m_Enabled === 0) continue;
    out.push({ el: s.el, nearPlane: mode === 1, camera: cam.comp, alpha: setting(s, 'targetCameraAlpha', 1) as number, aspectRatio: setting(s, 'aspectRatio', 2) as number });
  }
  return out;
}

/** 給繪製端：VideoPlayer 元件的 handle（world 有了才有） */
export function videoHandle(s: VideoState): H | null {
  const world = getActiveWorld();
  return world ? compHandle(world, s.comp) : null;
}

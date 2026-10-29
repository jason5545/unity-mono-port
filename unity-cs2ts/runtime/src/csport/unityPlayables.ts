// 相容層：UnityEngine.Playables（PlayableGraph、Playable、ScriptPlayable、PlayableOutput、PlayableDirector）。unity.ts 會 export * 這裡。
// Timeline（Unity.Timeline）本身是 managed C#，照原版轉（遊戲的 cs2ts.json 把反編譯的原始碼放進 sourceAssemblies）；這裡是它底下引擎原生的那一層。
//
// 照原文的部分（UnityCsReference 2022.3 的 Runtime/Export/Director、Modules/Director）：
//   - PlayableBehaviour 的預設方法都不做事，Clone 是 MemberwiseClone；ScriptPlayable.Create 有 template 就複製它（ICloneable.Clone），
//     沒有就新建 T；放進 handle 之後才觸發 OnPlayableCreate。
//   - PlayableAsset.duration 預設 PlayableBinding.DefaultDuration（正無限大），outputs 預設 PlayableBinding.None（空陣列）。
//   - ScriptPlayableBinding.Create 建的 binding，CreateOutput 時建 ScriptPlayableOutput。ExposedReference.Resolve 先問 resolver，沒有才用 defaultValue。
//   - FrameData 的欄位與旗標（evaluationType、timeLooped、timeHeld、effectivePlayState…）。
//   - PlayableDirector：Stop 停止並銷毀 graph；played／paused／stopped 三個事件。
//   - WrapMode None 到終點：在 duration 那一格求值一次再 Stop（Timeline 1.7.0 的 changelog：修好「最後一格不保證執行」，Unity 2021.2 以上）。
//
// 原生、沒有原始碼的部分，照文件與 Timeline 的用法做（未查證的寫在 README 的差異清單）：
//   - 每格在腳本的 Update 之後（Unity 的 Update.DirectorUpdate）推進播放中的 PlayableDirector；GameTime 用 Time.deltaTime。
//   - graph 求值：先把播放中的 playable 的時間往前推，再 PrepareFrame（由 output 往輸入走，每個 playable 一次；Passthrough 只走 output 那個 port
//     對應的輸入），再對每個 output 做 ProcessFrame（playerData 是 output 的 UserData）。暫停的 playable 和它的輸入不走。
//   - OnBehaviourPlay／OnBehaviourPause 在播放狀態改變後的下一次求值發；OnGraphStart 在第一次求值時發。
//   - 新建的 playable 是 Playing（RuntimeClip 建好後自己 Pause）；duration 預設正無限大。
//   - Stop 之後 time 回 initialTime；PlayableDirector 的綁定照場景存檔的 m_SceneBindings（track → 元件），exposed reference 照 m_ExposedReferences。

import { callAs, eventGet, gameObjectOf, genClass, getActiveWorld, H, hasGen, invokeDelegate, newGen, registerExternalCtor, registerValueType, resolveValue, staticCtx, type Ctx } from './core';
import { csException } from './dotnet';
import { nativeSet, registerNativeBase, registerNativeDataProp, registerNativeProp } from './unityNative';
import { registerDirectorUpdate, type World } from '../engine/world';
import type { ComponentData } from '../unity/types';


// PlayState：Paused 0、Playing 1。PlayableTraversalMode：Mix 0、Passthrough 1。
// DirectorWrapMode：Hold 0、Loop 1、None 2。DirectorUpdateMode：DSPClock 0、GameTime 1、UnscaledGameTime 2、Manual 3。
const PAUSED = 0;
const PLAYING = 1;
const PASSTHROUGH = 1;
const WRAP_HOLD = 0;
const WRAP_LOOP = 1;
const UPDATE_MANUAL = 3;

// ───────── graph 與 playable 的原生狀態 ─────────

interface PNode {
  id: number;
  graph: GraphState;
  /** C# 的型別（Playable、ScriptPlayable、AnimationClipPlayable…），IsPlayableOfType 用 */
  type: string;
  /** ScriptPlayable 的 PlayableBehaviour（產生類別的實體） */
  behaviour: Record<string, unknown> | null;
  inputs: (PNode | null)[];
  weights: number[];
  /** 每個 output port 接到哪個 playable */
  outputs: (PNode | null)[];
  time: number;
  previousTime: number;
  duration: number;
  speed: number;
  state: number;
  done: boolean;
  propagateSetTime: boolean;
  traversal: number;
  timeWrapMode: number;
  leadTime: number;
  /** 最後一次發給 behaviour 的播放狀態（OnBehaviourPlay／OnBehaviourPause） */
  notified: number | null;
  started: boolean;
  destroyed: boolean;
}
interface OutState {
  id: number;
  graph: GraphState;
  type: string;
  name: string;
  source: PNode | null;
  port: number;
  weight: number;
  reference: unknown;
  userData: unknown;
  receivers: unknown[];
}
interface GraphState {
  id: number;
  name: string;
  nodes: PNode[];
  outputs: OutState[];
  resolver: unknown;
  timeUpdateMode: number;
  playing: boolean;
  destroyed: boolean;
  frameId: number;
}

type PHandle = { $type: string; n: PNode | null };
type GHandle = { $type: 'PlayableGraph'; g: GraphState | null };
type OHandle = { $type: string; o: OutState | null };

let seq = 1;
const handle = (n: PNode | null, type = 'Playable'): PHandle => ({ $type: type, n });
const graphHandle = (g: GraphState | null): GHandle => ({ $type: 'PlayableGraph', g });
const outHandle = (o: OutState | null, type = 'PlayableOutput'): OHandle => ({ $type: type, o });

function nodeOf(p: unknown): PNode | null {
  const n = (p as PHandle | null)?.n;
  return n && !n.destroyed ? n : null;
}
function needNode(p: unknown, what: string): PNode {
  const n = nodeOf(p);
  if (!n) throw csException(['InvalidOperationException', 'SystemException', 'Exception'], `${what}：這個 PlayableHandle 無效`, null, 'Playables');
  return n;
}
function graphOf(g: unknown): GraphState | null {
  const s = (g as GHandle | null)?.g;
  return s && !s.destroyed ? s : null;
}
function needGraph(g: unknown, what: string): GraphState {
  const s = graphOf(g);
  if (!s) throw csException(['InvalidOperationException', 'SystemException', 'Exception'], `${what}：這個 PlayableGraph 無效`, null, 'Playables');
  return s;
}
function outOf(o: unknown): OutState | null {
  const s = (o as OHandle | null)?.o;
  return s && !s.graph.destroyed ? s : null;
}
function needOut(o: unknown, what: string): OutState {
  const s = outOf(o);
  if (!s) throw csException(['InvalidOperationException', 'SystemException', 'Exception'], `${what}：這個 PlayableOutput 無效`, null, 'Playables');
  return s;
}

function newGraph(name: string): GraphState {
  return { id: seq++, name, nodes: [], outputs: [], resolver: null, timeUpdateMode: 1, playing: false, destroyed: false, frameId: 0 };
}
function newNode(g: GraphState, type: string, inputCount: number): PNode {
  const n: PNode = {
    id: seq++,
    graph: g,
    type,
    behaviour: null,
    inputs: new Array(Math.max(0, inputCount)).fill(null),
    weights: new Array(Math.max(0, inputCount)).fill(0),
    outputs: [null],
    time: 0,
    previousTime: 0,
    duration: Number.POSITIVE_INFINITY,
    speed: 1,
    state: PLAYING,
    done: false,
    propagateSetTime: false,
    traversal: 0,
    timeWrapMode: WRAP_LOOP,
    leadTime: 0,
    notified: null,
    started: false,
    destroyed: false,
  };
  g.nodes.push(n);
  return n;
}

// ───────── 呼叫產生類別的方法（PlayableBehaviour 的回呼、PlayableAsset 的虛擬成員） ─────────

/** 產生類別（沿基底鏈）實作這個成員的類別與函式：先看覆寫 DLL 成員的 overrides，再看 methods */
function implOf(cls: unknown, name: string): { cls: string; fn: (c: Ctx, ...a: any[]) => any } | null {
  if (typeof cls !== 'string') return null;
  for (let k: string | undefined = cls; k && hasGen(k); k = genClass(k).base) {
    const g = genClass(k);
    const o = g.overrides[name];
    const methods = g.methods as Record<string, ((c: Ctx, ...a: any[]) => any) | undefined>;
    const fn = typeof o === 'function' ? (o as (c: Ctx, ...a: any[]) => any) : methods[name];
    if (fn) return { cls: k, fn };
  }
  return null;
}
function callImpl(impl: { cls: string; fn: (c: Ctx, ...a: any[]) => any }, recv: object, ...args: any[]): any {
  return callAs({ ...staticCtx, w: getActiveWorld() }, impl.cls, implName(impl), recv, ...args);
}
/** callAs 照名字找方法：overrides 裡的函式要找回它在 methods 裡的名字 */
const implNames = new WeakMap<(...a: any[]) => any, string>();
function implName(impl: { cls: string; fn: (c: Ctx, ...a: any[]) => any }): string {
  const hit = implNames.get(impl.fn);
  if (hit) return hit;
  const m = genClass(impl.cls).methods;
  for (const k of Object.keys(m))
    if (m[k] === impl.fn) {
      implNames.set(impl.fn, k);
      return k;
    }
  throw new Error(`${impl.cls} 的方法沒有在 methods 裡`);
}
const inVirtual = new WeakMap<object, Set<string>>();
/**
 * DLL 基底的虛擬成員（PlayableAsset.duration、CreatePlayable、PlayableBehaviour.Clone）：產生類別有覆寫就叫覆寫，沒有就是 DLL 的預設。
 * 同一個物件在覆寫裡又叫回同一個成員，是 C# 的 base.X（產生碼分不出來），改叫預設實作
 */
export function dllVirtual<T>(recv: unknown, name: string, base: () => T, ...args: any[]): T {
  if (!recv || typeof recv !== 'object') return base();
  const impl = implOf((recv as { $type?: unknown }).$type, name);
  if (!impl) return base();
  let s = inVirtual.get(recv);
  if (!s) inVirtual.set(recv, (s = new Set()));
  if (s.has(name)) return base();
  s.add(name);
  try {
    return callImpl(impl, recv, ...args) as T;
  } finally {
    s.delete(name);
  }
}
/** PlayableBehaviour 的回呼：沒覆寫就不做事（PlayableBehaviour 的預設）；丟例外照 Unity 記下來，graph 照跑 */
function behaviourCall(n: PNode, name: string, ...args: any[]): void {
  const b = n.behaviour;
  if (!b) return;
  const impl = implOf(b.$type, name);
  if (!impl) return;
  const w = getActiveWorld();
  const run = (): void => void callImpl(impl, b, ...args);
  if (w) w.guard(`${String(b.$type)}.${name}`, run);
  else run();
}

// ───────── FrameData ─────────

interface FrameOpts {
  dt: number;
  evaluate: boolean;
  loop?: boolean;
  hold?: boolean;
  seek?: boolean;
}
function frameData(g: GraphState, f: FrameOpts, weight: number, effWeight: number, parentSpeed: number, speed: number, playing: boolean, out: OutState | null): Record<string, unknown> {
  return {
    $type: 'FrameData',
    frameId: g.frameId,
    m_FrameID: g.frameId,
    deltaTime: Math.fround(f.dt),
    m_DeltaTime: f.dt,
    weight: Math.fround(weight),
    m_Weight: Math.fround(weight),
    effectiveWeight: Math.fround(effWeight),
    effectiveParentSpeed: Math.fround(parentSpeed),
    effectiveSpeed: Math.fround(speed),
    m_EffectiveSpeed: Math.fround(speed),
    // EvaluationType：Evaluate 0、Playback 1
    evaluationType: f.evaluate ? 0 : 1,
    seekOccurred: !!f.seek,
    timeLooped: !!f.loop,
    timeHeld: !!f.hold,
    effectivePlayState: playing ? PLAYING : PAUSED,
    output: outHandle(out, out?.type),
  };
}

// ───────── graph 求值 ─────────

function setTime(n: PNode, t: number): void {
  n.previousTime = n.time;
  n.time = t;
  n.done = false;
  if (n.propagateSetTime) for (const i of n.inputs) if (i && !i.destroyed) setTime(i, t);
}
/** graph 求值一次：時間往前推 → PrepareFrame → ProcessFrame */
function evaluateGraph(g: GraphState, f: FrameOpts, skipAdvance: Set<PNode> = new Set()): void {
  g.frameId++;
  if (f.dt > 0)
    for (const n of g.nodes)
      if (!n.destroyed && n.state === PLAYING && !skipAdvance.has(n)) {
        n.previousTime = n.time;
        n.time += f.dt * n.speed;
        if (n.time >= n.duration) n.done = true;
      }
  const prepared = new Set<PNode>();
  const prepare = (n: PNode | null, port: number, weight: number, effWeight: number, parentSpeed: number, out: OutState): void => {
    if (!n || n.destroyed || prepared.has(n)) return;
    prepared.add(n);
    const speed = parentSpeed * n.speed;
    const playing = n.state === PLAYING;
    const fd = frameData(g, f, weight, effWeight, parentSpeed, speed, playing, out);
    const p = handle(n, n.behaviour ? 'ScriptPlayable' : n.type);
    if (!n.started) {
      n.started = true;
      behaviourCall(n, 'OnGraphStart', p);
    }
    if (!playing) {
      if (n.notified === PLAYING) behaviourCall(n, 'OnBehaviourPause', p, fd);
      n.notified = PAUSED;
      return;
    }
    if (n.notified !== PLAYING) behaviourCall(n, 'OnBehaviourPlay', p, fd);
    n.notified = PLAYING;
    behaviourCall(n, 'PrepareFrame', p, fd);
    const idx = n.traversal === PASSTHROUGH ? [port] : n.inputs.map((_, i) => i);
    for (const i of idx) prepare(n.inputs[i] ?? null, 0, n.weights[i] ?? 0, effWeight * (n.weights[i] ?? 0), speed, out);
  };
  for (const o of g.outputs) prepare(o.source, o.port, o.weight, o.weight, 1, o);
  for (const o of g.outputs) {
    const seen = new Set<PNode>();
    const process = (n: PNode | null, port: number, weight: number, effWeight: number, parentSpeed: number): void => {
      if (!n || n.destroyed || seen.has(n) || n.state !== PLAYING) return;
      seen.add(n);
      const speed = parentSpeed * n.speed;
      behaviourCall(n, 'ProcessFrame', handle(n, n.behaviour ? 'ScriptPlayable' : n.type), frameData(g, f, weight, effWeight, parentSpeed, speed, true, o), o.userData ?? null);
      const idx = n.traversal === PASSTHROUGH ? [port] : n.inputs.map((_, i) => i);
      for (const i of idx) process(n.inputs[i] ?? null, 0, n.weights[i] ?? 0, effWeight * (n.weights[i] ?? 0), speed);
    };
    process(o.source, o.port, o.weight, o.weight, 1);
  }
}
function destroyNode(n: PNode): void {
  if (n.destroyed) return;
  const p = handle(n, n.behaviour ? 'ScriptPlayable' : n.type);
  if (n.notified === PLAYING) behaviourCall(n, 'OnBehaviourPause', p, frameData(n.graph, { dt: 0, evaluate: false }, 1, 1, 1, n.speed, false, null));
  if (n.started) behaviourCall(n, 'OnGraphStop', p);
  behaviourCall(n, 'OnPlayableDestroy', p);
  n.destroyed = true;
  for (const m of n.graph.nodes) {
    m.inputs = m.inputs.map((x) => (x === n ? null : x));
    m.outputs = m.outputs.map((x) => (x === n ? null : x));
  }
}
function destroyGraph(g: GraphState): void {
  if (g.destroyed) return;
  for (const n of [...g.nodes]) destroyNode(n);
  g.destroyed = true;
  g.playing = false;
}

// ───────── 型別與預設值 ─────────

for (const t of ['Playable', 'ScriptPlayable']) {
  registerExternalCtor(t, () => handle(null, t));
  registerValueType(t, { equals: (a, b) => nodeOf(a) === nodeOf(b), hash: (a) => nodeOf(a)?.id ?? 0 });
}
registerExternalCtor('PlayableGraph', () => graphHandle(null));
registerValueType('PlayableGraph', { equals: (a, b) => graphOf(a) === graphOf(b), hash: (a) => graphOf(a)?.id ?? 0 });
for (const t of ['PlayableOutput', 'ScriptPlayableOutput']) {
  registerExternalCtor(t, () => outHandle(null, t));
  registerValueType(t, { equals: (a, b) => outOf(a) === outOf(b), hash: (a) => outOf(a)?.id ?? 0 });
}
registerExternalCtor('FrameData', () => frameData(newGraph(''), { dt: 0, evaluate: false }, 0, 0, 0, 0, false, null));
// 靜態屬性：Playable.Null、PlayableBinding.None（空陣列）、PlayableBinding.DefaultDuration（正無限大）
nativeSet(staticCtx, null, 'Playable', 'Null', handle(null));
nativeSet(staticCtx, null, 'ScriptPlayable', 'Null', handle(null, 'ScriptPlayable'));
nativeSet(staticCtx, null, 'PlayableOutput', 'Null', outHandle(null));
nativeSet(staticCtx, null, 'ScriptPlayableOutput', 'Null', outHandle(null, 'ScriptPlayableOutput'));
nativeSet(staticCtx, null, 'PlayableBinding', 'None', []);
nativeSet(staticCtx, null, 'PlayableBinding', 'DefaultDuration', Number.POSITIVE_INFINITY);

// ───────── PlayableAsset、PlayableBehaviour（DLL 基底的虛擬成員） ─────────

/** PlayableAsset.duration：產生類別有覆寫就照它，沒有是 PlayableBinding.DefaultDuration */
const assetDuration = (a: unknown): number => dllVirtual(a, 'get_duration', () => Number.POSITIVE_INFINITY);
registerNativeDataProp('PlayableAsset', 'duration', { get: (_c, o) => assetDuration(o) });
registerNativeDataProp('PlayableAsset', 'outputs', { get: (_c, o) => dllVirtual(o, 'get_outputs', () => []) });
export const IPlayableAsset_get_duration = (_c: Ctx, a: unknown): number => assetDuration(a);
export const IPlayableAsset_get_outputs = (_c: Ctx, a: unknown): unknown => dllVirtual(a, 'get_outputs', () => []);
export function PlayableAsset_CreatePlayable(_c: Ctx, a: unknown, graph: unknown, owner: unknown): PHandle {
  return dllVirtual(a, 'CreatePlayable', () => {
    throw new Error(`${String((a as { $type?: unknown })?.$type)}.CreatePlayable：沒有實作（C# 是 abstract）`);
  }, graph, owner);
}
export const IPlayableAsset_CreatePlayable = PlayableAsset_CreatePlayable;
/** PlayableBehaviour.Clone：MemberwiseClone（淺複製）；產生類別有覆寫就照它 */
export function PlayableBehaviour_Clone(_c: Ctx, b: unknown): unknown {
  return dllVirtual(b, 'Clone', () => (b && typeof b === 'object' ? { ...(b as object) } : b));
}
// 子類別覆寫裡的 base.X()（MT2 的 TransformTweenMixerBehaviour.OnBehaviourPlay）：UnityCsReference 的 PlayableBehaviour.cs 這些虛擬方法都是空的 {}，
// Clone 是 MemberwiseClone（直接淺複製，不再走 dllVirtual，免得回頭叫到覆寫自己）
for (const m of ['OnGraphStart', 'OnGraphStop', 'OnPlayableCreate', 'OnPlayableDestroy', 'OnBehaviourDelay', 'OnBehaviourPlay', 'OnBehaviourPause', 'PrepareData', 'PrepareFrame', 'ProcessFrame'])
  registerNativeBase(`PlayableBehaviour.${m}`, () => undefined);
registerNativeBase('PlayableBehaviour.Clone', (_c, b) => (b && typeof b === 'object' ? { ...(b as object) } : b));

// ───────── PlayableGraph ─────────

export function PlayableGraph_Create$(c: Ctx): GHandle {
  return PlayableGraph_Create$string(c, '');
}
export function PlayableGraph_Create$string(_c: Ctx, name: string): GHandle {
  return graphHandle(newGraph(name ?? ''));
}
export const PlayableGraph_IsValid = (_c: Ctx, g: unknown): boolean => !!graphOf(g);
export const PlayableGraph_IsPlaying = (_c: Ctx, g: unknown): boolean => !!graphOf(g)?.playing;
export const PlayableGraph_IsDone = (_c: Ctx, g: unknown): boolean => {
  const s = graphOf(g);
  return !s || s.outputs.every((o) => !o.source || o.source.done);
};
export const PlayableGraph_GetResolver = (_c: Ctx, g: unknown): unknown => graphOf(g)?.resolver ?? null;
export function PlayableGraph_SetResolver(_c: Ctx, g: unknown, r: unknown): void {
  needGraph(g, 'PlayableGraph.SetResolver').resolver = r;
}
export const PlayableGraph_GetPlayableCount = (_c: Ctx, g: unknown): number => graphOf(g)?.nodes.filter((n) => !n.destroyed).length ?? 0;
/** 根節點：output port 沒有接到任何 playable 的 */
function roots(g: GraphState): PNode[] {
  return g.nodes.filter((n) => !n.destroyed && n.outputs.every((o) => !o));
}
export const PlayableGraph_GetRootPlayableCount = (_c: Ctx, g: unknown): number => {
  const s = graphOf(g);
  return s ? roots(s).length : 0;
};
export const PlayableGraph_GetRootPlayable = (_c: Ctx, g: unknown, i: number): PHandle => {
  const n = roots(needGraph(g, 'PlayableGraph.GetRootPlayable'))[i] ?? null;
  return handle(n, n?.behaviour ? 'ScriptPlayable' : (n?.type ?? 'Playable'));
};
export const PlayableGraph_GetOutputCount = (_c: Ctx, g: unknown): number => graphOf(g)?.outputs.length ?? 0;
export const PlayableGraph_GetOutput = (_c: Ctx, g: unknown, i: number): OHandle => {
  const o = needGraph(g, 'PlayableGraph.GetOutput').outputs[i] ?? null;
  return outHandle(o, o?.type);
};
export function PlayableGraph_Connect(_c: Ctx, g: unknown, source: unknown, sourcePort: number, dest: unknown, destPort: number): boolean {
  const s = needGraph(g, 'PlayableGraph.Connect');
  const a = nodeOf(source);
  const b = nodeOf(dest);
  if (!a || !b || a.graph !== s || b.graph !== s) return false;
  while (a.outputs.length <= sourcePort) a.outputs.push(null);
  if (destPort >= b.inputs.length) return false;
  a.outputs[sourcePort] = b;
  b.inputs[destPort] = a;
  return true;
}
export function PlayableGraph_Disconnect(_c: Ctx, g: unknown, p: unknown, port: number): void {
  void g;
  const n = needNode(p, 'PlayableGraph.Disconnect');
  const i = n.inputs[port];
  if (i) i.outputs = i.outputs.map((x) => (x === n ? null : x));
  n.inputs[port] = null;
}
export function PlayableGraph_DestroyPlayable(_c: Ctx, g: unknown, p: unknown): void {
  void g;
  const n = nodeOf(p);
  if (n) destroyNode(n);
}
export const PlayableGraph_DestroySubgraph = PlayableGraph_DestroyPlayable;
export function PlayableGraph_Destroy(_c: Ctx, g: unknown): void {
  const s = graphOf(g);
  if (s) destroyGraph(s);
}
export function PlayableGraph_Play(_c: Ctx, g: unknown): void {
  needGraph(g, 'PlayableGraph.Play').playing = true;
  manualGraphs.add(graphOf(g)!);
}
export function PlayableGraph_Stop(_c: Ctx, g: unknown): void {
  const s = graphOf(g);
  if (!s) return;
  s.playing = false;
  manualGraphs.delete(s);
}
export function PlayableGraph_Evaluate$(c: Ctx, g: unknown): void {
  PlayableGraph_Evaluate$float(c, g, 0);
}
export function PlayableGraph_Evaluate$float(_c: Ctx, g: unknown, dt: number): void {
  evaluateGraph(needGraph(g, 'PlayableGraph.Evaluate'), { dt, evaluate: true });
}
export const PlayableGraph_SynchronizeEvaluation = (_c: Ctx, g: unknown, playable: unknown): void => void [g, playable];
export const PlayableGraph_IsMatchFrameRateEnabled = (_c: Ctx, g: unknown): boolean => (void g, false);
export function PlayableGraph_SetTimeUpdateMode(_c: Ctx, g: unknown, m: number): void {
  needGraph(g, 'PlayableGraph.SetTimeUpdateMode').timeUpdateMode = m;
}
export const PlayableGraph_GetTimeUpdateMode = (_c: Ctx, g: unknown): number => needGraph(g, 'PlayableGraph.GetTimeUpdateMode').timeUpdateMode;
export const PlayableGraph_GetEditorName = (_c: Ctx, g: unknown): string => graphOf(g)?.name ?? '';
/** 自己 Play 的 graph（不是 PlayableDirector 的）：每格照 Time.deltaTime 求值 */
const manualGraphs = new Set<GraphState>();

// ───────── Playable、ScriptPlayable ─────────

export function Playable_Create(_c: Ctx, graph: unknown, inputCount = 0): PHandle {
  return handle(newNode(needGraph(graph, 'Playable.Create'), 'Playable', inputCount));
}
function createScript(c: Ctx, graph: unknown, template: unknown, inputCount: number, type: string): PHandle {
  const g = needGraph(graph, 'ScriptPlayable.Create');
  const n = newNode(g, 'ScriptPlayable', inputCount);
  let b: unknown;
  if (template != null) b = PlayableBehaviour_Clone(c, template);
  else {
    if (!hasGen(type)) throw new Error(`ScriptPlayable<${type}>.Create：${type} 沒有轉出`);
    b = newGen(c, type, genClass(type).ctor0 ?? null);
  }
  n.behaviour = b as Record<string, unknown>;
  const p = handle(n, 'ScriptPlayable');
  behaviourCall(n, 'OnPlayableCreate', p);
  return p;
}
export const ScriptPlayable_Create$PlayableGraph_int = (c: Ctx, graph: unknown, inputCount: number, type: string): PHandle => createScript(c, graph, null, inputCount, type);
export const ScriptPlayable_Create$PlayableGraph_T_int = (c: Ctx, graph: unknown, template: unknown, inputCount: number, type: string): PHandle =>
  createScript(c, graph, template, inputCount, type);
export const ScriptPlayable_GetBehaviour = (_c: Ctx, p: unknown): unknown => needNode(p, 'ScriptPlayable.GetBehaviour').behaviour;
export const ScriptPlayable_op_Implicit = (_c: Ctx, p: unknown): PHandle => handle(nodeOf(p));
export const ScriptPlayable_op_Explicit = (_c: Ctx, p: unknown): PHandle => handle(nodeOf(p), 'ScriptPlayable');
export const ScriptPlayable_Equals = (_c: Ctx, a: unknown, b: unknown): boolean => nodeOf(a) === nodeOf(b);
export const ScriptPlayable_GetHandle = (_c: Ctx, p: unknown): PHandle => handle(nodeOf(p));
export const Playable_GetHandle = ScriptPlayable_GetHandle;
export const Playable_Equals = ScriptPlayable_Equals;
/** IsPlayableOfType<T>()：型別名在最後 */
export const Playable_IsPlayableOfType = (_c: Ctx, p: unknown, type: string): boolean => {
  const n = nodeOf(p);
  if (!n) return false;
  return type === 'ScriptPlayable' || type.startsWith('ScriptPlayable<') ? !!n.behaviour : n.type === type;
};
/** GetPlayableType：C# 回 Type；這裡回型別名（ScriptPlayable<T> 是行為的類別） */
export const Playable_GetPlayableType = (_c: Ctx, p: unknown): string | null => {
  const n = nodeOf(p);
  if (!n) return null;
  return n.behaviour ? `ScriptPlayable<${String(n.behaviour.$type)}>` : n.type;
};

// ───────── PlayableExtensions（ScriptPlayable 與 Playable 共用） ─────────

export const PlayableExtensions_IsNull = (_c: Ctx, p: unknown): boolean => !(p as PHandle | null)?.n;
export const PlayableExtensions_IsValid = (_c: Ctx, p: unknown): boolean => !!nodeOf(p);
export function PlayableExtensions_Destroy(_c: Ctx, p: unknown): void {
  const n = nodeOf(p);
  if (n) destroyNode(n);
}
export const PlayableExtensions_GetGraph = (_c: Ctx, p: unknown): GHandle => graphHandle(needNode(p, 'GetGraph').graph);
export const PlayableExtensions_GetPlayState = (_c: Ctx, p: unknown): number => needNode(p, 'GetPlayState').state;
export function PlayableExtensions_SetPlayState(_c: Ctx, p: unknown, v: number): void {
  needNode(p, 'SetPlayState').state = v === PLAYING ? PLAYING : PAUSED;
}
export const PlayableExtensions_Play = (c: Ctx, p: unknown): void => PlayableExtensions_SetPlayState(c, p, PLAYING);
export const PlayableExtensions_Pause = (c: Ctx, p: unknown): void => PlayableExtensions_SetPlayState(c, p, PAUSED);
export function PlayableExtensions_SetSpeed(_c: Ctx, p: unknown, v: number): void {
  needNode(p, 'SetSpeed').speed = v;
}
export const PlayableExtensions_GetSpeed = (_c: Ctx, p: unknown): number => needNode(p, 'GetSpeed').speed;
export function PlayableExtensions_SetDuration(_c: Ctx, p: unknown, v: number): void {
  needNode(p, 'SetDuration').duration = v;
}
export const PlayableExtensions_GetDuration = (_c: Ctx, p: unknown): number => needNode(p, 'GetDuration').duration;
export function PlayableExtensions_SetTime(_c: Ctx, p: unknown, v: number): void {
  setTime(needNode(p, 'SetTime'), v);
}
export const PlayableExtensions_GetTime = (_c: Ctx, p: unknown): number => needNode(p, 'GetTime').time;
export const PlayableExtensions_GetPreviousTime = (_c: Ctx, p: unknown): number => needNode(p, 'GetPreviousTime').previousTime;
export function PlayableExtensions_SetDone(_c: Ctx, p: unknown, v: boolean): void {
  needNode(p, 'SetDone').done = !!v;
}
export const PlayableExtensions_IsDone = (_c: Ctx, p: unknown): boolean => needNode(p, 'IsDone').done;
export function PlayableExtensions_SetPropagateSetTime(_c: Ctx, p: unknown, v: boolean): void {
  needNode(p, 'SetPropagateSetTime').propagateSetTime = !!v;
}
export const PlayableExtensions_GetPropagateSetTime = (_c: Ctx, p: unknown): boolean => needNode(p, 'GetPropagateSetTime').propagateSetTime;
export const PlayableExtensions_CanChangeInputs = (_c: Ctx, p: unknown): boolean => !!nodeOf(p);
export const PlayableExtensions_CanSetWeights = PlayableExtensions_CanChangeInputs;
export const PlayableExtensions_CanDestroy = PlayableExtensions_CanChangeInputs;
export function PlayableExtensions_SetInputCount(_c: Ctx, p: unknown, count: number): void {
  const n = needNode(p, 'SetInputCount');
  while (n.inputs.length < count) {
    n.inputs.push(null);
    n.weights.push(0);
  }
  for (const i of n.inputs.splice(count)) if (i) i.outputs = i.outputs.map((x) => (x === n ? null : x));
  n.weights.length = count;
}
export const PlayableExtensions_GetInputCount = (_c: Ctx, p: unknown): number => needNode(p, 'GetInputCount').inputs.length;
export function PlayableExtensions_SetOutputCount(_c: Ctx, p: unknown, count: number): void {
  const n = needNode(p, 'SetOutputCount');
  while (n.outputs.length < count) n.outputs.push(null);
  n.outputs.length = count;
}
export const PlayableExtensions_GetOutputCount = (_c: Ctx, p: unknown): number => needNode(p, 'GetOutputCount').outputs.length;
export const PlayableExtensions_GetInput = (_c: Ctx, p: unknown, i: number): PHandle => {
  const x = needNode(p, 'GetInput').inputs[i] ?? null;
  return handle(x, x?.behaviour ? 'ScriptPlayable' : (x?.type ?? 'Playable'));
};
export const PlayableExtensions_GetOutput = (_c: Ctx, p: unknown, i: number): PHandle => {
  const x = needNode(p, 'GetOutput').outputs[i] ?? null;
  return handle(x, x?.behaviour ? 'ScriptPlayable' : (x?.type ?? 'Playable'));
};
export function PlayableExtensions_SetInputWeight$U_int_float(_c: Ctx, p: unknown, i: number, w: number): void {
  const n = needNode(p, 'SetInputWeight');
  if (i >= 0 && i < n.weights.length) n.weights[i] = Math.fround(w);
}
/** SetInputWeight(input, weight)：照輸入的 playable 找 port */
export function PlayableExtensions_SetInputWeight$U_V_float(c: Ctx, p: unknown, input: unknown, w: number): void {
  const n = needNode(p, 'SetInputWeight');
  const x = nodeOf(input);
  const i = x ? n.inputs.indexOf(x) : -1;
  if (i >= 0) PlayableExtensions_SetInputWeight$U_int_float(c, p, i, w);
}
export const PlayableExtensions_GetInputWeight = (_c: Ctx, p: unknown, i: number): number => needNode(p, 'GetInputWeight').weights[i] ?? 0;
export function PlayableExtensions_ConnectInput$U_int_V_int(c: Ctx, p: unknown, i: number, source: unknown, sourcePort: number): void {
  PlayableGraph_Connect(c, graphHandle(needNode(p, 'ConnectInput').graph), source, sourcePort, p, i);
}
export function PlayableExtensions_ConnectInput$U_int_V_int_float(c: Ctx, p: unknown, i: number, source: unknown, sourcePort: number, w: number): void {
  PlayableExtensions_ConnectInput$U_int_V_int(c, p, i, source, sourcePort);
  PlayableExtensions_SetInputWeight$U_int_float(c, p, i, w);
}
export function PlayableExtensions_DisconnectInput(c: Ctx, p: unknown, i: number): void {
  PlayableGraph_Disconnect(c, null, p, i);
}
export function PlayableExtensions_AddInput(c: Ctx, p: unknown, source: unknown, sourcePort: number, w = 0): number {
  const n = needNode(p, 'AddInput');
  const i = n.inputs.length;
  PlayableExtensions_SetInputCount(c, p, i + 1);
  PlayableExtensions_ConnectInput$U_int_V_int_float(c, p, i, source, sourcePort, w);
  return i;
}
export function PlayableExtensions_SetLeadTime(_c: Ctx, p: unknown, v: number): void {
  needNode(p, 'SetLeadTime').leadTime = v;
}
export const PlayableExtensions_GetLeadTime = (_c: Ctx, p: unknown): number => needNode(p, 'GetLeadTime').leadTime;
export function PlayableExtensions_SetTraversalMode(_c: Ctx, p: unknown, m: number): void {
  needNode(p, 'SetTraversalMode').traversal = m;
}
export const PlayableExtensions_GetTraversalMode = (_c: Ctx, p: unknown): number => needNode(p, 'GetTraversalMode').traversal;
export function PlayableExtensions_SetTimeWrapMode(_c: Ctx, p: unknown, m: number): void {
  needNode(p, 'SetTimeWrapMode').timeWrapMode = m;
}
export const PlayableExtensions_GetTimeWrapMode = (_c: Ctx, p: unknown): number => needNode(p, 'GetTimeWrapMode').timeWrapMode;
/** AnimationPlayableExtensions.SetAnimatedProperties：clip 的動畫曲線（Timeline 的 clip.curves）。MT2 的 track 都沒有（null） */
export function AnimationPlayableExtensions_SetAnimatedProperties(_c: Ctx, p: unknown, clip: unknown): void {
  void p;
  if (clip != null) getActiveWorld()?.notes.add('Playable.SetAnimatedProperties：clip 的動畫曲線還沒做');
}

// ───────── PlayableOutput、ScriptPlayableOutput、PlayableBinding ─────────

export function ScriptPlayableOutput_Create(_c: Ctx, graph: unknown, name: string): OHandle {
  const g = needGraph(graph, 'ScriptPlayableOutput.Create');
  const o: OutState = { id: seq++, graph: g, type: 'ScriptPlayableOutput', name: name ?? '', source: null, port: 0, weight: 1, reference: null, userData: null, receivers: [] };
  g.outputs.push(o);
  return outHandle(o, 'ScriptPlayableOutput');
}
export const ScriptPlayableOutput_op_Implicit = (_c: Ctx, o: unknown): OHandle => outHandle(outOf(o));
export const ScriptPlayableOutput_op_Explicit = (_c: Ctx, o: unknown): OHandle => outHandle(outOf(o), 'ScriptPlayableOutput');
/** IsPlayableOutputOfType<T>()：型別名在最後 */
export const PlayableOutput_IsPlayableOutputOfType = (_c: Ctx, o: unknown, type: string): boolean => outOf(o)?.type === type;
export const PlayableOutputExtensions_IsOutputNull = (_c: Ctx, o: unknown): boolean => !(o as OHandle | null)?.o;
export const PlayableOutputExtensions_IsOutputValid = (_c: Ctx, o: unknown): boolean => !!outOf(o);
export const PlayableOutputExtensions_GetReferenceObject = (_c: Ctx, o: unknown): unknown => needOut(o, 'GetReferenceObject').reference;
export function PlayableOutputExtensions_SetReferenceObject(_c: Ctx, o: unknown, v: unknown): void {
  needOut(o, 'SetReferenceObject').reference = v;
}
export const PlayableOutputExtensions_GetUserData = (_c: Ctx, o: unknown): unknown => needOut(o, 'GetUserData').userData;
export function PlayableOutputExtensions_SetUserData(_c: Ctx, o: unknown, v: unknown): void {
  needOut(o, 'SetUserData').userData = v;
}
export const PlayableOutputExtensions_GetSourcePlayable = (_c: Ctx, o: unknown): PHandle => {
  const n = needOut(o, 'GetSourcePlayable').source;
  return handle(n, n?.behaviour ? 'ScriptPlayable' : (n?.type ?? 'Playable'));
};
export function PlayableOutputExtensions_SetSourcePlayable$U_V(c: Ctx, o: unknown, p: unknown): void {
  PlayableOutputExtensions_SetSourcePlayable$U_V_int(c, o, p, 0);
}
export function PlayableOutputExtensions_SetSourcePlayable$U_V_int(_c: Ctx, o: unknown, p: unknown, port: number): void {
  const s = needOut(o, 'SetSourcePlayable');
  s.source = nodeOf(p);
  s.port = port;
}
export const PlayableOutputExtensions_GetSourceOutputPort = (_c: Ctx, o: unknown): number => needOut(o, 'GetSourceOutputPort').port;
export const PlayableOutputExtensions_GetWeight = (_c: Ctx, o: unknown): number => needOut(o, 'GetWeight').weight;
export function PlayableOutputExtensions_SetWeight(_c: Ctx, o: unknown, v: number): void {
  needOut(o, 'SetWeight').weight = Math.fround(v);
}
export function PlayableOutputExtensions_AddNotificationReceiver(_c: Ctx, o: unknown, r: unknown): void {
  needOut(o, 'AddNotificationReceiver').receivers.push(r);
}
export function PlayableOutputExtensions_RemoveNotificationReceiver(_c: Ctx, o: unknown, r: unknown): void {
  const s = needOut(o, 'RemoveNotificationReceiver');
  s.receivers = s.receivers.filter((x) => x !== r);
}
export const PlayableOutputExtensions_GetNotificationReceivers = (_c: Ctx, o: unknown): unknown[] => [...needOut(o, 'GetNotificationReceivers').receivers];
/** PushNotification：交給 output 的接收者（INotificationReceiver.OnNotify(origin, notification, context)） */
export function PlayableOutputExtensions_PushNotification(_c: Ctx, o: unknown, origin: unknown, notification: unknown, context: unknown = null): void {
  for (const r of needOut(o, 'PushNotification').receivers) {
    const impl = implOf((r as { $type?: unknown } | null)?.$type, 'OnNotify') ?? implOf((r as { $type?: unknown } | null)?.$type, 'INotificationReceiver$OnNotify');
    if (impl && r) callImpl(impl, r as object, origin, notification, context);
    else getActiveWorld()?.notes.add('PlayableOutput.PushNotification：接收者沒有轉出的 OnNotify');
  }
}

/** PlayableBinding：資料物件（streamName、sourceObject、outputTargetType 是欄位，nativeGet 直接讀） */
interface Binding {
  $type: 'PlayableBinding';
  streamName: string;
  sourceObject: unknown;
  outputTargetType: unknown;
  create: ((graph: unknown, name: string) => OHandle) | null;
}
export function ScriptPlayableBinding_Create(c: Ctx, name: string, key: unknown, type: unknown): Binding {
  return { $type: 'PlayableBinding', streamName: name, sourceObject: key, outputTargetType: type ?? null, create: (g, n) => ScriptPlayableOutput_Create(c, g, n) };
}
export function PlayableBinding_CreateOutput(_c: Ctx, b: Binding, graph: unknown): OHandle {
  return b?.create ? b.create(graph, b.streamName) : outHandle(null);
}

// ───────── ExposedReference、PropertyName ─────────

/** ExposedReference<T>.Resolve(resolver)：resolver 有這個 id 就用它的值，沒有用 defaultValue */
export function ExposedReference_Resolve(c: Ctx, ref: { exposedName?: unknown; defaultValue?: unknown } | null, resolver: unknown): unknown {
  if (resolver != null) {
    let valid = false;
    const v = getReferenceValue(c, resolver, ref?.exposedName, (x) => (valid = x));
    if (valid) return v ?? null;
  }
  return ref?.defaultValue ?? null;
}
/** PropertyName：build 裡存成 id（int）；從字串建的用字串本身當 id */
registerExternalCtor('PropertyName', (v?: unknown) => (v === undefined ? 0 : v) as unknown as object);
function propertyId(v: unknown): string {
  if (v && typeof v === 'object' && 'id' in (v as object)) return String((v as { id: unknown }).id);
  return String(v ?? 0);
}

// ───────── PlayableDirector ─────────

interface DirectorState {
  h: H;
  comp: ComponentData;
  graph: GraphState | null;
  root: PNode | null;
  time: number;
  playing: boolean;
  /** 遊戲改過的設定（沒改過照存檔） */
  asset?: unknown;
  wrap?: number;
  updateMode?: number;
  initialTime?: number;
  bindings: Map<unknown, unknown>;
  refs: Map<string, unknown>;
}
const directors = new WeakMap<ComponentData, DirectorState>();
const playingDirectors = new Set<DirectorState>();

function dirOf(h: H): DirectorState {
  const comp = h.comp!;
  let s = directors.get(comp);
  if (!s) {
    s = { h, comp, graph: null, root: null, time: Number(comp.m_InitialTime ?? 0), playing: false, bindings: new Map(), refs: new Map() };
    directors.set(comp, s);
  }
  return s;
}
function worldOf(c: Ctx): World {
  const w = c.w ?? getActiveWorld();
  if (!w) throw new Error('PlayableDirector：沒有作用中的 World');
  return w;
}
function assetOf(c: Ctx, s: DirectorState): unknown {
  if (s.asset !== undefined) return s.asset;
  return resolveValue(worldOf(c), s.comp.m_PlayableAsset ?? null);
}
const wrapOf = (s: DirectorState): number => s.wrap ?? Number(s.comp.m_WrapMode ?? 0);
const updateModeOf = (s: DirectorState): number => s.updateMode ?? Number(s.comp.m_DirectorUpdateMode ?? 1);
const initialTimeOf = (s: DirectorState): number => s.initialTime ?? Number(s.comp.m_InitialTime ?? 0);
function durationOf(c: Ctx, s: DirectorState): number {
  const a = assetOf(c, s);
  return a ? assetDuration(a) : 0;
}
/** 綁定：SetGenericBinding 設過的，再來是場景存檔的 m_SceneBindings（key 是 timeline 資產裡的 track：{guid, fileID}） */
function bindingOf(c: Ctx, s: DirectorState, key: unknown): unknown {
  if (s.bindings.has(key)) return s.bindings.get(key);
  const k = key as { $asset?: unknown; $fileID?: unknown } | null;
  if (!k?.$asset) return null;
  const fileID = k.$fileID ?? '11400000';
  for (const b of (s.comp.m_SceneBindings as { key?: { guid?: string; fileID?: unknown } | null; value?: unknown }[] | undefined) ?? []) {
    if (b?.key?.guid === k.$asset && String(b.key.fileID) === String(fileID)) return resolveValue(worldOf(c), b.value ?? null);
  }
  return null;
}
/** IExposedPropertyTable.GetReferenceValue：SetReferenceValue 設過的，再來是 m_ExposedReferences；有這個 id 才算有效 */
function getReferenceValue(c: Ctx, resolver: unknown, id: unknown, setValid: (v: boolean) => void): unknown {
  if (!(resolver instanceof H) || resolver.comp?.type !== 'PlayableDirector') {
    const impl = implOf((resolver as { $type?: unknown } | null)?.$type, 'GetReferenceValue');
    if (!impl) {
      setValid(false);
      return null;
    }
    return callImpl(impl, resolver as object, id, setValid);
  }
  const s = dirOf(resolver);
  const key = propertyId(id);
  if (s.refs.has(key)) {
    setValid(true);
    return s.refs.get(key);
  }
  const list = (s.comp.m_ExposedReferences as { m_References?: Record<string, unknown>[] } | undefined)?.m_References ?? [];
  for (const entry of list) {
    if (entry && key in entry) {
      setValid(true);
      return resolveValue(worldOf(c), entry[key] ?? null);
    }
  }
  setValid(false);
  return null;
}
function fire(event: string, h: H): void {
  const w = getActiveWorld();
  for (const f of eventGet(staticCtx, event, h) ?? []) {
    const call = (): void => void invokeDelegate(staticCtx, f, h);
    if (w) w.guard(event, call);
    else call();
  }
}
/** 建 graph：PlayableAsset.CreatePlayable(graph, 導演的 GameObject)，output 照綁定接上目標 */
function rebuild(c: Ctx, s: DirectorState): void {
  if (s.graph) destroyGraph(s.graph);
  s.graph = null;
  s.root = null;
  const asset = assetOf(c, s);
  if (!asset) return;
  const g = newGraph(String((s.h.node.go as { m_Name?: unknown }).m_Name ?? ''));
  g.resolver = s.h;
  g.timeUpdateMode = updateModeOf(s);
  s.graph = g;
  const root = nodeOf(PlayableAsset_CreatePlayable(c, asset, graphHandle(g), gameObjectOf(s.h.node)));
  s.root = root;
  for (const o of g.outputs) {
    const target = bindingOf(c, s, o.reference);
    if (o.type === 'ScriptPlayableOutput') o.userData = target;
  }
  if (root) setTime(root, s.time);
}
function evaluateDirector(s: DirectorState, f: FrameOpts): void {
  if (!s.graph || !s.root) return;
  setTime(s.root, s.time);
  evaluateGraph(s.graph, f, new Set([s.root]));
}
function stop(s: DirectorState): void {
  const was = s.playing;
  if (s.graph) destroyGraph(s.graph);
  s.graph = null;
  s.root = null;
  s.playing = false;
  s.time = initialTimeOf(s);
  playingDirectors.delete(s);
  if (was) fire('PlayableDirector.stopped', s.h);
}

export function PlayableDirector_Play$(c: Ctx, h: H): void {
  const s = dirOf(h);
  if (!s.graph) rebuild(c, s);
  if (!s.graph) return;
  s.graph.playing = true;
  playingDirectors.add(s);
  if (!s.playing) {
    s.playing = true;
    fire('PlayableDirector.played', h);
  }
}
export const PlayableDirector_Play$FrameRate = (c: Ctx, h: H, rate: unknown): void => (void rate, PlayableDirector_Play$(c, h));
export function PlayableDirector_Play$PlayableAsset(c: Ctx, h: H, asset: unknown): void {
  if (asset == null) throw csException(['ArgumentNullException', 'ArgumentException', 'SystemException', 'Exception'], 'asset', null, 'PlayableDirector.Play');
  PlayableDirector_set_playableAsset(c, h, asset);
  PlayableDirector_Play$(c, h);
}
export function PlayableDirector_Play$PlayableAsset_DirectorWrapMode(c: Ctx, h: H, asset: unknown, mode: number): void {
  if (asset == null) throw csException(['ArgumentNullException', 'ArgumentException', 'SystemException', 'Exception'], 'asset', null, 'PlayableDirector.Play');
  PlayableDirector_set_playableAsset(c, h, asset);
  dirOf(h).wrap = mode;
  PlayableDirector_Play$(c, h);
}
export function PlayableDirector_Stop(_c: Ctx, h: H): void {
  stop(dirOf(h));
}
export function PlayableDirector_Pause(_c: Ctx, h: H): void {
  const s = dirOf(h);
  if (!s.playing) return;
  s.playing = false;
  if (s.graph) s.graph.playing = false;
  playingDirectors.delete(s);
  fire('PlayableDirector.paused', h);
}
export function PlayableDirector_Resume(c: Ctx, h: H): void {
  const s = dirOf(h);
  if (s.playing || !s.graph) return;
  PlayableDirector_Play$(c, h);
}
/** Evaluate：照目前的時間求值一次（graph 還沒建先建） */
export function PlayableDirector_Evaluate(c: Ctx, h: H): void {
  const s = dirOf(h);
  if (!s.graph) rebuild(c, s);
  evaluateDirector(s, { dt: 0, evaluate: true });
}
export const PlayableDirector_DeferredEvaluate = PlayableDirector_Evaluate;
export function PlayableDirector_RebuildGraph(c: Ctx, h: H): void {
  rebuild(c, dirOf(h));
}
export const PlayableDirector_GetGenericBinding = (c: Ctx, h: H, key: unknown): unknown => bindingOf(c, dirOf(h), key);
export function PlayableDirector_SetGenericBinding(_c: Ctx, h: H, key: unknown, v: unknown): void {
  dirOf(h).bindings.set(key, v);
}
export function PlayableDirector_ClearGenericBinding(_c: Ctx, h: H, key: unknown): void {
  dirOf(h).bindings.set(key, null);
}
export const PlayableDirector_GetReferenceValue = (c: Ctx, h: H, id: unknown, setValid: (v: boolean) => void): unknown => getReferenceValue(c, h, id, setValid);
export function PlayableDirector_SetReferenceValue(_c: Ctx, h: H, id: unknown, v: unknown): void {
  dirOf(h).refs.set(propertyId(id), v);
}
export function PlayableDirector_ClearReferenceValue(_c: Ctx, h: H, id: unknown): void {
  dirOf(h).refs.delete(propertyId(id));
}
export function PlayableDirector_set_playableAsset(_c: Ctx, h: H, asset: unknown): void {
  const s = dirOf(h);
  s.asset = asset;
  if (s.graph) destroyGraph(s.graph);
  s.graph = null;
  s.root = null;
}
registerNativeProp('PlayableDirector', 'playableAsset', { get: (c, h) => assetOf(c, dirOf(h as H)), set: (c, h, v) => PlayableDirector_set_playableAsset(c, h as H, v) });
registerNativeProp('PlayableDirector', 'time', {
  get: (_c, h) => dirOf(h as H).time,
  set: (_c, h, v) => {
    const s = dirOf(h as H);
    s.time = Number(v);
    if (s.root) setTime(s.root, s.time);
  },
});
registerNativeProp('PlayableDirector', 'initialTime', { get: (_c, h) => initialTimeOf(dirOf(h as H)), set: (_c, h, v) => void (dirOf(h as H).initialTime = Number(v)) });
registerNativeProp('PlayableDirector', 'duration', { get: (c, h) => durationOf(c, dirOf(h as H)) });
registerNativeProp('PlayableDirector', 'state', { get: (_c, h) => (dirOf(h as H).playing ? PLAYING : PAUSED) });
registerNativeProp('PlayableDirector', 'extrapolationMode', { get: (_c, h) => wrapOf(dirOf(h as H)), set: (_c, h, v) => void (dirOf(h as H).wrap = Number(v)) });
registerNativeProp('PlayableDirector', 'timeUpdateMode', { get: (_c, h) => updateModeOf(dirOf(h as H)), set: (_c, h, v) => void (dirOf(h as H).updateMode = Number(v)) });
registerNativeProp('PlayableDirector', 'playOnAwake', { get: (_c, h) => Number((h as H).comp?.m_InitialState ?? 0) === PLAYING });
registerNativeProp('PlayableDirector', 'playableGraph', { get: (_c, h) => graphHandle(dirOf(h as H).graph) });

/**
 * DirectorUpdateMode 的時間：GameTime 是乘過 timeScale 的 deltaTime；UnscaledGameTime 不乘；DSPClock 跟著音訊時鐘，
 * 這裡當成不乘 timeScale 的實際時間（音訊時鐘不受 timeScale 影響是推定，未查證）
 */
function modeDelta(w: World, mode: number, scaledDt: number): number {
  return mode === 1 ? scaledDt : w.unscaledDeltaTime;
}
/** 每格（Update.DirectorUpdate）：播放中的 PlayableDirector 往前推、照 WrapMode 處理終點；自己 Play 的 graph 照 Time.deltaTime 求值 */
function directorUpdate(w: World, dt: number): void {
  const c: Ctx = { ...staticCtx, w };
  for (const s of [...playingDirectors]) {
    if (!s.playing || !s.graph) {
      playingDirectors.delete(s);
      continue;
    }
    // 停用的導演（GameObject 沒啟用、元件 enabled 關）不推進
    if (!s.h.node.activeInHierarchy || s.comp.m_Enabled === 0) continue;
    if (updateModeOf(s) === UPDATE_MANUAL) continue;
    const duration = durationOf(c, s);
    const ddt = modeDelta(w, updateModeOf(s), dt);
    let t = s.time + ddt;
    const f: FrameOpts = { dt: ddt, evaluate: false };
    if (t >= duration) {
      const wrap = wrapOf(s);
      if (wrap === WRAP_LOOP && duration > 0) {
        t %= duration;
        f.loop = true;
      } else if (wrap === WRAP_HOLD) {
        t = duration;
        f.hold = true;
      } else {
        // None：最後一格在 duration 求值，再停
        s.time = duration;
        evaluateDirector(s, f);
        stop(s);
        continue;
      }
    }
    s.time = t;
    evaluateDirector(s, f);
  }
  for (const g of [...manualGraphs]) {
    if (g.destroyed || !g.playing) manualGraphs.delete(g);
    else if (g.timeUpdateMode !== UPDATE_MANUAL) evaluateGraph(g, { dt: modeDelta(w, g.timeUpdateMode, dt), evaluate: false });
  }
}
registerDirectorUpdate(directorUpdate);

/** 測試用：導演的狀態（graph 有沒有建、時間、播放中） */
export function directorDebug(h: H): { time: number; playing: boolean; nodes: number; outputs: number } {
  const s = dirOf(h);
  return { time: s.time, playing: s.playing, nodes: s.graph?.nodes.filter((n) => !n.destroyed).length ?? 0, outputs: s.graph?.outputs.length ?? 0 };
}

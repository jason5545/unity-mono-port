// 相容層：ParticleSystem 的模組（MainModule）與 MinMaxCurve。unity.ts 會 export * 這裡。
//
// 依據：
//   - ParticleSystem 的模組是包住粒子系統的 struct，屬性直接讀寫粒子系統本身：腳本常寫
//     `var main = ps.main; main.simulationSpeed = x;`，改「複本」就是改粒子系統（Unity 手冊 Particle System modules 的說明）。
//     這裡的模組物件只帶 $ps（元件的 H），cloneData 不複製它（$type 不是產生的 struct），屬性的讀寫都落在元件資料上。
//   - 序列化欄位與屬性的對應照 UnityCsReference 2022.3 Modules/ParticleSystemEditor/ParticleSystemModules/InitialModuleUI.cs：
//     duration ↔ lengthInSec、loop ↔ looping、simulationSpace ↔ moveWithTransform（Local 0、World 1、Custom 2）、
//     maxParticles ↔ InitialModule.maxNumParticles，其他同名（prewarm、playOnAwake、simulationSpeed、useUnscaledTime、scalingMode、
//     emitterVelocityMode、stopAction、cullingMode、ringBufferMode）；startLifetime 這類 MinMaxCurve 在 InitialModule 底下。
//   - MinMaxCurve（Modules/ParticleSystem/Managed/ParticleSystemStructs.cs）：mode、curveMultiplier、curveMin、curveMax、constantMin、constantMax；
//     constant ＝ constantMax、curve ＝ curveMax。序列化的形式（Modules/ParticleSystemEditor/SerializedMinMaxCurve.cs）是
//     minMaxState（跟 ParticleSystemCurveMode 同編號）、scalar（maxConstant，曲線模式下是倍率）、minScalar（minConstant）、maxCurve、minCurve。
//
// 與原版的差異（未查證）：原生把序列化的 MinMaxCurve 轉成託管 struct 時，常數模式的 curveMin／curveMax 是不是 null、
// 曲線模式的 constantMax 是不是 0，查不到；這裡照 MinMaxCurve 的建構子（常數模式沒有曲線、曲線模式常數是 0）。
// 其他模組（emission、trails、textureSheetAnimation、subEmitters…）做了 enabled 與 MT2 用到的屬性，其餘屬性還沒做。
// 播放與粒子（10/17）：Play／Stop／Pause／Clear／Simulate／Emit、isPlaying 這些照 particles/manager.ts 的模擬；
// GetParticles／SetParticles 照粒子的陣列；ParticleSystemRenderer.BakeMesh／BakeTrailsMesh 照 particles/particleMesh.ts 產網格（UIParticle 用）。

import { Quaternion, Vector3 } from 'three';
import type { World } from '../engine/world';
import { meshAssetOf, type MeshInstance } from '../unity/meshes';
import type { ComponentData } from '../unity/types';
import { buildParticles, buildTrails, currentSize, particleColor, type ParticleCamera, type ParticleGeometry } from '../particles/particleMesh';
import type { ParticleSim } from '../particles/system';
import { registerWillRenderCanvases } from '../engine/world';
import { existingCanvasRendererState, registerCanvasMeshSource } from '../ui/canvasRenderer';
import { compHandle, eventGet, genCallVirtual, getActiveWorld, H, invokeDelegate, registerExternalCtor, resolveValue, staticCtx, type Ctx } from './core';
import { registerNativeDataProp, registerNativeProp } from './unityNative';

type Curve = { m_Curve: unknown[]; m_PreInfinity?: number; m_PostInfinity?: number };
interface SerializedMinMaxCurve {
  minMaxState: number;
  scalar: number;
  minScalar: number;
  maxCurve?: Curve;
  minCurve?: Curve;
}
/** ParticleSystem.MinMaxCurve 的託管形狀（欄位名照屬性名，產生碼用 nativeGet 讀得到） */
export interface MinMaxCurveJs {
  $type: 'ParticleSystem_MinMaxCurve';
  mode: number;
  curveMultiplier: number;
  curveMin: Curve | null;
  curveMax: Curve | null;
  constantMin: number;
  constantMax: number;
}
interface MainModuleJs {
  $type: 'ParticleSystem_MainModule';
  $ps: H;
}

function psData(m: MainModuleJs): ComponentData {
  const comp = m.$ps?.comp;
  if (!comp) throw new Error('ParticleSystem.main：粒子系統是 null（C# 會 NullReferenceException）');
  return comp;
}
function initialModule(m: MainModuleJs): Record<string, unknown> {
  const d = psData(m);
  return ((d.InitialModule as Record<string, unknown> | undefined) ??= {});
}

/** 序列化的 MinMaxCurve → 託管的 struct（新的一份，C# 的 struct 是值） */
export function minMaxCurveFrom(s: SerializedMinMaxCurve | undefined): MinMaxCurveJs {
  const mode = s?.minMaxState ?? 0;
  const curveMode = mode === 1 || mode === 2;
  return {
    $type: 'ParticleSystem_MinMaxCurve',
    mode,
    curveMultiplier: curveMode ? (s?.scalar ?? 0) : 0,
    curveMax: curveMode ? (s?.maxCurve ?? null) : null,
    curveMin: mode === 2 ? (s?.minCurve ?? null) : null,
    constantMin: mode === 3 ? (s?.minScalar ?? 0) : 0,
    constantMax: curveMode ? 0 : (s?.scalar ?? 0),
  };
}
/** 託管的 struct → 序列化形式（寫回元件資料） */
export function minMaxCurveTo(v: MinMaxCurveJs | number): SerializedMinMaxCurve {
  // C# 的 float 隱含轉 MinMaxCurve（op_Implicit）：轉換器有時直接傳數字
  if (typeof v === 'number') return { minMaxState: 0, scalar: v, minScalar: 0 };
  const curveMode = v.mode === 1 || v.mode === 2;
  const empty: Curve = { m_Curve: [], m_PreInfinity: 2, m_PostInfinity: 2 };
  return {
    minMaxState: v.mode,
    scalar: curveMode ? v.curveMultiplier : v.constantMax,
    minScalar: v.constantMin,
    maxCurve: v.curveMax ?? empty,
    minCurve: v.curveMin ?? empty,
  };
}

/** ParticleSystem.main */
registerNativeProp('ParticleSystem', 'main', { get: (_c, h) => ({ $type: 'ParticleSystem_MainModule', $ps: h }) satisfies MainModuleJs });

/** 布林在序列化資料裡是 0／1 */
const asBool = (v: unknown): boolean => !!v;
const toBool = (v: unknown): number => (v ? 1 : 0);
const same = (v: unknown): unknown => v;

/** 元件資料最上層的欄位（屬性名 → 序列化欄位名） */
const TOP: [string, string, (v: unknown) => unknown, (v: unknown) => unknown][] = [
  ['duration', 'lengthInSec', same, same],
  ['loop', 'looping', asBool, toBool],
  ['prewarm', 'prewarm', asBool, toBool],
  ['playOnAwake', 'playOnAwake', asBool, toBool],
  ['simulationSpeed', 'simulationSpeed', same, same],
  ['useUnscaledTime', 'useUnscaledTime', asBool, toBool],
  ['scalingMode', 'scalingMode', same, same],
  ['simulationSpace', 'moveWithTransform', same, same],
  ['emitterVelocityMode', 'emitterVelocityMode', same, same],
  ['stopAction', 'stopAction', same, same],
  ['cullingMode', 'cullingMode', same, same],
  ['ringBufferMode', 'ringBufferMode', same, same],
];
for (const [prop, key, get, set] of TOP) {
  registerNativeDataProp('ParticleSystem_MainModule', prop, {
    get: (_c, o) => get(psData(o as MainModuleJs)[key]),
    set: (_c, o, v) => void (psData(o as MainModuleJs)[key] = set(v)),
  });
}
/** startDelay 在最上層，其他 MinMaxCurve 在 InitialModule 底下 */
registerNativeDataProp('ParticleSystem_MainModule', 'startDelay', {
  get: (_c, o) => minMaxCurveFrom(psData(o as MainModuleJs).startDelay as SerializedMinMaxCurve | undefined),
  set: (_c, o, v) => void (psData(o as MainModuleJs).startDelay = minMaxCurveTo(v as MinMaxCurveJs)),
});
for (const prop of ['startLifetime', 'startSpeed', 'startSize', 'startSizeY', 'startSizeZ', 'startRotation', 'startRotationX', 'startRotationY', 'gravityModifier']) {
  // startSizeX、startRotationZ 在序列化裡就是 startSize、startRotation（3D 的第一軸與 2D 共用）
  registerNativeDataProp('ParticleSystem_MainModule', prop, {
    get: (_c, o) => minMaxCurveFrom(initialModule(o as MainModuleJs)[prop] as SerializedMinMaxCurve | undefined),
    set: (_c, o, v) => void (initialModule(o as MainModuleJs)[prop] = minMaxCurveTo(v as MinMaxCurveJs)),
  });
}
for (const [prop, key] of [
  ['startSizeX', 'startSize'],
  ['startRotationZ', 'startRotation'],
] as const) {
  registerNativeDataProp('ParticleSystem_MainModule', prop, {
    get: (_c, o) => minMaxCurveFrom(initialModule(o as MainModuleJs)[key] as SerializedMinMaxCurve | undefined),
    set: (_c, o, v) => void (initialModule(o as MainModuleJs)[key] = minMaxCurveTo(v as MinMaxCurveJs)),
  });
}
registerNativeDataProp('ParticleSystem_MainModule', 'maxParticles', {
  get: (_c, o) => (initialModule(o as MainModuleJs).maxNumParticles as number | undefined) ?? 1000,
  set: (_c, o, v) => void (initialModule(o as MainModuleJs).maxNumParticles = v),
});
for (const [prop, key] of [
  ['startSize3D', 'size3D'],
  ['startRotation3D', 'rotation3D'],
] as const) {
  registerNativeDataProp('ParticleSystem_MainModule', prop, {
    get: (_c, o) => asBool(initialModule(o as MainModuleJs)[key]),
    set: (_c, o, v) => void (initialModule(o as MainModuleJs)[key] = toBool(v)),
  });
}

// ───────── 其他模組（ParticleSystem.emission、trails…）：同樣是包住粒子系統的 struct，讀寫落在序列化的「XModule」 ─────────
// 屬性名 → 型別名（ParticleSystem_<型別名>）→ 序列化的模組名（ParticleSystem 元件資料的欄位；編輯器 ParticleSystemModules/*UI.cs 用的同一批）
interface ModuleJs {
  $type: string;
  $ps: H;
  $key: string;
}
const MODULES: [string, string, string][] = [
  ['emission', 'EmissionModule', 'EmissionModule'],
  ['shape', 'ShapeModule', 'ShapeModule'],
  ['velocityOverLifetime', 'VelocityOverLifetimeModule', 'VelocityModule'],
  ['limitVelocityOverLifetime', 'LimitVelocityOverLifetimeModule', 'ClampVelocityModule'],
  ['inheritVelocity', 'InheritVelocityModule', 'InheritVelocityModule'],
  ['lifetimeByEmitterSpeed', 'LifetimeByEmitterSpeedModule', 'LifetimeByEmitterSpeedModule'],
  ['forceOverLifetime', 'ForceOverLifetimeModule', 'ForceModule'],
  ['colorOverLifetime', 'ColorOverLifetimeModule', 'ColorModule'],
  ['colorBySpeed', 'ColorBySpeedModule', 'ColorBySpeedModule'],
  ['sizeOverLifetime', 'SizeOverLifetimeModule', 'SizeModule'],
  ['sizeBySpeed', 'SizeBySpeedModule', 'SizeBySpeedModule'],
  ['rotationOverLifetime', 'RotationOverLifetimeModule', 'RotationModule'],
  ['rotationBySpeed', 'RotationBySpeedModule', 'RotationBySpeedModule'],
  ['externalForces', 'ExternalForcesModule', 'ExternalForcesModule'],
  ['noise', 'NoiseModule', 'NoiseModule'],
  ['collision', 'CollisionModule', 'CollisionModule'],
  ['trigger', 'TriggerModule', 'TriggerModule'],
  ['subEmitters', 'SubEmittersModule', 'SubModule'],
  ['textureSheetAnimation', 'TextureSheetAnimationModule', 'UVModule'],
  ['lights', 'LightsModule', 'LightsModule'],
  ['trails', 'TrailModule', 'TrailModule'],
  ['customData', 'CustomDataModule', 'CustomDataModule'],
];
function moduleData(m: ModuleJs): Record<string, unknown> {
  const d = m.$ps?.comp;
  if (!d) throw new Error(`ParticleSystem 的模組：粒子系統是 null（C# 會 NullReferenceException）`);
  return ((d[m.$key] as Record<string, unknown> | undefined) ??= {});
}
type Kind = 'same' | 'bool' | 'curve';
/** 模組的屬性：屬性名 → 序列化欄位名、種類（布林存 0／1、MinMaxCurve 換成託管形狀） */
function moduleProp(type: string, prop: string, key: string, kind: Kind): void {
  registerNativeDataProp(`ParticleSystem_${type}`, prop, {
    get: (_c, o) => {
      const v = moduleData(o as ModuleJs)[key];
      return kind === 'bool' ? asBool(v) : kind === 'curve' ? minMaxCurveFrom(v as SerializedMinMaxCurve | undefined) : v;
    },
    set: (_c, o, v) => void (moduleData(o as ModuleJs)[key] = kind === 'bool' ? toBool(v) : kind === 'curve' ? minMaxCurveTo(v as MinMaxCurveJs) : v),
  });
}
for (const [prop, type, key] of MODULES) {
  registerNativeProp('ParticleSystem', prop, { get: (_c, h) => ({ $type: `ParticleSystem_${type}`, $ps: h, $key: key }) satisfies ModuleJs });
  moduleProp(type, 'enabled', 'enabled', 'bool');
}
moduleProp('EmissionModule', 'rateOverTime', 'rateOverTime', 'curve');
moduleProp('EmissionModule', 'rateOverDistance', 'rateOverDistance', 'curve');
moduleProp('EmissionModule', 'burstCount', 'm_BurstCount', 'same');
// TextureSheetAnimation（序列化是 UVModule）：numTilesX ↔ tilesX、animation ↔ animationType、cycleCount ↔ cycles
for (const [prop, key, kind] of [
  ['mode', 'mode', 'same'],
  ['timeMode', 'timeMode', 'same'],
  ['fps', 'fps', 'same'],
  ['numTilesX', 'tilesX', 'same'],
  ['numTilesY', 'tilesY', 'same'],
  ['animation', 'animationType', 'same'],
  ['rowMode', 'rowMode', 'same'],
  ['rowIndex', 'rowIndex', 'same'],
  ['cycleCount', 'cycles', 'same'],
  ['uvChannelMask', 'uvChannelMask', 'same'],
  ['frameOverTime', 'frameOverTime', 'curve'],
  ['startFrame', 'startFrame', 'curve'],
] as [string, string, Kind][]) moduleProp('TextureSheetAnimationModule', prop, key, kind);
registerNativeDataProp('ParticleSystem_TextureSheetAnimationModule', 'spriteCount', {
  get: (_c, o) => ((moduleData(o as ModuleJs).sprites as unknown[] | undefined) ?? []).length,
});
for (const [prop, key, kind] of [
  ['mode', 'mode', 'same'],
  ['ratio', 'ratio', 'same'],
  ['lifetime', 'lifetime', 'curve'],
  ['minVertexDistance', 'minVertexDistance', 'same'],
  ['worldSpace', 'worldSpace', 'bool'],
  ['dieWithParticles', 'dieWithParticles', 'bool'],
  ['sizeAffectsWidth', 'sizeAffectsWidth', 'bool'],
  ['inheritParticleColor', 'inheritParticleColor', 'bool'],
  ['widthOverTrail', 'widthOverTrail', 'curve'],
] as [string, string, Kind][]) moduleProp('TrailModule', prop, key, kind);
// SubEmitters（序列化是 SubModule.subEmitters：[{ emitter, type, properties, emitProbability }]）
const subEmitterList = (o: unknown): { emitter?: unknown }[] => (moduleData(o as ModuleJs).subEmitters as { emitter?: unknown }[] | undefined) ?? [];
registerNativeDataProp('ParticleSystem_SubEmittersModule', 'subEmittersCount', { get: (_c, o) => subEmitterList(o).length });
/** SubEmittersModule.GetSubEmitterSystem(index)：那一個子發射器的 ParticleSystem（參照照元件資料的規則解成 handle） */
export function ParticleSystem_SubEmittersModule_GetSubEmitterSystem(c: Ctx, m: ModuleJs, index: number): unknown {
  const list = subEmitterList(m);
  if (index < 0 || index >= list.length) throw new Error(`SubEmittersModule.GetSubEmitterSystem：index ${index} 超出範圍（共 ${list.length} 個）`);
  const w = c.w ?? getActiveWorld();
  return w ? resolveValue(w, list[index]!.emitter ?? null) : null;
}

// MinMaxCurve 的別名屬性：constant ＝ constantMax、curve ＝ curveMax
registerNativeDataProp('ParticleSystem_MinMaxCurve', 'constant', {
  get: (_c, o) => (o as MinMaxCurveJs).constantMax,
  set: (_c, o, v) => void ((o as MinMaxCurveJs).constantMax = v as number),
});
registerNativeDataProp('ParticleSystem_MinMaxCurve', 'curve', {
  get: (_c, o) => (o as MinMaxCurveJs).curveMax,
  set: (_c, o, v) => void ((o as MinMaxCurveJs).curveMax = v as Curve),
});

/** new MinMaxCurve(constant)／(multiplier, curve)／(multiplier, min, max)／(min, max)（ParticleSystemStructs.cs 的建構子） */
export const new_ParticleSystem_MinMaxCurve$float = (_c: Ctx, constant: number): MinMaxCurveJs => ({
  $type: 'ParticleSystem_MinMaxCurve',
  mode: 0,
  curveMultiplier: 0,
  curveMin: null,
  curveMax: null,
  constantMin: 0,
  constantMax: constant,
});
export const new_ParticleSystem_MinMaxCurve$float_AnimationCurve = (_c: Ctx, multiplier: number, curve: Curve): MinMaxCurveJs => ({
  $type: 'ParticleSystem_MinMaxCurve',
  mode: 1,
  curveMultiplier: multiplier,
  curveMin: null,
  curveMax: curve,
  constantMin: 0,
  constantMax: 0,
});
export const new_ParticleSystem_MinMaxCurve$float_AnimationCurve_AnimationCurve = (_c: Ctx, multiplier: number, min: Curve, max: Curve): MinMaxCurveJs => ({
  $type: 'ParticleSystem_MinMaxCurve',
  mode: 2,
  curveMultiplier: multiplier,
  curveMin: min,
  curveMax: max,
  constantMin: 0,
  constantMax: 0,
});
export const new_ParticleSystem_MinMaxCurve$float_float = (_c: Ctx, min: number, max: number): MinMaxCurveJs => ({
  $type: 'ParticleSystem_MinMaxCurve',
  mode: 3,
  curveMultiplier: 0,
  curveMin: null,
  curveMax: null,
  constantMin: min,
  constantMax: max,
});
/** float 隱含轉 MinMaxCurve */
export const ParticleSystem_MinMaxCurve_op_Implicit = (c: Ctx, constant: number): MinMaxCurveJs => new_ParticleSystem_MinMaxCurve$float(c, constant);


// ───────── 播放（particles/manager.ts 的模擬） ─────────

function psOf(c: Ctx, h: H | null, what: string): { world: World; comp: ComponentData } {
  const world = c.w ?? getActiveWorld();
  if (!world) throw new Error(`${what}：沒有執行中的 World`);
  if (!h?.comp) throw new Error(`${what}：對象是 null（C# 這裡會 NullReferenceException）`);
  return { world, comp: h.comp };
}
const pw = (c: Ctx, h: H | null, what: string) => {
  const { world, comp } = psOf(c, h, what);
  return { pm: world.particles, comp };
};
export function ParticleSystem_Play$bool(c: Ctx, h: H, withChildren: boolean): void {
  const { pm, comp } = pw(c, h, 'ParticleSystem.Play');
  pm.play(comp, withChildren);
}
export const ParticleSystem_Play$ = (c: Ctx, h: H): void => ParticleSystem_Play$bool(c, h, true);
/** Stop(withChildren, stopBehavior)：StopEmittingAndClear 0、StopEmitting 1（預設） */
export function ParticleSystem_Stop$bool_ParticleSystemStopBehavior(c: Ctx, h: H, withChildren: boolean, behavior: number): void {
  const { pm, comp } = pw(c, h, 'ParticleSystem.Stop');
  pm.stop(comp, withChildren, behavior === 0);
}
export const ParticleSystem_Stop$bool = (c: Ctx, h: H, withChildren: boolean): void => ParticleSystem_Stop$bool_ParticleSystemStopBehavior(c, h, withChildren, 1);
export const ParticleSystem_Stop$ = (c: Ctx, h: H): void => ParticleSystem_Stop$bool_ParticleSystemStopBehavior(c, h, true, 1);
export function ParticleSystem_Pause$bool(c: Ctx, h: H, withChildren: boolean): void {
  const { pm, comp } = pw(c, h, 'ParticleSystem.Pause');
  pm.pause(comp, withChildren);
}
export const ParticleSystem_Pause$ = (c: Ctx, h: H): void => ParticleSystem_Pause$bool(c, h, true);
export function ParticleSystem_Clear$bool(c: Ctx, h: H, withChildren: boolean): void {
  const { pm, comp } = pw(c, h, 'ParticleSystem.Clear');
  pm.clear(comp, withChildren);
}
export const ParticleSystem_Clear$ = (c: Ctx, h: H): void => ParticleSystem_Clear$bool(c, h, true);
export function ParticleSystem_Simulate$float_bool_bool_bool(c: Ctx, h: H, t: number, withChildren: boolean, restart: boolean, fixedTimeStep: boolean): void {
  const { pm, comp } = pw(c, h, 'ParticleSystem.Simulate');
  pm.simulate(comp, t, withChildren, restart, fixedTimeStep);
}
export const ParticleSystem_Simulate$float_bool_bool = (c: Ctx, h: H, t: number, withChildren: boolean, restart: boolean): void =>
  ParticleSystem_Simulate$float_bool_bool_bool(c, h, t, withChildren, restart, true);
export const ParticleSystem_Simulate$float_bool = (c: Ctx, h: H, t: number, withChildren: boolean): void => ParticleSystem_Simulate$float_bool_bool_bool(c, h, t, withChildren, true, true);
export const ParticleSystem_Simulate$float = (c: Ctx, h: H, t: number): void => ParticleSystem_Simulate$float_bool_bool_bool(c, h, t, true, true, true);
/** Emit(count)：照 Shape 與起始設定立刻發（系統沒在播也可以） */
export function ParticleSystem_Emit$int(c: Ctx, h: H, count: number): void {
  const { pm, comp } = pw(c, h, 'ParticleSystem.Emit');
  const sim = pm.simOf(comp);
  if (!sim) return;
  pm.setPose(sim);
  sim.emit(count);
}
const simIfAny = (c: Ctx, h: H, what: string): ParticleSim | null => {
  const { pm, comp } = pw(c, h, what);
  return pm.existing(comp);
};
export const ParticleSystem_get_isPlaying = (c: Ctx, h: H): boolean => simIfAny(c, h, 'ParticleSystem.isPlaying')?.isPlaying ?? false;
export const ParticleSystem_get_isEmitting = (c: Ctx, h: H): boolean => simIfAny(c, h, 'ParticleSystem.isEmitting')?.isEmitting ?? false;
export const ParticleSystem_get_isPaused = (c: Ctx, h: H): boolean => simIfAny(c, h, 'ParticleSystem.isPaused')?.isPaused ?? false;
export const ParticleSystem_get_isStopped = (c: Ctx, h: H): boolean => simIfAny(c, h, 'ParticleSystem.isStopped')?.isStopped ?? true;
export const ParticleSystem_get_particleCount = (c: Ctx, h: H): number => simIfAny(c, h, 'ParticleSystem.particleCount')?.n ?? 0;
export function ParticleSystem_IsAlive$bool(c: Ctx, h: H, withChildren: boolean): boolean {
  const { pm, comp } = pw(c, h, 'ParticleSystem.IsAlive');
  return pm.isAlive(comp, withChildren);
}
export const ParticleSystem_IsAlive$ = (c: Ctx, h: H): boolean => ParticleSystem_IsAlive$bool(c, h, true);
/** ParticleSystem.time：這次循環裡的系統時間（秒） */
registerNativeProp('ParticleSystem', 'time', {
  get: (c, h) => simIfAny(c, h, 'ParticleSystem.time')?.time ?? 0,
  set: (c, h, v) => {
    const { pm, comp } = pw(c, h, 'ParticleSystem.time');
    const sim = pm.simOf(comp);
    if (sim) sim.time = Math.max(0, Math.min(sim.duration, Number(v)));
  },
});
registerNativeProp('ParticleSystem', 'randomSeed', {
  get: (_c, h) => (h.comp?.randomSeed as number | undefined) ?? 0,
  set: (_c, h, v) => void (h.comp!.randomSeed = Number(v) >>> 0),
});
registerNativeProp('ParticleSystem', 'useAutoRandomSeed', {
  get: (_c, h) => h.comp?.autoRandomSeed !== 0,
  set: (_c, h, v) => void (h.comp!.autoRandomSeed = v ? 1 : 0),
});

// ───────── ParticleSystem.Particle（GetParticles／SetParticles） ─────────
// Unity 的 Particle 是 struct：位置與速度在模擬空間（Local 是系統的區域空間）；rotation 是度；startColor 是 Color32。
// 這裡是不帶 $type 的一般物件（cloneData 照值複製）。

interface ParticleJs {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  animatedVelocity: { x: number; y: number; z: number };
  totalVelocity: { x: number; y: number; z: number };
  remainingLifetime: number;
  startLifetime: number;
  startColor: { r: number; g: number; b: number; a: number };
  startSize: number;
  startSize3D: { x: number; y: number; z: number };
  rotation: number;
  rotation3D: { x: number; y: number; z: number };
  angularVelocity: number;
  angularVelocity3D: { x: number; y: number; z: number };
  randomSeed: number;
  axisOfRotation: { x: number; y: number; z: number };
}
const RAD = 180 / Math.PI;
const blank = (): ParticleJs => ({
  position: { x: 0, y: 0, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  animatedVelocity: { x: 0, y: 0, z: 0 },
  totalVelocity: { x: 0, y: 0, z: 0 },
  remainingLifetime: 0,
  startLifetime: 0,
  startColor: { r: 255, g: 255, b: 255, a: 255 },
  startSize: 0,
  startSize3D: { x: 0, y: 0, z: 0 },
  rotation: 0,
  rotation3D: { x: 0, y: 0, z: 0 },
  angularVelocity: 0,
  angularVelocity3D: { x: 0, y: 0, z: 0 },
  randomSeed: 0,
  axisOfRotation: { x: 0, y: 0, z: 1 },
});
registerExternalCtor('ParticleSystem_Particle', blank);
const byte = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
function particleOut(sim: ParticleSim, i: number): ParticleJs {
  const p = blank();
  p.position = { x: sim.px[i], y: sim.py[i], z: sim.pz[i] };
  p.velocity = { x: sim.vx[i], y: sim.vy[i], z: sim.vz[i] };
  p.animatedVelocity = { x: sim.avx[i], y: sim.avy[i], z: sim.avz[i] };
  p.totalVelocity = { x: sim.vx[i] + sim.avx[i], y: sim.vy[i] + sim.avy[i], z: sim.vz[i] + sim.avz[i] };
  p.remainingLifetime = sim.life[i] - sim.age[i];
  p.startLifetime = sim.life[i];
  p.startColor = { r: byte(sim.col[i * 4]), g: byte(sim.col[i * 4 + 1]), b: byte(sim.col[i * 4 + 2]), a: byte(sim.col[i * 4 + 3]) };
  p.startSize = sim.sx[i];
  p.startSize3D = { x: sim.sx[i], y: sim.sy[i], z: sim.sz[i] };
  p.rotation = sim.rz[i] * RAD;
  p.rotation3D = { x: sim.rx[i] * RAD, y: sim.ry[i] * RAD, z: sim.rz[i] * RAD };
  p.randomSeed = sim.seed[i];
  return p;
}
/** GetParticles(particles)：目前的粒子寫進陣列（最多陣列長度），回傳寫了幾個 */
export const ParticleSystem_GetParticles$ParticleSystem_Particle_arr = (c: Ctx, h: H, arr: ParticleJs[]): number =>
  ParticleSystem_GetParticles$ParticleSystem_Particle_arr_int(c, h, arr, -1);
/** GetParticles(particles, size)：最多寫 size 個（負數是整個陣列） */
export function ParticleSystem_GetParticles$ParticleSystem_Particle_arr_int(c: Ctx, h: H, arr: ParticleJs[], size: number): number {
  const sim = simIfAny(c, h, 'ParticleSystem.GetParticles');
  if (!sim || !arr) return 0;
  const n = Math.min(sim.n, arr.length, size >= 0 ? size : Infinity);
  for (let i = 0; i < n; i++) arr[i] = particleOut(sim, i);
  return n;
}
/** SetParticles(particles, size)：粒子換成陣列的前 size 個（位置、速度、生命期、顏色、大小、旋轉、seed） */
export function ParticleSystem_SetParticles$ParticleSystem_Particle_arr_int(c: Ctx, h: H, arr: ParticleJs[], size: number): void {
  const { pm, comp } = pw(c, h, 'ParticleSystem.SetParticles');
  const sim = pm.simOf(comp);
  if (!sim || !arr) return;
  const n = Math.max(0, Math.min(size ?? arr.length, arr.length));
  while (sim.n < n) sim.emit(1);
  sim.n = Math.min(sim.n, n);
  for (let i = 0; i < n; i++) {
    const p = arr[i];
    if (!p) continue;
    sim.px[i] = p.position.x;
    sim.py[i] = p.position.y;
    sim.pz[i] = p.position.z;
    sim.vx[i] = p.velocity.x;
    sim.vy[i] = p.velocity.y;
    sim.vz[i] = p.velocity.z;
    sim.life[i] = Math.max(1e-4, p.startLifetime);
    sim.age[i] = Math.max(0, p.startLifetime - p.remainingLifetime);
    sim.col[i * 4] = p.startColor.r / 255;
    sim.col[i * 4 + 1] = p.startColor.g / 255;
    sim.col[i * 4 + 2] = p.startColor.b / 255;
    sim.col[i * 4 + 3] = p.startColor.a / 255;
    sim.sx[i] = p.startSize3D?.x ?? p.startSize;
    sim.sy[i] = p.startSize3D?.y ?? p.startSize;
    sim.sz[i] = p.startSize3D?.z ?? p.startSize;
    sim.rz[i] = (p.rotation3D?.z ?? p.rotation) / RAD;
    sim.rx[i] = (p.rotation3D?.x ?? 0) / RAD;
    sim.ry[i] = (p.rotation3D?.y ?? 0) / RAD;
    sim.seed[i] = p.randomSeed >>> 0;
  }
}
export const ParticleSystem_SetParticles$ParticleSystem_Particle_arr = (c: Ctx, h: H, arr: ParticleJs[]): void =>
  ParticleSystem_SetParticles$ParticleSystem_Particle_arr_int(c, h, arr, arr?.length ?? 0);
/** 找回 Particle 對應的粒子（照 randomSeed） */
function findParticle(c: Ctx, ps: H, p: ParticleJs): { sim: ParticleSim; i: number } | null {
  const sim = simIfAny(c, ps, 'ParticleSystem.Particle');
  if (!sim) return null;
  for (let i = 0; i < sim.n; i++) if (sim.seed[i] === p.randomSeed >>> 0) return { sim, i };
  return null;
}
/** Particle.GetCurrentColor(system)：起始顏色 × Color over Lifetime（Color32） */
export function ParticleSystem_Particle_GetCurrentColor(c: Ctx, p: ParticleJs, ps: H): { r: number; g: number; b: number; a: number } {
  const f = findParticle(c, ps, p);
  if (!f) return { ...p.startColor };
  const out = new Float32Array(4);
  particleColor(f.sim, f.i, out);
  return { r: byte(out[0]), g: byte(out[1]), b: byte(out[2]), a: byte(out[3]) };
}
/** Particle.GetCurrentSize(system)：起始大小 × Size over Lifetime */
export function ParticleSystem_Particle_GetCurrentSize(c: Ctx, p: ParticleJs, ps: H): number {
  const f = findParticle(c, ps, p);
  return f ? currentSize(f.sim, f.i) : p.startSize;
}
/** TextureSheetAnimationModule.GetSprite(index)：sprites 清單的第 index 個 */
export function ParticleSystem_TextureSheetAnimationModule_GetSprite(c: Ctx, m: ModuleJs, index: number): unknown {
  const list = (moduleData(m).sprites as { sprite?: unknown }[] | undefined) ?? [];
  if (index < 0 || index >= list.length) throw new Error(`TextureSheetAnimationModule.GetSprite：index ${index} 超出範圍（共 ${list.length} 個）`);
  const w = c.w ?? getActiveWorld();
  return w ? resolveValue(w, list[index]!.sprite ?? null) : null;
}

// ───────── ParticleSystemRenderer ─────────

/** trailMaterial：材質清單的第二格（m_Materials[1]） */
registerNativeProp('ParticleSystemRenderer', 'trailMaterial', {
  get: (c, h) => {
    const w = c.w ?? getActiveWorld();
    const ref = (h.comp?.m_Materials as unknown[] | undefined)?.[1] ?? null;
    return w ? resolveValue(w, ref) : ref;
  },
  set: (_c, h, v) => {
    const mats = ((h.comp!.m_Materials as unknown[] | undefined) ??= []);
    while (mats.length < 2) mats.push(null);
    mats[1] = v ?? null;
  },
});

/** 攝影機（Camera 的 H）→ 粒子用的攝影機資料（Unity 世界座標） */
function particleCameraOf(world: World, cam: H | null): ParticleCamera {
  const pos = new Vector3();
  const q = new Quaternion();
  if (cam?.node) {
    world.refreshTransform(cam.node);
    cam.node.world.decompose(pos, q, new Vector3());
  }
  const comp = cam?.comp ?? {};
  return {
    position: pos,
    right: new Vector3(1, 0, 0).applyQuaternion(q),
    up: new Vector3(0, 1, 0).applyQuaternion(q),
    forward: new Vector3(0, 0, 1).applyQuaternion(q),
    orthographic: !!(comp as Record<string, unknown>).orthographic,
    fov: ((comp as Record<string, unknown>)['field of view'] as number) ?? 60,
    orthoSize: ((comp as Record<string, unknown>)['orthographic size'] as number) ?? 5,
  };
}

/** 產好的粒子網格寫進執行期的 Mesh（位置、法線、顏色、TEXCOORD0..n 照 4 個分量放 uv0..） */
function writeGeometry(mesh: MeshInstance & { submeshes?: number[][] }, g: ParticleGeometry): void {
  mesh.vertexCount = g.vertexCount;
  mesh.channels = {
    position: { dimension: 3, values: Float32Array.from(g.position) },
    normal: { dimension: 3, values: Float32Array.from(g.normal) },
    color: { dimension: 4, values: Float32Array.from(g.color) },
  };
  g.texcoords.forEach((tc, k) => (mesh.channels[`uv${k}`] = { dimension: 4, values: Float32Array.from(tc) }));
  mesh.indices = Array.from(g.indices);
  mesh.submeshes = [mesh.indices];
  mesh.version++;
}

/**
 * BakeMesh(mesh, camera, options)：粒子照 camera 的方向產成網格。options 是 ParticleSystemBakeMeshOptions：
 * BakeRotationAndScale（1）時 Local 模擬的頂點是「世界座標減掉發射器位置」（旋轉與縮放烤進去、位置不烤，UIParticle 再乘自己的矩陣），
 * BakePosition（2）一起烤進去（＝世界座標），Default（3）＝兩者（未查證細節）
 */
function bake(c: Ctx, h: H, mesh: MeshInstance, camera: H | null, options: number, trails: boolean): void {
  const world = c.w ?? getActiveWorld();
  if (!world || !h?.comp) throw new Error('ParticleSystemRenderer.BakeMesh：對象是 null（C# 這裡會 NullReferenceException）');
  if (!mesh) throw new Error('ParticleSystemRenderer.BakeMesh：mesh 是 null');
  const psComp = world.graph.component(h.node, 'ParticleSystem');
  const sim = psComp ? world.particles.existing(psComp) : null;
  if (!sim || !sim.pose) {
    writeGeometry(mesh, { vertexCount: 0, position: new Float32Array(0), normal: new Float32Array(0), color: new Float32Array(0), texcoords: [], indices: new Uint32Array(0) });
    return;
  }
  const r = h.comp;
  const meshRef = r.m_Mesh as { guid?: string; fileID?: string } | null;
  const asset = (r.m_RenderMode as number) === 4 && meshRef?.guid ? meshAssetOf(meshRef) : null;
  const opt = {
    camera: particleCameraOf(world, camera),
    renderer: r,
    // 烘出來的網格存 gamma 的頂點色（跟 Mesh.colors32 一樣是資料）；畫 UI 時 Canvas 照線性流程轉（Canvas.vertexColorAlwaysGammaSpace 預設 false）。
    // Unity 的 BakeMesh 在線性專案輸出哪一種：未查證
    linearColor: false,
    // 「不烤位置」只對 Local 模擬有意義（World 模擬的粒子本來就是世界座標，UIParticle 也照這個乘 worldToLocal）
    subtractEmitter: options === 1 && !sim.worldSpace,
    mesh: asset
      ? {
          position: asset.channels.position?.values ?? [],
          normal: asset.channels.normal?.values,
          uv: asset.channels.uv0?.values,
          color: asset.channels.color?.values,
          indices: asset.indices,
        }
      : null,
  };
  writeGeometry(mesh, trails ? buildTrails(sim, opt) : buildParticles(sim, opt));
}
export const ParticleSystemRenderer_BakeMesh$Mesh_Camera_ParticleSystemBakeMeshOptions = (c: Ctx, h: H, mesh: MeshInstance, camera: H | null, options: number): void =>
  bake(c, h, mesh, camera, options, false);
export const ParticleSystemRenderer_BakeMesh$Mesh_Camera_bool = (c: Ctx, h: H, mesh: MeshInstance, camera: H | null, useTransform: boolean): void =>
  bake(c, h, mesh, camera, useTransform ? 3 : 1, false);
export const ParticleSystemRenderer_BakeTrailsMesh$Mesh_Camera_ParticleSystemBakeMeshOptions = (c: Ctx, h: H, mesh: MeshInstance, camera: H | null, options: number): void =>
  bake(c, h, mesh, camera, options, true);
export const ParticleSystemRenderer_BakeTrailsMesh$Mesh_Camera_bool = (c: Ctx, h: H, mesh: MeshInstance, camera: H | null, useTransform: boolean): void =>
  bake(c, h, mesh, camera, useTransform ? 3 : 1, true);


// ───────── Canvas.willRenderCanvases 與 UIParticle ─────────

/**
 * Canvas.willRenderCanvases（靜態事件，產生碼用 eventAdd 加在 recv null 上）：World 每格在粒子推進之後發。
 * UIParticle 的 UpdateMeshes 掛在這裡：BakeMesh → 換到自己的座標 → CanvasRenderer.SetMesh
 */
registerWillRenderCanvases(() => {
  const handlers = eventGet(staticCtx, 'Canvas.willRenderCanvases', null);
  if (handlers) invokeDelegate(staticCtx, handlers);
});

/**
 * UIParticle（Coffee.UIExtensions，原始碼轉出來的 MaskableGraphic）畫什麼：網格是它交給 CanvasRenderer 的，材質是它 material 屬性
 * （粒子 Renderer 的 sharedMaterial；拖尾那份是 trailMaterial）。Graphic 的 UpdateMaterial 在這個專案沒有跑（Graphic 是原生基底），
 * 所以材質直接問產生碼的屬性
 */
registerCanvasMeshSource('UIParticle', (node, comp) => {
  const world = getActiveWorld();
  if (!world) return null;
  const crComp = world.graph.component(node, 'CanvasRenderer');
  const st = crComp ? existingCanvasRendererState(crComp) : null;
  if (!st?.mesh) return null;
  let material: unknown = null;
  try {
    material = genCallVirtual(world, 'UIParticle', compHandle(world, comp as ComponentData), 'get_material');
  } catch {
    material = null;
  }
  return { mesh: st.mesh, material, texture: st.texture };
});

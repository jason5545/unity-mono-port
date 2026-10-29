// Post Processing v2（Unity.Postprocessing.Runtime，DLL）：攝影機這一格的後製設定。
// 照反編譯的原版（reference/decompiled/Unity.Postprocessing.Runtime，ilspycmd 產生）：
//   - PostProcessManager.UpdateSettings：先把每種效果的設定換回預設值（ReplaceData，預設值是效果類別欄位的初始值），
//     再照 priority 由低到高（SortByPriority，插入排序、相同的保留原順序）把每個 volume 的 profile 疊上去。
//     跳過停用的、沒有 profile 的、weight ≤ 0 的；GameObject 的 layer 要在 PostProcessLayer.volumeLayer 裡（GrabVolumes）。
//   - PostProcessLayer.OverrideSettings：profile 裡 active 的效果，overrideState 為真的參數照 weight 插值
//     （Float、Color、Vector 線性；Int 線性後截斷；Bool、列舉、貼圖 t > 0 就換；Spline 逐格插 cachedData）。
// 遊戲改 profile（GraphicsSettingsMainSceneManager 開關 Bloom、fastMode）改的是同一份 ScriptableObject，這裡每格重讀。
// 繪製端（render/postProcess.ts）拿結果算 shader 參數、跑 Bloom／LUT／Uber。
// 沒做（差異清單）：非 global 的 volume（要 collider 與 volumeTrigger 的距離；MT2 的場景沒有，未逐一查證）、
// 效果的 IsEnabledAndSupported 由繪製端判斷。

import type { World } from '../engine/world';
import type { CameraInfo, SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { compHandle, mbGet, type Ctx } from './core';

type Rgba = { r: number; g: number; b: number; a: number };
type Vec = { x: number; y: number; z?: number; w?: number };
/** Spline：只用 cachedData（128 格） */
type SplineValue = { cachedData: number[] };
export type PPValue = number | boolean | Rgba | Vec | SplineValue | object | null;
/** 一種效果混合後的參數（名稱照 C# 欄位） */
export type PPEffect = Record<string, PPValue>;
export interface PostProcessFrame {
  /** 效果類別名 → 混合後的參數；只有這幾種：Bloom、ColorGrading、Vignette，加上其他 profile 裡出現過的（判斷有沒有開，繪製端記差異） */
  effects: Record<string, PPEffect>;
  /** PostProcessLayer 自己的設定（antialiasingMode、stopNaNPropagation、breakBeforeColorGrading） */
  layer: { antialiasingMode: number; stopNaNPropagation: boolean; breakBeforeColorGrading: boolean };
  /** 參與的 volume（除錯介面看） */
  volumes: string[];
  /** PostProcessResources.blueNoise64 的貼圖 guid（Dithering 用） */
  blueNoise: string[];
}

const flatSpline = (zero: number): SplineValue => ({ cachedData: new Array(128).fill(zero) });
const identitySpline = (): SplineValue => ({ cachedData: Array.from({ length: 128 }, (_, i) => i / 128) });

/** 各效果類別的欄位初始值（反編譯的 Bloom.cs、ColorGrading.cs、Vignette.cs；PostProcessEffectSettings.enabled 預設 false） */
export function defaultEffect(type: string): PPEffect {
  switch (type) {
    case 'Bloom':
      return {
        enabled: false,
        intensity: 0,
        threshold: 1,
        softKnee: 0.5,
        clamp: 65472,
        diffusion: 7,
        anamorphicRatio: 0,
        color: { r: 1, g: 1, b: 1, a: 1 },
        fastMode: false,
        dirtTexture: null,
        dirtIntensity: 0,
      };
    case 'ColorGrading':
      return {
        enabled: false,
        gradingMode: 1, // HighDefinitionRange
        externalLut: null,
        tonemapper: 0,
        toneCurveToeStrength: 0,
        toneCurveToeLength: 0.5,
        toneCurveShoulderStrength: 0,
        toneCurveShoulderLength: 0.5,
        toneCurveShoulderAngle: 0,
        toneCurveGamma: 1,
        ldrLut: null,
        ldrLutContribution: 1,
        temperature: 0,
        tint: 0,
        colorFilter: { r: 1, g: 1, b: 1, a: 1 },
        hueShift: 0,
        saturation: 0,
        brightness: 0,
        postExposure: 0,
        contrast: 0,
        mixerRedOutRedIn: 100,
        mixerRedOutGreenIn: 0,
        mixerRedOutBlueIn: 0,
        mixerGreenOutRedIn: 0,
        mixerGreenOutGreenIn: 100,
        mixerGreenOutBlueIn: 0,
        mixerBlueOutRedIn: 0,
        mixerBlueOutGreenIn: 0,
        mixerBlueOutBlueIn: 100,
        lift: { x: 1, y: 1, z: 1, w: 0 },
        gamma: { x: 1, y: 1, z: 1, w: 0 },
        gain: { x: 1, y: 1, z: 1, w: 0 },
        masterCurve: identitySpline(),
        redCurve: identitySpline(),
        greenCurve: identitySpline(),
        blueCurve: identitySpline(),
        hueVsHueCurve: flatSpline(0.5),
        hueVsSatCurve: flatSpline(0.5),
        satVsSatCurve: flatSpline(0.5),
        lumVsSatCurve: flatSpline(0.5),
      };
    case 'Vignette':
      return {
        enabled: false,
        mode: 0, // Classic
        color: { r: 0, g: 0, b: 0, a: 1 },
        center: { x: 0.5, y: 0.5 },
        intensity: 0,
        smoothness: 0.2,
        roundness: 1,
        rounded: false,
        mask: null,
        opacity: 1,
      };
    default:
      return { enabled: false };
  }
}

/** 序列化的布林是 0／1，遊戲寫進去的是 true／false */
export const ppBool = (v: PPValue | undefined): boolean => v === true || (typeof v === 'number' && v !== 0);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

/** ParameterOverride<T>.Interp 的各型別（反編譯的 FloatParameter、ColorParameter、Vector*Parameter、IntParameter、SplineParameter） */
export function interpParam(from: PPValue | undefined, to: PPValue, t: number): PPValue {
  if (typeof to === 'number' && typeof from === 'number') return from + (to - from) * t;
  if (isObj(to) && 'cachedData' in to && isObj(from) && 'cachedData' in from) {
    const a = (from as SplineValue).cachedData;
    const b = (to as SplineValue).cachedData;
    return { cachedData: b.map((x, i) => (a[i] ?? 0) + (x - (a[i] ?? 0)) * t) };
  }
  if (isObj(to) && 'r' in to && isObj(from) && 'r' in from) {
    const a = from as Rgba;
    const b = to as Rgba;
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
  }
  if (isObj(to) && 'x' in to && isObj(from) && 'x' in from) {
    const out: Record<string, number> = {};
    for (const k of ['x', 'y', 'z', 'w'] as const) {
      const b = (to as Record<string, number>)[k];
      if (b === undefined) continue;
      const a = (from as Record<string, number>)[k] ?? 0;
      out[k] = a + (b - a) * t;
    }
    return out;
  }
  return t > 0 ? to : (from ?? to);
}

/** 整數欄位（列舉）不插值：IntParameter 只用在 MT2 沒開的效果；列舉照 ParameterOverride 的預設（t > 0 就換） */
const ENUM_PARAMS = new Set(['gradingMode', 'tonemapper', 'mode']);

/** PostProcessLayer.OverrideSettings：一個 profile 疊到目前的設定上 */
export function overrideSettings(effects: Record<string, PPEffect>, settings: unknown[], weight: number): void {
  for (const s of settings) {
    if (!isObj(s) || !ppBool(s.active as PPValue)) continue;
    const type = s.$type as string;
    const target = (effects[type] ??= defaultEffect(type));
    for (const [name, p] of Object.entries(s)) {
      if (!isObj(p) || !('overrideState' in p) || !ppBool(p.overrideState as PPValue)) continue;
      const to = p.value as PPValue;
      target[name] = ENUM_PARAMS.has(name) ? (weight > 0 ? to : target[name]) : interpParam(target[name], to, weight);
    }
  }
}

interface VolumeEntry {
  name: string;
  priority: number;
  weight: number;
  settings: unknown[];
  order: number;
}

/**
 * 這台攝影機的後製設定：攝影機的 GameObject 上要有啟用的 PostProcessLayer（原版的 OnPreCull 只在元件啟用時跑）。
 * 沒有就回 null（照舊直接畫）。
 */
export function postProcessFor(world: World, cam: CameraInfo): PostProcessFrame | null {
  const comps = world.graph.components(cam.node);
  const layer = comps.find((c) => c.script?.class === 'PostProcessLayer');
  if (!layer || layer.m_Enabled === 0 || !cam.node.activeInHierarchy) return null;
  const c = { w: world } as Ctx;
  const mask = Number((layer.volumeLayer as { m_Bits?: number } | undefined)?.m_Bits ?? 0);
  const vols: VolumeEntry[] = [];
  let order = 0;
  // 有 PostProcessVolume 的節點只隨節點與元件增減變（SceneGraph.cached 的 membership，照 nodes 的順序）；啟用與否每次照舊判斷。
  // 每格每台攝影機掃 1.4 萬個節點，MT2 戰鬥占一格約 6%（10/18 量）
  const candidates = world.graph.cached(
    'postProcess.volumes',
    () => {
      const out: { n: SceneNode; comps: ComponentData[] }[] = [];
      for (const n of world.graph.nodes.values()) {
        const comps = world.graph.components(n).filter((c) => c.script?.class === 'PostProcessVolume');
        if (comps.length) out.push({ n, comps });
      }
      return out;
    },
    'membership',
  );
  for (const { n, comps } of candidates) {
    for (const comp of comps) {
      order++;
      // PostProcessVolume 在 OnEnable 登記、OnDisable 移除（PostProcessManager.Register／Unregister）：物件關掉或元件停用就不算
      if (!n.activeInHierarchy || comp.m_Enabled === 0) continue;
      const goLayer = Number(n.go.m_Layer ?? 0);
      if ((mask & (1 << goLayer)) === 0) continue;
      const h = compHandle(world, comp);
      const isGlobal = ppBool(mbGet(c, h, 'isGlobal') as PPValue);
      const weight = Number(mbGet(c, h, 'weight') ?? 1);
      const profile = mbGet(c, h, 'sharedProfile') as { settings?: unknown[] } | null;
      if (!profile?.settings || !(weight > 0)) continue;
      if (!isGlobal) continue; // 差異清單：local volume 沒做
      vols.push({ name: n.go.m_Name, priority: Number(mbGet(c, h, 'priority') ?? 0), weight: Math.min(1, Math.max(0, weight)), settings: profile.settings, order });
    }
  }
  vols.sort((a, b) => a.priority - b.priority || a.order - b.order);
  const resources = mbGet(c, compHandle(world, layer), 'm_Resources') as { blueNoise64?: { guid?: string }[] } | null;
  const blueNoise = (resources?.blueNoise64 ?? []).map((r) => r?.guid).filter((g): g is string => typeof g === 'string');
  const effects: Record<string, PPEffect> = {
    Bloom: defaultEffect('Bloom'),
    ColorGrading: defaultEffect('ColorGrading'),
    Vignette: defaultEffect('Vignette'),
  };
  for (const v of vols) overrideSettings(effects, v.settings, v.weight);
  return {
    effects,
    layer: {
      antialiasingMode: Number(layer.antialiasingMode ?? 0),
      stopNaNPropagation: ppBool(layer.stopNaNPropagation as PPValue),
      breakBeforeColorGrading: ppBool(layer.breakBeforeColorGrading as PPValue),
    },
    volumes: vols.map((v) => `${v.name}(${v.priority})`),
    blueNoise,
  };
}

/** 給繪製端：這個攝影機元件的後製設定（boot 接上 SceneRenderer.postProcess） */
export function cameraPostProcess(world: World): (cam: CameraInfo) => PostProcessFrame | null {
  return (cam) => postProcessFor(world, cam);
}


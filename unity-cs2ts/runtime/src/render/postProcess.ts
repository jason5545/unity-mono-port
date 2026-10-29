// Post Processing v2 的內建效果（built-in 管線；攝影機上有啟用的 PostProcessLayer 時，sceneRenderer.renderBuiltin 叫這裡）。
// 照反編譯的原版（reference/decompiled/Unity.Postprocessing.Runtime）：
//   - PostProcessLayer.RenderBuiltins：Bloom → Vignette → ColorGrading 各自往 uber 的 PropertySheet 填參數、開 keyword，
//     最後一次 Uber（Hidden/PostProcessing/Uber）從來源畫到攝影機的目標。沒有 AfterStack 效果、沒開 FXAA／SMAA 時這就是最後一趟（FINALPASS＋Dithering）。
//   - BloomRenderer.Render：Prefilter → Downsample 金字塔 → Upsample 回來（Hidden/PostProcessing/Bloom 的 pass 0–5），參數算法照抄。
//   - ColorGradingRenderer.RenderHDRPipeline2D：Lut2DBaker 的 pass 2 烘一張 1024×32 的 LUT 條（ACES 等 tonemapper 是 keyword）。
//     原版在支援 compute 的平台走 3D LUT（Lut3DBaker，33³）；WebGL 沒有 compute，走原版給 OpenGLES3／不支援 3D 的那條 2D 路（數學相同、解析度 32）。
//   - VignetteRenderer.Render：Classic 與 Masked 兩種。
// shader 都是原版的 DX11 bytecode 轉出的 GLSL（createProgram）。原版的全螢幕三角形在 D3D 上把 uv 的 y 反過來（VertDefault 的
// UNITY_UV_STARTS_AT_TOP 寫死在 bytecode 裡）；這裡的 render target 是 GL 的列序，所以三角形的 y 取負、vertex shader 最後再把
// gl_Position.y 取負：位置不變、uv 變成 GL 的方向。Uber 的 _UVTransform 給 D3D 的預設 (1, −1, 0, 1)，同一個取負就對上。
// 沒做（差異清單）：AutoExposure（_AutoExposureTex 給白）、Bloom 的 dirt 貼圖（MT2 的 profile 沒設）、stopNaNPropagation 的 NaN 清除、
// DepthOfField、MotionBlur、ChromaticAberration、Grain、LensDistortion、AmbientOcclusion、FXAA／SMAA／TAA、LDR 與 External 的色彩分級。

import * as THREE from 'three';
import { createProgram, fillBlock, type ShaderLibrary, type UnityProgram } from './unityShader';
import type { PPEffect, PPValue, PostProcessFrame } from '../csport/unityPostProcess';

type V4 = [number, number, number, number];
const num = (v: PPValue | undefined, d = 0): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);
const bool = (v: PPValue | undefined): boolean => v === true || (typeof v === 'number' && v !== 0);
const vec = (v: PPValue | undefined, d: V4): V4 => {
  const o = v as { x?: number; y?: number; z?: number; w?: number; r?: number; g?: number; b?: number; a?: number } | null;
  if (!o || typeof o !== 'object') return d;
  if ('r' in o) return [o.r ?? d[0], o.g ?? d[1], o.b ?? d[2], o.a ?? d[3]];
  return [o.x ?? d[0], o.y ?? d[1], o.z ?? d[2], o.w ?? d[3]];
};

/** Mathf.GammaToLinearSpace（UnityCG.cginc 的 GammaToLinearSpaceExact 同一套分段；大於 1 用 2.2 次方） */
export function gammaToLinearSpace(v: number): number {
  if (v <= 0.04045) return v / 12.92;
  if (v < 1) return Math.pow((v + 0.055) / 1.055, 2.4);
  return Math.pow(v, 2.2);
}

// ───────── 參數（純計算，vitest 驗）─────────

export interface BloomParams {
  /** 金字塔層數（num9） */
  iterations: number;
  /** 每一層的寬高（第 0 層是 num4×num5，之後各除以 2、至少 1） */
  sizes: { w: number; h: number }[];
  sampleScale: number;
  threshold: V4;
  params: V4;
  /** uber 的 _Bloom_Settings：(sampleScale, 強度, dirt 強度, 層數) */
  settings: V4;
  /** 線性的 bloom 顏色 */
  color: V4;
  fastMode: boolean;
}

/** BloomRenderer.Render 的參數（非 stereo） */
export function bloomParams(b: PPEffect, screenW: number, screenH: number): BloomParams {
  const ratio = Math.min(1, Math.max(-1, num(b.anamorphicRatio)));
  const rw = ratio < 0 ? -ratio : 0;
  const rh = ratio > 0 ? ratio : 0;
  let w = Math.floor(screenW / (2 - rw));
  let h = Math.floor(screenH / (2 - rh));
  const logh = Math.log2(Math.max(w, h)) + Math.min(num(b.diffusion, 7), 10) - 10;
  const logi = Math.floor(logh);
  const iterations = Math.min(16, Math.max(1, logi));
  const sampleScale = 0.5 + logh - logi;
  const lthresh = gammaToLinearSpace(num(b.threshold, 1));
  const knee = lthresh * num(b.softKnee, 0.5) + 1e-5;
  const sizes: { w: number; h: number }[] = [];
  for (let i = 0; i < iterations; i++) {
    sizes.push({ w, h });
    w = Math.max(Math.floor(w / 2), 1);
    h = Math.max(Math.floor(h / 2), 1);
  }
  const c = vec(b.color, [1, 1, 1, 1]);
  const intensity = Math.pow(2, num(b.intensity) / 10) - 1;
  return {
    iterations,
    sizes,
    sampleScale,
    threshold: [lthresh, lthresh - knee, knee * 2, 0.25 / knee],
    params: [gammaToLinearSpace(num(b.clamp, 65472)), 0, 0, 0],
    settings: [sampleScale, intensity, num(b.dirtIntensity), iterations],
    color: [gammaToLinearSpace(c[0]), gammaToLinearSpace(c[1]), gammaToLinearSpace(c[2]), c[3]],
    fastMode: bool(b.fastMode),
  };
}

// ColorUtilities（反編譯的原版）
const standardIlluminantY = (x: number): number => 2.87 * x - 3 * x * x - 0.27509508;
function cieXyToLms(x: number, y: number): [number, number, number] {
  const X = x / y;
  const Z = (1 - x - y) / y;
  return [0.7328 * X + 0.4296 - 0.1624 * Z, -0.7036 * X + 1.6975 + 0.0061 * Z, 0.003 * X + 0.0136 + 0.9834 * Z];
}
export function computeColorBalance(temperature: number, tint: number): [number, number, number] {
  const t1 = temperature / 60;
  const t2 = tint / 60;
  const x = 0.31271 - t1 * (t1 < 0 ? 0.1 : 0.05);
  const y = standardIlluminantY(x) + t2 * 0.05;
  const w1 = [0.949237, 1.03542, 1.08728];
  const w2 = cieXyToLms(x, y);
  return [w1[0] / w2[0], w1[1] / w2[1], w1[2] / w2[2]];
}
const luma = (v: V4): number => v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722;
export function colorToLift(c: V4): [number, number, number] {
  const l = luma(c);
  return [c[0] - l + c[3], c[1] - l + c[3], c[2] - l + c[3]];
}
export function colorToInverseGamma(c: V4): [number, number, number] {
  const l = luma(c);
  const w = c[3] + 1;
  return [1 / Math.max(c[0] - l + w, 0.001), 1 / Math.max(c[1] - l + w, 0.001), 1 / Math.max(c[2] - l + w, 0.001)];
}
export function colorToGain(c: V4): [number, number, number] {
  const l = luma(c);
  const w = c[3] + 1;
  return [c[0] - l + w, c[1] - l + w, c[2] - l + w];
}
const scale4 = (v: V4, k: number): V4 => [v[0] * k, v[1] * k, v[2] * k, v[3] * k];

/** ColorGradingRenderer.RenderHDRPipeline2D 給 Lut2DBaker 的參數 */
export function lutBakerParams(cg: PPEffect): Record<string, number[]> {
  return {
    _Lut2D_Params: [32, 2 / 4096, 1 / 64, 1.032258],
    _ColorBalance: computeColorBalance(num(cg.temperature), num(cg.tint)),
    // SetVector：不轉線性
    _ColorFilter: vec(cg.colorFilter, [1, 1, 1, 1]),
    _HueSatCon: [num(cg.hueShift) / 360, num(cg.saturation) / 100 + 1, num(cg.contrast) / 100 + 1],
    _ChannelMixerRed: [num(cg.mixerRedOutRedIn, 100) / 100, num(cg.mixerRedOutGreenIn) / 100, num(cg.mixerRedOutBlueIn) / 100],
    _ChannelMixerGreen: [num(cg.mixerGreenOutRedIn) / 100, num(cg.mixerGreenOutGreenIn, 100) / 100, num(cg.mixerGreenOutBlueIn) / 100],
    _ChannelMixerBlue: [num(cg.mixerBlueOutRedIn) / 100, num(cg.mixerBlueOutGreenIn) / 100, num(cg.mixerBlueOutBlueIn, 100) / 100],
    _Lift: colorToLift(scale4(vec(cg.lift, [1, 1, 1, 0]), 0.2)),
    _InvGamma: colorToInverseGamma(scale4(vec(cg.gamma, [1, 1, 1, 0]), 0.8)),
    _Gain: colorToGain(scale4(vec(cg.gain, [1, 1, 1, 0]), 0.8)),
  };
}

/** Lut2DBaker 的 keyword（tonemapper：0 None、1 Custom、2 ACES、3 Neutral；Custom 的 Hable 曲線沒做，記差異） */
export function tonemapKeyword(cg: PPEffect): string | null {
  switch (num(cg.tonemapper)) {
    case 2:
      return 'TONEMAPPING_ACES';
    case 3:
      return 'TONEMAPPING_NEUTRAL';
    case 1:
      return 'TONEMAPPING_CUSTOM';
    default:
      return null;
  }
}

/** GetCurveTexture(hdr: true)：第 0 列是 hueVsHue、hueVsSat、satVsSat、lumVsSat 的 cachedData（128 格），第 1 列 HDR 不寫（留 0） */
export function curvePixels(cg: PPEffect): Float32Array {
  const px = new Float32Array(128 * 2 * 4);
  const data = (k: string): number[] => ((cg[k] as { cachedData?: number[] } | undefined)?.cachedData ?? new Array(128).fill(0.5));
  const [a, b, c, d] = [data('hueVsHueCurve'), data('hueVsSatCurve'), data('satVsSatCurve'), data('lumVsSatCurve')];
  for (let i = 0; i < 128; i++) {
    px[i * 4] = a[i] ?? 0.5;
    px[i * 4 + 1] = b[i] ?? 0.5;
    px[i * 4 + 2] = c[i] ?? 0.5;
    px[i * 4 + 3] = d[i] ?? 0.5;
  }
  return px;
}

/** VignetteRenderer.Render 給 uber 的參數；mode 0 Classic、1 Masked */
export function vignetteParams(v: PPEffect): Record<string, number[]> {
  const mode = num(v.mode);
  const c = vec(v.color, [0, 0, 0, 1]);
  const out: Record<string, number[]> = {
    // SetColor：線性色彩空間下轉線性
    _Vignette_Color: [gammaToLinearSpace(c[0]), gammaToLinearSpace(c[1]), gammaToLinearSpace(c[2]), c[3]],
    _Vignette_Mode: [mode === 0 ? 0 : 1],
  };
  if (mode === 0) {
    const roundness = num(v.roundness, 1);
    const center = vec(v.center, [0.5, 0.5, 0, 0]);
    out._Vignette_Center = [center[0], center[1]];
    out._Vignette_Settings = [num(v.intensity) * 3, num(v.smoothness, 0.2) * 5, (1 - roundness) * 6 + roundness, bool(v.rounded) ? 1 : 0];
  } else out._Vignette_Opacity = [Math.min(1, Math.max(0, num(v.opacity, 1)))];
  return out;
}

/** IsEnabledAndSupported */
export function effectActive(type: string, e: PPEffect | undefined): boolean {
  if (!e || !bool(e.enabled)) return false;
  if (type === 'Bloom') return num(e.intensity) > 0;
  if (type === 'Vignette') {
    if (num(e.mode) === 0) return num(e.intensity) > 0;
    return num(e.opacity, 1) > 0 && !!e.mask;
  }
  return true;
}

// ───────── GPU ─────────

const COPY_VERTEX = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
const COPY_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D tSource;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = texture(tSource, vUv); }`;

interface ProgramSlot {
  program: UnityProgram | null;
  error?: string;
}

/** 一個攝影機的後製（每台攝影機一份：LUT 與 bloom 的暫存 target 跟著畫面大小） */
export class PostProcessStack {
  private programs = new Map<string, ProgramSlot>();
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private mesh: THREE.Mesh;
  private copyMesh: THREE.Mesh;
  private copyScene = new THREE.Scene();
  private bloomDown: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private lut: THREE.WebGLRenderTarget | null = null;
  private lutKey = '';
  private curves: THREE.DataTexture | null = null;
  private white: THREE.DataTexture;
  private black: THREE.DataTexture;
  private blueNoise: THREE.Texture[] = [];
  private noiseIndex = 0;
  /** System.Random(1234) 的替代：決定性的亂數（Dithering 的偏移；值不影響畫面的大小只到 1/255） */
  private seed = 1234;
  /** 這一格用到、還沒轉好的 shader（除錯介面看） */
  readonly report: { missing: Record<string, string>; skipped: Set<string>; lastPasses: number } = { missing: {}, skipped: new Set(), lastPasses: 0 };
  /** 攝影機畫進來的 HDR 來源（大小跟 viewport） */
  source: THREE.WebGLRenderTarget | null = null;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private shaders: ShaderLibrary,
    blueNoise: Promise<THREE.Texture | null>[] = [],
  ) {
    // 全螢幕三角形：y 取負（檔頭）。屬性名是轉出的 vertex shader 的輸入 POSITION
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('POSITION', new THREE.Float32BufferAttribute([-1, 1, 0, 3, 1, 0, -1, -3, 0], 3));
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, 1, 0, 3, 1, 0, -1, -3, 0], 3));
    this.mesh = new THREE.Mesh(tri);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
    const copyTri = new THREE.BufferGeometry();
    copyTri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.copyMesh = new THREE.Mesh(
      copyTri,
      new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: COPY_VERTEX, fragmentShader: COPY_FRAGMENT, uniforms: { tSource: { value: null } }, depthTest: false, depthWrite: false }),
    );
    this.copyMesh.frustumCulled = false;
    this.copyScene.add(this.copyMesh);
    const px = (v: number) => {
      const t = new THREE.DataTexture(new Uint8Array([v, v, v, v]), 1, 1);
      t.needsUpdate = true;
      return t;
    };
    this.white = px(255);
    this.black = px(0);
    void Promise.all(blueNoise).then((ts) => {
      this.blueNoise = ts.filter((t): t is THREE.Texture => !!t);
    });
  }

  private hdrTarget(w: number, h: number, depth = false): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: depth,
      stencilBuffer: depth,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
  }

  /** 攝影機要畫進的 HDR 來源（深度與 stencil 跟主 target 一樣都配） */
  sourceTarget(w: number, h: number): THREE.WebGLRenderTarget {
    if (!this.source) this.source = this.hdrTarget(w, h, true);
    else if (this.source.width !== w || this.source.height !== h) this.source.setSize(w, h);
    return this.source;
  }

  /** depth only／don't clear 的攝影機：先把目前畫面的這一塊複製進來（原版在 HDR 中繼 target 上也是接著前面攝影機的內容畫） */
  copyInto(src: THREE.Texture, dst: THREE.WebGLRenderTarget, uvRect: [number, number, number, number]): void {
    const m = this.copyMesh.material as THREE.RawShaderMaterial;
    m.uniforms.tSource.value = src;
    void uvRect; // viewport 等於整個畫面時 uv 就是 0–1；MT2 的後製攝影機都是全畫面
    this.renderer.setRenderTarget(dst);
    this.renderer.render(this.copyScene, this.camera);
  }

  /** 要的 program：第一次要時開始建（async），建好之前回 null（這一格就不做後製，照舊直接畫） */
  private program(shader: string, pass: number, keywords: string[]): UnityProgram | null {
    const key = `${shader}|${pass}|${keywords.join(',')}`;
    let slot = this.programs.get(key);
    if (!slot) {
      slot = { program: null };
      this.programs.set(key, slot);
      const s = slot;
      void createProgram(this.shaders, shader, keywords, {}, 'builtin', pass).then((p) => {
        if ('error' in p) {
          s.error = p.error;
          this.report.missing[key] = p.error;
          return;
        }
        // 檔頭：y 取負換回 GL 的列序
        p.material.vertexShader = p.material.vertexShader.replace(
          'gl_Position.z = gl_Position.w - 2.0 * gl_Position.z;',
          'gl_Position.z = gl_Position.w - 2.0 * gl_Position.z;\n    gl_Position.y = -gl_Position.y;',
        );
        p.material.depthTest = false;
        p.material.depthWrite = false;
        p.material.side = THREE.DoubleSide;
        p.material.needsUpdate = true;
        s.program = p;
      });
    }
    return slot.program;
  }

  /** 先把要用的 program 建起來（第一次遇到這個設定時；之後每格同步取） */
  ensure(frame: PostProcessFrame): boolean {
    const plan = this.plan(frame);
    let ready = true;
    for (const [shader, pass, kw] of plan.programs) if (!this.program(shader, pass, kw)) ready = false;
    return ready && plan.uber !== null;
  }

  private plan(frame: PostProcessFrame): { programs: [string, number, string[]][]; uber: string[] | null; bloom: boolean; grading: boolean; vignette: boolean } {
    const e = frame.effects;
    const bloom = effectActive('Bloom', e.Bloom);
    const vignette = effectActive('Vignette', e.Vignette);
    const cg = e.ColorGrading;
    const gradingHdr = effectActive('ColorGrading', cg) && !frame.layer.breakBeforeColorGrading && num(cg?.gradingMode, 1) === 1;
    for (const [type, s] of Object.entries(e)) if (!['Bloom', 'Vignette', 'ColorGrading'].includes(type) && bool(s.enabled)) this.report.skipped.add(type);
    if (effectActive('ColorGrading', cg) && !gradingHdr) this.report.skipped.add('ColorGrading（LDR／External）');
    const programs: [string, number, string[]][] = [];
    if (bloom) {
      const fast = bool(e.Bloom.fastMode) ? 1 : 0;
      programs.push(['Hidden/PostProcessing/Bloom', fast, []], ['Hidden/PostProcessing/Bloom', 2 + fast, []], ['Hidden/PostProcessing/Bloom', 4 + fast, []]);
    }
    if (gradingHdr) {
      const kw = tonemapKeyword(cg);
      programs.push(['Hidden/PostProcessing/Lut2DBaker', 2, kw ? [kw] : []]);
    }
    const uber = [bloom ? (bool(e.Bloom?.fastMode) ? 'BLOOM_LOW' : 'BLOOM') : null, vignette ? 'VIGNETTE' : null, gradingHdr ? 'COLOR_GRADING_HDR_2D' : null, 'FINALPASS'].filter((x): x is string => !!x);
    programs.push(['Hidden/PostProcessing/Uber', 0, uber]);
    return { programs, uber, bloom, grading: gradingHdr, vignette };
  }

  /** 一趟全螢幕：填 cbuffer、綁貼圖、畫進 target（null＝目前的 target 與 viewport 不動） */
  private blit(p: UnityProgram, target: THREE.WebGLRenderTarget | null | undefined, values: Record<string, ArrayLike<number>>, textures: Record<string, THREE.Texture | null>): void {
    for (const b of p.blocks) fillBlock(b, (name) => values[name] ?? null);
    for (const t of p.textures) p.material.uniforms[t.uniform].value = textures[t.property] ?? this.white;
    this.mesh.material = p.material;
    if (target !== undefined) this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.report.lastPasses++;
  }

  private bloomTargets(sizes: { w: number; h: number }[]): void {
    for (let i = 0; i < sizes.length; i++) {
      const { w, h } = sizes[i];
      for (const arr of [this.bloomDown, this.bloomUp]) {
        const t = arr[i];
        if (!t) arr[i] = this.hdrTarget(w, h);
        else if (t.width !== w || t.height !== h) t.setSize(w, h);
      }
    }
  }

  private texel(t: THREE.WebGLRenderTarget): number[] {
    return [1 / t.width, 1 / t.height, t.width, t.height];
  }

  private bakeLut(cg: PPEffect): void {
    const kw = tonemapKeyword(cg);
    const p = this.program('Hidden/PostProcessing/Lut2DBaker', 2, kw ? [kw] : []);
    if (!p) return;
    const params = lutBakerParams(cg);
    const curves = curvePixels(cg);
    const key = JSON.stringify([kw, params, Array.from(curves.slice(0, 512))]);
    if (!this.lut) this.lut = this.hdrTarget(1024, 32);
    if (key === this.lutKey) return;
    this.lutKey = key;
    if (!this.curves) {
      this.curves = new THREE.DataTexture(curves, 128, 2, THREE.RGBAFormat, THREE.FloatType);
      this.curves.minFilter = THREE.LinearFilter;
      this.curves.magFilter = THREE.LinearFilter;
      this.curves.wrapS = this.curves.wrapT = THREE.ClampToEdgeWrapping;
    } else (this.curves.image.data as Float32Array).set(curves);
    this.curves.needsUpdate = true;
    this.blit(p, this.lut, params, { _Curves: this.curves });
  }

  private nextRandom(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  /**
   * 跑一趟後製：source（攝影機畫好的 HDR）→ dest 的 viewport（主 target）。呼叫前 ensure 要回 true。
   * dest 的 viewport 由呼叫端設好（這裡最後一趟不改 target 的 viewport）。
   */
  render(frame: PostProcessFrame, dest: THREE.WebGLRenderTarget): void {
    const plan = this.plan(frame);
    const src = this.source!;
    const W = src.width;
    const H = src.height;
    this.report.lastPasses = 0;
    const r = this.renderer;
    const uberValues: Record<string, ArrayLike<number>> = {
      _UVTransform: [1, -1, 0, 1],
      _RenderViewportScaleFactor: [1],
      _ScreenParams: [W, H, 1 + 1 / W, 1 + 1 / H],
      _LumaInAlpha: [0],
    };
    const uberTex: Record<string, THREE.Texture | null> = { _MainTex: src.texture, _AutoExposureTex: this.white };
    const savedVp = dest.viewport.clone();
    const savedScissor = dest.scissorTest;
    if (plan.bloom) {
      const bp = bloomParams(frame.effects.Bloom, W, H);
      this.bloomTargets(bp.sizes);
      const fast = bp.fastMode ? 1 : 0;
      const pre = this.program('Hidden/PostProcessing/Bloom', fast, [])!;
      const down = this.program('Hidden/PostProcessing/Bloom', 2 + fast, [])!;
      const up = this.program('Hidden/PostProcessing/Bloom', 4 + fast, [])!;
      const common = { _RenderViewportScaleFactor: [1], _SampleScale: [bp.sampleScale], _Threshold: bp.threshold, _Params: bp.params };
      let last: THREE.WebGLRenderTarget = src;
      for (let i = 0; i < bp.iterations; i++) {
        this.blit(i === 0 ? pre : down, this.bloomDown[i], { ...common, _MainTex_TexelSize: this.texel(last) }, { _MainTex: last.texture, _AutoExposureTex: this.white });
        last = this.bloomDown[i];
      }
      for (let i = bp.iterations - 2; i >= 0; i--) {
        this.blit(up, this.bloomUp[i], { ...common, _MainTex_TexelSize: this.texel(last) }, { _MainTex: last.texture, _BloomTex: this.bloomDown[i].texture });
        last = this.bloomUp[i];
      }
      uberValues._Bloom_DirtTileOffset = bloomDirtTileOffset(W, H);
      uberValues._Bloom_Settings = bp.settings;
      uberValues._Bloom_Color = bp.color;
      uberValues._BloomTex_TexelSize = this.texel(last);
      uberTex._BloomTex = last.texture;
      uberTex._Bloom_DirtTex = this.black;
    }
    if (plan.vignette) {
      Object.assign(uberValues, vignetteParams(frame.effects.Vignette));
      uberTex._Vignette_Mask = this.white; // Masked 的遮罩貼圖沒接（差異清單；MT2 用 Classic）
    }
    if (plan.grading) {
      this.bakeLut(frame.effects.ColorGrading);
      const lut = this.lut!;
      uberValues._Lut2D_Params = [1 / lut.width, 1 / lut.height, lut.height - 1];
      uberValues._PostExposure = [Math.pow(2, num(frame.effects.ColorGrading.postExposure))];
      uberTex._Lut2D = lut.texture;
    }
    // Dithering.Render
    const noise = this.blueNoise.length ? this.blueNoise[(this.noiseIndex = (this.noiseIndex + 1) % this.blueNoise.length)] : null;
    const nw = (noise?.image as { width?: number } | undefined)?.width ?? 64;
    const nh = (noise?.image as { height?: number } | undefined)?.height ?? 64;
    uberValues._Dithering_Coords = [W / nw, H / nh, this.nextRandom(), this.nextRandom()];
    uberTex._DitheringTex = noise ?? this.grey();
    const uber = this.program('Hidden/PostProcessing/Uber', 0, plan.uber!)!;
    dest.viewport.copy(savedVp);
    dest.scissorTest = savedScissor;
    r.setRenderTarget(dest);
    this.blit(uber, undefined, uberValues, uberTex);
  }

  private greyTex: THREE.DataTexture | null = null;
  /** 藍噪聲還沒載到時：0.5 灰（Dithering 的偏移是 0） */
  private grey(): THREE.DataTexture {
    if (!this.greyTex) {
      this.greyTex = new THREE.DataTexture(new Uint8Array([128, 128, 128, 128]), 1, 1);
      this.greyTex.needsUpdate = true;
    }
    return this.greyTex;
  }

  dispose(): void {
    for (const t of [...this.bloomDown, ...this.bloomUp]) t.dispose();
    this.lut?.dispose();
    this.source?.dispose();
    this.curves?.dispose();
  }
}

/** BloomRenderer：dirt 貼圖（沒設時是 RuntimeUtilities.blackTexture，4×4）的長寬比對畫面的 tile／offset */
export function bloomDirtTileOffset(screenW: number, screenH: number, texW = 4, texH = 4): V4 {
  const ta = texW / texH;
  const sa = screenW / screenH;
  const v: V4 = [1, 1, 0, 0];
  if (ta > sa) {
    v[0] = sa / ta;
    v[2] = (1 - v[0]) * 0.5;
  } else if (sa > ta) {
    v[1] = ta / sa;
    v[3] = (1 - v[1]) * 0.5;
  }
  return v;
}

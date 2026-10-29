// 把 0e 轉出的 GLSL（public/game/shaders，D3D 慣例）接成 three.js 的 RawShaderMaterial。
//
// - pass：照 URP 2D Renderer 的 LightMode 選一個（Universal2D 優先，其次 UniversalForward、SRPDefaultUnlit、沒有標）。
//   Renderer2D 實際會畫哪些 LightMode、一個 shader 有多個符合的 pass 時會不會都畫，未查證；先只畫一個並記錄。
// - 變體：材質 keyword 只留該 stage 的 keyword 空間裡有的，再找 keyword 完全相同的（同 webgl-check.mjs）。
// - cbuffer：GLSL 裡原本是 UBO（`layout(std140) uniform cbX_yy_buf { vec4/uvec4 m[N]; } cbX_yy;`，版面同 D3D register）。
//   這裡在建構時把宣告改寫成普通的 uniform 陣列（`uniform vec4/uvec4 cbX_yy_m[N];`，存取同步改名），
//   照 index.json 的 byte offset 依名稱填進底層 ArrayBuffer，three.js 每個 draw 整塊上傳。
//   不用 UniformsGroup（UBO）的原因：three.js 對每個 UniformsGroup 實例永久佔用一個全域 binding point
//   （WebGLUniformsGroups.allocateBindingPointIndex），一個繪製物件一份材質 × 每份 4–6 個 block，幾十個 TMP 文字
//   就會爆 MAX_UNIFORM_BUFFER_BINDINGS（10/6 接上 TMP 後實測爆掉）。
//   uvec4 也直接寫 float：shader 用 uintBitsToFloat 讀回，位元一樣。矩陣是 column-major（m[0] 是第一欄，跟 three.js 一樣）。
// - 投影：餵 GL 慣例的投影矩陣（z ∈ [-1, 1]），shader 只做 VP × M × pos，不依賴 D3D 的 z 範圍。
//   view 矩陣照 Unity 的 worldToCameraMatrix：右手系、攝影機看 -z（= 翻轉 z × 攝影機世界矩陣的反矩陣）。
// - cull：D3D 是順時針為正面，GL 是逆時針，所以 Unity 的 Cull Back 對應 three.js 的 BackSide。
// - stencil：0e 輸出 Ref／ReadMask／WriteMask（可能綁材質屬性）；Comp／Pass 沒輸出，照 UI shader 的綁定讀
//   _StencilComp／_StencilOp（遊戲匯出的 TextMeshPro/Distance Field：Pass [_StencilOp]、Comp [_StencilComp]，
//   Fail／ZFail 沒綁屬性 → Keep；../../DiCEOMANCER-Swift/extracted_data/ar_fullver_shaders/ExportedProject/Assets/
//   Shader/TextMeshPro_Distance Field_1.asset:1060-1107）。Mask 的 stencil 裁切算出來的那組值
//   （ui/mask.ts 的 StencilState）就是寫進這幾個 float 的，所以這裡讀 float 等於讀 Unity 的實效 render state。
// - 填不到的欄位補 0，記在 unfilled 裡。

import * as THREE from 'three';
import { isDefaultStencil, stencilFromMaterial, type StencilState } from '../ui/mask';

export interface ShaderVariant {
  index: number;
  keywords: string[];
  converted: boolean;
  files: { glsl?: string };
  uniformBlocks?: Record<string, { block: string; instance: string; slot: number }>;
  reflection?: { ubos?: { name: string; block_size: number }[] };
  vertexInputs?: { name: string; location: number; type: string; semantic: string; index: number }[];
  /** 這個變體自己的參數表（0e 第三輪加，解參數 blob）。沒有就退回 stage 共用的，那份缺變體特有的欄位 */
  parameters?: ShaderStage['parameters'];
}

interface CBufferField {
  name: string;
  offset: number;
  dim?: number;
  rows?: number;
  arraySize: number;
}

export interface ShaderStage {
  variants: ShaderVariant[];
  parameters: {
    constantBuffers: { name: string; size: number; vectors: CBufferField[]; matrices: CBufferField[] }[];
    textures: { name: string; register: number; samplerRegister: number; dim: number }[];
  };
}

export interface ShaderPass {
  index: number;
  name: string;
  /** PassType（shaders/convert.py）：0 Normal、1 Use、2 Grab。舊的轉換結果沒有這欄（當 Normal） */
  type?: number;
  /** GrabPass 抓進哪張貼圖：空字串是 _GrabTexture、每個物件各抓一次；有名字的每格只在第一個用到的物件抓一次 */
  textureName?: string;
  tags: Record<string, string | boolean>;
  state: {
    blend: { src: number | { val: number; prop: string }; dst: number | { val: number; prop: string }; srcAlpha: number | { val: number; prop: string }; dstAlpha: number | { val: number; prop: string }; op: number | { val: number; prop: string }; opAlpha: number | { val: number; prop: string } };
    culling: number | { val: number; prop: string };
    colorMask: number | { val: number; prop: string };
    zWrite: number | { val: number; prop: string };
    zTest: number | { val: number; prop: string };
    stencilRef?: number | { val: number; prop: string };
    stencilReadMask?: number | { val: number; prop: string };
    stencilWriteMask?: number | { val: number; prop: string };
  };
  stages: { vertex?: ShaderStage; fragment?: ShaderStage };
}

export interface ShaderIndex {
  name: string;
  stem: string;
  properties: { name: string; type: number; flags: number; defaultValue: number[]; defaultTexture: string | null }[];
  subShaders: { index: number; tags: Record<string, string | boolean>; passes: ShaderPass[] }[];
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}：HTTP ${res.status}`);
  return res.text();
}

export class ShaderLibrary {
  private indexCache = new Map<string, Promise<ShaderIndex>>();
  private sourceCache = new Map<string, Promise<string>>();

  private constructor(
    readonly base: string,
    private names: Record<string, string>,
  ) {}

  static async load(base: string): Promise<ShaderLibrary> {
    // 遊戲還沒有轉好的 shader 時沒有 index.json：dev server 會回 index.html（200），所以看 content-type
    const res = await fetch(`${base}index.json`);
    const names = res.ok && (res.headers.get('content-type') ?? '').includes('json') ? ((await res.json()) as Record<string, string>) : {};
    return new ShaderLibrary(base, names);
  }

  has(name: string | null): boolean {
    return !!name && name in this.names;
  }

  index(name: string): Promise<ShaderIndex> {
    let p = this.indexCache.get(name);
    if (!p) {
      const stem = this.names[name];
      p = fetch(`${this.base}${encodeURIComponent(stem)}/index.json`).then((r) => r.json() as Promise<ShaderIndex>);
      this.indexCache.set(name, p);
    }
    return p;
  }

  source(stem: string, file: string): Promise<string> {
    const key = `${stem}/${file}`;
    let p = this.sourceCache.get(key);
    if (!p) {
      p = fetchText(`${this.base}${encodeURIComponent(stem)}/${encodeURIComponent(file)}`);
      this.sourceCache.set(key, p);
    }
    return p;
  }
}

const LIGHTMODE_ORDER = ['Universal2D', 'UniversalForward', 'SRPDefaultUnlit', ''];
/**
 * built-in 的前向繪製（Unity 文件 Pass tags 的 LightMode）：ForwardBase（主方向光、環境光、SH）；沒有 ForwardBase 的 shader 畫
 * 沒標 LightMode 或標 Always 的 pass（不打光）。ForwardAdd（其他逐像素光，一盞一次）、ShadowCaster、Deferred、Meta 不畫。
 * Unity 的 tag 值不分大小寫（遊戲匯出的是 FORWARDBASE 大寫），比對時轉大寫。
 * 一個 shader 有多個要畫的 pass（例如兩個沒標的 pass）時 Unity 依序都畫：uGUI 的 Image 照 drawPasses 都畫，其他繪製物件只畫第一個（差異清單）。
 */
const BUILTIN_LIGHTMODE_ORDER = ['FORWARDBASE', '', 'ALWAYS'];

export type Pipeline = 'srp' | 'builtin';

export function choosePass(index: ShaderIndex, pipeline: Pipeline = 'srp'): ShaderPass | null {
  // GrabPass 沒有程式（只抓畫面），不是可畫的 pass；以前 built-in 的空 LightMode 會先撞到它（Particles/Standard Unlit 的 pass 0），變成「變體沒轉出」
  const passes = (index.subShaders[0]?.passes ?? []).filter((x) => x.type !== 2);
  if (pipeline === 'builtin') {
    for (const mode of BUILTIN_LIGHTMODE_ORDER) {
      const p = passes.find((x) => String(x.tags.LIGHTMODE ?? '').toUpperCase() === mode);
      if (p) return p;
    }
    return null;
  }
  for (const mode of LIGHTMODE_ORDER) {
    const p = passes.find((x) => ((x.tags.LIGHTMODE as string) ?? '') === mode);
    if (p) return p;
  }
  return null;
}

/** LightMode 的分組：built-in 沒標與 Always 都是不打光的 pass，算同一種（大小寫不分） */
function lightModeGroup(p: ShaderPass): string {
  const m = String(p.tags.LIGHTMODE ?? '').toUpperCase();
  return m === 'ALWAYS' ? '' : m;
}
/**
 * 一個物件要依序畫的 pass：choosePass 挑的那個，加上它後面同一種 LightMode 的 pass（照 shader 裡的順序；GrabPass 不算）。
 * Unity 畫物件時把同一種 LightMode 的 pass 依序都畫（Pass tags 手冊）。MT2 的 Shiny Shoe/CardEffects 有兩個沒標的 pass：
 * PASS_1 畫第 1～5 層（一般混色）、PASS_2 畫第 6～9 層（加法混色），以前只畫 PASS_1，縱火犯（Firestarter）的主圖在第 6 層，整張只剩背景
 */
export function drawPasses(index: ShaderIndex, pipeline: Pipeline = 'srp'): ShaderPass[] {
  const first = choosePass(index, pipeline);
  if (!first) return [];
  const group = lightModeGroup(first);
  const passes = (index.subShaders[0]?.passes ?? []).filter((x) => x.type !== 2);
  return [first, ...passes.filter((x) => x.index > first.index && lightModeGroup(x) === group)];
}

/**
 * UnityEngine.Rendering.CompareFunction（Disabled 0、Never 1、Less 2、Equal 3、LessEqual 4、Greater 5、NotEqual 6、GreaterEqual 7、
 * Always 8）→ three.js 的 depthFunc。Disabled 與 Always 是不測（depthTest 關掉）
 */
const DEPTH_FUNCS: Record<number, THREE.DepthModes> = {
  1: THREE.NeverDepth,
  2: THREE.LessDepth,
  3: THREE.EqualDepth,
  4: THREE.LessEqualDepth,
  5: THREE.GreaterDepth,
  6: THREE.NotEqualDepth,
  7: THREE.GreaterEqualDepth,
};

export function chooseVariant(stage: ShaderStage | undefined, keywords: string[]): ShaderVariant | null {
  if (!stage) return null;
  const space = new Set(stage.variants.flatMap((v) => v.keywords));
  const target = keywords.filter((k) => space.has(k));
  const exact = stage.variants.find((v) => v.keywords.length === target.length && v.keywords.every((k) => target.includes(k)));
  if (exact) return exact;
  // build 裡沒有剛好的變體（打包時被剝掉）：Unity 沒開「嚴格變體比對」時改用最接近的那個（Unity 2022 文件 Shader variant
  // matching；挑法的細節未查證）。這裡挑跟目標相同的 keyword 最多的，同分挑多出來的 keyword 最少的
  //（MT2 的 CharacterShader2.0 Graph：build 只留了帶 _ADDITIONAL_OFF 的變體，目標沒有這個 keyword）。
  // 選中的 keyword 跟目標不同，呼叫端從 variant.keywords 看得出來
  let best: ShaderVariant | null = null;
  let bestHit = -1;
  let bestExtra = Infinity;
  for (const v of stage.variants) {
    const hit = v.keywords.filter((k) => target.includes(k)).length;
    const extra = v.keywords.length - hit;
    if (hit > bestHit || (hit === bestHit && extra < bestExtra)) {
      best = v;
      bestHit = hit;
      bestExtra = extra;
    }
  }
  return best;
}

/** render state 的值：數字，或綁材質屬性的 {val, prop} */
export function stateValue(v: number | { val: number; prop: string }, floats: Record<string, number>): number {
  if (typeof v === 'number') return v;
  return v.prop in floats ? floats[v.prop] : v.val;
}

const BLEND_FACTORS: Record<number, THREE.BlendingSrcFactor> = {
  0: THREE.ZeroFactor,
  1: THREE.OneFactor,
  2: THREE.DstColorFactor,
  3: THREE.SrcColorFactor,
  4: THREE.OneMinusDstColorFactor,
  5: THREE.SrcAlphaFactor,
  6: THREE.OneMinusSrcColorFactor,
  7: THREE.DstAlphaFactor,
  8: THREE.OneMinusDstAlphaFactor,
  9: THREE.SrcAlphaSaturateFactor,
  10: THREE.OneMinusSrcAlphaFactor,
};
const BLEND_OPS: Record<number, THREE.BlendingEquation> = {
  0: THREE.AddEquation,
  1: THREE.SubtractEquation,
  2: THREE.ReverseSubtractEquation,
  3: THREE.MinEquation,
  4: THREE.MaxEquation,
};

/**
 * UnityEngine.Rendering.CompareFunction（reference/decompiled/UnityEngine.CoreModule/UnityEngine.Rendering/
 * CompareFunction.cs：Disabled 0、Never 1、Less 2、Equal 3、LessEqual 4、Greater 5、NotEqual 6、GreaterEqual 7、
 * Always 8）→ GL 的 stencil func（NEVER 512 … ALWAYS 519，即 511 + 列舉值）。Disabled 沒有對應的 GL func：
 * 它是「不測」，由 applyStencilState 關掉 stencilWrite 表達。
 */
const STENCIL_FUNCS = [THREE.AlwaysStencilFunc, THREE.NeverStencilFunc, THREE.LessStencilFunc, THREE.EqualStencilFunc, THREE.LessEqualStencilFunc, THREE.GreaterStencilFunc, THREE.NotEqualStencilFunc, THREE.GreaterEqualStencilFunc, THREE.AlwaysStencilFunc];

/** UnityEngine.Rendering.StencilOp（StencilOp.cs：Keep 0、Zero 1、Replace 2、IncrementSaturate 3、
 *  DecrementSaturate 4、Invert 5、IncrementWrap 6、DecrementWrap 7）→ GL 的 stencil op */
const STENCIL_OPS = [THREE.KeepStencilOp, THREE.ZeroStencilOp, THREE.ReplaceStencilOp, THREE.IncrementStencilOp, THREE.DecrementStencilOp, THREE.InvertStencilOp, THREE.IncrementWrapStencilOp, THREE.DecrementWrapStencilOp];

/**
 * 把 Unity 的 stencil render state 套到 three.js 材質上（手寫 shader 與 K3 shader 共用）。
 * three.js 是「stencilWrite ＝ true 才開 stencil test」（WebGLState：setTest(material.stencilWrite)，
 * 之後才 setMask／setFunc／setOp），所以 writeMask 0 也要把 stencilWrite 開起來，測試才會跑。
 * 深度測試在這個 renderer 裡一律關掉，GL 的 stencil 用 zPass 那個 op。
 * colorWrite（_ColorMask）不在這裡：three.js 的 Material.colorWrite 只有開／關，Unity 的 ColorWriteMask 可以
 * 只開某幾個通道；這個專案的 Mask 只用 0 與 All（15），由呼叫端設。
 */
export function applyStencilState(material: THREE.Material, s: StencilState): void {
  // Comp Always＋Pass Keep＋ref 0（＝沒有遮罩時的預設）跟 Comp Disabled 一樣不作用，不開 stencil test
  const noop = isDefaultStencil(s) || s.comp === 0;
  material.stencilWrite = !noop;
  material.stencilFunc = STENCIL_FUNCS[s.comp] ?? THREE.AlwaysStencilFunc;
  material.stencilRef = s.ref | 0;
  material.stencilFuncMask = s.readMask; // gl.stencilFunc 的第三個參數是 read mask
  material.stencilWriteMask = s.writeMask;
  // UI shader 的 Fail／ZFail 沒綁材質屬性（TextMeshPro_Distance Field_1.asset:1064-1069 的 name 是 '<noninit>'、val 0＝Keep）
  material.stencilFail = THREE.KeepStencilOp;
  material.stencilZFail = THREE.KeepStencilOp;
  material.stencilZPass = STENCIL_OPS[s.op] ?? THREE.KeepStencilOp;
}

/** 一個 cbuffer 對應的 uniform 陣列：Float32Array 資料（寫入用）＋ GLSL 裡的 uniform 名稱（<instance>_m） */
export interface BlockBinding {
  cbuffer: string;
  data: Float32Array;
  uniformName: string;
  fields: CBufferField[];
}

export type FieldResolver = (name: string, length: number) => ArrayLike<number> | null;

/** 依名稱填一個 cbuffer。回傳填不到的欄位名稱 */
export function fillBlock(b: BlockBinding, resolve: FieldResolver): string[] {
  const unfilled: string[] = [];
  b.data.fill(0);
  for (const f of b.fields) {
    const length = f.rows ? 16 : (f.dim ?? 4);
    const v = resolve(f.name, length);
    if (!v) {
      unfilled.push(f.name);
      continue;
    }
    const start = f.offset / 4;
    for (let i = 0; i < Math.min(length, v.length) && start + i < b.data.length; i++) b.data[start + i] = v[i];
  }
  return unfilled;
}

/**
 * GLSL 取樣器要的貼圖 target。一個貼圖只能綁在建立時的 target 上：sampler2DArray 綁 2D 貼圖，WebGL 丟
 * INVALID_OPERATION（bindTexture: textures can not be used with multiple targets），那次取樣讀不到東西。
 * Shadow 版跟一般版同一個 target（sampler2DShadow 是 2D）；轉出的 GLSL 裡還有 sampler2DMS（GLSL ES 3.00 沒有），歸 other。
 */
export type SamplerKind = '2D' | '2DArray' | '3D' | 'Cube' | 'other';

/** uniform 在 GLSL 裡的取樣器對應的 target；沒宣告（編譯時被拿掉）當 2D，three.js 本來就不會綁 */
function samplerKindOf(src: string, uniform: string): SamplerKind {
  const m = src.match(new RegExp(`uniform\\s+(?:(?:highp|mediump|lowp)\\s+)?(\\w+)\\s+${uniform}\\s*;`));
  if (!m) return '2D';
  const k = m[1].match(/^[iu]?sampler(2DArray|2D|3D|Cube)(?:Shadow)?$/);
  return k ? (k[1] as SamplerKind) : 'other';
}

export interface UnityProgram {
  material: THREE.RawShaderMaterial;
  blocks: BlockBinding[];
  textures: { uniform: string; property: string; defaultTexture: string | null; sampler: SamplerKind }[];
  vertexInputs: NonNullable<ShaderVariant['vertexInputs']>;
  pass: ShaderPass;
  shader: ShaderIndex;
  /** 實際選到的 FS 變體 keyword */
  keywords: string[];
  /**
   * 同一個 SubShader 裡排在這個 pass 前面的 GrabPass（Unity 照順序跑每個 pass：先把目前的畫面抓進貼圖，下一個 pass 再取樣）。
   * texture 是 shader 取樣的屬性名，perObject：沒取名的 GrabPass 每個物件畫之前各抓一次；取了名的每格只抓一次（Unity 手冊 GrabPass）
   */
  grab: { texture: string; perObject: boolean } | null;
}

/** 選到的 pass 前面的 GrabPass（有多個時取最靠近的那個） */
export function grabBefore(shader: ShaderIndex, pass: ShaderPass): UnityProgram['grab'] {
  const passes = shader.subShaders.find((ss) => ss.passes.includes(pass))?.passes ?? [];
  let found: ShaderPass | null = null;
  for (const p of passes) {
    if (p === pass) break;
    if (p.type === 2) found = p;
  }
  if (!found) return null;
  const name = found.textureName ?? '';
  return { texture: name || '_GrabTexture', perObject: !name };
}

function stripVersion(src: string): string {
  return src.replace(/^\s*#version[^\n]*\n/, '');
}

/**
 * clip 空間的 z：原版的 shader 是 DX11 bytecode，Unity 在 D3D 上給的投影矩陣是反向深度（GL.GetGPUProjectionMatrix：
 * near 的 clip z ＝ w、far ＝ 0；sceneRenderer.ts 的 d3dProjection）。shader 裡拿 clip z 算東西的地方照這個慣例寫死，
 * 例如霧的距離 UNITY_Z_0_FAR_FROM_CLIPSPACE ＝ max((1 − z/near)·far, 0)（Shader Graphs/CharacterShader2.0 的 FOG_LINEAR 變體）。
 * vertex shader 照 D3D 算完，最後換回 GL 的 [−w, w]：z_gl ＝ w − 2·z_d3d（跟 three.js 的投影算出來的深度相同）
 */
export function d3dClipToGl(src: string): string {
  const renamed = src.replace(/\bvoid\s+main\s*\(\s*\)/, 'void main_d3d()');
  if (renamed === src) return src;
  return `${renamed}\nvoid main()\n{\n    main_d3d();\n    gl_Position.z = gl_Position.w - 2.0 * gl_Position.z;\n}\n`;
}

/**
 * 把 K3 GLSL 的 UBO 宣告改成普通 uniform 陣列（原因見檔頭）。
 * 3150 個轉出的 GLSL 全部是同一種形狀（10/6 掃過，4707 個宣告，只有 vec4／uvec4 兩種、可帶 highp）：
 *   layout(std140) uniform cb0_vs_buf\n{\n    uvec4 m[33];\n} cb0_vs;
 * 改成 `uniform uvec4 cb0_vs_m[33];`，並把 `cb0_vs.m[...]` 的存取改成 `cb0_vs_m[...]`。
 * 回傳每個 block 的 instance 名稱與型別（建 uniforms 用）；有殘留的 std140 宣告（形狀不認得）照樣回傳，由呼叫端記錄。
 */
function uboToUniformArrays(src: string): { src: string; blocks: { instance: string; vectype: string }[]; leftover: number } {
  const blocks: { instance: string; vectype: string }[] = [];
  let out = src.replace(/layout\(std140\)\s+uniform\s+\w+\s*\{\s*(?:highp\s+)?(uvec4|ivec4|vec4)\s+m\[\d+\]\s*;\s*\}\s*(\w+)\s*;/g, (_whole, vectype: string, instance: string) => {
    blocks.push({ instance, vectype });
    const decl = _whole.match(/m\[(\d+)\]/)![1];
    return `uniform ${vectype} ${instance}_m[${decl}];`;
  });
  for (const b of blocks) out = out.replace(new RegExp(`\\b${b.instance}\\.m\\b`, 'g'), `${b.instance}_m`);
  const leftover = (out.match(/layout\(std140\)\s+uniform/g) ?? []).length;
  return { src: out, blocks, leftover };
}

/** 建立一個繪製用的材質（每個繪製物件各一個：UnityPerDraw 每個物件不同） */
export async function createProgram(
  lib: ShaderLibrary,
  shaderName: string,
  keywords: string[],
  floats: Record<string, number>,
  pipeline: Pipeline = 'srp',
  /** 指定第幾個 pass（Skybox/6 Sided 一個 pass 畫一面）；沒給照 choosePass 挑 */
  passIndex?: number,
): Promise<UnityProgram | { error: string }> {
  const shader = await lib.index(shaderName);
  const pass = passIndex !== undefined ? (shader.subShaders[0]?.passes[passIndex] ?? null) : choosePass(shader, pipeline);
  if (!pass) return { error: `${shaderName}：沒有可畫的 pass` };
  const vs = chooseVariant(pass.stages.vertex, keywords);
  const fs = chooseVariant(pass.stages.fragment, keywords);
  if (!vs?.converted || !fs?.converted || !vs.files.glsl || !fs.files.glsl) return { error: `${shaderName} [${pass.name}]：變體沒轉出` };
  const [vsSrcRaw, fsSrcRaw] = await Promise.all([lib.source(shader.stem, vs.files.glsl), lib.source(shader.stem, fs.files.glsl)]);
  const vsT = uboToUniformArrays(vsSrcRaw);
  const fsT = uboToUniformArrays(fsSrcRaw);
  const vectypeOf = new Map<string, string>();
  for (const b of [...vsT.blocks, ...fsT.blocks]) vectypeOf.set(b.instance, b.vectype);
  const leftover = vsT.leftover + fsT.leftover;

  const blocks: BlockBinding[] = [];
  const uniforms: Record<string, THREE.IUniform> = {};
  const addBlocks = (stage: ShaderStage, v: ShaderVariant) => {
    for (const cb of (v.parameters ?? stage.parameters).constantBuffers) {
      const ub = v.uniformBlocks?.[cb.name];
      if (!ub) continue;
      const size = v.reflection?.ubos?.find((u) => u.name === ub.block)?.block_size ?? cb.size;
      // 底層一塊 ArrayBuffer：fillBlock 寫 float，uniform 上傳照 GLSL 宣告的型別（uvec4 用 Uint32Array 視圖，位元不變）
      const buf = new ArrayBuffer(Math.ceil(size / 16) * 16);
      const data = new Float32Array(buf);
      const vectype = vectypeOf.get(ub.instance);
      if (!vectype) continue; // GLSL 裡沒有這個 block 的宣告（形狀不認得）— leftover 會記
      const uniformName = `${ub.instance}_m`;
      uniforms[uniformName] = { value: vectype === 'vec4' ? data : vectype === 'uvec4' ? new Uint32Array(buf) : new Int32Array(buf) };
      blocks.push({ cbuffer: cb.name, data, uniformName, fields: [...cb.vectors, ...cb.matrices] });
    }
  };
  addBlocks(pass.stages.vertex!, vs);
  addBlocks(pass.stages.fragment!, fs);

  // 取樣器的 uniform 名稱是 spirv-cross 照「貼圖暫存器＋取樣器暫存器」組的。參數表的 samplerRegister 有時是 null（共用別的貼圖的
  // 取樣器，例如 unity_SpecCube1 用 samplerunity_SpecCube0；Shader Graph 的 _MainTex 也有），照 null 組出來的名字（t3snull）在 GLSL 裡不存在，
  // 貼圖就沒綁上。這種照 GLSL 的宣告找這個貼圖暫存器實際配到的取樣器（可能不只一個）
  const textures = ((fs.parameters ?? pass.stages.fragment?.parameters)?.textures ?? []).flatMap((t) => {
    let uniforms = [`SPIRV_Cross_Combinedt${t.register}s${t.samplerRegister}`];
    if (t.samplerRegister == null) {
      const found = [...fsT.src.matchAll(new RegExp(`uniform\\s+(?:(?:highp|mediump|lowp)\\s+)?\\w+\\s+(SPIRV_Cross_Combinedt${t.register}s\\d+)\\s*;`, 'g'))].map((m) => m[1]);
      if (found.length) uniforms = found;
    }
    return uniforms.map((uniform) => ({
      uniform,
      property: t.name,
      defaultTexture: shader.properties.find((p) => p.name === t.name)?.defaultTexture ?? null,
      sampler: samplerKindOf(fsT.src, uniform),
    }));
  });
  for (const t of textures) uniforms[t.uniform] = { value: null };

  const st = pass.state;
  // 綁屬性的 render state 讀材質的值；材質沒有這個屬性時用 shader 宣告的預設值（Unity 建材質時從 shader 屬性補，
  // Float 2、Range 3、Int 5），都沒有才用 state 裡存的值
  const stateFloats: Record<string, number> = {};
  for (const p of shader.properties) if (p.type === 2 || p.type === 3 || p.type === 5) stateFloats[p.name] = p.defaultValue[0];
  Object.assign(stateFloats, floats);
  const cull = stateValue(st.culling, stateFloats);
  // stencil：Ref／ReadMask／WriteMask 讀 0e 輸出的 render state（綁屬性的讀 stateFloats，寫死的讀 val）；
  // Comp／Pass 0e 沒輸出（scripts/shaders/convert.py 的 pass_state 只留三項），照 UI shader 的綁定
  // 讀 _StencilComp／_StencilOp（檔頭「stencil」那條；沒有這兩個屬性的 shader 拿到 Always／Keep ＝ 不作用）
  const stencil: StencilState = {
    ...stencilFromMaterial(stateFloats, fs.keywords),
    ref: stateValue(st.stencilRef ?? 0, stateFloats),
    readMask: stateValue(st.stencilReadMask ?? 255, stateFloats),
    writeMask: stateValue(st.stencilWriteMask ?? 255, stateFloats),
  };
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: d3dClipToGl(stripVersion(vsT.src)),
    fragmentShader: stripVersion(fsT.src),
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: cull === 2 ? THREE.BackSide : cull === 1 ? THREE.FrontSide : THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendSrc: BLEND_FACTORS[stateValue(st.blend.src, stateFloats)],
    blendDst: BLEND_FACTORS[stateValue(st.blend.dst, stateFloats)] as THREE.BlendingDstFactor,
    blendSrcAlpha: BLEND_FACTORS[stateValue(st.blend.srcAlpha, stateFloats)],
    blendDstAlpha: BLEND_FACTORS[stateValue(st.blend.dstAlpha, stateFloats)] as THREE.BlendingDstFactor,
    blendEquation: BLEND_OPS[stateValue(st.blend.op, stateFloats)] ?? THREE.AddEquation,
    blendEquationAlpha: BLEND_OPS[stateValue(st.blend.opAlpha, stateFloats)] ?? THREE.AddEquation,
    colorWrite: stateValue(st.colorMask, stateFloats) !== 0,
  });
  applyStencilState(material, stencil);
  if (pipeline === 'builtin') {
    // built-in 照 pass 的 ZTest／ZWrite（可能綁材質屬性，例如 Shader Graph 的 _BUILTIN_ZTest）。srp 的 2D 照排序畫，不測深度
    const zt = stateValue(st.zTest, stateFloats);
    material.depthTest = zt in DEPTH_FUNCS;
    material.depthFunc = DEPTH_FUNCS[zt] ?? THREE.AlwaysDepth;
    material.depthWrite = stateValue(st.zWrite, stateFloats) !== 0;
  }
  if (leftover > 0) console.warn(`${shaderName}：${leftover} 個 cbuffer 宣告形狀不認得，沒轉成 uniform 陣列`);
  return { material, blocks, textures, vertexInputs: vs.vertexInputs ?? [], pass, shader, keywords: fs.keywords, grab: grabBefore(shader, pass) };
}

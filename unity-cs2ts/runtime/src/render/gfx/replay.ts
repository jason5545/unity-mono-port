// render thread 的重播（2026/10/18）：照 client.ts 寫的指令順序呼叫真的 WebGL2（worker 的 OffscreenCanvas context）。
// 每筆指令對應一個 gl.* 呼叫，參數照原樣；只有兩個地方多做事，結果跟原本一樣：
//   - 貼圖的位元組資料只抄了 GL 讀得到的範圍時（skipCleared），上傳前 UNPACK_SKIP_* 暫時歸零、上傳後還原；
//   - 長度是 0 的陣列另外處理（WebGL2 的 srcLength 0 代表「到尾端」，重播時會讀到後面的指令）。

import type { JobReader, ParticleJobRunner } from './particleJobs';
import { KIND, OP, PROP, SRC } from './protocol';

const UNPACK_SKIP_ROWS = 0x0cf3;
const UNPACK_SKIP_PIXELS = 0x0cf4;
const UNPACK_SKIP_IMAGES = 0x806d;

const EMPTY_F32 = new Float32Array(0);
const EMPTY_I32 = new Int32Array(0);
const EMPTY_U32 = new Uint32Array(0);

const utf8 = new TextDecoder();

type GL = WebGL2RenderingContext;
type Source = TexImageSource | VideoFrame;

/** client.ts 的 viewKind → 重建同一種 view */
function makeView(kind: number, buf: ArrayBuffer, byteOffset: number, byteLength: number): ArrayBufferView {
  switch (kind) {
    case 1:
      return new Int8Array(buf, byteOffset, byteLength);
    case 3:
      return new Uint8ClampedArray(buf, byteOffset, byteLength);
    case 4:
      return new Int16Array(buf, byteOffset, byteLength >> 1);
    case 5:
      return new Uint16Array(buf, byteOffset, byteLength >> 1);
    case 6:
      return new Int32Array(buf, byteOffset, byteLength >> 2);
    case 7:
      return new Uint32Array(buf, byteOffset, byteLength >> 2);
    case 8:
      return new Float32Array(buf, byteOffset, byteLength >> 2);
    default:
      return new Uint8Array(buf, byteOffset, byteLength);
  }
}

export interface ReplayOptions {
  /** RESIZE 改的繪圖緩衝（worker 的 OffscreenCanvas） */
  canvas?: { width: number; height: number } | null;
  /** 粒子網格工作（SIM_DEF、SIM_STATE、PARTICLE_JOB、BUFFER_SUB_DATA_JOB） */
  jobs?: ParticleJobRunner | null;
}

export class GfxReplayer {
  /** 編號 → WebGL 物件或 WebGLUniformLocation */
  private readonly objs: unknown[] = [];
  private readonly exts = new Map<string, Record<string, unknown> | null>();
  /** UNPACK_SKIP_*（skipCleared 的上傳之後還原） */
  private skipRows = 0;
  private skipPixels = 0;
  private skipImages = 0;
  /** 統計（除錯用） */
  readonly stats = { segments: 0, commands: 0 };

  constructor(
    readonly gl: GL,
    private readonly opts: ReplayOptions = {},
  ) {}

  private o<T>(id: number): T {
    return (id ? this.objs[id] : null) as T;
  }

  /**
   * 執行一段。ext：這一段附帶的 ImageBitmap／VideoFrame；images：這一段影像清單（SegmentImage）解碼好的點陣圖（解不出來的是 null）
   */
  run(buf: ArrayBuffer, words: number, ext: readonly Source[] = [], images: readonly (Source | null)[] = []): void {
    const gl = this.gl;
    const i32 = new Int32Array(buf, 0, words);
    const u32 = new Uint32Array(buf, 0, words);
    const f32 = new Float32Array(buf, 0, words);
    const u8 = new Uint8Array(buf, 0, words * 4);
    const f64 = new Float64Array(buf, 0, buf.byteLength >> 3);
    let p = 0;
    const reader: JobReader = {
      i32: () => i32[p++],
      u32s: (n) => {
        const v = u32.subarray(p, p + n);
        p += n;
        return v;
      },
      f32s: (n) => {
        const v = f32.subarray(p, p + n);
        p += n;
        return v;
      },
      double: () => {
        if (p & 1) p++;
        const v = f64[p >> 1];
        p += 2;
        return v;
      },
    };
    const jobs = (): ParticleJobRunner => {
      if (!this.opts.jobs) throw new Error('render thread：有粒子網格工作的指令，重播端沒有 ParticleJobRunner');
      return this.opts.jobs;
    };
    let n = 0;
    const str = (): string => {
      const len = u32[p++];
      const s = utf8.decode(u8.subarray(p * 4, p * 4 + len));
      p += (len + 3) >> 2;
      return s;
    };
    /** [byteLength][bytes]：回傳 [起點位元組, 長度] */
    const bytes = (): [number, number] => {
      const len = u32[p++];
      const at = p * 4;
      p += (len + 3) >> 2;
      return [at, len];
    };
    const source = (kind: number, index: number): Source | null => {
      if (kind === SRC.EXT) return ext[index] ?? null;
      return images[index] ?? null;
    };
    /** [viewKind][skipCleared][bytes] → view；skipCleared 時 SKIP 歸零（上傳後呼叫 restore） */
    const pixels = (is3d: boolean): { view: ArrayBufferView; cleared: boolean } => {
      const kind = i32[p++];
      const cleared = i32[p++] === 1;
      const [at, len] = bytes();
      if (cleared) {
        if (this.skipRows) gl.pixelStorei(UNPACK_SKIP_ROWS, 0);
        if (this.skipPixels) gl.pixelStorei(UNPACK_SKIP_PIXELS, 0);
        if (is3d && this.skipImages) gl.pixelStorei(UNPACK_SKIP_IMAGES, 0);
      }
      return { view: makeView(kind, buf, at, len), cleared };
    };
    const restore = (cleared: boolean, is3d: boolean): void => {
      if (!cleared) return;
      if (this.skipRows) gl.pixelStorei(UNPACK_SKIP_ROWS, this.skipRows);
      if (this.skipPixels) gl.pixelStorei(UNPACK_SKIP_PIXELS, this.skipPixels);
      if (is3d && this.skipImages) gl.pixelStorei(UNPACK_SKIP_IMAGES, this.skipImages);
    };
    while (p < words) {
      const op = i32[p++];
      n++;
      switch (op) {
        case OP.CREATE: {
          const kind = i32[p++];
          const id = i32[p++];
          let obj: unknown = null;
          switch (kind) {
            case KIND.BUFFER:
              obj = gl.createBuffer();
              break;
            case KIND.TEXTURE:
              obj = gl.createTexture();
              break;
            case KIND.FRAMEBUFFER:
              obj = gl.createFramebuffer();
              break;
            case KIND.RENDERBUFFER:
              obj = gl.createRenderbuffer();
              break;
            case KIND.PROGRAM:
              obj = gl.createProgram();
              break;
            case KIND.SHADER:
              obj = gl.createShader(i32[p++]);
              break;
            case KIND.VERTEX_ARRAY:
              obj = gl.createVertexArray();
              break;
            case KIND.QUERY:
              obj = gl.createQuery();
              break;
            case KIND.SAMPLER:
              obj = gl.createSampler();
              break;
          }
          this.objs[id] = obj;
          break;
        }
        case OP.DELETE: {
          const kind = i32[p++];
          const id = i32[p++];
          const obj = this.objs[id] as never;
          switch (kind) {
            case KIND.BUFFER:
              gl.deleteBuffer(obj);
              break;
            case KIND.TEXTURE:
              gl.deleteTexture(obj);
              break;
            case KIND.FRAMEBUFFER:
              gl.deleteFramebuffer(obj);
              break;
            case KIND.RENDERBUFFER:
              gl.deleteRenderbuffer(obj);
              break;
            case KIND.PROGRAM:
              gl.deleteProgram(obj);
              break;
            case KIND.SHADER:
              gl.deleteShader(obj);
              break;
            case KIND.VERTEX_ARRAY:
              gl.deleteVertexArray(obj);
              break;
            case KIND.QUERY:
              gl.deleteQuery(obj);
              break;
            case KIND.SAMPLER:
              gl.deleteSampler(obj);
              break;
          }
          this.objs[id] = undefined;
          break;
        }
        case OP.UNIFORM_LOCATION: {
          const prog = this.o<WebGLProgram>(i32[p++]);
          const id = i32[p++];
          this.objs[id] = gl.getUniformLocation(prog, str());
          break;
        }
        case OP.ENABLE_EXTENSION: {
          const name = str();
          this.exts.set(name, gl.getExtension(name) as Record<string, unknown> | null);
          break;
        }
        case OP.EXTENSION_CALL: {
          const name = str();
          const method = str();
          const argc = i32[p++];
          const args: number[] = [];
          for (let k = 0; k < argc; k++) args.push(f32[p++]);
          const ext = this.exts.get(name) ?? (gl.getExtension(name) as Record<string, unknown> | null);
          (ext?.[method] as ((...a: number[]) => void) | undefined)?.apply(ext, args);
          break;
        }
        case OP.RESIZE: {
          const which = i32[p++];
          const v = i32[p++];
          const c = this.opts.canvas;
          if (c) {
            if (which === 0) c.width = v;
            else c.height = v;
          }
          break;
        }
        case OP.SET_PROP: {
          const which = i32[p++];
          const v = str();
          const g = gl as unknown as Record<string, unknown>;
          if (which === PROP.drawingBufferColorSpace) g.drawingBufferColorSpace = v;
          else if (which === PROP.unpackColorSpace) g.unpackColorSpace = v;
          break;
        }

        case OP.ACTIVE_TEXTURE:
          gl.activeTexture(i32[p++]);
          break;
        case OP.ATTACH_SHADER:
          gl.attachShader(this.o(i32[p]), this.o(i32[p + 1]));
          p += 2;
          break;
        case OP.DETACH_SHADER:
          gl.detachShader(this.o(i32[p]), this.o(i32[p + 1]));
          p += 2;
          break;
        case OP.BIND_ATTRIB_LOCATION: {
          const prog = this.o<WebGLProgram>(i32[p++]);
          const index = i32[p++];
          gl.bindAttribLocation(prog, index, str());
          break;
        }
        case OP.SHADER_SOURCE: {
          const sh = this.o<WebGLShader>(i32[p++]);
          gl.shaderSource(sh, str());
          break;
        }
        case OP.COMPILE_SHADER:
          gl.compileShader(this.o(i32[p++]));
          break;
        case OP.LINK_PROGRAM:
          gl.linkProgram(this.o(i32[p++]));
          break;
        case OP.USE_PROGRAM:
          gl.useProgram(this.o(i32[p++]));
          break;
        case OP.UNIFORM_BLOCK_BINDING:
          gl.uniformBlockBinding(this.o(i32[p]), i32[p + 1], i32[p + 2]);
          p += 3;
          break;
        case OP.BIND_BUFFER:
          gl.bindBuffer(i32[p], this.o(i32[p + 1]));
          p += 2;
          break;
        case OP.BIND_BUFFER_BASE:
          gl.bindBufferBase(i32[p], i32[p + 1], this.o(i32[p + 2]));
          p += 3;
          break;
        case OP.BIND_FRAMEBUFFER:
          gl.bindFramebuffer(i32[p], this.o(i32[p + 1]));
          p += 2;
          break;
        case OP.BIND_RENDERBUFFER:
          gl.bindRenderbuffer(i32[p], this.o(i32[p + 1]));
          p += 2;
          break;
        case OP.BIND_TEXTURE:
          gl.bindTexture(i32[p], this.o(i32[p + 1]));
          p += 2;
          break;
        case OP.BIND_VERTEX_ARRAY:
          gl.bindVertexArray(this.o(i32[p++]));
          break;
        case OP.BLEND_COLOR:
          gl.blendColor(f32[p], f32[p + 1], f32[p + 2], f32[p + 3]);
          p += 4;
          break;
        case OP.BLEND_EQUATION:
          gl.blendEquation(i32[p++]);
          break;
        case OP.BLEND_EQUATION_SEPARATE:
          gl.blendEquationSeparate(i32[p], i32[p + 1]);
          p += 2;
          break;
        case OP.BLEND_FUNC:
          gl.blendFunc(i32[p], i32[p + 1]);
          p += 2;
          break;
        case OP.BLEND_FUNC_SEPARATE:
          gl.blendFuncSeparate(i32[p], i32[p + 1], i32[p + 2], i32[p + 3]);
          p += 4;
          break;
        case OP.BLIT_FRAMEBUFFER:
          gl.blitFramebuffer(i32[p], i32[p + 1], i32[p + 2], i32[p + 3], i32[p + 4], i32[p + 5], i32[p + 6], i32[p + 7], i32[p + 8], i32[p + 9]);
          p += 10;
          break;
        case OP.CLEAR:
          gl.clear(i32[p++]);
          break;
        case OP.CLEAR_BUFFER_FV: {
          const b = i32[p++];
          const d = i32[p++];
          const c = i32[p++];
          gl.clearBufferfv(b, d, f32.subarray(p, p + c));
          p += c;
          break;
        }
        case OP.CLEAR_BUFFER_IV: {
          const b = i32[p++];
          const d = i32[p++];
          const c = i32[p++];
          gl.clearBufferiv(b, d, i32.subarray(p, p + c));
          p += c;
          break;
        }
        case OP.CLEAR_BUFFER_UIV: {
          const b = i32[p++];
          const d = i32[p++];
          const c = i32[p++];
          gl.clearBufferuiv(b, d, u32.subarray(p, p + c));
          p += c;
          break;
        }
        case OP.CLEAR_BUFFER_FI:
          gl.clearBufferfi(i32[p], i32[p + 1], f32[p + 3], i32[p + 2]);
          p += 4;
          break;
        case OP.CLEAR_COLOR:
          gl.clearColor(f32[p], f32[p + 1], f32[p + 2], f32[p + 3]);
          p += 4;
          break;
        case OP.CLEAR_DEPTH:
          gl.clearDepth(f32[p++]);
          break;
        case OP.CLEAR_STENCIL:
          gl.clearStencil(i32[p++]);
          break;
        case OP.COLOR_MASK:
          gl.colorMask(i32[p] === 1, i32[p + 1] === 1, i32[p + 2] === 1, i32[p + 3] === 1);
          p += 4;
          break;
        case OP.CULL_FACE:
          gl.cullFace(i32[p++]);
          break;
        case OP.DEPTH_FUNC:
          gl.depthFunc(i32[p++]);
          break;
        case OP.DEPTH_MASK:
          gl.depthMask(i32[p++] === 1);
          break;
        case OP.DEPTH_RANGE:
          gl.depthRange(f32[p], f32[p + 1]);
          p += 2;
          break;
        case OP.DISABLE:
          gl.disable(i32[p++]);
          break;
        case OP.ENABLE:
          gl.enable(i32[p++]);
          break;
        case OP.DISABLE_VERTEX_ATTRIB_ARRAY:
          gl.disableVertexAttribArray(i32[p++]);
          break;
        case OP.ENABLE_VERTEX_ATTRIB_ARRAY:
          gl.enableVertexAttribArray(i32[p++]);
          break;
        case OP.FRONT_FACE:
          gl.frontFace(i32[p++]);
          break;
        case OP.LINE_WIDTH:
          gl.lineWidth(f32[p++]);
          break;
        case OP.PIXEL_STOREI: {
          const pname = i32[p++];
          const v = i32[p++];
          if (pname === UNPACK_SKIP_ROWS) this.skipRows = v;
          else if (pname === UNPACK_SKIP_PIXELS) this.skipPixels = v;
          else if (pname === UNPACK_SKIP_IMAGES) this.skipImages = v;
          gl.pixelStorei(pname, v);
          break;
        }
        case OP.POLYGON_OFFSET:
          gl.polygonOffset(f32[p], f32[p + 1]);
          p += 2;
          break;
        case OP.READ_BUFFER:
          gl.readBuffer(i32[p++]);
          break;
        case OP.SCISSOR:
          gl.scissor(i32[p], i32[p + 1], i32[p + 2], i32[p + 3]);
          p += 4;
          break;
        case OP.VIEWPORT:
          gl.viewport(i32[p], i32[p + 1], i32[p + 2], i32[p + 3]);
          p += 4;
          break;
        case OP.STENCIL_FUNC:
          gl.stencilFunc(i32[p], i32[p + 1], u32[p + 2]);
          p += 3;
          break;
        case OP.STENCIL_FUNC_SEPARATE:
          gl.stencilFuncSeparate(i32[p], i32[p + 1], i32[p + 2], u32[p + 3]);
          p += 4;
          break;
        case OP.STENCIL_MASK:
          gl.stencilMask(u32[p++]);
          break;
        case OP.STENCIL_MASK_SEPARATE:
          gl.stencilMaskSeparate(i32[p], u32[p + 1]);
          p += 2;
          break;
        case OP.STENCIL_OP:
          gl.stencilOp(i32[p], i32[p + 1], i32[p + 2]);
          p += 3;
          break;
        case OP.STENCIL_OP_SEPARATE:
          gl.stencilOpSeparate(i32[p], i32[p + 1], i32[p + 2], i32[p + 3]);
          p += 4;
          break;
        case OP.DRAW_BUFFERS: {
          const c = i32[p++];
          gl.drawBuffers(Array.from(i32.subarray(p, p + c)));
          p += c;
          break;
        }
        case OP.INVALIDATE_FRAMEBUFFER: {
          const t = i32[p++];
          const c = i32[p++];
          gl.invalidateFramebuffer(t, Array.from(i32.subarray(p, p + c)));
          p += c;
          break;
        }
        case OP.DRAW_ARRAYS:
          gl.drawArrays(i32[p], i32[p + 1], i32[p + 2]);
          p += 3;
          break;
        case OP.DRAW_ARRAYS_INSTANCED:
          gl.drawArraysInstanced(i32[p], i32[p + 1], i32[p + 2], i32[p + 3]);
          p += 4;
          break;
        case OP.DRAW_ELEMENTS:
          gl.drawElements(i32[p], i32[p + 1], i32[p + 2], i32[p + 3]);
          p += 4;
          break;
        case OP.DRAW_ELEMENTS_INSTANCED:
          gl.drawElementsInstanced(i32[p], i32[p + 1], i32[p + 2], i32[p + 3], i32[p + 4]);
          p += 5;
          break;
        case OP.VERTEX_ATTRIB_POINTER:
          gl.vertexAttribPointer(i32[p], i32[p + 1], i32[p + 2], i32[p + 3] === 1, i32[p + 4], i32[p + 5]);
          p += 6;
          break;
        case OP.VERTEX_ATTRIB_I_POINTER:
          gl.vertexAttribIPointer(i32[p], i32[p + 1], i32[p + 2], i32[p + 3], i32[p + 4]);
          p += 5;
          break;
        case OP.VERTEX_ATTRIB_DIVISOR:
          gl.vertexAttribDivisor(i32[p], i32[p + 1]);
          p += 2;
          break;
        case OP.VERTEX_ATTRIB_FV: {
          const c = i32[p++];
          const index = i32[p++];
          // 純量版跟 *fv 版設的值一樣（不用另外建 subarray）
          if (c === 1) gl.vertexAttrib1f(index, f32[p]);
          else if (c === 2) gl.vertexAttrib2f(index, f32[p], f32[p + 1]);
          else if (c === 3) gl.vertexAttrib3f(index, f32[p], f32[p + 1], f32[p + 2]);
          else gl.vertexAttrib4f(index, f32[p], f32[p + 1], f32[p + 2], f32[p + 3]);
          p += c;
          break;
        }
        case OP.BUFFER_DATA_SIZE:
          gl.bufferData(i32[p], u32[p + 1], i32[p + 2]);
          p += 3;
          break;
        case OP.BUFFER_DATA: {
          const t = i32[p++];
          const usage = i32[p++];
          const [at, len] = bytes();
          if (len) gl.bufferData(t, u8, usage, at, len);
          else gl.bufferData(t, 0, usage);
          break;
        }
        case OP.BUFFER_SUB_DATA: {
          const t = i32[p++];
          const dst = u32[p++];
          const [at, len] = bytes();
          if (len) gl.bufferSubData(t, dst, u8, at, len);
          break;
        }
        case OP.TEX_PARAMETER_I:
          gl.texParameteri(i32[p], i32[p + 1], i32[p + 2]);
          p += 3;
          break;
        case OP.TEX_PARAMETER_F:
          gl.texParameterf(i32[p], i32[p + 1], f32[p + 2]);
          p += 3;
          break;
        case OP.TEX_STORAGE_2D:
          gl.texStorage2D(i32[p], i32[p + 1], i32[p + 2], i32[p + 3], i32[p + 4]);
          p += 5;
          break;
        case OP.TEX_STORAGE_3D:
          gl.texStorage3D(i32[p], i32[p + 1], i32[p + 2], i32[p + 3], i32[p + 4], i32[p + 5]);
          p += 6;
          break;
        case OP.GENERATE_MIPMAP:
          gl.generateMipmap(i32[p++]);
          break;
        case OP.COPY_TEX_SUB_IMAGE_2D:
          gl.copyTexSubImage2D(i32[p], i32[p + 1], i32[p + 2], i32[p + 3], i32[p + 4], i32[p + 5], i32[p + 6], i32[p + 7]);
          p += 8;
          break;
        case OP.COPY_TEX_SUB_IMAGE_3D:
          gl.copyTexSubImage3D(i32[p], i32[p + 1], i32[p + 2], i32[p + 3], i32[p + 4], i32[p + 5], i32[p + 6], i32[p + 7], i32[p + 8]);
          p += 9;
          break;
        case OP.TEX_IMAGE_2D: {
          const a = i32.subarray(p, p + 9);
          p += 9;
          if (a[8] === 0) {
            gl.texImage2D(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], null);
            break;
          }
          const { view, cleared } = pixels(false);
          gl.texImage2D(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], view);
          restore(cleared, false);
          break;
        }
        case OP.TEX_SUB_IMAGE_2D: {
          const a = i32.subarray(p, p + 8);
          p += 8;
          const { view, cleared } = pixels(false);
          gl.texSubImage2D(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], view);
          restore(cleared, false);
          break;
        }
        case OP.TEX_IMAGE_3D: {
          const a = i32.subarray(p, p + 10);
          p += 10;
          if (a[9] === 0) {
            gl.texImage3D(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], null);
            break;
          }
          const { view, cleared } = pixels(true);
          gl.texImage3D(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], view);
          restore(cleared, true);
          break;
        }
        case OP.TEX_SUB_IMAGE_3D: {
          const a = i32.subarray(p, p + 10);
          p += 10;
          const { view, cleared } = pixels(true);
          gl.texSubImage3D(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], view);
          restore(cleared, true);
          break;
        }
        case OP.TEX_IMAGE_2D_SRC: {
          // target level internalformat format type hasSize w h srcKind srcIndex
          const a = i32.subarray(p, p + 10);
          p += 10;
          const src = source(a[8], a[9]);
          if (!src) throw new Error(`texImage2D：影像 ${a[8]}/${a[9]} 沒有解碼結果`);
          if (a[5]) gl.texImage2D(a[0], a[1], a[2], a[6], a[7], 0, a[3], a[4], src as TexImageSource);
          else gl.texImage2D(a[0], a[1], a[2], a[3], a[4], src as TexImageSource);
          break;
        }
        case OP.TEX_SUB_IMAGE_2D_SRC: {
          // target level x y format type hasSize w h srcKind srcIndex
          const a = i32.subarray(p, p + 11);
          p += 11;
          const src = source(a[9], a[10]);
          if (!src) throw new Error(`texSubImage2D：影像 ${a[9]}/${a[10]} 沒有解碼結果`);
          if (a[6]) gl.texSubImage2D(a[0], a[1], a[2], a[3], a[7], a[8], a[4], a[5], src as TexImageSource);
          else gl.texSubImage2D(a[0], a[1], a[2], a[3], a[4], a[5], src as TexImageSource);
          break;
        }
        case OP.COMPRESSED_TEX_IMAGE_2D: {
          const a = i32.subarray(p, p + 6);
          p += 6;
          const [at, len] = bytes();
          gl.compressedTexImage2D(a[0], a[1], a[2], a[3], a[4], a[5], new Uint8Array(buf, at, len));
          break;
        }
        case OP.COMPRESSED_TEX_SUB_IMAGE_2D: {
          const a = i32.subarray(p, p + 7);
          p += 7;
          const [at, len] = bytes();
          gl.compressedTexSubImage2D(a[0], a[1], a[2], a[3], a[4], a[5], a[6], new Uint8Array(buf, at, len));
          break;
        }
        case OP.COMPRESSED_TEX_IMAGE_3D: {
          const a = i32.subarray(p, p + 7);
          p += 7;
          const [at, len] = bytes();
          gl.compressedTexImage3D(a[0], a[1], a[2], a[3], a[4], a[5], a[6], new Uint8Array(buf, at, len));
          break;
        }
        case OP.COMPRESSED_TEX_SUB_IMAGE_3D: {
          const a = i32.subarray(p, p + 9);
          p += 9;
          const [at, len] = bytes();
          gl.compressedTexSubImage3D(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], new Uint8Array(buf, at, len));
          break;
        }
        case OP.FRAMEBUFFER_RENDERBUFFER:
          gl.framebufferRenderbuffer(i32[p], i32[p + 1], i32[p + 2], this.o(i32[p + 3]));
          p += 4;
          break;
        case OP.FRAMEBUFFER_TEXTURE_2D:
          gl.framebufferTexture2D(i32[p], i32[p + 1], i32[p + 2], this.o(i32[p + 3]), i32[p + 4]);
          p += 5;
          break;
        case OP.FRAMEBUFFER_TEXTURE_LAYER:
          gl.framebufferTextureLayer(i32[p], i32[p + 1], this.o(i32[p + 2]), i32[p + 3], i32[p + 4]);
          p += 5;
          break;
        case OP.RENDERBUFFER_STORAGE:
          gl.renderbufferStorage(i32[p], i32[p + 1], i32[p + 2], i32[p + 3]);
          p += 4;
          break;
        case OP.RENDERBUFFER_STORAGE_MULTISAMPLE:
          gl.renderbufferStorageMultisample(i32[p], i32[p + 1], i32[p + 2], i32[p + 3], i32[p + 4]);
          p += 5;
          break;
        case OP.UNIFORM_N: {
          const kind = i32[p];
          const c = i32[p + 1];
          const loc = this.o<WebGLUniformLocation | null>(i32[p + 2]);
          const q = p + 3;
          p = q + c;
          if (kind === 0) {
            if (c === 1) gl.uniform1f(loc, f32[q]);
            else if (c === 2) gl.uniform2f(loc, f32[q], f32[q + 1]);
            else if (c === 3) gl.uniform3f(loc, f32[q], f32[q + 1], f32[q + 2]);
            else gl.uniform4f(loc, f32[q], f32[q + 1], f32[q + 2], f32[q + 3]);
          } else if (kind === 1) {
            if (c === 1) gl.uniform1i(loc, i32[q]);
            else if (c === 2) gl.uniform2i(loc, i32[q], i32[q + 1]);
            else if (c === 3) gl.uniform3i(loc, i32[q], i32[q + 1], i32[q + 2]);
            else gl.uniform4i(loc, i32[q], i32[q + 1], i32[q + 2], i32[q + 3]);
          } else if (c === 1) gl.uniform1ui(loc, u32[q]);
          else if (c === 2) gl.uniform2ui(loc, u32[q], u32[q + 1]);
          else if (c === 3) gl.uniform3ui(loc, u32[q], u32[q + 1], u32[q + 2]);
          else gl.uniform4ui(loc, u32[q], u32[q + 1], u32[q + 2], u32[q + 3]);
          break;
        }
        case OP.UNIFORM_V: {
          const kind = i32[p];
          const size = i32[p + 1];
          const loc = this.o<WebGLUniformLocation | null>(i32[p + 2]);
          const c = i32[p + 3];
          const q = p + 4;
          p = q + c;
          if (kind === 0) {
            const v = c ? f32 : EMPTY_F32;
            const o = c ? q : 0;
            if (size === 1) gl.uniform1fv(loc, v, o, c);
            else if (size === 2) gl.uniform2fv(loc, v, o, c);
            else if (size === 3) gl.uniform3fv(loc, v, o, c);
            else gl.uniform4fv(loc, v, o, c);
          } else if (kind === 1) {
            const v = c ? i32 : EMPTY_I32;
            const o = c ? q : 0;
            if (size === 1) gl.uniform1iv(loc, v, o, c);
            else if (size === 2) gl.uniform2iv(loc, v, o, c);
            else if (size === 3) gl.uniform3iv(loc, v, o, c);
            else gl.uniform4iv(loc, v, o, c);
          } else {
            const v = c ? u32 : EMPTY_U32;
            const o = c ? q : 0;
            if (size === 1) gl.uniform1uiv(loc, v, o, c);
            else if (size === 2) gl.uniform2uiv(loc, v, o, c);
            else if (size === 3) gl.uniform3uiv(loc, v, o, c);
            else gl.uniform4uiv(loc, v, o, c);
          }
          break;
        }
        case OP.UNIFORM_MATRIX: {
          const size = i32[p];
          const loc = this.o<WebGLUniformLocation | null>(i32[p + 1]);
          const t = i32[p + 2] === 1;
          const c = i32[p + 3];
          const q = p + 4;
          p = q + c;
          const v = c ? f32 : EMPTY_F32;
          const o = c ? q : 0;
          if (size === 2) gl.uniformMatrix2fv(loc, t, v, o, c);
          else if (size === 3) gl.uniformMatrix3fv(loc, t, v, o, c);
          else gl.uniformMatrix4fv(loc, t, v, o, c);
          break;
        }
        case OP.SIM_DEF: {
          const id = i32[p++];
          jobs().def(id, str());
          break;
        }
        case OP.SIM_STATE: {
          const id = i32[p++];
          jobs().state(id, reader);
          break;
        }
        case OP.PARTICLE_JOB: {
          const job = i32[p++];
          const sim = i32[p++];
          jobs().job(job, sim, reader);
          break;
        }
        case OP.BUFFER_SUB_DATA_JOB: {
          const t = i32[p];
          const dst = u32[p + 1];
          const job = i32[p + 2];
          const stream = i32[p + 3];
          const start = i32[p + 4];
          const len = i32[p + 5];
          p += 6;
          const data = jobs().data(job, stream);
          if (!data) throw new Error(`render thread：粒子網格工作 ${job} 的資料流 ${stream} 不在（太舊已丟或沒跑）`);
          const el = data.BYTES_PER_ELEMENT;
          // bufferData 整個陣列上傳時長度是陣列容量，工作的輸出只到頂點數：後面那段 BUFFER_DATA_SIZE 已經補 0
          const n = Math.min(len, data.byteLength - start);
          if (n > 0) gl.bufferSubData(t, dst, data, start / el, n / el);
          break;
        }
        case OP.FINISH:
          p++;
          gl.finish();
          break;
        case OP.FLUSH:
          p++;
          gl.flush();
          break;
        default:
          throw new Error(`render thread：不認得的指令 ${op}（位置 ${p - 1}/${words}）`);
      }
    }
    this.stats.segments++;
    this.stats.commands += n;
  }
}

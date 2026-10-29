// render thread 的主執行緒端（2026/10/18）：GfxContext 給 three.js 當 WebGL2 context，每個 gl.* 呼叫寫成一筆指令（protocol.ts），
// 一段一段交給 worker 重播。照 Unity 的 GfxDeviceClient：主執行緒只產生指令，不碰圖形 API。
//
// 同步的查詢：
//   - 程式與 shader（編譯狀態、log、getActiveUniform／Attrib、getAttribLocation、getUniformLocation 是不是 null）：問主執行緒的
//     影子 context（shadow）。同一顆 GPU、同一個 GPU 程序裡的另一個 WebGL2 context，同一份原始碼編出來的結果跟 worker 那邊一樣；
//     驗證模式（tee.ts）會兩邊比對。編譯本來就在主執行緒（three.js 直接用 context 時也是），不是新增的成本。
//   - 固定的上限與字串（MAX_TEXTURE_SIZE、VERSION…）：worker 開機時查好送過來（params），沒有的再問影子。
//   - 會變的狀態（VIEWPORT、SCISSOR_BOX、UNPACK_*／PACK_*）：照這裡記錄的呼叫自己算。
//   - 讀回像素（readPixels、getBufferSubData、fenceSync）：不支援。遊戲本身沒有用到（ScreenCapture、GetPixel 是 notPorted），
//     只有除錯函式（SceneRenderer.snapshotPixels）會用，開 render thread 時那些函式丟例外。
//
// 分段：一段指令在 worker 那邊是一個 task，task 結束時 OffscreenCanvas 才把畫面送出去，而且只有這段畫到預設 framebuffer 時才送
//（10/18 在 headless Chrome 實測：只畫 FBO 的 task 結束後畫面不變）。SceneRenderer 整格先畫進 render target、最後才 blit 到螢幕，
// 所以一格中途指令累積夠多就先送一段，worker 跟主執行緒同時做；碰到預設 framebuffer 之後就不再中途送，等 endFrame 一起送。

import { bytesPerPixel, KIND, OP, PROP, SRC, type SegmentImage } from './protocol';

/** WebGL 物件（buffer、texture、program…）在主執行緒的代表：只有編號；program、shader 另外掛影子 context 的物件 */
export class GfxObject {
  shadow: WebGLProgram | WebGLShader | null = null;
  /**
   * 這個物件參照的其他物件（VAO 的屬性 buffer 與 element buffer、framebuffer 的附件、program 掛的 shader）：
   * 跟 WebGL 一樣，被參照的物件不會因為 JS 這邊沒人拿著就被 GC 刪掉（見 GfxContext.collected）
   */
  refs: Map<number, GfxObject> | null = null;
  /** 已經 delete* 過：不再送第二次 DELETE */
  deleted = false;
  constructor(
    readonly id: number,
    readonly kind: number,
  ) {}
  ref(key: number, o: GfxObject | null): void {
    if (o) (this.refs ??= new Map()).set(key, o);
    else this.refs?.delete(key);
  }
}

/**
 * 交給 worker 解碼的影像（loadImage 回傳；THREE.Texture.image 用它）：主執行緒只有寬高，像素在 worker。
 * three.js 上傳時（texImage2D／texSubImage2D 的影像來源版）這裡換成 SRC.REMOTE，worker 照當時的 unpack 參數解碼後上傳
 */
export class RemoteImage {
  constructor(
    readonly id: number,
    readonly width: number,
    readonly height: number,
    /** 原始網址（CPU 要讀像素的地方自己再載一次，例如動態字型 atlas 的種子） */
    readonly url: string,
  ) {}
}

export interface Segment {
  buf: ArrayBuffer;
  words: number;
  ext: (ImageBitmap | VideoFrame)[];
  /** ext 裡要轉移（transfer）的：這裡自己建的 VideoFrame */
  transfer: Transferable[];
  images: SegmentImage[];
  /** endFrame 的格號；一格中途先送的段是 null */
  frame: number | null;
}

// GL 列舉（protocol 以外用到的）
const FRAMEBUFFER = 0x8d40;
const DRAW_FRAMEBUFFER = 0x8ca9;
const READ_FRAMEBUFFER = 0x8ca8;
const ARRAY_BUFFER = 0x8892;
const ELEMENT_ARRAY_BUFFER = 0x8893;
const VIEWPORT = 0x0ba2;
const SCISSOR_BOX = 0x0c10;
const UNPACK_ALIGNMENT = 0x0cf5;
const UNPACK_ROW_LENGTH = 0x0cf2;
const UNPACK_SKIP_ROWS = 0x0cf3;
const UNPACK_SKIP_PIXELS = 0x0cf4;
const UNPACK_IMAGE_HEIGHT = 0x806e;
const UNPACK_SKIP_IMAGES = 0x806d;
const UNPACK_FLIP_Y_WEBGL = 0x9240;
const UNPACK_PREMULTIPLY_ALPHA_WEBGL = 0x9241;
const UNPACK_COLORSPACE_CONVERSION_WEBGL = 0x9243;
const BROWSER_DEFAULT_WEBGL = 0x9244;
const PACK_ALIGNMENT = 0x0d05;
const PACK_ROW_LENGTH = 0x0d02;
const PACK_SKIP_ROWS = 0x0d03;
const PACK_SKIP_PIXELS = 0x0d04;

/** 一格中途送一段的門檻（32 位元字數，約 1 MB） */
const CHUNK_WORDS = 1 << 18;

const utf8 = new TextEncoder();

/** 可以長大的指令緩衝；送出去的 ArrayBuffer 由 worker 用完還回來（recycle） */
export class CmdWriter {
  buf!: ArrayBuffer;
  u32!: Uint32Array;
  i32!: Int32Array;
  f32!: Float32Array;
  f64!: Float64Array;
  u8!: Uint8Array;
  p = 0;
  private readonly pool: ArrayBuffer[] = [];
  constructor(private readonly initialWords = 1 << 16) {
    this.attach(new ArrayBuffer(initialWords * 4));
  }
  private attach(b: ArrayBuffer): void {
    this.buf = b;
    this.u32 = new Uint32Array(b);
    this.i32 = new Int32Array(b);
    this.f32 = new Float32Array(b);
    this.f64 = new Float64Array(b);
    this.u8 = new Uint8Array(b);
    this.p = 0;
  }
  need(n: number): void {
    if (this.p + n > this.u32.length) this.grow(this.p + n);
  }
  private grow(min: number): void {
    let cap = this.u32.length * 2;
    while (cap < min) cap *= 2;
    const old = this.u8;
    const p = this.p;
    this.attach(new ArrayBuffer(cap * 4));
    this.u8.set(old.subarray(0, p * 4));
    this.p = p;
  }
  /** 把目前的內容交出去（換一塊新的或回收的緩衝繼續寫） */
  take(): { buf: ArrayBuffer; words: number } {
    const r = { buf: this.buf, words: this.p };
    this.attach(this.pool.pop() ?? new ArrayBuffer(this.initialWords * 4));
    return r;
  }
  recycle(b: ArrayBuffer): void {
    if (b.byteLength >= this.initialWords * 4 && this.pool.length < 4) this.pool.push(b);
  }
  /** [byteLength][位元組…補到 4 的倍數] */
  bytes(src: Uint8Array): void {
    const n = src.byteLength;
    const words = (n + 3) >> 2;
    this.need(1 + words);
    this.u32[this.p++] = n;
    this.u8.set(src, this.p * 4);
    this.p += words;
  }
  str(s: string): void {
    this.bytes(utf8.encode(s));
  }
  /** 64 位元浮點（double 原樣；對齊到 8 位元組，前面可能補一個字） */
  double(v: number): void {
    this.need(3);
    if (this.p & 1) this.u32[this.p++] = 0;
    this.f64[this.p >> 1] = v;
    this.p += 2;
  }
}

/** 主執行緒的影子 context 要回答的部分（測試給假的） */
export type ShadowGL = Pick<
  WebGL2RenderingContext,
  | 'createShader'
  | 'createProgram'
  | 'shaderSource'
  | 'compileShader'
  | 'attachShader'
  | 'detachShader'
  | 'bindAttribLocation'
  | 'linkProgram'
  | 'deleteShader'
  | 'deleteProgram'
  | 'getShaderParameter'
  | 'getShaderInfoLog'
  | 'getShaderSource'
  | 'getProgramParameter'
  | 'getProgramInfoLog'
  | 'getActiveUniform'
  | 'getActiveAttrib'
  | 'getAttribLocation'
  | 'getUniformLocation'
  | 'getUniformBlockIndex'
  | 'getFragDataLocation'
  | 'getExtension'
  | 'getParameter'
  | 'getShaderPrecisionFormat'
  | 'uniformBlockBinding'
>;

export interface GfxContextOptions {
  /** GL 常數（WebGL2RenderingContext.prototype 上的數字屬性），three.js 讀 gl.TEXTURE_2D 這類 */
  constants: Record<string, number>;
  shadow: ShadowGL;
  /** worker 那邊真的 context 的屬性與支援的擴充 */
  attributes: WebGLContextAttributes | null;
  extensions: string[];
  /** worker 開機時查的固定參數（getParameter） */
  params: Record<number, unknown>;
  /** 畫布一開始的大小（VIEWPORT、SCISSOR_BOX 的初始值；WebGL 建 context 時設成整個繪圖緩衝） */
  width: number;
  height: number;
  /** 一段指令送給 worker */
  send(seg: Segment): void;
}

type FloatList = Float32Array | ArrayLike<number>;
type IntList = Int32Array | ArrayLike<number>;
type UintList = Uint32Array | ArrayLike<number>;

/** srcOffset／srcLength（WebGL2 的 uniform*v、clearBuffer*v 多載）：回傳 [起點, 個數]，超出範圍回 null（GL 是 INVALID_VALUE，不做事） */
function listRange(len: number, srcOffset: number, srcLength: number): [number, number] | null {
  srcOffset >>>= 0;
  srcLength >>>= 0;
  if (srcOffset > len) return null;
  const n = srcLength === 0 ? len - srcOffset : srcLength;
  if (srcOffset + n > len) return null;
  return [srcOffset, n];
}

/** 原始 view 的種類（重播時建同一種 view：WebGL 會檢查 view 的型別跟 type 合不合） */
function viewKind(v: ArrayBufferView): number {
  if (v instanceof Uint8Array) return 2;
  if (v instanceof Uint8ClampedArray) return 3;
  if (v instanceof Int8Array) return 1;
  if (v instanceof Uint16Array) return 5;
  if (v instanceof Int16Array) return 4;
  if (v instanceof Uint32Array) return 7;
  if (v instanceof Int32Array) return 6;
  if (v instanceof Float32Array) return 8;
  return 2;
}

/**
 * three.js 用到的 WebGL2 介面。方法名稱與參數照 WebGL2RenderingContext；沒有列的方法 three.js（0.186.1）沒用，呼叫會是 TypeError。
 * 常數在建構時從 options.constants 抄上來。
 */
export class GfxContext {
  [constant: string]: unknown;

  readonly canvas: GfxCanvas;
  private readonly w = new CmdWriter();
  private readonly shadow: ShadowGL;
  private nextId = 1;
  private ext: (ImageBitmap | VideoFrame)[] = [];
  private transfer: Transferable[] = [];
  private images: SegmentImage[] = [];
  private imageIndex = new Map<string, number>();
  private readonly extensionCache = new Map<string, object | null>();
  private readonly send: (seg: Segment) => void;
  private readonly params: Record<number, unknown>;
  private readonly attributes: WebGLContextAttributes | null;
  private readonly supported: string[];
  /** 目前畫到預設 framebuffer（DRAW_FRAMEBUFFER 綁 null） */
  private drawToDefault = true;
  /** 這一格已經畫過預設 framebuffer：endFrame 之前不中途送段 */
  private touchedDefault = false;
  private lost = false;
  /**
   * WebGL 的物件被 GC 收掉時，瀏覽器會自己刪掉 GPU 那邊的物件；three.js 換掉屬性時不一定 dispose 舊的 buffer，靠的就是這個
   *（10/18 MT2 戰鬥：每秒建約 300 個 buffer、明確刪的不到 6%，render thread 這邊沒刪，GPU 記憶體一路漲到 GL_OUT_OF_MEMORY、context lost）。
   * 這裡照做：GfxObject 被回收、又沒有 delete* 過，就在下一次 endFrame 送 DELETE。還在用的物件照 WebGL 的規則留著參照，
   * 不會被收：目前的綁定（bound、vao）、VAO 的屬性與 element buffer、framebuffer 的附件、program 的 shader（GfxObject.refs）
   */
  private readonly collected: { kind: number; id: number }[] = [];
  private readonly registry = new FinalizationRegistry<{ kind: number; id: number }>((h) => this.collected.push(h));
  /** context 的綁定（key 見 bind 開頭的方法）：綁著的物件不會被 GC */
  private readonly bound = new Map<string, GfxObject>();
  private unit = 0;
  /** 預設 VAO（綁 null 時）：只用來留屬性與 element buffer 的參照，不送指令 */
  private readonly defaultVao = new GfxObject(0, KIND.VERTEX_ARRAY);
  private vao: GfxObject = this.defaultVao;
  // 會變的狀態（getParameter 回答用；unpack 參數也決定上傳時抄哪一段、遠端影像怎麼解碼）
  private viewportBox: Int32Array;
  private scissorBox: Int32Array;
  private readonly store = new Map<number, number | boolean>([
    [UNPACK_ALIGNMENT, 4],
    [UNPACK_ROW_LENGTH, 0],
    [UNPACK_SKIP_ROWS, 0],
    [UNPACK_SKIP_PIXELS, 0],
    [UNPACK_IMAGE_HEIGHT, 0],
    [UNPACK_SKIP_IMAGES, 0],
    [UNPACK_FLIP_Y_WEBGL, false],
    [UNPACK_PREMULTIPLY_ALPHA_WEBGL, false],
    [UNPACK_COLORSPACE_CONVERSION_WEBGL, BROWSER_DEFAULT_WEBGL],
    [PACK_ALIGNMENT, 4],
    [PACK_ROW_LENGTH, 0],
    [PACK_SKIP_ROWS, 0],
    [PACK_SKIP_PIXELS, 0],
  ]);
  private props: Record<string, string> = { drawingBufferColorSpace: 'srgb', unpackColorSpace: 'srgb' };
  /** 統計（除錯用）：送出的段數、字數 */
  readonly stats = { segments: 0, words: 0, frames: 0 };
  /**
   * 內容由 worker 端工作產生的陣列（粒子網格的屬性與三角形，particleJobs.ts）：three.js 上傳它們時（bufferData／bufferSubData）
   * 不抄主執行緒的位元組，改成 BUFFER_SUB_DATA_JOB，worker 從那個工作的輸出抄。登記會被下一次覆蓋（陣列的內容一直是最近一次工作的輸出，
   * 跟主執行緒自己產生時陣列裡留的一樣）
   */
  private readonly jobArrays = new WeakMap<ArrayBufferView, { job: number; stream: number }>();
  /** 自訂指令的寫入口（particleJobs.ts 用）：不經過 gl.* 方法 */
  get writer(): CmdWriter {
    return this.w;
  }
  bindJobArray(view: ArrayBufferView, job: number, stream: number): void {
    this.jobArrays.set(view, { job, stream });
  }

  constructor(o: GfxContextOptions) {
    Object.assign(this, o.constants);
    this.shadow = o.shadow;
    this.send = o.send;
    this.params = o.params;
    this.attributes = o.attributes;
    this.supported = o.extensions;
    this.viewportBox = new Int32Array([0, 0, o.width, o.height]);
    this.scissorBox = new Int32Array([0, 0, o.width, o.height]);
    this.canvas = new GfxCanvas(this, o.width, o.height);
  }

  // ───────── 分段 ─────────

  /** 一格結束（SceneRenderer.render 的最後）：這一段送出去，worker 做完回 done（frame） */
  endFrame(frame: number): void {
    // GC 收掉的物件：接在這一格的指令後面刪（指令裡還用到它的都在前面）
    for (const h of this.collected.splice(0)) this.op2(OP.DELETE, h.kind, h.id);
    this.flushSegment(frame);
    this.touchedDefault = false;
    this.stats.frames++;
  }
  /** 有累積的指令就送（換場景、銷毀前；frame 是 null） */
  flushPending(): void {
    if (this.w.p > 0 || this.ext.length) this.flushSegment(null);
  }
  /** worker 還回來的緩衝 */
  recycle(buf: ArrayBuffer): void {
    this.w.recycle(buf);
  }
  markLost(): void {
    this.lost = true;
  }
  private flushSegment(frame: number | null): void {
    const { buf, words } = this.w.take();
    this.stats.segments++;
    this.stats.words += words;
    this.send({ buf, words, ext: this.ext, transfer: this.transfer, images: this.images, frame });
    this.ext = [];
    this.transfer = [];
    this.images = [];
    this.imageIndex.clear();
  }
  /** 畫圖呼叫之後：累積夠多、還沒碰預設 framebuffer 就先送一段 */
  private drew(): void {
    if (this.drawToDefault) this.touchedDefault = true;
    else if (this.w.p > CHUNK_WORDS && !this.touchedDefault) this.flushSegment(null);
  }

  // ───────── 寫入小工具 ─────────

  private op1(op: number, a: number): void {
    const w = this.w;
    w.need(2);
    const i = w.i32;
    const p = w.p;
    i[p] = op;
    i[p + 1] = a;
    w.p = p + 2;
  }
  private op2(op: number, a: number, b: number): void {
    const w = this.w;
    w.need(3);
    const i = w.i32;
    const p = w.p;
    i[p] = op;
    i[p + 1] = a;
    i[p + 2] = b;
    w.p = p + 3;
  }
  private op3(op: number, a: number, b: number, c: number): void {
    const w = this.w;
    w.need(4);
    const i = w.i32;
    const p = w.p;
    i[p] = op;
    i[p + 1] = a;
    i[p + 2] = b;
    i[p + 3] = c;
    w.p = p + 4;
  }
  private op4(op: number, a: number, b: number, c: number, d: number): void {
    const w = this.w;
    w.need(5);
    const i = w.i32;
    const p = w.p;
    i[p] = op;
    i[p + 1] = a;
    i[p + 2] = b;
    i[p + 3] = c;
    i[p + 4] = d;
    w.p = p + 5;
  }
  private opN(op: number, args: ArrayLike<number>): void {
    const w = this.w;
    w.need(1 + args.length);
    const i = w.i32;
    let p = w.p;
    i[p++] = op;
    for (let k = 0; k < args.length; k++) i[p++] = args[k];
    w.p = p;
  }
  private opF(op: number, args: ArrayLike<number>): void {
    const w = this.w;
    w.need(1 + args.length);
    w.i32[w.p++] = op;
    const f = w.f32;
    let p = w.p;
    for (let k = 0; k < args.length; k++) f[p++] = args[k];
    w.p = p;
  }
  private id(o: GfxObject | null | undefined): number {
    return o ? o.id : 0;
  }
  private create(kind: number, extra?: number): GfxObject {
    const o = new GfxObject(this.nextId++, kind);
    if (extra === undefined) this.op2(OP.CREATE, kind, o.id);
    else this.op3(OP.CREATE, kind, o.id, extra);
    this.registry.register(o, { kind, id: o.id }, o);
    return o;
  }
  private destroy(o: GfxObject | null | undefined): void {
    if (!o || o.deleted) return;
    o.deleted = true;
    o.refs = null;
    this.registry.unregister(o);
    // WebGL 刪掉綁著的物件時會解除綁定（目前的 VAO 刪掉就回到預設 VAO）
    if (o === this.vao) this.vao = this.defaultVao;
    for (const [k, v] of this.bound) if (v === o) this.bound.delete(k);
    this.op2(OP.DELETE, o.kind, o.id);
  }
  /** 一串 float（Float32Array 照位元抄；一般陣列照 WebIDL 轉 float32） */
  private floats(src: FloatList, start: number, n: number): void {
    const w = this.w;
    w.need(n);
    if (src instanceof Float32Array && n > 32) w.f32.set(src.subarray(start, start + n), w.p);
    else {
      const f = w.f32;
      const p = w.p;
      for (let k = 0; k < n; k++) f[p + k] = src[start + k];
    }
    w.p += n;
  }
  private ints(src: IntList | UintList, start: number, n: number): void {
    const w = this.w;
    w.need(n);
    const i = w.i32;
    const p = w.p;
    for (let k = 0; k < n; k++) i[p + k] = src[start + k];
    w.p += n;
  }
  private raw(view: ArrayBufferView, byteStart: number, byteLength: number): void {
    this.w.bytes(new Uint8Array(view.buffer, view.byteOffset + byteStart, byteLength));
  }

  // ───────── 物件 ─────────

  createBuffer(): GfxObject {
    return this.create(KIND.BUFFER);
  }
  createTexture(): GfxObject {
    return this.create(KIND.TEXTURE);
  }
  createFramebuffer(): GfxObject {
    return this.create(KIND.FRAMEBUFFER);
  }
  createRenderbuffer(): GfxObject {
    return this.create(KIND.RENDERBUFFER);
  }
  createVertexArray(): GfxObject {
    return this.create(KIND.VERTEX_ARRAY);
  }
  createQuery(): GfxObject {
    return this.create(KIND.QUERY);
  }
  createSampler(): GfxObject {
    return this.create(KIND.SAMPLER);
  }
  createProgram(): GfxObject {
    const o = this.create(KIND.PROGRAM);
    o.shadow = this.shadow.createProgram();
    return o;
  }
  createShader(type: number): GfxObject {
    const o = this.create(KIND.SHADER, type);
    o.shadow = this.shadow.createShader(type);
    return o;
  }
  deleteBuffer(o: GfxObject | null): void {
    this.destroy(o);
  }
  deleteTexture(o: GfxObject | null): void {
    this.destroy(o);
  }
  deleteFramebuffer(o: GfxObject | null): void {
    this.destroy(o);
  }
  deleteRenderbuffer(o: GfxObject | null): void {
    this.destroy(o);
  }
  deleteVertexArray(o: GfxObject | null): void {
    this.destroy(o);
  }
  deleteQuery(o: GfxObject | null): void {
    this.destroy(o);
  }
  deleteSampler(o: GfxObject | null): void {
    this.destroy(o);
  }
  deleteProgram(o: GfxObject | null): void {
    if (!o) return;
    this.shadow.deleteProgram(o.shadow as WebGLProgram);
    this.destroy(o);
  }
  deleteShader(o: GfxObject | null): void {
    if (!o) return;
    this.shadow.deleteShader(o.shadow as WebGLShader);
    this.destroy(o);
  }

  // ───────── shader 與 program（也做在影子上） ─────────

  shaderSource(s: GfxObject, src: string): void {
    this.shadow.shaderSource(s.shadow as WebGLShader, src);
    this.w.need(2);
    this.w.i32[this.w.p++] = OP.SHADER_SOURCE;
    this.w.i32[this.w.p++] = s.id;
    this.w.str(src);
  }
  compileShader(s: GfxObject): void {
    this.shadow.compileShader(s.shadow as WebGLShader);
    this.op1(OP.COMPILE_SHADER, s.id);
  }
  attachShader(p: GfxObject, s: GfxObject): void {
    this.shadow.attachShader(p.shadow as WebGLProgram, s.shadow as WebGLShader);
    p.ref(s.id, s);
    this.op2(OP.ATTACH_SHADER, p.id, s.id);
  }
  detachShader(p: GfxObject, s: GfxObject): void {
    this.shadow.detachShader(p.shadow as WebGLProgram, s.shadow as WebGLShader);
    p.ref(s.id, null);
    this.op2(OP.DETACH_SHADER, p.id, s.id);
  }
  bindAttribLocation(p: GfxObject, index: number, name: string): void {
    this.shadow.bindAttribLocation(p.shadow as WebGLProgram, index, name);
    this.op2(OP.BIND_ATTRIB_LOCATION, p.id, index);
    this.w.str(name);
  }
  linkProgram(p: GfxObject): void {
    this.shadow.linkProgram(p.shadow as WebGLProgram);
    this.op1(OP.LINK_PROGRAM, p.id);
  }
  getShaderParameter(s: GfxObject, pname: number): unknown {
    return this.shadow.getShaderParameter(s.shadow as WebGLShader, pname);
  }
  getShaderInfoLog(s: GfxObject): string | null {
    return this.shadow.getShaderInfoLog(s.shadow as WebGLShader);
  }
  getShaderSource(s: GfxObject): string | null {
    return this.shadow.getShaderSource(s.shadow as WebGLShader);
  }
  getProgramParameter(p: GfxObject, pname: number): unknown {
    return this.shadow.getProgramParameter(p.shadow as WebGLProgram, pname);
  }
  getProgramInfoLog(p: GfxObject): string | null {
    return this.shadow.getProgramInfoLog(p.shadow as WebGLProgram);
  }
  getActiveUniform(p: GfxObject, i: number): WebGLActiveInfo | null {
    return this.shadow.getActiveUniform(p.shadow as WebGLProgram, i);
  }
  getActiveAttrib(p: GfxObject, i: number): WebGLActiveInfo | null {
    return this.shadow.getActiveAttrib(p.shadow as WebGLProgram, i);
  }
  getAttribLocation(p: GfxObject, name: string): number {
    return this.shadow.getAttribLocation(p.shadow as WebGLProgram, name);
  }
  getFragDataLocation(p: GfxObject, name: string): number {
    return this.shadow.getFragDataLocation(p.shadow as WebGLProgram, name);
  }
  getUniformBlockIndex(p: GfxObject, name: string): number {
    return this.shadow.getUniformBlockIndex(p.shadow as WebGLProgram, name);
  }
  /** 影子上是 null 就回 null；否則給一個編號，worker 照名字在自己的 program 上查 */
  getUniformLocation(p: GfxObject, name: string): GfxObject | null {
    if (!this.shadow.getUniformLocation(p.shadow as WebGLProgram, name)) return null;
    const loc = new GfxObject(this.nextId++, KIND.LOCATION);
    this.op2(OP.UNIFORM_LOCATION, p.id, loc.id);
    this.w.str(name);
    return loc;
  }
  uniformBlockBinding(p: GfxObject, index: number, binding: number): void {
    this.shadow.uniformBlockBinding(p.shadow as WebGLProgram, index, binding);
    this.op3(OP.UNIFORM_BLOCK_BINDING, p.id, index, binding);
  }
  useProgram(p: GfxObject | null): void {
    this.keep('p', p);
    this.op1(OP.USE_PROGRAM, this.id(p));
  }
  /** context 的綁定：綁著的物件留參照（不會被 GC 刪），綁 null 放掉 */
  private keep(key: string, o: GfxObject | null): void {
    if (o) this.bound.set(key, o);
    else this.bound.delete(key);
  }

  // ───────── 查詢 ─────────

  getParameter(pname: number): unknown {
    switch (pname) {
      case VIEWPORT:
        return new Int32Array(this.viewportBox);
      case SCISSOR_BOX:
        return new Int32Array(this.scissorBox);
    }
    const s = this.store.get(pname);
    if (s !== undefined) return s;
    if (pname in this.params) {
      const v = this.params[pname];
      return ArrayBuffer.isView(v) ? (v as Int32Array).slice() : v;
    }
    return this.shadow.getParameter(pname);
  }
  getContextAttributes(): WebGLContextAttributes | null {
    return this.attributes ? { ...this.attributes } : null;
  }
  getSupportedExtensions(): string[] {
    return [...this.supported];
  }
  getShaderPrecisionFormat(shaderType: number, precisionType: number): WebGLShaderPrecisionFormat | null {
    return this.shadow.getShaderPrecisionFormat(shaderType, precisionType);
  }
  /**
   * 擴充：影子上開（常數從影子的擴充物件抄），worker 那邊也開。方法（WEBGL_lose_context 的 loseContext 等）轉成 EXTENSION_CALL，
   * 參數只收數字
   */
  getExtension(name: string): object | null {
    if (this.extensionCache.has(name)) return this.extensionCache.get(name)!;
    const real = this.shadow.getExtension(name) as Record<string, unknown> | null;
    if (!real || !this.supported.includes(name)) {
      this.extensionCache.set(name, null);
      return null;
    }
    this.w.need(1);
    this.w.i32[this.w.p++] = OP.ENABLE_EXTENSION;
    this.w.str(name);
    const wrapper: Record<string, unknown> = {};
    for (let o: object | null = real; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (k in wrapper || k === 'constructor') continue;
        const d = Object.getOwnPropertyDescriptor(o, k);
        if (d && typeof d.value === 'number') wrapper[k] = d.value;
        else if (d && typeof d.value === 'function')
          wrapper[k] = (...args: unknown[]) => {
            if (args.some((a) => typeof a !== 'number')) throw new Error(`render thread：${name}.${k} 的參數只支援數字`);
            this.w.need(1);
            this.w.i32[this.w.p++] = OP.EXTENSION_CALL;
            this.w.str(name);
            this.w.str(k);
            this.w.need(1 + args.length);
            this.w.i32[this.w.p++] = args.length;
            for (const a of args) this.w.f32[this.w.p++] = a as number;
            return undefined;
          };
      }
    }
    this.extensionCache.set(name, wrapper);
    return wrapper;
  }
  isContextLost(): boolean {
    return this.lost;
  }
  getError(): number {
    return 0;
  }
  readPixels(): never {
    throw new Error('render thread：不支援 readPixels（主執行緒拿不到 worker 的像素）');
  }
  getBufferSubData(): never {
    throw new Error('render thread：不支援 getBufferSubData');
  }
  fenceSync(): never {
    throw new Error('render thread：不支援 fenceSync');
  }
  finish(): void {
    this.op1(OP.FINISH, 0);
  }
  flush(): void {
    this.op1(OP.FLUSH, 0);
  }

  get drawingBufferWidth(): number {
    return this.canvas.width;
  }
  get drawingBufferHeight(): number {
    return this.canvas.height;
  }
  get drawingBufferColorSpace(): string {
    return this.props.drawingBufferColorSpace;
  }
  set drawingBufferColorSpace(v: string) {
    this.setProp('drawingBufferColorSpace', v);
  }
  get unpackColorSpace(): string {
    return this.props.unpackColorSpace;
  }
  set unpackColorSpace(v: string) {
    this.setProp('unpackColorSpace', v);
  }
  private setProp(k: keyof typeof PROP, v: string): void {
    this.props[k] = v;
    this.op1(OP.SET_PROP, PROP[k]);
    this.w.str(v);
  }
  /** GfxCanvas 改寬或高（three.js setSize 先設 width 再設 height，各是一次重設繪圖緩衝）：OffscreenCanvas 照同樣順序改。which 0 寬、1 高 */
  resize(which: 0 | 1, v: number): void {
    this.op2(OP.RESIZE, which, v);
  }

  // ───────── 狀態 ─────────

  activeTexture(t: number): void {
    this.unit = t;
    this.op1(OP.ACTIVE_TEXTURE, t);
  }
  bindBuffer(target: number, b: GfxObject | null): void {
    // ELEMENT_ARRAY_BUFFER 的綁定是 VAO 的狀態（跟著 VAO 走）
    if (target === ELEMENT_ARRAY_BUFFER) this.vao.ref(-1, b);
    else this.keep(`b${target}`, b);
    this.op2(OP.BIND_BUFFER, target, this.id(b));
  }
  bindBufferBase(target: number, index: number, b: GfxObject | null): void {
    // 同時綁一般的 target 跟那個索引
    this.keep(`b${target}`, b);
    this.keep(`b${target}:${index}`, b);
    this.op3(OP.BIND_BUFFER_BASE, target, index, this.id(b));
  }
  bindFramebuffer(target: number, fb: GfxObject | null): void {
    if (target === FRAMEBUFFER || target === DRAW_FRAMEBUFFER) {
      this.drawToDefault = !fb;
      this.keep('fd', fb);
    }
    if (target === FRAMEBUFFER || target === READ_FRAMEBUFFER) this.keep('fr', fb);
    this.op2(OP.BIND_FRAMEBUFFER, target, this.id(fb));
  }
  bindRenderbuffer(target: number, rb: GfxObject | null): void {
    this.keep('r', rb);
    this.op2(OP.BIND_RENDERBUFFER, target, this.id(rb));
  }
  bindTexture(target: number, t: GfxObject | null): void {
    this.keep(`t${this.unit}:${target}`, t);
    this.op2(OP.BIND_TEXTURE, target, this.id(t));
  }
  bindVertexArray(v: GfxObject | null): void {
    this.vao = v ?? this.defaultVao;
    this.keep('v', v);
    this.op1(OP.BIND_VERTEX_ARRAY, this.id(v));
  }
  /** framebuffer* 的對象：target 目前綁的 framebuffer（綁預設 framebuffer 時是 undefined） */
  private fboOf(target: number): GfxObject | undefined {
    return this.bound.get(target === READ_FRAMEBUFFER ? 'fr' : 'fd');
  }
  blendColor(r: number, g: number, b: number, a: number): void {
    this.opF(OP.BLEND_COLOR, [r, g, b, a]);
  }
  blendEquation(m: number): void {
    this.op1(OP.BLEND_EQUATION, m);
  }
  blendEquationSeparate(a: number, b: number): void {
    this.op2(OP.BLEND_EQUATION_SEPARATE, a, b);
  }
  blendFunc(s: number, d: number): void {
    this.op2(OP.BLEND_FUNC, s, d);
  }
  blendFuncSeparate(a: number, b: number, c: number, d: number): void {
    this.op4(OP.BLEND_FUNC_SEPARATE, a, b, c, d);
  }
  clearColor(r: number, g: number, b: number, a: number): void {
    this.opF(OP.CLEAR_COLOR, [r, g, b, a]);
  }
  clearDepth(d: number): void {
    this.opF(OP.CLEAR_DEPTH, [d]);
  }
  clearStencil(s: number): void {
    this.op1(OP.CLEAR_STENCIL, s);
  }
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void {
    this.op4(OP.COLOR_MASK, r ? 1 : 0, g ? 1 : 0, b ? 1 : 0, a ? 1 : 0);
  }
  cullFace(m: number): void {
    this.op1(OP.CULL_FACE, m);
  }
  depthFunc(f: number): void {
    this.op1(OP.DEPTH_FUNC, f);
  }
  depthMask(flag: boolean): void {
    this.op1(OP.DEPTH_MASK, flag ? 1 : 0);
  }
  depthRange(n: number, f: number): void {
    this.opF(OP.DEPTH_RANGE, [n, f]);
  }
  disable(cap: number): void {
    this.op1(OP.DISABLE, cap);
  }
  enable(cap: number): void {
    this.op1(OP.ENABLE, cap);
  }
  disableVertexAttribArray(i: number): void {
    this.op1(OP.DISABLE_VERTEX_ATTRIB_ARRAY, i);
  }
  enableVertexAttribArray(i: number): void {
    this.op1(OP.ENABLE_VERTEX_ATTRIB_ARRAY, i);
  }
  frontFace(m: number): void {
    this.op1(OP.FRONT_FACE, m);
  }
  lineWidth(w: number): void {
    this.opF(OP.LINE_WIDTH, [w]);
  }
  pixelStorei(pname: number, param: number | boolean): void {
    const prev = this.store.get(pname);
    // 記下來的值照 getParameter 會回的型別：布林參數回布林
    if (prev !== undefined) this.store.set(pname, typeof prev === 'boolean' ? !!param : Number(param) | 0);
    this.op2(OP.PIXEL_STOREI, pname, typeof param === 'boolean' ? (param ? 1 : 0) : param);
  }
  polygonOffset(factor: number, units: number): void {
    this.opF(OP.POLYGON_OFFSET, [factor, units]);
  }
  readBuffer(src: number): void {
    this.op1(OP.READ_BUFFER, src);
  }
  scissor(x: number, y: number, w: number, h: number): void {
    this.scissorBox[0] = x;
    this.scissorBox[1] = y;
    this.scissorBox[2] = w;
    this.scissorBox[3] = h;
    this.op4(OP.SCISSOR, x, y, w, h);
  }
  viewport(x: number, y: number, w: number, h: number): void {
    this.viewportBox[0] = x;
    this.viewportBox[1] = y;
    this.viewportBox[2] = w;
    this.viewportBox[3] = h;
    this.op4(OP.VIEWPORT, x, y, w, h);
  }
  stencilFunc(f: number, ref: number, mask: number): void {
    this.op3(OP.STENCIL_FUNC, f, ref, mask);
  }
  stencilFuncSeparate(face: number, f: number, ref: number, mask: number): void {
    this.op4(OP.STENCIL_FUNC_SEPARATE, face, f, ref, mask);
  }
  stencilMask(m: number): void {
    this.op1(OP.STENCIL_MASK, m);
  }
  stencilMaskSeparate(face: number, m: number): void {
    this.op2(OP.STENCIL_MASK_SEPARATE, face, m);
  }
  stencilOp(a: number, b: number, c: number): void {
    this.op3(OP.STENCIL_OP, a, b, c);
  }
  stencilOpSeparate(face: number, a: number, b: number, c: number): void {
    this.op4(OP.STENCIL_OP_SEPARATE, face, a, b, c);
  }
  drawBuffers(list: ArrayLike<number>): void {
    this.w.need(2 + list.length);
    this.w.i32[this.w.p++] = OP.DRAW_BUFFERS;
    this.w.i32[this.w.p++] = list.length;
    this.ints(list, 0, list.length);
  }
  invalidateFramebuffer(target: number, attachments: ArrayLike<number>): void {
    this.w.need(3 + attachments.length);
    this.w.i32[this.w.p++] = OP.INVALIDATE_FRAMEBUFFER;
    this.w.i32[this.w.p++] = target;
    this.w.i32[this.w.p++] = attachments.length;
    this.ints(attachments, 0, attachments.length);
  }

  // ───────── 畫 ─────────

  clear(mask: number): void {
    this.op1(OP.CLEAR, mask);
    this.drew();
  }
  clearBufferfv(buffer: number, drawbuffer: number, values: FloatList, srcOffset = 0): void {
    const r = listRange(values.length, srcOffset, 0);
    if (!r) return;
    this.op3(OP.CLEAR_BUFFER_FV, buffer, drawbuffer, r[1]);
    this.floats(values, r[0], r[1]);
    this.drew();
  }
  clearBufferiv(buffer: number, drawbuffer: number, values: IntList, srcOffset = 0): void {
    const r = listRange(values.length, srcOffset, 0);
    if (!r) return;
    this.op3(OP.CLEAR_BUFFER_IV, buffer, drawbuffer, r[1]);
    this.ints(values, r[0], r[1]);
    this.drew();
  }
  clearBufferuiv(buffer: number, drawbuffer: number, values: UintList, srcOffset = 0): void {
    const r = listRange(values.length, srcOffset, 0);
    if (!r) return;
    this.op3(OP.CLEAR_BUFFER_UIV, buffer, drawbuffer, r[1]);
    this.ints(values, r[0], r[1]);
    this.drew();
  }
  clearBufferfi(buffer: number, drawbuffer: number, depth: number, stencil: number): void {
    this.op3(OP.CLEAR_BUFFER_FI, buffer, drawbuffer, stencil);
    this.floats([depth], 0, 1);
    this.drew();
  }
  drawArrays(mode: number, first: number, count: number): void {
    this.op3(OP.DRAW_ARRAYS, mode, first, count);
    this.drew();
  }
  drawArraysInstanced(mode: number, first: number, count: number, instances: number): void {
    this.op4(OP.DRAW_ARRAYS_INSTANCED, mode, first, count, instances);
    this.drew();
  }
  drawElements(mode: number, count: number, type: number, offset: number): void {
    this.op4(OP.DRAW_ELEMENTS, mode, count, type, offset);
    this.drew();
  }
  drawElementsInstanced(mode: number, count: number, type: number, offset: number, instances: number): void {
    this.opN(OP.DRAW_ELEMENTS_INSTANCED, [mode, count, type, offset, instances]);
    this.drew();
  }
  blitFramebuffer(sx0: number, sy0: number, sx1: number, sy1: number, dx0: number, dy0: number, dx1: number, dy1: number, mask: number, filter: number): void {
    this.opN(OP.BLIT_FRAMEBUFFER, [sx0, sy0, sx1, sy1, dx0, dy0, dx1, dy1, mask, filter]);
    this.drew();
  }

  // ───────── 頂點 ─────────

  vertexAttribPointer(index: number, size: number, type: number, normalized: boolean, stride: number, offset: number): void {
    // 屬性指向當時綁的 ARRAY_BUFFER：VAO 留著它
    this.vao.ref(index, this.bound.get(`b${ARRAY_BUFFER}`) ?? null);
    this.opN(OP.VERTEX_ATTRIB_POINTER, [index, size, type, normalized ? 1 : 0, stride, offset]);
  }
  vertexAttribIPointer(index: number, size: number, type: number, stride: number, offset: number): void {
    this.vao.ref(index, this.bound.get(`b${ARRAY_BUFFER}`) ?? null);
    this.opN(OP.VERTEX_ATTRIB_I_POINTER, [index, size, type, stride, offset]);
  }
  vertexAttribDivisor(index: number, divisor: number): void {
    this.op2(OP.VERTEX_ATTRIB_DIVISOR, index, divisor);
  }
  private attribV(n: number, index: number, v: FloatList): void {
    // WebGL：值的個數少於 n 是 INVALID_VALUE（不做事）
    if (v.length < n) return;
    this.op2(OP.VERTEX_ATTRIB_FV, n, index);
    this.floats(v, 0, n);
  }
  vertexAttrib1fv(i: number, v: FloatList): void {
    this.attribV(1, i, v);
  }
  vertexAttrib2fv(i: number, v: FloatList): void {
    this.attribV(2, i, v);
  }
  vertexAttrib3fv(i: number, v: FloatList): void {
    this.attribV(3, i, v);
  }
  vertexAttrib4fv(i: number, v: FloatList): void {
    this.attribV(4, i, v);
  }
  vertexAttrib1f(i: number, x: number): void {
    this.attribV(1, i, [x]);
  }
  vertexAttrib2f(i: number, x: number, y: number): void {
    this.attribV(2, i, [x, y]);
  }
  vertexAttrib3f(i: number, x: number, y: number, z: number): void {
    this.attribV(3, i, [x, y, z]);
  }
  vertexAttrib4f(i: number, x: number, y: number, z: number, w: number): void {
    this.attribV(4, i, [x, y, z, w]);
  }

  // ───────── buffer ─────────

  bufferData(target: number, data: number | ArrayBufferView | ArrayBuffer | null, usage: number, srcOffset = 0, length = 0): void {
    if (typeof data === 'number') {
      this.op3(OP.BUFFER_DATA_SIZE, target, data >>> 0, usage);
      return;
    }
    if (data === null) {
      this.op3(OP.BUFFER_DATA_SIZE, target, 0, usage);
      return;
    }
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const el = (view as Uint8Array).BYTES_PER_ELEMENT ?? 1;
    const r = listRange(view.byteLength / el, srcOffset, length);
    if (!r) return;
    const job = this.jobArrays.get(view);
    if (job) {
      // 新建的 buffer 整個陣列上傳：先配大小（補 0，跟新配的陣列一樣），工作的輸出寫在前面
      this.op3(OP.BUFFER_DATA_SIZE, target, r[1] * el, usage);
      this.jobCopy(target, 0, job, r[0] * el, r[1] * el);
      return;
    }
    this.op2(OP.BUFFER_DATA, target, usage);
    this.raw(view, r[0] * el, r[1] * el);
  }
  private jobCopy(target: number, dst: number, job: { job: number; stream: number }, byteStart: number, byteLength: number): void {
    const w = this.w;
    w.need(7);
    const i = w.i32;
    const p = w.p;
    i[p] = OP.BUFFER_SUB_DATA_JOB;
    i[p + 1] = target;
    w.u32[p + 2] = dst >>> 0;
    i[p + 3] = job.job;
    i[p + 4] = job.stream;
    i[p + 5] = byteStart;
    i[p + 6] = byteLength;
    w.p = p + 7;
  }
  bufferSubData(target: number, dstByteOffset: number, data: ArrayBufferView | ArrayBuffer, srcOffset = 0, length = 0): void {
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const el = (view as Uint8Array).BYTES_PER_ELEMENT ?? 1;
    const r = listRange(view.byteLength / el, srcOffset, length);
    if (!r) return;
    const job = this.jobArrays.get(view);
    if (job) {
      this.jobCopy(target, dstByteOffset, job, r[0] * el, r[1] * el);
      return;
    }
    const w = this.w;
    w.need(3);
    w.i32[w.p++] = OP.BUFFER_SUB_DATA;
    w.i32[w.p++] = target;
    w.u32[w.p++] = dstByteOffset >>> 0;
    this.raw(view, r[0] * el, r[1] * el);
  }

  // ───────── 貼圖 ─────────

  texParameteri(target: number, pname: number, param: number): void {
    this.op3(OP.TEX_PARAMETER_I, target, pname, param);
  }
  texParameterf(target: number, pname: number, param: number): void {
    this.op2(OP.TEX_PARAMETER_F, target, pname);
    this.floats([param], 0, 1);
  }
  texStorage2D(target: number, levels: number, internalformat: number, w: number, h: number): void {
    this.opN(OP.TEX_STORAGE_2D, [target, levels, internalformat, w, h]);
  }
  texStorage3D(target: number, levels: number, internalformat: number, w: number, h: number, d: number): void {
    this.opN(OP.TEX_STORAGE_3D, [target, levels, internalformat, w, h, d]);
  }
  generateMipmap(target: number): void {
    this.op1(OP.GENERATE_MIPMAP, target);
  }
  copyTexSubImage2D(target: number, level: number, xoff: number, yoff: number, x: number, y: number, w: number, h: number): void {
    this.opN(OP.COPY_TEX_SUB_IMAGE_2D, [target, level, xoff, yoff, x, y, w, h]);
  }
  copyTexSubImage3D(target: number, level: number, xoff: number, yoff: number, zoff: number, x: number, y: number, w: number, h: number): void {
    this.opN(OP.COPY_TEX_SUB_IMAGE_3D, [target, level, xoff, yoff, zoff, x, y, w, h]);
  }

  /**
   * 位元組資料：抄 GL 實際會讀的那段。UNPACK_ROW_LENGTH／SKIP_* 都是 0 時抄 view 從 srcOffset 起的全部（GL 讀多少由寬高決定，
   * 多抄不影響）；有設的話只抄讀得到的範圍，重播時 SKIP 暫時歸零（skipCleared）。FLIP_Y、PREMULTIPLY 開著或格式不認得時整個抄、
   * SKIP 不動（結果一樣，只是抄得多）。
   * 寫出：[viewKind][skipCleared][bytes]
   */
  private pixels(view: ArrayBufferView, srcOffset: number, w: number, h: number, d: number, format: number, type: number, is3d: boolean): void {
    const el = (view as Uint8Array).BYTES_PER_ELEMENT ?? 1;
    const base = (srcOffset >>> 0) * el;
    const avail = view.byteLength - base;
    const kind = viewKind(view);
    const st = this.store;
    const rowLength = st.get(UNPACK_ROW_LENGTH) as number;
    const skipPixels = st.get(UNPACK_SKIP_PIXELS) as number;
    const skipRows = st.get(UNPACK_SKIP_ROWS) as number;
    const imageHeight = is3d ? (st.get(UNPACK_IMAGE_HEIGHT) as number) : 0;
    const skipImages = is3d ? (st.get(UNPACK_SKIP_IMAGES) as number) : 0;
    const whole = (): void => {
      this.w.need(2);
      this.w.i32[this.w.p++] = kind;
      this.w.i32[this.w.p++] = 0;
      this.raw(view, base, Math.max(0, avail));
    };
    if (avail < 0) return whole();
    if (!rowLength && !skipPixels && !skipRows && !imageHeight && !skipImages) return whole();
    if (st.get(UNPACK_FLIP_Y_WEBGL) || st.get(UNPACK_PREMULTIPLY_ALPHA_WEBGL)) return whole();
    const bpp = bytesPerPixel(format, type);
    if (!bpp || w <= 0 || h <= 0 || d <= 0) return whole();
    const align = st.get(UNPACK_ALIGNMENT) as number;
    const rowBytes = (rowLength || w) * bpp;
    const stride = Math.ceil(rowBytes / align) * align;
    const imgRows = imageHeight || h;
    const start = skipImages * imgRows * stride + skipRows * stride + skipPixels * bpp;
    const size = (d - 1) * imgRows * stride + (h - 1) * stride + w * bpp;
    if (start + size > avail) return whole();
    this.w.need(2);
    this.w.i32[this.w.p++] = kind;
    this.w.i32[this.w.p++] = 1;
    this.raw(view, base + start, size);
  }

  /**
   * 影像來源：遠端影像、ImageBitmap、VideoFrame、<video>。回傳 [SRC 種類, 索引]；先算好再寫指令（建 VideoFrame 可能丟例外，
   * 不能寫到一半）
   */
  private sourceRef(src: unknown): [number, number] {
    if (src instanceof RemoteImage) return [SRC.REMOTE, this.imageSlot({ id: src.id, url: null })];
    if (typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap) return [SRC.EXT, this.ext.push(src) - 1];
    if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return [SRC.EXT, this.ext.push(src) - 1];
    if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) {
      // 影片的這一格：VideoFrame 轉移過去（worker 上傳完 close）。WebGL 對 <video> 與 VideoFrame 都照 UNPACK_FLIP_Y 等參數
      const frame = new VideoFrame(src, { timestamp: Math.round(src.currentTime * 1e6) });
      this.transfer.push(frame);
      return [SRC.EXT, this.ext.push(frame) - 1];
    }
    // 不該走到（開 render thread 時貼圖由 loadImage 載）：照網址交給 worker 自己抓
    if (typeof HTMLImageElement !== 'undefined' && src instanceof HTMLImageElement) return [SRC.URL, this.imageSlot({ id: -1, url: src.currentSrc || src.src })];
    throw new Error(`render thread：不支援的貼圖來源 ${Object.prototype.toString.call(src)}`);
  }
  /** 這一段的影像清單：同一張、同一組解碼參數只列一次 */
  private imageSlot(img: { id: number; url: string | null }): number {
    const st = this.store;
    const flipY = !!st.get(UNPACK_FLIP_Y_WEBGL);
    const premultiplyAlpha = !!st.get(UNPACK_PREMULTIPLY_ALPHA_WEBGL);
    const noConversion = st.get(UNPACK_COLORSPACE_CONVERSION_WEBGL) === 0;
    const key = `${img.id}|${img.url}|${flipY}|${premultiplyAlpha}|${noConversion}`;
    let i = this.imageIndex.get(key);
    if (i === undefined) {
      i = this.images.push({ id: img.id, url: img.url ?? undefined, flipY, premultiplyAlpha, noConversion }) - 1;
      this.imageIndex.set(key, i);
    }
    return i;
  }

  texImage2D(...a: unknown[]): void {
    const n = a.map((x) => x as number);
    if (a.length === 6) {
      // (target, level, internalformat, format, type, source)
      const [k, idx] = this.sourceRef(a[5]);
      this.opN(OP.TEX_IMAGE_2D_SRC, [n[0], n[1], n[2], n[3], n[4], 0, 0, 0, k, idx]);
      return;
    }
    const [target, level, internalformat, width, height, border, format, type] = n;
    const data = a[8];
    if (typeof data === 'number') throw new Error('render thread：不支援 PIXEL_UNPACK_BUFFER 的 texImage2D');
    if (data === null || data === undefined || ArrayBuffer.isView(data)) {
      this.opN(OP.TEX_IMAGE_2D, [target, level, internalformat, width, height, border, format, type, data ? 1 : 0]);
      if (data) this.pixels(data as ArrayBufferView, (a[9] as number) ?? 0, width, height, 1, format, type, false);
      return;
    }
    // (target, level, internalformat, width, height, border, format, type, source)
    const [k, idx] = this.sourceRef(data);
    this.opN(OP.TEX_IMAGE_2D_SRC, [target, level, internalformat, format, type, 1, width, height, k, idx]);
  }
  texSubImage2D(...a: unknown[]): void {
    const n = a.map((x) => x as number);
    if (a.length === 7) {
      // (target, level, x, y, format, type, source)
      const [k, idx] = this.sourceRef(a[6]);
      this.opN(OP.TEX_SUB_IMAGE_2D_SRC, [n[0], n[1], n[2], n[3], n[4], n[5], 0, 0, 0, k, idx]);
      return;
    }
    const [target, level, x, y, width, height, format, type] = n;
    const data = a[8];
    if (typeof data === 'number') throw new Error('render thread：不支援 PIXEL_UNPACK_BUFFER 的 texSubImage2D');
    if (data === null || data === undefined) throw new Error('render thread：texSubImage2D 沒有資料');
    if (ArrayBuffer.isView(data)) {
      this.opN(OP.TEX_SUB_IMAGE_2D, [target, level, x, y, width, height, format, type]);
      this.pixels(data, (a[9] as number) ?? 0, width, height, 1, format, type, false);
      return;
    }
    const [k, idx] = this.sourceRef(data);
    this.opN(OP.TEX_SUB_IMAGE_2D_SRC, [target, level, x, y, format, type, 1, width, height, k, idx]);
  }
  texImage3D(...a: unknown[]): void {
    const [target, level, internalformat, width, height, depth, border, format, type] = a.map((x) => x as number);
    const data = a[9];
    if (data !== null && data !== undefined && !ArrayBuffer.isView(data)) throw new Error('render thread：texImage3D 只支援位元組資料');
    this.opN(OP.TEX_IMAGE_3D, [target, level, internalformat, width, height, depth, border, format, type, data ? 1 : 0]);
    if (data) this.pixels(data as ArrayBufferView, (a[10] as number) ?? 0, width, height, depth, format, type, true);
  }
  texSubImage3D(...a: unknown[]): void {
    const [target, level, x, y, z, width, height, depth, format, type] = a.map((v) => v as number);
    const data = a[10];
    if (!ArrayBuffer.isView(data)) throw new Error('render thread：texSubImage3D 只支援位元組資料');
    this.opN(OP.TEX_SUB_IMAGE_3D, [target, level, x, y, z, width, height, depth, format, type]);
    this.pixels(data, (a[11] as number) ?? 0, width, height, depth, format, type, true);
  }
  compressedTexImage2D(target: number, level: number, internalformat: number, w: number, h: number, border: number, data: ArrayBufferView): void {
    this.opN(OP.COMPRESSED_TEX_IMAGE_2D, [target, level, internalformat, w, h, border]);
    this.raw(data, 0, data.byteLength);
  }
  compressedTexSubImage2D(target: number, level: number, x: number, y: number, w: number, h: number, format: number, data: ArrayBufferView): void {
    this.opN(OP.COMPRESSED_TEX_SUB_IMAGE_2D, [target, level, x, y, w, h, format]);
    this.raw(data, 0, data.byteLength);
  }
  compressedTexImage3D(target: number, level: number, internalformat: number, w: number, h: number, d: number, border: number, data: ArrayBufferView): void {
    this.opN(OP.COMPRESSED_TEX_IMAGE_3D, [target, level, internalformat, w, h, d, border]);
    this.raw(data, 0, data.byteLength);
  }
  compressedTexSubImage3D(target: number, level: number, x: number, y: number, z: number, w: number, h: number, d: number, format: number, data: ArrayBufferView): void {
    this.opN(OP.COMPRESSED_TEX_SUB_IMAGE_3D, [target, level, x, y, z, w, h, d, format]);
    this.raw(data, 0, data.byteLength);
  }

  // ───────── framebuffer、renderbuffer ─────────

  framebufferRenderbuffer(target: number, attachment: number, rbTarget: number, rb: GfxObject | null): void {
    this.fboOf(target)?.ref(attachment, rb);
    this.op4(OP.FRAMEBUFFER_RENDERBUFFER, target, attachment, rbTarget, this.id(rb));
  }
  framebufferTexture2D(target: number, attachment: number, texTarget: number, t: GfxObject | null, level: number): void {
    this.fboOf(target)?.ref(attachment, t);
    this.opN(OP.FRAMEBUFFER_TEXTURE_2D, [target, attachment, texTarget, this.id(t), level]);
  }
  framebufferTextureLayer(target: number, attachment: number, t: GfxObject | null, level: number, layer: number): void {
    this.fboOf(target)?.ref(attachment, t);
    this.opN(OP.FRAMEBUFFER_TEXTURE_LAYER, [target, attachment, this.id(t), level, layer]);
  }
  renderbufferStorage(target: number, internalformat: number, w: number, h: number): void {
    this.op4(OP.RENDERBUFFER_STORAGE, target, internalformat, w, h);
  }
  renderbufferStorageMultisample(target: number, samples: number, internalformat: number, w: number, h: number): void {
    this.opN(OP.RENDERBUFFER_STORAGE_MULTISAMPLE, [target, samples, internalformat, w, h]);
  }
  checkFramebufferStatus(): number {
    // three.js（0.186.1）只在 readRenderTargetPixels 用，那條路在 render thread 不支援
    return 0x8cd5;
  }

  // ───────── uniform ─────────

  /** uniform{n}{f,i,ui}：kind 0 f、1 i、2 ui；n 1～4 個值 */
  private uniformN(kind: number, n: number, loc: GfxObject | null, x: number, y: number, z: number, v: number): void {
    const w = this.w;
    w.need(8);
    const i = w.i32;
    const p = w.p;
    i[p] = OP.UNIFORM_N;
    i[p + 1] = kind;
    i[p + 2] = n;
    i[p + 3] = loc ? loc.id : 0;
    if (kind === 0) {
      const f = w.f32;
      f[p + 4] = x;
      if (n > 1) f[p + 5] = y;
      if (n > 2) f[p + 6] = z;
      if (n > 3) f[p + 7] = v;
    } else {
      i[p + 4] = x;
      if (n > 1) i[p + 5] = y;
      if (n > 2) i[p + 6] = z;
      if (n > 3) i[p + 7] = v;
    }
    w.p = p + 4 + n;
  }
  uniform1f(l: GfxObject | null, x: number): void {
    this.uniformN(0, 1, l, x, 0, 0, 0);
  }
  uniform2f(l: GfxObject | null, x: number, y: number): void {
    this.uniformN(0, 2, l, x, y, 0, 0);
  }
  uniform3f(l: GfxObject | null, x: number, y: number, z: number): void {
    this.uniformN(0, 3, l, x, y, z, 0);
  }
  uniform4f(l: GfxObject | null, x: number, y: number, z: number, w: number): void {
    this.uniformN(0, 4, l, x, y, z, w);
  }
  uniform1i(l: GfxObject | null, x: number): void {
    this.uniformN(1, 1, l, x, 0, 0, 0);
  }
  uniform2i(l: GfxObject | null, x: number, y: number): void {
    this.uniformN(1, 2, l, x, y, 0, 0);
  }
  uniform3i(l: GfxObject | null, x: number, y: number, z: number): void {
    this.uniformN(1, 3, l, x, y, z, 0);
  }
  uniform4i(l: GfxObject | null, x: number, y: number, z: number, w: number): void {
    this.uniformN(1, 4, l, x, y, z, w);
  }
  uniform1ui(l: GfxObject | null, x: number): void {
    this.uniformN(2, 1, l, x, 0, 0, 0);
  }
  uniform2ui(l: GfxObject | null, x: number, y: number): void {
    this.uniformN(2, 2, l, x, y, 0, 0);
  }
  uniform3ui(l: GfxObject | null, x: number, y: number, z: number): void {
    this.uniformN(2, 3, l, x, y, z, 0);
  }
  uniform4ui(l: GfxObject | null, x: number, y: number, z: number, w: number): void {
    this.uniformN(2, 4, l, x, y, z, w);
  }
  /** kind 0 f、1 i、2 ui；size 1～4 */
  private uniformV(kind: number, size: number, loc: GfxObject | null, data: ArrayLike<number>, srcOffset: number, srcLength: number): void {
    const r = listRange(data.length, srcOffset, srcLength);
    if (!r) return;
    const w = this.w;
    w.need(5);
    const i = w.i32;
    const p = w.p;
    i[p] = OP.UNIFORM_V;
    i[p + 1] = kind;
    i[p + 2] = size;
    i[p + 3] = loc ? loc.id : 0;
    i[p + 4] = r[1];
    w.p = p + 5;
    if (kind === 0) this.floats(data, r[0], r[1]);
    else this.ints(data, r[0], r[1]);
  }
  uniform1fv(l: GfxObject | null, v: FloatList, o = 0, n = 0): void {
    this.uniformV(0, 1, l, v, o, n);
  }
  uniform2fv(l: GfxObject | null, v: FloatList, o = 0, n = 0): void {
    this.uniformV(0, 2, l, v, o, n);
  }
  uniform3fv(l: GfxObject | null, v: FloatList, o = 0, n = 0): void {
    this.uniformV(0, 3, l, v, o, n);
  }
  uniform4fv(l: GfxObject | null, v: FloatList, o = 0, n = 0): void {
    this.uniformV(0, 4, l, v, o, n);
  }
  uniform1iv(l: GfxObject | null, v: IntList, o = 0, n = 0): void {
    this.uniformV(1, 1, l, v, o, n);
  }
  uniform2iv(l: GfxObject | null, v: IntList, o = 0, n = 0): void {
    this.uniformV(1, 2, l, v, o, n);
  }
  uniform3iv(l: GfxObject | null, v: IntList, o = 0, n = 0): void {
    this.uniformV(1, 3, l, v, o, n);
  }
  uniform4iv(l: GfxObject | null, v: IntList, o = 0, n = 0): void {
    this.uniformV(1, 4, l, v, o, n);
  }
  uniform1uiv(l: GfxObject | null, v: UintList, o = 0, n = 0): void {
    this.uniformV(2, 1, l, v, o, n);
  }
  uniform2uiv(l: GfxObject | null, v: UintList, o = 0, n = 0): void {
    this.uniformV(2, 2, l, v, o, n);
  }
  uniform3uiv(l: GfxObject | null, v: UintList, o = 0, n = 0): void {
    this.uniformV(2, 3, l, v, o, n);
  }
  uniform4uiv(l: GfxObject | null, v: UintList, o = 0, n = 0): void {
    this.uniformV(2, 4, l, v, o, n);
  }
  private uniformMatrix(size: number, loc: GfxObject | null, transpose: boolean, data: FloatList, srcOffset: number, srcLength: number): void {
    const r = listRange(data.length, srcOffset, srcLength);
    if (!r) return;
    const w = this.w;
    w.need(5);
    const i = w.i32;
    const p = w.p;
    i[p] = OP.UNIFORM_MATRIX;
    i[p + 1] = size;
    i[p + 2] = loc ? loc.id : 0;
    i[p + 3] = transpose ? 1 : 0;
    i[p + 4] = r[1];
    w.p = p + 5;
    this.floats(data, r[0], r[1]);
  }
  uniformMatrix2fv(l: GfxObject | null, t: boolean, v: FloatList, o = 0, n = 0): void {
    this.uniformMatrix(2, l, t, v, o, n);
  }
  uniformMatrix3fv(l: GfxObject | null, t: boolean, v: FloatList, o = 0, n = 0): void {
    this.uniformMatrix(3, l, t, v, o, n);
  }
  uniformMatrix4fv(l: GfxObject | null, t: boolean, v: FloatList, o = 0, n = 0): void {
    this.uniformMatrix(4, l, t, v, o, n);
  }
}

/**
 * three.js 拿到的畫布：寬高（setSize 改的時候 OffscreenCanvas 跟著改）、事件（webglcontextlost 等）、getContext 回 GfxContext。
 * 真的 <canvas> 已經 transferControlToOffscreen，CSS 大小照舊由主執行緒管（fitCanvas），這裡不碰 style
 */
export class GfxCanvas extends EventTarget {
  private w: number;
  private h: number;
  /** three.js getContext 傳的屬性（render thread 開機時已經照這組建好 worker 的 context，不一樣就丟例外） */
  expectedAttributes: WebGLContextAttributes | null = null;
  readonly style: Record<string, string> = {};
  constructor(
    private readonly ctx: GfxContext,
    w: number,
    h: number,
  ) {
    super();
    this.w = w;
    this.h = h;
  }
  get width(): number {
    return this.w;
  }
  set width(v: number) {
    this.w = v >>> 0;
    this.ctx.resize(0, this.w);
  }
  get height(): number {
    return this.h;
  }
  set height(v: number) {
    this.h = v >>> 0;
    this.ctx.resize(1, this.h);
  }
  get clientWidth(): number {
    return this.w;
  }
  get clientHeight(): number {
    return this.h;
  }
  getContext(name: string, attributes?: WebGLContextAttributes): GfxContext | null {
    if (name !== 'webgl2') return null;
    const want = this.expectedAttributes;
    if (want && attributes) {
      for (const k of Object.keys(attributes) as (keyof WebGLContextAttributes)[])
        if (attributes[k] !== want[k]) throw new Error(`render thread：getContext 的 ${k}=${String(attributes[k])}，worker 的 context 建成 ${String(want[k])}`);
    }
    return this.ctx;
  }
}

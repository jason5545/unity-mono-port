// render thread 的指令格式（2026/10/18，照 Unity 的執行緒分工：主執行緒產生繪製指令，render thread 執行圖形 API）。
//
// Unity 的 multithreaded rendering：主執行緒的繪製迴圈把 GfxDevice 的指令寫進佇列（GfxDeviceClient），render thread 讀出來
// 呼叫真的圖形 API（Gfx.ProcessCommands 在 render thread，Gfx.WaitForRenderThread 是主執行緒等它，手冊 profiler-markers）。
// 這裡的對應：three.js 照舊在主執行緒跑，拿到的 WebGL context 是 client.ts 的 GfxContext，每個 gl.* 呼叫寫成一筆指令；
// worker（worker.ts）用 OffscreenCanvas 的 WebGL2 context 照順序重播（replay.ts）。呼叫的順序、參數、上傳的位元組都跟直接呼叫一樣，
// 畫出來逐位元相同。
//
// 一筆指令：[op:u32][參數…]，全部 4 位元組對齊。整數照 32 位元的位元樣式存（Int32Array 寫、照參數的有號無號讀，
// 跟 WebIDL 的 ToInt32／ToUint32 結果一樣），GLfloat 存 Float32（WebIDL 也是轉成 float32），布林存 0／1。
// 位元組資料：[byteLength:u32][位元組，補到 4 的倍數]；字串是 UTF-8 的位元組資料。
// 物件（buffer、texture、program…）用編號，0 是 null。

export const OP = {
  CREATE: 1, // kind id [shaderType]
  DELETE: 2, // kind id
  UNIFORM_LOCATION: 3, // program loc name
  ENABLE_EXTENSION: 4, // name
  RESIZE: 5, // which（0 寬、1 高） value：OffscreenCanvas 的繪圖緩衝大小
  SET_PROP: 6, // which value(str)：drawingBufferColorSpace、unpackColorSpace

  ACTIVE_TEXTURE: 10,
  ATTACH_SHADER: 11,
  BIND_ATTRIB_LOCATION: 12,
  BIND_BUFFER: 13,
  BIND_BUFFER_BASE: 14,
  BIND_FRAMEBUFFER: 15,
  BIND_RENDERBUFFER: 16,
  BIND_TEXTURE: 17,
  BIND_VERTEX_ARRAY: 18,
  BLEND_COLOR: 19,
  BLEND_EQUATION: 20,
  BLEND_EQUATION_SEPARATE: 21,
  BLEND_FUNC: 22,
  BLEND_FUNC_SEPARATE: 23,
  BLIT_FRAMEBUFFER: 24,
  BUFFER_DATA_SIZE: 25,
  BUFFER_DATA: 26,
  BUFFER_SUB_DATA: 27,
  CLEAR: 28,
  CLEAR_BUFFER_FV: 29,
  CLEAR_BUFFER_IV: 30,
  CLEAR_BUFFER_UIV: 31,
  CLEAR_BUFFER_FI: 32,
  CLEAR_COLOR: 33,
  CLEAR_DEPTH: 34,
  CLEAR_STENCIL: 35,
  COLOR_MASK: 36,
  COMPILE_SHADER: 37,
  COPY_TEX_SUB_IMAGE_2D: 38,
  COPY_TEX_SUB_IMAGE_3D: 39,
  CULL_FACE: 40,
  DEPTH_FUNC: 41,
  DEPTH_MASK: 42,
  DEPTH_RANGE: 43,
  DETACH_SHADER: 44,
  DISABLE: 45,
  DISABLE_VERTEX_ATTRIB_ARRAY: 46,
  DRAW_ARRAYS: 47,
  DRAW_ARRAYS_INSTANCED: 48,
  DRAW_BUFFERS: 49,
  DRAW_ELEMENTS: 50,
  DRAW_ELEMENTS_INSTANCED: 51,
  ENABLE: 52,
  ENABLE_VERTEX_ATTRIB_ARRAY: 53,
  FINISH: 54,
  FLUSH: 55,
  FRAMEBUFFER_RENDERBUFFER: 56,
  FRAMEBUFFER_TEXTURE_2D: 57,
  FRAMEBUFFER_TEXTURE_LAYER: 58,
  FRONT_FACE: 59,
  GENERATE_MIPMAP: 60,
  INVALIDATE_FRAMEBUFFER: 61,
  LINE_WIDTH: 62,
  LINK_PROGRAM: 63,
  PIXEL_STOREI: 64,
  POLYGON_OFFSET: 65,
  READ_BUFFER: 66,
  RENDERBUFFER_STORAGE: 67,
  RENDERBUFFER_STORAGE_MULTISAMPLE: 68,
  SCISSOR: 69,
  SHADER_SOURCE: 70,
  STENCIL_FUNC: 71,
  STENCIL_FUNC_SEPARATE: 72,
  STENCIL_MASK: 73,
  STENCIL_MASK_SEPARATE: 74,
  STENCIL_OP: 75,
  STENCIL_OP_SEPARATE: 76,
  TEX_PARAMETER_F: 77,
  TEX_PARAMETER_I: 78,
  TEX_STORAGE_2D: 79,
  TEX_STORAGE_3D: 80,
  /** 位元組資料版：target level internalformat w h border format type hasData [viewKind skipCleared bytes] */
  TEX_IMAGE_2D: 81,
  /** 影像來源版：target level internalformat format type hasSize w h srcKind srcIndex（SRC、hasSize 是 9 個參數的多載） */
  TEX_IMAGE_2D_SRC: 82,
  /** target level x y w h format type [viewKind skipCleared bytes] */
  TEX_SUB_IMAGE_2D: 83,
  /** target level x y format type hasSize w h srcKind srcIndex */
  TEX_SUB_IMAGE_2D_SRC: 84,
  TEX_IMAGE_3D: 85,
  TEX_SUB_IMAGE_3D: 86,
  COMPRESSED_TEX_IMAGE_2D: 87,
  COMPRESSED_TEX_SUB_IMAGE_2D: 88,
  COMPRESSED_TEX_IMAGE_3D: 89,
  COMPRESSED_TEX_SUB_IMAGE_3D: 90,
  UNIFORM_BLOCK_BINDING: 91,
  USE_PROGRAM: 92,
  VERTEX_ATTRIB_DIVISOR: 93,
  VERTEX_ATTRIB_I_POINTER: 94,
  VERTEX_ATTRIB_POINTER: 95,
  VERTEX_ATTRIB_FV: 96, // n index values
  VIEWPORT: 97,
  /** uniform{1,2,3,4}{f,i,ui}：kind(0 f、1 i、2 ui) n loc values */
  UNIFORM_N: 98,
  /** uniform{1,2,3,4}{f,i,ui}v：kind size loc count values */
  UNIFORM_V: 99,
  /** uniformMatrix{2,3,4}fv：size loc transpose count values */
  UNIFORM_MATRIX: 100,
  EXTENSION_CALL: 101, // name method argc args(u32)
  /** 粒子網格工作（particleJobs.ts，對應 Unity 的 ParticleSystem.GeometryJob） */
  SIM_DEF: 102, // simId json（模組設定、renderer 欄位、mesh 粒子的網格）
  SIM_STATE: 103, // simId n [SoA 陣列…] pose
  PARTICLE_JOB: 104, // jobId simId camera(f64×14) linearColor
  /** buffer 的資料來自粒子網格工作：target dstByteOffset jobId stream byteStart byteLength */
  BUFFER_SUB_DATA_JOB: 105,
} as const;

/** BUFFER_SUB_DATA_JOB 的資料流：位置、法線、顏色、TEXCOORDn（3＋n）、三角形 */
export const JOB_STREAM = { position: 0, normal: 1, color: 2, texcoord0: 3, indices: 100 } as const;

/** 物件種類（CREATE／DELETE 用） */
export const KIND = {
  BUFFER: 1,
  TEXTURE: 2,
  FRAMEBUFFER: 3,
  RENDERBUFFER: 4,
  PROGRAM: 5,
  SHADER: 6,
  VERTEX_ARRAY: 7,
  QUERY: 8,
  SAMPLER: 9,
  /** WebGLUniformLocation（UNIFORM_LOCATION 建、不刪：程式刪掉時一起失效，跟 WebGL 一樣） */
  LOCATION: 10,
} as const;

/** TEX_*_SRC 的影像來源 */
export const SRC = {
  /** worker 那邊的遠端影像（loadImage 先把 PNG 位元組送過去，上傳時照 unpack 狀態解碼） */
  REMOTE: 1,
  /** 這一段附帶的物件（ImageBitmap、VideoFrame），參數是 ext 陣列的索引 */
  EXT: 2,
  /** 網址（驗證模式：主執行緒自己用 <img>，worker 照網址抓） */
  URL: 3,
} as const;

/** SET_PROP 的屬性 */
export const PROP = { drawingBufferColorSpace: 1, unpackColorSpace: 2 } as const;

/** 一段指令附帶的遠端影像：上傳時的解碼參數（照當時的 UNPACK_FLIP_Y、PREMULTIPLY_ALPHA、COLORSPACE_CONVERSION） */
export interface SegmentImage {
  /** 遠端影像的編號（SRC.REMOTE）；SRC.URL 是 −1 */
  id: number;
  /** SRC.URL：worker 自己照網址抓 */
  url?: string;
  flipY: boolean;
  premultiplyAlpha: boolean;
  /** UNPACK_COLORSPACE_CONVERSION_WEBGL 是 NONE */
  noConversion: boolean;
}

/** 主執行緒 → worker */
export type ToWorker =
  /** 交出畫布之前先試：worker 裡建得出這組屬性的 WebGL2 嗎（transferControlToOffscreen 之後就回不去了） */
  | { type: 'probe'; attributes: WebGLContextAttributes }
  | { type: 'init'; canvas: OffscreenCanvas; attributes: WebGLContextAttributes; params: number[] }
  /** 驗證模式（verify.ts）：worker 自己建一張不顯示的 OffscreenCanvas 重播 */
  | { type: 'initVerify'; width: number; height: number; attributes: WebGLContextAttributes; params: number[] }
  /** check：驗證模式，重播完讀回預設 framebuffer 的像素（FromWorker 的 check） */
  | { type: 'segment'; buf: ArrayBuffer; words: number; ext: (ImageBitmap | VideoFrame)[]; images: SegmentImage[]; frame: number | null; check?: boolean }
  | { type: 'image'; id: number; bytes: ArrayBuffer }
  | { type: 'dropImage'; id: number };

/** worker → 主執行緒 */
export type FromWorker =
  | { type: 'probe'; ok: boolean; error?: string }
  | { type: 'ready'; ok: true; attributes: WebGLContextAttributes | null; params: Record<number, unknown>; extensions: string[] }
  | { type: 'ready'; ok: false; error: string }
  | { type: 'done'; frame: number | null; buf: ArrayBuffer }
  | { type: 'check'; frame: number; width: number; height: number; pixels: Uint8Array }
  | { type: 'error'; message: string }
  | { type: 'lost' };

/** 位元組資料型別 → 每個元素幾個位元組（貼圖上傳要照 type 建對的 view） */
export function viewOf(buf: ArrayBuffer, type: number, byteOffset: number, byteLength: number): ArrayBufferView {
  switch (type) {
    case 0x1400: // BYTE
      return new Int8Array(buf, byteOffset, byteLength);
    case 0x1402: // SHORT
      return new Int16Array(buf, byteOffset, byteLength >> 1);
    case 0x1403: // UNSIGNED_SHORT
    case 0x140b: // HALF_FLOAT
    case 0x8363: // UNSIGNED_SHORT_5_6_5
    case 0x8033: // UNSIGNED_SHORT_4_4_4_4
    case 0x8034: // UNSIGNED_SHORT_5_5_5_1
      return new Uint16Array(buf, byteOffset, byteLength >> 1);
    case 0x1404: // INT
      return new Int32Array(buf, byteOffset, byteLength >> 2);
    case 0x1405: // UNSIGNED_INT
    case 0x84fa: // UNSIGNED_INT_24_8
    case 0x8368: // UNSIGNED_INT_2_10_10_10_REV
    case 0x8c3b: // UNSIGNED_INT_10F_11F_11F_REV
    case 0x8c3e: // UNSIGNED_INT_5_9_9_9_REV
      return new Uint32Array(buf, byteOffset, byteLength >> 2);
    case 0x1406: // FLOAT
      return new Float32Array(buf, byteOffset, byteLength >> 2);
    default:
      return new Uint8Array(buf, byteOffset, byteLength);
  }
}

/** 每個像素幾個位元組（unpack 範圍計算用）；不認得的組合回 0（呼叫端改成整個 view 都抄） */
export function bytesPerPixel(format: number, type: number): number {
  const comps: Record<number, number> = {
    0x1903: 1, // RED
    0x8d94: 1, // RED_INTEGER
    0x8227: 2, // RG
    0x8228: 2, // RG_INTEGER
    0x1907: 3, // RGB
    0x8d98: 3, // RGB_INTEGER
    0x1908: 4, // RGBA
    0x8d99: 4, // RGBA_INTEGER
    0x1906: 1, // ALPHA
    0x1909: 1, // LUMINANCE
    0x190a: 2, // LUMINANCE_ALPHA
    0x1902: 1, // DEPTH_COMPONENT
  };
  const packed: Record<number, number> = { 0x8363: 2, 0x8033: 2, 0x8034: 2, 0x84fa: 4, 0x8368: 4, 0x8c3b: 4, 0x8c3e: 4 };
  if (packed[type]) return packed[type];
  const n = comps[format];
  if (!n) return 0;
  const size: Record<number, number> = { 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x140b: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4 };
  return size[type] ? n * size[type] : 0;
}

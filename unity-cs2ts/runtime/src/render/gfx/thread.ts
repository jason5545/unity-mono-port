// render thread 的主執行緒端啟動（2026/10/18）：開 worker、把 <canvas> 交過去、建影子 context，回傳給 three.js 用的畫布與 context。
// 照 Unity 的分工：主執行緒產生繪製指令，render thread 執行；主執行緒最多領先一格（Unity 的 Gfx.WaitForRenderThread，
// 手冊 profiler-markers），這裡用 busy() 讓主迴圈那一個 rAF 先不跑。render thread 只收指令、不回結果給遊戲，沒有「晚一格」的問題。
//
// 不需要 SharedArrayBuffer：指令用 postMessage 轉移 ArrayBuffer（Android WebView 沒有跨來源隔離，Chromium issue 40914606）。
// 瀏覽器沒有 Worker／OffscreenCanvas／transferControlToOffscreen、影子 context 建不起來、worker 裡建不出 WebGL2 時回 null，
// 呼叫端照舊在主執行緒畫（結果一樣）。

import { GfxCanvas, GfxContext, RemoteImage, type Segment } from './client';
import { ParticleJobs } from './particleJobs';
import type { FromWorker, ToWorker } from './protocol';

/**
 * three.js（0.186.1）WebGLRenderer({ antialias: false, alpha: false }) 給 getContext 的屬性（WebGLRenderer.js 的 contextAttributes：
 * alpha 一律 true，其他是預設值）。worker 的 context 照這組先建好，three.js 呼叫 GfxCanvas.getContext 時比對
 */
export const THREE_CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  depth: true,
  stencil: false,
  antialias: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'default',
  failIfMajorPerformanceCaveat: false,
};

/** worker 開機時查好的固定參數（three.js 的 WebGLCapabilities、WebGLState 讀這些；不在這裡的問主執行緒的影子 context） */
const STATIC_PARAMS = [
  0x1f00, // VENDOR
  0x1f01, // RENDERER
  0x1f02, // VERSION
  0x8b8c, // SHADING_LANGUAGE_VERSION
  0x0d33, // MAX_TEXTURE_SIZE
  0x851c, // MAX_CUBE_MAP_TEXTURE_SIZE
  0x84e8, // MAX_RENDERBUFFER_SIZE
  0x8872, // MAX_TEXTURE_IMAGE_UNITS
  0x8b4c, // MAX_VERTEX_TEXTURE_IMAGE_UNITS
  0x8b4d, // MAX_COMBINED_TEXTURE_IMAGE_UNITS
  0x8869, // MAX_VERTEX_ATTRIBS
  0x8dfb, // MAX_VERTEX_UNIFORM_VECTORS
  0x8dfc, // MAX_VARYING_VECTORS
  0x8dfd, // MAX_FRAGMENT_UNIFORM_VECTORS
  0x8d57, // MAX_SAMPLES
  0x80a9, // SAMPLES
  0x80a8, // SAMPLE_BUFFERS
  0x8073, // MAX_3D_TEXTURE_SIZE
  0x88ff, // MAX_ARRAY_TEXTURE_LAYERS
  0x8cdf, // MAX_COLOR_ATTACHMENTS
  0x8824, // MAX_DRAW_BUFFERS
  0x8a2f, // MAX_UNIFORM_BUFFER_BINDINGS
  0x8a30, // MAX_UNIFORM_BLOCK_SIZE
  0x8a34, // UNIFORM_BUFFER_OFFSET_ALIGNMENT
  0x0d3a, // MAX_VIEWPORT_DIMS
  0x846e, // ALIASED_LINE_WIDTH_RANGE
  0x846d, // ALIASED_POINT_SIZE_RANGE
  0x8d6b, // MAX_ELEMENT_INDEX
  0x84fd, // MAX_TEXTURE_LOD_BIAS
  0x8b9b, // IMPLEMENTATION_COLOR_READ_FORMAT
  0x8b9a, // IMPLEMENTATION_COLOR_READ_TYPE
];

export interface RenderThread {
  /** 給 three.js 的畫布（getContext 回 gl） */
  readonly canvas: GfxCanvas;
  readonly gl: GfxContext;
  /** 一格的繪製結束（SceneRenderer.render 最後呼叫）：這一段送出去 */
  endFrame(): void;
  /** worker 落後兩格以上：主迴圈這個 rAF 先不跑（Unity 的主執行緒最多領先 render thread 一格） */
  busy(): boolean;
  /** 貼圖的 PNG：主執行緒只抓位元組（寬高讀 IHDR），交給 worker 上傳時解碼。驗證模式是 null（主執行緒照舊用 <img>） */
  loadImage: ((url: string) => Promise<RemoteImage>) | null;
  /** 粒子網格工作（ParticleSystemRenderer 的 buildParticles 交給 worker；驗證模式沒有） */
  readonly particles: ParticleJobs | null;
  /** worker 回報的錯誤（重播失敗、解碼失敗） */
  readonly errors: string[];
  readonly stats: { framesSent: number; framesDone: number; images: number };
  dispose(): void;
}

/** PNG 的寬高（IHDR）；不是 PNG 回 null */
function pngSize(b: ArrayBuffer): [number, number] | null {
  if (b.byteLength < 24) return null;
  const u = new Uint8Array(b, 0, 24);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (sig.some((v, i) => u[i] !== v)) return null;
  const dv = new DataView(b, 16, 8);
  return [dv.getUint32(0), dv.getUint32(4)];
}

/** GL 常數（WebGL2RenderingContext 上的大寫數字屬性） */
function glConstants(gl: WebGL2RenderingContext): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k in gl) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) continue;
    const v = (gl as unknown as Record<string, unknown>)[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

function nextMessage<T extends FromWorker['type']>(worker: Worker, type: T, timeoutMs: number): Promise<Extract<FromWorker, { type: T }> | null> {
  return new Promise((resolve) => {
    const done = (v: Extract<FromWorker, { type: T }> | null): void => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMsg);
      worker.removeEventListener('error', onErr);
      resolve(v);
    };
    const onMsg = (e: MessageEvent<FromWorker>): void => {
      if (e.data.type === type) done(e.data as Extract<FromWorker, { type: T }>);
    };
    const onErr = (): void => done(null);
    const timer = setTimeout(() => done(null), timeoutMs);
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', onErr);
  });
}

/**
 * 開 render thread。成功後 <canvas> 已經交給 worker（不能再 getContext），呼叫端的 three.js 要用回傳的 canvas。
 * 回 null 時畫布沒動過，照舊在主執行緒畫
 */
export async function startRenderThread(canvas: HTMLCanvasElement, attributes: WebGLContextAttributes = THREE_CONTEXT_ATTRIBUTES): Promise<RenderThread | null> {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof canvas.transferControlToOffscreen !== 'function') return null;
  const shadow = new OffscreenCanvas(1, 1).getContext('webgl2', attributes) as WebGL2RenderingContext | null;
  if (!shadow) return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  const post = (m: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(m, transfer);
  post({ type: 'probe', attributes });
  const probe = await nextMessage(worker, 'probe', 10_000);
  if (!probe?.ok) {
    worker.terminate();
    return null;
  }
  const width = canvas.width;
  const height = canvas.height;
  const off = canvas.transferControlToOffscreen();
  post({ type: 'init', canvas: off, attributes, params: STATIC_PARAMS }, [off]);
  const ready = await nextMessage(worker, 'ready', 10_000);
  // 畫布已經交出去了，這裡失敗就沒有退路（probe 用同一組屬性試過，正常不會走到）
  if (!ready || !ready.ok) throw new Error(`render thread：worker 建不了 WebGL2（${ready && !ready.ok ? ready.error : '逾時'}）`);

  const errors: string[] = [];
  const stats = { framesSent: 0, framesDone: 0, images: 0 };
  const gl = new GfxContext({
    constants: glConstants(shadow),
    shadow,
    attributes: ready.attributes,
    extensions: ready.extensions,
    params: ready.params,
    width,
    height,
    send: (s: Segment) =>
      post({ type: 'segment', buf: s.buf, words: s.words, ext: s.ext, images: s.images, frame: s.frame }, [s.buf, ...s.transfer]),
  });
  gl.canvas.expectedAttributes = attributes;
  worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'done') {
      gl.recycle(m.buf);
      if (m.frame !== null) stats.framesDone = m.frame;
    } else if (m.type === 'error') {
      if (errors.length < 200) errors.push(m.message);
      console.error(`render thread：${m.message}`);
    } else if (m.type === 'lost') {
      gl.markLost();
      gl.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    }
  });
  worker.addEventListener('error', (e) => {
    errors.push(`worker 錯誤：${e.message}`);
    console.error('render thread：worker 錯誤', e);
  });
  let nextImage = 1;
  // RemoteImage 被 GC 收掉（貼圖 dispose、沒人拿著）：worker 留的 PNG 位元組也丟掉。等這一格的段送出去之後才送，
  // 還要上傳它的段都在前面（worker 照順序處理，解碼前就先拿到位元組）
  const droppedImages: number[] = [];
  const imageRegistry = new FinalizationRegistry<number>((id) => droppedImages.push(id));
  const particles = new ParticleJobs(gl);
  return {
    canvas: gl.canvas,
    gl,
    particles,
    errors,
    stats,
    endFrame() {
      gl.endFrame(++stats.framesSent);
      particles.endFrame();
      for (const id of droppedImages.splice(0)) post({ type: 'dropImage', id });
    },
    busy() {
      return stats.framesSent - stats.framesDone >= 2;
    },
    async loadImage(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}：HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      let size = pngSize(bytes);
      if (!size) {
        const bmp = await createImageBitmap(new Blob([bytes]));
        size = [bmp.width, bmp.height];
        bmp.close();
      }
      const id = nextImage++;
      stats.images++;
      post({ type: 'image', id, bytes }, [bytes]);
      const img = new RemoteImage(id, size[0], size[1], url);
      imageRegistry.register(img, id);
      return img;
    },
    dispose() {
      gl.flushPending();
      worker.terminate();
    },
  };
}

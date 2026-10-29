// render thread 的 worker（2026/10/18）：主執行緒把 <canvas> transferControlToOffscreen 交過來，這裡建 WebGL2，照順序重播
// 主執行緒送來的指令段（replay.ts）。一段一個 task：task 結束時，這段畫過預設 framebuffer 才會送出畫面（SceneRenderer 最後的 blit）。
//
// 貼圖的 PNG：主執行緒 loadImage 抓到位元組就送過來（image），這裡留著位元組；某一段要上傳時才照當時的 unpack 參數解碼
//（createImageBitmap 的 imageOrientation／premultiplyAlpha／colorSpaceConversion 對應 UNPACK_FLIP_Y／PREMULTIPLY_ALPHA／
// COLORSPACE_CONVERSION，WebGL 上傳 ImageBitmap 時不看 pixelStorei），上傳完就 close。戰鬥一次載 786 張、解開 623 MB，
// GPU 上只有 330 張（10/18 量），解碼結果不留著。10/18 在 headless Chrome 比過 55 張（RGBA、RGB、最大的 5 張）：
// 這樣上傳跟 <img> 照 three.js 的參數（FLIP_Y、不預乘、不轉色彩空間）上傳逐位元組相同。

import type { FromWorker, SegmentImage, ToWorker } from './protocol';
import { ParticleJobRunner } from './particleJobs';
import { GfxReplayer } from './replay';

interface Scope {
  postMessage(m: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null;
}
const scope = self as unknown as Scope;

let gl: WebGL2RenderingContext | null = null;
let replayer: GfxReplayer | null = null;
/** 粒子網格工作（particleJobs.ts） */
const jobs = new ParticleJobRunner();
/** 遠端影像的 PNG 位元組 */
const images = new Map<number, ArrayBuffer>();
const queue: ToWorker[] = [];
let running = false;

const report = (message: string): void => scope.postMessage({ type: 'error', message });

// 讓出一個 task（MessageChannel 比 setTimeout 快，不會被夾到 4 ms）
const yielder = new MessageChannel();
let wake: (() => void) | null = null;
yielder.port1.onmessage = () => wake?.();
const yieldTask = (): Promise<void> =>
  new Promise((r) => {
    wake = r;
    yielder.port2.postMessage(0);
  });

scope.onmessage = (e) => {
  queue.push(e.data);
  if (!running) void pump();
};

/** 照順序處理；要等解碼的段之後，排隊的下一格另開一個 task（每一格各自送出畫面） */
async function pump(): Promise<void> {
  running = true;
  try {
    while (queue.length) {
      const m = queue.shift()!;
      const pending = handle(m);
      if (pending) await pending;
      // 平常一則訊息一個 task，佇列只有這一則；等過解碼才會積起來，這時每一格做完先讓出，不跟下一格擠在同一個 task
      if (m.type === 'segment' && m.frame !== null && queue.length) await yieldTask();
    }
  } catch (e) {
    report(`worker：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  } finally {
    running = false;
  }
}

function handle(m: ToWorker): Promise<void> | null {
  switch (m.type) {
    case 'probe': {
      try {
        const c = new OffscreenCanvas(1, 1).getContext('webgl2', m.attributes) as WebGL2RenderingContext | null;
        (c?.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
        scope.postMessage({ type: 'probe', ok: !!c });
      } catch (e) {
        scope.postMessage({ type: 'probe', ok: false, error: String(e) });
      }
      return null;
    }
    case 'init':
    case 'initVerify': {
      const canvas = m.type === 'init' ? m.canvas : new OffscreenCanvas(m.width, m.height);
      gl = canvas.getContext('webgl2', m.attributes) as WebGL2RenderingContext | null;
      if (!gl) {
        scope.postMessage({ type: 'ready', ok: false, error: 'getContext("webgl2") 回 null' });
        return null;
      }
      canvas.addEventListener('webglcontextlost', (ev) => {
        ev.preventDefault();
        scope.postMessage({ type: 'lost' });
      });
      replayer = new GfxReplayer(gl, { canvas, jobs });
      const params: Record<number, unknown> = {};
      for (const p of m.params) {
        const v = gl.getParameter(p);
        if (v !== null && v !== undefined) params[p] = v;
      }
      // 查不到的參數會留下 INVALID_ENUM：清掉（主執行緒直接用 context 時沒有這些查詢）
      while (gl.getError() !== gl.NO_ERROR);
      scope.postMessage({ type: 'ready', ok: true, attributes: gl.getContextAttributes(), params, extensions: gl.getSupportedExtensions() ?? [] });
      return null;
    }
    case 'image':
      images.set(m.id, m.bytes);
      return null;
    case 'dropImage':
      images.delete(m.id);
      return null;
    case 'segment': {
      if (!m.images.length) {
        runSegment(m, []);
        return null;
      }
      return Promise.all(m.images.map(decode)).then((decoded) => runSegment(m, decoded));
    }
  }
}

function runSegment(m: Extract<ToWorker, { type: 'segment' }>, decoded: (ImageBitmap | null)[]): void {
  try {
    replayer!.run(m.buf, m.words, m.ext, decoded);
  } catch (e) {
    report(`重播失敗（第 ${m.frame ?? '中途'} 格）：${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
  for (const b of decoded) b?.close();
  for (const x of m.ext) x.close();
  if (m.check && m.frame !== null) check(m.frame);
  if (m.frame !== null) jobs.endFrame();
  scope.postMessage({ type: 'done', frame: m.frame, buf: m.buf }, [m.buf]);
}

/** 驗證模式：這一格重播完的預設 framebuffer（讀的 framebuffer 暫時綁 null，讀完還原，不影響之後的重播） */
function check(frame: number): void {
  const g = gl!;
  const prev = g.getParameter(g.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  g.bindFramebuffer(g.READ_FRAMEBUFFER, null);
  const w = g.drawingBufferWidth;
  const h = g.drawingBufferHeight;
  const pixels = new Uint8Array(w * h * 4);
  g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, pixels);
  g.bindFramebuffer(g.READ_FRAMEBUFFER, prev);
  scope.postMessage({ type: 'check', frame, width: w, height: h, pixels }, [pixels.buffer]);
}

async function decode(img: SegmentImage): Promise<ImageBitmap | null> {
  const opts: ImageBitmapOptions = {
    imageOrientation: img.flipY ? 'flipY' : 'from-image',
    premultiplyAlpha: img.premultiplyAlpha ? 'premultiply' : 'none',
    colorSpaceConversion: img.noConversion ? 'none' : 'default',
  };
  try {
    let blob: Blob;
    if (img.id >= 0) {
      const bytes = images.get(img.id);
      if (!bytes) {
        report(`影像 ${img.id} 沒有位元組（loadImage 沒送到）`);
        return null;
      }
      blob = new Blob([bytes]);
    } else {
      const res = await fetch(img.url!);
      if (!res.ok) throw new Error(`${img.url}：HTTP ${res.status}`);
      blob = await res.blob();
    }
    return await createImageBitmap(blob, opts);
  } catch (e) {
    report(`影像 ${img.id >= 0 ? img.id : img.url} 解碼失敗：${String(e)}`);
    return null;
  }
}

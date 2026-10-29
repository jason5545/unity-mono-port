// render thread 的逐位元驗證（2026/10/18，網址 gfx=verify）：主執行緒照舊用真的 WebGL context 畫（畫面跟沒開 render thread 一樣），
// three.js 的每個呼叫同時寫成指令（GfxContext），交給 worker 在另一張 OffscreenCanvas 重播。每 every 格兩邊各讀一次預設 framebuffer
// 的像素比對；三種東西一起驗：
//   1. 指令的記錄與重播（replay.ts）跟直接呼叫畫出來的一樣；
//   2. 貼圖影像在 worker 照 unpack 參數解碼（createImageBitmap）跟 <img> 直接上傳一樣（這裡 worker 照網址抓）；
//   3. 影子 context（主執行緒的另一個 WebGL2）回答的程式查詢（getActiveUniform、getAttribLocation、uniform 是不是 null…）
//      跟真的 context 一樣——render thread 開著時 three.js 拿的是影子的答案。
// 只給除錯與驗收用：主執行緒多做一份記錄、影子多編一次 shader、每次比對要讀回整個畫面。
//
// 10/18 在 headless Chrome（Mac、ANGLE Metal）跑 MT2 的結果：影子查詢全部一致；像素會有 ±1 的差（戰鬥畫面約 86 萬個位元組，
// 3D 的部分）。查到的原因在主執行緒這邊：它的 canvas context 有些 draw 用的不是 WebGL 狀態裡記的取樣參數（Chrome／ANGLE 內部
// 沒同步）。證據：
//   - 同一串指令在其他 context 重播（主執行緒的 <canvas>、主執行緒的 OffscreenCanvas、worker 裡兩個 context）結果彼此逐位元相同；
//   - 找到第一個不同的 draw，兩邊的 GL 狀態、全部 uniform（含陣列每個元素）、頂點與索引緩衝、貼圖內容都相同，關掉混合、
//     深度改 ALWAYS 一樣不同；主執行緒自己畫幾次都一樣；
//   - 主執行緒每個 draw 之前把各單元綁著的貼圖過濾參數先改再改回（touch，網址 gfxtouch=1）：之後的比對全部逐位元相同，
//     只剩大背景圖剛上傳的那一格差十幾個位元組（原因未查到）。
// 所以 worker 畫的是這串 WebGL 指令照規格的結果；跟直接在主執行緒畫的差異來自主執行緒 context 本身。

import { GfxContext, GfxObject, type Segment } from './client';
import type { FromWorker, ToWorker } from './protocol';
import { THREE_CONTEXT_ATTRIBUTES, type RenderThread } from './thread';

export interface VerifyStats {
  frames: number;
  checks: number;
  /** 像素不一樣的比對次數、第一次不一樣的格號與差了幾個位元組 */
  pixelMismatches: number;
  firstMismatch: { frame: number; bytes: number; size: [number, number]; samples: string[] } | null;
  /** 最近 20 次不一樣的格號與位元組數 */
  mismatchLog: [number, number][];
  /** 影子 context 的回答跟真的不一樣的次數與前幾筆 */
  queryChecks: number;
  queryMismatches: number;
  querySamples: string[];
}

/** 要跟影子比對的查詢（render thread 開著時 three.js 拿的是影子的答案） */
const SHADOW_QUERIES = new Set([
  'getProgramParameter',
  'getShaderParameter',
  'getActiveUniform',
  'getActiveAttrib',
  'getAttribLocation',
  'getUniformBlockIndex',
  'getFragDataLocation',
  'getShaderPrecisionFormat',
]);

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if ('name' in a && 'type' in a && 'size' in a) {
      const x = a as WebGLActiveInfo;
      const y = b as WebGLActiveInfo;
      return x.name === y.name && x.type === y.type && x.size === y.size;
    }
    if ('precision' in a) {
      const x = a as WebGLShaderPrecisionFormat;
      const y = b as WebGLShaderPrecisionFormat;
      return x.precision === y.precision && x.rangeMin === y.rangeMin && x.rangeMax === y.rangeMax;
    }
  }
  return false;
}

function show(v: unknown): string {
  if (v && typeof v === 'object' && 'name' in v) return JSON.stringify({ name: (v as WebGLActiveInfo).name, type: (v as WebGLActiveInfo).type, size: (v as WebGLActiveInfo).size });
  return JSON.stringify(v);
}

/**
 * 驗證模式：回傳的 canvas 給 three.js（getContext 回包了一層的真 context），endFrame 照常由 SceneRenderer.render 叫。
 * 瀏覽器沒有 Worker／OffscreenCanvas 時回 null
 */
export async function startVerifyThread(
  canvas: HTMLCanvasElement,
  every = 30,
  attributes: WebGLContextAttributes = THREE_CONTEXT_ATTRIBUTES,
  /** 診斷：主執行緒每個 draw 之前把各單元綁著的貼圖 MIN／MAG 過濾先改再改回（不記錄），見檔頭 */
  touch = typeof location !== 'undefined' && new URLSearchParams(location.search).get('gfxtouch') === '1',
): Promise<(RenderThread & { verify: VerifyStats }) | null> {
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  const shadow = new OffscreenCanvas(1, 1).getContext('webgl2', attributes) as WebGL2RenderingContext | null;
  if (!shadow) return null;
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const post = (m: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(m, transfer);
  const ready = await new Promise<Extract<FromWorker, { type: 'ready' }> | null>((resolve) => {
    const t = setTimeout(() => resolve(null), 10_000);
    worker.addEventListener('message', function on(e: MessageEvent<FromWorker>) {
      if (e.data.type !== 'ready') return;
      clearTimeout(t);
      worker.removeEventListener('message', on);
      resolve(e.data);
    });
    post({ type: 'initVerify', width: canvas.width, height: canvas.height, attributes, params: [] });
  });
  if (!ready?.ok) {
    worker.terminate();
    return null;
  }

  const errors: string[] = [];
  const stats = { framesSent: 0, framesDone: 0, images: 0 };
  const verify: VerifyStats = { frames: 0, checks: 0, pixelMismatches: 0, firstMismatch: null, mismatchLog: [], queryChecks: 0, queryMismatches: 0, querySamples: [] };
  let real: WebGL2RenderingContext | null = null;
  /** 主執行緒讀回的像素，等 worker 那一格的結果來比 */
  const pending = new Map<number, Uint8Array>();
  let checkNext = false;

  const rec = new GfxContext({
    constants: glConstantsOf(shadow),
    shadow,
    attributes: ready.attributes,
    extensions: ready.extensions,
    params: {},
    width: canvas.width,
    height: canvas.height,
    send: (s: Segment) => {
      const check = s.frame !== null && checkNext;
      if (check) checkNext = false;
      post({ type: 'segment', buf: s.buf, words: s.words, ext: s.ext, images: s.images, frame: s.frame, check }, [s.buf, ...s.transfer]);
    },
  });
  worker.addEventListener('message', (e: MessageEvent<FromWorker>) => {
    const m = e.data;
    if (m.type === 'done') {
      rec.recycle(m.buf);
      if (m.frame !== null) stats.framesDone = m.frame;
    } else if (m.type === 'check') {
      const mine = pending.get(m.frame);
      pending.delete(m.frame);
      if (!mine) return;
      verify.checks++;
      let diff = mine.length === m.pixels.length ? 0 : Math.abs(mine.length - m.pixels.length);
      if (!diff) for (let i = 0; i < mine.length; i++) if (mine[i] !== m.pixels[i]) diff++;
      if (diff) {
        // 除錯：最近一次不一樣的兩張（不列舉，JSON 不帶）
        Object.defineProperty(verify, 'lastPair', { value: { frame: m.frame, width: m.width, height: m.height, main: mine, worker: m.pixels }, configurable: true, enumerable: false });
        verify.pixelMismatches++;
        verify.mismatchLog.push([m.frame, diff]);
        if (verify.mismatchLog.length > 20) verify.mismatchLog.shift();
        if (!verify.firstMismatch) {
          const samples: string[] = [];
          for (let i = 0; i < mine.length && samples.length < 24; i++)
            if (mine[i] !== m.pixels[i]) {
              const px = i >> 2;
              const at = px << 2;
              samples.push(`(${px % m.width},${Math.floor(px / m.width)}) 主 ${[...mine.slice(at, at + 4)]} worker ${[...m.pixels.slice(at, at + 4)]}`);
              i = at + 3;
            }
          verify.firstMismatch = { frame: m.frame, bytes: diff, size: [m.width, m.height], samples };
        }
      }
    } else if (m.type === 'error') {
      if (errors.length < 200) errors.push(m.message);
      console.error(`render thread（驗證）：${m.message}`);
    }
  });

  // 真的物件 → 記錄端的編號
  const handles = new Map<object, GfxObject>();
  const toRec = (a: unknown): unknown => (a && typeof a === 'object' && handles.has(a) ? handles.get(a) : a);
  const recCall = (name: string, args: unknown[]): unknown => (rec as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args.map(toRec));
  const mismatch = (what: string): void => {
    verify.queryMismatches++;
    if (verify.querySamples.length < 10) verify.querySamples.push(what);
  };

  const tee = (gl: WebGL2RenderingContext): WebGL2RenderingContext => {
    real = gl;
    const wrapped = new Map<string, unknown>();
    return new Proxy(gl, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (typeof prop !== 'string' || typeof v !== 'function') return v;
        let f = wrapped.get(prop);
        if (!f) {
          f = (...args: unknown[]): unknown => {
            if (touch && /^draw[AE]/.test(prop)) touchSamplers(target);
            const r = (v as (...a: unknown[]) => unknown).apply(target, args);
            try {
              if (prop.startsWith('create')) {
                if (r) handles.set(r as object, recCall(prop, args) as GfxObject);
              } else if (prop === 'getUniformLocation') {
                const h = recCall(prop, args) as GfxObject | null;
                verify.queryChecks++;
                if (!r !== !h) mismatch(`getUniformLocation(${String(args[1])})：真的 ${r ? '有' : 'null'}，影子 ${h ? '有' : 'null'}`);
                if (r && h) handles.set(r as object, h);
              } else if (prop === 'getExtension') {
                if (r) recCall(prop, args);
              } else if (SHADOW_QUERIES.has(prop)) {
                const s = recCall(prop, args);
                verify.queryChecks++;
                if (!same(r, s)) mismatch(`${prop}(${args.slice(1).map(String).join(', ')})：真的 ${show(r)}，影子 ${show(s)}`);
              } else if (!/^(get|is|check|readPixels)/.test(prop) && typeof (rec as unknown as Record<string, unknown>)[prop] === 'function') {
                recCall(prop, args);
              }
            } catch (e) {
              if (errors.length < 200) errors.push(`記錄 ${prop}：${e instanceof Error ? e.message : String(e)}`);
            }
            return r;
          };
          wrapped.set(prop, f);
        }
        return f;
      },
      set(target, prop, value) {
        Reflect.set(target, prop, value, target);
        if (prop === 'drawingBufferColorSpace' || prop === 'unpackColorSpace') (rec as unknown as Record<string, unknown>)[prop] = value;
        return true;
      },
    });
  };

  // three.js 的畫布：寬高、事件照真的 <canvas>，getContext 回包過的 context；寬高改變也記成 RESIZE
  const fake = {
    get width() {
      return canvas.width;
    },
    set width(v: number) {
      canvas.width = v;
      rec.canvas.width = v;
    },
    get height() {
      return canvas.height;
    },
    set height(v: number) {
      canvas.height = v;
      rec.canvas.height = v;
    },
    style: canvas.style,
    addEventListener: canvas.addEventListener.bind(canvas),
    removeEventListener: canvas.removeEventListener.bind(canvas),
    getContext: (name: string, attrs?: WebGLContextAttributes) => {
      const gl = canvas.getContext(name as 'webgl2', attrs) as WebGL2RenderingContext | null;
      return gl ? tee(gl) : null;
    },
  };

  return {
    canvas: fake as never,
    gl: rec,
    particles: null,
    errors,
    stats,
    verify,
    endFrame() {
      const frame = ++stats.framesSent;
      verify.frames++;
      const firstCheck = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('gfxfirst') ?? 0) : 0;
      if (real && frame % every === 0 && frame >= firstCheck) {
        // SceneRenderer.render 最後畫到預設 framebuffer（blit）：還沒交給合成器之前讀回來
        const gl = real;
        const prevRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, prevRead);
        pending.set(frame, px);
        checkNext = true;
      }
      rec.endFrame(frame);
    },
    busy: () => false,
    loadImage: null,
    dispose() {
      worker.terminate();
    },
  };
}

/** 各單元綁著的貼圖：MIN／MAG 過濾先改成另一個值再改回原值（Chrome／ANGLE 才會重新套用取樣參數；只在主執行緒、不記錄） */
function touchSamplers(gl: WebGL2RenderingContext): void {
  const active = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  const units = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) as number;
  const kinds: [number, number][] = [
    [gl.TEXTURE_BINDING_2D, gl.TEXTURE_2D],
    [gl.TEXTURE_BINDING_CUBE_MAP, gl.TEXTURE_CUBE_MAP],
    [gl.TEXTURE_BINDING_2D_ARRAY, gl.TEXTURE_2D_ARRAY],
    [gl.TEXTURE_BINDING_3D, gl.TEXTURE_3D],
  ];
  for (let u = 0; u < units; u++) {
    gl.activeTexture(gl.TEXTURE0 + u);
    for (const [binding, target] of kinds) {
      if (!gl.getParameter(binding)) continue;
      for (const pname of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
        const v = gl.getTexParameter(target, pname) as number;
        gl.texParameteri(target, pname, v === gl.NEAREST ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(target, pname, v);
      }
    }
  }
  gl.activeTexture(active);
}

function glConstantsOf(gl: WebGL2RenderingContext): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k in gl) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) continue;
    const v = (gl as unknown as Record<string, unknown>)[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

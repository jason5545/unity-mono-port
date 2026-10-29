// render thread 的指令：同一串 gl 呼叫，直接打在假的 GL 上，跟經過 GfxContext 記錄、GfxReplayer 重播的結果逐項相同
//（呼叫順序、參數、uniform／buffer 的實際值、貼圖上傳時 GL 會讀到的位元組、最後的 pixelStorei 狀態）。
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { GfxContext, RemoteImage, type Segment, type ShadowGL } from './client';
import { GfxReplayer } from './replay';

const GL = {
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  TEXTURE_2D: 0x0de1,
  TEXTURE_2D_ARRAY: 0x8c1a,
  RGBA: 0x1908,
  RGBA8: 0x8058,
  RED: 0x1903,
  R8: 0x8229,
  UNSIGNED_BYTE: 0x1401,
  FLOAT: 0x1406,
  RGBA32F: 0x8814,
  TRIANGLES: 0x0004,
  UNSIGNED_SHORT: 0x1403,
  FRAMEBUFFER: 0x8d40,
  COLOR: 0x1800,
  DEPTH_STENCIL: 0x84f9,
  COLOR_ATTACHMENT0: 0x8ce0,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  VIEWPORT: 0x0ba2,
  SCISSOR_BOX: 0x0c10,
  UNPACK_ALIGNMENT: 0x0cf5,
  UNPACK_ROW_LENGTH: 0x0cf2,
  UNPACK_SKIP_ROWS: 0x0cf3,
  UNPACK_SKIP_PIXELS: 0x0cf4,
  UNPACK_IMAGE_HEIGHT: 0x806e,
  UNPACK_SKIP_IMAGES: 0x806d,
  UNPACK_FLIP_Y_WEBGL: 0x9240,
  UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
  UNPACK_COLORSPACE_CONVERSION_WEBGL: 0x9243,
  BLEND: 0x0be2,
  MAX_TEXTURE_SIZE: 0x0d33,
};

const BPP: Record<string, number> = { [`${GL.RGBA}|${GL.UNSIGNED_BYTE}`]: 4, [`${GL.RED}|${GL.UNSIGNED_BYTE}`]: 1, [`${GL.RGBA}|${GL.FLOAT}`]: 16 };

/**
 * 假的 GL：記下呼叫（物件換成建立順序、陣列換成 GL 實際會讀的值），追蹤 pixelStorei。
 * 貼圖上傳照目前的 unpack 參數自己算 GL 會讀哪些位元組（獨立於 client.ts 的實作）
 */
function mockGL() {
  const log: unknown[] = [];
  const store = new Map<number, number>([
    [GL.UNPACK_ALIGNMENT, 4],
    [GL.UNPACK_ROW_LENGTH, 0],
    [GL.UNPACK_SKIP_ROWS, 0],
    [GL.UNPACK_SKIP_PIXELS, 0],
    [GL.UNPACK_IMAGE_HEIGHT, 0],
    [GL.UNPACK_SKIP_IMAGES, 0],
  ]);
  const ids = new Map<object, string>();
  let n = 0;
  const tok = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'object' && ids.has(v as object)) return ids.get(v as object);
    if (ArrayBuffer.isView(v)) return `${v.constructor.name}[${Array.from(v as Uint8Array).join(',')}]`;
    if (Array.isArray(v)) return v.map(tok);
    if (typeof v === 'object' && v && 'loc' in v) return `loc:${(v as { loc: string }).loc}`;
    return v;
  };
  const region = (view: ArrayBufferView, srcOffset: number, w: number, h: number, d: number, format: number, type: number, is3d: boolean): string => {
    const bpp = BPP[`${format}|${type}`];
    const el = (view as Uint8Array).BYTES_PER_ELEMENT;
    const bytes = new Uint8Array(view.buffer, view.byteOffset + srcOffset * el);
    const rowLen = store.get(GL.UNPACK_ROW_LENGTH)! || w;
    const align = store.get(GL.UNPACK_ALIGNMENT)!;
    const stride = Math.ceil((rowLen * bpp) / align) * align;
    const imgRows = (is3d && store.get(GL.UNPACK_IMAGE_HEIGHT)!) || h;
    const out: number[] = [];
    for (let z = 0; z < d; z++)
      for (let y = 0; y < h; y++) {
        const at = ((is3d ? store.get(GL.UNPACK_SKIP_IMAGES)! : 0) + z) * imgRows * stride + (store.get(GL.UNPACK_SKIP_ROWS)! + y) * stride + store.get(GL.UNPACK_SKIP_PIXELS)! * bpp;
        for (let k = 0; k < w * bpp; k++) out.push(bytes[at + k]);
      }
    return `${view.constructor.name}{${out.join(',')}}`;
  };
  const sub = (v: ArrayLike<number>, o = 0, len = 0): number[] => {
    const a = Array.from(v as ArrayLike<number>).slice(o, len ? o + len : undefined);
    return v instanceof Float32Array ? a : a;
  };
  const gl: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, name: string) {
        return (...args: unknown[]): unknown => {
          if (name.startsWith('create')) {
            const o = { kind: name };
            ids.set(o, `${name}#${n++}`);
            log.push([name, ...args.map(tok)]);
            return o;
          }
          if (name === 'getUniformLocation') {
            const l = { loc: String(args[1]) };
            log.push([name, tok(args[0]), args[1]]);
            return l;
          }
          if (name === 'getExtension') {
            log.push([name, args[0]]);
            return { name: args[0], call: (...a: unknown[]) => log.push([`${args[0]}.call`, ...a]) };
          }
          if (name === 'pixelStorei') {
            store.set(args[0] as number, Number(args[1]) | 0);
            return undefined;
          }
          if (/^uniform(Matrix)?[1-4]/.test(name) && /v$/.test(name)) {
            const m = name.startsWith('uniformMatrix');
            const data = args[m ? 2 : 1] as ArrayLike<number>;
            const vals = sub(data, (args[m ? 3 : 2] as number) ?? 0, (args[m ? 4 : 3] as number) ?? 0);
            log.push([name, tok(args[0]), ...(m ? [args[1]] : []), vals.map((x) => Math.fround(x))]);
            return undefined;
          }
          if (/^uniform[1-4](f|i|ui)$/.test(name)) {
            log.push([name, tok(args[0]), ...args.slice(1).map((x) => (name.endsWith('f') ? Math.fround(x as number) : (x as number) | 0))]);
            return undefined;
          }
          if (name === 'bufferData' || name === 'bufferSubData') {
            const data = args[name === 'bufferData' ? 1 : 2];
            if (typeof data === 'number' || data === null) {
              log.push([name, args[0], data, args[2]]);
              return undefined;
            }
            const view = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
            const el = view.BYTES_PER_ELEMENT ?? 1;
            const o = ((args[name === 'bufferData' ? 3 : 3] as number) ?? 0) * el;
            const len = ((args[4] as number) ?? 0) * el;
            const bytes = Array.from(new Uint8Array(view.buffer, view.byteOffset + o, len || view.byteLength - o));
            log.push([name, args[0], name === 'bufferData' ? args[2] : args[1], bytes.join(',')]);
            return undefined;
          }
          if (name === 'texImage2D' && args.length >= 9 && ArrayBuffer.isView(args[8])) {
            const a = args as number[];
            log.push([name, ...a.slice(0, 8), region(args[8] as ArrayBufferView, (args[9] as number) ?? 0, a[3], a[4], 1, a[6], a[7], false)]);
            return undefined;
          }
          if (name === 'texSubImage2D' && args.length >= 9 && ArrayBuffer.isView(args[8])) {
            const a = args as number[];
            log.push([name, ...a.slice(0, 8), region(args[8] as ArrayBufferView, (args[9] as number) ?? 0, a[4], a[5], 1, a[6], a[7], false)]);
            return undefined;
          }
          if (name === 'texImage3D' && ArrayBuffer.isView(args[9])) {
            const a = args as number[];
            log.push([name, ...a.slice(0, 9), region(args[9] as ArrayBufferView, (args[10] as number) ?? 0, a[3], a[4], a[5], a[7], a[8], true)]);
            return undefined;
          }
          if (name === 'texSubImage3D' && ArrayBuffer.isView(args[10])) {
            const a = args as number[];
            log.push([name, ...a.slice(0, 10), region(args[10] as ArrayBufferView, (args[11] as number) ?? 0, a[5], a[6], a[7], a[8], a[9], true)]);
            return undefined;
          }
          if (name === 'clearBufferfv' || name === 'clearBufferiv' || name === 'clearBufferuiv') {
            log.push([name, args[0], args[1], sub(args[2] as ArrayLike<number>, (args[3] as number) ?? 0).map((x) => (name === 'clearBufferfv' ? Math.fround(x) : x))]);
            return undefined;
          }
          if (name === 'clearColor' || name === 'blendColor' || name === 'clearDepth' || name === 'lineWidth' || name === 'polygonOffset' || name === 'depthRange' || name === 'texParameterf') {
            log.push([name, ...args.map((x, i) => (name === 'texParameterf' && i < 2 ? x : Math.fround(x as number)))]);
            return undefined;
          }
          if (/^vertexAttrib[1-4]f/.test(name)) {
            const nArgs = +name[12];
            const vals = name.endsWith('v') ? Array.from(args[1] as ArrayLike<number>).slice(0, nArgs) : (args.slice(1) as number[]);
            log.push([`vertexAttrib${nArgs}`, args[0], ...vals.map((x) => Math.fround(x))]);
            return undefined;
          }
          if (name === 'colorMask' || name === 'depthMask') {
            log.push([name, ...args.map((x) => !!x)]);
            return undefined;
          }
          if (name === 'stencilMask' || name === 'stencilFunc') {
            log.push([name, ...args.map((x) => (x as number) >>> 0)]);
            return undefined;
          }
          log.push([name, ...args.map(tok)]);
          return undefined;
        };
      },
    },
  );
  return { gl, log, store };
}

/** 影子：getUniformLocation 對 name 以 '_unused' 結尾的回 null（模擬被最佳化掉的 uniform） */
function mockShadow(): ShadowGL {
  const s: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, name: string) {
        if (name === 'getUniformLocation') return (_p: unknown, n: string) => (n.endsWith('_unused') ? null : { n });
        if (name === 'getExtension') return (n: string) => (n === 'NOPE' ? null : { MAX_THING: 0x1234, call() {} });
        if (name === 'getParameter') return (p: number) => `shadow:${p}`;
        if (name.startsWith('create')) return () => ({});
        return () => null;
      },
    },
  );
  return s as unknown as ShadowGL;
}

/** 兩邊一起呼叫：物件照建立順序對應 */
function harness() {
  const direct = mockGL();
  const segs: Segment[] = [];
  const ctx = new GfxContext({
    constants: {},
    shadow: mockShadow(),
    attributes: { alpha: true },
    extensions: ['EXT_a', 'EXT_b'],
    params: { [GL.MAX_TEXTURE_SIZE]: 4096 },
    width: 300,
    height: 150,
    send: (s) => segs.push(s),
  });
  const pairs = new Map<object, object | null>();
  const call = (name: string, ...args: unknown[]): unknown => {
    const d = (direct.gl[name] as (...a: unknown[]) => unknown)(...args);
    const c = (ctx[name] as (...a: unknown[]) => unknown).apply(ctx, args.map((a) => (a && typeof a === 'object' && pairs.has(a) ? pairs.get(a) : a)));
    if (d && typeof d === 'object') pairs.set(d, c as object | null);
    return d;
  };
  const replay = () => {
    const out = mockGL();
    const r = new GfxReplayer(out.gl as unknown as WebGL2RenderingContext);
    for (const s of segs) r.run(s.buf, s.words, s.ext as never, []);
    return out;
  };
  return { direct, ctx, call, segs, replay };
}

describe('render thread：GfxContext 記錄、GfxReplayer 重播', () => {
  it('狀態、物件、uniform、buffer、畫的呼叫逐項相同', () => {
    const h = harness();
    const { call } = h;
    const vs = call('createShader', GL.VERTEX_SHADER);
    call('shaderSource', vs, 'void main(){ gl_Position = vec4(0.0); } // 中文註解');
    call('compileShader', vs);
    const fs = call('createShader', GL.FRAGMENT_SHADER);
    call('shaderSource', fs, 'void main(){}');
    call('compileShader', fs);
    const prog = call('createProgram');
    call('attachShader', prog, vs);
    call('attachShader', prog, fs);
    call('bindAttribLocation', prog, 0, 'position');
    call('linkProgram', prog);
    call('useProgram', prog);
    const loc = call('getUniformLocation', prog, 'uColor');
    const loc2 = call('getUniformLocation', prog, 'uMat');
    call('uniform4f', loc, 0.1, 0.2, 0.3, 1e40);
    call('uniform1i', loc, -3);
    call('uniform1ui', loc, 0xffffffff);
    call('uniform3fv', loc, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]);
    call('uniform4fv', loc, new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 4, 8);
    call('uniform4uiv', loc, new Uint32Array(Array.from({ length: 64 }, (_, i) => i * 0x01010101)), 0, 0);
    call('uniform2iv', loc, new Int32Array([-1, 2, -3, 4]), 2);
    call('uniformMatrix4fv', loc2, false, new Float32Array(Array.from({ length: 48 }, (_, i) => i / 7)), 16, 16);
    call('uniformMatrix3fv', loc2, false, Array.from({ length: 9 }, (_, i) => i * 0.3));
    const buf = call('createBuffer');
    call('bindBuffer', GL.ARRAY_BUFFER, buf);
    call('bufferData', GL.ARRAY_BUFFER, 1024, GL.DYNAMIC_DRAW);
    call('bufferData', GL.ARRAY_BUFFER, new Float32Array([1.5, 2.5, 3.5]), GL.STATIC_DRAW);
    call('bufferData', GL.ARRAY_BUFFER, new Uint16Array([1, 2, 3, 4, 5, 6]).buffer, GL.STATIC_DRAW);
    call('bufferData', GL.ARRAY_BUFFER, new Float32Array([9, 8, 7, 6, 5]), GL.STATIC_DRAW, 1, 3);
    call('bufferSubData', GL.ARRAY_BUFFER, 8, new Float32Array([0.25, 0.5, 0.75, 1, 1.25]), 2, 2);
    call('bufferSubData', GL.ARRAY_BUFFER, 0, new Uint8Array([1, 2, 3]));
    const vao = call('createVertexArray');
    call('bindVertexArray', vao);
    call('vertexAttribPointer', 0, 3, GL.FLOAT, false, 12, 0);
    call('vertexAttribIPointer', 1, 2, GL.UNSIGNED_SHORT, 4, 8);
    call('enableVertexAttribArray', 0);
    call('vertexAttrib4fv', 2, new Float32Array([1, 0.5, 0.25, 0.125]));
    call('vertexAttrib2f', 3, 0.3, 0.7);
    call('enable', GL.BLEND);
    call('blendFuncSeparate', 1, 0x0303, 1, 0x0303);
    call('blendColor', 0.1, 0.2, 0.3, 0.4);
    call('colorMask', true, false, 1, 0);
    call('depthMask', false);
    call('stencilMask', 0xffffffff);
    call('stencilFunc', 0x0207, 1, 0xffffffff);
    call('clearColor', 0.1, 0.2, 0.3, 1);
    call('clearDepth', 1);
    call('viewport', 0, 0, 640, 480);
    call('scissor', 10, 20, 30, 40);
    call('clear', 0x4100);
    call('drawElements', GL.TRIANGLES, 6, GL.UNSIGNED_SHORT, 0);
    call('drawArrays', GL.TRIANGLES, 0, 3);
    call('drawArraysInstanced', GL.TRIANGLES, 0, 3, 5);
    call('drawBuffers', [GL.COLOR_ATTACHMENT0]);
    call('invalidateFramebuffer', GL.FRAMEBUFFER, [GL.COLOR_ATTACHMENT0, GL.DEPTH_STENCIL]);
    call('clearBufferfv', GL.COLOR, 0, [0.5, 0.25, 0.125, 1]);
    call('clearBufferuiv', GL.COLOR, 0, new Uint32Array([9, 8, 7, 6, 5]), 1);
    call('clearBufferfi', GL.DEPTH_STENCIL, 0, 0.5, 7);
    call('lineWidth', 1);
    call('polygonOffset', 0.5, -1);
    call('deleteBuffer', buf);
    call('deleteVertexArray', vao);
    call('deleteProgram', prog);
    h.ctx.endFrame(1);
    expect(h.replay().log).toEqual(h.direct.log);
  });

  it('影子上被最佳化掉的 uniform 回 null，不建編號、worker 不查', () => {
    const h = harness();
    const p = h.ctx.createProgram();
    expect(h.ctx.getUniformLocation(p, 'x_unused')).toBeNull();
    const loc = h.ctx.getUniformLocation(p, 'x');
    expect(loc?.kind).toBe(10);
    h.ctx.endFrame(1);
    expect(h.replay().log).toEqual([
      ['createProgram'],
      ['getUniformLocation', 'createProgram#0', 'x'],
    ]);
  });

  it('貼圖：位元組資料、null、ROW_LENGTH／SKIP 子矩形、3D 的 SKIP_IMAGES、FLIP_Y 開著時整個抄', () => {
    const h = harness();
    const { call } = h;
    const tex = call('createTexture');
    call('bindTexture', GL.TEXTURE_2D, tex);
    call('texStorage2D', GL.TEXTURE_2D, 1, GL.RGBA8, 64, 64);
    const big = new Uint8Array(64 * 64 * 4).map((_, i) => (i * 37) & 255);
    call('texImage2D', GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, big);
    call('texImage2D', GL.TEXTURE_2D, 0, GL.RGBA8, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    call('texImage2D', GL.TEXTURE_2D, 0, GL.RGBA8, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, big, 16);
    // 子矩形：atlas 的局部上傳（three.js copyTextureToTexture 的做法）
    call('pixelStorei', GL.UNPACK_ROW_LENGTH, 64);
    call('pixelStorei', GL.UNPACK_SKIP_PIXELS, 5);
    call('pixelStorei', GL.UNPACK_SKIP_ROWS, 7);
    call('texSubImage2D', GL.TEXTURE_2D, 0, 5, 7, 6, 3, GL.RGBA, GL.UNSIGNED_BYTE, big);
    // 單通道、ALIGNMENT 對齊的列寬
    call('pixelStorei', GL.UNPACK_ALIGNMENT, 8);
    call('pixelStorei', GL.UNPACK_ROW_LENGTH, 13);
    call('texSubImage2D', GL.TEXTURE_2D, 0, 0, 0, 5, 4, GL.RED, GL.UNSIGNED_BYTE, big);
    // FLIP_Y 開著：整個抄、SKIP 不動
    call('pixelStorei', GL.UNPACK_FLIP_Y_WEBGL, true);
    call('texSubImage2D', GL.TEXTURE_2D, 0, 0, 0, 3, 2, GL.RGBA, GL.UNSIGNED_BYTE, big);
    call('pixelStorei', GL.UNPACK_FLIP_Y_WEBGL, false);
    call('pixelStorei', GL.UNPACK_ALIGNMENT, 4);
    // 3D
    call('pixelStorei', GL.UNPACK_ROW_LENGTH, 4);
    call('pixelStorei', GL.UNPACK_IMAGE_HEIGHT, 4);
    call('pixelStorei', GL.UNPACK_SKIP_IMAGES, 1);
    call('pixelStorei', GL.UNPACK_SKIP_PIXELS, 1);
    call('pixelStorei', GL.UNPACK_SKIP_ROWS, 1);
    const arr = call('createTexture');
    call('bindTexture', GL.TEXTURE_2D_ARRAY, arr);
    call('texImage3D', GL.TEXTURE_2D_ARRAY, 0, GL.RGBA8, 2, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE, big);
    call('texSubImage3D', GL.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 2, 3, 2, GL.RGBA, GL.UNSIGNED_BYTE, big);
    call('pixelStorei', GL.UNPACK_SKIP_IMAGES, 0);
    call('pixelStorei', GL.UNPACK_SKIP_PIXELS, 0);
    call('pixelStorei', GL.UNPACK_SKIP_ROWS, 0);
    call('pixelStorei', GL.UNPACK_ROW_LENGTH, 0);
    call('pixelStorei', GL.UNPACK_IMAGE_HEIGHT, 0);
    // float 資料
    call('texImage2D', GL.TEXTURE_2D, 0, GL.RGBA32F, 2, 1, 0, GL.RGBA, GL.FLOAT, new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]));
    call('texParameterf', GL.TEXTURE_2D, 0x84fe, 4);
    call('texParameteri', GL.TEXTURE_2D, 0x2801, 0x2601);
    call('generateMipmap', GL.TEXTURE_2D);
    h.ctx.endFrame(1);
    const out = h.replay();
    expect(out.log).toEqual(h.direct.log);
    // 重播時暫時歸零的 SKIP 有還原：最後的 unpack 狀態一樣
    expect([...out.store]).toEqual([...h.direct.store]);
  });

  it('getParameter：VIEWPORT／SCISSOR_BOX 照記錄的呼叫、UNPACK 照 pixelStorei、固定參數照 worker 查的、其他問影子', () => {
    const h = harness();
    expect([...(h.ctx.getParameter(GL.VIEWPORT) as Int32Array)]).toEqual([0, 0, 300, 150]);
    h.ctx.viewport(1, 2, 3, 4);
    h.ctx.scissor(5, 6, 7, 8);
    expect([...(h.ctx.getParameter(GL.VIEWPORT) as Int32Array)]).toEqual([1, 2, 3, 4]);
    expect([...(h.ctx.getParameter(GL.SCISSOR_BOX) as Int32Array)]).toEqual([5, 6, 7, 8]);
    expect(h.ctx.getParameter(GL.UNPACK_FLIP_Y_WEBGL)).toBe(false);
    h.ctx.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, 1);
    expect(h.ctx.getParameter(GL.UNPACK_FLIP_Y_WEBGL)).toBe(true);
    h.ctx.pixelStorei(GL.UNPACK_ROW_LENGTH, 33);
    expect(h.ctx.getParameter(GL.UNPACK_ROW_LENGTH)).toBe(33);
    expect(h.ctx.getParameter(GL.MAX_TEXTURE_SIZE)).toBe(4096);
    expect(h.ctx.getParameter(0x1f02)).toBe('shadow:7938');
  });

  it('擴充：沒支援的回 null；有支援的常數照影子、worker 那邊也開、方法轉成指令', () => {
    const h = harness();
    expect(h.ctx.getExtension('NOPE')).toBeNull();
    expect(h.ctx.getExtension('EXT_c')).toBeNull(); // worker 不支援
    const e = h.ctx.getExtension('EXT_a') as Record<string, unknown>;
    expect(e.MAX_THING).toBe(0x1234);
    (e.call as () => void)();
    h.ctx.endFrame(1);
    expect(h.replay().log).toEqual([
      ['getExtension', 'EXT_a'],
      ['EXT_a.call'],
    ]);
  });

  it('分段：一格中途累積夠多先送（畫的是 FBO），碰過預設 framebuffer 之後等 endFrame；接起來重播跟一段一樣', () => {
    const h = harness();
    const fb = h.call('createFramebuffer');
    h.call('bindFramebuffer', GL.FRAMEBUFFER, fb);
    const big = new Float32Array(300_000);
    for (let i = 0; i < 6; i++) {
      h.call('bufferSubData', GL.ARRAY_BUFFER, 0, big);
      h.call('drawArrays', GL.TRIANGLES, 0, 3);
    }
    const midFrame = h.segs.length;
    expect(midFrame).toBeGreaterThan(0);
    expect(h.segs.every((s) => s.frame === null)).toBe(true);
    h.call('bindFramebuffer', GL.FRAMEBUFFER, null);
    h.call('clear', 0x4000);
    for (let i = 0; i < 6; i++) {
      h.call('bufferSubData', GL.ARRAY_BUFFER, 0, big);
      h.call('drawArrays', GL.TRIANGLES, 0, 3);
    }
    expect(h.segs.length).toBe(midFrame);
    h.ctx.endFrame(7);
    expect(h.segs.at(-1)!.frame).toBe(7);
    expect(h.replay().log).toEqual(h.direct.log);
  });

  it('遠端影像：上傳時記下當時的解碼參數，同一張同一組參數一段只列一次', () => {
    const h = harness();
    const img = new RemoteImage(5, 64, 32, 'x.png');
    const tex = h.ctx.createTexture();
    h.ctx.bindTexture(GL.TEXTURE_2D, tex);
    h.ctx.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, true);
    h.ctx.pixelStorei(GL.UNPACK_COLORSPACE_CONVERSION_WEBGL, 0);
    h.ctx.texImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, img);
    h.ctx.texSubImage2D(GL.TEXTURE_2D, 0, 0, 0, GL.RGBA, GL.UNSIGNED_BYTE, img);
    h.ctx.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false);
    h.ctx.texSubImage2D(GL.TEXTURE_2D, 0, 1, 2, 64, 32, GL.RGBA, GL.UNSIGNED_BYTE, img);
    h.ctx.endFrame(1);
    const seg = h.segs[0];
    expect(seg.images).toEqual([
      { id: 5, url: undefined, flipY: true, premultiplyAlpha: false, noConversion: true },
      { id: 5, url: undefined, flipY: false, premultiplyAlpha: false, noConversion: true },
    ]);
    const out = mockGL();
    const decoded = [{ bmp: 'flip' }, { bmp: 'noflip' }] as unknown as ImageBitmap[];
    new GfxReplayer(out.gl as unknown as WebGL2RenderingContext).run(seg.buf, seg.words, [], decoded);
    const tex2 = out.log.filter((e) => /^tex/.test((e as string[])[0]));
    expect(tex2.map((e) => (e as unknown[]).map((x) => (x && typeof x === 'object' ? (x as { bmp: string }).bmp : x)))).toEqual([
      ['texImage2D', GL.TEXTURE_2D, 0, GL.RGBA8, GL.RGBA, GL.UNSIGNED_BYTE, 'flip'],
      ['texSubImage2D', GL.TEXTURE_2D, 0, 0, 0, GL.RGBA, GL.UNSIGNED_BYTE, 'flip'],
      ['texSubImage2D', GL.TEXTURE_2D, 0, 1, 2, 64, 32, GL.RGBA, GL.UNSIGNED_BYTE, 'noflip'],
    ]);
  });

  it('畫布改大小：寬、高各記一次（跟 canvas.width、canvas.height 分兩次設一樣）', () => {
    const h = harness();
    h.ctx.canvas.width = 800;
    h.ctx.canvas.height = 600;
    h.ctx.endFrame(1);
    const c = { width: 300, height: 150 };
    const sets: string[] = [];
    const watched = {
      get width() {
        return c.width;
      },
      set width(v: number) {
        sets.push(`w${v}`);
        c.width = v;
      },
      get height() {
        return c.height;
      },
      set height(v: number) {
        sets.push(`h${v}`);
        c.height = v;
      },
    };
    const out = mockGL();
    new GfxReplayer(out.gl as unknown as WebGL2RenderingContext, { canvas: watched }).run(h.segs[0].buf, h.segs[0].words);
    expect(sets).toEqual(['w800', 'h600']);
  });

  // WebGL 的物件被 GC 收掉時瀏覽器會刪掉 GPU 那邊的；GfxObject 也要（10/18 MT2 戰鬥 GPU 記憶體一路漲到 context lost）
  it('GC：沒人參照的物件在下一次 endFrame 刪掉；綁著的、VAO 的屬性與 element buffer、framebuffer 的附件留著', async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const collect = async () => {
      for (let i = 0; i < 5; i++) {
        gc();
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    const h = harness();
    const ctx = h.ctx;
    const deleted = () => {
      const out = mockGL();
      const r = new GfxReplayer(out.gl as unknown as WebGL2RenderingContext);
      for (const s of h.segs) r.run(s.buf, s.words, s.ext as never, []);
      return out.log.filter((e) => Array.isArray(e) && String(e[0]).startsWith('delete')).map((e) => (e as unknown[])[0]);
    };
    // 每一個都在函式裡建，回來之後 JS 這邊沒有參照
    const vao = ctx.createVertexArray();
    (() => {
      ctx.bindVertexArray(vao);
      const attr = ctx.createBuffer();
      ctx.bindBuffer(GL.ARRAY_BUFFER, attr);
      ctx.bufferData(GL.ARRAY_BUFFER, new Float32Array(12), GL.STATIC_DRAW);
      ctx.vertexAttribPointer(0, 3, GL.FLOAT, false, 0, 0);
      const index = ctx.createBuffer();
      ctx.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, index);
      ctx.bufferData(GL.ELEMENT_ARRAY_BUFFER, new Uint16Array(3), GL.STATIC_DRAW);
      ctx.bindVertexArray(null);
      ctx.bindBuffer(GL.ARRAY_BUFFER, null);
      // 綁著的貼圖、framebuffer 與它的附件
      const tex = ctx.createTexture();
      ctx.bindTexture(GL.TEXTURE_2D, tex);
      const fb = ctx.createFramebuffer();
      ctx.bindFramebuffer(GL.FRAMEBUFFER, fb);
      const att = ctx.createTexture();
      ctx.framebufferTexture2D(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, att, 0);
      // 沒人參照、也沒綁：這兩個要被刪
      const lone = ctx.createBuffer();
      ctx.bindBuffer(GL.ARRAY_BUFFER, lone);
      ctx.bufferData(GL.ARRAY_BUFFER, new Float32Array(4), GL.DYNAMIC_DRAW);
      ctx.bindBuffer(GL.ARRAY_BUFFER, null);
      ctx.createTexture();
    })();
    await collect();
    ctx.endFrame(1);
    // GC 回收的順序不固定：排序後比
    expect(deleted().sort()).toEqual(['deleteBuffer', 'deleteTexture']);
    // VAO 刪掉之後，它的屬性與 element buffer 也沒人參照了
    ctx.deleteVertexArray(vao);
    await collect();
    ctx.endFrame(2);
    expect(deleted().sort()).toEqual(['deleteBuffer', 'deleteBuffer', 'deleteBuffer', 'deleteTexture', 'deleteVertexArray']);
    // 明確刪過的不再刪第二次
    ctx.deleteVertexArray(vao);
    ctx.endFrame(3);
    expect(deleted().length).toBe(5);
  });
});

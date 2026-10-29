// MT2 每格時間分項（Mac 本機 vite dev，CPU 降速倍率模擬手機；GPU 用 Metal）
// node scripts/perf-split.mjs [秒數] [cpu降速] [輸出json]
// 印：rAF 回呼、world.frame、renderer.frame、renderer.render 的每格耗時，GL 呼叫數，以及 CPU profile 自身／含子呼叫前幾名。
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [secs = '6', rate = '1', outJson = ''] = process.argv.slice(2);
const UA = 'Mozilla/5.0 (Linux; Android 16; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

const server = await createServer({ root: ROOT, logLevel: 'error', server: { port: 0 } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const ctx = await browser.newContext({
    viewport: { width: 400, height: 869 },
    userAgent: UA,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    locale: 'zh-TW',
  });
  await ctx.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.__cb = [];
    window.requestAnimationFrame = (f) =>
      raf((t) => {
        const t0 = performance.now();
        f(t);
        const d = performance.now() - t0;
        if (window.__cbOn && d > 0.2) window.__cb.push(d);
      });
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  // 沒有 scene 參數：照原版從 start 開機（正式流程）。gfx=0 讓繪製留在主執行緒，才量得到 renderer.render
  const url = new URL('index.html?gfx=0', base).href;
  await p.goto(url);
  await p.evaluate(() => window.__ready);
  // 等到主選單（開機流程跑完、畫面開始動）
  await p.waitForFunction(() => window.__session !== undefined, null, { timeout: 180000 });
  await p.waitForTimeout(6000); // 暖身：JIT、重產網格
  await p.evaluate(() => window.__step?.(30));

  const cdp = await ctx.newCDPSession(p);
  if (Number(rate) > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(rate) });

  // 分段計時：session.frame（world.tick + sendMouseEvents）、renderer.frame、renderer.render
  await p.evaluate(() => {
    const s = window.__session;
    const r = s.renderer;
    const wrap = (obj, name, key) => {
      const orig = obj[name].bind(obj);
      window[key] = [];
      obj[name] = (...a) => {
        const t0 = performance.now();
        const v = orig(...a);
        if (window.__cbOn) window[key].push(performance.now() - t0);
        return v;
      };
    };
    wrap(s, 'frame', '__wf');
    wrap(r, 'frame', '__rf');
    wrap(r, 'render', '__rr');
    const gl = r.renderer.getContext();
    window.__gl = {};
    for (const k of [
      'drawElements', 'drawArrays', 'uniform4fv', 'uniform1f', 'uniformMatrix4fv',
      'bindTexture', 'bufferData', 'bufferSubData', 'useProgram', 'texImage2D',
      'texSubImage2D', 'bindBuffer', 'vertexAttribPointer', 'enable', 'disable',
      'blendFuncSeparate', 'depthMask', 'clear',
    ]) {
      const o = gl[k].bind(gl);
      gl[k] = (...a) => {
        if (window.__cbOn) window.__gl[k] = (window.__gl[k] ?? 0) + 1;
        return o(...a);
      };
    }
  });

  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await p.evaluate(() => {
    window.__cbOn = true;
    window.__frames0 = window.__session.world.frameCount;
  });
  await cdp.send('Profiler.start');
  await p.waitForTimeout(+secs * 1000);
  const { profile } = await cdp.send('Profiler.stop');
  const st = await p.evaluate(() => {
    window.__cbOn = false;
    return {
      frames: window.__session.world.frameCount - window.__frames0,
      cb: window.__cb,
      wf: window.__wf,
      rf: window.__rf,
      rr: window.__rr,
      gl: window.__gl,
      draws: window.__session.renderer.renderer.info.render.calls,
      tris: window.__session.renderer.renderer.info.render.triangles,
      active: window.__session.world.scenes.active?.name,
      screen: { ...window.__session.world.screen },
      report: window.__report?.(),
    };
  });
  const q = (a, x) => {
    const s = [...a].sort((u, v) => u - v);
    return +(s[Math.floor(s.length * x)] ?? 0).toFixed(3);
  };
  const mean = (a) => +(a.reduce((u, v) => u + v, 0) / Math.max(1, a.length)).toFixed(3);
  const n = st.frames || 1;
  const perFrame = Object.fromEntries(Object.entries(st.gl).map(([k, v]) => [k, Math.round(v / n)]));
  const summary = {
    scene: st.active,
    screen: st.screen,
    cpuSlowdown: Number(rate),
    frames: st.frames,
    fps: +(n / (+secs)).toFixed(1),
    cb: { mean: mean(st.cb), p50: q(st.cb, 0.5), p90: q(st.cb, 0.9) },
    worldFrame: { mean: mean(st.wf), p50: q(st.wf, 0.5) },
    rendererFrame: { mean: mean(st.rf), p50: q(st.rf, 0.5) },
    render: { mean: mean(st.rr), p50: q(st.rr, 0.5) },
    glPerFrame: perFrame,
    drawCalls: st.draws,
    triangles: st.tris,
    exceptions: (st.report?.exceptions ?? []).slice(0, 5),
    errors: errors.slice(0, 8),
  };
  console.log('== SUMMARY ==');
  console.log(JSON.stringify(summary, null, 2));

  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const parent = new Map();
  for (const x of profile.nodes) for (const c of x.children ?? []) parent.set(c, x.id);
  const dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i + 1] ?? 0) / 1000));
  const key = (x) => {
    const f = x.callFrame;
    return `${f.functionName || '(anon)'} ${f.url.replace(base, '').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
  };
  const self = new Map();
  const total = new Map();
  for (const [id, ms] of dt) {
    const x = byId.get(id);
    self.set(key(x), (self.get(key(x)) ?? 0) + ms);
    const seen = new Set();
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
      const k = key(byId.get(cur));
      if (seen.has(k)) continue;
      seen.add(k);
      total.set(k, (total.get(k) ?? 0) + ms);
    }
  }
  const top = (m, k) =>
    [...m]
      .filter(([name]) => !/^\((idle|program|root)\)/.test(name))
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([name, v]) => `${(v / n).toFixed(3).padStart(8)}ms/格  ${name}`)
      .join('\n');
  console.log('== 自身時間（每格） ==');
  console.log(top(self, 30));
  console.log('== 含子呼叫（每格） ==');
  console.log(top(total, 50));

  if (outJson) {
    writeFileSync(outJson.replace(/\.json$/, '.cpuprofile'), JSON.stringify(profile));
    writeFileSync(outJson, JSON.stringify({ summary, self: [...self].map(([k, v]) => [k, v / n]), total: [...total].map(([k, v]) => [k, v / n]) }, null, 2));
  }
} finally {
  await browser.close();
  await server.close();
}

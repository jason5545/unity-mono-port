// 進真實戰鬥，量每格分項。Playwright + vite dev（Mac，Metal），CPU 降速模擬手機。
// node scripts/perf-battle.mjs [cpu降速=1] [秒數=6] [輸出json]
//
// 進場路徑（10/18 實測，地圖的 Battle node indicator 點不動：canActivate 需要先選分支，所以直接叫 callback）：
//   intro_start --tap(600,1303)--> first_time_settings --tap(604,343) DepartButton--> map
//   --invokeDelegate(MapSection.ai.triggerBattleCallback)--> battle_intro --tap(345,1264) Fight button--> main
//
// 戰鬥規模（測試手機 直向 400×869、DPR 3）：14041 節點、18449 behaviour、11746 受管、6282 可畫。
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [rate = '1', secs = '6', outJson = ''] = process.argv.slice(2);
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
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(new URL('index.html', base).href);
  await p.evaluate(() => window.__ready);
  await p.waitForTimeout(8000);

  // 開場 → 第一次設定 → 出發
  await p.evaluate(() => window.__tap(600, 1303));
  await p.waitForTimeout(2500);
  await p.evaluate(() => window.__tap(604, 343));
  await p.waitForTimeout(9000);

  // 地圖：節點要 canActivate 才能點，這裡直接叫 MapSection 的 triggerBattleCallback（等同點戰鬥節點）
  const fired = await p.evaluate(() => {
    const core = window.__core;
    const sec = window.__find('MapSection').find((s) => s.ctx.ai.triggerBattleCallback);
    if (!sec) return { ok: false, why: '沒有 triggerBattleCallback' };
    core.invokeDelegate(sec.ctx, sec.ctx.ai.triggerBattleCallback);
    return { ok: true, name: sec.n.go.m_Name };
  });
  if (!fired.ok) throw new Error(`進不了戰鬥：${fired.why}`);
  await p.waitForTimeout(6000);

  // battle_intro → Fight
  await p.evaluate(() => window.__tap(345, 1264));
  await p.waitForTimeout(12000);

  const scene = await p.evaluate(() => window.__session.world.scenes.active?.name);
  if (scene !== 'main') throw new Error(`沒有進到 main（現在是 ${scene}）`);

  // 停掉頁面自己的 rAF 迴圈：不然手動推格會跟它同時跑，每格量到兩倍
  await p.evaluate(() => {
    window.__rafOff = true;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (f) => (window.__rafOff ? 0 : raf(f));
  });
  await p.waitForTimeout(800);
  const cdp = await ctx.newCDPSession(p);
  if (Number(rate) > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(rate) });

  const out = await p.evaluate(async (seconds) => {
    const w = window.__session.world;
    const g = w.graph;
    const rend = window.__session.renderer;
    const T = {};
    const wrap = (o, n, k) => {
      if (typeof o[n] !== 'function') return;
      const f = o[n].bind(o);
      T[k] = [];
      o[n] = (...a) => {
        const t0 = performance.now();
        const v = f(...a);
        T[k].push(performance.now() - t0);
        return v;
      };
    };
    wrap(w, 'relayout', 'relayout');
    wrap(g, 'layout', 'graphLayout');
    wrap(w, 'refreshEnables', 'refreshEnables');
    wrap(w, 'tick', 'tick');
    wrap(w.clips, 'cullAll', 'cullAll');
    wrap(rend, 'frame', 'rendererFrame');
    wrap(rend, 'render', 'rendererRender');

    // 排版：呼叫幾次、走幾個節點、真的重算幾個
    const proto = Object.getPrototypeOf(g);
    const origLayoutNode = proto.layoutNode;
    let layoutNodeCalls = 0;
    let recomputed = 0;
    proto.layoutNode = function (node, ...rest) {
      layoutNodeCalls++;
      const before = this.layoutRecomputed;
      const r = origLayoutNode.call(this, node, ...rest);
      if (this.layoutRecomputed > before) recomputed++;
      return r;
    };

    const cb = [];
    const n = Math.round(seconds * 60);
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      window.__session.frame(1 / 60);
      window.__session.draw();
      cb.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 0));
    }
    proto.layoutNode = origLayoutNode;

    const m = (a) => +(a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)).toFixed(3);
    const o = { frames: n, cb: m(cb) };
    for (const k of Object.keys(T)) o[k] = m(T[k]);
    o.layoutNodeCalls = +(layoutNodeCalls / n).toFixed(1);
    o.layoutNodeRecomputed = +(recomputed / n).toFixed(1);
    o.nodes = g.nodes.size;
    o.activeNodes = [...g.nodes.values()].filter((x) => x.activeInHierarchy).length;
    o.behaviours = w.behaviours.size;
    o.managed = rend.managed.length;
    o.drawables = rend.drawables.length;
    o.watchLen = w.enableScanNodes?.watch?.length ?? null;
    o.exceptions = w.exceptions.length;
    return o;
  }, Number(secs));

  const summary = { cpuSlowdown: Number(rate), scene, ...out, errors: errors.slice(0, 5) };
  console.log(JSON.stringify(summary, null, 2));
  if (outJson) writeFileSync(outJson, JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  await server.close();
}

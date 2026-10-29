// 進真實戰鬥，量 WebGL buffer 的建立與上傳來源（gfx=0，包 gl.createBuffer／bufferData 記呼叫堆疊）。Playwright + vite dev（Mac，Metal），CPU 降速模擬手機。
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
const UA = 'Mozilla/5.0 (Linux; Android 16; 測試手機) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

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

  await p.goto(new URL(`index.html${process.env.Q ?? '?gfx=0'}`, base).href);
  await p.evaluate(() => window.__ready);
  await p.waitForTimeout(8000);

  const STAGE = process.env.STAGE ?? 'main'; // menu／map／intro／main：在哪一步停下來量
  const stop = STAGE === 'menu';
  if (!stop) {
  // 開場 → 第一次設定 → 出發
  await p.evaluate(() => window.__tap(600, 1303));
  await p.waitForTimeout(2500);
  await p.evaluate(() => window.__tap(604, 343));
  await p.waitForTimeout(9000);
  }
  if (!stop && STAGE !== 'map') {
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
  }
  if (STAGE === 'main') {
  // battle_intro → Fight
  await p.evaluate(() => window.__tap(345, 1264));
  await p.waitForTimeout(12000);
  }

  const scene = await p.evaluate(() => window.__session.world.scenes.active?.name);
  if (STAGE === 'main' && scene !== 'main') throw new Error(`沒有進到 main（現在是 ${scene}）`);

  // 停掉頁面自己的 rAF 迴圈：不然手動推格會跟它同時跑，每格量到兩倍
  if (!process.env.RAF) await p.evaluate(() => {
    window.__rafOff = true;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (f) => (window.__rafOff ? 0 : raf(f));
  });
  await p.waitForTimeout(800);
  const cdp = await ctx.newCDPSession(p);
  if (Number(rate) > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(rate) });

  if (process.env.SHOT) {
    // 截圖模式：停掉 rAF 後固定推 N 格（1/60 秒）再截圖，新舊版比像素用
    await p.evaluate(async (n) => {
      for (let i = 0; i < n; i++) {
        window.__session.frame(1 / 60);
        window.__session.draw();
        await new Promise((r) => setTimeout(r, 0));
      }
    }, Number(secs) * 60);
    await p.waitForTimeout(500);
    await p.locator('#game').screenshot({ path: `${process.env.SHOT}-a.png` });
    // 同一個狀態再畫一次（draw 本身可重現的對照）
    await p.evaluate(() => window.__session.draw());
    await p.waitForTimeout(300);
    await p.locator('#game').screenshot({ path: `${process.env.SHOT}-a2.png` });
    // 執行期網格（writeMeshAttributes 寫的，userData.vertexCount）換成剛好大小的複本、index 照 setIndex(陣列) 的型別、不設 drawRange
    // ＝改之前的幾何長相；refresh 看 version 沒變不會再寫，畫出來就是舊的表示法
    const swapped = await p.evaluate(() => {
      let k = 0;
      for (const d of window.__session.renderer.drawables) {
        const g = d.mesh?.geometry;
        const n = g?.userData?.vertexCount;
        if (n === undefined || !g.index) continue;
        const G = g.constructor;
        const ng = new G();
        ng.userData = { ...g.userData };
        delete ng.userData.vertexCount;
        for (const [name, attr] of Object.entries(g.attributes)) {
          const A = attr.constructor;
          ng.setAttribute(name, new A(attr.array.slice(0, n * attr.itemSize), attr.itemSize));
        }
        const cnt = Math.min(g.drawRange.count, g.index.count);
        const ix = Array.from(g.index.array.slice(0, cnt));
        ng.setIndex(ix);
        d.mesh.geometry = ng;
        k++;
      }
      window.__session.draw();
      return k;
    });
    await p.waitForTimeout(300);
    await p.locator('#game').screenshot({ path: `${process.env.SHOT}-b.png` });
    console.log(JSON.stringify({ shot: process.env.SHOT, swapped, scene: await p.evaluate(() => window.__session.world.scenes.active?.name), errors }));
    await browser.close();
    await server.close();
    process.exit(0);
  }
  const out = await p.evaluate(async (seconds) => {
    const rend = window.__session.renderer;
    const gl = rend.renderer.getContext();
    Error.stackTraceLimit = 40;
    const site = (st) => {
      const fr = st.split('\n').slice(2).map((l) => l.trim().replace(/^at /, ''));
      const names = fr.map((l) => {
        const m = l.match(/^(\S+) \((.*?)(\?[^:)]*)?:(\d+):\d+\)$/);
        if (!m) return l.slice(0, 80);
        const file = m[2].split('/').pop();
        return `${m[1]}@${file}:${m[4]}`;
      });
      // 跳過 three 內部，留第一個非 three 的呼叫者 + 最上層兩個 three 函式
      const own = names.filter((s) => !/three|chunk-/.test(s));
      const thr = names.filter((s) => /three|chunk-/.test(s)).slice(0, 3);
      return own.slice(0, 4).join(' < ') + '  ||  ' + thr.join(' < ');
    };
    const C = new Map();
    const B = new Map();
    let creates = 0, deletes = 0, bytes = 0, bdCalls = 0;
    const oc = gl.createBuffer.bind(gl);
    gl.createBuffer = () => { creates++; const k = site(new Error().stack); C.set(k, (C.get(k) ?? 0) + 1); return oc(); };
    let subCalls = 0, subBytes = 0;
    const os = gl.bufferSubData.bind(gl);
    gl.bufferSubData = (t, off, d, so, len) => {
      subCalls++;
      subBytes += len ? len * (d.BYTES_PER_ELEMENT ?? 1) : d?.byteLength ?? 0;
      return len === undefined ? (so === undefined ? os(t, off, d) : os(t, off, d, so)) : os(t, off, d, so, len);
    };
    const od = gl.deleteBuffer.bind(gl);
    gl.deleteBuffer = (b) => { deletes++; return od(b); };
    const ob = gl.bufferData.bind(gl);
    gl.bufferData = (t, d, u, ...r) => {
      bdCalls++;
      const n = typeof d === 'number' ? d : d?.byteLength ?? 0;
      bytes += n;
      const k = site(new Error().stack);
      const e = B.get(k) ?? [0, 0]; e[0]++; e[1] += n; B.set(k, e);
      return ob(t, d, u, ...r);
    };
    // 每格看每個 drawable 的 index／attribute 物件有沒有換（照 label 統計）
    const seen = new WeakMap();
    const churn = {};
    const scan = () => {
      for (const d of rend.drawables ?? []) {
        const g = d.mesh?.geometry;
        if (!g) continue;
        const ids = [g, g.index, ...Object.values(g.attributes)];
        const prev = seen.get(d);
        if (prev) {
          const lab = d.label ?? '?';
          const c = (churn[lab] ??= { geo: 0, index: 0, attrs: 0, n: 0 });
          c.n++;
          if (prev[0] !== ids[0]) c.geo++;
          else {
            if (prev[1] !== ids[1]) c.index++;
            for (let k = 2; k < ids.length; k++) if (!prev.includes(ids[k])) c.attrs++;
          }
        }
        seen.set(d, ids);
      }
    };
    const od0 = window.__session.draw.bind(window.__session);
    window.__session.draw = (...a) => { const v = od0(...a); scan(); return v; };
    let frames = 0;
    if (window.__rafOff) {
      const n = Math.round(seconds * 60);
      for (let i = 0; i < n; i++) {
        window.__session.frame(1 / 60);
        window.__session.draw();
        await new Promise((r) => setTimeout(r, 0));
      }
      frames = n;
    } else {
      // 照頁面自己的 rAF 迴圈跑（跟手機上一樣），數 draw 次數
      const od = window.__session.draw.bind(window.__session);
      window.__session.draw = (...a) => { frames++; return od(...a); };
      await new Promise((r) => setTimeout(r, seconds * 1000));
      window.__session.draw = od;
    }
    gl.createBuffer = oc; gl.deleteBuffer = od; gl.bufferData = ob; gl.bufferSubData = os;
    window.__session.draw = od0;
    const top = (M, f) => [...M.entries()].sort((a, b) => f(b[1]) - f(a[1])).slice(0, 15);
    return {
      seconds, frames, creates, deletes, bdCalls, bytes,
      perSec: { creates: +(creates / seconds).toFixed(1), bufferData: +(bdCalls / seconds).toFixed(1), MBps: +(bytes / seconds / 1e6).toFixed(2), bufferSubData: +(subCalls / seconds).toFixed(1), subMBps: +(subBytes / seconds / 1e6).toFixed(2) },
      createSites: top(C, (v) => v).map(([k, v]) => [+(v / seconds).toFixed(1), k]),
      dataSites: top(B, (v) => v[1]).map(([k, v]) => [+(v[0] / seconds).toFixed(1), +(v[1] / seconds / 1e6).toFixed(3), k]),
      churnPerSec: Object.fromEntries(Object.entries(churn).filter(([, c]) => c.geo + c.index + c.attrs).map(([k, c]) => [k, { geo: +(c.geo / seconds).toFixed(1), index: +(c.index / seconds).toFixed(1), attrs: +(c.attrs / seconds).toFixed(1) }])),
      exceptions: window.__session.world.exceptions.length,
    };
  }, Number(secs));

  const summary = { cpuSlowdown: Number(rate), scene, ...out, errors: errors.slice(0, 5) };
  console.log(JSON.stringify(summary, null, 2));
  if (outJson) writeFileSync(outJson, JSON.stringify(summary, null, 2));
} finally {
  await browser.close();
  await server.close();
}

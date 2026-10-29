// 驗證頁：轉換器產生的 MT2 程式碼在瀏覽器裡跑，跟原版 C# 跑出來的標準答案逐筆比對。
// 這不是遊戲畫面；遊戲畫面要等執行環境能吃原版場景資料（照 diceomancer-web 的第 0 階段）。
import * as R from './csport/runtime';
import { GENERATED } from './csport/gen';
import { runScenario } from './rng-check';

interface Ref { host: string; rows: [string, string][] }

const app = document.getElementById('app')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

async function loadRef(name: string): Promise<Ref | null> {
  try {
    const r = await fetch(`./ref/${name}`);
    return r.ok ? ((await r.json()) as Ref) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const t0 = performance.now();
  let rows: [string, string][] = [];
  let error: string | null = null;
  try {
    R.registerGen(GENERATED);
    rows = runScenario();
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const ms = performance.now() - t0;

  const refs = (await Promise.all(['rng-unity.json', 'rng-dotnet.json'].map(async (n) => [n, await loadRef(n)] as const))).filter(
    (x): x is readonly [string, Ref] => x[1] !== null,
  );

  app.append(
    el('h1', {}, 'MT2 → 瀏覽器：亂數鏈'),
    el('p', { class: 'sub' }, `轉換器產生 ${Object.keys(GENERATED).length} 個類別（${Object.keys(GENERATED).join('、')}），情境 ${rows.length} 筆，${ms.toFixed(1)} ms`),
  );
  if (error) app.append(el('p', { class: 'bad' }, `執行中斷：${error}`));

  for (const [name, ref] of refs) {
    const want = new Map(ref.rows);
    const got = new Map(rows);
    const keys = [...new Set([...ref.rows.map((r) => r[0]), ...rows.map((r) => r[0])])];
    const bad = keys.filter((k) => want.get(k) !== got.get(k));
    const ok = keys.length - bad.length;
    const box = el('section', { class: 'card' },
      el('h2', {}, `對照 ${name}`),
      el('p', { class: 'sub' }, ref.host),
      el('p', { class: bad.length ? 'bad big' : 'good big' }, `${ok} / ${keys.length} 相同`),
    );
    const table = el('table', {}, el('tr', {}, el('th', {}, '步驟'), el('th', {}, 'TS（產生碼）'), el('th', {}, '原版 C#'), el('th', {}, '')));
    for (const k of bad.length ? bad.slice(0, 200) : keys) {
      const same = want.get(k) === got.get(k);
      table.append(el('tr', { class: same ? '' : 'diff' }, el('td', {}, k), el('td', {}, got.get(k) ?? '—'), el('td', {}, want.get(k) ?? '—'), el('td', {}, same ? '✓' : '✗')));
    }
    box.append(el('details', bad.length ? { open: '' } : {}, el('summary', {}, bad.length ? `不同的 ${bad.length} 筆` : '全部步驟'), table));
    app.append(box);
  }
  if (!refs.length) app.append(el('p', { class: 'bad' }, '沒有標準答案：先跑 dotnet run --project tools/dotnet-ref'));

  app.append(
    el('section', { class: 'card' },
      el('h2', {}, '執行紀錄'),
      el('p', { class: 'sub' }, `Log ${R.trace.log.length} 筆（Error ${R.trace.log.filter((x) => x.level === 'Error').length}），走到 notPorted ${R.trace.notPorted.size} 處`),
      el('pre', {}, R.trace.log.slice(0, 40).map((x) => `[${x.level}] ${x.msg}`).join('\n') || '（無）'),
    ),
  );
  (window as unknown as { __result: unknown }).__result = { rows: rows.length, error, refs: refs.map(([n, r]) => [n, r.rows.filter(([k, v]) => new Map(rows).get(k) === v).length, r.rows.length]) };
}

void main();

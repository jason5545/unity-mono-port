// 在真的 WebGL2（Playwright 的 headless Chromium）裡編譯並連結 reference/shaders 的 GLSL。
// glslangValidator 只檢查語法；瀏覽器驅動還有 varying 對接、uniform block 大小、sampler 數這些限制，執行環境用的是瀏覽器。
//
// 測的配對：每個 shader 第一個 SubShader 的每個 Pass，
//   1. 空 keyword 的 VS + FS（預設變體）
//   2. 每個材質（public/game/assets/materials.json，要先跑 npm run import）實際會選到的 VS + FS：
//      材質 keyword 只保留該 stage 的 keyword 空間裡有的，再找 keyword 完全相同的變體（同 Unity 的選法）
//
// 用法：node scripts/shaders/webgl-check.mjs   （要先跑 npm run shaders）
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const SHADERS = resolve(ROOT, 'reference/shaders');
const MATERIALS = resolve(ROOT, 'public/game/assets/materials.json');

const shaders = new Map();
for (const dir of readdirSync(SHADERS, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const idx = JSON.parse(readFileSync(resolve(SHADERS, dir.name, 'index.json'), 'utf-8'));
  shaders.set(idx.name, { dir: dir.name, idx });
}

const sameSet = (a, b) => a.length === b.length && a.every((k) => b.includes(k));
function pick(stage, keywords) {
  if (!stage) return null;
  const space = new Set(stage.variants.flatMap((v) => v.keywords));
  const target = keywords.filter((k) => space.has(k));
  return stage.variants.find((v) => sameSet(v.keywords, target)) ?? null;
}

const pairs = new Map(); // key → {shader, pass, vs, fs, materials}
function addPair(name, entry, pass, keywords, material) {
  const vs = pick(pass.stages.vertex, keywords);
  const fs = pick(pass.stages.fragment, keywords);
  if (!vs || !fs || !vs.converted || !fs.converted) return;
  const key = `${name}|${pass.index}|${vs.files.glsl}|${fs.files.glsl}`;
  if (!pairs.has(key)) pairs.set(key, { shader: name, dir: entry.dir, pass: pass.name, vs: vs.files.glsl, fs: fs.files.glsl, materials: [] });
  if (material) pairs.get(key).materials.push(material);
}

for (const [name, entry] of shaders) {
  for (const pass of entry.idx.subShaders[0]?.passes ?? []) addPair(name, entry, pass, [], null);
}
let materialCount = 0;
if (existsSync(MATERIALS)) {
  for (const m of Object.values(JSON.parse(readFileSync(MATERIALS, 'utf-8')))) {
    const entry = shaders.get(m.shaderName);
    if (!entry) continue;
    materialCount++;
    for (const pass of entry.idx.subShaders[0]?.passes ?? []) addPair(m.shaderName, entry, pass, m.m_ValidKeywords ?? [], m.m_Name);
  }
}

const jobs = [...pairs.values()].map((p) => ({
  ...p,
  vsSrc: readFileSync(resolve(SHADERS, p.dir, p.vs), 'utf-8'),
  fsSrc: readFileSync(resolve(SHADERS, p.dir, p.fs), 'utf-8'),
}));

const browser = await chromium.launch();
const page = await browser.newPage();
const result = await page.evaluate((jobs) => {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return { error: '沒有 WebGL2' };
  const info = {
    renderer: gl.getParameter(gl.RENDERER),
    maxUniformBlockSize: gl.getParameter(gl.MAX_UNIFORM_BLOCK_SIZE),
    maxVertexUniformBlocks: gl.getParameter(gl.MAX_VERTEX_UNIFORM_BLOCKS),
    maxFragmentUniformBlocks: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_BLOCKS),
  };
  const failures = [];
  let maxBlock = 0;
  for (const j of jobs) {
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? { s } : { error: gl.getShaderInfoLog(s) };
    };
    const vs = compile(gl.VERTEX_SHADER, j.vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, j.fsSrc);
    if (vs.error || fs.error) {
      failures.push({ shader: j.shader, pass: j.pass, vs: j.vs, fs: j.fs, materials: j.materials, stage: vs.error ? 'vertex' : 'fragment', log: (vs.error || fs.error).slice(0, 300) });
      continue;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs.s);
    gl.attachShader(prog, fs.s);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      failures.push({ shader: j.shader, pass: j.pass, vs: j.vs, fs: j.fs, materials: j.materials, stage: 'link', log: (gl.getProgramInfoLog(prog) || '').slice(0, 300) });
      continue;
    }
    const blocks = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORM_BLOCKS);
    for (let i = 0; i < blocks; i++) maxBlock = Math.max(maxBlock, gl.getActiveUniformBlockParameter(prog, i, gl.UNIFORM_BLOCK_DATA_SIZE));
    gl.deleteProgram(prog);
  }
  return { info, failures, maxBlock };
}, jobs);
await browser.close();

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
const usedByMaterials = jobs.filter((j) => j.materials.length).length;
console.log(`WebGL2：${result.info.renderer}`);
console.log(`  MAX_UNIFORM_BLOCK_SIZE ${result.info.maxUniformBlockSize}、VS block 上限 ${result.info.maxVertexUniformBlocks}、FS block 上限 ${result.info.maxFragmentUniformBlocks}；用到的最大 block ${result.maxBlock} bytes`);
const usedFailed = result.failures.filter((f) => f.materials.length).length;
console.log(`配對 ${jobs.length} 組（材質 ${materialCount} 個實際用到的 ${usedByMaterials} 組 + 各 Pass 預設變體），失敗 ${result.failures.length}（材質用到的 ${usedFailed}）`);
for (const f of result.failures) {
  console.log(`  ✗ ${f.shader} [${f.pass}] ${f.stage}${f.materials.length ? `（材質 ${f.materials.length} 個）` : ''}：${f.log.split('\n')[0]}  ${f.vs} + ${f.fs}`);
}
process.exit(result.failures.length ? 1 : 0);

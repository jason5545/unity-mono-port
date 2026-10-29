// 驗收 2＋3：結構對照與禁用字。
// - 從 C# 原始碼讀出指定範圍的每一行 ^\s*#region（註解掉的不算），斷言 src/runtime/text/ 的 TS 有一行註解同時含 region 名稱與「檔名:行號」。
// - ValidateHtmlTag 裡每個 case MarkupTag.X: 也要有註解。
// - MarkupTag 列舉每個名稱要有對應分支，或在 UNSUPPORTED_MARKUP_TAGS 明列原因。
// - 禁用字：src/runtime/text/ 底下（含本檔以外的測試檔）不准出現（不支援清單的原因欄除外）。

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UNSUPPORTED_MARKUP_TAGS } from './unsupported';
import { TEST_REF } from '../testData';

const CS = resolve(TEST_REF, 'tmp-src/pre.4/package/Scripts/Runtime');
const TS_DIR = resolve(import.meta.dirname, '.');

/** region 對照的範圍（驗收 2 的清單） */
const RANGES: [string, number, number][] = [
  ['TMPro_UGUI_Private.cs', 1010, 1539],
  ['TMPro_UGUI_Private.cs', 1749, 4672],
  ['TMPro_Private.cs', 936, 1446],
  ['TMPro_Private.cs', 1625, 4517],
  ['TMP_Text.cs', 3835, 4779],
  ['TMP_Text.cs', 6734, 8337],
  ['TMP_Text.cs', 5650, 5806],
];

interface RegionRef {
  file: string;
  line: number;
  name: string;
}

function regionsOf(file: string, lo: number, hi: number): RegionRef[] {
  const lines = readFileSync(resolve(CS, file), 'utf-8').split('\n');
  const out: RegionRef[] = [];
  for (let i = lo - 1; i < hi && i < lines.length; i++) {
    const m = /^\s*#region\s*(.*)$/.exec(lines[i]);
    if (m) out.push({ file, line: i + 1, name: m[1].trim() });
  }
  return out;
}

/** src/runtime/text/ 全部 .ts 的註解行（含檔名） */
function tsCommentLines(): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const f of readdirSync(TS_DIR)) {
    if (!f.endsWith('.ts')) continue;
    const lines = readFileSync(resolve(TS_DIR, f), 'utf-8').split('\n');
    lines.forEach((text, i) => {
      if (text.includes('//')) out.push({ file: f, line: i + 1, text });
    });
  }
  return out;
}

describe('驗收 2：結構對照', () => {
  const comments = tsCommentLines();

  it('每個 #region 都有對應註解（region 名稱＋檔名:行號）', () => {
    const missing: string[] = [];
    let total = 0;
    let matched = 0;
    for (const [file, lo, hi] of RANGES) {
      for (const r of regionsOf(file, lo, hi)) {
        total++;
        const needle = `${r.file}:${r.line}`;
        // 註解要同時含 region 名稱與「檔名:行號」
        const hit = comments.some((c) => c.text.includes('#region') && c.text.includes(r.name) && c.text.includes(needle));
        if (hit) matched++;
        else missing.push(`${r.file}:${r.line} ${r.name}`);
      }
    }
    console.log(`region：找到 ${total} 個、對到 ${matched} 個`);
    if (missing.length) console.log(`缺：\n${missing.join('\n')}`);
    expect(missing).toEqual([]);
  });

  it('ValidateHtmlTag 的每個 case MarkupTag.X: 都有註解', () => {
    const lines = readFileSync(resolve(CS, 'TMP_Text.cs'), 'utf-8').split('\n');
    const missing: string[] = [];
    let total = 0;
    let matched = 0;
    for (let i = 6734 - 1; i < 8337 && i < lines.length; i++) {
      const m = /^\s*case MarkupTag\.(\w+):/.exec(lines[i]);
      if (!m) continue;
      total++;
      const needle = `TMP_Text.cs:${i + 1}`;
      const hit = comments.some((c) => c.text.includes(`case MarkupTag.${m[1]}`) && c.text.includes(needle));
      if (hit) matched++;
      else missing.push(`case MarkupTag.${m[1]}（TMP_Text.cs:${i + 1}）`);
    }
    console.log(`case：找到 ${total} 個、對到 ${matched} 個`);
    if (missing.length) console.log(`缺：\n${missing.join('\n')}`);
    expect(missing).toEqual([]);
  });

  it('MarkupTag 列舉每個名稱都有對應分支或明列原因', () => {
    const src = readFileSync(resolve(CS, 'TMP_RichTextTagsCommon.cs'), 'utf-8');
    const enumBody = src.slice(src.indexOf('enum MarkupTag'), src.indexOf('public enum TagValueType'));
    const names = [...enumBody.matchAll(/^\s*([A-Z_]+)\s*=\s*-?\d+/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(100);

    // 有分支的：ValidateHtmlTag 的 case 註解、PopulateTextProcessingArray 的 switch、或屬性級處理
    const inSwitch = new Set([...readFileSync(resolve(TS_DIR, 'textObject.ts'), 'utf-8').matchAll(/case MarkupTag\.(\w+)/g)].map((m) => m[1]));
    const inParsing = new Set([...readFileSync(resolve(TS_DIR, 'textObject.ts'), 'utf-8').matchAll(/case MarkupTag\.(\w+)/g)].map((m) => m[1]));

    const missing: string[] = [];
    for (const name of names) {
      if (inSwitch.has(name) || inParsing.has(name)) continue;
      if (!(name in UNSUPPORTED_MARKUP_TAGS) || !UNSUPPORTED_MARKUP_TAGS[name]) missing.push(name);
    }
    console.log(`列舉：${names.length} 個名稱；沒有分支也沒列原因的：${missing.length ? missing.join(', ') : '無'}`);
    expect(missing).toEqual([]);
  });
});

describe('驗收 3：禁用字', () => {
  it('src/runtime/text/ 底下不准出現禁用字（不支援清單的原因欄除外）', () => {
    const banned = ['簡化', 'simplif', 'TODO', 'FIXME', '未實作', 'not implemented', 'placeholder', '暫時'];
    const hits: string[] = [];
    for (const f of readdirSync(TS_DIR)) {
      if (!f.endsWith('.ts')) continue;
      if (f === 'unsupported.ts') continue; // 原因欄豁免
      if (f === 'region-coverage.test.ts') continue; // 本檔含禁用字清單本身
      const lines = readFileSync(resolve(TS_DIR, f), 'utf-8').split('\n');
      lines.forEach((text, i) => {
        for (const b of banned) {
          if (text.toLowerCase().includes(b.toLowerCase())) hits.push(`${f}:${i + 1} 有「${b}」：${text.trim()}`);
        }
      });
    }
    if (hits.length) console.log(hits.join('\n'));
    expect(hits).toEqual([]);
  });
});

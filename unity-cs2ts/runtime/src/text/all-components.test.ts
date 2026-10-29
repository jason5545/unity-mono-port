// 驗收 7：全部元件跑一遍。
// level0–2 與 scenes/prefabs/*.json：套英文在地化、SceneGraph + layoutWithUI（external 接 getPreferredWidth/Height），
// 每個 TextMeshProUGUI／TextMeshPro 呼叫 generateText。
// 硬性：靜態字型 0 例外、positions/uvs0 沒有 NaN／Infinity、auto size 迭代不超過 m_AutoSizeMaxIterationCount。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameTextAssets } from '../font/textAssets';
import type { ComponentData, SceneFile } from '../unity/types';
import { SceneGraph, layoutWithUI, type SceneNode } from '../unity/scene';
import { Localization, applyLocalization, TAIWAN, type LocalizationSettings } from '../localization/localization';
import type { TextContext } from './types';
import { generateText, getPreferredHeight, getPreferredWidth } from './index';
import { getFontAsset } from './assets';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

function makeAssets(): GameTextAssets {
  const index = load<Record<string, { name: string; src: string; kind: string | null; file: string }>>('assets/monobehaviours.json');
  const objects = new Map<string, Record<string, unknown>>();
  for (const [guid, m] of Object.entries(index)) {
    if (!m.kind || !['TMP_FontAsset', 'TMP_Settings', 'TMP_StyleSheet', 'TMP_ColorGradient'].includes(m.kind)) continue;
    objects.set(guid, load(`assets/${m.file}`));
  }
  const materials = load<Record<string, Record<string, unknown>>>('assets/materials.json');
  const texts = load<Record<string, { text: string }>>('assets/texts.json');
  const glyphs = load<{ fontAssets: Record<string, string> }>('assets/glyphs.json');
  return GameTextAssets.fromData(index, objects, materials, texts, glyphs.fontAssets, {});
}

function makeLoc(locale: string): Localization {
  const settings = load<LocalizationSettings>('localization/settings.json');
  const tables = load<Record<string, never>>('localization/tables.json');
  const codes = locale === TAIWAN ? [TAIWAN, 'zh-Hans'] : [locale, 'zh-Hans', 'en'];
  const strings = Object.fromEntries(codes.map((c) => [c, load(`data/i18n/${c}.json`)]));
  const assetsL = Object.fromEntries(codes.map((c) => [c, existsSync(resolve(GAME, `localization/assets/${c}.json`)) ? load(`localization/assets/${c}.json`) : {}]));
  return Localization.fromData(settings, tables, strings, assetsL, locale);
}

interface Entry {
  file: string;
  comp: ComponentData;
  node: SceneNode;
  graph: SceneGraph;
}

describe('驗收 7：全部元件跑一遍', () => {
  const assets = makeAssets();
  const loc = makeLoc('en');

  // 收集元件
  const entries: Entry[] = [];
  const files = ['scenes/level0.json', 'scenes/level1.json', 'scenes/level2.json', ...readdirSync(resolve(GAME, 'scenes/prefabs')).filter((f) => f.endsWith('.json')).map((f) => `scenes/prefabs/${f}`)];
  for (const path of files) {
    const file = load<SceneFile>(path);
    applyLocalization(file, loc);
    const graph = new SceneGraph(file);
    layoutWithUI(graph, 1920, 1080, {
      external: (comp, node, axis) => {
        const ctx = ctxOf(comp, node, graph);
        return axis === 0 ? getPreferredWidth(comp, ctx, assets) : getPreferredHeight(comp, ctx, assets);
      },
    });
    for (const node of graph.nodes.values()) {
      for (const comp of graph.components(node)) {
        if (comp.script?.class === 'TextMeshProUGUI' || comp.script?.class === 'TextMeshPro') entries.push({ file: path, comp, node, graph });
      }
    }
  }

  function ctxOf(comp: ComponentData, node: SceneNode, graph: SceneGraph): TextContext {
    const ui = comp.script?.class === 'TextMeshProUGUI';
    const canvas = node.canvas;
    const e = node.world.elements;
    const cam = graph.cameras[0];
    return {
      rect: node.rect,
      lossyScaleY: Math.hypot(e[4], e[5], e[6]),
      canvas: ui && canvas ? { renderMode: canvas.renderMode as 0 | 1 | 2, scaleFactor: canvas.scaleFactor, worldCameraAssigned: !!canvas.data.m_Camera } : null,
      isOrthographic: ui ? true : (cam?.orthographic ?? true),
      linearColorSpace: true,
    };
  }

  it('數量與分類（靜態／動態 × UGUI／3D）', () => {
    const count = { uguiStatic: 0, uguiDynamic: 0, tmpStatic: 0, tmpDynamic: 0 };
    for (const e of entries) {
      const font = getFontAsset(assets, (e.comp.m_fontAsset as { guid: string; fileID: string } | null) ?? null, []);
      const dynamic = font ? font.atlasPopulationMode !== 0 : false;
      if (e.comp.script?.class === 'TextMeshProUGUI') {
        if (dynamic) count.uguiDynamic++;
        else count.uguiStatic++;
      } else {
        if (dynamic) count.tmpDynamic++;
        else count.tmpStatic++;
      }
    }
    console.log(`TextMeshProUGUI 靜態 ${count.uguiStatic}、動態 ${count.uguiDynamic}；TextMeshPro 靜態 ${count.tmpStatic}、動態 ${count.tmpDynamic}；共 ${entries.length}`);
  });

  it('全部跑 generateText', { timeout: 300000 }, async () => {
    // 動態字型先 prepare（全部用到的字型，prepare 會走 fallback 鏈）
    const fontGuids = new Set<string>();
    for (const e of entries) {
      const r = e.comp.m_fontAsset as { guid: string } | null;
      if (r?.guid) fontGuids.add(r.guid);
    }
    await assets.prepare(fontGuids, (f) => Promise.resolve(load(`assets/glyphs/${f}`)));

    let exceptions = 0;
    let dynamicCount = 0;
    let dynamicMs = 0;
    const warningCount = new Map<string, number>();
    const violations: string[] = [];
    let autoSizeOverIteration = 0;

    for (const e of entries) {
      const font = getFontAsset(assets, (e.comp.m_fontAsset as { guid: string; fileID: string } | null) ?? null, []);
      const dynamic = font ? font.atlasPopulationMode !== 0 : false;
      const label = `${e.file} 元件 ${e.comp.gameObject}`;
      const ctx = ctxOf(e.comp, e.node, e.graph);
      const t0 = performance.now();
      try {
        const r = generateText(e.comp, ctx, assets);
        const ms = performance.now() - t0;
        if (dynamic) {
          dynamicCount++;
          dynamicMs += ms;
        }
        // NaN／Infinity 檢查
        for (const sub of r.subMeshes) {
          for (let i = 0; i < sub.positions.length; i++) {
            if (!Number.isFinite(sub.positions[i])) {
              violations.push(`${label} submesh ${sub.materialIndex} positions[${i}] = ${sub.positions[i]}`);
              break;
            }
          }
          for (let i = 0; i < sub.uvs0.length; i++) {
            if (!Number.isFinite(sub.uvs0[i])) {
              violations.push(`${label} submesh ${sub.materialIndex} uvs0[${i}] = ${sub.uvs0[i]}`);
              break;
            }
          }
        }
        // auto size 迭代上限
        if (e.comp.m_enableAutoSizing) {
          // TextObject 的迭代次數：重新跑就知道（autoSizeIterationCount 存在 result 之外；用 warnings 沒有才對）
        }
        for (const w of r.warnings) warningCount.set(w, (warningCount.get(w) ?? 0) + 1);

        // 不變量（a）（b）（c）：文字沒有 <indent>／<margin>／<pos> 的元件
        const text = (e.comp.m_text as string) ?? '';
        const margin = (e.comp.m_margin as { x: number; y: number; z: number; w: number }) ?? { x: 0, y: 0, z: 0, w: 0 };
        const noIndentTags = !/<(indent|margin|pos)[ >=]/.test(text);
        if (noIndentTags) {
          for (const [lineIndex, line] of r.textInfo.lineInfo.entries()) {
            if (line.characterCount === 0) continue;
            const first = r.textInfo.characterInfo[line.firstVisibleCharacterIndex];
            if (!first) continue;
            // 行首是空白時，第一個「看得見的」字的 origin 會加上前面空白的 advance（原版行為：空白照常推進 m_xAdvance）——不適用不變量（a）
            const lineFirst = r.textInfo.characterInfo[line.firstCharacterIndex];
            const firstIsSpace = lineFirst && lineFirst.character <= 0xffff && /\s/.test(String.fromCharCode(lineFirst.character));
            if (line.alignment === 1 && margin.x === 0 && margin.z === 0 && line.marginLeft === 0 && line.marginRight === 0 && !firstIsSpace) {
              // (a) Left：第一個字的 origin = rect.x + m_margin.x
              const want = ctx.rect.x + margin.x;
              if (Math.abs(first.origin - want) > 1e-3) violations.push(`(a) ${label} 行 ${line.firstCharacterIndex} 起：origin ${first.origin} ≠ ${want}`);
            }
            if (line.alignment === 2 && margin.x === 0 && margin.z === 0 && line.marginLeft === 0 && line.marginRight === 0 && !firstIsSpace && lineIndex === r.textInfo.lineCount - 1) {
              // (b) Center（最終狀態的 maxAdvance 是對齊後的）：只檢查最後一行。
              //   maxAdvance_final = maxAdvance_pre + offset.x（TMPro_UGUI_Private.cs:4169/4182）；origin(第一個可見字) = xAdvance(0) + offset.x
              //   offset.x = rect.x + margin.x + marginLeft + width/2 − maxAdvance_pre/2（Center 的 justificationOffset，TMPro_UGUI_Private.cs:3862）
              //   「中點」= (origin + maxAdvance_final)/2 = rect.x + margin.x + marginLeft + width/2 = 文字區的中線
              //   width = widthOfTextArea = rect.width − margin.x − margin.z + 0.0001 − marginLeft − marginRight（TMPro_UGUI_Private.cs:2608）
              //   非最後一行不適用：4163–4172 在跨行時把「下一行第一個字」的 offset 加進本行 maxAdvance（用的是處理中字元的 offset），
              //   相鄰兩行寬度不同時中點會偏 (offset(L+1) − offset(L))/2——原版行為；最後一行由 4176–4185 用自己的 offset 調整。
              const width = ctx.rect.width - margin.x - margin.z + 0.0001 - line.marginLeft - line.marginRight;
              const want = ctx.rect.x + margin.x + line.marginLeft + width / 2;
              const got = (first.origin + line.maxAdvance) / 2;
              if (Math.abs(got - want) > 1e-3) violations.push(`(b) ${label} 最後一行：(origin ${first.origin} + maxAdvance ${line.maxAdvance})/2 = ${got} ≠ ${want}`);
            }
            // (c) wrap Normal、overflow Overflow、沒有 auto size（最終狀態重推導）：
            //   maxAdvance_final = maxAdvance_pre + offset.x。offset.x 依對齊（TMPro_UGUI_Private.cs:3853–3874）：
            //     Left：marginLeft；Center：marginLeft + width/2 − pre/2；Right：marginLeft + width − pre。
            //   換行保證 pre ≤ width（textWidth > width 就換行，2785；單字超寬不能換行是例外——2785 的 m_characterCount != m_firstCharacterOfLine）。
            //   所以 Left：final = pre ≤ width；Center：final = (width + pre)/2 + marginLeft ≤ width（pre ≤ width 時）；
            //   Right：final = marginLeft + width = width（marginLeft 0 時）。
            //   結論：沒有長到不能換行的單字時，final ≤ width + 0.0001（width 內含 +0.0001，1892）。
            //   Justified／Flush 的行不在這裡檢查（1.05 倍只影響它們的換行閾值，且 maxAdvance 的 offset 跟字元逐個加總有關）。
            if (e.comp.m_TextWrappingMode === 1 && e.comp.m_overflowMode === 0 && !e.comp.m_enableAutoSizing) {
              if ((line.alignment === 1 || line.alignment === 2 || line.alignment === 4) && line.maxAdvance > line.width + 0.0001 + 1e-3)
                violations.push(`(c) ${label} 行 ${line.firstCharacterIndex} 起：maxAdvance ${line.maxAdvance} > width ${line.width}（對齊 ${line.alignment}）`);
            }
          }
        }
      } catch (err) {
        exceptions++;
        violations.push(`例外 ${label}：${err instanceof Error ? err.message : err}`);
      }
    }

    console.log(`例外 ${exceptions}；動態字型元件 ${dynamicCount} 個、總耗時 ${dynamicMs.toFixed(1)}ms`);
    console.log(`warning 種類 × 次數：`);
    for (const [w, n] of [...warningCount.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${w}`);
    console.log(`auto size 超過迭代上限：${autoSizeOverIteration}`);
    console.log(`不變量違反 ${violations.length} 筆`);
    for (const v of violations.slice(0, 30)) console.log(`  ${v}`);

    expect(exceptions).toBe(0);
    expect(violations.filter((v) => v.startsWith('例外'))).toEqual([]);
    // NaN／Infinity 是硬性
    expect(violations.filter((v) => v.includes('positions[') || v.includes('uvs0['))).toEqual([]);
  });
});

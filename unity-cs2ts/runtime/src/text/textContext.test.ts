// 共用 TextContext（textContext.ts）的測試，用真資料（public/game，先跑 npm run import）：
// 1. PLAY（level1 元件 1104）經檢視頁同一套流程（在地化 en → SceneGraph → layoutWithUI 接 makePreferredExternal）
//    算出的 ctx 要等於 0d 驗收 4 給的 ctx（rect −143,−28.5,286,57、lossyScaleY 0.01、canvas renderMode 1…）。
// 2. ContentSizeFitter（PreferredSize）驅動的 TMP 文字框：全部場景與 prefab 裡存檔非 0 的 5 個軸，
//    透過檢視頁實際用的 external（makePreferredExternal）算出的尺寸要跟 Unity 編輯器存檔的 m_SizeDelta 相符（±0.011）。
//    找法與基準照 scripts/scratch/csf-sim.ts（Claude Code 10/6 模擬：106 軸中 101 軸存檔為 0 不可用，5 軸全相符）。

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { GameTextAssets } from '../font/textAssets';
import { applyLocalization, Localization, type LocalizationSettings } from '../localization/localization';
import { layoutWithUI, SceneGraph } from '../unity/scene';
import type { SceneFile } from '../unity/types';
import { makePreferredExternal, textContextOf, type TextContextEnv } from './textContext';
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
  return GameTextAssets.fromData(index, objects, load('assets/materials.json'), load('assets/texts.json'), load<{ fontAssets: Record<string, string> }>('assets/glyphs.json').fontAssets, {});
}

/** 檢視頁的 TextContextEnv（level1 攝影機是正交、專案 linear） */
const ENV: TextContextEnv = { orthographic: true, linearColorSpace: true };

let assets: GameTextAssets;
beforeAll(async () => {
  assets = makeAssets();
  const index = load<Record<string, { kind: string | null }>>('assets/monobehaviours.json');
  await assets.prepare(Object.entries(index).filter(([, m]) => m.kind === 'TMP_FontAsset').map(([g]) => g), (f) => Promise.resolve(load(`assets/glyphs/${f}`)));
});

describe('共用 TextContext：PLAY（level1 元件 1104）', () => {
  it('產生 0d 驗收 4 的 ctx', () => {
    const file = load<SceneFile>('scenes/level1.json');
    // 檢視頁的流程：在地化（en）→ SceneGraph → layoutWithUI 接 makePreferredExternal
    const loc = Localization.fromData(
      load<LocalizationSettings>('localization/settings.json'),
      load('localization/tables.json'),
      { en: load('data/i18n/en.json'), 'zh-Hans': load('data/i18n/zh-Hans.json') },
      { en: {}, 'zh-Hans': {} },
      'en',
    );
    applyLocalization(file, loc);
    const graph = new SceneGraph(file);
    layoutWithUI(graph, 1920, 1080, { external: makePreferredExternal(assets, ENV) });
    const comp = file.components['1104'];
    const node = graph.nodeOfComponent('1104')!;
    expect(node).toBeTruthy();
    const ctx = textContextOf(node, comp, ENV);
    expect(ctx.rect.x).toBeCloseTo(-143, 6);
    expect(ctx.rect.y).toBeCloseTo(-28.5, 6);
    expect(ctx.rect.width).toBeCloseTo(286, 6);
    expect(ctx.rect.height).toBeCloseTo(57, 6);
    expect(ctx.lossyScaleY).toBeCloseTo(0.01, 10);
    expect(ctx.canvas).not.toBeNull();
    expect(ctx.canvas!.renderMode).toBe(1);
    expect(ctx.canvas!.scaleFactor).toBeCloseTo(1, 10);
    expect(ctx.canvas!.worldCameraAssigned).toBe(true);
    expect(ctx.isOrthographic).toBe(true);
    expect(ctx.linearColorSpace).toBe(true);
  });
});

describe('ContentSizeFitter 驅動的 TMP 文字框（存檔非 0 的軸）', () => {
  it('5 軸全部與 Unity 存檔的 m_SizeDelta 相符（±0.011）', () => {
    const files = [
      'scenes/level0.json',
      'scenes/level1.json',
      'scenes/level2.json',
      ...readdirSync(resolve(GAME, 'scenes/prefabs')).filter((f) => f.endsWith('.json')).map((f) => `scenes/prefabs/${f}`),
    ];
    const rows: string[] = [];
    let total = 0;
    let match = 0;
    for (const path of files) {
      const file = load<SceneFile>(path);
      const saved = JSON.parse(JSON.stringify(file)) as SceneFile;
      const graph = new SceneGraph(file);
      layoutWithUI(graph, 1920, 1080, { external: makePreferredExternal(assets, ENV) });
      for (const node of graph.nodes.values()) {
        const comps = graph.components(node);
        const csf = comps.find((c) => c.script?.class === 'ContentSizeFitter');
        const tmp = comps.find((c) => c.script?.class === 'TextMeshProUGUI');
        const rt = comps.find((c) => c.type === 'RectTransform');
        if (!csf || !tmp || !rt) continue;
        const cid = Object.entries(file.components).find(([, v]) => v === rt)![0];
        const rtSaved = saved.components[cid];
        for (const axis of [0, 1] as const) {
          const fit = axis === 0 ? csf.m_HorizontalFit : csf.m_VerticalFit;
          if (fit !== 2) continue;
          const amin = (rtSaved.m_AnchorMin as { x: number; y: number })[axis ? 'y' : 'x'];
          const amax = (rtSaved.m_AnchorMax as { x: number; y: number })[axis ? 'y' : 'x'];
          if (amin !== amax) continue; // 拉伸錨點的 rect 不是 sizeDelta 直接決定，csf-sim 同樣跳過
          const want = (rtSaved.m_SizeDelta as { x: number; y: number })[axis ? 'y' : 'x'];
          if (want === 0) continue; // 被驅動的值存檔時清成 0，不可用（106 軸中 101 軸）
          // 停用的物件 layout 不算（10/17），照腳本讀 rect 的方式沿父物件鏈算
          graph.refreshChain(node, 1920, 1080);
          const got = axis === 0 ? node.rect.width : node.rect.height;
          total++;
          const ok = Math.abs(got - want) <= 0.011;
          if (ok) match++;
          rows.push(`${ok ? 'v' : 'x'} ${path.replace('scenes/', '')} ${node.go.m_Name} ${axis ? 'h' : 'w'} got=${got.toFixed(3)} saved=${want}`);
        }
      }
    }
    console.log(`CSF 存檔非 0 的軸：${total}，相符 ${match}\n${rows.join('\n')}`);
    expect(total).toBe(5); // csf-sim 的基準；變了要先核對資料來源
    expect(match).toBe(5);
  });
});

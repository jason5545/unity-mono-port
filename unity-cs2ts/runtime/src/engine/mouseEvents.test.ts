// 舊版滑鼠事件（mouseEvents.ts）對「已銷毀目標」的處理。用 level1 真資料，寫法照 unity/instantiate.test.ts。
// 原本的 bug：命中的物件（lastHit／mouseDownHit）被 destroy 之後，下一格送 OnMouseExit 會走進
// sendMessage，讀到 file.components 已經刪掉的元件，comp.m_Enabled 丟 TypeError。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClipAsset, ControllerAsset } from './animator';
import { World } from './world';
import { applyLocalization, Localization, type LocalizationSettings } from '../localization/localization';
import { SceneGraph } from '../unity/scene';
import type { SceneFile } from '../unity/types';
import { destroy, instantiate } from '../unity/instantiate';
import { UI_BEHAVIOURS } from '../ui/selectable';
import { isLiveNode, liveHit, type HitInfo } from './mouseEvents';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

/** Language Dropdown 的 Template（存檔裡未啟用的物件，複製它不需要任何 UI 狀態） */
const TEMPLATE_GO = '384';

function setup() {
  const loc = Localization.fromData(
    load<LocalizationSettings>('localization/settings.json'),
    load('localization/tables.json'),
    { en: load('data/i18n/en.json'), 'zh-Hans': load('data/i18n/zh-Hans.json') },
    { en: load('localization/assets/en.json') },
    'en',
  );
  const file = load<SceneFile>('scenes/level1.json');
  applyLocalization(file, loc);
  const graph = new SceneGraph(file);
  const world = new World(graph, {
    localization: loc,
    version: load<{ gameVersion: string }>('data/manifest.json').gameVersion,
    controllers: load<Record<string, ControllerAsset>>('assets/animators.json'),
    clips: load<Record<string, ClipAsset>>('assets/animations.json'),
    registry: { ...UI_BEHAVIOURS },
    layout: {},
    sortingLayerIndex: () => 0,
  });
  world.screen = { w: 1920, h: 1080 };
  world.events.screenSize = { w: 1920, h: 1080 };
  world.start();
  world.relayout();
  const template = graph.nodes.get(TEMPLATE_GO)!;
  return { world, graph, template };
}

describe('mouseEvents：已銷毀的目標視同沒命中', () => {
  it('destroy 之前活著，destroy 之後 isLiveNode 為 false，liveHit 回傳沒命中', () => {
    const s = setup();
    const clone = instantiate(s.world, s.template, s.template.parent);
    expect(isLiveNode(s.world, clone)).toBe(true);
    expect(s.graph.nodes.get(clone.id)).toBe(clone);
    destroy(s.world, clone);
    expect(isLiveNode(s.world, clone)).toBe(false);
    expect(liveHit(s.world, { target: clone, camera: null })).toEqual({ target: null, camera: null });
  });

  it('lastHit／mouseDownHit 還留著已銷毀的目標，下一格派送不丟錯、也不送任何訊息', () => {
    const s = setup();
    const clone = instantiate(s.world, s.template, s.template.parent);
    // 模擬上一格命中了 clone：lastHit／mouseDownHit 是私有欄位，測試用 cast 直接寫
    const dispatcher = s.world.mouseEvents as unknown as { lastHit: HitInfo[]; mouseDownHit: HitInfo[] };
    dispatcher.lastHit[2] = { target: clone, camera: null };
    dispatcher.mouseDownHit[2] = { target: clone, camera: null };
    destroy(s.world, clone);
    // 滑鼠移到畫面外：這一格沒有任何命中，只剩 lastHit 那筆要處理
    s.world.mouse.x = -10000;
    s.world.mouse.y = -10000;
    expect(() => s.world.mouseEvents.send()).not.toThrow();
    expect(s.world.mouseEvents.lastDispatch).toEqual([]);
  });
});

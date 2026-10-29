// 驗收 1：執行時期從 prefab 檔生物件（unity/prefab.ts spawnPrefab）的單元測試。
// 用真資料：Card_Template（75f40fbf59e4b334586e2cd684479116.json，32 個物件，無巢狀 prefab）生進 level1。
// 逐條對照 prompt 驗收 1：節點數、id 唯一、ScrollRect 的 m_Content／m_Viewport／m_VerticalScrollbar
// 指向「自己那一份」、外部素材引用不動、來源資料不被改到、destroy 整份清乾淨、找不到名稱丟具名錯誤。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { World } from '../engine/world';
import { Localization, type LocalizationSettings } from '../localization/localization';
import { SceneGraph, type SceneNode } from './scene';
import type { ComponentData, SceneFile } from './types';
import { destroy } from './instantiate';
import { PrefabNotFoundError, PrefabSource, spawnPrefab } from './prefab';
import { UI_BEHAVIOURS } from '../ui/selectable';
import { SLIDER_BEHAVIOURS } from '../ui/slider';
import { TOGGLE_BEHAVIOURS } from '../ui/toggle';
import { SCROLLRECT_BEHAVIOURS } from '../ui/scrollRect';
import { SCROLLBAR_BEHAVIOURS } from '../ui/scrollbar';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

const CARD_GUID = '75f40fbf59e4b334586e2cd684479116';
/** prefab 檔裡（重新編號前）的 Description RectTransform／RectMask RectTransform／Scrollbar 元件 id */
const PREFAB_CONTENT_RT = '224397768327470545';
const PREFAB_VIEWPORT_RT = '224693329660128220';
const PREFAB_SCROLLBAR = '114215879266689626';
const DEFAULT_TEXT = '1\n2\n3\n4\n5<sprite name="coin">1\n2\n3\n4\n5<sprite name="coin">1\n2\n3\n4\n5<sprite name="coin">';

function setup() {
  const loc = Localization.fromData(
    load<LocalizationSettings>('localization/settings.json'),
    load('localization/tables.json'),
    { en: load('data/i18n/en.json') },
    { en: load('localization/assets/en.json') },
    'en',
  );
  const file = load<SceneFile>('scenes/level1.json');
  const graph = new SceneGraph(file);
  const world = new World(graph, {
    localization: loc,
    version: 'test',
    controllers: {},
    clips: {},
    registry: { ...UI_BEHAVIOURS, ...SLIDER_BEHAVIOURS, ...TOGGLE_BEHAVIOURS, ...SCROLLRECT_BEHAVIOURS, ...SCROLLBAR_BEHAVIOURS },
    layout: { spriteOf: () => null, external: null },
    sortingLayerIndex: () => 0,
  });
  world.screen = { w: 1920, h: 1080 };
  world.start();
  return { world, graph, file };
}

function findInChildren(root: SceneNode, name: string): SceneNode {
  const stack = [...root.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.go.m_Name === name) return n;
    stack.push(...n.children);
  }
  throw new Error(`${root.go.m_Name} 子樹找不到 ${name}`);
}

function compOf(graph: SceneGraph, n: SceneNode, kind: string): ComponentData {
  const c = graph.component(n, kind);
  if (!c) throw new Error(`${n.go.m_Name} 沒有 ${kind}`);
  return c;
}

function subtreeIds(n: SceneNode, out = new Set<string>()): Set<string> {
  out.add(n.id);
  for (const c of n.children) subtreeIds(c, out);
  return out;
}

describe('spawnPrefab（Object.Instantiate(prefab)）', () => {
  const prefab = () => load<SceneFile>(`scenes/prefabs/${CARD_GUID}.json`);

  it('生一份：場景節點數 +32，新 id 跟場景與 prefab 檔的都不重複', () => {
    const { world, graph, file } = setup();
    const data = prefab();
    const before = graph.nodes.size;
    const goBefore = Object.keys(file.gameObjects).length;
    const compBefore = Object.keys(file.components).length;
    const sceneIdsBefore = new Set([...Object.keys(file.gameObjects), ...Object.keys(file.components)]);
    const prefabIds = new Set([...Object.keys(data.gameObjects), ...Object.keys(data.components)]);
    const root = spawnPrefab(world, data, null);
    expect(graph.nodes.size).toBe(before + 32);
    expect(Object.keys(file.gameObjects).length).toBe(goBefore + 32);
    expect(Object.keys(file.components).length).toBe(compBefore + Object.keys(data.components).length);
    const made = subtreeIds(root);
    expect(made.size).toBe(32);
    for (const id of made) {
      expect(sceneIdsBefore.has(id)).toBe(false);
      expect(prefabIds.has(id)).toBe(false);
    }
  });

  it('生兩份：第二份 ScrollRect 的 m_Content／m_Viewport／m_VerticalScrollbar 指向自己那一份', () => {
    const { world, graph } = setup();
    const data = prefab();
    const first = spawnPrefab(world, data, null);
    const second = spawnPrefab(world, data, null);
    const sr = compOf(graph, findInChildren(second, 'RectMask'), 'ScrollRect') as unknown as Record<string, { fileID: string }>;
    const targets: [string, SceneNode, string][] = [
      ['m_Content', graph.nodeOfComponent(sr.m_Content.fileID)!, PREFAB_CONTENT_RT],
      ['m_Viewport', graph.nodeOfComponent(sr.m_Viewport.fileID)!, PREFAB_VIEWPORT_RT],
      ['m_VerticalScrollbar', graph.nodeOfComponent(sr.m_VerticalScrollbar.fileID)!, PREFAB_SCROLLBAR],
    ];
    for (const [field, node, oldId] of targets) {
      expect(node, field).toBeTruthy();
      expect(subtreeIds(second).has(node!.id), `${field} 在第二份裡`).toBe(true);
      expect(subtreeIds(first).has(node!.id), `${field} 不是第一份`).toBe(false);
      expect(oldId).not.toBe(node!.id);
      const refId = sr[field].fileID;
      expect([PREFAB_CONTENT_RT, PREFAB_VIEWPORT_RT, PREFAB_SCROLLBAR]).not.toContain(refId);
    }
    expect(targets[0][1]!.go.m_Name).toBe('Description');
    expect(targets[1][1]!.go.m_Name).toBe('RectMask');
    expect(targets[2][1]!.go.m_Name).toBe('Scrollbar');
  });

  it('外部引用不變：SpriteRenderer 的 m_Sprite 與 TMP 的 m_fontAsset {guid,fileID} 跟 prefab 檔完全相同', () => {
    const { world, graph } = setup();
    const data = prefab();
    const root = spawnPrefab(world, data, null);
    const card = findInChildren(root, 'Card');
    const principle = findInChildren(card, 'CardPrinciple');
    const sprite = compOf(graph, principle, 'SpriteRenderer').m_Sprite as { guid: string; fileID: string };
    const srcPrincipleGo = Object.keys(data.gameObjects).find((g) => data.gameObjects[g].m_Name === 'CardPrinciple')!;
    const srcSrId = data.gameObjects[srcPrincipleGo].components.find((cid) => (data.components[cid].script?.class ?? data.components[cid].type) === 'SpriteRenderer')!;
    expect(sprite).toEqual(data.components[srcSrId].m_Sprite);
    const nameText = findInChildren(card, 'CardNameText');
    const font = compOf(graph, nameText, 'TextMeshPro').m_fontAsset as { guid: string; fileID: string };
    expect(font.guid).toBe('f7e314a50ab19a849b3cde5fc51294a1');
    expect(font.fileID).toBe('11400000');
  });

  it('第一份改文字不髒來源：第二份仍是 prefab 原文，讀進來的資料沒被改', () => {
    const { world, graph } = setup();
    const data = prefab();
    const pristine = JSON.stringify(data);
    const first = spawnPrefab(world, data, null);
    const firstDesc = findInChildren(first, 'Description');
    (compOf(graph, firstDesc, 'TextMeshProUGUI') as unknown as Record<string, unknown>).m_text = '改過的文字';
    (firstDesc.transform as unknown as { m_LocalPosition: { x: number } }).m_LocalPosition.x = 123;
    const second = spawnPrefab(world, data, null);
    const secondDesc = findInChildren(second, 'Description');
    expect(compOf(graph, secondDesc, 'TextMeshProUGUI').m_text).toBe(DEFAULT_TEXT);
    expect((secondDesc.transform as unknown as { m_LocalPosition: { x: number } }).m_LocalPosition.x).toBe(0);
    expect(JSON.stringify(data)).toBe(pristine);
  });

  it('destroy 第一份：節點數減 32、RectMask2D 登錄清掉，第二份不受影響', () => {
    const { world, graph } = setup();
    const data = prefab();
    const first = spawnPrefab(world, data, null);
    const second = spawnPrefab(world, data, null);
    const firstDesc = findInChildren(first, 'Description');
    // prefab 存檔裡 Card_Template 的 RectMask2D／ScrollRect／ContentSizeFitter 都是 m_Enabled 0
    //（說明框的裁切與捲動是執行期才開的），先啟用再驗登錄與銷毀清乾淨
    for (const [name, kind] of [['RectMask', 'RectMask2D'], ['RectMask', 'ScrollRect'], ['Description', 'ContentSizeFitter']] as const) {
      (compOf(graph, findInChildren(first, name), kind) as unknown as Record<string, number>).m_Enabled = 1;
    }
    for (const [name, kind] of [['RectMask', 'RectMask2D'], ['RectMask', 'ScrollRect'], ['Description', 'ContentSizeFitter']] as const) {
      (compOf(graph, findInChildren(second, name), kind) as unknown as Record<string, number>).m_Enabled = 1;
    }
    world.relayout(); // cullAll 產生裁切登錄（Description 掛勾 RectMask），才驗證 destroy 拔得乾淨
    expect(world.clips.clipOf(firstDesc.id)).not.toBeNull();
    const before = graph.nodes.size;
    destroy(world, first);
    expect(graph.nodes.size).toBe(before - 32);
    expect(graph.nodes.get(firstDesc.id)).toBeUndefined();
    expect(world.clips.clipOf(firstDesc.id)).toBeNull();
    expect(world.clips.isCulled(firstDesc.id)).toBe(false);
    const secondDesc = findInChildren(second, 'Description');
    expect(graph.nodes.has(secondDesc.id)).toBe(true);
    expect(world.clips.clipOf(secondDesc.id)).not.toBeNull(); // 第二份的登錄不受影響
    expect(findInChildren(second, 'Card').go.m_Name).toBe('Card');
    for (const id of subtreeIds(first)) {
      expect(graph.file.gameObjects[id]).toBeUndefined();
      expect(graph.file.components[id]).toBeUndefined();
    }
  });

  it('找不到 prefab 名稱：PrefabSource.entry 丟 PrefabNotFoundError', () => {
    const source = new PrefabSource({ [CARD_GUID]: { file: `scenes/prefabs/${CARD_GUID}.json`, name: 'Card_Template', src: 'x', roots: 1, counts: {} } }, './game/');
    expect(source.entry('Card_Template').file).toContain(CARD_GUID);
    expect(source.entry(CARD_GUID).name).toBe('Card_Template');
    expect(() => source.entry('NoSuchPrefab')).toThrow(PrefabNotFoundError);
  });

  it('整棵子樹都建 behaviour：registry 有 factory 的元件逐個有 behaviour（含停用的 ScrollRect、啟用的 Scrollbar）', () => {
    const { world, graph } = setup();
    const data = prefab();
    const root = spawnPrefab(world, data, null);
    // 逐個元件比對：子樹裡凡 registry 註冊了 factory 的元件都必須已經有 behaviour（含 m_Enabled 0 的）。
    // 反例：spawnPrefab 若只對 [root] 跑 startBehaviours，子物件（Scrollbar／RectMask 的 ScrollRect）就不會有。
    const checked: string[] = [];
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      for (const c of graph.components(n)) {
        const cls = c.script?.class;
        if (!cls || !world.services.registry[cls]) continue;
        expect(world.behaviours.has(c), `${n.go.m_Name}/${cls}`).toBe(true);
        checked.push(`${n.go.m_Name}/${cls}`);
      }
      stack.push(...n.children);
    }
    // 停用的 ScrollRect（RectMask 上，m_Enabled 0）與啟用中的 Scrollbar（m_Enabled 1）都要有 behaviour
    const scrollRect = compOf(graph, findInChildren(root, 'RectMask'), 'ScrollRect');
    expect(scrollRect.m_Enabled).toBe(0);
    expect(world.behaviours.has(scrollRect)).toBe(true);
    expect(checked).toContain('RectMask/ScrollRect');
    const scrollbar = compOf(graph, findInChildren(root, 'Scrollbar'), 'Scrollbar');
    expect(scrollbar.m_Enabled).not.toBe(0);
    expect(world.behaviours.has(scrollbar)).toBe(true);
    expect(checked).toContain('Scrollbar/Scrollbar');
    expect(checked.length).toBeGreaterThan(0);
  });
});

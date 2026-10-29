// 執行時期物件複製（unity/instantiate.ts）的測試。用 level1 真資料：
// SettingCanvasMainMenu/SettingPanel/SettingCards/Game/Language/Dropdown 的 Template 子樹
//（物件 384，底下 Viewport 282 → Content 184 → Item 280 → Item Background 371／Item Checkmark 170／Item Label 352，共 7 個物件）。
// Item 的 Toggle（元件 1305）的 m_Graphic 指 Item Checkmark 的 Image（元件 1405）——複製後要指到複製出來的那一份，
// 這是「子樹內部 PPtr 重映射、外部參照不動」最直接的一條。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClipAsset, ControllerAsset } from '../engine/animator';
import { World } from '../engine/world';
import { applyLocalization, Localization, type LocalizationSettings } from '../localization/localization';
import { SceneGraph, type SceneNode } from './scene';
import type { ComponentData, RectTransformData, SceneFile, TransformData } from './types';
import { addComponent, createGameObject, destroy, instantiate, setParent } from './instantiate';
import { UI_BEHAVIOURS } from '../ui/selectable';
import { TOGGLE_BEHAVIOURS, type ToggleBehaviour } from '../ui/toggle';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

/** Language Dropdown 的 Template（存檔裡未啟用，TMP_Dropdown.Show 才 SetActive(true) 後複製） */
const TEMPLATE_GO = '384';
const ITEM_TOGGLE_COMP = '1305';
const ITEM_CHECKMARK_IMAGE_COMP = '1405';

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
    registry: { ...UI_BEHAVIOURS, ...TOGGLE_BEHAVIOURS },
    layout: {},
    sortingLayerIndex: () => 0,
  });
  world.screen = { w: 1920, h: 1080 };
  world.events.screenSize = { w: 1920, h: 1080 };
  const before = { nodes: graph.nodes.size, gameObjects: Object.keys(file.gameObjects).length, components: Object.keys(file.components).length };
  world.start();
  world.relayout();
  const template = graph.nodes.get(TEMPLATE_GO)!;
  return { world, graph, file, template, before };
}

function subtreeCount(n: SceneNode): number {
  return 1 + n.children.reduce((s, c) => s + subtreeCount(c), 0);
}

describe('instantiate（Object.Instantiate）', () => {
  it('複製一棵子樹：節點數增加子樹大小，資料也進場景檔', () => {
    const s = setup();
    const n = subtreeCount(s.template);
    expect(n).toBe(7); // Template、Viewport、Content、Item、Item Background、Item Checkmark、Item Label
    const clone = instantiate(s.world, s.template, s.template.parent);
    expect(s.graph.nodes.size).toBe(s.before.nodes + n);
    expect(Object.keys(s.file.gameObjects).length).toBe(s.before.gameObjects + n);
    expect(clone.id).not.toBe(s.template.id);
    expect(clone.go.m_Name).toBe(s.template.go.m_Name);
    expect(clone.parent).toBe(s.template.parent);
    // 子樹形狀照原樣複製
    expect(subtreeCount(clone)).toBe(n);
    expect(clone.children.map((c) => c.go.m_Name)).toEqual(s.template.children.map((c) => c.go.m_Name));
  });

  it('子樹內部的 PPtr 重映射到複製出來的那一份；外部素材參照不動', () => {
    const s = setup();
    const clone = instantiate(s.world, s.template, s.template.parent);
    // 原本的 Toggle.m_Graphic 指 Item Checkmark 的 Image（1405）
    const origToggle = s.file.components[ITEM_TOGGLE_COMP];
    expect((origToggle.graphic as { fileID: string }).fileID).toBe(ITEM_CHECKMARK_IMAGE_COMP);

    // 複製出來的 Item 上那個 Toggle：graphic 不可以還指 1405，要指複製出來的 Image，
    // 而那個 Image 要在複製出來的子樹裡（不是原本那棵）
    const cloneIds = new Set<string>();
    const walk = (n: SceneNode): void => {
      cloneIds.add(n.id);
      for (const c of n.go.components) cloneIds.add(c);
      for (const ch of n.children) walk(ch);
    };
    walk(clone);
    const cloneToggle = [...cloneIds].map((id) => s.file.components[id]).find((c) => c?.script?.class === 'Toggle')!;
    expect(cloneToggle).toBeDefined();
    const gRef = cloneToggle.graphic as { fileID: string; guid?: string };
    expect(gRef.fileID).not.toBe(ITEM_CHECKMARK_IMAGE_COMP);
    expect(cloneIds.has(gRef.fileID)).toBe(true);
    expect(s.file.components[gRef.fileID].script?.class).toBe('Image');

    // 外部素材（sprite 的 {guid, fileID}）不可以被動：複製前後同一個 guid
    const origImage = s.file.components[ITEM_CHECKMARK_IMAGE_COMP];
    const cloneImage = s.file.components[gRef.fileID];
    expect(cloneImage.m_Sprite).toEqual(origImage.m_Sprite);
    expect((cloneImage.m_Sprite as { guid: string }).guid).toBeTruthy();
  });

  it('複製出來的元件照 World.start() 的順序建 behaviour，Toggle 可以用', () => {
    const s = setup();
    const clone = instantiate(s.world, s.template, s.template.parent);
    const cloneComps: ComponentData[] = [];
    const walk = (n: SceneNode): void => {
      for (const c of s.graph.components(n)) cloneComps.push(c);
      for (const ch of n.children) walk(ch);
    };
    walk(clone);
    const toggleComp = cloneComps.find((c) => c.script?.class === 'Toggle')!;
    const toggle = s.world.behaviour<ToggleBehaviour>(toggleComp)!;
    expect(toggle).toBeDefined();
    // 複製出來的 Toggle 與原本那個是兩份獨立的 behaviour
    expect(toggle).not.toBe(s.world.behaviour(s.file.components[ITEM_TOGGLE_COMP]));
    let fired = -1;
    toggle.addListener((v) => (fired = v ? 1 : 0));
    toggle.setIsOnWithoutNotify(true);
    expect(toggle.isOn).toBe(true);
    expect(fired).toBe(-1); // SetIsOnWithoutNotify 不觸發事件（Toggle.cs:132-135）
    toggle.isOn = false;
    expect(fired).toBe(0);
  });

  it('destroy 之後節點數與場景資料回到複製前，behaviour 也清掉', () => {
    const s = setup();
    const clone = instantiate(s.world, s.template, s.template.parent);
    const cloneComps: ComponentData[] = [];
    const walk = (n: SceneNode): void => {
      for (const c of s.graph.components(n)) cloneComps.push(c);
      for (const ch of n.children) walk(ch);
    };
    walk(clone);
    const behavioursBefore = s.world.behaviours.size;
    const clonedWithBehaviour = cloneComps.filter((c) => s.world.behaviours.has(c)).length;
    expect(clonedWithBehaviour).toBeGreaterThan(0);

    destroy(s.world, clone);
    expect(s.graph.nodes.size).toBe(s.before.nodes);
    expect(Object.keys(s.file.gameObjects).length).toBe(s.before.gameObjects);
    expect(Object.keys(s.file.components).length).toBe(s.before.components);
    expect(s.world.behaviours.size).toBe(behavioursBefore - clonedWithBehaviour);
    for (const c of cloneComps) expect(s.world.behaviours.has(c)).toBe(false);
    // 原本那棵子樹不受影響
    expect(s.graph.nodes.get(TEMPLATE_GO)).toBe(s.template);
    expect(subtreeCount(s.template)).toBe(7);
    // 父物件的子清單沒有殘留
    expect(s.template.parent!.go.children).not.toContain(clone.id);
    const ptf = s.template.parent!.transform as TransformData;
    expect(ptf.m_Children.some((c) => c?.fileID === s.template.go.transform)).toBe(true);
  });

  it('addComponent：把元件加進既有物件（TMP_Dropdown.SetupTemplate 加 DropdownItem 用）', () => {
    const s = setup();
    const item = s.graph.nodes.get('280')!; // Template/Viewport/Content/Item
    const before = item.go.components.length;
    const comp = addComponent(s.world, item, {
      type: 'MonoBehaviour',
      classID: 114,
      gameObject: '',
      m_Enabled: 1,
      script: { assembly: 'Unity.TextMeshPro', namespace: 'TMPro', class: 'DropdownItem' },
      m_Text: { fileID: '1126' },
      m_Toggle: { fileID: ITEM_TOGGLE_COMP },
    } as ComponentData);
    expect(item.go.components.length).toBe(before + 1);
    expect(item.go.components).toContain(Object.keys(s.file.components).find((k) => s.file.components[k] === comp));
    expect(comp.gameObject).toBe(item.id); // gameObject 由 addComponent 填，傳入的值不算
    expect(s.graph.component(item, 'DropdownItem')).toBe(comp);
  });

  it('createGameObject：程式建的物件（CreateBlocker 用）接進樹裡、有 rect 與世界矩陣', () => {
    const s = setup();
    const rootCanvas = s.graph.nodes.get('335')!; // SettingCanvasMainMenu（World Space 根 Canvas）
    const blocker = createGameObject(s.world, 'Blocker', rootCanvas, [
      {
        type: 'RectTransform',
        classID: 224,
        gameObject: '',
        m_LocalPosition: { x: 0, y: 0, z: 0 },
        m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
        m_LocalScale: { x: 1, y: 1, z: 1 },
        m_Father: null,
        m_Children: [],
        m_AnchorMin: { x: 0, y: 0 },
        m_AnchorMax: { x: 1, y: 1 },
        m_AnchoredPosition: { x: 0, y: 0 },
        m_SizeDelta: { x: 0, y: 0 },
        m_Pivot: { x: 0.5, y: 0.5 },
      } as ComponentData,
    ]);
    expect(blocker.go.m_Name).toBe('Blocker');
    expect(blocker.parent).toBe(rootCanvas);
    expect(rootCanvas.go.children).toContain(blocker.id);
    expect(blocker.activeInHierarchy).toBe(true);
    // anchorMin 0／anchorMax 1／sizeDelta 0 ＝ 撐滿根 Canvas（CreateBlocker 的做法）
    expect(blocker.rect.width).toBeCloseTo(rootCanvas.rect.width, 3);
    expect(blocker.rect.height).toBeCloseTo(rootCanvas.rect.height, 3);
    expect(blocker.canvas?.node).toBe(rootCanvas); // 自己沒有 Canvas，沿用往上最近的
    destroy(s.world, blocker);
    expect(s.graph.nodes.size).toBe(s.before.nodes);
    expect(rootCanvas.go.children).not.toContain(blocker.id);
  });

  it('setParent(parent, false)：本地座標不動，只換父物件', () => {
    const s = setup();
    const item = s.graph.nodes.get('280')!; // Item
    const content = s.graph.nodes.get('184')!; // Content（Item 原本的父物件）
    const viewport = s.graph.nodes.get('282')!;
    const tf = item.transform as RectTransformData;
    const ap = { ...tf.m_AnchoredPosition };
    setParent(s.world, item, viewport);
    expect(item.parent).toBe(viewport);
    expect(viewport.go.children).toContain(item.id);
    expect(content.go.children).not.toContain(item.id);
    expect((item.transform as RectTransformData).m_AnchoredPosition).toEqual(ap); // worldPositionStays false
    const vtf = viewport.transform as TransformData;
    expect(vtf.m_Children.some((c) => c?.fileID === item.go.transform)).toBe(true);
    const ctf = content.transform as TransformData;
    expect(ctf.m_Children.some((c) => c?.fileID === item.go.transform)).toBe(false);
    setParent(s.world, item, content);
    expect(item.parent).toBe(content);
    expect(content.go.children).toContain(item.id);
  });
});

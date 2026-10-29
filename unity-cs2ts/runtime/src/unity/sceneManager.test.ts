// 換場景的基礎（第 3 階段第六段第 0 段，Claude Code 10/10）：World.destroyDeferred、常駐 behaviour 由別的 World 每格呼叫、
// 載入時關著的 Animator 啟用後才建 runtime。用 level1 真資料，期望值照 Unity 的語意（Destroy 在幀尾生效、Awake 中被
// Destroy 的物件不跑 Start、DontDestroyOnLoad 的物件換場景後照常 Update、Animator 在物件啟用後才開始跑）。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClipAsset, ControllerAsset } from '../engine/animator';
import { World, type Behaviour, type BehaviourRegistry } from '../engine/world';
import { SceneGraph, type SceneNode } from './scene';
import { SceneManagerService } from './sceneManager';
import type { SceneFile } from './types';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

const controllers = load<Record<string, ControllerAsset>>('assets/animators.json');
const clips = load<Record<string, ClipAsset>>('assets/animations.json');

function makeWorld(registry: BehaviourRegistry, sceneManager?: SceneManagerService) {
  const graph = new SceneGraph(load<SceneFile>('scenes/level1.json'));
  const world = new World(graph, {
    localization: undefined as never,
    version: 'test',
    controllers,
    clips,
    registry,
    layout: {},
    sortingLayerIndex: () => 0,
    sceneManager,
  });
  const node = (name: string): SceneNode | undefined => [...graph.nodes.values()].find((n) => n.go.m_Name === name);
  return { world, graph, node };
}

describe('World.destroyDeferred', () => {
  it('Awake 裡 Destroy(gameObject)：start() 結束時整個物件不在，這個物件上的 Start 不跑', () => {
    const calls: string[] = [];
    const registry: BehaviourRegistry = {
      AudioManager: ({ world, node }) => {
        world.destroyDeferred(node);
        return { start: () => calls.push('AudioManager.start') };
      },
      UtilSoundDataManager: () => ({ start: () => calls.push('UtilSoundDataManager.start') }),
    };
    const { world, node } = makeWorld(registry);
    world.start();
    expect(node('AudioManager')).toBeUndefined();
    expect(calls).toEqual(['UtilSoundDataManager.start']); // UtilSoundDataManager 在 DataManager 底下，不受影響
  });

  it('Destroy(this)：只拿掉那個元件，物件與其他元件還在', () => {
    let removed: unknown = null;
    const registry: BehaviourRegistry = {
      PlayerCommandHandler: ({ world, comp }) => {
        removed = comp;
        world.destroyDeferred(comp);
        return {};
      },
    };
    const { world, graph, node } = makeWorld(registry);
    const n = node('CommandHandler')!;
    const before = n.go.components.length;
    world.start();
    expect(node('CommandHandler')).toBe(n);
    expect(n.go.components.length).toBe(before - 1);
    expect(graph.components(n).some((c) => c.script?.class === 'PlayerCommandHandler')).toBe(false);
    expect(Object.values(graph.file.components)).not.toContain(removed);
    expect(world.behaviours.has(removed as never)).toBe(false);
  });

  it('tick 中登記的 Destroy 在那一格最後才生效', () => {
    let target: SceneNode | null = null;
    let seenDuringTick = false;
    const registry: BehaviourRegistry = {
      MainMenu: ({ world, node }) => ({
        update() {
          if (!target) {
            target = node;
            world.destroyDeferred(node);
            seenDuringTick = world.graph.nodes.get(node.id) === node;
          }
        },
      }),
    };
    const { world } = makeWorld(registry);
    world.start();
    world.tick(1 / 60);
    expect(seenDuringTick).toBe(true);
    expect(world.graph.nodes.get(target!.id)).toBeUndefined();
  });
});

describe('DontDestroyOnLoad', () => {
  it('第二個場景的同類 Awake 看得到常駐實例並自砍；常駐 behaviour 由第二個場景每格呼叫，原場景不重複', () => {
    const sm = new SceneManagerService(new URLSearchParams(), async () => {});
    let updates = 0;
    const registry: BehaviourRegistry = {
      AudioManager: ({ world, node }) => {
        if (sm.persistent('AudioManager')) {
          world.destroyDeferred(node);
          return {};
        }
        const self: Behaviour = { update: () => void updates++ };
        sm.dontDestroyOnLoad('AudioManager', self, world);
        return self;
      },
    };
    const a = makeWorld(registry, sm);
    a.world.start();
    a.world.tick(1 / 60); // 原場景：自己的 behaviour 照常 update 一次
    expect(updates).toBe(1);
    const b = makeWorld(registry, sm);
    b.world.start();
    expect(b.node('AudioManager')).toBeUndefined(); // 第二份在 Awake 自砍
    expect(sm.persistentFor(a.world)).toEqual([]);
    expect(sm.persistentFor(b.world)).toHaveLength(1);
    b.world.tick(1 / 60); // 新場景替常駐物件呼叫 update
    expect(updates).toBe(2);
    expect(() => sm.dontDestroyOnLoad('AudioManager', {}, b.world)).toThrow();
  });
});

describe('載入時關著的 Animator', () => {
  it('LevelLoader 的 loadingIcon（OnLoadingAnimation）：關著時沒有 runtime，啟用後第一次 tick 才建', () => {
    const { world, graph, node } = makeWorld({});
    world.start();
    const icon = node('OnLoadingAnimation')!;
    expect(icon.activeInHierarchy).toBe(false);
    const has = () => world.animators.some((a) => a.node === icon);
    expect(has()).toBe(false);
    world.tick(1 / 60);
    expect(has()).toBe(false);
    graph.setActive(icon, true);
    expect(has()).toBe(false); // SetActive 當下不建（Unity：下一次 Update 才開始跑）
    world.tick(1 / 60);
    expect(has()).toBe(true);
    const count = world.animators.length;
    graph.setActive(icon, false);
    world.tick(1 / 60);
    graph.setActive(icon, true);
    world.tick(1 / 60);
    expect(world.animators.length).toBe(count); // 已經建過的不重建
  });
});

// OnDestroy（2026/10/17）：Object.Destroy 與場景卸載時，OnDisable 之後叫；只對跑過 Awake 的；回呼期間物件還沒算銷毀。
// 以前執行環境完全沒有 OnDestroy，MT2 的 UIScreen 不會 UnregisterScreen，場景卸載後 ScreenManager 拿著銷毀的畫面丟例外。
import { describe, expect, it } from 'vitest';
import { World, type Behaviour, type BehaviourRegistry } from './world';
import { SceneGraph } from '../unity/scene';
import { destroy, destroyedObjects } from '../unity/instantiate';
import type { ComponentData, GameObjectData, SceneFile } from '../unity/types';

const T = (go: string, parent: string | null = null) => ({ type: 'Transform', classID: 4, gameObject: go, m_LocalPosition: { x: 0, y: 0, z: 0 }, m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 }, m_LocalScale: { x: 1, y: 1, z: 1 }, m_Father: parent, m_Children: [] });
const GO = (name: string, transform: string, components: string[], children: string[] = [], parent: string | null = null, active = 1): GameObjectData => ({
  m_Name: name, m_IsActive: active, m_Layer: 0, m_TagString: 'Untagged', transform, parent, children, components: [transform, ...components],
});
const mb = (go: string, cls: string): ComponentData => ({ type: 'MonoBehaviour', classID: 114, gameObject: go, m_Enabled: 1, script: { class: cls } }) as unknown as ComponentData;

function setup() {
  const log: string[] = [];
  let aliveDuringDestroy: boolean | null = null;
  const lifecycle = (name: string, extra: Partial<Behaviour> = {}): BehaviourRegistry[string] => () => ({
    awake: () => void log.push(`${name}.awake`),
    onDisable: () => void log.push(`${name}.disable`),
    onDestroy: () => void log.push(`${name}.destroy`),
    ...extra,
  });
  let world: World;
  const registry: BehaviourRegistry = {
    // 父物件：OnDestroy 裡看自己的節點是不是已經算銷毀
    P: (ctx) => ({
      ...lifecycle('P')(ctx),
      onDestroy: () => {
        log.push('P.destroy');
        aliveDuringDestroy = !destroyedObjects.has(world.graph.nodes.get('10')!);
      },
    }),
    C: lifecycle('C'),
    // 從沒啟用過（沒跑 Awake）的物件
    X: lifecycle('X'),
  };
  const gos: Record<string, GameObjectData> = {
    '10': GO('Parent', '11', ['12'], ['20']),
    '20': GO('Child', '21', ['22'], [], '10'),
    '30': GO('Never', '31', ['32'], [], null, 0),
  };
  const file: SceneFile = {
    guid: 'g', name: 's', src: 's.unity', settings: {},
    roots: ['10', '30'],
    gameObjects: gos,
    components: { '12': mb('10', 'P'), '22': mb('20', 'C'), '32': mb('30', 'X') },
  };
  for (const [id, go] of Object.entries(gos)) file.components[go.transform] = T(id, go.parent ? gos[go.parent].transform : null) as unknown as ComponentData;
  world = new World(new SceneGraph(file), { localization: undefined as never, version: 'test', controllers: {}, clips: {}, registry, layout: {}, sortingLayerIndex: () => 0 });
  world.start();
  log.length = 0;
  return { world, log, alive: () => aliveDuringDestroy };
}

describe('OnDestroy', () => {
  it('Destroy 子樹：先全部 OnDisable，再全部 OnDestroy；回呼期間自己還沒算銷毀，之後才算', () => {
    const { world, log, alive } = setup();
    const parent = world.graph.nodes.get('10')!;
    destroy(world, parent);
    expect(log).toEqual(['P.disable', 'C.disable', 'P.destroy', 'C.destroy']);
    expect(alive()).toBe(true);
    expect(destroyedObjects.has(parent)).toBe(true);
  });
  it('沒啟用過（沒跑 Awake）的物件銷毀時不叫 OnDestroy', () => {
    const { world, log } = setup();
    destroy(world, world.graph.nodes.get('30')!);
    expect(log).toEqual([]);
  });
  it('只銷毀元件（Destroy(component)）：OnDisable 之後 OnDestroy，下一格開頭處理', () => {
    const { world, log } = setup();
    const comp = world.graph.file.components['22'];
    world.destroyDeferred(comp);
    world.tick(1 / 60);
    expect(log).toEqual(['C.disable', 'C.destroy']);
    expect(destroyedObjects.has(comp)).toBe(true);
  });
});

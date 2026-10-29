// 增量排版（SceneGraph.layout 只重算輸入有變的節點，10/15）的測試：level1、level2 真資料，隨機改 Transform／RectTransform
// （就地改欄位、整個換物件）、SetActive、換父物件、換螢幕大小，每一輪 layoutWithUI 之後跟「全部重算」比（verifyLayout），
// rect、世界矩陣、canvas 一個位元都不能差。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutWithUI, SceneGraph, type SceneNode } from './scene';
import type { RectTransformData, SceneFile } from './types';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}

/** mulberry32：測試用的可重現亂數 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(node: SceneNode, r: () => number): void {
  const tf = node.transform;
  const v = (r() - 0.5) * 200;
  switch (Math.floor(r() * 9)) {
    case 0:
      tf.m_LocalPosition.x += v; // 就地改
      break;
    case 1:
      tf.m_LocalPosition = { ...tf.m_LocalPosition, z: tf.m_LocalPosition.z + v / 100 }; // 整個換物件
      break;
    case 2:
      tf.m_LocalScale = { x: 0.5 + r(), y: 0.5 + r(), z: 1 };
      break;
    case 3: {
      const a = r() * Math.PI;
      tf.m_LocalRotation = { x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) };
      break;
    }
    default: {
      if (!node.isRect) {
        tf.m_LocalPosition.y -= v;
        break;
      }
      const rt = tf as unknown as RectTransformData;
      const k = Math.floor(r() * 5);
      if (k === 0) rt.m_AnchoredPosition = { x: rt.m_AnchoredPosition.x + v, y: rt.m_AnchoredPosition.y };
      else if (k === 1) rt.m_SizeDelta.y += v;
      else if (k === 2) rt.m_Pivot = { x: r(), y: r() };
      else if (k === 3) rt.m_AnchorMin = { x: r() * 0.5, y: rt.m_AnchorMin.y };
      else rt.m_AnchorMax.x = 0.5 + r() * 0.5;
    }
  }
}

/** instantiate.ts setParent 的場景樹部分（這裡不建 World） */
function reparent(graph: SceneGraph, node: SceneNode, parent: SceneNode): void {
  const old = node.parent!;
  old.children.splice(old.children.indexOf(node), 1);
  old.go.children.splice(old.go.children.indexOf(node.id), 1);
  node.parent = parent;
  node.go.parent = parent.id;
  parent.children.push(node);
  parent.go.children.push(node.id);
  graph.bumpStructure();
  graph.refreshHierarchy();
}

function isAncestor(a: SceneNode, b: SceneNode): boolean {
  for (let n: SceneNode | null = b; n; n = n.parent) if (n === a) return true;
  return false;
}

describe.each(['level1', 'level2'])('增量排版（%s）', (scene) => {
  it('隨機改 Transform、SetActive、換父物件、換螢幕大小：每輪都跟全部重算一樣', () => {
    const graph = new SceneGraph(load<SceneFile>(`scenes/${scene}.json`));
    let [w, h] = [1920, 1080];
    layoutWithUI(graph, w, h);
    expect(graph.verifyLayout(w, h)).toEqual([]);
    // 沒改任何東西：只有 Screen Space 的根 Canvas 重算（每次都算、算出來一樣就當沒變）
    layoutWithUI(graph, w, h);
    const roots = [...graph.nodes.values()].filter((n) => graph.isScreenRoot(n)).length;
    expect(graph.lastLayoutRecomputed).toBe(roots);

    const r = rng(scene === 'level1' ? 1 : 2);
    const nodes = [...graph.nodes.values()];
    let mutated = 0;
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 15; i++) {
        mutate(nodes[Math.floor(r() * nodes.length)], r);
        mutated++;
      }
      if (round % 5 === 2) {
        const n = nodes[Math.floor(r() * nodes.length)];
        graph.setActive(n, !n.go.m_IsActive);
      }
      if (round % 7 === 3) {
        const n = nodes[Math.floor(r() * nodes.length)];
        const p = nodes[Math.floor(r() * nodes.length)];
        if (n.parent && n !== p && !isAncestor(n, p)) reparent(graph, n, p);
      }
      if (round === 20) [w, h] = [1280, 720];
      if (round === 30) [w, h] = [2960, 1665];
      layoutWithUI(graph, w, h);
      expect(graph.verifyLayout(w, h), `第 ${round} 輪`).toEqual([]);
    }
    expect(mutated).toBe(600);
  });

  // 讀取時只沿父物件鏈算（refreshChain，10/17：MT2 戰鬥一格讀上百次 transform，以前每次整棵樹重排）。
  // 標準答案：同一份場景資料另建一個 SceneGraph（Transform 物件共用），每次全部重算。
  it('refreshChain：讀到的 rect 與世界矩陣跟全部重算一樣；之後的 layout 也跟全部重算一樣', () => {
    const file = load<SceneFile>(`scenes/${scene}.json`);
    const graph = new SceneGraph(file);
    const truth = new SceneGraph(file);
    const [w, h] = [1920, 1080];
    layoutWithUI(graph, w, h);
    const same = (n: SceneNode, what: string) => {
      truth.layout(w, h, true);
      const t = truth.nodes.get(n.id)!;
      expect([...n.world.elements], `${what} world`).toEqual([...t.world.elements]);
      if (n.isRect) expect(n.rect, `${what} rect`).toEqual(t.rect);
    };

    // Screen Space - Camera 的 Canvas：攝影機動了，讀 Canvas 底下的物件要用攝影機現在的位置（layout 是靠根的順序先算攝影機）
    const camCanvas = [...graph.nodes.values()].find((n) => graph.isScreenRoot(n) && n.canvas?.renderMode === 1 && n.children.length);
    if (camCanvas) {
      const camId = (graph.component(camCanvas, 'Canvas')!.m_Camera as { fileID: string }).fileID;
      const cam = graph.cameras.find((c) => graph.components(c.node).some((x) => x === graph.file.components[camId]))!;
      cam.node.transform.m_LocalPosition.x += 3;
      const leaf = camCanvas.children[0];
      graph.refreshChain(leaf, w, h);
      same(leaf, 'Canvas 底下');
      graph.layout(w, h);
      expect(graph.verifyLayout(w, h)).toEqual([]);
    }

    const r = rng(scene === 'level1' ? 3 : 4);
    const nodes = [...graph.nodes.values()];
    let reads = 0;
    for (let round = 0; round < 30; round++) {
      for (let i = 0; i < 10; i++) mutate(nodes[Math.floor(r() * nodes.length)], r);
      for (let k = 0; k < 8; k++) {
        const n = nodes[Math.floor(r() * nodes.length)];
        graph.refreshChain(n, w, h);
        same(n, `第 ${round} 輪 ${n.go.m_Name}`);
        reads++;
      }
      // 鏈上的祖先輸出變了，它不在鏈上的子物件要在這一次 layout 跟著重算（childrenStale）
      graph.layout(w, h);
      expect(graph.verifyLayout(w, h), `第 ${round} 輪`).toEqual([]);
    }
    expect(reads).toBe(240);
  });

  // 停用的子樹 layout 不算（10/17）：停用期間父物件動了，重新啟用後第一次 layout 要算對；停用時讀它走 refreshChain
  it('停用的子樹：layout 跳過、讀的時候算對、重新啟用後 layout 算對', () => {
    const file = load<SceneFile>(`scenes/${scene}.json`);
    const graph = new SceneGraph(file);
    const truth = new SceneGraph(file);
    const [w, h] = [1920, 1080];
    layoutWithUI(graph, w, h);
    const target = [...graph.nodes.values()].find((n) => n.activeInHierarchy && n.parent?.activeInHierarchy && n.children.some((c) => c.children.length))!;
    const grand = target.children.find((c) => c.children.length)!.children[0];
    graph.setActive(target, false);
    graph.layout(w, h);
    const parentTf = target.parent!.transform;
    parentTf.m_LocalPosition = { ...parentTf.m_LocalPosition, z: parentTf.m_LocalPosition.z + 5 };
    parentTf.m_LocalScale = { x: parentTf.m_LocalScale.x * 1.5, y: parentTf.m_LocalScale.y, z: parentTf.m_LocalScale.z };
    const before = [...target.world.elements];
    graph.layout(w, h);
    expect([...target.world.elements], '停用的不算').toEqual(before);
    expect(graph.verifyLayout(w, h)).toEqual([]);
    truth.layout(w, h, true);
    graph.refreshChain(grand, w, h);
    expect([...grand.world.elements], '停用時讀').toEqual([...truth.nodes.get(grand.id)!.world.elements]);
    graph.setActive(target, true);
    graph.layout(w, h);
    for (const n of [target, ...target.children, grand]) expect([...n.world.elements], n.go.m_Name).toEqual([...truth.nodes.get(n.id)!.world.elements]);
    expect(graph.verifyLayout(w, h)).toEqual([]);
  });

  // Instantiate／SetParent 只算那棵子樹（10/17，以前整棵樹 relayout）
  it('refreshSubtree：換父物件之後只算那棵子樹，跟全部重算一樣；之後的 layout 也一樣', () => {
    const file = load<SceneFile>(`scenes/${scene}.json`);
    const graph = new SceneGraph(file);
    const [w, h] = [1920, 1080];
    layoutWithUI(graph, w, h);
    const r = rng(scene === 'level1' ? 5 : 6);
    const nodes = [...graph.nodes.values()].filter((n) => n.activeInHierarchy);
    let moved = 0;
    for (let round = 0; round < 10; round++) {
      const n = nodes.filter((x) => x.parent && x.children.length)[Math.floor(r() * 50)];
      const p = nodes[Math.floor(r() * nodes.length)];
      if (!n || n === p || isAncestor(n, p) || n.parent === p) continue;
      reparent(graph, n, p);
      graph.refreshSubtree(n, w, h);
      moved++;
      const truth = new SceneGraph(file);
      truth.layout(w, h, true);
      const stack = [n];
      while (stack.length) {
        const x = stack.pop()!;
        if (!x.activeInHierarchy) continue;
        const t = truth.nodes.get(x.id)!;
        expect([...x.world.elements], `${x.go.m_Name} world`).toEqual([...t.world.elements]);
        if (x.isRect) expect(x.rect, `${x.go.m_Name} rect`).toEqual(t.rect);
        stack.push(...x.children);
      }
      graph.layout(w, h);
      expect(graph.verifyLayout(w, h), `第 ${round} 次`).toEqual([]);
    }
    expect(moved).toBeGreaterThan(5);
  });

  it('refreshChain 只動鏈上的節點：不在鏈上的物件改了，讀別的物件不會更新它', () => {
    const graph = new SceneGraph(load<SceneFile>(`scenes/${scene}.json`));
    const [w, h] = [1920, 1080];
    layoutWithUI(graph, w, h);
    const roots = graph.roots.filter((n) => n.children.length);
    const [a, b] = [roots[0].children[0], roots[roots.length - 1].children[0]];
    const before = [...b.world.elements];
    // z：Transform 與 RectTransform 都直接用 m_LocalPosition.z（RectTransform 的 xy 由 anchoredPosition 算）
    b.transform.m_LocalPosition = { ...b.transform.m_LocalPosition, z: b.transform.m_LocalPosition.z + 7 };
    graph.refreshChain(a, w, h);
    expect([...b.world.elements]).toEqual(before);
    graph.refreshChain(b, w, h);
    expect([...b.world.elements]).not.toEqual(before);
  });
});

// 候選清單的快取（10/17）：換父物件（bumpHierarchy）不讓「有哪種元件」的清單重建，節點或元件增減（bumpStructure）才重建
describe('SceneGraph.cached 的 membership', () => {
  it('換父物件只讓 structure 的快取失效；節點或元件增減兩種都失效', () => {
    const graph = new SceneGraph(load<SceneFile>('scenes/level1.json'));
    const builds = { s: 0, m: 0 };
    const read = () => {
      graph.cached('t.structure', () => builds.s++);
      graph.cached('t.membership', () => builds.m++, 'membership');
    };
    read();
    read();
    expect(builds).toEqual({ s: 1, m: 1 });
    graph.bumpHierarchy();
    read();
    expect(builds).toEqual({ s: 2, m: 1 });
    graph.bumpStructure();
    read();
    expect(builds).toEqual({ s: 3, m: 2 });
  });
});

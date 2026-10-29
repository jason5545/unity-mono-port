// 場景裡全部 ParticleSystem 的管理（2026/10/17）：啟用與停用、playOnAwake、每格推進、stopAction、子發射器的對應。
//
// 依據（Unity 2022.3 手冊 Main module、ParticleSystem 腳本 API）：
//   - playOnAwake：物件啟用時開始播（場景載入時已啟用的也是）。物件停用時粒子清掉、停止（再啟用照 playOnAwake 從頭播）。
//     啟用狀態的變化在 SetActive 當下處理（World.refreshEnables 會叫 syncActivation），跟 OnEnable／OnDisable 同一個時機。
//   - 子發射器（Sub Emitters module 指到的子系統）自己不發射，也不照 playOnAwake 播；由父系統的觸發驅動。
//   - 每格在排版之後推進（Unity 的粒子在 LateUpdate 前後的 PreLateUpdate／PostLateUpdate 更新；這裡放在全部腳本的 LateUpdate 之後）。dt：useUnscaledTime 用 unscaledDeltaTime，乘 simulationSpeed。
//   - stopAction（系統停下、粒子死光時）：1 Disable（物件 SetActive(false)）、2 Destroy（銷毀物件）、3 Callback
//     （對物件上的腳本 SendMessage("OnParticleSystemStopped")）。
//   - 發射器的姿態照 scalingMode（Hierarchy 0：整條父物件鏈的縮放；Local 1：只有自己的 localScale；Shape 2：只縮放發射形狀）。

import { Matrix4, Quaternion, Vector3 } from 'three';
import type { World } from '../engine/world';
import { setActive } from '../unity/instantiate';
import type { SceneNode } from '../unity/scene';
import type { ComponentData } from '../unity/types';
import { ParticleRandom } from './curves';
import { ParticleSim, type EmitterPose } from './system';

export class ParticleWorld {
  private readonly sims = new Map<ComponentData, ParticleSim>();
  private readonly active = new WeakMap<ComponentData, boolean>();
  readonly rng = new ParticleRandom(0x5eed1234);

  constructor(private readonly world: World) {}

  /** 場景裡全部的 ParticleSystem（照 nodes 的順序；只隨節點與元件增減變） */
  private all(): [SceneNode, ComponentData][] {
    const g = this.world.graph;
    return g.cached(
      'particles.systems',
      () => {
        const out: [SceneNode, ComponentData][] = [];
        for (const node of g.nodes.values()) for (const cid of node.go.components) {
          const c = g.file.components[cid];
          if (c?.type === 'ParticleSystem') out.push([node, c]);
        }
        return out;
      },
      'membership',
    );
  }

  /** 被其他系統當成子發射器的 ParticleSystem 元件 */
  private subEmitterSet(): Set<ComponentData> {
    const g = this.world.graph;
    return g.cached(
      'particles.subEmitters',
      () => {
        const out = new Set<ComponentData>();
        for (const [, c] of this.all()) {
          const sm = c.SubModule as { enabled?: number; subEmitters?: { emitter?: { fileID?: string | number } | null }[] } | undefined;
          if (sm?.enabled !== 1) continue;
          for (const s of sm.subEmitters ?? []) {
            const target = s.emitter?.fileID ? g.file.components[String(s.emitter.fileID)] : undefined;
            if (target) out.add(target);
          }
        }
        return out;
      },
      'membership',
    );
  }

  /** 元件的模擬（第一次用到才建；子發射器的對應也在這時接上） */
  simOf(comp: ComponentData): ParticleSim | null {
    let sim = this.sims.get(comp);
    if (sim) return sim;
    const node = this.world.graph.nodes.get(comp.gameObject);
    if (!node) return null;
    sim = new ParticleSim(comp, node);
    this.sims.set(comp, sim);
    this.linkSubs(sim);
    return sim;
  }

  private linkSubs(sim: ParticleSim): void {
    const g = this.world.graph;
    sim.subs = [];
    const sm = sim.comp.SubModule as { enabled?: number; subEmitters?: { emitter?: { fileID?: string | number } | null; type?: number; properties?: number; emitProbability?: number }[] } | undefined;
    if (sm?.enabled !== 1) return;
    for (const s of sm.subEmitters ?? []) {
      const target = s.emitter?.fileID ? g.file.components[String(s.emitter.fileID)] : undefined;
      if (!target || target === sim.comp) continue;
      const child = this.simOf(target);
      if (!child) continue;
      child.subEmitterOf = sim;
      sim.subs.push({ sim: child, type: s.type ?? 0, properties: s.properties ?? 0, probability: s.emitProbability ?? 1 });
    }
  }

  /**
   * 啟用狀態的變化（root 底下，null 是全部）：停用 → 清掉、停止；啟用 → playOnAwake 的開始播（子發射器除外）。
   * World.refreshEnables 叫（SetActive 當下、每格開頭）
   */
  syncActivation(root: SceneNode | null): void {
    const subs = this.subEmitterSet();
    const visit = (node: SceneNode, comp: ComponentData): void => {
      const now = node.activeInHierarchy;
      const was = this.active.get(comp) ?? false;
      if (now === was) return;
      this.active.set(comp, now);
      if (!now) {
        this.sims.get(comp)?.stop(true);
        return;
      }
      if (comp.playOnAwake === 1 && !subs.has(comp)) {
        const sim = this.simOf(comp);
        if (sim) {
          this.setPose(sim);
          sim.play(this.rng);
        }
      }
    };
    if (!root) {
      for (const [node, comp] of this.all()) visit(node, comp);
      return;
    }
    const g = this.world.graph;
    const stack = [root];
    while (stack.length) {
      const n = stack.pop()!;
      for (const cid of n.go.components) {
        const c = g.file.components[cid];
        if (c?.type === 'ParticleSystem') visit(n, c);
      }
      for (const ch of n.children) stack.push(ch);
    }
  }

  /** 發射器的姿態（照 scalingMode），設進模擬 */
  setPose(sim: ParticleSim): void {
    const node = sim.node;
    this.world.refreshTransform(node);
    const pos = new Vector3();
    const rot = new Quaternion();
    const lossy = new Vector3();
    node.world.decompose(pos, rot, lossy);
    const ls = node.transform.m_LocalScale;
    const local = new Vector3(ls.x, ls.y, ls.z);
    const mode = (sim.comp.scalingMode as number) ?? 1;
    let pose: EmitterPose;
    if (mode === 0) pose = { toWorld: node.world.clone(), position: pos, rotation: rot, sizeScale: lossy, shapeScale: null };
    else if (mode === 2) pose = { toWorld: new Matrix4().compose(pos, rot, new Vector3(1, 1, 1)), position: pos, rotation: rot, sizeScale: new Vector3(1, 1, 1), shapeScale: lossy };
    else pose = { toWorld: new Matrix4().compose(pos, rot, local), position: pos, rotation: rot, sizeScale: local, shapeScale: null };
    sim.setPose(pose);
  }

  /** 每格：啟用中的系統往前推（dt 是乘過 timeScale 的、unscaled 是沒乘的） */
  update(dt: number, unscaled: number): void {
    for (const [node, comp] of this.all()) {
      if (!node.activeInHierarchy) continue;
      const sim = this.sims.get(comp);
      if (!sim) continue;
      if (!sim.playing && !sim.isAlive()) continue;
      const prev = sim.pose?.position.clone() ?? null;
      this.setPose(sim);
      const d = (comp.useUnscaledTime === 1 ? unscaled : dt) * ((comp.simulationSpeed as number) ?? 1);
      if (prev && d > 0) sim.emitterVel.copy(sim.pose!.position).sub(prev).divideScalar(d);
      sim.step(d);
      if (!sim.playing && !sim.isAlive() && !sim.stopNotified) {
        sim.stopNotified = true;
        this.stopAction(node, comp);
      }
    }
    // 銷毀了的元件
    for (const [comp, sim] of this.sims) if (this.world.graph.nodes.get(comp.gameObject) !== sim.node) this.sims.delete(comp);
  }

  private stopAction(node: SceneNode, comp: ComponentData): void {
    const action = (comp.stopAction as number) ?? 0;
    if (action === 1) setActive(this.world, node, false);
    else if (action === 2) this.world.destroyDeferred(node);
    else if (action === 3) {
      for (const cid of node.go.components) {
        const b = this.world.behaviours.get(this.world.graph.file.components[cid]) as Record<string, unknown> | undefined;
        const fn = b?.OnParticleSystemStopped;
        if (typeof fn === 'function') this.world.guard('OnParticleSystemStopped', () => fn());
      }
    }
  }

  // ── 腳本 API（csport/unityParticles.ts） ──

  /** 自己與底下的 ParticleSystem（withChildren；GetComponentsInChildren 的順序，含停用的） */
  family(comp: ComponentData, withChildren: boolean): ComponentData[] {
    if (!withChildren) return [comp];
    const g = this.world.graph;
    const root = g.nodes.get(comp.gameObject);
    if (!root) return [comp];
    const out: ComponentData[] = [];
    const visit = (n: SceneNode): void => {
      for (const cid of n.go.components) {
        const c = g.file.components[cid];
        if (c?.type === 'ParticleSystem') out.push(c);
      }
      for (const ch of n.children) visit(ch);
    };
    visit(root);
    return out;
  }

  play(comp: ComponentData, withChildren: boolean): void {
    const subs = this.subEmitterSet();
    for (const c of this.family(comp, withChildren)) {
      const sim = this.simOf(c);
      if (!sim || !sim.node.activeInHierarchy) continue;
      this.active.set(c, true);
      if (subs.has(c) && c !== comp) continue;
      this.setPose(sim);
      sim.play(this.rng);
    }
  }
  stop(comp: ComponentData, withChildren: boolean, clear: boolean): void {
    for (const c of this.family(comp, withChildren)) this.sims.get(c)?.stop(clear);
  }
  pause(comp: ComponentData, withChildren: boolean): void {
    for (const c of this.family(comp, withChildren)) this.sims.get(c)?.pause();
  }
  clear(comp: ComponentData, withChildren: boolean): void {
    for (const c of this.family(comp, withChildren)) this.sims.get(c)?.clear();
  }
  /** Simulate(t, withChildren, restart, fixedTimeStep)：往前快轉 t 秒後暫停（手冊：Simulate 之後系統是暫停的） */
  simulate(comp: ComponentData, t: number, withChildren: boolean, restart: boolean, fixedTimeStep: boolean): void {
    for (const c of this.family(comp, withChildren)) {
      const sim = this.simOf(c);
      if (!sim) continue;
      if (restart) {
        sim.stop(true);
        sim.time = 0;
      }
      this.setPose(sim);
      if (!sim.playing) sim.play(this.rng);
      sim.paused = false;
      const step = fixedTimeStep ? 1 / 50 : t;
      let left = t;
      while (left > 1e-9) {
        const d = Math.min(step, left);
        sim.step(d);
        left -= d;
      }
      sim.paused = true;
    }
  }
  isAlive(comp: ComponentData, withChildren: boolean): boolean {
    return this.family(comp, withChildren).some((c) => this.sims.get(c)?.isAlive() ?? false);
  }
  /** 目前有的模擬（繪製端讀） */
  existing(comp: ComponentData): ParticleSim | null {
    return this.sims.get(comp) ?? null;
  }
}

// Unity 的 3D 物理（PhysX）。這個專案只有 3D 骰子用到：DiceManager.GenerateDice 生帶 Rigidbody 的骰子，
// AnimationRecorder.StartRecording（DiceUtilities/AnimationRecorder.cs:53-75）把 Physics.simulationMode 改成 Script，
// 自己呼叫 Physics.Simulate(0.03f) 50 次錄下每一格，之後只回放錄影。所以這裡只做手動推進，不做 FixedUpdate 的自動模擬
//（錄完之後骰子被 DisablePhysics 改成 kinematic，原版也不會再動）。
//
// 用 Rapier（@dimforge/rapier3d-deterministic-compat 0.21.0，Apache-2.0）代替 PhysX，軌跡跟原版不會一樣（差異記在 HANDOFF）。
// 骰子停下來之後 DiceObject.ManipulateResult 把朝上那一面的數字換成結果，所以點數照原版，只有滾的路線不同。
// 照原版資料設定的部分：
//   - 重力：ProjectSettings/DynamicsManager.asset 的 m_Gravity (0, 0, 9.81)（往畫面裡）。
//   - 剛體：Rigidbody 的 m_Mass、m_Drag、m_AngularDrag、m_UseGravity、m_IsKinematic（慣性由碰撞器形狀算，同 m_ImplicitTensor）。
//   - 碰撞器：MeshCollider 的 m_Mesh（m_Convex 1 → 凸包，0 → 三角網格）、節點的縮放；骰盤是不動的三角網格。
//   - 物理材質：PhysicMaterial 的 dynamicFriction、bounciness、frictionCombine、bounceCombine（沒指定用 PhysX 預設 0.6／0／Average）。
//     Rapier 只有一個摩擦係數，用 dynamicFriction；bounceThreshold（DynamicsManager 的 m_BounceThreshold 2）沒有對應。
//   - 睡眠：PhysX 的規則自己算（Rapier 的睡眠門檻在 JS 介面設不到）：質量正規化的動能
//     0.5·|v|² + 0.5·ω·Iω/m 低於 m_SleepThreshold（0.005）持續 0.4 秒（PhysX wakeCounter 的預設 20 × 0.02）就睡，速度歸零。
//     AnimationRecorder.CheckObjectHasStopped 要的就是速度剛好是 0。
//   - 座標：直接把 Unity 的左手座標餵給 Rapier。鏡像的物理軌跡一樣是合法的軌跡，四元數的代數也一樣，不用轉。
//   - 碰撞訊息：每一步之後照 Unity 的規則送 OnCollisionEnter（這一步開始接觸）、OnCollisionStay（之前就接觸、還在接觸）、
//     OnCollisionExit（這一步分開），兩邊有腳本的物件都送；kinematic／static 之間不送（同 Rapier 的預設碰撞類型）。

import type RapierModule from '@dimforge/rapier3d-deterministic-compat';
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ComponentData, TransformData } from '../unity/types';
import type { SceneNode } from '../unity/scene';
import { meshAssetOf } from '../unity/meshes';
import { physicMaterial } from '../unity/physicMaterials';
import type { World } from './world';

type V3 = { x: number; y: number; z: number };
type Q = { x: number; y: number; z: number; w: number };

type RAPIER = typeof RapierModule;
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace RAPIER {
  type World = RapierModule.World;
  type RigidBody = RapierModule.RigidBody;
  type Collider = RapierModule.Collider;
  type ColliderDesc = RapierModule.ColliderDesc;
  type CoefficientCombineRule = RapierModule.CoefficientCombineRule;
}
/** Rapier（WebAssembly 約 2 MB）在 initPhysics 才動態載入，不進主程式包 */
let RAPIER: RAPIER;
let ready = false;
let initing: Promise<void> | null = null;
/** Rapier 的載入與 WebAssembly 初始化（非同步；3D 骰子要用之前先做，Physics.Simulate 是同步的） */
export function initPhysics(): Promise<void> {
  initing ??= import('@dimforge/rapier3d-deterministic-compat').then(async (m) => {
    RAPIER = m.default;
    await RAPIER.init();
    ready = true;
  });
  return initing;
}
export function physicsReady(): boolean {
  return ready;
}

/** ProjectSettings/DynamicsManager.asset 的值（m_Gravity、m_SleepThreshold；10/13 對 ExportedProject 確認） */
export interface DynamicsSettings {
  gravity: V3;
  sleepThreshold: number;
}
const DEFAULT_DYNAMICS: DynamicsSettings = { gravity: { x: 0, y: 0, z: 9.81 }, sleepThreshold: 0.005 };
/** PhysX 的 wakeCounter 重設值（PxSceneDesc 預設 20 × 0.02 秒） */
const WAKE_COUNTER_RESET = 0.4;

/** Rigidbody 的執行期狀態（C# 端讀寫的屬性） */
export interface RigidbodyState {
  isKinematic: boolean;
  useGravity: boolean;
  detectCollisions: boolean;
  maxAngularVelocity: number;
  /** 還沒建 Rapier 剛體前設的速度（建好就直接寫進剛體） */
  velocity: V3;
  angularVelocity: V3;
  /** AddTorque（ForceMode.Force）累積到下一步才作用 */
  torque: V3;
  /** PhysX 的睡眠倒數 */
  wake: number;
  sleeping: boolean;
}

interface BodyEntry {
  comp: ComponentData;
  node: SceneNode;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider | null;
  state: RigidbodyState;
}
interface StaticEntry {
  comp: ComponentData;
  node: SceneNode;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export type CollisionKind = 'OnCollisionEnter' | 'OnCollisionStay' | 'OnCollisionExit';
export interface CollisionMessage {
  kind: CollisionKind;
  /** 收訊息的物件 */
  node: SceneNode;
  /** 對方碰撞器的物件（Collision.transform／gameObject） */
  other: SceneNode;
}

function nodeWorldMatrix(node: SceneNode): Matrix4 {
  if (node.isRect) return node.world.clone();
  const tf = node.transform as TransformData;
  const p = tf.m_LocalPosition;
  const q = tf.m_LocalRotation;
  const s = tf.m_LocalScale;
  const local = new Matrix4().compose(new Vector3(p.x, p.y, p.z), new Quaternion(q.x, q.y, q.z, q.w), new Vector3(s.x, s.y, s.z));
  return node.parent ? nodeWorldMatrix(node.parent).multiply(local) : local;
}
function decompose(node: SceneNode): { pos: Vector3; rot: Quaternion; scale: Vector3 } {
  const pos = new Vector3();
  const rot = new Quaternion();
  const scale = new Vector3();
  nodeWorldMatrix(node).decompose(pos, rot, scale);
  return { pos, rot, scale };
}
function writeWorld(node: SceneNode, pos: V3, rot: Q): void {
  const tf = node.transform as TransformData;
  let p = new Vector3(pos.x, pos.y, pos.z);
  let q = new Quaternion(rot.x, rot.y, rot.z, rot.w);
  if (node.parent) {
    const pm = nodeWorldMatrix(node.parent);
    const pq = new Quaternion();
    pm.decompose(new Vector3(), pq, new Vector3());
    p = p.applyMatrix4(pm.clone().invert());
    q = pq.invert().multiply(q);
  }
  tf.m_LocalPosition = { x: p.x, y: p.y, z: p.z };
  tf.m_LocalRotation = { x: q.x, y: q.y, z: q.z, w: q.w };
}

/** PhysicMaterialCombine：Average 0、Minimum 1、Multiply 2、Maximum 3 → Rapier 的 CoefficientCombineRule */
function combineRule(v: number): RAPIER.CoefficientCombineRule {
  return v === 1 ? RAPIER.CoefficientCombineRule.Min : v === 2 ? RAPIER.CoefficientCombineRule.Multiply : v === 3 ? RAPIER.CoefficientCombineRule.Max : RAPIER.CoefficientCombineRule.Average;
}

function liveActive(w: World, node: SceneNode): boolean {
  return w.graph.nodes.get(node.id) === node && node.activeInHierarchy !== false;
}

/** 一個 World 的物理場景（第一次 Physics.Simulate 時建） */
export class PhysicsScene {
  readonly rapier: RAPIER.World;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly bodies = new Map<ComponentData, BodyEntry>();
  private readonly statics = new Map<ComponentData, StaticEntry>();
  /** collider handle → 物件 */
  private readonly colliderNode = new Map<number, SceneNode>();
  /** 上一步之後仍在接觸的碰撞器對（`小 handle:大 handle`） */
  private touching = new Set<string>();
  readonly dynamics: DynamicsSettings;

  constructor(
    private readonly w: World,
    dynamics?: Partial<DynamicsSettings>,
  ) {
    if (!ready) throw new Error('Physics：Rapier 還沒初始化（initPhysics）');
    this.dynamics = { ...DEFAULT_DYNAMICS, ...dynamics };
    this.rapier = new RAPIER.World(this.dynamics.gravity);
  }

  /** Rigidbody 元件的狀態（還沒進物理場景也有：C# 在 Instantiate 之後馬上設速度） */
  stateOf(comp: ComponentData): RigidbodyState {
    return this.bodies.get(comp)?.state ?? pendingStateOf(comp);
  }

  /** Rigidbody.velocity（睡著或 kinematic 是 0，同 PhysX） */
  velocity(comp: ComponentData): V3 {
    const e = this.bodies.get(comp);
    if (!e) return { ...this.stateOf(comp).velocity };
    if (e.state.sleeping || e.state.isKinematic) return { x: 0, y: 0, z: 0 };
    const v = e.body.linvel();
    return { x: v.x, y: v.y, z: v.z };
  }
  angularVelocity(comp: ComponentData): V3 {
    const e = this.bodies.get(comp);
    if (!e) return { ...this.stateOf(comp).angularVelocity };
    if (e.state.sleeping || e.state.isKinematic) return { x: 0, y: 0, z: 0 };
    const v = e.body.angvel();
    return { x: v.x, y: v.y, z: v.z };
  }
  setVelocity(comp: ComponentData, v: V3): void {
    const s = this.stateOf(comp);
    s.velocity = { x: v.x, y: v.y, z: v.z };
    const e = this.bodies.get(comp);
    if (e && !s.isKinematic) {
      e.body.setLinvel(s.velocity, true);
      this.wakeUp(e);
    }
  }
  addTorque(comp: ComponentData, t: V3): void {
    const s = this.stateOf(comp);
    s.torque = { x: s.torque.x + t.x, y: s.torque.y + t.y, z: s.torque.z + t.z };
  }
  setKinematic(comp: ComponentData, on: boolean): void {
    const s = this.stateOf(comp);
    s.isKinematic = on;
    const e = this.bodies.get(comp);
    if (e) e.body.setBodyType(on ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true);
  }
  setUseGravity(comp: ComponentData, on: boolean): void {
    this.stateOf(comp).useGravity = on;
    this.bodies.get(comp)?.body.setGravityScale(on ? 1 : 0, true);
  }
  setDetectCollisions(comp: ComponentData, on: boolean): void {
    this.stateOf(comp).detectCollisions = on;
    this.bodies.get(comp)?.collider?.setEnabled(on);
  }

  private wakeUp(e: BodyEntry): void {
    e.state.sleeping = false;
    e.state.wake = WAKE_COUNTER_RESET;
    e.body.wakeUp();
  }

  /** 場景 → 物理：新出現的剛體與靜態碰撞器建起來，消失的拿掉，位置照場景（autoSyncTransforms 關著時 Simulate 前的 SyncTransforms） */
  private sync(): void {
    const w = this.w;
    const seenBodies = new Set<ComponentData>();
    const seenStatics = new Set<ComponentData>();
    for (const node of w.graph.nodes.values()) {
      if (!liveActive(w, node)) continue;
      const comps = w.graph.components(node);
      const rb = comps.find((c) => c.type === 'Rigidbody');
      if (rb) {
        seenBodies.add(rb);
        if (!this.bodies.has(rb)) this.addBody(node, rb, comps);
        continue;
      }
      for (const mc of comps) {
        if (mc.type !== 'MeshCollider' || mc.m_Enabled === 0 || mc.m_IsTrigger === 1) continue;
        if (this.hasRigidbodyAncestor(node)) continue;
        seenStatics.add(mc);
        if (!this.statics.has(mc)) this.addStatic(node, mc);
      }
    }
    for (const [comp, e] of [...this.bodies]) {
      if (seenBodies.has(comp)) continue;
      if (e.collider) this.colliderNode.delete(e.collider.handle);
      this.rapier.removeRigidBody(e.body);
      this.bodies.delete(comp);
    }
    for (const [comp, e] of [...this.statics]) {
      if (seenStatics.has(comp)) continue;
      this.colliderNode.delete(e.collider.handle);
      this.rapier.removeRigidBody(e.body);
      this.statics.delete(comp);
    }
    // 位置：不動的碰撞器（骰盤跟著 Dice Box 的 Animator 動）與剛體都照場景
    for (const e of this.statics.values()) {
      const { pos, rot } = decompose(e.node);
      e.body.setTranslation(pos, false);
      e.body.setRotation(rot, false);
    }
    for (const e of this.bodies.values()) {
      const { pos, rot } = decompose(e.node);
      e.body.setTranslation(pos, false);
      e.body.setRotation(rot, false);
    }
  }

  private hasRigidbodyAncestor(node: SceneNode): boolean {
    for (let n = node.parent; n; n = n.parent) if (this.w.graph.components(n).some((c) => c.type === 'Rigidbody')) return true;
    return false;
  }

  private colliderDesc(node: SceneNode, mc: ComponentData, scale: Vector3, convex: boolean): RAPIER.ColliderDesc | null {
    const ref = mc.m_Mesh as { guid?: string; fileID?: string } | null;
    const mesh = meshAssetOf(ref);
    if (!mesh) {
      this.w.notes.add(`Physics：${node.go.m_Name} 的 MeshCollider 網格 ${ref?.guid ?? '（空）'} 沒有預載`);
      return null;
    }
    const src = mesh.channels.position.values;
    const pts = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      pts[i] = src[i] * scale.x;
      pts[i + 1] = src[i + 1] * scale.y;
      pts[i + 2] = src[i + 2] * scale.z;
    }
    const desc = convex ? RAPIER.ColliderDesc.convexHull(pts) : RAPIER.ColliderDesc.trimesh(pts, new Uint32Array(mesh.indices));
    if (!desc) return null;
    const matRef = mc.m_Material as { guid?: string } | null;
    const mat = (matRef?.guid ? physicMaterial(matRef.guid) : null) ?? { dynamicFriction: 0.6, staticFriction: 0.6, bounciness: 0, frictionCombine: 0, bounceCombine: 0 };
    desc.setFriction(mat.dynamicFriction).setFrictionCombineRule(combineRule(mat.frictionCombine));
    desc.setRestitution(mat.bounciness).setRestitutionCombineRule(combineRule(mat.bounceCombine));
    desc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    return desc;
  }

  private addBody(node: SceneNode, rb: ComponentData, comps: ComponentData[]): void {
    const state = this.stateOf(rb);
    pendingStates.delete(rb);
    const { pos, rot, scale } = decompose(node);
    const bd = (state.isKinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic())
      .setTranslation(pos.x, pos.y, pos.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinearDamping((rb.m_Drag as number) ?? 0)
      .setAngularDamping((rb.m_AngularDrag as number) ?? 0.05)
      .setGravityScale(state.useGravity ? 1 : 0)
      .setLinvel(state.velocity.x, state.velocity.y, state.velocity.z)
      .setAngvel(state.angularVelocity);
    const body = this.rapier.createRigidBody(bd);
    let collider: RAPIER.Collider | null = null;
    const mc = comps.find((c) => c.type === 'MeshCollider' && c.m_Enabled !== 0);
    if (mc) {
      const desc = this.colliderDesc(node, mc, scale, mc.m_Convex === 1);
      if (desc) {
        desc.setMass((rb.m_Mass as number) ?? 1);
        collider = this.rapier.createCollider(desc, body);
        collider.setEnabled(state.detectCollisions);
        this.colliderNode.set(collider.handle, node);
      }
    } else this.w.notes.add(`Physics：${node.go.m_Name} 的 Rigidbody 沒有 MeshCollider（其他碰撞器還沒做）`);
    this.bodies.set(rb, { comp: rb, node, body, collider, state });
  }

  private addStatic(node: SceneNode, mc: ComponentData): void {
    const { pos, rot, scale } = decompose(node);
    const desc = this.colliderDesc(node, mc, scale, mc.m_Convex === 1);
    if (!desc) return;
    const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z).setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w }));
    const collider = this.rapier.createCollider(desc, body);
    this.colliderNode.set(collider.handle, node);
    this.statics.set(mc, { comp: mc, node, body, collider });
  }

  /** Physics.Simulate(dt)：推一步，寫回場景，回傳這一步的碰撞訊息（照 Unity：Enter、Stay、Exit） */
  simulate(dt: number): CollisionMessage[] {
    this.sync();
    // AddTorque（ForceMode.Force）：這一步的角衝量 = 扭力 × dt
    for (const e of this.bodies.values()) {
      const t = e.state.torque;
      if (t.x !== 0 || t.y !== 0 || t.z !== 0) {
        if (!e.state.isKinematic) {
          e.body.applyTorqueImpulse({ x: t.x * dt, y: t.y * dt, z: t.z * dt }, true);
          this.wakeUp(e);
        }
        e.state.torque = { x: 0, y: 0, z: 0 };
      }
    }
    this.rapier.timestep = dt;
    this.rapier.step(this.events);
    const started = new Set<string>();
    const stopped = new Set<string>();
    this.events.drainCollisionEvents((h1, h2, isStarted) => {
      const key = h1 < h2 ? `${h1}:${h2}` : `${h2}:${h1}`;
      if (isStarted) started.add(key);
      else stopped.add(key);
    });
    // 寫回場景與睡眠
    for (const e of this.bodies.values()) {
      if (e.state.isKinematic) continue;
      const p = e.body.translation();
      const r = e.body.rotation();
      writeWorld(e.node, p, r);
      this.updateSleep(e, dt);
    }
    // 碰撞訊息
    const out: CollisionMessage[] = [];
    const next = new Set<string>();
    const push = (kind: CollisionKind, key: string) => {
      const [a, b] = key.split(':').map(Number);
      const na = this.colliderNode.get(a);
      const nb = this.colliderNode.get(b);
      if (!na || !nb) return;
      out.push({ kind, node: na, other: nb });
      out.push({ kind, node: nb, other: na });
    };
    for (const key of started) {
      if (stopped.has(key)) continue;
      push('OnCollisionEnter', key);
      next.add(key);
    }
    for (const key of this.touching) {
      if (stopped.has(key)) {
        push('OnCollisionExit', key);
        continue;
      }
      if (started.has(key)) continue;
      push('OnCollisionStay', key);
      next.add(key);
    }
    this.touching = next;
    return out;
  }

  /** PhysX 的睡眠：質量正規化的動能低於門檻持續 WAKE_COUNTER_RESET 秒就睡，速度歸零 */
  private updateSleep(e: BodyEntry, dt: number): void {
    if (e.state.sleeping) {
      // Rapier 因接觸把它叫醒（被別的骰子撞）：照 PhysX 也醒來
      if (!e.body.isSleeping()) this.wakeUp(e);
      else return;
    }
    const v = e.body.linvel();
    const w = e.body.angvel();
    const m = e.body.mass() || 1;
    const inertia = e.body.principalInertia();
    const iw = { x: inertia.x * w.x, y: inertia.y * w.y, z: inertia.z * w.z };
    // 主慣性軸跟世界軸不一定對齊；骰子都是正多面體，慣性是等向的，這裡直接用主軸分量
    const energy = 0.5 * (v.x * v.x + v.y * v.y + v.z * v.z) + (0.5 * (w.x * iw.x + w.y * iw.y + w.z * iw.z)) / m;
    if (energy < this.dynamics.sleepThreshold) e.state.wake -= dt;
    else e.state.wake = WAKE_COUNTER_RESET;
    if (e.state.wake <= 0) {
      e.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      e.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      e.body.sleep();
      e.state.sleeping = true;
    }
  }
}

/** 還沒進物理場景的 Rigidbody 狀態（Instantiate 之後、第一次 Simulate 之前設的速度與扭力） */
const pendingStates = new WeakMap<ComponentData, RigidbodyState>();
function pendingStateOf(comp: ComponentData): RigidbodyState {
  let p = pendingStates.get(comp);
  if (!p) {
    p = {
      isKinematic: comp.m_IsKinematic === 1,
      useGravity: comp.m_UseGravity !== 0,
      detectCollisions: true,
      maxAngularVelocity: 7,
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      torque: { x: 0, y: 0, z: 0 },
      wake: WAKE_COUNTER_RESET,
      sleeping: false,
    };
    pendingStates.set(comp, p);
  }
  return p;
}

const scenes = new WeakMap<World, PhysicsScene>();
/** 這個 World 的物理場景（第一次用到才建；Rapier 要先 initPhysics） */
export function physicsOf(w: World, dynamics?: Partial<DynamicsSettings>): PhysicsScene {
  let s = scenes.get(w);
  if (!s) {
    s = new PhysicsScene(w, dynamics);
    scenes.set(w, s);
  }
  return s;
}
/** Rigidbody 的狀態：物理場景建了就問它，還沒建（Instantiate 之後馬上設速度）就用暫存的 */
export function rigidbodyStateOf(w: World, comp: ComponentData): RigidbodyState {
  return scenes.get(w)?.stateOf(comp) ?? pendingStateOf(comp);
}
export function hasPhysics(w: World): boolean {
  return scenes.has(w);
}

// Animator（Mecanim，引擎原生）：照 AnimatorController 的資料跑狀態機，取樣 clip 套到場景資料。
//
// 照 Unity 的定義做的部分：預設狀態、狀態速度與 cycle offset、clip 的 loop 與 start／stop time、轉換條件（If／IfNot／
// Greater／Less／Equals／NotEqual、trigger 用掉就清）、exit time、Any State、Write Defaults（目前狀態沒動到的屬性回到初始值）、
// AnimatorOverrideController 換 clip。
// 動畫事件（clip 的 m_Events）：播放時間經過事件的時間就記在 fired，由 World 交給登記的派送函式（csport 照方法的參數型別帶值）。
// 事件時間落在 (上一格, 這一格]；剛進狀態的那一格含起點（時間 0 的事件會發）；loop 的 clip 每圈都發。
// 還沒做（遇到記在 notes）：轉換的淡入淡出（現在瞬間切換）、BlendTree、子狀態機、第 2 層以後的 layer、root motion。

import { evaluate, evaluateVector, num, samplePPtr, type Keyframe, type PPtrKey } from './curves';
import { crc32 } from './crc32';
import type { SceneGraph, SceneNode } from '../unity/scene';
import type { ComponentData, Ref } from '../unity/types';

export interface ControllerAsset {
  name: string;
  type: 'AnimatorController' | 'AnimatorOverrideController';
  root: string;
  objects: Record<string, Record<string, unknown>>;
}

/** AnimationClip 的 m_Events（匯入的 YAML：data 是 stringParameter） */
export interface AnimEventData {
  time: number;
  functionName: string;
  data: string | null;
  objectReferenceParameter: Ref | null;
  floatParameter: number;
  intParameter: number;
  /** SendMessageOptions：0 RequireReceiver（沒有接收者 Unity 會記錯誤）、1 DontRequireReceiver */
  messageOptions: number;
}

export interface ClipAsset {
  m_Name: string;
  m_Events?: AnimEventData[];
  m_SampleRate: number;
  m_AnimationClipSettings: { m_StartTime: number; m_StopTime: number; m_LoopTime: number; m_CycleOffset: number };
  m_PositionCurves: CurveEntry[];
  m_EulerCurves: CurveEntry[];
  m_RotationCurves: CurveEntry[];
  m_ScaleCurves: CurveEntry[];
  m_FloatCurves: CurveEntry[];
  m_PPtrCurves: CurveEntry[];
}

interface CurveEntry {
  curve: { m_Curve: Keyframe<never>[] } | PPtrKey<Ref>[];
  path: string | null;
  attribute?: string | null;
  classID?: number | null;
  script?: Ref;
}

type Kind = 'position' | 'euler' | 'rotation' | 'scale' | 'float' | 'pptr';

/** 一條綁定：曲線 + 解析好的寫入目標 */
interface Binding {
  key: string; // 「路徑|類別|屬性」，Write Defaults 用
  kind: Kind;
  keys: unknown[];
  get: () => unknown;
  set: (v: unknown) => void;
}

const CLASS_TYPE: Record<number, string> = { 1: 'GameObject', 4: 'Transform', 224: 'RectTransform', 212: 'SpriteRenderer', 23: 'MeshRenderer', 20: 'Camera', 222: 'CanvasRenderer', 95: 'Animator', 61: 'BoxCollider2D' };

/** Quaternion.Euler（度）：先繞 z、再 x、再 y（q = qy·qx·qz） */
export function eulerToQuaternion(e: { x: number; y: number; z: number }): { x: number; y: number; z: number; w: number } {
  const r = Math.PI / 360;
  const [sx, cx] = [Math.sin(e.x * r), Math.cos(e.x * r)];
  const [sy, cy] = [Math.sin(e.y * r), Math.cos(e.y * r)];
  const [sz, cz] = [Math.sin(e.z * r), Math.cos(e.z * r)];
  return {
    x: cy * sx * cz + sy * cx * sz,
    y: sy * cx * cz - cy * sx * sz,
    z: cy * cx * sz - sy * sx * cz,
    w: cy * cx * cz + sy * sx * sz,
  };
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
}
function setPath(obj: Record<string, unknown>, path: string, v: unknown) {
  const parts = path.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof o[p] !== 'object' || o[p] === null) o[p] = {};
    o = o[p] as Record<string, unknown>;
  }
  o[parts[parts.length - 1]] = v;
}

export class AnimatorRuntime {
  readonly notes: string[] = [];
  private base: ControllerAsset;
  private overrides = new Map<string, string>();
  private params = new Map<string, { type: number; value: number | boolean }>();
  private state: Record<string, unknown> | null = null;
  private stateTime = 0;
  private defaults = new Map<string, unknown>();
  private bindings = new Map<string, Binding[]>(); // clip guid → 綁定
  /** 屬性有改（sprite、顏色、active…），繪製與排版要更新 */
  changed = false;
  /** 這一格經過的動畫事件（World 派送後清空） */
  readonly fired: { ev: AnimEventData; clip: string }[] = [];
  /** 剛進目前的狀態、還沒推進過：時間 0 的事件要發 */
  private freshState = true;

  constructor(
    private readonly graph: SceneGraph,
    readonly node: SceneNode,
    readonly component: ComponentData,
    controller: ControllerAsset,
    controllers: Record<string, ControllerAsset>,
    private readonly clips: Record<string, ClipAsset>,
  ) {
    if (controller.type === 'AnimatorOverrideController') {
      const ov = controller.objects[controller.root] as { m_Controller: Ref; m_Clips: { m_OriginalClip: Ref; m_OverrideClip: Ref }[] };
      for (const c of ov.m_Clips) if (c.m_OriginalClip && 'guid' in c.m_OriginalClip && c.m_OverrideClip && 'guid' in c.m_OverrideClip) this.overrides.set(c.m_OriginalClip.guid, c.m_OverrideClip.guid);
      this.base = controllers[(ov.m_Controller as { guid: string }).guid];
    } else this.base = controller;
    const root = this.base.objects[this.base.root] as { m_AnimatorParameters: { m_Name: string; m_Type: number; m_DefaultFloat: number; m_DefaultInt: number; m_DefaultBool: number }[]; m_AnimatorLayers: { m_StateMachine: { fileID: string } }[] };
    for (const p of root.m_AnimatorParameters) {
      this.params.set(p.m_Name, { type: p.m_Type, value: p.m_Type === 1 ? p.m_DefaultFloat : p.m_Type === 3 ? p.m_DefaultInt : p.m_Type === 4 ? !!p.m_DefaultBool : false });
    }
    if (root.m_AnimatorLayers.length > 1) this.notes.push(`${this.base.name}：第 2 層以後的 layer 還沒做`);
    const sm = this.base.objects[root.m_AnimatorLayers[0].m_StateMachine.fileID] as { m_DefaultState: { fileID: string }; m_ChildStateMachines?: unknown[] };
    if (sm.m_ChildStateMachines?.length) this.notes.push(`${this.base.name}：子狀態機還沒做`);
    this.stateMachine = sm as unknown as Record<string, unknown>;
    // 這個控制器所有 clip 動到的屬性，記下初始值（Write Defaults 用）
    for (const s of this.states()) {
      const clip = this.clipOf(s);
      if (clip) for (const b of this.bind(clip)) if (!this.defaults.has(b.key)) this.defaults.set(b.key, structuredClone(b.get()));
    }
    this.enter(this.base.objects[sm.m_DefaultState.fileID]);
  }

  private stateMachine: Record<string, unknown>;

  private states(): Record<string, unknown>[] {
    return Object.values(this.base.objects).filter((o) => o.type === 'AnimatorState');
  }

  private clipOf(state: Record<string, unknown>): string | null {
    const m = state.m_Motion as Ref;
    if (!m || !('guid' in m)) return null;
    if (m.fileID !== '7400000') {
      this.notes.push(`${state.m_Name}：BlendTree 還沒做`);
      return null;
    }
    return this.overrides.get(m.guid) ?? m.guid;
  }

  setTrigger(name: string) {
    const p = this.params.get(name);
    if (p) p.value = true;
  }
  /** Animator.ResetTrigger：還沒被轉換消耗掉的 trigger 清掉 */
  resetTrigger(name: string) {
    const p = this.params.get(name);
    if (p) p.value = false;
  }
  setBool(name: string, v: boolean) {
    const p = this.params.get(name);
    if (p) p.value = v;
  }
  setFloat(name: string, v: number) {
    const p = this.params.get(name);
    if (p) p.value = v;
  }

  get currentStateName(): string | null {
    return (this.state?.m_Name as string) ?? null;
  }

  private enter(state: Record<string, unknown> | undefined, offset = 0) {
    this.state = state ?? null;
    this.stateTime = offset;
    this.freshState = true;
  }

  /** 狀態時間 prev → cur 之間經過的事件（cycle offset 與 start time 換成 clip 時間；loop 的 clip 展開成連續時間一圈一圈找） */
  private collectEvents(clip: ClipAsset, length: number, prev: number, cur: number) {
    const evs = clip.m_Events;
    const fresh = this.freshState;
    this.freshState = false;
    if (!evs?.length || cur < prev) return;
    const s = clip.m_AnimationClipSettings;
    const off = ((this.state!.m_CycleOffset as number) ?? 0) * length;
    const a = prev + off;
    const b = cur + off;
    const hit = (t: number) => (t > a || (fresh && t >= a)) && t <= b;
    const loop = !!s.m_LoopTime && length > 0;
    const k0 = loop ? Math.floor(a / length) : 0;
    const k1 = loop ? Math.floor(b / length) : 0;
    for (let k = k0; k <= k1; k++)
      for (const ev of evs) {
        const t = k * length + (ev.time - s.m_StartTime);
        if (hit(t)) this.fired.push({ ev, clip: clip.m_Name });
      }
  }

  // ───────── 綁定 ─────────

  private findNode(path: string | number | null): SceneNode | null {
    let n: SceneNode | null = this.node;
    if (path === null || path === undefined || path === '') return n;
    // 名字是純數字的子物件（刪卡小遊戲的剪刀刀片「1」「2」）：匯入時 YAML 把 path 讀成整數，照字串比對（10/15 剪刀畫面一進去就丟錯）
    for (const name of String(path).split('/')) {
      n = n?.children.find((c) => c.go.m_Name === name) ?? null;
      if (!n) return null;
    }
    return n;
  }

  private findComponent(node: SceneNode, classID: number | null | undefined, script?: Ref): ComponentData | Record<string, unknown> | null {
    if (classID === 1) return node.go as unknown as Record<string, unknown>;
    if (classID === 114) {
      const guid = script && 'guid' in script ? script.guid : null;
      return this.graph.components(node).find((c) => c.type === 'MonoBehaviour' && (!guid || (c.m_Script as { guid?: string } | null)?.guid === guid)) ?? null;
    }
    if (!classID) return null;
    // 型別名表裡沒有的內建元件（CanvasGroup 225 的 m_Alpha 等）：場景樹的元件都帶 classID，直接比對
    const type = CLASS_TYPE[classID];
    return this.graph.components(node).find((c) => (type && c.type === type) || c.classID === classID) ?? null;
  }

  private bind(guid: string): Binding[] {
    const cached = this.bindings.get(guid);
    if (cached) return cached;
    const clip = this.clips[guid];
    const out: Binding[] = [];
    if (!clip) {
      this.notes.push(`clip ${guid} 不在 animations.json`);
      this.bindings.set(guid, out);
      return out;
    }
    const transformOf = (path: string | number | null) => {
      const n = this.findNode(path);
      if (!n) this.notes.push(`${clip.m_Name}：找不到路徑 ${path}`);
      return n?.transform as unknown as Record<string, unknown> | undefined;
    };
    const vectorKind: [keyof ClipAsset, Kind, string][] = [
      ['m_PositionCurves', 'position', 'm_LocalPosition'],
      ['m_ScaleCurves', 'scale', 'm_LocalScale'],
      ['m_EulerCurves', 'euler', 'm_LocalRotation'],
      ['m_RotationCurves', 'rotation', 'm_LocalRotation'],
    ];
    for (const [field, kind, prop] of vectorKind) {
      for (const e of clip[field] as CurveEntry[]) {
        const tf = transformOf(e.path);
        if (!tf) continue;
        out.push({
          key: `${e.path ?? ''}|Transform|${prop}`,
          kind,
          keys: (e.curve as { m_Curve: unknown[] }).m_Curve,
          get: () => tf[prop],
          set: (v) => {
            tf[prop] = v;
          },
        });
      }
    }
    for (const e of clip.m_FloatCurves) {
      const n = this.findNode(e.path);
      const target = n && this.findComponent(n, e.classID, e.script);
      if (!target || !e.attribute) {
        this.notes.push(`${clip.m_Name}：找不到 ${e.path}（classID ${e.classID}）的 ${e.attribute}`);
        continue;
      }
      const attr = resolveCrcAttribute(e.attribute, target as Record<string, unknown>);
      const isBool = attr === 'm_IsActive' || attr === 'm_Enabled';
      if (attr.startsWith('material.')) this.notes.push(`${clip.m_Name}：材質屬性動畫（${attr}）先寫進 $materialOverrides，繪製還沒讀`);
      const path = attr.startsWith('material.') ? `$materialOverrides.${attr.slice(9)}` : attr;
      out.push({
        key: `${e.path ?? ''}|${e.classID}|${attr}`,
        kind: 'float',
        keys: (e.curve as { m_Curve: unknown[] }).m_Curve,
        get: () => getPath(target as Record<string, unknown>, path),
        set: (v) => {
          if (!isBool) {
            setPath(target as Record<string, unknown>, path, v);
            return;
          }
          const b = (v as number) > 0.5 ? 1 : 0;
          // 曲線在 0～1 之間內插時，套用端每格都會呼叫（原始值跟存的 0／1 不同），四捨五入後沒變就不算改
          if (getPath(target as Record<string, unknown>, path) === b) return;
          setPath(target as Record<string, unknown>, path, b);
          // m_Enabled／m_IsActive 是直接寫欄位的（沒有 setter），refreshEnables 的「整段跳過」要失效。
          // m_IsActive 由下一次 refreshHierarchy 處理；這裡 bump 一次讓兩條路都不跳
          this.graph.enabledVersion++;
        },
      });
    }
    for (const e of clip.m_PPtrCurves) {
      const n = this.findNode(e.path);
      const target = n && this.findComponent(n, e.classID, e.script);
      if (!target || !e.attribute) {
        this.notes.push(`${clip.m_Name}：找不到 ${e.path}（classID ${e.classID}）的 ${e.attribute}`);
        continue;
      }
      const attr = resolveCrcAttribute(e.attribute, target as Record<string, unknown>);
      out.push({
        key: `${e.path ?? ''}|${e.classID}|${attr}`,
        kind: 'pptr',
        keys: e.curve as PPtrKey<Ref>[],
        get: () => (target as Record<string, unknown>)[attr],
        set: (v) => {
          (target as Record<string, unknown>)[attr] = v;
        },
      });
    }
    this.bindings.set(guid, out);
    return out;
  }

  // ───────── 每格 ─────────

  private clipLength(clip: ClipAsset): number {
    const s = clip.m_AnimationClipSettings;
    return Math.max(0, s.m_StopTime - s.m_StartTime);
  }

  private conditionsMet(t: Record<string, unknown>): boolean {
    for (const c of (t.m_Conditions as { m_ConditionMode: number; m_ConditionEvent: string; m_EventTreshold: number }[]) ?? []) {
      const p = this.params.get(c.m_ConditionEvent);
      if (!p) return false;
      const v = p.value;
      switch (c.m_ConditionMode) {
        case 1: if (!v) return false; break; // If
        case 2: if (v) return false; break; // IfNot
        case 3: if (!((v as number) > c.m_EventTreshold)) return false; break; // Greater
        case 4: if (!((v as number) < c.m_EventTreshold)) return false; break; // Less
        case 6: if ((v as number) !== c.m_EventTreshold) return false; break; // Equals
        case 7: if ((v as number) === c.m_EventTreshold) return false; break; // NotEqual
        default: return false;
      }
    }
    return true;
  }

  private consumeTriggers(t: Record<string, unknown>) {
    for (const c of (t.m_Conditions as { m_ConditionEvent: string }[]) ?? []) {
      const p = this.params.get(c.m_ConditionEvent);
      if (p && p.type === 9) p.value = false;
    }
  }

  /**
   * Has Exit Time 的時間條件（Unity 2022.3 手冊 Animation transitions）：正規化時間到達 exit time 的那一格成立，下一格就不成立。
   * 循環的 clip、exit time 小於 1：每一圈都判斷，也就是跨過 k + exitTime（k = 0, 1, 2…）的那一格；大於等於 1 的只判斷一次。
   * 剛進狀態時（prev＝0）exit time 0 不算到達，要等第一圈跑完（未查證）。
   * 長度 0 的循環 clip（只有一格靜態姿勢；MT2 故事事件的 WideBG_Init、Event_Init）：一格就跑完很多圈，時間有前進的每一格都算到達（未查證）。
   * 以前拿總時間比、長度 0 當成非循環：WideBG_Init → WideBG_ScrollingStop（exit 0）永遠不轉，背景停在捲動，門不會開，故事事件卡住
   */
  private exitTimeReached(exit: number, prevNormalized: number, normalized: number, loop: 'none' | 'loop' | 'zero'): boolean {
    if (loop === 'zero') return this.advanced;
    if (loop === 'none' || exit >= 1) return prevNormalized < exit && normalized >= exit;
    const k = Math.floor(normalized - exit);
    return k >= 0 && prevNormalized < k + exit && normalized >= k + exit;
  }
  /** 這一格狀態時間有沒有前進（長度 0 的循環 clip 判斷 exit time 用） */
  private advanced = false;

  private tryTransitions(prevNormalized: number, normalized: number, loop: 'none' | 'loop' | 'zero'): boolean {
    const candidates: Record<string, unknown>[] = [];
    const anyCount = ((this.stateMachine.m_AnyStateTransitions as unknown[]) ?? []).length;
    for (const r of (this.stateMachine.m_AnyStateTransitions as { fileID: string }[]) ?? []) candidates.push(this.base.objects[r.fileID]);
    for (const r of (this.state?.m_Transitions as { fileID: string }[]) ?? []) candidates.push(this.base.objects[r.fileID]);
    for (let i = 0; i < candidates.length; i++) {
      const t = candidates[i];
      if (!t || t.m_Mute) continue;
      // AnyState 的轉換：目的地就是目前的狀態時，要開了 Can Transition To Self 才轉（Unity 手冊 Animation transitions）
      if (i < anyCount && !t.m_CanTransitionToSelf && this.base.objects[(t.m_DstState as { fileID: string } | null)?.fileID ?? ''] === this.state) continue;
      if (t.m_HasExitTime) {
        if (!this.exitTimeReached(t.m_ExitTime as number, prevNormalized, normalized, loop)) continue;
      }
      if (!t.m_HasExitTime && !((t.m_Conditions as unknown[]) ?? []).length) continue;
      if (!this.conditionsMet(t)) continue;
      this.consumeTriggers(t);
      const dst = t.m_DstState as { fileID: string } | null;
      if (!dst || dst.fileID === '0') {
        this.notes.push('轉到 Exit／子狀態機還沒做');
        continue;
      }
      if ((t.m_TransitionDuration as number) > 0) this.notes.push('轉換的淡入淡出還沒做（瞬間切換）');
      this.enter(this.base.objects[dst.fileID], 0);
      return true;
    }
    return false;
  }

  update(dt: number, allowTransition = true): void {
    if (!this.state) return;
    const speed = (this.state.m_Speed as number) ?? 1;
    const guid = this.clipOf(this.state);
    const clip = guid ? this.clips[guid] : null;
    const length = clip ? this.clipLength(clip) : 0;
    const prev = this.stateTime;
    this.stateTime += dt * speed;
    if (clip) this.collectEvents(clip, length, prev, this.stateTime);
    else this.freshState = false;
    const norm = (t: number) => (length > 0 ? t / length : t > 0 ? 1 : 0);
    // 一格每個 layer 只開始一個轉換：新狀態從 0 開始套，它的轉換下一格才判斷（以前馬上再判斷，AnyState 的 bool 條件一直成立時無限遞迴）
    const loop = !clip?.m_AnimationClipSettings.m_LoopTime ? 'none' : length > 0 ? 'loop' : 'zero';
    this.advanced = this.stateTime > prev;
    if (allowTransition && this.tryTransitions(norm(prev), norm(this.stateTime), loop)) return this.update(0, false);
    this.apply(guid, clip, length);
  }

  private apply(guid: string | null, clip: ClipAsset | null, length: number) {
    const active = new Set<string>();
    if (guid && clip) {
      const s = clip.m_AnimationClipSettings;
      let t = this.stateTime + ((this.state!.m_CycleOffset as number) ?? 0) * length;
      if (s.m_LoopTime && length > 0) t = ((t % length) + length) % length;
      else t = Math.min(Math.max(t, 0), length);
      t += s.m_StartTime;
      for (const b of this.bind(guid)) {
        active.add(b.key);
        let v: unknown;
        if (b.kind === 'pptr') v = samplePPtr(b.keys as PPtrKey<Ref>[], t);
        else if (b.kind === 'float') v = evaluate(b.keys as Keyframe<number>[], t);
        else if (b.kind === 'euler') {
          const e = evaluateVector(b.keys as Keyframe<{ x: number; y: number; z: number }>[], t, ['x', 'y', 'z']);
          v = eulerToQuaternion(e);
        } else if (b.kind === 'rotation') v = evaluateVector(b.keys as Keyframe<{ x: number; y: number; z: number; w: number }>[], t, ['x', 'y', 'z', 'w']);
        else v = evaluateVector(b.keys as Keyframe<{ x: number; y: number; z: number }>[], t, ['x', 'y', 'z']);
        if (v === undefined) continue;
        const old = b.get();
        if (JSON.stringify(old) !== JSON.stringify(v)) {
          b.set(v);
          this.changed = true;
        }
      }
    }
    // Write Defaults：這個狀態沒動到、但控制器裡別的狀態會動的屬性，回到初始值
    if (this.state?.m_WriteDefaultValues) {
      for (const s of this.states()) {
        const g = this.clipOf(s);
        if (!g) continue;
        for (const b of this.bind(g)) {
          if (active.has(b.key)) continue;
          const d = this.defaults.get(b.key);
          if (JSON.stringify(b.get()) !== JSON.stringify(d)) {
            b.set(structuredClone(d));
            this.changed = true;
          }
        }
      }
    }
  }
}

export { num };

/**
 * 綁到腳本欄位（classID 114）的曲線，build 裡只存屬性路徑的 CRC32（GenericBinding.attribute）。AssetRipper 對 DLL 裡的類別
 *（UnityEngine.UI 的 Image）認不出名稱時寫成 script_0x<CRC32 十六進位>_<亂碼>：MT2 載入畫面的火焰（Flames.anim 換 Image 的 sprite）
 * 是 script_0x7822D856_UsmorHH，0x7822D856 ＝ CRC32("m_Sprite")。照目標元件的欄位名（含一層的子欄位，例如 m_Color.a）算 CRC32 對回原名；
 * 對不到就照原字串（跟以前一樣寫不到東西）
 */
export function resolveCrcAttribute(attr: string, target: Record<string, unknown>): string {
  const m = attr.match(/^script_0x([0-9a-fA-F]{8})_/);
  if (!m) return attr;
  const want = parseInt(m[1], 16) >>> 0;
  for (const [k, v] of Object.entries(target)) {
    if (crc32(k) === want) return k;
    if (v && typeof v === 'object' && !Array.isArray(v)) for (const sub of Object.keys(v)) if (crc32(`${k}.${sub}`) === want) return `${k}.${sub}`;
  }
  return attr;
}

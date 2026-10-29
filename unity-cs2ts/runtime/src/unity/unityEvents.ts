// UnityEvent 的 m_PersistentCalls（場景 YAML 裡綁定的 onClick／onValueChanged）：
// 依 m_Target 找元件的 behaviour，用 C# 方法名稱（m_MethodName）呼叫。
// 對應 UnityEngine.Events.PersistentCall（Unity 執行環境行為照 EventUtility／UnityEvent.Invoke，
// 加上 InputSystemUIInputModule.ProcessPointerButton 那側的用法；10/5 讀）。
//
// - m_Mode 0（Event）＝ 帶事件自己的執行期參數（例如 Toggle.onValueChanged 的 bool、TMP_Dropdown 的 int）。
// - m_Mode 1（Void）＝ 不帶參數直接呼叫；其餘 m_Mode（Int／Float／String／Object 用 m_Arguments 存的值）
//   設定流程沒用到，遇到記 notes。
// - 目標找不到、或方法還沒移植：記 notes（格式沿用既有「點擊 → X.Y（還沒做）」）。

import type { World } from '../engine/world';
import type { ComponentData } from './types';

interface PersistentCall {
  m_Target: { fileID: string } | null;
  m_TargetAssemblyTypeName: string;
  m_MethodName: string;
  m_Mode: number;
  m_Arguments: Record<string, unknown>;
}

interface PersistentCallsEvent {
  m_PersistentCalls: { m_Calls: PersistentCall[] };
}

/** 元件上的 m_OnClick／m_OnValueChanged 等欄位 */
export function persistentCallsOf(comp: ComponentData, field: string): PersistentCall[] {
  const evt = comp[field] as PersistentCallsEvent | undefined;
  return evt?.m_PersistentCalls?.m_Calls ?? [];
}

/**
 * 呼叫一組 persistent calls。runtimeArg 是事件參數（m_Mode 0 用的那個）。
 * label 給 notes 用（「點擊」或「onValueChanged」）。
 */
export function invokePersistentCalls(world: World, comp: ComponentData, field: string, runtimeArg: unknown, label: string): void {
  for (const call of persistentCallsOf(comp, field)) {
    const cls = call.m_TargetAssemblyTypeName.split(',')[0];
    const target = call.m_Target ? world.graph.file.components[call.m_Target.fileID] : undefined;
    const behaviour = target ? world.behaviour(target) : undefined;
    const member = behaviour ? (behaviour as Record<string, unknown>)[call.m_MethodName] : undefined;
    const fn = typeof member === 'function' ? (member as (arg: unknown) => void) : undefined;
    if (typeof fn === 'function') {
      if (call.m_Mode === 0) fn.call(behaviour, runtimeArg);
      else if (call.m_Mode === 1) (fn as () => void).call(behaviour);
      else world.notes.add(`${label} → ${cls}.${call.m_MethodName}（m_Mode ${call.m_Mode} 參數還沒做）`);
    } else {
      world.notes.add(`${label} → ${cls}.${call.m_MethodName}（還沒做）`);
    }
  }
  // 再叫執行期的監聽（腳本 AddListener 加的；UnityEvent.Invoke 也是先持久呼叫、再執行期監聽）
  const ev = comp[field];
  if (ev && typeof ev === 'object') for (const f of [...(runtimeListeners.get(ev) ?? [])]) world.guard(`${label} 的監聽`, () => void f(runtimeArg));
}

/**
 * 執行期加的監聽（UnityEvent.AddListener；csport 的相容層登記）：照事件物件記。執行環境原生的控制項（Slider、Toggle…）
 * 的事件物件就是元件資料裡那一份（m_OnValueChanged），同一個元件永遠同一個物件。
 */
const runtimeListeners = new WeakMap<object, ((...a: unknown[]) => unknown)[]>();
export function runtimeListenersOf(ev: object): ((...a: unknown[]) => unknown)[] {
  let list = runtimeListeners.get(ev);
  if (!list) runtimeListeners.set(ev, (list = []));
  return list;
}
export function clearRuntimeListeners(ev: object): void {
  runtimeListeners.delete(ev);
}

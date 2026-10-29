// C#: UnityEngine.Localization.SmartFormat.PersistentVariables/IVariable.cs、IVariableGroup.cs、
//     IVariableValueChanged.cs、IMetadataVariable.cs、Variable.cs、VariableNameValuePair.cs、
//     VariablesGroupAsset.cs、NestedVariablesGroup.cs，以及 IntVariable.cs、UIntVariable.cs、
//     LongVariable.cs、ULongVariable.cs、ShortVariable.cs、UShortVariable.cs、ByteVariable.cs、
//     SByteVariable.cs、FloatVariable.cs、DoubleVariable.cs、BoolVariable.cs、StringVariable.cs、
//     ObjectVariable.cs（13 個具體型別）。
//
// GetSourceValue 回傳 values.ts 的 C# 型別包裝，不回裸值：
//   IntVariable → cs.int、LongVariable／ULongVariable → cs.long、FloatVariable → cs.float、
//   DoubleVariable → cs.double、BoolVariable → cs.bool、StringVariable → cs.string、
//   ObjectVariable → wrap(UnityEngine.Object)。
//   UInt／UShort／Short／Byte／SByte 在 C# 裡都不是 int（OrdinalFormatter 的 `is int` 會拒收），
//   這裡用 cs.long 包裝保留「不是 int」這件事，數值輸出與 C# 相同。
// 具體型別的 Value 初始值照 C# 的 default(T)（int 系 0、bool false、string／Object null）。
// C# 的 `event Action<IVariable> ValueChanged`（+=／-=）在 TS 是 AddValueChanged／RemoveValueChanged。

import type { ISelectorInfo } from './interfaces.ts';
import { cs, wrap, type CsValue } from './values.ts';

export type Action<T> = (arg: T) => void;

/** C#: PersistentVariables/IVariable.cs IVariable */
export interface IVariable {
  GetSourceValue(selector: ISelectorInfo): CsValue;
}

/** C#: PersistentVariables/IVariableGroup.cs IVariableGroup（C# 是 bool TryGetValue(key, out value)） */
export interface IVariableGroup {
  TryGetValue(key: string): IVariable | undefined;
}

/** C#: PersistentVariables/IVariableValueChanged.cs IVariableValueChanged */
export interface IVariableValueChanged extends IVariable {
  AddValueChanged(handler: Action<IVariable>): void;
  RemoveValueChanged(handler: Action<IVariable>): void;
}

/** C#: PersistentVariables/IMetadataVariable.cs IMetadataVariable */
export interface IMetadataVariable extends IVariable {
  readonly VariableName: string;
}

/** C#: PersistentVariables/VariableNameValuePair.cs VariableNameValuePair */
export class VariableNameValuePair {
  /** C#: VariableNameValuePair.name */
  name = '';
  /** C#: VariableNameValuePair.variable */
  variable: IVariable | null = null;

  /** C#: VariableNameValuePair.ToString */
  ToString(): string {
    return `${this.name} - ${this.variable?.constructor.name ?? ''}`;
  }
}

/** C#: PersistentVariables/Variable.cs Variable<T> */
export class Variable<T> implements IVariableValueChanged {
  private m_Value: T;
  private readonly listeners: Action<IVariable>[] = [];

  /** C# 的 m_Value 初始是 default(T)；這裡由子類別的建構子給（不走 setter，不發事件） */
  constructor(initial: T) {
    this.m_Value = initial;
  }

  /** C#: Variable<T>.Value */
  get Value(): T {
    return this.m_Value;
  }
  set Value(value: T) {
    // C#: if (m_Value == null || !m_Value.Equals(value)) —— 值型別的 m_Value == null 恆 false
    if (this.m_Value === null || this.m_Value === undefined || !valueEquals(this.m_Value, value)) {
      this.m_Value = value;
      this.SendValueChangedEvent();
    }
  }

  /** C#: event Action<IVariable> ValueChanged 的 += */
  AddValueChanged(handler: Action<IVariable>): void {
    this.listeners.push(handler);
  }

  /** C#: event Action<IVariable> ValueChanged 的 -= */
  RemoveValueChanged(handler: Action<IVariable>): void {
    const i = this.listeners.indexOf(handler);
    if (i !== -1) this.listeners.splice(i, 1);
  }

  /** C#: Variable<T>.SendValueChangedEvent */
  protected SendValueChangedEvent(): void {
    for (const h of [...this.listeners]) h(this);
  }

  /** C#: Variable<T>.GetSourceValue（回傳 Value；TS 版包成 C# 型別） */
  GetSourceValue(_selector: ISelectorInfo): CsValue {
    return this.ToCsValue(this.Value);
  }

  /** 子類別覆寫：把 T 對回 C# 型別包裝 */
  protected ToCsValue(value: T): CsValue {
    return wrap(value);
  }

  /** C#: Variable<T>.ToString */
  ToString(): string {
    return String(this.Value);
  }
}

/** C#: Variable<T> 的 m_Value.Equals(value)（物件是參考相等） */
function valueEquals<T>(a: T, b: T): boolean {
  return a === b || Object.is(a, b);
}

/** C#: PersistentVariables/IntVariable.cs IntVariable */
export class IntVariable extends Variable<number> {
  constructor(initial = 0) {
    super(initial);
  }
  protected override ToCsValue(value: number): CsValue {
    return cs.int(value);
  }
}

/** C#: PersistentVariables/UIntVariable.cs UIntVariable（C# 的 uint 不是 int，用 cs.long 保留這件事） */
export class UIntVariable extends Variable<number> {
  constructor(initial = 0) {
    super(initial);
  }
  protected override ToCsValue(value: number): CsValue {
    return cs.long(value);
  }
}

/** C#: PersistentVariables/LongVariable.cs LongVariable */
export class LongVariable extends Variable<bigint> {
  constructor(initial = 0n) {
    super(initial);
  }
  protected override ToCsValue(value: bigint): CsValue {
    return cs.long(value);
  }
}

/** C#: PersistentVariables/ULongVariable.cs ULongVariable */
export class ULongVariable extends Variable<bigint> {
  constructor(initial = 0n) {
    super(initial);
  }
  protected override ToCsValue(value: bigint): CsValue {
    return cs.long(value);
  }
}

/** C#: PersistentVariables/ShortVariable.cs ShortVariable（C# 的 short 不是 int） */
export class ShortVariable extends Variable<number> {
  constructor(initial = 0) {
    super(initial);
  }
  protected override ToCsValue(value: number): CsValue {
    return cs.long(value);
  }
}

/** C#: PersistentVariables/UShortVariable.cs UShortVariable（C# 的 ushort 不是 int） */
export class UShortVariable extends Variable<number> {
  constructor(initial = 0) {
    super(initial);
  }
  protected override ToCsValue(value: number): CsValue {
    return cs.long(value);
  }
}

/** C#: PersistentVariables/ByteVariable.cs ByteVariable（C# 的 byte 不是 int） */
export class ByteVariable extends Variable<number> {
  constructor(initial = 0) {
    super(initial);
  }
  protected override ToCsValue(value: number): CsValue {
    return cs.long(value);
  }
}

/** C#: PersistentVariables/SByteVariable.cs SByteVariable（C# 的 sbyte 不是 int） */
export class SByteVariable extends Variable<number> {
  constructor(initial = 0) {
    super(initial);
  }
  protected override ToCsValue(value: number): CsValue {
    return cs.long(value);
  }
}

/** C#: PersistentVariables/FloatVariable.cs FloatVariable */
export class FloatVariable extends Variable<number> {
  constructor(initial = 0) {
    super(Math.fround(initial));
  }
  protected override ToCsValue(value: number): CsValue {
    return cs.float(value);
  }
}

/** C#: PersistentVariables/DoubleVariable.cs DoubleVariable */
export class DoubleVariable extends Variable<number> {
  constructor(initial = 0) {
    super(initial);
  }
  protected override ToCsValue(value: number): CsValue {
    return cs.double(value);
  }
}

/** C#: PersistentVariables/BoolVariable.cs BoolVariable */
export class BoolVariable extends Variable<boolean> {
  constructor(initial = false) {
    super(initial);
  }
  protected override ToCsValue(value: boolean): CsValue {
    return cs.bool(value);
  }
}

/** C#: PersistentVariables/StringVariable.cs StringVariable */
export class StringVariable extends Variable<string | null> {
  constructor(initial: string | null = null) {
    super(initial);
  }
  protected override ToCsValue(value: string | null): CsValue {
    return value === null ? cs.null() : cs.string(value);
  }
}

/** C#: PersistentVariables/ObjectVariable.cs ObjectVariable（UnityEngine.Object） */
export class ObjectVariable extends Variable<object | null> {
  constructor(initial: object | null = null) {
    super(initial);
  }
  protected override ToCsValue(value: object | null): CsValue {
    return wrap(value);
  }
}

/** C#: PersistentVariables/VariablesGroupAsset.cs VariablesGroupAsset（ScriptableObject；同時是
 *  IVariableGroup、IVariable、IDictionary<string, IVariable>） */
export class VariablesGroupAsset implements IVariableGroup, IVariable {
  /** C#: VariablesGroupAsset.m_Variables */
  private readonly m_Variables: VariableNameValuePair[] = [];
  /** C#: VariablesGroupAsset.m_VariableLookup */
  private readonly m_VariableLookup = new Map<string, VariableNameValuePair>();

  /** C#: VariablesGroupAsset.Count */
  get Count(): number {
    return this.m_VariableLookup.size;
  }

  /** C#: VariablesGroupAsset.Keys */
  get Keys(): string[] {
    return [...this.m_VariableLookup.keys()];
  }

  /** C#: VariablesGroupAsset.Values */
  get Values(): IVariable[] {
    return [...this.m_VariableLookup.values()].map((s) => s.variable!);
  }

  /** C#: VariablesGroupAsset.GetSourceValue（回傳自己） */
  GetSourceValue(_selector: ISelectorInfo): CsValue {
    return cs.object(this);
  }

  /** C#: VariablesGroupAsset.TryGetValue */
  TryGetValue(name: string): IVariable | undefined {
    return this.m_VariableLookup.get(name)?.variable ?? undefined;
  }

  /** C#: VariablesGroupAsset.Add（同名直接丟 ArgumentException；LocalizedString.Add 才是替換） */
  Add(name: string, variable: IVariable): void {
    if (!name) throw new Error('name: Name must not be null or empty.');
    if (variable === null || variable === undefined) throw new Error('variable');
    name = ReplaceWhiteSpaces(name, '-');
    if (this.m_VariableLookup.has(name)) throw new Error(`An item with the same key has already been added. Key: ${name}`);
    const pair = new VariableNameValuePair();
    pair.name = name;
    pair.variable = variable;
    this.m_VariableLookup.set(name, pair);
    this.m_Variables.push(pair);
  }

  /** C#: VariablesGroupAsset.Remove */
  Remove(name: string): boolean {
    const hit = this.m_VariableLookup.get(name);
    if (hit !== undefined) {
      const i = this.m_Variables.indexOf(hit);
      if (i !== -1) this.m_Variables.splice(i, 1);
      this.m_VariableLookup.delete(name);
      return true;
    }
    return false;
  }

  /** C#: VariablesGroupAsset.ContainsKey */
  ContainsKey(name: string): boolean {
    return this.m_VariableLookup.has(name);
  }

  /** C#: VariablesGroupAsset.Clear */
  Clear(): void {
    this.m_VariableLookup.clear();
    this.m_Variables.length = 0;
  }
}

/** C#: PersistentVariables/NestedVariablesGroup.cs NestedVariablesGroup（Variable<VariablesGroupAsset> + IVariableGroup） */
export class NestedVariablesGroup extends Variable<VariablesGroupAsset | null> implements IVariableGroup {
  constructor(initial: VariablesGroupAsset | null = null) {
    super(initial);
  }

  /** C#: NestedVariablesGroup.TryGetValue */
  TryGetValue(name: string): IVariable | undefined {
    return this.Value !== null ? this.Value.TryGetValue(name) : undefined;
  }
}

/** C#: UnityEngine.Localization/StringExtensionMethods.cs StringExtensionMethods.ReplaceWhiteSpaces（\s+） */
export function ReplaceWhiteSpaces(str: string, replacement = ''): string {
  return str.replace(/\s+/g, replacement);
}

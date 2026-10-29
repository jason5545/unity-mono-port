// C#: UnityEngine.Localization/LocalizedString.cs LocalizedString（同步部分）、
//     StringTableEntryVariable（第 43 行）、ChainedLocalVariablesGroup（第 69 行）。
// 走上一輪的 Localization.stringWithArgs；區域變數（Add 進來的 IVariable）在格式化前掛到
// FormatCache.LocalVariables，接法照 GetLocalizedStringOperation.Execute（Operations/
// GetLocalizedStringOperation.cs 第 62-70 行）。
// 不在範圍：非同步 handle（GetLocalizedStringAsync／AsyncOperationHandle）、Addressables、
// StringChanged 的自動刷新（ForceUpdate、UpdateVariableListeners、Locale 變更重載）。
// 原版的建構子只要表與 key，字串庫是全域的 LocalizationSettings.StringDatabase；這個移植把
// Localization 實例傳進建構子（TS 沒有全域單例）。

import type { Localization, LocalizedReference } from './localization.ts';
import type { ISelectorInfo } from './smartFormat/interfaces.ts';
import {
  cs,
  ReplaceWhiteSpaces,
  type Action,
  type CsValue,
  type IMetadataVariable,
  type IVariable,
  type IVariableGroup,
  type IVariableValueChanged,
  VariableNameValuePair,
} from './smartFormat/index.ts';

/** C#: LocalizedString.cs 第 43 行 StringTableEntryVariable（private struct，IVariableGroup）。
 *  TryGetValue 找項目中繼資料裡的 IMetadataVariable；我們的資料沒有這種中繼資料（只有型別名的
 *  標記列表），所以預設是空清單。 */
export class StringTableEntryVariable implements IVariableGroup {
  /** C#: StringTableEntryVariable.m_Localized */
  private readonly m_Localized: string;
  /** C#: StringTableEntryVariable.m_StringTableEntry.MetadataEntries 裡的 IMetadataVariable */
  private readonly m_MetadataVariables: IMetadataVariable[];

  constructor(localized: string, metadataVariables: IMetadataVariable[] = []) {
    this.m_Localized = localized;
    this.m_MetadataVariables = metadataVariables;
  }

  /** C#: StringTableEntryVariable.TryGetValue（第 49 行） */
  TryGetValue(key: string): IVariable | undefined {
    for (const m of this.m_MetadataVariables) {
      if (m.VariableName === key) return m;
    }
    return undefined;
  }

  /** C#: StringTableEntryVariable.ToString（DefaultFormatter 用 obj.ToString() 寫出） */
  ToString(): string {
    return this.m_Localized;
  }

  /** JS 的字串轉換（對應 C# ToString） */
  toString(): string {
    return this.m_Localized;
  }
}

/** C#: LocalizedString.cs 第 69 行 ChainedLocalVariablesGroup（private struct，IVariableGroup）：
 *  先查內層（Group），找不到再查外層（ParentGroup）。 */
export class ChainedLocalVariablesGroup implements IVariableGroup {
  /** C#: ChainedLocalVariablesGroup.Group */
  private readonly Group: IVariableGroup;
  /** C#: ChainedLocalVariablesGroup.ParentGroup */
  private readonly ParentGroup: IVariableGroup | null;

  constructor(group: IVariableGroup, parent: IVariableGroup | null) {
    this.Group = group;
    this.ParentGroup = parent;
  }

  /** C#: ChainedLocalVariablesGroup.TryGetValue（第 81 行） */
  TryGetValue(key: string): IVariable | undefined {
    const hit = this.Group.TryGetValue(key);
    if (hit !== undefined) return hit;
    return this.ParentGroup?.TryGetValue(key) ?? undefined;
  }
}

/** C#: UnityEngine.Localization/LocalizedString.cs LocalizedString（同步部分；
 *  同時是 IVariableGroup、IVariable、IVariableValueChanged、IDictionary<string, IVariable>） */
export class LocalizedString implements IVariableGroup, IVariable, IVariableValueChanged {
  /** C#: LocalizedReference 基底（m_TableReference、m_TableEntryReference） */
  readonly ref: LocalizedReference;
  /** C#: LocalizedString.Arguments（第 117 行） */
  Arguments: readonly unknown[] | null = null;
  /** C#: LocalizedReference.LocaleOverride（m_LocaleOverride） */
  LocaleOverride: string | null = null;

  /** C#: LocalizedString.m_LocalVariables */
  private readonly m_LocalVariables: VariableNameValuePair[] = [];
  /** C#: LocalizedString.m_VariableLookup */
  private readonly m_VariableLookup = new Map<string, VariableNameValuePair>();
  private readonly listeners: Action<IVariable>[] = [];

  /** 原版用全域 LocalizationSettings.StringDatabase；這裡傳 Localization 實例（見檔頭） */
  constructor(
    private readonly loc: Localization,
    table: string,
    key: string,
  ) {
    this.ref = {
      m_TableReference: { m_TableCollectionName: table },
      m_TableEntryReference: { m_KeyId: 0, m_Key: key },
    };
  }

  /** C#: LocalizedReference.IsEmpty */
  get IsEmpty(): boolean {
    const e = this.ref.m_TableEntryReference;
    return !this.ref.m_TableReference.m_TableCollectionName || (Number(e.m_KeyId) === 0 && !e.m_Key);
  }

  /** C#: LocalizedString.Count */
  get Count(): number {
    return this.m_VariableLookup.size;
  }

  /** C#: LocalizedString.Keys */
  get Keys(): string[] {
    return [...this.m_VariableLookup.keys()];
  }

  /** C#: LocalizedString.Values */
  get Values(): IVariable[] {
    return [...this.m_VariableLookup.values()].map((s) => s.variable!);
  }

  /** C#: LocalizedString.Add(string, IVariable)（第 266 行；同名替換，先到先贏是 VariablesGroupAsset 的行為） */
  Add(name: string, variable: IVariable): void {
    if (!name) throw new Error('name: Name must not be null or empty.');
    if (variable === null || variable === undefined) throw new Error('variable');
    name = ReplaceWhiteSpaces(name, '-');
    const existing = this.m_VariableLookup.get(name);
    if (existing !== undefined) {
      if (existing.variable === variable) return;
      const i = this.m_LocalVariables.indexOf(existing);
      if (i !== -1) this.m_LocalVariables.splice(i, 1);
    }
    const pair = new VariableNameValuePair();
    pair.name = name;
    pair.variable = variable;
    this.m_VariableLookup.set(name, pair);
    this.m_LocalVariables.push(pair);
  }

  /** C#: LocalizedString.Remove(string) */
  Remove(name: string): boolean {
    const hit = this.m_VariableLookup.get(name);
    if (hit !== undefined) {
      const i = this.m_LocalVariables.indexOf(hit);
      if (i !== -1) this.m_LocalVariables.splice(i, 1);
      this.m_VariableLookup.delete(name);
      return true;
    }
    return false;
  }

  /** C#: LocalizedString.TryGetValue（第 255 行） */
  TryGetValue(name: string): IVariable | undefined {
    return this.m_VariableLookup.get(name)?.variable ?? undefined;
  }

  /** C#: LocalizedString.ContainsKey */
  ContainsKey(name: string): boolean {
    return this.m_VariableLookup.has(name);
  }

  /** C#: LocalizedString.Clear */
  Clear(): void {
    this.m_LocalVariables.length = 0;
    this.m_VariableLookup.clear();
  }

  /** C#: event Action<IVariable> ValueChanged 的 +=（自動刷新的事件源不在範圍，見檔頭） */
  AddValueChanged(handler: Action<IVariable>): void {
    this.listeners.push(handler);
  }

  /** C#: event Action<IVariable> ValueChanged 的 -= */
  RemoveValueChanged(handler: Action<IVariable>): void {
    const i = this.listeners.indexOf(handler);
    if (i !== -1) this.listeners.splice(i, 1);
  }

  /**
   * C#: LocalizedString.GetLocalizedString()（第 229 行）、GetLocalizedString(params object[])（第 239 行）、
   * GetLocalizedString(IList<object>)（第 244 行）。
   * TS 只有一個可變參數簽名：沒給參數用 Arguments 屬性；一個陣列引數視為 IList<object>；其他視為 params object[]。
   * 區域變數照第 252 行接：有 Add 過才把自己（IVariableGroup）交給格式化。
   */
  GetLocalizedString(...args: unknown[]): string {
    const list = args.length === 0 ? (this.Arguments ?? []) : args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    return this.loc.stringWithArgs(
      this.ref,
      list,
      this.LocaleOverride ?? this.loc.locale,
      this.m_VariableLookup.size > 0 ? this : null,
    );
  }

  /** C#: LocalizedString.GetSourceValue（第 363 行）：把另一條 LocalizedString 當區域變數用時的取值 */
  GetSourceValue(selector: ISelectorInfo): CsValue {
    if (this.IsEmpty) return cs.string('');
    // C#: 第 368-377 行的 locale 挑選：LocaleOverride → FormatCache.Table 的語言 → SelectedLocale
    let locale: string | null = this.LocaleOverride;
    if (locale === null && selector.FormatDetails.FormatCache !== null) {
      locale = selector.FormatDetails.FormatCache.Table?.LocaleIdentifier ?? null;
    }
    if (locale === null) locale = this.loc.locale;
    if (locale === null) return cs.string('<No Available Locale>');
    if (this.loc.findEntry(this.ref) === undefined) return cs.string('<Missing Entry>');
    const args = this.Arguments ?? [];
    if (!this.loc.isSmartEntry(this.ref, locale)) {
      // C#: 第 393-396 行（非 smart：只用 Arguments，不掛區域變數）
      return cs.object(new StringTableEntryVariable(this.loc.stringWithArgs(this.ref, args, locale, null)));
    }
    // C#: 第 398-427 行（smart：ChainedLocalVariablesGroup + 目前的值接到參數最前面）
    const outer = selector.FormatDetails.FormatCache?.LocalVariables ?? null;
    const chain: IVariableGroup | null = this.m_VariableLookup.size > 0 ? new ChainedLocalVariablesGroup(this, outer) : outer;
    const smartArgs = selector.CurrentValue.kind !== 'null' ? [selector.CurrentValue, ...args] : [...args];
    const localized = this.loc.stringWithArgs(this.ref, smartArgs, locale, chain);
    return cs.object(new StringTableEntryVariable(localized));
  }

  /** C#: IVariable.GetSourceValue 的變體是上面的 GetSourceValue；ToString 對應 C# Object（表名/key） */
  ToString(): string {
    return `${this.ref.m_TableReference.m_TableCollectionName}/${this.ref.m_TableEntryReference.m_Key}`;
  }
}

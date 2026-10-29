// Unity Localization（com.unity.localization，版本照 build 的 Unity.Localization.dll，10/5 反編譯讀）的執行時行為：
// 選語言、查字串與資產（含 fallback）、套用場景裡的 GameObjectLocalizer 與 LocalizeStringEvent。
//
// 資料：public/game/localization（scripts/import/localization.py）與 0a 的 data/i18n（表名 → key → 文字）。
// zh-TW 是這個移植加的（0a 用 OpenCC 從 zh-Hans 轉），原版沒有：這裡把它當成 fallback 到 zh-Hans 的語言，
// GameObjectLocalizer 沒有 zh-TW 的變體時，照 Unity 的規則退回專案語言 zh-Hans，字型、字級就跟簡中一樣。

import type { ComponentData, ExternalRef, Ref, SceneFile } from '../unity/types';
import {
  createSmartFormat,
  stringFormat,
  wrap,
  wrapStringFormatError,
  FormatCache,
  SmartFormatter,
  type CsValue,
  type FormatProvider,
  type IVariableGroup,
} from './smartFormat/index.ts';

export interface LocaleInfo {
  name: string;
  sortOrder: number;
  fallback: string[];
}

export interface LocalizationSettings {
  projectLocale: string;
  startupSelectors: ({ $type: string } & Record<string, unknown>)[];
  stringDatabase: { m_UseFallback: number; m_MissingTranslationState: number; m_NoTranslationFoundMessage: string };
  assetDatabase: { m_UseFallback: number };
  locales: Record<string, LocaleInfo>;
  /** settings.json 的 smartFormat（SmartFormatter 的序列化設定，給 createSmartFormat 用） */
  smartFormat?: Record<string, unknown>;
}

export interface TableInfo {
  name: string;
  kind: 'string' | 'asset';
  keys: Record<string, string>;
  /** 語言 → keyId → 項目的中繼資料型別（SmartFormatTag 等） */
  entryMetadata?: Record<string, Record<string, string[]>>;
}

/** LocalizedString／LocalizedAsset 的序列化欄位 */
export interface LocalizedReference {
  m_TableReference: { m_TableCollectionName: string };
  m_TableEntryReference: { m_KeyId: string | number; m_Key: string };
  m_FallbackState?: number; // 0 照專案設定、1 用 fallback、2 不用
}

type Strings = Record<string, Record<string, string>>; // 表名 → key → 文字
type Assets = Record<string, Record<string, Record<string, ExternalRef> | null>>; // 表名 → keyId → 型別 → 參照

export const TAIWAN = 'zh-TW';

/** 查詢結果的統計，給檢視頁的繪製報告用 */
export interface LocalizationStats {
  strings: number;
  fallback: number;
  missing: string[];
  smart: string[];
  assets: number;
  assetMissing: string[];
  variants: number;
}

export class Localization {
  readonly locales: Record<string, LocaleInfo>;
  readonly stats: LocalizationStats = { strings: 0, fallback: 0, missing: [], smart: [], assets: 0, assetMissing: [], variants: 0 };

  private constructor(
    readonly settings: LocalizationSettings,
    readonly tables: Record<string, TableInfo>,
    private readonly strings: Map<string, Strings>,
    private readonly assets: Map<string, Assets>,
    public locale: string,
  ) {
    this.locales = { ...settings.locales, [TAIWAN]: { name: 'Chinese (Taiwan) (zh-TW)', sortOrder: 10000, fallback: ['zh-Hans'] } };
  }

  /** 載入設定、表，以及選定語言的 fallback 鏈上每個語言的字串與資產表。
   *  locale 可以直接給，或給一個函式依設定挑（例如 selectStartupLocale） */
  static async load(base: string, locale: string | ((settings: LocalizationSettings, available: string[]) => string)): Promise<Localization> {
    // 沒有的檔案（例如 zh-TW 沒有資產表）：dev server 會回 index.html（200），所以看 content-type
    const json = <T>(url: string): Promise<T | null> =>
      fetch(url).then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? (r.json() as Promise<T>) : null));
    const [settings, tables] = await Promise.all([
      json<LocalizationSettings>(`${base}localization/settings.json`),
      json<Record<string, TableInfo>>(`${base}localization/tables.json`),
    ]);
    if (!settings || !tables) throw new Error('找不到 localization/，先跑 npm run import');
    const loc = new Localization(settings, tables, new Map(), new Map(), '');
    loc.locale = typeof locale === 'string' ? locale : locale(settings, Object.keys(loc.locales));
    locale = loc.locale;
    const codes = new Set([...loc.chain(locale), settings.projectLocale, ...loc.chain(settings.projectLocale)]);
    await Promise.all(
      [...codes].map(async (code) => {
        loc.strings.set(code, (await json<Strings>(`${base}data/i18n/${code}.json`)) ?? {});
        loc.assets.set(code, (await json<Assets>(`${base}localization/assets/${code}.json`)) ?? {});
      }),
    );
    return loc;
  }

  /** 測試用：直接給資料 */
  static fromData(settings: LocalizationSettings, tables: Record<string, TableInfo>, strings: Record<string, Strings>, assets: Record<string, Assets>, locale: string): Localization {
    return new Localization(settings, tables, new Map(Object.entries(strings)), new Map(Object.entries(assets)), locale);
  }

  /** 語言 + 它的 fallback（GetTableEntryOperation.GetNextFallback：廣度優先、每個語言只走一次） */
  chain(code: string): string[] {
    const out = [code];
    const seen = new Set(out);
    for (let i = 0; i < out.length; i++) {
      for (const f of this.locales[out[i]]?.fallback ?? []) {
        if (!seen.has(f)) {
          seen.add(f);
          out.push(f);
        }
      }
    }
    return out;
  }

  table(name: string): [string, TableInfo] | undefined {
    if (name.startsWith('GUID:')) {
      const g = name.slice(5);
      return this.tables[g] ? [g, this.tables[g]] : undefined;
    }
    const e = Object.entries(this.tables).find(([, t]) => t.name === name);
    return e;
  }

  /** TableEntryReference → keyId 與 key（KeyId 是 0 時用 m_Key 找） */
  private entry(t: TableInfo, ref: LocalizedReference): { id: string; key: string } | undefined {
    const e = ref.m_TableEntryReference;
    const id = String(e.m_KeyId);
    if (id !== '0' && t.keys[id] !== undefined) return { id, key: t.keys[id] };
    const found = Object.entries(t.keys).find(([, k]) => k === e.m_Key);
    return found ? { id: found[0], key: found[1] } : undefined;
  }

  private useFallback(ref: LocalizedReference, dbDefault: number): boolean {
    return ref.m_FallbackState === 1 || (!ref.m_FallbackState && !!dbDefault);
  }

  /** LocalizedStringDatabase.GetLocalizedString：找不到或空字串就照 fallback 鏈往下；都沒有時照 MissingTranslationState */
  string(ref: LocalizedReference, locale = this.locale): string {
    const name = ref.m_TableReference.m_TableCollectionName;
    const found = this.table(name);
    const entry = found && this.entry(found[1], ref);
    const codes = this.useFallback(ref, this.settings.stringDatabase.m_UseFallback) ? this.chain(locale) : [locale];
    if (found && entry) {
      for (const code of codes) {
        const text = this.strings.get(code)?.[found[1].name]?.[entry.key];
        if (text) {
          this.stats.strings++;
          if (code !== locale) this.stats.fallback++;
          if (found[1].entryMetadata?.[code]?.[entry.id]?.includes('SmartFormatTag')) this.stats.smart.push(`${found[1].name}/${entry.key}`);
          return text;
        }
      }
    }
    return this.processUntranslated(ref, found, name);
  }

  /** ProcessUntranslatedText：MissingTranslationState 有 ShowMissingTranslationMessage（1）就顯示訊息。
   *  key 名稱照 TableEntryReference.ResolveKeyName：用 id 參照時查共用表（查不到是空的；沒有表是 "Key Id N"），用名稱參照就是名稱 */
  private processUntranslated(ref: LocalizedReference, found: [string, TableInfo] | undefined, name: string): string {
    const id = String(ref.m_TableEntryReference.m_KeyId);
    const key = id !== '0' ? (found ? (found[1].keys[id] ?? '') : `Key Id ${id}`) : ref.m_TableEntryReference.m_Key;
    const tableName = found?.[1].name ?? name;
    this.stats.missing.push(`${tableName}/${key}`);
    if (this.settings.stringDatabase.m_MissingTranslationState & 1) {
      return this.settings.stringDatabase.m_NoTranslationFoundMessage.replace('{key}', key).replace('{table.TableCollectionName}', tableName);
    }
    return '';
  }

  /** LocalizedString.GetSourceValue 要分辨「項目不存在」（回 "<Missing Entry>"）與「有項目但文字空」 */
  findEntry(ref: LocalizedReference): { id: string; key: string } | undefined {
    const found = this.table(ref.m_TableReference.m_TableCollectionName);
    return found ? this.entry(found[1], ref) : undefined;
  }

  /** StringTableEntry.IsSmart 的對應：沿 fallback 鏈解到的語言（第一個有文字的）有沒有 SmartFormatTag。
   *  zh-TW 沿用 zh-Hans 的標記（這個移植加的語言）。 */
  isSmartEntry(ref: LocalizedReference, locale = this.locale): boolean {
    const found = this.table(ref.m_TableReference.m_TableCollectionName);
    const entry = found && this.entry(found[1], ref);
    const codes = this.useFallback(ref, this.settings.stringDatabase.m_UseFallback) ? this.chain(locale) : [locale];
    if (found && entry) {
      for (const code of codes) {
        const text = this.strings.get(code)?.[found[1].name]?.[entry.key];
        if (text) {
          const metaLang = code === TAIWAN ? 'zh-Hans' : code;
          return !!found[1].entryMetadata?.[metaLang]?.[entry.id]?.includes('SmartFormatTag');
        }
      }
    }
    return false;
  }

  /** StringTableEntry.GetLocalizedString(formatProvider, args) + GenerateLocalizedString：
   *  項目有 SmartFormatTag 才走 SmartFormat（FormatWithCache）；沒有、但有參數時照原版走 C# string.Format
   *  （見 smartFormat/stringFormat.ts）。zh-TW 是這個移植加的語言，smart 標記沿用 zh-Hans 同一個 keyId
   *  （跟原版的差異：原版沒有 zh-TW 表）。
   *  localVariables 對應 GetLocalizedStringOperation.Execute（第 62-70 行）：格式化前掛到
   *  FormatCache.LocalVariables，格式化後設回 null。 */
  stringWithArgs(
    ref: LocalizedReference,
    args: readonly (CsValue | unknown)[] = [],
    locale = this.locale,
    localVariables: IVariableGroup | null = null,
  ): string {
    const name = ref.m_TableReference.m_TableCollectionName;
    const found = this.table(name);
    const entry = found && this.entry(found[1], ref);
    const codes = this.useFallback(ref, this.settings.stringDatabase.m_UseFallback) ? this.chain(locale) : [locale];
    const wrapped = args.map(wrap);
    if (found && entry) {
      for (const code of codes) {
        const text = this.strings.get(code)?.[found[1].name]?.[entry.key];
        if (text) {
          this.stats.strings++;
          if (code !== locale) this.stats.fallback++;
          const metaLang = code === TAIWAN ? 'zh-Hans' : code;
          if (found[1].entryMetadata?.[metaLang]?.[entry.id]?.includes('SmartFormatTag')) {
            this.stats.smart.push(`${found[1].name}/${entry.key}`);
            const provider: FormatProvider = { Code: code };
            // C#: StringTableEntry.GetOrCreateFormatCache（第 90-97 行）＋ GetLocalizedStringOperation.Execute
            let cache = this.smartCache.get(text) ?? null;
            if (cache === null) {
              cache = new FormatCache(this.smart().Parser.ParseFormat(text, this.smart().GetNotEmptyFormatterExtensionNames()));
              this.smartCache.set(text, cache);
            }
            cache.LocalVariables = localVariables;
            cache.Table = { LocaleIdentifier: code };
            const result = this.smart().FormatWithCache(cache, text, provider, wrapped);
            cache.LocalVariables = null;
            return result.text;
          }
          if (wrapped.length > 0) {
            try {
              return stringFormat(text, wrapped, { Code: code });
            } catch (ex) {
              throw wrapStringFormatError(text, ex as Error);
            }
          }
          return text;
        }
      }
    }
    return this.processUntranslated(ref, found, name);
  }

  private smartInstance: SmartFormatter | null = null;
  private readonly smartCache = new Map<string, FormatCache>();

  /** LocalizedStringDatabase.SmartFormatter（照 settings.json 的 smartFormat 建一次） */
  private smart(): SmartFormatter {
    return (this.smartInstance ??= createSmartFormat(this.settings.smartFormat ?? {}));
  }

  /** LocalizedAssetDatabase：資產表的值，依使用端要的型別（Sprite、MonoBehaviour、Material…）挑 */
  asset(ref: LocalizedReference, type: string, locale = this.locale): ExternalRef | null {
    const found = this.table(ref.m_TableReference.m_TableCollectionName);
    const entry = found && this.entry(found[1], ref);
    const codes = this.useFallback(ref, this.settings.assetDatabase.m_UseFallback) ? this.chain(locale) : [locale];
    if (found && entry) {
      for (const code of codes) {
        const hit = this.assets.get(code)?.[found[1].name]?.[entry.id]?.[type];
        if (hit) {
          this.stats.assets++;
          return hit;
        }
      }
    }
    this.stats.assetMissing.push(`${found?.[1].name ?? '?'}/${entry?.key ?? ref.m_TableEntryReference.m_KeyId}:${type}`);
    return null;
  }
}

// ───────── 套用到場景 ─────────

interface VariantPair {
  localeIdentifier: { m_Code: string };
  value: unknown;
}
interface TrackedProperty {
  $type: string;
  m_PropertyPath: string;
  m_VariantData?: VariantPair[];
  m_Localized?: LocalizedReference & { $type: string };
}
interface TrackedObject {
  $type: string;
  m_Target: Ref;
  m_TrackedProperties: { items: (TrackedProperty | null)[] };
}

/** LocalizedAssetBase 子類別 → 資產表裡要挑的型別 */
const ASSET_TYPE: Record<string, string> = {
  LocalizedSprite: 'Sprite',
  LocalizedTexture: 'Texture2D',
  LocalizedMaterial: 'Material',
  LocalizedTmpFont: 'MonoBehaviour',
  LocalizedFont: 'Font',
  LocalizedAudioClip: 'AudioClip',
  LocalizedGameObject: 'GameObject',
};

/** "m_Options.m_Options.Array.data[0].m_Text" → ['m_Options', 'm_Options', 0, 'm_Text']（Unity 的 SerializedProperty 路徑） */
export function propertyPath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const part of path.split('.')) {
    if (part === 'Array') continue;
    const m = /^data\[(\d+)\]$/.exec(part);
    out.push(m ? Number(m[1]) : part);
  }
  return out;
}

function setPath(target: Record<string, unknown>, path: (string | number)[], value: unknown): boolean {
  let cur: unknown = target;
  for (let i = 0; i < path.length - 1; i++) {
    cur = (cur as Record<string | number, unknown>)?.[path[i]];
    if (cur === undefined || cur === null) return false;
  }
  (cur as Record<string | number, unknown>)[path[path.length - 1]] = value;
  return true;
}

/** TrackedProperty.GetValue(locale, 專案語言)：先找這個語言，沒有就用專案語言的值 */
function variant(p: TrackedProperty, locale: string, projectLocale: string): { found: boolean; value: unknown } {
  const data = p.m_VariantData ?? [];
  const hit = data.find((v) => v.localeIdentifier.m_Code === locale) ?? data.find((v) => v.localeIdentifier.m_Code === projectLocale);
  return hit ? { found: true, value: hit.value } : { found: false, value: null };
}

/**
 * 把語言套用到場景資料（直接改元件的欄位，排版之前呼叫）。
 * GameObjectLocalizer（JsonSerializerTrackedObject.ApplyLocale）：數值、列舉、字串變體找不到就不動；
 * UnityObjectProperty 找不到時設成 null（原始碼就是這樣）；LocalizedString／LocalizedAsset 交給資料庫查。
 * LocalizeStringEvent：m_UpdateString 的 set_text／SetText 都是把 TMP 的 m_text 設成查到的字串。
 * 只處理 m_Enabled 的元件（停用的元件在原版不會執行）。
 */
export function applyLocalization(file: SceneFile, loc: Localization): { applied: number; skipped: string[] } {
  const comps = file.components as Record<string, ComponentData>;
  return applyLocalizationToComponents(comps, Object.values(comps), loc);
}

/**
 * 只對 list 裡的元件套用語言（target 的查找仍然走整個 comps）。生成出來的 prefab 用這個：
 * 只套新生成的那棵子樹，不動場景裡其他元件（它們的文字可能是引擎執行期寫進去的）。
 */
export function applyLocalizationToComponents(
  comps: Record<string, ComponentData>,
  list: readonly ComponentData[],
  loc: Localization,
): { applied: number; skipped: string[] } {
  const project = loc.settings.projectLocale;
  const skipped: string[] = [];
  let applied = 0;
  for (const c of list) {
    if (!c.m_Enabled) continue;
    const cls = c.script?.class;
    if (cls === 'GameObjectLocalizer') {
      for (const t of (c.m_TrackedObjects as TrackedObject[] | undefined) ?? []) {
        const target = t?.m_Target && 'fileID' in t.m_Target ? comps[t.m_Target.fileID] : undefined;
        if (!target) {
          skipped.push(`${c.gameObject}: ${t?.$type} 沒有 m_Target`);
          continue;
        }
        for (const p of t.m_TrackedProperties.items) {
          if (!p) continue;
          const path = propertyPath(p.m_PropertyPath);
          let value: unknown;
          if (p.$type === 'LocalizedStringProperty') {
            if (!p.m_Localized?.m_TableReference.m_TableCollectionName) continue;
            value = loc.string(p.m_Localized);
          } else if (p.$type === 'LocalizedAssetProperty') {
            const l = p.m_Localized;
            if (!l?.m_TableReference.m_TableCollectionName) continue;
            const type = ASSET_TYPE[l.$type];
            if (!type) {
              skipped.push(`${c.gameObject}: 不認得的 ${l.$type}`);
              continue;
            }
            value = loc.asset(l, type);
          } else if (p.$type === 'UnityObjectProperty') {
            value = variant(p, loc.locale, project).value; // 找不到就是 null
          } else if (p.$type === 'ArraySizeTrackedProperty') {
            skipped.push(`${c.gameObject}: ArraySizeTrackedProperty 還沒做`);
            continue;
          } else {
            const v = variant(p, loc.locale, project);
            if (!v.found) continue;
            value = v.value;
          }
          if (setPath(target, path, value)) {
            applied++;
            loc.stats.variants++;
          } else skipped.push(`${c.gameObject}: ${target.type} 沒有 ${p.m_PropertyPath}`);
        }
      }
    } else if (cls === 'LocalizeStringEvent') {
      const ref = c.m_StringReference as LocalizedReference;
      if (!ref?.m_TableReference?.m_TableCollectionName) continue;
      const text = loc.string(ref);
      const calls = (c.m_UpdateString as { m_PersistentCalls: { m_Calls: { m_Target: Ref; m_MethodName: string }[] } }).m_PersistentCalls.m_Calls;
      for (const call of calls) {
        const target = call.m_Target && 'fileID' in call.m_Target ? comps[call.m_Target.fileID] : undefined;
        if (target && (call.m_MethodName === 'set_text' || call.m_MethodName === 'SetText')) {
          target.m_text = text;
          applied++;
        } else skipped.push(`${c.gameObject}: LocalizeStringEvent 呼叫 ${call.m_MethodName}`);
      }
    }
  }
  return { applied, skipped };
}

/** 啟動時選語言（LocalizationSettings 的 startupSelectors 依序試）。網頁版：玩家偏好存在 localStorage，系統語言用 navigator.languages */
export function selectStartupLocale(
  settings: LocalizationSettings,
  available: string[],
  env: { playerPref?: string | null; systemLanguages?: readonly string[] },
): string {
  for (const s of settings.startupSelectors) {
    if (s.$type === 'PlayerPrefLocaleSelector' && env.playerPref && available.includes(env.playerPref)) return env.playerPref;
    if (s.$type === 'SystemLocaleSelector') {
      for (const lang of env.systemLanguages ?? []) {
        if (available.includes(lang)) return lang;
        const base = lang.split('-')[0];
        const match = available.find((a) => a === base || a.startsWith(`${base}-`));
        if (match) return match;
      }
    }
    if (s.$type === 'SpecificLocaleSelector') {
      const code = (s.m_LocaleId as { m_Code: string }).m_Code;
      if (available.includes(code)) return code;
    }
  }
  return settings.projectLocale;
}

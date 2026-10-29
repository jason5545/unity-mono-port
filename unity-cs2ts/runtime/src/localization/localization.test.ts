// localization.ts 的測試，用真的匯入資料（public/game，先跑 npm run import）。
// 期望值是 10/5 實際套用 level1 的結果；規則（fallback、缺翻譯訊息、變體退回專案語言）照 Unity.Localization 反編譯的原始碼。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SceneFile } from '../unity/types';
import { applyLocalization, Localization, propertyPath, selectStartupLocale, TAIWAN, type LocalizationSettings } from './localization';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}
const settings = load<LocalizationSettings>('localization/settings.json');
const tables = load<Record<string, never>>('localization/tables.json');

function make(locale: string): Localization {
  const codes = locale === TAIWAN ? [TAIWAN, 'zh-Hans'] : [locale, 'zh-Hans', 'en'];
  const strings = Object.fromEntries(codes.map((c) => [c, load(`data/i18n/${c}.json`)]));
  const assets = Object.fromEntries(codes.map((c) => [c, existsSync(resolve(GAME, `localization/assets/${c}.json`)) ? load(`localization/assets/${c}.json`) : {}]));
  return Localization.fromData(settings, tables, strings, assets, locale);
}

/** level1 主選單按鈕：GameObject 名稱 → [文字, 字型資產名稱, 字型樣式] */
function menu(file: SceneFile): Record<string, [unknown, string, unknown]> {
  const mb = load<Record<string, { name: string }>>('assets/monobehaviours.json');
  const out: Record<string, [unknown, string, unknown]> = {};
  for (const c of Object.values(file.components)) {
    const go = file.gameObjects[c.gameObject];
    if (c.script?.class === 'TextMeshProUGUI' && go.m_IsActive && ['continue', 'setting', 'Quit'].includes(go.m_Name)) {
      out[go.m_Name] = [c.m_text, mb[(c.m_fontAsset as { guid: string }).guid].name, c.m_fontStyle];
    }
  }
  return out;
}

describe('Unity Localization 的執行時行為', () => {
  it('fallback 鏈：ja → en（原版 Locale 的 FallbackLocale）；zh-TW → zh-Hans（這個移植加的）', () => {
    const loc = make('en');
    expect(loc.chain('ja')).toEqual(['ja', 'en']);
    expect(loc.chain('zh-Hans')).toEqual(['zh-Hans']);
    expect(loc.chain(TAIWAN)).toEqual([TAIWAN, 'zh-Hans']);
  });

  it('找不到的 key 顯示原版設定的缺翻譯訊息（MissingTranslationState 1）', () => {
    const loc = make('en');
    const text = loc.string({ m_TableReference: { m_TableCollectionName: 'UI' }, m_TableEntryReference: { m_KeyId: 0, m_Key: 'no-such-key' } });
    expect(text).toBe("No translation found for 'no-such-key' in UI");
    expect(loc.stats.missing).toEqual(['UI/no-such-key']);
  });

  it('SerializedProperty 路徑：Array.data[i] 變成陣列索引', () => {
    expect(propertyPath('m_Options.m_Options.Array.data[1].m_Text')).toEqual(['m_Options', 'm_Options', 1, 'm_Text']);
    expect(propertyPath('m_SizeDelta.x')).toEqual(['m_SizeDelta', 'x']);
  });

  it('level1 套英文：主選單文字換成英文、字型 Biko_Bold、正體字樣；0 缺翻譯、0 跳過', () => {
    const file = load<SceneFile>('scenes/level1.json');
    const loc = make('en');
    const r = applyLocalization(file, loc);
    expect(r.skipped).toEqual([]);
    expect(r.applied).toBe(126);
    expect(loc.stats.missing).toEqual([]);
    expect(menu(file)).toEqual({
      continue: ['CONTINUE', 'Biko_Bold SDF', 0],
      setting: ['SETTINGS', 'Biko_Bold SDF', 0],
      Quit: ['QUIT', 'Biko_Bold SDF', 0],
    });
  });

  it('level1 套 zh-TW：文字是 OpenCC 轉的臺灣正體；沒有 zh-TW 變體的屬性退回專案語言 zh-Hans（斜體 2）', () => {
    const file = load<SceneFile>('scenes/level1.json');
    const loc = make(TAIWAN);
    const r = applyLocalization(file, loc);
    expect(r.skipped).toEqual([]);
    expect(loc.stats.missing).toEqual([]);
    expect(menu(file)).toEqual({
      continue: ['繼續', 'Biko_Bold SDF', 2],
      setting: ['設定', 'Biko_Bold SDF', 2],
      Quit: ['退出', 'Biko_Bold SDF', 2],
    });
  });

  it('標題圖依語言換（資產表 Main）：en → title_white_en，zh-TW → 管線合成的繁體 title_white_tw，zh-Hans → title_white_cn', () => {
    const sprites = load<Record<string, { m_Name: string }>>('assets/sprites.json');
    const title = (locale: string) => {
      const file = load<SceneFile>('scenes/level1.json');
      applyLocalization(file, make(locale));
      return Object.values(file.components)
        .filter((c) => c.script?.class === 'Image' && file.gameObjects[c.gameObject].m_Name === 'title')
        .map((c) => sprites[(c.m_Sprite as { guid: string }).guid].m_Name);
    };
    expect(title('en')).toEqual(['title_white_en']);
    // 原版只有簡體標題圖；zh-TW 的資產表指到 assets.py export_taiwan_title 合成的 title_white_tw（見 HANDOFF「與原版的差異」）
    expect(title(TAIWAN)).toEqual(['title_white_tw']);
    expect(title('zh-Hans')).toEqual(['title_white_cn']);
  });

  it('啟動選語言：玩家偏好 → 系統語言 → 指定英文', () => {
    const avail = ['zh-Hans', 'en', 'ja', TAIWAN];
    expect(selectStartupLocale(settings, avail, { playerPref: 'ja', systemLanguages: ['zh-TW'] })).toBe('ja');
    expect(selectStartupLocale(settings, avail, { systemLanguages: ['zh-TW', 'en'] })).toBe(TAIWAN);
    expect(selectStartupLocale(settings, avail, { systemLanguages: ['ko-KR'] })).toBe('en');
  });
});

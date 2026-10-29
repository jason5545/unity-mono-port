// LocalizedString（區域變數 PersistentVariables）的標準答案與行為測試。
// 標準答案照 DLL（UnityEngine.Localization/LocalizedString.cs、SmartFormat.PersistentVariables/*、
// Extensions/PersistentVariablesSource.cs）與遊戲程式碼（Utilities/DitwUtil.cs 的 AddRuleNumberToLocalizedString
// ／AddPluralIndicator、Rest/RestOptionHeal.cs）手算，用真的字串表逐字比對。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Localization, type LocalizationSettings, type TableInfo } from './localization.ts';
import { LocalizedString } from './localizedString.ts';
import { cs, FloatVariable, FormattingException, IntVariable, StringVariable } from './smartFormat/index.ts';
import { TEST_GAME } from '../testData';

const GAME = TEST_GAME;
function load<T>(p: string): T {
  const f = resolve(GAME, p);
  if (!existsSync(f)) throw new Error(`找不到 ${f}，先跑 npm run import`);
  return JSON.parse(readFileSync(f, 'utf-8')) as T;
}
const settings = load<LocalizationSettings>('localization/settings.json');
const tables = load<Record<string, TableInfo>>('localization/tables.json');

function make(locale: string): Localization {
  const codes = locale === 'zh-TW' ? ['zh-TW', 'zh-Hans'] : [locale, 'zh-Hans', 'en'];
  const strings = Object.fromEntries(codes.map((c) => [c, load(`data/i18n/${c}.json`)]));
  return Localization.fromData(settings, tables, strings, {}, locale);
}

describe('LocalizedString 標準答案（照 DLL 與遊戲程式碼手算）', () => {
  it('1–2 en Encyclopedia/MaxHandDescription：{RuleNumber} 讀參數字典、{rule_number} 讀區域變數決定單複數', () => {
    const loc = make('en');
    // 字串：`You can hold a maximum of {RuleNumber} {rule_number:card|cards} in hand at a time, you may not draw any further.`
    const L1 = new LocalizedString(loc, 'Encyclopedia', 'MaxHandDescription');
    L1.Add('rule_number', new IntVariable(16));
    expect(L1.GetLocalizedString({ RuleNumber: '16' })).toBe('You can hold a maximum of 16 cards in hand at a time, you may not draw any further.');
    const L2 = new LocalizedString(loc, 'Encyclopedia', 'MaxHandDescription');
    L2.Add('rule_number', new IntVariable(1));
    expect(L2.GetLocalizedString({ RuleNumber: '1' })).toBe('You can hold a maximum of 1 card in hand at a time, you may not draw any further.');
  });

  it('3–5 ru Encyclopedia/MaxHandDescription（`{rule_number:p(ru):карта|карты|карт}`）', () => {
    const loc = make('ru');
    const t = (n: number, display: string) => {
      const L = new LocalizedString(loc, 'Encyclopedia', 'MaxHandDescription');
      L.Add('rule_number', new IntVariable(n));
      return L.GetLocalizedString({ RuleNumber: display });
    };
    expect(t(16, '16')).toBe('Максимум у вас в руке может быть 16 карт — вы не можете вытянуть больше.');
    expect(t(21, '21')).toBe('Максимум у вас в руке может быть 21 карта — вы не можете вытянуть больше.');
    expect(t(22, '22')).toBe('Максимум у вас в руке может быть 22 карты — вы не можете вытянуть больше.');
  });

  it('6–8 en EffectDescription/Key_DrawCards：骰子的區域變數 99 決定複數；區域優先於參數字典', () => {
    const loc = make('en');
    // 字串：`Draw {Number} {number:p:card|cards}.`
    const L6 = new LocalizedString(loc, 'EffectDescription', 'Key_DrawCards');
    L6.Add('number', new IntVariable(99)); // DitwUtil.AddPluralIndicator：骰子數字一律 99
    expect(L6.GetLocalizedString({ Number: '1d6' })).toBe('Draw 1d6 cards.');
    const L7 = new LocalizedString(loc, 'EffectDescription', 'Key_DrawCards');
    L7.Add('number', new IntVariable(5));
    expect(L7.GetLocalizedString({ Number: '5', number: cs.int(1) })).toBe('Draw 5 cards.');
    const L8 = new LocalizedString(loc, 'EffectDescription', 'Key_DrawCards');
    expect(L8.GetLocalizedString({ Number: '5', number: cs.int(1) })).toBe('Draw 5 card.');
  });

  it('9 en UI/RestHealOption：Number 是 StringVariable 的顯示字串（照 Rest/RestOptionHeal.cs 第 14-21 行）', () => {
    const loc = make('en');
    // 字串：`Heal {Number} HP`
    const L = new LocalizedString(loc, 'UI', 'RestHealOption');
    L.Add('Number', new StringVariable('15'));
    L.Add('number', new IntVariable(15));
    expect(L.GetLocalizedString()).toBe('Heal 15 HP');
  });
});

describe('LocalizedString 的行為（照 DLL）', () => {
  it('ValueChanged：值相同不發事件（Variable.cs 的 Value setter），設新值剛好一次；換個值格式化結果跟著變', () => {
    const v = new IntVariable();
    v.Value = 3;
    let calls = 0;
    const handler = () => {
      calls++;
    };
    v.AddValueChanged(handler);
    v.Value = 3;
    expect(calls).toBe(0);
    v.Value = 4;
    expect(calls).toBe(1);
    const loc = make('en');
    const L = new LocalizedString(loc, 'EffectDescription', 'Key_DrawCards');
    L.Add('number', v);
    expect(L.GetLocalizedString({ Number: '4' })).toBe('Draw 4 cards.');
  });

  it('巢狀：ChainedLocalVariablesGroup 先查內層、內層有就用內層，找不到才查外層（LocalizedString.cs 第 81 行）', () => {
    const loc = make('en');
    const inner = new LocalizedString(loc, 'EffectDescription', 'Key_DrawCards');
    inner.Add('number', new IntVariable(1)); // 內層有 number → 1 → "card"
    const outer = new LocalizedString(loc, 'Encyclopedia', 'MaxHandDescription');
    outer.Add('RuleNumber', inner); // {RuleNumber} → 內層 LocalizedString 的字串
    outer.Add('rule_number', new IntVariable(16)); // 外層自己的複數 → "cards"
    outer.Add('Number', new StringVariable('9')); // 內層沒有 Number → 往外層找 → "9"
    outer.Add('number', new IntVariable(7)); // 內層有 number=1，這個 7 不會被用到（7 會給 "cards"）
    expect(outer.GetLocalizedString({})).toBe('You can hold a maximum of Draw 9 card. cards in hand at a time, you may not draw any further.');
  });

  it('型別：FloatVariable 回 cs.float，OrdinalFormatter 只收 int → FormattingException', () => {
    const loc = make('en');
    const L = new LocalizedString(loc, 'Relic', 'Wrench_SpDes');
    L.Add('number', new FloatVariable(1.5));
    let thrown: unknown;
    try {
      L.GetLocalizedString({ Number: '1' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FormattingException);
    expect((thrown as FormattingException).message).toContain('No suitable Formatter could be found');
  });
});

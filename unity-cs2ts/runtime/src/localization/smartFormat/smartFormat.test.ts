// SmartFormat 移植的驗收測試（C：標準答案）＋設定涵蓋。
// 標準答案是照 DLL 手算的，用真的字串表（public/game，先跑 npm run import）逐字比對。
// 期望字串裡的 `·` 代表一個空白（寫在註解裡），程式裡是真正的空白。
// 規則依據：reference/decompiled/Unity.Localization/UnityEngine.Localization.SmartFormat*。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Localization, type LocalizationSettings, type TableInfo } from '../localization.ts';
import { createSmartFormat, cs, FormattingException, StringFormatException, stringFormat, wrapStringFormatError } from './index.ts';
import type { CsValue } from './values.ts';
import { TEST_GAME } from '../../testData';

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

const ref = (table: string, key: string) => ({
  m_TableReference: { m_TableCollectionName: table },
  m_TableEntryReference: { m_KeyId: 0, m_Key: key },
});

/** 參數照驗收規格：字串裡的每個 selector 名稱都對到同一個 C# int 值 */
function args(pairs: Record<string, CsValue>): CsValue[] {
  return [cs.dict(Object.entries(pairs))];
}

describe('SmartFormat 標準答案（照 DLL 手算）', () => {
  it('1–3 en EffectDescription/Key_DrawCards：DualOneOther 兩種時 n≠1 取第二種（`Draw {Number} {number:p:card|cards}.`）', () => {
    const loc = make('en');
    expect(loc.stringWithArgs(ref('EffectDescription', 'Key_DrawCards'), args({ Number: cs.int(1), number: cs.int(1) }))).toBe('Draw 1 card.');
    expect(loc.stringWithArgs(ref('EffectDescription', 'Key_DrawCards'), args({ Number: cs.int(3), number: cs.int(3) }))).toBe('Draw 3 cards.');
    // n=0 → DualOneOther(0,2)=1 → "cards"
    expect(loc.stringWithArgs(ref('EffectDescription', 'Key_DrawCards'), args({ Number: cs.int(0), number: cs.int(0) }))).toBe('Draw 0 cards.');
  });

  it('4 fr 同一條（fr 表是英文佔位）：DualFromZeroToTwo 的 0 和 1 都取第一種', () => {
    const loc = make('fr');
    expect(loc.stringWithArgs(ref('EffectDescription', 'Key_DrawCards'), args({ Number: cs.int(0), number: cs.int(0) }))).toBe('Draw 0 card.');
  });

  it('5–10 ru EffectDescription/Key_DrawCards（`{number:p(ru):карту|карты|карт}`）', () => {
    const loc = make('ru');
    const t = (n: number) => loc.stringWithArgs(ref('EffectDescription', 'Key_DrawCards'), args({ Number: cs.int(n), number: cs.int(n) }));
    expect(t(1)).toBe('Вытяните 1 карту.');
    expect(t(2)).toBe('Вытяните 2 карты.');
    expect(t(5)).toBe('Вытяните 5 карт.');
    expect(t(11)).toBe('Вытяните 11 карт.');
    expect(t(21)).toBe('Вытяните 21 карту.');
    expect(t(22)).toBe('Вытяните 22 карты.');
  });

  it('11–12 pl：Polish 回 2 時只有兩種選項 → FormattingException("Invalid number of plural parameters")；n=22 不丟', () => {
    const loc = make('pl');
    let thrown: unknown;
    try {
      loc.stringWithArgs(ref('EffectDescription', 'Key_DrawCards'), args({ Number: cs.int(12), number: cs.int(12) }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FormattingException);
    expect((thrown as FormattingException).message).toContain('Invalid number of plural parameters');
    expect(loc.stringWithArgs(ref('EffectDescription', 'Key_DrawCards'), args({ Number: cs.int(22), number: cs.int(22) }))).toBe('Draw 22 cards.');
  });

  it('13–14 en Relic/BattleStartCoolDown（`Each {Number: time|{} times} when the combat starts, `，隱含 plural）', () => {
    const loc = make('en');
    // 期望 `Each··time when the combat starts,·`（Each 後兩個空白，結尾一個空白）
    expect(loc.stringWithArgs(ref('Relic', 'BattleStartCoolDown'), args({ Number: cs.int(1) }))).toBe('Each  time when the combat starts, ');
    // 期望 `Each 3 times when the combat starts,·`（{} 是目前的值）
    expect(loc.stringWithArgs(ref('Relic', 'BattleStartCoolDown'), args({ Number: cs.int(3) }))).toBe('Each 3 times when the combat starts, ');
  });

  it('15–16 ru Relic/BattleStartCoolDown（`{Number:p(ru): Каждый раз|Каждые {} раза|Каждые {} раз}`）', () => {
    const loc = make('ru');
    // 期望 `·Каждый раз, как начинается бой,·`
    expect(loc.stringWithArgs(ref('Relic', 'BattleStartCoolDown'), args({ Number: cs.int(1) }))).toBe(' Каждый раз, как начинается бой, ');
    // 期望 `Каждые 5 раз, как начинается бой,·`
    expect(loc.stringWithArgs(ref('Relic', 'BattleStartCoolDown'), args({ Number: cs.int(5) }))).toBe('Каждые 5 раз, как начинается бой, ');
  });

  it('17–18 en Relic/Wrench_SpDes：{Number}{number:ordinal()} 的序數詞尾', () => {
    const loc = make('en');
    const t = (n: number) =>
      loc.stringWithArgs(
        ref('Relic', 'Wrench_SpDes'),
        args({ Number: cs.int(n), number: cs.int(n), Number2: cs.int(1), number2: cs.int(1) }),
      );
    expect(t(1).startsWith('At the start of the 1st turn')).toBe(true);
    expect(t(2).startsWith('At the start of the 2nd turn')).toBe(true);
    expect(t(3).startsWith('At the start of the 3rd turn')).toBe(true);
    expect(t(11).startsWith('At the start of the 11th turn')).toBe(true);
    expect(t(12).startsWith('At the start of the 12th turn')).toBe(true);
    expect(t(13).startsWith('At the start of the 13th turn')).toBe(true);
    expect(t(21).startsWith('At the start of the 21st turn')).toBe(true);
    expect(t(22).startsWith('At the start of the 22nd turn')).toBe(true);
    expect(t(23).startsWith('At the start of the 23rd turn')).toBe(true);
    expect(t(111).startsWith('At the start of the 111th turn')).toBe(true);
    expect(t(112).startsWith('At the start of the 112th turn')).toBe(true);
  });

  it('19 en Relic/Wrench_SpDes：number 傳 C# float 1 → OrdinalFormatter 只收 int，指定名字就只試那一個', () => {
    const loc = make('en');
    let thrown: unknown;
    try {
      loc.stringWithArgs(
        ref('Relic', 'Wrench_SpDes'),
        args({ Number: cs.int(1), number: cs.float(1), Number2: cs.int(1), number2: cs.int(1) }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FormattingException);
    expect((thrown as FormattingException).message).toContain('No suitable Formatter could be found');
  });

  it('20 pt-BR 直接格式化：pt 只寫符號不寫數字（`{0}{0:ordinal()}`／`{0:ordinal(f)}`，int 1）', () => {
    const smart = createSmartFormat(settings.smartFormat!);
    expect(smart.Format({ Code: 'pt-BR' }, [cs.int(1)], '{0}{0:ordinal()}')).toBe('1º');
    expect(smart.Format({ Code: 'pt-BR' }, [cs.int(1)], '{0:ordinal(f)}')).toBe('ª');
  });

  it('21–22 zh-Hans 與 zh-TW EffectDescription/Key_DrawCards', () => {
    expect(make('zh-Hans').stringWithArgs(ref('EffectDescription', 'Key_DrawCards'), args({ Number: cs.int(3) }))).toBe('抽3张牌。');
    // zh-TW 是這個移植加的（OpenCC 從 zh-Hans 轉），複數規則用 zh（原版沒有這個語言）
    expect(make('zh-TW').stringWithArgs(ref('EffectDescription', 'Key_DrawCards'), args({ Number: cs.int(3) }))).toBe('抽3張牌。');
  });
});

describe('設定涵蓋：settings.json 的 10 個 Formatter、7 個 Source 都有實作且照順序註冊', () => {
  const smart = createSmartFormat(settings.smartFormat!);
  const json = settings.smartFormat as { m_Formatters: { $type: string }[]; m_Sources: { $type: string }[] };

  it('Formatter 依序是 ListFormatter、PluralLocalizationFormatter、ConditionalFormatter、TimeFormatter、XElementFormatter、ChooseFormatter、SubStringFormatter、IsMatchFormatter、OrdinalFormatter、DefaultFormatter', () => {
    expect(smart.FormatterExtensions.map((f) => f.constructor.name)).toEqual(json.m_Formatters.map((f) => f.$type));
    expect(smart.FormatterExtensions.map((f) => f.constructor.name)).toEqual([
      'ListFormatter',
      'PluralLocalizationFormatter',
      'ConditionalFormatter',
      'TimeFormatter',
      'XElementFormatter',
      'ChooseFormatter',
      'SubStringFormatter',
      'IsMatchFormatter',
      'OrdinalFormatter',
      'DefaultFormatter',
    ]);
  });

  it('Source 依序是 ListFormatter、PersistentVariablesSource、DictionarySource、ValueTupleSource、XmlSource、ReflectionSource、DefaultSource', () => {
    expect(smart.SourceExtensions.map((s) => s.constructor.name)).toEqual(json.m_Sources.map((s) => s.$type));
    expect(smart.SourceExtensions.map((s) => s.constructor.name)).toEqual([
      'ListFormatter',
      'PersistentVariablesSource',
      'DictionarySource',
      'ValueTupleSource',
      'XmlSource',
      'ReflectionSource',
      'DefaultSource',
    ]);
  });

  it('Formatter 的 Names 照 settings.json 的 m_Names（含空字串的名字）', () => {
    const jsonNames = json.m_Formatters.map((f) => (f as { m_Names?: string[] }).m_Names);
    expect(smart.FormatterExtensions.map((f) => f.Names)).toEqual(jsonNames);
    expect(smart.GetNotEmptyFormatterExtensionNames()).toEqual([
      'list',
      'l',
      'plural',
      'p',
      'conditional',
      'cond',
      'timespan',
      'time',
      't',
      'xelement',
      'xml',
      'x',
      'choose',
      'c',
      'substr',
      'ismatch',
      'ordinal',
      'default',
      'd',
    ]);
  });
});

describe('Parser 與非 smart 項目的行為', () => {
  const smart = createSmartFormat(settings.smartFormat!);

  it('跳脫的大括號輸出成真的大括號；{{ }} 是雙重大括號跳脫', () => {
    expect(smart.Format({ Code: 'en' }, [], '\\{a\\}')).toBe('{a}');
    expect(smart.Format({ Code: 'en' }, [], '{{a}}')).toBe('{a}');
  });

  it('字元跳脫：\\n 換行、\\uXXXX 是萬國碼（ConvertCharacterStringLiterals 1）', () => {
    expect(smart.Format({ Code: 'en' }, [], 'a\\nb')).toBe('a\nb');
    expect(smart.Format({ Code: 'en' }, [], 'a\\u3000b')).toBe('a\u3000b');
  });

  it('FormatErrorAction 0（ThrowError）：selector 查不到丟 FormattingException；ParseErrorAction 0 解析錯誤丟 ParsingErrors', () => {
    expect(() => smart.Format({ Code: 'en' }, [cs.int(1)], '{Nope}')).toThrow('Could not evaluate the selector');
    // {1} 的索引超出參數數目（DefaultSource 只接 result < OriginalArgs.Count）
    expect(() => smart.Format({ Code: 'en' }, [cs.int(1)], '{1}')).toThrow('Could not evaluate the selector');
    expect(() => smart.Parser.ParseFormat('{a', smart.GetNotEmptyFormatterExtensionNames())).toThrow('The format string has 1 issue');
  });

  it('非 smart 項目有參數：照原版走 C# string.Format，格式不對丟 FormatException 並包上「Ensure that the string is marked as Smart」', () => {
    // KeyWord/GenCardInfoPlaceHolder 是非 smart：`{Type} Card` 對 string.Format 來說是壞格式
    const loc = make('en');
    let thrown: unknown;
    try {
      loc.stringWithArgs(ref('KeyWord', 'GenCardInfoPlaceHolder'), [cs.string('Dice')]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(StringFormatException);
    expect((thrown as Error).message).toContain('Ensure that the string is marked as Smart');
    // 沒有參數時原樣回傳（StringTableEntry.GetLocalizedString 的 else 分支）
    expect(loc.stringWithArgs(ref('KeyWord', 'GenCardInfoPlaceHolder'))).toBe('{Type} Card');
    // 一般字串：{0} 這種索引格式能用（C# string.Format）
    expect(loc.stringWithArgs(ref('KeyWord', 'ManaPlaceHolder'), [])).toBe('{Mana}');
  });

  it('string.Format：{{ }} 跳脫、{0,3} 對齊、壞格式丟 FormatException（wrapStringFormatError 包裝）', () => {
    expect(stringFormat('{{{0}}}', [cs.int(7)])).toBe('{7}');
    expect(stringFormat('[{0,3}]', [cs.int(7)])).toBe('[  7]');
    expect(stringFormat('[{0,-3}]', [cs.int(7)])).toBe('[7  ]');
    expect(stringFormat('{0}:{1}', [cs.int(7), cs.string('x')])).toBe('7:x');
    expect(() => stringFormat('{Number}', [cs.int(1)])).toThrow(StringFormatException);
    expect(() => stringFormat('{1}', [cs.int(1)])).toThrow(StringFormatException);
    expect(() => stringFormat('{0', [cs.int(1)])).toThrow(StringFormatException);
    expect(() => stringFormat('}', [cs.int(1)])).toThrow(StringFormatException);
    const wrapped = wrapStringFormatError('{Type} Card', new StringFormatException('Input string was not in a correct format.'));
    expect(wrapped.message).toContain('Ensure that the string is marked as Smart');
    expect(wrapped.message).toContain('{Type} Card');
  });
});

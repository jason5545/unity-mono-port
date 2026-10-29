// C#: UnityEngine.Localization.SmartFormat.Utilities/TimeSpanFormatOptions.cs、
//     TimeSpanFormatOptionsConverter.cs、TimeSpanUtility.cs、TimeTextInfo.cs、
//     CommonLanguagesTimeTextInfo.cs，以及 Net.Utilities/SystemTime.cs。
// TimeSpan／DateTime 用 ticks（100ns）表示，見 values.ts。

import { GetPluralRule, type PluralRuleDelegate } from './pluralRules.ts';

/** C#: Utilities/TimeSpanFormatOptions.cs TimeSpanFormatOptions（[Flags]） */
export const TimeSpanFormatOptions = {
  InheritDefaults: 0,
  Abbreviate: 1,
  AbbreviateOff: 2,
  LessThan: 4,
  LessThanOff: 8,
  TruncateShortest: 0x10,
  TruncateAuto: 0x20,
  TruncateFill: 0x40,
  TruncateFull: 0x80,
  RangeMilliSeconds: 0x100,
  RangeSeconds: 0x200,
  RangeMinutes: 0x400,
  RangeHours: 0x800,
  RangeDays: 0x1000,
  RangeWeeks: 0x2000,
} as const;
export type TimeSpanFormatOptions = number;

/** C#: Utilities/TimeSpanFormatOptions.cs TimeSpanFormatOptions（internal const） */
const AbbreviateAll = TimeSpanFormatOptions.Abbreviate | TimeSpanFormatOptions.AbbreviateOff;
const LessThanAll = TimeSpanFormatOptions.LessThan | TimeSpanFormatOptions.LessThanOff;
const RangeAll =
  TimeSpanFormatOptions.RangeMilliSeconds |
  TimeSpanFormatOptions.RangeSeconds |
  TimeSpanFormatOptions.RangeMinutes |
  TimeSpanFormatOptions.RangeHours |
  TimeSpanFormatOptions.RangeDays |
  TimeSpanFormatOptions.RangeWeeks;
const TruncateAll =
  TimeSpanFormatOptions.TruncateShortest | TimeSpanFormatOptions.TruncateAuto | TimeSpanFormatOptions.TruncateFill | TimeSpanFormatOptions.TruncateFull;

/** C#: Utilities/TimeSpanFormatOptionsConverter.cs TimeSpanFormatOptionsConverter.Merge */
export function merge(left: TimeSpanFormatOptions, right: TimeSpanFormatOptions): TimeSpanFormatOptions {
  let out = left;
  for (const group of [AbbreviateAll, LessThanAll, RangeAll, TruncateAll]) {
    if ((out & group) === 0) out |= right & group;
  }
  return out;
}

/** C#: Utilities/TimeSpanFormatOptionsConverter.cs TimeSpanFormatOptionsConverter.Mask */
export function mask(options: TimeSpanFormatOptions, m: number): TimeSpanFormatOptions {
  return options & m;
}

/** C#: Utilities/TimeSpanFormatOptionsConverter.cs TimeSpanFormatOptionsConverter.AllFlags */
export function allFlags(options: TimeSpanFormatOptions): number[] {
  const out: number[] = [];
  for (let value = 1; value <= options; value <<= 1) {
    if ((value & options) !== 0) out.push(value);
  }
  return out;
}

/** C#: Utilities/TimeSpanFormatOptionsConverter.cs TimeSpanFormatOptionsConverter.parser */
const parser = /\b(w|week|weeks|d|day|days|h|hour|hours|m|minute|minutes|s|second|seconds|ms|millisecond|milliseconds|auto|short|fill|full|abbr|noabbr|less|noless)\b/gi;

/** C#: Utilities/TimeSpanFormatOptionsConverter.cs TimeSpanFormatOptionsConverter.Parse */
export function parseTimeSpanFormatOptions(formatOptionsString: string): TimeSpanFormatOptions {
  let out = TimeSpanFormatOptions.InheritDefaults;
  for (const match of formatOptionsString.toLowerCase().matchAll(parser)) {
    switch (match[1]) {
      case 'w':
      case 'week':
      case 'weeks':
        out |= TimeSpanFormatOptions.RangeWeeks;
        break;
      case 'd':
      case 'day':
      case 'days':
        out |= TimeSpanFormatOptions.RangeDays;
        break;
      case 'h':
      case 'hour':
      case 'hours':
        out |= TimeSpanFormatOptions.RangeHours;
        break;
      case 'm':
      case 'minute':
      case 'minutes':
        out |= TimeSpanFormatOptions.RangeMinutes;
        break;
      case 's':
      case 'second':
      case 'seconds':
        out |= TimeSpanFormatOptions.RangeSeconds;
        break;
      case 'ms':
      case 'millisecond':
      case 'milliseconds':
        out |= TimeSpanFormatOptions.RangeMilliSeconds;
        break;
      case 'short':
        out |= TimeSpanFormatOptions.TruncateShortest;
        break;
      case 'auto':
        out |= TimeSpanFormatOptions.TruncateAuto;
        break;
      case 'fill':
        out |= TimeSpanFormatOptions.TruncateFill;
        break;
      case 'full':
        out |= TimeSpanFormatOptions.TruncateFull;
        break;
      case 'abbr':
        out |= TimeSpanFormatOptions.Abbreviate;
        break;
      case 'noabbr':
        out |= TimeSpanFormatOptions.AbbreviateOff;
        break;
      case 'less':
        out |= TimeSpanFormatOptions.LessThan;
        break;
      case 'noless':
        out |= TimeSpanFormatOptions.LessThanOff;
        break;
    }
  }
  return out;
}

export const TICKS_PER_SECOND = 10000000n;
export const TICKS_PER_MINUTE = 60n * TICKS_PER_SECOND;
export const TICKS_PER_HOUR = 60n * TICKS_PER_MINUTE;
export const TICKS_PER_DAY = 24n * TICKS_PER_HOUR;

/** C#: System.TimeSpan 的 TotalDays／TotalHours…（double） */
export function totalDays(ticks: bigint): number {
  return Number(ticks) / Number(TICKS_PER_DAY);
}
export function totalHours(ticks: bigint): number {
  return Number(ticks) / Number(TICKS_PER_HOUR);
}
export function totalMinutes(ticks: bigint): number {
  return Number(ticks) / Number(TICKS_PER_MINUTE);
}
export function totalSeconds(ticks: bigint): number {
  return Number(ticks) / Number(TICKS_PER_SECOND);
}
export function totalMilliseconds(ticks: bigint): number {
  return Number(ticks) / 10000;
}

/** C#: Utilities/TimeTextInfo.cs TimeTextInfo */
export class TimeTextInfo {
  private readonly pluralRule: PluralRuleDelegate;
  private readonly week: string[];
  private readonly day: string[];
  private readonly hour: string[];
  private readonly minute: string[];
  private readonly second: string[];
  private readonly millisecond: string[];
  private readonly w: string[];
  private readonly d: string[];
  private readonly h: string[];
  private readonly m: string[];
  private readonly s: string[];
  private readonly ms: string[];
  private readonly lessThan: string;

  constructor(
    pluralRule: PluralRuleDelegate,
    week: string[],
    day: string[],
    hour: string[],
    minute: string[],
    second: string[],
    millisecond: string[],
    w: string[],
    d: string[],
    h: string[],
    m: string[],
    s: string[],
    ms: string[],
    lessThan: string,
  ) {
    this.pluralRule = pluralRule;
    this.week = week;
    this.day = day;
    this.hour = hour;
    this.minute = minute;
    this.second = second;
    this.millisecond = millisecond;
    this.w = w;
    this.d = d;
    this.h = h;
    this.m = m;
    this.s = s;
    this.ms = ms;
    this.lessThan = lessThan;
  }

  /** C#: TimeTextInfo.GetValue */
  private static getValue(pluralRule: PluralRuleDelegate, value: number, units: string[]): string {
    const index = units.length !== 1 ? pluralRule(value, units.length) : 0;
    return format0(units[index], value);
  }

  /** C#: TimeTextInfo.GetLessThanText */
  getLessThanText(minimumValue: string): string {
    return format0(this.lessThan, minimumValue);
  }

  /** C#: TimeTextInfo.GetUnitText */
  getUnitText(unit: TimeSpanFormatOptions, value: number, abbr: boolean): string | null {
    switch (unit) {
      case TimeSpanFormatOptions.RangeWeeks:
        return TimeTextInfo.getValue(this.pluralRule, value, abbr ? this.w : this.week);
      case TimeSpanFormatOptions.RangeDays:
        return TimeTextInfo.getValue(this.pluralRule, value, abbr ? this.d : this.day);
      case TimeSpanFormatOptions.RangeHours:
        return TimeTextInfo.getValue(this.pluralRule, value, abbr ? this.h : this.hour);
      case TimeSpanFormatOptions.RangeMinutes:
        return TimeTextInfo.getValue(this.pluralRule, value, abbr ? this.m : this.minute);
      case TimeSpanFormatOptions.RangeSeconds:
        return TimeTextInfo.getValue(this.pluralRule, value, abbr ? this.s : this.second);
      case TimeSpanFormatOptions.RangeMilliSeconds:
        return TimeTextInfo.getValue(this.pluralRule, value, abbr ? this.ms : this.millisecond);
      default:
        return null;
    }
  }
}

/** C#: string.Format("{0} week", value) 之類的單一參數格式化（TimeTextInfo 的字串樣板） */
function format0(template: string, value: string | number): string {
  return template.replace(/\{0\}/g, String(value));
}

/** C#: Utilities/CommonLanguagesTimeTextInfo.cs CommonLanguagesTimeTextInfo（只有英文） */
export const EnglishTimeTextInfo = new TimeTextInfo(
  GetPluralRule('en'),
  ['{0} week', '{0} weeks'],
  ['{0} day', '{0} days'],
  ['{0} hour', '{0} hours'],
  ['{0} minute', '{0} minutes'],
  ['{0} second', '{0} seconds'],
  ['{0} millisecond', '{0} milliseconds'],
  ['{0}w'],
  ['{0}d'],
  ['{0}h'],
  ['{0}m'],
  ['{0}s'],
  ['{0}ms'],
  'less than {0}',
);

/** C#: Utilities/CommonLanguagesTimeTextInfo.cs CommonLanguagesTimeTextInfo.GetTimeTextInfo */
export function GetTimeTextInfo(twoLetterIsoLanguageName: string): TimeTextInfo | null {
  if (twoLetterIsoLanguageName === 'en') return EnglishTimeTextInfo;
  return null;
}

/** C#: Net.Utilities/SystemTime.cs SystemTime */
export const SystemTime = {
  /** C#: SystemTime.Now（DateTime.Now → 本地時間的 UTC ticks） */
  nowTicks(): bigint {
    return BigInt(Date.now()) * 10000n + 621355968000000000n;
  },
};

/** C#: Utilities/TimeSpanUtility.cs TimeSpanUtility（ToTimeString） */
export const TimeSpanUtility = {
  /** C#: TimeSpanUtility.DefaultFormatOptions */
  defaultFormatOptions: TimeSpanFormatOptions.AbbreviateOff |
    TimeSpanFormatOptions.LessThan |
    TimeSpanFormatOptions.TruncateAuto |
    TimeSpanFormatOptions.RangeSeconds |
    TimeSpanFormatOptions.RangeDays,
  /** C#: TimeSpanUtility.AbsoluteDefaults */
  absoluteDefaults:
    TimeSpanFormatOptions.AbbreviateOff |
    TimeSpanFormatOptions.LessThan |
    TimeSpanFormatOptions.TruncateAuto |
    TimeSpanFormatOptions.RangeSeconds |
    TimeSpanFormatOptions.RangeDays,

  /** C#: TimeSpanUtility.ToTimeString */
  toTimeString(fromTimeTicks: bigint, options: TimeSpanFormatOptions, timeTextInfo: TimeTextInfo): string {
    let ticks = fromTimeTicks;
    options = merge(merge(options, TimeSpanUtility.defaultFormatOptions), TimeSpanUtility.absoluteDefaults);
    const rangeFlags = allFlags(mask(options, RangeAll));
    const largest = rangeFlags[rangeFlags.length - 1];
    const smallest = rangeFlags[0];
    const truncate = allFlags(mask(options, TruncateAll))[0];
    const lessThan = mask(options, LessThanAll) !== TimeSpanFormatOptions.LessThanOff;
    const abbr = mask(options, AbbreviateAll) !== TimeSpanFormatOptions.AbbreviateOff;
    const round = lessThan ? Math.floor : Math.ceil;
    switch (smallest) {
      case TimeSpanFormatOptions.RangeWeeks:
        ticks = daysToTicks(round(totalDays(ticks) / 7) * 7);
        break;
      case TimeSpanFormatOptions.RangeDays:
        ticks = daysToTicks(round(totalDays(ticks)));
        break;
      case TimeSpanFormatOptions.RangeHours:
        ticks = hoursToTicks(round(totalHours(ticks)));
        break;
      case TimeSpanFormatOptions.RangeMinutes:
        ticks = minutesToTicks(round(totalMinutes(ticks)));
        break;
      case TimeSpanFormatOptions.RangeSeconds:
        ticks = secondsToTicks(round(totalSeconds(ticks)));
        break;
      case TimeSpanFormatOptions.RangeMilliSeconds:
        ticks = msToTicks(round(totalMilliseconds(ticks)));
        break;
    }
    let any = false;
    let out = '';
    for (let unit = largest; unit >= smallest; unit >>= 1) {
      let count: number;
      switch (unit) {
        case TimeSpanFormatOptions.RangeWeeks:
          count = Math.floor(totalDays(ticks) / 7);
          ticks -= daysToTicks(count * 7);
          break;
        case TimeSpanFormatOptions.RangeDays:
          count = Math.floor(totalDays(ticks));
          ticks -= daysToTicks(count);
          break;
        case TimeSpanFormatOptions.RangeHours:
          count = Math.floor(totalHours(ticks));
          ticks -= hoursToTicks(count);
          break;
        case TimeSpanFormatOptions.RangeMinutes:
          count = Math.floor(totalMinutes(ticks));
          ticks -= minutesToTicks(count);
          break;
        case TimeSpanFormatOptions.RangeSeconds:
          count = Math.floor(totalSeconds(ticks));
          ticks -= secondsToTicks(count);
          break;
        case TimeSpanFormatOptions.RangeMilliSeconds:
          count = Math.floor(totalMilliseconds(ticks));
          ticks -= msToTicks(count);
          break;
        default:
          throw new Error('TimeSpanUtility');
      }
      let include = false;
      let stop = false;
      switch (truncate) {
        case TimeSpanFormatOptions.TruncateShortest:
          if (any) stop = true;
          else if (count > 0) include = true;
          break;
        case TimeSpanFormatOptions.TruncateAuto:
          if (count > 0) include = true;
          break;
        case TimeSpanFormatOptions.TruncateFill:
          if (any || count > 0) include = true;
          break;
        case TimeSpanFormatOptions.TruncateFull:
          include = true;
          break;
      }
      if (stop) break;
      if (unit === smallest && !any) {
        include = true;
        if (lessThan && count < 1) {
          const unitText = timeTextInfo.getUnitText(smallest, 1, abbr) ?? '';
          out += timeTextInfo.getLessThanText(unitText);
          include = false;
        }
      }
      if (include) {
        if (any) out += ' ';
        out += timeTextInfo.getUnitText(unit, count, abbr) ?? '';
        any = true;
      }
    }
    return out;
  },
};

function daysToTicks(days: number): bigint {
  return BigInt(days) * TICKS_PER_DAY;
}
function hoursToTicks(hours: number): bigint {
  return BigInt(hours) * TICKS_PER_HOUR;
}
function minutesToTicks(minutes: number): bigint {
  return BigInt(minutes) * TICKS_PER_MINUTE;
}
function secondsToTicks(seconds: number): bigint {
  return BigInt(seconds) * TICKS_PER_SECOND;
}
function msToTicks(ms: number): bigint {
  return BigInt(ms) * 10000n;
}

import { t } from "@/i18n";
import type { RecurrenceConfig, RecurrenceType } from "@/types/todo";

/** 每天可设的提醒时刻上限 */
export const DAILY_TIME_LIMIT = 10;
/** 每周某天 / 每月某号可设的提醒时刻上限 */
export const PER_DAY_TIME_LIMIT = 5;
/** 每月可选号数上限 */
export const MONTHLY_DAY_LIMIT = 15;

const DAY_MS = 86_400_000;

export interface TimeSlot {
  hour: number;
  minute: number;
}

/** "HH:MM" → {hour, minute}，非法返回 null */
export function parseSlot(text: string): TimeSlot | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(text.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function formatSlot(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function slotFromMs(ms: number): TimeSlot {
  const d = new Date(ms);
  return { hour: d.getHours(), minute: d.getMinutes() };
}

/**
 * 归一化后的规则：daily 只有一个 spec（key=0）；
 * weekly 的 key 是星期数字 0-6；monthly 的 key 是号数 1-31。
 */
export interface NormalizedRecurrence {
  interval: number;
  specs: Array<{ key: number; times: TimeSlot[] }>;
}

const EMPTY: NormalizedRecurrence = { interval: 1, specs: [] };

function sortSlots(times: TimeSlot[]): TimeSlot[] {
  return [...times].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

/** 依次尝试多份时刻来源，全都没有就用锚点时刻兜底 */
function parseSlots(
  primary: string[] | undefined,
  secondary: string[] | undefined,
  fallback: TimeSlot,
): TimeSlot[] {
  for (const list of [primary, secondary]) {
    if (!list?.length) continue;
    const parsed = list
      .map((s) => parseSlot(String(s)))
      .filter((t): t is TimeSlot => t !== null);
    if (parsed.length) return sortSlots(parsed);
  }
  return [fallback];
}

/**
 * 把数据库里的 JSON 规则读成统一的槽位表。
 *
 * @param fallbackMs 老数据没有时刻字段时，用它（原本的截止时间）的时分补齐
 */
export function normalizeRecurrence(
  type: RecurrenceType,
  config: string,
  fallbackMs: number,
): NormalizedRecurrence {
  if (type === "none" || !config) return EMPTY;

  let cfg: RecurrenceConfig;
  try {
    cfg = JSON.parse(config);
  } catch {
    return EMPTY;
  }
  if (!cfg || typeof cfg !== "object") return EMPTY;

  const interval = Math.max(1, Math.floor(cfg.interval || 1));
  const fallback = slotFromMs(fallbackMs);
  const perDay = cfg.dayTimes;

  if (type === "daily") {
    return { interval, specs: [{ key: 0, times: parseSlots(cfg.times, undefined, fallback) }] };
  }

  if (type === "weekly") {
    const days = cfg.days?.length ? cfg.days : [new Date(fallbackMs).getDay()];
    return {
      interval,
      specs: [...new Set(days)]
        .sort((a, b) => a - b)
        .map((d) => ({
          key: d,
          times: parseSlots(perDay?.[String(d)], cfg.times, fallback),
        })),
    };
  }

  // monthly：旧版单号数并入 daysOfMonth
  const doms = cfg.daysOfMonth?.length
    ? cfg.daysOfMonth
    : cfg.dayOfMonth
      ? [cfg.dayOfMonth]
      : [new Date(fallbackMs).getDate()];
  return {
    interval,
    specs: [...new Set(doms)]
      .filter((d) => d >= 1 && d <= 31)
      .sort((a, b) => a - b)
      .map((d) => ({
        key: d,
        times: parseSlots(perDay?.[String(d)], cfg.times, fallback),
      })),
  };
}

/** 公历日序号（与时区、夏令时无关，只做日历对齐用） */
function civilDayNum(d: Date): number {
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** 周一为起点的周序号 */
function weekIndex(dayNum: number): number {
  return Math.floor((dayNum + 6) / 7);
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * 某个月里「实际会提醒」的日期 → 生效的号数。
 *
 * 短月里 29/30/31 会被压到月末同一天，规则是号数小的优先、其余忽略：
 * 选了 28 就用 28 的时刻，28 没选才轮到 30，31 始终被 30 挡住。
 */
function monthlyWinners(doms: number[], year: number, month: number): Map<number, number> {
  const last = daysInMonth(year, month);
  const out = new Map<number, number>();
  for (const d of [...doms].sort((a, b) => a - b)) {
    const eff = Math.min(d, last);
    if (!out.has(eff)) out.set(eff, d);
  }
  return out;
}

/**
 * 下一个提醒时刻：严格晚于 afterMs 的第一个槽位。
 *
 * 直接按规则展开，而不是「在上一次的基础上加一格」——所以提醒时刻被「稍后提醒」
 * 挪动后，循环的锚点不会跟着漂移。anchorMs 用于「每 N 天/周/月」的对齐基准。
 */
export function computeNextDueDate(
  afterMs: number,
  type: RecurrenceType,
  config: string,
  anchorMs?: number,
): number {
  if (type === "none" || afterMs <= 0) return 0;

  const anchor = anchorMs && anchorMs > 0 ? anchorMs : afterMs;
  const norm = normalizeRecurrence(type, config, anchor);
  if (!norm.specs.length) return 0;

  const anchorDay = civilDayNum(new Date(anchor));
  const anchorWeek = weekIndex(anchorDay);
  const anchorMonth = new Date(anchor).getFullYear() * 12 + new Date(anchor).getMonth();

  const timesByKey = new Map(norm.specs.map((s) => [s.key, s.times]));
  const doms = norm.specs.map((s) => s.key);

  const cursor = new Date(afterMs);
  cursor.setHours(0, 0, 0, 0);

  // 每 N 月/周/天的对齐可能要把窗口拉得很长，留足扫描天数后仍找不到就当没有下一次
  const horizon = 400 + 366 * norm.interval;

  for (let i = 0; i <= horizon; i++) {
    const day = new Date(cursor.getTime() + i * DAY_MS);
    // 用日历字段而不是毫秒加法，避开夏令时造成的整天偏移
    day.setHours(0, 0, 0, 0);
    const dayNum = civilDayNum(day);
    const monthIdx = day.getFullYear() * 12 + day.getMonth();

    let times: TimeSlot[] | undefined;
    if (type === "daily") {
      if ((dayNum - anchorDay) % norm.interval !== 0) continue;
      times = timesByKey.get(0);
    } else if (type === "weekly") {
      const weekday = day.getDay();
      if ((weekIndex(dayNum) - anchorWeek) % norm.interval !== 0) continue;
      times = timesByKey.get(weekday);
    } else {
      if ((monthIdx - anchorMonth) % norm.interval !== 0) continue;
      const winners = monthlyWinners(doms, day.getFullYear(), day.getMonth());
      const winner = winners.get(day.getDate());
      if (winner === undefined) continue;
      times = timesByKey.get(winner);
    }

    for (const slot of times ?? []) {
      const ts = new Date(day);
      ts.setHours(slot.hour, slot.minute, 0, 0);
      if (ts.getTime() > afterMs) return ts.getTime();
    }
  }

  return 0;
}

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 折叠态一行里列几个时间点，多的用「等 N 个时间」收尾 */
const MAX_INLINE_TIMES = 2;

/** 规则开头的频率描述 */
function ruleHead(type: RecurrenceType, interval: number, isZh: boolean): string {
  if (type === "daily") {
    return interval === 1
      ? isZh
        ? "每天"
        : "Daily"
      : isZh
        ? `每${interval}天`
        : `Every ${interval} days`;
  }
  if (type === "weekly") {
    // 中文的「每」要贴着星期写：每周一 08:00，而不是「每 周一」
    return interval === 1
      ? isZh
        ? "每"
        : "Weekly "
      : isZh
        ? `每${interval}周`
        : `Every ${interval} weeks `;
  }
  return interval === 1
    ? isZh
      ? "每月"
      : "Monthly "
    : isZh
      ? `每${interval}月`
      : `Every ${interval} months `;
}

/** 每个时间点前面的日子标签：周一 / 3号 / 每天没有 */
function dayLabel(type: RecurrenceType, key: number, isZh: boolean): string {
  if (type === "weekly") return isZh ? `周${WEEKDAY_ZH[key]}` : WEEKDAY_EN[key];
  if (type === "monthly") return isZh ? `${key}号` : String(key);
  return "";
}

/** 频率与正文之间要不要补空格 */
function glue(head: string, body: string, type: RecurrenceType, isZh: boolean): string {
  return type === "weekly" && isZh ? `${head}${body}` : `${head} ${body}`;
}

/**
 * 展开态：按天分组，把**所有**时间点都列出来。
 * 每周一 08:00、13:00；周五 09:00
 */
export function formatRecurrence(
  type: RecurrenceType,
  config: string,
  locale: "zh-CN" | "en",
  anchorMs?: number,
): string | null {
  if (type === "none" || !config) return null;

  const isZh = locale === "zh-CN";
  const norm = normalizeRecurrence(type, config, anchorMs ?? Date.now());
  if (!norm.specs.length) return null;

  const groups = norm.specs.map((s) => {
    const day = dayLabel(type, s.key, isZh);
    const times = s.times.map((t) => formatSlot(t.hour, t.minute)).join("、");
    return day ? `${day} ${times}` : times;
  });
  return glue(ruleHead(type, norm.interval, isZh), groups.join(isZh ? "；" : "; "), type, isZh);
}

/**
 * 折叠态：只露前两个时间点，后面用「等 N 个时间」收尾。
 * 每天 08:00、13:00 等 6 个时间
 */
export function formatRecurrenceCollapsed(
  type: RecurrenceType,
  config: string,
  locale: "zh-CN" | "en",
  anchorMs?: number,
): string | null {
  if (type === "none" || !config) return null;

  const isZh = locale === "zh-CN";
  const norm = normalizeRecurrence(type, config, anchorMs ?? Date.now());
  if (!norm.specs.length) return null;

  const flat: Array<{ day: string; time: string }> = [];
  for (const s of norm.specs) {
    const day = dayLabel(type, s.key, isZh);
    for (const slot of s.times) flat.push({ day, time: formatSlot(slot.hour, slot.minute) });
  }

  const shown = flat.slice(0, MAX_INLINE_TIMES).map((tk, i) => {
    // 同一天只写一次日子标签
    const sameDayAsPrev = i > 0 && flat[i - 1].day === tk.day;
    return tk.day && !sameDayAsPrev ? `${tk.day} ${tk.time}` : tk.time;
  });
  const body =
    flat.length <= MAX_INLINE_TIMES
      ? shown.join("、")
      : `${shown.join("、")} ${t(locale, "recurSlotsMore", { n: flat.length })}`;

  return glue(ruleHead(type, norm.interval, isZh), body, type, isZh);
}

import type { Locale } from "@/i18n";
import { t } from "@/i18n";
import type { TodoItem } from "@/types/todo";

export function sortTodos(list: TodoItem[]): TodoItem[] {
  return [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    // 已完成的按完成时间倒序；未完成的回退到更新时间倒序
    const at = a.completed ? a.completedTime : a.updateTime;
    const bt = b.completed ? b.completedTime : b.updateTime;
    return bt - at;
  });
}

export interface CompletedBucket {
  /** 分组唯一键（动态分组用 w:/m:/y: 前缀，配合时间戳或年月） */
  id: string;
  /** 分组标题：周/月/年这类动态标题在计算时就生成好，UI 层不用再判断一次 */
  title: string;
  /** 桶内待办（已完成，按完成时间倒序） */
  items: TodoItem[];
}

const DAY = 86_400_000;

/**
 * 按 completedTime 互斥分桶：某条已完成项只会落入“最紧”的桶。
 *
 * 折叠粒度随距今时间放宽（用户要求）：
 *   今天 → 近 3 天 → 近 7 天            （近一周，保持细粒度）
 *   → 超过一周：按**自然周**折叠（周一起）
 *   → 超过一个月：按**自然月**折叠
 *   → 超过一年：按**自然年**折叠
 *
 * completedTime 为空（历史数据）时回退到 updateTime。
 */
function effectiveCompletedTime(todo: TodoItem): number {
  return todo.completedTime > 0 ? todo.completedTime : todo.updateTime;
}

/** 该时间戳所在自然周的周一 00:00 */
function weekStart(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 0 = 周一（中国习惯，周一开始）
  return d.getTime() - dow * DAY;
}

function monthDayLabel(ts: number, locale: Locale): string {
  const d = new Date(ts);
  return locale === "en"
    ? `${d.getMonth() + 1}/${d.getDate()}`
    : `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function bucketCompletedByTime(
  list: TodoItem[],
  locale: Locale,
): CompletedBucket[] {
  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = startOfToday.getTime();

  // 先按完成时间倒序：之后用 Map 顺序插入，天然就是「从新到旧」
  const sorted = [...list].sort(
    (a, b) => effectiveCompletedTime(b) - effectiveCompletedTime(a),
  );

  const grouped = new Map<string, CompletedBucket>();
  const push = (id: string, title: string, todo: TodoItem) => {
    const hit = grouped.get(id);
    if (hit) hit.items.push(todo);
    else grouped.set(id, { id, title, items: [todo] });
  };

  for (const todo of sorted) {
    const ct = effectiveCompletedTime(todo);

    if (ct >= todayStart) {
      push("today", t(locale, "completedToday"), todo);
      continue;
    }
    if (ct >= now - 3 * DAY) {
      push("3days", t(locale, "completed3Days"), todo);
      continue;
    }
    if (ct >= now - 7 * DAY) {
      push("7days", t(locale, "completed7Days"), todo);
      continue;
    }

    if (ct >= now - 30 * DAY) {
      // 一周以上、一个月以内 → 按自然周折叠
      const ws = weekStart(ct);
      const we = ws + 6 * DAY;
      push(
        `w:${ws}`,
        `${monthDayLabel(ws, locale)} - ${monthDayLabel(we, locale)}`,
        todo,
      );
      continue;
    }

    const d = new Date(ct);
    if (ct >= now - 365 * DAY) {
      // 一个月以上、一年以内 → 按自然月折叠
      push(
        `m:${d.getFullYear()}-${d.getMonth() + 1}`,
        locale === "en"
          ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
          : `${d.getFullYear()}年${d.getMonth() + 1}月`,
        todo,
      );
      continue;
    }

    // 一年以前 → 按自然年折叠
    push(
      `y:${d.getFullYear()}`,
      locale === "en" ? `${d.getFullYear()}` : `${d.getFullYear()}年`,
      todo,
    );
  }

  return [...grouped.values()];
}

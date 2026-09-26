import { useMemo, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { Locale } from "@/i18n";
import type { TodoItem } from "@/types/todo";

interface WeekCalendarProps {
  locale: Locale;
  todos: TodoItem[];
  /** 选中的日期时间戳（当天 00:00:00），null 表示未筛选 */
  selectedDate: number | null;
  onSelectDate: (timestamp: number | null) => void;
}

/** 一天的开始时间戳（00:00:00） */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 一天的结束时间戳（23:59:59.999） */
function endOfDay(ts: number): number {
  return startOfDay(ts) + 86_399_999;
}

/** 获得指定日期所在周的周一 00:00:00 */
function getMondayOfWeek(date: Date): number {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return startOfDay(d.getTime());
}

/** 格式化 MM-DD */
function fmtMMDD(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${m}-${dd}`;
}

const WEEK_LABELS_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
const WEEK_LABELS_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** 单个日期单元格 — 可拖放目标 */
function DayCell({
  ts,
  label,
  isToday,
  selected,
  hasDue,
  hasOverdue,
  onSelect,
}: {
  ts: number;
  label: string;
  isToday: boolean;
  selected: boolean;
  hasDue: boolean;
  hasOverdue: boolean;
  onSelect: (ts: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `day-${ts}`,
    data: { type: "day" as const, date: ts },
  });

  const showDot = hasDue || hasOverdue;
  const dotColor = hasOverdue ? "bg-amber-400/80" : "bg-red-400/80";

  const textColor = isOver
    ? "var(--ln-theme-text)"
    : selected
      ? "var(--ln-theme-text)"
      : isToday
        ? "var(--ln-theme-today)"
        : "var(--ln-theme-text-secondary)";

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={() => onSelect(ts)}
      className={[
        "relative flex flex-col items-center justify-center",
        // 竖向空间主要来自这里：原 h-14(56px) 的 75% → 42px
        "flex-1 max-w-[52px] h-[42px] rounded-lg text-xs transition",
        isOver
          ? "bg-sky-500/30 ring-1 ring-sky-400/50 scale-105"
          : selected
            ? "bg-white/12 ring-1 ring-white/10"
            : isToday
              ? "bg-white/[0.06]"
              : "hover:bg-white/[0.04]",
      ].join(" ")}
      style={{ color: textColor }}
    >
      {/* 星期 */}
      <span className={`leading-none text-[11px] ${
        selected || isToday ? "font-medium" : ""
      }`}>
        {label}
      </span>

      {/* 日期 MM-DD（行间距 mt-1(4px) → 3px，同为 75%） */}
      <span className={`mt-[3px] text-[11px] leading-none ${
        selected ? "font-semibold" : "font-normal"
      }`}>
        {fmtMMDD(ts)}
      </span>

      {/* 待办指示点 — 右上角 */}
      {showDot ? (
        <span
          className={`absolute top-0.5 right-1 h-1.5 w-1.5 rounded-full ${dotColor}`}
        />
      ) : null}
    </button>
  );
}

export function WeekCalendar({
  locale,
  todos,
  selectedDate,
  onSelectDate,
}: WeekCalendarProps) {
  const [weekOffset, setWeekOffset] = useState(0);
  const todayStart = startOfDay(Date.now());

  // 当前展示周的起始时间（周一 00:00:00）
  const weekMonday = useMemo(() => {
    const now = new Date();
    now.setDate(now.getDate() + weekOffset * 7);
    return getMondayOfWeek(now);
  }, [weekOffset]);

  // 当前周是否是本周
  const isCurrentWeek = weekOffset === 0;

  // 生成 7 天数据
  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => {
      const ts = weekMonday + i * 86_400_000;
      const isToday = ts === todayStart;

      let hasDue = false;
      let hasOverdue = false;

      for (const todo of todos) {
        if (todo.completed || todo.dueDate <= 0) continue;
        if (todo.dueDate >= ts && todo.dueDate <= endOfDay(ts)) {
          if (ts < todayStart) {
            hasOverdue = true;
          } else {
            hasDue = true;
          }
        }
      }

      return { ts, isToday, hasDue, hasOverdue };
    });
  }, [weekMonday, todayStart, todos]);

  const weekLabels = locale === "zh-CN" ? WEEK_LABELS_ZH : WEEK_LABELS_EN;

  const handleClick = (ts: number) => {
    if (selectedDate === ts) {
      onSelectDate(null);
    } else {
      onSelectDate(ts);
    }
  };

  // 箭头按钮样式
  const arrowBtn =
    "flex h-8 w-6 shrink-0 items-center justify-center rounded-md transition hover:bg-white/8";
  const arrowColor = "var(--ln-theme-text-secondary)";

  return (
    <nav
      className="shrink-0 flex items-center gap-0.5 px-1 py-1.5 select-none"
      style={{ borderBottom: `1px solid var(--ln-theme-border-light)` }}
      data-tauri-no-drag
    >
      {/* 左箭头 */}
      <button
        type="button"
        className={arrowBtn}
        style={{ color: arrowColor }}
        onClick={() => setWeekOffset((o) => o - 1)}
        aria-label="上一周"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>

      {/* 7 天 */}
      <div className="flex flex-1 items-center justify-center gap-0.5">
        {weekDays.map((day, idx) => (
          <DayCell
            key={day.ts}
            ts={day.ts}
            label={weekLabels[idx]}
            isToday={day.isToday}
            selected={selectedDate === day.ts}
            hasDue={day.hasDue}
            hasOverdue={day.hasOverdue}
            onSelect={handleClick}
          />
        ))}
      </div>

      {/* 右箭头 */}
      <button
        type="button"
        className={arrowBtn}
        style={{ color: arrowColor }}
        onClick={() => setWeekOffset((o) => o + 1)}
        aria-label="下一周"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>

      {/* 非本周时显示"回到今天" */}
      {!isCurrentWeek ? (
        <button
          type="button"
          className="shrink-0 rounded-md px-1.5 py-1 text-[11px] transition hover:bg-white/8"
          style={{ color: "var(--ln-theme-text-muted)" }}
          onClick={() => {
            setWeekOffset(0);
            onSelectDate(null);
          }}
        >
          {locale === "zh-CN" ? "今" : "Today"}
        </button>
      ) : null}
    </nav>
  );
}

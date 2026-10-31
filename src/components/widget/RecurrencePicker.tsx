import { useEffect, useState } from "react";
import type { Locale } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { t } from "@/i18n";
import type { RecurrenceConfig, RecurrenceType } from "@/types/todo";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  DAILY_TIME_LIMIT,
  MONTHLY_DAY_LIMIT,
  PER_DAY_TIME_LIMIT,
  computeNextDueDate,
  formatSlot,
  normalizeRecurrence,
} from "@/lib/recurrence";

interface RecurrencePickerProps {
  locale: Locale;
  open: boolean;
  recurrenceType: RecurrenceType;
  /** 现有规则，重开面板时回填 */
  initialConfig: string;
  /** 现有提醒时刻，老规则里没有时刻时用它兜底 */
  initialDueDate: number;
  onConfirm: (type: RecurrenceType, config: string, dueDate: number) => void;
  onCancel: () => void;
}

const WEEKDAY_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** 面板里星期从左到右的顺序：周一开头 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const ACCENT = "#0ea5e9";

/** 下一格默认时间：在最后一个时刻上 +1 小时，比复制同一个数好用 */
function nextTimeAfter(last: string): string {
  const [h, m] = last.split(":").map(Number);
  const total = ((h || 0) + 1) * 60 + (m || 0);
  return formatSlot(Math.floor((total % 1440) / 60), total % 60);
}

function slotsToText(slots: Array<{ hour: number; minute: number }>): string[] {
  return slots.map((s) => formatSlot(s.hour, s.minute));
}

export function RecurrencePicker({
  locale,
  open,
  recurrenceType,
  initialConfig,
  initialDueDate,
  onConfirm,
  onCancel,
}: RecurrencePickerProps) {
  const isZh = locale === "zh-CN";
  const wdLabels = isZh ? WEEKDAY_ZH : WEEKDAY_EN;
  const isDaily = recurrenceType === "daily";
  const theme = useSettingsStore((s) => s.theme);
  const scheme: "dark" | "light" = theme === "dark" || theme === "glass" ? "dark" : "light";

  const [times, setTimes] = useState<string[]>(["10:00"]);
  const [days, setDays] = useState<number[]>([]);
  const [dayTimes, setDayTimes] = useState<Record<number, string[]>>({});
  const [active, setActive] = useState<number>(-1);
  const [pendingDay, setPendingDay] = useState<string>("");

  // 每次打开都按当前待办的规则回填，否则会把上一次编辑的残留带进来
  useEffect(() => {
    if (!open) return;
    const now = new Date();
    const anchorMs =
      initialDueDate > 0
        ? initialDueDate
        : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0, 0).getTime();
    const norm = normalizeRecurrence(recurrenceType, initialConfig, anchorMs);

    if (isDaily) {
      const t = slotsToText(norm.specs[0]?.times ?? []);
      setTimes(t.length ? t : ["10:00"]);
      setDays([]);
      setDayTimes({});
      setActive(-1);
    } else {
      const keys = norm.specs.map((s) => s.key);
      const map: Record<number, string[]> = {};
      for (const s of norm.specs) map[s.key] = slotsToText(s.times);
      if (!keys.length) {
        // 全新规则：先落在今天上，免得面板开出来是空的
        const d = recurrenceType === "weekly" ? now.getDay() : now.getDate();
        keys.push(d);
        map[d] = ["10:00"];
      }
      setDays(keys);
      setDayTimes(map);
      setActive(keys[0]);
    }
    setPendingDay("");
  }, [open, recurrenceType, initialConfig, initialDueDate, isDaily]);

  if (!open) return null;

  const mk = (key: MessageKey) => t(locale, key);
  const timeLimit = isDaily ? DAILY_TIME_LIMIT : PER_DAY_TIME_LIMIT;

  const activeList = isDaily ? times : (dayTimes[active] ?? ["10:00"]);

  const setActiveList = (next: string[]) => {
    if (isDaily) setTimes(next);
    else setDayTimes((prev) => ({ ...prev, [active]: next }));
  };

  const addTimeRow = () => {
    if (activeList.length >= timeLimit) return;
    const last = activeList[activeList.length - 1] ?? "10:00";
    setActiveList([...activeList, nextTimeAfter(last)]);
  };

  const removeTimeRow = (index: number) => {
    // 允许删到空：清空后由「确定」禁用 + 提示语兜住，重新设置靠清空/添加
    setActiveList(activeList.filter((_, i) => i !== index));
  };

  const clearTimes = () => setActiveList([]);

  /**
   * 星期胶囊三态：点未选中的 = 选上并开始编辑它；点已选中但不在编辑的 = 只切过去编辑；
   * 再点一次正在编辑的那个才是取消这天。
   */
  const toggleWeekday = (d: number) => {
    if (days.includes(d)) {
      if (active === d) {
        const next = days.filter((x) => x !== d);
        setDays(next);
        setActive(next[0] ?? -1);
      } else {
        setActive(d);
      }
      return;
    }
    setDays([...days, d].sort((a, b) => a - b));
    setDayTimes((prev) =>
      prev[d]?.length ? prev : { ...prev, [d]: activeList.length ? [...activeList] : ["10:00"] },
    );
    setActive(d);
  };

  const addDayOfMonth = () => {
    const v = Math.floor(Number(pendingDay));
    if (!Number.isFinite(v) || v < 1 || v > 31) return;
    if (days.includes(v) || days.length >= MONTHLY_DAY_LIMIT) return;
    setDays([...days, v].sort((a, b) => a - b));
    setDayTimes((prev) => ({ ...prev, [v]: prev[v]?.length ? prev[v] : [...activeList] }));
    setActive(v);
    setPendingDay("");
  };

  const removeDayOfMonth = (d: number) => {
    const next = days.filter((x) => x !== d);
    setDays(next);
    if (active === d) setActive(next[0] ?? -1);
  };

  const handleConfirm = () => {
    const cfg: RecurrenceConfig = { interval: 1 };
    if (isDaily) {
      cfg.times = activeList;
    } else if (recurrenceType === "weekly") {
      cfg.days = days;
      cfg.dayTimes = Object.fromEntries(
        days.map((d) => [String(d), dayTimes[d] ?? []]),
      );
    } else {
      cfg.daysOfMonth = days;
      cfg.dayOfMonth = days[0];
      cfg.dayTimes = Object.fromEntries(
        days.map((d) => [String(d), dayTimes[d] ?? []]),
      );
    }
    const config = JSON.stringify(cfg);
    const now = Date.now();
    const dueDate = computeNextDueDate(now, recurrenceType, config, now) || initialDueDate;
    onConfirm(recurrenceType, config, dueDate);
  };

  /**
   * 每一天都至少得有一个时间点才能确定 —— 否则「清空时间」后保存下来的是
   * 一条没有提醒时刻的规则，看起来设上了其实不会响。
   */
  const canConfirm = isDaily
    ? activeList.length > 0
    : days.length > 0 &&
      active >= 0 &&
      days.every((d) => (dayTimes[d] ?? []).length > 0);

  const labelStyle: React.CSSProperties = { color: "var(--ln-theme-text-secondary)" };
  const fieldStyle: React.CSSProperties = {
    borderColor: "var(--ln-theme-border)",
    background: "var(--ln-theme-surface)",
    color: "var(--ln-theme-text)",
    colorScheme: scheme,
  };
  const btnBase = "flex items-center justify-center rounded-md border text-[12px] transition";

  const titleKey = (
    isDaily ? "recurTitleDaily" : recurrenceType === "weekly" ? "recurTitleWeekly" : "recurTitleMonthly"
  ) as MessageKey;

  return (
    <div
      className="fixed inset-0 z-[170] flex items-center justify-center"
      style={{ background: "var(--ln-theme-overlay)" }}
      onClick={onCancel}
    >
      <div
        className="ln-recur-panel max-h-[92%] w-[296px] overflow-y-auto rounded-xl p-3 shadow-2xl"
        style={{
          background: "var(--ln-theme-bg)",
          backdropFilter: "var(--ln-theme-backdrop)",
          WebkitBackdropFilter: "var(--ln-theme-backdrop)",
          border: "1px solid var(--ln-theme-border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3
          className="mb-2.5 text-[13px] font-semibold"
          style={{ color: "var(--ln-theme-text)" }}
        >
          {mk(titleKey)}
        </h3>

        {/* 每周：星期多选。选中描边，正在编辑实心 */}
        {recurrenceType === "weekly" ? (
          <div className="mb-2.5">
            <div className="mb-1 text-[11px]" style={labelStyle}>
              {mk("recurPickDay")}
            </div>
            <div className="flex gap-1">
              {WEEK_ORDER.map((d) => {
                const selected = days.includes(d);
                const editing = active === d;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleWeekday(d)}
                    className={`${btnBase} h-7 flex-1`}
                    style={{
                      borderColor: selected ? ACCENT : "var(--ln-theme-border)",
                      background: editing ? ACCENT : selected ? "rgba(14,165,233,0.14)" : "var(--ln-theme-surface)",
                      color: editing ? "#fff" : selected ? ACCENT : "var(--ln-theme-text-secondary)",
                      fontWeight: selected ? 600 : 400,
                    }}
                  >
                    {wdLabels[d]}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* 每月：先输入号数再加，已加的显示成可删的角标 */}
        {recurrenceType === "monthly" ? (
          <div className="mb-2.5">
            <div className="mb-1 text-[11px]" style={labelStyle}>
              {mk("recurPickDayOfMonth")}
            </div>
            <div className="mb-1.5 flex items-center gap-1.5">
              <input
                type="number"
                min={1}
                max={31}
                value={pendingDay}
                placeholder="--"
                onChange={(e) => setPendingDay(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addDayOfMonth();
                }}
                className="ln-no-spin h-7 w-14 rounded-md border px-1.5 text-center text-[12px] focus:outline-none"
                style={fieldStyle}
              />
              <span className="text-[11px]" style={labelStyle}>
                {mk("recurDayUnit")}
              </span>
              <button
                type="button"
                title={t(locale, "recurDayLimit", { n: MONTHLY_DAY_LIMIT })}
                disabled={days.length >= MONTHLY_DAY_LIMIT}
                onClick={addDayOfMonth}
                className={`${btnBase} h-7 w-7`}
                style={{
                  borderColor: "var(--ln-theme-border)",
                  background: "var(--ln-theme-surface)",
                  color: "var(--ln-theme-text)",
                  opacity: days.length >= MONTHLY_DAY_LIMIT ? 0.35 : 1,
                }}
              >
                +
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {days.map((d) => {
                const editing = active === d;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setActive(d)}
                    className={`${btnBase} relative h-7 min-w-[30px] px-1.5`}
                    style={{
                      borderColor: editing ? ACCENT : "var(--ln-theme-border)",
                      background: editing ? ACCENT : "rgba(14,165,233,0.14)",
                      color: editing ? "#fff" : ACCENT,
                      fontWeight: 600,
                    }}
                  >
                    {d}
                    <span
                      role="button"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeDayOfMonth(d);
                      }}
                      className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[9px] leading-none"
                      style={{
                        background: "var(--ln-theme-surface-active)",
                        color: "var(--ln-theme-text-secondary)",
                      }}
                    >
                      ×
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {/* 时间行：最后一行是 +，其余行是 − */}
        {!isDaily && active < 0 ? (
          <div className="mb-2.5 text-[11px]" style={labelStyle}>
            {mk("recurEmptyDay")}
          </div>
        ) : (
          <div className="mb-1">
            <div className="mb-1 flex items-center justify-between">
              <div className="text-[11px]" style={labelStyle}>
                {mk("recurPickTime")}
                {!isDaily ? (
                  <span style={{ color: ACCENT }}>
                    {recurrenceType === "weekly"
                      ? ` · ${wdLabels[active]}`
                      : ` · ${active}${mk("recurDayUnit")}`}
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={clearTimes}
                disabled={!activeList.length}
                className="rounded px-1 py-0.5 text-[11px] transition disabled:opacity-35"
                style={{ color: "var(--ln-theme-text-secondary)" }}
              >
                {mk("recurClearTimes")}
              </button>
            </div>
            {activeList.length ? (
              <div className="flex flex-col gap-1.5">
                {activeList.map((value, i) => {
                  const isLast = i === activeList.length - 1;
                  return (
                    <div key={i} className="flex items-center gap-1.5">
                      <input
                        type="time"
                        value={value}
                        onChange={(e) => {
                          const next = [...activeList];
                          next[i] = e.target.value || value;
                          setActiveList(next);
                        }}
                        className="h-7 w-[86px] rounded-md border px-1.5 text-[12px] focus:outline-none"
                        style={fieldStyle}
                      />
                      {/* 每一行都能删；只有最后一行带 + */}
                      <button
                        type="button"
                        title={mk("recurClearTimes")}
                        onClick={() => removeTimeRow(i)}
                        className={`${btnBase} h-6 w-6`}
                        style={{
                          borderColor: "var(--ln-theme-border)",
                          background: "transparent",
                          color: "var(--ln-theme-text)",
                        }}
                      >
                        −
                      </button>
                      {isLast ? (
                        <button
                          type="button"
                          title={t(locale, "recurTimeLimit", { n: timeLimit })}
                          disabled={activeList.length >= timeLimit}
                          onClick={addTimeRow}
                          className={`${btnBase} h-6 w-6`}
                          style={{
                            borderColor: "var(--ln-theme-border)",
                            background: "transparent",
                            color: "var(--ln-theme-text)",
                            opacity: activeList.length >= timeLimit ? 0.35 : 1,
                          }}
                        >
                          +
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex items-center gap-1.5 py-0.5">
                <span className="text-[11px]" style={labelStyle}>
                  {mk("recurNoTime")}
                </span>
                {/* 清空后总得有个入口再加回来 */}
                <button
                  type="button"
                  title={t(locale, "recurTimeLimit", { n: timeLimit })}
                  onClick={addTimeRow}
                  className={`${btnBase} h-6 w-6`}
                  style={{
                    borderColor: "var(--ln-theme-border)",
                    background: "transparent",
                    color: "var(--ln-theme-text)",
                  }}
                >
                  +
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="ln-recur-ok h-7 rounded-lg px-3 transition"
            style={{
              background: "var(--ln-theme-surface)",
              color: "var(--ln-theme-text-secondary)",
            }}
          >
            {mk("cancel")}
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={handleConfirm}
            className="ln-recur-ok h-7 rounded-lg px-3 text-white transition disabled:opacity-40"
            style={{ background: canConfirm ? ACCENT : "var(--ln-theme-surface-active)" }}
          >
            {mk("confirm")}
          </button>
        </div>
      </div>

      <style>{`
        /* index.css 里未分层的 input,textarea,button{font:inherit} 会盖掉 Tailwind
           分层里的 text-[Npx]，所以面板内控件字号在这里显式压回来 */
        .ln-recur-panel, .ln-recur-panel input, .ln-recur-panel button { font-size: 12px; }
        .ln-recur-panel .ln-recur-ok { font-size: 13px; }
        .ln-no-spin::-webkit-outer-spin-button,
        .ln-no-spin::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .ln-no-spin { -moz-appearance: textfield; appearance: textfield; }
        .ln-recur-panel input[type="time"]::-webkit-calendar-picker-indicator { opacity: 0.45; }
      `}</style>
    </div>
  );
}

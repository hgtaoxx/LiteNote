import { useEffect, useRef } from "react";
import type { Locale } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { t } from "@/i18n";
import { TODO_COLOR_IMPORTANCE_ORDER } from "@/lib/todoImportanceColors";
import { COLOR_DOT_STYLE } from "@/lib/itemColors";
import { todayEnd, tomorrowEnd, weekendEnd, formatDueDate } from "@/lib/dueDate";
import type { TodoColorId, RecurrenceType } from "@/types/todo";

const COLOR_TITLE_KEY: Record<TodoColorId, MessageKey> = {
  hollow: "colorPriorityHollow",
  none: "colorPriorityNone",
  attention: "colorPriorityAttention",
  important: "colorPriorityImportant",
  urgent: "colorPriorityUrgent",
};

const RECURRENCE_LABELS: Array<{
  type: RecurrenceType;
  key: MessageKey;
}> = [
  { type: "daily", key: "recurDaily" },
  { type: "weekly", key: "recurWeekly" },
  { type: "monthly", key: "recurMonthly" },
];

interface TodoContextMenuProps {
  locale: Locale;
  x: number;
  y: number;
  completed: boolean;
  pinned: boolean;
  dueDate: number;
  isRecurring: boolean;
  onClose: () => void;
  onPin: () => void;
  /** 进入「排序」模式（拖动待办上下排序） */
  onStartSort: () => void;
  onDelete: () => void;
  onToggleDone: () => void;
  onPickColor: (c: TodoColorId) => void;
  onPickDueDate: (ts: number) => void;
  onOpenCustomDueDate: () => void;
  onClearDueDate: () => void;
  onSetRecurrence: (type: RecurrenceType) => void;
  onClearRecurrence: () => void;
  onCopyTo: () => void;
}

export function TodoContextMenu({
  locale,
  x,
  y,
  completed,
  pinned,
  dueDate,
  isRecurring,
  onClose,
  onPin,
  onStartSort,
  onDelete,
  onToggleDone,
  onPickColor,
  onPickDueDate,
  onOpenCustomDueDate,
  onClearDueDate,
  onSetRecurrence,
  onClearRecurrence,
  onCopyTo,
}: TodoContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const tId = window.setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      window.clearTimeout(tId);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  const item =
    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-neutral-800 hover:bg-neutral-100";

  const mk = (key: MessageKey) => t(locale, key);

  const dueLabel = dueDate > 0 ? formatDueDate(dueDate, locale === "en" ? "en" : "zh-CN") : null;

  const quickBtn =
    "rounded-md border border-neutral-300 px-1.5 py-0.5 text-neutral-700 hover:bg-neutral-100 transition";

  return (
    <div
      ref={ref}
      className="fixed z-[150] min-w-[10rem] rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        top: Math.min(y, window.innerHeight - 420),
        /*
          字号用内联样式，不用 Tailwind 任意值类（text-[13px]）：
          实测它们虽然被生成了（.text-\[13px\]{font-size:13px}），但在实际渲染中
          并没有生效（同项目里下拉菜单字号也踩过同一个坑）。
          内联样式优先级最高，必定落地；子元素继承，快捷按钮再单独覆盖成 11px。
        */
        fontSize: 13,
      }}
      role="menu"
    >
      {!completed ? (
        <button
          type="button"
          className={item}
          role="menuitem"
          onClick={() => {
            onPin();
            onClose();
          }}
        >
          <span aria-hidden>↑</span>
          {mk(pinned ? "menuUnpin" : "menuPin")}
        </button>
      ) : null}

      {/* 排序：紧跟在「置顶」下方（用户指定位置）—— 进入后可上下拖动待办 */}
      {!completed ? (
        <button
          type="button"
          className={item}
          role="menuitem"
          onClick={() => {
            onStartSort();
            onClose();
          }}
        >
          <span aria-hidden>⇅</span>
          {mk("menuSort")}
        </button>
      ) : null}

      <div className={completed ? "py-1" : "border-t border-neutral-100 py-1"}>
        <div className="px-2.5 py-1 text-neutral-500" style={{ fontSize: 11 }}>{mk("menuColor")}</div>
        <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1">
          {TODO_COLOR_IMPORTANCE_ORDER.map((c) => (
            <button
              key={c}
              type="button"
              /* 色板圆点缩到原来的 80%（28px → 22.4px）；
                 hollow 用 COLOR_DOT_STYLE 的空心描边样式，所以这里整体展开该样式 */
              className="h-[1.4rem] w-[1.4rem] rounded-full border border-neutral-300/90 shadow-sm ring-offset-1 ring-offset-white transition hover:ring-2 hover:ring-neutral-400/60 focus-visible:outline focus-visible:ring-2 focus-visible:ring-sky-400"
              style={{ ...COLOR_DOT_STYLE[c] }}
              title={mk(COLOR_TITLE_KEY[c])}
              aria-label={mk(COLOR_TITLE_KEY[c])}
              onClick={() => {
                onPickColor(c);
                onClose();
              }}
            />
          ))}
        </div>
      </div>

      {!completed ? (
        <>
          {/* 截止时间：循环待办不显示（时间已由循环规则确定） */}
          {!isRecurring ? (
            <div className="border-t border-neutral-100 py-1">
              <div className="flex items-center justify-between px-2.5 py-1" style={{ fontSize: 11 }}>
                <span className="text-neutral-500">{mk("menuDueDate")}</span>
                {dueLabel ? (
                  <span className="text-sky-600">{dueLabel}</span>
                ) : null}
              </div>
              <div className="flex items-center gap-1.5 px-2 pb-1" style={{ fontSize: 11 }}>
                <button
                  type="button"
                  className={quickBtn}
                  onClick={() => {
                    onPickDueDate(todayEnd());
                    onClose();
                  }}
                >
                  {mk("dueToday")}
                </button>
                <button
                  type="button"
                  className={quickBtn}
                  onClick={() => {
                    onPickDueDate(tomorrowEnd());
                    onClose();
                  }}
                >
                  {mk("dueTomorrow")}
                </button>
                <button
                  type="button"
                  className={quickBtn}
                  onClick={() => {
                    onPickDueDate(weekendEnd());
                    onClose();
                  }}
                >
                  {mk("dueWeekend")}
                </button>
              </div>
              <button
                type="button"
                className={item}
                role="menuitem"
                onClick={() => {
                  onOpenCustomDueDate();
                  onClose();
                }}
              >
                {mk("dueCustom")}
              </button>
              {dueDate > 0 ? (
                <button
                  type="button"
                  className={item}
                  role="menuitem"
                  onClick={() => {
                    onClearDueDate();
                    onClose();
                  }}
                >
                  {mk("dueClear")}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* 循环规则 */}
          <div className="border-t border-neutral-100 py-1">
            <div className="px-2.5 py-1 text-neutral-500" style={{ fontSize: 11 }}>{mk("menuRecurrence")}</div>
            <div className="flex items-center gap-1.5 px-2 pb-1" style={{ fontSize: 11 }}>
              {RECURRENCE_LABELS.map(({ type }) => (
                <button
                  key={type}
                  type="button"
                  className={`${quickBtn} ${
                    isRecurring && type === "daily"
                      ? "bg-sky-100 border-sky-300 text-sky-700"
                      : ""
                  }`}
                  onClick={() => {
                    onSetRecurrence(type);
                    onClose();
                  }}
                >
                  {mk(`recur${type.charAt(0).toUpperCase() + type.slice(1)}` as MessageKey)}
                </button>
              ))}
            </div>
            {isRecurring ? (
              <button
                type="button"
                className={item}
                role="menuitem"
                onClick={() => {
                  onClearRecurrence();
                  onClose();
                }}
              >
                {mk("recurClear")}
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      <div className="border-t border-neutral-100">
        <button type="button" className={item} role="menuitem" onClick={() => { onCopyTo(); onClose(); }}>
          {mk("menuCopyTo")}
        </button>
        <button type="button" className={item} role="menuitem" onClick={() => { onDelete(); onClose(); }}>
          {mk("menuDelete")}
        </button>
        {!isRecurring || !completed ? (
          <button type="button" className={item} role="menuitem" onClick={() => { onToggleDone(); onClose(); }}>
            {completed
              ? mk("menuUndone")
              : isRecurring
                ? mk("menuDoneCycle")
                : mk("menuDone")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

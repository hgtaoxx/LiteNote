import { useEffect, useMemo, useRef } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Locale } from "@/i18n";
import { t } from "@/i18n";
import { COLOR_DOT_STYLE } from "@/lib/itemColors";
import { formatDueDate } from "@/lib/dueDate";
import { formatRecurrence, computeNextDueDate } from "@/lib/recurrence";
import type { TodoItem } from "@/types/todo";
import { useNow } from "@/hooks/useNow";

/**
 * 内容区（待办行）排版规范 —— 完整模式与专注模式共用：
 *   · 字号来自设置里的「内容字号」（WidgetShell 写成 CSS 变量 --ln-content-font-size），
 *     14px 只是变量缺失时的兜底；单行 / 多行完全一致
 *   · 行距 1.6 倍：随字号缩放，多行时比 1.5 更舒展
 *   · 上下内边距各 6px；多行自动换行、高度弹性增长
 *   · 用内联样式固定字号 / 行高 / 字体：显示态与编辑态 textarea 必须完全一致。
 *     表单控件默认 font 与 padding 不受 Tailwind preflight 完全重置（v4 不再清零 padding），
 *     只靠 class 会让编辑时的字看起来更大。
 */
const TODO_TEXT_STYLE: React.CSSProperties = {
  fontSize: "var(--ln-content-font-size, 14px)",
  lineHeight: 1.6,
  fontFamily: "var(--ln-content-font-family, inherit)",
};
// 行距：原来 py-1.5（上下各 6px）行与行之间显得很空，收成 py-0.5（上下各 2px）
// 专注模式（FocusTodoRow）用这一套
const TODO_ROW_PAD_Y = "py-0.5";

/**
 * 完整模式正文块的竖向内边距。
 * **下内边距刻意留 0**：下方日期行的 marginTop 已经负责了间距，
 * 正文这边再留一份就会两个变量叠加、怎么调都调不准。
 * 于是「正文 → 日期」的可见距离只由 DATE_GAP_Y 一个数字决定。
 */
const DATE_BLOCK_PAD = "pt-0.5 pb-0";

/**
 * 创建 / 完成日期的字号。
 * 中文「六号」≈ 7.5pt ≈ 10px，用户反馈偏大，收成 9px（暂定值，要调改这一个数字）。
 * 进行中与已完成共用，保证两者显示格式一致。
 */
const DATE_FONT_SIZE = 9;

/**
 * 日期与正文之间的**可见**距离。
 * 6px → 3px（用户反馈再缩小一半）。
 * 这是唯一需要调的数字：进行中与已完成共用，改成 0 或负数都可以（负数更贴）。
 */
const DATE_GAP_Y = 3;

/**
 * 正文行高带来的「隐性空隙」系数（半行距）。
 *
 * 正文用 line-height: 1.6 排版（多行可读性需要），字号 F 时行盒高 1.6F，
 * 而中文（楷体等）字形的 em 盒约占 1.0F —— 多出来的部分平均分到上下，
 * 每侧约 (1.6 − 1.0) / 2 = 0.3F。14px 时就是 4.2px。
 *
 * 关键：这部分属于**行盒内部**，不是 margin/padding，
 * 所以只调间距是压不下去的（这正是「改了间距却没效果」的原因）。
 * 只能反过来用**负 margin** 把它吃掉。
 */
const CONTENT_HALF_LEADING = 0.3;

interface TodoRowProps {
  todo: TodoItem;
  locale: Locale;
  selected: boolean;
  editing: boolean;
  /** 专注模式：仅展示 + 勾选，无编辑/拖拽/右键 */
  focusMode?: boolean;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onChangeText: (text: string) => void;
  onEndEdit: () => void;
  onToggleCompleted: () => void;
}

export function TodoRow(props: TodoRowProps) {
  if (props.focusMode) {
    return (
      <FocusTodoRow
        todo={props.todo}
        locale={props.locale}
        onToggleCompleted={props.onToggleCompleted}
      />
    );
  }
  return <ManagementTodoRow {...props} />;
}

function FocusTodoRow({
  todo,
  locale,
  onToggleCompleted,
}: {
  todo: TodoItem;
  locale: Locale;
  onToggleCompleted: () => void;
}) {
  const accent = COLOR_DOT_STYLE[todo.colorId].background;

  return (
    <div
      data-tauri-no-drag
      className="flex cursor-default items-center gap-1 px-2 sm:px-3"
      style={{ borderBottom: `1px solid var(--ln-theme-border)` }}
    >
      {todo.isRecurring ? (
        <button
          type="button"
          data-tauri-no-drag
          aria-label={t(locale, "menuDone")}
          title={locale === "zh-CN" ? "完成本轮循环" : "Complete this cycle"}
          className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-white/50"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCompleted();
          }}
        >
          <span
            className="flex h-[0.875rem] w-[0.875rem] items-center justify-center rounded-full"
            style={{ background: accent }}
          />
          {/* 循环角标 */}
          <span
            className="pointer-events-none absolute -right-0.5 -top-0.5 text-[0.55rem] leading-none"
            style={{ color: accent }}
          >
            ↻
          </span>
        </button>
      ) : (
        <button
          type="button"
          data-tauri-no-drag
          aria-label={t(locale, "menuDone")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full outline-none transition focus-visible:ring-2 focus-visible:ring-white/50"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCompleted();
          }}
        >
          <span
            className="flex h-[0.875rem] w-[0.875rem] items-center justify-center rounded-full"
            style={{ background: accent }}
          />
        </button>
      )}
      {/*
        正文与完整模式共用同一套排版令牌（TODO_TEXT_STYLE / TODO_ROW_PAD_Y），
        圆点标记也与完整模式一致；多行内容同样换行完整显示。
        窗口高度改由渲染后实测得出，所以这里不再固定单行。
      */}
      <div className={`flex min-w-0 flex-1 flex-col ${TODO_ROW_PAD_Y}`}>
        <span
          className="whitespace-pre-wrap break-words"
          style={{ color: "var(--ln-theme-text)", ...TODO_TEXT_STYLE }}
        >
          {todo.text || (locale === "zh-CN" ? "（空）" : "(empty)")}
        </span>
      </div>
    </div>
  );
}

/**
 * 时间戳 →「9月28日」。
 *
 * 刻意不做「今天 / 明天」这种相对化：创建与完成日期是已经发生的事实，
 * 用绝对日期表述更清楚；跨年时补上年份避免歧义。
 */
function formatStamp(ts: number, locale: Locale): string {
  if (!ts || ts <= 0) return "";
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();

  if (locale === "en") {
    return sameYear ? `${m}/${day}` : `${m}/${day}/${d.getFullYear()}`;
  }
  return sameYear ? `${m}月${day}日` : `${d.getFullYear()}年${m}月${day}日`;
}

function ManagementTodoRow({
  todo,
  locale,
  selected,
  editing,
  onSelect,
  onContextMenu,
  onChangeText,
  onEndEdit,
  onToggleCompleted,
}: Omit<TodoRowProps, "focusMode">) {
  const accent = COLOR_DOT_STYLE[todo.colorId].background;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 仅未完成且非编辑态的待办可拖拽
  const sortable = useSortable({
    id: todo.id,
    disabled: todo.completed || editing,
    data: { type: "todo" as const },
  });

  // 每分钟刷新当前时间戳，确保逾期状态能自动更新
  const now = useNow(60_000);

  const dueLabel = useMemo(() => {
    if (todo.dueDate <= 0) return null;

    // 循环待办：如果当前 dueDate 已过期，展示自动推进后的下一次时间
    if (todo.isRecurring && todo.dueDate <= Date.now()) {
      const nextDue = computeNextDueDate(
        todo.dueDate,
        todo.recurrenceType,
        todo.recurrenceConfig,
      );
      if (nextDue > 0) {
        return formatDueDate(nextDue, locale === "en" ? "en" : "zh-CN");
      }
      return null;
    }
    return formatDueDate(todo.dueDate, locale === "en" ? "en" : "zh-CN");
  }, [todo.dueDate, todo.isRecurring, todo.recurrenceType, todo.recurrenceConfig, locale, now]);

  const recurrenceLabel = useMemo(
    () =>
      todo.isRecurring
        ? formatRecurrence(
            todo.recurrenceType,
            todo.recurrenceConfig,
            locale === "en" ? "en" : "zh-CN",
          )
        : null,
    [todo.isRecurring, todo.recurrenceType, todo.recurrenceConfig, locale],
  );

  // 进入编辑态时，光标定位到文本末尾
  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  // 编辑态高度自适应：换行后行数变多时输入框跟着长高，避免出现内部滚动条
  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [editing, todo.text]);

  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  return (
    <div
      ref={sortable.setNodeRef}
      {...sortable.attributes}
      {...sortable.listeners}
      data-tauri-no-drag
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
      className={
        "flex cursor-default flex-wrap items-center gap-1 px-2 touch-none sm:px-3 " +
        (sortable.isDragging ? "opacity-0" : "") +
        (!selected ? " hover:bg-[var(--ln-theme-surface-hover)]" : "")
      }
      style={{
        ...style,
        borderBottom: `1px solid var(--ln-theme-border)`,
        background: selected ? "var(--ln-theme-surface-active)" : "transparent",
      }}
    >
      {/* 循环待办：显示可点击的完成按钮（带循环角标） */}
      {todo.isRecurring ? (
        <button
          type="button"
          data-tauri-no-drag
          aria-label={t(locale, "menuDone")}
          title={locale === "zh-CN" ? "完成本轮循环" : "Complete this cycle"}
          className={
            "relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full outline-none transition " +
            "focus-visible:ring-2 focus-visible:ring-white/50"
          }
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCompleted();
          }}
        >
          <span
            className="flex h-[0.875rem] w-[0.875rem] items-center justify-center rounded-full"
            style={{ background: accent }}
          />
          <span
            className="pointer-events-none absolute -right-0.5 -top-0.5 text-[0.6rem] leading-none"
            style={{ color: accent }}
          >
            ↻
          </span>
        </button>
      ) : (
        <button
          type="button"
          data-tauri-no-drag
          aria-pressed={todo.completed}
          aria-label={todo.completed ? t(locale, "menuUndone") : t(locale, "menuDone")}
          className={
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full outline-none transition " +
            "focus-visible:ring-2 focus-visible:ring-white/50"
          }
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCompleted();
          }}
        >
          <span
            className={
              "flex h-[0.875rem] w-[0.875rem] items-center justify-center rounded-full text-[0.5rem] font-semibold leading-none" +
              (todo.completed ? " text-white" : "")
            }
            style={{
              background: accent,
              // 已完成：内描边 + 勾号，与未完成的纯实心点区分
              boxShadow: todo.completed
                ? "inset 0 0 0 1px rgb(255 255 255 / 0.2)"
                : undefined,
            }}
          >
            {todo.completed ? "✓" : null}
          </span>
        </button>
      )}
      <button
        type="button"
        data-tauri-no-drag
        className="flex min-w-0 flex-1 items-center text-left cursor-pointer bg-transparent border-0"
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect();
          }
        }}
      >
        {/* 编辑态文本框与显示态完全对齐：rows=1 + 同一套竖向内边距（pt-0.5 pb-0） */}
        {editing ? (
          <textarea
            ref={textareaRef}
            data-tauri-no-drag
            className="w-0 flex-1 resize-none bg-transparent pt-0.5 pb-0 outline-none ring-0"
            style={{ color: "var(--ln-theme-text)", ...TODO_TEXT_STYLE }}
            rows={1}
            value={todo.text}
            onChange={(e) => onChangeText(e.target.value)}
            onBlur={onEndEdit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                (e.target as HTMLTextAreaElement).blur();
              } else if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                (e.target as HTMLTextAreaElement).blur();
              } else if (e.key === "Enter" && e.shiftKey) {
                e.stopPropagation(); // 允许默认换行，阻止冒泡到父按钮
              } else if (e.key === " ") {
                e.stopPropagation(); // 允许输入空格，阻止冒泡到父按钮
              }
            }}
          />
        ) : (
          <div className={`flex min-w-0 flex-1 flex-col ${DATE_BLOCK_PAD}`}>
            <span
              className={
                "whitespace-pre-wrap break-words" +
                (todo.completed && !todo.isRecurring ? " opacity-50 line-through" : "")
              }
              style={{ color: "var(--ln-theme-text)", ...TODO_TEXT_STYLE }}
            >
              {todo.text || (locale === "zh-CN" ? "（空）" : "(empty)")}
            </span>
            {(todo.pinned || dueLabel || recurrenceLabel) ? (
              <div className="mt-0.5 flex items-center gap-1.5">
                {todo.pinned ? (
                  <span className="text-xs" style={{ color: "var(--ln-theme-text-secondary)" }}>
                    ↑ {locale === "zh-CN" ? "置顶" : "Pinned"}
                  </span>
                ) : null}
                {recurrenceLabel ? (
                  <span className="text-xs" style={{ color: "var(--ln-theme-text-secondary)" }}>
                    ↻ {recurrenceLabel}
                  </span>
                ) : null}
                {dueLabel ? (
                  <span className="text-xs"
                    style={{ color: todo.completed ? "var(--ln-theme-text-muted)" : "var(--ln-theme-text-secondary)" }}
                  >
                    {dueLabel}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </button>

      {/*
        日期行：
          · 独占一整行：父级 flex-wrap + 这里的 w-full，横跨整行宽度
          · 进行中：只有创建日期，按用户要求放**右下角**（justify-end）
          · 已完成：创建日期在左、完成日期在右（justify-between）
          · 左右各内缩 1 个字符（1em 跟着字号走，改字号内缩同步变）
          · 与正文之间固定 DATE_GAP_Y（暂定 6px），日期贴着行底
      */}
      {todo.completed || todo.createTime > 0 ? (
        <div
          className={
            "flex w-full items-center " +
            (todo.completed ? "justify-between" : "justify-end")
          }
          style={{
            fontSize: DATE_FONT_SIZE,
            // 行高 1：日期自身不再产生额外半行距，间距完全由 DATE_GAP_Y 决定
            lineHeight: 1,
            /*
              让「正文 → 日期」的**可见**间距正好等于 DATE_GAP_Y。

              正文行盒 = 1.6 × 正文字号，字形只占约 (1 − 2×CONTENT_HALF_LEADING)，
              所以字形下方天然多出 CONTENT_HALF_LEADING × 正文字号 的空白；
              正文块的下内边距已刻意设为 0，于是：

                可见间距 = 半行距 + 这个 marginTop

              反推 marginTop = DATE_GAP_Y − 半行距。
              DATE_GAP_Y 可以填 0 甚至负数（负得越多，日期越往内容贴）。
            */
            marginTop: `calc(${DATE_GAP_Y}px - ${CONTENT_HALF_LEADING} * var(--ln-content-font-size, 14px))`,
            padding: "0 1em",
          }}
        >
          {/* 已完成才有左侧的创建日期；进行中只显示一个日期，落在右下角 */}
          {todo.completed ? (
            <span style={{ color: "var(--ln-theme-text-muted)" }}>
              {formatStamp(todo.createTime, locale)}
            </span>
          ) : null}
          <span style={{ color: "var(--ln-theme-text-muted)" }}>
            {todo.completed
              ? formatStamp(todo.completedTime, locale)
              : formatStamp(todo.createTime, locale)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

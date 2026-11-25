import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { t } from "@/i18n";
import { TODO_COLOR_IMPORTANCE_ORDER } from "@/lib/todoImportanceColors";
import { MARKER_COLOR_DOT_STYLE } from "@/lib/itemColors";
import { formatDueDate } from "@/lib/dueDate";
import { swatchInk } from "@/lib/categoryColors";
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

type MenuView = "main" | "due" | "recurrence";

interface TodoContextMenuProps {
  locale: Locale;
  x: number;
  y: number;
  completed: boolean;
  pinned: boolean;
  dueDate: number;
  isRecurring: boolean;
  /** true：色板使用新式荧光黄；false：使用旧式琥珀色 */
  importanceMarkerStyle: boolean;
  /** 该条目当前所属标签 */
  categoryId: string;
  /** 可选标签（含未分类），按左轨顺序 */
  categories: Array<{ id: string; name: string; bg: string }>;
  onClose: () => void;
  onPin: () => void;
  /** 进入「排序」模式（拖动待办上下排序） */
  onStartSort: () => void;
  onDelete: () => void;
  onToggleDone: () => void;
  onPickColor: (c: TodoColorId) => void;
  onPickCategory: (id: string) => void;
  /** 右键菜单里直接新建标签并归类 */
  onCreateCategory: (name: string) => void;
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
  importanceMarkerStyle,
  categoryId,
  categories,
  onClose,
  onPin,
  onStartSort,
  onDelete,
  onToggleDone,
  onPickColor,
  onPickCategory,
  onCreateCategory,
  onOpenCustomDueDate,
  onClearDueDate,
  onSetRecurrence,
  onClearRecurrence,
  onCopyTo,
}: TodoContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<MenuView>("main");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const dotStyles = MARKER_COLOR_DOT_STYLE[
    importanceMarkerStyle ? "gradient" : "legacy"
  ];

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
    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[var(--ln-theme-text)] hover:bg-[var(--ln-theme-surface-hover)]";

  const mk = (key: MessageKey) => t(locale, key);

  const dueLabel = dueDate > 0 ? formatDueDate(dueDate, locale === "en" ? "en" : "zh-CN") : null;

  const chip =
    "rounded-full border px-1.5 py-0.5 transition hover:bg-[var(--ln-theme-surface-hover)]";
  const chipStyle: React.CSSProperties = {
    fontSize: 11,
    borderColor: "var(--ln-theme-border)",
    color: "var(--ln-theme-text)",
  };

  const backRow = (
    <button
      type="button"
      className="flex w-full items-center gap-1.5 border-b px-2.5 py-1.5 text-left hover:bg-[var(--ln-theme-surface-hover)]"
      style={{ borderColor: "var(--ln-theme-border)", color: "var(--ln-theme-text-secondary)", fontSize: 12 }}
      onClick={() => setView("main")}
    >
      <span aria-hidden>‹</span>
      {mk("menuBack")}
    </button>
  );

  const commitCreate = () => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    onCreateCategory(name);
    setCreating(false);
    setNewName("");
    onClose();
  };

  return (
    <div
      ref={ref}
      className="fixed z-[150] min-w-[10rem] rounded-lg border py-1 shadow-lg"
      style={{
        left: Math.min(x, window.innerWidth - 220),
        // 菜单比面板高时别顶出屏幕：贴顶留 8px，内部滚动
        top: Math.max(8, Math.min(y, window.innerHeight - 420)),
        maxHeight: "calc(100vh - 16px)",
        overflowY: "auto",
        background: "var(--ln-theme-bg)",
        borderColor: "var(--ln-theme-border)",
        backdropFilter: "var(--ln-theme-backdrop)",
        color: "var(--ln-theme-text)",
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
      {view === "main" ? (
        <>
          {!completed ? (
            <>
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

              {/* 排序：紧跟在「置顶」下方（用户指定位置）—— 进入后可上下拖动待办 */}
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
            </>
          ) : null}

          {/* 标签：一条待办只属于一个标签，直接点选即可归类；关掉标签开关时这一排整块消失 */}
          {categories.length > 0 ? (
          <div className={completed ? "py-1" : "border-t border-[var(--ln-theme-border)] py-1"}>
            <div className="px-2.5 py-1 text-[var(--ln-theme-text-secondary)]" style={{ fontSize: 11 }}>
              {mk("catMenuTitle")}
            </div>
            <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={chip}
                  style={{
                    ...chipStyle,
                    background:
                      c.id === categoryId ? c.bg : "transparent",
                    color: c.id === categoryId ? swatchInk(c.bg) : chipStyle.color,
                    fontWeight: c.id === categoryId ? 700 : 400,
                  }}
                  onClick={() => {
                    onPickCategory(c.id);
                    onClose();
                  }}
                >
                  {c.name}
                </button>
              ))}
              {creating ? (
                <input
                  autoFocus
                  value={newName}
                  maxLength={40}
                  placeholder={mk("catAddPlaceholder")}
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={commitCreate}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") commitCreate();
                    if (e.key === "Escape") {
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                  className="rounded-full border px-1.5 py-0.5 outline-none"
                  style={{
                    ...chipStyle,
                    width: 84,
                    background: "var(--ln-theme-surface)",
                  }}
                />
              ) : (
                <button
                  type="button"
                  className={chip}
                  style={{ ...chipStyle, borderStyle: "dashed", color: "var(--ln-theme-text-secondary)" }}
                  onClick={() => setCreating(true)}
                >
                  {mk("catNew")}
                </button>
              )}
            </div>
          </div>
          ) : null}

          {/* 重要性程度：直接平铺，不再收进子页 */}
          <div className="border-t border-[var(--ln-theme-border)] py-1">
            <div className="px-2.5 py-1 text-[var(--ln-theme-text-secondary)]" style={{ fontSize: 11 }}>
              {mk("menuColor")}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 px-2 pb-1">
              {TODO_COLOR_IMPORTANCE_ORDER.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="menuitem"
                  /* 色板圆点缩到原来的 80%（28px → 22.4px）；
                     hollow 沿用描边样式，important 的色值跟随当前标记样式 */
                  className="h-[1.4rem] w-[1.4rem] rounded-full border border-[var(--ln-theme-border)] shadow-sm ring-offset-1 ring-offset-[var(--ln-theme-surface)] transition hover:ring-2 hover:ring-[var(--ln-theme-text-muted)] focus-visible:outline focus-visible:ring-2 focus-visible:ring-[var(--ln-theme-today)]"
                  style={{ ...dotStyles[c] }}
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
              {!isRecurring ? (
                <button
                  type="button"
                  className="flex w-full items-center justify-between border-t px-2.5 py-1.5 text-left hover:bg-[var(--ln-theme-surface-hover)]"
                  style={{ borderColor: "var(--ln-theme-border)", color: "var(--ln-theme-text)" }}
                  role="menuitem"
                  onClick={() => setView("due")}
                >
                  <span className="flex items-center gap-1.5">
                    {mk("menuDueDate")}
                    {dueLabel ? (
                      <span style={{ color: "var(--ln-theme-text-secondary)", fontSize: 11 }}>{dueLabel}</span>
                    ) : null}
                  </span>
                  <span aria-hidden style={{ color: "var(--ln-theme-text-muted)" }}>›</span>
                </button>
              ) : null}

              <button
                type="button"
                className="flex w-full items-center justify-between border-t px-2.5 py-1.5 text-left hover:bg-[var(--ln-theme-surface-hover)]"
                style={{ borderColor: "var(--ln-theme-border)", color: "var(--ln-theme-text)" }}
                role="menuitem"
                onClick={() => setView("recurrence")}
              >
                {mk("menuRecurrence")}
                <span aria-hidden style={{ color: "var(--ln-theme-text-muted)" }}>›</span>
              </button>
            </>
          ) : null}

          <div className="border-t border-[var(--ln-theme-border)]">
            <button type="button" className={item} role="menuitem" onClick={() => { onCopyTo(); onClose(); }}>
              {mk("menuCopyTo")}
            </button>
            <button type="button" className={item} role="menuitem" onClick={() => { onDelete(); onClose(); }}>
              {mk("menuDelete")}
            </button>
            {!isRecurring || !completed ? (
              <button type="button" className={item} role="menuitem" onClick={() => { onToggleDone(); onClose(); }}>
                {/* 完成即终结（循环规则一并清掉），所以不再区分「本轮」 */}
                {completed ? mk("menuUndone") : mk("menuDone")}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {backRow}

          {view === "due" ? (
            <div className="py-1">
              <div className="flex items-center justify-between px-2.5 py-1" style={{ fontSize: 11 }}>
                <span className="text-[var(--ln-theme-text-secondary)]">{mk("menuDueDate")}</span>
                {dueLabel ? (
                  <span className="text-[var(--ln-theme-text-secondary)]">{dueLabel}</span>
                ) : null}
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

          {view === "recurrence" ? (
            <div className="py-1">
              <div className="px-2.5 py-1 text-[var(--ln-theme-text-secondary)]" style={{ fontSize: 11 }}>
                {mk("menuRecurrence")}
              </div>
              {RECURRENCE_LABELS.map(({ type, key }) => (
                <button
                  key={type}
                  type="button"
                  className={item}
                  role="menuitem"
                  onClick={() => {
                    onSetRecurrence(type);
                    onClose();
                  }}
                >
                  {mk(key)}
                </button>
              ))}
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
          ) : null}
        </>
      )}
    </div>
  );
}

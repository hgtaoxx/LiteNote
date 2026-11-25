import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/i18n";
import { t } from "@/i18n";
import {
  CATEGORY_COLORS,
  NO_CATEGORY_COLOR,
  NO_CATEGORY_SWATCH,
} from "@/lib/categoryColors";
import { ConfirmDialog } from "./ConfirmDialog";

interface CategoryManagerModalProps {
  open: boolean;
  locale: Locale;
  /** 仅自定义分类，已按显示顺序排好；color 是当前实际底色，storedColor 是库里存的 */
  items: Array<{
    id: string;
    name: string;
    count: number;
    color: string;
    storedColor: string | null;
  }>;
  /** 默认分类（未分类）：只展示计数，不能改名也不能删 */
  systemItem: { name: string; count: number } | null;
  onClose: () => void;
  onAdd: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onSetColor: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, delta: number) => void;
}

export function CategoryManagerModal({
  open,
  locale,
  items,
  systemItem,
  onClose,
  onAdd,
  onRename,
  onSetColor,
  onDelete,
  onMove,
}: CategoryManagerModalProps) {
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string; count: number } | null>(null);
  /** 同一时刻只开一个取色弹层 */
  const [picker, setPicker] = useState<{ id: string; x: number; y: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setDraft("");
      setRenamingId(null);
      setPendingDelete(null);
      setPicker(null);
    }
  }, [open]);

  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (pickerRef.current?.contains(el)) return;
      // 色块按钮自己负责开合，别在这里抢着关掉
      if (el.closest("[data-cat-swatch]")) return;
      setPicker(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [picker]);

  if (!open) return null;

  const mk = () => t(locale, "catManageTitle");
  const btn =
    "rounded-md border px-2 py-0.5 transition hover:bg-[var(--ln-theme-surface-hover)]";
  const btnStyle: React.CSSProperties = {
    borderColor: "var(--ln-theme-border)",
    color: "var(--ln-theme-text)",
    fontSize: 11,
  };

  const commitAdd = () => {
    const name = draft.trim();
    if (!name) return;
    onAdd(name);
    setDraft("");
  };

  const commitRename = (id: string) => {
    if (renamingId !== id) return;
    onRename(id, renameValue);
    setRenamingId(null);
  };

  const pickerItem = picker ? (items.find((x) => x.id === picker.id) ?? null) : null;

  return (
    <>
      <div
        className="fixed inset-0 z-[155] flex items-center justify-center"
        style={{ background: "var(--ln-theme-overlay)" }}
        onClick={onClose}
      >
        <div
          className="flex max-h-[88vh] w-[86%] max-w-[360px] flex-col rounded-lg px-4 py-4 shadow-2xl"
          style={{ background: "var(--ln-theme-bg)", backdropFilter: "var(--ln-theme-backdrop)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold" style={{ color: "var(--ln-theme-text)" }}>
              {mk()}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-white/10"
              style={{ color: "var(--ln-theme-text-secondary)" }}
            >
              ×
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <p className="py-2" style={{ color: "var(--ln-theme-text-secondary)", fontSize: 12 }}>
                {t(locale, "catManageEmpty")}
              </p>
            ) : (
              items.map((item, index) => {
                const renaming = renamingId === item.id;
                return (
                  <div
                    key={item.id}
                    className="flex items-center gap-1.5 border-b py-1.5"
                    style={{ borderColor: "var(--ln-theme-border)" }}
                  >
                    <button
                      type="button"
                      data-cat-swatch={item.id}
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setPicker(
                          picker?.id === item.id
                            ? null
                            : { id: item.id, x: rect.left - 6, y: rect.bottom + 6 },
                        );
                      }}
                      className="shrink-0 rounded-[3px]"
                      style={{
                        width: 12,
                        height: 12,
                        background: item.color,
                        border: "1px solid #cbd5e1",
                        cursor: "pointer",
                      }}
                      title={t(locale, "catColor")}
                    />
                    {renaming ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(item.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(item.id);
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                        className="min-w-0 flex-1 rounded px-1.5 py-0.5 outline-none"
                        style={{
                          fontSize: 12,
                          color: "var(--ln-theme-text)",
                          background: "var(--ln-theme-surface)",
                          border: "1px solid var(--ln-theme-border)",
                        }}
                      />
                    ) : (
                      <span
                        className="min-w-0 flex-1 cursor-text truncate"
                        style={{ color: "var(--ln-theme-text)", fontSize: 12 }}
                        onDoubleClick={() => {
                          setRenamingId(item.id);
                          setRenameValue(item.name);
                        }}
                      >
                        {item.name}
                      </span>
                    )}
                    <span style={{ color: "var(--ln-theme-text-muted)", fontSize: 11 }}>{item.count}</span>
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => onMove(item.id, -1)}
                      className={btn}
                      style={{ ...btnStyle, opacity: index === 0 ? 0.35 : 1 }}
                      title={t(locale, "catMoveUp")}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      disabled={index === items.length - 1}
                      onClick={() => onMove(item.id, 1)}
                      className={btn}
                      style={{ ...btnStyle, opacity: index === items.length - 1 ? 0.35 : 1 }}
                      title={t(locale, "catMoveDown")}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={btn}
                      style={{ ...btnStyle, color: "#f87171" }}
                      onClick={() => setPendingDelete(item)}
                    >
                      {t(locale, "catDelete")}
                    </button>
                  </div>
                );
              })
            )}

            {systemItem ? (
              <div
                className="flex items-center gap-1.5 border-b py-1.5"
                style={{ borderColor: "var(--ln-theme-border)" }}
              >
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--ln-theme-text-secondary)", fontSize: 12 }}>
                  {systemItem.name}
                </span>
                <span style={{ color: "var(--ln-theme-text-muted)", fontSize: 11 }}>{systemItem.count}</span>
                <span style={{ color: "var(--ln-theme-text-muted)", fontSize: 11 }}>
                  {t(locale, "catDefault")}
                </span>
              </div>
            ) : null}
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <input
              value={draft}
              maxLength={40}
              placeholder={t(locale, "catAddPlaceholder")}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitAdd();
              }}
              className="min-w-0 flex-1 rounded px-2 py-1 outline-none"
              style={{
                fontSize: 12,
                color: "var(--ln-theme-text)",
                background: "var(--ln-theme-surface)",
                border: "1px solid var(--ln-theme-border)",
              }}
            />
            <button
              type="button"
              onClick={commitAdd}
              className="rounded-md px-2.5 py-1"
              style={{
                fontSize: 12,
                color: "var(--ln-theme-text)",
                background: "var(--ln-theme-surface-active)",
                border: "1px solid var(--ln-theme-border)",
              }}
            >
              {t(locale, "catAdd")}
            </button>
          </div>

          <p className="mt-1.5" style={{ color: "var(--ln-theme-text-muted)", fontSize: 10, lineHeight: 1.5 }}>
            {t(locale, "catManageNote")}
          </p>

          {picker && pickerItem ? (
            <div
              ref={pickerRef}
              className="fixed z-[200] w-[132px] rounded-lg border p-2 shadow-xl"
              style={{
                left: picker.x,
                top: picker.y,
                background: "var(--ln-theme-bg)",
                borderColor: "var(--ln-theme-border)",
                backdropFilter: "var(--ln-theme-backdrop)",
              }}
              role="menu"
            >
              <div className="mb-1.5" style={{ color: "var(--ln-theme-text-muted)", fontSize: 10 }}>
                {t(locale, "catColorTitle")}
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {CATEGORY_COLORS.map((color) => {
                  const active = pickerItem.storedColor
                    ? pickerItem.storedColor === color
                    : pickerItem.color === color;
                  const taken =
                    !active &&
                    items.some((x) => x.id !== pickerItem.id && x.color === color);
                  return (
                    <button
                      key={color}
                      type="button"
                      role="menuitem"
                      disabled={taken}
                      onClick={() => {
                        onSetColor(pickerItem.id, color);
                        setPicker(null);
                      }}
                      className="rounded-[3px]"
                      style={{
                        width: 16,
                        height: 16,
                        background: color,
                        opacity: taken ? 0.22 : 1,
                        outline: active ? "2px solid var(--ln-theme-text)" : "none",
                        outlineOffset: 1,
                      }}
                      title={taken ? t(locale, "catColorTaken") : color}
                    />
                  );
                })}
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onSetColor(pickerItem.id, NO_CATEGORY_COLOR);
                  setPicker(null);
                }}
                className="mt-2 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-[var(--ln-theme-surface-hover)]"
                style={{
                  color: "var(--ln-theme-text-secondary)",
                  fontSize: 10,
                  background:
                    pickerItem.storedColor === NO_CATEGORY_COLOR
                      ? "var(--ln-theme-surface-active)"
                      : "transparent",
                }}
              >
                <span
                  className="rounded-[3px]"
                  style={{
                    width: 12,
                    height: 12,
                    background: NO_CATEGORY_SWATCH,
                    border: "1px solid var(--ln-theme-border)",
                  }}
                />
                {t(locale, "catColorNone")}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t(locale, "catManageTitle")}
        message={
          pendingDelete
            ? t(locale, "catDeleteConfirm").replace("{n}", String(pendingDelete.count)).replace("{name}", pendingDelete.name)
            : ""
        }
        confirmLabel={t(locale, "catDelete")}
        cancelLabel={t(locale, "cancel")}
        onConfirm={() => {
          if (pendingDelete) onDelete(pendingDelete.id);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}

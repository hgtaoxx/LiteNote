import { useEffect, useRef, useState } from "react";
import type { Locale } from "@/i18n";
import { t } from "@/i18n";
import { swatchColors, swatchInk, type RailItem } from "@/lib/categoryColors";

interface CategoryBadgeProps {
  locale: Locale;
  items: RailItem[];
  activeId: string;
  onSelect: (id: string) => void;
  /** 右键：打开标签管理面板（左键只是切换） */
  onManage: () => void;
}

/**
 * 筛选行上唯一的标签入口：显示当前标签名，底色就是原来的色块。
 * 左键出下拉切换，右键才是「标签管理」。
 */
export function CategoryBadge({ locale, items, activeId, onSelect, onManage }: CategoryBadgeProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = items.find((x) => x.id === activeId) ?? items[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const colors = swatchColors(items);

  return (
    <div ref={ref} className="relative min-w-0 shrink-0" data-tauri-no-drag>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          onManage();
        }}
        className="flex w-[52px] items-center rounded-[5px] border px-1.5 py-[3px]"
        style={{
          borderColor: "var(--ln-theme-border)",
          background: colors[current?.id] ?? "rgba(255,255,255,0.06)",
          color: swatchInk(colors[current?.id]),
          fontSize: 10,
          fontWeight: 600,
        }}
        title={t(locale, "catBadgeHint")}
      >
        <span className="min-w-0 flex-1 truncate">{current?.name}</span>
      </button>

      {open ? (
        <div
          className="absolute left-0 top-full z-[140] mt-1 min-w-[128px] rounded-lg border py-1 shadow-lg"
          style={{
            background: "var(--ln-theme-bg)",
            borderColor: "var(--ln-theme-border)",
            backdropFilter: "var(--ln-theme-backdrop)",
            fontSize: 12,
          }}
          role="menu"
        >
          {items.map((item) => {
            const active = item.id === activeId;
            return (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  onSelect(item.id);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-[var(--ln-theme-surface-hover)]"
                style={{
                  color: "var(--ln-theme-text)",
                  background: active ? "var(--ln-theme-surface-active)" : "transparent",
                  fontWeight: active ? 700 : 400,
                }}
              >
                <span
                  aria-hidden
                  className="shrink-0 rounded-[3px]"
                  style={{
                    width: 9,
                    height: 9,
                    background: colors[item.id],
                    border: "1px solid var(--ln-theme-border)",
                  }}
                />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span style={{ color: "var(--ln-theme-text-muted)", fontSize: 11 }}>{item.count}</span>
              </button>
            );
          })}
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-1.5 border-t px-2.5 py-1.5 text-left hover:bg-[var(--ln-theme-surface-hover)]"
            style={{ borderColor: "var(--ln-theme-border)", color: "var(--ln-theme-text-secondary)" }}
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            {t(locale, "catManage")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t, type Locale } from "@/i18n";

/**
 * 专注模式的右键菜单（HTML 自绘）。
 *
 * 为什么不是原生菜单（两个原因，都有源码依据）：
 *   1. WebView2 自带的右键菜单没有任何字号/尺寸/排版接口，改不了 —— 它已经被
 *      整个关掉（Rust 侧 disable_native_context_menu），否则会盖在自绘菜单上面；
 *   2. Tauri 的原生菜单 popup_at 要 `tauri::Window<R>`，而取它的
 *      `Manager::get_window` 被 `#[cfg(feature = "unstable")]` 锁着
 *      （tauri lib.rs:541），为一个菜单去开 unstable 特性会牵动其它 API 签名。
 *
 * HTML 自绘反而是需求更想要的那种：尺寸、字号、间距、圆角、阴影全部可控，
 * 所以下面用一个 MENU_SCALE 就能整体缩放（原生菜单做不到）。
 */

/** 整体缩放系数：原生菜单约 14px 字号，这里按 75% 走 */
const MENU_SCALE = 0.75;
const BASE_FONT = 14;
const FONT = BASE_FONT * MENU_SCALE; // 10.5px
const PAD_X = 12 * MENU_SCALE; // 9px
const PAD_Y = 8 * MENU_SCALE; // 6px
const MIN_W = 96 * MENU_SCALE + 24; // ≈ 96px

interface FocusContextMenuProps {
  x: number;
  y: number;
  locale: Locale;
  onClose: () => void;
  onPick: (id: "hide" | "full" | "quit") => void;
}

export function FocusContextMenu({
  x,
  y,
  locale,
  onClose,
  onPick,
}: FocusContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // 点外面 / 按 Esc 关闭（与 TodoContextMenu 的交互保持一致）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const menuItem = {
    display: "flex",
    width: "100%",
    alignItems: "center",
    textAlign: "left" as const,
    padding: `${PAD_Y}px ${PAD_X}px`,
    fontSize: FONT,
    color: "var(--ln-theme-text)",
    background: "transparent",
  };

  const hover = (el: HTMLElement | null, on: boolean) => {
    if (el) el.style.background = on ? "var(--ln-theme-surface-hover)" : "transparent";
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[200] rounded-lg py-1"
      style={{
        left: Math.min(x, window.innerWidth - MIN_W - 8),
        top: Math.min(y, window.innerHeight - 110),
        minWidth: MIN_W,
        background: "var(--ln-theme-bg)",
        border: "1px solid var(--ln-theme-border)",
        boxShadow: "0 6px 18px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.10)",
        backdropFilter: "var(--ln-theme-backdrop)",
        fontSize: FONT,
      }}
    >
      <button
        type="button"
        role="menuitem"
        style={menuItem}
        onMouseEnter={(e) => hover(e.currentTarget, true)}
        onMouseLeave={(e) => hover(e.currentTarget, false)}
        onClick={() => {
          onPick("hide");
          onClose();
        }}
      >
        {t(locale, "menuHideWindow")}
      </button>

      <button
        type="button"
        role="menuitem"
        style={menuItem}
        onMouseEnter={(e) => hover(e.currentTarget, true)}
        onMouseLeave={(e) => hover(e.currentTarget, false)}
        onClick={() => {
          onPick("full");
          onClose();
        }}
      >
        {t(locale, "menuExitFocus")}
      </button>

      {/* 分隔线：与截图一样，把「退出」单独分出来 */}
      <div
        style={{
          height: 1,
          margin: `${PAD_Y * 0.5}px 0`,
          background: "var(--ln-theme-border)",
        }}
      />

      <button
        type="button"
        role="menuitem"
        style={menuItem}
        onMouseEnter={(e) => hover(e.currentTarget, true)}
        onMouseLeave={(e) => hover(e.currentTarget, false)}
        onClick={() => {
          onPick("quit");
          onClose();
        }}
      >
        {t(locale, "menuQuit")}
      </button>
    </div>,
    document.body,
  );
}

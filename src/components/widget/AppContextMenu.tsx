import { useEffect, useRef } from "react";
import type { Locale } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { t } from "@/i18n";

interface AppContextMenuProps {
  locale: Locale;
  x: number;
  y: number;
  /** 当前是否专注模式：决定第二项显示「专注模式」还是「完整模式」 */
  isFocus: boolean;
  onHide: () => void;
  onToggleFocus: () => void;
  onQuit: () => void;
  onClose: () => void;
}

/**
 * 标题栏 / 专注模式拖拽条的右键菜单 —— 精简三项：
 *   隐藏界面 · （专注模式 | 完整模式）· 退出
 *
 * 为什么自己画而不用系统菜单：窗口是无边框的，在标题区域右键会弹出 Windows 的
 * 系统菜单（还原 / 移动 / 大小 / 最小化 / 最大化 / 关闭），与这个界面的语义
 * 完全对不上，而且那些项对本应用没有意义。所以自己用主题变量画一个精简版。
 */
export function AppContextMenu({
  locale,
  x,
  y,
  isFocus,
  onHide,
  onToggleFocus,
  onQuit,
  onClose,
}: AppContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const mk = (key: MessageKey) => t(locale, key);

  // 点击菜单外部 / 按 Esc 关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 延后一拍再监听，避免"打开菜单的那一次点击"立刻把它关掉
    const tId = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
    }, 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(tId);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const item =
    "flex w-full items-center px-2.5 py-1 text-left transition-colors hover:bg-[var(--ln-theme-surface-hover)]";
  const itemStyle: React.CSSProperties = {
    color: "var(--ln-theme-text)",
    // 12.5px：与「常规」页下拉菜单同一量级，整体比之前更紧凑
    fontSize: 12.5,
  };

  /** 执行动作并关闭菜单 */
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[150] min-w-[8rem] overflow-hidden rounded-lg py-1 shadow-xl"
      style={{
        // 贴边时向左 / 向上收，避免超出窗口
        left: Math.min(x, Math.max(0, window.innerWidth - 140)),
        top: Math.min(y, Math.max(0, window.innerHeight - 100)),
        background: "var(--ln-theme-bg)",
        backdropFilter: "var(--ln-theme-backdrop)",
        border: "1px solid var(--ln-theme-border)",
      }}
    >
      <button
        type="button"
        role="menuitem"
        className={item}
        style={itemStyle}
        onClick={run(onHide)}
      >
        {mk("menuHideWindow")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        style={itemStyle}
        onClick={run(onToggleFocus)}
      >
        {mk(isFocus ? "menuExitFocus" : "menuEnterFocus")}
      </button>

      <div
        className="my-1"
        style={{ borderTop: "1px solid var(--ln-theme-border-light)" }}
      />

      <button
        type="button"
        role="menuitem"
        className={item}
        style={itemStyle}
        onClick={run(onQuit)}
      >
        {mk("menuQuit")}
      </button>
    </div>
  );
}

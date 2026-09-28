import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { Locale } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { t } from "@/i18n";
import { Icon } from "@/components/Icon";

interface HeaderBarProps {
  locale: Locale;
  alwaysOnTop: boolean;
  onToggleAlwaysOnTop: () => void;
  /** 鼠标穿透是否已开启（开启后界面点不到，只能从托盘关闭） */
  mousePassthrough: boolean;
  /** 开启鼠标穿透（只用于开启，关闭走托盘） */
  onEnableMousePassthrough: () => void;
  /** 切换专注模式（按钮置于「鼠标穿透」左侧） */
  onEnterFocus: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  /** 隐藏到托盘（标题栏不再有右键菜单，按钮恢复） */
  onHide: () => void;
}

const iconBtn =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-100/50";
const iconStyle = { color: "var(--ln-theme-text)" } as React.CSSProperties;
/**
 * 穿透已开启时的高亮样式。
 * 之前按钮在开 / 关两种状态下外观完全一样，用户点了之后无法确认是否生效；
 * 专注模式下穿透不真穿透（只是锁定窗口），更需要这个可视反馈。
 */
const iconOnStyle = {
  color: "#fbbf24",
  background: "rgba(251, 191, 36, 0.18)",
} as React.CSSProperties;

export function HeaderBar({
  locale,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  mousePassthrough,
  onEnableMousePassthrough,
  onEnterFocus,
  onOpenSettings,
  onOpenAbout,
  onHide,
}: HeaderBarProps) {
  const mk = (key: MessageKey) => t(locale, key);
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(`v${v}`))
      .catch(() => setVersion(""));
  }, []);

  // 顶栏高度压缩为原 h-11(44px) 的 75% → 33px；图标按钮同步缩为 h-6(24px)，否则会撑满整栏
  return (
    <header
      className="flex h-[33px] shrink-0 cursor-grab select-none items-center px-1 active:cursor-grabbing"
      style={{ borderBottom: `1px solid var(--ln-theme-header-border)` }}
      data-tauri-drag-region
    >
      <div
        className="flex min-h-0 min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2 pr-2"
        data-tauri-drag-region
      >
        <span className="truncate text-sm font-semibold leading-none" style={{ color: "var(--ln-theme-text)" }}>
          {mk("appName")}
        </span>
        {version ? (
          <span className="shrink-0 text-xs leading-none" style={{ color: "var(--ln-theme-text-muted)" }}>{version}</span>
        ) : null}
      </div>
      <div
        className="flex cursor-default items-center gap-0.5 pr-1"
        data-tauri-no-drag
      >
        {/* 专注模式开关：置于「鼠标穿透」左侧 */}
        <button
          type="button"
          className={iconBtn}
          style={iconStyle}
          title={mk("menuEnterFocus")}
          aria-label={mk("menuEnterFocus")}
          onClick={onEnterFocus}
        >
          {/* 聚焦准星：中心圆 + 四个方向的内折线 */}
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {/* 鼠标穿透：置于「帮助」左侧；开启后整个界面点不到，只能从托盘关闭 */}
        <button
          type="button"
          className={iconBtn}
          style={mousePassthrough ? iconOnStyle : iconStyle}
          title={mk(mousePassthrough ? "mousePassthroughOn" : "mousePassthrough")}
          aria-label={mk("mousePassthrough")}
          aria-pressed={mousePassthrough}
          onClick={onEnableMousePassthrough}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden>
            {/* 鼠标本体：未开启穿透时只有它 */}
            <rect
              x="6.5"
              y="3"
              width="11"
              height="18"
              rx="5.5"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            {/* 左右键分界线 */}
            <path
              d="M12 3v5.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            {/* 开启穿透后才加一道斜杠：鼠标事件穿过窗口 */}
            {mousePassthrough ? (
              <path
                d="M3.5 20.5 20.5 3.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            ) : null}
          </svg>
        </button>
        <button
          type="button"
          className={iconBtn}
          style={iconStyle}
          title={mk("helpTitle")}
          onClick={onOpenAbout}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
            <line x1="12" y1="8" x2="12" y2="8.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="12" y1="12" x2="12" y2="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          className={iconBtn}
          style={iconStyle}
          title={mk("settings")}
          onClick={onOpenSettings}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M19.4 15a1.85 1.85 0 0 0 .37 2.02l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.85 1.85 0 0 0-2.02-.37 1.85 1.85 0 0 0-1.12 1.69V21a2 2 0 1 1-4 0v-.09a1.85 1.85 0 0 0-1.12-1.69 1.85 1.85 0 0 0-2.02.37l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.85 1.85 0 0 0 .37-2.02 1.85 1.85 0 0 0-1.69-1.12H3a2 2 0 1 1 0-4h.09a1.85 1.85 0 0 0 1.69-1.12 1.85 1.85 0 0 0-.37-2.02l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.85 1.85 0 0 0 2.02.37h.03a1.85 1.85 0 0 0 1.12-1.69V3a2 2 0 1 1 4 0v.09a1.85 1.85 0 0 0 1.12 1.69 1.85 1.85 0 0 0 2.02-.37l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.85 1.85 0 0 0-.37 2.02v.03a1.85 1.85 0 0 0 1.69 1.12H21a2 2 0 1 1 0 4h-.09a1.85 1.85 0 0 0-1.69 1.12Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          className={iconBtn}
          style={iconStyle}
          title={alwaysOnTop ? mk("alwaysOnTopCancel") : mk("alwaysOnTop")}
          aria-label={alwaysOnTop ? mk("alwaysOnTopCancel") : mk("alwaysOnTop")}
          aria-pressed={alwaysOnTop}
          onClick={onToggleAlwaysOnTop}
        >
          <Icon name={alwaysOnTop ? "pushpin-fill" : "pushpin-line"} className="h-3.5 w-3.5" />
        </button>
        {/* 隐藏到托盘 */}
        <button
          type="button"
          className={iconBtn}
          style={iconStyle}
          title={mk("hideWindow")}
          aria-label={mk("hideWindow")}
          onClick={onHide}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M6 12h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </header>
  );
}

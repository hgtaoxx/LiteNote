import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { Locale } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { t } from "@/i18n";

interface HeaderBarProps {
  locale: Locale;
  /** 窗口锁定态：锁定后不能移动、不能改大小，其余操作照常 */
  windowLocked: boolean;
  onToggleWindowLock: () => void;
  /** 钉桌面设置是否开启（按钮该不该亮） */
  desktopPin: boolean;
  /** 是否**真的**挂在桌面层：停靠期间只是挂起，这时按钮置灰 */
  pinApplied: boolean;
  /** 钉桌面此刻不可用（贴边停靠中） */
  pinUnavailable: boolean;
  onToggleDesktopPin: () => void;
  /** 切换专注模式 */
  onEnterFocus: () => void;
  onOpenSettings: () => void;
  /** 隐藏到托盘（标题栏不再有右键菜单，按钮恢复） */
  onHide: () => void;
}

const iconBtn =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg transition hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-100/50";
const iconStyle = { color: "var(--ln-theme-text)" } as React.CSSProperties;
/** 生效中的高亮（琥珀色）：钉住 / 锁定这类「从外观不容易看出来」的状态都需要它 */
const iconOnStyle = {
  color: "#fbbf24",
  background: "rgba(251, 191, 36, 0.18)",
} as React.CSSProperties;
/** 置灰：设置是开的，但当前被挂起（贴边停靠中） */
const iconDimStyle = { color: "var(--ln-theme-text-muted)", opacity: 0.5 } as React.CSSProperties;

export function HeaderBar({
  locale,
  windowLocked,
  onToggleWindowLock,
  desktopPin,
  pinApplied,
  pinUnavailable,
  onToggleDesktopPin,
  onEnterFocus,
  onOpenSettings,
  onHide,
}: HeaderBarProps) {
  const mk = (key: MessageKey) => t(locale, key);
  const [version, setVersion] = useState("");

  /**
   * 能不能用原生拖拽：锁定态禁止。钉在桌面层时不需要在这里另设条件 ——
   * 那时整个窗口都不再接鼠标事件了（Rust 侧挂上前打上了穿透位），
   * 要挪位置先用托盘「钉桌面」取消。
   */
  const canNativeDrag = !windowLocked;

  useEffect(() => {
    getVersion()
      .then((v) => setVersion(`v${v}`))
      .catch(() => setVersion(""));
  }, []);

  // 顶栏高度压缩为原 h-11(44px) 的 75% → 33px；图标按钮同步缩为 h-6(24px)，否则会撑满整栏
  return (
    <header
      className={
        "flex h-[33px] shrink-0 select-none items-center px-1 " +
        // 锁定时不只是禁用拖拽区域，光标也要从「抓手」变回普通箭头，否则看着像还能拖
        (windowLocked ? "cursor-default" : "cursor-grab active:cursor-grabbing")
      }
      style={{ borderBottom: `1px solid var(--ln-theme-header-border)` }}
      /* 不能拖时显式置为 "false"（Tauri 的显式禁止值），整条顶栏都不再能拖动窗口 */
      data-tauri-drag-region={canNativeDrag ? "true" : "false"}
    >
      <div
        className="flex min-h-0 min-w-0 flex-1 items-center gap-1.5 self-stretch pl-2 pr-2"
        data-tauri-drag-region={canNativeDrag ? "true" : "false"}
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
        {/* 专注模式开关 */}
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
        {/* 钉桌面：把挂件挂进桌面层，「显示桌面 / Win+D」不再收起它。
            贴边停靠期间自动挂起（唤出要靠临时置顶，桌面层做不到），这时按钮置灰并写明原因。 */}
        <button
          type="button"
          className={iconBtn}
          style={pinApplied ? iconOnStyle : pinUnavailable ? iconDimStyle : iconStyle}
          title={mk(
            pinUnavailable
              ? "desktopPinUnavailable"
              : pinApplied || desktopPin
                ? "desktopPinOn"
                : "desktopPin",
          )}
          aria-label={mk("desktopPin")}
          aria-pressed={pinApplied}
          disabled={pinUnavailable}
          onClick={onToggleDesktopPin}
        >
          {/* 图钉：钉帽 + 针 */}
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9.2 3.5h5.6l-.7 5.3 3.4 3.2H6.5l3.4-3.2-.7-5.3Z" />
            <path d="M12 12.2v8.3" />
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
          title={windowLocked ? mk("windowUnlock") : mk("windowLock")}
          aria-label={windowLocked ? mk("windowUnlock") : mk("windowLock")}
          aria-pressed={windowLocked}
          onClick={onToggleWindowLock}
        >
          {/* 锁：关闭=实心锁梁，打开=开口锁梁（与顶栏其它图标同为内联 SVG 风格） */}
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="4.5" y="10.5" width="15" height="9.5" rx="1.8" />
            {windowLocked ? (
              <path d="M8 10.5V7.2a4 4 0 0 1 8 0v3.3" />
            ) : (
              <path d="M8 10.5V7.2a4 4 0 0 1 7.6-1.7" />
            )}
          </svg>
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

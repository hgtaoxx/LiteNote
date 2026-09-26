import type { Locale } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { t } from "@/i18n";

interface FooterBarProps {
  locale: Locale;
  onAdd: () => void;
  onExport: () => void;
  onClearClick: () => void;
  /** 无已完成项时禁用清除按钮 */
  clearCompletedDisabled?: boolean;
  /** 面板透明度 */
  opacity?: number;
}

export function FooterBar({
  locale,
  onAdd,
  onExport,
  onClearClick,
  clearCompletedDisabled = false,
  opacity = 1,
}: FooterBarProps) {
  const mk = (key: MessageKey) => t(locale, key);

  // 底栏高度 = 28px 按钮 + 上下各 4px = 36px。
  // 行高固定 20px：这样调大「内容字号」时底栏高度不会跟着跳动。
  const btnBase =
    "flex items-center gap-1 rounded-lg px-1.5 py-1 transition";
  const btnActive = `${btnBase} hover:bg-[var(--ln-theme-surface-hover)]`;
  const btnDisabled = `${btnBase} cursor-not-allowed`;

  /**
   * 底栏属于「界面」，所以字号**固定 14px**、字体用界面默认字体，
   * 不跟随设置里的「内容字号 / 内容字体」。
   */
  const FOOTER_FONT_SIZE = "14px";

  const btnStyle: React.CSSProperties = {
    color: "var(--ln-theme-text)",
    fontSize: FOOTER_FONT_SIZE,
    lineHeight: "20px",
  };
  const btnDisabledStyle: React.CSSProperties = {
    color: "var(--ln-theme-text-muted)",
    fontSize: FOOTER_FONT_SIZE,
    lineHeight: "20px",
  };

  /** 图标用 em 跟随字号，字号调整时自动等比缩放 */
  const iconStyle: React.CSSProperties = {
    width: "1.05em",
    height: "1.05em",
    flexShrink: 0,
  };

  return (
    <footer className="relative shrink-0" data-tauri-no-drag>
      {/* 背景层（受透明度影响） */}
      <div
        className="absolute inset-0 z-0"
        style={{
          borderTop: `1px solid var(--ln-theme-border)`,
          background: "var(--ln-theme-surface)",
          opacity,
        }}
      />
      {/* 内容层（文字清晰） */}
      <div className="relative z-10 flex items-center justify-between gap-2 px-2 py-1">
        <button
          type="button"
          title={mk("footerAddTooltip")}
          onClick={onAdd}
          className={btnActive}
          style={btnStyle}
        >
          <svg
            className="opacity-95"
            style={iconStyle}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          {mk("footerAdd")}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            title={mk("footerExportTooltip")}
            onClick={onExport}
            className={btnActive}
            style={btnStyle}
          >
            <svg
              className="opacity-95"
            style={iconStyle}
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
            >
              <path
                d="M12 3v12M8 11l4 4 4-4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            {mk("footerExport")}
          </button>
          <button
            type="button"
            title={
              clearCompletedDisabled ? undefined : mk("footerClearTooltip")
            }
            disabled={clearCompletedDisabled}
            onClick={onClearClick}
            className={clearCompletedDisabled ? btnDisabled : btnActive}
            style={clearCompletedDisabled ? btnDisabledStyle : btnStyle}
          >
            <svg
              className="opacity-95"
            style={iconStyle}
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
            >
              <path
                d="M9 3h6l1 2h5v2H3V5h5l1-2Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path
                d="M6 9h12l-1 12H7L6 9Z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <path
                d="M10 13v6M14 13v6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            {mk("footerClear")}
          </button>
        </div>
      </div>
    </footer>
  );
}

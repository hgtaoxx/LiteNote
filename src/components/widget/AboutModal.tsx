import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Locale } from "@/i18n";

interface AboutModalProps {
  open: boolean;
  locale: Locale;
  onClose: () => void;
}

/**
 * 关于弹窗。
 * 原先这里还有「使用教程（B站）」与「源码（GitHub）」两组外链，
 * 按用户要求已全部移除，只保留简介。
 */
export function AboutModal({ open, locale, onClose }: AboutModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const isZh = locale === "zh-CN";

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "var(--ln-theme-overlay)" }}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div
        className="w-[320px] max-h-[90%] overflow-y-auto rounded-xl px-5 py-5 shadow-2xl"
        style={{ background: "var(--ln-theme-bg)", backdropFilter: "var(--ln-theme-backdrop)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold" style={{ color: "var(--ln-theme-text)" }}>
            {isZh ? "关于轻签" : "About LiteNote"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/10"
            style={{ color: "var(--ln-theme-text-secondary)" }}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <Section title={isZh ? "简介" : "Intro"}>
          <p className="text-sm leading-relaxed" style={{ color: "var(--ln-theme-text-secondary)" }}>
            {isZh
              ? "轻量本地待办便签工具，数据存于本机，透明面板常驻桌面。"
              : "Lightweight local to-do note widget. Your data stays on your machine."}
          </p>
        </Section>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h3 className="text-xs font-medium mb-2.5" style={{ color: "var(--ln-theme-text-muted)" }}>{title}</h3>
      {children}
    </div>
  );
}

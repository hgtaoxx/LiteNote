import { useEffect, useState } from "react";
import type { Locale } from "@/i18n";
import { formatLunarLine } from "@/lib/lunarLine";

interface ClockSectionProps {
  locale: Locale;
  /** 是否显示秒（单击时钟可切换） */
  showSeconds: boolean;
  /** 单击时钟：在「显示秒 / 隐藏秒」之间切换 */
  onToggleSeconds: () => void;
}

export function ClockSection({ locale, showSeconds, onToggleSeconds }: ClockSectionProps) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const timeStr = now.toLocaleTimeString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(showSeconds ? { second: "2-digit" as const } : {}),
  });

  const dateStr = now.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: "2-digit",
    day: "2-digit",
  });

  const weekdayStr = now.toLocaleDateString(locale === "zh-CN" ? "zh-CN" : "en-US", {
    weekday: "long",
  });

  const lunar = formatLunarLine(now, locale);

  return (
    <section
      className="shrink-0 select-none"
      style={{ borderBottom: `1px solid var(--ln-theme-border)` }}
    >
      {/*
        整个时钟区就是一个按钮：内边距也算在热区内，整块区域都可点。
        - 鼠标指针全程保持默认箭头（cursor-default），只有单击才切换秒显示
        - 时间字号显式 24px（= 最初 text-5xl 48px 的一半）+ font-mono + tabular-nums：
          等宽数字，秒数跳动时不抖动
        - 右组 min-w-0 + 农历 truncate：窄窗口或英文长星期时优雅省略，不挤压时间
        - 右侧三项亮度统一为最亮的 --ln-theme-text
      */}
      <button
        type="button"
        onClick={onToggleSeconds}
        aria-pressed={showSeconds}
        title={
          showSeconds
            ? locale === "zh-CN" ? "隐藏秒" : "Hide seconds"
            : locale === "zh-CN" ? "显示秒" : "Show seconds"
        }
        className="flex h-10 w-full cursor-default items-center justify-between gap-2 border-0 bg-transparent px-3 text-left"
      >
        <span
          className="shrink-0 font-mono text-[24px] font-light leading-none tabular-nums tracking-wide"
          style={{ color: "var(--ln-theme-text)" }}
        >
          {timeStr}
        </span>

        {/*
          公历 + 星期占一行，农历另起一行。
          整块靠右（按钮是 justify-between），块内左对齐（items-start），
          于是农历的左边缘与公历对齐，整块右边缘贴着界面右边。
          不用 leading-none：农历带 truncate(overflow:hidden)，行高低于字体内容框会裁掉 CJK 字形。
        */}
        <span
          className="flex min-w-0 flex-col items-start text-xs leading-tight"
          style={{ color: "var(--ln-theme-text)" }}
        >
          <span className="flex items-center gap-1.5">
            <span className="shrink-0 tabular-nums">{dateStr}</span>
            <span className="shrink-0 font-medium">{weekdayStr}</span>
          </span>
          <span className="min-w-0 max-w-full truncate">{lunar}</span>
        </span>
      </button>
    </section>
  );
}

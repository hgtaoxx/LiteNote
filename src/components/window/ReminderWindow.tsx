import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "@/stores/settingsStore";
import { resolveLocale, t } from "@/i18n";

/** 预设的延后分钟数 */
const PRESETS = [5, 10, 15, 30];

/**
 * 待办提醒弹窗。
 * - 通过 ?window=reminder&todoId=...&text=...&dueDate=... 加载
 * - 尺寸与落点由 Rust 按面板当前几何算：悬浮在面板之内、宽度跟面板走，高度见 reminder_fit
 * - 延后时间常显：一排预设 + 一个自定义输入；只有一个按钮，
 *   没选时间＝「我知道了」，选了时间＝「稍后提醒」
 */
export function ReminderWindow() {
  const localeMode = useSettingsStore((s) => s.localeMode);
  const locale = resolveLocale(localeMode);
  // 提醒窗是独立窗口，拿不到挂件那套运行时主题变量（--ln-theme-bg 在 CSS 里指向渐变，
  // 也不能直接当背景色），所以弹窗自己按主题取一组实色
  const theme = useSettingsStore((s) => s.theme);
  const initSettings = useSettingsStore((s) => s.init);
  const dark = theme === "dark" || theme === "glass";
  const skin = useMemo(() => SKINS[dark ? "dark" : "light"], [dark]);

  const params = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    return {
      todoId: sp.get("todoId") ?? "",
      text: sp.get("text") ?? "",
      dueDate: Number(sp.get("dueDate") ?? 0),
    };
  }, []);

  const text = params.text || t(locale, "emptyTodo");
  const isZh = locale === "zh-CN";

  // 弹窗一直开着时时间也要往前走：不定时刷新，「已逾期 X 分钟」会停在打开那一刻
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const dueLabel = useMemo(
    () => formatDueLabel(params.dueDate, locale),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [params.dueDate, locale, tick],
  );

  const [picked, setPicked] = useState<number | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);

  // 这个窗口不挂载主应用，设置一直是默认值（主题、语言都不对），这里补一次加载
  useEffect(() => {
    void initSettings();
  }, [initSettings]);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  // 标记 html 根节点为 reminder 模式（用于 index.css 的无边框样式）
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("ln-reminder");
    return () => {
      root.classList.remove("ln-reminder");
    };
  }, []);

  const customNum = Math.floor(Number(custom) || 0);
  const minutes = picked ?? (customNum > 0 ? Math.min(1440, customNum) : null);

  const callAction = async (action: "snooze" | "close", delayMinutes?: number) => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("reminder_action", {
        todoId: params.todoId,
        action,
        delayMinutes: delayMinutes ?? null,
      });
      // 通知其他窗口（主窗口）重新从 DB 加载 todo 数据
      emit("litenote-todos-updated", { ts: Date.now() }).catch(() => {});
      setTimeout(() => {
        getCurrentWindow().close().catch(() => {});
      }, 200);
    } catch (e) {
      console.error("[ReminderWindow] action failed", e);
      setBusy(false);
    }
  };

  const submit = () => {
    if (minutes) void callAction("snooze", minutes);
    else void callAction("close");
  };

  // 高度由内容决定：Rust 先给一个初值，这里量准了回报一次再居中。
  // 只写死常量的话，换一块缩放不同的屏幕（100%/125%/150%）按钮就会被裁掉。
  const cardRef = useRef<HTMLDivElement | null>(null);
  const fittedRef = useRef(0);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const natural = Math.ceil(el.offsetHeight);
    const physical = Math.round(natural * (window.devicePixelRatio || 1));
    if (physical > 0 && physical !== fittedRef.current) {
      fittedRef.current = physical;
      void invoke("reminder_fit", { height: physical }).catch(() => {});
    }
  }, [text, dueLabel]);

  return (
    <div className="reminder-root" data-tauri-drag-region>
      <div className="reminder-card" ref={cardRef} data-tauri-drag-region>
        <div className="reminder-header">
          <span className="reminder-dot" />
          <span className="reminder-title">{t(locale, "reminderWindowTitle")}</span>
          <button
            className="reminder-close"
            aria-label="close"
            data-tauri-no-drag
            onClick={() => callAction("close")}
            disabled={busy}
          >
            ×
          </button>
        </div>

        <div className="reminder-body">
          <div className="reminder-text" title={text}>
            {text}
          </div>
          {dueLabel && <div className="reminder-due">{dueLabel}</div>}
        </div>

        <div className="reminder-snooze" data-tauri-no-drag>
          {PRESETS.map((m) => (
            <button
              key={m}
              type="button"
              className={"reminder-pill" + (picked === m ? " on" : "")}
              disabled={busy}
              onClick={() => {
                setPicked(picked === m ? null : m);
                setCustom("");
              }}
            >
              {m}
              {isZh ? "分钟" : "m"}
            </button>
          ))}
          <input
            className="reminder-custom"
            type="number"
            min={1}
            max={1440}
            placeholder="--"
            value={custom}
            disabled={busy}
            onChange={(e) => {
              setCustom(e.target.value);
              setPicked(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <span className="reminder-unit">{isZh ? "分钟" : "min"}</span>
        </div>

        <div className="reminder-actions" data-tauri-no-drag>
          <button
            type="button"
            className="reminder-btn reminder-btn-primary"
            disabled={busy}
            onClick={submit}
          >
            {minutes ? t(locale, "reminderActionSnooze") : t(locale, "reminderActionDone")}
          </button>
        </div>
      </div>

      <ReminderStyles skin={skin} />
    </div>
  );
}

/**
 * 把 dueDate(ms) 转成「绝对时间 · 相对时长」。
 * 绝对时间打底：相对时长万一算错，也能一眼看出提醒的是哪一刻。
 */
function formatDueLabel(dueDate: number, locale: "zh-CN" | "en"): string {
  if (!dueDate || dueDate <= 0) return "";
  const diff = dueDate - Date.now();
  const isZh = locale === "zh-CN";

  const d = new Date(dueDate);
  const p = (n: number) => String(n).padStart(2, "0");
  const when = isZh
    ? `${p(d.getMonth() + 1)}月${p(d.getDate())}日 ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

  let relative: string;
  if (Math.abs(diff) < 30_000) {
    relative = t(locale, "reminderOverdueNow");
  } else {
    const totalMin = Math.floor(Math.abs(diff) / 60_000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    let timeStr = "";
    if (h > 0) timeStr += isZh ? `${h}小时` : `${h}h`;
    if (m > 0 || h === 0) timeStr += isZh ? `${m}分钟` : `${m} min`;
    relative =
      diff > 0
        ? t(locale, "reminderDueIn", { time: timeStr })
        : t(locale, "reminderOverdue", { time: timeStr });
  }

  return `${when} · ${relative}`;
}

/**
 * 弹窗自带的一套实色配色（不依赖挂件的运行时主题变量）。
 * 深色主题走 dark，其余浅色系走 light。
 */
interface Skin {
  cardBg: string;
  cardFg: string;
  sub: string;
  muted: string;
  border: string;
  field: string;
  fieldHover: string;
  accent: string;
  accentHover: string;
}

const SKINS: Record<"light" | "dark", Skin> = {
  light: {
    cardBg: "#ffffff",
    cardFg: "#1a1a1a",
    sub: "#666666",
    muted: "#999999",
    border: "#e6e6e6",
    field: "#f5f5f5",
    fieldHover: "#ebebeb",
    accent: "#ff9500",
    accentHover: "#ffa624",
  },
  dark: {
    cardBg: "#1f2937",
    cardFg: "#e5e7eb",
    sub: "#9ca3af",
    muted: "#6b7280",
    border: "#374151",
    field: "#111827",
    fieldHover: "#0b1220",
    accent: "#ff9500",
    accentHover: "#ffa624",
  },
};

/**
 * 弹窗独立样式：用自带的一套实色，卡片高度铺满窗口（窗口尺寸由 Rust 按面板算），
 * 所以任何面板宽度下内容都不会溢出到窗口外。
 */
function ReminderStyles({ skin: s }: { skin: Skin }) {
  return (
    <style>{`
      .reminder-root {
        position: fixed;
        inset: 0;
        background: transparent;
        display: flex;
        align-items: flex-start;
        justify-content: stretch;
        font-family: var(--ln-font-stack, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif);
        -webkit-user-select: none;
        user-select: none;
        margin: 0;
        padding: 0;
      }
      .reminder-card {
        width: 100%;
        /* 高度交给内容：窗口按这个测量值收，不留中间的空隙 */
        height: auto;
        border-radius: 10px;
        background: ${s.cardBg};
        border: 1px solid ${s.border};
        box-shadow: 0 8px 24px rgba(0,0,0,0.18);
        color: ${s.cardFg};
        display: flex;
        flex-direction: column;
        overflow: hidden;
        position: relative;
        box-sizing: border-box;
      }

      /* ─── header ─── */
      .reminder-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 7px 10px 2px;
        flex-shrink: 0;
      }
      .reminder-dot {
        width: 6px; height: 6px; border-radius: 50%;
        background: ${s.accent};
        flex-shrink: 0;
      }
      .reminder-title {
        flex: 1;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.2px;
        color: ${s.sub};
      }
      .reminder-close {
        background: transparent;
        border: 0;
        color: ${s.muted};
        font-size: 15px;
        line-height: 1;
        width: 18px; height: 18px;
        border-radius: 4px;
        cursor: pointer;
      }
      .reminder-close:hover { background: ${s.fieldHover}; color: ${s.cardFg}; }

      /* ─── body ── */
      .reminder-body {
        padding: 2px 10px 4px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex-shrink: 0;
        min-height: 0;
      }
      .reminder-text {
        font-size: 13px;
        font-weight: 500;
        line-height: 1.35;
        color: ${s.cardFg};
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
        /* 固定占两行高：内容高度恒定，窗口高度才能按内容收紧而不留缝 */
        min-height: 36px;
      }
      .reminder-due {
        font-size: 11px;
        color: ${s.sub};
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      /* ─── 延后时间常显：一排预设 + 自定义输入 ─── */
      .reminder-snooze {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 10px 0;
        flex-shrink: 0;
      }
      .reminder-pill {
        flex: 1 1 0;
        min-width: 0;
        height: 24px;
        border-radius: 12px;
        border: 1px solid ${s.border};
        background: ${s.field};
        color: ${s.cardFg};
        font-size: 11px;
        font-weight: 500;
        padding: 0 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      .reminder-pill:hover { background: ${s.fieldHover}; }
      .reminder-pill.on {
        background: ${s.accent};
        border-color: transparent;
        color: #fff;
        font-weight: 600;
      }
      .reminder-pill:disabled { opacity: 0.5; cursor: not-allowed; }
      .reminder-custom {
        width: 42px;
        height: 24px;
        flex-shrink: 0;
        background: ${s.field};
        border: 1px solid ${s.border};
        border-radius: 5px;
        color: ${s.cardFg};
        font-size: 11px;
        padding: 0 3px;
        outline: none;
        text-align: center;
        -moz-appearance: textfield;
        appearance: textfield;
      }
      .reminder-custom:focus { border-color: ${s.accent}; }
      .reminder-custom::-webkit-outer-spin-button,
      .reminder-custom::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .reminder-unit {
        font-size: 10px;
        color: ${s.muted};
        flex-shrink: 0;
        white-space: nowrap;
      }

      /* ─── 唯一的动作按钮：没选时间＝我知道了，选了＝稍后提醒 ─── */
      .reminder-actions {
        display: flex;
        padding: 6px 10px 10px;
        flex-shrink: 0;
      }
      .reminder-btn {
        flex: 1;
        height: 28px;
        border-radius: 8px;
        border: 1px solid transparent;
        font-size: 13px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .reminder-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .reminder-btn-primary {
        background: ${s.accent};
        color: #fff;
        font-weight: 600;
      }
      .reminder-btn-primary:hover { background: ${s.accentHover}; }
    `}</style>
  );
}

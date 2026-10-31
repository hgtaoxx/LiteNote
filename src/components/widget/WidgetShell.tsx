import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cursorPosition, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { resolveLocale, t } from "@/i18n";
import { useWidgetActions } from "@/hooks/useWidgetActions";
import { useFocusWindowSize } from "@/hooks/useFocusWindowSize";
import { resolveWindowMode } from "@/lib/windowMode";
import { resolveContentFontStack } from "@/lib/contentFonts";
import { webdavAutoSync } from "@/lib/webdav";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTodoStore } from "@/stores/todoStore";
import type { TodoColorId } from "@/types/todo";
import { generateExportContent, saveTxt } from "@/lib/exportTodos";
import { ClockSection } from "./ClockSection";
import { ConfirmDialog } from "./ConfirmDialog";
import { DatePicker } from "./DatePicker";
import { FooterBar } from "./FooterBar";
import { HeaderBar } from "./HeaderBar";
import { RecurrencePicker } from "./RecurrencePicker";
import { SettingsModal } from "./SettingsModal";
import { TodoContextMenu } from "./TodoContextMenu";
import { TodoList } from "./TodoList";
import { WeekCalendar } from "./WeekCalendar";
import { FocusDragHandle } from "./FocusDragHandle";
import { FocusContextMenu } from "./FocusContextMenu";

/** 获取指定时间戳当天的开始时间（00:00:00） */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 获取指定时间戳当天的结束时间（23:59:59.999） */
function endOfDay(ts: number): number {
  return startOfDay(ts) + 86_399_999;
}

export function WidgetShell() {
  const windowLocked = useSettingsStore((s) => s.windowLocked);
  const setWindowLocked = useSettingsStore((s) => s.setWindowLocked);
  const panelOpacity = useSettingsStore((s) => s.panelOpacity);
  const setPanelOpacity = useSettingsStore((s) => s.setPanelOpacity);
  const localeMode = useSettingsStore((s) => s.localeMode);
  const setLocaleMode = useSettingsStore((s) => s.setLocaleMode);
  const clockCollapsed = useSettingsStore((s) => s.clockCollapsed);
  const setClockCollapsed = useSettingsStore((s) => s.setClockCollapsed);
  const showSeconds = useSettingsStore((s) => s.showSeconds);
  const setShowSeconds = useSettingsStore((s) => s.setShowSeconds);
  const setFocusMode = useSettingsStore((s) => s.setFocusMode);
  const contentFontSize = useSettingsStore((s) => s.contentFontSize);
  const setContentFontSize = useSettingsStore((s) => s.setContentFontSize);
  const contentFontFamily = useSettingsStore((s) => s.contentFontFamily);
  const setContentFontFamily = useSettingsStore((s) => s.setContentFontFamily);
  const weekCalendarCollapsed = useSettingsStore((s) => s.weekCalendarCollapsed);
  const setWeekCalendarCollapsed = useSettingsStore((s) => s.setWeekCalendarCollapsed);
  const autoStart = useSettingsStore((s) => s.autoStart);
  const setAutoStart = useSettingsStore((s) => s.setAutoStart);
  const edgeHide = useSettingsStore((s) => s.edgeHide);
  const setEdgeHide = useSettingsStore((s) => s.setEdgeHide);
  const desktopPin = useSettingsStore((s) => s.desktopPin);
  const setDesktopPin = useSettingsStore((s) => s.setDesktopPin);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const reminderMode = useSettingsStore((s) => s.reminderMode);
  const setReminderMode = useSettingsStore((s) => s.setReminderMode);
  const focusMode = useSettingsStore((s) => s.focusMode);
  const settingsInitialized = useSettingsStore((s) => s.initialized);
  const webdavEnabled = useSettingsStore((s) => s.webdavEnabled);
  const lastSettingsError = useSettingsStore((s) => s.lastError);
  const clearSettingsError = useSettingsStore((s) => s.clearError);
  const lastTodoError = useTodoStore((s) => s.lastError);
  const clearTodoError = useTodoStore((s) => s.clearError);
  const lastTodoSuccess = useTodoStore((s) => s.lastSuccess);
  const clearTodoSuccess = useTodoStore((s) => s.clearSuccess);
  const setTodoSuccess = useTodoStore((s) => s.setSuccess);
  const reloadFromDb = useTodoStore((s) => s.reloadFromDb);

  // 周日历选中日期（null 表示不筛选）
  const [selectedDate, setSelectedDate] = useState<number | null>(null);
  // 待办视图筛选：进行中 / 已完成
  const [todoView, setTodoView] = useState<"active" | "completed">("active");
  const [showSettings, setShowSettings] = useState(false);
  /**
   * 钉桌面是否**真的生效**（已挂到桌面层）。
   * 设置开着但正贴边停靠时是 false —— 那时它被挂起，解除停靠会自动挂回。
   */
  const [pinApplied, setPinApplied] = useState(false);
  /** 贴边隐藏当前是否处于停靠态（决定钉桌面按钮能不能点） */
  const [dockedUi, setDockedUi] = useState(false);
  /** 专注模式的右键菜单（HTML 自绘）位置；null = 不显示 */
  const [focusMenu, setFocusMenu] = useState<{ x: number; y: number } | null>(null);

  // 直接获取 setTodoDueDate（拖拽到日历日期时需用）
  const setTodoDueDate = useTodoStore((s) => s.setTodoDueDate);

  const lastError = lastSettingsError || lastTodoError;

  // 错误展示（自动清除）
  useEffect(() => {
    if (lastSettingsError) {
      const id = window.setTimeout(() => clearSettingsError(), 4000);
      return () => window.clearTimeout(id);
    }
  }, [lastSettingsError, clearSettingsError]);

  useEffect(() => {
    if (lastTodoError) {
      const id = window.setTimeout(() => clearTodoError(), 4000);
      return () => window.clearTimeout(id);
    }
  }, [lastTodoError, clearTodoError]);

  useEffect(() => {
    if (lastTodoSuccess) {
      const id = window.setTimeout(() => clearTodoSuccess(), 2500);
      return () => window.clearTimeout(id);
    }
  }, [lastTodoSuccess, clearTodoSuccess]);

  const locale = useMemo(() => resolveLocale(localeMode), [localeMode]);

  const noop = useCallback(() => {}, []);

  // 注意：这里**不要**加全局的 contextmenu 拦截。
  // 曾经加过一层 document 级 preventDefault 想顺便压掉无边框窗口的系统菜单，
  // 结果把内容区（待办列表）原本的右键行为也一并挡住了。
  // 需要自定义菜单的地方各自在 onContextMenu 里 preventDefault 即可，
  // 不要动全局默认行为。
  const noopContextMenu = useCallback((_e: React.MouseEvent, _id: string) => {}, []);
  const noopChangeText = useCallback((_id: string, _text: string) => {}, []);

  // 背景层样式：包含透明度和实际背景
  const bgLayerStyle: React.CSSProperties = useMemo(
    () => ({
      opacity: panelOpacity,
      background: "var(--ln-theme-bg)",
      backdropFilter: "var(--ln-theme-backdrop)",
      WebkitBackdropFilter: "var(--ln-theme-backdrop)",
    }),
    [panelOpacity],
  );

  const {
    todos,
    completedCount,
    menuTodo,
    selectedId,
    editingId,
    menu,
    confirmClear,
    confirmDeleteId,
    dueDatePickerFor,
    recurrencePicker,
    copyToPickerFor,
    setMenu,
    handleCloseMenu,
    setConfirmClear,
    setConfirmDeleteId,
    handleAdd,
    handleSelect,
    handleStartEdit,
    sorting,
    handleStartSort,
    handleEndSort,
    handleContextMenu,
    handleEndEdit,
    handleClearCompleted,
    handleDeleteOne,
    handleDueDateConfirm,
    handleDueDateCancel,
    handleRecurrenceConfirm,
    handleRecurrenceCancel,
    handleCopyToConfirm,
    handleCopyToCancel,
    updateTodoText,
    toggleCompleted,
    reorderTodos,
    menuActions,
  } = useWidgetActions(locale);

  const focusActiveTodos = useMemo(
    () => todos.filter((t) => !t.completed),
    [todos],
  );

  // 模式判定统一走 resolveWindowMode（唯一来源），四种形态见 lib/windowMode.ts 的状态表
  const windowMode = resolveWindowMode(focusMode, windowLocked);

  /**
   * 诊断日志：曾有"刷新内容区后莫名跳到专注模式"的偶发报告，
   * 但查遍前端（无自动切模式的代码、无键盘处理）、后端（busy_timeout 已设、
   * WebDAV 同步不含 focusMode）都没找到能改它的路径。
   * 这里在每次 focusMode 变化时打一行日志，下次复发时打开开发者工具
   * （右键 → 更多工具 → 开发者工具）就能看到它是在什么时候、变成什么值。
   */
  useEffect(() => {
    console.warn("[LiteNote] focusMode 变为:", focusMode);
  }, [focusMode]);

  // 内容字号 / 内容字体下发为 CSS 变量，**只有待办正文（TodoRow）读它们**。
  // 界面其余部分（顶栏、时钟区、底部栏、设置面板）固定用默认字体与字号，不跟随。
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--ln-content-font-size", `${contentFontSize}px`);
    root.setProperty(
      "--ln-content-font-family",
      resolveContentFontStack(contentFontFamily),
    );
  }, [contentFontSize, contentFontFamily]);

  useFocusWindowSize(focusMode, settingsInitialized, windowMode.sizeLocked);

  /**
   * 钉桌面「设置开着」和「真的挂上了」是两件事：
   * 桌面层的父窗口不一定已经存在（开机时资源管理器还没建好），停靠期间还会被挂起。
   * 生效状态统一问 Rust，按钮亮不亮以它为准。
   */
  useEffect(() => {
    if (!settingsInitialized) return;
    void invoke("get_desktop_pin_state")
      .then((v) => setPinApplied(Boolean(v)))
      .catch(() => {});
  }, [settingsInitialized, desktopPin]);

  const handleToggleDesktopPin = () => {
    void setDesktopPin(!desktopPin).then(setPinApplied);
  };

  /**
   * WebDAV 自动同步：**内容变化后才触发**，不再定期无脑上传。
   *
   * 这里只负责"内容变化后稍等一下触发一次"，真正要不要走网络由 Rust 侧的内容
   * 指纹决定：指纹与上次同步一致就直接返回，一个请求都不发。因此这里的防抖
   * 即使多触发几次也没有任何网络开销。
   */
  const didSkipFirstAutoSync = useRef(false);
  useEffect(() => {
    if (!settingsInitialized || !webdavEnabled) return;
    // 启动时加载数据那一次不算「内容变化」
    if (!didSkipFirstAutoSync.current) {
      didSkipFirstAutoSync.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      void webdavAutoSync().catch((e) =>
        console.warn("[LiteNote] WebDAV 自动同步失败:", e),
      );
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [todos, webdavEnabled, settingsInitialized]);

  /**
   * 贴边隐藏（类似 QQ）—— 前端实现，支持屏幕的左 / 右 / 上三条边。
   *
   *   · 吸附：拖动停下后，窗口离某条边不到 SNAP 像素才贴上去；几条边都够近时贴最近的那条。
   *     窗口只要探出了屏幕边界，无论超出多少都按越界那条边吸回来（不用凑很近）
   *   · 隐藏：鼠标离开窗口约 0.2 秒后沿停靠的那条边滑出，只在屏幕内留 PEEK 像素
   *   · 显示（两条路，缺一不可）：
   *       1) 鼠标真的进了本窗口（碰到那 PEEK 像素）→ DOM 的 mouseenter 立即滑回
   *       2) 活动窗口是别的程序时，本窗口收不到 DOM 事件（露出的那条窄边还被别的
   *          窗口盖着）→ 轮询系统全局光标，**贴到边带 REVEAL_BAND 以内**就唤出，
   *          并临时抬一层，否则滑出来也被压在下面看不见
   *   · 轮询在整个停靠期间都跑（每 120ms 一次 IPC）：唤出靠它，DOM 漏报 mouseleave
   *     时的收回也靠它（别的窗口抬起来接管光标时，本窗口根本收不到离开事件，
   *     否则挂件会一直露着、一直压在最上面）。
   *   · 滞回：唤出只看贴边窄带，收回看「窗口此刻真实占的矩形 + HYST 余量」，两条边界不重合。
   *     挂件被拖着走时这块矩形跟着走，所以拖离贴边不会被误当成「鼠标离开了」。
   *     另外 DOM 的 enter/leave 会被窗口自己的滑动补发，看起来跟真的进出一样 ——
   *     所以 slideOut 前还要再确认光标真的走开了，否则会「弹出→被假 leave 收回→再弹出」循环。
   *
   * 为什么不用 Rust 轮询全局光标：那条路要「每拍读数据库 + GetCursorPos +
   * set_position」全部成功才有效，任一环失败就整体静默失效且看不到日志。
   * 这里只在「藏着 / 轮询唤出」这两个状态下拍一次 cursor_position 的 IPC，
   * 停靠判定和滑出滑回全走窗口自己的坐标与鼠标进出事件。
   *
   * ⚠️ 自己 setPosition 一样会收到 onMoved。滑出后的位置在屏幕外，若把它
   * 当成「用户拖离了边缘」重判，dock 会被清空，窗口就再也滑不回来。
   * 所以：动画期间的事件直接丢弃，动画结束后由 reconcile 认「当前停靠边的
   * 贴位与隐位」，认出来就保持原状态。
   */
  useEffect(() => {
    if (!settingsInitialized || !edgeHide || focusMode) return;
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;

    const win = getCurrentWindow();
    /**
     * 位置写入口：钉桌面期间窗口挂在桌面层的窗口里，是子窗口 ——
     * 子窗口的位置按父窗口客户区原点解释，和屏幕坐标差一个偏移量。
     * Tauri 的 setPosition 不知道这件事，所以统一走 Rust 的换算入口。
     */
    const place = (x: number, y: number) =>
      invoke("set_widget_position", { x, y }).then(() => undefined);
    /** 把停靠状态报给 Rust：停靠期间钉桌面自动挂起（唤出要靠临时置顶） */
    const reportDock = (active: boolean) => {
      setDockedUi(active);
      void invoke("set_dock_state", { active })
        .then((applied) => setPinApplied(Boolean(applied)))
        .catch(() => {});
    };
    /** 隐藏时露在屏幕内的厚度（物理 px） */
    const PEEK = 2;
    /**
     * 近距离吸附阈值（三条边共用）：只有停在离边 10px 以内才吸。
     * 放得远的窗口是用户故意摆在中间的，不该被抢走。
     * 「已经越过屏幕边界」不走这个阈值——超出多少都直接拉回来（见 reconcile）。
     */
    const SNAP = 10;
    /** 鼠标离开多久后滑出（毫秒）。另外还会叠加轮询间隔与滑动动画时长 */
    const HIDE_DELAY = 200;
    /** 拖动结束多久后再判断吸附，避免和拖动过程打架 */
    const SNAP_DELAY = 260;
    /** 滑出/滑回动画时长（毫秒） */
    const SLIDE_MS = 180;
    /** 动画分帧间隔（毫秒） */
    const FRAME_MS = 16;
    /**
     * 隐藏态下轮询全局光标的间隔（毫秒）。
     * 活动窗口是别的程序时，鼠标经过的是那个程序的窗口，本窗口收不到 DOM 事件，
     * 只能像 QQ 那样自己问系统「光标现在在哪儿」。
     */
    const HOVER_POLL_MS = 120;
    /**
     * 唤出用的贴边窄带（物理 px）= 露出来的那一条 PEEK 的宽度：
     * 鼠标必须**真的碰到边上那条**才弹出。原来给的是 24px，离边还有一截就冒出来，
     * 贴着边干活时非常容易误触发。
     * 收回看的是「离开整块窗口」，两条边界仍不重合，鼠标在边上抖不会来回弹。
     */
    const REVEAL_BAND = PEEK;
    /** 收回判定比唤出多让出的余量（物理 px）：滞回带，鼠标贴在边界抖动也不会来回弹 */
    const HYST = 30;

    type Side = "left" | "right" | "top";

    let dock: Side | null = null;
    /** 停靠期间锁死的显示器边界（多屏压接缝时 currentMonitor 会来回跳） */
    let dockMon: {
      left: number;
      right: number;
      top: number;
      bottom: number;
    } | null = null;
    let hidden = false;
    /** 停靠时窗口显示状态下占的那块矩形（物理 px）：贴边窄带按它算 */
    let hoverRect: { l: number; r: number; t: number; b: number } | null = null;
    /**
     * 窗口此刻真实占的那块矩形（物理 px）：「光标还在不在挂件上」按它判。
     * 拖动时 reconcile 要等窗口停下 260ms 才插手，这期间真实位置和 hoverRect
     * 不一致 —— 跟着理想位判就会把「拖离贴边」误判成「鼠标走开了」，松手就收回。
     */
    let winRect: { l: number; r: number; t: number; b: number } | null = null;
    /** 窗口尺寸（物理 px）：onMoved 只带位置，尺寸沿用最近一次 measure 读到的 */
    let winW = 0;
    let winH = 0;
    /**
     * 已经临时抬过层。收回时必须按这个标记还层，不能靠「是谁唤出的」判断 ——
     * DOM 的 enter/leave 会被窗口自己的滑动补发，那种事件跟真的进出长得一模一样。
     */
    let raised = false;
    /** 正在做程序化的移动：此期间收到的 onMoved 全是我们自己触发的 */
    let animating = false;
    /** 每次程序移动递增，旧动画循环靠它发现已被接管、立刻收手 */
    let moveSeq = 0;
    let hideTimer: number | null = null;
    let snapTimer: number | null = null;
    let pollTimer: number | null = null;
    let cancelled = false;
    /** 已经报给 Rust 的停靠状态，只在真的变化时才上报（钉桌面的挂起/恢复据此决定） */
    let dockReported = false;

    /** 读出当前需要的几何信息（全部是物理像素） */
    const measure = async () => {
      const mon = await currentMonitor();
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      winW = size.width;
      winH = size.height;
      winRect = {
        l: pos.x,
        r: pos.x + size.width,
        t: pos.y,
        b: pos.y + size.height,
      };
      if (!mon) return null;
      const live = {
        left: mon.position.x,
        right: mon.position.x + mon.size.width,
        top: mon.position.y,
        bottom: mon.position.y + mon.size.height,
      };
      // 已停靠且窗口还碰到停靠那块屏时，沿用停靠当时记下的边界：窗口横跨两屏接缝时
      // currentMonitor 会随可见面积在两块屏之间跳，跟着跳会把窗口甩到另一块屏。
      // 整个窗口都挪到另一块屏上时（不再有任何交集）才改用实时边界。
      const cache =
        dockMon &&
        pos.x < dockMon.right &&
        pos.x + size.width > dockMon.left &&
        pos.y < dockMon.bottom &&
        pos.y + size.height > dockMon.top
          ? dockMon
          : null;
      const b = cache ?? live;
      return {
        monLeft: b.left,
        monRight: b.right,
        monTop: b.top,
        monBottom: b.bottom,
        w: size.width,
        h: size.height,
        x: pos.x,
        y: pos.y,
        leftFlush: b.left,
        rightFlush: b.right - size.width,
        topFlush: b.top,
        leftHidden: b.left - size.width + PEEK,
        rightHidden: b.right - PEEK,
        topHidden: b.top - size.height + PEEK,
      };
    };

    type Geo = Awaited<ReturnType<typeof measure>>;

    /** 另一轴如果也探出屏幕，一并拉回屏幕内，别让窗口斜着露头 */
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(Math.max(v, lo), hi);

    /** 某条边在显示 / 隐藏状态下应该贴在哪里 */
    const targetOf = (m: NonNullable<Geo>, side: Side, isHidden: boolean) => {
      const y = clamp(m.y, m.monTop, m.monBottom - m.h);
      const x = clamp(m.x, m.monLeft, m.monRight - m.w);
      if (side === "left") {
        return { x: isHidden ? m.leftHidden : m.leftFlush, y };
      }
      if (side === "right") {
        return { x: isHidden ? m.rightHidden : m.rightFlush, y };
      }
      return { x, y: isHidden ? m.topHidden : m.topFlush };
    };

    /** 把窗口移到 (x, y)：animate 为真时分帧滑过去 */
    const moveTo = async (
      fromX: number,
      fromY: number,
      x: number,
      y: number,
      animate: boolean,
    ) => {
      const seq = ++moveSeq;
      animating = true;
      try {
        const frames = animate ? Math.max(1, Math.round(SLIDE_MS / FRAME_MS)) : 1;
        for (let i = 1; i <= frames; i++) {
          if (cancelled || seq !== moveSeq) return;
          const t = animate ? i / frames : 1;
          const eased = 1 - (1 - t) * (1 - t);
          const px = Math.round(fromX + (x - fromX) * eased);
          const py = Math.round(fromY + (y - fromY) * eased);
          await place(px, py);
          if (animate && i < frames) {
            await new Promise((r) => window.setTimeout(r, FRAME_MS));
          }
        }
      } catch (e) {
        console.warn("[LiteNote] 贴边移动窗口失败:", e);
      } finally {
        if (seq === moveSeq) animating = false;
      }
    };

    /** 由当前几何反推停靠状态（自己触发的移动也走这里，认得出隐藏位） */
    const reconcile = async () => {
      if (cancelled || animating) return;
      const m = (await measure().catch(() => null)) as NonNullable<Geo> | null;
      if (!m || cancelled) return;
      const at = (a: number, b: number) => Math.abs(a - b) <= 2;
      const setDock = (side: Side, isHidden: boolean) => {
        dock = side;
        hidden = isHidden;
        dockMon = {
          left: m.monLeft,
          right: m.monRight,
          top: m.monTop,
          bottom: m.monBottom,
        };
        // 感应范围取「显示状态下窗口占的那块矩形」：隐藏时鼠标只要进这块区域就算贴近
        const shown = targetOf(m, side, false);
        hoverRect = {
          l: shown.x,
          r: shown.x + m.w,
          t: shown.y,
          b: shown.y + m.h,
        };
        // 停靠期间一直轮询：唤出要它，「DOM 没察觉到鼠标离开」时的收回也要它
        startPoll();
        // 钉桌面要挂起（唤出得临时置顶，挂在桌面层的子窗口置顶不了）
        if (!dockReported) {
          dockReported = true;
          reportDock(true);
        }
      };
      const undock = () => {        dock = null;
        dockMon = null;
        hidden = false;
        hoverRect = null;
        winRect = null;
        stopPoll();
        lower();
        // 解除停靠后才把钉桌面挂回去，且要先还层再报（顺序反了会闪一下）
        if (dockReported) {
          dockReported = false;
          reportDock(false);
        }
      };
      // 已停靠时先按当前这条边认位：贴角的时候几条边可能同时成立，
      // 只认当前边才不会被别的边抢走（抢走就会横竖来回跳）。
      // 隐藏位也必须在这一步认出来，否则会被下一步当成「越界」又拉回屏幕里。
      if (dock === "left" && (at(m.x, m.leftFlush) || at(m.x, m.leftHidden))) {
        setDock("left", at(m.x, m.leftHidden));
        return;
      }
      if (dock === "right" && (at(m.x, m.rightFlush) || at(m.x, m.rightHidden))) {
        setDock("right", at(m.x, m.rightHidden));
        return;
      }
      if (dock === "top" && (at(m.y, m.topFlush) || at(m.y, m.topHidden))) {
        setDock("top", at(m.y, m.topHidden));
        return;
      }
      // 窗口探出屏幕边界了：超出多少都算，按越得最多的那条边吸回来
      const over = [
        { side: "left" as Side, by: m.monLeft - m.x },
        { side: "right" as Side, by: m.x + m.w - m.monRight },
        { side: "top" as Side, by: m.monTop - m.y },
      ]
        .filter((o) => o.by > 0)
        .sort((a, b) => b.by - a.by)[0];
      if (over) {
        // 我们以为它正藏着，而越界的正是当前这条边：那是窗口尺寸在这期间被改过
        // （进出专注模式会把高度从 707 换成 379），隐位对不上才显得越界。
        // 按新尺寸重新贴回隐位就行，别把它整个拉回屏幕里 —— 拉回来还会闪一下。
        if (hidden && dock === over.side) {
          setDock(dock, true);
          const back = targetOf(m, dock, true);
          await moveTo(m.x, m.y, back.x, back.y, false);
          return;
        }
        setDock(over.side, false);
        const t = targetOf(m, over.side, false);
        await moveTo(m.x, m.y, t.x, t.y, false);
        return;
      }
      // 没越界时只认近距离：阈值内挑最近的一条边
      const cands: { side: Side; dist: number }[] = [
        { side: "left", dist: Math.abs(m.x - m.leftFlush) },
        { side: "right", dist: Math.abs(m.x - m.rightFlush) },
        { side: "top", dist: Math.abs(m.y - m.topFlush) },
      ];
      const best = cands
        .filter((c) => c.dist <= SNAP)
        .sort((a, b) => a.dist - b.dist)[0];
      if (best) {
        setDock(best.side, false);
        const t = targetOf(m, best.side, false);
        await moveTo(m.x, m.y, t.x, t.y, false);
        return;
      }
      undock();
    };

    /** 光标是否落在挂件此刻真实占的那块矩形里（外加 pad 余量） */
    const inZone = (c: { x: number; y: number }, pad = HYST) =>
      !!winRect &&
      c.x >= winRect.l - pad &&
      c.x < winRect.r + pad &&
      c.y >= winRect.t - pad &&
      c.y < winRect.b + pad;

    /** 光标此刻是否还在感应区里（也就是「还没真正走开」） */
    const cursorInZone = async () => {
      const c = await cursorPosition().catch(() => null);
      if (!c || cancelled) return false;
      return inZone(c);
    };

    /** 我们自己要动了：把之前排下的吸附判定撤掉，别拿动画中间帧去判越界 */
    const cancelSnap = () => {
      if (snapTimer !== null) {
        window.clearTimeout(snapTimer);
        snapTimer = null;
      }
    };

    /** 沿停靠边滑出屏幕（只留 PEEK） */
    const slideOut = async () => {
      if (cancelled || !dock || hidden) return;
      // 光标还贴在感应区里就不收：滑入滑出会让浏览器补发 enter/leave，
      // 那种事件和「鼠标真的离开了」长得一样，收下去就会被轮询再唤出，形成循环弹出
      if (await cursorInZone()) return;
      // 真要闻了才撤之前的吸附判定：只是被上面那道护栏拦住的话，
      // 把用户拖动排下的那次重判撤掉，dock 就会一直停在老边上
      cancelSnap();
      if (cancelled || !dock || hidden) return;
      const m = (await measure().catch(() => null)) as NonNullable<Geo> | null;
      if (!m || cancelled || !dock || hidden) return;
      const t = targetOf(m, dock, true);
      hidden = true;
      const wasRaised = raised;
      startPoll();
      await moveTo(m.x, m.y, t.x, t.y, true);
      // 轮询唤出时抬过一层，藏回去就还给别的程序，别一直压着
      if (wasRaised) lower();
    };

    /** 沿停靠边滑回屏幕 */
    const slideIn = async () => {
      if (cancelled || !dock || !hidden) return;
      cancelSnap();
      const m = (await measure().catch(() => null)) as NonNullable<Geo> | null;
      if (!m || cancelled || !dock || !hidden) return;
      const t = targetOf(m, dock, false);
      hidden = false;
      hoverRect = { l: t.x, r: t.x + m.w, t: t.y, b: t.y + m.h };
      await moveTo(m.x, m.y, t.x, t.y, true);
    };

    const clearHideTimer = () => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer);
        hideTimer = null;
      }
    };

    // 鼠标进窗口 → 立刻滑回
    const onEnter = () => {
      clearHideTimer();
      if (dock && hidden) void slideIn();
    };
    // 鼠标离开窗口 → 稍等一下再滑出（给"只是划过"留余地）
    const onLeave = () => {
      clearHideTimer();
      if (!dock || hidden) return;
      hideTimer = window.setTimeout(() => {
        hideTimer = null;
        void slideOut();
      }, HIDE_DELAY);
    };

    const startPoll = () => {
      if (cancelled || pollTimer !== null) return;
      pollTimer = window.setInterval(() => void hoverTick(), HOVER_POLL_MS);
    };
    const stopPoll = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    /**
     * 活动窗口是别的程序时，鼠标经过的是那个程序的窗口，本窗口收不到 DOM 的
     * enter/leave —— 这时只能像 QQ 那样自己问系统光标现在在哪，贴近了就唤出。
     */
    const hoverTick = async () => {
      if (cancelled || !dock || !hoverRect) {
        stopPoll();
        return;
      }
      const c = await cursorPosition().catch(() => null);
      if (!c || cancelled || !hoverRect) return;
      // 收回看的是「感应区 + HYST 余量」；唤出只看贴边窄带。
      // 两条边界不重合才有滞回，鼠标停在边界上抖不会来回弹。
      const inside = inZone(c);
      const spanOk =
        dock === "left" || dock === "right"
          ? c.y >= hoverRect.t - HYST && c.y < hoverRect.b + HYST
          : c.x >= hoverRect.l - HYST && c.x < hoverRect.r + HYST;
      // 带内 = 跨过那条边 REVEAL_BAND 以内，且不能跑到外侧的另一块屏上去。
      // 只写下界会漏成半平面：副屏右边缘是 x=0，`c.x >= -24` 会把整块主屏都
      // 判成「贴着副屏右边」，于是每次收起后 120ms 内又被唤出，形成循环弹出。
      const nearEdge =
        spanOk &&
        (dock === "right"
          ? c.x >= hoverRect.r - REVEAL_BAND && c.x < hoverRect.r + HYST
          : dock === "left"
            ? c.x <= hoverRect.l + REVEAL_BAND && c.x > hoverRect.l - HYST
            : c.y <= hoverRect.t + REVEAL_BAND && c.y > hoverRect.t - HYST);
      // 滑出/滑回的动画期间不响应：否则 slideOut 还没跑完就被这次 tick 抢成
      // 「显示了但层已经还回去了」，动画结束后再判一次就够了
      if (animating) return;
      if (hidden) {
        if (nearEdge) void summonIn();
        return;
      }
      // 露出状态下只要光标不在窗口上就排一次收回（DOM 漏报 mouseleave 时的兜底）。
      // 已经排着就别重排：每 120ms 重排一次，那 200ms 的延迟永远到不了。
      // 也不能要求「上一拍还在里面」这个边沿 —— 窗口自己弹回屏幕内（尺寸变了、越界
      // 恢复）时光标本来就在外面，靠边沿触发就再也收不回去，看着就是「贴上边不隐藏」。
      if (!inside && hideTimer === null) onLeave();
    };

    /**
     * 抬层只在这次唤出期间有效：窗口藏回去、解除停靠或 effect 关闭时都立刻还层，
     * 所以挂件平时不会压在所有程序上面（用户要求「只有激活时才在前面」）。
     */
    const lower = () => {
      if (!raised) return;
      raised = false;
      void win.setAlwaysOnTop(false).catch(() => {});
    };

    /** 轮询唤出：先抬一层，否则滑出来仍被活动窗口压着，等于没显示 */
    const summonIn = async () => {
      if (cancelled || !dock || !hidden) return;
      raised = true;
      await win.setAlwaysOnTop(true).catch(() => {});
      await slideIn();
    };

    // 窗口被移动 → 停下之后再判断吸附（动画期间的移动不参与）
    const unlistenPromise = win.onMoved((e) => {
      // 真实位置要先跟上：拖动路上 reconcile 一直不参与（它等窗口停下 260ms 才判），
      // 而每 120ms 的轮询就得按「光标在不在窗口上」决定收不收
      const p = e.payload;
      if (winW && winH) {
        winRect = { l: p.x, r: p.x + winW, t: p.y, b: p.y + winH };
      }
      if (cancelled || animating) return;
      if (snapTimer !== null) window.clearTimeout(snapTimer);
      snapTimer = window.setTimeout(() => {
        snapTimer = null;
        // 排队这段时间里我们可能已经开始滑动：那时窗口正好处在屏幕外，
        // 拿去判越界会被拽回来，滑出动画就跑完了又被弹回屏幕里
        if (animating) return;
        void reconcile();
      }, SNAP_DELAY);
    });

    document.addEventListener("mouseenter", onEnter);
    document.addEventListener("mouseleave", onLeave);
    void reconcile();

    return () => {
      cancelled = true;
      clearHideTimer();
      stopPoll();
      if (snapTimer !== null) window.clearTimeout(snapTimer);
      document.removeEventListener("mouseenter", onEnter);
      document.removeEventListener("mouseleave", onLeave);
      void unlistenPromise.then((un) => un()).catch(() => {});
      // 关开关 / 进专注模式时如果正藏着，把它拉回屏幕内，别留半截在外面
      if (dock && hidden) {
        const side = dock;
        void (async () => {
          const m = (await measure().catch(() => null)) as NonNullable<Geo> | null;
          if (!m) return;
          const t = targetOf(m, side, false);
          await place(t.x, t.y).catch(() => {});
        })();
      }
      lower();
      // 关开关 / 进专注模式时别把钉桌面一直挂在起：收尾报一次「已不停靠」
      if (dockReported) {
        dockReported = false;
        reportDock(false);
      }
    };

  }, [settingsInitialized, edgeHide, focusMode]);

  /**
   * 专注模式：右键**任意位置**弹出应用自己的菜单（隐藏界面 / 完整模式 / 退出）。
   *
   * 为什么自己做：WebView2 自带的右键菜单没有任何字号/尺寸/排版接口，改不了，
   * 所以启动时已经把它整个关掉（Rust 侧 disable_native_context_menu），
   * 右键就完全交回应用。菜单本体是 Rust 侧的原生菜单（popup_focus_menu），
   * 外观与系统一致，位置跟着鼠标走。
   *
   * ⚠️ 只在专注模式注册、退出时立刻移除，所以**完整模式下的右键完全不受影响**
   * （待办行仍然是自己的 TodoContextMenu）。
   */
  useEffect(() => {
    if (!focusMode) return;
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      // 记下位置，交给 FocusContextMenu 渲染（HTML 自绘，尺寸字号完全可控）
      setFocusMenu({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, [focusMode]);

  // 进入专注模式时关闭编辑态、右键菜单与模态框。
  // 专注模式不渲染这些 UI，不清掉的话切回完整模式会「突然又弹出来」。
  useEffect(() => {
    if (!focusMode) return;
    setMenu(null);
    handleEndEdit();
    setShowSettings(false);
    setFocusMenu(null);
  }, [focusMode, setMenu, handleEndEdit]);

  // 当前拖拽中的待办 id（用于 DragOverlay）
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const activeDragTodo = useMemo(
    () => (activeDragId ? todos.find((t) => t.id === activeDragId) ?? null : null),
    [activeDragId, todos],
  );

  // 根据周日历选中日期过滤待办
  const filteredTodos = useMemo(() => {
    if (selectedDate === null) return todos;
    return todos.filter((t) => {
      if (t.dueDate <= 0) return false;
      return t.dueDate >= selectedDate && t.dueDate <= endOfDay(selectedDate);
    });
  }, [todos, selectedDate]);

  useEffect(() => {
    document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
  }, [locale]);

  // 从云端恢复待办后，刷新主列表
  useEffect(() => {
    const handler = () => {
      void reloadFromDb();
      setTodoSuccess(t(locale, "syncStatusOk"));
    };
    window.addEventListener("litenote-webdav-restored", handler);
    return () => window.removeEventListener("litenote-webdav-restored", handler);
  }, [reloadFromDb, setTodoSuccess, locale]);

  /**
   * 锁定窗口的前端镜像。
   *
   * 锁定 = 不能移动、不能改变大小，其余操作照常：
   *   · 不能改大小：这里 setResizable(false)（Rust 侧也会做，双保险）
   *   · 不能移动：靠两处 —— 顶栏 / 拖拽条的 drag-region 一起禁用（本文件与 HeaderBar），
   *     以及 Rust 侧剥掉 Windows 标题栏样式（顶部那几像素本来会被系统当标题栏拖动）
   * 窗口「始终置顶」不再是一个开关：已写进 tauri.conf.json，恒为 true。
   */
  useEffect(() => {
    if (!settingsInitialized) return;
    void (async () => {
      try {
        await getCurrentWindow().setResizable(!windowLocked);
      } catch (e) {
        console.warn("[LiteNote] 前端锁定窗口失败（Rust 侧仍会生效）:", e);
      }
    })();
  }, [settingsInitialized, windowLocked]);

  const handleHide = useCallback(async () => {
    try {
      // 通过 Rust 命令隐藏：先保存窗口状态再隐藏
      await invoke("hide_main_window");
    } catch {
      /* 非 Tauri */
    }
  }, []);

  // 添加待办时，若当前选中了日期则自动附上截止时间（当天 23:59:59）
  const handleAddWithDate = useCallback(() => {
    handleAdd(selectedDate !== null ? endOfDay(selectedDate) : undefined);
  }, [handleAdd, selectedDate]);

  // 导出待办
  const handleExport = useCallback(() => {
    const content = generateExportContent(todos, locale);
    void saveTxt(content).then(() => {
      setTodoSuccess(t(locale, "toastExportSuccess"));
    });
  }, [todos, locale, setTodoSuccess]);

  // 拖拽传感器
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // 拖拽开始：记录被拖的待办
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  // 统一拖拽结束处理：排序 or 设置截止日期（循环待办不允许拖到日历改日期）
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      setActiveDragId(null);

      if (!over) return;

      const activeId = String(active.id);
      const overId = String(over.id);

      const overData = over.data.current as { type?: string; date?: number } | undefined;

      if (overData?.type === "day" && overData.date) {
        // 循环待办不允许拖到日历修改日期
        const todo = todos.find((t) => t.id === activeId);
        if (!todo?.isRecurring) {
          setTodoDueDate(activeId, endOfDay(overData.date));
          setSelectedDate(overData.date);
        }
      } else if (activeId !== overId) {
        reorderTodos(activeId, overId);
      }
    },
    [setTodoDueDate, reorderTodos, todos],
  );

  return (
    <>
      {/* Toast 提示（底部居中，错误优先） */}
      {(lastError || lastTodoSuccess) ? (
        <div
          className={`absolute bottom-16 left-1/2 z-[200] -translate-x-1/2 rounded-full bg-black/50 px-4 py-1.5 text-xs backdrop-blur-md shadow-lg ${
            lastError ? "text-red-300" : "text-emerald-300"
          }`}
        >
          {lastError ?? lastTodoSuccess}
        </div>
      ) : null}

      {focusMode ? (
        <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
          {/* 透明背景层 */}
          <div
            className="pointer-events-none absolute inset-0 z-0"
            style={bgLayerStyle}
          />
          {/* 内容层 - 文字永远清晰可见 */}
          <div
            className={
              "relative z-10 flex h-full min-h-0 w-full flex-col" +
              /* 专注受限形态（专注 + 穿透）：内容不可选中 */
              (windowMode.noSelect ? " select-none" : "")
            }
            /*
              注意：这里**不要**挂 onContextMenu。
              内容区要保留它原本的右键行为（用户反馈：挂上去会和应用菜单同时弹出）。
              应用自己的菜单只挂在拖拽条的**右半区**，见 FocusDragHandle。
            */
          >
            {/* 拖拽条始终占位（高度不变、切换时文字不跳），受限形态下仅禁用拖动 */}
            <FocusDragHandle
              draggable={windowMode.movable}
              locked={windowMode.sizeLocked}
            />
            <TodoList
              focusMode
              locale={locale}
              todos={focusActiveTodos}
              selectedId={null}
              editingId={null}
              emptyHint={`${t(locale, "focusEmptyHint")}\n${t(locale, "focusModeHint")}`}
              onSelect={noop}
              onContextMenu={noopContextMenu}
              onChangeText={noopChangeText}
              onEndEdit={noop}
              onToggleCompleted={toggleCompleted}
            />
          </div>
        </div>
      ) : (
      <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
        {/* 透明背景层 */}
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={bgLayerStyle}
        />
        {/* 内容层 - 文字永远清晰可见 */}
        <div className="relative z-10 flex h-full min-h-0 w-full flex-col">
        <HeaderBar
          locale={locale}
          windowLocked={windowLocked}
          onToggleWindowLock={() => setWindowLocked(!windowLocked)}
          desktopPin={desktopPin}
          pinApplied={pinApplied}
          pinUnavailable={dockedUi}
          onToggleDesktopPin={handleToggleDesktopPin}
          onEnterFocus={() => setFocusMode(true)}
          onOpenSettings={() => setShowSettings(true)}
          onHide={handleHide}
        />

        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {!clockCollapsed ? (
            <ClockSection
              locale={locale}
              showSeconds={showSeconds}
              onToggleSeconds={() => setShowSeconds(!showSeconds)}
            />
          ) : null}

          {!weekCalendarCollapsed ? (
            <WeekCalendar
              locale={locale}
              todos={todos}
              selectedDate={selectedDate}
              onSelectDate={setSelectedDate}
            />
          ) : null}

          <div className="flex px-2 py-1 select-none">
            <div
              className="flex w-full items-center gap-0.5 p-0.5"
              style={{
                background: "rgba(255,255,255,0.05)",
                borderRadius: "5px",
              }}
            >
              {(["active", "completed"] as const).map((view) => {
                const active = todoView === view;
                return (
                  <button
                    key={view}
                    type="button"
                    onClick={() => setTodoView(view)}
                    className="flex-1 px-1.5 py-0 text-[9px] transition-colors"
                    style={{
                      color: active
                        ? "var(--ln-theme-text)"
                        : "var(--ln-theme-text-secondary)",
                      fontWeight: active ? 700 : 400,
                      background: active
                        ? "var(--ln-theme-surface-active)"
                        : "transparent",
                      borderRadius: "4px",
                    }}
                  >
                    {t(locale, view === "active" ? "viewActive" : "viewCompleted")}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 排序模式提示条：提示可拖动 + 「完成」退出（iOS 排序那套交互） */}
          {sorting ? (
            <div
              className="flex shrink-0 items-center justify-between px-3 py-1"
              style={{
                background: "var(--ln-theme-surface-active)",
                borderBottom: "1px solid var(--ln-theme-border)",
              }}
            >
              <span className="text-xs" style={{ color: "var(--ln-theme-text-secondary)" }}>
                {t(locale, "sortHint")}
              </span>
              <button
                type="button"
                onClick={handleEndSort}
                className="rounded-md px-2 py-0.5 text-xs font-medium transition"
                style={{ background: "var(--ln-theme-surface)", color: "var(--ln-theme-text)" }}
              >
                {t(locale, "sortDone")}
              </button>
            </div>
          ) : null}

          <TodoList
            locale={locale}
            todos={filteredTodos}
            todoView={todoView}
            sorting={sorting}
            selectedId={selectedId}
            editingId={editingId}
            emptyHint={
              selectedDate !== null
                ? locale === "zh-CN"
                  ? "该日期暂无待办"
                  : "No tasks for this day"
                : t(locale, "emptyHint")
            }
            onSelect={handleSelect}
            onStartEdit={handleStartEdit}
            onStartSort={handleStartSort}
            onContextMenu={handleContextMenu}
            onChangeText={updateTodoText}
            onEndEdit={handleEndEdit}
            onToggleCompleted={toggleCompleted}
          />

          {/* 拖拽预览：显示待办内容 */}
          <DragOverlay dropAnimation={null}>
            {activeDragTodo ? (
              <div className="rounded-lg bg-white/15 backdrop-blur-md px-3 py-2 text-sm text-white shadow-lg ring-1 ring-white/20 max-w-[200px] truncate">
                {activeDragTodo.text || (locale === "zh-CN" ? "（空）" : "(empty)")}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        <FooterBar
          locale={locale}
          clearCompletedDisabled={completedCount === 0}
          onAdd={handleAddWithDate}
          onExport={handleExport}
          onClearClick={() => setConfirmClear(true)}
          opacity={panelOpacity}
        />

        {/* 设置模态框 */}
        <SettingsModal
          open={showSettings}
          locale={locale}
          localeMode={localeMode}
          onSetLocaleMode={setLocaleMode}
          panelOpacity={panelOpacity}
          onPanelOpacityChange={setPanelOpacity}
          clockCollapsed={clockCollapsed}
          onSetClockCollapsed={setClockCollapsed}
          weekCalendarCollapsed={weekCalendarCollapsed}
          onSetWeekCalendarCollapsed={setWeekCalendarCollapsed}
          autoStart={autoStart}
          onSetAutoStart={setAutoStart}
          edgeHide={edgeHide}
          onSetEdgeHide={setEdgeHide}
          theme={theme}
          onSetTheme={setTheme}
          reminderMode={reminderMode}
          onSetReminderMode={setReminderMode}
          contentFontSize={contentFontSize}
          onSetContentFontSize={setContentFontSize}
          contentFontFamily={contentFontFamily}
          onSetContentFontFamily={setContentFontFamily}
          onClose={() => setShowSettings(false)}
        />
        </div>
        </div>
      )}

      {!focusMode && menu && menuTodo ? (
        <TodoContextMenu
          locale={locale}
          x={menu.x}
          y={menu.y}
          completed={menuTodo.completed}
          pinned={menuTodo.pinned}
          dueDate={menuTodo.dueDate}
          isRecurring={menuTodo.isRecurring}
          onClose={handleCloseMenu}
          onPin={menuActions.onPin}
          onStartSort={handleStartSort}
          onDelete={menuActions.onDelete}
          onToggleDone={menuActions.onToggleDone}
          onPickColor={(c: TodoColorId) => menuActions.onPickColor(c)}
          onOpenCustomDueDate={menuActions.onOpenCustomDueDate}
          onClearDueDate={menuActions.onClearDueDate}
          onSetRecurrence={menuActions.onSetRecurrence}
          onClearRecurrence={menuActions.onClearRecurrence}
          onCopyTo={menuActions.onCopyTo}
        />
      ) : null}

      {/*
        专注模式的右键菜单（HTML 自绘）。
        放在这一层而不是 !focusMode 那个分支里，因为它**只在专注模式**出现。
      */}
      {focusMenu ? (
        <FocusContextMenu
          locale={locale}
          x={focusMenu.x}
          y={focusMenu.y}
          onClose={() => setFocusMenu(null)}
          onPick={(id) => {
            if (id === "hide") handleHide();
            else if (id === "full") setFocusMode(false);
            else if (id === "quit") void invoke("quit_app");
          }}
        />
      ) : null}

      {!focusMode ? (
      <>
      <DatePicker
        locale={locale}
        open={dueDatePickerFor !== null}
        title={t(locale, "duePickerTitle")}
        showTime
        onConfirm={handleDueDateConfirm}
        onCancel={handleDueDateCancel}
      />

      <DatePicker
        locale={locale}
        open={copyToPickerFor !== null}
        title={t(locale, "copyToTitle")}
        showTime={false}
        onConfirm={handleCopyToConfirm}
        onCancel={handleCopyToCancel}
      />

      <RecurrencePicker
        locale={locale}
        open={recurrencePicker !== null}
        recurrenceType={recurrencePicker?.type ?? "none"}
        initialConfig={recurrencePicker?.config ?? ""}
        initialDueDate={recurrencePicker?.dueDate ?? 0}
        onConfirm={handleRecurrenceConfirm}
        onCancel={handleRecurrenceCancel}
      />

      <ConfirmDialog
        open={confirmClear}
        title={t(locale, "clearCompleted")}
        message={t(locale, "clearCompletedConfirm")}
        confirmLabel={t(locale, "confirm")}
        cancelLabel={t(locale, "cancel")}
        onCancel={() => setConfirmClear(false)}
        onConfirm={handleClearCompleted}
      />

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title={t(locale, "menuDelete")}
        message={t(locale, "deleteOneConfirm")}
        confirmLabel={t(locale, "confirm")}
        cancelLabel={t(locale, "cancel")}
        onCancel={() => setConfirmDeleteId(null)}
        onConfirm={handleDeleteOne}
      />
      </>
      ) : null}
    </>
  );
}

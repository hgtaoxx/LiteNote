import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { saveSetting } from "@/lib/db";
import {
  computeFocusWindowHeight,
  DEFAULT_FULL_WINDOW_WIDTH,
  lockCurrentWindowSize,
  lockWindowSize,
  readWindowInnerSize,
  setWindowLogicalSize,
  unlockWindowSize,
  isLikelyFullModeSize,
  isOversizedFullSize,
  resolveStoredFullSize,
  type WindowLogicalSize,
} from "@/lib/focusWindowSize";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * 专注 / 完整模式的窗口尺寸与能力。
 *
 * **所有改窗口尺寸/可缩放/尺寸锁定的动作都集中在这一个有序的异步流程里**，
 * 避免「启动修复」和「模式切换」两处各自改窗口而互相打架。
 *
 * 规则：
 *   进入专注（含启动时就已经是专注）→ 记录完整模式尺寸 → 窗口调成正方形
 *   专注 + 穿透 → 锁定当前尺寸、禁止缩放（继承现有大小，不重置尺寸）
 *   专注、无穿透 → 解除锁定、允许缩放
 *   退出专注     → 先解锁 → 恢复完整模式尺寸
 *   启动即完整   → 修正 window-state 可能恢复的专注尺寸 / 异常膨胀尺寸
 *
 * @param sizeLocked 是否锁死尺寸，由 resolveWindowMode 推导（专注 + 鼠标穿透）
 */
export function useFocusWindowSize(
  focusMode: boolean,
  settingsReady: boolean,
  sizeLocked: boolean,
): void {
  const fullWindowWidth = useSettingsStore((s) => s.fullWindowWidth);
  const fullWindowHeight = useSettingsStore((s) => s.fullWindowHeight);
  /** null 表示还没跑过（首次），用于区分「启动」与「模式切换」 */
  const prevFocusMode = useRef<boolean | null>(null);
  const focusWidthRef = useRef(DEFAULT_FULL_WINDOW_WIDTH);
  const fullSizeRef = useRef<WindowLogicalSize>(
    resolveStoredFullSize(fullWindowWidth, fullWindowHeight),
  );
  const didFullRestoreCheck = useRef(false);

  // 同步 DB 中的完整模式尺寸（忽略被误写入的专注尺寸 / 膨胀值）
  useEffect(() => {
    if (!settingsReady) return;
    const resolved = resolveStoredFullSize(fullWindowWidth, fullWindowHeight);
    fullSizeRef.current = resolved;
    if (!focusMode) {
      focusWidthRef.current = resolved.width;
    }

    if (
      resolved.width !== fullWindowWidth ||
      resolved.height !== fullWindowHeight
    ) {
      void saveSetting("fullWindowWidth", resolved.width);
      void saveSetting("fullWindowHeight", resolved.height);
      useSettingsStore.setState({
        fullWindowWidth: resolved.width,
        fullWindowHeight: resolved.height,
      });
    }
  }, [settingsReady, fullWindowWidth, fullWindowHeight, focusMode]);

  useEffect(() => {
    if (!settingsReady) return;

    let cancelled = false;

    const run = async () => {
      const wasFocus = prevFocusMode.current; // 首次运行为 null

      /**
       * 把「形态」记为已施加。
       *
       * ⚠️ 必须放在流程**末尾**、且只在**没被打断**时调用：
       * effect 依赖 [focusMode, settingsReady, sizeLocked]，而「切到专注」会让
       * focusMode 和 sizeLocked **同时变化**，于是 effect 会立刻重跑一轮并把上一轮
       * 标记为 cancelled。如果像以前那样在 run() 开头就写 prevFocusMode，
       * 新一轮就会误判 entering = false —— 于是「记录完整模式尺寸 + 变成正方形」
       * 被整段跳过，还会走 lockCurrentWindowSize() 把窗口锁死在完整模式的矩形上。
       * 表现为：专注 + 穿透 的正方形与尺寸锁定时灵时不灵。
       */
      const commit = () => {
        if (cancelled) return;
        prevFocusMode.current = focusMode;
      };

      if (focusMode) {
        const entering = wasFocus !== true;

        // 进入专注（启动时就已经是专注也算）：记录完整模式尺寸并调成正方形
        if (entering) {
          const current = await readWindowInnerSize();
          if (cancelled) return;

          if (current && isLikelyFullModeSize(current)) {
            fullSizeRef.current = {
              width: current.width,
              height: current.height,
            };
            focusWidthRef.current = current.width;
            await saveSetting("fullWindowWidth", current.width);
            await saveSetting("fullWindowHeight", current.height);
            if (cancelled) return;
            useSettingsStore.setState({
              fullWindowWidth: current.width,
              fullWindowHeight: current.height,
            });
          } else {
            focusWidthRef.current = fullSizeRef.current.width;
          }

          await setWindowLogicalSize({
            width: focusWidthRef.current,
            height: computeFocusWindowHeight(focusWidthRef.current),
          });
          if (cancelled) return;
        }

        // 专注 + 穿透 → 锁死尺寸；专注无穿透 → 解锁、自由缩放
        //
        // ⚠️ 这里刻意**不再调 setWindowResizable**：
        // 它会改 WindowFlags，令 TAO 重套窗口样式并调 SWP_FRAMECHANGED 重算
        // 非客户区，把本来被 WebView 完整盖住的标题栏露出来（用户看到的顶部白条）。
        // 「不可调整大小」现在由 Rust 侧的 WM_NCHITTEST 拦截统一负责。
        if (sizeLocked) {
          if (entering) {
            // 刚进入：直接锁到上面设好的正方形尺寸。
            // 不回读窗口尺寸——setSize 刚发出，窗口管理器可能还没应用，回读会拿到旧尺寸。
            await lockWindowSize({
              width: focusWidthRef.current,
              height: computeFocusWindowHeight(focusWidthRef.current),
            });
          } else {
            // 已经在专注模式里再开启穿透：继承当前尺寸（用户可能刚拉过大小）
            await lockCurrentWindowSize();
          }
        } else {
          await unlockWindowSize();
        }
        // 让 Rust 依据「锁定窗口 / 界面锁定」重新同步命中测试拦截状态
        void invoke("refresh_window_lock").catch(() => {});
        commit();
        return;
      }

      if (wasFocus === true) {
        // 退出专注：解锁尺寸并恢复完整模式尺寸
        await unlockWindowSize();
        await setWindowLogicalSize(fullSizeRef.current);
        void invoke("refresh_window_lock").catch(() => {});
        commit();
        return;
      }

      // 启动即完整模式：修正 window-state 可能恢复的专注尺寸 / 异常膨胀尺寸
      if (wasFocus === null && !didFullRestoreCheck.current) {
        didFullRestoreCheck.current = true;
        const current = await readWindowInnerSize();
        if (!current || cancelled) return;
        const full = fullSizeRef.current;
        if (
          (!isLikelyFullModeSize(current) && full.height > current.height) ||
          isOversizedFullSize(current)
        ) {
          await unlockWindowSize();
          await setWindowLogicalSize(full);
        }
      }
      commit();
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [focusMode, settingsReady, sizeLocked]);
}

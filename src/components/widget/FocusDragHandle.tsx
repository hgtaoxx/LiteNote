interface FocusDragHandleProps {
  /**
   * 是否可拖动窗口。
   *
   * Tauri 的拖拽区域**只认 `data-tauri-drag-region` 属性**，取值语义见
   * `tauri/src/window/scripts/drag.js`：
   *   · 裸值 / "true" → 只有直接点在该元素上才拖
   *   · "deep"        → 子树任意位置都能拖
   *   · "false"       → 显式禁止，**并且阻断祖先的拖拽区域**
   *
   * 注意：`-webkit-app-region: no-drag` 是 **Electron** 的 API，Tauri 完全不认，
   * 以前就是靠它"禁止拖拽"，所以从未生效、专注+穿透时窗口仍能被拖动。
   *
   * 高度由 h-4 固定，因此切换穿透时文字不会上下跳动。
   */
  draggable?: boolean;
  /**
   * 是否处于「界面锁定」（专注 + 穿透）。
   * 锁定的小圆条会变成琥珀色——纯粹是为了让「锁定到底生效没有」一眼可见，
   * 因为这个状态从外观上很难判断（窗口不能拖、不能拉，但看不出来）。
   */
  locked?: boolean;
}

/** 专注模式顶部拖拽条：始终占位，按需决定能否拖动 */
export function FocusDragHandle({
  draggable = true,
  locked = false,
}: FocusDragHandleProps) {
  return (
    <div
      className={
        "flex h-4 shrink-0 items-center justify-center " +
        (draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default")
      }
      data-tauri-drag-region={draggable ? "deep" : "false"}
      aria-hidden
    >
      <span
        className="h-1 w-8 rounded-full transition-colors"
        style={{
          // 锁定时变琥珀色（与顶栏穿透图标的高亮同色）
          background: locked ? "#fbbf24" : "var(--ln-theme-text-muted)",
          opacity: locked ? 0.95 : 0.45,
        }}
      />
    </div>
  );
}

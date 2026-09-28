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
  /** 右键：弹出精简菜单（隐藏界面 / 完整模式 / 退出） */
  onContextMenu?: (e: React.MouseEvent) => void;
}

/** 专注模式顶部拖拽条：始终占位，按需决定能否拖动 */
export function FocusDragHandle({
  draggable = true,
  onContextMenu,
}: FocusDragHandleProps) {
  return (
    <div
      className={
        "flex h-4 shrink-0 items-center justify-center " +
        (draggable ? "cursor-grab active:cursor-grabbing" : "cursor-default")
      }
      data-tauri-drag-region={draggable ? "deep" : "false"}
      onContextMenu={(e) => {
        /*
          左右分区（按用户设计）：
            · 左半区 → 不拦截，交给系统 → 弹出 Windows 系统菜单（还原/移动/大小…）
            · 右半区 → 拦下并 preventDefault → 弹出应用自己的菜单
          注意：紧贴窗口最顶的那几像素属于非客户区（缩放边框），
          Windows 会直接抢走右键，DOM 收不到事件，属于平台限制。
        */
        const rect = e.currentTarget.getBoundingClientRect();
        const onRightHalf = e.clientX - rect.left > rect.width / 2;
        if (!onRightHalf) return;
        e.preventDefault();
        onContextMenu?.(e);
      }}
      aria-hidden
    >
      <span
        className="h-1 w-8 rounded-full"
        style={{ background: "var(--ln-theme-text-muted)", opacity: 0.45 }}
      />
    </div>
  );
}

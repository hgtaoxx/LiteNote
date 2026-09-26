interface FocusDragHandleProps {
  /**
   * 是否可拖动窗口。
   * 鼠标穿透状态下窗口不允许移动 → 传 false：这条占位保留但去掉拖拽区域，
   * 这样高度不变，切换穿透时文字不会上下跳动。
   */
  draggable?: boolean;
}

/** 专注模式顶部拖拽条：始终占位，按需决定能否拖动 */
export function FocusDragHandle({ draggable = true }: FocusDragHandleProps) {
  return (
    <div
      className={
        "flex h-4 shrink-0 items-center justify-center " +
        (draggable
          ? "cursor-grab active:cursor-grabbing"
          : "ln-no-drag-handle cursor-default")
      }
      data-tauri-drag-region
      aria-hidden
    >
      <span
        className="h-1 w-8 rounded-full"
        style={{ background: "var(--ln-theme-text-muted)", opacity: 0.45 }}
      />
    </div>
  );
}

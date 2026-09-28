interface FocusDragHandleProps {
  /**
   * 是否可拖动窗口。
   *
   * ⚠️ 关键：不可拖动时必须**不渲染 `data-tauri-drag-region`**。
   * Tauri 只认这个属性（由它注入的脚本监听 mousedown 后调用 startDragging），
   * 而 `-webkit-app-region: no-drag` 是 **Electron** 的 API，Tauri 完全不理会——
   * 之前就是这样写的，所以「专注 + 穿透」本该锁死却仍然能拖。
   *
   * 高度由 h-4 固定，所以切换穿透时文字不会上下跳动。
   */
  draggable?: boolean;
  /** 右键：弹出与托盘完全一致的菜单 */
  onContextMenu?: () => void;
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
      // 只有可拖动时才挂拖拽区域
      {...(draggable ? { "data-tauri-drag-region": true } : {})}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.();
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

/**
 * 窗口形态推导 —— 全应用**唯一**的模式判定来源。
 *
 * 「专注 / 完整模式」和「鼠标穿透」是两个独立的持久化开关，
 * 交叉后只有四种状态，其中两种是特殊形态：
 *
 * | 模式 | 穿透设置 | 实际形态           | 真穿透 | 可移动 | 可缩放 | 可滚动 | 可勾选完成 |
 * |------|----------|--------------------|--------|--------|--------|--------|------------|
 * | 完整 | 关       | 普通完整窗口       | ✗      | ✓      | ✓      | ✓      | ✓          |
 * | 完整 | 开       | **真穿透**         | ✓      | —      | —      | —      | —          |
 * | 专注 | 关       | 普通专注窗口       | ✗      | ✓      | ✓      | ✓      | ✓          |
 * | 专注 | 开       | **专注受限**       | ✗      | ✗      | ✗      | ✓      | ✓          |
 *
 * 关键约定：
 *   · 真穿透只在「完整模式 + 穿透开启」时生效——专注模式下要保留滚动与勾选，
 *     所以穿透降级为"受限模式"标记，设置值和托盘勾选都不变。
 *   · 专注模式下始终是正方形窗口（宽 = 高），由 focusWindowSize 负责。
 */
export interface WindowMode {
  /** 是否处于专注模式 */
  isFocus: boolean;
  /** 真正的 OS 级鼠标穿透（界面完全不可操作）：仅「完整模式 + 穿透开启」 */
  realPassthrough: boolean;
  /** 锁死窗口尺寸并禁止缩放：仅「专注模式 + 穿透开启」 */
  sizeLocked: boolean;
  /** 能否通过顶部拖拽条移动窗口 */
  movable: boolean;
  /** 是否禁止文字选中 */
  noSelect: boolean;
}

export function resolveWindowMode(
  focusMode: boolean,
  mousePassthrough: boolean,
): WindowMode {
  const locked = focusMode && mousePassthrough;
  return {
    isFocus: focusMode,
    realPassthrough: mousePassthrough && !focusMode,
    sizeLocked: locked,
    movable: !locked,
    noSelect: locked,
  };
}

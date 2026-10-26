/**
 * 窗口形态推导 —— 全应用**唯一**的模式判定来源。
 *
 * 「专注 / 完整模式」和「锁定窗口」是两个独立的持久化开关，交叉后只有四种状态：
 *
 * | 模式 | 锁定 | 实际形态       | 可移动 | 可缩放 | 可滚动 | 可勾选完成 | 可选中文字 |
 * |------|------|----------------|--------|--------|--------|------------|-------------|
 * | 完整 | 关   | 普通完整窗口   | ✓      | ✓      | ✓      | ✓          | ✓           |
 * | 完整 | 开   | 锁定完整窗口   | ✗      | ✗      | ✓      | ✓          | ✓           |
 * | 专注 | 关   | 普通专注窗口   | ✓      | ✓      | ✓      | ✓          | ✓           |
 * | 专注 | 开   | **专注受限**   | ✗      | ✗      | ✓      | ✓          | ✗           |
 *
 * 关键约定：
 *   · 锁定 = 不能移动、不能改尺寸，界面一切照常（能点、能改、能滚动）。
 *   · 「专注 + 锁定」额外锁死当前正方形尺寸并禁止文字选中，
 *     原来由「鼠标穿透」承担的这一档已并入锁定开关。
 *   · 专注模式下始终是正方形窗口（宽 = 高），由 focusWindowSize 负责。
 */
export interface WindowMode {
  /** 是否处于专注模式 */
  isFocus: boolean;
  /** 锁死窗口尺寸并禁止缩放：仅「专注模式 + 锁定」 */
  sizeLocked: boolean;
  /** 能否通过顶部拖拽条移动窗口 */
  movable: boolean;
  /** 是否禁止文字选中 */
  noSelect: boolean;
}

export function resolveWindowMode(
  focusMode: boolean,
  windowLocked: boolean,
): WindowMode {
  const locked = focusMode && windowLocked;
  return {
    isFocus: focusMode,
    sizeLocked: locked,
    movable: !locked,
    noSelect: locked,
  };
}

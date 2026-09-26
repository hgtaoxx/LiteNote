import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 专注模式窗口尺寸 —— 宽度与完整模式一致，高度 = 宽度（**正方形**）。
 * 不再按内容测量、按行高累加，也不随鼠标穿透状态变化。
 */
export const FOCUS_HEIGHT_RATIO = 1;

export function computeFocusWindowHeight(width: number): number {
  return Math.round(width * FOCUS_HEIGHT_RATIO);
}

export const DEFAULT_FULL_WINDOW_WIDTH = 360;
export const DEFAULT_FULL_WINDOW_HEIGHT = 620;

/** 完整模式合理上限（用于修复 Retina 下误存物理像素导致的膨胀） */
export const FULL_SIZE_MAX_WIDTH = DEFAULT_FULL_WINDOW_WIDTH * 2;
export const FULL_SIZE_MAX_HEIGHT = DEFAULT_FULL_WINDOW_HEIGHT * 2;

export type WindowLogicalSize = { width: number; height: number };

/**
 * 是否像「完整模式」尺寸：完整模式高度不会恰好等于专注模式的正方形高度。
 * 专注模式高度只由宽度推导（高度 = 宽度），因此可以直接排除。
 *
 * 已知副作用（可接受）：若用户把完整模式窗口手动拉成接近正方形，
 * 会被误判为专注模式尺寸，下次启动回落到默认尺寸。容差 24px，命中范围很窄。
 */
export function isLikelyFullModeSize(size: WindowLogicalSize): boolean {
  return Math.abs(size.height - computeFocusWindowHeight(size.width)) > 24;
}

/** 从 settings 解析完整模式尺寸，过滤专注模式尺寸与异常膨胀值 */
export function resolveStoredFullSize(
  width: number | undefined,
  height: number | undefined,
): WindowLogicalSize {
  const full = {
    width: width ?? DEFAULT_FULL_WINDOW_WIDTH,
    height: height ?? DEFAULT_FULL_WINDOW_HEIGHT,
  };
  if (!isLikelyFullModeSize(full)) {
    return {
      width: DEFAULT_FULL_WINDOW_WIDTH,
      height: DEFAULT_FULL_WINDOW_HEIGHT,
    };
  }
  if (full.width > FULL_SIZE_MAX_WIDTH || full.height > FULL_SIZE_MAX_HEIGHT) {
    return {
      width: DEFAULT_FULL_WINDOW_WIDTH,
      height: DEFAULT_FULL_WINDOW_HEIGHT,
    };
  }
  return full;
}

export function isOversizedFullSize(size: WindowLogicalSize): boolean {
  return (
    isLikelyFullModeSize(size) &&
    (size.width > FULL_SIZE_MAX_WIDTH || size.height > FULL_SIZE_MAX_HEIGHT)
  );
}

export async function readWindowInnerSize(): Promise<WindowLogicalSize | null> {
  try {
    const window = getCurrentWindow();
    const [physical, scaleFactor] = await Promise.all([
      window.innerSize(),
      window.scaleFactor(),
    ]);
    const logical = physical.toLogical(scaleFactor);
    return { width: logical.width, height: logical.height };
  } catch {
    return null;
  }
}

export async function setWindowLogicalSize(size: WindowLogicalSize): Promise<void> {
  try {
    await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
  } catch {
    /* 浏览器预览 */
  }
}

/** 设置窗口是否可手动缩放（专注模式锁死宽高比用） */
export async function setWindowResizable(resizable: boolean): Promise<void> {
  try {
    await getCurrentWindow().setResizable(resizable);
  } catch (e) {
    console.warn("[LiteNote] 设置窗口可缩放失败:", e);
  }
}

/**
 * 锁死窗口尺寸：把最小 / 最大尺寸都设成同一个值。
 * 只靠 setResizable(false) 对无边框透明窗口不一定能挡住拖边调整，min = max 才锁得住。
 */
export async function lockWindowSize(size: WindowLogicalSize): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.setMinSize(new LogicalSize(size.width, size.height));
    await win.setMaxSize(new LogicalSize(size.width, size.height));
  } catch (e) {
    console.warn("[LiteNote] 锁定窗口尺寸失败:", e);
  }
}

/**
 * 锁死「当前」窗口尺寸（先读取再锁定）。
 * 用于专注模式 + 鼠标穿透：继承进入该状态时的尺寸，之后不能拉伸。
 */
export async function lockCurrentWindowSize(): Promise<void> {
  const size = await readWindowInnerSize();
  if (!size) return;
  await lockWindowSize({
    width: Math.round(size.width),
    height: Math.round(size.height),
  });
}

/** 解除尺寸锁定；恢复完整模式尺寸前必须先调用，否则会被上一步的 min/max 卡住 */
export async function unlockWindowSize(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.setMaxSize(null);
    await win.setMinSize(null);
  } catch (e) {
    console.warn("[LiteNote] 解除窗口尺寸锁定失败:", e);
  }
}

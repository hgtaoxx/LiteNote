/**
 * 内容（待办正文）可选字体。
 *
 * 只影响待办正文；界面其余部分（顶栏、时钟区、底部栏、设置面板）统一使用
 * --ln-font-stack，**不提供字体 / 字号调整**。
 *
 * 字体栈按「macOS 优先、Windows 兜底、最后通用族」排列，缺失时逐级回退。
 */
export type ContentFontId = "system" | "hei" | "song" | "kai" | "mono";

export const CONTENT_FONT_STACKS: Record<ContentFontId, string> = {
  /** 跟随界面默认无衬线（苹方 / 微软雅黑 / Segoe UI） */
  system:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  /** 黑体：无衬线，字面更硬朗 */
  hei: '"PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Heiti SC", "SimHei", sans-serif',
  /** 宋体：衬线，长文本更耐读 */
  song: '"Songti SC", SimSun, STSong, "Noto Serif SC", "Source Han Serif SC", serif',
  /** 楷体：手写感 */
  kai: '"Kaiti SC", KaiTi, STKaiti, "Noto Serif SC", serif',
  /** 等宽：数字与标点对齐工整 */
  mono: 'ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace',
};

/** 设置面板下拉里的排列顺序 */
export const CONTENT_FONT_IDS: readonly ContentFontId[] = [
  "system",
  "hei",
  "song",
  "kai",
  "mono",
];

/** 把设置值解析成可直接用作 CSS font-family 的字体栈；未知值回退到界面默认 */
export function resolveContentFontStack(id: string | undefined): string {
  const key = (id ?? "system") as ContentFontId;
  return CONTENT_FONT_STACKS[key] ?? CONTENT_FONT_STACKS.system;
}

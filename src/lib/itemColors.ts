import type { CSSProperties } from "react";
import type { TodoColorId } from "@/types/todo";

/**
 * 列表左侧圆点的样式。
 *
 * 用完整的 CSSProperties（而不是只给 background）是因为 hollow 这一档
 * 需要的是「不填充 + 一圈内描边」，光靠 background 表达不出来。
 *
 * hollow：空心圆，未标记重要程度 —— 只描边，不填充。
 */
export const COLOR_DOT_STYLE: Record<TodoColorId, CSSProperties> = {
  hollow: {
    background: "transparent",
    boxShadow: "inset 0 0 0 1.5px var(--ln-todo-p-hollow)",
  },
  none: { background: "var(--ln-todo-p-none)" },
  attention: { background: "var(--ln-todo-p-attention)" },
  important: { background: "var(--ln-todo-p-important)" },
  urgent: { background: "var(--ln-todo-p-urgent)" },
};

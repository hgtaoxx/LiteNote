export const ALL_CATEGORY_ID = "all";

/** 主动选「无色」：区别于 null（没选过，按顺序自动取空闲色） */
export const NO_CATEGORY_COLOR = "none";

/** 标签可选的标准色，互斥使用（同一色不能同时给两个标签） */
export const CATEGORY_COLORS = [
  "#6ee7b7",
  "#fbbf24",
  "#fdba74",
  "#fb7185",
  "#f9a8d4",
  "#c4b5fd",
  "#a5b4fc",
  "#7dd3fc",
  "#86efac",
  "#5eead4",
];

const ALL_SWATCH = "linear-gradient(135deg, #60a5fa, #34d399 55%, #fbbf24)";
/** 「无色」和未分类共用的底：半透明灰，文字用主题色 */
export const NO_CATEGORY_SWATCH = "rgba(148,163,184,0.28)";

export interface RailItem {
  id: string;
  name: string;
  count: number;
  kind: "all" | "custom" | "system";
  color: string | null;
}

/** 没存过色的标签按显示顺序补第一个空闲色，保证同一屏里不重色 */
export function customSwatches(
  list: Array<{ id: string; color: string | null }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const item of list) {
    if (item.color && item.color !== NO_CATEGORY_COLOR) used.add(item.color);
  }
  let cursor = 0;
  for (const item of list) {
    if (item.color && item.color !== NO_CATEGORY_COLOR) {
      map[item.id] = item.color;
      continue;
    }
    if (item.color === NO_CATEGORY_COLOR) {
      map[item.id] = NO_CATEGORY_SWATCH;
      continue;
    }
    while (cursor < CATEGORY_COLORS.length && used.has(CATEGORY_COLORS[cursor])) cursor += 1;
    if (cursor < CATEGORY_COLORS.length) {
      used.add(CATEGORY_COLORS[cursor]);
      map[item.id] = CATEGORY_COLORS[cursor];
      cursor += 1;
    } else {
      map[item.id] = NO_CATEGORY_SWATCH;
    }
  }
  return map;
}

export function swatchColors(items: RailItem[]): Record<string, string> {
  const custom = customSwatches(items.filter((x) => x.kind === "custom"));
  const map: Record<string, string> = {};
  for (const item of items) {
    map[item.id] =
      item.kind === "all" ? ALL_SWATCH : item.kind === "system" ? NO_CATEGORY_SWATCH : custom[item.id];
  }
  return map;
}

/** 新建标签该拿哪个色：第一个没人占的标准色，全占了就落到「无色」 */
export function freeColorFor(list: Array<{ id: string; color: string | null }>): string {
  const used = new Set(Object.values(customSwatches(list)));
  return CATEGORY_COLORS.find((c) => !used.has(c)) ?? NO_CATEGORY_COLOR;
}

/** 实色底上用深墨，半透明底（未分类 / 无色）上用主题文字色 */
export function swatchInk(bg: string | undefined): string {
  return bg && bg.startsWith("#") ? "#10202f" : "var(--ln-theme-text)";
}

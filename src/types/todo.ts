/**
 * 重要程度色 id，数组顺序即「由低到高」。
 * hollow = 空心圆（只描边、不填充），是新增的最低一档：「还没定重要程度」。
 */
export const TODO_COLOR_IDS = [
  "hollow",
  "none",
  "attention",
  "important",
  "urgent",
] as const;

export type TodoColorId = (typeof TODO_COLOR_IDS)[number];

export const RECURRENCE_TYPES = ["none", "daily", "weekly", "monthly"] as const;
export type RecurrenceType = (typeof RECURRENCE_TYPES)[number];

/** 循环规则配置 */
export interface RecurrenceConfig {
  /** 间隔数，如 2 表示每 2 天/周/月 */
  interval: number;
  /** 每周：指定星期几，0=周日 1=周一 ... 6=周六 */
  days?: number[];
  /** 每月：指定几号（1-31） */
  dayOfMonth?: number;
}

export interface TodoItem {
  id: string;
  text: string;
  colorId: TodoColorId;
  pinned: boolean;
  completed: boolean;
  /** 完成时间戳（毫秒），0 表示未完成或无完成时间 */
  completedTime: number;
  sortOrder: number;
  createTime: number;
  updateTime: number;
  /** 截止时间戳（毫秒），0 表示无截止 */
  dueDate: number;
  /** 是否已触发过提醒 */
  reminded: boolean;
  /** 是否为循环待办 */
  isRecurring: boolean;
  /** 循环类型 */
  recurrenceType: RecurrenceType;
  /** 循环规则 JSON 配置 */
  recurrenceConfig: string;
}

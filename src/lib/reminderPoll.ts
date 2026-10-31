import { getDb } from "@/lib/db";
import { computeNextDueDate } from "@/lib/recurrence";
import type { RecurrenceType } from "@/types/todo";

/**
 * 循环待办自动推进的前端兜底。
 *
 * 注意：核心提醒逻辑（开弹窗 / 系统通知）已下沉到 Rust 后台轮询
 * （src-tauri/src/lib.rs::check_and_notify），保证 macOS 窗口隐藏时也能
 * 准时触发。本文件仅保留循环推进 + 循环触发后再 reset reminded 的兜底。
 */
let _polling = false;

const RECURRING_POLL_MS = 60_000;

export function startReminderPoll(): void {
  if (_polling) return;
  _polling = true;

  let intervalId: ReturnType<typeof setInterval> | null = null;

  const tick = async () => {
    try {
      const db = await getDb();
      const now = Date.now();

      const overdueRecurring = await db.select<
        Array<{
          id: string;
          due_date: number;
          recurrence_type: string;
          recurrence_config: string;
        }>
      >(
        "SELECT id, due_date, recurrence_type, recurrence_config FROM todos WHERE deleted = 0 AND is_recurring = 1 AND due_date > 0 AND due_date < $1",
        [now],
      );

      for (const row of overdueRecurring) {
        const nextDue = computeNextDueDate(
          now,
          row.recurrence_type as RecurrenceType,
          row.recurrence_config,
          row.due_date,
        );

        if (nextDue > 0) {
          await db.execute(
            "UPDATE todos SET due_date = $2, reminded = 0, update_time = $3 WHERE id = $1",
            [row.id, nextDue, now],
          );
          console.log(
            `[LiteNote] 循环待办 ${row.id} 自动推进到 ${new Date(nextDue).toLocaleString()}`,
          );
        }
      }
    } catch {
      // 静默
    }
  };

  // 首次 5s 延迟跑一次（让主窗口渲染完成），之后每分钟
  setTimeout(tick, 5_000);
  intervalId = setInterval(tick, RECURRING_POLL_MS);

  // 卸载清理
  window.addEventListener("beforeunload", () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    _polling = false;
  });
}

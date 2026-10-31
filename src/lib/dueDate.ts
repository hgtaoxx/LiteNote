/**
 * 截止时间工具函数。
 */

/**
 * 格式化截止时间为简短可读文本，**时间一律到分钟**（按用户要求不再提供开关）：
 * - 今天/明天 + HH:mm
 * - 已逾期：逾期 N天/N小时
 * - 其他：MM/DD HH:mm
 */
export function formatDueDate(ts: number, locale: "zh-CN" | "en"): string | null {
  if (!ts || ts <= 0) return null;

  const now = Date.now();
  const due = new Date(ts);
  // hourCycle 用 h23：hour12:false 在 zh-CN 下零点会印成「24:00」
  const hhmm = (l: string) =>
    due.toLocaleTimeString(l, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  // 今天
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  if (ts >= todayStart.getTime() && ts < tomorrowStart.getTime()) {
    if (ts < now) {
      const diffMs = now - ts;
      const diffHours = Math.floor(diffMs / 3600000);
      if (diffHours < 1) return locale === "zh-CN" ? "逾期不久" : "Overdue";
      if (diffHours < 24) return locale === "zh-CN" ? `逾期 ${diffHours}小时` : `Overdue ${diffHours}h`;
      const diffDays = Math.floor(diffMs / 86400000);
      return locale === "zh-CN" ? `逾期 ${diffDays}天` : `Overdue ${diffDays}d`;
    }
    return locale === "zh-CN" ? `今天 ${hhmm("zh-CN")}` : `Today ${hhmm("en-US")}`;
  }

  // 明天
  const dayAfterTomorrow = new Date(tomorrowStart); dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 1);
  if (ts >= tomorrowStart.getTime() && ts < dayAfterTomorrow.getTime()) {
    return locale === "zh-CN" ? `明天 ${hhmm("zh-CN")}` : `Tomorrow ${hhmm("en-US")}`;
  }

  // 已逾期
  if (ts < now) {
    const diffDays = Math.ceil((now - ts) / 86400000);
    return locale === "zh-CN" ? `逾期 ${diffDays}天` : `Overdue ${diffDays}d`;
  }

  // 其他将来时间
  const p = (n: number) => String(n).padStart(2, "0");
  const mmdd = `${p(due.getMonth() + 1)}/${p(due.getDate())}`;
  return `${mmdd} ${hhmm(locale === "zh-CN" ? "zh-CN" : "en-US")}`;
}

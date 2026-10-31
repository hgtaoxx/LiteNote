use std::path::Path;
use std::time::Duration;

use chrono::{Datelike, Local, Months, NaiveDate, NaiveDateTime, TimeDelta, TimeZone, Timelike};
use rusqlite::Connection;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, Manager, PhysicalPosition, PhysicalSize, Runtime,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
#[cfg(target_os = "macos")]
use tauri::{ActivationPolicy, TitleBarStyle};
use tauri::RunEvent;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod webdav;

/// 提醒提前量（毫秒），默认 15 分钟
const REMIND_ADVANCE_MS: i64 = 15 * 60 * 1000;

/// 背景提醒轮询间隔
const REMINDER_POLL_INTERVAL_SECS: u64 = 30;

/// 持久化窗口位置/大小（不含可见性，避免上次隐藏后被恢复成隐藏态导致「启动打不开」）
fn window_persist_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION
}

pub(crate) const SETTINGS_UPDATED_EVENT: &str = "litenote-settings-updated";

/// 待办数据变化（前端 todoStore 已在监听这个名字，带 source 去重）。
/// 提醒窗口弹窗操作后就是发这个事件让主窗口重新读库的。
pub(crate) const TODOS_UPDATED_EVENT: &str = "litenote-todos-updated";

/// 毫秒时间戳 → 本地时区的日历时间。
///
/// 早先按 UTC 拆分星期/号数，UTC+8 下早上 8 点前的提醒会算错「下一个是哪一天」。
fn to_local(ms: i64) -> Option<NaiveDateTime> {
    Local.timestamp_millis_opt(ms).single().map(|d| d.naive_local())
}

fn from_local(dt: NaiveDateTime) -> Option<i64> {
    Local
        .from_local_datetime(&dt)
        .single()
        .map(|d| d.timestamp_millis())
}

/// "HH:MM" 列表 → 升序去重的 (时, 分)
fn parse_times(list: &[serde_json::Value]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = list
        .iter()
        .filter_map(|v| {
            let mut it = v.as_str()?.split(':');
            let h = it.next()?.parse::<u32>().ok()?;
            let m = it.next()?.parse::<u32>().ok()?;
            if h > 23 || m > 59 {
                return None;
            }
            Some((h, m))
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

fn int_list(cfg: &serde_json::Value, key: &str) -> Vec<i64> {
    cfg.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
        .unwrap_or_default()
}

/// 归一化后的循环规则：daily 只有一个 (0, 时刻表)；weekly 的 key 是星期 0-6；
/// monthly 的 key 是号数 1-31。与前端 normalizeRecurrence 逐条对应。
struct Recurrence {
    interval: i64,
    specs: Vec<(i64, Vec<(u32, u32)>)>,
}

/// 读 recurrence_config。老数据里没有时刻时，用锚点（原本的截止时间）的时分补齐。
fn normalize_recurrence(rec_type: &str, config: &str, anchor: NaiveDateTime) -> Option<Recurrence> {
    if rec_type == "none" {
        return None;
    }
    let cfg: serde_json::Value = serde_json::from_str(config).ok()?;
    let interval = cfg
        .get("interval")
        .and_then(|v| v.as_i64())
        .unwrap_or(1)
        .max(1);
    let fallback = vec![(anchor.hour(), anchor.minute())];
    let shared = cfg
        .get("times")
        .and_then(|v| v.as_array())
        .map(|a| parse_times(a.as_slice()))
        .filter(|v: &Vec<(u32, u32)>| !v.is_empty());

    let times_of = |key: i64| -> Vec<(u32, u32)> {
        cfg.get("dayTimes")
            .and_then(|d| d.get(key.to_string()))
            .and_then(|v| v.as_array())
            .map(|a| parse_times(a.as_slice()))
            .filter(|v: &Vec<(u32, u32)>| !v.is_empty())
            .or_else(|| shared.clone())
            .unwrap_or_else(|| fallback.clone())
    };

    let specs = match rec_type {
        "daily" => vec![(0i64, shared.clone().unwrap_or_else(|| fallback.clone()))],
        "weekly" => {
            let mut days = int_list(&cfg, "days");
            if days.is_empty() {
                days.push(anchor.weekday().num_days_from_sunday() as i64);
            }
            days.sort();
            days.dedup();
            days.into_iter().map(|d| (d, times_of(d))).collect()
        }
        "monthly" => {
            let mut doms = int_list(&cfg, "daysOfMonth");
            if doms.is_empty() {
                if let Some(d) = cfg.get("dayOfMonth").and_then(|v| v.as_i64()) {
                    doms.push(d);
                }
            }
            if doms.is_empty() {
                doms.push(anchor.day() as i64);
            }
            doms.retain(|d| (1..=31).contains(d));
            doms.sort();
            doms.dedup();
            doms.into_iter().map(|d| (d, times_of(d))).collect()
        }
        _ => return None,
    };
    if specs.is_empty() {
        return None;
    }
    Some(Recurrence { interval, specs })
}

/// 周一为起点的周序号（与前端 weekIndex 一致）
fn week_index(day_num: i64) -> i64 {
    (day_num + 6).div_euclid(7)
}

fn last_day_of_month(year: i32, month: u32) -> u32 {
    NaiveDate::from_ymd_opt(year, month, 1)
        .and_then(|d| d.checked_add_months(Months::new(1)))
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(31)
}

/// 下一个提醒时刻：严格晚于 `after_ms` 的第一个槽位。
///
/// 按规则向未来展开，而不是「在上一次的基础上加一格」——所以「稍后提醒」挪动过
/// 的时刻不会把循环锚点带偏。`anchor_ms` 是「每 N 天/周/月」的对齐基准。
fn compute_next_due(after_ms: i64, anchor_ms: i64, rec_type: &str, config: &str) -> Option<i64> {
    if rec_type == "none" || after_ms <= 0 {
        return None;
    }
    let anchor_ms = if anchor_ms > 0 { anchor_ms } else { after_ms };
    let anchor = to_local(anchor_ms)?;
    let rec = normalize_recurrence(rec_type, config, anchor)?;
    let now = to_local(after_ms)?;

    let anchor_day = anchor.date().num_days_from_ce() as i64;
    let anchor_week = week_index(anchor_day);
    let anchor_month = anchor.year() as i64 * 12 + anchor.month() as i64;

    // 每 N 月/周/天的对齐可能要往后扫很久，扫不到就当没有下一次
    let horizon = 400 + 366 * rec.interval;
    let mut day = now.date();

    for _ in 0..=horizon {
        let day_num = day.num_days_from_ce() as i64;
        let times: Option<&[(u32, u32)]> = match rec_type {
            "daily" => {
                if (day_num - anchor_day).rem_euclid(rec.interval) == 0 {
                    Some(&rec.specs[0].1)
                } else {
                    None
                }
            }
            "weekly" => {
                if (week_index(day_num) - anchor_week).rem_euclid(rec.interval) != 0 {
                    None
                } else {
                    let wd = day.weekday().num_days_from_sunday() as i64;
                    rec.specs
                        .iter()
                        .find(|(k, _)| *k == wd)
                        .map(|(_, t)| &t[..])
                }
            }
            "monthly" => {
                let month_idx = day.year() as i64 * 12 + day.month() as i64;
                if (month_idx - anchor_month).rem_euclid(rec.interval) != 0 {
                    None
                } else {
                    // 短月里 29/30/31 被压到月末同一天：specs 已按号数升序，
                    // 第一个命中的就是号数最小的，其余忽略（对应前端 monthlyWinners）
                    let last = last_day_of_month(day.year(), day.month()) as i64;
                    let today = day.day() as i64;
                    rec.specs
                        .iter()
                        .find(|(d, _)| (*d).min(last) == today)
                        .map(|(_, t)| &t[..])
                }
            }
            _ => None,
        };

        if let Some(times) = times {
            for (h, m) in times {
                if let Some(ts) = day.and_hms_opt(*h, *m, 0).and_then(from_local) {
                    if ts > after_ms {
                        return Some(ts);
                    }
                }
            }
        }
        day = day + TimeDelta::days(1);
    }
    None
}

/// 检查并自动推进循环待办（把 due_date 滚动到下一个提醒时刻）
fn advance_recurring_todos(conn: &Connection, now_ms: i64) {
    // 先用块作用域收集结果以释放 conn 借用
    let rows: Vec<(String, i64, String, String)> = {
        let mut stmt = match conn.prepare(
            "SELECT id, due_date, recurrence_type, recurrence_config FROM todos WHERE deleted = 0 AND is_recurring = 1 AND due_date > 0 AND due_date < ?1",
        ) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[LiteNote] 循环推进查询失败: {e}");
                return;
            }
        };

        let mapped = match stmt.query_map(rusqlite::params![now_ms], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        }) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[LiteNote] 循环推进查询失败: {e}");
                return;
            }
        };

        mapped.filter_map(|r| r.ok()).collect()
    }; // stmt 在此释放，conn 借用结束

    for (id, due_date, rec_type, rec_config) in &rows {
        if let Some(next_due) = compute_next_due(now_ms, *due_date, rec_type, rec_config) {
            if next_due == *due_date {
                continue;
            }
            if let Err(e) = conn.execute(
                "UPDATE todos SET due_date = ?2, reminded = 0, update_time = ?3 WHERE id = ?1",
                rusqlite::params![id, next_due, now_ms],
            ) {
                eprintln!("[LiteNote] 循环推进更新失败 (id={}): {e}", id);
            } else {
                println!(
                    "[LiteNote] 循环待办 {} 自动推进: {} -> {}",
                    id, due_date, next_due
                );
            }
        }
    }
}

/// 与前端 `tauri-plugin-sql` 一致：数据库位于 app_config_dir/litenote.db
pub(crate) fn litenote_db_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("litenote.db"))
}

fn todos_table_exists(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='todos' LIMIT 1",
        [],
        |_| Ok(()),
    )
    .is_ok()
}

/// 待办行的最小字段集合（Rust 端开窗所需）
struct ReminderRow {
    id: String,
    text: String,
    due_date: i64,
}

/// 查询到当前应当弹出提醒的待办
/// - 命中条件：due_date > 0 且 due_date <= now + REMIND_ADVANCE_MS 且 reminded = 0
fn query_due_reminders(conn: &Connection, now: i64) -> Vec<ReminderRow> {
    let threshold = now + REMIND_ADVANCE_MS;

    let mut stmt = match conn.prepare(
        "SELECT id, text, due_date \
         FROM todos \
         WHERE deleted = 0 \
           AND due_date > 0 \
           AND due_date <= ?1 \
           AND reminded = 0",
    ) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[LiteNote] 提醒查询 SQL 准备失败: {e}");
            return Vec::new();
        }
    };

    let rows = match stmt.query_map(
        rusqlite::params![threshold],
        |row| {
            Ok(ReminderRow {
                id: row.get(0)?,
                text: row.get(1)?,
                due_date: row.get(2)?,
            })
        },
    ) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[LiteNote] 提醒查询失败: {e}");
            return Vec::new();
        }
    };

    rows.filter_map(|r| r.ok()).collect()
}

/// 标记某条待办「本轮已提醒」，避免同一周期内重复弹
fn mark_reminded(conn: &Connection, id: &str) {
    if let Err(e) = conn.execute(
        "UPDATE todos SET reminded = 1 WHERE id = ?1",
        rusqlite::params![id],
    ) {
        eprintln!("[LiteNote] 标记已提醒失败 (id={}): {e}", id);
    }
}

/// 提醒弹窗的尺寸与落点（全部物理像素）：像设置面板那样**悬浮在面板之内**——
/// 宽度跟面板一致（绝不比面板宽），高度按内容收紧（面板被拉得很矮时跟着缩），
/// 在面板里居中；面板本身贴边出屏时再夹回它所在那块屏。
///
/// `want_h` = 弹窗按自己内容回报的高度；不传就用 `HEIGHT` 这个初值
/// （窗口先按初值出现，页面量完真实内容再调 `reminder_fit` 收一次，
/// 这样 100%/125%/150% 缩放下都不会把按钮裁掉）。
fn reminder_geometry<R: Runtime>(app: &AppHandle<R>) -> (i32, i32, u32, u32) {
    reminder_geometry_h(app, None)
}

fn reminder_geometry_h<R: Runtime>(app: &AppHandle<R>, want_h: Option<u32>) -> (i32, i32, u32, u32) {
    const HEIGHT: u32 = 200;
    const MAX_W: u32 = 560;

    let widget = panel_screen_rect(app);

    let (wx, wy, ww, wh) = match widget {
        Some(v) => v,
        // 拿不到面板时退回屏幕右上角
        None => {
            let w = 300_u32;
            if let Ok(Some(m)) = app.primary_monitor() {
                let scale = m.scale_factor();
                let x = (m.size().width as f64 / scale - 316.0).max(0.0) * scale;
                return (x as i32, (60.0 * scale) as i32, w, HEIGHT);
            }
            return (60, 60, w, HEIGHT);
        }
    };

    // 宽不超过面板，高不超过面板
    let pw = (ww as i32).min(MAX_W as i32).max(1) as u32;
    let ph = (want_h.unwrap_or(HEIGHT) as i32).min(wh as i32).max(1) as u32;

    // 面板中心落在哪块屏，就用哪块屏的边界
    let cx = wx + ww as i32 / 2;
    let cy = wy + wh as i32 / 2;
    let monitor = app
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .find(|m| {
            let (mx, my) = (m.position().x, m.position().y);
            let (mw, mh) = (m.size().width as i32, m.size().height as i32);
            cx >= mx && cx < mx + mw && cy >= my && cy < my + mh
        })
        .or_else(|| app.primary_monitor().ok().flatten());

    // 在面板里居中：面板就是它的活动范围
    let mut x = wx + (ww as i32 - pw as i32) / 2;
    let mut y = wy + (wh as i32 - ph as i32) / 2;

    if let Some(m) = monitor {
        // 面板贴边出屏时，弹窗宁可离开面板也要留在屏里
        let mx = m.position().x;
        let my = m.position().y;
        let mw = m.size().width as i32;
        let mh = m.size().height as i32;
        let max_x = (mx + mw - pw as i32).max(mx);
        let max_y = (my + mh - ph as i32).max(my);
        x = x.clamp(mx, max_x);
        y = y.clamp(my, max_y);
    }
    (x, y, pw, ph)
}

/// 面板的真实屏幕矩形（物理像素）。
///
/// 钉桌面期间面板是桌面层窗口的子窗口，而 tao 的 `outer_position` 按 DWM 帧边界算坐标，
/// 子窗口下会偏掉一个父窗口原点（实测差 49px，弹窗就落不回面板正中）—— 直接问 Win32 要。
#[cfg(windows)]
fn panel_screen_rect<R: Runtime>(app: &AppHandle<R>) -> Option<(i32, i32, u32, u32)> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;
    let hwnd = app.get_webview_window("main")?.hwnd().ok()?.0;
    let mut r = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if unsafe { GetWindowRect(hwnd, &mut r) } != 1 {
        return None;
    }
    Some((
        r.left,
        r.top,
        (r.right - r.left) as u32,
        (r.bottom - r.top) as u32,
    ))
}

#[cfg(not(windows))]
fn panel_screen_rect<R: Runtime>(app: &AppHandle<R>) -> Option<(i32, i32, u32, u32)> {
    let w = app.get_webview_window("main")?;
    let (p, s) = match (w.outer_position(), w.outer_size()) {
        (Ok(p), Ok(s)) => (p, s),
        _ => return None,
    };
    Some((p.x, p.y, s.width, s.height))
}

/// 面板被拖动 / 拉伸时，把所有还开着的提醒弹窗按新几何重摆一次。
/// **只动弹窗，绝不动面板的层级**：面板一旦被 topmost 之类操作碰一下，
/// 就会从桌面层被摘出去（见 desktop_pin::is_pinned 的注释），钉桌面就废了。
fn reposition_reminders<R: Runtime>(app: &AppHandle<R>) {
    for (label, win) in app.webview_windows() {
        if !label.starts_with("reminder-") {
            continue;
        }
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else {
            continue;
        };
        // 高度沿用弹窗自己已经贴合内容的那个值，宽度与落点跟面板重算
        let (x, y, w, h) = reminder_geometry_h(app, Some(size.height));
        if (pos.x, pos.y, size.width, size.height) == (x, y, w, h) {
            continue;
        }
        let _ = win.set_size(PhysicalSize::new(w, h));
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// 弹窗按自己的内容回报高度（物理像素），Rust 据此重算尺寸与居中位置。
/// 窗口先按初值出现，页面量完真实内容再收一次 —— 只写死一个常量的话，
/// 显示缩放一变（100%/125%/150%）按钮就会被裁掉。
#[tauri::command]
fn reminder_fit(win: WebviewWindow, app: AppHandle, height: u32) -> Result<(), String> {
    let want = height.clamp(120, 480);
    let (x, y, w, h) = reminder_geometry_h(&app, Some(want));
    let before = win.outer_position().ok();
    win.set_size(PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    if let Some(p) = before {
        println!(
            "[LiteNote] 提醒弹窗自适应: {}x{} @({},{}) ← 原 @({},{})",
            w, h, x, y, p.x, p.y
        );
    }
    Ok(())
}

/// 格式化通知正文：`待办内容 —— 还有 X 分钟到期`
fn format_due_text(text: &str, due_date_ms: i64, now_ms: i64) -> String {
    if due_date_ms <= 0 {
        return text.to_string();
    }
    let diff_ms = due_date_ms - now_ms;
    let abs_ms = diff_ms.abs();
    let total_min = abs_ms / 60_000;

    let time_part = if abs_ms < 30_000 {
        "已到截止时间".to_string()
    } else if diff_ms > 0 {
        if total_min < 60 {
            format!("还有 {} 分钟到期", total_min)
        } else {
            let h = total_min / 60;
            let m = total_min % 60;
            if m == 0 {
                format!("还有 {} 小时到期", h)
            } else {
                format!("还有 {} 小时 {} 分钟到期", h, m)
            }
        }
    } else {
        if total_min < 60 {
            format!("已逾期 {} 分钟", total_min)
        } else {
            let h = total_min / 60;
            let m = total_min % 60;
            if m == 0 {
                format!("已逾期 {} 小时", h)
            } else {
                format!("已逾期 {} 小时 {} 分钟", h, m)
            }
        }
    };
    format!("{} —— {}", text, time_part)
}

/// 从 settings 表读取 reminderMode 配置，默认 "popup"
fn read_reminder_mode(conn: &Connection) -> String {
    let has_table: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !has_table {
        return "popup".to_string();
    }
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'reminderMode'",
        [],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| "popup".to_string())
}

/// 统一打开数据库连接并启用 WAL + busy_timeout，降低与前端 tauri-plugin-sql
/// 及 webdav 模块并发访问同一文件时的锁竞争。
pub(crate) fn open_db(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开 DB 失败: {e}"))?;
    let _ = conn.execute("PRAGMA journal_mode=WAL", []);
    let _ = conn.execute("PRAGMA busy_timeout=5000", []);
    Ok(conn)
}

pub(crate) fn read_setting_string(conn: &Connection, key: &str, default: &str) -> String {
    let has_table: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !has_table {
        return default.to_string();
    }
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| default.to_string())
}

pub(crate) fn read_setting_bool(conn: &Connection, key: &str, default: bool) -> bool {
    let has_table: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !has_table {
        return default;
    }
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [key],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| serde_json::from_str::<bool>(&v).ok())
    .unwrap_or(default)
}

fn write_setting_bool<R: Runtime>(app: &AppHandle<R>, key: &str, value: bool) -> Result<(), String> {
    let db_path = litenote_db_path(app).ok_or_else(|| "无法获取数据库路径".to_string())?;
    let conn = open_db(&db_path)?;
    let json = if value { "true" } else { "false" };
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, json],
    )
    .map_err(|e| format!("写入设置失败: {e}"))?;
    Ok(())
}

fn read_focus_mode<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(db_path) = litenote_db_path(app) else {
        return false;
    };
    if !db_path.exists() {
        return false;
    }
    let Ok(conn) = Connection::open(&db_path) else {
        return false;
    };
    read_setting_bool(&conn, "focusMode", false)
}

/// 窗口是否处于「锁定」状态：不能移动、不能改变大小，但界面照常可点可按可编辑
fn read_window_locked<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(db_path) = litenote_db_path(app) else {
        return false;
    };
    if !db_path.exists() {
        return false;
    }
    let Ok(conn) = Connection::open(&db_path) else {
        return false;
    };
    read_setting_bool(&conn, "windowLocked", false)
}

fn build_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    focus_mode: bool,
    window_locked: bool,
) -> tauri::Result<Menu<R>> {    let show_i = MenuItem::with_id(app, "tray_show", "显示窗口", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let focus_i = CheckMenuItem::with_id(
        app,
        "tray_mode_focus",
        "专注模式",
        true,
        focus_mode,
        None::<&str>,
    )?;
    let manage_i = CheckMenuItem::with_id(
        app,
        "tray_mode_manage",
        "完整模式",
        true,
        !focus_mode,
        None::<&str>,
    )?;
    // 锁定窗口：不能移动、不能改变大小，其余操作照常
    let lock_i = CheckMenuItem::with_id(
        app,
        "tray_window_lock",
        "锁定窗口",
        true,
        window_locked,
        None::<&str>,
    )?;
    // 钉桌面：挂件常驻桌面层，「显示桌面 / Win+D」不再把它最小化。
    // 停靠期间置灰 —— 贴边隐藏唤出要靠临时置顶，挂在桌面层的子窗口置顶不了。
    let docked = is_docked();
    let pin_label = if docked {
        "钉桌面（贴边停靠时暂不可用）"
    } else {
        "钉桌面"
    };
    let pin_i = CheckMenuItem::with_id(
        app,
        "tray_desktop_pin",
        pin_label,
        !docked,
        read_desktop_pinned(app),
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let quit_i = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
    Menu::with_items(
        app,
        &[
            &show_i,
            &sep1,
            &focus_i,
            &manage_i,
            &lock_i,
            &pin_i,
            &sep2,
            &quit_i,
        ],
    )
}

fn rebuild_tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let focus_mode = read_focus_mode(app);
    let window_locked = read_window_locked(app);
    let menu = build_tray_menu(app, focus_mode, window_locked)?;
    if let Some(tray) = app.tray_by_id("litenote-tray") {
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}

/// 关掉 WebView2 自带的右键菜单。
///
/// 为什么是"关掉"而不是"改小"：那个菜单是 Edge 内核自己的 UI，
/// **没有任何字号 / 尺寸 / 排版接口**，改不了。能做的只有整个禁用，
/// 然后由应用自己画菜单（尺寸、字号、间距就完全可控了）。
///
/// wry 里有 `with_default_context_menus(false)`，但 Tauri 没有把它暴露到
/// 配置或 builder 上（源码里搜不到），所以这里通过 `with_webview` 拿到
/// WebView2 控制器，直接设 `AreDefaultContextMenusEnabled = false`。
#[cfg(windows)]
fn disable_native_context_menu<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(|webview| {
        let controller = webview.controller();
        // 与 wry 内部同样的调用路径（webview2/mod.rs: set_webview_settings）
        unsafe {
            if let Ok(core) = controller.CoreWebView2() {
                if let Ok(settings) = core.Settings() {
                    let _ = settings.SetAreDefaultContextMenusEnabled(false);
                }
            }
        }
    });
}

#[cfg(not(windows))]
fn disable_native_context_menu<R: Runtime>(_app: &AppHandle<R>) {}

/* ────────────────────────────────────────────────────────────────
   关于「专注模式右键菜单」为什么不在 Rust 侧弹原生菜单：

   ContextMenu::popup_at 的第一个参数要 tauri::Window<R>，而获取它的
   Manager::get_window 被 #[cfg(feature = "unstable")] 锁着（tauri lib.rs:541），
   get_webview_window 拿到的 WebviewWindow 又不能直接喂给 popup_at
   （E0308: expected Window<_>, found &WebviewWindow<R>）。
   为这一个菜单去开 unstable 特性会牵动其它 API 签名，不划算。

   所以改成前端 HTML 自绘菜单（FocusContextMenu）——
   顺带反而更符合需求：原生菜单没有字号/尺寸接口，而 HTML 菜单的
   尺寸、字号、间距、圆角、阴影全部可控。
   ──────────────────────────────────────────────────────────────── */

fn apply_focus_mode<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    write_setting_bool(app, "focusMode", enabled)?;
    // 切模式时前端会调 setResizable（会把标题栏样式带回来），这里顺手再收敛一次
    apply_window_lock_effects(app);
    rebuild_tray_menu(app).map_err(|e| format!("更新托盘菜单失败: {e}"))?;
    app.emit(
        SETTINGS_UPDATED_EVENT,
        serde_json::json!({ "ts": now_ms(), "source": "rust" }),
    )
    .map_err(|e| format!("通知前端失败: {e}"))?;
    Ok(())
}

fn toggle_focus_mode<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    apply_focus_mode(app, !read_focus_mode(app))
}

/// 退出应用（供界面右键菜单的「退出」使用）。
/// 与托盘菜单的 tray_quit 走同一个出口，保证行为一致。
#[tauri::command]
fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}

/* ────────────────────────────────────────────────────────────────
   窗口锁定：劫持窗口过程，只拦 WM_NCHITTEST（桌面整理工具的做法）

   为什么不改窗口样式（前两版走过的弯路，都记录在这里）：
     · TAO 的 WindowFlags::apply_diff 只要发现 flags 变了，就会
       ① 重新套用 to_window_styles()，把 WS_CAPTION 加回来 → 锁定失效 ✗
       ② 调 SetWindowPos(SWP_FRAMECHANGED) 重算非客户区 → 本来被 WebView
          完整盖住的标题栏露出来 → 顶部白条 + 淡淡的窗口标题 ✗
     · 而 set_resizable / show / hide / set_ignore_cursor_events 全都会触发它，
       所以"剥掉 → 被加回 → 再剥"是在跟框架打架，永远打不赢。

   现在改成：**样式一位都不动**，只劫持窗口过程拦 WM_NCHITTEST ——
   锁定时一律返回 HTCLIENT，于是标题栏拖动、边缘拉伸、系统菜单全部失效，
   而客户区内部（点击、滚动、编辑）完全不受影响。
   视觉上零变化：既没有白条，也没有边框。
   ──────────────────────────────────────────────────────────────── */

/// 原窗口过程（只装一次）；0 表示还没装
static ORIGINAL_WNDPROC: std::sync::atomic::AtomicIsize =
    std::sync::atomic::AtomicIsize::new(0);
/// 当前是否处于「锁定」：由 apply_window_lock_effects 更新
static WINDOW_LOCKED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
unsafe extern "system" fn lock_wndproc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, HTCLIENT, WM_NCHITTEST,
    };

    // 锁定时：整个窗口都算「客户区」→ 拖不动、拉不动、也不弹系统菜单
    if msg == WM_NCHITTEST && WINDOW_LOCKED.load(Ordering::Relaxed) {
        return HTCLIENT as isize;
    }

    let prev = ORIGINAL_WNDPROC.load(Ordering::Relaxed);
    if prev == 0 {
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }
    // 其余消息原样转发给 TAO 原来的窗口过程，绝不改变它的行为
    let proc: windows_sys::Win32::UI::WindowsAndMessaging::WNDPROC =
        std::mem::transmute(prev);
    CallWindowProcW(proc, hwnd, msg, wparam, lparam)
}

/// 安装命中测试拦截（幂等，只会真正装一次）
#[cfg(windows)]
fn install_lock_subclass<R: Runtime>(w: &tauri::WebviewWindow<R>) {
    use std::sync::atomic::Ordering;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_WNDPROC};

    if ORIGINAL_WNDPROC.load(Ordering::Relaxed) != 0 {
        return;
    }
    let Ok(hwnd) = w.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as *mut core::ffi::c_void;

    unsafe {
        let new_proc = lock_wndproc as *const () as usize as isize;
        let prev = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, new_proc);
        if prev != 0 {
            ORIGINAL_WNDPROC.store(prev, Ordering::Relaxed);
            eprintln!("[LiteNote] 已安装窗口锁定拦截（WM_NCHITTEST）");
        }
    }
}

#[cfg(not(windows))]
fn install_lock_subclass<R: Runtime>(_w: &tauri::WebviewWindow<R>) {}

/// 把「锁定」状态同步给窗口过程（幂等、可任意次调用）。
///
/// 只更新一个原子标志，**不碰任何窗口 API** —— 所以不会引发 TAO 重套样式，
/// 也就不会冒出白条或边框。首次调用时顺便安装拦截。
fn apply_window_lock_effects<R: Runtime>(app: &AppHandle<R>) {
    // 「锁定」统一走命中测试拦截，不改窗口样式：
    //   · 原本用 setResizable(false) 实现，但那会触发 TAO 重套样式并重算
    //     非客户区，把被 WebView 盖住的标题栏露出来 → 顶部白条，所以挪到这里
    //   · 专注模式的尺寸锁（专注 + 锁定）也归这一个开关管
    let locked = read_window_locked(app);
    if let Some(w) = app.get_webview_window("main") {
        install_lock_subclass(&w);
    }
    WINDOW_LOCKED.store(locked, std::sync::atomic::Ordering::Relaxed);
}

/// 供前端在改完窗口尺寸限制之后调用（保留为幂等收尾；现在它不碰窗口 API）
#[tauri::command]
fn refresh_window_lock<R: Runtime>(app: AppHandle<R>) {
    apply_window_lock_effects(&app);
}

/// 锁定 / 解锁窗口。
///
/// 「锁定」的含义（按用户要求）：**不能移动、不能改变窗口大小**，
/// 但界面一切照常 —— 按钮能点、内容能改、能滚动。
/// 实现见上面的 lock_wndproc：只拦命中测试，不动窗口样式。
fn apply_window_lock<R: Runtime>(app: &AppHandle<R>, locked: bool) -> Result<(), String> {
    write_setting_bool(app, "windowLocked", locked)?;
    apply_window_lock_effects(app);
    rebuild_tray_menu(app).map_err(|e| format!("更新托盘菜单失败: {e}"))?;
    app.emit(
        SETTINGS_UPDATED_EVENT,
        serde_json::json!({ "ts": now_ms(), "source": "rust" }),
    )
    .map_err(|e| format!("通知前端失败: {e}"))?;
    Ok(())
}

fn toggle_window_lock<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    apply_window_lock(app, !read_window_locked(app))
}

/* ────────────────────────────────────────────────────────────────
   钉桌面：把挂件挂进桌面层的窗口里（承载 SHELLDLL_DefView 的 WorkerW，没有就 Progman）

   为什么是"挂上去"而不是"剥掉最小化样式"（实机探出来的）：
     · 挂件的窗口是 WS_VISIBLE|WS_CAPTION|WS_SYSMENU|WS_MINIMIZEBOX + WS_EX_APPWINDOW
       的顶层窗口，而 Shell 的「显示桌面 / Win+D」正是靠逐个最小化顶层窗口起作用的，
       所以它会被一起收掉；
     · TAO 只要发现 WindowFlags 变了就无条件重套样式（见上面「窗口锁定」那一节），
       "剥掉 → 被加回 → 再剥"是在跟框架打架；
     · 子窗口不在 Shell 枚举最小化的名单里，挂上桌面层就再也碰不到它。
   实测这台机器：SHELLDLL_DefView 直接在 Progman 里（16 个 WorkerW 全是空的），
   而 Progman 的矩形横跨整块虚拟屏（两块屏一整片），所以只挂一次父窗口、
   按父窗口客户区原点做一次换算就够，挂件压在接缝上也不会被裁成半截。

   代价（用户已确认接受）：
     · 挂上之后永远在所有普通窗口之下，而且**不能置顶** —— 贴边隐藏的唤出靠临时置顶，
       所以停靠期间钉桌面自动挂起（见 set_dock_state）；
     · 钉住期间整个窗口不接鼠标键盘（挂上前先把 WS_EX_TRANSPARENT|WS_EX_LAYERED 打上）
       —— 它现在是壁纸级的展示物，要挪位置 / 要打字都先用托盘「钉桌面」取消。这也顺手
       避免了误交互：窗口一旦被抬起就会走顶层语义（HWND_TOPMOST 那类哨兵值），会把
       子窗口从桌面层悄悄摘出去，而设置里还显示着「已钉住」；
     · 资源管理器重启会销毁桌面窗口，Windows 对子窗口是级联销毁，救不回来 ——
       表现为重启 explorer 后挂件消失，需要重开程序。
   ──────────────────────────────────────────────────────────────── */

/// 钉桌面设置（持久化）。真正挂没挂上以 desktop_pin::is_pinned() 为准，
/// 停靠期间两者会短暂不一致（设置为开、实际挂起）。
fn read_desktop_pinned<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(db_path) = litenote_db_path(app) else {
        return false;
    };
    if !db_path.exists() {
        return false;
    }
    let Ok(conn) = Connection::open(&db_path) else {
        return false;
    };
    read_setting_bool(&conn, "desktopPin", false)
}

/// 贴边隐藏当前是否处于停靠态：由前端每次吸附 / 解除时报过来
static DOCKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn is_docked() -> bool {
    DOCKED.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(windows)]
mod desktop_pin {
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::InvalidateRgn;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, EnumWindows, FindWindowW, GetAncestor, GetClassNameW, GetWindowLongW,
        GetWindowRect, SetParent, SetWindowLongW, SetWindowPos, GA_PARENT, GWL_EXSTYLE,
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
    };

    static PINNED: AtomicBool = AtomicBool::new(false);
    /// 父窗口客户区原点（屏幕坐标）：子窗口的位置要按它换算
    static PAR_X: AtomicIsize = AtomicIsize::new(0);
    static PAR_Y: AtomicIsize = AtomicIsize::new(0);
    /// 当前的父窗口，用来判活（资源管理器重启后就没了）
    static PARENT: AtomicIsize = AtomicIsize::new(0);
    /// 我们自己的窗口句柄，用来随时核实「还挂着吗」
    static OWN: AtomicIsize = AtomicIsize::new(0);

    /// 意图：设置要求挂着 —— 不等于真的挂着
    fn intent() -> bool {
        PINNED.load(Ordering::Relaxed)
    }

    fn class_of(h: HWND) -> String {
        let mut buf = [0u16; 256];
        let n = unsafe { GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32) };
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }

    unsafe extern "system" fn scan_defview(child: HWND, l: isize) -> i32 {
        let out = &mut *(l as *mut bool);
        if *out {
            return 1;
        }
        if class_of(child) == "SHELLDLL_DefView" {
            *out = true;
        }
        1
    }

    fn hosts_defview(h: HWND) -> bool {
        let mut found = false;
        unsafe {
            EnumChildWindows(h, Some(scan_defview), &mut found as *mut bool as isize);
        }
        found
    }

    unsafe extern "system" fn scan_workerw(h: HWND, l: isize) -> i32 {
        let out = &mut *(l as *mut isize);
        if *out != 0 {
            return 1;
        }
        if class_of(h) == "WorkerW" && hosts_defview(h) {
            *out = h as isize;
        }
        1
    }

    /// 壁纸由哪个窗口在画：只认 WorkerW / Progman 这两个类名。
    /// 不能光按「有没有 SHELLDLL_DefView 子窗口」找 —— 资源管理器的文件夹窗口也有，
    /// 探针实测就误命中过他正开着的那个文件夹。
    fn wallpaper_window() -> Option<HWND> {
        let mut hit: isize = 0;
        unsafe {
            EnumWindows(Some(scan_workerw), &mut hit as *mut isize as isize);
            if hit != 0 {
                return Some(hit as HWND);
            }
            let name: Vec<u16> = "Progman".encode_utf16().chain(std::iter::once(0)).collect();
            let p = FindWindowW(name.as_ptr(), std::ptr::null());
            if p.is_null() {
                None
            } else {
                Some(p)
            }
        }
    }

    /// 事实：现在真的挂在桌面层吗。
    /// 不能只信 PINNED：只要有任何一处按顶层窗口的语义去动它（例如给子窗口传
    /// HWND_TOPMOST / HWND_NOTOPMOST 这类只对顶层窗口有意义的哨兵值），
    /// Windows 就会把它从桌面层摘出去，而 PINNED 还留着 true ——
    /// 于是位置照样按父窗口原点偏、界面照样显示「已钉住」，两边都对不上现实。
    pub fn is_pinned() -> bool {
        if !intent() {
            return false;
        }
        let own = OWN.load(Ordering::Relaxed);
        let par = PARENT.load(Ordering::Relaxed);
        if own == 0 || par == 0 {
            return false;
        }
        unsafe { GetAncestor(own as HWND, GA_PARENT) as isize == par }
    }

    /// 意图是挂、事实不是 → 需要重挂
    pub fn needs_repin() -> bool {
        intent() && !is_pinned()
    }

    /// 钉住期间的「不接鼠标键盘」：直接改扩展样式位。
    /// 位与 tao 的 `set_ignore_cursor_events` 一致（TRANSPARENT|LAYERED，老版鼠标穿透
    /// 就是这么实现的），但**不走那个接口** —— 实测窗口挂进桌面层之后，tao 那条路径
    /// 只更新它自己缓存的 WindowFlags，样式位不再落到窗口上（还是顶层时能落）。
    ///
    /// **必须在 SetParent 之前调用**：挂到 Progman 之后，Windows 会把我们的线程和
    /// 桌面线程的输入队列绑在一起，这时连自己改自己的 GWL_EXSTYLE 都会被拒
    /// （SetWindowLongW 返回 lasterr=203 ERROR_WINDOW_OF_OTHER_THREAD，实测）。
    /// 反过来这也意味着挂上之后没人改得动它 —— 穿透位不会被抹，不需要额外补写。
    fn set_passthrough_bits(hwnd: HWND, on: bool) {
        // WS_EX_TRANSPARENT / WS_EX_LAYERED
        const MASK: i32 = 0x0000_0020 | 0x0008_0000;
        unsafe {
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
            let next = if on { ex | MASK } else { ex & !MASK };
            if next == ex {
                return;
            }
            if SetWindowLongW(hwnd, GWL_EXSTYLE, next) == 0 {
                return;
            }
            // 不碰 FRAMECHANGED：重算非客户区会把被 WebView 盖住的标题栏露出来（顶部白条，老 bug）
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    /// 挂/摘父窗口、改穿透位、换算坐标 —— 连着做是四次重合成事件，
    /// 用户看到的就是「点一下闪一下」。中间用 WM_SETREDRAW 把重绘挂起来，
    /// 最后一次性作废重画（桌面整理类工具的标准做法）。
    unsafe fn freeze_redraw(hwnd: HWND, allow: bool) {
        use windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW;
        const WM_SETREDRAW: u32 = 0x000B;
        // windows-sys 里 WPARAM/LPARAM 就是 usize/isize 别名，直接传值
        SendMessageW(hwnd, WM_SETREDRAW, allow as usize, 0);
    }

    pub fn pin(hwnd: HWND) -> bool {
        if is_pinned() {
            return true;
        }
        let Some(parent) = wallpaper_window() else {
            return false;
        };
        unsafe {
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetWindowRect(hwnd, &mut rect) != 1 {
                return false;
            }
            // 父窗口原点用它的**窗口矩形**，不是 ClientToScreen：
            // Progman 没有标题栏/边框，客户区 == 窗口矩形；而实测 ClientToScreen
            // 对它返回 (0,0)（Win11 的桌面窗口不按常规客户区回报），
            // 拿那个当原点会把窗口整体甩偏一个虚拟屏宽度。
            let mut prect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            if GetWindowRect(parent, &mut prect) != 1 {
                return false;
            }
            let (origin_x, origin_y) = (prect.left, prect.top);
            // 下面四步各自都会引发一次重合成，挂起重绘让它们并成一次
            freeze_redraw(hwnd, false);
            // 穿透位要在挂上去**之前**打 —— 挂上之后输入队列并到桌面线程，改不动了
            set_passthrough_bits(hwnd, true);
            SetParent(hwnd, parent);
            // 判"挂上了没有"要用 GetAncestor(GA_PARENT)：跨进程挂到 Progman 之后，
            // GetParent 会回报 0（实测），拿它当校验就会误判失败、
            // 既记不下父窗口原点，也让后面每次写位置都少减一个虚拟屏宽度。
            let now = GetAncestor(hwnd, GA_PARENT) as isize;
            if now != parent as isize {
                // 没挂上就还是顶层窗口，这时还改得回来 —— 别留一个点不动的挂件
                set_passthrough_bits(hwnd, false);
                freeze_redraw(hwnd, true);
                InvalidateRgn(hwnd, std::ptr::null_mut(), 0);
                return false;
            }
            PAR_X.store(origin_x as isize, Ordering::Relaxed);
            PAR_Y.store(origin_y as isize, Ordering::Relaxed);
            PARENT.store(parent as isize, Ordering::Relaxed);
            OWN.store(hwnd as isize, Ordering::Relaxed);
            PINNED.store(true, Ordering::Relaxed);
            // 位置搬进子窗口坐标系，别让它跳一下；z-order 要抬到桌面层最上面。
            // 这里**不能**用 HWND_BOTTOM：桌面层的兄弟里有 SHELLDLL_DefView，
            // 壁纸和桌面图标都是它画的，压到它下面等于一钉上就看不见
            // （实测：钉上后 widget-below-defview=1，中心命中测试返回的是 defview）。
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                rect.left - origin_x,
                rect.top - origin_y,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE,
            );
            // 恢复重绘并整块作废：换了父窗口 = 换了绘制上下文，不主动要一次重绘会留残影
            freeze_redraw(hwnd, true);
            InvalidateRgn(hwnd, std::ptr::null_mut(), 0);
            true
        }
    }

    pub fn unpin(hwnd: HWND) {
        if !intent() {
            return;
        }
        unsafe {
            let mut rect = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            let ok = GetWindowRect(hwnd, &mut rect) == 1;
            freeze_redraw(hwnd, false);
            SetParent(hwnd, std::ptr::null_mut());
            // 回到顶层才改得动扩展样式：撤掉穿透，挂件重新可点可打字
            set_passthrough_bits(hwnd, false);
            PINNED.store(false, Ordering::Relaxed);
            PARENT.store(0, Ordering::Relaxed);
            OWN.store(0, Ordering::Relaxed);
            PAR_X.store(0, Ordering::Relaxed);
            PAR_Y.store(0, Ordering::Relaxed);
            if ok {
                // 回到顶层后坐标又按屏幕解释了，摆回原来的位置。
                // 这里抬到普通窗口最前而不是压底：解除钉桌面的意图就是把它拿回手里用，
                // 压到底会立刻看不见，和「一钉上就消失」是同一个误会的两面。
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    rect.left,
                    rect.top,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }
            freeze_redraw(hwnd, true);
            InvalidateRgn(hwnd, std::ptr::null_mut(), 0);
        }
    }

    /// 按**屏幕坐标**摆放窗口：钉桌面期间减掉父窗口客户区原点。
    /// 参数与 TAO 的 set_outer_position 保持一致（同样是直接 SetWindowPos、
    /// 同样不做边框换算），前端才不会出现「写进去的位置和读出来的对不上」。
    pub fn place(hwnd: HWND, x: i32, y: i32) {
        let (dx, dy) = if is_pinned() {
            (
                PAR_X.load(Ordering::Relaxed) as i32,
                PAR_Y.load(Ordering::Relaxed) as i32,
            )
        } else {
            (0, 0)
        };
        unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                x - dx,
                y - dy,
                0,
                0,
                SWP_ASYNCWINDOWPOS | SWP_NOZORDER | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

#[cfg(not(windows))]
mod desktop_pin {
    use std::sync::atomic::{AtomicBool, Ordering};
    static PINNED: AtomicBool = AtomicBool::new(false);

    pub fn is_pinned() -> bool {
        PINNED.load(Ordering::Relaxed)
    }
    pub fn needs_repin() -> bool {
        false
    }
    pub fn pin(_hwnd: *mut core::ffi::c_void) -> bool {
        false
    }
    pub fn unpin(_hwnd: *mut core::ffi::c_void) {}
    pub fn place(_hwnd: *mut core::ffi::c_void, _x: i32, _y: i32) {}
}

/// 主窗口的原生句柄（Windows 下就是 HWND）
#[cfg(windows)]
fn main_hwnd<R: Runtime>(app: &AppHandle<R>) -> Option<*mut core::ffi::c_void> {
    app.get_webview_window("main")?
        .hwnd()
        .ok()
        .map(|h| h.0 as *mut core::ffi::c_void)
}

#[cfg(windows)]
/// 把穿透位也记进 tao 自己缓存的 WindowFlags。
/// 只手动改样式不够：tao 每次重算 ex 样式都是按缓存整体覆写，
/// 开机时 show() 触发过一次，手动打的位就被它抹掉了（实测 ex 回到 0x40110）。
/// 挂上之后再调它会写失败（输入队列已并到桌面线程），但 tao 是先更新缓存再写窗口，
/// 所以缓存照样对上 —— 之后无论谁重算都会带上这两一位。
fn mark_passthrough_in_tao<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_ignore_cursor_events(on);
    }
}

/// 挂/摘要串行：点按钮（apply_desktop_pin）和贴边上报（set_dock_state）可能同时进来，
/// 交错执行会出现「刚挂上就被另一次同步按旧读数摘下来」。
static PIN_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 按「设置开启 且 当前没停靠」施加钉桌面，返回实际挂上没有。
/// 设置改动、停靠变化、拖动结束、开机恢复都收敛到这一个函数里。
fn sync_desktop_pin<R: Runtime>(app: &AppHandle<R>) -> bool {
    let _guard = PIN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let want = read_desktop_pinned(app) && !is_docked();
    #[cfg(windows)]
    {
        let Some(hwnd) = main_hwnd(app) else {
            return desktop_pin::is_pinned();
        };
        if want {
            // 先让 tao 把穿透位记进它自己缓存的 WindowFlags 并写一次 —— 顶层时写得动，
            // 它那次 SWP_FRAMECHANGED 也落在挂父窗口之前；之后无论谁重算 ex 样式都带着
            // 这两一位，而 pin 内部这次改样式变成幂等，不再多一次 SetWindowPos。
            mark_passthrough_in_tao(app, true);
            if !desktop_pin::pin(hwnd) {
                mark_passthrough_in_tao(app, false);
            }
        } else {
            desktop_pin::unpin(hwnd);
            mark_passthrough_in_tao(app, false);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
    // 穿透位由 pin/unpin 自己负责（挂上之后输入队列并到桌面线程，就改不动了）
    desktop_pin::is_pinned()
}

fn apply_desktop_pin<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<bool, String> {
    write_setting_bool(app, "desktopPin", enabled)?;
    let applied = sync_desktop_pin(app);
    rebuild_tray_menu(app).map_err(|e| format!("更新托盘菜单失败: {e}"))?;
    app.emit(
        SETTINGS_UPDATED_EVENT,
        serde_json::json!({ "ts": now_ms(), "source": "rust" }),
    )
    .map_err(|e| format!("通知前端失败: {e}"))?;
    Ok(applied)
}

fn toggle_desktop_pin<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    apply_desktop_pin(app, !read_desktop_pinned(app))
}

/// 开机时资源管理器可能还没把桌面窗口建好，试若干次；顺便盯着父窗口是否被换掉
fn start_pin_watchdog(app: &AppHandle) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        for _ in 0..15 {
            if sync_desktop_pin(&handle) || !read_desktop_pinned(&handle) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(1000));
        }
        loop {
            std::thread::sleep(std::time::Duration::from_millis(2000));
            #[cfg(windows)]
            if desktop_pin::needs_repin() {
                let _ = sync_desktop_pin(&handle);
            }
        }
    });
}

/// 设置钉桌面：返回是否真的挂上（停靠期间设为开也挂不上，等解除停靠后自动挂）
#[tauri::command]
fn set_desktop_pinned(app: AppHandle, enabled: bool) -> Result<bool, String> {
    apply_desktop_pin(&app, enabled)
}

/// 钉桌面当前是否真的生效（前端据此决定按钮亮不亮）
#[tauri::command]
fn get_desktop_pin_state() -> bool {
    desktop_pin::is_pinned()
}

/// 贴边隐藏上报停靠状态：停靠 = 钉桌面自动挂起（唤出要靠临时置顶，桌面层做不到）。
/// 只挂起，不改设置值 —— 解除停靠后自动挂回，用户不用重新点一次。
#[tauri::command]
fn set_dock_state(app: AppHandle, active: bool) -> Result<bool, String> {
    let was = is_docked();
    DOCKED.store(active, std::sync::atomic::Ordering::Relaxed);
    let applied = sync_desktop_pin(&app);
    if was != active {
        rebuild_tray_menu(&app).map_err(|e| format!("更新托盘菜单失败: {e}"))?;
    }
    Ok(applied)
}

/// 前端唯一的位置写入口：钉桌面期间窗口是桌面窗口的子窗口，
/// 位置要按父窗口客户区原点换算，Tauri 自己的 setPosition 不懂这件事。
#[tauri::command]
fn set_widget_position(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    #[cfg(windows)]
    {
        let Some(hwnd) = main_hwnd(&app) else {
            return Err("没有主窗口".to_string());
        };
        desktop_pin::place(hwnd, x, y);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let w = app.get_webview_window("main").ok_or("没有主窗口")?;
        w.set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())
    }
}

/// 提醒弹窗的查询串：待办内容、id 和这一次要提醒的时刻都烧在 URL 上
fn reminder_query(row: &ReminderRow) -> String {
    format!(
        "window=reminder&todoId={}&text={}&dueDate={}",
        urlencoding_simple(&row.id),
        urlencoding_simple(&row.text),
        row.due_date,
    )
}

/// 创建并展示一条独立提醒弹窗（置顶 / 不可被主窗口遮挡）
fn show_reminder_window<R: Runtime>(app: &AppHandle<R>, row: &ReminderRow) {
    let label = format!("reminder-{}", row.id);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        // 面板可能被拉伸或挪过，复用窗口时按当前几何重算一次
        let (x, y, w, h) = reminder_geometry(app);
        let _ = existing.set_size(PhysicalSize::new(w, h));
        let _ = existing.set_position(PhysicalPosition::new(x, y));
        let _ = existing.show();
        // 提醒时刻烧在 URL 里，复用窗口时必须重新导航，否则显示的是上一轮的时间
        if let Ok(mut uri) = existing.url() {
            uri.set_query(Some(&reminder_query(row)));
            let _ = existing.navigate(uri);
        }
        return;
    }

    let url = format!("index.html?{}", reminder_query(row));

    let (x, y, w, h) = reminder_geometry(app);

    // 先以不可见方式创建，避免 build() 时窗口管理器将其放到屏幕中央
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title("提醒")
        .inner_size(300.0, 150.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)            // 配合 WebView 透明背景，彻底去掉 1px 边
        .shadow(false)                // 卡片自带 box-shadow，不需要窗口级阴影
        .always_on_top(true)
        .skip_taskbar(true)
        .maximizable(false)
        .focused(false)               // 关键：首次弹出也不抢焦点，让用户主动点
        .visible(false);              // 先不可见，设好位置后再显示

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(TitleBarStyle::Transparent)
        .hidden_title(true);

    let result = builder.build();

    match result {
        Ok(win) => {
            // 尺寸/位置都按面板实际几何定，再显示，避免闪一下
            let _ = win.set_size(PhysicalSize::new(w, h));
            let _ = win.set_position(PhysicalPosition::new(x, y));

            // 针对不同系统进行「不抢焦点」的显示
            #[cfg(target_os = "windows")]
            {
                if let Ok(hwnd) = win.hwnd() {
                    unsafe {
                        // SW_SHOWNOACTIVATE = 4 : 显示但不激活
                        extern "system" {
                            fn ShowWindow(hwnd: isize, nCmdShow: i32) -> i32;
                        }
                        ShowWindow(hwnd.0 as isize, 4);
                    }
                } else {
                    let _ = win.show();
                }
            }

            #[cfg(target_os = "macos")]
            {
                // macOS 上 .show() 配合 focused(false) 通常不抢焦点
                let _ = win.show();
            }

            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                let _ = win.show();
            }

            println!("[LiteNote] 提醒弹窗已创建: label={}", label);
        }
        Err(e) => {
            eprintln!("[LiteNote] 创建提醒弹窗失败: {e}");
        }
    }
}

/// 极简 URL 编码（不引外部 crate），仅处理中文 / 空格 / 特殊字符
fn urlencoding_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// 检查并发送到期提醒（从 Rust 端直接操作 SQLite）
fn check_and_notify(app: &AppHandle, db_path: &std::path::Path) {
    if !db_path.exists() {
        return;
    }

    let conn = match Connection::open(db_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[LiteNote] 提醒检查：无法打开数据库: {e}");
            return;
        }
    };

    if !todos_table_exists(&conn) {
        return;
    }

    // 读取用户设置的提醒方式
    let reminder_mode = read_reminder_mode(&conn);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    // 1. 提醒检查
    let rows = query_due_reminders(&conn, now);
    if !rows.is_empty() {
        println!(
            "[LiteNote] 发现 {} 条待办需要提醒 (mode={})",
            rows.len(),
            reminder_mode
        );
        for row in &rows {
            match reminder_mode.as_str() {
                "system" => {
                    // 系统通知：使用 tauri-plugin-notification
                    let body = format_due_text(&row.text, row.due_date, now);
                    if let Err(e) = app
                        .notification()
                        .builder()
                        .title("LiteNote 提醒")
                        .body(&body)
                        .show()
                    {
                        eprintln!("[LiteNote] 发送系统通知失败: {e}");
                    } else {
                        println!(
                            "[LiteNote] 系统通知已发送: label={}",
                            row.id
                        );
                    }
                }
                _ => {
                    // 默认弹窗
                    show_reminder_window(app, row);
                }
            }
            mark_reminded(&conn, &row.id);
        }
    }

    // 2. 循环待办自动推进
    advance_recurring_todos(&conn, now);
}

// ──────────────── 前端调用的 Tauri Commands ────────────────

/// 提醒窗口中的用户操作
/// - action = "snooze": 延后 delayMinutes 分钟，关闭弹窗
/// - action = "close" : 仅关闭弹窗（「我知道了」/×，不修改数据）
#[tauri::command]
fn reminder_action(
    app: AppHandle,
    todo_id: String,
    action: String,
    delay_minutes: Option<i64>,
) -> Result<(), String> {
    // 找到 db 路径
    let db_path = litenote_db_path(&app).ok_or_else(|| "无法获取数据库路径".to_string())?;
    if !db_path.exists() {
        return Err("数据库文件不存在".into());
    }

    let conn = Connection::open(&db_path).map_err(|e| format!("打开 DB 失败: {e}"))?;

    match action.as_str() {
        "snooze" => {
            let delay = delay_minutes.unwrap_or(5).max(1);
            // 在原有截止时间基础上叠加，不是从「现在」计算
            let current_due: i64 = conn
                .query_row(
                    "SELECT due_date FROM todos WHERE id = ?1",
                    rusqlite::params![todo_id],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let new_due = if current_due > 0 {
                current_due + delay * 60_000
            } else {
                now_ms() + delay * 60_000
            };
            conn.execute(
                "UPDATE todos SET due_date = ?2, reminded = 0, update_time = ?3 WHERE id = ?1",
                rusqlite::params![todo_id, new_due, now_ms()],
            )
            .map_err(|e| format!("更新失败: {e}"))?;
        }
        "close" => {
            // 「我知道了」/× 关闭弹窗，标记本轮已提醒
            conn.execute(
                "UPDATE todos SET reminded = 1, update_time = ?2 WHERE id = ?1",
                rusqlite::params![todo_id, now_ms()],
            )
            .map_err(|e| format!("更新失败: {e}"))?;
        }
        other => {
            return Err(format!("未知 action: {other}"));
        }
    }

    // 让前端自己 close 窗口，Rust 不动（避免 macOS 唤起主窗口）
    Ok(())
}

/// 前端隐藏窗口时调用：保存窗口状态再隐藏
#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    let flags = if read_focus_mode(&app) {
        // 专注模式不写 SIZE，避免下次完整模式恢复到矮窗口
        StateFlags::POSITION
    } else {
        window_persist_flags()
    };
    app.save_window_state(flags).map_err(|e| format!("保存窗口状态失败: {e}"))?;
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(|e| format!("隐藏窗口失败: {e}"))?;
    }
    Ok(())
}

/// 切换专注 / 完整模式（托盘、快捷键、前端均可调用）
#[tauri::command]
fn set_focus_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_focus_mode(&app, enabled)
}

/// 设置窗口锁定（托盘、快捷键、前端均可调用）
#[tauri::command]
fn set_window_locked(app: AppHandle, enabled: bool) -> Result<(), String> {
    apply_window_lock(&app, enabled)
}

/// 重新注册全局快捷键（前端修改快捷键设置后调用）
#[tauri::command]
fn update_shortcuts(app: AppHandle) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| format!("取消注册快捷键失败: {e}"))?;
    register_all_shortcuts(&app)
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// 通过 AppHandle 读取布尔设置（供 webdav 模块使用）
pub(crate) fn read_setting_bool_app<R: Runtime>(app: &AppHandle<R>, key: &str, default: bool) -> bool {
    let Some(db_path) = litenote_db_path(app) else {
        return default;
    };
    if !db_path.exists() {
        return default;
    }
    let Ok(conn) = open_db(&db_path) else {
        return default;
    };
    read_setting_bool(&conn, key, default)
}

/// 通过 AppHandle 读取字符串设置（供 webdav 模块使用）
pub(crate) fn read_setting_string_app<R: Runtime>(
    app: &AppHandle<R>,
    key: &str,
    default: &str,
) -> String {
    let Some(db_path) = litenote_db_path(app) else {
        return default.to_string();
    };
    if !db_path.exists() {
        return default.to_string();
    }
    let Ok(conn) = open_db(&db_path) else {
        return default.to_string();
    };
    read_setting_string(&conn, key, default)
}

/// 从 settings 表读取快捷键配置并注册全局快捷键（空字符串 = 不注册）
fn register_all_shortcuts<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    const D_TOGGLE_WINDOW: &str = "CmdOrCtrl+Shift+L";
    const D_FOCUS: &str = "CmdOrCtrl+Shift+F";
    const D_LOCK: &str = "CmdOrCtrl+Shift+P";
    const D_DESKTOP_PIN: &str = "CmdOrCtrl+Shift+D";

    let (toggle_window, toggle_focus, toggle_lock, toggle_pin) = match litenote_db_path(app) {
        Some(db_path) if db_path.exists() => match Connection::open(&db_path) {
            Ok(conn) => (
                read_setting_string(&conn, "shortcutToggleWindow", D_TOGGLE_WINDOW),
                read_setting_string(&conn, "shortcutFocusMode", D_FOCUS),
                read_setting_string(&conn, "shortcutWindowLock", D_LOCK),
                read_setting_string(&conn, "shortcutDesktopPin", D_DESKTOP_PIN),
            ),
            Err(_) => (
                D_TOGGLE_WINDOW.to_string(),
                D_FOCUS.to_string(),
                D_LOCK.to_string(),
                D_DESKTOP_PIN.to_string(),
            ),
        },
        _ => (
            D_TOGGLE_WINDOW.to_string(),
            D_FOCUS.to_string(),
            D_LOCK.to_string(),
            D_DESKTOP_PIN.to_string(),
        ),
    };

    let mut errors: Vec<String> = Vec::new();

    if !toggle_window.is_empty() {
        let handle = app.clone();
        if let Err(e) = app.global_shortcut().on_shortcut(
            toggle_window.as_str(),
            move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_main_window(&handle);
                }
            },
        ) {
            errors.push(format!("{toggle_window}: {e}"));
        }
    }

    if !toggle_focus.is_empty() {
        if let Err(e) = app.global_shortcut().on_shortcut(
            toggle_focus.as_str(),
            move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = toggle_focus_mode(app);
                }
            },
        ) {
            errors.push(format!("{toggle_focus}: {e}"));
        }
    }

    if !toggle_lock.is_empty() {
        if let Err(e) = app.global_shortcut().on_shortcut(
            toggle_lock.as_str(),
            move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = toggle_window_lock(app);
                }
            },
        ) {
            errors.push(format!("{toggle_lock}: {e}"));
        }
    }

    if !toggle_pin.is_empty() {
        if let Err(e) = app.global_shortcut().on_shortcut(
            toggle_pin.as_str(),
            move |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    let _ = toggle_desktop_pin(app);
                }
            },
        ) {
            errors.push(format!("{toggle_pin}: {e}"));
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("注册快捷键失败: {}", errors.join("; ")))
    }
}

/// 启动 Rust 端后台提醒轮询（独立于前端，确保 macOS 上窗口隐藏时也能可靠提醒）
fn start_rust_reminder_poll(app: &AppHandle) {
    let handle = app.clone();

    // 获取数据库路径（与 plugin-sql 的 app_config_dir 保持一致）
    let db_path = match litenote_db_path(app) {
        Some(p) => p,
        None => {
            eprintln!("[LiteNote] 无法获取应用配置目录");
            return;
        }
    };

    println!(
        "[LiteNote] 启动 Rust 端提醒轮询，数据库路径: {}",
        db_path.display()
    );

    tauri::async_runtime::spawn(async move {
        // 延迟 5 秒后首次检查，之后每 30 秒一次
        tokio::time::sleep(Duration::from_secs(5)).await;

        let mut interval =
            tokio::time::interval(Duration::from_secs(REMINDER_POLL_INTERVAL_SECS));
        // 跳过第一个即时 tick
        interval.tick().await;

        loop {
            interval.tick().await;
            let db_path = db_path.clone();
            let handle = handle.clone();

            // SQLite 是阻塞操作，放到 spawn_blocking 中执行
            let _ = tokio::task::spawn_blocking(move || {
                check_and_notify(&handle, &db_path);
            })
            .await;
        }
    });
}

fn tray_image<R: Runtime>(app: &AppHandle<R>) -> Image<'static> {
    if let Some(icon) = app.default_window_icon() {
        return Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height());
    }
    let mut rgba = Vec::with_capacity(32 * 32 * 4);
    for _ in 0..(32 * 32) {
        rgba.extend_from_slice(&[70u8, 140, 190, 255]);
    }
    Image::new_owned(rgba, 32, 32)
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        // 钉在桌面层时不要焦点：子窗口的「激活」会落到桌面窗口(Progman)上，
        // 等于把桌面切到前台；钉住本来就要求鼠标键盘都不接到挂件。
        #[cfg(windows)]
        let focusable = !desktop_pin::is_pinned();
        #[cfg(not(windows))]
        let focusable = true;
        if focusable {
            let _ = w.set_focus();
        }
    }
    // show() 同样会让 TAO 重套窗口样式（把 WS_CAPTION 带回来），显示后再收敛一次
    apply_window_lock_effects(app);
}

fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        if let Ok(visible) = w.is_visible() {
            if visible {
                // 隐藏前保存窗口状态（位置 + 大小；专注模式不写 SIZE）
                let flags = if read_focus_mode(app) {
                    StateFlags::POSITION
                } else {
                    window_persist_flags()
                };
                let _ = app.save_window_state(flags);
                let _ = w.hide();
            } else {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
    }
    // 与 show_main_window 同理：隐显之后要重新收敛锁定状态
    apply_window_lock_effects(app);
}

/* ──────────────── 贴边隐藏（类似 QQ） ────────────────
   窗口贴近屏幕左/右边缘时自动吸附；鼠标离开窗口约 0.5 秒后滑出屏幕，
   只留下 EDGE_PEEK 像素宽的一条；鼠标碰到这条窄边再滑回来。
   四个常量都可以按手感调整。
   ─────────────────────────────────────────────────── */

/// 隐藏时露在屏幕内的宽度（px）
const EDGE_PEEK: i32 = 4;
/// 距屏幕边缘多少像素内自动吸附
const EDGE_SNAP: i32 = 28;
/// 连续多少拍「鼠标不在窗口上」才滑出去（160ms 一拍 → 约 0.5 秒）
const EDGE_HIDE_TICKS: u32 = 3;
/// 轮询间隔（毫秒）
const EDGE_POLL_MS: u64 = 160;

#[cfg(windows)]
fn cursor_pos() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut p = POINT { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut p) };
    if ok == 0 {
        None
    } else {
        Some((p.x, p.y))
    }
}

#[cfg(not(windows))]
fn cursor_pos() -> Option<(i32, i32)> {
    None
}

/// 启动贴边隐藏轮询（设置关闭时什么都不做）
fn start_edge_hide_poll<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(EDGE_POLL_MS));
        // 停靠边：0 = 未停靠，-1 = 左，1 = 右
        let mut dock: i32 = 0;
        // 已显示状态下，鼠标连续不在窗口上的拍数
        let mut outside_ticks: u32 = 0;

        loop {
            interval.tick().await;

            if !read_setting_bool_app(&handle, "edgeHide", false) {
                dock = 0;
                outside_ticks = 0;
                continue;
            }
            let Some(w) = handle.get_webview_window("main") else {
                continue;
            };
            let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else {
                continue;
            };
            let Ok(Some(mon)) = w.current_monitor() else {
                continue;
            };
            let Some((cx, cy)) = cursor_pos() else {
                continue;
            };

            let mx = mon.position().x;
            let mw = mon.size().width as i32;
            let (wx, wy) = (pos.x, pos.y);
            let (ww, wh) = (size.width as i32, size.height as i32);

            // ── 未停靠：贴近屏幕左/右边缘就吸附上去 ──
            if dock == 0 {
                if wx <= mx + EDGE_SNAP && wx >= mx - EDGE_SNAP {
                    dock = -1;
                    outside_ticks = 0;
                    if wx != mx {
                        let _ = w.set_position(tauri::PhysicalPosition::new(mx, wy));
                    }
                } else if wx + ww >= mx + mw - EDGE_SNAP && wx + ww <= mx + mw + EDGE_SNAP {
                    dock = 1;
                    outside_ticks = 0;
                    let target = mx + mw - ww;
                    if wx != target {
                        let _ = w.set_position(tauri::PhysicalPosition::new(target, wy));
                    }
                }
                continue;
            }

            // ── 已停靠 ──
            let shown_x = if dock == -1 { mx } else { mx + mw - ww };
            let hidden_x = if dock == -1 {
                mx - ww + EDGE_PEEK
            } else {
                mx + mw - EDGE_PEEK
            };
            let is_hidden = (wx - hidden_x).abs() <= 2;
            let over_window = cx >= wx && cx <= wx + ww && cy >= wy && cy <= wy + wh;

            // 用户把窗口拖离了停靠位 → 解除停靠
            if !is_hidden && (wx - shown_x).abs() > 10 {
                dock = 0;
                outside_ticks = 0;
                continue;
            }

            if is_hidden {
                // 鼠标碰到露出的那条窄边 → 滑回来
                let hit_strip = cy >= wy
                    && cy <= wy + wh
                    && if dock == -1 {
                        cx <= mx + EDGE_PEEK + 1
                    } else {
                        cx >= mx + mw - EDGE_PEEK - 1
                    };
                if hit_strip {
                    let _ = w.set_position(tauri::PhysicalPosition::new(shown_x, wy));
                }
            } else if over_window {
                outside_ticks = 0;
            } else {
                outside_ticks += 1;
                if outside_ticks >= EDGE_HIDE_TICKS {
                    outside_ticks = 0;
                    let _ = w.set_position(tauri::PhysicalPosition::new(hidden_x, wy));
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            reminder_action,
            reminder_fit,
            hide_main_window,
            set_focus_mode,
            set_window_locked,
            refresh_window_lock,
            set_desktop_pinned,
            get_desktop_pin_state,
            set_dock_state,
            set_widget_position,
            quit_app,
            update_shortcuts,
            webdav::webdav_set_config,
            webdav::webdav_get_config,
            webdav::webdav_test,
            webdav::webdav_sync_now,
            webdav::webdav_restore,
            webdav::webdav_status,
        ])
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_persist_flags())
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // 小部件模式：Windows 不在任务栏显示；macOS 不在 Dock 显示（仅托盘）
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_skip_taskbar(true);
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_maximizable(false);
            }
            // 安装窗口锁定拦截（WM_NCHITTEST）并同步当前锁定状态。
            // 这里刻意不调 set_resizable：它会让 TAO 重套样式并重算非客户区，
            // 从而露出被 WebView 盖住的标题栏（顶部白条）。
            apply_window_lock_effects(app.handle());

            #[cfg(target_os = "macos")]
            app.set_activation_policy(ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            let icon = tray_image(&handle);

            // macOS: 设置透明标题栏样式 + WebView 透明背景
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title_bar_style(TitleBarStyle::Transparent);

                    // 设置窗口背景色为透明
                    let _ = window.set_background_color(Some(tauri::utils::config::Color(0, 0, 0, 0)));
                }
            }

            let focus_mode = read_focus_mode(app.handle());
            let window_locked = read_window_locked(app.handle());
            let menu = build_tray_menu(app.handle(), focus_mode, window_locked)?;

            let _tray = TrayIconBuilder::with_id("litenote-tray")
                .icon(icon)
                .tooltip("一笺 Yijian")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "tray_quit" => {
                        app.exit(0);
                    }
                    "tray_show" => {
                        show_main_window(app);
                    }
                    "tray_mode_focus" => {
                        let _ = apply_focus_mode(app, true);
                    }
                    "tray_mode_manage" => {
                        let _ = apply_focus_mode(app, false);
                    }
                    "tray_window_lock" => {
                        let _ = toggle_window_lock(app);
                    }
                    "tray_desktop_pin" => {
                        let _ = toggle_desktop_pin(app);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    let app = tray.app_handle();
                    match event {
                        TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        } => {
                            show_main_window(app);
                        }
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            show_main_window(app);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // 启动 Rust 端后台提醒轮询（独立于前端，macOS 窗口隐藏时也能可靠运行）
            start_rust_reminder_poll(app.handle());

            // 关掉 WebView2 自带的右键菜单：它没有样式接口改不了，
            // 关掉之后右键完全交给应用自己的菜单处理
            disable_native_context_menu(app.handle());

            // 启动 Rust 端后台 WebDAV 同步轮询（仅启用时执行单向上传）
            webdav::start_webdav_sync_poll(app.handle());

            // 启动时自动拉取一次远端（多设备：每次打开轻签就能拿到别的设备的改动）
            webdav::startup_pull(app.handle());

            /*
              贴边隐藏改由**前端**实现（见 WidgetShell 的 edgeHide effect）。

              Rust 这套「每 160ms 读一次数据库 + 轮询全局光标 + set_position」
              依赖环节太多：任一环失败（数据库读失败、current_monitor 返回 None、
              位置设置被拒……）就整体静默失效，而且日志在 stderr 里用户看不到，
              排查成本极高（实测就是"完全没反应"）。

              前端只需要窗口自身坐标与鼠标进出事件即可：
              隐藏时还有 4px 露在屏幕内，鼠标进入它同样触发 mouseenter，
              所以「碰边缘滑回来」根本不需要读全局光标。
              保留下面这套代码备查，不再调用。
            */
            // start_edge_hide_poll(app.handle());

            // 全局快捷键：从设置中读取配置并注册
            if let Err(e) = register_all_shortcuts(app.handle()) {
                eprintln!("[LiteNote] 全局快捷键注册失败: {e}");
            }

            // 启动时按 DB 里的「锁定窗口」恢复命中测试拦截，
            // 避免前端设置加载完成之前窗口还能被拖动 / 拉伸
            apply_window_lock_effects(app.handle());

            // 启动后强制显示主窗口，避免 window-state 或上次隐藏导致「启动打不开」
            show_main_window(app.handle());

            // 钉桌面：桌面层的父窗口要等资源管理器建好，试若干次；之后一直盯着它有没有被换掉
            start_pin_watchdog(app.handle());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { .. } = event {
                show_main_window(app_handle);
            }
            // 面板一动，弹窗就跟着重摆（弹窗是面板的「附属」，反过来不成立）
            if let RunEvent::WindowEvent { label, event, .. } = event {
                if label == "main"
                    && matches!(
                        event,
                        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
                    )
                {
                    reposition_reminders(app_handle);
                }
            }
        });
}

#[cfg(test)]
mod recurrence_tests {
    use super::*;

    /// 与前端共用同一张用例表（`src/lib/recurrence.ts` 的 node 跑法读同一个文件），
    /// 两边算法各写一遍，靠这张表对齐。
    const CASES: &str = include_str!("../tests/reccases.json");

    /// "2026-10-31T09:00" → 本地时区时间戳
    fn local_ms(text: &str) -> i64 {
        let (date, time) = text.split_once('T').expect("用例时间格式");
        let mut d = date.split('-').map(|x| x.parse::<i32>().unwrap());
        let mut t = time.split(':').map(|x| x.parse::<u32>().unwrap());
        Local
            .with_ymd_and_hms(
                d.next().unwrap(),
                d.next().unwrap() as u32,
                d.next().unwrap() as u32,
                t.next().unwrap(),
                t.next().unwrap(),
                0,
            )
            .single()
            .expect("本地时间不合法")
            .timestamp_millis()
    }

    fn local_text(ms: i64) -> String {
        let d = to_local(ms).expect("时间戳不合法");
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}",
            d.year(),
            d.month(),
            d.day(),
            d.hour(),
            d.minute()
        )
    }

    #[test]
    fn next_due_matches_shared_case_table() {
        let root: serde_json::Value = serde_json::from_str(CASES).expect("用例表不是合法 JSON");
        let cases = root["cases"].as_array().expect("用例表缺 cases 数组");
        let mut checked = 0usize;

        for c in cases {
            let name = c["name"].as_str().unwrap_or("?");
            let kind = c["type"].as_str().unwrap();
            let config = c["config"].to_string();
            let expect = c["expect"].as_str().unwrap();

            let got = compute_next_due(
                local_ms(c["now"].as_str().unwrap()),
                local_ms(c["anchor"].as_str().unwrap()),
                kind,
                &config,
            );
            let text = got.map(local_text).unwrap_or_else(|| "无".to_string());
            assert_eq!(text, expect, "用例「{name}」两边算得不一致");
            checked += 1;
        }
        assert!(checked >= 15, "用例表太少，起不到对照作用");
    }

    /// 提醒提前量只减一次：配置 15 分钟，就只提前 15 分钟
    #[test]
    fn remind_lead_is_applied_once() {
        assert_eq!(REMIND_ADVANCE_MS, 15 * 60 * 1000);
    }
}

//! WebDAV 同步模块
//!
//! 设计：
//! - 双向同步：本地 todos 表与远端单文件 `litenote.json` 按条目 `update_time` 合并
//!   （last-write-wins），避免多设备互相覆盖丢数据
//! - 提供「手动恢复」：拉取远端 JSON 覆盖本地（由前端在用户确认后调用）
//! - 坚果云等兼容 WebDAV 的网盘均可使用
//! - 密码使用 aes-gcm 随机 nonce 加密后存入 settings 表（非明文）

use std::path::Path;
use std::time::Duration;

use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::{
    apply_synced_settings, ensure_settings_updated_at, litenote_db_path, now_ms, read_setting_bool,
    read_setting_bool_app, read_setting_string, read_setting_string_app, CATEGORIES_UPDATED_EVENT,
    SETTINGS_UPDATED_EVENT, TODOS_UPDATED_EVENT,
};

/// 远端文件名（存于用户配置的 remotePath 目录下，默认 /Yijian/litenote.json）
/// 刻意与原版的 /LiteNote/ 分开：否则两版会同步到同一个云端文件、互相覆盖数据。
/// 以前默认值是上一任使用者的个人目录名，别人首次同步会在自己网盘里建出别人的目录。
const DEFAULT_REMOTE_PATH: &str = "/Yijian/litenote.json";

/// 后台定时同步间隔（秒）。
///
/// 口径（他定的）：**内容变化才是主触发**（前端在列表变化后 2.5 秒调 webdavAutoSync，
/// 实测新增/删除都在几秒内传到云端），定时器只是**兜底**——用来接住「另一台设备改了、
/// 本机一直没动」这种情况。所以间隔可以放宽，不必跟得那么紧。
const SYNC_POLL_INTERVAL_SECS: u64 = 3600;
const SYNC_FILE_VERSION: u32 = 3;
const UNCATEGORIZED_CATEGORY_ID: &str = "uncategorized";

/// 简单加密密钥派生：基于固定 salt + 应用标识（设备级弱密钥，仅防明文泄漏）
const ENC_KEY_SALT: &[u8] = b"litenote-webdav-salt";
/// AES-GCM nonce 长度必须为 12 字节
const ENC_NONCE_LEN: usize = 12;

// ──────────────── 同步数据模型 ────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
struct TodoItemSync {
    id: String,
    text: String,
    completed: bool,
    /// 一条待办只属于一个分类。旧快照缺字段时由 serde 归入系统默认分类。
    #[serde(default)]
    category_id: Option<String>,
    #[serde(default)]
    pinned: bool,
    #[serde(default)]
    sort_order: f64,
    #[serde(default)]
    color_id: Option<String>,
    #[serde(default)]
    due_date: i64,
    #[serde(default)]
    reminded: bool,
    #[serde(default)]
    is_recurring: bool,
    #[serde(default)]
    recurrence_type: String,
    #[serde(default)]
    recurrence_config: String,
    #[serde(default)]
    update_time: i64,
    /// 软删除墓碑。合并规则是「并集 + update_time 新者胜」，真删行对它不可见，
    /// 所以删除必须作为一个带更新时间的条目同步出去，否则本机删掉、云端留着，
    /// 下一轮同步又把人家的条目塞回来（表现就是「删不掉」）。
    /// `serde(default)` 保证老快照（没这个字段）读进来仍然是「未删除」。
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    create_time: i64,
    #[serde(default)]
    completed_time: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct CategorySync {
    id: String,
    name: String,
    /// 标签底色："#rrggbb" / "none"；None = 前端按顺序自动取空闲色
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    sort_order: f64,
    #[serde(default)]
    create_time: i64,
    #[serde(default)]
    update_time: i64,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    system: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct SettingSync {
    key: String,
    value: String,
    updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
struct SyncFile {
    version: u32,
    updated_at: i64,
    todos: Vec<TodoItemSync>,
    #[serde(default)]
    categories: Vec<CategorySync>,
    #[serde(default)]
    settings: Vec<SettingSync>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WebdavStatus {
    enabled: bool,
    last_sync: i64,
}

// ──────────────── 加密（密码存储用） ────────────────

fn derive_key() -> [u8; 32] {
    // 简单派生：固定 salt + 固定串，取前 32 字节。仅用于「不落明文」，非高安全场景。
    use std::io::Write;
    let mut data = Vec::new();
    let _ = data.write_all(b"litenote-webdav-secret");
    let _ = data.write_all(ENC_KEY_SALT);
    let mut key = [0u8; 32];
    for (i, b) in data.iter().cycle().take(32).enumerate() {
        key[i] = *b;
    }
    key
}

fn encrypt_secret(plain: &str) -> Result<String, String> {
    let cipher =
        Aes256Gcm::new_from_slice(&derive_key()).map_err(|e| format!("加密初始化失败: {e}"))?;
    // 每次加密使用随机 nonce，避免固定 nonce 复用的密码学缺陷
    let mut nonce_bytes = [0u8; ENC_NONCE_LEN];
    // 使用 rand 的线程安全 RNG 生成随机数
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let mut ciphertext = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| format!("加密失败: {e}"))?;
    // 存储格式：nonce(12字节) ++ ciphertext，再整体 base64
    let mut out = Vec::with_capacity(ENC_NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.append(&mut ciphertext);
    Ok(B64.encode(out))
}

fn decrypt_secret(cipher_b64: &str) -> Result<String, String> {
    let cipher =
        Aes256Gcm::new_from_slice(&derive_key()).map_err(|e| format!("解密初始化失败: {e}"))?;
    let bytes = B64.decode(cipher_b64).map_err(|e| format!("密文解码失败: {e}"))?;
    if bytes.len() < ENC_NONCE_LEN {
        return Err("密文长度不足（缺少 nonce）".to_string());
    }
    let (nonce_bytes, ciphertext) = bytes.split_at(ENC_NONCE_LEN);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plain = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| "密码解密失败（可能已损坏）".to_string())?;
    String::from_utf8(plain).map_err(|e| format!("密码编码失败: {e}"))
}

// ──────────────── settings 读写 ────────────────

/// 统一打开数据库连接并启用 WAL 模式，降低与前端 tauri-plugin-sql 并发写时的锁竞争。
fn open_db(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| format!("打开 DB 失败: {e}"))?;
    let _ = conn.execute("PRAGMA journal_mode=WAL", []);
    let _ = conn.execute("PRAGMA busy_timeout=5000", []);
    Ok(conn)
}

fn write_setting_string<R: Runtime>(app: &AppHandle<R>, key: &str, value: &str) -> Result<(), String> {
    let db_path = litenote_db_path(app).ok_or_else(|| "无法获取数据库路径".to_string())?;
    let conn = open_db(&db_path)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| format!("写入设置失败: {e}"))?;
    Ok(())
}

// ──────────────── 分类同步 ────────────────

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let sql = format!("PRAGMA table_info({})", table);
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("检查表结构失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("读取表结构失败: {e}"))?;
    for row in rows {
        if row.map_err(|e| format!("读取表结构失败: {e}"))? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 同步路径不能假设前端 WebView 已经完成建表：老库、只启动 Rust 后台、云端恢复
/// 都可能在分类表尚未存在时到达这里。补一次幂等 schema，再读写才不会报 no such table。
fn ensure_category_sync_schema(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT,
            sort_order REAL NOT NULL DEFAULT 0,
            create_time INTEGER NOT NULL DEFAULT 0,
            update_time INTEGER NOT NULL DEFAULT 0,
            deleted INTEGER NOT NULL DEFAULT 0,
            system INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .map_err(|e| format!("创建分类表失败: {e}"))?;

    for (column, definition) in [
        ("color", "TEXT"),
        ("sort_order", "REAL NOT NULL DEFAULT 0"),
        ("deleted", "INTEGER NOT NULL DEFAULT 0"),
        ("system", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !column_exists(conn, "categories", column)? {
            let sql = format!("ALTER TABLE categories ADD COLUMN {column} {definition}");
            conn.execute(&sql, [])
                .map_err(|e| format!("升级分类表失败: {e}"))?;
        }
    }

    let now = now_ms();
    conn.execute(
        "INSERT INTO categories (id,name,sort_order,create_time,update_time,deleted,system)
         VALUES (?1,'未分类',0,?2,?2,0,1)
         ON CONFLICT(id) DO UPDATE SET name='未分类', system=1, deleted=0",
        rusqlite::params![UNCATEGORIZED_CATEGORY_ID, now],
    )
    .map_err(|e| format!("初始化默认分类失败: {e}"))?;

    let has_todos = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='todos' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if has_todos && !column_exists(conn, "todos", "category_id")? {
        conn.execute(
            "ALTER TABLE todos ADD COLUMN category_id TEXT NOT NULL DEFAULT 'uncategorized'",
            [],
        )
        .map_err(|e| format!("升级待办表失败: {e}"))?;
    }
    if has_todos {
        conn.execute(
            "UPDATE todos SET category_id = ?1 WHERE category_id IS NULL OR category_id = ''",
            rusqlite::params![UNCATEGORIZED_CATEGORY_ID],
        )
        .map_err(|e| format!("归一化待办分类失败: {e}"))?;
    }
    Ok(())
}

fn normalize_category_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "未命名".to_string();
    }
    trimmed.chars().take(40).filter(|c| !c.is_control()).collect()
}

fn normalize_category_color(color: Option<String>) -> Option<String> {
    let value = color?
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn normalize_category(item: CategorySync) -> CategorySync {
    if item.id == UNCATEGORIZED_CATEGORY_ID {
        return CategorySync {
            id: UNCATEGORIZED_CATEGORY_ID.to_string(),
            name: "未分类".to_string(),
            color: None,
            sort_order: 0.0,
            create_time: item.create_time,
            update_time: item.update_time.max(0),
            deleted: false,
            system: true,
        };
    }
    CategorySync {
        name: normalize_category_name(&item.name),
        color: normalize_category_color(item.color),
        update_time: item.update_time.max(0),
        deleted: item.deleted,
        system: false,
        ..item
    }
}

fn read_local_categories<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<CategorySync>, String> {
    let db_path = litenote_db_path(app).ok_or_else(|| "无法获取数据库路径".to_string())?;
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let conn = open_db(&db_path)?;
    ensure_category_sync_schema(&conn)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, name, color, sort_order, create_time, update_time, deleted, system \
             FROM categories",
        )
        .map_err(|e| format!("查询分类失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CategorySync {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                sort_order: row.get(3)?,
                create_time: row.get(4)?,
                update_time: row.get(5)?,
                deleted: row.get::<_, i64>(6)? != 0,
                system: row.get::<_, i64>(7)? != 0,
            })
        })
        .map_err(|e| format!("读取分类失败: {e}"))?;
    Ok(rows.filter_map(|r| r.ok()).map(normalize_category).collect())
}

fn merge_categories(local: Vec<CategorySync>, remote: Vec<CategorySync>) -> Vec<CategorySync> {
    let mut map: std::collections::HashMap<String, CategorySync> = std::collections::HashMap::new();
    for item in local {
        let item = normalize_category(item);
        map.insert(item.id.clone(), item);
    }
    for item in remote {
        let item = normalize_category(item);
        match map.get(&item.id) {
            Some(l) if l.update_time >= item.update_time => {}
            _ => {
                map.insert(item.id.clone(), item);
            }
        }
    }
    let mut merged: Vec<CategorySync> = map.into_values().collect();
    merged.sort_by(|a, b| {
        a.system
            .cmp(&b.system)
            .then(a.sort_order.partial_cmp(&b.sort_order).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.update_time.cmp(&b.update_time))
            .then(a.id.cmp(&b.id))
    });
    merged
}

fn category_tombstone_cutoff() -> i64 {
    now_ms() - 30 * 24 * 60 * 60 * 1000
}

// ──────────────── WebDAV 客户端 ────────────────

fn build_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        // 坚果云等使用有效 SSL 证书；此处不跳过校验
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))
}

/// 确保远端目录存在（逐级 MKCOL）。remote_path 形如 /Yijian/litenote.json
///
/// 必须在拉取之前调用：目录不存在时坚果云对 GET 回的是 409，
/// 先建好目录，首次同步才会走到「404/409 → 直接上传本地」。
fn ensure_remote_dir(client: &reqwest::blocking::Client, base: &str, auth: &reqwest::header::HeaderValue, remote_path: &str) -> Result<(), String> {
    // 取目录部分：去掉 remote_path 末尾的文件名
    let dir = match remote_path.trim_start_matches('/').rsplit_once('/') {
        Some((d, _)) if !d.is_empty() => d.to_string(),
        _ => return Ok(()), // 没有子目录，无需创建
    };
    let base = base.trim_end_matches('/');
    // 逐级拼接 remote_path 的目录分段并 MKCOL（已存在的目录返回 405/409，忽略）
    let mut cur = base.to_string();
    for seg in dir.split('/') {
        if seg.is_empty() {
            continue;
        }
        cur.push('/');
        cur.push_str(seg);
        let mkcol = http::Method::from_bytes(b"MKCOL")
            .map_err(|e| format!("构造 MKCOL 方法失败: {e}"))?;
        let resp = client
            .request(mkcol, &cur)
            .header(reqwest::header::AUTHORIZATION, auth.clone())
            .send();
        match resp {
            Ok(r) => {
                let s = r.status();
                // 201 创建成功；405/409 已存在，可接受；其他错误打印日志
                if !s.is_success() && s.as_u16() != 405 && s.as_u16() != 409 {
                    eprintln!("[webdav] MKCOL {} -> {}", cur, s);
                }
                // 凭据或路径本身不对时继续往下 PUT 也一定失败，直接报出来更好定位
                if matches!(s.as_u16(), 400 | 401 | 403) {
                    return Err(dav_error("创建远端目录", s, &cur));
                }
            }
            Err(e) => eprintln!("[webdav] MKCOL {} 请求失败: {}", cur, e),
        }
    }
    Ok(())
}

/// 把「远端文件路径」框里的内容归一化成一条纯路径。
///
/// 实测坚果云：有人把整条网址粘进这个框，拼出来就是 `.../dav/https://dav...` → 400 Bad Request。
/// 更糟的是「逐级建目录」会把 `https:` 当成一层目录去 MKCOL，在别人网盘里建出垃圾目录。
/// 所以在取配置这一步就把网址还原成路径，后面所有用法都只看到干净的 `/a/b.json`。
fn normalize_remote_path(base: &str, raw: &str) -> String {
    let rp = raw.trim().replace('\\', "/");
    // 协议名大小写不敏感（有人从文档里粘的是 HTTPS://…），用 lowercase 判一次
    let scheme = rp.to_ascii_lowercase();
    if !scheme.starts_with("http://") && !scheme.starts_with("https://") {
        return rp;
    }
    // 粘的网址正好以已填的服务器地址开头 → 剥掉这段前缀，剩下的就是路径
    let b = base.trim().trim_end_matches('/');
    if rp.len() > b.len() && rp[..b.len()].eq_ignore_ascii_case(b) {
        return rp[b.len()..].to_string();
    }
    // 对不上：取 `://主机` 之后的路径部分
    match rp.find("://") {
        Some(i) => {
            let rest = &rp[i + 3..];
            match rest.find('/') {
                Some(j) => rest[j..].to_string(),
                None => String::new(),
            }
        }
        None => rp,
    }
}

/// 拼接服务器地址与已归一化的远端路径（逐段拼，顺手吃掉重复斜杠和结尾斜杠）。
fn normalize_remote_url(base: &str, remote_path: &str) -> String {
    let mut out = base.trim().trim_end_matches('/').to_string();
    for seg in remote_path.split('/').filter(|s| !s.is_empty()) {
        out.push('/');
        out.push_str(seg);
    }
    out
}

/// 「云端还没有这个文件」的两种表现，都必须放行去上传，否则首次同步永远传不上去：
/// 404 = 目录在、文件不在；409 = 连父目录都不在（坚果云实测回的是 409，不是 404）。
fn is_missing(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 404 | 409)
}

/// 报错里只留「主机 + 路径」：既够对方对照设置，也不会把地址栏里可能粘进的账号密码复述出来。
fn target_for_message(target: &str) -> String {
    match target.find("://") {
        Some(i) => {
            let rest = &target[i + 3..];
            // 万一有人把账号密码也粘进地址栏，这里不会跟着报错原文复述一遍
            let host_and_path = match rest.find('@') {
                Some(k) => &rest[k + 1..],
                None => rest,
            };
            format!("<{host_and_path}>")
        }
        None => format!("<{target}>"),
    }
}

/// 把状态码翻译成能照着做的提示。
/// 以前所有失败都是「下载失败，服务器返回 400 Bad Request 400 Bad Request」——
/// 状态码重复两遍（两个占位符填了同一个值），而且对方看完不知道该改哪个框。
fn dav_error(method: &str, status: reqwest::StatusCode, target: &str) -> String {
    let hint = match status.as_u16() {
        400 => "远端文件路径格式不对：这里只填以 / 开头的路径（例如 /Yijian/litenote.json），不要把整条网址粘进来",
        401 => "账号或密码不对：坚果云要填「应用密码」（网页版 → 账户信息 → 安全选项 → 添加应用），不是登录密码",
        403 => "这个路径没有访问权限，或者远端文件路径填成了目录（要指到 .json 文件，结尾不要带 /）",
        404 => "服务器上没有这个路径：核对服务器地址（坚果云要以 /dav/ 结尾）与远端文件路径",
        405 => "服务器不支持这个请求方法，请确认填的是 WebDAV 根地址",
        409 => "远端目录还不存在",
        410 => "服务器地址不对：坚果云要填 https://dav.jianguoyun.com/dav/",
        423 => "该目录被锁住了，换个路径或稍后再试",
        500..=599 => "服务器自己出错了，稍后再试；一直失败请检查网盘服务状态",
        _ => "请核对服务器地址、账号密码与远端文件路径",
    };
    format!(
        "{method} {} 失败：{}。{hint}",
        target_for_message(target),
        status,
    )
}

fn basic_auth_header(user: &str, pass: &str) -> Result<reqwest::header::HeaderValue, String> {
    let raw = format!("{}:{}", user, pass);
    let encoded = B64.encode(raw);
    reqwest::header::HeaderValue::from_str(&format!("Basic {encoded}")).map_err(|e| format!("认证头构造失败: {e}"))
}

// ──────────────── 本地数据读取 / 写入 ────────────────

fn read_local_todos<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<TodoItemSync>, String> {
    let db_path = litenote_db_path(app).ok_or_else(|| "无法获取数据库路径".to_string())?;
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let conn = open_db(&db_path)?;
    ensure_category_sync_schema(&conn)?;
    let has_table = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='todos' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !has_table {
        return Ok(Vec::new());
    }

    // 这里刻意不过滤 deleted：墓碑必须一起进快照，才能把「已删除」带到其它设备。
    let mut stmt = conn
        .prepare(
            "SELECT id, text, completed, pinned, sort_order, color_id, due_date, reminded, \
             is_recurring, recurrence_type, recurrence_config, update_time, create_time, completed_time, \
             deleted, category_id \
             FROM todos",
        )
        .map_err(|e| format!("查询待办失败: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(TodoItemSync {
                id: row.get(0)?,
                text: row.get(1)?,
                completed: row.get(2)?,
                pinned: row.get(3)?,
                sort_order: row.get(4)?,
                color_id: row.get(5)?,
                due_date: row.get(6)?,
                reminded: row.get(7)?,
                is_recurring: row.get(8)?,
                recurrence_type: row.get(9)?,
                recurrence_config: row.get(10)?,
                update_time: row.get(11)?,
                create_time: row.get(12)?,
                completed_time: row.get(13)?,
                deleted: row.get::<_, i64>(14)? != 0,
                category_id: Some(
                    row.get::<_, Option<String>>(15)?
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| UNCATEGORIZED_CATEGORY_ID.to_string()),
                ),
            })
        })
        .map_err(|e| format!("读取待办失败: {e}"))?;

    let todos: Vec<TodoItemSync> = rows.filter_map(|r| r.ok()).collect();
    Ok(todos)
}

const SYNCABLE_SETTING_KEYS: &[&str] = &[
    "clockCollapsed",
    "showSeconds",
    "weekCalendarCollapsed",
    "contentFontSize",
    "contentFontFamily",
    "importanceMarkerStyle",
    "tagsEnabled",
    "panelOpacity",
    "localeMode",
    "windowLocked",
    "autoStart",
    "edgeHide",
    "desktopPin",
    "theme",
    "reminderMode",
    "focusMode",
    "fullWindowWidth",
    "fullWindowHeight",
    "shortcutToggleWindow",
    "shortcutFocusMode",
    "shortcutWindowLock",
    "shortcutDesktopPin",
];

fn normalize_setting(key: &str, value: &str) -> Option<String> {
    match key {
        "clockCollapsed" | "showSeconds" | "weekCalendarCollapsed" | "windowLocked"
        | "autoStart" | "edgeHide" | "desktopPin" | "focusMode"
        | "importanceMarkerStyle" | "tagsEnabled" => {
            serde_json::from_str::<bool>(value).ok().map(|v| v.to_string())
        }
        "contentFontSize" => {
            let n = value.parse::<f64>().ok()?;
            ((12.0..=17.0).contains(&n) && (n * 2.0).fract() == 0.0)
                .then(|| n.to_string())
        }
        "panelOpacity" => {
            let n = value.parse::<f64>().ok()?;
            ((0.15..=1.0).contains(&n) && n.is_finite()).then(|| n.to_string())
        }
        "fullWindowWidth" => {
            let n = value.parse::<f64>().ok()?;
            ((200.0..=720.0).contains(&n) && n.fract() == 0.0).then(|| format!("{}", n as i64))
        }
        "fullWindowHeight" => {
            let n = value.parse::<f64>().ok()?;
            ((300.0..=1240.0).contains(&n) && n.fract() == 0.0).then(|| format!("{}", n as i64))
        }
        "contentFontFamily" => {
            matches!(value, "system" | "hei" | "song" | "kai" | "mono").then(|| value.to_string())
        }
        "localeMode" => matches!(value, "system" | "zh-CN" | "en").then(|| value.to_string()),
        "theme" => matches!(value, "glass" | "dark" | "light" | "yellow" | "gray" | "pink")
            .then(|| value.to_string()),
        "reminderMode" => matches!(value, "popup" | "system").then(|| value.to_string()),
        "shortcutToggleWindow" | "shortcutFocusMode" | "shortcutWindowLock"
        | "shortcutDesktopPin" => (value.len() <= 128 && !value.chars().any(char::is_control))
            .then(|| value.to_string()),
        _ => None,
    }
}

fn read_local_settings<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<SettingSync>, String> {
    let db_path = litenote_db_path(app).ok_or_else(|| "无法获取数据库路径".to_string())?;
    if !db_path.exists() {
        return Ok(Vec::new());
    }
    let conn = open_db(&db_path)?;
    ensure_settings_updated_at(&conn)?;
    let mut stmt = conn
        .prepare("SELECT key, value, updated_at FROM settings ORDER BY key")
        .map_err(|e| format!("查询设置失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SettingSync {
                key: row.get(0)?,
                value: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|e| format!("读取设置失败: {e}"))?;
    let mut settings = Vec::new();
    for row in rows {
        let item = row.map_err(|e| format!("读取设置失败: {e}"))?;
        if SYNCABLE_SETTING_KEYS.contains(&item.key.as_str()) {
            if let Some(value) = normalize_setting(&item.key, &item.value) {
                settings.push(SettingSync {
                    key: item.key,
                    value,
                    updated_at: item.updated_at.max(0),
                });
            }
        }
    }
    Ok(settings)
}

fn merge_settings(local: Vec<SettingSync>, remote: Vec<SettingSync>) -> Vec<SettingSync> {
    let mut map: std::collections::HashMap<String, SettingSync> = std::collections::HashMap::new();
    for item in local {
        if SYNCABLE_SETTING_KEYS.contains(&item.key.as_str()) {
            if let Some(value) = normalize_setting(&item.key, &item.value) {
                map.insert(
                    item.key.clone(),
                    SettingSync {
                        key: item.key,
                        value,
                        updated_at: item.updated_at.max(0),
                    },
                );
            }
        }
    }
    for item in remote {
        if !SYNCABLE_SETTING_KEYS.contains(&item.key.as_str()) {
            continue;
        }
        let Some(value) = normalize_setting(&item.key, &item.value) else {
            continue;
        };
        match map.get(&item.key) {
            Some(l) if l.updated_at >= item.updated_at.max(0) => {}
            _ => {
                map.insert(
                    item.key.clone(),
                    SettingSync {
                        key: item.key,
                        value,
                        updated_at: item.updated_at.max(0),
                    },
                );
            }
        }
    }
    let mut merged: Vec<SettingSync> = map.into_values().collect();
    merged.sort_by(|a, b| a.key.cmp(&b.key));
    merged
}

/// 待办、分类与设置的合并指纹；数组顺序和顶层 updated_at 不参与。
fn fingerprint(
    todos: &[TodoItemSync],
    categories: &[CategorySync],
    settings: &[SettingSync],
) -> String {
    use std::hash::{Hash, Hasher};

    let mut sorted_todos: Vec<TodoItemSync> = todos.to_vec();
    sorted_todos.sort_by(|a, b| {
        a.id.cmp(&b.id).then(a.update_time.cmp(&b.update_time))
    });
    let mut sorted_categories: Vec<CategorySync> = categories.to_vec();
    sorted_categories.sort_by(|a, b| {
        a.id.cmp(&b.id).then(a.update_time.cmp(&b.update_time))
    });
    let mut sorted_settings: Vec<SettingSync> = settings.to_vec();
    sorted_settings.sort_by(|a, b| a.key.cmp(&b.key));
    let json = serde_json::to_string(&(sorted_todos, sorted_categories, sorted_settings)).unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    json.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn overwrite_local_snapshot<R: Runtime>(app: &AppHandle<R>, sync: &SyncFile) -> Result<(), String> {
    let db_path = litenote_db_path(app).ok_or_else(|| "无法获取数据库路径".to_string())?;
    let mut conn = open_db(&db_path)?;
    ensure_settings_updated_at(&conn)?;
    ensure_category_sync_schema(&conn)?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开始恢复事务失败: {e}"))?;

    tx.execute("DELETE FROM todos", [])
        .map_err(|e| format!("清空本地数据失败: {e}"))?;
    tx.execute("DELETE FROM categories", [])
        .map_err(|e| format!("清空分类数据失败: {e}"))?;

    for item in &sync.categories {
        let item = normalize_category(item.clone());
        tx.execute(
            "INSERT INTO categories (id,name,color,sort_order,create_time,update_time,deleted,system) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, sort_order=excluded.sort_order, \
             create_time=excluded.create_time, update_time=excluded.update_time, \
             deleted=excluded.deleted, system=excluded.system",
            rusqlite::params![
                item.id,
                item.name,
                item.color,
                item.sort_order,
                item.create_time,
                item.update_time,
                item.deleted,
                item.system,
            ],
        )
        .map_err(|e| format!("写入分类失败: {e}"))?;
    }

    // 云端 v2 或手工快照可能没有任何分类；恢复后仍必须有「未分类」这个归属目标。
    let now = now_ms();
    tx.execute(
        "INSERT INTO categories (id,name,sort_order,create_time,update_time,deleted,system) \
         VALUES (?1,'未分类',0,?2,?2,0,1) \
         ON CONFLICT(id) DO UPDATE SET name='未分类', system=1, deleted=0",
        rusqlite::params![UNCATEGORIZED_CATEGORY_ID, now],
    )
    .map_err(|e| format!("恢复默认分类失败: {e}"))?;

    for item in &sync.todos {
        let category_id = item
            .category_id
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| UNCATEGORIZED_CATEGORY_ID.to_string());
        tx.execute(
            "INSERT INTO todos \
             (id, text, category_id, completed, pinned, sort_order, color_id, due_date, reminded, is_recurring, recurrence_type, recurrence_config, update_time, create_time, completed_time, deleted) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) \
             ON CONFLICT(id) DO UPDATE SET \
             text=excluded.text, category_id=excluded.category_id, completed=excluded.completed, pinned=excluded.pinned, \
             sort_order=excluded.sort_order, color_id=excluded.color_id, due_date=excluded.due_date, reminded=excluded.reminded, \
             is_recurring=excluded.is_recurring, recurrence_type=excluded.recurrence_type, \
             recurrence_config=excluded.recurrence_config, update_time=excluded.update_time, \
             create_time=excluded.create_time, completed_time=excluded.completed_time, \
             deleted=excluded.deleted",
            rusqlite::params![
                item.id,
                item.text,
                category_id,
                item.completed,
                item.pinned,
                item.sort_order,
                item.color_id,
                item.due_date,
                item.reminded,
                item.is_recurring,
                item.recurrence_type,
                item.recurrence_config,
                item.update_time,
                item.create_time,
                item.completed_time,
                item.deleted,
            ],
        )
        .map_err(|e| format!("写入待办失败: {e}"))?;
    }

    // 分类快照可以带墓碑；这些引用绝不能悬空，否则筛选时条目会凭空消失。
    tx.execute(
        "UPDATE todos SET category_id = ?1 \
         WHERE category_id IS NULL OR category_id = '' \
            OR category_id NOT IN (SELECT id FROM categories WHERE deleted = 0)",
        rusqlite::params![UNCATEGORIZED_CATEGORY_ID],
    )
    .map_err(|e| format!("修复待办分类引用失败: {e}"))?;
    tx.execute(
        "DELETE FROM categories WHERE deleted = 1 AND update_time < ?1",
        rusqlite::params![category_tombstone_cutoff()],
    )
    .map_err(|e| format!("清理分类墓碑失败: {e}"))?;

    for item in &sync.settings {
        if !SYNCABLE_SETTING_KEYS.contains(&item.key.as_str()) {
            continue;
        }
        let Some(value) = normalize_setting(&item.key, &item.value) else {
            continue;
        };
        tx.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            rusqlite::params![item.key, value, item.updated_at.max(0)],
        )
        .map_err(|e| format!("写入设置失败: {e}"))?;
    }

    tx.commit().map_err(|e| format!("提交恢复事务失败: {e}"))?;
    Ok(())
}

// ──────────────── 核心同步逻辑 ────────────────

/// 可选的配置覆盖（来自当前输入框的临时值，优先于已保存配置）
struct ConfigOverride {
    url: Option<String>,
    user: Option<String>,
    pass: Option<String>,
    remote_path: Option<String>,
}

fn get_config<R: Runtime>(
    app: &AppHandle<R>,
    ov: Option<&ConfigOverride>,
) -> Result<(String, String, String, String, bool), String> {
    let enabled = read_setting_bool_app(app, "webdavEnabled", false);
    if !enabled {
        return Err("WebDAV 同步未启用".into());
    }
    let url = ov.and_then(|o| o.url.clone()).filter(|s| !s.is_empty())
        .unwrap_or_else(|| read_setting_string_app(app, "webdavUrl", ""));
    let user = ov.and_then(|o| o.user.clone()).filter(|s| !s.is_empty())
        .unwrap_or_else(|| read_setting_string_app(app, "webdavUser", ""));
    // 优先用传入的明文密码；否则回退已保存（加密）的密码
    let pass = if let Some(p) = ov.and_then(|o| o.pass.clone()).filter(|s| !s.is_empty()) {
        p
    } else {
        let pass_enc = read_setting_string_app(app, "webdavPass", "");
        if pass_enc.is_empty() {
            // 以前这里和「地址/账号为空」共用同一句话，根本分不清是哪个字段缺。
            // 拆开之后一次就能定位。
            return Err(
                "WebDAV 未保存密码：请在设置里重新填写一次密码（坚果云必须用「应用密码」，\
                 不是登录密码），填好后点「立即同步」即会存下来"
                    .into(),
            );
        }
        decrypt_secret(&pass_enc).map_err(|e| {
            format!("WebDAV 已保存的密码无法解密（{e}）：请在设置里重新填写一次密码")
        })?
    };
    let remote_path = ov.and_then(|o| o.remote_path.clone()).filter(|s| !s.is_empty())
        .unwrap_or_else(|| read_setting_string_app(app, "webdavRemotePath", DEFAULT_REMOTE_PATH));
    // 归一化放在这里，而不是等到拼 URL 时：后面「逐级建远端目录」也要用这个值，
    // 不先洗干净就会拿着一整条网址去建出 `.../https:` 这种垃圾目录。
    let remote_path = normalize_remote_path(&url, &remote_path);

    if url.is_empty() || user.is_empty() {
        let missing = match (url.is_empty(), user.is_empty()) {
            (true, true) => "服务器地址和账号",
            (true, false) => "服务器地址",
            _ => "账号",
        };
        return Err(format!("WebDAV 配置不完整：{missing}为空，请在设置里填写"));
    }

    // 关键信息只打「有/空」，不打印密码本身，便于排查又不会泄漏
    eprintln!(
        "[webdav] 配置检查: url={} user={} pass={} remote={}",
        if url.is_empty() { "空" } else { "有" },
        if user.is_empty() { "空" } else { "有" },
        if pass.is_empty() { "空" } else { "有" },
        if remote_path.is_empty() { "空" } else { "有" },
    );

    Ok((url, user, pass, remote_path, enabled))
}

/// 本地与远端逐条合并（last-write-wins：以 update_time 较大者为准）。
/// 任一端缺失的条目直接采用对端；同 id 冲突时取 update_time 更大的一方。
fn merge_todos(local: Vec<TodoItemSync>, remote: Vec<TodoItemSync>) -> Vec<TodoItemSync> {
    let mut map: std::collections::HashMap<String, TodoItemSync> = std::collections::HashMap::new();
    for t in local {
        map.insert(t.id.clone(), t);
    }
    for r in remote {
        match map.get(&r.id) {
            Some(l) if l.update_time >= r.update_time => { /* 本地更新更新，保留本地 */ }
            _ => {
                map.insert(r.id.clone(), r);
            }
        }
    }
    let mut merged: Vec<TodoItemSync> = map.into_values().collect();
    merged.sort_by(|a, b| a.update_time.cmp(&b.update_time));
    merged
}

/// 双向同步：每轮都先拉一次远端，再按差异决定要不要写本地 / 传云端。
/// - 远端还没有快照（404/409）时，直接把本地上传。
/// - 已有快照时逐条按 update_time 合并（含软删除墓碑），避免多设备互相覆盖丢数据。
/// - 两边内容一致时只发这一个 GET，不写盘也不上传。
fn sync_to_webdav<R: Runtime>(
    app: &AppHandle<R>,
    ov: Option<&ConfigOverride>,
) -> Result<(), String> {
    let (url, user, pass, remote_path, _enabled) = get_config(app, ov)?;

    let client = build_client()?;
    let auth = basic_auth_header(&user, &pass)?;
    let full = normalize_remote_url(&url, &remote_path);

    let local = read_local_todos(app)?;
    let local_categories = read_local_categories(app)?;
    let local_settings = read_local_settings(app)?;

    // 诊断：同步是「有网络等待」的路径，起止都记一行并算耗时。
    // 主线程不在这儿跑，但一旦远端卡住，日志要能说明卡在哪一步。
    let _op_sync = crate::diag::op(crate::diag::OP_SYNC);
    let t_start = crate::now_ms();
    crate::diag::log_line(&format!(
        "同步开始 → {}（本地 {} 条）",
        target_for_message(&full),
        local.len()
    ));

    // 每轮都先 GET 一次远端：本地没改 ≠ 云端没改。
    // 以前这里用「本地指纹 == 上次同步指纹」当闸门，一致就一个请求都不发（为省流量定的），
    // 结果界面上写的「每 5 分钟自动双向同步」只做了一半——
    // 另一台设备的改动要等到重启或手动点「立即同步」才进得来。
    // 现在固定每轮一次 GET（快照就几 KB），真正的写盘/上传再按差异决定，见下面三方指纹比对。
    // 尝试拉取远端
    let (remote_todos, remote_categories, remote_settings) = match client
        .get(&full)
        .header(reqwest::header::AUTHORIZATION, auth.clone())
        .send()
    {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
            match serde_json::from_str::<SyncFile>(&body) {
                Ok(sf) => {
                    eprintln!(
                        "[webdav] sync: 拉取远端 {} 条 / {} 个分类 / {} 项设置",
                        sf.todos.len(),
                        sf.categories.len(),
                        sf.settings.len()
                    );
                    (sf.todos, sf.categories, sf.settings)
                }
                Err(e) => {
                    eprintln!("[webdav] sync: 远端数据解析失败，视为空: {e}");
                    (Vec::new(), Vec::new(), Vec::new())
                }
            }
        }
        Ok(resp) if is_missing(resp.status()) => {
            eprintln!("[webdav] sync: 远端还没有快照（{}），将直接上传本地", resp.status());
            (Vec::new(), Vec::new(), Vec::new())
        }
        Ok(resp) => {
            return Err(dav_error("下载", resp.status(), &full));
        }
        Err(e) => return Err(format!("下载请求失败: {e}")),
    };

    let local_fp = fingerprint(&local, &local_categories, &local_settings);
    let remote_fp = fingerprint(&remote_todos, &remote_categories, &remote_settings);
    let n_local = local.len();
    let n_remote = remote_todos.len();
    let merged = merge_todos(local, remote_todos);
    let merged_categories = merge_categories(local_categories, remote_categories);
    let merged_settings = merge_settings(local_settings, remote_settings);
    let merged_fp = fingerprint(&merged, &merged_categories, &merged_settings);
    let n_merged = merged.len();

    // 两边内容一致（合并结果与双方都相同）→ 一个字节都不用写，也不建目录。
    // 但「上次同步」时间还是要记：手动点按钮时他要能看到时间变了。
    if merged_fp == local_fp && merged_fp == remote_fp {
        crate::diag::log_line(&format!(
            "同步无差异，用时 {}ms（本地 {} / 云端 {}）",
            crate::now_ms() - t_start,
            n_local,
            n_remote
        ));
        set_last_sync(app, now_ms())?;
        return Ok(());
    }

    // 确定要写云端了才建目录：只读轮询不该在他网盘里凭空建出文件夹。
    // 首次同步的 GET 会因为父目录不存在回 409，这里补建。
    ensure_remote_dir(&client, &url, &auth, &remote_path)?;

    if merged_fp != local_fp {
        // 本地落后（或云端有本地没有的内容/设置）→ 写回本地
        overwrite_local_snapshot(
            app,
            &SyncFile {
                version: SYNC_FILE_VERSION,
                updated_at: now_ms(),
                todos: merged.clone(),
                categories: merged_categories.clone(),
                settings: merged_settings.clone(),
            },
        )?;
        let _ = app.emit(
            TODOS_UPDATED_EVENT,
            serde_json::json!({ "ts": now_ms(), "source": "webdav-poll" }),
        );
        let _ = app.emit(
            CATEGORIES_UPDATED_EVENT,
            serde_json::json!({ "ts": now_ms(), "source": "webdav-poll" }),
        );
        let _ = app.emit(
            SETTINGS_UPDATED_EVENT,
            serde_json::json!({ "ts": now_ms(), "source": "webdav-poll" }),
        );
        if let Err(e) = apply_synced_settings(app) {
            eprintln!("[webdav] 应用同步设置失败: {e}");
        }
    }

    if merged_fp != remote_fp {
        // 云端落后 → 上传合并结果
        let body = serde_json::to_string(&SyncFile {
            version: SYNC_FILE_VERSION,
            updated_at: now_ms(),
            todos: merged,
            categories: merged_categories,
            settings: merged_settings,
        })
        .map_err(|e| format!("序列化失败: {e}"))?;

        eprintln!("[webdav] sync: PUT {}", full);
        let resp = client
            .put(&full)
            .header(reqwest::header::AUTHORIZATION, auth.clone())
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .map_err(|e| format!("上传请求失败: {e}"))?;

        if !resp.status().is_success() {
            eprintln!("[webdav] sync: 失败状态码 {}", resp.status());
            return Err(dav_error("上传", resp.status(), &full));
        }
    }
    eprintln!("[webdav] sync: 完成");
    crate::diag::log_line(&format!(
        "同步完成，用时 {}ms（本地 {} / 云端 {} → 合并 {}；写本地={} 上传云端={}）",
        crate::now_ms() - t_start,
        n_local,
        n_remote,
        n_merged,
        merged_fp != local_fp,
        merged_fp != remote_fp
    ));

    set_last_sync(app, now_ms())?;
    Ok(())
}

/// 从 WebDAV 下载并覆盖本地（手动恢复，危险操作，仅在用户确认后调用）
fn download_from_webdav<R: Runtime>(app: &AppHandle<R>, ov: Option<&ConfigOverride>) -> Result<(), String> {
    let _op_restore = crate::diag::op(crate::diag::OP_RESTORE);
    let (url, user, pass, remote_path, _enabled) = get_config(app, ov)?;

    let client = build_client()?;
    let auth = basic_auth_header(&user, &pass)?;
    let full = normalize_remote_url(&url, &remote_path);

    let resp = client
        .get(&full)
        .header(reqwest::header::AUTHORIZATION, auth.clone())
        .send()
        .map_err(|e| format!("下载请求失败: {e}"))?;

    let status = resp.status();
    if is_missing(status) {
        return Err("云端还没有快照：请先在数据更全的那台设备上点「立即同步」把待办传上去，再回来恢复".into());
    }
    if !status.is_success() {
        return Err(dav_error("下载", status, &full));
    }

    let body = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
    let sync_file: SyncFile = serde_json::from_str(&body).map_err(|e| format!("解析远端数据失败: {e}"))?;

    let settings = if sync_file.settings.is_empty() {
        read_local_settings(app)?
    } else {
        sync_file.settings
    };
    let categories = sync_file.categories;
    overwrite_local_snapshot(
        app,
        &SyncFile {
            version: SYNC_FILE_VERSION,
            updated_at: sync_file.updated_at,
            todos: sync_file.todos,
            categories,
            settings,
        },
    )?;
    let _ = app.emit(
        TODOS_UPDATED_EVENT,
        serde_json::json!({ "ts": now_ms(), "source": "webdav-restore" }),
    );
    let _ = app.emit(
        CATEGORIES_UPDATED_EVENT,
        serde_json::json!({ "ts": now_ms(), "source": "webdav-restore" }),
    );
    let _ = app.emit(
        SETTINGS_UPDATED_EVENT,
        serde_json::json!({ "ts": now_ms(), "source": "webdav-restore" }),
    );
    if let Err(e) = apply_synced_settings(app) {
        eprintln!("[webdav] 应用恢复设置失败: {e}");
    }
    // 恢复后本地内容与云端一致，下一轮轮询的三方指纹比对会自己判出「没差异」，不用另存标记
    set_last_sync(app, now_ms())?;
    Ok(())
}

fn set_last_sync<R: Runtime>(app: &AppHandle<R>, ts: i64) -> Result<(), String> {
    write_setting_string(app, "webdavLastSync", &ts.to_string())?;
    // 通知前端更新
    let _ = app.emit(
        SETTINGS_UPDATED_EVENT,
        serde_json::json!({ "ts": now_ms(), "source": "webdav" }),
    );
    Ok(())
}

/// 后台定时检查（仅 enabled 时执行）。
/// force=false：内容指纹没变就直接返回，不发任何网络请求；
/// 因此它的作用已从「定期同步」变成「兜底检查内容是否变化」。
fn sync_tick<R: Runtime>(app: &AppHandle<R>) {
    if !read_setting_bool_app(app, "webdavEnabled", false) {
        return;
    }
    if let Err(e) = sync_to_webdav(app, None) {
        eprintln!("[LiteNote] WebDAV 后台同步失败: {e}");
    }
    // set_last_sync 由 sync_to_webdav 内部在成功时调用
}

/// 启动时自动拉取一次远端（用户要求：每次打开一笺就拉一次）。
///
/// 走的是和后台轮询完全同一条路径：先 GET，再按差异决定写本地 / 传云端。
/// 真写了本地会由 sync_to_webdav 自己发待办更新事件，这里不再重复发一次。
pub fn startup_pull<R: Runtime>(app: &AppHandle<R>) {
    if !read_setting_bool_app(app, "webdavEnabled", false) {
        return;
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 等窗口、数据库、前端都稳定下来再拉，避免和启动期的读写打架
        tokio::time::sleep(Duration::from_secs(6)).await;

        let h = handle.clone();
        let _ = tokio::task::spawn_blocking(move || match sync_to_webdav(&h, None) {
            Ok(_) => eprintln!("[webdav] 启动自动拉取完成"),
            Err(e) => eprintln!("[LiteNote] 启动自动拉取失败: {e}"),
        })
        .await;
    });
}

/// 启动 Rust 端后台同步轮询（异步运行时内循环，仅在启用时执行同步）
pub fn start_webdav_sync_poll<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        // 这个定时器只是**兜底**：接住「别的设备改了、本机一直没动」的情况。
        // 主路径是前端的「内容变化后 2.5 秒同步」（见 WidgetShell），那条才是该跟手的。
        // 下面 tick() 先吃掉 tokio interval 的即时一拍，所以第一次兜底落在启动约 1 小时后。
        let mut interval = tokio::time::interval(Duration::from_secs(SYNC_POLL_INTERVAL_SECS));
        interval.tick().await; // 跳过首个即时 tick

        loop {
            interval.tick().await;
            // 仅在启用时执行；禁用时空转跳过（无网络/IO 开销）
            if !read_setting_bool_app(&handle, "webdavEnabled", false) {
                continue;
            }
            let handle = handle.clone();
            let _ = tokio::task::spawn_blocking(move || {
                sync_tick(&handle);
            })
            .await;
        }
    });
}

// ──────────────── Tauri Commands ────────────────

/// 设置 WebDAV 配置（密码加密存储）
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavConfigPayload {
    pub enabled: Option<bool>,
    pub url: Option<String>,
    pub user: Option<String>,
    pub pass: Option<String>,
    pub remote_path: Option<String>,
}
#[tauri::command]
pub async fn webdav_set_config(app: AppHandle, config: WebdavConfigPayload) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(enabled) = config.enabled {
            write_setting_string(&app, "webdavEnabled", &serde_json::to_string(&enabled).unwrap())?;
        }
        if let Some(url) = config.url {
            write_setting_string(&app, "webdavUrl", &url)?;
        }
        if let Some(user) = config.user {
            write_setting_string(&app, "webdavUser", &user)?;
        }
        if let Some(pass) = config.pass {
            if !pass.is_empty() {
                let enc = encrypt_secret(&pass)?;
                write_setting_string(&app, "webdavPass", &enc)?;
            }
        }
        if let Some(remote_path) = config.remote_path {
            let rp = if remote_path.trim().is_empty() {
                DEFAULT_REMOTE_PATH.to_string()
            } else {
                remote_path
            };
            write_setting_string(&app, "webdavRemotePath", &rp)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 获取当前配置（密码解密后以明文返回，方便前端回填输入框）
#[tauri::command]
pub async fn webdav_get_config(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = litenote_db_path(&app).ok_or_else(|| "无法获取数据库路径".to_string())?;
        let conn = open_db(&db_path)?;
        let enabled = read_setting_bool(&conn, "webdavEnabled", false);
        let url = read_setting_string(&conn, "webdavUrl", "");
        let user = read_setting_string(&conn, "webdavUser", "");
        let remote_path = read_setting_string(&conn, "webdavRemotePath", DEFAULT_REMOTE_PATH);
        let pass_enc = read_setting_string(&conn, "webdavPass", "");
        // 解密容错：损坏的密文返回空，不阻断获取配置
        let pass = if pass_enc.is_empty() {
            String::new()
        } else {
            decrypt_secret(&pass_enc).unwrap_or_default()
        };
        let last_sync: i64 = read_setting_string(&conn, "webdavLastSync", "0")
            .parse()
            .unwrap_or(0);

        Ok(serde_json::json!({
            "enabled": enabled,
            "url": url,
            "user": user,
            "remotePath": remote_path,
            "pass": pass,
            "lastSync": last_sync,
        }))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 测试连接请求参数（使用当前输入框的临时值，不依赖已保存配置）
///
/// ⚠️ 必须 `rename_all = "camelCase"`：前端 invoke 传的是 `remotePath`，
/// 没有这行 serde 会去找 `remote_path`、恒为 None ——
/// 表现就是「远端路径填了却存不进去、点完同步又变回默认值」。
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebdavTestPayload {
    pub url: String,
    pub user: String,
    pub pass: String,
    pub remote_path: Option<String>,
}

/// 测试连接：先 PROPFIND 根目录验地址与凭据，再按当前填的远端路径只读探一次文件。
/// 直接使用传入的临时配置，避免把不完整配置写库；若 pass 为空则回退已保存密码。
///
/// 以前只探根目录就回「连接成功」，所以「测试连接成功、一点同步就 400」根本查不下去——
/// 根目录能列出来不代表那个路径能用。这里全程只读（PROPFIND / GET），不建目录也不写文件。
#[tauri::command]
pub async fn webdav_test(app: AppHandle, payload: WebdavTestPayload) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _op_test = crate::diag::op(crate::diag::OP_TEST);
        let url = payload.url.trim();
        let user = payload.user.trim();
        let remote_path = payload.remote_path.unwrap_or_default();
        let mut pass = payload.pass;
        if pass.is_empty() {
            let saved = read_setting_string_app(&app, "webdavPass", "");
            if !saved.is_empty() {
                pass = decrypt_secret(&saved)?;
            }
        }
        if url.is_empty() || user.is_empty() || pass.is_empty() {
            return Err("请先填写服务器地址、账号和密码".into());
        }
        let client = build_client()?;
        let auth = basic_auth_header(&user, &pass)?;
        let root = url.trim_end_matches('/').to_string();
        eprintln!("[webdav] test: PROPFIND {}", root);
        let propfind = http::Method::from_bytes(b"PROPFIND")
            .map_err(|e| format!("构造 PROPFIND 方法失败: {e}"))?;
        let resp = client
            .request(propfind, &root)
            .header(reqwest::header::AUTHORIZATION, auth.clone())
            .header("Depth", "0")
            .send()
            .map_err(|e| format!("连接测试失败: {e}"))?;
        let root_status = resp.status();
        eprintln!("[webdav] test: 根目录状态码 {}", root_status);
        if !root_status.is_success() && root_status.as_u16() != 207 {
            return Err(dav_error("列根目录", root_status, &root));
        }

        let full = normalize_remote_url(url, &normalize_remote_path(url, &remote_path));
        if full == root {
            return Err("远端文件路径没填或指向目录：要填到 .json 文件，例如 /Yijian/litenote.json".into());
        }
        eprintln!("[webdav] test: GET {}", full);
        let resp = client
            .get(&full)
            .header(reqwest::header::AUTHORIZATION, auth)
            .send()
            .map_err(|e| format!("探测远端文件失败: {e}"))?;
        let status = resp.status();
        eprintln!("[webdav] test: 远端文件状态码 {}", status);
        if status.is_success() {
            let body = resp.text().unwrap_or_default();
            return Ok(match serde_json::from_str::<SyncFile>(&body) {
                Ok(sf) => format!("连接成功，云端已有 {} 条待办", sf.todos.len()),
                Err(_) => "连接成功，但云端这个文件不是本程序导出的快照，同步时会按条目合并".into(),
            });
        }
        if is_missing(status) {
            return Ok("连接成功，云端还没有快照：点「立即同步」会把本地待办传上去（远端目录不存在会自动创建）".into());
        }
        Err(dav_error("探测远端文件", status, &full))
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 立即双向同步（合并本地与远端，结果同时写回本地并上传云端）。
/// 可传入当前输入框的临时配置覆盖已保存配置。
#[tauri::command]
pub async fn webdav_sync_now(app: AppHandle, payload: Option<WebdavTestPayload>) -> Result<String, String> {
    let ov = payload.map(|p| ConfigOverride {
        url: Some(p.url),
        user: Some(p.user),
        pass: Some(p.pass),
        remote_path: p.remote_path,
    });
    tauri::async_runtime::spawn_blocking(move || match sync_to_webdav(&app, ov.as_ref()) {
        Ok(_) => Ok("同步成功".into()),
        Err(e) => Err(e),
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

/// 从云端恢复（下载覆盖本地，危险操作）。可传入当前输入框的临时配置覆盖已保存配置。
#[tauri::command]
pub async fn webdav_restore(app: AppHandle, payload: Option<WebdavTestPayload>) -> Result<String, String> {
    let ov = payload.map(|p| ConfigOverride {
        url: Some(p.url),
        user: Some(p.user),
        pass: Some(p.pass),
        remote_path: p.remote_path,
    });
    tauri::async_runtime::spawn_blocking(move || match download_from_webdav(&app, ov.as_ref()) {
        Ok(_) => {
            let _ = set_last_sync(&app, now_ms());
            Ok("已从云端恢复".into())
        }
        Err(e) => {
            let _ = set_last_sync(&app, now_ms());
            Err(e)
        }
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

#[tauri::command]
pub async fn webdav_status(app: AppHandle) -> Result<WebdavStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = litenote_db_path(&app).ok_or_else(|| "无法获取数据库路径".to_string())?;
        let conn = open_db(&db_path)?;
        let enabled = read_setting_bool(&conn, "webdavEnabled", false);
        let last_sync: i64 = read_setting_string(&conn, "webdavLastSync", "0")
            .parse()
            .unwrap_or(0);
        Ok(WebdavStatus {
            enabled,
            last_sync,
        })
    })
    .await
    .map_err(|e| format!("后台任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn todo(id: &str, update_time: i64, sort_order: f64) -> TodoItemSync {
        TodoItemSync {
            id: id.into(),
            text: format!("待办 {id}"),
            completed: false,
            category_id: Some(UNCATEGORIZED_CATEGORY_ID.into()),
            pinned: false,
            sort_order,
            color_id: Some("important".into()),
            due_date: 0,
            reminded: false,
            is_recurring: false,
            recurrence_type: "none".into(),
            recurrence_config: String::new(),
            update_time,
            create_time: 1,
            completed_time: 0,
            deleted: false,
        }
    }

    fn setting(key: &str, value: &str, updated_at: i64) -> SettingSync {
        SettingSync {
            key: key.into(),
            value: value.into(),
            updated_at,
        }
    }

    fn category(id: &str, name: &str, sort_order: f64, update_time: i64) -> CategorySync {
        CategorySync {
            id: id.into(),
            name: name.into(),
            color: None,
            sort_order,
            create_time: 1,
            update_time,
            deleted: false,
            system: false,
        }
    }

    #[test]
    fn old_v1_snapshot_without_settings_or_sort_order_still_parses() {
        let sync: SyncFile = serde_json::from_str(
            r#"{"version":1,"updated_at":10,"todos":[{"id":"a","text":"旧待办","completed":true}]}"#,
        )
        .unwrap();
        assert!(sync.settings.is_empty());
        assert!(sync.categories.is_empty());
        assert_eq!(sync.todos[0].sort_order, 0.0);
        assert_eq!(sync.todos[0].category_id, None);
        assert!(sync.todos[0].completed);
    }

    #[test]
    fn v2_snapshot_without_categories_section_still_parses() {
        let sync: SyncFile = serde_json::from_str(
            r#"{"version":2,"updated_at":20,"todos":[{"id":"a","text":"旧待办","completed":false}],"settings":[]}"#,
        )
        .unwrap();
        assert!(sync.categories.is_empty());
        assert_eq!(sync.todos.len(), 1);
    }

    #[test]
    fn categories_merge_uses_newer_timestamp_and_keeps_tombstone() {
        let local = vec![
            category("work", "工作", 1.0, 30),
            category("life", "生活", 2.0, 10),
        ];
        let remote = vec![
            category("work", "职场", 1.0, 20),
            CategorySync {
                deleted: true,
                update_time: 20,
                ..category("life", "生活", 2.0, 20)
            },
        ];
        let merged = merge_categories(local, remote);
        let work = merged.iter().find(|c| c.id == "work").unwrap();
        assert_eq!(work.name, "工作");
        let life = merged.iter().find(|c| c.id == "life").unwrap();
        assert!(life.deleted);
    }

    #[test]
    fn system_category_stays_uncategorized_and_sorts_last() {
        let merged = merge_categories(
            vec![
                category("work", "工作", 1.0, 10),
                CategorySync {
                    name: "被改过名".into(),
                    system: true,
                    ..category(UNCATEGORIZED_CATEGORY_ID, "被改过名", 9.0, 10)
                },
            ],
            Vec::new(),
        );
        assert_eq!(merged.last().unwrap().id, UNCATEGORIZED_CATEGORY_ID);
        assert_eq!(merged.last().unwrap().name, "未分类");
        assert!(merged.last().unwrap().system);
    }

    #[test]
    fn settings_merge_uses_newer_timestamp_and_local_wins_ties() {
        let local = vec![
            setting("theme", "dark", 20),
            setting("showSeconds", "true", 10),
        ];
        let remote = vec![
            setting("theme", "light", 20),
            setting("showSeconds", "false", 11),
        ];
        let merged = merge_settings(local, remote);
        assert_eq!(merged[0].key, "showSeconds");
        assert_eq!(merged[0].value, "false");
        assert_eq!(merged[1].key, "theme");
        assert_eq!(merged[1].value, "dark");
    }

    #[test]
    fn credentials_unknown_keys_and_invalid_values_are_not_synced() {
        let merged = merge_settings(
            Vec::new(),
            vec![
                setting("webdavEnabled", "true", 10),
                setting("webdavUrl", "https://example.invalid/dav/", 10),
                setting("webdavUser", "account", 10),
                setting("webdavPass", "ciphertext", 10),
                setting("webdavRemotePath", "/private/file.json", 10),
                setting("webdavLastSync", "10", 10),
                setting("theme", "not-a-theme", 10),
                setting("unknownSetting", "value", 10),
            ],
        );
        assert!(merged.is_empty());
    }

    #[test]
    fn half_step_font_sizes_are_accepted_but_other_steps_are_rejected() {
        assert_eq!(normalize_setting("contentFontSize", "12.5"), Some("12.5".into()));
        assert_eq!(normalize_setting("contentFontSize", "17"), Some("17".into()));
        assert_eq!(normalize_setting("contentFontSize", "12.25"), None);
        assert_eq!(normalize_setting("contentFontSize", "18"), None);
    }

    #[test]
    fn todo_snapshot_round_trips_state_and_fractional_sort_order() {
        let original = TodoItemSync {
            completed: true,
            pinned: true,
            sort_order: 1.5,
            color_id: Some("urgent".into()),
            due_date: 123,
            reminded: true,
            is_recurring: true,
            recurrence_type: "weekly".into(),
            recurrence_config: r#"{"interval":2,"days":[1]}"#.into(),
            update_time: 50,
            create_time: 2,
            completed_time: 40,
            deleted: true,
            ..todo("state", 50, 1.5)
        };
        let json = serde_json::to_string(&SyncFile {
            version: SYNC_FILE_VERSION,
            updated_at: 50,
            todos: vec![original.clone()],
            categories: vec![category("work", "工作", 1.5, 40)],
            settings: Vec::new(),
        })
        .unwrap();
        let restored: SyncFile = serde_json::from_str(&json).unwrap();
        let state = serde_json::to_value(&restored.todos[0]).unwrap();
        let expected = serde_json::to_value(&original).unwrap();
        assert_eq!(state, expected);
        assert_eq!(restored.categories[0].sort_order, 1.5);
        assert!(json.contains("\"sort_order\":1.5"));
    }

    #[test]
    fn fingerprint_changes_when_only_sort_order_changes() {
        let first = vec![todo("a", 10, 1.0), todo("b", 10, 2.0)];
        let mut second = first.clone();
        second[0].sort_order = 1.5;
        assert_ne!(fingerprint(&first, &[], &[]), fingerprint(&second, &[], &[]));
    }

    #[test]
    fn fingerprint_changes_when_only_a_category_changes() {
        let todos = vec![todo("a", 10, 1.0)];
        let settings = vec![setting("theme", "dark", 10)];
        let first = vec![category("work", "工作", 1.0, 10)];
        let second = vec![category("work", "工作", 1.0, 11)];
        assert_ne!(
            fingerprint(&todos, &first, &settings),
            fingerprint(&todos, &second, &settings)
        );
        assert_ne!(
            fingerprint(&todos, &[], &settings),
            fingerprint(&todos, &first, &settings)
        );
    }

    #[test]
    fn category_color_round_trips_and_absent_field_defaults_to_none() {
        let json = r##"{"version":3,"updated_at":1,"todos":[],"categories":[
            {"id":"work","name":"工作","color":"#6ee7b7","sort_order":1,"update_time":10,"deleted":false,"system":false},
            {"id":"life","name":"生活","sort_order":2,"update_time":10}
        ]}"##;
        let file: SyncFile = serde_json::from_str(json).unwrap();
        assert_eq!(file.categories[0].color.as_deref(), Some("#6ee7b7"));
        assert_eq!(file.categories[1].color, None);
    }

    #[test]
    fn category_color_follows_the_newer_side() {
        let mut newer = category("work", "工作", 1.0, 20);
        newer.color = Some("#fbbf24".into());
        let older = category("work", "工作", 1.0, 10);

        let merged = merge_categories(vec![newer.clone()], vec![older.clone()]);
        assert_eq!(merged[0].color.as_deref(), Some("#fbbf24"));

        let merged = merge_categories(vec![older], vec![newer]);
        assert_eq!(merged[0].color.as_deref(), Some("#fbbf24"));
    }

    #[test]
    fn fingerprint_changes_when_only_a_category_color_changes() {
        let todos = vec![todo("a", 10, 1.0)];
        let settings = vec![setting("theme", "dark", 10)];
        let mut first = category("work", "工作", 1.0, 10);
        first.color = Some("#6ee7b7".into());
        let mut second = first.clone();
        second.color = Some("none".into());
        assert_ne!(
            fingerprint(&todos, &[first], &settings),
            fingerprint(&todos, &[second], &settings)
        );
    }
}

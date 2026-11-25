//! 运行诊断：文件日志 + 主线程心跳看门狗 + 「最后一步操作」标记。
//!
//! 为什么需要它：发布版是 GUI 子系统（`windows_subsystem = "windows"`，没有控制台），
//! 代码里散落的 `println!` / `eprintln!` 写出去没人看，等于全部丢弃。
//! 于是「主线程偶尔死锁、界面点不动」这种问题在现场一点痕迹都不留：
//! Windows 只留下一个 `0xc0000409` 的崩溃记录，`strip = "symbols"` 又把堆栈抹了。
//!
//! 这里补最小可用的一手：
//! - 日志落到 `<appData>/logs/run.log`（超 2MB 轮转一份 `.1`）；
//! - 每 1 秒往主线程塞一个空闭包刷新心跳时间戳；
//! - 独立看门狗发现心跳超过 3 秒没动，就记下「无响应多久 + 最后进入哪个操作 + 该操作持续多久」，
//!   并在恢复时补一行——间歇性挂起往往没人来得及抓现场，日志能自己说话。
//!
//! 两条硬规矩：
//! 1. **诊断自己不许成为死锁的一环**：状态全用原子量，操作名走固定表 + 索引，不引入任何锁。
//! 2. **任何一步失败都不许 panic**：日志写不进去就安静放弃。

use std::fs::{OpenOptions, rename};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use chrono::Local;
use tauri::{AppHandle, Manager, Runtime};

/// 操作名表。索引必须和下面的 OP_* 常量一一对应。
pub const OP_NAMES: &[&str] = &[
    "（无进行中操作）",
    "钉桌面-施加(pin)",
    "钉桌面-摘下(unpin)",
    "钉桌面-同步状态",
    "停靠状态上报",
    "重建托盘菜单",
    "重注册全局快捷键",
    "提醒-查询到期",
    "提醒-创建弹窗",
    "同步-双向同步",
    "同步-从云端恢复",
    "同步-测试连接",
    "窗口-显示主面板",
    "窗口-隐藏主面板",
    "窗口-切换专注模式",
    "窗口-切换锁定",
];

pub const OP_PIN: usize = 1;
pub const OP_UNPIN: usize = 2;
pub const OP_SYNC_PIN: usize = 3;
pub const OP_DOCK: usize = 4;
pub const OP_TRAY: usize = 5;
pub const OP_SHORTCUTS: usize = 6;
pub const OP_REMIND_QUERY: usize = 7;
pub const OP_REMIND_POPUP: usize = 8;
pub const OP_SYNC: usize = 9;
pub const OP_RESTORE: usize = 10;
pub const OP_TEST: usize = 11;
pub const OP_SHOW: usize = 12;
pub const OP_HIDE: usize = 13;
pub const OP_FOCUS: usize = 14;
pub const OP_LOCK: usize = 15;

static OP: AtomicUsize = AtomicUsize::new(0);
static OP_T0: AtomicI64 = AtomicI64::new(0);
static BEAT_MS: AtomicI64 = AtomicI64::new(0);
static HEARTBEAT_STARTED: AtomicBool = AtomicBool::new(false);
static LOG_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

fn log_dir() -> Option<PathBuf> {
    LOG_DIR.get().and_then(|o| o.clone())
}

/// 写一行日志。任何失败都安静忽略——诊断不能把应用带下水。
pub fn log_line(msg: &str) {
    let Some(dir) = log_dir() else { return };
    let path = dir.join("run.log");
    // 轮转：超过上限就把旧的挪走，只留一份历史
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = rename(&path, dir.join("run.log.1"));
        }
    }
    let line = format!("{} | {}\n", Local::now().format("%Y-%m-%d %H:%M:%S%.3f"), msg);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// 标记「进入某个操作」，返回的守卫在离开作用域时清掉。
///
/// **只认主线程**：看门狗要回答的是「主线程卡在哪儿」，而命令处理、同步、提醒轮询
/// 都跑在别的线程上。如果谁都能写这个标记，报出来的操作名就可能是别的线程的，
/// 反而把人带偏。非主线程调用拿到的是空守卫，什么也不记。
///
/// 不做嵌套（内层退出会把标记清成「无」），所以只打在确实想知道的那一步上。
pub struct OpGuard {
    tracked: bool,
}

pub fn op(idx: usize) -> OpGuard {
    let tracked = is_main_thread();
    if tracked {
        OP.store(idx, Ordering::Relaxed);
        OP_T0.store(crate::now_ms(), Ordering::Relaxed);
    }
    OpGuard { tracked }
}

impl Drop for OpGuard {
    fn drop(&mut self) {
        if self.tracked {
            OP.store(0, Ordering::Relaxed);
            OP_T0.store(0, Ordering::Relaxed);
        }
    }
}

static MAIN_TID: OnceLock<std::thread::ThreadId> = OnceLock::new();

fn is_main_thread() -> bool {
    match MAIN_TID.get() {
        Some(t) => *t == std::thread::current().id(),
        // 还没记录过主线程 id（理论上只在 init 之前的极早期）：宁可不记，也不记错
        None => false,
    }
}

/// 挂死现场自动落一份 minidump。
///
/// 为什么值得做：光有「最后进入哪个操作」还是粗的，真正定死原因要的是主线程当时的调用栈。
/// 之前一次挂起只能靠外部抓 dump，而 `strip = "symbols"` 让 PDB 只剩 743 个函数，
/// 深帧全是栈扫描噪音。现在诊断版保留符号，配合 dump_syms + minidump-stackwalk
/// （本机已装好）就能把栈读出来。
///
/// 用 LoadLibrary + GetProcAddress 取 MiniDumpWriteDump，不给构建加 dbghelp.lib 的链接依赖。
/// 只留最近 3 份，超过就删最旧的——MiniDumpWithThreadInfo 那份大概几 MB 到几十 MB。
#[cfg(windows)]
pub fn write_hang_dump() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    type MiniDumpFn = unsafe extern "system" fn(
        h_process: *mut core::ffi::c_void,
        pid: u32,
        h_file: *mut core::ffi::c_void,
        dump_type: u32,
        exception_param: *mut core::ffi::c_void,
        user_stream: *mut core::ffi::c_void,
        comment_stream: *mut core::ffi::c_void,
    ) -> i32;

    extern "system" {
        fn GetCurrentProcess() -> *mut core::ffi::c_void;
        fn CreateFileW(
            name: *const u16,
            access: u32,
            share: u32,
            security: *mut core::ffi::c_void,
            disposition: u32,
            flags: u32,
            template: *mut core::ffi::c_void,
        ) -> *mut core::ffi::c_void;
        fn CloseHandle(h: *mut core::ffi::c_void) -> i32;
        fn LoadLibraryW(name: *const u16) -> *mut core::ffi::c_void;
        fn GetProcAddress(module: *mut core::ffi::c_void, name: *const i8) -> Option<extern "system" fn()>;
    }

    let Some(dir) = log_dir() else { return };
    let wide = |s: &str| -> Vec<u16> { OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect() };

    unsafe {
        let dbghelp = LoadLibraryW(wide("dbghelp.dll").as_ptr());
        if dbghelp.is_null() {
            log_line("挂死转储失败：加载不了 dbghelp.dll");
            return;
        }
        let addr = GetProcAddress(dbghelp, b"MiniDumpWriteDump\0".as_ptr() as *const i8);
        let Some(addr) = addr else {
            log_line("挂死转储失败：dbghelp 里没有 MiniDumpWriteDump");
            return;
        };
        // 取函数指针：extern "system" fn() 的地址就是目标函数地址
        let dump: MiniDumpFn = core::mem::transmute::<*mut core::ffi::c_void, MiniDumpFn>(addr as *mut core::ffi::c_void);

        let path = dir.join(format!("hang-{}.dmp", crate::now_ms()));
        let h_file = CreateFileW(
            wide(&path.to_string_lossy()).as_ptr(),
            0x40000000, // GENERIC_WRITE
            0,
            core::ptr::null_mut(),
            2,          // CREATE_ALWAYS
            0x80,       // FILE_ATTRIBUTE_NORMAL
            core::ptr::null_mut(),
        );
        if h_file == -1 as _ || h_file.is_null() {
            log_line(&format!("挂死转储失败：打不开 {}", path.display()));
            return;
        }
        // MiniDumpNormal(0) | MiniDumpWithThreadInfo(0x1000)：含线程上下文与各线程栈内存，够读栈
        let ok = dump(GetCurrentProcess(), std::process::id(), h_file, 0x1000, core::ptr::null_mut(), core::ptr::null_mut(), core::ptr::null_mut());
        CloseHandle(h_file);
        log_line(&format!(
            "挂死转储{}：{}",
            if ok != 0 { "已写" } else { "失败" },
            path.display()
        ));
    }

    // 只留最近 3 份
    let mut dumps: Vec<_> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("hang-") && n.ends_with(".dmp")).unwrap_or(false))
            .collect(),
        Err(_) => return,
    };
    if dumps.len() <= 3 {
        return;
    }
    dumps.sort();
    for old in dumps.drain(..dumps.len() - 3) {
        let _ = std::fs::remove_file(old);
    }
}

#[cfg(not(windows))]
pub fn write_hang_dump() {}

/// 初始化日志目录并写一行启动记录。在 setup 里调用（setup 跑在主线程，正好用来认主线程）。
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let _ = MAIN_TID.set(std::thread::current().id());
    let dir = app
        .path()
        .app_data_dir()
        .ok()
        .map(|p| p.join("logs"));
    if let Some(d) = &dir {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = LOG_DIR.set(dir.clone());
    let ver = app.package_info().version.to_string();
    log_line(&format!(
        "=== 启动 v{} pid={} ===",
        ver,
        std::process::id()
    ));
    match dir {
        Some(d) => log_line(&format!("日志目录 {}", d.display())),
        None => eprintln!("[diag] 拿不到 app_data_dir，日志不可用"),
    }
}

/// 心跳 + 看门狗。只启动一次。
///
/// 挂死之后不再往主线程队列里塞闭包：那些闭包会永远排在一个不泵消息的队列里，
/// 无界堆积反而把现场搞得更难读。
pub fn start_heartbeat<R: Runtime>(app: &AppHandle<R>) {
    if HEARTBEAT_STARTED.swap(true, Ordering::Relaxed) {
        return;
    }
    BEAT_MS.store(crate::now_ms(), Ordering::Relaxed);
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut stalled_since: i64 = 0;
        let mut last_report = 0i64;
        loop {
            // 1 秒一次：再密就变成给主线程常驻加负载，对挂件不划算
            std::thread::sleep(Duration::from_millis(1000));
            let now = crate::now_ms();
            let beat = BEAT_MS.load(Ordering::Relaxed);
            let age = now - beat;
            if age <= 3000 {
                if stalled_since != 0 {
                    log_line(&format!(
                        "主线程恢复，本次无响应约 {}ms",
                        now - stalled_since
                    ));
                    stalled_since = 0;
                    last_report = 0;
                }
                let _ = handle.run_on_main_thread(|| {
                    BEAT_MS.store(crate::now_ms(), Ordering::Relaxed);
                });
                continue;
            }
            if stalled_since == 0 {
                stalled_since = beat;
                // 每一轮挂起只落一次现场，避免反复写大文件
                write_hang_dump();
            }
            if now - last_report < 10000 {
                continue;
            }
            last_report = now;
            let idx = OP.load(Ordering::Relaxed);
            let name = OP_NAMES.get(idx).copied().unwrap_or("?");
            let t0 = OP_T0.load(Ordering::Relaxed);
            let op_age = if t0 > 0 { now - t0 } else { -1 };
            log_line(&format!(
                "主线程无响应 {}ms｜最后进入的操作＝{}｜该操作已持续 {}ms",
                age, name, op_age
            ));
        }
    });
}

/// 供心跳闭包调用：主线程真的在跑才会执行到这里。
pub fn beat() {
    BEAT_MS.store(crate::now_ms(), Ordering::Relaxed);
}

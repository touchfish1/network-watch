//! 后端常量集中定义。
//!
//! 这些常量用于在各模块之间共享“稳定的字符串/时间参数”，避免散落的 magic string：\n+//! - 窗口 label：用于通过 `AppHandle::get_webview_window` 获取主窗口\n+//! - 事件名：后端向前端广播系统采样快照\n+//! - 托盘菜单 ID：用于在 `MenuEvent` 中匹配点击项\n+//! - Windows 专用参数：置顶 guard 的轮询间隔\n+
/// 主窗口 label（需与 `tauri.conf.json` 中的 label 匹配）。
pub const WINDOW_LABEL: &str = "main";

/// 系统采样快照事件名（前端通过 event listener 订阅）。
pub const EVENT_SYSTEM_SNAPSHOT: &str = "system-snapshot";

/// 托盘菜单：显示/隐藏主窗口。
pub const MENU_TOGGLE_WINDOW: &str = "toggle-window";
/// 托盘菜单：开机启动开关。
pub const MENU_AUTOSTART: &str = "toggle-autostart";
/// 托盘菜单：鼠标穿透开关（Windows）。
pub const MENU_CLICK_THROUGH: &str = "toggle-click-through";
/// 托盘菜单：退出应用（会先尝试保存窗口状态）。
pub const MENU_QUIT: &str = "quit";

/// Windows：置顶守护线程轮询间隔（毫秒）。
///
/// 背景：在部分系统/窗口管理器交互下，窗口的 topmost 层级可能被“悄悄打掉”。\n+/// 该 guard 会在窗口可见时周期性重应用 overlay 策略，以降低边缘问题概率。
#[cfg(target_os = "windows")]
pub const WINDOW_TOPMOST_GUARD_INTERVAL_MS: u64 = 1200;


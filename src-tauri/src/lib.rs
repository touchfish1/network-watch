//! Tauri 后端入口与模块编排。
//!
//! 这个 crate 负责把几个相对独立的能力组合成一个“常驻置顶悬浮窗”应用：
//! - `tray`：托盘菜单与开机启动开关
//! - `windowing`：窗口初始化、关闭拦截、显示/隐藏切换与事件分发
//! - `sampler`：系统指标采样线程，按固定周期向前端广播 `system-snapshot`
//! - `overlay`：置顶/不抢焦点/仍可点击的窗口叠加策略（Windows 额外有 topmost guard）
//! - `diagnostics`/`state`：跨线程状态与诊断数据（供前端排障/显示）
//!
//! 前端通过 `invoke` 调用少量命令（例如切换 overlay 交互性），并通过事件订阅接收采样快照。
mod constants;
#[cfg(target_os = "windows")]
mod click_through_bus;
mod diagnostics;
mod overlay;
mod sampler;
mod state;
mod tray;
mod windowing;
mod web_server;
#[cfg(target_os = "windows")]
mod windows_connections;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use diagnostics::get_runtime_diagnostics;
use overlay::set_overlay_interactive;
#[cfg(target_os = "windows")]
use overlay::set_click_through_enabled;

#[tauri::command]
fn open_settings_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.set_always_on_top(true);
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("/?window=settings".into()),
    )
    .title("设置 - Network Watch")
    .inner_size(520.0, 680.0)
    .min_inner_size(420.0, 520.0)
    .resizable(true)
    .decorations(true)
    .visible(true)
    .center()
    .always_on_top(true)
    .build()?;

    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn close_settings_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        window.close()?;
    }
    Ok(())
}

/// 启动并运行 Tauri 应用（后端主入口）。
///
/// 主要工作：
/// - 初始化所需插件（更新、进程重启、窗口状态持久化、开机启动等）
/// - 注册前端可 `invoke` 的命令（例如 overlay 交互开关、运行时诊断）
/// - 在 `setup` 阶段创建托盘、初始化窗口位置/状态，并启动采样线程
/// - 在运行循环中把 `RunEvent` 分发给 `windowing` 处理（如关闭拦截、移动/缩放等）
///
/// 说明：
/// - 采样数据通过事件 `system-snapshot` 广播给前端（见 `constants::EVENT_SYSTEM_SNAPSHOT`）。
/// - Windows 下会启动 topmost guard，以降低“被系统/其他窗口抢走置顶层级”的边缘问题（见 `overlay`）。
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Network Watch")
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            set_overlay_interactive,
            open_settings_window,
            close_settings_window,
            get_runtime_diagnostics,
            #[cfg(target_os = "windows")]
            set_click_through_enabled
        ])
        .setup(|app| {
            tray::build_tray(app)?;
            windowing::initialize_window(app.app_handle());
            // Web 监控服务（可选）：默认开启，端口可用环境变量覆盖
            // - NETWORK_WATCH_WEB=0 关闭
            // - NETWORK_WATCH_WEB_BIND=127.0.0.1:17321 覆盖绑定地址
            let web_enabled = std::env::var("NETWORK_WATCH_WEB")
                .ok()
                .map(|v| v != "0" && v.to_ascii_lowercase() != "false")
                .unwrap_or(true);
            let machine_id = std::env::var("NETWORK_WATCH_MACHINE_ID").unwrap_or_else(|_| "local".to_string());
            let (latest, tx) = web_server::new_state();
            app.manage(latest.clone());
            app.manage(tx.clone());
            if web_enabled {
                let bind = std::env::var("NETWORK_WATCH_WEB_BIND")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| "0.0.0.0:17321".parse().expect("default bind addr"));
                web_server::start_web_server(latest, tx, machine_id, bind);
            }

            sampler::start_sampler(app.app_handle().clone());
            #[cfg(target_os = "windows")]
            overlay::start_windows_topmost_guard(app.app_handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(|app_handle, event| {
            windowing::handle_run_event(app_handle, event);
        });
}

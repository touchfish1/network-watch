//! 窗口生命周期与事件处理。
//!
//! 这个模块聚焦在“主窗口”层面的行为：
//! - 首次启动：根据 window-state 文件是否存在决定是否设置默认位置（右下角贴边）
//! - 关闭按钮：拦截关闭并隐藏窗口，同时保存 window-state
//! - 托盘切换：显示/隐藏窗口
//! - 失焦兜底：回退 overlay 交互性，降低边缘情况下的“窗口可点但不该抢焦点”问题
//! - 移动/缩放：重申 overlay 策略（Windows topmost 相关属性可能受影响）

use tauri::{AppHandle, Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_positioner::{Position, WindowExt as _};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags, DEFAULT_FILENAME};

use crate::desktop::{constants, overlay, state};

/// 初始化主窗口。
///
/// - 设置初始 overlay 为“不可交互”（收起态默认策略）
/// - 窗口显示
/// - 如果发现 window-state 尚未生成（通常意味着第一次启动），则把窗口移动到右下角
pub fn initialize_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(constants::WINDOW_LABEL) {
        state::set_overlay_interactive(false);
        overlay::apply_overlay_mode(&window, false);
        let _ = window.show();

        let needs_default_position = app
            .path()
            .app_config_dir()
            .map(|dir| !dir.join(DEFAULT_FILENAME).exists())
            .unwrap_or(true);

        if needs_default_position {
            let _ = window.move_window(Position::BottomRight);
        }
    }
}

/// 处理主窗口的 `WindowEvent`。
///
/// 说明：这个 handler 只处理少数与“常驻悬浮窗体验”强相关的事件，其他事件忽略即可。
pub fn handle_window_event(app: &AppHandle, event: WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(window) = app.get_webview_window(constants::WINDOW_LABEL) {
                let _ = app.save_window_state(StateFlags::all());
                let _ = window.hide();
            }
        }
        WindowEvent::Focused(false) => {
            // Frontend also handles blur -> non-interactive, but keep a backend fallback
            // to reduce edge cases where webview events don't fire as expected.
            state::set_overlay_interactive(false);
            if let Some(window) = app.get_webview_window(constants::WINDOW_LABEL) {
                overlay::apply_overlay_mode(&window, false);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(window) = app.get_webview_window(constants::WINDOW_LABEL) {
                let interactive = state::overlay_interactive();
                overlay::apply_overlay_mode(&window, interactive);
            }
        }
        _ => {}
    }
}

/// 显示/隐藏主窗口（托盘触发）。
///
/// - 隐藏时保存 window-state（以便下次启动恢复）\n+/// - 显示时把 overlay 设为不可交互（展开交互性由前端在需要时再打开）
pub fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(constants::WINDOW_LABEL) {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            state::set_overlay_interactive(false);
            let _ = app.save_window_state(StateFlags::all());
            let _ = window.hide();
        } else {
            state::set_overlay_interactive(false);
            overlay::apply_overlay_mode(&window, false);
            let _ = window.show();
            let _ = window.unminimize();
        }
    }
}

/// 从 `RunEvent` 中筛选出主窗口事件并委托给 `handle_window_event`。
pub fn handle_run_event(app_handle: &AppHandle, event: RunEvent) {
    if let RunEvent::WindowEvent { label, event, .. } = event {
        if label == constants::WINDOW_LABEL {
            handle_window_event(app_handle, event);
        }
    }
}


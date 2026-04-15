//! 悬浮窗 overlay/置顶策略。
//!
//! 目标是在不同平台上尽量同时满足：
//! - 窗口置顶、从任务栏隐藏、透明无边框
//! - 展开态需要可点击/可滚动/可交互
//! - 收起态尽量不抢焦点（尤其在 Windows 上）
//! - 在 Windows 上抵抗“topmost 层级被系统打掉”的边缘场景
//!
//! 重要约束（Windows）：
//! - `focusable(false)` 在部分情况下会导致窗口**完全收不到鼠标事件**，从而无法点击展开。
//! - 因此我们保持窗口 focusable，并用 `SWP_NOACTIVATE`（搭配前端 blur 处理）降低抢焦点的副作用。

use tauri::{Manager, Runtime};

#[cfg(target_os = "windows")]
use std::{thread, time::Duration};
#[cfg(target_os = "windows")]
use tauri::AppHandle;

use crate::desktop::{constants, state};

#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    WS_EX_LAYERED, WS_EX_TRANSPARENT, GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos,
};

/// Windows：强制将窗口提升到 topmost 层级（不激活窗口）。
///
/// 这是一种“更底层”的兜底：即使 `set_always_on_top(true)` 已经调用，
/// 仍可能在某些系统交互后失效，因此在可见时周期性重申。
#[cfg(target_os = "windows")]
fn force_windows_topmost<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    if let Ok(hwnd) = window.hwnd() {
        let _ = unsafe {
            SetWindowPos(
                hwnd.0 as _,
                HWND_TOPMOST,
                0,
                0,
                0,
                0,
                SWP_ASYNCWINDOWPOS | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        };
    }
}

/// 应用 overlay 模式（置顶/隐藏任务栏/可见工作区等）。
///
/// - 该函数可能被频繁调用（窗口移动/缩放、Windows guard 轮询），因此以“幂等、忽略错误”为设计。
/// - 参数 `_interactive` 预留为语义占位：实际是否可交互主要由前端决定；后端只在必要时切换状态并重申窗口属性。
pub fn apply_overlay_mode<R: Runtime>(window: &tauri::WebviewWindow<R>, _interactive: bool) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);
    // NOTE:
    // On Windows, `focusable(false)` can prevent pointer interactions, making the widget
    // impossible to click/expand. We keep the window focusable and instead rely on
    // `SWP_NOACTIVATE` (plus frontend blur handling) to minimize focus stealing.
    let _ = window.set_focusable(true);
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let _ = window.set_visible_on_all_workspaces(true);
    #[cfg(target_os = "windows")]
    force_windows_topmost(window);
    #[cfg(target_os = "windows")]
    apply_click_through(window, state::click_through_enabled());
}

/// Windows：应用鼠标穿透窗口样式。
///
/// 通过 `WS_EX_TRANSPARENT` 让窗口“穿透鼠标”，并保持 `WS_EX_LAYERED`（透明窗口常见组合）。
#[cfg(target_os = "windows")]
fn apply_click_through<R: Runtime>(window: &tauri::WebviewWindow<R>, enabled: bool) {
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let ex_style = GetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE) as isize;
            let mut next = ex_style;

            if enabled {
                next |= (WS_EX_TRANSPARENT as isize) | (WS_EX_LAYERED as isize);
            } else {
                next &= !(WS_EX_TRANSPARENT as isize);
            }

            if next != ex_style {
                let _ = SetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE, next);
            }
        }
    }
}

/// Windows：topmost 置顶守护线程。
///
/// 当窗口可见时周期性调用 `apply_overlay_mode`，降低置顶层级被打掉的概率。\n+/// 它读取 `state::overlay_interactive()`，用于在必要时重新应用与交互相关的窗口状态。
#[cfg(target_os = "windows")]
pub fn start_windows_topmost_guard(app: AppHandle) {
    thread::spawn(move || loop {
        if let Some(window) = app.get_webview_window(constants::WINDOW_LABEL) {
            if window.is_visible().unwrap_or(false) {
                let interactive = state::overlay_interactive();
                apply_overlay_mode(&window, interactive);
            }
        }

        thread::sleep(Duration::from_millis(
            constants::WINDOW_TOPMOST_GUARD_INTERVAL_MS,
        ));
    });
}

/// 设置 overlay 交互性（由前端驱动）。
///
/// - **interactive=true**：展开态，允许交互。此时尝试 `set_focus()`，让键盘/滚轮行为更一致。\n+/// - **interactive=false**：收起态，尽量降低干扰（前端也会在 blur 时回退）。\n+///\n+/// 该命令会更新原子状态，并立即对窗口重申 overlay 策略（幂等）。
#[tauri::command]
pub fn set_overlay_interactive<R: Runtime>(
    app: tauri::AppHandle<R>,
    interactive: bool,
) -> tauri::Result<()> {
    state::set_overlay_interactive(interactive);
    if let Some(window) = app.get_webview_window(constants::WINDOW_LABEL) {
        apply_overlay_mode(&window, interactive);
        if interactive {
            let _ = window.set_focus();
        }
    }

    Ok(())
}

/// 应用鼠标穿透开关（Windows）：更新状态、重绘窗口样式、同步托盘勾选并通知前端。
#[cfg(target_os = "windows")]
pub fn apply_click_through_setting<R: Runtime>(app: &tauri::AppHandle<R>, enabled: bool) {
    state::set_click_through_enabled(enabled);
    if let Some(window) = app.get_webview_window(constants::WINDOW_LABEL) {
        apply_overlay_mode(&window, state::overlay_interactive());
    }
    crate::desktop::win::click_through_bus::notify_click_through_changed(app, enabled);
}

/// 设置鼠标穿透开关（Windows）。
///
/// 返回值为最终状态，便于前端与托盘 UI 同步。
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn set_click_through_enabled<R: Runtime>(app: tauri::AppHandle<R>, enabled: bool) -> tauri::Result<bool> {
    apply_click_through_setting(&app, enabled);
    Ok(state::click_through_enabled())
}



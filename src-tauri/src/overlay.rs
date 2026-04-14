use std::{thread, time::Duration};

use tauri::{AppHandle, Manager, Runtime};

use crate::{constants, state};

#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos,
};

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
}

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


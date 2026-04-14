use tauri::{AppHandle, Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_positioner::{Position, WindowExt as _};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags, DEFAULT_FILENAME};

use crate::{constants, overlay, state};

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

pub fn handle_run_event(app_handle: &AppHandle, event: RunEvent) {
    if let RunEvent::WindowEvent { label, event, .. } = event {
        if label == constants::WINDOW_LABEL {
            handle_window_event(app_handle, event);
        }
    }
}


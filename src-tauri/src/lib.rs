use serde::Serialize;
use std::{thread, time::{Duration, SystemTime, UNIX_EPOCH}};
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, Networks, RefreshKind, System};
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent,
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuEvent, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_positioner::{Position, WindowExt as _};
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags, DEFAULT_FILENAME};
#[cfg(target_os = "windows")]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    HWND_TOPMOST, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos,
};

const WINDOW_LABEL: &str = "main";
const EVENT_SYSTEM_SNAPSHOT: &str = "system-snapshot";
const MENU_TOGGLE_WINDOW: &str = "toggle-window";
const MENU_AUTOSTART: &str = "toggle-autostart";
const MENU_QUIT: &str = "quit";
#[cfg(target_os = "windows")]
const WINDOW_TOPMOST_GUARD_INTERVAL_MS: u64 = 1200;

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

fn apply_overlay_mode<R: Runtime>(window: &tauri::WebviewWindow<R>, interactive: bool) {
    let _ = window.set_always_on_top(true);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_focusable(interactive);
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let _ = window.set_visible_on_all_workspaces(true);
    #[cfg(target_os = "windows")]
    force_windows_topmost(window);
}

#[cfg(target_os = "windows")]
fn start_windows_topmost_guard(app: AppHandle) {
    thread::spawn(move || loop {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            if window.is_visible().unwrap_or(false) {
                let interactive = window.is_focused().unwrap_or(false);
                apply_overlay_mode(&window, interactive);
            }
        }

        thread::sleep(Duration::from_millis(WINDOW_TOPMOST_GUARD_INTERVAL_MS));
    });
}

#[tauri::command]
fn set_overlay_interactive<R: Runtime>(app: AppHandle<R>, interactive: bool) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        apply_overlay_mode(&window, interactive);
        if interactive {
            let _ = window.set_focus();
        }
    }

    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
struct SystemSnapshot {
    timestamp: u64,
    cpu_usage: f32,
    memory_used: u64,
    memory_total: u64,
    network_download: u64,
    network_upload: u64,
}

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
        .invoke_handler(tauri::generate_handler![set_overlay_interactive])
        .setup(|app| {
            build_tray(app)?;
            initialize_window(app.app_handle());
            start_sampler(app.app_handle().clone());
            #[cfg(target_os = "windows")]
            start_windows_topmost_guard(app.app_handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(|app_handle, event| {
            if let RunEvent::WindowEvent { label, event, .. } = event {
                if label == WINDOW_LABEL {
                    handle_window_event(app_handle, event);
                }
            }
        });
}

fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let autostart_checked = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_item = CheckMenuItemBuilder::new("开机启动")
        .id(MENU_AUTOSTART)
        .checked(autostart_checked)
        .build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::new("显示 / 隐藏").id(MENU_TOGGLE_WINDOW).build(app)?)
        .item(&autostart_item)
        .separator()
        .item(&MenuItemBuilder::new("退出").id(MENU_QUIT).build(app)?)
        .build()?;

    let autostart_item_handle = autostart_item.clone();
    let mut tray_builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Network Watch")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| handle_menu_event(app, event, &autostart_item_handle))
        .on_tray_icon_event(|tray, event| handle_tray_event(tray.app_handle(), event));

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder.build(app)?;

    Ok(())
}

fn initialize_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        apply_overlay_mode(&window, false);
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

fn handle_tray_event(app: &AppHandle, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        toggle_window(app);
    }
}

fn handle_menu_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
    event: MenuEvent,
    autostart_item: &CheckMenuItem<R>,
) {
    match event.id.as_ref() {
        MENU_TOGGLE_WINDOW => toggle_window(app),
        MENU_AUTOSTART => toggle_autostart(app, autostart_item),
        MENU_QUIT => {
            let _ = app.save_window_state(StateFlags::all());
            app.exit(0);
        }
        _ => {}
    }
}

fn handle_window_event(app: &AppHandle, event: WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let _ = app.save_window_state(StateFlags::all());
                let _ = window.hide();
            }
        }
        WindowEvent::Focused(false) | WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                let interactive = window.is_focused().unwrap_or(false);
                apply_overlay_mode(&window, interactive);
            }
        }
        _ => {}
    }
}

fn toggle_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let is_visible = window.is_visible().unwrap_or(false);
        if is_visible {
            let _ = app.save_window_state(StateFlags::all());
            let _ = window.hide();
        } else {
            apply_overlay_mode(&window, false);
            let _ = window.show();
            let _ = window.unminimize();
        }
    }
}

fn toggle_autostart<R: tauri::Runtime>(app: &AppHandle<R>, autostart_item: &CheckMenuItem<R>) {
    let autolaunch = app.autolaunch();
    let enabled = autolaunch.is_enabled().unwrap_or(false);
    let next_enabled = !enabled;

    if next_enabled {
        let _ = autolaunch.enable();
    } else {
        let _ = autolaunch.disable();
    }

    let _ = autostart_item.set_checked(next_enabled);
}

fn start_sampler(app: AppHandle) {
    thread::spawn(move || {
        let mut system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        let mut networks = Networks::new_with_refreshed_list();

        loop {
            system.refresh_cpu_usage();
            system.refresh_memory();
            networks.refresh(true);

            let cpu_usage = system.global_cpu_usage();
            let memory_used = system.used_memory();
            let memory_total = system.total_memory();

            let mut network_download = 0_u64;
            let mut network_upload = 0_u64;

            for (_name, data) in &networks {
                network_download = network_download.saturating_add(data.received());
                network_upload = network_upload.saturating_add(data.transmitted());
            }

            let snapshot = SystemSnapshot {
                timestamp: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or_default(),
                cpu_usage,
                memory_used,
                memory_total,
                network_download,
                network_upload,
            };

            let _ = app.emit(EVENT_SYSTEM_SNAPSHOT, snapshot);
            thread::sleep(Duration::from_secs(1));
        }
    });
}

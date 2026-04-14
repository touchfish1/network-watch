mod constants;
mod diagnostics;
mod overlay;
mod sampler;
mod state;
mod tray;
mod windowing;

use tauri::Manager;
use diagnostics::get_runtime_diagnostics;
use overlay::set_overlay_interactive;

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
        .invoke_handler(tauri::generate_handler![set_overlay_interactive, get_runtime_diagnostics])
        .setup(|app| {
            tray::build_tray(app)?;
            windowing::initialize_window(app.app_handle());
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

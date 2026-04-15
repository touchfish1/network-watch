//! 仅桌面 GUI（Tauri）使用的模块。
pub mod constants;
pub mod diagnostics;
pub mod overlay;
pub mod state;
pub mod tray;
pub mod windowing;

#[cfg(target_os = "windows")]
pub mod win;

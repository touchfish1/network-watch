//! 桌面应用进程入口（thin main）。
//!
//! 说明：大部分逻辑都在 `network_watch_lib` 中实现，这里只负责把进程入口委托过去。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// 进程主入口。
///
/// - `windows_subsystem = "windows"`：在 Release 构建下隐藏控制台窗口，使应用表现为“纯 GUI”。
/// - 运行逻辑由 `network_watch_lib::run()` 承担（插件、托盘、采样线程、窗口事件等）。
fn main() {
    network_watch_lib::run()
}

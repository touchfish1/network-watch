//! Windows：托盘「鼠标穿透」勾选与前端 UI 的状态同步。
//!
//! - 托盘菜单项在构建时 `manage` 到 App 状态，便于在任意路径下更新勾选。
//! - 穿透实际开关由 `state::click_through_enabled` + `overlay::apply_overlay_mode` 负责；
//!   变更后通过事件 `EVENT_CLICK_THROUGH_CHANGED` 通知前端更新 localStorage 与按钮文案。

use tauri::{App, AppHandle, Emitter, Manager, Runtime};
use tauri::menu::CheckMenuItem;

use crate::desktop::constants;

/// 托盘菜单中「鼠标穿透」勾选条目的句柄（仅 Windows 构建）。
pub struct ClickThroughTrayMenuItem<R: Runtime>(pub CheckMenuItem<R>);

pub fn register_click_through_menu_item<R: Runtime>(app: &mut App<R>, item: &CheckMenuItem<R>) {
    let _ = app.manage(ClickThroughTrayMenuItem(item.clone()));
}

pub fn notify_click_through_changed<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    if let Some(st) = app.try_state::<ClickThroughTrayMenuItem<R>>() {
        let _ = st.0.set_checked(enabled);
    }
    let _ = app.emit(constants::EVENT_CLICK_THROUGH_CHANGED, enabled);
}

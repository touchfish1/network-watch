//! 托盘图标与菜单。
//!
//! 这里负责创建托盘图标、构建菜单并处理交互：
//! - 左键点击：切换主窗口显示/隐藏
//! - 菜单项：显示/隐藏、开机启动、退出
//!
//! 说明：
//! - 开机启动能力来自 `tauri-plugin-autostart`
//! - 窗口显示/隐藏由 `windowing` 模块统一处理

use tauri::{
    AppHandle,
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuEvent, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags};

use crate::{constants, windowing};
#[cfg(target_os = "windows")]
use crate::{click_through_bus, overlay, state};

/// 创建托盘与菜单，并绑定事件处理。
///
/// - `开机启动` 为可勾选项，初始状态来自 autostart plugin
/// - `退出` 会先保存 window-state，再调用 `app.exit(0)`
pub fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let autostart_checked = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_item = CheckMenuItemBuilder::new("开机启动")
        .id(constants::MENU_AUTOSTART)
        .checked(autostart_checked)
        .build(app)?;

    #[cfg(target_os = "windows")]
    let click_through_item = CheckMenuItemBuilder::new("鼠标穿透")
        .id(constants::MENU_CLICK_THROUGH)
        .checked(state::click_through_enabled())
        .build(app)?;

    #[cfg(target_os = "windows")]
    click_through_bus::register_click_through_menu_item(app, &click_through_item);

    #[cfg(target_os = "windows")]
    let mut menu_builder = MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::new("显示 / 隐藏")
                .id(constants::MENU_TOGGLE_WINDOW)
                .build(app)?,
        )
        .item(&autostart_item);
    #[cfg(not(target_os = "windows"))]
    let menu_builder = MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::new("显示 / 隐藏")
                .id(constants::MENU_TOGGLE_WINDOW)
                .build(app)?,
        )
        .item(&autostart_item);

    #[cfg(target_os = "windows")]
    {
        menu_builder = menu_builder.item(&click_through_item);
    }

    let menu = menu_builder
        .separator()
        .item(&MenuItemBuilder::new("退出").id(constants::MENU_QUIT).build(app)?)
        .build()?;

    let autostart_item_handle = autostart_item.clone();
    #[cfg(target_os = "windows")]
    let click_through_item_handle = click_through_item.clone();
    let mut tray_builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Network Watch")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            handle_menu_event(
                app,
                event,
                &autostart_item_handle,
                #[cfg(target_os = "windows")]
                &click_through_item_handle,
            )
        })
        .on_tray_icon_event(|tray, event| handle_tray_event(tray.app_handle(), event));

    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }

    tray_builder.build(app)?;
    Ok(())
}

/// 托盘图标事件（目前只关心左键抬起）。
fn handle_tray_event(app: &AppHandle, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        windowing::toggle_window(app);
    }
}

/// 托盘菜单事件分发（通过常量菜单 ID 匹配）。
fn handle_menu_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
    event: MenuEvent,
    autostart_item: &CheckMenuItem<R>,
    #[cfg(target_os = "windows")] click_through_item: &CheckMenuItem<R>,
) {
    match event.id.as_ref() {
        constants::MENU_TOGGLE_WINDOW => windowing::toggle_window(app),
        constants::MENU_AUTOSTART => toggle_autostart(app, autostart_item),
        #[cfg(target_os = "windows")]
        constants::MENU_CLICK_THROUGH => toggle_click_through(app, click_through_item),
        constants::MENU_QUIT => {
            let _ = app.save_window_state(StateFlags::all());
            app.exit(0);
        }
        _ => {}
    }
}

#[cfg(target_os = "windows")]
fn toggle_click_through<R: tauri::Runtime>(app: &AppHandle<R>, _click_through_item: &CheckMenuItem<R>) {
    let next_enabled = !state::click_through_enabled();
    overlay::apply_click_through_setting(app, next_enabled);
}

/// 切换开机启动，并同步菜单勾选状态。
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


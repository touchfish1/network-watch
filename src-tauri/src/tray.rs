use tauri::{
    AppHandle,
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuEvent, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags};

use crate::{constants, windowing};

pub fn build_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let autostart_checked = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_item = CheckMenuItemBuilder::new("开机启动")
        .id(constants::MENU_AUTOSTART)
        .checked(autostart_checked)
        .build(app)?;

    let menu = MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::new("显示 / 隐藏")
                .id(constants::MENU_TOGGLE_WINDOW)
                .build(app)?,
        )
        .item(&autostart_item)
        .separator()
        .item(&MenuItemBuilder::new("退出").id(constants::MENU_QUIT).build(app)?)
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

fn handle_menu_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
    event: MenuEvent,
    autostart_item: &CheckMenuItem<R>,
) {
    match event.id.as_ref() {
        constants::MENU_TOGGLE_WINDOW => windowing::toggle_window(app),
        constants::MENU_AUTOSTART => toggle_autostart(app, autostart_item),
        constants::MENU_QUIT => {
            let _ = app.save_window_state(StateFlags::all());
            app.exit(0);
        }
        _ => {}
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


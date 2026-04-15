//! Tauri 后端入口与模块编排。
//!
//! 这个 crate 负责把几个相对独立的能力组合成一个“常驻置顶悬浮窗”应用：
//! - `desktop::tray`：托盘菜单与开机启动开关
//! - `desktop::windowing`：窗口初始化、关闭拦截、显示/隐藏切换与事件分发
//! - `core::sampler`：系统指标采样线程，按固定周期向前端广播 `system-snapshot`
//! - `desktop::overlay`：置顶/不抢焦点/仍可点击的窗口叠加策略（Windows 额外有 topmost guard）
//! - `desktop::diagnostics` / `desktop::state`：跨线程状态与诊断数据（供前端排障/显示）
//!
//! 前端通过 `invoke` 调用少量命令（例如切换 overlay 交互性），并通过事件订阅接收采样快照。
//!
//! **特性**：`desktop` 为 GUI；`agent` 为独立 headless 二进制（见 `network-watch-agent`），二者可单独或同时启用。

mod core;

#[cfg(feature = "desktop")]
mod desktop;

#[cfg(feature = "agent")]
pub mod agent;

#[cfg(feature = "desktop")]
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
#[cfg(feature = "desktop")]
use desktop::diagnostics::get_runtime_diagnostics;
#[cfg(feature = "desktop")]
use desktop::overlay::set_overlay_interactive;
#[cfg(all(feature = "desktop", target_os = "windows"))]
use desktop::overlay::set_click_through_enabled;

#[cfg(feature = "desktop")]
use serde::Serialize;
use serde::Deserialize;
use std::{
    collections::HashMap,
    net::{Ipv4Addr, UdpSocket},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[cfg(feature = "desktop")]
use std::net::SocketAddr;

#[cfg(feature = "desktop")]
#[tauri::command]
fn open_settings_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window("settings") {
        let _ = existing.set_always_on_top(true);
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        &app,
        "settings",
        WebviewUrl::App("/?window=settings".into()),
    )
    .title("设置 - Network Watch")
    .inner_size(520.0, 680.0)
    .min_inner_size(420.0, 520.0)
    .resizable(true)
    .decorations(true)
    .visible(true)
    .center()
    .always_on_top(true)
    .build()?;

    let _ = window.set_focus();
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn close_settings_window<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        window.close()?;
    }
    Ok(())
}

/// 供展开态控制中心展示：是否与后端 `NETWORK_WATCH_WEB_*` 一致的本机访问地址。
#[cfg(feature = "desktop")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebMonitorHint {
    pub enabled: bool,
    pub primary_url: Option<String>,
    pub note: Option<String>,
}

#[cfg(feature = "desktop")]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnlineMachine {
    pub machine_id: String,
    pub host_name: Option<String>,
    pub host_ips: Vec<String>,
    pub label: Option<String>,
    pub received_at_ms: u64,
    pub snapshot: serde_json::Value,
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn get_web_monitor_hint() -> WebMonitorHint {
    let enabled = env_enabled("NETWORK_WATCH_WEB", true);
    if !enabled {
        return WebMonitorHint {
            enabled: false,
            primary_url: None,
            note: Some("已关闭（NETWORK_WATCH_WEB=0）".to_string()),
        };
    }

    let bind: SocketAddr = std::env::var("NETWORK_WATCH_WEB_BIND")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| "0.0.0.0:17321".parse().expect("default web bind"));

    let port = bind.port();
    let primary_url = match bind.ip() {
        std::net::IpAddr::V4(v4) if v4.is_unspecified() => format!("http://127.0.0.1:{port}/"),
        std::net::IpAddr::V6(v6) if v6.is_unspecified() => format!("http://127.0.0.1:{port}/"),
        ip => format!("http://{ip}:{port}/"),
    };

    let note = if bind.ip().is_unspecified() {
        Some(format!("局域网其他设备请使用「本机 IP:{port}」", port = port))
    } else {
        None
    };

    WebMonitorHint {
        enabled: true,
        primary_url: Some(primary_url),
        note,
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn get_online_machines(
    machines: tauri::State<'_, core::web_server::MachineSnapshots>,
) -> Result<Vec<OnlineMachine>, String> {
    let map = machines.0.read().await;
    let mut list = Vec::<OnlineMachine>::new();

    for (machine_id, item) in map.iter() {
        let Some(received_at_ms) = item.get("received_at_ms").and_then(|v| v.as_u64()) else {
            continue;
        };
        let Some(snapshot_value) = item.get("snapshot") else {
            continue;
        };
        list.push(OnlineMachine {
            machine_id: machine_id.clone(),
            host_name: item
                .get("host_name")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            host_ips: item
                .get("host_ips")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|ip| ip.as_str().map(|v| v.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default(),
            label: item
                .get("label")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()),
            received_at_ms,
            snapshot: snapshot_value.clone(),
        });
    }

    list.sort_by(|a, b| b.received_at_ms.cmp(&a.received_at_ms));
    Ok(list)
}

pub(crate) fn env_enabled(key: &str, default_value: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|v| v != "0" && v.to_ascii_lowercase() != "false")
        .unwrap_or(default_value)
}

pub(crate) fn env_u16(key: &str, default_value: u16) -> u16 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(default_value)
}

pub(crate) fn env_u64(key: &str, default_value: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default_value)
}

#[cfg(feature = "desktop")]
fn parse_port(bind: &SocketAddr) -> u16 {
    bind.port()
}

#[derive(Clone)]
struct GuiNodeTarget {
    ingest_url: String,
    last_seen: Instant,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct CapabilityResponse {
    role: String,
    ingest_url: String,
}

const DISCOVERY_REQUEST: &str = "NW_DISCOVER_GUI_V1";
const DISCOVERY_RESPONSE_PREFIX: &str = "NW_GUI_NODE_V1";

#[cfg(feature = "desktop")]
fn start_udp_discovery_responder(discovery_port: u16, web_port: u16) {
    thread::spawn(move || {
        let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, discovery_port)) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("[discover-responder] bind failed: {err}");
                return;
            }
        };

        let mut buf = [0_u8; 256];
        loop {
            let Ok((size, peer)) = socket.recv_from(&mut buf) else {
                continue;
            };
            let msg = String::from_utf8_lossy(&buf[..size]);
            if msg.trim() == DISCOVERY_REQUEST {
                let resp = format!("{DISCOVERY_RESPONSE_PREFIX} {web_port}");
                let _ = socket.send_to(resp.as_bytes(), peer);
            }
        }
    });
}

/// 统一入口：桌面模式 / 无 GUI agent 模式。
///
/// - `NETWORK_WATCH_AGENT=1`：启动 agent（不创建窗口）
/// - 默认：启动桌面应用
#[cfg(feature = "desktop")]
pub fn run_entry() {
    if env_enabled("NETWORK_WATCH_AGENT", false) {
        run_agent_mode();
    } else {
        run();
    }
}

#[cfg(all(feature = "agent", target_os = "linux"))]
fn agent_log_file_path(cwd: &std::path::Path) -> std::path::PathBuf {
    let name = std::env::var("NETWORK_WATCH_AGENT_LOG")
        .unwrap_or_else(|_| "network-watch-agent.log".to_string());
    let p = std::path::PathBuf::from(name);
    if p.is_absolute() {
        p
    } else {
        cwd.join(p)
    }
}

/// Linux 专用：在启动业务逻辑前将进程守护进程化，并把 stdout/stderr 追加到日志文件。
///
/// - 默认：写入当前工作目录下 `network-watch-agent.log`（可用 `NETWORK_WATCH_AGENT_LOG` 覆盖，相对路径相对当前目录）。
/// - `NETWORK_WATCH_AGENT_FOREGROUND=1`：不守护进程化，仍在前台运行（便于调试）。
#[cfg(all(feature = "agent", target_os = "linux"))]
pub fn linux_prepare_standalone_agent() -> std::io::Result<()> {
    use daemonize::Daemonize;
    use std::fs::OpenOptions;
    use std::path::PathBuf;

    if env_enabled("NETWORK_WATCH_AGENT_FOREGROUND", false) {
        return Ok(());
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let log_path = agent_log_file_path(&cwd);

    let stdout = OpenOptions::new().create(true).append(true).open(&log_path)?;
    let stderr = stdout.try_clone()?;

    let daemonize = Daemonize::new()
        .working_directory(&cwd)
        .stdout(stdout)
        .stderr(stderr)
        .umask(0o022);

    daemonize.start().map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::Other, format!("daemonize: {e}"))
    })
}

/// 独立 headless agent 二进制入口（`network-watch-agent`），不依赖 Tauri / 前端。
#[cfg(feature = "agent")]
pub fn run_standalone_agent() {
    run_agent_mode();
}

/// 启动并运行 Tauri 应用（后端主入口）。
///
/// 主要工作：
/// - 初始化所需插件（更新、进程重启、窗口状态持久化、开机启动等）
/// - 注册前端可 `invoke` 的命令（例如 overlay 交互开关、运行时诊断）
/// - 在 `setup` 阶段创建托盘、初始化窗口位置/状态，并启动采样线程
/// - 在运行循环中把 `RunEvent` 分发给 `windowing` 处理（如关闭拦截、移动/缩放等）
///
/// 说明：
/// - 采样数据通过事件 `system-snapshot` 广播给前端（见 `desktop::constants::EVENT_SYSTEM_SNAPSHOT`）。
/// - Windows 下会启动 topmost guard，以降低“被系统/其他窗口抢走置顶层级”的边缘问题（见 `desktop::overlay`）。
#[cfg(feature = "desktop")]
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
        .invoke_handler(tauri::generate_handler![
            set_overlay_interactive,
            open_settings_window,
            close_settings_window,
            get_web_monitor_hint,
            get_online_machines,
            get_runtime_diagnostics,
            #[cfg(target_os = "windows")]
            set_click_through_enabled
        ])
        .setup(|app| {
            desktop::tray::build_tray(app)?;
            desktop::windowing::initialize_window(app.app_handle());
            // Web 监控服务（可选）：默认开启，端口可用环境变量覆盖
            // - NETWORK_WATCH_WEB=0 关闭
            // - NETWORK_WATCH_WEB_BIND=127.0.0.1:17321 覆盖绑定地址
            let web_enabled = env_enabled("NETWORK_WATCH_WEB", true);
            let machine_id = std::env::var("NETWORK_WATCH_MACHINE_ID").unwrap_or_else(|_| "local".to_string());
            let (latest, tx) = core::web_server::new_state();
            let machines = core::web_server::new_machine_store();
            app.manage(latest.clone());
            app.manage(tx.clone());
            app.manage(machines.clone());
            if web_enabled {
                let bind: SocketAddr = std::env::var("NETWORK_WATCH_WEB_BIND")
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or_else(|| "0.0.0.0:17321".parse().expect("default bind addr"));
                // 桌面节点默认开启 UDP 发现应答，供局域网 agent 自动发现。
                if env_enabled("NETWORK_WATCH_DISCOVERY_RESPONDER", true) {
                    let discovery_port = env_u16("NETWORK_WATCH_DISCOVERY_PORT", 17322);
                    start_udp_discovery_responder(discovery_port, parse_port(&bind));
                }
                core::web_server::start_web_server(latest, machines, tx, machine_id, bind);
            }

            core::sampler::start_sampler(app.app_handle().clone());
            #[cfg(target_os = "windows")]
            desktop::overlay::start_windows_topmost_guard(app.app_handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(|app_handle, event| {
            desktop::windowing::handle_run_event(app_handle, event);
        });
}

#[cfg(any(feature = "desktop", feature = "agent"))]
fn run_agent_mode() {
    // Agent 模式关键环境变量（用于无 GUI Linux 部署）：
    // - NETWORK_WATCH_AGENT=1                      启用 agent
    // - NETWORK_WATCH_MACHINE_ID=linux-node-01     上报机器标识
    // - NETWORK_WATCH_DISCOVERY_PORT=17322         UDP 广播发现端口
    // - NETWORK_WATCH_DISCOVERY_INTERVAL_SECS=10   发现周期
    // - NETWORK_WATCH_NODE_TTL_SECS=30             GUI 节点过期时间
    // - NETWORK_WATCH_CAPABILITY_PATH=/api/v1/capabilities
    // - NETWORK_WATCH_COLLECTOR=http://host:17321/api/v1/ingest 发现为空时兜底
    // - NETWORK_WATCH_PUSH_TIMEOUT_SECS=3          上报请求超时
    let machine_id = std::env::var("NETWORK_WATCH_MACHINE_ID").unwrap_or_else(|_| "agent-local".to_string());
    let collector_url = std::env::var("NETWORK_WATCH_COLLECTOR").ok();
    let host_name = hostname::get()
        .ok()
        .and_then(|v| v.into_string().ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| machine_id.clone());
    let host_ips = core::web_server::get_host_ips();
    let label = {
        #[cfg(feature = "agent")]
        {
            crate::agent::label_cmd::get_or_create_label(&host_name)
        }
        #[cfg(not(feature = "agent"))]
        {
            // 桌面-only 构建下不含 agent 模块：给一个不持久化的兜底 label，避免编译失败。
            fn random_suffix_5() -> String {
                use std::time::{SystemTime, UNIX_EPOCH};
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or(0);
                let pid = std::process::id() as u64;
                let mut x = nanos ^ (pid.rotate_left(17)) ^ (nanos >> 7);
                let mut out = String::new();
                for _ in 0..5 {
                    x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    let v = (x % 36) as u8;
                    let c = if v < 10 { (b'0' + v) as char } else { (b'a' + (v - 10)) as char };
                    out.push(c);
                }
                out
            }
            format!("{}-{}", host_name, random_suffix_5())
        }
    };
    let timeout_secs = std::env::var("NETWORK_WATCH_PUSH_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(3);
    let discovery_port = env_u16("NETWORK_WATCH_DISCOVERY_PORT", 17322);
    let discovery_interval_secs = env_u64("NETWORK_WATCH_DISCOVERY_INTERVAL_SECS", 10);
    let node_ttl_secs = env_u64("NETWORK_WATCH_NODE_TTL_SECS", 30);
    let capability_path = std::env::var("NETWORK_WATCH_CAPABILITY_PATH")
        .unwrap_or_else(|_| "/api/v1/capabilities".to_string());

    // Agent 模式默认关闭内置 web，可用 NETWORK_WATCH_WEB=1 开启（便于本地排障）
    if env_enabled("NETWORK_WATCH_WEB", false) {
        let (latest, tx) = core::web_server::new_state();
        let machines = core::web_server::new_machine_store();
        let bind = std::env::var("NETWORK_WATCH_WEB_BIND")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or_else(|| "0.0.0.0:17321".parse().expect("default bind addr"));
        core::web_server::start_web_server(latest, machines, tx, machine_id.clone(), bind);
    }

    let http_client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .expect("failed to create reqwest client");

    let gui_nodes: Arc<Mutex<HashMap<String, GuiNodeTarget>>> = Arc::new(Mutex::new(HashMap::new()));

    // 发现循环：UDP 广播 -> 能力校验 -> 更新 GUI 主节点集合
    {
        let gui_nodes = Arc::clone(&gui_nodes);
        let http_client = http_client.clone();
        let capability_path = capability_path.clone();
        thread::spawn(move || {
            let socket = match UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
                Ok(s) => s,
                Err(err) => {
                    eprintln!("[agent-discovery] bind failed: {err}");
                    return;
                }
            };
            let _ = socket.set_broadcast(true);
            let _ = socket.set_read_timeout(Some(Duration::from_millis(800)));
            let mut buf = [0_u8; 512];

            loop {
                let _ = socket.send_to(
                    DISCOVERY_REQUEST.as_bytes(),
                    (Ipv4Addr::BROADCAST, discovery_port),
                );

                let started = Instant::now();
                while started.elapsed() < Duration::from_secs(1) {
                    let Ok((size, from)) = socket.recv_from(&mut buf) else {
                        break;
                    };
                    let msg = String::from_utf8_lossy(&buf[..size]).to_string();
                    if !msg.starts_with(DISCOVERY_RESPONSE_PREFIX) {
                        continue;
                    }
                    let Some(port_str) = msg.split_whitespace().nth(1) else {
                        continue;
                    };
                    let Ok(port) = port_str.parse::<u16>() else {
                        continue;
                    };
                    let base_url = format!("http://{}:{}", from.ip(), port);
                    let cap_url = format!(
                        "{}{}",
                        base_url.trim_end_matches('/'),
                        if capability_path.starts_with('/') {
                            capability_path.clone()
                        } else {
                            format!("/{}", capability_path)
                        }
                    );

                    let Ok(resp) = http_client.get(&cap_url).send() else {
                        continue;
                    };
                    let Ok(cap) = resp.json::<CapabilityResponse>() else {
                        continue;
                    };
                    if cap.role != "desktop_gui" {
                        continue;
                    }
                    let ingest_url = if cap.ingest_url.starts_with("http://")
                        || cap.ingest_url.starts_with("https://")
                    {
                        cap.ingest_url
                    } else {
                        format!(
                            "{}{}",
                            base_url.trim_end_matches('/'),
                            if cap.ingest_url.starts_with('/') {
                                cap.ingest_url
                            } else {
                                format!("/{}", cap.ingest_url)
                            }
                        )
                    };

                    if let Ok(mut map) = gui_nodes.lock() {
                        map.insert(
                            base_url,
                            GuiNodeTarget {
                                ingest_url,
                                last_seen: Instant::now(),
                            },
                        );
                    }
                }

                // TTL 清理
                if let Ok(mut map) = gui_nodes.lock() {
                    let ttl = Duration::from_secs(node_ttl_secs);
                    map.retain(|_, node| node.last_seen.elapsed() <= ttl);
                }
                thread::sleep(Duration::from_secs(discovery_interval_secs));
            }
        });
    }

    let (tx, rx) = mpsc::sync_channel::<core::sampler::SystemSnapshot>(8);
    core::sampler::start_headless_sampler(move |snapshot| {
        let _ = tx.try_send(snapshot);
    });

    eprintln!(
        "[agent] started. machine_id={machine_id}, discovery_port={discovery_port}, capability_path={capability_path}"
    );
    loop {
        let Ok(snapshot) = rx.recv() else {
            break;
        };
        let body = serde_json::json!({
            "machine_id": &machine_id,
            "host_name": &host_name,
            "host_ips": &host_ips,
            "label": &label,
            "snapshot": snapshot,
        });

        let mut targets = Vec::<String>::new();
        if let Ok(map) = gui_nodes.lock() {
            for item in map.values() {
                targets.push(item.ingest_url.clone());
            }
        }
        // 兜底：支持手动指定单主节点
        if targets.is_empty() {
            if let Some(url) = &collector_url {
                targets.push(url.clone());
            }
        }

        for url in targets {
            if let Err(err) = http_client.post(&url).json(&body).send() {
                eprintln!("[agent] push failed {url}: {err}");
            }
        }
    }
}

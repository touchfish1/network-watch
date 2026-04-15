//! 运行时诊断信息（提供给前端展示/排障）。
//!
//! 诊断信息不参与业务逻辑决策，主要用途：
//! - 验证采样线程是否持续在跑
//! - 验证 overlay 当前是否处于“可交互”模式
//! - 快速判断前端收到的快照是否新鲜（age）

use serde::Serialize;

use crate::desktop::state;
use crate::core::history_store;

/// 提供给前端的运行时诊断快照。
///
/// 字段名采用 `snake_case`，与前端 TypeScript 类型保持一致（见 `src/app/types.ts`）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RuntimeDiagnostics {
    /// 当前 overlay 是否可交互。
    overlay_interactive: bool,
    /// 采样 tick 次数（自启动累计）。
    sampler_tick_count: u64,
    /// 最近一次系统快照时间戳（毫秒，Unix epoch）。
    last_snapshot_at_ms: u64,
}

/// 读取当前运行时诊断信息。
///
/// 这是一个轻量命令：仅从原子状态读取数据，不做 IO/阻塞操作。
#[tauri::command]
pub fn get_runtime_diagnostics() -> RuntimeDiagnostics {
    RuntimeDiagnostics {
        overlay_interactive: state::overlay_interactive(),
        sampler_tick_count: state::snapshot_tick_count(),
        last_snapshot_at_ms: state::last_snapshot_at_ms(),
    }
}

/// 导出诊断报告到本地文件，并返回文件路径。
///
/// - 默认导出最近 10 分钟 events
/// - 内容包含版本号、关键环境变量与最近事件（不包含快照原始内容，避免敏感信息泄露）
#[tauri::command]
pub fn export_diagnostics_report(minutes: Option<u64>) -> Result<String, String> {
    let minutes = minutes.unwrap_or(10).clamp(1, 24 * 60);
    let now = history_store::now_ms();
    let since_ms = now.saturating_sub(minutes * 60_000);

    let db_path = history_store::default_db_path();
    let events = history_store::query_events(&db_path, None, Some(since_ms), Some(now), None, None, 0, 200)
        .unwrap_or_default();

    let machine_id = std::env::var("NETWORK_WATCH_MACHINE_ID").unwrap_or_else(|_| "local".to_string());
    let web_bind = std::env::var("NETWORK_WATCH_WEB_BIND").unwrap_or_else(|_| "0.0.0.0:17321".to_string());
    let relay_on = std::env::var("NETWORK_WATCH_GUI_RELAY").unwrap_or_else(|_| "1".to_string());
    let relay_interval = std::env::var("NETWORK_WATCH_GUI_PUSH_INTERVAL_SECS").unwrap_or_else(|_| "2".to_string());
    let discovery_port = std::env::var("NETWORK_WATCH_DISCOVERY_PORT").unwrap_or_else(|_| "17322".to_string());
    let discovery_interval = std::env::var("NETWORK_WATCH_DISCOVERY_INTERVAL_SECS").unwrap_or_else(|_| "10".to_string());
    let node_ttl = std::env::var("NETWORK_WATCH_NODE_TTL_SECS").unwrap_or_else(|_| "30".to_string());

    let parent = db_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| std::path::PathBuf::from("."));
    let file_name = format!("network-watch-diagnostics-{}.txt", now);
    let out_path = parent.join(file_name);

    let header = format!(
        "Network Watch diagnostics\n\
version: {ver}\n\
ts_ms: {now}\n\
machine_id: {mid}\n\
web_bind: {web_bind}\n\
gui_relay: {relay_on}\n\
gui_push_interval_secs: {relay_interval}\n\
discovery_port: {discovery_port}\n\
discovery_interval_secs: {discovery_interval}\n\
node_ttl_secs: {node_ttl}\n\
sampler_tick_count: {ticks}\n\
last_snapshot_at_ms: {last_snap}\n\
events_window_minutes: {minutes}\n\
events_count: {ec}\n\
\n\
events (latest first):\n",
        ver = env!("CARGO_PKG_VERSION"),
        now = now,
        mid = machine_id,
        web_bind = web_bind,
        relay_on = relay_on,
        relay_interval = relay_interval,
        discovery_port = discovery_port,
        discovery_interval = discovery_interval,
        node_ttl = node_ttl,
        ticks = state::snapshot_tick_count(),
        last_snap = state::last_snapshot_at_ms(),
        minutes = minutes,
        ec = events.len()
    );

    let mut body = String::new();
    for e in events {
        body.push_str(&format!(
            "- {ts}  {typ}  {mid}  {label}\n",
            ts = e.ts_ms,
            typ = e.r#type,
            mid = e.machine_id,
            label = e.label
        ));
    }

    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    std::fs::write(&out_path, header + &body).map_err(|e| e.to_string())?;
    Ok(out_path.to_string_lossy().to_string())
}


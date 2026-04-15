//! 轻量 Web 监控服务（可选）。
//!
//! 目标：
//! - 提供一个可在浏览器访问的页面展示当前系统监控
//! - 提供版本化 API（v1），为未来“多机器数据接入”预留接口形状
//!
//! 说明：
//! - 默认仅用于局域网/本机自用，不做复杂鉴权；可通过环境变量关闭或绑定到 127.0.0.1
//! - SSE 用于推送快照，避免频繁轮询

use std::{
    collections::HashMap,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::State,
    http::StatusCode,
    response::{sse::Event, sse::KeepAlive, sse::Sse, Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, RwLock};
use tokio_stream::{wrappers::BroadcastStream, StreamExt as _};
use tower_http::cors::{Any, CorsLayer};

use crate::core::sampler::SystemSnapshot;
use crate::core::history_store;

fn ingest_allowed(sender_role: Option<&str>, hop_count: u8) -> bool {
    // 允许 agent 与 GUI 双向上报；旧版本未携带 sender_role 时也放行。
    if let Some(role) = sender_role {
        let r = role.trim().to_ascii_lowercase();
        if r != "agent" && r != "desktop_gui" {
            return false;
        }
    }
    hop_count <= 1
}

#[derive(Clone)]
pub struct LatestSnapshot(pub Arc<RwLock<Option<SystemSnapshot>>>);

#[derive(Clone)]
pub struct SnapshotBroadcaster(pub broadcast::Sender<SystemSnapshot>);

#[derive(Clone)]
pub struct MachineSnapshots(pub Arc<RwLock<HashMap<String, serde_json::Value>>>);

#[derive(Clone)]
struct WebState {
    latest: LatestSnapshot,
    machines: MachineSnapshots,
    tx: SnapshotBroadcaster,
    machine_id: String,
    host_name: String,
    host_ips: Vec<String>,
    role: String,
    ingest_url: String,
    db_path: PathBuf,
    last_seen: Arc<RwLock<HashMap<String, (u64, String, bool)>>>, // machine_id -> (last_seen_ms, label, is_stale)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
struct SnapshotEnvelope {
    machine_id: String,
    snapshot: Option<SystemSnapshot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct IngestEnvelope {
    machine_id: String,
    #[serde(default)]
    sender_role: Option<String>,
    #[serde(default)]
    origin_machine_id: Option<String>,
    #[serde(default)]
    hop_count: Option<u8>,
    #[serde(default)]
    host_name: Option<String>,
    #[serde(default)]
    host_ips: Option<Vec<String>>,
    #[serde(default)]
    label: Option<String>,
    snapshot: serde_json::Value,
}

fn build_ingest_storage_key(payload: &IngestEnvelope) -> String {
    // 多台 agent 可能使用相同 machine_id（例如默认值 agent-local），
    // 这里拼接一个稳定“主机指纹”避免后写覆盖前写。
    let host_hint = payload
        .host_ips
        .as_ref()
        .and_then(|ips| ips.iter().find(|ip| !ip.trim().is_empty()).cloned())
        .or_else(|| {
            payload
                .host_name
                .as_ref()
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
        });
    match host_hint {
        Some(hint) => format!("{}@{}", payload.machine_id, hint),
        None => payload.machine_id.clone(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
struct CapabilitiesEnvelope {
    machine_id: String,
    role: String,
    ingest_url: String,
    version: String,
}

pub fn new_state() -> (LatestSnapshot, SnapshotBroadcaster) {
    let latest = LatestSnapshot(Arc::new(RwLock::new(None)));
    let (tx, _rx) = broadcast::channel::<SystemSnapshot>(16);
    (latest, SnapshotBroadcaster(tx))
}

pub fn new_machine_store() -> MachineSnapshots {
    MachineSnapshots(Arc::new(RwLock::new(HashMap::new())))
}

pub fn start_web_server(
    latest: LatestSnapshot,
    machines: MachineSnapshots,
    tx: SnapshotBroadcaster,
    machine_id: String,
    bind: SocketAddr,
) {
    let host_name = hostname::get()
        .ok()
        .and_then(|v| v.into_string().ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let host_ips = get_host_ips();

    let db_path = history_store::default_db_path();
    let _ = history_store::init_db(&db_path);

    let state = WebState {
        latest,
        machines,
        tx,
        machine_id,
        host_name,
        host_ips,
        role: std::env::var("NETWORK_WATCH_ROLE").unwrap_or_else(|_| {
            if std::env::var("NETWORK_WATCH_AGENT")
                .ok()
                .map(|v| v != "0" && v.to_ascii_lowercase() != "false")
                .unwrap_or(false)
            {
                "agent".to_string()
            } else {
                "desktop_gui".to_string()
            }
        }),
        ingest_url: "/api/v1/ingest".to_string(),
        db_path,
        last_seen: Arc::new(RwLock::new(HashMap::new())),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let last_seen_for_tick = state.last_seen.clone();
    let db_for_tick = state.db_path.clone();
    let app = Router::new()
        .route("/", get(root_page))
        .route("/api/v1/health", get(health))
        .route("/api/v1/capabilities", get(capabilities))
        .route("/api/v1/snapshot", get(get_snapshot))
        .route("/api/v1/machines", get(get_machines))
        .route("/api/v1/history", get(get_history))
        .route("/api/v1/history/aggregate", get(get_history_aggregate))
        .route("/api/v1/events", get(get_events))
        .route("/api/v1/stream", get(stream_sse))
        .route("/api/v1/ingest", post(ingest_snapshot))
        .layer(cors)
        .with_state(state);

    // offline 检测：定期将超过阈值未上报的主机标记为 stale，并落盘 offline 事件（只触发一次）
    {
        let last_seen = last_seen_for_tick;
        let db = db_for_tick;
        let ttl_ms = std::env::var("NETWORK_WATCH_HOST_STALE_THRESHOLD_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(12_000);
        let tick = async move {
            loop {
                let now = history_store::now_ms();
                let mut to_offline: Vec<(String, String)> = Vec::<(String, String)>::new();
                {
                    let mut map: tokio::sync::RwLockWriteGuard<'_, HashMap<String, (u64, String, bool)>> =
                        last_seen.write().await;
                    for (mid, (seen, label, stale)) in map.iter_mut() {
                        let is_now_stale = now.saturating_sub(*seen) > ttl_ms;
                        if is_now_stale && !*stale {
                            *stale = true;
                            to_offline.push((mid.clone(), label.clone()));
                        }
                        if !is_now_stale && *stale {
                            *stale = false;
                        }
                    }
                }
                for (mid, label) in to_offline {
                    let db2 = db.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        history_store::insert_event(&db2, &mid, &label, "offline", now)
                    })
                    .await;
                }
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        };

        #[cfg(feature = "desktop")]
        tauri::async_runtime::spawn(tick);

        #[cfg(not(feature = "desktop"))]
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime for offline tick");
            rt.block_on(tick);
        });
    }

    let serve = async move {
        let listener = match tokio::net::TcpListener::bind(bind).await {
            Ok(v) => v,
            Err(err) => {
                eprintln!("[web] bind {bind} failed: {err}");
                return;
            }
        };

        eprintln!("[web] listening on http://{bind}");

        if let Err(err) = axum::serve(listener, app).await {
            eprintln!("[web] serve error: {err}");
        }
    };

    #[cfg(feature = "desktop")]
    tauri::async_runtime::spawn(serve);

    #[cfg(not(feature = "desktop"))]
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime for web server");
        rt.block_on(serve);
    });
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct HistoryQuery {
    machine_id: String,
    range: Option<String>, // "24h" | "7d"
}

async fn get_history(
    State(st): State<WebState>,
    axum::extract::Query(q): axum::extract::Query<HistoryQuery>,
) -> impl IntoResponse {
    let now = history_store::now_ms();
    let since_ms = match q.range.as_deref() {
        Some("7d") => now.saturating_sub(7 * 24 * 60 * 60_000),
        _ => now.saturating_sub(24 * 60 * 60_000),
    };
    let db = st.db_path.clone();
    let mid = q.machine_id;
    let result = tokio::task::spawn_blocking(move || history_store::query_metrics_since(&db, &mid, since_ms))
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();
    Json(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct AggregateHistoryQuery {
    range: Option<String>, // "24h" | "7d"
}

async fn get_history_aggregate(
    State(st): State<WebState>,
    axum::extract::Query(q): axum::extract::Query<AggregateHistoryQuery>,
) -> impl IntoResponse {
    let now = history_store::now_ms();
    let since_ms = match q.range.as_deref() {
        Some("7d") => now.saturating_sub(7 * 24 * 60 * 60_000),
        _ => now.saturating_sub(24 * 60 * 60_000),
    };
    let db = st.db_path.clone();
    let result =
        tokio::task::spawn_blocking(move || history_store::query_metrics_aggregate_since(&db, since_ms))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
    Json(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct EventsQuery {
    machine_id: Option<String>,
    since_ms: Option<u64>,
    until_ms: Option<u64>,
    event_type: Option<String>,
    query: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
}

async fn get_events(
    State(st): State<WebState>,
    axum::extract::Query(q): axum::extract::Query<EventsQuery>,
) -> impl IntoResponse {
    let db = st.db_path.clone();
    let mid = q
        .machine_id
        .and_then(|s| if s.trim().is_empty() { None } else { Some(s) });
    let since_ms = q.since_ms;
    let until_ms = q.until_ms;
    let event_type = q.event_type;
    let query = q.query;
    let offset = q.offset.unwrap_or(0);
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let result = tokio::task::spawn_blocking(move || {
        history_store::query_events(
            &db,
            mid.as_deref(),
            since_ms,
            until_ms,
            event_type.as_deref(),
            query.as_deref(),
            offset,
            limit,
        )
    })
    .await
    .ok()
    .and_then(|r| r.ok())
    .unwrap_or_default();
    Json(result)
}

async fn capabilities(State(st): State<WebState>) -> impl IntoResponse {
    Json(CapabilitiesEnvelope {
        machine_id: st.machine_id,
        role: st.role,
        ingest_url: st.ingest_url,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

async fn root_page(State(st): State<WebState>) -> impl IntoResponse {
    let ips = if st.host_ips.is_empty() {
        "—".to_string()
    } else {
        st.host_ips.join(" / ")
    };
    const TEMPLATE: &str = include_str!("../web/index.html");
    let html = TEMPLATE
        .replace("__MACHINE_ID__", &st.machine_id)
        .replace("__HOST_NAME__", &st.host_name)
        .replace("__HOST_IPS__", &ips);
    Html(html)
}

async fn get_snapshot(State(st): State<WebState>) -> impl IntoResponse {
    let snap = st.latest.0.read().await.clone();
    Json(SnapshotEnvelope {
        machine_id: st.machine_id,
        snapshot: snap,
    })
}

async fn get_machines(State(st): State<WebState>) -> impl IntoResponse {
    let mut list = st.machines.0.read().await.clone();
    let local_snapshot = st.latest.0.read().await.clone();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default();
    list.insert(
        st.machine_id.clone(),
        serde_json::json!({
            "received_at_ms": now_ms,
            "host_name": st.host_name,
            "host_ips": st.host_ips,
            "label": st.host_name,
            "snapshot": local_snapshot,
        }),
    );

    // 本机分钟级落盘（幂等 upsert）
    if let Some(s) = st.latest.0.read().await.clone() {
        let db = st.db_path.clone();
        let mid = st.machine_id.clone();
        let cpu = s.cpu_usage as f64;
        let mem_pct = if s.memory_total > 0 {
            (s.memory_used as f64 / s.memory_total as f64) * 100.0
        } else {
            0.0
        };
        let down = s.network_download as f64;
        let up = s.network_upload as f64;
        let ts = now_ms;
        let _ = tokio::task::spawn_blocking(move || {
            history_store::upsert_metrics_minute(&db, &mid, ts, cpu, mem_pct, down, up)
        })
        .await;
    }
    Json(list)
}

async fn ingest_snapshot(
    State(st): State<WebState>,
    Json(payload): Json<IngestEnvelope>,
) -> impl IntoResponse {
    let hop_count = payload.hop_count.unwrap_or(0);
    if !ingest_allowed(payload.sender_role.as_deref(), hop_count) {
        return (StatusCode::FORBIDDEN, "forbidden: ingest rejected").into_response();
    }
    let origin_machine_id = payload
        .origin_machine_id
        .clone()
        .unwrap_or_else(|| payload.machine_id.clone());

    let storage_key = build_ingest_storage_key(&payload);
    let now_ms = history_store::now_ms();
    {
        let mut map = st.machines.0.write().await;
        map.insert(
            storage_key,
            serde_json::json!({
                "machine_id": payload.machine_id,
                "origin_machine_id": origin_machine_id,
                "hop_count": hop_count,
                "received_at_ms": now_ms,
                "host_name": payload.host_name,
                "host_ips": payload.host_ips.unwrap_or_default(),
                "label": payload.label,
                "snapshot": payload.snapshot,
            }),
        );
    }

    // 事件流：online/offline（online 在 ingest 时触发；offline 由后台检查任务触发）
    {
        let label = payload
            .label
            .clone()
            .or_else(|| payload.host_name.clone())
            .unwrap_or_else(|| payload.machine_id.clone());
        let mid = payload.machine_id.clone();
        let mut last = st.last_seen.write().await;
        let prev = last.get(&mid).cloned();
        let was_stale = prev.map(|x| x.2).unwrap_or(true);
        last.insert(mid.clone(), (now_ms, label.clone(), false));
        if was_stale {
            let db = st.db_path.clone();
            let _ = tokio::task::spawn_blocking(move || {
                history_store::insert_event(&db, &mid, &label, "online", now_ms)
            })
            .await;
        }
    }

    // 分钟级指标落盘
    {
        let snap = &payload.snapshot;
        let cpu = snap.get("cpu_usage").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let mem_used = snap.get("memory_used").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let mem_total = snap.get("memory_total").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let mem_pct = if mem_total > 0.0 { (mem_used / mem_total) * 100.0 } else { 0.0 };
        let down = snap.get("network_download").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let up = snap.get("network_upload").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let db = st.db_path.clone();
        let mid = payload.machine_id.clone();
        let _ = tokio::task::spawn_blocking(move || {
            history_store::upsert_metrics_minute(&db, &mid, now_ms, cpu, mem_pct, down, up)
        })
        .await;
    }

    (StatusCode::ACCEPTED, "ok").into_response()
}

async fn stream_sse(
    State(st): State<WebState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = st.tx.0.subscribe();
    let machine_id = st.machine_id;

    let stream = BroadcastStream::new(rx).filter_map(move |msg| match msg {
        Ok(snapshot) => {
            let payload = serde_json::json!({ "machine_id": machine_id, "snapshot": snapshot });
            Some(Ok(Event::default().data(payload.to_string())))
        }
        Err(_) => None,
    });

    Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)).text("keep-alive"))
}

pub(crate) fn get_host_ips() -> Vec<String> {
    let mut ips = Vec::<String>::new();
    let addrs = match get_if_addrs::get_if_addrs() {
        Ok(v) => v,
        Err(_) => return ips,
    };

    for iface in addrs {
        let ip = iface.ip();
        if ip.is_loopback() {
            continue;
        }
        // 去重（同一 IP 可能在多个 alias 上出现）
        let s = ip.to_string();
        if !ips.contains(&s) {
            ips.push(s);
        }
    }

    // 排序：让输出稳定（大多数情况下 v4 在前）
    ips.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
    ips
}

#[cfg(test)]
mod tests {
    use super::ingest_allowed;

    #[test]
    fn ingest_allows_legacy_no_role() {
        assert!(ingest_allowed(None, 0));
        assert!(ingest_allowed(None, 1));
    }

    #[test]
    fn ingest_rejects_unknown_role() {
        assert!(!ingest_allowed(Some("evil"), 0));
    }

    #[test]
    fn ingest_rejects_hop_gt_one() {
        assert!(!ingest_allowed(Some("agent"), 2));
        assert!(!ingest_allowed(None, 2));
    }

    #[test]
    fn ingest_allows_agent_and_gui() {
        assert!(ingest_allowed(Some("agent"), 0));
        assert!(ingest_allowed(Some("desktop_gui"), 1));
        assert!(ingest_allowed(Some(" DESKTOP_GUI "), 0));
    }
}


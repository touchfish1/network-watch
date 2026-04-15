//! 轻量 Web 监控服务（可选）。
//!
//! 目标：
//! - 提供一个可在浏览器访问的页面展示当前系统监控
//! - 提供版本化 API（v1），为未来“多机器数据接入”预留接口形状
//!
//! 说明：
//! - 默认仅用于局域网/本机自用，不做复杂鉴权；可通过环境变量关闭或绑定到 127.0.0.1
//! - SSE 用于推送快照，避免频繁轮询

use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::{SystemTime, UNIX_EPOCH}};

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
    host_name: Option<String>,
    #[serde(default)]
    host_ips: Option<Vec<String>>,
    #[serde(default)]
    label: Option<String>,
    snapshot: serde_json::Value,
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
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/", get(root_page))
        .route("/api/v1/health", get(health))
        .route("/api/v1/capabilities", get(capabilities))
        .route("/api/v1/snapshot", get(get_snapshot))
        .route("/api/v1/machines", get(get_machines))
        .route("/api/v1/stream", get(stream_sse))
        .route("/api/v1/ingest", post(ingest_snapshot))
        .layer(cors)
        .with_state(state);

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
    Json(list)
}

async fn ingest_snapshot(
    State(st): State<WebState>,
    Json(payload): Json<IngestEnvelope>,
) -> impl IntoResponse {
    {
        let mut map = st.machines.0.write().await;
        map.insert(
            payload.machine_id,
            serde_json::json!({
                "received_at_ms": SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or_default(),
                "host_name": payload.host_name,
                "host_ips": payload.host_ips.unwrap_or_default(),
                "label": payload.label,
                "snapshot": payload.snapshot,
            }),
        );
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


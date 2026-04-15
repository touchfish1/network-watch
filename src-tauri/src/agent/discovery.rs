//! 单次 UDP + capabilities 扫描，枚举局域网内可上报的 GUI 节点（与常驻 agent 发现协议一致）。

use std::collections::HashSet;
use std::net::{Ipv4Addr, UdpSocket};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::{env_u16, env_u64};

const DISCOVERY_REQUEST: &str = "NW_DISCOVER_GUI_V1";
const DISCOVERY_RESPONSE_PREFIX: &str = "NW_GUI_NODE_V1";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct CapabilityResponse {
    role: String,
    ingest_url: String,
}

/// 局域网内发现的 GUI 节点（base 为 `http://IP:webPort`，ingest 为实际上报 URL）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DiscoveredGuiNode {
    pub base_url: String,
    pub ingest_url: String,
}

/// 发送一次广播并在 `wait_secs` 内收集响应，校验 `/api/v1/capabilities`（协议与常驻 agent 相同）。
pub fn discover_gui_nodes_once(wait_secs: u64) -> Result<Vec<DiscoveredGuiNode>, String> {
    let discovery_port = env_u16("NETWORK_WATCH_DISCOVERY_PORT", 17322);
    let capability_path =
        std::env::var("NETWORK_WATCH_CAPABILITY_PATH").unwrap_or_else(|_| "/api/v1/capabilities".to_string());
    let timeout_secs = env_u64("NETWORK_WATCH_PUSH_TIMEOUT_SECS", 3);

    let http_client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())?;

    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| format!("UDP 绑定失败: {e}"))?;
    let _ = socket.set_broadcast(true);
    let _ = socket.set_read_timeout(Some(Duration::from_millis(800)));

    let _ = socket.send_to(DISCOVERY_REQUEST.as_bytes(), (Ipv4Addr::BROADCAST, discovery_port));

    let mut buf = [0_u8; 512];
    let mut seen_ingest = HashSet::<String>::new();
    let mut out = Vec::<DiscoveredGuiNode>::new();

    let listen_for = Duration::from_secs(wait_secs.max(1));
    let started = Instant::now();
    while started.elapsed() < listen_for {
        let Ok((size, from)) = socket.recv_from(&mut buf) else {
            continue;
        };
        let msg = String::from_utf8_lossy(&buf[..size]);
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
        let ingest_url = if cap.ingest_url.starts_with("http://") || cap.ingest_url.starts_with("https://") {
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
        if seen_ingest.insert(ingest_url.clone()) {
            out.push(DiscoveredGuiNode { base_url, ingest_url });
        }
    }

    out.sort_by(|a, b| a.base_url.cmp(&b.base_url));
    Ok(out)
}

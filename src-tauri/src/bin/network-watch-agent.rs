//! Headless Linux agent entrypoint.
//!
//! Build (no GUI deps):
//!   cargo build -p src-tauri --release --no-default-features --features agent --bin network-watch-agent
//!
//! Runtime env:
//! - NETWORK_WATCH_MACHINE_ID
//! - NETWORK_WATCH_DISCOVERY_PORT (default 17322)
//! - NETWORK_WATCH_DISCOVERY_INTERVAL_SECS (default 10)
//! - NETWORK_WATCH_NODE_TTL_SECS (default 30)
//! - NETWORK_WATCH_CAPABILITY_PATH (default /api/v1/capabilities)
//! - NETWORK_WATCH_COLLECTOR (fallback when discovery empty)
//! - NETWORK_WATCH_PUSH_TIMEOUT_SECS (default 3)

#[path = "../sampler.rs"]
mod sampler;

use serde::Deserialize;
use std::{
    collections::HashMap,
    net::{Ipv4Addr, UdpSocket},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct CapabilityResponse {
    role: String,
    ingest_url: String,
}

#[derive(Clone)]
struct GuiNodeTarget {
    ingest_url: String,
    last_seen: Instant,
}

const DISCOVERY_REQUEST: &str = "NW_DISCOVER_GUI_V1";
const DISCOVERY_RESPONSE_PREFIX: &str = "NW_GUI_NODE_V1";

fn env_u16(key: &str, default_value: u16) -> u16 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(default_value)
}

fn env_u64(key: &str, default_value: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default_value)
}

fn main() {
    let machine_id = std::env::var("NETWORK_WATCH_MACHINE_ID").unwrap_or_else(|_| "agent-local".to_string());
    let collector_url = std::env::var("NETWORK_WATCH_COLLECTOR").ok();
    let timeout_secs = env_u64("NETWORK_WATCH_PUSH_TIMEOUT_SECS", 3);
    let discovery_port = env_u16("NETWORK_WATCH_DISCOVERY_PORT", 17322);
    let discovery_interval_secs = env_u64("NETWORK_WATCH_DISCOVERY_INTERVAL_SECS", 10);
    let node_ttl_secs = env_u64("NETWORK_WATCH_NODE_TTL_SECS", 30);
    let capability_path = std::env::var("NETWORK_WATCH_CAPABILITY_PATH").unwrap_or_else(|_| "/api/v1/capabilities".to_string());

    let http_client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .expect("failed to create reqwest client");

    let gui_nodes: Arc<Mutex<HashMap<String, GuiNodeTarget>>> = Arc::new(Mutex::new(HashMap::new()));

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
                let _ = socket.send_to(DISCOVERY_REQUEST.as_bytes(), (Ipv4Addr::BROADCAST, discovery_port));

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

                if let Ok(mut map) = gui_nodes.lock() {
                    let ttl = Duration::from_secs(node_ttl_secs);
                    map.retain(|_, node| node.last_seen.elapsed() <= ttl);
                }
                thread::sleep(Duration::from_secs(discovery_interval_secs));
            }
        });
    }

    let (tx, rx) = mpsc::sync_channel::<sampler::SystemSnapshot>(8);
    sampler::start_headless_sampler(move |snapshot| {
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
            "snapshot": snapshot,
        });

        let mut targets = Vec::<String>::new();
        if let Ok(map) = gui_nodes.lock() {
            for item in map.values() {
                targets.push(item.ingest_url.clone());
            }
        }
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


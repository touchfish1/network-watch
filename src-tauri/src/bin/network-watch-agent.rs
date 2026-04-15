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

fn main() {
    network_watch_lib::run_standalone_agent();
}

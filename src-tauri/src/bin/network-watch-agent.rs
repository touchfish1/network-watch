//! Headless Linux agent entrypoint.
//!
//! Build (no GUI deps):
//!   cargo build -p src-tauri --release --no-default-features --features agent --bin network-watch-agent
//!
//! 子命令：`check`、`upgrade`、`hosts`、`label`、`machine-id`、`guide`（`--help` 查看）。无子命令时为运行采集循环。
//!
//! Runtime env:
//! - NETWORK_WATCH_MACHINE_ID
//! - NETWORK_WATCH_WEB (default 1)
//! - NETWORK_WATCH_WEB_BIND (default 0.0.0.0:17321)
//! - NETWORK_WATCH_DISCOVERY_PORT (default 17322)
//! - NETWORK_WATCH_DISCOVERY_INTERVAL_SECS (default 10)
//! - NETWORK_WATCH_NODE_TTL_SECS (default 30)
//! - NETWORK_WATCH_CAPABILITY_PATH (default /api/v1/capabilities)
//! - NETWORK_WATCH_COLLECTOR (fallback when discovery empty)
//! - NETWORK_WATCH_PUSH_TIMEOUT_SECS (default 3)
//! - Linux：`NETWORK_WATCH_AGENT_LOG`（默认当前目录 `network-watch-agent.log`）
//! - Linux：`NETWORK_WATCH_AGENT_FOREGROUND=1` 时以前台运行（不守护进程化）
//! - 升级：`NETWORK_WATCH_AGENT_GITHUB_REPO`、`NETWORK_WATCH_AGENT_GITHUB_TOKEN`（可选）

use clap::Parser;
use network_watch_lib::agent::cli::{AgentCommand, Cli};

fn main() {
    let cli = Cli::parse();
    let host_name = hostname::get()
        .ok()
        .and_then(|v| v.into_string().ok())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    match cli.command {
        Some(AgentCommand::Check) => {
            if let Err(e) = network_watch_lib::agent::upgrade::run_check() {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        Some(AgentCommand::Upgrade { dry_run }) => {
            if let Err(e) = network_watch_lib::agent::upgrade::run_upgrade(dry_run) {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        Some(AgentCommand::Hosts {
            wait_secs,
            json,
            push,
        }) => {
            if let Err(e) = network_watch_lib::agent::hosts_cmd::run_hosts(wait_secs, json, push) {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        Some(AgentCommand::Guide { env_only }) => {
            network_watch_lib::agent::hosts_cmd::run_guide(env_only);
        }
        Some(AgentCommand::Label { value, clear }) => {
            if let Err(e) = network_watch_lib::agent::label_cmd::run_label(value, clear, &host_name) {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        Some(AgentCommand::MachineId { value, clear }) => {
            if let Err(e) = network_watch_lib::agent::machine_id_cmd::run_machine_id(value, clear) {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
        None => {
            #[cfg(target_os = "linux")]
            {
                if let Err(e) = network_watch_lib::linux_prepare_standalone_agent() {
                    eprintln!("[network-watch-agent] 启动失败: {e}");
                    std::process::exit(1);
                }
            }
            network_watch_lib::run_standalone_agent();
        }
    }
}

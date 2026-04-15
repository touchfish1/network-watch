//! `hosts` / `guide` 子命令实现。

use crate::agent::discovery::discover_gui_nodes_once;
use crate::agent::machine_id_cmd::get_or_create_machine_id;
use crate::env_u64;

/// 列出发现的节点；可选将 JSON 推送到 `--push URL`。
pub fn run_hosts(wait_secs: u64, json: bool, push: Option<String>) -> Result<(), String> {
    let nodes = discover_gui_nodes_once(wait_secs)?;

    if json {
        let payload = serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "wait_secs": wait_secs,
            "count": nodes.len(),
            "nodes": nodes,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?
        );
    } else if nodes.is_empty() {
        println!("(未发现 GUI 节点，可加大 --wait-secs 或检查防火墙 / UDP 广播)");
    } else {
        println!("BASE_URL\tINGEST_URL");
        for n in &nodes {
            println!("{}\t{}", n.base_url, n.ingest_url);
        }
    }

    if let Some(url) = push {
        if url.is_empty() {
            return Err("参数 --push 的 URL 不能为空".to_string());
        }
        let timeout = env_u64("NETWORK_WATCH_PUSH_TIMEOUT_SECS", 3);
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(timeout))
            .build()
            .map_err(|e| e.to_string())?;
        let machine_id = get_or_create_machine_id();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let body = serde_json::json!({
            "source": "network-watch-agent",
            "version": env!("CARGO_PKG_VERSION"),
            "machine_id": machine_id,
            "discovered_at_ms": ts,
            "wait_secs": wait_secs,
            "count": nodes.len(),
            "ingest_urls": nodes.iter().map(|n| &n.ingest_url).collect::<Vec<_>>(),
            "nodes": nodes,
        });
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .map_err(|e| format!("推送失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("推送返回 HTTP {}", resp.status()));
        }
        eprintln!("[hosts] 已推送到 {url}（HTTP {}）", resp.status());
    }

    Ok(())
}

/// 打印完整说明；`env_only` 时仅列出环境变量说明。
pub fn run_guide(env_only: bool) {
    if env_only {
        print_env_only();
    } else {
        print_full_guide();
    }
}

fn print_env_only() {
    print!(
        r#"运行模式类
  NETWORK_WATCH_MACHINE_ID          本机标识（上报 JSON 中的 machine_id）
  NETWORK_WATCH_COLLECTOR           未发现 GUI 时的兜底 ingest URL（如 http://主控:17321/api/v1/ingest）
  NETWORK_WATCH_DISCOVERY_PORT      UDP 发现端口（默认 17322）
  NETWORK_WATCH_DISCOVERY_INTERVAL_SECS  常驻 agent 发现周期（秒）
  NETWORK_WATCH_NODE_TTL_SECS       节点过期时间（秒）
  NETWORK_WATCH_CAPABILITY_PATH     capabilities HTTP 路径（默认 /api/v1/capabilities）
  NETWORK_WATCH_PUSH_TIMEOUT_SECS   HTTP 请求超时（秒）
  NETWORK_WATCH_AGENT_FOREGROUND    Linux 前台运行（1/true，不守护进程）
  NETWORK_WATCH_AGENT_LOG           Linux 日志文件路径（默认当前目录 network-watch-agent.log）
  NETWORK_WATCH_WEB / BIND          agent 内嵌 Web（默认开启，支持通过 IP:端口访问）

升级类
  NETWORK_WATCH_AGENT_GITHUB_REPO   owner/repo（默认 touchfish1/network-watch）
  NETWORK_WATCH_AGENT_GITHUB_TOKEN    GitHub API token（可选）

"#
    );
}

fn print_full_guide() {
    print!(
        r#"network-watch-agent — Network Watch 无头采集 agent

用法概览
  network-watch-agent              常驻运行：采集并推送到发现的 GUI 或兜底 URL
  network-watch-agent check        检查 GitHub 是否有新版本
  network-watch-agent upgrade      从 GitHub Release 自更新当前二进制
  network-watch-agent hosts        单次扫描局域网 GUI 节点，打印 base / ingest
  network-watch-agent label [VALUE] 查看/设置本机展示标签（Web/GUI 列表显示）
  network-watch-agent machine-id [VALUE] 查看/设置 machine_id（上报主键）
  network-watch-agent hosts --push <URL>   扫描后将 JSON 列表 POST 到给定 URL
  network-watch-agent guide        本说明（同 help）
  network-watch-agent -h           clap 简短帮助

hosts 说明
  --wait-secs <秒>  单次广播后监听时长（默认 2）
  --json            终端输出为 JSON
  --push <URL>      将节点列表以 JSON POST（含 machine_id、ingest_urls、nodes）

推送 JSON 字段示例
  source, version, machine_id, discovered_at_ms, wait_secs, count, ingest_urls, nodes[]

"#
    );
    print_env_only();
}

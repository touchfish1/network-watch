//! `network-watch-agent` 命令行入口（clap）。

use clap::{Parser, Subcommand};

/// Network Watch 无头采集 agent。
///
/// 不带子命令时：进入采集与上报循环（Linux 默认守护进程化，见 crate 文档）。
#[derive(Parser)]
#[command(name = "network-watch-agent")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(
    about = "Network Watch 无头 agent：采集指标、发现 GUI、上报；含 check/upgrade/hosts 等子命令",
    long_about = None
)]
#[command(
    after_help = "简要：check=检查更新，upgrade=自更新，hosts=枚举局域网 GUI，guide=完整说明。\n常用环境：NETWORK_WATCH_MACHINE_ID、NETWORK_WATCH_COLLECTOR、NETWORK_WATCH_DISCOVERY_PORT。"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<AgentCommand>,
}

#[derive(Subcommand, Debug)]
pub enum AgentCommand {
    /// 查询当前版本并检查 GitHub Release 是否有新版本（不下载）
    Check,
    /// 从 GitHub Release 下载与当前架构匹配的 agent 并覆盖当前可执行文件
    Upgrade {
        /// 仅打印将要下载的地址，不写入磁盘
        #[arg(long)]
        dry_run: bool,
    },
    /// 单次扫描局域网内 GUI 节点；可将结果以 JSON POST 到 `--push URL`
    Hosts {
        /// 发出 UDP 广播后持续监听并校验 capabilities 的秒数（≥1）
        #[arg(long, default_value_t = 2)]
        wait_secs: u64,
        /// 终端输出为 JSON
        #[arg(long)]
        json: bool,
        /// 将节点列表 POST 到此 URL（`Content-Type: application/json`）
        #[arg(long)]
        push: Option<String>,
    },
    /// 打印完整使用说明（环境变量、子命令）。别名：help
    #[command(visible_alias = "help")]
    Guide {
        /// 仅输出环境变量说明段落
        #[arg(long)]
        env_only: bool,
    },
    /// 查看/设置本机展示标签（用于 Web/GUI 列表显示）。
    ///
    /// - 不带参数：打印当前 label；若未设置则自动生成 `主机名-xxxxx` 并写入配置
    /// - 带参数：设置为给定 label
    /// - `--clear`：清除已设置 label
    Label {
        /// 设置为指定 label（空则为查看）
        value: Option<String>,
        /// 清除已设置 label
        #[arg(long)]
        clear: bool,
    },
}

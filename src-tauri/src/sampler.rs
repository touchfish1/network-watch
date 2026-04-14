//! 系统指标采样线程（每秒）。
//!
//! 该模块使用 `sysinfo` 周期性采样系统状态，并向前端广播事件：
//! - 事件名：`constants::EVENT_SYSTEM_SNAPSHOT`（即 `"system-snapshot"`）
//! - 周期：当前固定为 1s（见 `start_sampler` 内的 sleep）
//!
//! 指标口径说明：
//! - `network_download`/`network_upload`：对所有网卡的 **received/transmitted 累计增量** 求和。
//!   因为采样周期为 1s，所以“每次刷新拿到的增量”可近似视为 B/s。
//! - `nics[*].received/transmitted`：单网卡的增量（同上，周期为 1s）。
//! - `system_disk`：Windows 默认选择 `C:\\` 挂载点；非 Windows 默认选择 `/`。
//! - `top_processes_*`：取 Top N（当前 N=5），按 CPU/内存分别排序并截断。

use std::{
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use sysinfo::{
    CpuRefreshKind, Disks, MemoryRefreshKind, Networks, Pid, ProcessRefreshKind, ProcessesToUpdate,
    RefreshKind, System,
};
use tauri::{AppHandle, Emitter};

use crate::{constants, state};

/// 进程快照（用于 Top 列表展示）。
///
/// 字段单位：
/// - `cpu_usage`：百分比（0~100+，取决于 sysinfo 口径）
/// - `memory_used`：字节（与前端展示的 Bytes/GB 换算一致）
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ProcessSnapshot {
    /// 进程 ID（平台相关；这里统一序列化为 `u32` 便于前端展示）。
    pub pid: u32,
    /// 进程名（来自 sysinfo）。
    pub name: String,
    /// CPU 占用百分比（来自 sysinfo，采样后计算）。
    pub cpu_usage: f32,
    /// 内存占用（字节）。
    pub memory_used: u64,
}

/// 单网卡采样增量（1s）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct NicSnapshot {
    /// 网卡 ID（通常为接口名，如 `Ethernet`/`Wi-Fi`）。
    pub id: String,
    /// 本周期接收字节增量（约等于 B/s）。
    pub received: u64,
    /// 本周期发送字节增量（约等于 B/s）。
    pub transmitted: u64,
}

/// 磁盘空间快照（容量与可用空间）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DiskSnapshot {
    /// 磁盘唯一标识（优先用挂载点；否则用名称）。
    pub id: String,
    /// 磁盘名称（平台相关）。
    pub name: String,
    /// 挂载点（例如 Windows 的 `C:\\`，Linux/macOS 的 `/`、`/Volumes/...`）。
    pub mount: String,
    /// 总容量（字节）。
    pub total_bytes: u64,
    /// 可用容量（字节）。
    pub available_bytes: u64,
}

/// 系统盘摘要（用于在“系统总览”里快速展示）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DiskSummary {
    /// 总容量（字节）。
    pub total_bytes: u64,
    /// 可用容量（字节）。
    pub available_bytes: u64,
}

/// 单次系统快照（通过事件广播给前端）。
///
/// 设计原则：\n+/// - 结构可序列化（serde）且字段名稳定（snake_case），便于前端 TypeScript 对齐\n+/// - 单次快照应尽量“自洽”：包含时间戳与足够信息用于展示/诊断\n+/// - 指标以“轻量采样”为主，避免引入高权限/高开销调用
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SystemSnapshot {
    /// 快照时间戳（毫秒，Unix epoch）。
    pub timestamp: u64,
    /// 整机 CPU 占用百分比。
    pub cpu_usage: f32,
    /// 已用内存（字节）。
    pub memory_used: u64,
    /// 总内存（字节）。
    pub memory_total: u64,
    /// 全网卡下载增量（字节/周期；周期为 1s，约等于 B/s）。
    pub network_download: u64,
    /// 全网卡上传增量（字节/周期；周期为 1s，约等于 B/s）。
    pub network_upload: u64,
    /// 多网卡增量列表（字节/周期）。
    pub nics: Vec<NicSnapshot>,
    /// 选出的“活跃网卡”（按 `received+transmitted` 最大，且 >0）。
    pub active_nic_id: Option<String>,
    /// 磁盘列表（容量与可用空间）。
    pub disks: Vec<DiskSnapshot>,
    /// 系统盘摘要（见模块说明的判定规则）。
    pub system_disk: Option<DiskSummary>,
    /// 系统运行时长（秒）。
    pub uptime_seconds: u64,
    /// 当前进程数。
    pub process_count: usize,
    /// CPU 占用 Top N 进程（N=5）。
    pub top_processes_cpu: Vec<ProcessSnapshot>,
    /// 内存占用 Top N 进程（N=5）。
    pub top_processes_memory: Vec<ProcessSnapshot>,
}

/// 启动采样线程。
///
/// - **线程模型**：后台线程每秒采样一次并 emit\n+/// - **失败策略**：尽量不 panic；emit 失败会被忽略（前端可能未监听/窗口未就绪）\n+/// - **性能**：使用 `new_with_specifics` 只刷新需要的子系统，避免不必要开销
pub fn start_sampler(app: AppHandle) {
    thread::spawn(move || {
        let mut system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything())
                .with_processes(ProcessRefreshKind::everything()),
        );
        let mut networks = Networks::new_with_refreshed_list();
        let mut disks = Disks::new_with_refreshed_list();

        loop {
            system.refresh_cpu_usage();
            system.refresh_memory();
            system.refresh_processes(ProcessesToUpdate::All, true);
            networks.refresh(true);
            disks.refresh(true);

            let cpu_usage = system.global_cpu_usage();
            let memory_used = system.used_memory();
            let memory_total = system.total_memory();
            let uptime_seconds = System::uptime();
            let process_count = system.processes().len();

            let mut network_download = 0_u64;
            let mut network_upload = 0_u64;
            let mut nics = Vec::<NicSnapshot>::new();
            let mut active_nic_id: Option<String> = None;
            let mut active_score = 0_u64;

            for (_name, data) in &networks {
                let received = data.received();
                let transmitted = data.transmitted();
                network_download = network_download.saturating_add(received);
                network_upload = network_upload.saturating_add(transmitted);
            }

            for (name, data) in &networks {
                let received = data.received();
                let transmitted = data.transmitted();
                let score = received.saturating_add(transmitted);
                if score >= active_score && score > 0 {
                    active_score = score;
                    active_nic_id = Some(name.to_string());
                }
                nics.push(NicSnapshot {
                    id: name.to_string(),
                    received,
                    transmitted,
                });
            }

            let mut disk_items = Vec::<DiskSnapshot>::new();
            let mut system_disk: Option<DiskSummary> = None;

            for disk in &disks {
                let mount = disk.mount_point().to_string_lossy().to_string();
                let name = disk.name().to_string_lossy().to_string();
                let total_bytes = disk.total_space();
                let available_bytes = disk.available_space();
                let id = if !mount.is_empty() { mount.clone() } else { name.clone() };

                #[cfg(target_os = "windows")]
                let is_system = mount.to_ascii_lowercase().starts_with("c:\\");
                #[cfg(not(target_os = "windows"))]
                let is_system = mount == "/";

                if system_disk.is_none() && is_system {
                    system_disk = Some(DiskSummary {
                        total_bytes,
                        available_bytes,
                    });
                }

                disk_items.push(DiskSnapshot {
                    id,
                    name,
                    mount,
                    total_bytes,
                    available_bytes,
                });
            }

            // 注意：这里分别生成两份 Vec 以便按不同字段排序；Top N 很小，复制成本可接受。
            let mut top_processes_cpu = system
                .processes()
                .iter()
                .map(|(pid, process)| ProcessSnapshot {
                    pid: pid_to_u32(*pid),
                    name: process.name().to_string_lossy().to_string(),
                    cpu_usage: process.cpu_usage(),
                    memory_used: process.memory(),
                })
                .collect::<Vec<_>>();
            top_processes_cpu.sort_by(|a, b| b.cpu_usage.total_cmp(&a.cpu_usage));
            top_processes_cpu.truncate(5);

            let mut top_processes_memory = system
                .processes()
                .iter()
                .map(|(pid, process)| ProcessSnapshot {
                    pid: pid_to_u32(*pid),
                    name: process.name().to_string_lossy().to_string(),
                    cpu_usage: process.cpu_usage(),
                    memory_used: process.memory(),
                })
                .collect::<Vec<_>>();
            top_processes_memory.sort_by(|a, b| b.memory_used.cmp(&a.memory_used));
            top_processes_memory.truncate(5);

            let snapshot = SystemSnapshot {
                timestamp: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or_default(),
                cpu_usage,
                memory_used,
                memory_total,
                network_download,
                network_upload,
                nics,
                active_nic_id,
                disks: disk_items,
                system_disk,
                uptime_seconds,
                process_count,
                top_processes_cpu,
                top_processes_memory,
            };

            state::record_snapshot(snapshot.timestamp);
            let _ = app.emit(constants::EVENT_SYSTEM_SNAPSHOT, snapshot);
            thread::sleep(Duration::from_secs(1));
        }
    });
}

/// 将平台相关的 `Pid` 转成可序列化/可展示的 `u32`。
fn pid_to_u32(pid: Pid) -> u32 {
    #[allow(clippy::cast_possible_truncation)]
    pid.as_u32()
}


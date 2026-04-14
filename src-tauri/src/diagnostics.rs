//! 运行时诊断信息（提供给前端展示/排障）。
//!
//! 诊断信息不参与业务逻辑决策，主要用途：
//! - 验证采样线程是否持续在跑
//! - 验证 overlay 当前是否处于“可交互”模式
//! - 快速判断前端收到的快照是否新鲜（age）

use serde::Serialize;

use crate::state;

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


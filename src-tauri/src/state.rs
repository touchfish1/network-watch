//! 运行时跨线程状态（atomic）。
//!
//! 这些状态会被多个线程读写：
//! - 前端 `invoke` 命令线程：更新 overlay 交互性
//! - Windows topmost guard：周期性读取交互状态并重应用 overlay
//! - 采样线程：记录 tick 次数与最近一次快照时间
//! - 主线程/窗口事件回调：在失焦等场景回退 overlay 交互性
//!
//! 这里统一使用 `Ordering::Relaxed`：
//! - 我们关心的是“最新值大概率可见”，而非跨多个原子变量的严格时序一致性
//! - 这些值不会参与内存安全相关的同步（不作为锁/队列指针使用）
//! - 读取滞后 1~2 个调度周期在语义上是可接受的（UI/置顶策略容错）
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// 是否允许 overlay 接收交互（前端可点击/可滚动）。
///
/// - **写入方**：`overlay::set_overlay_interactive`（前端触发）、`windowing` 的失焦兜底
/// - **读取方**：Windows topmost guard、窗口事件回调
pub static OVERLAY_INTERACTIVE: AtomicBool = AtomicBool::new(false);

/// Windows：是否开启鼠标穿透（窗口不接收鼠标事件）。
///
/// - **写入方**：前端命令、托盘菜单\n+/// - **读取方**：overlay 应用函数/窗口事件回调（用于重申窗口样式）
pub static CLICK_THROUGH_ENABLED: AtomicBool = AtomicBool::new(false);

/// 采样线程 tick 计数（用于诊断“采样是否还在跑”）。
pub static SAMPLER_TICK_COUNT: AtomicU64 = AtomicU64::new(0);

/// 最近一次发出系统快照的时间戳（毫秒，Unix epoch）。
pub static LAST_SNAPSHOT_AT_MS: AtomicU64 = AtomicU64::new(0);

/// 设置 overlay 交互性（Relaxed）。
pub fn set_overlay_interactive(value: bool) {
    OVERLAY_INTERACTIVE.store(value, Ordering::Relaxed);
}

/// 读取 overlay 交互性（Relaxed）。
pub fn overlay_interactive() -> bool {
    OVERLAY_INTERACTIVE.load(Ordering::Relaxed)
}

/// 设置鼠标穿透开关（Relaxed）。
pub fn set_click_through_enabled(value: bool) {
    CLICK_THROUGH_ENABLED.store(value, Ordering::Relaxed);
}

/// 读取鼠标穿透开关（Relaxed）。
pub fn click_through_enabled() -> bool {
    CLICK_THROUGH_ENABLED.load(Ordering::Relaxed)
}

/// 记录一次系统快照的发出（用于运行时诊断）。
///
/// - `timestamp_ms`：快照中携带的时间戳（毫秒）
pub fn record_snapshot(timestamp_ms: u64) {
    LAST_SNAPSHOT_AT_MS.store(timestamp_ms, Ordering::Relaxed);
    SAMPLER_TICK_COUNT.fetch_add(1, Ordering::Relaxed);
}

/// 获取采样 tick 次数。
pub fn snapshot_tick_count() -> u64 {
    SAMPLER_TICK_COUNT.load(Ordering::Relaxed)
}

/// 获取最近一次快照时间戳（毫秒）。
pub fn last_snapshot_at_ms() -> u64 {
    LAST_SNAPSHOT_AT_MS.load(Ordering::Relaxed)
}


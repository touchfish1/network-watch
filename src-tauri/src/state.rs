use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub static OVERLAY_INTERACTIVE: AtomicBool = AtomicBool::new(false);
pub static SAMPLER_TICK_COUNT: AtomicU64 = AtomicU64::new(0);
pub static LAST_SNAPSHOT_AT_MS: AtomicU64 = AtomicU64::new(0);

pub fn set_overlay_interactive(value: bool) {
    OVERLAY_INTERACTIVE.store(value, Ordering::Relaxed);
}

pub fn overlay_interactive() -> bool {
    OVERLAY_INTERACTIVE.load(Ordering::Relaxed)
}

pub fn record_snapshot(timestamp_ms: u64) {
    LAST_SNAPSHOT_AT_MS.store(timestamp_ms, Ordering::Relaxed);
    SAMPLER_TICK_COUNT.fetch_add(1, Ordering::Relaxed);
}

pub fn snapshot_tick_count() -> u64 {
    SAMPLER_TICK_COUNT.load(Ordering::Relaxed)
}

pub fn last_snapshot_at_ms() -> u64 {
    LAST_SNAPSHOT_AT_MS.load(Ordering::Relaxed)
}


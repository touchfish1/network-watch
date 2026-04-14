use serde::Serialize;

use crate::state;

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RuntimeDiagnostics {
    overlay_interactive: bool,
    sampler_tick_count: u64,
    last_snapshot_at_ms: u64,
}

#[tauri::command]
pub fn get_runtime_diagnostics() -> RuntimeDiagnostics {
    RuntimeDiagnostics {
        overlay_interactive: state::overlay_interactive(),
        sampler_tick_count: state::snapshot_tick_count(),
        last_snapshot_at_ms: state::last_snapshot_at_ms(),
    }
}


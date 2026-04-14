use std::{
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use sysinfo::{CpuRefreshKind, MemoryRefreshKind, Networks, RefreshKind, System};
use tauri::{AppHandle, Emitter};

use crate::{constants, state};

#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SystemSnapshot {
    pub timestamp: u64,
    pub cpu_usage: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub network_download: u64,
    pub network_upload: u64,
}

pub fn start_sampler(app: AppHandle) {
    thread::spawn(move || {
        let mut system = System::new_with_specifics(
            RefreshKind::nothing()
                .with_cpu(CpuRefreshKind::everything())
                .with_memory(MemoryRefreshKind::everything()),
        );
        let mut networks = Networks::new_with_refreshed_list();

        loop {
            system.refresh_cpu_usage();
            system.refresh_memory();
            networks.refresh(true);

            let cpu_usage = system.global_cpu_usage();
            let memory_used = system.used_memory();
            let memory_total = system.total_memory();

            let mut network_download = 0_u64;
            let mut network_upload = 0_u64;

            for (_name, data) in &networks {
                network_download = network_download.saturating_add(data.received());
                network_upload = network_upload.saturating_add(data.transmitted());
            }

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
            };

            state::record_snapshot(snapshot.timestamp);
            let _ = app.emit(constants::EVENT_SYSTEM_SNAPSHOT, snapshot);
            thread::sleep(Duration::from_secs(1));
        }
    });
}


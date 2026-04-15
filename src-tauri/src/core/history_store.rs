//! SQLite 历史落盘（分钟级）与事件流。
//!
//! 目标：
//! - 低开销：以“分钟”为粒度 upsert 指标点（同一分钟多次写入会覆盖）
//! - 可查询：提供 24h / 7d（或任意 since_ms）范围读取
//! - 可运维：支持 env 覆盖数据库路径

use rusqlite::{params, Connection};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const DB_PATH_ENV: &str = "NETWORK_WATCH_DB_PATH";

fn config_dir() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("XDG_CONFIG_HOME") {
        let p = PathBuf::from(v);
        if p.is_absolute() {
            return Some(p);
        }
    }
    if let Ok(v) = std::env::var("HOME") {
        if !v.trim().is_empty() {
            return Some(PathBuf::from(v).join(".config"));
        }
    }
    if let Ok(v) = std::env::var("APPDATA") {
        if !v.trim().is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    None
}

pub fn default_db_path() -> PathBuf {
    if let Ok(v) = std::env::var(DB_PATH_ENV) {
        let p = PathBuf::from(v);
        if p.is_absolute() {
            return p;
        }
        if let Ok(cwd) = std::env::current_dir() {
            return cwd.join(p);
        }
        return p;
    }
    config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("network-watch")
        .join("history.db")
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("db path has no parent".to_string());
    };
    fs::create_dir_all(parent).map_err(|e| format!("create db dir failed: {e}"))?;
    Ok(())
}

pub fn init_db(path: &Path) -> Result<(), String> {
    ensure_parent_dir(path)?;
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
CREATE TABLE IF NOT EXISTS metrics_minute (
  machine_id TEXT NOT NULL,
  ts_minute_ms INTEGER NOT NULL,
  cpu REAL NOT NULL,
  mem_pct REAL NOT NULL,
  down REAL NOT NULL,
  up REAL NOT NULL,
  PRIMARY KEY(machine_id, ts_minute_ms)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms INTEGER NOT NULL,
  machine_id TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_ms DESC);
CREATE INDEX IF NOT EXISTS idx_events_machine ON events(machine_id, ts_ms DESC);
"#,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn floor_to_minute_ms(ts_ms: u64) -> u64 {
    (ts_ms / 60_000) * 60_000
}

pub fn upsert_metrics_minute(
    db_path: &Path,
    machine_id: &str,
    ts_ms: u64,
    cpu: f64,
    mem_pct: f64,
    down: f64,
    up: f64,
) -> Result<(), String> {
    let ts_min = floor_to_minute_ms(ts_ms) as i64;
    ensure_parent_dir(db_path)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        r#"
INSERT INTO metrics_minute(machine_id, ts_minute_ms, cpu, mem_pct, down, up)
VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT(machine_id, ts_minute_ms) DO UPDATE SET
  cpu=excluded.cpu,
  mem_pct=excluded.mem_pct,
  down=excluded.down,
  up=excluded.up
"#,
        params![machine_id, ts_min, cpu, mem_pct, down, up],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct MetricPoint {
    pub ts_ms: u64,
    pub cpu: f64,
    pub mem_pct: f64,
    pub down: f64,
    pub up: f64,
}

pub fn query_metrics_since(
    db_path: &Path,
    machine_id: &str,
    since_ms: u64,
) -> Result<Vec<MetricPoint>, String> {
    ensure_parent_dir(db_path)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"
SELECT ts_minute_ms, cpu, mem_pct, down, up
FROM metrics_minute
WHERE machine_id = ?1 AND ts_minute_ms >= ?2
ORDER BY ts_minute_ms ASC
"#,
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![machine_id, since_ms as i64])
        .map_err(|e| e.to_string())?;
    let mut out = Vec::<MetricPoint>::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        out.push(MetricPoint {
            ts_ms: row.get::<_, i64>(0).map_err(|e| e.to_string())? as u64,
            cpu: row.get::<_, f64>(1).map_err(|e| e.to_string())?,
            mem_pct: row.get::<_, f64>(2).map_err(|e| e.to_string())?,
            down: row.get::<_, f64>(3).map_err(|e| e.to_string())?,
            up: row.get::<_, f64>(4).map_err(|e| e.to_string())?,
        });
    }
    Ok(out)
}

pub fn query_metrics_aggregate_since(db_path: &Path, since_ms: u64) -> Result<Vec<MetricPoint>, String> {
    ensure_parent_dir(db_path)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  ts_minute_ms,
  AVG(cpu) as cpu_avg,
  AVG(mem_pct) as mem_avg,
  SUM(down) as down_sum,
  SUM(up) as up_sum
FROM metrics_minute
WHERE ts_minute_ms >= ?1
GROUP BY ts_minute_ms
ORDER BY ts_minute_ms ASC
"#,
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![since_ms as i64]).map_err(|e| e.to_string())?;
    let mut out = Vec::<MetricPoint>::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        out.push(MetricPoint {
            ts_ms: row.get::<_, i64>(0).map_err(|e| e.to_string())? as u64,
            cpu: row.get::<_, f64>(1).map_err(|e| e.to_string())?,
            mem_pct: row.get::<_, f64>(2).map_err(|e| e.to_string())?,
            down: row.get::<_, f64>(3).map_err(|e| e.to_string())?,
            up: row.get::<_, f64>(4).map_err(|e| e.to_string())?,
        });
    }
    Ok(out)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub struct EventRow {
    pub ts_ms: u64,
    pub machine_id: String,
    pub label: String,
    pub r#type: String,
}

pub fn insert_event(db_path: &Path, machine_id: &str, label: &str, event_type: &str, ts_ms: u64) -> Result<(), String> {
    ensure_parent_dir(db_path)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO events(ts_ms, machine_id, label, type) VALUES (?1, ?2, ?3, ?4)",
        params![ts_ms as i64, machine_id, label, event_type],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn query_events(
    db_path: &Path,
    machine_id: Option<&str>,
    since_ms: Option<u64>,
    until_ms: Option<u64>,
    offset: usize,
    limit: usize,
) -> Result<Vec<EventRow>, String> {
    ensure_parent_dir(db_path)?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let limit = limit.clamp(1, 500) as i64;
    let offset = offset as i64;
    let since = since_ms.unwrap_or(0) as i64;
    let until = until_ms.unwrap_or(u64::MAX) as i64;
    let mut out = Vec::<EventRow>::new();

    if let Some(mid) = machine_id {
        let mut stmt = conn
            .prepare(
                r#"
SELECT ts_ms, machine_id, label, type
FROM events
WHERE machine_id = ?1
  AND ts_ms >= ?2
  AND ts_ms <= ?3
ORDER BY ts_ms DESC
LIMIT ?4 OFFSET ?5
"#,
            )
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query(params![mid, since, until, limit, offset])
            .map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            out.push(EventRow {
                ts_ms: row.get::<_, i64>(0).map_err(|e| e.to_string())? as u64,
                machine_id: row.get::<_, String>(1).map_err(|e| e.to_string())?,
                label: row.get::<_, String>(2).map_err(|e| e.to_string())?,
                r#type: row.get::<_, String>(3).map_err(|e| e.to_string())?,
            });
        }
        return Ok(out);
    }

    let mut stmt = conn
        .prepare(
            r#"
SELECT ts_ms, machine_id, label, type
FROM events
WHERE ts_ms >= ?1
  AND ts_ms <= ?2
ORDER BY ts_ms DESC
LIMIT ?3 OFFSET ?4
"#,
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![since, until, limit, offset])
        .map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        out.push(EventRow {
            ts_ms: row.get::<_, i64>(0).map_err(|e| e.to_string())? as u64,
            machine_id: row.get::<_, String>(1).map_err(|e| e.to_string())?,
            label: row.get::<_, String>(2).map_err(|e| e.to_string())?,
            r#type: row.get::<_, String>(3).map_err(|e| e.to_string())?,
        });
    }
    Ok(out)
}


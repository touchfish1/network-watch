//! `machine_id` 子命令：查看/设置本机 machine_id，并在未配置时自动生成稳定值。

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MACHINE_ID_FILE_ENV: &str = "NETWORK_WATCH_MACHINE_ID_FILE";
const MACHINE_ID_ENV: &str = "NETWORK_WATCH_MACHINE_ID";

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

fn machine_id_file_path() -> Option<PathBuf> {
    if let Ok(v) = std::env::var(MACHINE_ID_FILE_ENV) {
        let p = PathBuf::from(v);
        if p.is_absolute() {
            return Some(p);
        }
        return std::env::current_dir().ok().map(|cwd| cwd.join(p));
    }
    config_dir().map(|dir| dir.join("network-watch").join("machine_id.txt"))
}

fn normalize_machine_id(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cleaned = trimmed
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == '.')
        .collect::<String>();
    let cleaned = cleaned.trim_matches(['-', '_', '.']);
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn read_machine_id(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    normalize_machine_id(&buf)
}

fn write_machine_id(path: &Path, machine_id: &str) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("machine_id 文件路径无 parent".to_string());
    };
    fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let mut f = fs::File::create(path).map_err(|e| format!("写入 machine_id 失败: {e}"))?;
    f.write_all(machine_id.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("写入 machine_id 失败: {e}"))?;
    Ok(())
}

fn delete_machine_id(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("删除 machine_id 文件失败: {e}"))?;
    }
    Ok(())
}

fn random_suffix_8() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let mut x = nanos ^ (pid.rotate_left(13)) ^ (nanos >> 11);
    let mut out = String::new();
    for _ in 0..8 {
        x = x
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let v = (x % 36) as u8;
        let c = if v < 10 {
            (b'0' + v) as char
        } else {
            (b'a' + (v - 10)) as char
        };
        out.push(c);
    }
    out
}

pub fn get_machine_id() -> Option<String> {
    if let Ok(v) = std::env::var(MACHINE_ID_ENV) {
        if let Some(clean) = normalize_machine_id(&v) {
            return Some(clean);
        }
    }
    let p = machine_id_file_path()?;
    read_machine_id(&p)
}

pub fn get_or_create_machine_id() -> String {
    if let Some(existing) = get_machine_id() {
        return existing;
    }
    let generated = format!("agent-{}", random_suffix_8());
    if let Some(p) = machine_id_file_path() {
        let _ = write_machine_id(&p, &generated);
    }
    generated
}

pub fn set_machine_id(value: &str) -> Result<String, String> {
    let Some(clean) = normalize_machine_id(value) else {
        return Err("machine_id 不能为空，且仅支持字母/数字/-/_/.".to_string());
    };
    let p = machine_id_file_path().ok_or_else(|| "无法确定 machine_id 文件路径".to_string())?;
    write_machine_id(&p, &clean)?;
    Ok(clean)
}

pub fn clear_machine_id() -> Result<(), String> {
    let p = machine_id_file_path().ok_or_else(|| "无法确定 machine_id 文件路径".to_string())?;
    delete_machine_id(&p)
}

pub fn run_machine_id(value: Option<String>, clear: bool) -> Result<(), String> {
    if clear {
        clear_machine_id()?;
        println!("(machine_id 已清除)");
        return Ok(());
    }
    if let Some(v) = value {
        let machine_id = set_machine_id(&v)?;
        println!("{machine_id}");
        return Ok(());
    }
    let machine_id = get_or_create_machine_id();
    println!("{machine_id}");
    Ok(())
}

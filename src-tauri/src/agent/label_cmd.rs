//! `label` 子命令：为本机设置一个稳定的展示标签。
//!
//! 设计：
//! - 标签持久化到本机配置文件（默认：Linux `~/.config/network-watch/label.txt`）
//! - 未设置时自动生成：`主机名 + 5位随机字符`，并写入文件，保证后续稳定

use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const LABEL_FILE_ENV: &str = "NETWORK_WATCH_LABEL_FILE";

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

fn label_file_path() -> Option<PathBuf> {
    if let Ok(v) = std::env::var(LABEL_FILE_ENV) {
        let p = PathBuf::from(v);
        if p.is_absolute() {
            return Some(p);
        }
        return std::env::current_dir().ok().map(|cwd| cwd.join(p));
    }
    config_dir().map(|dir| dir.join("network-watch").join("label.txt"))
}

fn normalize_label(s: &str) -> Option<String> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    // 避免控制字符/换行，保持单行可读
    let cleaned = trimmed
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn read_label(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    normalize_label(&buf)
}

fn write_label(path: &Path, label: &str) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("label 文件路径无 parent".to_string());
    };
    fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    let mut f = fs::File::create(path).map_err(|e| format!("写入 label 失败: {e}"))?;
    f.write_all(label.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("写入 label 失败: {e}"))?;
    Ok(())
}

fn delete_label(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("删除 label 文件失败: {e}"))?;
    }
    Ok(())
}

fn random_suffix_5() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let mut x = nanos ^ (pid.rotate_left(17)) ^ (nanos >> 7);
    // 生成 5 位 base36（0-9a-z）
    let mut out = String::new();
    for _ in 0..5 {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let v = (x % 36) as u8;
        let c = if v < 10 { (b'0' + v) as char } else { (b'a' + (v - 10)) as char };
        out.push(c);
    }
    out
}

/// 获取稳定 label：已设置则读文件；否则生成默认 label 并写入。
pub fn get_or_create_label(host_name: &str) -> String {
    let path = label_file_path();
    if let Some(p) = &path {
        if let Some(existing) = read_label(p) {
            return existing;
        }
    }
    let base = normalize_label(host_name).unwrap_or_else(|| "host".to_string());
    let label = format!("{base}-{}", random_suffix_5());
    if let Some(p) = &path {
        // 忽略写入失败，不影响运行
        let _ = write_label(p, &label);
    }
    label
}

pub fn get_label() -> Option<String> {
    let p = label_file_path()?;
    read_label(&p)
}

pub fn set_label(value: &str) -> Result<String, String> {
    let Some(clean) = normalize_label(value) else {
        return Err("label 不能为空".to_string());
    };
    let p = label_file_path().ok_or_else(|| "无法确定 label 文件路径".to_string())?;
    write_label(&p, &clean)?;
    Ok(clean)
}

pub fn clear_label() -> Result<(), String> {
    let p = label_file_path().ok_or_else(|| "无法确定 label 文件路径".to_string())?;
    delete_label(&p)
}

/// `label` 子命令入口：
/// - 无参数：打印当前 label（若未设置则生成并打印）
/// - `--clear`：清除 label
/// - `<VALUE>`：设置 label
pub fn run_label(value: Option<String>, clear: bool, host_name: &str) -> Result<(), String> {
    if clear {
        clear_label()?;
        println!("(label 已清除)");
        return Ok(());
    }
    if let Some(v) = value {
        let label = set_label(&v)?;
        println!("{label}");
        return Ok(());
    }
    let label = get_label().unwrap_or_else(|| get_or_create_label(host_name));
    println!("{label}");
    Ok(())
}


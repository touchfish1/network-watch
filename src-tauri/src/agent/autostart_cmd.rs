//! `autostart` 子命令：为 agent 配置开机自启（Linux systemd --user）。

#[cfg(target_os = "linux")]
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[cfg(target_os = "linux")]
const SERVICE_NAME: &str = "network-watch-agent.service";

#[cfg(target_os = "linux")]
fn user_systemd_dir() -> Result<PathBuf, String> {
    if let Ok(v) = std::env::var("XDG_CONFIG_HOME") {
        let p = PathBuf::from(v);
        if p.is_absolute() {
            return Ok(p.join("systemd").join("user"));
        }
    }
    let home = std::env::var("HOME").map_err(|_| "未找到 HOME 环境变量".to_string())?;
    if home.trim().is_empty() {
        return Err("HOME 为空，无法确定 systemd 用户目录".to_string());
    }
    Ok(PathBuf::from(home).join(".config").join("systemd").join("user"))
}

#[cfg(target_os = "linux")]
fn service_file_path() -> Result<PathBuf, String> {
    Ok(user_systemd_dir()?.join(SERVICE_NAME))
}

#[cfg(target_os = "linux")]
fn quote_systemd_value(v: &str) -> String {
    v.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(target_os = "linux")]
fn maybe_env_line(key: &str) -> Option<String> {
    std::env::var(key).ok().and_then(|v| {
        if v.trim().is_empty() {
            None
        } else {
            Some(format!(r#"Environment="{}={}""#, key, quote_systemd_value(&v)))
        }
    })
}

#[cfg(target_os = "linux")]
fn build_service_text(exec_path: &Path, working_dir: &Path) -> String {
    let mut lines = vec![
        "[Unit]".to_string(),
        "Description=Network Watch Agent".to_string(),
        "After=network-online.target".to_string(),
        "Wants=network-online.target".to_string(),
        "".to_string(),
        "[Service]".to_string(),
        "Type=simple".to_string(),
        format!(r#"WorkingDirectory={}"#, working_dir.display()),
        format!(r#"ExecStart={}"#, exec_path.display()),
        "Restart=always".to_string(),
        "RestartSec=3".to_string(),
        r#"Environment="NETWORK_WATCH_AGENT=1""#.to_string(),
    ];

    for key in [
        "NETWORK_WATCH_MACHINE_ID",
        "NETWORK_WATCH_COLLECTOR",
        "NETWORK_WATCH_DISCOVERY_PORT",
        "NETWORK_WATCH_DISCOVERY_INTERVAL_SECS",
        "NETWORK_WATCH_NODE_TTL_SECS",
        "NETWORK_WATCH_CAPABILITY_PATH",
        "NETWORK_WATCH_PUSH_TIMEOUT_SECS",
        "NETWORK_WATCH_WEB",
        "NETWORK_WATCH_WEB_BIND",
    ] {
        if let Some(line) = maybe_env_line(key) {
            lines.push(line);
        }
    }

    lines.extend([
        "".to_string(),
        "[Install]".to_string(),
        "WantedBy=default.target".to_string(),
        "".to_string(),
    ]);

    lines.join("\n")
}

#[cfg(target_os = "linux")]
fn run_systemctl_user(args: &[&str]) -> Result<String, String> {
    let output = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .output()
        .map_err(|e| format!("调用 systemctl 失败: {e}"))?;
    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(text)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(format!(
            "systemctl --user {} 失败: {}{}",
            args.join(" "),
            if stderr.is_empty() { "" } else { &stderr },
            if stdout.is_empty() {
                "".to_string()
            } else {
                format!(" | {}", stdout)
            }
        ))
    }
}

#[cfg(target_os = "linux")]
fn print_status() -> Result<(), String> {
    let service = service_file_path()?;
    let exists = service.exists();
    let enabled = run_systemctl_user(&["is-enabled", SERVICE_NAME]).unwrap_or_else(|_| "unknown".to_string());
    let active = run_systemctl_user(&["is-active", SERVICE_NAME]).unwrap_or_else(|_| "unknown".to_string());
    println!("service_file={}", service.display());
    println!("exists={}", if exists { "yes" } else { "no" });
    println!("enabled={enabled}");
    println!("active={active}");
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn run_autostart(enable: bool, disable: bool, status: bool) -> Result<(), String> {
    if [enable, disable, status].iter().filter(|v| **v).count() > 1 {
        return Err("autostart 只能选择一个动作：--enable / --disable / --status".to_string());
    }

    if status || (!enable && !disable) {
        return print_status();
    }

    let service = service_file_path()?;
    let service_dir = service
        .parent()
        .ok_or_else(|| "无法确定 service 目录".to_string())?;

    if enable {
        fs::create_dir_all(service_dir).map_err(|e| format!("创建 systemd 用户目录失败: {e}"))?;
        let exe = std::env::current_exe().map_err(|e| format!("获取当前可执行文件路径失败: {e}"))?;
        let cwd = std::env::current_dir().map_err(|e| format!("获取当前工作目录失败: {e}"))?;
        let content = build_service_text(&exe, &cwd);
        fs::write(&service, content).map_err(|e| format!("写入 service 文件失败: {e}"))?;
        run_systemctl_user(&["daemon-reload"])?;
        run_systemctl_user(&["enable", "--now", SERVICE_NAME])?;
        println!("已启用开机自启（systemd --user）：{}", service.display());
        return Ok(());
    }

    run_systemctl_user(&["disable", "--now", SERVICE_NAME]).or_else(|e| {
        // 若服务此前未启用，继续清理文件，不让用户被中断。
        eprintln!("{e}");
        Ok::<(), String>(())
    })?;
    if service.exists() {
        fs::remove_file(&service).map_err(|e| format!("删除 service 文件失败: {e}"))?;
    }
    run_systemctl_user(&["daemon-reload"])?;
    println!("已关闭开机自启（systemd --user）。");
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn run_autostart(_enable: bool, _disable: bool, _status: bool) -> Result<(), String> {
    Err("autostart 子命令当前仅支持 Linux（systemd --user）".to_string())
}

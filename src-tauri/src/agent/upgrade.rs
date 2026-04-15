//! Headless agent：通过 GitHub Releases 检查/下载更新。

use reqwest::blocking::Client;
use semver::Version;
use serde::Deserialize;

/// 与 `tauri.conf.json` / 现有 Release 流程一致；可用 `NETWORK_WATCH_AGENT_GITHUB_REPO` 覆盖（`owner/repo`）。
const DEFAULT_GITHUB_REPO: &str = "touchfish1/network-watch";

fn github_repo() -> String {
    std::env::var("NETWORK_WATCH_AGENT_GITHUB_REPO").unwrap_or_else(|_| DEFAULT_GITHUB_REPO.to_string())
}

/// Release 中与当前构建类型对应的资源文件名（CI 上传名）。
pub fn release_asset_filename() -> &'static str {
    if cfg!(target_env = "musl") {
        "network-watch-agent-musl"
    } else {
        "network-watch-agent"
    }
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

fn parse_tag_version(tag: &str) -> Option<Version> {
    Version::parse(tag.trim_start_matches('v')).ok()
}

pub fn current_version() -> Version {
    Version::parse(env!("CARGO_PKG_VERSION")).expect("CARGO_PKG_VERSION must be semver-like")
}

fn github_client() -> Result<Client, String> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

/// 成功且 `Some` 时表示远端有**更高**版本及下载地址。
pub fn check_update_available() -> Result<Option<(Version, String, String)>, String> {
    let client = github_client()?;
    let repo = github_repo();
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let mut req = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "network-watch-agent");
    if let Ok(token) = std::env::var("NETWORK_WATCH_AGENT_GITHUB_TOKEN") {
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
    }
    let res = req
        .send()
        .map_err(|e| format!("GitHub API 请求失败: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GitHub API HTTP {}", res.status()));
    }
    let rel: GhRelease = res.json().map_err(|e| format!("解析 Release JSON: {e}"))?;
    let remote_v =
        parse_tag_version(&rel.tag_name).ok_or_else(|| format!("无法解析 tag: {}", rel.tag_name))?;
    let cur = current_version();
    if remote_v <= cur {
        return Ok(None);
    }
    let want = release_asset_filename();
    let asset = rel
        .assets
        .iter()
        .find(|a| a.name == want)
        .ok_or_else(|| format!("该版本 Release 中未找到资源: {want}"))?;
    Ok(Some((
        remote_v,
        asset.browser_download_url.clone(),
        rel.tag_name,
    )))
}

pub fn run_check() -> Result<(), String> {
    let cur = current_version();
    println!("{cur}");
    match check_update_available()? {
        None => {
            eprintln!("[check] 已是最新");
        }
        Some((v, _url, tag)) => {
            eprintln!("[check] 有新版本: {tag}（远端 {v} > 当前 {cur}）");
        }
    }
    Ok(())
}

pub fn run_upgrade(dry_run: bool) -> Result<(), String> {
    let Some((_remote_v, download_url, tag)) = check_update_available()? else {
        eprintln!("[upgrade] 已是最新 ({})", current_version());
        return Ok(());
    };

    eprintln!("[upgrade] 发现新版本 {tag}，将下载: {}", release_asset_filename());
    if dry_run {
        eprintln!("[upgrade] dry-run: {download_url}");
        return Ok(());
    }

    let client = github_client()?;
    let bytes = client
        .get(&download_url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("下载失败: {e}"))?
        .bytes()
        .map_err(|e| format!("读取响应: {e}"))?;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let parent = exe.parent().ok_or("无法确定可执行文件目录")?;
    let stem = exe
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("network-watch-agent");
    let tmp = parent.join(format!("{stem}.part"));

    if tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
    }
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod 失败: {e}"))?;
    }

    std::fs::rename(&tmp, &exe).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换二进制失败（可先停止 agent 再试）: {e}")
    })?;

    eprintln!("[upgrade] 已写入 {tag}；若进程仍在运行，请重启服务或再次执行本程序以加载新版本。");
    Ok(())
}

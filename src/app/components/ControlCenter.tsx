import { useCallback, useRef, useState } from "react";
import type React from "react";

import type { ThemeId, UpdateState } from "../types";
import { formatBytes, formatMemoryUsage, formatPercent, formatRate, formatCompactRate, formatUptimeSeconds } from "../utils";
import { themeDefinitions } from "../themes";
import { Sparkline } from "./Sparkline";

/**
 * 展开态控制中心。
 *
 * 组成：
 * - 顶部标题栏：支持拖拽移动窗口；提供“在线升级”快捷入口与收起\n+ * - 设置面板（grid）：总览/网卡/进程/磁盘/主题/更新\n+ * - 详情区：CPU/内存/网络趋势（sparkline）\n+ *
 * 交互注意：
 * - 标题栏区域需要可拖拽（`data-tauri-drag-region`），但按钮必须 `no-drag`\n+ * - “在线升级”卡片放在末尾以减少占位，但提供滚动定位快捷按钮避免难找
 */
type ControlCenterProps = {
  expanded: boolean;
  appVersion: string;
  lastUpdated: string;
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  updateState: UpdateState;
  onCheckOrInstallUpdate: () => void;
  onCollapse: () => void;
  onHeaderPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  diagnosticsLabel: string | null;
  snapshot: {
    cpu_usage: number;
    memory_used: number;
    memory_total: number;
    network_download: number;
    network_upload: number;
    nics: Array<{
      id: string;
      received: number;
      transmitted: number;
    }>;
    active_nic_id: string | null;
    disks: Array<{
      id: string;
      name: string;
      mount: string;
      total_bytes: number;
      available_bytes: number;
    }>;
    system_disk: {
      total_bytes: number;
      available_bytes: number;
    } | null;
    uptime_seconds: number;
    process_count: number;
    top_processes_cpu: Array<{
      pid: number;
      name: string;
      cpu_usage: number;
      memory_used: number;
    }>;
    top_processes_memory: Array<{
      pid: number;
      name: string;
      cpu_usage: number;
      memory_used: number;
    }>;
  };
  history: {
    cpu: number[];
    memory: number[];
    download: number[];
    upload: number[];
  };
};

export function ControlCenter({
  expanded,
  appVersion,
  lastUpdated,
  theme,
  setTheme,
  updateState,
  onCheckOrInstallUpdate,
  onCollapse,
  onHeaderPointerDown,
  diagnosticsLabel,
  snapshot,
  history,
}: ControlCenterProps) {
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const updateCardRef = useRef<HTMLElement | null>(null);

  const scrollToUpdateCard = useCallback(() => {
    updateCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const hasUpdate = updateState.stage === "available";
  const activeNic = snapshot.active_nic_id
    ? snapshot.nics.find((nic) => nic.id === snapshot.active_nic_id) ?? null
    : null;
  const topNics = [...snapshot.nics]
    .sort((a, b) => b.received + b.transmitted - (a.received + a.transmitted))
    .slice(0, 4);
  const systemDiskUsedPct =
    snapshot.system_disk && snapshot.system_disk.total_bytes > 0
      ? (1 - snapshot.system_disk.available_bytes / snapshot.system_disk.total_bytes) * 100
      : null;
  const topDisks = [...snapshot.disks].sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, 4);

  return (
    <div className={`expanded-panel ${expanded ? "expanded-panel-visible" : ""}`}>
      <header className="widget-header" data-tauri-drag-region onPointerDown={onHeaderPointerDown}>
        <div className="title-block">
          <span className="eyebrow">Network Watch</span>
          <h1>控制中心</h1>
        </div>
        <div className="header-meta">
          <span>v{appVersion}</span>
          <span>{lastUpdated}</span>
          <button
            type="button"
            className={`expand-button expand-button-secondary ${hasUpdate ? "expand-button-has-update" : ""}`}
            data-tauri-drag-region="false"
            onClick={scrollToUpdateCard}
          >
            在线升级
            {hasUpdate ? <span className="update-dot" aria-hidden="true" /> : null}
          </button>
          <button type="button" className="expand-button" data-tauri-drag-region="false" onClick={onCollapse}>
            收起
          </button>
        </div>
      </header>

      <section className="settings-panel">
        <article className="overview-card">
          <div className="overview-header">
            <span className="settings-label">系统总览</span>
            <span className="theme-current">{lastUpdated}</span>
          </div>
          <div className="overview-grid">
            <div className="overview-item">
              <span className="stat-label">CPU</span>
              <strong>{formatPercent(snapshot.cpu_usage)}</strong>
              <span className="stat-subtitle">整机占用</span>
            </div>
            <div className="overview-item">
              <span className="stat-label">Memory</span>
              <strong>{formatMemoryUsage(snapshot.memory_used, snapshot.memory_total)}</strong>
              <span className="stat-subtitle">
                {formatBytes(snapshot.memory_used)} / {formatBytes(snapshot.memory_total)}
              </span>
            </div>
            <div className="overview-item">
              <span className="stat-label">Network</span>
              <strong>
                ↓ {formatCompactRate(snapshot.network_download)} / ↑ {formatCompactRate(snapshot.network_upload)}
              </strong>
              <span className="stat-subtitle">实时上下行</span>
            </div>
            <div className="overview-item">
              <span className="stat-label">Active NIC</span>
              <strong>
                {activeNic
                  ? `↓ ${formatCompactRate(activeNic.received)} / ↑ ${formatCompactRate(activeNic.transmitted)}`
                  : "—"}
              </strong>
              <span className="stat-subtitle">{activeNic?.id ?? "未检测到活跃网卡"}</span>
            </div>
            <div className="overview-item">
              <span className="stat-label">Disk</span>
              <strong>{systemDiskUsedPct === null ? "—" : formatPercent(systemDiskUsedPct)}</strong>
              <span className="stat-subtitle">
                {snapshot.system_disk
                  ? `${formatBytes(snapshot.system_disk.available_bytes)} 可用 / ${formatBytes(snapshot.system_disk.total_bytes)}`
                  : "未检测到系统盘"}
              </span>
            </div>
            <div className="overview-item">
              <span className="stat-label">Uptime</span>
              <strong>{formatUptimeSeconds(snapshot.uptime_seconds)}</strong>
              <span className="stat-subtitle">{snapshot.process_count} 进程</span>
            </div>
          </div>
        </article>

        <article className="settings-card nic-card">
          <div className="settings-card-header">
            <div>
              <span className="settings-label">网卡吞吐</span>
              <strong>多网卡实时速率</strong>
            </div>
            <span className="theme-current">{activeNic?.id ?? "—"}</span>
          </div>
          <div className="kv-table">
            {topNics.length ? (
              topNics.map((nic) => (
                <div key={nic.id} className="kv-row">
                  <span className="kv-key">{nic.id}</span>
                  <span className="kv-value">
                    ↓ {formatCompactRate(nic.received)} / ↑ {formatCompactRate(nic.transmitted)}
                  </span>
                </div>
              ))
            ) : (
              <div className="kv-row">
                <span className="kv-key">网卡</span>
                <span className="kv-value">暂无数据</span>
              </div>
            )}
          </div>
        </article>

        <article className="settings-card process-card">
          <div className="settings-card-header">
            <div>
              <span className="settings-label">进程</span>
              <strong>Top 占用</strong>
            </div>
            <span className="theme-current">{snapshot.process_count ? `${snapshot.process_count} 个` : "—"}</span>
          </div>
          <div className="kv-table">
            {snapshot.top_processes_cpu?.length ? (
              snapshot.top_processes_cpu.map((process) => (
                <div key={`cpu-${process.pid}-${process.name}`} className="kv-row">
                  <span className="kv-key">
                    {process.name} · {process.pid}
                  </span>
                  <span className="kv-value">{formatPercent(process.cpu_usage)}</span>
                </div>
              ))
            ) : (
              <div className="kv-row">
                <span className="kv-key">CPU Top</span>
                <span className="kv-value">暂无数据</span>
              </div>
            )}
          </div>
          <div className="kv-table kv-table-secondary">
            {snapshot.top_processes_memory?.length ? (
              snapshot.top_processes_memory.map((process) => (
                <div key={`mem-${process.pid}-${process.name}`} className="kv-row">
                  <span className="kv-key">
                    {process.name} · {process.pid}
                  </span>
                  <span className="kv-value">{formatBytes(process.memory_used)}</span>
                </div>
              ))
            ) : (
              <div className="kv-row">
                <span className="kv-key">Memory Top</span>
                <span className="kv-value">暂无数据</span>
              </div>
            )}
          </div>
        </article>

        <article className="settings-card disk-card">
          <div className="settings-card-header">
            <div>
              <span className="settings-label">磁盘空间</span>
              <strong>可用空间与占用</strong>
            </div>
            <span className="theme-current">{snapshot.disks.length ? `${snapshot.disks.length} 盘` : "—"}</span>
          </div>
          <div className="kv-table">
            {topDisks.length ? (
              topDisks.map((disk) => {
                const usedPct = disk.total_bytes > 0 ? (1 - disk.available_bytes / disk.total_bytes) * 100 : 0;
                const label = disk.mount || disk.name || disk.id;
                return (
                  <div key={disk.id} className="kv-row">
                    <span className="kv-key">{label}</span>
                    <span className="kv-value">
                      {formatPercent(usedPct)} · {formatBytes(disk.available_bytes)} 可用
                    </span>
                  </div>
                );
              })
            ) : (
              <div className="kv-row">
                <span className="kv-key">磁盘</span>
                <span className="kv-value">暂无数据</span>
              </div>
            )}
          </div>
        </article>

        <article className="settings-card theme-card">
          <div className="settings-card-header">
            <div>
              <span className="settings-label">主题切换</span>
              <strong>让状态条有自己的气质</strong>
            </div>
            <span className="theme-current">{themeDefinitions[theme].name}</span>
          </div>
          <div className="theme-grid">
            {Object.entries(themeDefinitions).map(([themeKey, themeValue]) => (
              <button
                key={themeKey}
                type="button"
                className={`theme-tile ${theme === themeKey ? "theme-tile-active" : ""}`}
                onClick={() => setTheme(themeKey as ThemeId)}
              >
                <div className="theme-swatches">
                  {themeValue.swatches.map((swatch) => (
                    <span key={swatch} style={{ background: swatch }} />
                  ))}
                </div>
                <strong>{themeValue.name}</strong>
                <span>{themeValue.mood}</span>
                <small>{themeValue.detail}</small>
              </button>
            ))}
          </div>
        </article>

        <article ref={updateCardRef} className="settings-card update-card">
          <div className="settings-card-header">
            <div>
              <span className="settings-label">在线升级</span>
              <strong>自动下载并重启生效</strong>
            </div>
            <button
              type="button"
              className={`primary-action ${updateState.stage === "available" ? "primary-action-hot" : ""}`}
              disabled={
                updateState.stage === "checking" ||
                updateState.stage === "downloading" ||
                updateState.stage === "installing"
              }
              onClick={onCheckOrInstallUpdate}
            >
              {updateState.stage === "available"
                ? "立即更新"
                : updateState.stage === "checking"
                  ? "检查中…"
                  : updateState.stage === "downloading"
                    ? "下载中…"
                    : updateState.stage === "installing"
                      ? "安装中…"
                      : "检查更新"}
            </button>
          </div>
          <p className="settings-copy">{updateState.message}</p>
          <div className="update-meta">
            <span>当前版本 v{appVersion}</span>
            <span>
              {updateState.availableVersion ? `目标版本 v${updateState.availableVersion}` : "发布源：GitHub Release"}
            </span>
            {updateState.releaseNotes ? (
              <button
                type="button"
                className="link-button"
                onClick={() => setShowReleaseNotes((current) => !current)}
              >
                {showReleaseNotes ? "收起说明" : "更新说明"}
              </button>
            ) : null}
          </div>
          {updateState.releaseNotes && showReleaseNotes ? (
            <div className="release-notes">
              <p>{updateState.releaseNotes}</p>
            </div>
          ) : null}
        </article>
      </section>

      <div className={`details ${expanded ? "details-visible" : ""}`}>
        <div className="detail-card">
          <div className="detail-header">
            <span>CPU 趋势</span>
            <strong>{formatPercent(snapshot.cpu_usage)}</strong>
          </div>
          <Sparkline values={history.cpu} tone="cpu" />
        </div>
        <div className="detail-card">
          <div className="detail-header">
            <span>内存趋势</span>
            <strong>{formatMemoryUsage(snapshot.memory_used, snapshot.memory_total)}</strong>
          </div>
          <Sparkline values={history.memory} tone="memory" />
        </div>
        <div className="detail-card detail-card-wide">
          <div className="detail-header">
            <span>网络趋势</span>
            <strong>
              ↓ {formatRate(snapshot.network_download)} / ↑ {formatRate(snapshot.network_upload)}
            </strong>
          </div>
          <div className="network-lines">
            <Sparkline values={history.download} tone="download" />
            <Sparkline values={history.upload} tone="upload" />
          </div>
        </div>
      </div>

      <footer className="widget-footer">
        <span>{lastUpdated}</span>
        <span>{diagnosticsLabel ?? `${themeDefinitions[theme].name} · 拖近工作区边缘会自动贴边`}</span>
      </footer>
    </div>
  );
}


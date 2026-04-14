import type React from "react";

import type { ThemeId, UpdateState } from "../types";
import { formatBytes, formatMemoryUsage, formatPercent, formatRate, formatCompactRate } from "../utils";
import { themeDefinitions } from "../themes";
import { Sparkline } from "./Sparkline";

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
          <button type="button" className="expand-button" data-tauri-drag-region="false" onClick={onCollapse}>
            收起
          </button>
        </div>
      </header>

      <section className="settings-panel">
        <article className="settings-card update-card">
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
          </div>
          {updateState.releaseNotes ? (
            <div className="release-notes">
              <span className="settings-label">更新说明</span>
              <p>{updateState.releaseNotes}</p>
            </div>
          ) : null}
        </article>

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


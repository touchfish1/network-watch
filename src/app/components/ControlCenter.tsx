import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { formatMemoryUsage, formatPercent, formatRate } from "../utils";
import { themeDefinitions } from "../themes";
import { Sparkline } from "./Sparkline";
import { getOnlineMachines, getWebMonitorHint, setClickThroughEnabled } from "../tauri";
import type { MetricHistory, OnlineMachine, SystemSnapshot, WebMonitorHint } from "../types";
import { CLICK_THROUGH_CHANGED_EVENT, CLICK_THROUGH_STORAGE_KEY } from "../constants";
import {
  defaultCardOrder,
  defaultCardVisibility,
  loadCardOrder,
  loadCardVisibility,
  saveCardOrder,
  saveCardVisibility,
  type CardId,
} from "../config/uiLayout";
import { HeaderBar } from "./control-center/HeaderBar";
import { OverviewCard } from "./control-center/OverviewCard";
import { AlertSummaryCard } from "./control-center/AlertSummaryCard";
import { HistorySummaryCard } from "./control-center/HistorySummaryCard";
import { ConnectionsCard } from "./control-center/ConnectionsCard";
import { NicCard } from "./control-center/NicCard";
import { ProcessCard } from "./control-center/ProcessCard";
import { DiskCard } from "./control-center/DiskCard";
import { OnlineHostsCard } from "./control-center/OnlineHostsCard";
import { ThemeCard } from "./control-center/ThemeCard";
import { UpdateModal } from "./control-center/UpdateModal";
import type { ControlCenterProps } from "./control-center/types";
import { ControlCenterSettingsModal } from "./control-center/ControlCenterSettingsModal";
import { emitAppEvent } from "../stateBus";
import { DEFAULT_HOST_STALE_THRESHOLD_MS, loadHostStaleThresholdMs, saveHostStaleThresholdMs } from "../config/hostStatus";
import { loadPinnedHostIds, savePinnedHostIds } from "../config/pinnedHosts";

const DEFAULT_WEB_MONITOR_URL = "http://127.0.0.1:17321/";
const REMOTE_HISTORY_MAX_POINTS = 60;
const LOW_LOAD_MODE_STORAGE_KEY = "network-watch-low-load-mode-v1";
const WEB_HEALTH_PATH = "/api/v1/health";
const WEB_HEALTH_RETRY_WINDOW_MS = 5000;
const WEB_HEALTH_RETRY_INTERVAL_MS = 500;
const WEB_HEALTH_REQUEST_TIMEOUT_MS = 800;

function pushHistoryValue(arr: number[], value: number, max: number) {
  const next = [...arr, value];
  if (next.length > max) {
    return next.slice(next.length - max);
  }
  return next;
}

function buildEmptyHistory(): MetricHistory {
  return { cpu: [], memory: [], download: [], upload: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function buildHealthCheckUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.pathname = WEB_HEALTH_PATH;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function checkWebHealthWithRetry(url: string): Promise<boolean> {
  const healthUrl = buildHealthCheckUrl(url);
  if (!healthUrl) {
    return false;
  }
  const deadline = Date.now() + WEB_HEALTH_RETRY_WINDOW_MS;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), WEB_HEALTH_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // ignore and retry until deadline
    } finally {
      window.clearTimeout(timeout);
    }
    await sleep(WEB_HEALTH_RETRY_INTERVAL_MS);
  }
  return false;
}

/**
 * 展开态控制中心。
 *
 * 组成：
 * - 顶部标题栏：支持拖拽移动窗口；提供“在线升级”快捷入口与收起
 * - 设置面板（grid）：总览/网卡/进程/磁盘/主题
 * - 详情区：CPU/内存/网络趋势（sparkline）
 *
 * 交互注意：
 * - 标题栏区域需要可拖拽（`data-tauri-drag-region`），但按钮必须 `no-drag`
 * - “在线升级”按钮弹出独立详情窗口，不占用悬窗卡片区
 */

export function ControlCenter({
  expanded,
  appVersion,
  lastUpdated,
  theme,
  setTheme,
  updateState,
  updatePollIntervalMinutes,
  setUpdatePollIntervalMinutes,
  nicPreference,
  setNicPreference,
  alertSettings,
  setAlertSettings,
  quotaSettings,
  setQuotaSettings,
  quotaRuntime,
  alertRecords,
  historySummary,
  historySeries,
  onCheckOrInstallUpdate,
  onCollapse,
  onHeaderPointerDown,
  diagnosticsLabel,
  snapshot,
  history,
}: ControlCenterProps) {
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [clickThroughEnabled, setClickThroughEnabledState] = useState(() => {
    const saved = window.localStorage.getItem(CLICK_THROUGH_STORAGE_KEY);
    return saved === "1" || saved === "true";
  });
  const [showSettingsPopover, setShowSettingsPopover] = useState(false);
  const [lowLoadMode, setLowLoadModeState] = useState(() => window.localStorage.getItem(LOW_LOAD_MODE_STORAGE_KEY) === "1");

  /**
   * 与托盘「鼠标穿透」菜单同步：后端在任意路径变更穿透后会广播该事件。
   */
  useEffect(() => {
    if (!isTauri()) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen<boolean>(CLICK_THROUGH_CHANGED_EVENT, ({ payload }) => {
      const on = Boolean(payload);
      setClickThroughEnabledState(on);
      window.localStorage.setItem(CLICK_THROUGH_STORAGE_KEY, on ? "1" : "0");
      emitAppEvent("app:click-through-changed", on);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  const toggleClickThrough = useCallback(() => {
    const next = !clickThroughEnabled;
    setClickThroughEnabledState(next);
    window.localStorage.setItem(CLICK_THROUGH_STORAGE_KEY, next ? "1" : "0");
    void setClickThroughEnabled(next).catch(() => {
      // ignore (non-windows or command unavailable)
    });
  }, [clickThroughEnabled]);

  const openUpdateModal = useCallback(() => {
    setShowUpdateModal(true);
  }, []);
  const closeUpdateModal = useCallback(() => {
    setShowUpdateModal(false);
  }, []);
  const hasUpdate = updateState.stage === "available";
  const toggleSettingsPopover = useCallback(() => {
    setShowSettingsPopover((current) => !current);
  }, []);
  const closeSettingsPopover = useCallback(() => {
    setShowSettingsPopover(false);
  }, []);
  const setLowLoadMode = useCallback((enabled: boolean) => {
    setLowLoadModeState(enabled);
    window.localStorage.setItem(LOW_LOAD_MODE_STORAGE_KEY, enabled ? "1" : "0");
  }, []);

  const [cardOrder, setCardOrder] = useState<CardId[]>(() => loadCardOrder());
  const [cardVisibility, setCardVisibility] = useState<Record<CardId, boolean>>(() => loadCardVisibility());

  const toggleCard = useCallback((id: CardId) => {
    setCardVisibility((current) => {
      const next = { ...current, [id]: !current[id] };
      saveCardVisibility(next);
      return next;
    });
  }, []);

  const moveCard = useCallback((id: CardId, direction: -1 | 1) => {
    setCardOrder((current) => {
      const index = current.indexOf(id);
      if (index < 0) {
        return current;
      }
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      saveCardOrder(next);
      return next;
    });
  }, []);

  const resetCards = useCallback(() => {
    setCardOrder(defaultCardOrder);
    setCardVisibility(defaultCardVisibility);
    saveCardOrder(defaultCardOrder);
    saveCardVisibility(defaultCardVisibility);
  }, []);

  const [tauriWebHint, setTauriWebHint] = useState<WebMonitorHint | null>(null);
  const [onlineMachines, setOnlineMachines] = useState<OnlineMachine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [pinnedMachineIds, setPinnedMachineIds] = useState<string[]>(() =>
    typeof window !== "undefined" ? loadPinnedHostIds() : [],
  );
  const [remoteHistoryByMachineId, setRemoteHistoryByMachineId] = useState<Record<string, MetricHistory>>({});
  const [hostStaleThresholdMs, setHostStaleThresholdMs] = useState(() =>
    typeof window !== "undefined" ? loadHostStaleThresholdMs() : DEFAULT_HOST_STALE_THRESHOLD_MS,
  );

  const updateHostStaleThresholdMs = useCallback((ms: number) => {
    setHostStaleThresholdMs(ms);
    saveHostStaleThresholdMs(ms);
  }, []);

  const togglePinnedMachine = useCallback((machineId: string) => {
    setPinnedMachineIds((current) => {
      const set = new Set(current);
      if (set.has(machineId)) set.delete(machineId);
      else set.add(machineId);
      const next = Array.from(set);
      savePinnedHostIds(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!expanded || !isTauri()) {
      return;
    }
    let cancelled = false;
    void getWebMonitorHint()
      .then((hint) => {
        if (!cancelled) {
          setTauriWebHint(hint);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTauriWebHint({
            enabled: true,
            primaryUrl: DEFAULT_WEB_MONITOR_URL,
            note: null,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded || !isTauri()) {
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const poll = () => {
      void getOnlineMachines()
        .then((machines) => {
          if (cancelled) {
            return;
          }
          // 边界：后端偶发返回非数组/脏数据时兜底，避免展开页空白
          const safeMachines = Array.isArray(machines) ? machines : [];
          setOnlineMachines(safeMachines);
          // 维护 remote history（每台 agent 独立）
          setRemoteHistoryByMachineId((current) => {
            const next: Record<string, MetricHistory> = { ...current };
            for (const item of safeMachines) {
              const snap = item?.snapshot;
              if (!snap) continue;
              const cpu = typeof (snap as SystemSnapshot).cpu_usage === "number" ? (snap as SystemSnapshot).cpu_usage : 0;
              const memPct =
                typeof (snap as SystemSnapshot).memory_used === "number" &&
                typeof (snap as SystemSnapshot).memory_total === "number" &&
                (snap as SystemSnapshot).memory_total > 0
                  ? ((snap as SystemSnapshot).memory_used / (snap as SystemSnapshot).memory_total) * 100
                  : 0;
              const down =
                typeof (snap as SystemSnapshot).network_download === "number" ? (snap as SystemSnapshot).network_download : 0;
              const up =
                typeof (snap as SystemSnapshot).network_upload === "number" ? (snap as SystemSnapshot).network_upload : 0;

              const prev = next[item.machine_id] ?? buildEmptyHistory();
              next[item.machine_id] = {
                cpu: pushHistoryValue(prev.cpu, cpu, REMOTE_HISTORY_MAX_POINTS),
                memory: pushHistoryValue(prev.memory, memPct, REMOTE_HISTORY_MAX_POINTS),
                download: pushHistoryValue(prev.download, down, REMOTE_HISTORY_MAX_POINTS),
                upload: pushHistoryValue(prev.upload, up, REMOTE_HISTORY_MAX_POINTS),
              };
            }

            // 清理：只保留当前在线列表中的主机历史，避免无限增长
            const alive = new Set(safeMachines.map((m) => m.machine_id));
            for (const key of Object.keys(next)) {
              if (!alive.has(key)) delete next[key];
            }
            return next;
          });

          setSelectedMachineId((current) => {
            if (current && safeMachines.some((item) => item.machine_id === current)) {
              return current;
            }
            return safeMachines[0]?.machine_id ?? null;
          });
        })
        .catch(() => {
          if (!cancelled) {
            setOnlineMachines([]);
            setSelectedMachineId(null);
          }
        });
    };

    poll();
    timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      if (timer) {
        window.clearInterval(timer);
      }
    };
  }, [expanded]);

  const selectedRemoteMachine = useMemo(() => {
    if (!selectedMachineId) return null;
    return onlineMachines.find((m) => m.machine_id === selectedMachineId) ?? null;
  }, [onlineMachines, selectedMachineId]);

  const displaySnapshot = useMemo(() => {
    return selectedRemoteMachine?.snapshot ?? snapshot;
  }, [selectedRemoteMachine, snapshot]);

  const displayHistory: MetricHistory = useMemo(() => {
    if (!selectedRemoteMachine) return history;
    return remoteHistoryByMachineId[selectedRemoteMachine.machine_id] ?? buildEmptyHistory();
  }, [history, remoteHistoryByMachineId, selectedRemoteMachine]);

  const webMonitorHint = useMemo((): WebMonitorHint | null => {
    if (!expanded) {
      return null;
    }
    if (!isTauri()) {
      return {
        enabled: true,
        primaryUrl: DEFAULT_WEB_MONITOR_URL,
        note: "需在本机运行应用后，用浏览器打开上述地址",
      };
    }
    return tauriWebHint;
  }, [expanded, tauriWebHint]);

  const displayWebUrl = useMemo(() => {
    if (webMonitorHint?.primaryUrl) {
      return webMonitorHint.primaryUrl;
    }
    if (webMonitorHint && !webMonitorHint.enabled) {
      return "";
    }
    return DEFAULT_WEB_MONITOR_URL;
  }, [webMonitorHint]);

  const copyWebUrl = useCallback(() => {
    const text = displayWebUrl || DEFAULT_WEB_MONITOR_URL;
    if (!text) {
      return;
    }
    void navigator.clipboard?.writeText(text).catch(() => {
      // ignore
    });
  }, [displayWebUrl]);
  const openWebUrl = useCallback(async () => {
    const url = displayWebUrl || DEFAULT_WEB_MONITOR_URL;
    if (!url) {
      return;
    }
    await checkWebHealthWithRetry(url);
    if (isTauri()) {
      void openUrl(url).catch(() => {
        window.open(url, "_blank", "noopener,noreferrer");
      });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [displayWebUrl]);

  const renderers: Record<CardId, () => React.ReactNode> = {
    overview: () => <OverviewCard lastUpdated={lastUpdated} snapshot={displaySnapshot as any} />,
    online_hosts: () => (
      <OnlineHostsCard
        machines={onlineMachines}
        selectedMachineId={selectedMachineId}
        onSelectMachine={setSelectedMachineId}
        staleThresholdMs={hostStaleThresholdMs}
        pinnedMachineIds={pinnedMachineIds}
        onTogglePinned={togglePinnedMachine}
      />
    ),
    alerts: () => <AlertSummaryCard alertRecords={alertRecords} quotaRuntime={quotaRuntime} />,
    history: () => <HistorySummaryCard historySummary={historySummary} series={historySeries} lowLoadMode={lowLoadMode} />,
    connections: () => <ConnectionsCard connections={(displaySnapshot as any).connections} />,
    nic: () => (
      <NicCard
        nics={(displaySnapshot as any).nics ?? []}
        activeNicId={(displaySnapshot as any).active_nic_id ?? null}
        nicPreference={nicPreference}
        setNicPreference={setNicPreference}
      />
    ),
    process: () => (
      <ProcessCard
        processCount={(displaySnapshot as any).process_count ?? 0}
        topCpu={(displaySnapshot as any).top_processes_cpu ?? []}
        topMemory={(displaySnapshot as any).top_processes_memory ?? []}
      />
    ),
    disk: () => <DiskCard disks={(displaySnapshot as any).disks ?? []} />,
    theme: () => <ThemeCard theme={theme} setTheme={setTheme} />,
  };
  const cardTitles: Record<CardId, string> = {
    overview: "系统总览",
    online_hosts: "在线主机",
    alerts: "告警",
    history: "历史",
    connections: "连接",
    nic: "网卡",
    process: "进程",
    disk: "磁盘",
    theme: "主题",
  };
  const cardSummary: Record<CardId, string> = {
    overview: `CPU ${formatPercent((displaySnapshot as any).cpu_usage ?? 0)} · ↓ ${formatRate((displaySnapshot as any).network_download ?? 0)}`,
    online_hosts: `在线 ${onlineMachines.length} 台`,
    alerts: `最近 ${alertRecords.length} 条`,
    history: `样本 ${historySummary.sampleCount} 条`,
    connections: (displaySnapshot as any).connections ? `总连接 ${(displaySnapshot as any).connections.total}` : "无连接统计",
    nic: `网卡 ${((displaySnapshot as any).nics ?? []).length} 个`,
    process: `进程 ${(displaySnapshot as any).process_count ?? 0} 个`,
    disk: `磁盘 ${((displaySnapshot as any).disks ?? []).length} 个`,
    theme: `主题 ${themeDefinitions[theme].name}`,
  };
  const safeCardOrder = cardOrder.filter((id) => typeof renderers[id] === "function");

  return (
    <div className={`expanded-panel ${expanded ? "expanded-panel-visible" : ""}`}>
      <HeaderBar
        appVersion={appVersion}
        lastUpdated={lastUpdated}
        hasUpdate={hasUpdate}
        clickThroughEnabled={clickThroughEnabled}
        onToggleClickThrough={toggleClickThrough}
        onOpenUpdateModal={openUpdateModal}
        settingsMenu={
          <button
            type="button"
            className={`expand-button ${showSettingsPopover ? "primary-action-hot" : ""}`}
            data-tauri-drag-region="false"
            onClick={toggleSettingsPopover}
          >
            设置
          </button>
        }
        onCollapse={onCollapse}
        onHeaderPointerDown={onHeaderPointerDown}
      />

      {expanded ? (
        <section className="web-hint" aria-label="Web 监控地址">
          <span className="web-hint-label">Web 监控</span>
          {webMonitorHint && !webMonitorHint.enabled ? (
            <span className="web-hint-url web-hint-disabled">{webMonitorHint.note ?? "已关闭"}</span>
          ) : (
            <span className="web-hint-url" title={displayWebUrl}>
              {displayWebUrl || "…"}
            </span>
          )}
          <button
            type="button"
            className="link-button"
            data-tauri-drag-region="false"
            disabled={!displayWebUrl}
            onClick={openWebUrl}
          >
            打开
          </button>
          <button
            type="button"
            className="link-button"
            data-tauri-drag-region="false"
            disabled={!displayWebUrl}
            onClick={copyWebUrl}
          >
            复制
          </button>
          {webMonitorHint?.note && webMonitorHint.enabled ? (
            <p className="web-hint-note">{webMonitorHint.note}</p>
          ) : null}
        </section>
      ) : null}

      <ControlCenterSettingsModal
        open={showSettingsPopover}
        onClose={closeSettingsPopover}
        nicPreference={nicPreference}
        setNicPreference={setNicPreference}
        updatePollIntervalMinutes={updatePollIntervalMinutes}
        setUpdatePollIntervalMinutes={setUpdatePollIntervalMinutes}
        alertSettings={alertSettings}
        setAlertSettings={setAlertSettings}
        quotaSettings={quotaSettings}
        setQuotaSettings={setQuotaSettings}
        quotaRuntime={quotaRuntime}
        alertRecords={alertRecords}
        historySummary={historySummary}
        historySeries={historySeries}
        snapshot={{ nics: snapshot.nics, active_nic_id: snapshot.active_nic_id }}
        cardOrder={cardOrder}
        cardVisibility={cardVisibility}
        onResetCards={resetCards}
        onToggleCard={toggleCard}
        onMoveCard={moveCard}
        hostStaleThresholdMs={hostStaleThresholdMs}
        setHostStaleThresholdMs={updateHostStaleThresholdMs}
        lowLoadMode={lowLoadMode}
        setLowLoadMode={setLowLoadMode}
      />
      <UpdateModal
        open={showUpdateModal}
        appVersion={appVersion}
        updateState={updateState}
        showReleaseNotes={showReleaseNotes}
        setShowReleaseNotes={setShowReleaseNotes}
        onClose={closeUpdateModal}
        onCheckOrInstallUpdate={onCheckOrInstallUpdate}
      />

      <section className="settings-panel">
        {safeCardOrder.map((id) =>
          cardVisibility[id] ? (
            <div key={`card-${id}`} className={`card-shell card-shell-${id}`}>
              <details className="card-fold" open>
                <summary className="card-fold-summary">
                  <span className="card-fold-title">{cardTitles[id]}</span>
                  <span className="card-fold-mini-text">{cardSummary[id]}</span>
                </summary>
                <div className="card-fold-content">{renderers[id]()}</div>
              </details>
            </div>
          ) : null,
        )}
      </section>

      <div className={`details ${expanded ? "details-visible" : ""}`}>
        <div className="detail-card">
          <div className="detail-header">
            <span>CPU 趋势</span>
            <strong>{formatPercent((displaySnapshot as any).cpu_usage ?? 0)}</strong>
          </div>
          <Sparkline values={displayHistory.cpu} tone="cpu" lowLoadMode={lowLoadMode} />
        </div>
        <div className="detail-card">
          <div className="detail-header">
            <span>内存趋势</span>
            <strong>
              {formatMemoryUsage(
                (displaySnapshot as any).memory_used ?? 0,
                (displaySnapshot as any).memory_total ?? 0,
              )}
            </strong>
          </div>
          <Sparkline values={displayHistory.memory} tone="memory" lowLoadMode={lowLoadMode} />
        </div>
        <div className="detail-card detail-card-wide">
          <div className="detail-header">
            <span>网络趋势</span>
            <strong>
              ↓ {formatRate((displaySnapshot as any).network_download ?? 0)} / ↑ {formatRate((displaySnapshot as any).network_upload ?? 0)}
            </strong>
          </div>
          <div className="network-lines">
            <Sparkline values={displayHistory.download} tone="download" lowLoadMode={lowLoadMode} />
            <Sparkline values={displayHistory.upload} tone="upload" lowLoadMode={lowLoadMode} />
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


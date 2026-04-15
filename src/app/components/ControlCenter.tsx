import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import { formatMemoryUsage, formatPercent, formatRate } from "../utils";
import { themeDefinitions } from "../themes";
import { Sparkline } from "./Sparkline";
import { getOnlineMachines, getWebMonitorHint, setClickThroughEnabled } from "../tauri";
import type { OnlineMachine, WebMonitorHint } from "../types";
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
import { UpdateCard } from "./control-center/UpdateCard";
import type { ControlCenterProps } from "./control-center/types";
import { ControlCenterSettingsModal } from "./control-center/ControlCenterSettingsModal";
import { emitAppEvent } from "../stateBus";

const DEFAULT_WEB_MONITOR_URL = "http://127.0.0.1:17321/";

/**
 * 展开态控制中心。
 *
 * 组成：
 * - 顶部标题栏：支持拖拽移动窗口；提供“在线升级”快捷入口与收起
 * - 设置面板（grid）：总览/网卡/进程/磁盘/主题/更新
 * - 详情区：CPU/内存/网络趋势（sparkline）
 *
 * 交互注意：
 * - 标题栏区域需要可拖拽（`data-tauri-drag-region`），但按钮必须 `no-drag`
 * - “在线升级”卡片放在末尾以减少占位，但提供滚动定位快捷按钮避免难找
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
  const [clickThroughEnabled, setClickThroughEnabledState] = useState(() => {
    const saved = window.localStorage.getItem(CLICK_THROUGH_STORAGE_KEY);
    return saved === "1" || saved === "true";
  });
  const [showSettingsPopover, setShowSettingsPopover] = useState(false);
  const updateCardRef = useRef<HTMLElement | null>(null);

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

  const scrollToUpdateCard = useCallback(() => {
    updateCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);
  const hasUpdate = updateState.stage === "available";
  const toggleSettingsPopover = useCallback(() => {
    setShowSettingsPopover((current) => !current);
  }, []);
  const closeSettingsPopover = useCallback(() => {
    setShowSettingsPopover(false);
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
  const openWebUrl = useCallback(() => {
    const url = displayWebUrl || DEFAULT_WEB_MONITOR_URL;
    if (!url) {
      return;
    }
    if (isTauri()) {
      void openUrl(url).catch(() => {
        window.open(url, "_blank", "noopener,noreferrer");
      });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [displayWebUrl]);

  const renderers: Record<CardId, () => React.ReactNode> = {
    overview: () => <OverviewCard lastUpdated={lastUpdated} snapshot={snapshot} />,
    online_hosts: () => (
      <OnlineHostsCard
        machines={onlineMachines}
        selectedMachineId={selectedMachineId}
        onSelectMachine={setSelectedMachineId}
      />
    ),
    alerts: () => <AlertSummaryCard alertRecords={alertRecords} quotaRuntime={quotaRuntime} />,
    history: () => <HistorySummaryCard historySummary={historySummary} series={historySeries} />,
    connections: () => <ConnectionsCard connections={snapshot.connections} />,
    nic: () => (
      <NicCard
        nics={snapshot.nics}
        activeNicId={snapshot.active_nic_id}
        nicPreference={nicPreference}
        setNicPreference={setNicPreference}
      />
    ),
    process: () => (
      <ProcessCard processCount={snapshot.process_count} topCpu={snapshot.top_processes_cpu} topMemory={snapshot.top_processes_memory} />
    ),
    disk: () => <DiskCard disks={snapshot.disks} />,
    theme: () => <ThemeCard theme={theme} setTheme={setTheme} />,
    update: () => (
      <UpdateCard
        appVersion={appVersion}
        updateState={updateState}
        showReleaseNotes={showReleaseNotes}
        setShowReleaseNotes={setShowReleaseNotes}
        onCheckOrInstallUpdate={onCheckOrInstallUpdate}
        updateCardRef={updateCardRef}
      />
    ),
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
    update: "在线升级",
  };
  const cardSummary: Record<CardId, string> = {
    overview: `CPU ${formatPercent(snapshot.cpu_usage)} · ↓ ${formatRate(snapshot.network_download)}`,
    online_hosts: `在线 ${onlineMachines.length} 台`,
    alerts: `最近 ${alertRecords.length} 条`,
    history: `样本 ${historySummary.sampleCount} 条`,
    connections: snapshot.connections ? `总连接 ${snapshot.connections.total}` : "无连接统计",
    nic: `网卡 ${snapshot.nics.length} 个`,
    process: `进程 ${snapshot.process_count} 个`,
    disk: `磁盘 ${snapshot.disks.length} 个`,
    theme: `主题 ${themeDefinitions[theme].name}`,
    update: updateState.message || "检查更新状态",
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
        onScrollToUpdateCard={scrollToUpdateCard}
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


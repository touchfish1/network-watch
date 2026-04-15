import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";

import { formatMemoryUsage, formatPercent, formatRate } from "../utils";
import { themeDefinitions } from "../themes";
import { Sparkline } from "./Sparkline";
import { setClickThroughEnabled } from "../tauri";
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
import { ThemeCard } from "./control-center/ThemeCard";
import { UpdateCard } from "./control-center/UpdateCard";
import type { ControlCenterProps } from "./control-center/types";
import { ControlCenterSettingsModal } from "./control-center/ControlCenterSettingsModal";
import { emitAppEvent } from "../stateBus";

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

  const renderers: Record<CardId, () => React.ReactNode> = {
    overview: () => <OverviewCard lastUpdated={lastUpdated} snapshot={snapshot} />,
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
        {cardOrder.map((id) => (cardVisibility[id] ? <div key={`card-${id}`}>{renderers[id]()}</div> : null))}
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


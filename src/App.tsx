import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import "./app/styles/index.css";

import {
  THEME_STORAGE_KEY,
  CLICK_THROUGH_STORAGE_KEY,
} from "./app/constants";
import { ControlCenter } from "./app/components/ControlCenter";
import { StatusStrip } from "./app/components/StatusStrip";
import type { AlertRecord, HistorySummary, MetricHistory, QuotaRuntime, SystemSnapshot, ThemeId } from "./app/types";
import { useOverlayInteraction } from "./app/hooks/useOverlayInteraction";
import { useRuntimeDiagnostics } from "./app/hooks/useRuntimeDiagnostics";
import { useUpdater } from "./app/hooks/useUpdater";
import { useWindowLayout } from "./app/hooks/useWindowLayout";
import { themeDefinitions } from "./app/themes";
import {
  pushSample,
} from "./app/utils";
import { setClickThroughEnabled } from "./app/tauri";
import {
  loadAlertSettings,
  loadNicPreference,
  loadQuotaSettings,
  loadUpdatePollIntervalMinutes,
  saveAlertSettings,
  saveNicPreference,
  saveQuotaSettings,
  saveUpdatePollIntervalMinutes,
  type AlertSettings,
  type NicPreference,
  type QuotaSettings,
  type UpdatePollIntervalMinutes,
} from "./app/config/settings";
import { emitAppEvent, listenAppEvent } from "./app/stateBus";

/**
 * 前端应用入口（单窗口悬浮窗）。
 *
 * 数据流概览：
 * - 后端（Tauri/Rust）每秒广播一次 `system-snapshot`
 * - `useWindowLayout` 订阅该事件并维护窗口展开/收起、拖拽/缩放、贴边等布局状态
 * - 组件层：`StatusStrip`（收起态）+ `ControlCenter`（展开态）
 *
 * 兼容说明：
 * - 在浏览器开发环境（`npm run dev`）下没有 Tauri API，因此需要 `isTauri()` 守卫。
 */
const emptySnapshot: SystemSnapshot = {
  timestamp: Date.now(),
  cpu_usage: 0,
  memory_used: 0,
  memory_total: 0,
  network_download: 0,
  network_upload: 0,
  nics: [],
  active_nic_id: null,
  disks: [],
  system_disk: null,
  uptime_seconds: 0,
  process_count: 0,
  top_processes_cpu: [],
  top_processes_memory: [],
  connections: null,
};

const emptyHistory: MetricHistory = {
  cpu: [],
  memory: [],
  download: [],
  upload: [],
};

const HISTORY_STORAGE_KEY = "network-watch-history-rollup-v1";
const QUOTA_RUNTIME_STORAGE_KEY = "network-watch-quota-runtime-v1";
const MAX_HISTORY_BUCKETS = 60 * 24 * 7;
const MAX_ALERT_RECORDS = 20;

type HistoryBucket = {
  minuteTs: number;
  download: number;
  upload: number;
  cpuMax: number;
  memoryMax: number;
};

function getEffectiveSnapshot(payload: SystemSnapshot, nicPreference: NicPreference): SystemSnapshot {
  if (nicPreference.mode !== "manual" || !nicPreference.nicId) {
    return payload;
  }

  const selectedNic = payload.nics.find((nic) => nic.id === nicPreference.nicId);
  if (!selectedNic) {
    return payload;
  }

  return {
    ...payload,
    network_download: selectedNic.received,
    network_upload: selectedNic.transmitted,
    active_nic_id: selectedNic.id,
  };
}

function getQuotaPeriodKey(date: Date, resetDay: number) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const effectiveMonth = day >= resetDay ? month : month - 1;
  const effectiveDate = new Date(year, effectiveMonth, 1);
  return `${effectiveDate.getFullYear()}-${String(effectiveDate.getMonth() + 1).padStart(2, "0")}`;
}

function loadHistoryBuckets(): HistoryBucket[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryBucket[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistoryBuckets(value: HistoryBucket[]) {
  window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(value.slice(-MAX_HISTORY_BUCKETS)));
}

function appendHistoryBucket(payload: SystemSnapshot) {
  const minuteTs = Math.floor(payload.timestamp / 60000) * 60000;
  const buckets = loadHistoryBuckets();
  const last = buckets.at(-1);
  if (last && last.minuteTs === minuteTs) {
    last.download += payload.network_download;
    last.upload += payload.network_upload;
    last.cpuMax = Math.max(last.cpuMax, payload.cpu_usage);
    last.memoryMax = Math.max(
      last.memoryMax,
      payload.memory_total > 0 ? (payload.memory_used / payload.memory_total) * 100 : 0,
    );
  } else {
    buckets.push({
      minuteTs,
      download: payload.network_download,
      upload: payload.network_upload,
      cpuMax: payload.cpu_usage,
      memoryMax: payload.memory_total > 0 ? (payload.memory_used / payload.memory_total) * 100 : 0,
    });
  }
  saveHistoryBuckets(buckets);
  return buckets.slice(-MAX_HISTORY_BUCKETS);
}

function buildHistorySummary(buckets: HistoryBucket[]): HistorySummary {
  const now = Date.now();
  const dayCutoff = now - 24 * 60 * 60 * 1000;
  const weekCutoff = now - 7 * 24 * 60 * 60 * 1000;
  let last24HoursDownload = 0;
  let last24HoursUpload = 0;
  let last7DaysDownload = 0;
  let last7DaysUpload = 0;
  let peakDownload = 0;
  let peakUpload = 0;

  for (const bucket of buckets) {
    if (bucket.minuteTs >= dayCutoff) {
      last24HoursDownload += bucket.download;
      last24HoursUpload += bucket.upload;
    }
    if (bucket.minuteTs >= weekCutoff) {
      last7DaysDownload += bucket.download;
      last7DaysUpload += bucket.upload;
      peakDownload = Math.max(peakDownload, bucket.download);
      peakUpload = Math.max(peakUpload, bucket.upload);
    }
  }

  return {
    last24HoursDownload,
    last24HoursUpload,
    last7DaysDownload,
    last7DaysUpload,
    peakDownload,
    peakUpload,
    sampleCount: buckets.length,
  };
}

function buildHistorySeries(buckets: HistoryBucket[], minutes: number) {
  const nowMinuteTs = Math.floor(Date.now() / 60000) * 60000;
  const byTs = new Map<number, HistoryBucket>();
  for (const bucket of buckets) {
    byTs.set(bucket.minuteTs, bucket);
  }
  const downloadPerMinute: number[] = [];
  const uploadPerMinute: number[] = [];
  for (let i = minutes - 1; i >= 0; i -= 1) {
    const ts = nowMinuteTs - i * 60000;
    const item = byTs.get(ts);
    downloadPerMinute.push(item ? item.download : 0);
    uploadPerMinute.push(item ? item.upload : 0);
  }
  return { downloadPerMinute, uploadPerMinute };
}

function loadQuotaRuntime(resetDay: number): QuotaRuntime {
  try {
    const raw = window.localStorage.getItem(QUOTA_RUNTIME_STORAGE_KEY);
    if (!raw) {
      throw new Error("missing quota runtime");
    }
    const parsed = JSON.parse(raw) as QuotaRuntime;
    const currentPeriodKey = getQuotaPeriodKey(new Date(), resetDay);
    if (parsed.periodKey !== currentPeriodKey) {
      return {
        periodKey: currentPeriodKey,
        usedBytes: 0,
        warningTriggered: false,
        exceededTriggered: false,
      };
    }
    return parsed;
  } catch {
    return {
      periodKey: getQuotaPeriodKey(new Date(), resetDay),
      usedBytes: 0,
      warningTriggered: false,
      exceededTriggered: false,
    };
  }
}

function saveQuotaRuntime(value: QuotaRuntime) {
  window.localStorage.setItem(QUOTA_RUNTIME_STORAGE_KEY, JSON.stringify(value));
}

function App() {
  /**
   * `isTauri()` 仅在首次渲染求值，避免在 render 期间触发任何潜在的环境探测抖动。
   */
  const isTauriEnv = useMemo(() => isTauri(), []);
  const [lastUpdated, setLastUpdated] = useState("等待系统数据…");
  const [nicPreference, setNicPreferenceState] = useState<NicPreference>(() => loadNicPreference());
  const [alertSettings, setAlertSettingsState] = useState<AlertSettings>(() => loadAlertSettings());
  const [quotaSettings, setQuotaSettingsState] = useState<QuotaSettings>(() => loadQuotaSettings());
  const [alertRecords, setAlertRecords] = useState<AlertRecord[]>([]);
  const [historySummary, setHistorySummary] = useState<HistorySummary>(() => buildHistorySummary(loadHistoryBuckets()));
  const [historySeries, setHistorySeries] = useState(() => buildHistorySeries(loadHistoryBuckets(), 60));
  const [quotaRuntime, setQuotaRuntime] = useState<QuotaRuntime>(() => loadQuotaRuntime(loadQuotaSettings().resetDay));

  const layout = useWindowLayout({
    isTauriEnv,
    emptySnapshot,
    emptyHistory,
    onSnapshot: (payload) => {
      // 采样频率较高（1s），用 transition 降低 UI 更新的阻塞感。
      startTransition(() => {
        const effectiveSnapshot = getEffectiveSnapshot(payload, nicPreference);
        layout.setHistory((current) => ({
          cpu: pushSample(current.cpu, effectiveSnapshot.cpu_usage),
          memory: pushSample(
            current.memory,
            effectiveSnapshot.memory_total > 0 ? (effectiveSnapshot.memory_used / effectiveSnapshot.memory_total) * 100 : 0,
          ),
          download: pushSample(current.download, effectiveSnapshot.network_download),
          upload: pushSample(current.upload, effectiveSnapshot.network_upload),
        }));
        layout.setSnapshot(effectiveSnapshot);
        setLastUpdated(new Date(effectiveSnapshot.timestamp).toLocaleTimeString());

        const buckets = appendHistoryBucket(effectiveSnapshot);
        setHistorySummary(buildHistorySummary(buckets));
        setHistorySeries(buildHistorySeries(buckets, 60));

        const nextPeriodKey = getQuotaPeriodKey(new Date(effectiveSnapshot.timestamp), quotaSettings.resetDay);
        setQuotaRuntime((current) => {
          const base =
            current.periodKey === nextPeriodKey
              ? current
              : {
                  periodKey: nextPeriodKey,
                  usedBytes: 0,
                  warningTriggered: false,
                  exceededTriggered: false,
                };
          const usedBytes = base.usedBytes + effectiveSnapshot.network_download + effectiveSnapshot.network_upload;
          let warningTriggered = base.warningTriggered;
          let exceededTriggered = base.exceededTriggered;

          if (quotaSettings.enabled && quotaSettings.monthlyBytes > 0) {
            const usagePercent = (usedBytes / quotaSettings.monthlyBytes) * 100;
            if (!warningTriggered && usagePercent >= quotaSettings.warningPercent) {
              const record = {
                id: `quota-warning-${effectiveSnapshot.timestamp}`,
                title: "流量配额预警",
                message: `本月已使用 ${usagePercent.toFixed(0)}%，接近配额上限。`,
                metric: "quota" as const,
                timestamp: effectiveSnapshot.timestamp,
              };
              setAlertRecords((items) => [record, ...items].slice(0, MAX_ALERT_RECORDS));
              emitAppEvent("app:alert-raised", record);
              warningTriggered = true;
            }
            if (!exceededTriggered && usagePercent >= 100) {
              const record = {
                id: `quota-exceeded-${effectiveSnapshot.timestamp}`,
                title: "流量配额已超出",
                message: "本月累计流量已经达到或超过设定配额。",
                metric: "quota" as const,
                timestamp: effectiveSnapshot.timestamp,
              };
              setAlertRecords((items) => [record, ...items].slice(0, MAX_ALERT_RECORDS));
              emitAppEvent("app:alert-raised", record);
              exceededTriggered = true;
            }
          }

          return {
            periodKey: nextPeriodKey,
            usedBytes,
            warningTriggered,
            exceededTriggered,
          };
        });

        if (alertSettings.enabled) {
          const currentMemoryPercent =
            effectiveSnapshot.memory_total > 0 ? (effectiveSnapshot.memory_used / effectiveSnapshot.memory_total) * 100 : 0;
          const triggeredAlerts: AlertRecord[] = [];
          if (effectiveSnapshot.cpu_usage >= alertSettings.cpuPercent) {
            triggeredAlerts.push({
              id: `cpu-${effectiveSnapshot.timestamp}`,
              title: "CPU 告警",
              message: `CPU 占用达到 ${effectiveSnapshot.cpu_usage.toFixed(0)}%。`,
              metric: "cpu",
              timestamp: effectiveSnapshot.timestamp,
            });
          }
          if (currentMemoryPercent >= alertSettings.memoryPercent) {
            triggeredAlerts.push({
              id: `memory-${effectiveSnapshot.timestamp}`,
              title: "内存告警",
              message: `内存占用达到 ${currentMemoryPercent.toFixed(0)}%。`,
              metric: "memory",
              timestamp: effectiveSnapshot.timestamp,
            });
          }
          if (effectiveSnapshot.network_download >= alertSettings.downloadBytesPerSec) {
            triggeredAlerts.push({
              id: `download-${effectiveSnapshot.timestamp}`,
              title: "下载速率告警",
              message: `下载速率达到 ${(effectiveSnapshot.network_download / 1024 / 1024).toFixed(1)} MB/s。`,
              metric: "download",
              timestamp: effectiveSnapshot.timestamp,
            });
          }
          if (effectiveSnapshot.network_upload >= alertSettings.uploadBytesPerSec) {
            triggeredAlerts.push({
              id: `upload-${effectiveSnapshot.timestamp}`,
              title: "上传速率告警",
              message: `上传速率达到 ${(effectiveSnapshot.network_upload / 1024 / 1024).toFixed(1)} MB/s。`,
              metric: "upload",
              timestamp: effectiveSnapshot.timestamp,
            });
          }

          if (triggeredAlerts.length > 0) {
            setAlertRecords((items) => {
              const allowed: AlertRecord[] = [];
              for (const alert of triggeredAlerts) {
                const latest = items.find((item) => item.metric === alert.metric);
                const cooldownMs = alertSettings.cooldownSeconds * 1000;
                if (!latest || alert.timestamp - latest.timestamp >= cooldownMs) {
                  allowed.push(alert);
                }
              }
              if (allowed.length === 0) {
                return items;
              }
              for (const alert of allowed) {
                emitAppEvent("app:alert-raised", alert);
              }
              return [...allowed.reverse(), ...items].slice(0, MAX_ALERT_RECORDS);
            });
          }
        }
      });
    },
  });

  const {
    expanded,
    expansionDirection,
    snapshot,
    history,
    collapsedHeight,
    collapsedWidth,
    statusTextRef,
    handleCollapsedPointerDown,
    handleCollapsedPointerMove,
    handleCollapsedPointerUp,
    resetCollapsedPointer,
    handleCollapsedResizeStart,
    handleExpandedResizeStart,
    handleDragStart,
    toggleExpanded,
  } = layout;
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved && saved in themeDefinitions ? (saved as ThemeId) : "cyberpunk";
  });
  const [appVersion, setAppVersion] = useState(() => (isTauriEnv ? "--" : "dev"));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const diagnostics = useRuntimeDiagnostics(isTauriEnv);
  const { updateState, checkForUpdates, installUpdate } = useUpdater(isTauriEnv);
  useOverlayInteraction(isTauriEnv);
  const [updatePollIntervalMinutes, setUpdatePollIntervalMinutes] = useState<UpdatePollIntervalMinutes>(() =>
    loadUpdatePollIntervalMinutes(),
  );

  const onCheckOrInstallUpdate = useCallback(() => {
    void (updateState.stage === "available" ? installUpdate() : checkForUpdates());
  }, [checkForUpdates, installUpdate, updateState.stage]);

  /**
   * 获取应用版本号（仅桌面端）。用于更新卡片与标题栏展示。
   */
  useEffect(() => {
    if (!isTauriEnv) {
      return;
    }

    void getVersion()
      .then(setAppVersion)
      .catch(() => {
        setAppVersion("--");
      });
  }, [isTauriEnv]);

  /**
   * 静默轮询更新（10 分钟一次）。
   *
   * - 仅在桌面端启用\n+   * - 使用 silent 模式避免打断用户（不切换成 “检查中…”）
   */
  useEffect(() => {
    if (!isTauriEnv) {
      return;
    }

    void checkForUpdates({ silent: true });
    const timer = window.setInterval(() => {
      void checkForUpdates({ silent: true });
    }, updatePollIntervalMinutes * 60 * 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [checkForUpdates, isTauriEnv, updatePollIntervalMinutes]);

  useEffect(() => {
    saveUpdatePollIntervalMinutes(updatePollIntervalMinutes);
  }, [updatePollIntervalMinutes]);

  const setNicPreference = useCallback((next: NicPreference) => {
    setNicPreferenceState(next);
    saveNicPreference(next);
    emitAppEvent("app:settings-changed", { key: "nicPreference" });
  }, []);

  const setAlertSettings = useCallback((next: AlertSettings) => {
    setAlertSettingsState(next);
    saveAlertSettings(next);
    emitAppEvent("app:settings-changed", { key: "alertSettings" });
  }, []);

  const setQuotaSettings = useCallback((next: QuotaSettings) => {
    setQuotaSettingsState(next);
    saveQuotaSettings(next);
    emitAppEvent("app:settings-changed", { key: "quotaSettings" });
  }, []);

  useEffect(() => {
    saveQuotaRuntime(quotaRuntime);
  }, [quotaRuntime]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  /**
   * 启动时把“鼠标穿透”配置同步到后端（Windows）。\n+   * 由于开启后窗口不可点击，因此 UI 也提供托盘入口作为兜底关闭方式。
   */
  useEffect(() => {
    if (!isTauriEnv) {
      return;
    }

    const saved = window.localStorage.getItem(CLICK_THROUGH_STORAGE_KEY);
    const enabled = saved === "1" || saved === "true";
    void setClickThroughEnabled(enabled).catch(() => {
      // ignore (non-windows or command unavailable)
    });
  }, [isTauriEnv]);

  const diagnosticsLabel = useMemo(() => {
    if (!diagnostics) {
      return null;
    }

    const ageSeconds =
      diagnostics.last_snapshot_at_ms > 0
        ? Math.max(0, Math.round((nowMs - diagnostics.last_snapshot_at_ms) / 1000))
        : null;
    const ageText = ageSeconds === null ? "--" : `${ageSeconds}s`;
    return `采样 ${diagnostics.sampler_tick_count} 次 · 最近 ${ageText} · 交互 ${diagnostics.overlay_interactive ? "开" : "关"}`;
  }, [diagnostics, nowMs]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    const unlisten = listenAppEvent("app:alert-raised", (detail) => {
      if (!("Notification" in window)) {
        return;
      }

      const notify = () => {
        try {
          new Notification(detail.title, { body: detail.message });
        } catch {
          // ignore notification failures
        }
      };

      if (Notification.permission === "granted") {
        notify();
      } else if (Notification.permission === "default") {
        void Notification.requestPermission().then((permission) => {
          if (permission === "granted") {
            notify();
          }
        });
      }
    });

    return () => {
      unlisten();
    };
  }, []);

  return (
    <main className={`shell theme-${theme} ${expanded ? "shell-expanded" : ""}`}>
      <section
        className={`widget ${expanded && expansionDirection === "up" ? "widget-expand-up" : "widget-expand-down"}`}
      >
        <StatusStrip
          expanded={expanded}
          collapsedHeight={collapsedHeight}
          collapsedWidth={collapsedWidth}
          statusTextRef={statusTextRef}
          onPointerDown={handleCollapsedPointerDown}
          onPointerMove={(event) => void handleCollapsedPointerMove(event)}
          onPointerUp={() => void handleCollapsedPointerUp()}
          onPointerCancel={resetCollapsedPointer}
          onResizeHandlePointerDown={(event) => void handleCollapsedResizeStart(event)}
          snapshot={snapshot}
        />

        <ControlCenter
          expanded={expanded}
          appVersion={appVersion}
          lastUpdated={lastUpdated}
          theme={theme}
          setTheme={setTheme}
          updateState={updateState}
          updatePollIntervalMinutes={updatePollIntervalMinutes}
          setUpdatePollIntervalMinutes={setUpdatePollIntervalMinutes}
          nicPreference={nicPreference}
          setNicPreference={setNicPreference}
          alertSettings={alertSettings}
          setAlertSettings={setAlertSettings}
          quotaSettings={quotaSettings}
          setQuotaSettings={setQuotaSettings}
          quotaRuntime={quotaRuntime}
          alertRecords={alertRecords}
          historySummary={historySummary}
          historySeries={historySeries}
          onCheckOrInstallUpdate={onCheckOrInstallUpdate}
          onCollapse={() => void toggleExpanded()}
          onHeaderPointerDown={(event) => void handleDragStart(event)}
          diagnosticsLabel={diagnosticsLabel}
          snapshot={snapshot}
          history={history}
        />

        {expanded ? (
          <div
            className="resize-handle resize-handle-expanded"
            role="presentation"
            onPointerDown={(event) => void handleExpandedResizeStart(event)}
          />
        ) : null}
      </section>
    </main>
  );
}

export default App;

import { useCallback, useState } from "react";

import { formatBytes } from "../../utils";
import { formatIntervalLabel, formatQuotaResetLabel, nicModeOptions, updatePollIntervalOptionsMinutes } from "../../config/settings";
import type { CardId } from "../../config/uiLayout";
import type { AlertRecord, HistorySummary, QuotaRuntime } from "../../types";
import type { AlertSettings, NicPreference, QuotaSettings, UpdatePollIntervalMinutes } from "../../config/settings";
import { AlertSummaryCard } from "./AlertSummaryCard";
import { HistorySummaryCard } from "./HistorySummaryCard";

type ControlCenterSettingsModalProps = {
  open: boolean;
  onClose: () => void;

  nicPreference: NicPreference;
  setNicPreference: (next: NicPreference) => void;

  updatePollIntervalMinutes: UpdatePollIntervalMinutes;
  setUpdatePollIntervalMinutes: (next: UpdatePollIntervalMinutes) => void;

  alertSettings: AlertSettings;
  setAlertSettings: (next: AlertSettings) => void;

  quotaSettings: QuotaSettings;
  setQuotaSettings: (next: QuotaSettings) => void;

  quotaRuntime: QuotaRuntime;
  alertRecords: AlertRecord[];

  historySummary: HistorySummary;
  historySeries: { downloadPerMinute: number[]; uploadPerMinute: number[] };

  snapshot: {
    nics: Array<{ id: string }>;
    active_nic_id: string | null;
  };

  cardOrder: CardId[];
  cardVisibility: Record<CardId, boolean>;
  onResetCards: () => void;
  onToggleCard: (id: CardId) => void;
  onMoveCard: (id: CardId, direction: -1 | 1) => void;

  hostStaleThresholdMs: number;
  setHostStaleThresholdMs: (ms: number) => void;
};

type SettingsTab = "overview" | "alerts" | "quota" | "history";

export function ControlCenterSettingsModal({
  open,
  onClose,
  nicPreference,
  setNicPreference,
  updatePollIntervalMinutes,
  setUpdatePollIntervalMinutes,
  alertSettings,
  setAlertSettings,
  quotaSettings,
  setQuotaSettings,
  quotaRuntime,
  alertRecords,
  historySummary,
  historySeries,
  snapshot,
  cardOrder,
  cardVisibility,
  onResetCards,
  onToggleCard,
  onMoveCard,
  hostStaleThresholdMs,
  setHostStaleThresholdMs,
}: ControlCenterSettingsModalProps) {
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("overview");

  const setTab = useCallback((tab: SettingsTab) => {
    setSettingsTab(tab);
  }, []);

  if (!open) {
    return null;
  }

  return (
    <div className="settings-modal" onClick={onClose}>
      <section
        className="settings-modal-panel"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="settings-modal-header">
          <div>
            <span className="settings-label">控制中心</span>
            <strong>设置</strong>
          </div>
          <button type="button" className="expand-button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="settings-modal-body">
          <nav className="settings-tabs">
            <button
              type="button"
              className={`settings-tab ${settingsTab === "overview" ? "settings-tab-active" : ""}`}
              onClick={() => setTab("overview")}
            >
              总览
            </button>
            <button
              type="button"
              className={`settings-tab ${settingsTab === "alerts" ? "settings-tab-active" : ""}`}
              onClick={() => setTab("alerts")}
            >
              告警
            </button>
            <button
              type="button"
              className={`settings-tab ${settingsTab === "quota" ? "settings-tab-active" : ""}`}
              onClick={() => setTab("quota")}
            >
              配额
            </button>
            <button
              type="button"
              className={`settings-tab ${settingsTab === "history" ? "settings-tab-active" : ""}`}
              onClick={() => setTab("history")}
            >
              历史
            </button>
          </nav>

          <div className="settings-modal-content">
            {settingsTab === "overview" ? (
              <>
                <article className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <span className="settings-label">网卡</span>
                      <strong>自动选择或手动锁定</strong>
                    </div>
                    <span className="theme-current">{nicPreference.mode === "auto" ? "自动" : nicPreference.nicId ?? "手动"}</span>
                  </div>
                  <div className="settings-popover-options">
                    {nicModeOptions.map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`settings-option ${nicPreference.mode === mode ? "settings-option-active" : ""}`}
                        onClick={() =>
                          setNicPreference({
                            mode,
                            nicId: mode === "auto" ? null : nicPreference.nicId ?? snapshot.active_nic_id ?? snapshot.nics[0]?.id ?? null,
                          })
                        }
                      >
                        {mode === "auto" ? "自动" : "手动"}
                      </button>
                    ))}
                  </div>
                  {nicPreference.mode === "manual" ? (
                    <div className="kv-table">
                      {snapshot.nics.map((nic) => (
                        <div key={`nic-select-${nic.id}`} className="kv-row">
                          <span className="kv-key">{nic.id}</span>
                          <span className="kv-value">
                            <button
                              type="button"
                              className={`settings-option ${nicPreference.nicId === nic.id ? "settings-option-active" : ""}`}
                              onClick={() => setNicPreference({ mode: "manual", nicId: nic.id })}
                            >
                              选中
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>

                <article className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <span className="settings-label">更新</span>
                      <strong>后台检查频率</strong>
                    </div>
                    <span className="theme-current">{formatIntervalLabel(updatePollIntervalMinutes)}</span>
                  </div>
                  <div className="settings-popover-options">
                    {updatePollIntervalOptionsMinutes.map((minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        className={`settings-option ${minutes === updatePollIntervalMinutes ? "settings-option-active" : ""}`}
                        onClick={() => setUpdatePollIntervalMinutes(minutes)}
                      >
                        {formatIntervalLabel(minutes)}
                      </button>
                    ))}
                  </div>
                </article>

                <article className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <span className="settings-label">主机状态</span>
                      <strong>离线判定阈值</strong>
                    </div>
                    <span className="theme-current">{Math.round(hostStaleThresholdMs / 1000)}s</span>
                  </div>
                  <div className="kv-table">
                    <div className="kv-row">
                      <span className="kv-key">超过该时长未上报 → 可能离线</span>
                      <span className="kv-value">
                        <input
                          className="settings-number-input"
                          type="number"
                          min={2}
                          max={600}
                          value={Math.round(hostStaleThresholdMs / 1000)}
                          onChange={(event) => setHostStaleThresholdMs(Number(event.target.value || 12) * 1000)}
                        />
                        秒
                      </span>
                    </div>
                    <div className="settings-popover-options">
                      {[6, 12, 20, 30, 60].map((sec) => (
                        <button
                          key={`stale-${sec}`}
                          type="button"
                          className={`settings-option ${Math.round(hostStaleThresholdMs / 1000) === sec ? "settings-option-active" : ""}`}
                          onClick={() => setHostStaleThresholdMs(sec * 1000)}
                        >
                          {sec}s
                        </button>
                      ))}
                    </div>
                  </div>
                </article>
              </>
            ) : null}

            {settingsTab === "alerts" ? (
              <>
                <AlertSummaryCard alertRecords={alertRecords} quotaRuntime={quotaRuntime} />
                <article className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <span className="settings-label">阈值告警</span>
                      <strong>超限提醒（带冷却）</strong>
                    </div>
                    <button
                      type="button"
                      className={`settings-option ${alertSettings.enabled ? "settings-option-active" : ""}`}
                      onClick={() => setAlertSettings({ ...alertSettings, enabled: !alertSettings.enabled })}
                    >
                      {alertSettings.enabled ? "已开启" : "已关闭"}
                    </button>
                  </div>
                  <div className="kv-table">
                    <div className="kv-row">
                      <span className="kv-key">CPU / 内存阈值</span>
                      <span className="kv-value">
                        <input
                          className="settings-number-input"
                          type="number"
                          min={10}
                          max={100}
                          value={alertSettings.cpuPercent}
                          onChange={(event) => setAlertSettings({ ...alertSettings, cpuPercent: Number(event.target.value || 0) })}
                        />
                        %{" / "}
                        <input
                          className="settings-number-input"
                          type="number"
                          min={10}
                          max={100}
                          value={alertSettings.memoryPercent}
                          onChange={(event) =>
                            setAlertSettings({ ...alertSettings, memoryPercent: Number(event.target.value || 0) })
                          }
                        />
                        %
                      </span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-key">下载 / 上传阈值</span>
                      <span className="kv-value">
                        <input
                          className="settings-number-input"
                          type="number"
                          min={1}
                          value={Math.round(alertSettings.downloadBytesPerSec / 1024 / 1024)}
                          onChange={(event) =>
                            setAlertSettings({
                              ...alertSettings,
                              downloadBytesPerSec: Number(event.target.value || 0) * 1024 * 1024,
                            })
                          }
                        />
                        MB/s{" / "}
                        <input
                          className="settings-number-input"
                          type="number"
                          min={1}
                          value={Math.round(alertSettings.uploadBytesPerSec / 1024 / 1024)}
                          onChange={(event) =>
                            setAlertSettings({
                              ...alertSettings,
                              uploadBytesPerSec: Number(event.target.value || 0) * 1024 * 1024,
                            })
                          }
                        />
                        MB/s
                      </span>
                    </div>
                    <div className="kv-row">
                      <span className="kv-key">冷却时间</span>
                      <span className="kv-value">
                        <input
                          className="settings-number-input"
                          type="number"
                          min={30}
                          step={30}
                          value={alertSettings.cooldownSeconds}
                          onChange={(event) =>
                            setAlertSettings({ ...alertSettings, cooldownSeconds: Number(event.target.value || 0) })
                          }
                        />
                        秒
                      </span>
                    </div>
                  </div>
                </article>
              </>
            ) : null}

            {settingsTab === "quota" ? (
              <article className="settings-card">
                <div className="settings-card-header">
                  <div>
                    <span className="settings-label">流量配额</span>
                    <strong>月度累计与预警（可配置重置日）</strong>
                  </div>
                  <button
                    type="button"
                    className={`settings-option ${quotaSettings.enabled ? "settings-option-active" : ""}`}
                    onClick={() => setQuotaSettings({ ...quotaSettings, enabled: !quotaSettings.enabled })}
                  >
                    {quotaSettings.enabled ? "已开启" : "已关闭"}
                  </button>
                </div>
                <div className="kv-table">
                  <div className="kv-row">
                    <span className="kv-key">每月配额</span>
                    <span className="kv-value">
                      <input
                        className="settings-number-input"
                        type="number"
                        min={1}
                        value={Math.round(quotaSettings.monthlyBytes / 1024 / 1024 / 1024)}
                        onChange={(event) =>
                          setQuotaSettings({
                            ...quotaSettings,
                            monthlyBytes: Number(event.target.value || 0) * 1024 * 1024 * 1024,
                          })
                        }
                      />
                      GB
                    </span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-key">预警 / 重置日</span>
                    <span className="kv-value">
                      <input
                        className="settings-number-input"
                        type="number"
                        min={1}
                        max={100}
                        value={quotaSettings.warningPercent}
                        onChange={(event) => setQuotaSettings({ ...quotaSettings, warningPercent: Number(event.target.value || 0) })}
                      />
                      %{" / "}
                      <input
                        className="settings-number-input"
                        type="number"
                        min={1}
                        max={28}
                        value={quotaSettings.resetDay}
                        onChange={(event) => setQuotaSettings({ ...quotaSettings, resetDay: Number(event.target.value || 1) })}
                      />
                      日
                    </span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-key">当前周期</span>
                    <span className="kv-value">
                      已用 {formatBytes(quotaRuntime.usedBytes)} / {formatBytes(quotaSettings.monthlyBytes)}
                    </span>
                  </div>
                  <div className="kv-row">
                    <span className="kv-key">结算周期</span>
                    <span className="kv-value">{formatQuotaResetLabel(quotaSettings.resetDay)}</span>
                  </div>
                </div>
              </article>
            ) : null}

            {settingsTab === "history" ? (
              <>
                <HistorySummaryCard historySummary={historySummary} series={historySeries} />
                <article className="settings-card">
                  <div className="settings-card-header">
                    <div>
                      <span className="settings-label">最近告警</span>
                      <strong>仅保留最近 {alertRecords.length} 条</strong>
                    </div>
                  </div>
                  <div className="kv-table">
                    {alertRecords.length ? (
                      alertRecords.slice(0, 6).map((record) => (
                        <div key={record.id} className="kv-row">
                          <span className="kv-key">{record.title}</span>
                          <span className="kv-value">{new Date(record.timestamp).toLocaleTimeString()}</span>
                        </div>
                      ))
                    ) : (
                      <div className="kv-row">
                        <span className="kv-key">告警</span>
                        <span className="kv-value">暂无</span>
                      </div>
                    )}
                  </div>
                </article>
              </>
            ) : null}

            <article className="settings-card settings-card-full">
              <div className="settings-card-header">
                <div>
                  <span className="settings-label">布局</span>
                  <strong>卡片顺序与显示</strong>
                </div>
                <button type="button" className="settings-option" onClick={onResetCards}>
                  恢复默认
                </button>
              </div>
              <div className="kv-table">
                {cardOrder.map((id) => (
                  <div key={`layout-${id}`} className="kv-row">
                    <span className="kv-key">{id}</span>
                    <span className="kv-value">
                      <button type="button" className="settings-option" onClick={() => onToggleCard(id)}>
                        {cardVisibility[id] ? "显示" : "隐藏"}
                      </button>{" "}
                      <button type="button" className="settings-option" onClick={() => onMoveCard(id, -1)}>
                        上移
                      </button>{" "}
                      <button type="button" className="settings-option" onClick={() => onMoveCard(id, 1)}>
                        下移
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </article>
          </div>
        </div>
      </section>
    </div>
  );
}


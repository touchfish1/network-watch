import type { AlertRecord, QuotaRuntime } from "../../types";
import { formatBytes } from "../../utils";

type AlertSummaryCardProps = {
  alertRecords: AlertRecord[];
  quotaRuntime: QuotaRuntime;
};

export function AlertSummaryCard({ alertRecords, quotaRuntime }: AlertSummaryCardProps) {
  const latest = alertRecords[0] ?? null;

  return (
    <article className="settings-card alerts-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">告警</span>
          <strong>最近状态</strong>
        </div>
        <span className="theme-current">{latest ? latest.title : "正常"}</span>
      </div>
      <div className="kv-table">
        <div className="kv-row">
          <span className="kv-key">最近一条</span>
          <span className="kv-value">{latest ? new Date(latest.timestamp).toLocaleTimeString() : "—"}</span>
        </div>
        <div className="kv-row">
          <span className="kv-key">本周期累计流量</span>
          <span className="kv-value">{formatBytes(quotaRuntime.usedBytes)}</span>
        </div>
        {latest ? (
          <div className="kv-row">
            <span className="kv-key">说明</span>
            <span className="kv-value">{latest.message}</span>
          </div>
        ) : (
          <div className="kv-row">
            <span className="kv-key">提示</span>
            <span className="kv-value">未触发告警</span>
          </div>
        )}
      </div>
    </article>
  );
}


import type { HistorySummary } from "../../types";
import { formatBytes } from "../../utils";
import { Sparkline } from "../Sparkline";

type HistorySummaryCardProps = {
  historySummary: HistorySummary;
  series: {
    downloadPerMinute: number[];
    uploadPerMinute: number[];
  };
  lowLoadMode?: boolean;
};

export function HistorySummaryCard({ historySummary, series, lowLoadMode = false }: HistorySummaryCardProps) {
  return (
    <article className="settings-card history-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">历史</span>
          <strong>最近趋势与汇总</strong>
        </div>
        <span className="theme-current">{historySummary.sampleCount} 分钟桶</span>
      </div>
      <div className="network-lines">
        <Sparkline values={series.downloadPerMinute} tone="download" lowLoadMode={lowLoadMode} />
        <Sparkline values={series.uploadPerMinute} tone="upload" lowLoadMode={lowLoadMode} />
      </div>
      <div className="kv-table kv-table-secondary">
        <div className="kv-row">
          <span className="kv-key">24 小时</span>
          <span className="kv-value">
            ↓ {formatBytes(historySummary.last24HoursDownload)} / ↑ {formatBytes(historySummary.last24HoursUpload)}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-key">7 天</span>
          <span className="kv-value">
            ↓ {formatBytes(historySummary.last7DaysDownload)} / ↑ {formatBytes(historySummary.last7DaysUpload)}
          </span>
        </div>
      </div>
    </article>
  );
}


import { useMemo } from "react";

type HostEventType = "online" | "offline";

type HostEvent = {
  timestamp: number;
  type: HostEventType;
  machineId: string;
  label: string;
};

type HostEventsCardProps = {
  events: HostEvent[];
  selectedMachineId: string | null;
  scope: "current" | "all";
  timeRange: "1h" | "24h" | "7d";
  offset: number;
  pageSize: number;
  hasMore: boolean;
  loading: boolean;
  eventTypeFilter: "all" | HostEventType;
  query: string;
  onChangeScope: (next: "current" | "all") => void;
  onChangeTimeRange: (next: "1h" | "24h" | "7d") => void;
  onChangeEventTypeFilter: (next: "all" | HostEventType) => void;
  onChangeQuery: (next: string) => void;
  onPagePrev: () => void;
  onPageNext: () => void;
  onBackToLatest: () => void;
};

function formatRelativeTime(ts: number) {
  const diffMs = Date.now() - ts;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s 前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m 前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}h 前`;
  return `${Math.floor(hour / 24)}d 前`;
}

export function HostEventsCard({
  events,
  selectedMachineId,
  scope,
  timeRange,
  offset,
  pageSize,
  hasMore,
  loading,
  eventTypeFilter,
  query,
  onChangeScope,
  onChangeTimeRange,
  onChangeEventTypeFilter,
  onChangeQuery,
  onPagePrev,
  onPageNext,
  onBackToLatest,
}: HostEventsCardProps) {
  const top = useMemo(() => {
    if (selectedMachineId) {
      return events.filter((e) => e.machineId === selectedMachineId).slice(0, 20);
    }
    return events.slice(0, 20);
  }, [events, selectedMachineId]);
  return (
    <div className="card-desc">
      <div className="settings-popover-options" style={{ marginBottom: 8 }}>
        <button
          type="button"
          className={`settings-option ${scope === "current" ? "settings-option-active" : ""}`}
          onClick={() => onChangeScope("current")}
        >
          当前主机
        </button>
        <button type="button" className={`settings-option ${scope === "all" ? "settings-option-active" : ""}`} onClick={() => onChangeScope("all")}>
          全部主机
        </button>
        <button type="button" className={`settings-option ${timeRange === "1h" ? "settings-option-active" : ""}`} onClick={() => onChangeTimeRange("1h")}>
          1h
        </button>
        <button
          type="button"
          className={`settings-option ${timeRange === "24h" ? "settings-option-active" : ""}`}
          onClick={() => onChangeTimeRange("24h")}
        >
          24h
        </button>
        <button type="button" className={`settings-option ${timeRange === "7d" ? "settings-option-active" : ""}`} onClick={() => onChangeTimeRange("7d")}>
          7d
        </button>
        <button
          type="button"
          className={`settings-option ${eventTypeFilter === "all" ? "settings-option-active" : ""}`}
          onClick={() => onChangeEventTypeFilter("all")}
        >
          全部
        </button>
        <button
          type="button"
          className={`settings-option ${eventTypeFilter === "online" ? "settings-option-active" : ""}`}
          onClick={() => onChangeEventTypeFilter("online")}
        >
          上线
        </button>
        <button
          type="button"
          className={`settings-option ${eventTypeFilter === "offline" ? "settings-option-active" : ""}`}
          onClick={() => onChangeEventTypeFilter("offline")}
        >
          离线
        </button>
        <input
          className="settings-text-input"
          placeholder="筛选主机名 / machine_id"
          value={query}
          onChange={(e) => onChangeQuery(e.target.value)}
        />
        <button type="button" className="settings-option" onClick={onBackToLatest} disabled={offset <= 0}>
          最新
        </button>
        <button type="button" className="settings-option" onClick={onPagePrev} disabled={offset <= 0}>
          上一页
        </button>
        <button type="button" className="settings-option" onClick={onPageNext} disabled={!hasMore}>
          下一页
        </button>
        <span style={{ opacity: 0.7 }}>第 {Math.floor(offset / Math.max(1, pageSize)) + 1} 页{loading ? " · 刷新中" : ""}</span>
      </div>
      {top.length ? (
        top.map((event) => (
          <div key={`${event.timestamp}-${event.machineId}-${event.type}`} className="host-pill" style={{ marginBottom: 6 }}>
            <span className={`host-status-pill ${event.type === "online" ? "host-status-ok" : "host-status-stale"}`}>
              {event.type === "online" ? "上线" : "离线"}
            </span>
            <span>{event.label}</span>
            <span style={{ marginLeft: "auto", opacity: 0.7 }}>{formatRelativeTime(event.timestamp)}</span>
          </div>
        ))
      ) : (
        <div>暂无事件（上线/离线）</div>
      )}
    </div>
  );
}

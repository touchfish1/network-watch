import { useMemo, useState } from "react";

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

export function HostEventsCard({ events, selectedMachineId }: HostEventsCardProps) {
  const [eventTypeFilter, setEventTypeFilter] = useState<"all" | HostEventType>("all");
  const [query, setQuery] = useState("");
  const top = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = events.filter((e) => {
      if (selectedMachineId && e.machineId !== selectedMachineId) return false;
      if (eventTypeFilter !== "all" && e.type !== eventTypeFilter) return false;
      if (!q) return true;
      const text = `${e.label} ${e.machineId}`.toLowerCase();
      return text.includes(q);
    });
    return filtered.slice(0, 20);
  }, [eventTypeFilter, events, query, selectedMachineId]);
  return (
    <div className="card-desc">
      <div className="settings-popover-options" style={{ marginBottom: 8 }}>
        <button
          type="button"
          className={`settings-option ${eventTypeFilter === "all" ? "settings-option-active" : ""}`}
          onClick={() => setEventTypeFilter("all")}
        >
          全部
        </button>
        <button
          type="button"
          className={`settings-option ${eventTypeFilter === "online" ? "settings-option-active" : ""}`}
          onClick={() => setEventTypeFilter("online")}
        >
          上线
        </button>
        <button
          type="button"
          className={`settings-option ${eventTypeFilter === "offline" ? "settings-option-active" : ""}`}
          onClick={() => setEventTypeFilter("offline")}
        >
          离线
        </button>
        <input
          className="settings-text-input"
          placeholder="筛选主机名 / machine_id"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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

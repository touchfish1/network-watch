import { useMemo, useState } from "react";
import { formatMemoryUsage, formatPercent, formatRate, formatUptimeSeconds } from "../../utils";
import type { OnlineMachine } from "../../types";

export type OnlineHostsCardProps = {
  machines: OnlineMachine[];
  selectedMachineId: string | null;
  onSelectMachine: (machineId: string) => void;
  staleThresholdMs: number;
  pinnedMachineIds: string[];
  onTogglePinned: (machineId: string) => void;
  events: Array<{
    timestamp: number;
    type: "online" | "offline";
    machineId: string;
    label: string;
  }>;
};

export function OnlineHostsCard({
  machines,
  selectedMachineId,
  onSelectMachine,
  staleThresholdMs,
  pinnedMachineIds,
  onTogglePinned,
  events,
}: OnlineHostsCardProps) {
  const [query, setQuery] = useState("");
  const [onlyPinned, setOnlyPinned] = useState(false);

  const now = Date.now();
  const normalizedQuery = query.trim().toLowerCase();
  const filteredMachines = useMemo(() => {
    if (!normalizedQuery) return machines;
    return machines.filter((item) => {
      const parts = [
        item.label ?? "",
        item.host_name ?? "",
        item.machine_id ?? "",
        Array.isArray(item.host_ips) ? item.host_ips.join(" ") : "",
      ];
      return parts.join(" ").toLowerCase().includes(normalizedQuery);
    });
  }, [machines, normalizedQuery]);

  const pinnedSet = useMemo(() => new Set(pinnedMachineIds), [pinnedMachineIds]);
  const displayMachines = useMemo(() => {
    const base = onlyPinned ? filteredMachines.filter((m) => pinnedSet.has(m.machine_id)) : filteredMachines;
    // 置顶排序：pin 在前，其他保持 received_at_ms 降序（后端已排好，这里只做稳定处理）
    return [...base].sort((a, b) => {
      const ap = pinnedSet.has(a.machine_id) ? 1 : 0;
      const bp = pinnedSet.has(b.machine_id) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.received_at_ms ?? 0) - (a.received_at_ms ?? 0);
    });
  }, [filteredMachines, onlyPinned, pinnedSet]);

  const selectedMachine =
    displayMachines.find((item) => item.machine_id === selectedMachineId) ?? displayMachines[0] ?? null;
  const selectedLabel = selectedMachine?.label ?? selectedMachine?.host_name ?? selectedMachine?.machine_id ?? null;
  const selectedSnapshot = selectedMachine?.snapshot ?? null;
  const cpuUsage = typeof selectedSnapshot?.cpu_usage === "number" ? selectedSnapshot.cpu_usage : 0;
  const memoryUsed = typeof selectedSnapshot?.memory_used === "number" ? selectedSnapshot.memory_used : 0;
  const memoryTotal = typeof selectedSnapshot?.memory_total === "number" ? selectedSnapshot.memory_total : 0;
  const networkDownload =
    typeof selectedSnapshot?.network_download === "number" ? selectedSnapshot.network_download : 0;
  const networkUpload =
    typeof selectedSnapshot?.network_upload === "number" ? selectedSnapshot.network_upload : 0;
  const uptimeSeconds = typeof selectedSnapshot?.uptime_seconds === "number" ? selectedSnapshot.uptime_seconds : 0;
  const processCount = typeof selectedSnapshot?.process_count === "number" ? selectedSnapshot.process_count : 0;
  const hostIps = Array.isArray(selectedMachine?.host_ips)
    ? selectedMachine.host_ips.filter((ip): ip is string => typeof ip === "string" && ip.length > 0)
    : [];
  const lastSeenMs = typeof selectedMachine?.received_at_ms === "number" ? selectedMachine.received_at_ms : null;
  const ageMs = lastSeenMs ? Math.max(0, now - lastSeenMs) : null;
  const isStale = ageMs !== null ? ageMs > staleThresholdMs : false;

  const ageLabel = useMemo(() => {
    if (ageMs === null) return "—";
    const s = Math.round(ageMs / 1000);
    if (s < 60) return `${s}s 前`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m 前`;
    const h = Math.round(m / 60);
    return `${h}h 前`;
  }, [ageMs]);

  return (
    <article className="settings-card online-hosts-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">在线主机</span>
          <strong>
            {machines.length > 0 ? `已发现 ${machines.length} 台` : "暂无在线主机"}
            {normalizedQuery ? (
              <span className="muted" style={{ marginLeft: 8 }}>
                （匹配 {displayMachines.length}）
              </span>
            ) : null}
          </strong>
        </div>
        <span className="theme-current">{selectedLabel ?? "无数据"}</span>
      </div>

      <div className="kv-table">
        {machines.length === 0 ? (
          <div className="kv-row">
            <span className="kv-key">等待 agent 上报（/api/v1/ingest）</span>
            <span className="kv-value">—</span>
          </div>
        ) : (
          <>
            <div className="online-host-search">
              <input
                className="settings-text-input"
                value={query}
                placeholder="搜索：label / 主机名 / IP / machine_id"
                onChange={(e) => setQuery(e.target.value)}
              />
              {query ? (
                <button type="button" className="settings-option" onClick={() => setQuery("")}>
                  清空
                </button>
              ) : null}
              <button
                type="button"
                className={`settings-option ${onlyPinned ? "settings-option-active" : ""}`}
                onClick={() => setOnlyPinned((v) => !v)}
                title="只显示关注(置顶)的主机"
              >
                只看关注
              </button>
            </div>
            {displayMachines.length === 0 ? (
              <div className="kv-row">
                <span className="kv-key">无匹配主机</span>
                <span className="kv-value">—</span>
              </div>
            ) : displayMachines.length === 1 ? null : (
              <div className="online-host-switcher">
                {displayMachines.map((item) => {
                  const pinned = pinnedSet.has(item.machine_id);
                  return (
                    <div key={item.machine_id} className="host-pill">
                      <button
                        type="button"
                        className={`pin-button ${pinned ? "pin-button-on" : ""}`}
                        title={pinned ? "取消关注" : "关注/置顶"}
                        onClick={() => onTogglePinned(item.machine_id)}
                      >
                        {pinned ? "★" : "☆"}
                      </button>
                      <button
                        type="button"
                        className={`settings-option ${selectedMachine?.machine_id === item.machine_id ? "settings-option-active" : ""}`}
                        onClick={() => onSelectMachine(item.machine_id)}
                      >
                        {item.label ?? item.host_name ?? item.machine_id}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {selectedMachine ? (
        <div className="kv-table kv-table-secondary">
          <div className="kv-row">
            <span className="kv-key">状态</span>
            <span className="kv-value">
              <span className={`host-status-pill ${isStale ? "host-status-stale" : "host-status-ok"}`}>
                {isStale ? "可能离线" : "在线"}
              </span>
              <span className="muted">{ageLabel}</span>
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-key">Label</span>
            <span className="kv-value">{selectedMachine.label ?? "—"}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">主机名</span>
            <span className="kv-value">{selectedMachine.host_name ?? selectedMachine.machine_id}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">IP</span>
            <span className="kv-value">{hostIps.length ? hostIps.join(", ") : "—"}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">机器标识</span>
            <span className="kv-value">{selectedMachine.machine_id}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">CPU / 内存</span>
            <span className="kv-value">
              {formatPercent(cpuUsage)} / {formatMemoryUsage(memoryUsed, memoryTotal)}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-key">网络（↓ / ↑）</span>
            <span className="kv-value">
              ↓ {formatRate(networkDownload)} / ↑ {formatRate(networkUpload)}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-key">运行时长 / 进程</span>
            <span className="kv-value">
              {formatUptimeSeconds(uptimeSeconds)} / {processCount}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-key">事件</span>
            <span className="kv-value muted" style={{ fontWeight: 600 }}>
              {events.length ? `${events[0].type === "online" ? "上线" : "离线"} · ${new Date(events[0].timestamp).toLocaleTimeString()}` : "—"}
            </span>
          </div>
        </div>
      ) : null}
    </article>
  );
}

import { formatBytes, formatMemoryUsage, formatPercent, formatCompactRate, formatUptimeSeconds } from "../../utils";

type NicSnapshot = {
  id: string;
  received: number;
  transmitted: number;
};

type OverviewCardProps = {
  lastUpdated: string;
  snapshot: {
    cpu_usage: number;
    memory_used: number;
    memory_total: number;
    network_download: number;
    network_upload: number;
    uptime_seconds: number;
    process_count: number;
    system_disk: { total_bytes: number; available_bytes: number } | null;
    active_nic_id: string | null;
    nics: NicSnapshot[];
  };
};

export function OverviewCard({ lastUpdated, snapshot }: OverviewCardProps) {
  const activeNic = snapshot.active_nic_id ? snapshot.nics.find((nic) => nic.id === snapshot.active_nic_id) ?? null : null;
  const systemDiskUsedPct =
    snapshot.system_disk && snapshot.system_disk.total_bytes > 0
      ? (1 - snapshot.system_disk.available_bytes / snapshot.system_disk.total_bytes) * 100
      : null;

  return (
    <article className="overview-card">
      <div className="overview-header">
        <span className="settings-label">系统总览</span>
        <span className="theme-current">{lastUpdated}</span>
      </div>
      <div className="overview-grid">
        <div className="overview-item">
          <span className="stat-label">CPU</span>
          <strong>{formatPercent(snapshot.cpu_usage)}</strong>
          <span className="stat-subtitle">整机占用</span>
        </div>
        <div className="overview-item">
          <span className="stat-label">Memory</span>
          <strong>{formatMemoryUsage(snapshot.memory_used, snapshot.memory_total)}</strong>
          <span className="stat-subtitle">
            {formatBytes(snapshot.memory_used)} / {formatBytes(snapshot.memory_total)}
          </span>
        </div>
        <div className="overview-item">
          <span className="stat-label">Network</span>
          <strong>
            ↓ {formatCompactRate(snapshot.network_download)} / ↑ {formatCompactRate(snapshot.network_upload)}
          </strong>
          <span className="stat-subtitle">实时上下行</span>
        </div>
        <div className="overview-item">
          <span className="stat-label">Active NIC</span>
          <strong>
            {activeNic ? `↓ ${formatCompactRate(activeNic.received)} / ↑ ${formatCompactRate(activeNic.transmitted)}` : "—"}
          </strong>
          <span className="stat-subtitle">{activeNic?.id ?? "未检测到活跃网卡"}</span>
        </div>
        <div className="overview-item">
          <span className="stat-label">Disk</span>
          <strong>{systemDiskUsedPct === null ? "—" : formatPercent(systemDiskUsedPct)}</strong>
          <span className="stat-subtitle">
            {snapshot.system_disk
              ? `${formatBytes(snapshot.system_disk.available_bytes)} 可用 / ${formatBytes(snapshot.system_disk.total_bytes)}`
              : "未检测到系统盘"}
          </span>
        </div>
        <div className="overview-item">
          <span className="stat-label">Uptime</span>
          <strong>{formatUptimeSeconds(snapshot.uptime_seconds)}</strong>
          <span className="stat-subtitle">{snapshot.process_count} 进程</span>
        </div>
      </div>
    </article>
  );
}


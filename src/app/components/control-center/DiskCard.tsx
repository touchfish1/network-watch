import { formatBytes, formatPercent } from "../../utils";

type DiskCardProps = {
  disks: Array<{
    id: string;
    name: string;
    mount: string;
    total_bytes: number;
    available_bytes: number;
  }>;
};

export function DiskCard({ disks }: DiskCardProps) {
  const topDisks = [...disks].sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, 4);

  return (
    <article className="settings-card disk-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">磁盘空间</span>
          <strong>可用空间与占用</strong>
        </div>
        <span className="theme-current">{disks.length ? `${disks.length} 盘` : "—"}</span>
      </div>
      <div className="kv-table">
        {topDisks.length ? (
          topDisks.map((disk) => {
            const usedPct = disk.total_bytes > 0 ? (1 - disk.available_bytes / disk.total_bytes) * 100 : 0;
            const label = disk.mount || disk.name || disk.id;
            return (
              <div key={disk.id} className="kv-row">
                <span className="kv-key">{label}</span>
                <span className="kv-value">
                  {formatPercent(usedPct)} · {formatBytes(disk.available_bytes)} 可用
                </span>
              </div>
            );
          })
        ) : (
          <div className="kv-row">
            <span className="kv-key">磁盘</span>
            <span className="kv-value">暂无数据</span>
          </div>
        )}
      </div>
    </article>
  );
}


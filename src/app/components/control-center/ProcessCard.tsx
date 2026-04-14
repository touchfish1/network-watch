import { formatBytes, formatPercent } from "../../utils";

type ProcessCardProps = {
  processCount: number;
  topCpu: Array<{ pid: number; name: string; cpu_usage: number; memory_used: number }>;
  topMemory: Array<{ pid: number; name: string; cpu_usage: number; memory_used: number }>;
};

export function ProcessCard({ processCount, topCpu, topMemory }: ProcessCardProps) {
  return (
    <article className="settings-card process-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">进程</span>
          <strong>Top 占用</strong>
        </div>
        <span className="theme-current">{processCount ? `${processCount} 个` : "—"}</span>
      </div>
      <div className="kv-table">
        {topCpu?.length ? (
          topCpu.map((process) => (
            <div key={`cpu-${process.pid}-${process.name}`} className="kv-row">
              <span className="kv-key">
                {process.name} · {process.pid}
              </span>
              <span className="kv-value">{formatPercent(process.cpu_usage)}</span>
            </div>
          ))
        ) : (
          <div className="kv-row">
            <span className="kv-key">CPU Top</span>
            <span className="kv-value">暂无数据</span>
          </div>
        )}
      </div>
      <div className="kv-table kv-table-secondary">
        {topMemory?.length ? (
          topMemory.map((process) => (
            <div key={`mem-${process.pid}-${process.name}`} className="kv-row">
              <span className="kv-key">
                {process.name} · {process.pid}
              </span>
              <span className="kv-value">{formatBytes(process.memory_used)}</span>
            </div>
          ))
        ) : (
          <div className="kv-row">
            <span className="kv-key">Memory Top</span>
            <span className="kv-value">暂无数据</span>
          </div>
        )}
      </div>
    </article>
  );
}


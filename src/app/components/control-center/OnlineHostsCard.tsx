import { formatMemoryUsage, formatPercent, formatRate, formatUptimeSeconds } from "../../utils";
import type { OnlineMachine } from "../../types";

type OnlineHostsCardProps = {
  machines: OnlineMachine[];
  selectedMachineId: string | null;
  onSelectMachine: (machineId: string) => void;
};

export function OnlineHostsCard({ machines, selectedMachineId, onSelectMachine }: OnlineHostsCardProps) {
  const selectedMachine =
    machines.find((item) => item.machine_id === selectedMachineId) ?? machines[0] ?? null;
  const selectedLabel = selectedMachine?.label ?? selectedMachine?.host_name ?? selectedMachine?.machine_id ?? null;

  return (
    <article className="settings-card online-hosts-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">在线主机</span>
          <strong>{machines.length > 0 ? `已发现 ${machines.length} 台` : "暂无在线主机"}</strong>
        </div>
        <span className="theme-current">{selectedLabel ?? "无数据"}</span>
      </div>

      <div className="kv-table">
        {machines.length === 0 ? (
          <div className="kv-row">
            <span className="kv-key">等待 agent 上报（/api/v1/ingest）</span>
            <span className="kv-value">—</span>
          </div>
        ) : machines.length === 1 ? null : (
          <div className="online-host-switcher">
            {machines.map((item) => (
              <button
                key={item.machine_id}
                type="button"
                className={`settings-option ${selectedMachine?.machine_id === item.machine_id ? "settings-option-active" : ""}`}
                onClick={() => onSelectMachine(item.machine_id)}
              >
                {item.label ?? item.host_name ?? item.machine_id}
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedMachine ? (
        <div className="kv-table kv-table-secondary">
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
            <span className="kv-value">{selectedMachine.host_ips.length ? selectedMachine.host_ips.join(", ") : "—"}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">机器标识</span>
            <span className="kv-value">{selectedMachine.machine_id}</span>
          </div>
          <div className="kv-row">
            <span className="kv-key">CPU / 内存</span>
            <span className="kv-value">
              {formatPercent(selectedMachine.snapshot.cpu_usage)} /{" "}
              {formatMemoryUsage(selectedMachine.snapshot.memory_used, selectedMachine.snapshot.memory_total)}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-key">网络（↓ / ↑）</span>
            <span className="kv-value">
              ↓ {formatRate(selectedMachine.snapshot.network_download)} / ↑ {formatRate(selectedMachine.snapshot.network_upload)}
            </span>
          </div>
          <div className="kv-row">
            <span className="kv-key">运行时长 / 进程</span>
            <span className="kv-value">
              {formatUptimeSeconds(selectedMachine.snapshot.uptime_seconds)} / {selectedMachine.snapshot.process_count}
            </span>
          </div>
        </div>
      ) : null}
    </article>
  );
}

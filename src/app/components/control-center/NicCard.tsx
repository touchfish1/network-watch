import { formatCompactRate } from "../../utils";

type NicCardProps = {
  nics: Array<{
    id: string;
    received: number;
    transmitted: number;
  }>;
  activeNicId: string | null;
};

export function NicCard({ nics, activeNicId }: NicCardProps) {
  const activeNic = activeNicId ? nics.find((nic) => nic.id === activeNicId) ?? null : null;
  const topNics = [...nics].sort((a, b) => b.received + b.transmitted - (a.received + a.transmitted)).slice(0, 4);

  return (
    <article className="settings-card nic-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">网卡吞吐</span>
          <strong>多网卡实时速率</strong>
        </div>
        <span className="theme-current">{activeNic?.id ?? "—"}</span>
      </div>
      <div className="kv-table">
        {topNics.length ? (
          topNics.map((nic) => (
            <div key={nic.id} className="kv-row">
              <span className="kv-key">{nic.id}</span>
              <span className="kv-value">
                ↓ {formatCompactRate(nic.received)} / ↑ {formatCompactRate(nic.transmitted)}
              </span>
            </div>
          ))
        ) : (
          <div className="kv-row">
            <span className="kv-key">网卡</span>
            <span className="kv-value">暂无数据</span>
          </div>
        )}
      </div>
    </article>
  );
}


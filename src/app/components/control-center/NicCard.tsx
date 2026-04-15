import { formatCompactRate } from "../../utils";
import type { NicPreference } from "../../config/settings";

type NicCardProps = {
  nics: Array<{
    id: string;
    received: number;
    transmitted: number;
  }>;
  activeNicId: string | null;
  nicPreference: NicPreference;
  setNicPreference: (next: NicPreference) => void;
};

export function NicCard({ nics, activeNicId, nicPreference, setNicPreference }: NicCardProps) {
  const effectiveNicId = nicPreference.mode === "manual" ? nicPreference.nicId : activeNicId;
  const activeNic = effectiveNicId ? nics.find((nic) => nic.id === effectiveNicId) ?? null : null;
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
      <div className="settings-popover-options">
        <button
          type="button"
          className={`settings-option ${nicPreference.mode === "auto" ? "settings-option-active" : ""}`}
          onClick={() => setNicPreference({ mode: "auto", nicId: null })}
        >
          自动选择
        </button>
        {topNics.map((nic) => (
          <button
            key={`nic-pref-${nic.id}`}
            type="button"
            className={`settings-option ${nicPreference.mode === "manual" && nicPreference.nicId === nic.id ? "settings-option-active" : ""}`}
            onClick={() => setNicPreference({ mode: "manual", nicId: nic.id })}
          >
            {nic.id}
          </button>
        ))}
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


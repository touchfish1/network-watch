type ConnectionsCardProps = {
  connections:
    | {
        total: number;
        by_state: Array<{ state: string; count: number }>;
      }
    | null;
};

export function ConnectionsCard({ connections }: ConnectionsCardProps) {
  const topConnectionStates = connections ? [...connections.by_state].sort((a, b) => b.count - a.count).slice(0, 6) : [];

  return (
    <article className="settings-card connections-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">连接</span>
          <strong>总数与状态分布</strong>
        </div>
        <span className="theme-current">{connections ? `${connections.total} 条` : "仅 Windows 可用"}</span>
      </div>
      <div className="kv-table">
        {connections ? (
          topConnectionStates.length ? (
            topConnectionStates.map((entry) => (
              <div key={entry.state} className="kv-row">
                <span className="kv-key">{entry.state}</span>
                <span className="kv-value">{entry.count}</span>
              </div>
            ))
          ) : (
            <div className="kv-row">
              <span className="kv-key">状态</span>
              <span className="kv-value">暂无数据</span>
            </div>
          )
        ) : (
          <div className="kv-row">
            <span className="kv-key">提示</span>
            <span className="kv-value">暂无连接统计</span>
          </div>
        )}
      </div>
    </article>
  );
}


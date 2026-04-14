import type { CardId } from "../../config/uiLayout";

type LayoutCardProps = {
  cardOrder: CardId[];
  cardVisibility: Record<CardId, boolean>;
  onReset: () => void;
  onToggleCard: (id: CardId) => void;
  onMoveCard: (id: CardId, direction: -1 | 1) => void;
};

export function LayoutCard({ cardOrder, cardVisibility, onReset, onToggleCard, onMoveCard }: LayoutCardProps) {
  return (
    <article className="settings-card layout-card layout-card-embedded">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">布局设置</span>
          <strong>卡片与状态条</strong>
        </div>
        <button type="button" className="link-button" onClick={onReset}>
          恢复默认
        </button>
      </div>
      <div className="kv-table">
        {cardOrder.map((id) => (
          <div key={id} className="kv-row">
            <span className="kv-key">{id}</span>
            <span className="kv-value">
              <button type="button" className="link-button" onClick={() => onToggleCard(id)}>
                {cardVisibility[id] ? "显示" : "隐藏"}
              </button>{" "}
              <button type="button" className="link-button" onClick={() => onMoveCard(id, -1)}>
                上移
              </button>{" "}
              <button type="button" className="link-button" onClick={() => onMoveCard(id, 1)}>
                下移
              </button>
            </span>
          </div>
        ))}
      </div>
    </article>
  );
}


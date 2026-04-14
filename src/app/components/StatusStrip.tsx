import type React from "react";

import { formatCompactRate, formatMemoryUsage, formatPercent } from "../utils";
import type { SystemSnapshot } from "../types";

/**
 * 收起态状态条（悬浮窗最小形态）。
 *
 * 交互说明：
 * - 点击/拖拽/缩放等手势由上层 `useWindowLayout` 统一处理并通过 props 传入\n+ * - 该组件只负责展示当前快照的关键摘要（CPU/MEM/上下行）
 */
type StatusStripProps = {
  expanded: boolean;
  collapsedHeight: number;
  collapsedWidth: number;
  statusTextRef: React.RefObject<HTMLDivElement | null>;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onResizeHandlePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  snapshot: SystemSnapshot;
};

export function StatusStrip({
  expanded,
  collapsedHeight,
  collapsedWidth,
  statusTextRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onResizeHandlePointerDown,
  snapshot,
}: StatusStripProps) {
  return (
    <div
      className={`status-strip ${expanded ? "status-strip-expanded" : ""}`}
      style={expanded ? undefined : { minHeight: `${collapsedHeight}px`, width: `${collapsedWidth}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div ref={statusTextRef} className="status-text-block">
        <div className="status-line">
          <span>CPU {formatPercent(snapshot.cpu_usage)}</span>
          <span>MEM {formatMemoryUsage(snapshot.memory_used, snapshot.memory_total)}</span>
        </div>
        <div className="status-line status-line-secondary">
          <span>DOWN {formatCompactRate(snapshot.network_download)}</span>
          <span>UP {formatCompactRate(snapshot.network_upload)}</span>
        </div>
      </div>
      {!expanded ? (
        <div
          className="resize-handle resize-handle-collapsed"
          role="presentation"
          onPointerDown={onResizeHandlePointerDown}
        />
      ) : null}
    </div>
  );
}


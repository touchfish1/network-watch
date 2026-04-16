import { useMemo } from "react";
import type React from "react";

import { formatCompactRate, formatMemoryUsage, formatPercent } from "../utils";
import type { SystemSnapshot } from "../types";
import { loadStatusVisibility } from "../config/uiLayout";

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
  miniDockSide?: "left" | "right" | null;
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
  miniDockSide,
  statusTextRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onResizeHandlePointerDown,
  snapshot,
}: StatusStripProps) {
  const statusVisibility = useMemo(() => loadStatusVisibility(), []);
  const miniMode = !expanded && Boolean(miniDockSide);
  const memoryPercent = snapshot.memory_total > 0 ? (snapshot.memory_used / snapshot.memory_total) * 100 : 0;
  return (
    <div
      className={`status-strip ${expanded ? "status-strip-expanded" : ""} ${miniMode ? "status-strip-mini" : ""}`}
      style={expanded ? undefined : { minHeight: `${collapsedHeight}px`, width: `${collapsedWidth}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {miniMode ? (
        <div className="status-mini-bars" title={`CPU ${formatPercent(snapshot.cpu_usage)} / MEM ${formatPercent(memoryPercent)}`}>
          <div className="mini-bar">
            <div className="mini-bar-fill mini-bar-fill-cpu" style={{ height: `${Math.max(0, Math.min(100, snapshot.cpu_usage))}%` }} />
            <div className="mini-bar-label">CPU</div>
          </div>
          <div className="mini-bar">
            <div className="mini-bar-fill mini-bar-fill-mem" style={{ height: `${Math.max(0, Math.min(100, memoryPercent))}%` }} />
            <div className="mini-bar-label">MEM</div>
          </div>
        </div>
      ) : (
        <div ref={statusTextRef} className="status-text-block">
          <div className="status-line">
            {statusVisibility.cpu ? <span>CPU {formatPercent(snapshot.cpu_usage)}</span> : null}
            {statusVisibility.mem ? <span>MEM {formatMemoryUsage(snapshot.memory_used, snapshot.memory_total)}</span> : null}
            {statusVisibility.connections ? (
              <span>CONN {snapshot.connections ? snapshot.connections.total : "--"}</span>
            ) : null}
          </div>
          <div className="status-line status-line-secondary">
            {statusVisibility.down ? <span>DOWN {formatCompactRate(snapshot.network_download)}</span> : null}
            {statusVisibility.up ? <span>UP {formatCompactRate(snapshot.network_upload)}</span> : null}
            {statusVisibility.active_nic ? <span>NIC {snapshot.active_nic_id ?? "--"}</span> : null}
            {statusVisibility.disk ? (
              <span>
                DISK{" "}
                {snapshot.system_disk
                  ? formatPercent((1 - snapshot.system_disk.available_bytes / snapshot.system_disk.total_bytes) * 100)
                  : "--"}
              </span>
            ) : null}
          </div>
        </div>
      )}
      {!expanded && !miniMode ? (
        <div
          className="resize-handle resize-handle-collapsed"
          role="presentation"
          onPointerDown={onResizeHandlePointerDown}
        />
      ) : null}
    </div>
  );
}


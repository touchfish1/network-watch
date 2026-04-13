import { startTransition, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  LogicalSize,
  PhysicalPosition,
  type Monitor,
  getCurrentWindow,
  monitorFromPoint,
} from "@tauri-apps/api/window";
import "./App.css";

type SystemSnapshot = {
  timestamp: number;
  cpu_usage: number;
  memory_used: number;
  memory_total: number;
  network_download: number;
  network_upload: number;
};

type MetricHistory = {
  cpu: number[];
  memory: number[];
  download: number[];
  upload: number[];
};

type LayoutDebugInfo = {
  phase: string;
  beforePosition: string;
  beforeSize: string;
  targetPosition: string;
  targetSize: string;
  workArea: string;
  monitor: string;
  direction: string;
};

type ExpansionDirection = "down" | "up";

const FALLBACK_COLLAPSED_HEIGHT = 40;
const FALLBACK_COLLAPSED_WIDTH = 240;
const EXPANDED_HEIGHT = 330;
const EXPANDED_WIDTH = 320;
const HISTORY_LIMIT = 300;
const SNAP_THRESHOLD = 28;
const MIN_COLLAPSED_HEIGHT = 28;
const MAX_COLLAPSED_HEIGHT = 64;
const MIN_COLLAPSED_WIDTH = 160;
const MAX_COLLAPSED_WIDTH = 420;
const POSITION_SETTLE_DELAY = 140;
const CLICK_DRAG_THRESHOLD = 6;

type TaskbarEdge = "top" | "right" | "bottom" | "left";

const emptySnapshot: SystemSnapshot = {
  timestamp: Date.now(),
  cpu_usage: 0,
  memory_used: 0,
  memory_total: 0,
  network_download: 0,
  network_upload: 0,
};

const emptyHistory: MetricHistory = {
  cpu: [],
  memory: [],
  download: [],
  upload: [],
};

const emptyDebugInfo: LayoutDebugInfo = {
  phase: "idle",
  beforePosition: "-",
  beforeSize: "-",
  targetPosition: "-",
  targetSize: "-",
  workArea: "-",
  monitor: "-",
  direction: "-",
};

function pushSample(series: number[], value: number) {
  const next = [...series, value];
  return next.slice(-HISTORY_LIMIT);
}

function formatBytes(value: number) {
  if (value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** exponent;
  return `${size.toFixed(size >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatRate(value: number) {
  return `${formatBytes(value)}/s`;
}

function formatCompactRate(value: number) {
  if (value <= 0) {
    return "0B/s";
  }

  const units = ["B/s", "K/s", "M/s", "G/s", "T/s"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** exponent;
  const decimals = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(decimals)}${units[exponent]}`;
}

function formatPercent(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatMemoryUsage(used: number, total: number) {
  if (total <= 0) {
    return "0%";
  }

  return formatPercent((used / total) * 100);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getTaskbarThickness(monitor: Awaited<ReturnType<typeof monitorFromPoint>>) {
  if (!monitor) {
    return FALLBACK_COLLAPSED_HEIGHT;
  }

  const horizontalInset = monitor.size.height - monitor.workArea.size.height;
  const verticalInset = monitor.size.width - monitor.workArea.size.width;
  const thickness = Math.max(horizontalInset, verticalInset, 0);

  return clamp(thickness, MIN_COLLAPSED_HEIGHT, MAX_COLLAPSED_HEIGHT);
}

function getTaskbarEdge(monitor: Monitor | null): TaskbarEdge {
  if (!monitor) {
    return "bottom";
  }

  const topInset = monitor.workArea.position.y - monitor.position.y;
  const leftInset = monitor.workArea.position.x - monitor.position.x;
  const bottomInset =
    monitor.position.y + monitor.size.height - (monitor.workArea.position.y + monitor.workArea.size.height);
  const rightInset =
    monitor.position.x + monitor.size.width - (monitor.workArea.position.x + monitor.workArea.size.width);

  const edges = [
    { edge: "top" as const, inset: topInset },
    { edge: "right" as const, inset: rightInset },
    { edge: "bottom" as const, inset: bottomInset },
    { edge: "left" as const, inset: leftInset },
  ];

  return edges.reduce((best, current) => (current.inset > best.inset ? current : best)).edge;
}

function getDockedPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  monitor: Monitor | null,
) {
  if (!monitor) {
    return null;
  }

  const minX = monitor.position.x;
  const maxX = monitor.position.x + monitor.size.width - size.width;
  const minY = monitor.position.y;
  const maxY = monitor.position.y + monitor.size.height - size.height;

  const taskbarEdge = getTaskbarEdge(monitor);
  const clampedX = clamp(position.x, minX, Math.max(minX, maxX));
  const clampedY = clamp(position.y, minY, Math.max(minY, maxY));

  if (taskbarEdge === "bottom") {
    const targetY = maxY;
    if (Math.abs(position.y - targetY) > SNAP_THRESHOLD && clampedY === position.y) {
      return null;
    }

    return { x: clampedX, y: targetY };
  }

  if (taskbarEdge === "top") {
    const targetY = minY;
    if (Math.abs(position.y - targetY) > SNAP_THRESHOLD && clampedY === position.y) {
      return null;
    }

    return { x: clampedX, y: targetY };
  }

  if (taskbarEdge === "left") {
    const targetX = minX;
    if (Math.abs(position.x - targetX) > SNAP_THRESHOLD && clampedX === position.x) {
      return null;
    }

    return { x: targetX, y: clampedY };
  }

  const targetX = maxX;
  if (Math.abs(position.x - targetX) > SNAP_THRESHOLD && clampedX === position.x) {
    return null;
  }

  return { x: targetX, y: clampedY };
}

function getAnchoredExpandedPosition(
  position: { x: number; y: number },
  currentSize: { width: number; height: number },
  nextSize: { width: number; height: number },
  monitor: Monitor | null,
) {
  if (!monitor) {
    return { position, direction: "unknown" };
  }

  const minX = monitor.position.x;
  const maxX = monitor.position.x + monitor.size.width - nextSize.width;
  const minY = monitor.position.y;
  const maxY = monitor.position.y + monitor.size.height - nextSize.height;
  const bottomEdge = position.y + currentSize.height;
  const downwardY = position.y;
  const upwardY = bottomEdge - nextSize.height;
  const canExpandDown = position.y + nextSize.height <= monitor.position.y + monitor.size.height;
  const nextY = canExpandDown ? downwardY : upwardY;

  return {
    position: {
      x: clamp(position.x, minX, Math.max(minX, maxX)),
      y: clamp(nextY, minY, Math.max(minY, maxY)),
    },
    direction: canExpandDown ? "down" : "up",
  };
}

function buildPath(values: number[]) {
  if (values.length === 0) {
    return "";
  }

  const max = Math.max(...values, 1);
  const step = values.length > 1 ? 100 / (values.length - 1) : 100;

  return values
    .map((value, index) => {
      const x = index * step;
      const y = 100 - (value / max) * 100;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

type SparklineProps = {
  values: number[];
  tone: "cpu" | "memory" | "download" | "upload";
};

function Sparkline({ values, tone }: SparklineProps) {
  const path = useMemo(() => buildPath(values), [values]);

  return (
    <svg className={`sparkline sparkline-${tone}`} viewBox="0 0 100 100" preserveAspectRatio="none">
      <path d={path || "M 0 100 L 100 100"} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function App() {
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const [expanded, setExpanded] = useState(false);
  const [expansionDirection, setExpansionDirection] = useState<ExpansionDirection>("down");
  const [collapsedHeight, setCollapsedHeight] = useState(FALLBACK_COLLAPSED_HEIGHT);
  const [collapsedWidth, setCollapsedWidth] = useState(FALLBACK_COLLAPSED_WIDTH);
  const [snapshot, setSnapshot] = useState<SystemSnapshot>(emptySnapshot);
  const [history, setHistory] = useState<MetricHistory>(emptyHistory);
  const [lastUpdated, setLastUpdated] = useState("Waiting for system data...");
  const [layoutDebugInfo, setLayoutDebugInfo] = useState<LayoutDebugInfo>(emptyDebugInfo);
  const snapTimerRef = useRef<number | null>(null);
  const isProgrammaticLayoutRef = useRef(false);
  const statusTextRef = useRef<HTMLDivElement | null>(null);
  const collapsedPointerRef = useRef<{ x: number; y: number } | null>(null);
  const collapsedDraggingRef = useRef(false);

  const syncCollapsedHeight = useEffectEvent(async () => {
    const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
    const centerX = position.x + size.width / 2;
    const centerY = position.y + size.height / 2;
    const monitor = await monitorFromPoint(centerX, centerY);
    const nextCollapsedHeight = getTaskbarThickness(monitor);

    setCollapsedHeight((current) => (current === nextCollapsedHeight ? current : nextCollapsedHeight));

    if (!expanded) {
      isProgrammaticLayoutRef.current = true;
      try {
        await appWindow.setSize(new LogicalSize(collapsedWidth, nextCollapsedHeight));
      } finally {
        window.setTimeout(() => {
          isProgrammaticLayoutRef.current = false;
        }, POSITION_SETTLE_DELAY);
      }
    }
  });

  const applyWindowLayoutSafely = useCallback(
    async (nextLayout: { width: number; height: number; x: number; y: number }) => {
      isProgrammaticLayoutRef.current = true;
      try {
        await appWindow.setSize(new LogicalSize(nextLayout.width, nextLayout.height));
        await appWindow.setPosition(new PhysicalPosition(nextLayout.x, nextLayout.y));
      } finally {
        window.setTimeout(() => {
          isProgrammaticLayoutRef.current = false;
        }, POSITION_SETTLE_DELAY);
      }
    },
    [appWindow],
  );

  const snapToWorkAreaEdge = useCallback(async () => {
    const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
    const centerX = position.x + size.width / 2;
    const centerY = position.y + size.height / 2;
    const monitor = await monitorFromPoint(centerX, centerY);
    const snappedPosition = getDockedPosition(position, size, monitor);

    if (!snappedPosition) {
      return;
    }

    if (snappedPosition.x === position.x && snappedPosition.y === position.y) {
      return;
    }

    await applyWindowLayoutSafely({
      width: size.width,
      height: size.height,
      x: snappedPosition.x,
      y: snappedPosition.y,
    });
  }, [appWindow, applyWindowLayoutSafely]);

  const handleSnapshot = useEffectEvent((payload: SystemSnapshot) => {
    startTransition(() => {
      setSnapshot(payload);
      setHistory((current) => ({
        cpu: pushSample(current.cpu, payload.cpu_usage),
        memory: pushSample(
          current.memory,
          payload.memory_total > 0 ? (payload.memory_used / payload.memory_total) * 100 : 0,
        ),
        download: pushSample(current.download, payload.network_download),
        upload: pushSample(current.upload, payload.network_upload),
      }));
      setLastUpdated(new Date(payload.timestamp).toLocaleTimeString());
    });
  });

  useEffect(() => {
    void syncCollapsedHeight();

    let unlistenSnapshot: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;

    void listen<SystemSnapshot>("system-snapshot", ({ payload }) => {
      handleSnapshot(payload);
    }).then((dispose) => {
      unlistenSnapshot = dispose;
    });

    void appWindow.onMoved(() => {
      if (isProgrammaticLayoutRef.current) {
        return;
      }

      if (snapTimerRef.current) {
        window.clearTimeout(snapTimerRef.current);
      }

      snapTimerRef.current = window.setTimeout(() => {
        void syncCollapsedHeight();
        void snapToWorkAreaEdge();
      }, POSITION_SETTLE_DELAY);
    }).then((dispose) => {
      unlistenMoved = dispose;
    });

    return () => {
      if (snapTimerRef.current) {
        window.clearTimeout(snapTimerRef.current);
      }

      unlistenSnapshot?.();
      unlistenMoved?.();
    };
  }, [appWindow, snapToWorkAreaEdge]);

  useEffect(() => {
    const textWidth = statusTextRef.current?.scrollWidth ?? FALLBACK_COLLAPSED_WIDTH - 16;
    const nextCollapsedWidth = clamp(textWidth + 16, MIN_COLLAPSED_WIDTH, MAX_COLLAPSED_WIDTH);

    if (nextCollapsedWidth === collapsedWidth) {
      return;
    }

    setCollapsedWidth(nextCollapsedWidth);

    if (!expanded) {
      isProgrammaticLayoutRef.current = true;
      void appWindow.setSize(new LogicalSize(nextCollapsedWidth, collapsedHeight)).finally(() => {
        window.setTimeout(() => {
          isProgrammaticLayoutRef.current = false;
        }, POSITION_SETTLE_DELAY);
      });
    }
  }, [appWindow, collapsedHeight, collapsedWidth, expanded, snapshot]);

  const toggleExpanded = async () => {
    const nextExpanded = !expanded;
    const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
    const centerX = position.x + size.width / 2;
    const centerY = position.y + size.height / 2;
    const monitor = await monitorFromPoint(centerX, centerY);

    const nextWidth = nextExpanded ? EXPANDED_WIDTH : collapsedWidth;
    const nextHeight = nextExpanded ? EXPANDED_HEIGHT : collapsedHeight;
    const currentBottom = position.y + size.height;

    const expansionPlan = nextExpanded
      ? getAnchoredExpandedPosition(
          position,
          { width: size.width, height: size.height },
          { width: nextWidth, height: nextHeight },
          monitor,
        )
      : {
          position: {
            x: position.x,
            y: expansionDirection === "up" ? currentBottom - nextHeight : position.y,
          },
          direction: expansionDirection,
        };

    setExpanded(nextExpanded);
    if (nextExpanded) {
      setExpansionDirection(expansionPlan.direction as ExpansionDirection);
    }

    setLayoutDebugInfo({
      phase: nextExpanded ? "expand" : "collapse",
      beforePosition: `${position.x}, ${position.y}`,
      beforeSize: `${size.width} x ${size.height}`,
      targetPosition: `${expansionPlan.position.x}, ${expansionPlan.position.y}`,
      targetSize: `${nextWidth} x ${nextHeight}`,
      workArea: monitor
        ? `${monitor.workArea.position.x}, ${monitor.workArea.position.y} / ${monitor.workArea.size.width} x ${monitor.workArea.size.height}`
        : "none",
      monitor: monitor
        ? `${monitor.position.x}, ${monitor.position.y} / ${monitor.size.width} x ${monitor.size.height}`
        : "none",
      direction: expansionPlan.direction,
    });

    await applyWindowLayoutSafely({
      width: nextWidth,
      height: nextHeight,
      x: expansionPlan.position.x,
      y: expansionPlan.position.y,
    });

    if (!nextExpanded) {
      await snapToWorkAreaEdge();
    }
  };

  const handleDragStart = async (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target;
    if (target instanceof HTMLElement && target.closest("button")) {
      return;
    }

    event.preventDefault();
    await appWindow.startDragging();
  };

  const handleCollapsedPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (expanded || event.button !== 0) {
      return;
    }

    collapsedPointerRef.current = { x: event.clientX, y: event.clientY };
    collapsedDraggingRef.current = false;
  };

  const handleCollapsedPointerMove = async (event: React.PointerEvent<HTMLElement>) => {
    if (expanded || collapsedDraggingRef.current || !collapsedPointerRef.current) {
      return;
    }

    const deltaX = Math.abs(event.clientX - collapsedPointerRef.current.x);
    const deltaY = Math.abs(event.clientY - collapsedPointerRef.current.y);
    if (Math.max(deltaX, deltaY) < CLICK_DRAG_THRESHOLD) {
      return;
    }

    collapsedDraggingRef.current = true;
    event.preventDefault();
    await appWindow.startDragging();
  };

  const handleCollapsedPointerUp = async () => {
    if (expanded) {
      return;
    }

    const wasDragging = collapsedDraggingRef.current;
    collapsedPointerRef.current = null;
    collapsedDraggingRef.current = false;

    if (!wasDragging) {
      await toggleExpanded();
    }
  };

  const resetCollapsedPointer = () => {
    collapsedPointerRef.current = null;
    collapsedDraggingRef.current = false;
  };

  return (
    <main className={`shell ${expanded ? "shell-expanded" : ""}`}>
      <section
        className={`widget ${expanded && expansionDirection === "up" ? "widget-expand-up" : "widget-expand-down"}`}
      >
        <div
          className={`status-strip ${expanded ? "status-strip-expanded" : ""}`}
          style={
            expanded
              ? undefined
              : { minHeight: `${collapsedHeight}px`, width: `${collapsedWidth}px` }
          }
          onPointerDown={(event) => handleCollapsedPointerDown(event)}
          onPointerMove={(event) => void handleCollapsedPointerMove(event)}
          onPointerUp={() => void handleCollapsedPointerUp()}
          onPointerCancel={resetCollapsedPointer}
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
        </div>

        <div className={`expanded-panel ${expanded ? "expanded-panel-visible" : ""}`}>
          <header className="widget-header" onPointerDown={(event) => void handleDragStart(event)}>
            <div className="title-block">
              <span className="eyebrow">Network Watch</span>
              <h1>详细监控面板</h1>
            </div>
            <div className="header-meta">
              <span>{lastUpdated}</span>
              <button type="button" className="expand-button" onClick={() => void toggleExpanded()}>
                收起
              </button>
            </div>
          </header>

          <div className="layout-debug">
            <span>phase {layoutDebugInfo.phase}</span>
            <span>before pos {layoutDebugInfo.beforePosition}</span>
            <span>before size {layoutDebugInfo.beforeSize}</span>
            <span>target pos {layoutDebugInfo.targetPosition}</span>
            <span>target size {layoutDebugInfo.targetSize}</span>
            <span>direction {layoutDebugInfo.direction}</span>
            <span>workArea {layoutDebugInfo.workArea}</span>
            <span>monitor {layoutDebugInfo.monitor}</span>
          </div>

          <div className="stats-grid">
            <article className="stat-card">
              <span className="stat-label">CPU</span>
              <strong>{formatPercent(snapshot.cpu_usage)}</strong>
              <span className="stat-subtitle">整机占用</span>
            </article>
            <article className="stat-card">
              <span className="stat-label">Memory</span>
              <strong>{formatMemoryUsage(snapshot.memory_used, snapshot.memory_total)}</strong>
              <span className="stat-subtitle">
                {formatBytes(snapshot.memory_used)} / {formatBytes(snapshot.memory_total)}
              </span>
            </article>
            <article className="stat-card">
              <span className="stat-label">Download</span>
              <strong>{formatRate(snapshot.network_download)}</strong>
              <span className="stat-subtitle">实时下行</span>
            </article>
            <article className="stat-card">
              <span className="stat-label">Upload</span>
              <strong>{formatRate(snapshot.network_upload)}</strong>
              <span className="stat-subtitle">实时上行</span>
            </article>
          </div>

          <div className={`details ${expanded ? "details-visible" : ""}`}>
            <div className="detail-card">
              <div className="detail-header">
                <span>CPU 趋势</span>
                <strong>{formatPercent(snapshot.cpu_usage)}</strong>
              </div>
              <Sparkline values={history.cpu} tone="cpu" />
            </div>
            <div className="detail-card">
              <div className="detail-header">
                <span>内存趋势</span>
                <strong>{formatMemoryUsage(snapshot.memory_used, snapshot.memory_total)}</strong>
              </div>
              <Sparkline values={history.memory} tone="memory" />
            </div>
            <div className="detail-card detail-card-wide">
              <div className="detail-header">
                <span>网络趋势</span>
                <strong>
                  ↓ {formatRate(snapshot.network_download)} / ↑ {formatRate(snapshot.network_upload)}
                </strong>
              </div>
              <div className="network-lines">
                <Sparkline values={history.download} tone="download" />
                <Sparkline values={history.upload} tone="upload" />
              </div>
            </div>
          </div>

          <footer className="widget-footer">
            <span>{lastUpdated}</span>
            <span>拖近屏幕工作区边缘会自动贴边</span>
          </footer>
        </div>
      </section>
    </main>
  );
}

export default App;

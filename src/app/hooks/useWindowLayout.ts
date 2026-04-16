import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { LogicalSize, availableMonitors, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import {
  FALLBACK_COLLAPSED_HEIGHT,
  POSITION_SETTLE_DELAY,
} from "../constants";
import type { ExpansionDirection, MetricHistory, SystemSnapshot } from "../types";
import { getAnchoredExpandedPosition, getDockedPosition, getTaskbarThickness } from "../utils";
import { setOverlayInteractive } from "../tauri";
import { loadCollapsedWidth, loadExpandedSize, saveCollapsedWidth, saveExpandedSize } from "./window-layout/storage";
import { useCollapsedClickDrag } from "./window-layout/useCollapsedClickDrag";
import { applyWindowLayoutSafely } from "./window-layout/applyWindowLayoutSafely";
import { useResizeHandlers } from "./window-layout/useResizeHandlers";

/**
 * 管理悬浮窗窗口布局与交互（收起/展开、拖拽、缩放、贴边、尺寸持久化、事件订阅）。
 *
 * 关键点：
 * - **采样事件订阅**：监听后端广播的 `system-snapshot`，更新 `snapshot` 并将原始采样交给 `onSnapshot`\n+ * - **尺寸持久化**：收起宽度与展开尺寸写入 localStorage\n+ * - **拖拽/点击区分**：收起态通过阈值区分“拖动窗口”与“点击切换展开”\n+ * - **贴边策略**：窗口移动/失焦后会尝试吸附到工作区边缘（避免飘在中间遮挡）\n+ * - **overlay 交互性**：展开时开启、收起/失焦时关闭（后端也有兜底）
 */
type UseWindowLayoutArgs = {
  isTauriEnv: boolean;
  emptySnapshot: SystemSnapshot;
  emptyHistory: MetricHistory;
  onSnapshot: (payload: SystemSnapshot) => void;
};

export function useWindowLayout({ isTauriEnv, emptySnapshot, emptyHistory, onSnapshot }: UseWindowLayoutArgs) {
  /**
   * 仅在 Tauri 环境获取窗口对象；浏览器环境必须为 null（否则会触发运行时错误）。
   */
  const appWindow = useMemo(() => (isTauriEnv ? getCurrentWindow() : null), [isTauriEnv]);
  const [expanded, setExpanded] = useState(false);
  const [expansionDirection, setExpansionDirection] = useState<ExpansionDirection>("down");
  const [collapsedHeight, setCollapsedHeight] = useState(FALLBACK_COLLAPSED_HEIGHT);
  const [collapsedWidth, setCollapsedWidth] = useState(() => loadCollapsedWidth());
  const [expandedSize, setExpandedSize] = useState(() => loadExpandedSize());
  const [miniDockSide, setMiniDockSide] = useState<"left" | "right" | null>(null);

  const [snapshot, setSnapshot] = useState<SystemSnapshot>(emptySnapshot);
  const [history, setHistory] = useState<MetricHistory>(emptyHistory);

  const snapTimerRef = useRef<number | null>(null);
  const isProgrammaticLayoutRef = useRef(false);
  const statusTextRef = useRef<HTMLDivElement | null>(null);
  // 收起态“点击切换 / 拖拽移动”交互由子 hook 管理

  const isWindowsEnv = useMemo(() => /windows/i.test(navigator.userAgent), []);
  const MINI_COLLAPSED_WIDTH = 96;
  const MINI_EDGE_THRESHOLD = 18;

  const effectiveCollapsedWidth = isWindowsEnv && miniDockSide ? MINI_COLLAPSED_WIDTH : collapsedWidth;

  const safeGetWindowCenterMonitor = useEffectEvent(async () => {
    if (!appWindow) {
      return null;
    }
    try {
      const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
      const centerX = position.x + size.width / 2;
      const centerY = position.y + size.height / 2;
      const fromPoint = await monitorFromPoint(centerX, centerY);
      if (fromPoint) {
        return fromPoint;
      }
      // Windows 在任务栏/边界附近可能拿不到 monitorFromPoint：退化为“最接近 window center 的显示器”。
      const monitors = await availableMonitors();
      if (!monitors || monitors.length === 0) {
        return null;
      }
      let best = monitors[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const m of monitors) {
        const mx = m.position.x + m.size.width / 2;
        const my = m.position.y + m.size.height / 2;
        const dx = mx - centerX;
        const dy = my - centerY;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = m;
        }
      }
      return best;
    } catch {
      return null;
    }
  });

  const updateWindowsMiniDock = useEffectEvent(async () => {
    if (!appWindow) {
      return;
    }
    if (!isWindowsEnv) {
      return;
    }
    if (expanded) {
      if (miniDockSide) {
        setMiniDockSide(null);
      }
      return;
    }
    try {
      const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
      const monitor = await safeGetWindowCenterMonitor();
      if (!monitor) {
        if (miniDockSide) {
          setMiniDockSide(null);
        }
        return;
      }

      const leftDist = position.x - monitor.position.x;
      const rightDist = monitor.position.x + monitor.size.width - (position.x + size.width);

      const nextSide =
        leftDist <= MINI_EDGE_THRESHOLD ? "left" : rightDist <= MINI_EDGE_THRESHOLD ? "right" : null;

      if (nextSide === miniDockSide) {
        return;
      }

      setMiniDockSide(nextSide);

      // 进入/退出微型模式时同步窗口宽度，并在进入时贴边，避免出现“只有一部分在屏幕内”的状态。
      const nextWidth = nextSide ? MINI_COLLAPSED_WIDTH : collapsedWidth;
      const nextX =
        nextSide === "left"
          ? monitor.position.x
          : nextSide === "right"
            ? monitor.position.x + monitor.size.width - nextWidth
            : position.x;

      isProgrammaticLayoutRef.current = true;
      try {
        await applyWindowLayoutSafely(
          appWindow,
          { width: nextWidth, height: collapsedHeight, x: nextX, y: position.y },
          isProgrammaticLayoutRef,
        );
      } finally {
        window.setTimeout(() => {
          isProgrammaticLayoutRef.current = false;
        }, POSITION_SETTLE_DELAY);
      }
    } catch {
      // ignore
    }
  });

  /**
   * 根据当前显示器的 taskbar/dock 厚度同步收起态高度，并在收起态时立即应用窗口尺寸。
   */
  const syncCollapsedHeight = useEffectEvent(async () => {
    if (!appWindow) {
      return;
    }
    // Windows：不再把收起态强行对齐任务栏高度（避免“不能拖到状态栏上”的隐式限制）。
    if (isWindowsEnv) {
      setCollapsedHeight((current) => (current === FALLBACK_COLLAPSED_HEIGHT ? current : FALLBACK_COLLAPSED_HEIGHT));
      if (!expanded) {
        isProgrammaticLayoutRef.current = true;
        try {
          await appWindow.setSize(new LogicalSize(effectiveCollapsedWidth, FALLBACK_COLLAPSED_HEIGHT));
        } finally {
          window.setTimeout(() => {
            isProgrammaticLayoutRef.current = false;
          }, POSITION_SETTLE_DELAY);
        }
      }
      return;
    }
    const monitor = await safeGetWindowCenterMonitor();
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

  const applyLayoutSafely = useCallback(
    async (nextLayout: { width: number; height: number; x: number; y: number }) => {
      if (!appWindow) return;
      await applyWindowLayoutSafely(appWindow, nextLayout, isProgrammaticLayoutRef);
    },
    [appWindow],
  );

  const snapToWorkAreaEdge = useCallback(async () => {
    if (!appWindow) {
      return;
    }
    // Windows：取消自动吸附（由用户自由摆放）。
    if (isWindowsEnv) {
      return;
    }
    const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
    const monitor = await safeGetWindowCenterMonitor();
    const snappedPosition = getDockedPosition(position, size, monitor);

    if (!snappedPosition) {
      return;
    }

    if (snappedPosition.x === position.x && snappedPosition.y === position.y) {
      return;
    }

    await applyLayoutSafely({
      width: size.width,
      height: size.height,
      x: snappedPosition.x,
      y: snappedPosition.y,
    });
  }, [appWindow, applyLayoutSafely, isWindowsEnv, safeGetWindowCenterMonitor]);

  /**
   * 接收来自后端的系统快照，并同步到 state，同时把 payload 透传给调用方以更新历史曲线。
   */
  const handleSnapshot = useEffectEvent((payload: SystemSnapshot) => {
    setSnapshot(payload);
    onSnapshot(payload);
  });

  useEffect(() => {
    if (!appWindow) {
      return;
    }

    void setOverlayInteractive(false).catch(() => {
      // ignore
    });

    void syncCollapsedHeight();
    void updateWindowsMiniDock();

    let unlistenSnapshot: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    const handleWindowBlur = () => {
      void setOverlayInteractive(false).catch(() => {
        // ignore
      });
      void syncCollapsedHeight().catch(() => {
        // ignore
      });
      void snapToWorkAreaEdge().catch(() => {
        // ignore
      });
    };
    window.addEventListener("blur", handleWindowBlur);

    void listen<SystemSnapshot>("system-snapshot", ({ payload }) => {
      handleSnapshot(payload);
    }).then((dispose) => {
      unlistenSnapshot = dispose;
    });

    void appWindow
      .onMoved(() => {
        if (isProgrammaticLayoutRef.current) {
          return;
        }

        if (snapTimerRef.current) {
          window.clearTimeout(snapTimerRef.current);
        }

        snapTimerRef.current = window.setTimeout(() => {
          void syncCollapsedHeight().catch(() => {
            // ignore
          });
          void snapToWorkAreaEdge().catch(() => {
            // ignore
          });
          void updateWindowsMiniDock().catch(() => {
            // ignore
          });
        }, POSITION_SETTLE_DELAY);
      })
      .then((dispose) => {
        unlistenMoved = dispose;
      });

    return () => {
      if (snapTimerRef.current) {
        window.clearTimeout(snapTimerRef.current);
      }

      window.removeEventListener("blur", handleWindowBlur);
      unlistenSnapshot?.();
      unlistenMoved?.();
    };
  }, [appWindow, handleSnapshot, snapToWorkAreaEdge, syncCollapsedHeight, updateWindowsMiniDock]);

  useEffect(() => {
    saveCollapsedWidth(collapsedWidth);
  }, [collapsedWidth]);

  useEffect(() => {
    saveExpandedSize(expandedSize);
  }, [expandedSize]);

  useEffect(() => {
    if (!appWindow) {
      return;
    }

    if (!expanded) {
      isProgrammaticLayoutRef.current = true;
      void appWindow.setSize(new LogicalSize(effectiveCollapsedWidth, collapsedHeight)).finally(() => {
        window.setTimeout(() => {
          isProgrammaticLayoutRef.current = false;
        }, POSITION_SETTLE_DELAY);
      });
    }
  }, [appWindow, collapsedHeight, effectiveCollapsedWidth, expanded, snapshot]);

  const toggleExpanded = async () => {
    if (!appWindow) {
      setExpanded((current) => !current);
      return;
    }

    try {
      const nextExpanded = !expanded;
      const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
      const monitor = await safeGetWindowCenterMonitor();

      const nextWidth = nextExpanded ? expandedSize.width : collapsedWidth;
      const nextHeight = nextExpanded ? expandedSize.height : collapsedHeight;
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

      if (nextExpanded) {
        await setOverlayInteractive(true);
      }

      setExpanded(nextExpanded);
      if (nextExpanded) {
        setExpansionDirection(expansionPlan.direction as ExpansionDirection);
      }

      await applyLayoutSafely({
        width: nextWidth,
        height: nextHeight,
        x: expansionPlan.position.x,
        y: expansionPlan.position.y,
      });

      if (!nextExpanded) {
        await setOverlayInteractive(false);
        await snapToWorkAreaEdge();
        await updateWindowsMiniDock();
      }
    } catch {
      // 任何窗口 API 异常都不应导致悬浮窗白屏；直接忽略这次布局切换。
    }
  };

  const { handleCollapsedResizeStart, handleExpandedResizeStart } = useResizeHandlers({
    appWindow,
    expanded,
    collapsedWidth,
    setCollapsedWidth,
    expandedSize,
    setExpandedSize,
    isProgrammaticLayoutRef,
  });

  const handleDragStart = async (event: React.PointerEvent<HTMLElement>) => {
    if (!appWindow) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest(
        [
          "button",
          "a",
          "input",
          "select",
          "textarea",
          "[data-tauri-drag-region='false']",
          ".settings-popover",
          ".settings-menu",
        ].join(","),
      )
    ) {
      return;
    }

    event.preventDefault();
    await appWindow.startDragging();
  };

  const { handleCollapsedPointerDown, handleCollapsedPointerMove, handleCollapsedPointerUp, resetCollapsedPointer } =
    useCollapsedClickDrag({
      appWindow,
      expanded,
      onToggleExpanded: toggleExpanded,
    });

  return {
    appWindow,
    expanded,
    expansionDirection,
    collapsedHeight,
    collapsedWidth,
    effectiveCollapsedWidth,
    miniDockSide,
    expandedSize,
    snapshot,
    history,
    statusTextRef,
    setCollapsedWidth,
    setExpandedSize,
    setHistory,
    setSnapshot,
    setExpanded,
    setExpansionDirection,
    handleDragStart,
    handleCollapsedPointerDown,
    handleCollapsedPointerMove,
    handleCollapsedPointerUp,
    resetCollapsedPointer,
    handleCollapsedResizeStart,
    handleExpandedResizeStart,
    toggleExpanded,
  };
}


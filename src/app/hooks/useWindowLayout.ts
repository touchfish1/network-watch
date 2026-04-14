import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { LogicalSize, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
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

  const [snapshot, setSnapshot] = useState<SystemSnapshot>(emptySnapshot);
  const [history, setHistory] = useState<MetricHistory>(emptyHistory);

  const snapTimerRef = useRef<number | null>(null);
  const isProgrammaticLayoutRef = useRef(false);
  const statusTextRef = useRef<HTMLDivElement | null>(null);
  // 收起态“点击切换 / 拖拽移动”交互由子 hook 管理

  /**
   * 根据当前显示器的 taskbar/dock 厚度同步收起态高度，并在收起态时立即应用窗口尺寸。
   */
  const syncCollapsedHeight = useEffectEvent(async () => {
    if (!appWindow) {
      return;
    }
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

    await applyLayoutSafely({
      width: size.width,
      height: size.height,
      x: snappedPosition.x,
      y: snappedPosition.y,
    });
  }, [appWindow, applyLayoutSafely]);

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

    let unlistenSnapshot: (() => void) | undefined;
    let unlistenMoved: (() => void) | undefined;
    const handleWindowBlur = () => {
      void setOverlayInteractive(false).catch(() => {
        // ignore
      });
      void syncCollapsedHeight();
      void snapToWorkAreaEdge();
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
          void syncCollapsedHeight();
          void snapToWorkAreaEdge();
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
  }, [appWindow, handleSnapshot, snapToWorkAreaEdge, syncCollapsedHeight]);

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
      void appWindow.setSize(new LogicalSize(collapsedWidth, collapsedHeight)).finally(() => {
        window.setTimeout(() => {
          isProgrammaticLayoutRef.current = false;
        }, POSITION_SETTLE_DELAY);
      });
    }
  }, [appWindow, collapsedHeight, collapsedWidth, expanded, snapshot]);

  const toggleExpanded = async () => {
    if (!appWindow) {
      setExpanded((current) => !current);
      return;
    }

    const nextExpanded = !expanded;
    const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
    const centerX = position.x + size.width / 2;
    const centerY = position.y + size.height / 2;
    const monitor = await monitorFromPoint(centerX, centerY);

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
    if (target instanceof HTMLElement && target.closest("button")) {
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


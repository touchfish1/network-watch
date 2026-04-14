import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { LogicalSize, PhysicalPosition, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

import {
  CLICK_DRAG_THRESHOLD,
  COLLAPSED_WIDTH_STORAGE_KEY,
  EXPANDED_EDGE_GAP,
  EXPANDED_SIZE_STORAGE_KEY,
  FALLBACK_COLLAPSED_HEIGHT,
  FALLBACK_COLLAPSED_WIDTH,
  MAX_COLLAPSED_WIDTH,
  MIN_COLLAPSED_WIDTH,
  MIN_EXPANDED_HEIGHT,
  MIN_EXPANDED_WIDTH,
  POSITION_SETTLE_DELAY,
} from "../constants";
import type { ExpansionDirection, MetricHistory, SystemSnapshot } from "../types";
import { clamp, getAnchoredExpandedPosition, getDefaultExpandedSize, getDockedPosition, getTaskbarThickness } from "../utils";
import { setOverlayInteractive } from "../tauri";

type UseWindowLayoutArgs = {
  isTauriEnv: boolean;
  emptySnapshot: SystemSnapshot;
  emptyHistory: MetricHistory;
  onSnapshot: (payload: SystemSnapshot) => void;
};

export function useWindowLayout({ isTauriEnv, emptySnapshot, emptyHistory, onSnapshot }: UseWindowLayoutArgs) {
  const appWindow = useMemo(() => (isTauriEnv ? getCurrentWindow() : null), [isTauriEnv]);
  const [expanded, setExpanded] = useState(false);
  const [expansionDirection, setExpansionDirection] = useState<ExpansionDirection>("down");
  const [collapsedHeight, setCollapsedHeight] = useState(FALLBACK_COLLAPSED_HEIGHT);
  const [collapsedWidth, setCollapsedWidth] = useState(() => {
    const saved = window.localStorage.getItem(COLLAPSED_WIDTH_STORAGE_KEY);
    const parsed = saved ? Number(saved) : NaN;
    if (!Number.isFinite(parsed)) {
      return FALLBACK_COLLAPSED_WIDTH;
    }
    return clamp(parsed, MIN_COLLAPSED_WIDTH, MAX_COLLAPSED_WIDTH);
  });
  const [expandedSize, setExpandedSize] = useState(() => {
    const saved = window.localStorage.getItem(EXPANDED_SIZE_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as { width?: unknown; height?: unknown };
        const defaults = getDefaultExpandedSize();
        const width = typeof parsed.width === "number" ? parsed.width : defaults.width;
        const height = typeof parsed.height === "number" ? parsed.height : defaults.height;
        return {
          width: clamp(width, MIN_EXPANDED_WIDTH, Number.POSITIVE_INFINITY),
          height: clamp(height, MIN_EXPANDED_HEIGHT, Number.POSITIVE_INFINITY),
        };
      } catch {
        // ignore
      }
    }
    return getDefaultExpandedSize();
  });

  const [snapshot, setSnapshot] = useState<SystemSnapshot>(emptySnapshot);
  const [history, setHistory] = useState<MetricHistory>(emptyHistory);

  const snapTimerRef = useRef<number | null>(null);
  const isProgrammaticLayoutRef = useRef(false);
  const statusTextRef = useRef<HTMLDivElement | null>(null);
  const collapsedPointerRef = useRef<{ x: number; y: number } | null>(null);
  const collapsedDraggingRef = useRef(false);

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

  const applyWindowLayoutSafely = useCallback(
    async (nextLayout: { width: number; height: number; x: number; y: number }) => {
      if (!appWindow) {
        return;
      }
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

    await applyWindowLayoutSafely({
      width: size.width,
      height: size.height,
      x: snappedPosition.x,
      y: snappedPosition.y,
    });
  }, [appWindow, applyWindowLayoutSafely]);

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
    window.localStorage.setItem(COLLAPSED_WIDTH_STORAGE_KEY, String(collapsedWidth));
  }, [collapsedWidth]);

  useEffect(() => {
    window.localStorage.setItem(EXPANDED_SIZE_STORAGE_KEY, JSON.stringify(expandedSize));
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

    await applyWindowLayoutSafely({
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

  const handleCollapsedResizeStart = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (!appWindow || expanded || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = collapsedWidth;

    const onMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setCollapsedWidth(clamp(startWidth + delta, MIN_COLLAPSED_WIDTH, MAX_COLLAPSED_WIDTH));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const handleExpandedResizeStart = async (event: React.PointerEvent<HTMLDivElement>) => {
    if (!appWindow || !expanded || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = { ...expandedSize };

    const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
    const centerX = position.x + size.width / 2;
    const centerY = position.y + size.height / 2;
    const monitor = await monitorFromPoint(centerX, centerY);
    const workAreaWidth = monitor?.workArea.size.width ?? 99999;
    const workAreaHeight = monitor?.workArea.size.height ?? 99999;
    const maxExpandedWidth = Math.max(MIN_EXPANDED_WIDTH, workAreaWidth - EXPANDED_EDGE_GAP * 2);
    const maxExpandedHeight = Math.max(MIN_EXPANDED_HEIGHT, workAreaHeight - EXPANDED_EDGE_GAP * 2);

    const onMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const nextWidth = clamp(startSize.width + deltaX, MIN_EXPANDED_WIDTH, maxExpandedWidth);
      const nextHeight = clamp(startSize.height + deltaY, MIN_EXPANDED_HEIGHT, maxExpandedHeight);
      setExpandedSize({
        width: nextWidth,
        height: nextHeight,
      });
      isProgrammaticLayoutRef.current = true;
      void appWindow
        .setSize(new LogicalSize(nextWidth, nextHeight))
        .finally(() => {
          window.setTimeout(() => {
            isProgrammaticLayoutRef.current = false;
          }, POSITION_SETTLE_DELAY);
        });
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

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

  const handleCollapsedPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!appWindow) {
      return;
    }

    if (expanded || event.button !== 0) {
      return;
    }

    collapsedPointerRef.current = { x: event.clientX, y: event.clientY };
    collapsedDraggingRef.current = false;
  };

  const handleCollapsedPointerMove = async (event: React.PointerEvent<HTMLElement>) => {
    if (!appWindow) {
      return;
    }

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
    if (!appWindow) {
      setExpanded((current) => !current);
      return;
    }

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


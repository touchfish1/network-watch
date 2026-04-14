import { useCallback, useRef } from "react";
import type React from "react";
import type { Window } from "@tauri-apps/api/window";

import { CLICK_DRAG_THRESHOLD } from "../../constants";

type Args = {
  appWindow: Window | null;
  expanded: boolean;
  onToggleExpanded: () => Promise<void> | void;
};

export function useCollapsedClickDrag({ appWindow, expanded, onToggleExpanded }: Args) {
  const collapsedPointerRef = useRef<{ x: number; y: number } | null>(null);
  const collapsedDraggingRef = useRef(false);

  const handleCollapsedPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!appWindow) return;
      if (event.button !== 0) return;
      collapsedPointerRef.current = { x: event.clientX, y: event.clientY };
      collapsedDraggingRef.current = false;
    },
    [appWindow],
  );

  const handleCollapsedPointerMove = useCallback(
    async (event: React.PointerEvent<HTMLElement>) => {
      if (!appWindow) return;
      if (expanded) return;
      if (collapsedDraggingRef.current || !collapsedPointerRef.current) return;

      const deltaX = Math.abs(event.clientX - collapsedPointerRef.current.x);
      const deltaY = Math.abs(event.clientY - collapsedPointerRef.current.y);
      if (Math.max(deltaX, deltaY) < CLICK_DRAG_THRESHOLD) return;

      collapsedDraggingRef.current = true;
      event.preventDefault();
      await appWindow.startDragging();
    },
    [appWindow, expanded],
  );

  const handleCollapsedPointerUp = useCallback(async () => {
    if (!appWindow) {
      await onToggleExpanded();
      return;
    }

    const wasDragging = collapsedDraggingRef.current;
    collapsedPointerRef.current = null;
    collapsedDraggingRef.current = false;

    if (!wasDragging) {
      await onToggleExpanded();
    }
  }, [appWindow, onToggleExpanded]);

  const resetCollapsedPointer = useCallback(() => {
    collapsedPointerRef.current = null;
    collapsedDraggingRef.current = false;
  }, []);

  return {
    handleCollapsedPointerDown,
    handleCollapsedPointerMove,
    handleCollapsedPointerUp,
    resetCollapsedPointer,
  };
}


import { useCallback } from "react";
import type React from "react";
import type { Window } from "@tauri-apps/api/window";
import { LogicalSize, monitorFromPoint } from "@tauri-apps/api/window";

import {
  EXPANDED_EDGE_GAP,
  MAX_COLLAPSED_WIDTH,
  MIN_COLLAPSED_WIDTH,
  MIN_EXPANDED_HEIGHT,
  MIN_EXPANDED_WIDTH,
  POSITION_SETTLE_DELAY,
} from "../../constants";
import { clamp } from "../../utils";

type Args = {
  appWindow: Window | null;
  expanded: boolean;
  collapsedWidth: number;
  setCollapsedWidth: (next: number) => void;
  expandedSize: { width: number; height: number };
  setExpandedSize: (next: { width: number; height: number }) => void;
  isProgrammaticLayoutRef: React.MutableRefObject<boolean>;
};

export function useResizeHandlers({
  appWindow,
  expanded,
  collapsedWidth,
  setCollapsedWidth,
  expandedSize,
  setExpandedSize,
  isProgrammaticLayoutRef,
}: Args) {
  const handleCollapsedResizeStart = useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      if (!appWindow || expanded || event.button !== 0) return;

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
    },
    [appWindow, collapsedWidth, expanded, setCollapsedWidth],
  );

  const handleExpandedResizeStart = useCallback(
    async (event: React.PointerEvent<HTMLDivElement>) => {
      if (!appWindow || !expanded || event.button !== 0) return;

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
        setExpandedSize({ width: nextWidth, height: nextHeight });

        isProgrammaticLayoutRef.current = true;
        void appWindow.setSize(new LogicalSize(nextWidth, nextHeight)).finally(() => {
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
    },
    [appWindow, expanded, expandedSize, isProgrammaticLayoutRef, setExpandedSize],
  );

  return { handleCollapsedResizeStart, handleExpandedResizeStart };
}


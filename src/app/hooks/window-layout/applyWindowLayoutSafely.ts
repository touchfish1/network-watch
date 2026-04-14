import { LogicalSize, PhysicalPosition, type Window } from "@tauri-apps/api/window";
import type React from "react";

import { POSITION_SETTLE_DELAY } from "../../constants";

/**
 * 对 `setSize`/`setPosition` 做“程序性布局”的保护：避免 onMoved/onResized 误判为用户拖拽。
 */
export async function applyWindowLayoutSafely(
  appWindow: Window,
  nextLayout: { width: number; height: number; x: number; y: number },
  isProgrammaticLayoutRef: React.MutableRefObject<boolean>,
) {
  isProgrammaticLayoutRef.current = true;
  try {
    await appWindow.setSize(new LogicalSize(nextLayout.width, nextLayout.height));
    await appWindow.setPosition(new PhysicalPosition(nextLayout.x, nextLayout.y));
  } finally {
    window.setTimeout(() => {
      isProgrammaticLayoutRef.current = false;
    }, POSITION_SETTLE_DELAY);
  }
}


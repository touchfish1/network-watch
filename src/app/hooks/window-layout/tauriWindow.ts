import { LogicalSize, PhysicalPosition, monitorFromPoint, type Window } from "@tauri-apps/api/window";

import { POSITION_SETTLE_DELAY } from "../../constants";

export type WindowLayout = { width: number; height: number; x: number; y: number };

export async function getMonitorForWindow(appWindow: Window) {
  const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
  const centerX = position.x + size.width / 2;
  const centerY = position.y + size.height / 2;
  return monitorFromPoint(centerX, centerY);
}

/**
 * 避免 onMoved 等事件把“代码触发的移动/缩放”当成用户拖动：调用方应在 finally 后再解除标记。
 */
export async function applyWindowLayout(appWindow: Window, nextLayout: WindowLayout) {
  await appWindow.setSize(new LogicalSize(nextLayout.width, nextLayout.height));
  await appWindow.setPosition(new PhysicalPosition(nextLayout.x, nextLayout.y));
}

export function scheduleProgrammaticFlagReset(reset: () => void) {
  window.setTimeout(reset, POSITION_SETTLE_DELAY);
}


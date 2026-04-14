import type { Monitor } from "@tauri-apps/api/window";
import { monitorFromPoint } from "@tauri-apps/api/window";

import {
  DEFAULT_EXPANDED_HEIGHT,
  DEFAULT_EXPANDED_WIDTH,
  EXPANDED_EDGE_GAP,
  EXPANDED_SYSTEM_FLYOUT_GAP,
  FALLBACK_COLLAPSED_HEIGHT,
  HISTORY_LIMIT,
  MAX_COLLAPSED_HEIGHT,
  MIN_COLLAPSED_HEIGHT,
  SNAP_THRESHOLD,
} from "./constants";
import type { TaskbarEdge } from "./types";

export function pushSample(series: number[], value: number) {
  const next = [...series, value];
  return next.slice(-HISTORY_LIMIT);
}

export function formatBytes(value: number) {
  if (value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** exponent;
  return `${size.toFixed(size >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatRate(value: number) {
  return `${formatBytes(value)}/s`;
}

export function formatCompactRate(value: number) {
  if (value <= 0) {
    return "0B/s";
  }

  const units = ["B/s", "K/s", "M/s", "G/s", "T/s"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const size = value / 1024 ** exponent;
  const decimals = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(decimals)}${units[exponent]}`;
}

export function formatPercent(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function formatMemoryUsage(used: number, total: number) {
  if (total <= 0) {
    return "0%";
  }

  return formatPercent((used / total) * 100);
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function getTaskbarThickness(monitor: Awaited<ReturnType<typeof monitorFromPoint>>) {
  if (!monitor) {
    return FALLBACK_COLLAPSED_HEIGHT;
  }

  const horizontalInset = monitor.size.height - monitor.workArea.size.height;
  const verticalInset = monitor.size.width - monitor.workArea.size.width;
  const thickness = Math.max(horizontalInset, verticalInset, 0);

  return clamp(thickness, MIN_COLLAPSED_HEIGHT, MAX_COLLAPSED_HEIGHT);
}

export function getTaskbarEdge(monitor: Monitor | null): TaskbarEdge {
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

export function getDockedPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  monitor: Monitor | null,
) {
  if (!monitor) {
    return null;
  }

  const workAreaX = monitor.workArea.position.x;
  const workAreaY = monitor.workArea.position.y;
  const workAreaWidth = monitor.workArea.size.width;
  const workAreaHeight = monitor.workArea.size.height;
  const minX = workAreaX;
  const maxX = workAreaX + workAreaWidth - size.width;
  const minY = workAreaY;
  const maxY = workAreaY + workAreaHeight - size.height;

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

export function getAnchoredExpandedPosition(
  position: { x: number; y: number },
  currentSize: { width: number; height: number },
  nextSize: { width: number; height: number },
  monitor: Monitor | null,
) {
  if (!monitor) {
    return { position, direction: "unknown" };
  }

  const workAreaX = monitor.workArea.position.x;
  const workAreaY = monitor.workArea.position.y;
  const workAreaWidth = monitor.workArea.size.width;
  const workAreaHeight = monitor.workArea.size.height;
  const taskbarEdge = getTaskbarEdge(monitor);
  const extraGap = Math.max(EXPANDED_EDGE_GAP, getTaskbarThickness(monitor), EXPANDED_SYSTEM_FLYOUT_GAP);
  const gapX = taskbarEdge === "left" || taskbarEdge === "right" ? extraGap : EXPANDED_EDGE_GAP;
  const gapY = taskbarEdge === "top" || taskbarEdge === "bottom" ? extraGap : EXPANDED_EDGE_GAP;

  const minX = workAreaX + (taskbarEdge === "left" ? gapX : EXPANDED_EDGE_GAP);
  const maxX =
    workAreaX +
    workAreaWidth -
    nextSize.width -
    (taskbarEdge === "right" ? gapX : EXPANDED_EDGE_GAP);
  const minY = workAreaY + (taskbarEdge === "top" ? gapY : EXPANDED_EDGE_GAP);
  const maxY =
    workAreaY +
    workAreaHeight -
    nextSize.height -
    (taskbarEdge === "bottom" ? gapY : EXPANDED_EDGE_GAP);
  const bottomEdge = position.y + currentSize.height;
  const downwardY = position.y;
  const upwardY = bottomEdge - nextSize.height;
  const canExpandDown = position.y + nextSize.height <= workAreaY + workAreaHeight;
  const nextY = canExpandDown ? downwardY : upwardY;

  const safeMinX = Math.min(minX, maxX);
  const safeMaxX = Math.max(minX, maxX);
  const safeMinY = Math.min(minY, maxY);
  const safeMaxY = Math.max(minY, maxY);

  return {
    position: {
      x: clamp(position.x, safeMinX, safeMaxX),
      y: clamp(nextY, safeMinY, safeMaxY),
    },
    direction: canExpandDown ? "down" : "up",
  };
}

export function buildPath(values: number[]) {
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

export function formatProgress(downloadedBytes?: number, totalBytes?: number) {
  if (!downloadedBytes) {
    return "准备下载更新包…";
  }

  if (!totalBytes || totalBytes <= 0) {
    return `已下载 ${formatBytes(downloadedBytes)}`;
  }

  const percent = Math.min((downloadedBytes / totalBytes) * 100, 100);
  return `已下载 ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)} (${percent.toFixed(0)}%)`;
}

export function getDefaultExpandedSize() {
  return { width: DEFAULT_EXPANDED_WIDTH, height: DEFAULT_EXPANDED_HEIGHT };
}


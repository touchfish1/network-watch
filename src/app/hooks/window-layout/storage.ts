import {
  COLLAPSED_WIDTH_STORAGE_KEY,
  EXPANDED_SIZE_STORAGE_KEY,
  FALLBACK_COLLAPSED_WIDTH,
  MAX_COLLAPSED_WIDTH,
  MIN_COLLAPSED_WIDTH,
  MIN_EXPANDED_HEIGHT,
  MIN_EXPANDED_WIDTH,
} from "../../constants";
import { clamp, getDefaultExpandedSize } from "../../utils";

export type PersistedExpandedSize = { width: number; height: number };

export function loadCollapsedWidth(): number {
  const saved = window.localStorage.getItem(COLLAPSED_WIDTH_STORAGE_KEY);
  const parsed = saved ? Number(saved) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return FALLBACK_COLLAPSED_WIDTH;
  }
  return clamp(parsed, MIN_COLLAPSED_WIDTH, MAX_COLLAPSED_WIDTH);
}

export function saveCollapsedWidth(width: number) {
  window.localStorage.setItem(COLLAPSED_WIDTH_STORAGE_KEY, String(width));
}

export function loadExpandedSize(): PersistedExpandedSize {
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
}

export function saveExpandedSize(size: PersistedExpandedSize) {
  window.localStorage.setItem(EXPANDED_SIZE_STORAGE_KEY, JSON.stringify(size));
}


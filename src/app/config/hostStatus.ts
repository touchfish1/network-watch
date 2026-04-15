export const HOST_STALE_THRESHOLD_STORAGE_KEY = "network-watch-host-stale-threshold-ms-v1";
export const DEFAULT_HOST_STALE_THRESHOLD_MS = 12_000;

export function loadHostStaleThresholdMs(): number {
  const raw = window.localStorage.getItem(HOST_STALE_THRESHOLD_STORAGE_KEY);
  if (!raw) return DEFAULT_HOST_STALE_THRESHOLD_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_HOST_STALE_THRESHOLD_MS;
  // 合理范围：2s ~ 10min
  return Math.min(10 * 60_000, Math.max(2_000, Math.round(n)));
}

export function saveHostStaleThresholdMs(ms: number) {
  const safe = Math.min(10 * 60_000, Math.max(2_000, Math.round(ms)));
  window.localStorage.setItem(HOST_STALE_THRESHOLD_STORAGE_KEY, String(safe));
}


export const UPDATE_POLL_INTERVAL_KEY = "network-watch-update-poll-interval-minutes-v1";

export const updatePollIntervalOptionsMinutes = [15, 30, 60, 240, 720] as const;
export type UpdatePollIntervalMinutes = (typeof updatePollIntervalOptionsMinutes)[number];

export const defaultUpdatePollIntervalMinutes: UpdatePollIntervalMinutes = 30;

export function loadUpdatePollIntervalMinutes(): UpdatePollIntervalMinutes {
  const raw = window.localStorage.getItem(UPDATE_POLL_INTERVAL_KEY);
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) return defaultUpdatePollIntervalMinutes;
  if ((updatePollIntervalOptionsMinutes as readonly number[]).includes(parsed)) {
    return parsed as UpdatePollIntervalMinutes;
  }
  return defaultUpdatePollIntervalMinutes;
}

export function saveUpdatePollIntervalMinutes(minutes: UpdatePollIntervalMinutes) {
  window.localStorage.setItem(UPDATE_POLL_INTERVAL_KEY, String(minutes));
}

export function formatIntervalLabel(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours} 小时`;
  return `${minutes} 分钟`;
}


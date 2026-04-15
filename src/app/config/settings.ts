export const UPDATE_POLL_INTERVAL_KEY = "network-watch-update-poll-interval-minutes-v1";
export const NIC_PREFERENCE_KEY = "network-watch-nic-preference-v1";
export const ALERT_SETTINGS_KEY = "network-watch-alert-settings-v1";
export const QUOTA_SETTINGS_KEY = "network-watch-quota-settings-v1";

export const updatePollIntervalOptionsMinutes = [15, 30, 60, 240, 720] as const;
export type UpdatePollIntervalMinutes = (typeof updatePollIntervalOptionsMinutes)[number];
export const nicModeOptions = ["auto", "manual"] as const;
export type NicMode = (typeof nicModeOptions)[number];

export const defaultUpdatePollIntervalMinutes: UpdatePollIntervalMinutes = 30;
export const defaultNicPreference = {
  mode: "auto" as NicMode,
  nicId: null as string | null,
};
export const defaultAlertSettings = {
  enabled: true,
  cpuPercent: 85,
  memoryPercent: 85,
  downloadBytesPerSec: 20 * 1024 * 1024,
  uploadBytesPerSec: 10 * 1024 * 1024,
  cooldownSeconds: 300,
};
export const defaultQuotaSettings = {
  enabled: false,
  monthlyBytes: 200 * 1024 * 1024 * 1024,
  warningPercent: 80,
  resetDay: 1,
};

export type NicPreference = typeof defaultNicPreference;
export type AlertSettings = typeof defaultAlertSettings;
export type QuotaSettings = typeof defaultQuotaSettings;

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

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

export function loadNicPreference(): NicPreference {
  const parsed = safeParse<Partial<NicPreference>>(window.localStorage.getItem(NIC_PREFERENCE_KEY));
  return {
    mode: parsed?.mode === "manual" ? "manual" : "auto",
    nicId: typeof parsed?.nicId === "string" && parsed.nicId.length > 0 ? parsed.nicId : null,
  };
}

export function saveNicPreference(value: NicPreference) {
  window.localStorage.setItem(NIC_PREFERENCE_KEY, JSON.stringify(value));
}

export function loadAlertSettings(): AlertSettings {
  const parsed = safeParse<Partial<AlertSettings>>(window.localStorage.getItem(ALERT_SETTINGS_KEY));
  return {
    enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : defaultAlertSettings.enabled,
    cpuPercent: Number.isFinite(parsed?.cpuPercent) ? Number(parsed?.cpuPercent) : defaultAlertSettings.cpuPercent,
    memoryPercent: Number.isFinite(parsed?.memoryPercent)
      ? Number(parsed?.memoryPercent)
      : defaultAlertSettings.memoryPercent,
    downloadBytesPerSec: Number.isFinite(parsed?.downloadBytesPerSec)
      ? Number(parsed?.downloadBytesPerSec)
      : defaultAlertSettings.downloadBytesPerSec,
    uploadBytesPerSec: Number.isFinite(parsed?.uploadBytesPerSec)
      ? Number(parsed?.uploadBytesPerSec)
      : defaultAlertSettings.uploadBytesPerSec,
    cooldownSeconds: Number.isFinite(parsed?.cooldownSeconds)
      ? Number(parsed?.cooldownSeconds)
      : defaultAlertSettings.cooldownSeconds,
  };
}

export function saveAlertSettings(value: AlertSettings) {
  window.localStorage.setItem(ALERT_SETTINGS_KEY, JSON.stringify(value));
}

export function loadQuotaSettings(): QuotaSettings {
  const parsed = safeParse<Partial<QuotaSettings>>(window.localStorage.getItem(QUOTA_SETTINGS_KEY));
  return {
    enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : defaultQuotaSettings.enabled,
    monthlyBytes: Number.isFinite(parsed?.monthlyBytes) ? Number(parsed?.monthlyBytes) : defaultQuotaSettings.monthlyBytes,
    warningPercent: Number.isFinite(parsed?.warningPercent)
      ? Number(parsed?.warningPercent)
      : defaultQuotaSettings.warningPercent,
    resetDay: Number.isFinite(parsed?.resetDay) ? Number(parsed?.resetDay) : defaultQuotaSettings.resetDay,
  };
}

export function saveQuotaSettings(value: QuotaSettings) {
  window.localStorage.setItem(QUOTA_SETTINGS_KEY, JSON.stringify(value));
}

export function formatIntervalLabel(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  if (Number.isInteger(hours)) return `${hours} 小时`;
  return `${minutes} 分钟`;
}

export function formatQuotaResetLabel(day: number) {
  return `每月 ${day} 日`;
}


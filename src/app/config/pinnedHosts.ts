export const PINNED_HOSTS_STORAGE_KEY = "network-watch-pinned-machine-ids-v1";

export function loadPinnedHostIds(): string[] {
  const raw = window.localStorage.getItem(PINNED_HOSTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    return [];
  }
}

export function savePinnedHostIds(ids: string[]) {
  const unique = Array.from(new Set(ids.filter((x) => typeof x === "string" && x.trim().length > 0)));
  window.localStorage.setItem(PINNED_HOSTS_STORAGE_KEY, JSON.stringify(unique));
}


import { CLICK_THROUGH_STORAGE_KEY } from "../constants";

export type CardId =
  | "overview"
  | "alerts"
  | "history"
  | "connections"
  | "nic"
  | "process"
  | "disk"
  | "theme"
  | "update";
export type StatusItemId = "cpu" | "mem" | "down" | "up" | "active_nic" | "disk" | "connections";

const CARD_ORDER_KEY = "network-watch-card-order-v1";
const CARD_VISIBILITY_KEY = "network-watch-card-visibility-v1";
const STATUS_VISIBILITY_KEY = "network-watch-status-visibility-v1";

export const defaultCardOrder: CardId[] = [
  "overview",
  "alerts",
  "history",
  "connections",
  "nic",
  "process",
  "disk",
  "theme",
  "update",
];
export const defaultCardVisibility: Record<CardId, boolean> = {
  overview: true,
  alerts: true,
  history: true,
  connections: true,
  nic: true,
  process: true,
  disk: true,
  theme: true,
  update: true,
};
export const defaultStatusVisibility: Record<StatusItemId, boolean> = {
  cpu: true,
  mem: true,
  down: true,
  up: true,
  active_nic: false,
  disk: false,
  connections: false,
};

function safeParse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function loadCardOrder(): CardId[] {
  const parsed = safeParse<unknown>(window.localStorage.getItem(CARD_ORDER_KEY));
  if (!Array.isArray(parsed)) return defaultCardOrder;
  const filtered = parsed.filter((x): x is CardId => typeof x === "string" && x in defaultCardVisibility);
  const unique = Array.from(new Set(filtered));
  // 保证所有卡片都有位置
  for (const id of defaultCardOrder) {
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

export function saveCardOrder(order: CardId[]) {
  window.localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(order));
}

export function loadCardVisibility(): Record<CardId, boolean> {
  const parsed = safeParse<Record<string, unknown>>(window.localStorage.getItem(CARD_VISIBILITY_KEY));
  if (!parsed) return defaultCardVisibility;
  const next: Record<CardId, boolean> = { ...defaultCardVisibility };
  for (const key of Object.keys(defaultCardVisibility) as CardId[]) {
    if (typeof parsed[key] === "boolean") next[key] = parsed[key] as boolean;
  }
  return next;
}

export function saveCardVisibility(visibility: Record<CardId, boolean>) {
  window.localStorage.setItem(CARD_VISIBILITY_KEY, JSON.stringify(visibility));
}

export function loadStatusVisibility(): Record<StatusItemId, boolean> {
  const parsed = safeParse<Record<string, unknown>>(window.localStorage.getItem(STATUS_VISIBILITY_KEY));
  if (!parsed) return defaultStatusVisibility;
  const next: Record<StatusItemId, boolean> = { ...defaultStatusVisibility };
  for (const key of Object.keys(defaultStatusVisibility) as StatusItemId[]) {
    if (typeof parsed[key] === "boolean") next[key] = parsed[key] as boolean;
  }
  return next;
}

export function saveStatusVisibility(visibility: Record<StatusItemId, boolean>) {
  window.localStorage.setItem(STATUS_VISIBILITY_KEY, JSON.stringify(visibility));
}

export function loadClickThroughEnabled(): boolean {
  const saved = window.localStorage.getItem(CLICK_THROUGH_STORAGE_KEY);
  return saved === "1" || saved === "true";
}


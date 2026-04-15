import type React from "react";

import type { AlertRecord, HistorySummary, QuotaRuntime, ThemeId, UpdateState } from "../../types";
import type { AlertSettings, NicPreference, QuotaSettings, UpdatePollIntervalMinutes } from "../../config/settings";

export type ControlCenterSnapshot = {
  cpu_usage: number;
  memory_used: number;
  memory_total: number;
  network_download: number;
  network_upload: number;
  nics: Array<{
    id: string;
    received: number;
    transmitted: number;
  }>;
  active_nic_id: string | null;
  disks: Array<{
    id: string;
    name: string;
    mount: string;
    total_bytes: number;
    available_bytes: number;
  }>;
  system_disk: {
    total_bytes: number;
    available_bytes: number;
  } | null;
  uptime_seconds: number;
  process_count: number;
  top_processes_cpu: Array<{
    pid: number;
    name: string;
    cpu_usage: number;
    memory_used: number;
  }>;
  top_processes_memory: Array<{
    pid: number;
    name: string;
    cpu_usage: number;
    memory_used: number;
  }>;
  connections: {
    total: number;
    by_state: Array<{
      state: string;
      count: number;
    }>;
  } | null;
};

export type ControlCenterHistory = {
  cpu: number[];
  memory: number[];
  download: number[];
  upload: number[];
};

export type ControlCenterProps = {
  expanded: boolean;
  appVersion: string;
  lastUpdated: string;
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  updateState: UpdateState;
  updatePollIntervalMinutes: UpdatePollIntervalMinutes;
  setUpdatePollIntervalMinutes: (next: UpdatePollIntervalMinutes) => void;
  nicPreference: NicPreference;
  setNicPreference: (next: NicPreference) => void;
  alertSettings: AlertSettings;
  setAlertSettings: (next: AlertSettings) => void;
  quotaSettings: QuotaSettings;
  setQuotaSettings: (next: QuotaSettings) => void;
  quotaRuntime: QuotaRuntime;
  alertRecords: AlertRecord[];
  historySummary: HistorySummary;
  historySeries: {
    downloadPerMinute: number[];
    uploadPerMinute: number[];
  };
  onCheckOrInstallUpdate: () => void;
  onCollapse: () => void;
  onHeaderPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  diagnosticsLabel: string | null;
  snapshot: ControlCenterSnapshot;
  history: ControlCenterHistory;
};


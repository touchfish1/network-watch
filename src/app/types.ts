export type SystemSnapshot = {
  timestamp: number;
  cpu_usage: number;
  memory_used: number;
  memory_total: number;
  network_download: number;
  network_upload: number;
};

export type MetricHistory = {
  cpu: number[];
  memory: number[];
  download: number[];
  upload: number[];
};

export type ExpansionDirection = "down" | "up";
export type TaskbarEdge = "top" | "right" | "bottom" | "left";

export type ThemeId = "cyberpunk" | "japanese" | "chinese" | "western";

export type ThemeDefinition = {
  name: string;
  mood: string;
  detail: string;
  swatches: [string, string, string];
};

export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "latest"
  | "downloading"
  | "installing"
  | "error";

export type UpdateState = {
  stage: UpdateStage;
  message: string;
  availableVersion?: string;
  releaseNotes?: string;
  downloadedBytes?: number;
  totalBytes?: number;
};

export type RuntimeDiagnostics = {
  overlay_interactive: boolean;
  sampler_tick_count: number;
  last_snapshot_at_ms: number;
};

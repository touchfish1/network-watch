/**
 * 与后端 `SystemSnapshot` 对齐的系统快照。
 *
 * 约定：
 * - 字段名使用 `snake_case`（来自 Rust serde）\n+ * - 大多数容量/流量单位为 **字节**\n+ * - 网络吞吐字段为“1s 周期内的增量”，在 UI 上按 B/s 展示
 */
export type SystemSnapshot = {
  timestamp: number;
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
  /**
   * Windows：连接总数与状态分布；其它平台为 null。
   */
  connections: {
    total: number;
    by_state: Array<{
      state: string;
      count: number;
    }>;
  } | null;
};

/**
 * 指标历史序列（用于 sparkline 趋势）。
 *
 * - `cpu`：百分比（0~100+）\n+ * - `memory`：百分比（0~100）\n+ * - `download/upload`：字节/秒（由采样周期推导）
 */
export type MetricHistory = {
  cpu: number[];
  memory: number[];
  download: number[];
  upload: number[];
};

export type ExpansionDirection = "down" | "up";
export type TaskbarEdge = "top" | "right" | "bottom" | "left";

export type ThemeId = "cyberpunk" | "japanese" | "chinese" | "western";

/**
 * 主题展示定义（用于控制中心的主题切换卡片）。
 */
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

/**
 * 后端运行时诊断（用于 footer 文案与排障）。
 */
export type RuntimeDiagnostics = {
  overlay_interactive: boolean;
  sampler_tick_count: number;
  last_snapshot_at_ms: number;
};

/** 后端 `get_web_monitor_hint` 返回值（camelCase）。 */
export type WebMonitorHint = {
  enabled: boolean;
  primaryUrl: string | null;
  note: string | null;
};

/** 悬窗通过 `get_online_machines` 拉取到的在线主机快照。 */
export type OnlineMachine = {
  machine_id: string;
  host_name: string | null;
  host_ips: string[];
  label: string | null;
  received_at_ms: number;
  snapshot: SystemSnapshot;
};

export type AlertRecord = {
  id: string;
  title: string;
  message: string;
  metric: "cpu" | "memory" | "download" | "upload" | "quota";
  timestamp: number;
};

export type HistorySummary = {
  last24HoursDownload: number;
  last24HoursUpload: number;
  last7DaysDownload: number;
  last7DaysUpload: number;
  peakDownload: number;
  peakUpload: number;
  sampleCount: number;
};

export type QuotaRuntime = {
  periodKey: string;
  usedBytes: number;
  warningTriggered: boolean;
  exceededTriggered: boolean;
};

import { invoke } from "@tauri-apps/api/core";

import type { HostEvent, MachineHistoryPoint, OnlineMachine, RuntimeDiagnostics, WebMonitorHint } from "./types";

/**
 * 统一封装 Tauri `invoke` 调用。
 *
 * 设计目标：
 * - 把命令名集中在一处，避免散落 magic string\n+ * - 让 hooks/组件只关心业务语义（例如“切换 overlay 可交互”）\n+ * - 便于未来给 invoke 加统一的错误处理/超时策略
 */
export async function setOverlayInteractive(interactive: boolean) {
  await invoke("set_overlay_interactive", { interactive });
}

/**
 * 获取后端运行时诊断信息（采样 tick、最近快照时间、overlay 交互状态等）。
 */
export async function getRuntimeDiagnostics() {
  return await invoke<RuntimeDiagnostics>("get_runtime_diagnostics");
}

export async function exportDiagnosticsReport(minutes = 10) {
  return await invoke<string>("export_diagnostics_report", { minutes });
}

/** 与后端 Web 监控绑定一致的本机访问地址（用于控制中心展示）。 */
export async function getWebMonitorHint() {
  return await invoke<WebMonitorHint>("get_web_monitor_hint");
}

/** 获取 agent 上报到 GUI 的在线主机列表（按最近上报时间倒序）。 */
export async function getOnlineMachines() {
  return await invoke<OnlineMachine[]>("get_online_machines");
}

export async function getMachineHistory(machineId: string, range: "24h" | "7d" = "24h") {
  return await invoke<MachineHistoryPoint[]>("get_machine_history", { machineId, range });
}

export async function getHostEvents(params?: {
  machineId?: string;
  sinceMs?: number;
  untilMs?: number;
  eventType?: "online" | "offline" | "all";
  query?: string;
  offset?: number;
  limit?: number;
}) {
  return await invoke<HostEvent[]>("get_host_events", {
    machineId: params?.machineId,
    sinceMs: params?.sinceMs,
    untilMs: params?.untilMs,
    eventType: params?.eventType,
    query: params?.query,
    offset: params?.offset,
    limit: params?.limit ?? 100,
  });
}

/**
 * Windows：切换鼠标穿透（开启后窗口不再吃鼠标点击）。
 *
 * 返回值为最终状态，便于 UI 与托盘同步。
 */
export async function setClickThroughEnabled(enabled: boolean) {
  return await invoke<boolean>("set_click_through_enabled", { enabled });
}

/**
 * 打开（或聚焦）独立的设置窗口。
 *
 * 说明：
 * - 单独窗口可避免主窗口标题栏 drag-region 导致的点击吞掉问题
 * - 使用 query 参数让同一套前端资源渲染设置页
 */
export async function openSettingsWindow() {
  await invoke<void>("open_settings_window");
}

/** 关闭设置窗口（优先走后端，避免 ACL 或 webview 差异导致 `close()` 无效）。 */
export async function closeSettingsWindow() {
  await invoke<void>("close_settings_window");
}


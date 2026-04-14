import { invoke } from "@tauri-apps/api/core";

import type { RuntimeDiagnostics } from "./types";

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

/**
 * Windows：切换鼠标穿透（开启后窗口不再吃鼠标点击）。
 *
 * 返回值为最终状态，便于 UI 与托盘同步。
 */
export async function setClickThroughEnabled(enabled: boolean) {
  return await invoke<boolean>("set_click_through_enabled", { enabled });
}


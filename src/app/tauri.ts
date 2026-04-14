import { invoke } from "@tauri-apps/api/core";
import { getAllWindows } from "@tauri-apps/api/window";

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

/**
 * 打开（或聚焦）独立的设置窗口。
 *
 * 说明：
 * - 单独窗口可避免主窗口标题栏 drag-region 导致的点击吞掉问题
 * - 使用 query 参数让同一套前端资源渲染设置页
 */
export async function openSettingsWindow() {
  const windows = await getAllWindows();
  const existing = windows.find((w) => w.label === "settings");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  // 兼容不同版本的 window API：部分版本没有导出 WebviewWindow 构造器。
  // 这里用底层 invoke 创建新窗口（由后端 tauri runtime 处理）。
  await invoke<void>("plugin:window|create", {
    options: {
      label: "settings",
      title: "设置 - Network Watch",
      url: "/?window=settings",
      width: 520,
      height: 680,
      minWidth: 420,
      minHeight: 520,
      resizable: true,
      decorations: true,
      visible: true,
      center: true,
    },
  });
}


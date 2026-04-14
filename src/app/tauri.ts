import { invoke } from "@tauri-apps/api/core";

import type { RuntimeDiagnostics } from "./types";

export async function setOverlayInteractive(interactive: boolean) {
  await invoke("set_overlay_interactive", { interactive });
}

export async function getRuntimeDiagnostics() {
  return await invoke<RuntimeDiagnostics>("get_runtime_diagnostics");
}


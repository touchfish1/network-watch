import { useEffect, useState } from "react";

import type { RuntimeDiagnostics } from "../types";
import { getRuntimeDiagnostics } from "../tauri";

/**
 * 周期性拉取后端运行时诊断数据。
 *
 * 说明：
 * - 仅在 Tauri 桌面端启用\n+ * - 频率（1.5s）比采样（1s）略低，减少 invoke 压力，同时仍能及时反映“采样是否卡住”
 */
export function useRuntimeDiagnostics(isTauriEnv: boolean) {
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null);

  useEffect(() => {
    if (!isTauriEnv) {
      return;
    }

    let timer: number | null = null;
    const poll = () => {
      void getRuntimeDiagnostics()
        .then(setDiagnostics)
        .catch(() => {
          setDiagnostics(null);
        });
    };

    poll();
    timer = window.setInterval(poll, 1500);

    return () => {
      if (timer) {
        window.clearInterval(timer);
      }
    };
  }, [isTauriEnv]);

  return diagnostics;
}


import { useEffect, useState } from "react";

import type { RuntimeDiagnostics } from "../types";
import { getRuntimeDiagnostics } from "../tauri";

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


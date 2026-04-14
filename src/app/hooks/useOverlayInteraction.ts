import { useEffect } from "react";

import { setOverlayInteractive } from "../tauri";

export function useOverlayInteraction(isTauriEnv: boolean) {
  useEffect(() => {
    if (!isTauriEnv) {
      return;
    }

    // Any intentional user interaction should switch the overlay to interactive mode.
    // We keep the logic simple: pointer-down enables; window blur disables.
    const handlePointerDownCapture = () => {
      void setOverlayInteractive(true).catch(() => {
        // ignore
      });
    };

    document.addEventListener("pointerdown", handlePointerDownCapture, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDownCapture, {
        capture: true,
      } as AddEventListenerOptions);
    };
  }, [isTauriEnv]);
}


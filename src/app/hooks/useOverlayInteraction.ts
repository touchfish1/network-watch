import { useEffect } from "react";

import { setOverlayInteractive } from "../tauri";

/**
 * 让“悬浮窗 overlay”在用户交互时可点击，在失去交互意图时回到非交互。
 *
 * 约束与设计：
 * - 该 hook 只在 Tauri 桌面端启用；浏览器环境没有 overlay 概念\n+ * - “用户意图”用最简单的启发式：任意 `pointerdown`（捕获阶段）视为用户要交互\n+ * - 关闭交互由其它地方（例如窗口 blur、展开/收起逻辑）触发，避免在这里耦合过多窗口状态
 */
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


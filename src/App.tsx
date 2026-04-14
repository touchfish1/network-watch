import { startTransition, useCallback, useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import "./App.css";

import {
  THEME_STORAGE_KEY,
} from "./app/constants";
import { ControlCenter } from "./app/components/ControlCenter";
import { StatusStrip } from "./app/components/StatusStrip";
import type { MetricHistory, SystemSnapshot, ThemeId } from "./app/types";
import { useOverlayInteraction } from "./app/hooks/useOverlayInteraction";
import { useRuntimeDiagnostics } from "./app/hooks/useRuntimeDiagnostics";
import { useUpdater } from "./app/hooks/useUpdater";
import { useWindowLayout } from "./app/hooks/useWindowLayout";
import { themeDefinitions } from "./app/themes";
import {
  pushSample,
} from "./app/utils";

/**
 * 前端应用入口（单窗口悬浮窗）。
 *
 * 数据流概览：
 * - 后端（Tauri/Rust）每秒广播一次 `system-snapshot`
 * - `useWindowLayout` 订阅该事件并维护窗口展开/收起、拖拽/缩放、贴边等布局状态
 * - 组件层：`StatusStrip`（收起态）+ `ControlCenter`（展开态）
 *
 * 兼容说明：
 * - 在浏览器开发环境（`npm run dev`）下没有 Tauri API，因此需要 `isTauri()` 守卫。
 */
const emptySnapshot: SystemSnapshot = {
  timestamp: Date.now(),
  cpu_usage: 0,
  memory_used: 0,
  memory_total: 0,
  network_download: 0,
  network_upload: 0,
  nics: [],
  active_nic_id: null,
  disks: [],
  system_disk: null,
  uptime_seconds: 0,
  process_count: 0,
  top_processes_cpu: [],
  top_processes_memory: [],
};

const emptyHistory: MetricHistory = {
  cpu: [],
  memory: [],
  download: [],
  upload: [],
};

function App() {
  /**
   * `isTauri()` 仅在首次渲染求值，避免在 render 期间触发任何潜在的环境探测抖动。
   */
  const isTauriEnv = useMemo(() => isTauri(), []);
  const [lastUpdated, setLastUpdated] = useState("等待系统数据…");

  const layout = useWindowLayout({
    isTauriEnv,
    emptySnapshot,
    emptyHistory,
    onSnapshot: (payload) => {
      // 采样频率较高（1s），用 transition 降低 UI 更新的阻塞感。
      startTransition(() => {
        layout.setHistory((current) => ({
          cpu: pushSample(current.cpu, payload.cpu_usage),
          memory: pushSample(
            current.memory,
            payload.memory_total > 0 ? (payload.memory_used / payload.memory_total) * 100 : 0,
          ),
          download: pushSample(current.download, payload.network_download),
          upload: pushSample(current.upload, payload.network_upload),
        }));
        setLastUpdated(new Date(payload.timestamp).toLocaleTimeString());
      });
    },
  });

  const {
    expanded,
    expansionDirection,
    snapshot,
    history,
    collapsedHeight,
    collapsedWidth,
    statusTextRef,
    handleCollapsedPointerDown,
    handleCollapsedPointerMove,
    handleCollapsedPointerUp,
    resetCollapsedPointer,
    handleCollapsedResizeStart,
    handleExpandedResizeStart,
    handleDragStart,
    toggleExpanded,
  } = layout;
  const [theme, setTheme] = useState<ThemeId>(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved && saved in themeDefinitions ? (saved as ThemeId) : "cyberpunk";
  });
  const [appVersion, setAppVersion] = useState("--");
  const diagnostics = useRuntimeDiagnostics(isTauriEnv);
  const { updateState, checkForUpdates, installUpdate } = useUpdater(isTauriEnv);
  useOverlayInteraction(isTauriEnv);

  const onCheckOrInstallUpdate = useCallback(() => {
    void (updateState.stage === "available" ? installUpdate() : checkForUpdates());
  }, [checkForUpdates, installUpdate, updateState.stage]);

  /**
   * 获取应用版本号（仅桌面端）。用于更新卡片与标题栏展示。
   */
  useEffect(() => {
    if (!isTauriEnv) {
      setAppVersion("dev");
      return;
    }

    void getVersion()
      .then(setAppVersion)
      .catch(() => {
        setAppVersion("--");
      });
  }, [isTauriEnv]);

  /**
   * 静默轮询更新（10 分钟一次）。
   *
   * - 仅在桌面端启用\n+   * - 使用 silent 模式避免打断用户（不切换成 “检查中…”）
   */
  useEffect(() => {
    if (!isTauriEnv) {
      return;
    }

    void checkForUpdates({ silent: true });
    const timer = window.setInterval(() => {
      void checkForUpdates({ silent: true });
    }, 10 * 60 * 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [checkForUpdates, isTauriEnv]);

  const diagnosticsLabel = useMemo(() => {
    if (!diagnostics) {
      return null;
    }

    const now = Date.now();
    const ageSeconds =
      diagnostics.last_snapshot_at_ms > 0
        ? Math.max(0, Math.round((now - diagnostics.last_snapshot_at_ms) / 1000))
        : null;
    const ageText = ageSeconds === null ? "--" : `${ageSeconds}s`;
    return `采样 ${diagnostics.sampler_tick_count} 次 · 最近 ${ageText} · 交互 ${diagnostics.overlay_interactive ? "开" : "关"}`;
  }, [diagnostics]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  return (
    <main className={`shell theme-${theme} ${expanded ? "shell-expanded" : ""}`}>
      <section
        className={`widget ${expanded && expansionDirection === "up" ? "widget-expand-up" : "widget-expand-down"}`}
      >
        <StatusStrip
          expanded={expanded}
          collapsedHeight={collapsedHeight}
          collapsedWidth={collapsedWidth}
          statusTextRef={statusTextRef}
          onPointerDown={handleCollapsedPointerDown}
          onPointerMove={(event) => void handleCollapsedPointerMove(event)}
          onPointerUp={() => void handleCollapsedPointerUp()}
          onPointerCancel={resetCollapsedPointer}
          onResizeHandlePointerDown={(event) => void handleCollapsedResizeStart(event)}
          snapshot={snapshot}
        />

        <ControlCenter
          expanded={expanded}
          appVersion={appVersion}
          lastUpdated={lastUpdated}
          theme={theme}
          setTheme={setTheme}
          updateState={updateState}
          onCheckOrInstallUpdate={onCheckOrInstallUpdate}
          onCollapse={() => void toggleExpanded()}
          onHeaderPointerDown={(event) => void handleDragStart(event)}
          diagnosticsLabel={diagnosticsLabel}
          snapshot={snapshot}
          history={history}
        />

        {expanded ? (
          <div
            className="resize-handle resize-handle-expanded"
            role="presentation"
            onPointerDown={(event) => void handleExpandedResizeStart(event)}
          />
        ) : null}
      </section>
    </main>
  );
}

export default App;

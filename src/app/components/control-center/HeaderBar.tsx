import { useCallback } from "react";
import type React from "react";

type HeaderBarProps = {
  appVersion: string;
  lastUpdated: string;
  hasUpdate: boolean;
  clickThroughEnabled: boolean;
  onToggleClickThrough: () => void;
  onOpenUpdateModal: () => void;
  settingsMenu: React.ReactNode;
  onCollapse: () => void;
  onHeaderPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
};

export function HeaderBar({
  appVersion,
  lastUpdated,
  hasUpdate,
  clickThroughEnabled,
  onToggleClickThrough,
  onOpenUpdateModal,
  settingsMenu,
  onCollapse,
  onHeaderPointerDown,
}: HeaderBarProps) {
  const handleCollapseClick = useCallback(() => {
    onCollapse();
  }, [onCollapse]);

  return (
    <header className="widget-header">
      <div className="title-block" data-tauri-drag-region onPointerDown={onHeaderPointerDown}>
        <span className="eyebrow">Network Watch</span>
        <h1>控制中心</h1>
      </div>
      <div className="header-meta">
        <span>v{appVersion}</span>
        <span>{lastUpdated}</span>
        {settingsMenu}
        <button
          type="button"
          className={`expand-button ${clickThroughEnabled ? "primary-action-hot" : ""}`}
          data-tauri-drag-region="false"
          onClick={onToggleClickThrough}
        >
          穿透 {clickThroughEnabled ? "开" : "关"}
        </button>
        <button
          type="button"
          className={`expand-button expand-button-secondary ${hasUpdate ? "expand-button-has-update" : ""}`}
          data-tauri-drag-region="false"
          onClick={onOpenUpdateModal}
        >
          在线升级
          {hasUpdate ? <span className="update-dot" aria-hidden="true" /> : null}
        </button>
        <button type="button" className="expand-button" data-tauri-drag-region="false" onClick={handleCollapseClick}>
          收起
        </button>
      </div>
    </header>
  );
}


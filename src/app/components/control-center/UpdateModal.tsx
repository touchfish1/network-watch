import { useCallback } from "react";

import type { UpdateState } from "../../types";

type UpdateModalProps = {
  open: boolean;
  appVersion: string;
  updateState: UpdateState;
  showReleaseNotes: boolean;
  setShowReleaseNotes: (next: boolean) => void;
  onClose: () => void;
  onCheckOrInstallUpdate: () => void;
};

export function UpdateModal({
  open,
  appVersion,
  updateState,
  showReleaseNotes,
  setShowReleaseNotes,
  onClose,
  onCheckOrInstallUpdate,
}: UpdateModalProps) {
  const toggleReleaseNotes = useCallback(() => {
    setShowReleaseNotes(!showReleaseNotes);
  }, [setShowReleaseNotes, showReleaseNotes]);

  if (!open) {
    return null;
  }

  return (
    <div className="settings-modal" onClick={onClose}>
      <section
        className="settings-modal-panel update-modal-panel"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="settings-modal-header">
          <div>
            <span className="settings-label">在线升级</span>
            <strong>升级详情</strong>
          </div>
          <button type="button" className="expand-button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="settings-modal-content update-modal-content">
          <article className="settings-card settings-card-full update-card">
            <div className="settings-card-header">
              <div>
                <span className="settings-label">版本信息</span>
                <strong>自动下载并重启生效</strong>
              </div>
              <button
                type="button"
                className={`primary-action ${updateState.stage === "available" ? "primary-action-hot" : ""}`}
                disabled={updateState.stage === "checking" || updateState.stage === "downloading" || updateState.stage === "installing"}
                onClick={onCheckOrInstallUpdate}
              >
                {updateState.stage === "available"
                  ? "立即更新"
                  : updateState.stage === "checking"
                    ? "检查中…"
                    : updateState.stage === "downloading"
                      ? "下载中…"
                      : updateState.stage === "installing"
                        ? "安装中…"
                        : "检查更新"}
              </button>
            </div>
            <p className="settings-copy">{updateState.message}</p>
            <div className="update-meta">
              <span>当前版本 v{appVersion}</span>
              <span>{updateState.availableVersion ? `目标版本 v${updateState.availableVersion}` : "发布源：GitHub Release"}</span>
              {updateState.releaseNotes ? (
                <button type="button" className="link-button" onClick={toggleReleaseNotes}>
                  {showReleaseNotes ? "收起说明" : "更新说明"}
                </button>
              ) : null}
            </div>
            {updateState.releaseNotes && showReleaseNotes ? (
              <div className="release-notes">
                <p>{updateState.releaseNotes}</p>
              </div>
            ) : null}
          </article>
        </div>
      </section>
    </div>
  );
}

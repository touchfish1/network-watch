import { useCallback } from "react";

import type { UpdateState } from "../../types";

type UpdateCardProps = {
  appVersion: string;
  updateState: UpdateState;
  showReleaseNotes: boolean;
  setShowReleaseNotes: (next: boolean) => void;
  onCheckOrInstallUpdate: () => void;
  updateCardRef: React.RefObject<HTMLElement | null>;
};

export function UpdateCard({
  appVersion,
  updateState,
  showReleaseNotes,
  setShowReleaseNotes,
  onCheckOrInstallUpdate,
  updateCardRef,
}: UpdateCardProps) {
  const toggleReleaseNotes = useCallback(() => {
    setShowReleaseNotes(!showReleaseNotes);
  }, [setShowReleaseNotes, showReleaseNotes]);

  return (
    <article ref={updateCardRef} className="settings-card update-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">在线升级</span>
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
  );
}


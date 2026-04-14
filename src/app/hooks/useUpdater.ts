import { useCallback, useRef, useState } from "react";

import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update as AvailableUpdate } from "@tauri-apps/plugin-updater";

import type { UpdateState } from "../types";
import { formatProgress } from "../utils";

/**
 * 向 updater 插件发起一次更新检查（带轻量重试）。
 *
 * 设计原因：
 * - GitHub Release 的可见性/网络抖动会导致偶发失败\n+ * - 这里重试一次（短延迟）可以显著提升“自动轮询”场景的稳定性
 */
async function requestUpdateWithRetry() {
  try {
    return await check({ timeout: 15000 });
  } catch (firstError) {
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
    try {
      return await check({ timeout: 15000 });
    } catch {
      throw firstError;
    }
  }
}

const idleUpdateState: UpdateState = {
  stage: "idle",
  message: "点击检查更新，可自动下载并完成安装。",
};

/**
 * 管理“在线升级”的状态机与动作（检查/下载/安装/重启）。
 *
 * 约束：
 * - 仅桌面端真正可用；浏览器开发环境会给出友好错误\n+ * - `checkForUpdates({ silent: true })` 用于后台轮询：不打扰 UI（不进入 checking/latest/error 文案）
 */
export function useUpdater(isTauriEnv: boolean) {
  const [updateState, setUpdateState] = useState<UpdateState>(idleUpdateState);
  const availableUpdateRef = useRef<AvailableUpdate | null>(null);

  /**
   * 检查更新。
   *
   * - 默认会更新 UI 状态与文案\n+   * - `silent=true` 时只在有新版本时切到 `available`（用于定时轮询 + 小红点提示）
   */
  const checkForUpdates = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    if (!silent) {
      setUpdateState({
        stage: "checking",
        message: "正在检查 GitHub Release 更新…",
      });
    }

    try {
      const update = await requestUpdateWithRetry();
      availableUpdateRef.current = update;

      if (!update) {
        if (!silent) {
          setUpdateState({
            stage: "latest",
            message: "当前已经是最新版本。",
          });
        }
        return;
      }

      setUpdateState({
        stage: "available",
        availableVersion: update.version,
        releaseNotes: update.body,
        message: `检测到新版本 v${update.version}，点击后自动下载并安装。`,
      });
    } catch (error) {
      availableUpdateRef.current = null;
      if (!silent) {
        setUpdateState({
          stage: "error",
          message: `检查更新失败：${error instanceof Error ? error.message : String(error)}。如果刚发布新版本，可稍等片刻再试。`,
        });
      }
    }
  }, []);

  /**
   * 下载并安装更新，完成后 relaunch。
   *
   * 说明：
   * - 若之前 `checkForUpdates` 已发现新版本，会复用缓存的 update 对象\n+   * - 下载进度会更新到 `updateState`，用于 UI 展示
   */
  const installUpdate = useCallback(async () => {
    try {
      if (!isTauriEnv) {
        setUpdateState({
          stage: "error",
          message: "当前处于浏览器开发环境，在线升级仅在桌面应用内可用。",
        });
        return;
      }

      let update = availableUpdateRef.current;
      if (!update) {
        update = await requestUpdateWithRetry();
        availableUpdateRef.current = update;
      }

      if (!update) {
        setUpdateState({
          stage: "latest",
          message: "当前已经是最新版本。",
        });
        return;
      }

      let downloadedBytes = 0;
      let totalBytes = 0;

      setUpdateState({
        stage: "downloading",
        availableVersion: update.version,
        releaseNotes: update.body,
        message: "准备下载更新包…",
      });

      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength ?? 0;
          setUpdateState({
            stage: "downloading",
            availableVersion: update.version,
            releaseNotes: update.body,
            downloadedBytes,
            totalBytes,
            message: formatProgress(downloadedBytes, totalBytes),
          });
          return;
        }

        if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          setUpdateState({
            stage: "downloading",
            availableVersion: update.version,
            releaseNotes: update.body,
            downloadedBytes,
            totalBytes,
            message: formatProgress(downloadedBytes, totalBytes),
          });
          return;
        }

        setUpdateState({
          stage: "installing",
          availableVersion: update.version,
          releaseNotes: update.body,
          downloadedBytes,
          totalBytes,
          message: "安装完成，正在重启应用…",
        });
      });

      await relaunch();
    } catch (error) {
      setUpdateState({
        stage: "error",
        message: `安装更新失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [isTauriEnv]);

  return { updateState, checkForUpdates, installUpdate };
}


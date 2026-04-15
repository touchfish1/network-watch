import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import App from "./App";
import { SettingsWindow } from "./app/windows/SettingsWindow";
import "./index.css";

/**
 * 设置窗口用独立 label（`settings`）打开时，WebView 的 `location.search` 往往拿不到 `?window=settings`，
 * 仅靠 query 会误判成主界面，出现「空白窗」。以窗口 label 为准最可靠。
 */
function isSettingsBootstrap(): boolean {
  try {
    if (isTauri() && getCurrentWindow().label === "settings") {
      return true;
    }
  } catch {
    // 非 Tauri（例如纯浏览器预览）
  }

  const q = new URLSearchParams(window.location.search);
  if (q.get("window") === "settings") {
    return true;
  }

  const h = window.location.hash.replace(/^#\/?/, "");
  if (h === "settings") {
    return true;
  }

  return false;
}

const bootSettings = isSettingsBootstrap();

createRoot(document.getElementById("root")!).render(
  <StrictMode>{bootSettings ? <SettingsWindow /> : <App />}</StrictMode>,
);

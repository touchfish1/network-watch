import { useCallback, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { closeSettingsWindow } from "../tauri";

import { THEME_STORAGE_KEY } from "../constants";
import {
  formatIntervalLabel,
  loadUpdatePollIntervalMinutes,
  saveUpdatePollIntervalMinutes,
  type UpdatePollIntervalMinutes,
  updatePollIntervalOptionsMinutes,
} from "../config/settings";
import {
  defaultCardOrder,
  defaultCardVisibility,
  loadCardOrder,
  loadCardVisibility,
  saveCardOrder,
  saveCardVisibility,
  type CardId,
} from "../config/uiLayout";
import { themeDefinitions } from "../themes";

function useThemeClassName() {
  const theme = useMemo(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved && saved in themeDefinitions ? saved : "cyberpunk";
  }, []);
  return `theme-${theme}`;
}

export function SettingsWindow() {
  const themeClassName = useThemeClassName();
  const [updatePollIntervalMinutes, setUpdatePollIntervalMinutes] = useState<UpdatePollIntervalMinutes>(() =>
    loadUpdatePollIntervalMinutes(),
  );

  const [cardOrder, setCardOrder] = useState<CardId[]>(() => loadCardOrder());
  const [cardVisibility, setCardVisibility] = useState<Record<CardId, boolean>>(() => loadCardVisibility());

  const closeWindow = useCallback(() => {
    void (async () => {
      try {
        await closeSettingsWindow();
      } catch {
        try {
          await getCurrentWindow().close();
        } catch {
          // ignore
        }
      }
    })();
  }, []);

  const onIntervalChange = useCallback((minutes: UpdatePollIntervalMinutes) => {
    setUpdatePollIntervalMinutes(minutes);
    saveUpdatePollIntervalMinutes(minutes);
  }, []);

  const moveCard = useCallback((id: CardId, direction: -1 | 1) => {
    setCardOrder((current) => {
      const index = current.indexOf(id);
      if (index < 0) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      saveCardOrder(next);
      return next;
    });
  }, []);

  const toggleCard = useCallback((id: CardId) => {
    setCardVisibility((current) => {
      const next = { ...current, [id]: !current[id] };
      saveCardVisibility(next);
      return next;
    });
  }, []);

  const resetCards = useCallback(() => {
    setCardOrder(defaultCardOrder);
    setCardVisibility(defaultCardVisibility);
    saveCardOrder(defaultCardOrder);
    saveCardVisibility(defaultCardVisibility);
  }, []);

  return (
    <main className={`shell ${themeClassName} shell-settings`}>
      <div className="settings-window">
        <header className="settings-window-header" data-tauri-drag-region>
          <div className="settings-window-title">
            <div className="settings-window-eyebrow">Network Watch</div>
            <h1>设置</h1>
          </div>
          <button type="button" className="expand-button" data-tauri-drag-region="false" onClick={closeWindow}>
            关闭
          </button>
        </header>

        <section className="settings-window-content">
          <article className="settings-card">
            <div className="settings-card-header">
              <div>
                <span className="settings-label">在线升级</span>
                <strong>后台检查间隔</strong>
              </div>
              <span className="theme-current">{formatIntervalLabel(updatePollIntervalMinutes)}</span>
            </div>
            <div className="settings-popover-options">
              {updatePollIntervalOptionsMinutes.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  className={`settings-option ${minutes === updatePollIntervalMinutes ? "settings-option-active" : ""}`}
                  onClick={() => onIntervalChange(minutes)}
                >
                  {formatIntervalLabel(minutes)}
                </button>
              ))}
            </div>
            <p className="settings-copy">该设置仅影响后台静默检查更新的频率，不会打断 UI。</p>
          </article>

          <article className="settings-card layout-card">
            <div className="settings-card-header">
              <div>
                <span className="settings-label">布局设置</span>
                <strong>卡片顺序与显示</strong>
              </div>
              <button type="button" className="link-button" onClick={resetCards}>
                恢复默认
              </button>
            </div>
            <div className="kv-table">
              {cardOrder.map((id) => (
                <div key={id} className="kv-row">
                  <span className="kv-key">{id}</span>
                  <span className="kv-value">
                    <button type="button" className="link-button" onClick={() => toggleCard(id)}>
                      {cardVisibility[id] ? "显示" : "隐藏"}
                    </button>{" "}
                    <button type="button" className="link-button" onClick={() => moveCard(id, -1)}>
                      上移
                    </button>{" "}
                    <button type="button" className="link-button" onClick={() => moveCard(id, 1)}>
                      下移
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}


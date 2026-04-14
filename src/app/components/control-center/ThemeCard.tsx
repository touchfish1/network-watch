import type { ThemeId } from "../../types";
import { themeDefinitions } from "../../themes";

type ThemeCardProps = {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
};

export function ThemeCard({ theme, setTheme }: ThemeCardProps) {
  return (
    <article className="settings-card theme-card">
      <div className="settings-card-header">
        <div>
          <span className="settings-label">主题切换</span>
          <strong>让状态条有自己的气质</strong>
        </div>
        <span className="theme-current">{themeDefinitions[theme].name}</span>
      </div>
      <div className="theme-grid">
        {Object.entries(themeDefinitions).map(([themeKey, themeValue]) => (
          <button
            key={themeKey}
            type="button"
            className={`theme-tile ${theme === themeKey ? "theme-tile-active" : ""}`}
            onClick={() => setTheme(themeKey as ThemeId)}
          >
            <div className="theme-swatches">
              {themeValue.swatches.map((swatch) => (
                <span key={swatch} style={{ background: swatch }} />
              ))}
            </div>
            <strong>{themeValue.name}</strong>
            <span>{themeValue.mood}</span>
            <small>{themeValue.detail}</small>
          </button>
        ))}
      </div>
    </article>
  );
}


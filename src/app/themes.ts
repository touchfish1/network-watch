import type { ThemeDefinition, ThemeId } from "./types";

/**
 * 内置主题列表。
 *
 * 前端仅存储 `ThemeId`（localStorage），具体配色细节在 CSS 中通过 `.theme-*` 实现。
 */
export const themeDefinitions: Record<ThemeId, ThemeDefinition> = {
  cyberpunk: {
    name: "石墨深色",
    mood: "低饱和深灰、清晰对比、克制高亮",
    detail: "偏系统深色的工具风格，减少霓虹与材质渲染感。",
    swatches: ["#6ea8ff", "#a0aec0", "#0b1220"],
  },
  japanese: {
    name: "雾白浅色",
    mood: "温和白底、灰蓝点缀、阅读友好",
    detail: "更接近系统浅色 UI，强调可读性与层级。",
    swatches: ["#2b6cb0", "#718096", "#f7fafc"],
  },
  chinese: {
    name: "墨绿暖灰",
    mood: "暖灰底色、墨绿强调、少量橙色提示",
    detail: "偏稳重的监控工具配色，避免强烈装饰。",
    swatches: ["#2f855a", "#a0aec0", "#1a202c"],
  },
  western: {
    name: "海军蓝",
    mood: "深蓝基调、干净按钮、轻量阴影",
    detail: "更“产品化”的经典配色，减少复古材质感。",
    swatches: ["#2c5282", "#90cdf4", "#0f172a"],
  },
};


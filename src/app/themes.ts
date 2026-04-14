import type { ThemeDefinition, ThemeId } from "./types";

/**
 * 内置主题列表。
 *
 * 前端仅存储 `ThemeId`（localStorage），具体配色细节在 CSS 中通过 `.theme-*` 实现。
 */
export const themeDefinitions: Record<ThemeId, ThemeDefinition> = {
  cyberpunk: {
    name: "赛博朋克",
    mood: "霓虹洋红、冷青电流、深夜雨幕",
    detail: "参考高饱和霓虹对比与暗色赛博城市灯牌氛围。",
    swatches: ["#35f2ff", "#ff4fd8", "#0a1024"],
  },
  japanese: {
    name: "日式风格",
    mood: "靛青、朱红、和纸留白",
    detail: "参考日式传统配色中的藍色、朱色与纸感留白层次。",
    swatches: ["#223a5e", "#c24b3c", "#f3ead8"],
  },
  chinese: {
    name: "中国风",
    mood: "绛红、玉青、鎏金云纹",
    detail: "参考中式传统色中的胭脂红、玉色与金色器物质感。",
    swatches: ["#b6413c", "#2f8f83", "#d8ab4f"],
  },
  western: {
    name: "欧美风",
    mood: "海军蓝、皮革棕、黄铜复古",
    detail: "参考欧美复古海报与皮革黄铜材质的暖色层次。",
    swatches: ["#1c3254", "#8c5a3c", "#d6b36a"],
  },
};


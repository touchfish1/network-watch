import { useMemo } from "react";

import { buildPath } from "../utils";

/**
 * 迷你趋势线（0~N 点）。
 *
 * 注意：\n+ * - 该组件不做数据归一化；`buildPath` 会按当前序列的 max 做相对缩放\n+ * - 当 values 为空时绘制一条底线，避免 SVG path 为空导致渲染抖动
 */
type SparklineProps = {
  values: number[];
  tone: "cpu" | "memory" | "download" | "upload";
};

export function Sparkline({ values, tone }: SparklineProps) {
  const path = useMemo(() => buildPath(values), [values]);

  return (
    <svg className={`sparkline sparkline-${tone}`} viewBox="0 0 100 100" preserveAspectRatio="none">
      <path d={path || "M 0 100 L 100 100"} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}


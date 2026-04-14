import { useMemo } from "react";

import { buildPath } from "../utils";

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


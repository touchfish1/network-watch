import { useEffect, useRef } from "react";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { type ECharts, init, use } from "echarts/core";

use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const chart = init(el, undefined, { renderer: "canvas" });
    chartRef.current = chart;

    const resize = () => chart.resize();
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const el = rootRef.current;
    if (!chart || !el) return;

    const styles = getComputedStyle(el);
    const toneColor =
      tone === "cpu"
        ? styles.getPropertyValue("--cpu").trim()
        : tone === "memory"
          ? styles.getPropertyValue("--memory").trim()
          : tone === "download"
            ? styles.getPropertyValue("--download").trim()
            : styles.getPropertyValue("--upload").trim();

    const safeValues = values.length > 0 ? values : [0];
    const maxY = Math.max(1, ...safeValues);

    chart.setOption(
      {
        animation: false,
        grid: { left: 0, right: 0, top: 2, bottom: 2, containLabel: false },
        xAxis: {
          type: "category",
          show: false,
          boundaryGap: false,
          data: safeValues.map((_, idx) => idx),
        },
        yAxis: {
          type: "value",
          show: false,
          min: 0,
          max: maxY,
        },
        tooltip: {
          trigger: "axis",
          confine: true,
          backgroundColor: "rgba(2, 6, 23, 0.92)",
          borderColor: "rgba(255,255,255,0.14)",
          textStyle: { color: "rgba(245, 248, 255, 0.94)", fontSize: 11 },
          formatter: (params: any) => {
            const value = params?.[0]?.value;
            if (typeof value !== "number") return "—";
            if (tone === "cpu" || tone === "memory") return `${value.toFixed(1)}%`;
            const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
            let v = value;
            let i = 0;
            while (v >= 1024 && i < units.length - 1) {
              v /= 1024;
              i += 1;
            }
            return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
          },
        },
        series: [
          {
            type: "line",
            smooth: 0.28,
            symbol: "none",
            lineStyle: { color: toneColor || "#38bdf8", width: 3 },
            areaStyle: { color: toneColor || "#38bdf8", opacity: 0.1 },
            data: safeValues,
          },
        ],
      },
      { notMerge: true },
    );
  }, [tone, values]);

  return (
    <div ref={rootRef} className={`sparkline sparkline-${tone}`} />
  );
}


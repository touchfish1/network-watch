import { useEffect, useRef, useState } from "react";
import { LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { type ECharts, getInstanceByDom, init, use } from "echarts/core";

use([LineChart, GridComponent, TooltipComponent, CanvasRenderer]);

/**
 * 迷你趋势线（0~N 点）。
 *
 * 注意：\n+ * - 该组件不做数据归一化；`buildPath` 会按当前序列的 max 做相对缩放\n+ * - 当 values 为空时绘制一条底线，避免 SVG path 为空导致渲染抖动
 */
type SparklineProps = {
  values: number[];
  tone: "cpu" | "memory" | "download" | "upload";
  lowLoadMode?: boolean;
};

export function Sparkline({ values, tone, lowLoadMode = false }: SparklineProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const disposedRef = useRef(false);
  const throttleTimerRef = useRef<number | null>(null);
  const latestValuesRef = useRef<number[]>(values);
  const [displayValues, setDisplayValues] = useState<number[]>(values);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    disposedRef.current = false;

    try {
      const reused = getInstanceByDom(el);
      const chart = reused ?? init(el, undefined, { renderer: "canvas" });
      chartRef.current = chart;
    } catch {
      chartRef.current = null;
      return;
    }

    const resize = () => {
      const chart = chartRef.current;
      if (!chart || disposedRef.current) return;
      if (!el.isConnected || el.clientWidth <= 0 || el.clientHeight <= 0) return;
      try {
        chart.resize();
      } catch {
        // ignore transient resize errors for detached/hidden container
      }
    };
    window.addEventListener("resize", resize);
    const observer = new ResizeObserver(() => {
      resize();
    });
    observer.observe(el);

    return () => {
      disposedRef.current = true;
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      window.removeEventListener("resize", resize);
      observer.disconnect();
      try {
        chartRef.current?.dispose();
      } catch {
        // ignore
      }
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    latestValuesRef.current = values;
    if (!lowLoadMode) {
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      setDisplayValues(values);
      return;
    }
    if (throttleTimerRef.current !== null) {
      return;
    }
    throttleTimerRef.current = window.setTimeout(() => {
      throttleTimerRef.current = null;
      setDisplayValues(latestValuesRef.current);
    }, 2500);
    return () => {
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
    };
  }, [lowLoadMode, values]);

  useEffect(() => {
    const chart = chartRef.current;
    const el = rootRef.current;
    if (!chart || !el || disposedRef.current) return;

    const styles = getComputedStyle(el);
    const toneColor =
      tone === "cpu"
        ? styles.getPropertyValue("--cpu").trim()
        : tone === "memory"
          ? styles.getPropertyValue("--memory").trim()
          : tone === "download"
            ? styles.getPropertyValue("--download").trim()
            : styles.getPropertyValue("--upload").trim();

    const sanitized = displayValues
      .map((v) => (Number.isFinite(v) ? Number(v) : 0))
      .map((v) => (v < 0 ? 0 : v));
    const safeValues = sanitized.length > 0 ? sanitized : [0];
    const maxY = Math.max(1, ...safeValues);

    try {
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
            show: !lowLoadMode,
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
              smooth: lowLoadMode ? 0 : 0.28,
              symbol: "none",
              lineStyle: { color: toneColor || "#38bdf8", width: 3 },
              areaStyle: lowLoadMode ? undefined : { color: toneColor || "#38bdf8", opacity: 0.1 },
              data: safeValues,
            },
          ],
        },
        { notMerge: true },
      );
    } catch {
      // ignore transient chart render errors, next tick will retry
    }
  }, [displayValues, lowLoadMode, tone]);

  return (
    <div ref={rootRef} className={`sparkline sparkline-${tone}`} />
  );
}


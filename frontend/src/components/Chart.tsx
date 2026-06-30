import { useEffect, useRef } from "react";
import {
  createChart,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, Gap, SessionWindow, Trade } from "../api/client";
import { SessionPrimitive } from "./sessionPrimitive";

// Convert a tz-aware ISO string into a UNIX timestamp that, when rendered on the
// chart's UTC axis, shows the *session wall-clock* time. We strip the offset and
// reinterpret the local components as if they were UTC.
export function toChartTime(iso: string): UTCTimestamp {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0 as UTCTimestamp;
  const [, y, mo, d, h, mi, s] = m.map(Number) as unknown as number[];
  return (Date.UTC(y, mo - 1, d, h, mi, s) / 1000) as UTCTimestamp;
}

interface Props {
  candles: Candle[];
  gaps: Gap[];
  trades: Trade[];
  sessionWindows: SessionWindow[];
  precision: number;
}

export default function Chart({ candles, gaps, trades, sessionWindows, precision }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const sessionPrimitiveRef = useRef<SessionPrimitive | null>(null);

  // Create the chart once.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#0e1117" },
        textColor: "#c9d1d9",
      },
      grid: {
        vertLines: { color: "#1c2128" },
        horzLines: { color: "#1c2128" },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });
    const sessionPrimitive = new SessionPrimitive();
    series.attachPrimitive(sessionPrimitive);

    chartRef.current = chart;
    seriesRef.current = series;
    sessionPrimitiveRef.current = sessionPrimitive;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      sessionPrimitiveRef.current = null;
    };
  }, []);

  // Match the price axis decimals to the instrument (e.g. 5 dp for EURUSD).
  useEffect(() => {
    const dp = Math.max(2, precision);
    seriesRef.current?.applyOptions({
      priceFormat: { type: "price", precision: dp, minMove: Math.pow(10, -dp) },
    });
  }, [precision]);

  // Update session shading whenever the windows change.
  useEffect(() => {
    sessionPrimitiveRef.current?.setSpans(
      sessionWindows.map((w) => ({
        open: toChartTime(w.open_ts),
        close: toChartTime(w.close_ts),
      }))
    );
  }, [sessionWindows]);

  // Update data + markers whenever inputs change.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    series.setData(
      candles.map((c) => ({
        time: toChartTime(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
    );

    const markers: SeriesMarker<Time>[] = [];
    // Match the instrument's decimals so forex pips are visible (EURUSD 0.00012,
    // not a rounded 0.0).
    const dp = Math.max(2, precision);

    // Big-gap markers at the session open bar: the gap size and, alongside it, the
    // rolling average gap size (the baseline the big-gap threshold is built on).
    for (const g of gaps) {
      if (!g.is_big || !g.open_ts) continue;
      const avg = g.mean != null ? ` · avg ${g.mean.toFixed(dp)}` : "";
      markers.push({
        time: toChartTime(g.open_ts),
        position: g.direction === "up" ? "aboveBar" : "belowBar",
        color: "#f5a623",
        shape: g.direction === "up" ? "arrowDown" : "arrowUp",
        text: `gap ${g.gap?.toFixed(dp)}${avg}`,
      });
    }

    // Trade entry / exit markers.
    for (const t of trades) {
      const long = t.side === "long";
      markers.push({
        time: toChartTime(t.entry_ts),
        position: long ? "belowBar" : "aboveBar",
        color: long ? "#26a69a" : "#ef5350",
        shape: long ? "arrowUp" : "arrowDown",
        text: `${t.side} entry`,
      });
      markers.push({
        time: toChartTime(t.exit_ts),
        position: "aboveBar",
        color: t.pnl >= 0 ? "#3fb950" : "#d29922",
        shape: "circle",
        text: `exit ${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(1)} (${t.exit_reason})`,
      });
    }

    markers.sort((a, b) => (a.time as number) - (b.time as number));
    series.setMarkers(markers);
    chartRef.current?.timeScale().fitContent();
  }, [candles, gaps, trades, precision]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}

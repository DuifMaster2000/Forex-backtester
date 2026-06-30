// Stability / sensitivity sweep: vary one parameter (optionally split into a few
// series) and report a chosen metric across its range, so robustness can be
// eyeballed as a plateau vs. a single spike. Built on top of the grid engine.

import type { BacktestConfig, Bar } from "./types";
import { DEFAULT_SESSIONS } from "./sessions";
import { expandGrid, hhmmToHours, type GridSpec, type NumRange } from "./grid";
import { getSession } from "./sessions";
import { runBacktest } from "./backtest";
import { parseHHMM } from "./followFilters";

// The base config's first entry time as hours-after-open (the neutral fixed value
// when entry_time isn't the swept parameter). Falls back to 0.
function baseEntryHour(base: BacktestConfig): number {
  return entryHoursAfterOpen(base);
}

// A follow config's entry time expressed as hours after the session open (0..24),
// the duration the entry_time sweep ranges over. Inverse of the grid's resolution.
function entryHoursAfterOpen(config: BacktestConfig): number {
  const clock = (parseHHMM(config.entry_times[0] ?? "") ?? 0) / 60;
  const open = hhmmToHours(getSession(config.session).open_time);
  return ((clock - open) % 24 + 24) % 24;
}

export type SweepParam =
  | "entry_delay"
  | "entry_time"
  | "entry_timeout"
  | "time_stop"
  | "gap_window"
  | "gap_sigma"
  | "sl_value"
  | "tp_value";

export type SweepMetric =
  | "total_pnl"
  | "return_dd"
  | "profit_factor"
  | "total_r"
  | "win_rate"
  | "expectancy"
  | "trades";

export type SeriesBy = "none" | "direction" | "session";

export interface SweepSpec {
  param: SweepParam;
  min: number;
  max: number;
  step: number;
  series: SeriesBy;
  metric: SweepMetric;
}

export interface SweepSeries {
  label: string;
  points: { x: number; y: number | null }[];
}

export interface SweepResult {
  series: SweepSeries[];
  param: SweepParam;
  metric: SweepMetric;
}

export const PARAM_LABELS: Record<SweepParam, string> = {
  entry_delay: "Entry delay (h)",
  entry_time: "Entry: hrs after open",
  entry_timeout: "Wait timeout (h)",
  time_stop: "Time stop (h)",
  gap_window: "Gap window",
  gap_sigma: "Gap sigma",
  sl_value: "Stop loss",
  tp_value: "Take profit",
};

export const METRIC_LABELS: Record<SweepMetric, string> = {
  total_pnl: "Total P/L",
  return_dd: "Return / Max DD",
  profit_factor: "Profit factor",
  total_r: "Total R",
  win_rate: "Win rate %",
  expectancy: "Expectancy",
  trades: "Trades",
};

function fixed(value: number): NumRange {
  return { vary: false, fixed: value, min: value, max: value, step: 1 };
}

function varied(spec: SweepSpec): NumRange {
  return { vary: true, fixed: spec.min, min: spec.min, max: spec.max, step: spec.step };
}

// Translate the base config + sweep selection into a one-parameter grid.
function buildGridSpec(base: BacktestConfig, spec: SweepSpec): GridSpec {
  const p = spec.param;
  const isFollow = base.strategy === "follow_filters";
  return {
    strategy: base.strategy,
    sessions: spec.series === "session" ? DEFAULT_SESSIONS.map((s) => s.name) : [base.session],
    // follow_filters is follow-only, so the "direction" series collapses to follow.
    directions: spec.series === "direction" && !isFollow ? ["fade", "follow"] : [base.direction],
    gapWindow: p === "gap_window" ? varied(spec) : fixed(base.gap_window),
    gapSigma: p === "gap_sigma" ? varied(spec) : fixed(base.gap_sigma),
    entryOffsetHours:
      p === "entry_delay" ? varied(spec) : fixed(base.entry_offset_minutes / 60),
    entryTimes: base.entry_times,
    // When not sweeping entry_time, leave entryTime non-varying so the fixed
    // entryTimes list above is used (its value is then irrelevant).
    entryTime: p === "entry_time" ? varied(spec) : fixed(baseEntryHour(base)),
    entryTime2: fixed(0), // the stability sweep varies a single parameter only
    entryTimeout: p === "entry_timeout" ? varied(spec) : fixed(base.entry_timeout_minutes / 60),
    timeStop: {
      enabled: base.time_stop_minutes != null || p === "time_stop",
      ...(p === "time_stop" ? varied(spec) : fixed((base.time_stop_minutes ?? 1440) / 60)),
    },
    sl: {
      enabled: base.stop_loss != null || p === "sl_value",
      mode: base.stop_loss?.mode ?? "adr_multiple",
      ...(p === "sl_value" ? varied(spec) : fixed(base.stop_loss?.value ?? 0.5)),
    },
    tp: {
      enabled: base.take_profit != null || p === "tp_value",
      mode: base.take_profit?.mode ?? "adr_multiple",
      ...(p === "tp_value" ? varied(spec) : fixed(base.take_profit?.value ?? 1.0)),
    },
    spread: base.spread, // carry the base's spread through the sweep
    rankBy: "total_pnl",
  };
}

export function extractX(config: BacktestConfig, param: SweepParam): number {
  switch (param) {
    case "entry_delay":
      return config.entry_offset_minutes / 60;
    case "entry_time":
      return entryHoursAfterOpen(config);
    case "entry_timeout":
      return config.entry_timeout_minutes / 60;
    case "time_stop":
      return (config.time_stop_minutes ?? 0) / 60;
    case "gap_window":
      return config.gap_window;
    case "gap_sigma":
      return config.gap_sigma;
    case "sl_value":
      return config.stop_loss?.value ?? 0;
    case "tp_value":
      return config.take_profit?.value ?? 0;
  }
}

export function getMetric(
  m: {
    total_pnl: number;
    max_drawdown: number;
    profit_factor: number | null;
    total_r: number | null;
    win_rate: number;
    expectancy: number;
    trades: number;
  },
  metric: SweepMetric
): number | null {
  switch (metric) {
    case "total_pnl":
      return m.total_pnl;
    case "return_dd":
      // Plotting: leave undefined (no drawdown yet) as a gap in the line.
      return m.max_drawdown > 0 ? m.total_pnl / m.max_drawdown : null;
    case "profit_factor":
      return m.profit_factor;
    case "total_r":
      return m.total_r;
    case "win_rate":
      return m.win_rate * 100;
    case "expectancy":
      return m.expectancy;
    case "trades":
      return m.trades;
  }
}

function seriesLabel(config: BacktestConfig, by: SeriesBy): string {
  return by === "session" ? config.session : config.direction;
}

export function runSweep(bars: Bar[], base: BacktestConfig, spec: SweepSpec): SweepResult {
  const configs = expandGrid(buildGridSpec(base, spec));
  const lines = new Map<string, { x: number; y: number | null }[]>();

  for (const config of configs) {
    const metrics = runBacktest(bars, getSession(config.session), config).metrics;
    const label =
      spec.series === "none" ? METRIC_LABELS[spec.metric] : seriesLabel(config, spec.series);
    if (!lines.has(label)) lines.set(label, []);
    lines.get(label)!.push({ x: extractX(config, spec.param), y: getMetric(metrics, spec.metric) });
  }

  const series: SweepSeries[] = [...lines.entries()].map(([label, points]) => ({
    label,
    points: points.sort((a, b) => a.x - b.x),
  }));
  return { series, param: spec.param, metric: spec.metric };
}

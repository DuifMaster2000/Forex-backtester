// Brute-force / grid-search optimiser: expand a parameter grid into individual
// backtest configs, run them all, and rank by a chosen metric.
//
// Runs entirely client-side (so it works on the static site). Large grids are
// processed in chunks with progress callbacks so the UI stays responsive.

import type { BacktestConfig, Bar, Metrics, PriceLevel } from "./types";
import { getSession } from "./sessions";
import { runBacktest } from "./backtest";

export interface NumRange {
  vary: boolean;
  fixed: number;
  min: number;
  max: number;
  step: number;
}

export type LevelMode = PriceLevel["mode"];
export type RankMetric = "total_r" | "total_pnl" | "profit_factor" | "win_rate" | "expectancy";

export interface GridSpec {
  sessions: string[];
  directions: ("fade" | "follow")[];
  gapWindow: NumRange;
  gapSigma: NumRange;
  entryOffsetHours: NumRange;
  timeStop: { enabled: boolean } & NumRange; // hours
  sl: { enabled: boolean; mode: LevelMode } & NumRange;
  tp: { enabled: boolean; mode: LevelMode } & NumRange;
  rankBy: RankMetric;
}

export interface GridResult {
  config: BacktestConfig;
  metrics: Metrics;
}

// Expand a NumRange into its values (inclusive of max, with float tolerance).
export function rangeValues(r: NumRange): number[] {
  if (!r.vary) return [r.fixed];
  if (r.step <= 0 || r.max < r.min) return [r.min];
  const out: number[] = [];
  const eps = r.step * 1e-6;
  for (let v = r.min; v <= r.max + eps; v += r.step) {
    out.push(Number(v.toFixed(6)));
  }
  return out;
}

// All backtest configs implied by the grid (the Cartesian product).
export function expandGrid(spec: GridSpec): BacktestConfig[] {
  const gapWindows = rangeValues(spec.gapWindow).map((v) => Math.round(v));
  const gapSigmas = rangeValues(spec.gapSigma);
  const entryOffsets = rangeValues(spec.entryOffsetHours).map((h) => Math.round((h * 60) / 30) * 30);
  const timeStops = spec.timeStop.enabled
    ? rangeValues(spec.timeStop).map((h) => Math.round((h * 60) / 30) * 30)
    : [null];
  const slValues: (PriceLevel | null)[] = spec.sl.enabled
    ? rangeValues(spec.sl).map((v) => ({ mode: spec.sl.mode, value: v }))
    : [null];
  const tpValues: (PriceLevel | null)[] = spec.tp.enabled
    ? rangeValues(spec.tp).map((v) => ({ mode: spec.tp.mode, value: v }))
    : [null];

  const configs: BacktestConfig[] = [];
  for (const session of spec.sessions) {
    for (const direction of spec.directions) {
      for (const gap_window of gapWindows) {
        for (const gap_sigma of gapSigmas) {
          for (const entry_offset_minutes of entryOffsets) {
            for (const time_stop_minutes of timeStops) {
              for (const stop_loss of slValues) {
                for (const take_profit of tpValues) {
                  configs.push({
                    session,
                    gap_window,
                    gap_sigma,
                    direction,
                    entry_offset_minutes,
                    adr_window: 20,
                    stop_loss,
                    take_profit,
                    time_stop_minutes,
                    intrabar: "stop_first",
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return configs;
}

export function countGrid(spec: GridSpec): number {
  return expandGridSizes(spec).reduce((a, b) => a * b, 1);
}

function expandGridSizes(spec: GridSpec): number[] {
  return [
    spec.sessions.length || 1,
    spec.directions.length || 1,
    rangeValues(spec.gapWindow).length,
    rangeValues(spec.gapSigma).length,
    rangeValues(spec.entryOffsetHours).length,
    spec.timeStop.enabled ? rangeValues(spec.timeStop).length : 1,
    spec.sl.enabled ? rangeValues(spec.sl).length : 1,
    spec.tp.enabled ? rangeValues(spec.tp).length : 1,
  ];
}

export function metricValue(m: Metrics, rankBy: RankMetric): number {
  switch (rankBy) {
    case "total_r":
      return m.total_r ?? -Infinity;
    case "total_pnl":
      return m.total_pnl;
    case "profit_factor":
      return m.profit_factor ?? -Infinity;
    case "win_rate":
      return m.win_rate;
    case "expectancy":
      return m.expectancy;
  }
}

function configKey(c: BacktestConfig): string {
  return [
    c.session, c.direction, c.gap_window, c.gap_sigma, c.entry_offset_minutes,
    c.time_stop_minutes, c.stop_loss?.mode, c.stop_loss?.value,
    c.take_profit?.mode, c.take_profit?.value,
  ].join("|");
}

// Rank best-first by the metric, with a deterministic config tiebreak so the
// result order is stable regardless of how the work was split across workers.
export function compareResults(a: GridResult, b: GridResult, rankBy: RankMetric): number {
  const d = metricValue(b.metrics, rankBy) - metricValue(a.metrics, rankBy);
  if (d !== 0) return d;
  const ka = configKey(a.config);
  const kb = configKey(b.config);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// Run every config, ranked best-first by the chosen metric. Chunked so the event
// loop (and progress UI) keeps ticking; `onProgress(done, total)` is called per chunk.
export async function runGrid(
  bars: Bar[],
  spec: GridSpec,
  onProgress?: (done: number, total: number) => void,
  chunkSize = 150
): Promise<GridResult[]> {
  const configs = expandGrid(spec);
  const total = configs.length;
  const results: GridResult[] = [];

  for (let i = 0; i < total; i++) {
    const config = configs[i];
    const metrics = runBacktest(bars, getSession(config.session), config).metrics;
    metrics.equity_curve = []; // not used by the optimiser report; saves memory
    results.push({ config, metrics });
    if ((i + 1) % chunkSize === 0) {
      onProgress?.(i + 1, total);
      // Yield to the event loop so the UI can repaint.
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(total, total);

  results.sort((a, b) => compareResults(a, b, spec.rankBy));
  return results;
}

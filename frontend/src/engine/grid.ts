// Brute-force / grid-search optimiser: expand a parameter grid into individual
// backtest configs, run them all, and rank by a chosen metric.
//
// Runs entirely client-side (so it works on the static site). Large grids are
// processed in chunks with progress callbacks so the UI stays responsive.

import type { BacktestConfig, Bar, Metrics, PriceLevel, Strategy } from "./types";
import { getSession } from "./sessions";
import { runBacktest } from "./backtest";

// Wait timeout used for base-strategy configs (where it's irrelevant): 48h.
const DEFAULT_ENTRY_TIMEOUT_MIN = 2880;

export interface NumRange {
  vary: boolean;
  fixed: number;
  min: number;
  max: number;
  step: number;
}

export type LevelMode = PriceLevel["mode"];
export type RankMetric =
  | "total_r"
  | "total_pnl"
  | "return_dd"
  | "profit_factor"
  | "win_rate"
  | "expectancy";

export interface GridSpec {
  strategy: Strategy;
  sessions: string[];
  directions: ("fade" | "follow")[];
  gapWindow: NumRange;
  gapSigma: NumRange;
  entryOffsetHours: NumRange; // base strategy only
  entryTimes: string[]; // follow_filters: fixed list of entry times ("HH:MM")
  entryTimeout: NumRange; // follow_filters: wait timeout in hours
  timeStop: { enabled: boolean } & NumRange; // hours
  sl: { enabled: boolean; mode: LevelMode } & NumRange;
  tp: { enabled: boolean; mode: LevelMode } & NumRange;
  spread: number; // static round-trip cost in price units, applied to every config
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

// Value lists for each grid axis. follow_filters varies the wait timeout (not the
// entry offset) and follows only; base varies the entry offset and fade/follow.
// The unused axis collapses to length 1 so it doesn't inflate the product.
function gridAxes(spec: GridSpec) {
  const isFollow = spec.strategy === "follow_filters";
  const toMinutes = (h: number) => Math.round((h * 60) / 30) * 30;
  const directions: ("fade" | "follow")[] = isFollow
    ? ["follow"]
    : spec.directions.length
    ? spec.directions
    : ["fade"];
  return {
    isFollow,
    directions,
    gapWindows: rangeValues(spec.gapWindow).map((v) => Math.round(v)),
    gapSigmas: rangeValues(spec.gapSigma),
    entryOffsets: isFollow ? [0] : rangeValues(spec.entryOffsetHours).map(toMinutes),
    entryTimeouts: isFollow ? rangeValues(spec.entryTimeout).map(toMinutes) : [DEFAULT_ENTRY_TIMEOUT_MIN],
    timeStops: spec.timeStop.enabled
      ? rangeValues(spec.timeStop).map(toMinutes)
      : [null as number | null],
    slValues: (spec.sl.enabled
      ? rangeValues(spec.sl).map((v) => ({ mode: spec.sl.mode, value: v }))
      : [null]) as (PriceLevel | null)[],
    tpValues: (spec.tp.enabled
      ? rangeValues(spec.tp).map((v) => ({ mode: spec.tp.mode, value: v }))
      : [null]) as (PriceLevel | null)[],
  };
}

// All backtest configs implied by the grid (the Cartesian product).
export function expandGrid(spec: GridSpec): BacktestConfig[] {
  const ax = gridAxes(spec);
  const spread = Number.isFinite(spec.spread) ? spec.spread : 0;
  const entryTimes = ax.isFollow ? spec.entryTimes : [];

  const configs: BacktestConfig[] = [];
  for (const session of spec.sessions) {
    for (const direction of ax.directions) {
      for (const gap_window of ax.gapWindows) {
        for (const gap_sigma of ax.gapSigmas) {
          for (const entry_offset_minutes of ax.entryOffsets) {
            for (const entry_timeout_minutes of ax.entryTimeouts) {
              for (const time_stop_minutes of ax.timeStops) {
                for (const stop_loss of ax.slValues) {
                  for (const take_profit of ax.tpValues) {
                    configs.push({
                      strategy: spec.strategy,
                      session,
                      gap_window,
                      gap_sigma,
                      direction,
                      entry_offset_minutes,
                      entry_times: entryTimes,
                      entry_timeout_minutes,
                      adr_window: 20,
                      stop_loss,
                      take_profit,
                      time_stop_minutes,
                      intrabar: "stop_first",
                      spread,
                    });
                  }
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
  const ax = gridAxes(spec);
  return [
    spec.sessions.length || 1,
    ax.directions.length,
    ax.gapWindows.length,
    ax.gapSigmas.length,
    ax.entryOffsets.length,
    ax.entryTimeouts.length,
    ax.timeStops.length,
    ax.slValues.length,
    ax.tpValues.length,
  ].reduce((a, b) => a * b, 1);
}

export function metricValue(m: Metrics, rankBy: RankMetric): number {
  switch (rankBy) {
    case "total_r":
      return m.total_r ?? -Infinity;
    case "total_pnl":
      return m.total_pnl;
    case "return_dd":
      return returnOverDrawdown(m);
    case "profit_factor":
      return m.profit_factor ?? -Infinity;
    case "win_rate":
      return m.win_rate;
    case "expectancy":
      return m.expectancy;
  }
}

// Total P/L per unit of max drawdown (a.k.a. MAR ratio) — "how much gain for the
// pain". When there's no drawdown, a profitable run ranks at the top and a
// non-profitable one at the bottom. A finite sentinel (not Infinity) keeps the
// difference-based sort well-defined.
export function returnOverDrawdown(m: Metrics): number {
  if (m.max_drawdown > 0) return m.total_pnl / m.max_drawdown;
  return m.total_pnl > 0 ? Number.MAX_VALUE : 0;
}

function configKey(c: BacktestConfig): string {
  return [
    c.strategy, c.session, c.direction, c.gap_window, c.gap_sigma, c.entry_offset_minutes,
    c.entry_timeout_minutes, c.time_stop_minutes, c.stop_loss?.mode, c.stop_loss?.value,
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

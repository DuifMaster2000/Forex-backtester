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
  // follow_filters: when varied, sweep an entry time as hours after the session
  // open (0..24); when not varied, the fixed entryTimes list above is used.
  entryTime: NumRange;
  // follow_filters: when entryTime is swept AND this is varied, add a second swept
  // entry time (hours after open). Configs then carry a two-element entry_times
  // list — two chances per cycle, first qualifying taken. Combos = time1 × time2.
  entryTime2: NumRange;
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

// Hours-of-day -> "HH:MM", snapped to the 30-min bar grid and wrapped to a day
// (9.5 -> "09:30", 25.5 -> "01:30"). Wrapping lets a "hours after open" duration
// that crosses midnight resolve to the right clock time the next day.
export function hoursToHHMM(hours: number): string {
  const m = Math.round((hours * 60) / 30) * 30;
  const hh = Math.floor(m / 60) % 24;
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

// "HH:MM" -> hours-of-day (e.g. "09:30" -> 9.5).
export function hhmmToHours(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h + m / 60;
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
  // When swept, the entry time is a duration in *hours after the session open*
  // (0..24), so it can cross midnight into the next day — the actual clock time is
  // resolved per session in expandGrid (each session opens at a different hour).
  // When not swept, the fixed entry_times list is used as-is.
  const entryDurations: number[] | null =
    isFollow && spec.entryTime.vary ? rangeValues(spec.entryTime) : null;
  // Optional second swept entry time (only when the first is being swept).
  const entryDurations2: number[] | null =
    entryDurations && spec.entryTime2.vary ? rangeValues(spec.entryTime2) : null;
  return {
    isFollow,
    directions,
    entryDurations,
    entryDurations2,
    entryTimesLen: (entryDurations ? entryDurations.length : 1) * (entryDurations2 ? entryDurations2.length : 1),
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

  const configs: BacktestConfig[] = [];
  for (const session of spec.sessions) {
    // Resolve the entry-time axis for this session: swept durations become clock
    // times anchored to *this* session's open; otherwise use the fixed list. With
    // a second swept time, each config carries both (ordered by time of day).
    const openHours = hhmmToHours(getSession(session).open_time);
    const toClock = (h: number) => hoursToHHMM(openHours + h);
    let entryTimesAxis: string[][];
    if (ax.entryDurations && ax.entryDurations2) {
      entryTimesAxis = [];
      for (const h1 of ax.entryDurations) {
        for (const h2 of ax.entryDurations2) {
          entryTimesAxis.push(h1 <= h2 ? [toClock(h1), toClock(h2)] : [toClock(h2), toClock(h1)]);
        }
      }
    } else if (ax.entryDurations) {
      entryTimesAxis = ax.entryDurations.map((h) => [toClock(h)]);
    } else {
      entryTimesAxis = [ax.isFollow ? spec.entryTimes : []];
    }
    for (const direction of ax.directions) {
      for (const gap_window of ax.gapWindows) {
        for (const gap_sigma of ax.gapSigmas) {
          for (const entry_offset_minutes of ax.entryOffsets) {
            for (const entry_times of entryTimesAxis) {
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
                        entry_times,
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
    ax.entryTimesLen,
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
    c.entry_times.join("/"), c.entry_timeout_minutes, c.time_stop_minutes, c.stop_loss?.mode, c.stop_loss?.value,
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

// Position simulation + metrics. Mirrors backend/app/backtest/engine.py and metrics.py.

import type {
  Bar,
  BacktestConfig,
  BacktestResult,
  Gap,
  Metrics,
  PriceLevel,
  Session,
  Trade,
} from "./types";
import { computeGaps } from "./gap";
import { sessionBars } from "./sessions";
import { zonedParts, wallClockISO } from "./tz";

function levelDistance(level: PriceLevel, entryPrice: number, gapAbs: number): number {
  if (level.mode === "points") return level.value;
  if (level.mode === "percent") return (entryPrice * level.value) / 100;
  return gapAbs * level.value; // gap_multiple
}

function sideFor(direction: "fade" | "follow", gapDir: "up" | "down"): number {
  if (direction === "fade") return gapDir === "up" ? -1 : 1;
  return gapDir === "up" ? 1 : -1;
}

function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

export function runBacktest(
  bars: Bar[],
  session: Session,
  config: BacktestConfig
): BacktestResult {
  const gaps = computeGaps(bars, session, config.gap_window, config.gap_sigma);
  const signals = gaps.filter((g) => g.is_big);

  // Precompute lookups: bar index by ms, and session-zone minutes-of-day per bar.
  const indexByMs = new Map<number, number>();
  const minutesOfDay = new Array<number>(bars.length);
  for (let i = 0; i < bars.length; i++) {
    indexByMs.set(bars[i].ms, i);
    minutesOfDay[i] = zonedParts(bars[i].ms, session.tz).minutesOfDay;
  }
  // Map each session day to its exact open-bar ms (robust signal -> bar lookup).
  const openMsByDate = new Map<string, number>();
  for (const d of sessionBars(bars, session)) openMsByDate.set(d.date, d.openMs);

  const trades: Trade[] = [];
  for (const sig of signals) {
    const t = simulateTrade(bars, indexByMs, minutesOfDay, openMsByDate, session, config, sig);
    if (t) trades.push(t);
  }

  return { trades, metrics: summarize(trades), signals: signals.length };
}

function simulateTrade(
  bars: Bar[],
  indexByMs: Map<number, number>,
  minutesOfDay: number[],
  openMsByDate: Map<string, number>,
  session: Session,
  config: BacktestConfig,
  sig: Gap
): Trade | null {
  // Locate the signal's session open bar exactly by its day key.
  const openMs = openMsByDate.get(sig.date);
  if (openMs == null) return null;
  const loc = indexByMs.get(openMs)!;
  const entryLoc = loc + config.entry_offset_bars;
  if (entryLoc >= bars.length) return null;

  const side = sideFor(config.direction, sig.direction);
  const entryBar = bars[entryLoc];
  const entryPrice = entryBar.open;
  const gapAbs = sig.abs_gap ?? 0;

  const slDist = config.stop_loss ? levelDistance(config.stop_loss, entryPrice, gapAbs) : null;
  const tpDist = config.take_profit
    ? levelDistance(config.take_profit, entryPrice, gapAbs)
    : null;
  const slPrice = slDist != null ? entryPrice - side * slDist : null;
  const tpPrice = tpDist != null ? entryPrice + side * tpDist : null;

  const stopAtMin = config.time_stop_at ? hhmmToMinutes(config.time_stop_at) : null;
  const maxBar = config.time_stop_bars != null ? entryLoc + config.time_stop_bars : null;

  let exitPrice: number | null = null;
  let exitMs = 0;
  let exitReason = "";

  for (let j = entryLoc; j < bars.length; j++) {
    const bar = bars[j];
    const hitSl =
      slPrice != null &&
      ((side === 1 && bar.low <= slPrice) || (side === -1 && bar.high >= slPrice));
    const hitTp =
      tpPrice != null &&
      ((side === 1 && bar.high >= tpPrice) || (side === -1 && bar.low <= tpPrice));

    if (hitSl && hitTp) {
      if (config.intrabar === "stop_first") {
        exitPrice = slPrice;
        exitReason = "stop_loss";
      } else {
        exitPrice = tpPrice;
        exitReason = "take_profit";
      }
      exitMs = bar.ms;
      break;
    }
    if (hitSl) {
      exitPrice = slPrice;
      exitReason = "stop_loss";
      exitMs = bar.ms;
      break;
    }
    if (hitTp) {
      exitPrice = tpPrice;
      exitReason = "take_profit";
      exitMs = bar.ms;
      break;
    }

    // Time-based exits, evaluated at bar close.
    if (maxBar != null && j >= maxBar) {
      exitPrice = bar.close;
      exitReason = "time_stop_bars";
      exitMs = bar.ms;
      break;
    }
    if (stopAtMin != null && minutesOfDay[j] >= stopAtMin && j > entryLoc) {
      exitPrice = bar.close;
      exitReason = "time_stop_at";
      exitMs = bar.ms;
      break;
    }
  }

  if (exitPrice == null) {
    const last = bars[bars.length - 1];
    exitPrice = last.close;
    exitReason = "end_of_data";
    exitMs = last.ms;
  }

  const pnl = side * (exitPrice - entryPrice);
  const rMultiple = slDist ? pnl / slDist : null;

  return {
    signal_date: sig.date,
    side: side === 1 ? "long" : "short",
    gap: sig.gap ?? 0,
    entry_ts: wallClockISO(entryBar.ms, session.tz),
    entry_price: round(entryPrice, 5),
    exit_ts: wallClockISO(exitMs, session.tz),
    exit_price: round(exitPrice, 5),
    exit_reason: exitReason,
    pnl: round(pnl, 5),
    r_multiple: rMultiple != null ? round(rMultiple, 3) : null,
  };
}

export function summarize(trades: Trade[]): Metrics {
  const n = trades.length;
  if (n === 0) {
    return {
      trades: 0, wins: 0, losses: 0, win_rate: 0, total_pnl: 0, avg_pnl: 0,
      expectancy: 0, profit_factor: null, max_drawdown: 0, avg_win: 0,
      avg_loss: 0, equity_curve: [],
    };
  }

  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);

  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  const curve: { exit_ts: string; equity: number }[] = [];
  for (const t of trades) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    curve.push({ exit_ts: t.exit_ts, equity: round(equity, 5) });
  }

  const total = pnls.reduce((a, b) => a + b, 0);
  return {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    win_rate: round(wins.length / n, 4),
    total_pnl: round(total, 5),
    avg_pnl: round(total / n, 5),
    expectancy: round(total / n, 5),
    profit_factor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : null,
    max_drawdown: round(maxDd, 5),
    avg_win: wins.length ? round(grossWin / wins.length, 5) : 0,
    avg_loss: losses.length ? round(losses.reduce((a, b) => a + b, 0) / losses.length, 5) : 0,
    equity_curve: curve,
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

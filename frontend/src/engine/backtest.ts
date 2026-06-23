// Position simulation + metrics. Mirrors backend/app/backtest/engine.py and metrics.py.

import type {
  Bar,
  BacktestConfig,
  BacktestResult,
  Gap,
  Metrics,
  PriceLevel,
  Session,
  SideStats,
  Trade,
} from "./types";
import { computeGaps } from "./gap";
import { sessionBars } from "./sessions";
import { dailyRanges, adrBefore, type DayRange } from "./adr";
import { DISPLAY_TZ, wallClockISO, zonedParts } from "./tz";

// Distance from entry implied by a price level. Returns null when the level can't
// be sized (e.g. adr_multiple with no prior-day history) so it's treated as unset.
function levelDistance(
  level: PriceLevel,
  entryPrice: number,
  gapAbs: number,
  adr: number | null
): number | null {
  switch (level.mode) {
    case "points":
      return level.value;
    case "percent":
      return (entryPrice * level.value) / 100;
    case "gap_multiple":
      return gapAbs * level.value;
    case "adr_multiple":
      return adr == null ? null : adr * level.value;
  }
}

function sideFor(direction: "fade" | "follow", gapDir: "up" | "down"): number {
  if (direction === "fade") return gapDir === "up" ? -1 : 1;
  return gapDir === "up" ? 1 : -1;
}

// Most common gap between consecutive bars, in minutes. Used to convert the
// minute-based entry/time-stop durations into trading-bar counts.
function barStepMinutes(bars: Bar[]): number {
  if (bars.length < 2) return 30;
  const counts = new Map<number, number>();
  for (let i = 1; i < bars.length; i++) {
    const d = Math.round((bars[i].ms - bars[i - 1].ms) / 60_000);
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let modal = 30;
  let best = -1;
  for (const [d, c] of counts) {
    if (c > best) {
      best = c;
      modal = d;
    }
  }
  return modal;
}

export function runBacktest(
  bars: Bar[],
  session: Session,
  config: BacktestConfig
): BacktestResult {
  const gaps = computeGaps(bars, session, config.gap_window, config.gap_sigma);
  const signals = gaps.filter((g) => g.is_big);

  // Bar index by timestamp, for fast lookups.
  const indexByMs = new Map<number, number>();
  for (let i = 0; i < bars.length; i++) indexByMs.set(bars[i].ms, i);
  // Map each session day to its exact open-bar ms (robust signal -> bar lookup).
  const openMsByDate = new Map<string, number>();
  for (const d of sessionBars(bars, session)) openMsByDate.set(d.date, d.openMs);
  // Daily ranges (NY axis) for ADR-based stops.
  const ranges = dailyRanges(bars, DISPLAY_TZ);
  // Entry/time-stop durations are counted in trading bars so weekends and
  // closures (which have no bars) don't consume the budget.
  const stepMinutes = barStepMinutes(bars);

  const trades: Trade[] = [];
  for (const sig of signals) {
    const t = simulateTrade(bars, indexByMs, openMsByDate, ranges, stepMinutes, config, sig);
    if (t) trades.push(t);
  }

  return { trades, metrics: summarize(trades), signals: signals.length };
}

function simulateTrade(
  bars: Bar[],
  indexByMs: Map<number, number>,
  openMsByDate: Map<string, number>,
  ranges: DayRange[],
  stepMinutes: number,
  config: BacktestConfig,
  sig: Gap
): Trade | null {
  // Locate the signal's session open bar exactly by its day key. This is the
  // "gap" reference time; entry and time-stop are measured from here as real
  // durations (so they correctly skip overnight/weekend gaps in the data).
  const openMs = openMsByDate.get(sig.date);
  if (openMs == null) return null;
  const loc = indexByMs.get(openMs)!;
  const gapMs = bars[loc].ms;

  // Entry: a number of trading bars after the gap bar (durations are trading
  // time, so weekends/closures don't shift them in calendar terms).
  const entryLoc = loc + Math.round(config.entry_offset_minutes / stepMinutes);
  if (entryLoc >= bars.length) return null;

  const side = sideFor(config.direction, sig.direction);
  const entryBar = bars[entryLoc];
  const entryPrice = entryBar.open;
  const gapAbs = sig.abs_gap ?? 0;
  // ADR over the days strictly before this signal's NY day (no look-ahead).
  const refDay = zonedParts(gapMs, DISPLAY_TZ).dayKey;
  const adr = adrBefore(ranges, refDay, config.adr_window);

  const slDist = config.stop_loss
    ? levelDistance(config.stop_loss, entryPrice, gapAbs, adr)
    : null;
  const tpDist = config.take_profit
    ? levelDistance(config.take_profit, entryPrice, gapAbs, adr)
    : null;
  const slPrice = slDist != null ? entryPrice - side * slDist : null;
  const tpPrice = tpDist != null ? entryPrice + side * tpDist : null;

  // Time stop: exit this many trading bars after the gap bar (counting bars
  // skips weekends/closures so e.g. a 48h stop spans a weekend rather than
  // expiring inside it).
  const stopLoc =
    config.time_stop_minutes != null
      ? loc + Math.round(config.time_stop_minutes / stepMinutes)
      : null;

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

    // Time-based exit, evaluated at bar close.
    if (stopLoc != null && j >= stopLoc && j > entryLoc) {
      exitPrice = bar.close;
      exitReason = "time_stop";
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
    entry_ts: wallClockISO(entryBar.ms, DISPLAY_TZ),
    entry_price: round(entryPrice, 5),
    exit_ts: wallClockISO(exitMs, DISPLAY_TZ),
    exit_price: round(exitPrice, 5),
    exit_reason: exitReason,
    pnl: round(pnl, 5),
    r_multiple: rMultiple != null ? round(rMultiple, 3) : null,
  };
}

// Per-side performance (long vs short), to expose directional asymmetry.
function sideStats(trades: Trade[]): SideStats {
  const n = trades.length;
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0);
  const total = pnls.reduce((a, b) => a + b, 0);
  const rs = trades.map((t) => t.r_multiple).filter((r): r is number => r != null);
  const totalR = rs.length ? round(rs.reduce((a, b) => a + b, 0), 3) : null;
  return {
    trades: n,
    wins: wins.length,
    losses: pnls.filter((p) => p < 0).length,
    win_rate: n ? round(wins.length / n, 4) : 0,
    total_pnl: round(total, 5),
    avg_pnl: n ? round(total / n, 5) : 0,
    total_r: totalR,
    avg_r: totalR != null ? round(totalR / rs.length, 3) : null,
    profit_factor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : null,
  };
}

export function summarize(trades: Trade[]): Metrics {
  const n = trades.length;
  const bySide = {
    long: sideStats(trades.filter((t) => t.side === "long")),
    short: sideStats(trades.filter((t) => t.side === "short")),
  };
  if (n === 0) {
    return {
      trades: 0, wins: 0, losses: 0, win_rate: 0, total_pnl: 0, avg_pnl: 0,
      expectancy: 0, profit_factor: null, max_drawdown: 0, avg_win: 0,
      avg_loss: 0, total_r: null, avg_r: null, by_side: bySide, equity_curve: [],
    };
  }

  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);

  // R-multiples (pnl / stop distance) for trades that defined a stop loss.
  const rValues = trades
    .map((t) => t.r_multiple)
    .filter((r): r is number => r != null);
  const totalR = rValues.length ? round(rValues.reduce((a, b) => a + b, 0), 3) : null;
  const avgR = rValues.length ? round(rValues.reduce((a, b) => a + b, 0) / rValues.length, 3) : null;

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
    total_r: totalR,
    avg_r: avgR,
    by_side: bySide,
    equity_curve: curve,
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

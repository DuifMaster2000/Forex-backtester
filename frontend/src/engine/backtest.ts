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
import { findFollowEntry } from "./followFilters";
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
  // Map each session day to its exact open-bar ms (robust signal -> bar lookup),
  // and to the *next* session's open (ms + price) for the inversion clause.
  const openMsByDate = new Map<string, number>();
  const nextOpenByDate = new Map<string, { ms: number; price: number }>();
  const days = sessionBars(bars, session);
  for (let i = 0; i < days.length; i++) {
    openMsByDate.set(days[i].date, days[i].openMs);
    if (i + 1 < days.length) {
      nextOpenByDate.set(days[i].date, { ms: days[i + 1].openMs, price: days[i + 1].openPrice });
    }
  }
  // Daily ranges (NY axis) for ADR-based stops.
  const ranges = dailyRanges(bars, DISPLAY_TZ);
  // Entry/time-stop durations are counted in trading bars so weekends and
  // closures (which have no bars) don't consume the budget.
  const stepMinutes = barStepMinutes(bars);

  const trades: Trade[] = [];
  for (const sig of signals) {
    const t = simulateTrade(bars, indexByMs, openMsByDate, nextOpenByDate, ranges, stepMinutes, config, sig, session);
    if (t) trades.push(t);
  }

  return { trades, metrics: summarize(trades), signals: signals.length };
}

function simulateTrade(
  bars: Bar[],
  indexByMs: Map<number, number>,
  openMsByDate: Map<string, number>,
  nextOpenByDate: Map<string, { ms: number; price: number }>,
  ranges: DayRange[],
  stepMinutes: number,
  config: BacktestConfig,
  sig: Gap,
  session: Session
): Trade | null {
  // Locate the signal's session open bar exactly by its day key. This is the
  // "gap" reference time; entry and time-stop are measured from here as real
  // durations (so they correctly skip overnight/weekend gaps in the data).
  const openMs = openMsByDate.get(sig.date);
  if (openMs == null) return null;
  const loc = indexByMs.get(openMs)!;
  const gapMs = bars[loc].ms;

  // Entry depends on the strategy.
  //  - base: a fixed number of trading bars after the gap bar, always taken,
  //    direction fade or follow.
  //  - follow_filters: follow the gap and wait for a "good entry" at one of the
  //    configured times; the signal is voided (no trade) if none arrives in time.
  let entryLoc: number;
  let side: number;
  let kind: Trade["kind"];
  if (config.strategy === "follow_filters") {
    const followLoc = findFollowEntry(
      bars, session, sig, loc, stepMinutes, config.entry_times, config.entry_timeout_minutes
    );
    const followSide = sig.direction === "up" ? 1 : -1;

    // Inversion clause #1: if all follow entries are missed and the next session
    // opens > multiple * gap beyond the original open (a liquidity "reach"), fade.
    let nextOpenLoc: number | null = null;
    let reached = false;
    if (config.invert_enabled) {
      const nxt = nextOpenByDate.get(sig.date);
      const nl = nxt != null ? indexByMs.get(nxt.ms) : undefined;
      if (nxt != null && nl != null) {
        nextOpenLoc = nl;
        const open0 = sig.open_price ?? 0;
        // Displacement of the next open from the original open, in the gap direction.
        const reach = sig.direction === "up" ? nxt.price - open0 : open0 - nxt.price;
        reached = reach > config.invert_gap_multiple * (sig.abs_gap ?? 0);
      }
    }

    // A follow entry taken *before* the next open wins (the reach wasn't confirmed
    // yet). Otherwise, if the reach fired, invert; else fall back to the follow
    // entry (if any) or void.
    const followBeforeNext = followLoc != null && (nextOpenLoc == null || followLoc < nextOpenLoc);
    if (followBeforeNext) {
      entryLoc = followLoc!;
      side = followSide;
      kind = "follow";
    } else if (nextOpenLoc != null && reached) {
      const cand = nextOpenLoc + Math.round(config.invert_entry_offset_minutes / stepMinutes);
      if (cand >= bars.length) return null;
      entryLoc = cand;
      side = -followSide; // inverted = fade the original gap
      kind = "inversion";
    } else if (followLoc != null) {
      entryLoc = followLoc;
      side = followSide;
      kind = "follow";
    } else {
      return null;
    }
  } else {
    entryLoc = loc + Math.round(config.entry_offset_minutes / stepMinutes);
    if (entryLoc >= bars.length) return null;
    side = sideFor(config.direction, sig.direction);
    kind = "base";
  }

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

  // Time stop: exit this many trading bars after the reference bar (counting bars
  // skips weekends/closures so e.g. a 48h stop spans a weekend rather than
  // expiring inside it). Base measures from the gap bar; follow_filters measures
  // from entry, since entry can land far from the gap (a cap on how long the trade
  // is held rather than on how long since the gap).
  const timeStopRef = config.strategy === "follow_filters" ? entryLoc : loc;
  const stopLoc =
    config.time_stop_minutes != null
      ? timeStopRef + Math.round(config.time_stop_minutes / stepMinutes)
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

  // Deduct the round-trip spread cost from every trade.
  const pnl = side * (exitPrice - entryPrice) - (config.spread || 0);
  const rMultiple = slDist ? pnl / slDist : null;

  return {
    signal_date: sig.date,
    kind,
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

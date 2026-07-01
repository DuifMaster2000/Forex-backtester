// Portfolio / multi-strategy combiner. Mirrors backend/app/backtest/portfolio.py.
//
// Runs several independent "legs" — each a (dataset, session, strategy config)
// pair — and merges their trades onto one shared clock to simulate real-world
// execution, where signals from different instruments (or different sessions on
// the same instrument) may fire at the same time. Each leg has a fixed position
// size; trades are scaled to cash P/L and applied to a simulated starting
// capital. A global cap limits how many trades can be open at once: when it is
// reached, a new signal is skipped (missed) rather than queued.

import type { BacktestConfig, Bar, Metrics, Session, Trade } from "./types";
import { runBacktest, summarize } from "./backtest";

// One leg resolved to the data it runs against. `positionSize` is the fixed
// number of units traded per signal for this leg's instrument, so a trade's cash
// P/L is its price P/L (already net of spread) times the size.
export interface PreparedLeg {
  id: string;
  label: string;
  instrument: string;
  positionSize: number;
  bars: Bar[];
  session: Session;
  config: BacktestConfig;
}

export interface PortfolioOptions {
  startingCapital: number;
  // Maximum simultaneously-open trades across the whole portfolio. <= 0 means
  // unlimited (no cap).
  maxOpenTrades: number;
}

// A leg's trade lifted into the portfolio, carrying its origin, sizing, cash P/L
// and whether the max-open-trades cap let it be taken.
export interface PortfolioTrade extends Trade {
  leg_id: string;
  leg_label: string;
  instrument: string;
  position_size: number;
  cash_pnl: number; // price pnl (net of spread) * position_size
  taken: boolean; // false = skipped because the portfolio was at max open trades
}

export interface LegSummary {
  leg_id: string;
  label: string;
  instrument: string;
  session: string;
  candidates: number; // trades the leg generated (before the cap)
  taken: number;
  skipped: number;
  cash_pnl: number; // realised cash P/L from this leg's taken trades
}

export interface PortfolioResult {
  // Every candidate trade, ordered by entry, with `taken` set. Skipped trades are
  // retained so the missed signals are visible.
  trades: PortfolioTrade[];
  // Portfolio-level metrics computed on the taken trades' cash P/L.
  metrics: Metrics;
  starting_capital: number;
  ending_capital: number;
  return_pct: number;
  max_open_trades: number; // echo of the cap (0 = unlimited)
  peak_concurrent: number; // most trades open at once among taken trades
  taken: number;
  skipped: number;
  legs: LegSummary[];
  // Portfolio equity (capital terms), one point per trade close, for charting.
  equity_curve: { exit_ts: string; equity: number }[];
}

// Deterministic ordering of candidate trades on the shared clock: by entry
// instant, then exit instant, then leg id and signal date as stable tiebreaks.
function compareTrades(a: PortfolioTrade, b: PortfolioTrade): number {
  return (
    a.entry_ms - b.entry_ms ||
    a.exit_ms - b.exit_ms ||
    (a.leg_id < b.leg_id ? -1 : a.leg_id > b.leg_id ? 1 : 0) ||
    (a.signal_date < b.signal_date ? -1 : a.signal_date > b.signal_date ? 1 : 0)
  );
}

export function runPortfolio(legs: PreparedLeg[], opts: PortfolioOptions): PortfolioResult {
  const startingCapital = opts.startingCapital;
  const cap = opts.maxOpenTrades > 0 ? opts.maxOpenTrades : Infinity;

  // Run each leg independently and lift its trades into portfolio trades.
  const candidates: PortfolioTrade[] = [];
  const legMeta = new Map<string, LegSummary>();
  for (const leg of legs) {
    const res = runBacktest(leg.bars, leg.session, leg.config);
    legMeta.set(leg.id, {
      leg_id: leg.id,
      label: leg.label,
      instrument: leg.instrument,
      session: leg.config.session,
      candidates: res.trades.length,
      taken: 0,
      skipped: 0,
      cash_pnl: 0,
    });
    for (const t of res.trades) {
      candidates.push({
        ...t,
        leg_id: leg.id,
        leg_label: leg.label,
        instrument: leg.instrument,
        position_size: leg.positionSize,
        cash_pnl: round(t.pnl * leg.positionSize, 5),
        taken: false,
      });
    }
  }

  candidates.sort(compareTrades);

  // Walk trades in entry order, tracking the exit times of currently-open taken
  // trades. A trade occupies a slot over [entry, exit); one that has already
  // exited by the new entry frees its slot. If a free slot exists (or the cap is
  // unlimited), take the trade; otherwise skip it (the signal is missed).
  let openExits: number[] = [];
  let peakConcurrent = 0;
  for (const t of candidates) {
    openExits = openExits.filter((exit) => exit > t.entry_ms);
    if (openExits.length < cap) {
      t.taken = true;
      openExits.push(t.exit_ms);
      peakConcurrent = Math.max(peakConcurrent, openExits.length);
      const m = legMeta.get(t.leg_id)!;
      m.taken += 1;
      m.cash_pnl = round(m.cash_pnl + t.cash_pnl, 5);
    } else {
      t.taken = false;
      legMeta.get(t.leg_id)!.skipped += 1;
    }
  }

  const taken = candidates.filter((t) => t.taken);
  // Portfolio metrics run on cash P/L, in close order, so the equity curve and
  // drawdown reflect the realised sequence across all instruments. R-multiples
  // are size-independent, so they carry through unchanged.
  const cashTrades: Trade[] = [...taken]
    .sort((a, b) => a.exit_ms - b.exit_ms || compareTrades(a, b))
    .map((t) => ({ ...t, pnl: t.cash_pnl }));
  const metrics = summarize(cashTrades);

  const endingCapital = round(startingCapital + metrics.total_pnl, 5);
  const returnPct =
    startingCapital !== 0 ? round((metrics.total_pnl / startingCapital) * 100, 3) : 0;
  const equityCurve = metrics.equity_curve.map((p) => ({
    exit_ts: p.exit_ts,
    equity: round(startingCapital + p.equity, 5),
  }));

  return {
    trades: candidates,
    metrics,
    starting_capital: startingCapital,
    ending_capital: endingCapital,
    return_pct: returnPct,
    max_open_trades: opts.maxOpenTrades > 0 ? opts.maxOpenTrades : 0,
    peak_concurrent: peakConcurrent,
    taken: taken.length,
    skipped: candidates.length - taken.length,
    legs: legs.map((l) => legMeta.get(l.id)!),
    equity_curve: equityCurve,
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

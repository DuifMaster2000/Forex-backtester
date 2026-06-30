// Shared types for the in-browser engine and the API-facade in api/client.ts.

export interface DatasetMeta {
  id: string;
  instrument: string;
  interval_minutes: number;
  rows: number;
  source_offset: string;
  price_precision: number;
  adr: number | null; // most recent 20-day Average Daily Range
  start: string;
  end: string;
}

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Gap {
  date: string;
  prev_close_ts: string | null;
  prev_close: number | null;
  open_ts: string | null;
  open_price: number | null;
  gap: number | null;
  abs_gap: number | null;
  direction: "up" | "down";
  // Rolling average of the prior `window` absolute gaps (the "avg gap size") and
  // the big-gap threshold (mean + sigma*std). Null until a full window exists.
  mean: number | null;
  threshold: number | null;
  is_big: boolean;
}

export interface PriceLevel {
  mode: "points" | "percent" | "gap_multiple" | "adr_multiple";
  value: number;
}

// Which strategy generates the entry. "base" is the original gap strategy
// (fixed offset after the open, fade/follow). "follow_filters" always follows the
// gap and waits for a "good entry" (a pullback through the gap level) at one of a
// list of configured times of day, voiding the signal if none arrives in time.
export type Strategy = "base" | "follow_filters";

export interface BacktestConfig {
  strategy: Strategy;
  session: string;
  gap_window: number;
  gap_sigma: number;
  direction: "fade" | "follow";
  // Delay from the gap (session open) before entering, in minutes (30-min steps).
  // Base strategy only.
  entry_offset_minutes: number;
  // follow_filters: allowed entry times of day ("HH:MM" in the session timezone).
  // The first one whose good-entry condition holds is taken.
  entry_times: string[];
  // follow_filters: void the signal if no good entry appears within this many
  // minutes of the gap (trading time, so it skips weekends/closures). Default 48h.
  entry_timeout_minutes: number;
  // Days used for the Average Daily Range when SL/TP is in adr_multiple mode.
  adr_window: number;
  stop_loss: PriceLevel | null;
  take_profit: PriceLevel | null;
  // Exit this many minutes after the gap (30-min steps), or null to disable.
  time_stop_minutes: number | null;
  intrabar: "stop_first" | "target_first";
  // Round-trip transaction cost in price units, deducted from each trade's P/L
  // (e.g. EURUSD 0.00015 = 1.5 pips; gold 0.30). 0 = frictionless.
  spread: number;
}

export interface Trade {
  signal_date: string;
  side: "long" | "short";
  gap: number;
  entry_ts: string;
  entry_price: number;
  exit_ts: string;
  exit_price: number;
  exit_reason: string;
  pnl: number;
  r_multiple: number | null;
}

export interface SideStats {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  total_r: number | null;
  avg_r: number | null;
  profit_factor: number | null;
}

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  expectancy: number;
  profit_factor: number | null;
  max_drawdown: number;
  avg_win: number;
  avg_loss: number;
  total_r: number | null;
  avg_r: number | null;
  by_side: { long: SideStats; short: SideStats };
  equity_curve: { exit_ts: string; equity: number }[];
}

export interface BacktestResult {
  trades: Trade[];
  metrics: Metrics;
  signals: number;
}

export interface Session {
  name: string;
  tz: string;
  open_time: string;
  close_time: string;
}

// A session's open/close boundary timestamps for one day (wall-clock ISO strings).
export interface SessionWindow {
  open_ts: string;
  close_ts: string;
}

// A single price bar. `utc` is the true instant; `ms` is its epoch milliseconds.
export interface Bar {
  ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Dataset {
  bars: Bar[];
  instrument: string;
  interval_minutes: number;
  source_offset: string;
  // Number of decimal places in the instrument's prices (e.g. EURUSD 5, gold 2-3).
  price_precision: number;
}

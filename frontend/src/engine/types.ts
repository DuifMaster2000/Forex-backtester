// Shared types for the in-browser engine and the API-facade in api/client.ts.

export interface DatasetMeta {
  id: string;
  instrument: string;
  interval_minutes: number;
  rows: number;
  source_offset: string;
  price_precision: number;
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
  threshold: number | null;
  is_big: boolean;
}

export interface PriceLevel {
  mode: "points" | "percent" | "gap_multiple";
  value: number;
}

export interface BacktestConfig {
  session: string;
  gap_window: number;
  gap_sigma: number;
  direction: "fade" | "follow";
  // Delay from the gap (session open) before entering, in minutes (30-min steps).
  entry_offset_minutes: number;
  stop_loss: PriceLevel | null;
  take_profit: PriceLevel | null;
  // Exit this many minutes after the gap (30-min steps), or null to disable.
  time_stop_minutes: number | null;
  intrabar: "stop_first" | "target_first";
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

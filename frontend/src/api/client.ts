// Typed client for the backtester API.

export interface DatasetMeta {
  id: string;
  instrument: string;
  interval_minutes: number;
  rows: number;
  source_offset: string;
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
  entry_offset_bars: number;
  stop_loss: PriceLevel | null;
  take_profit: PriceLevel | null;
  time_stop_bars: number | null;
  time_stop_at: string | null;
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

const BASE = "/api";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body.detail ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export async function uploadDataset(file: File): Promise<DatasetMeta> {
  const form = new FormData();
  form.append("file", file);
  return json(await fetch(`${BASE}/datasets`, { method: "POST", body: form }));
}

export async function getCandles(id: string, tz = "America/New_York"): Promise<Candle[]> {
  const res = await json<{ candles: Candle[] }>(
    await fetch(`${BASE}/datasets/${id}/candles?tz=${encodeURIComponent(tz)}`)
  );
  return res.candles;
}

export async function getGaps(
  id: string,
  session: string,
  window: number,
  sigma: number
): Promise<Gap[]> {
  const res = await json<{ gaps: Gap[] }>(
    await fetch(`${BASE}/datasets/${id}/gaps?session=${session}&window=${window}&sigma=${sigma}`)
  );
  return res.gaps;
}

export async function runBacktest(id: string, config: BacktestConfig): Promise<BacktestResult> {
  return json(
    await fetch(`${BASE}/datasets/${id}/backtest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    })
  );
}

export async function getSessions(): Promise<Session[]> {
  return json(await fetch(`${BASE}/sessions`));
}

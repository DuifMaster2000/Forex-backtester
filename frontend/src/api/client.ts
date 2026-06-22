// In-browser facade. Keeps the same function names/types the components import,
// but runs the ported engine locally instead of calling a backend — so the app is
// fully static and deployable to GitHub Pages.

import { parseCsv } from "../engine/loader";
import { computeGaps } from "../engine/gap";
import { runBacktest as runBacktestEngine } from "../engine/backtest";
import { DEFAULT_SESSIONS, getSession, sessionBars } from "../engine/sessions";
import { wallClockISO } from "../engine/tz";
import type {
  BacktestConfig,
  BacktestResult,
  Candle,
  Dataset,
  DatasetMeta,
  Gap,
  Session,
  SessionWindow,
} from "../engine/types";

// Re-export types so existing `import ... from "../api/client"` keeps working.
export type {
  BacktestConfig,
  BacktestResult,
  Candle,
  DatasetMeta,
  Gap,
  Metrics,
  PriceLevel,
  Session,
  SessionWindow,
  Trade,
} from "../engine/types";

// Module-level in-memory dataset registry (replaces the backend store).
const datasets = new Map<string, Dataset>();

function datasetMeta(id: string, ds: Dataset): DatasetMeta {
  const tz = "America/New_York";
  return {
    id,
    instrument: ds.instrument,
    interval_minutes: ds.interval_minutes,
    rows: ds.bars.length,
    source_offset: ds.source_offset,
    start: wallClockISO(ds.bars[0].ms, tz),
    end: wallClockISO(ds.bars[ds.bars.length - 1].ms, tz),
  };
}

export async function uploadDataset(file: File): Promise<DatasetMeta> {
  const text = await file.text();
  const ds = parseCsv(text, file.name);
  const id = Math.random().toString(36).slice(2, 14);
  datasets.set(id, ds);
  return datasetMeta(id, ds);
}

function get(id: string): Dataset {
  const ds = datasets.get(id);
  if (!ds) throw new Error(`Dataset '${id}' not found`);
  return ds;
}

export async function getCandles(id: string, tz = "America/New_York"): Promise<Candle[]> {
  const ds = get(id);
  return ds.bars.map((b) => ({
    time: wallClockISO(b.ms, tz),
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

export async function getGaps(
  id: string,
  session: string,
  window: number,
  sigma: number
): Promise<Gap[]> {
  const ds = get(id);
  return computeGaps(ds.bars, getSession(session), window, sigma);
}

export async function runBacktest(id: string, config: BacktestConfig): Promise<BacktestResult> {
  const ds = get(id);
  return runBacktestEngine(ds.bars, getSession(config.session), config);
}

export async function getSessions(): Promise<Session[]> {
  return DEFAULT_SESSIONS;
}

export async function getSessionWindows(
  id: string,
  sessionName: string
): Promise<SessionWindow[]> {
  const ds = get(id);
  const session = getSession(sessionName);
  return sessionBars(ds.bars, session).map((d) => ({
    open_ts: wallClockISO(d.openMs, session.tz),
    close_ts: wallClockISO(d.closeMs, session.tz),
  }));
}

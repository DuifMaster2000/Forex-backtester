// In-browser facade. Keeps the same function names/types the components import,
// but runs the ported engine locally instead of calling a backend — so the app is
// fully static and deployable to GitHub Pages.

import { parseCsv } from "../engine/loader";
import { computeGaps } from "../engine/gap";
import { runBacktest as runBacktestEngine } from "../engine/backtest";
import { DEFAULT_SESSIONS, getSession, sessionBars } from "../engine/sessions";
import { latestAdr } from "../engine/adr";
import { countGrid, runGrid, type GridResult, type GridSpec } from "../engine/grid";
import { runGridParallel } from "../engine/gridPool";
import { runSweep, type SweepResult, type SweepSpec } from "../engine/sweep";
import { runPortfolio as runPortfolioEngine, type PortfolioResult } from "../engine/portfolio";
import { DISPLAY_TZ, wallClockISO } from "../engine/tz";

const ADR_WINDOW = 20;
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
  Strategy,
  Trade,
} from "../engine/types";
export type { PortfolioResult, PortfolioTrade, LegSummary } from "../engine/portfolio";

// One portfolio leg as configured in the UI: a dataset + strategy config, with a
// fixed position size (units per trade) and a display label.
export interface PortfolioLegSpec {
  id: string;
  dataset_id: string;
  label: string;
  position_size: number;
  config: BacktestConfig;
}

export interface PortfolioRunSpec {
  starting_capital: number;
  max_open_trades: number; // <= 0 = unlimited
  legs: PortfolioLegSpec[];
}

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
    price_precision: ds.price_precision,
    adr: latestAdr(ds.bars, ADR_WINDOW, DISPLAY_TZ),
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

export async function runOptimizer(
  id: string,
  spec: GridSpec,
  onProgress?: (done: number, total: number) => void
): Promise<GridResult[]> {
  const ds = get(id);
  // Spread large grids across CPU cores; small ones aren't worth the worker
  // startup. Fall back to the single-thread runner if workers are unavailable.
  if (countGrid(spec) >= 100 && typeof Worker !== "undefined") {
    try {
      return await runGridParallel(ds.bars, spec, onProgress);
    } catch {
      /* fall through to single-thread */
    }
  }
  return runGrid(ds.bars, spec, onProgress);
}

export async function runStability(
  id: string,
  base: BacktestConfig,
  spec: SweepSpec
): Promise<SweepResult> {
  const ds = get(id);
  return runSweep(ds.bars, base, spec);
}

export async function runPortfolio(spec: PortfolioRunSpec): Promise<PortfolioResult> {
  const legs = spec.legs.map((l) => {
    const ds = get(l.dataset_id);
    return {
      id: l.id,
      label: l.label,
      instrument: ds.instrument,
      positionSize: l.position_size,
      bars: ds.bars,
      session: getSession(l.config.session),
      config: l.config,
    };
  });
  return runPortfolioEngine(legs, {
    startingCapital: spec.starting_capital,
    maxOpenTrades: spec.max_open_trades,
  });
}

export async function getSessionWindows(
  id: string,
  sessionName: string
): Promise<SessionWindow[]> {
  const ds = get(id);
  const session = getSession(sessionName);
  // Detect in the session's own tz, but emit timestamps on the NY display axis.
  return sessionBars(ds.bars, session).map((d) => ({
    open_ts: wallClockISO(d.openMs, DISPLAY_TZ),
    close_ts: wallClockISO(d.closeMs, DISPLAY_TZ),
  }));
}

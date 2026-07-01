import { useEffect, useState } from "react";
import Chart from "./components/Chart";
import UploadPanel from "./components/UploadPanel";
import StrategyForm from "./components/StrategyForm";
import ResultsPanel from "./components/ResultsPanel";
import BruteForceForm from "./components/BruteForceForm";
import GridReport from "./components/GridReport";
import SweepForm from "./components/SweepForm";
import StabilityReport from "./components/StabilityReport";
import PortfolioForm from "./components/PortfolioForm";
import PortfolioReport from "./components/PortfolioReport";
import {
  getCandles,
  getGaps,
  getSessions,
  getSessionWindows,
  runBacktest,
  runOptimizer,
  runStability,
  runPortfolio,
  uploadDataset,
  type BacktestConfig,
  type BacktestResult,
  type Candle,
  type DatasetMeta,
  type Gap,
  type PortfolioResult,
  type PortfolioRunSpec,
  type Session,
  type SessionWindow,
  type Strategy,
} from "./api/client";
import { countGrid, type GridResult, type GridSpec } from "./engine/grid";
import type { SweepResult, SweepSpec } from "./engine/sweep";

type Mode = "single" | "optimize" | "stability" | "portfolio";

// Every numeric field of a config is a real number (no blank inputs left as NaN),
// and follow_filters additionally needs at least one entry time.
function configValid(c: BacktestConfig): boolean {
  const nums = [c.gap_window, c.gap_sigma];
  if (c.strategy === "follow_filters") {
    if (c.entry_times.length === 0) return false;
    nums.push(c.entry_timeout_minutes);
    if (c.invert_enabled) {
      nums.push(c.invert_gap_multiple, c.invert_entry_offset_minutes);
      if (c.invert_stop_loss) nums.push(c.invert_stop_loss.value);
      if (c.invert_take_profit) nums.push(c.invert_take_profit.value);
    }
  } else {
    nums.push(c.entry_offset_minutes);
  }
  if (c.stop_loss) nums.push(c.stop_loss.value);
  if (c.take_profit) nums.push(c.take_profit.value);
  if (c.time_stop_minutes != null) nums.push(c.time_stop_minutes);
  return nums.every(Number.isFinite);
}

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState("NY");
  const [dataset, setDataset] = useState<DatasetMeta | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [sessionWindows, setSessionWindows] = useState<SessionWindow[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("single");
  const [strategy, setStrategy] = useState<Strategy>("base");
  const [gridResults, setGridResults] = useState<GridResult[]>([]);
  const [gridSpec, setGridSpec] = useState<GridSpec | null>(null);
  const [gridRunning, setGridRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const [baseConfig, setBaseConfig] = useState<BacktestConfig | null>(null);
  const [sweep, setSweep] = useState<SweepResult | null>(null);
  const [sweepRunning, setSweepRunning] = useState(false);

  // Portfolio mode keeps its own multi-dataset registry (several CSVs at once).
  const [portfolioDatasets, setPortfolioDatasets] = useState<DatasetMeta[]>([]);
  const [portfolio, setPortfolio] = useState<PortfolioResult | null>(null);
  const [portfolioRunning, setPortfolioRunning] = useState(false);

  useEffect(() => {
    getSessions().then(setSessions).catch((e) => setError(e.message));
  }, []);

  // Refresh the session shading whenever a dataset is loaded or the session changes.
  useEffect(() => {
    if (!dataset) return;
    getSessionWindows(dataset.id, session)
      .then(setSessionWindows)
      .catch((e) => setError(e.message));
  }, [dataset, session]);

  async function onLoaded(meta: DatasetMeta) {
    setDataset(meta);
    setResult(null);
    setGaps([]);
    setGridResults([]);
    setSweep(null);
    const c = await getCandles(meta.id);
    setCandles(c);
  }

  async function onRun(config: BacktestConfig) {
    if (!dataset) return;
    setRunning(true);
    setError(null);
    try {
      const [g, res] = await Promise.all([
        getGaps(dataset.id, config.session, config.gap_window, config.gap_sigma),
        runBacktest(dataset.id, config),
      ]);
      setGaps(g);
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function onRunSweep(spec: SweepSpec) {
    if (!dataset || !baseConfig) return;
    if (!configValid(baseConfig)) {
      setError("The base strategy has empty fields — fill them in before sweeping.");
      return;
    }
    setSweepRunning(true);
    setError(null);
    try {
      // Defer one frame so the "Running…" state paints before the (sync) sweep.
      await new Promise((r) => setTimeout(r, 0));
      setSweep(await runStability(dataset.id, baseConfig, spec));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSweepRunning(false);
    }
  }

  async function onPortfolioUpload(file: File): Promise<DatasetMeta> {
    const meta = await uploadDataset(file);
    setPortfolioDatasets((ds) => [...ds, meta]);
    return meta;
  }

  async function onRunPortfolio(spec: PortfolioRunSpec) {
    setPortfolioRunning(true);
    setError(null);
    try {
      // Defer a frame so the "Running…" state paints before the (sync) run.
      await new Promise((r) => setTimeout(r, 0));
      setPortfolio(await runPortfolio(spec));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPortfolioRunning(false);
    }
  }

  async function onRunGrid(spec: GridSpec) {
    if (!dataset) return;
    setGridRunning(true);
    setError(null);
    setProgress({ done: 0, total: countGrid(spec) });
    const t0 = performance.now();
    try {
      const res = await runOptimizer(dataset.id, spec, (done, total) => setProgress({ done, total }));
      setGridResults(res);
      setGridSpec(spec);
      setElapsedMs(performance.now() - t0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGridRunning(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Forex Strategy Backtester</h1>
        {mode !== "portfolio" && (
          <div className="strategy-select">
            <label htmlFor="strategy">Strategy</label>
            <select
              id="strategy"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as Strategy)}
            >
              <option value="base">Base strategy</option>
              <option value="follow_filters">Follow only + filters</option>
            </select>
          </div>
        )}
        <div className="mode-toggle">
          <button className={mode === "single" ? "on" : ""} onClick={() => setMode("single")}>
            Single
          </button>
          <button className={mode === "optimize" ? "on" : ""} onClick={() => setMode("optimize")}>
            Optimize
          </button>
          <button className={mode === "stability" ? "on" : ""} onClick={() => setMode("stability")}>
            Stability
          </button>
          <button className={mode === "portfolio" ? "on" : ""} onClick={() => setMode("portfolio")}>
            Portfolio
          </button>
        </div>
        {mode === "single" && (
          <span className="legend">
            <span className="legend-band" /> session window
            <span className="legend-line open" /> open
            <span className="legend-line close" /> close
          </span>
        )}
      </header>

      <div className="layout">
        <aside className="sidebar">
          {mode === "portfolio" ? (
            <PortfolioForm
              sessions={sessions}
              datasets={portfolioDatasets}
              running={portfolioRunning}
              onUpload={onPortfolioUpload}
              onRun={onRunPortfolio}
            />
          ) : (
            <>
              <UploadPanel onLoaded={onLoaded} />
              {mode === "optimize" ? (
                <BruteForceForm
                  strategy={strategy}
                  sessions={sessions}
                  disabled={!dataset}
                  running={gridRunning}
                  progress={progress}
                  onRun={onRunGrid}
                />
              ) : (
                <>
                  <StrategyForm
                    strategy={strategy}
                    sessions={sessions}
                    session={session}
                    onSessionChange={setSession}
                    disabled={!dataset || running}
                    onRun={onRun}
                    onChange={setBaseConfig}
                  />
                  {mode === "stability" && (
                    <SweepForm
                      strategy={strategy}
                      disabled={!dataset}
                      running={sweepRunning}
                      onRun={onRunSweep}
                    />
                  )}
                </>
              )}
            </>
          )}
        </aside>

        <main className="main">
          {error && <div className="error banner">{error}</div>}
          {mode === "single" && (
            <>
              <div className="chart-wrap">
                {candles.length > 0 ? (
                  <Chart
                    candles={candles}
                    gaps={gaps}
                    trades={result?.trades ?? []}
                    sessionWindows={sessionWindows}
                    precision={dataset?.price_precision ?? 2}
                  />
                ) : (
                  <div className="placeholder">Upload a CSV to view the chart.</div>
                )}
              </div>
              <ResultsPanel result={result} precision={dataset?.price_precision ?? 2} />
            </>
          )}

          {mode === "optimize" &&
            (gridSpec ? (
              <GridReport
                results={gridResults}
                spec={gridSpec}
                precision={dataset?.price_precision ?? 2}
                elapsedMs={elapsedMs}
              />
            ) : (
              <div className="panel">
                <h3>Optimiser report</h3>
                <p className="muted">
                  {dataset
                    ? "Configure a grid on the left and run the optimiser."
                    : "Upload a CSV to begin."}
                </p>
              </div>
            ))}

          {mode === "stability" && (
            <StabilityReport
              result={sweep}
              precision={dataset?.price_precision ?? 2}
              hasDataset={!!dataset}
            />
          )}

          {mode === "portfolio" && (
            <PortfolioReport
              result={portfolio}
              datasets={portfolioDatasets}
              hasDatasets={portfolioDatasets.length > 0}
            />
          )}
        </main>
      </div>
    </div>
  );
}

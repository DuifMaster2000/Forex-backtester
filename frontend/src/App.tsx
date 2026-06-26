import { useEffect, useState } from "react";
import Chart from "./components/Chart";
import UploadPanel from "./components/UploadPanel";
import StrategyForm from "./components/StrategyForm";
import ResultsPanel from "./components/ResultsPanel";
import BruteForceForm from "./components/BruteForceForm";
import GridReport from "./components/GridReport";
import {
  getCandles,
  getGaps,
  getSessions,
  getSessionWindows,
  runBacktest,
  runOptimizer,
  type BacktestConfig,
  type BacktestResult,
  type Candle,
  type DatasetMeta,
  type Gap,
  type Session,
  type SessionWindow,
} from "./api/client";
import { countGrid, type GridResult, type GridSpec } from "./engine/grid";

type Mode = "single" | "optimize";

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
  const [gridResults, setGridResults] = useState<GridResult[]>([]);
  const [gridSpec, setGridSpec] = useState<GridSpec | null>(null);
  const [gridRunning, setGridRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

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
        <div className="mode-toggle">
          <button className={mode === "single" ? "on" : ""} onClick={() => setMode("single")}>
            Single
          </button>
          <button className={mode === "optimize" ? "on" : ""} onClick={() => setMode("optimize")}>
            Optimize
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
          <UploadPanel onLoaded={onLoaded} />
          {mode === "single" ? (
            <StrategyForm
              sessions={sessions}
              session={session}
              onSessionChange={setSession}
              disabled={!dataset || running}
              onRun={onRun}
            />
          ) : (
            <BruteForceForm
              sessions={sessions}
              disabled={!dataset}
              running={gridRunning}
              progress={progress}
              onRun={onRunGrid}
            />
          )}
        </aside>

        <main className="main">
          {error && <div className="error banner">{error}</div>}
          {mode === "single" ? (
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
          ) : gridSpec ? (
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
          )}
        </main>
      </div>
    </div>
  );
}

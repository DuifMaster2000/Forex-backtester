import { useEffect, useState } from "react";
import Chart from "./components/Chart";
import UploadPanel from "./components/UploadPanel";
import StrategyForm from "./components/StrategyForm";
import ResultsPanel from "./components/ResultsPanel";
import {
  getCandles,
  getGaps,
  getSessions,
  runBacktest,
  type BacktestConfig,
  type BacktestResult,
  type Candle,
  type DatasetMeta,
  type Gap,
  type Session,
} from "./api/client";

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [dataset, setDataset] = useState<DatasetMeta | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSessions().then(setSessions).catch((e) => setError(e.message));
  }, []);

  async function onLoaded(meta: DatasetMeta) {
    setDataset(meta);
    setResult(null);
    setGaps([]);
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

  return (
    <div className="app">
      <header>
        <h1>Forex Strategy Backtester</h1>
        <span className="muted">Session-gap strategy · times in session timezone</span>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <UploadPanel onLoaded={onLoaded} />
          <StrategyForm sessions={sessions} disabled={!dataset || running} onRun={onRun} />
        </aside>

        <main className="main">
          {error && <div className="error banner">{error}</div>}
          <div className="chart-wrap">
            {candles.length > 0 ? (
              <Chart candles={candles} gaps={gaps} trades={result?.trades ?? []} />
            ) : (
              <div className="placeholder">Upload a CSV to view the chart.</div>
            )}
          </div>
          <ResultsPanel result={result} />
        </main>
      </div>
    </div>
  );
}

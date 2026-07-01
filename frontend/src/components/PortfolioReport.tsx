import SweepChart from "./SweepChart";
import type { DatasetMeta, PortfolioResult } from "../api/client";

interface Props {
  result: PortfolioResult | null;
  datasets: DatasetMeta[];
  hasDatasets: boolean;
}

export default function PortfolioReport({ result, datasets, hasDatasets }: Props) {
  if (!result) {
    return (
      <div className="panel">
        <h3>Portfolio report</h3>
        <p className="muted">
          {hasDatasets
            ? "Add strategy legs on the left and run the portfolio."
            : "Upload one or more CSVs to begin."}
        </p>
      </div>
    );
  }

  // Cash figures are money, so format with 2 dp; per-instrument prices use each
  // dataset's own precision.
  const money = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const precByInstrument = new Map(datasets.map((d) => [d.instrument, Math.max(2, d.price_precision)]));
  const price = (v: number, instrument: string) => v.toFixed(precByInstrument.get(instrument) ?? 5);
  const fmtR = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`);

  const m = result.metrics;
  const capacity = result.max_open_trades === 0 ? "∞" : String(result.max_open_trades);

  const equitySeries = result.equity_curve.length
    ? [{
        label: "Equity",
        points: [
          { x: 0, y: result.starting_capital },
          ...result.equity_curve.map((p, i) => ({ x: i + 1, y: p.equity })),
        ],
      }]
    : [];

  const stats: [string, string][] = [
    ["Starting capital", money(result.starting_capital)],
    ["Ending capital", money(result.ending_capital)],
    ["Return", `${result.return_pct >= 0 ? "+" : ""}${result.return_pct.toFixed(2)}%`],
    ["Net P/L", money(m.total_pnl)],
    ["Trades taken", `${result.taken}`],
    ["Signals skipped", `${result.skipped}`],
    ["Peak concurrent", `${result.peak_concurrent} / ${capacity}`],
    ["Win rate", `${(m.win_rate * 100).toFixed(1)}%`],
    ["Profit factor", m.profit_factor == null ? "—" : m.profit_factor.toFixed(2)],
    ["Max drawdown", money(m.max_drawdown)],
    ["Total R", fmtR(m.total_r)],
    ["Expectancy", money(m.expectancy)],
    ["Avg R / trade", fmtR(m.avg_r)],
    ["Linearity R²", m.r2.toFixed(3)],
  ];

  return (
    <div className="panel">
      <h3>Portfolio report</h3>
      <div className="stats">
        {stats.map(([k, v]) => (
          <div key={k} className="stat">
            <span className="stat-label">{k}</span>
            <span className="stat-value">{v}</span>
          </div>
        ))}
      </div>

      {equitySeries.length > 0 && (
        <>
          <h4 className="subhead">Equity curve (capital, per trade close)</h4>
          <SweepChart series={equitySeries} xLabel="Trade #" yLabel="Capital" yFormat={money} />
        </>
      )}

      <h4 className="subhead">By leg</h4>
      <table className="sides">
        <thead>
          <tr>
            <th>Leg</th><th>Instrument</th><th>Session</th>
            <th>Signals</th><th>Taken</th><th>Skipped</th><th>Cash P/L</th>
          </tr>
        </thead>
        <tbody>
          {result.legs.map((l) => (
            <tr key={l.leg_id}>
              <td>{l.label}</td>
              <td>{l.instrument}</td>
              <td>{l.session}</td>
              <td>{l.candidates}</td>
              <td>{l.taken}</td>
              <td>{l.skipped}</td>
              <td className={l.cash_pnl >= 0 ? "win" : "loss"}>{money(l.cash_pnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 className="subhead">Trades (chronological by entry)</h4>
      <table className="trades portfolio-trades">
        <thead>
          <tr>
            <th>Entry</th><th>Leg</th><th>Instrument</th><th>Side</th>
            <th>Entry px</th><th>Exit px</th><th>Cash P/L</th><th>R</th><th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {result.trades.map((t, i) => (
            <tr key={i} className={`${t.taken ? (t.cash_pnl >= 0 ? "win" : "loss") : "skipped"}`}>
              <td>{t.entry_ts.replace("T", " ").slice(0, 16)}</td>
              <td>{t.leg_label}</td>
              <td>{t.instrument}</td>
              <td>{t.side}</td>
              <td>{price(t.entry_price, t.instrument)}</td>
              <td>{price(t.exit_price, t.instrument)}</td>
              <td>{t.taken ? money(t.cash_pnl) : "—"}</td>
              <td>{t.r_multiple ?? "—"}</td>
              <td>{t.taken ? t.exit_reason : "skipped (max open)"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

import SweepChart from "./SweepChart";
import type { BacktestResult } from "../api/client";

interface Props {
  result: BacktestResult | null;
  precision: number;
}

export default function ResultsPanel({ result, precision }: Props) {
  if (!result) {
    return (
      <div className="panel">
        <h3>Results</h3>
        <p className="muted">Run a backtest to see trades and metrics.</p>
      </div>
    );
  }

  // P/L is in price units, so format it with the instrument's price precision
  // (e.g. EURUSD 5 dp) — at least 2 dp for readability.
  const dp = Math.max(2, precision);
  const fmt = (v: number) => v.toFixed(dp);

  const fmtR = (v: number | null) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

  const m = result.metrics;

  // Cumulative P/L over the sequence of trades (starts at 0 before trade 1).
  const equitySeries = m.equity_curve.length
    ? [{
        label: "Equity",
        points: [{ x: 0, y: 0 }, ...m.equity_curve.map((p, i) => ({ x: i + 1, y: p.equity }))],
      }]
    : [];

  const stats: [string, string][] = [
    ["Signals", String(result.signals)],
    ["Trades", String(m.trades)],
    ["Win rate", `${(m.win_rate * 100).toFixed(1)}%`],
    ["Total P/L", fmt(m.total_pnl)],
    ["Total R", fmtR(m.total_r)],
    ["Expectancy", fmt(m.expectancy)],
    ["Avg R / trade", fmtR(m.avg_r)],
    ["Profit factor", m.profit_factor == null ? "—" : m.profit_factor.toFixed(2)],
    ["Max drawdown", fmt(m.max_drawdown)],
    ["Avg win / loss", `${fmt(m.avg_win)} / ${fmt(m.avg_loss)}`],
  ];

  return (
    <div className="panel">
      <h3>Results</h3>
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
          <h4 className="subhead">Equity curve (cumulative P/L per trade)</h4>
          <SweepChart series={equitySeries} xLabel="Trade #" yLabel="Cumulative P/L" yFormat={fmt} />
        </>
      )}

      <h4 className="subhead">Long vs short</h4>
      <table className="sides">
        <thead>
          <tr>
            <th>Side</th><th>Trades</th><th>Win%</th><th>P/L</th>
            <th>Total R</th><th>Avg R</th><th>PF</th>
          </tr>
        </thead>
        <tbody>
          {(["long", "short"] as const).map((sd) => {
            const s = m.by_side[sd];
            return (
              <tr key={sd}>
                <td>{sd}</td>
                <td>{s.trades}</td>
                <td>{(s.win_rate * 100).toFixed(1)}%</td>
                <td className={s.total_pnl >= 0 ? "win" : "loss"}>{fmt(s.total_pnl)}</td>
                <td>{fmtR(s.total_r)}</td>
                <td>{fmtR(s.avg_r)}</td>
                <td>{s.profit_factor == null ? "—" : s.profit_factor.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <table className="trades">
        <thead>
          <tr>
            <th>Date</th><th>Type</th><th>Side</th><th>Gap</th><th>Entry</th>
            <th>Exit</th><th>P/L</th><th>R</th><th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {result.trades.map((t, i) => (
            <tr key={i} className={t.pnl >= 0 ? "win" : "loss"}>
              <td>{t.signal_date}</td>
              <td className={`kind kind-${t.kind}`}>{t.kind}</td>
              <td>{t.side}</td>
              <td>{fmt(t.gap)}</td>
              <td>{t.entry_price.toFixed(dp)}</td>
              <td>{t.exit_price.toFixed(dp)}</td>
              <td>{fmt(t.pnl)}</td>
              <td>{t.r_multiple ?? "—"}</td>
              <td>{t.exit_reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

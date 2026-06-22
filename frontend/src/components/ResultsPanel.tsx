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

      <table className="trades">
        <thead>
          <tr>
            <th>Date</th><th>Side</th><th>Gap</th><th>Entry</th>
            <th>Exit</th><th>P/L</th><th>R</th><th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {result.trades.map((t, i) => (
            <tr key={i} className={t.pnl >= 0 ? "win" : "loss"}>
              <td>{t.signal_date}</td>
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

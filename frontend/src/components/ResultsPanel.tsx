import type { BacktestResult } from "../api/client";

export default function ResultsPanel({ result }: { result: BacktestResult | null }) {
  if (!result) {
    return (
      <div className="panel">
        <h3>Results</h3>
        <p className="muted">Run a backtest to see trades and metrics.</p>
      </div>
    );
  }

  const m = result.metrics;
  const stats: [string, string][] = [
    ["Signals", String(result.signals)],
    ["Trades", String(m.trades)],
    ["Win rate", `${(m.win_rate * 100).toFixed(1)}%`],
    ["Total P/L", m.total_pnl.toFixed(2)],
    ["Expectancy", m.expectancy.toFixed(2)],
    ["Profit factor", m.profit_factor == null ? "—" : m.profit_factor.toFixed(2)],
    ["Max drawdown", m.max_drawdown.toFixed(2)],
    ["Avg win / loss", `${m.avg_win.toFixed(2)} / ${m.avg_loss.toFixed(2)}`],
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
              <td>{t.gap.toFixed(1)}</td>
              <td>{t.entry_price}</td>
              <td>{t.exit_price}</td>
              <td>{t.pnl.toFixed(2)}</td>
              <td>{t.r_multiple ?? "—"}</td>
              <td>{t.exit_reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

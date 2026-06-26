import { useMemo } from "react";
import type { BacktestConfig } from "../api/client";
import type { GridResult, GridSpec } from "../engine/grid";

interface Props {
  results: GridResult[];
  spec: GridSpec;
  precision: number;
  elapsedMs: number | null;
}

interface Col {
  label: string;
  get: (c: BacktestConfig) => string;
}

const ALL_COLS: Col[] = [
  { label: "Session", get: (c) => c.session },
  { label: "Dir", get: (c) => c.direction },
  { label: "Win", get: (c) => String(c.gap_window) },
  { label: "Sigma", get: (c) => String(c.gap_sigma) },
  { label: "Entry h", get: (c) => String(c.entry_offset_minutes / 60) },
  { label: "Stop h", get: (c) => (c.time_stop_minutes == null ? "—" : String(c.time_stop_minutes / 60)) },
  { label: "SL", get: (c) => (c.stop_loss ? `${c.stop_loss.value} ${shortMode(c.stop_loss.mode)}` : "—") },
  { label: "TP", get: (c) => (c.take_profit ? `${c.take_profit.value} ${shortMode(c.take_profit.mode)}` : "—") },
];

function shortMode(m: string): string {
  return m === "adr_multiple" ? "ADR" : m === "gap_multiple" ? "gap" : m === "percent" ? "%" : "pt";
}

export default function GridReport({ results, spec, precision, elapsedMs }: Props) {
  const dp = Math.max(2, precision);
  const fmt = (v: number) => v.toFixed(dp);

  // Only show config columns whose value actually varies across the grid.
  const cols = useMemo(() => {
    return ALL_COLS.filter((col) => {
      const seen = new Set<string>();
      for (const r of results) {
        seen.add(col.get(r.config));
        if (seen.size > 1) return true;
      }
      return false;
    });
  }, [results]);

  if (results.length === 0) {
    return (
      <div className="panel">
        <h3>Optimiser report</h3>
        <p className="muted">Configure a grid and run the optimiser to see results.</p>
      </div>
    );
  }

  const top = results.slice(0, 100);
  const best = results[0];

  return (
    <div className="panel">
      <h3>Optimiser report</h3>
      <div className="muted report-summary">
        {results.length.toLocaleString()} combinations
        {elapsedMs != null && ` · ${(elapsedMs / 1000).toFixed(1)}s`}
        {" · ranked by "}<b>{rankLabel(spec.rankBy)}</b>
        {" · showing top "}{top.length}
        <button className="link" onClick={() => downloadCsv(results, cols, dp)}>download CSV</button>
      </div>

      <table className="grid-results">
        <thead>
          <tr>
            <th>#</th>
            {cols.map((c) => <th key={c.label}>{c.label}</th>)}
            <th>Trades</th><th>Win%</th><th>P/L</th><th>Total R</th><th>PF</th><th>Max DD</th>
          </tr>
        </thead>
        <tbody>
          {top.map((r, i) => (
            <tr key={i} className={r === best ? "best" : ""}>
              <td>{i + 1}</td>
              {cols.map((c) => <td key={c.label}>{c.get(r.config)}</td>)}
              <td>{r.metrics.trades}</td>
              <td>{(r.metrics.win_rate * 100).toFixed(0)}%</td>
              <td className={r.metrics.total_pnl >= 0 ? "win" : "loss"}>{fmt(r.metrics.total_pnl)}</td>
              <td>{r.metrics.total_r == null ? "—" : r.metrics.total_r.toFixed(2)}</td>
              <td>{r.metrics.profit_factor == null ? "—" : r.metrics.profit_factor.toFixed(2)}</td>
              <td>{fmt(r.metrics.max_drawdown)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function rankLabel(r: string): string {
  return { total_r: "Total R", total_pnl: "Total P/L", profit_factor: "Profit factor",
    win_rate: "Win rate", expectancy: "Expectancy" }[r] ?? r;
}

function downloadCsv(results: GridResult[], cols: Col[], dp: number): void {
  const header = [
    ...ALL_COLS.map((c) => c.label),
    "trades", "win_rate", "total_pnl", "avg_pnl", "expectancy",
    "total_r", "avg_r", "profit_factor", "max_drawdown",
    "long_trades", "long_pnl", "long_r", "short_trades", "short_pnl", "short_r",
  ];
  void cols;
  const rows = results.map((r) => {
    const m = r.metrics;
    return [
      ...ALL_COLS.map((c) => c.get(r.config)),
      m.trades, m.win_rate, m.total_pnl.toFixed(dp), m.avg_pnl.toFixed(dp), m.expectancy.toFixed(dp),
      m.total_r ?? "", m.avg_r ?? "", m.profit_factor ?? "", m.max_drawdown.toFixed(dp),
      m.by_side.long.trades, m.by_side.long.total_pnl.toFixed(dp), m.by_side.long.total_r ?? "",
      m.by_side.short.trades, m.by_side.short.total_pnl.toFixed(dp), m.by_side.short.total_r ?? "",
    ].join(",");
  });
  const csv = [header.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "optimiser-results.csv";
  a.click();
  URL.revokeObjectURL(url);
}

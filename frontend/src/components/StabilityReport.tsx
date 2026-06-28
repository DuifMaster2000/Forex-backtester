import SweepChart from "./SweepChart";
import { METRIC_LABELS, PARAM_LABELS, type SweepResult } from "../engine/sweep";

interface Props {
  result: SweepResult | null;
  precision: number;
  hasDataset: boolean;
}

export default function StabilityReport({ result, precision, hasDataset }: Props) {
  if (!result) {
    return (
      <div className="panel">
        <h3>Stability report</h3>
        <p className="muted">
          {hasDataset
            ? "Pick a parameter to vary on the left and run the sweep."
            : "Upload a CSV to begin."}
        </p>
      </div>
    );
  }

  const dp = Math.max(2, precision);
  const yFormat = metricFormatter(result.metric, dp);
  const xLabel = PARAM_LABELS[result.param];
  const yLabel = METRIC_LABELS[result.metric];

  // Union of x values across series for the table.
  const xs = [...new Set(result.series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);

  return (
    <div className="panel">
      <h3>Stability report</h3>
      <p className="muted report-summary">
        {yLabel} vs {xLabel}
        {result.series.length > 1 ? ` · ${result.series.length} series` : ""}
        {" · look for a broad plateau, not a single spike"}
      </p>

      <SweepChart series={result.series} xLabel={xLabel} yLabel={yLabel} yFormat={yFormat} />

      <table className="sides sweep-table">
        <thead>
          <tr>
            <th>{xLabel}</th>
            {result.series.map((s) => <th key={s.label}>{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {xs.map((x) => (
            <tr key={x}>
              <td>{Number(x.toFixed(4))}</td>
              {result.series.map((s) => {
                const pt = s.points.find((p) => p.x === x);
                return <td key={s.label}>{pt && pt.y != null ? yFormat(pt.y) : "—"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function metricFormatter(metric: string, dp: number): (v: number) => string {
  if (metric === "trades") return (v) => String(Math.round(v));
  if (metric === "win_rate") return (v) => `${v.toFixed(0)}%`;
  if (metric === "profit_factor" || metric === "total_r" || metric === "return_dd")
    return (v) => v.toFixed(2);
  return (v) => v.toFixed(dp); // total_pnl, expectancy
}

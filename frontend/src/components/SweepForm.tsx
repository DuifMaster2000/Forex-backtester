import { useState } from "react";
import {
  METRIC_LABELS,
  PARAM_LABELS,
  type SeriesBy,
  type SweepMetric,
  type SweepParam,
  type SweepSpec,
} from "../engine/sweep";

const DEFAULTS: Record<SweepParam, { min: number; max: number; step: number }> = {
  entry_delay: { min: 0, max: 8, step: 0.5 },
  time_stop: { min: 12, max: 96, step: 6 },
  gap_window: { min: 10, max: 40, step: 2 },
  gap_sigma: { min: 1.0, max: 3.0, step: 0.1 },
  sl_value: { min: 0.25, max: 2.0, step: 0.25 },
  tp_value: { min: 0.5, max: 4.0, step: 0.25 },
};

interface Props {
  disabled: boolean;
  running: boolean;
  onRun: (spec: SweepSpec) => void;
}

export default function SweepForm({ disabled, running, onRun }: Props) {
  const [param, setParam] = useState<SweepParam>("entry_delay");
  const [range, setRange] = useState(DEFAULTS.entry_delay);
  const [series, setSeries] = useState<SeriesBy>("none");
  const [metric, setMetric] = useState<SweepMetric>("total_pnl");

  function changeParam(p: SweepParam) {
    setParam(p);
    setRange(DEFAULTS[p]);
  }

  const steps = range.step > 0 ? Math.floor((range.max - range.min) / range.step) + 1 : 0;

  return (
    <div className="panel">
      <h3>Stability sweep</h3>
      <p className="muted small">
        Vary one parameter (using the strategy above as the base) and plot a metric
        to check for a stable plateau rather than a single profitable spike.
      </p>

      <label>Parameter to vary</label>
      <select value={param} onChange={(e) => changeParam(e.target.value as SweepParam)}>
        {(Object.keys(PARAM_LABELS) as SweepParam[]).map((p) => (
          <option key={p} value={p}>{PARAM_LABELS[p]}</option>
        ))}
      </select>

      <div className="row">
        <div>
          <label>Min</label>
          <input type="number" step={0.05} value={range.min}
            onChange={(e) => setRange({ ...range, min: Number(e.target.value) })} />
        </div>
        <div>
          <label>Max</label>
          <input type="number" step={0.05} value={range.max}
            onChange={(e) => setRange({ ...range, max: Number(e.target.value) })} />
        </div>
        <div>
          <label>Step</label>
          <input type="number" step={0.05} value={range.step}
            onChange={(e) => setRange({ ...range, step: Number(e.target.value) })} />
        </div>
      </div>

      <label>Compare across (series)</label>
      <select value={series} onChange={(e) => setSeries(e.target.value as SeriesBy)}>
        <option value="none">None (single line)</option>
        <option value="direction">Direction (fade vs follow)</option>
        <option value="session">Session (NY/London/Tokyo)</option>
      </select>

      <label>Plot metric</label>
      <select value={metric} onChange={(e) => setMetric(e.target.value as SweepMetric)}>
        {(Object.keys(METRIC_LABELS) as SweepMetric[]).map((m) => (
          <option key={m} value={m}>{METRIC_LABELS[m]}</option>
        ))}
      </select>

      <div className="combo-count">{steps} point{steps === 1 ? "" : "s"} per line</div>

      <button className="run" disabled={disabled || running || steps < 2}
        onClick={() => onRun({ param, ...range, series, metric })}>
        {running ? "Running…" : "Run sweep"}
      </button>
    </div>
  );
}

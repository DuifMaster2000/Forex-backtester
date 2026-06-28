import { useState } from "react";
import NumberInput from "./NumberInput";
import type { Session } from "../api/client";
import type { GridSpec, LevelMode, NumRange, RankMetric } from "../engine/grid";
import { countGrid } from "../engine/grid";

export const DEFAULT_GRID: GridSpec = {
  sessions: ["NY"],
  directions: ["fade"],
  gapWindow: { vary: false, fixed: 20, min: 10, max: 30, step: 5 },
  gapSigma: { vary: true, fixed: 1.5, min: 1.0, max: 2.5, step: 0.5 },
  entryOffsetHours: { vary: false, fixed: 0, min: 0, max: 4, step: 1 },
  timeStop: { enabled: true, vary: true, fixed: 24, min: 12, max: 96, step: 12 },
  sl: { enabled: true, mode: "adr_multiple", vary: true, fixed: 0.5, min: 0.25, max: 1.5, step: 0.25 },
  tp: { enabled: true, mode: "adr_multiple", vary: true, fixed: 1.0, min: 0.5, max: 3.0, step: 0.5 },
  rankBy: "total_r",
};

const MAX_COMBOS = 50000;

interface Props {
  sessions: Session[];
  disabled: boolean;
  running: boolean;
  progress: { done: number; total: number } | null;
  onRun: (spec: GridSpec) => void;
}

export default function BruteForceForm({ sessions, disabled, running, progress, onRun }: Props) {
  const [spec, setSpec] = useState<GridSpec>(DEFAULT_GRID);
  const set = (patch: Partial<GridSpec>) => setSpec((s) => ({ ...s, ...patch }));

  const [err, setErr] = useState<string | null>(null);
  const rangesOk =
    rangeOk(spec.gapWindow) && rangeOk(spec.gapSigma) && rangeOk(spec.entryOffsetHours) &&
    (!spec.timeStop.enabled || rangeOk(spec.timeStop)) &&
    (!spec.sl.enabled || rangeOk(spec.sl)) &&
    (!spec.tp.enabled || rangeOk(spec.tp));
  const combos = rangesOk ? countGrid(spec) : null;
  const tooMany = combos != null && combos > MAX_COMBOS;

  function toggle<T>(list: T[], v: T): T[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  function launch() {
    if (!rangesOk) return setErr("Please fill in all range fields before running.");
    if (spec.sessions.length === 0 || spec.directions.length === 0)
      return setErr("Select at least one session and one direction.");
    if (tooMany) return setErr(`Too many combinations (max ${MAX_COMBOS.toLocaleString()}).`);
    setErr(null);
    onRun(spec);
  }

  return (
    <div className="panel">
      <h3>Brute-force optimiser</h3>

      <label>Sessions</label>
      <div className="chips">
        {sessions.map((s) => (
          <button
            key={s.name}
            className={`chip ${spec.sessions.includes(s.name) ? "on" : ""}`}
            onClick={() => set({ sessions: toggle(spec.sessions, s.name) })}
          >
            {s.name}
          </button>
        ))}
      </div>

      <label>Direction</label>
      <div className="chips">
        {(["fade", "follow"] as const).map((d) => (
          <button
            key={d}
            className={`chip ${spec.directions.includes(d) ? "on" : ""}`}
            onClick={() => set({ directions: toggle(spec.directions, d) })}
          >
            {d}
          </button>
        ))}
      </div>

      <RangeRow label="Gap window" intStep value={spec.gapWindow}
        onChange={(v) => set({ gapWindow: v })} />
      <RangeRow label="Gap sigma" value={spec.gapSigma} onChange={(v) => set({ gapSigma: v })} />
      <RangeRow label="Entry delay (h)" value={spec.entryOffsetHours}
        onChange={(v) => set({ entryOffsetHours: v })} />

      <ToggleRange label="Time stop (h)" enabled={spec.timeStop.enabled}
        onToggle={(e) => set({ timeStop: { ...spec.timeStop, enabled: e } })}
        value={spec.timeStop} onChange={(v) => set({ timeStop: { ...spec.timeStop, ...v } })} />

      <ToggleRange label="Stop loss" enabled={spec.sl.enabled}
        onToggle={(e) => set({ sl: { ...spec.sl, enabled: e } })}
        mode={spec.sl.mode} onMode={(m) => set({ sl: { ...spec.sl, mode: m } })}
        value={spec.sl} onChange={(v) => set({ sl: { ...spec.sl, ...v } })} />

      <ToggleRange label="Take profit" enabled={spec.tp.enabled}
        onToggle={(e) => set({ tp: { ...spec.tp, enabled: e } })}
        mode={spec.tp.mode} onMode={(m) => set({ tp: { ...spec.tp, mode: m } })}
        value={spec.tp} onChange={(v) => set({ tp: { ...spec.tp, ...v } })} />

      <label>Rank by</label>
      <select value={spec.rankBy} onChange={(e) => set({ rankBy: e.target.value as RankMetric })}>
        <option value="total_r">Total R</option>
        <option value="total_pnl">Total P/L</option>
        <option value="profit_factor">Profit factor</option>
        <option value="expectancy">Expectancy</option>
        <option value="win_rate">Win rate</option>
      </select>

      <div className="combo-count">
        {combos == null ? "—" : `${combos.toLocaleString()} combination${combos === 1 ? "" : "s"}`}
        {tooMany && <span className="error"> · over {MAX_COMBOS.toLocaleString()} limit</span>}
      </div>

      {running && progress && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          <span>{progress.done.toLocaleString()} / {progress.total.toLocaleString()}</span>
        </div>
      )}

      {err && <p className="error field-error">{err}</p>}
      <button className="run" disabled={disabled || running} onClick={launch}>
        {running ? "Running…" : "Run optimiser"}
      </button>
    </div>
  );
}

function rangeOk(r: NumRange): boolean {
  return r.vary
    ? [r.min, r.max, r.step].every(Number.isFinite) && r.step > 0
    : Number.isFinite(r.fixed);
}

interface RangeProps {
  label: string;
  value: NumRange;
  onChange: (v: NumRange) => void;
  intStep?: boolean;
}

function RangeRow({ label, value, onChange, intStep }: RangeProps) {
  const step = intStep ? 1 : 0.05;
  return (
    <div className="level">
      <div className="check">
        <input type="checkbox" checked={value.vary}
          onChange={(e) => onChange({ ...value, vary: e.target.checked })} />
        <label>{label}</label>
      </div>
      {value.vary ? (
        <div className="row">
          <NumInput ph="min" step={step} v={value.min} on={(n) => onChange({ ...value, min: n })} />
          <NumInput ph="max" step={step} v={value.max} on={(n) => onChange({ ...value, max: n })} />
          <NumInput ph="step" step={step} v={value.step} on={(n) => onChange({ ...value, step: n })} />
        </div>
      ) : (
        <NumInput ph="fixed" step={step} v={value.fixed} on={(n) => onChange({ ...value, fixed: n })} />
      )}
    </div>
  );
}

interface ToggleRangeProps extends RangeProps {
  enabled: boolean;
  onToggle: (e: boolean) => void;
  mode?: LevelMode;
  onMode?: (m: LevelMode) => void;
}

function ToggleRange({ label, enabled, onToggle, mode, onMode, value, onChange }: ToggleRangeProps) {
  return (
    <div className="level">
      <div className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        <label>{label}</label>
        {enabled && mode && onMode && (
          <select className="inline-mode" value={mode}
            onChange={(e) => onMode(e.target.value as LevelMode)}>
            <option value="points">Points</option>
            <option value="percent">Percent</option>
            <option value="gap_multiple">Gap mult</option>
            <option value="adr_multiple">ADR mult</option>
          </select>
        )}
      </div>
      {enabled && (
        value.vary ? (
          <div className="row">
            <NumInput ph="min" step={0.05} v={value.min} on={(n) => onChange({ ...value, min: n })} />
            <NumInput ph="max" step={0.05} v={value.max} on={(n) => onChange({ ...value, max: n })} />
            <NumInput ph="step" step={0.05} v={value.step} on={(n) => onChange({ ...value, step: n })} />
          </div>
        ) : (
          <NumInput ph="fixed" step={0.05} v={value.fixed} on={(n) => onChange({ ...value, fixed: n })} />
        )
      )}
      {enabled && (
        <div className="check tiny">
          <input type="checkbox" checked={value.vary}
            onChange={(e) => onChange({ ...value, vary: e.target.checked })} />
          <label>vary</label>
        </div>
      )}
    </div>
  );
}

function NumInput({ v, on, ph, step }: { v: number; on: (n: number) => void; ph: string; step: number }) {
  return <NumberInput value={v} onChange={on} placeholder={ph} title={ph} step={step} />;
}

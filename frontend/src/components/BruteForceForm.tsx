import { useState } from "react";
import NumberInput from "./NumberInput";
import type { Session, Strategy } from "../api/client";
import type { GridSpec, LevelMode, NumRange, RankMetric } from "../engine/grid";
import { countGrid } from "../engine/grid";

export const DEFAULT_GRID: GridSpec = {
  strategy: "base",
  sessions: ["NY"],
  directions: ["fade"],
  gapWindow: { vary: false, fixed: 20, min: 10, max: 30, step: 5 },
  gapSigma: { vary: true, fixed: 1.5, min: 1.0, max: 2.5, step: 0.5 },
  entryOffsetHours: { vary: false, fixed: 0, min: 0, max: 4, step: 1 },
  entryTimes: ["14:00"],
  entryTime: { vary: false, fixed: 0, min: 0, max: 24, step: 0.5 }, // hours after open
  entryTime2: { vary: false, fixed: 0, min: 0, max: 24, step: 0.5 }, // optional 2nd time
  entryTimeout: { vary: false, fixed: 48, min: 24, max: 72, step: 12 },
  invert: [false],
  invertMultiple: { vary: false, fixed: 1.0, min: 0.5, max: 2, step: 0.25 },
  invertOffsetHours: { vary: false, fixed: 1, min: 0, max: 4, step: 0.5 },
  invertCustomExits: false,
  invertSl: { enabled: false, mode: "gap_multiple", vary: false, fixed: 1.0, min: 0.25, max: 1.5, step: 0.25 },
  invertTp: { enabled: false, mode: "gap_multiple", vary: false, fixed: 1.0, min: 0.5, max: 3.0, step: 0.5 },
  timeStop: { enabled: true, vary: true, fixed: 24, min: 12, max: 96, step: 12 },
  sl: { enabled: true, mode: "adr_multiple", vary: true, fixed: 0.5, min: 0.25, max: 1.5, step: 0.25 },
  tp: { enabled: true, mode: "adr_multiple", vary: true, fixed: 1.0, min: 0.5, max: 3.0, step: 0.5 },
  spread: 0,
  rankBy: "total_r",
  rankMinTrades: 10,
};


function isValidTime(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

interface Props {
  strategy: Strategy;
  sessions: Session[];
  disabled: boolean;
  running: boolean;
  progress: { done: number; total: number } | null;
  onRun: (spec: GridSpec) => void;
}

export default function BruteForceForm({ strategy, sessions, disabled, running, progress, onRun }: Props) {
  const [spec, setSpec] = useState<GridSpec>(DEFAULT_GRID);
  const set = (patch: Partial<GridSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const isFollow = strategy === "follow_filters";
  // The strategy is owned by the top-level menu, not this form's local state.
  const effectiveSpec: GridSpec = { ...spec, strategy };

  const [err, setErr] = useState<string | null>(null);
  const rangesOk =
    rangeOk(spec.gapWindow) && rangeOk(spec.gapSigma) &&
    (isFollow ? rangeOk(spec.entryTimeout) : rangeOk(spec.entryOffsetHours)) &&
    (!isFollow || !spec.entryTime.vary || rangeOk(spec.entryTime)) &&
    (!isFollow || !spec.entryTime.vary || !spec.entryTime2.vary || rangeOk(spec.entryTime2)) &&
    (!spec.timeStop.enabled || rangeOk(spec.timeStop)) &&
    (!spec.sl.enabled || rangeOk(spec.sl)) &&
    (!spec.tp.enabled || rangeOk(spec.tp)) &&
    (!(isFollow && spec.invertCustomExits && spec.invertSl.enabled) || rangeOk(spec.invertSl)) &&
    (!(isFollow && spec.invertCustomExits && spec.invertTp.enabled) || rangeOk(spec.invertTp));
  const combos = rangesOk ? countGrid(effectiveSpec) : null;
  // Loosely flag very large grids so the user knows it'll be a long run — but it's
  // their call whether to proceed (no hard cap).
  const heavy = combos != null && combos > 100000;

  function toggle<T>(list: T[], v: T): T[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }

  function launch() {
    if (!rangesOk) return setErr("Please fill in all range fields before running.");
    if (spec.sessions.length === 0) return setErr("Select at least one session.");
    if (!isFollow && spec.directions.length === 0)
      return setErr("Select at least one direction.");
    if (isFollow && !spec.entryTime.vary && spec.entryTimes.filter(isValidTime).length === 0)
      return setErr("Add at least one valid entry time (HH:MM).");
    if (isFollow && spec.invert.length === 0)
      return setErr("Select at least one inversion setting (off and/or on).");
    if (isFollow && spec.invert.includes(true) &&
        ![spec.invertMultiple.fixed, spec.invertOffsetHours.fixed].every(Number.isFinite))
      return setErr("Fill in the inversion reach multiple and entry offset.");
    setErr(null);
    onRun(effectiveSpec);
  }

  return (
    <div className="panel">
      <h3>Brute-force optimiser{isFollow ? " · follow + filters" : ""}</h3>

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

      {isFollow ? (
        <>
          <div className="check">
            <input
              type="checkbox"
              checked={spec.entryTime.vary}
              onChange={(e) => set({ entryTime: { ...spec.entryTime, vary: e.target.checked } })}
            />
            <label>Sweep entry time across the day</label>
          </div>

          {spec.entryTime.vary ? (
            <>
              <label>Hours after open (0–24)</label>
              <div className="row">
                <NumberInput title="from" placeholder="from" min={0} max={24} step={0.5}
                  value={spec.entryTime.min}
                  onChange={(n) => set({ entryTime: { ...spec.entryTime, min: n } })} />
                <NumberInput title="to" placeholder="to" min={0} max={24} step={0.5}
                  value={spec.entryTime.max}
                  onChange={(n) => set({ entryTime: { ...spec.entryTime, max: n } })} />
                <NumberInput title="step" placeholder="step" min={0.5} step={0.5}
                  value={spec.entryTime.step}
                  onChange={(n) => set({ entryTime: { ...spec.entryTime, step: n } })} />
              </div>
              <div className="muted small">
                One recurring entry per run, swept N hours after the session open —
                values past the open's distance to midnight roll into the next day.
              </div>

              <div className="check">
                <input
                  type="checkbox"
                  checked={spec.entryTime2.vary}
                  onChange={(e) => set({ entryTime2: { ...spec.entryTime2, vary: e.target.checked } })}
                />
                <label>Add a second entry time</label>
              </div>
              {spec.entryTime2.vary && (
                <>
                  <label>2nd entry — hours after open (0–24)</label>
                  <div className="row">
                    <NumberInput title="from" placeholder="from" min={0} max={24} step={0.5}
                      value={spec.entryTime2.min}
                      onChange={(n) => set({ entryTime2: { ...spec.entryTime2, min: n } })} />
                    <NumberInput title="to" placeholder="to" min={0} max={24} step={0.5}
                      value={spec.entryTime2.max}
                      onChange={(n) => set({ entryTime2: { ...spec.entryTime2, max: n } })} />
                    <NumberInput title="step" placeholder="step" min={0.5} step={0.5}
                      value={spec.entryTime2.step}
                      onChange={(n) => set({ entryTime2: { ...spec.entryTime2, step: n } })} />
                  </div>
                  <div className="muted small">
                    Two chances per cycle (first qualifying taken). Combos = time1 × time2.
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <label>Entry times (session tz)</label>
              {spec.entryTimes.map((t, i) => (
                <div className="row entry-time" key={i}>
                  <input
                    type="time"
                    value={t}
                    onChange={(e) =>
                      set({ entryTimes: spec.entryTimes.map((x, k) => (k === i ? e.target.value : x)) })
                    }
                  />
                  <button
                    className="chip"
                    title="Remove"
                    onClick={() => set({ entryTimes: spec.entryTimes.filter((_, k) => k !== i) })}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button className="chip" onClick={() => set({ entryTimes: [...spec.entryTimes, "14:00"] })}>
                + Add time
              </button>
              <div className="muted small">Follow-only; first qualifying entry time is taken.</div>
            </>
          )}

          <label>Test inversion clause</label>
          <div className="chips">
            {([false, true] as const).map((v) => (
              <button
                key={String(v)}
                className={`chip ${spec.invert.includes(v) ? "on" : ""}`}
                onClick={() => set({ invert: toggle(spec.invert, v) })}
              >
                {v ? "on" : "off"}
              </button>
            ))}
          </div>
          {spec.invert.includes(true) && (
            <div className="row">
              <div>
                <label>Reach (× gap)</label>
                <NumberInput min={0} step={0.1} value={spec.invertMultiple.fixed}
                  onChange={(n) => set({ invertMultiple: { ...spec.invertMultiple, fixed: n } })} />
              </div>
              <div>
                <label>Inv. entry (h)</label>
                <NumberInput min={0} step={0.5} value={spec.invertOffsetHours.fixed}
                  onChange={(n) => set({ invertOffsetHours: { ...spec.invertOffsetHours, fixed: n } })} />
              </div>
            </div>
          )}
          {spec.invert.includes(true) && (
            <div className="check">
              <input type="checkbox" checked={spec.invertCustomExits}
                onChange={(e) => set({ invertCustomExits: e.target.checked })} />
              <label>Custom SL/TP for inversion</label>
            </div>
          )}
          {spec.invert.includes(true) && spec.invertCustomExits && (
            <>
              <ToggleRange label="Inversion stop loss" enabled={spec.invertSl.enabled}
                onToggle={(e) => set({ invertSl: { ...spec.invertSl, enabled: e } })}
                mode={spec.invertSl.mode} onMode={(m) => set({ invertSl: { ...spec.invertSl, mode: m } })}
                value={spec.invertSl} onChange={(v) => set({ invertSl: { ...spec.invertSl, ...v } })} />
              <ToggleRange label="Inversion take profit" enabled={spec.invertTp.enabled}
                onToggle={(e) => set({ invertTp: { ...spec.invertTp, enabled: e } })}
                mode={spec.invertTp.mode} onMode={(m) => set({ invertTp: { ...spec.invertTp, mode: m } })}
                value={spec.invertTp} onChange={(v) => set({ invertTp: { ...spec.invertTp, ...v } })} />
            </>
          )}
        </>
      ) : (
        <>
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
        </>
      )}

      <RangeRow label="Gap window" intStep value={spec.gapWindow}
        onChange={(v) => set({ gapWindow: v })} />
      <RangeRow label="Gap sigma" value={spec.gapSigma} onChange={(v) => set({ gapSigma: v })} />
      {isFollow ? (
        <RangeRow label="Wait timeout (h)" value={spec.entryTimeout}
          onChange={(v) => set({ entryTimeout: v })} />
      ) : (
        <RangeRow label="Entry delay (h)" value={spec.entryOffsetHours}
          onChange={(v) => set({ entryOffsetHours: v })} />
      )}

      <ToggleRange label={isFollow ? "Time stop after entry (h)" : "Time stop (h)"} enabled={spec.timeStop.enabled}
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

      <label>Spread (price units, per trade)</label>
      <NumberInput min={0} step={0.0001} value={spec.spread}
        onChange={(n) => set({ spread: n })} />
      <div className="muted small">applied to all combinations · e.g. 0.00015 = 1.5 pips</div>

      <label>Rank by</label>
      <select value={spec.rankBy} onChange={(e) => set({ rankBy: e.target.value as RankMetric })}>
        <option value="total_r">Total R</option>
        <option value="total_pnl">Total P/L</option>
        <option value="return_dd">Return / Max DD</option>
        <option value="linear_score">Linear score (Return/DD × R²)</option>
        <option value="k_ratio">K-ratio (trend reliability)</option>
        <option value="profit_factor">Profit factor</option>
        <option value="expectancy">Expectancy</option>
        <option value="win_rate">Win rate</option>
      </select>

      <label>Min trades to rank</label>
      <NumberInput min={0} step={1} value={spec.rankMinTrades}
        onChange={(n) => set({ rankMinTrades: n })} />
      <div className="muted small">
        Configs with fewer trades rank last — keeps the linearity metrics off tiny,
        fragile samples. 0 = off.
      </div>

      <div className="combo-count">
        {combos == null ? "—" : `${combos.toLocaleString()} combination${combos === 1 ? "" : "s"}`}
        {heavy && <span className="muted"> · large run, may take a while</span>}
      </div>
      <div className="muted small">
        Runs across {navigator.hardwareConcurrency || "?"} CPU core
        {navigator.hardwareConcurrency === 1 ? "" : "s"}
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

import { useEffect, useMemo, useState } from "react";
import NumberInput from "./NumberInput";
import type { BacktestConfig, PriceLevel, Session } from "../api/client";

interface Props {
  sessions: Session[];
  session: string;
  onSessionChange: (session: string) => void;
  disabled: boolean;
  onRun: (config: BacktestConfig) => void;
  // Emitted on every change so callers (e.g. the stability sweep) can use the
  // current form values as a base config.
  onChange?: (config: BacktestConfig) => void;
}

type LevelMode = PriceLevel["mode"];

// Hours -> whole minutes snapped to 30-min intervals (NaN propagates when blank).
function snapMinutes(hours: number): number {
  return Math.max(0, Math.round((hours * 60) / 30) * 30);
}

export default function StrategyForm({
  sessions,
  session,
  onSessionChange,
  disabled,
  onRun,
  onChange,
}: Props) {
  const [gapWindow, setGapWindow] = useState(20);
  const [gapSigma, setGapSigma] = useState(1.5);
  const [direction, setDirection] = useState<"fade" | "follow">("fade");
  // Durations from the gap, in hours (snapped to 30-min steps in the config).
  const [entryOffsetHours, setEntryOffsetHours] = useState(0);

  const [slOn, setSlOn] = useState(true);
  const [slMode, setSlMode] = useState<LevelMode>("gap_multiple");
  const [slValue, setSlValue] = useState(1.0);

  const [tpOn, setTpOn] = useState(true);
  const [tpMode, setTpMode] = useState<LevelMode>("gap_multiple");
  const [tpValue, setTpValue] = useState(1.0);

  const [timeStopOn, setTimeStopOn] = useState(true);
  const [timeStopHours, setTimeStopHours] = useState(24);
  const [spread, setSpread] = useState(0);
  const [intrabar, setIntrabar] = useState<"stop_first" | "target_first">("stop_first");
  const [err, setErr] = useState<string | null>(null);

  const config = useMemo<BacktestConfig>(
    () => ({
      session,
      gap_window: gapWindow,
      gap_sigma: gapSigma,
      direction,
      entry_offset_minutes: snapMinutes(entryOffsetHours),
      adr_window: 20,
      stop_loss: slOn ? { mode: slMode, value: slValue } : null,
      take_profit: tpOn ? { mode: tpMode, value: tpValue } : null,
      time_stop_minutes: timeStopOn ? snapMinutes(timeStopHours) : null,
      intrabar,
      spread: Number.isFinite(spread) ? spread : 0, // blank = frictionless
    }),
    [session, gapWindow, gapSigma, direction, entryOffsetHours, slOn, slMode, slValue,
      tpOn, tpMode, tpValue, timeStopOn, timeStopHours, spread, intrabar]
  );

  useEffect(() => onChange?.(config), [config, onChange]);

  function submit() {
    const required = [gapWindow, gapSigma, entryOffsetHours];
    if (slOn) required.push(slValue);
    if (tpOn) required.push(tpValue);
    if (timeStopOn) required.push(timeStopHours);
    if (required.some((n) => !Number.isFinite(n))) {
      setErr("Please fill in all fields before running.");
      return;
    }
    setErr(null);
    onRun(config);
  }

  return (
    <div className="panel">
      <h3>Gap strategy</h3>

      <label>Session</label>
      <select value={session} onChange={(e) => onSessionChange(e.target.value)}>
        {sessions.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name} ({s.open_time}–{s.close_time} {s.tz})
          </option>
        ))}
      </select>

      <div className="row">
        <div>
          <label>Gap window (sessions)</label>
          <NumberInput min={2} value={gapWindow} onChange={setGapWindow} />
        </div>
        <div>
          <label>Sigma threshold</label>
          <NumberInput step={0.1} min={0} value={gapSigma} onChange={setGapSigma} />
        </div>
      </div>

      <label>Direction</label>
      <select value={direction} onChange={(e) => setDirection(e.target.value as "fade" | "follow")}>
        <option value="fade">Fade the gap</option>
        <option value="follow">Follow the gap</option>
      </select>

      <label>Entry delay after gap (hours)</label>
      <NumberInput min={0} max={48} step={0.5} value={entryOffsetHours}
        onChange={setEntryOffsetHours} />

      <LevelRow label="Stop loss" on={slOn} setOn={setSlOn}
        mode={slMode} setMode={setSlMode} value={slValue} setValue={setSlValue} />
      <LevelRow label="Take profit" on={tpOn} setOn={setTpOn}
        mode={tpMode} setMode={setTpMode} value={tpValue} setValue={setTpValue} />

      <div className="check">
        <input type="checkbox" checked={timeStopOn}
          onChange={(e) => setTimeStopOn(e.target.checked)} />
        <label>Time stop after gap (hours)</label>
        <NumberInput min={0.5} max={96} step={0.5} value={timeStopHours}
          disabled={!timeStopOn} onChange={setTimeStopHours} />
      </div>

      <label>Spread (price units, per trade)</label>
      <NumberInput min={0} step={0.0001} value={spread} onChange={setSpread} />
      <div className="muted small">e.g. 0.00015 = 1.5 pips · gold 0.30 · blank = none</div>

      <label>Same-bar SL/TP resolution</label>
      <select value={intrabar}
        onChange={(e) => setIntrabar(e.target.value as "stop_first" | "target_first")}>
        <option value="stop_first">Stop first (conservative)</option>
        <option value="target_first">Target first (optimistic)</option>
      </select>

      {err && <p className="error field-error">{err}</p>}
      <button className="run" disabled={disabled} onClick={submit}>
        Run backtest
      </button>
    </div>
  );
}

interface LevelProps {
  label: string;
  on: boolean;
  setOn: (v: boolean) => void;
  mode: LevelMode;
  setMode: (v: LevelMode) => void;
  value: number;
  setValue: (v: number) => void;
}

function LevelRow({ label, on, setOn, mode, setMode, value, setValue }: LevelProps) {
  return (
    <div className="level">
      <div className="check">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <label>{label}</label>
      </div>
      <div className="row">
        <select value={mode} disabled={!on}
          onChange={(e) => setMode(e.target.value as LevelMode)}>
          <option value="points">Points</option>
          <option value="percent">Percent</option>
          <option value="gap_multiple">Gap multiple</option>
          <option value="adr_multiple">ADR multiple</option>
        </select>
        <NumberInput step={0.1} min={0} value={value} disabled={!on} onChange={setValue} />
      </div>
    </div>
  );
}

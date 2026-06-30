import { useEffect, useMemo, useState } from "react";
import NumberInput from "./NumberInput";
import type { BacktestConfig, PriceLevel, Session, Strategy } from "../api/client";

interface Props {
  strategy: Strategy;
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

function isValidTime(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

export default function StrategyForm({
  strategy,
  sessions,
  session,
  onSessionChange,
  disabled,
  onRun,
  onChange,
}: Props) {
  const isFollow = strategy === "follow_filters";

  const [gapWindow, setGapWindow] = useState(20);
  const [gapSigma, setGapSigma] = useState(1.5);
  const [direction, setDirection] = useState<"fade" | "follow">("fade");
  // Durations from the gap, in hours (snapped to 30-min steps in the config).
  const [entryOffsetHours, setEntryOffsetHours] = useState(0);

  // follow_filters: list of allowed entry times + wait timeout.
  const [entryTimes, setEntryTimes] = useState<string[]>(["14:00"]);
  const [timeoutHours, setTimeoutHours] = useState(48);

  // follow_filters inversion clause.
  const [invertOn, setInvertOn] = useState(false);
  const [invertMult, setInvertMult] = useState(1.0);
  const [invertOffsetHours, setInvertOffsetHours] = useState(1);
  const [invCustomExits, setInvCustomExits] = useState(false);
  const [invSlOn, setInvSlOn] = useState(true);
  const [invSlMode, setInvSlMode] = useState<LevelMode>("gap_multiple");
  const [invSlValue, setInvSlValue] = useState(1.0);
  const [invTpOn, setInvTpOn] = useState(true);
  const [invTpMode, setInvTpMode] = useState<LevelMode>("gap_multiple");
  const [invTpValue, setInvTpValue] = useState(1.0);

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
      strategy,
      session,
      gap_window: gapWindow,
      gap_sigma: gapSigma,
      // follow_filters always follows the gap; direction picker is base-only.
      direction: isFollow ? "follow" : direction,
      entry_offset_minutes: isFollow ? 0 : snapMinutes(entryOffsetHours),
      entry_times: isFollow ? entryTimes.filter(isValidTime) : [],
      entry_timeout_minutes: snapMinutes(timeoutHours),
      invert_enabled: isFollow ? invertOn : false,
      invert_gap_multiple: invertMult,
      invert_entry_offset_minutes: snapMinutes(invertOffsetHours),
      invert_custom_exits: isFollow ? invCustomExits : false,
      invert_stop_loss: invCustomExits && invSlOn ? { mode: invSlMode, value: invSlValue } : null,
      invert_take_profit: invCustomExits && invTpOn ? { mode: invTpMode, value: invTpValue } : null,
      adr_window: 20,
      stop_loss: slOn ? { mode: slMode, value: slValue } : null,
      take_profit: tpOn ? { mode: tpMode, value: tpValue } : null,
      time_stop_minutes: timeStopOn ? snapMinutes(timeStopHours) : null,
      intrabar,
      spread: Number.isFinite(spread) ? spread : 0, // blank = frictionless
    }),
    [strategy, isFollow, session, gapWindow, gapSigma, direction, entryOffsetHours,
      entryTimes, timeoutHours, invertOn, invertMult, invertOffsetHours,
      invCustomExits, invSlOn, invSlMode, invSlValue, invTpOn, invTpMode, invTpValue,
      slOn, slMode, slValue, tpOn, tpMode, tpValue,
      timeStopOn, timeStopHours, spread, intrabar]
  );

  useEffect(() => onChange?.(config), [config, onChange]);

  function submit() {
    const required = [gapWindow, gapSigma];
    if (isFollow) {
      required.push(timeoutHours);
      if (invertOn) {
        required.push(invertMult, invertOffsetHours);
        if (invCustomExits && invSlOn) required.push(invSlValue);
        if (invCustomExits && invTpOn) required.push(invTpValue);
      }
    } else required.push(entryOffsetHours);
    if (slOn) required.push(slValue);
    if (tpOn) required.push(tpValue);
    if (timeStopOn) required.push(timeStopHours);
    if (required.some((n) => !Number.isFinite(n))) {
      setErr("Please fill in all fields before running.");
      return;
    }
    if (isFollow && entryTimes.filter(isValidTime).length === 0) {
      setErr("Add at least one valid entry time (HH:MM).");
      return;
    }
    setErr(null);
    onRun(config);
  }

  return (
    <div className="panel">
      <h3>{isFollow ? "Follow only + filters" : "Gap strategy"}</h3>

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

      {isFollow ? (
        <>
          <label>Entry times (session tz)</label>
          {entryTimes.map((t, i) => (
            <div className="row entry-time" key={i}>
              <input
                type="time"
                value={t}
                onChange={(e) => updateAt(entryTimes, setEntryTimes, i, e.target.value)}
              />
              <button
                className="chip"
                title="Remove"
                onClick={() => setEntryTimes(entryTimes.filter((_, k) => k !== i))}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="chip" onClick={() => setEntryTimes([...entryTimes, "14:00"])}>
            + Add time
          </button>
          <div className="muted small">
            The first time whose pullback condition holds (price back through the gap
            level) is taken. Use bar-aligned times, e.g. 14:00 / 14:30 for 30-min data.
          </div>

          <label>Wait timeout (hours)</label>
          <NumberInput min={0.5} step={0.5} value={timeoutHours} onChange={setTimeoutHours} />
          <div className="muted small">
            Signal is voided (no trade) if no good entry appears within this window.
          </div>

          <div className="check">
            <input type="checkbox" checked={invertOn}
              onChange={(e) => setInvertOn(e.target.checked)} />
            <label>Inversion clause</label>
          </div>
          {invertOn && (
            <>
              <div className="row">
                <div>
                  <label>Reach (× gap)</label>
                  <NumberInput min={0} step={0.1} value={invertMult} onChange={setInvertMult} />
                </div>
                <div>
                  <label>Inverted entry (h after next open)</label>
                  <NumberInput min={0} step={0.5} value={invertOffsetHours}
                    onChange={setInvertOffsetHours} />
                </div>
              </div>
              <div className="muted small">
                If no follow entry fires and the next session opens more than this
                multiple of the gap further in the gap direction, fade it at the
                configured time after that open.
              </div>

              <div className="check">
                <input type="checkbox" checked={invCustomExits}
                  onChange={(e) => setInvCustomExits(e.target.checked)} />
                <label>Custom SL/TP for inversion trades</label>
              </div>
              {invCustomExits && (
                <>
                  <LevelRow label="Inversion stop loss" on={invSlOn} setOn={setInvSlOn}
                    mode={invSlMode} setMode={setInvSlMode} value={invSlValue} setValue={setInvSlValue} />
                  <LevelRow label="Inversion take profit" on={invTpOn} setOn={setInvTpOn}
                    mode={invTpMode} setMode={setInvTpMode} value={invTpValue} setValue={setInvTpValue} />
                  <div className="muted small">
                    Inversion trades use these; follow trades keep the stop loss /
                    take profit below.
                  </div>
                </>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <label>Direction</label>
          <select value={direction}
            onChange={(e) => setDirection(e.target.value as "fade" | "follow")}>
            <option value="fade">Fade the gap</option>
            <option value="follow">Follow the gap</option>
          </select>

          <label>Entry delay after gap (hours)</label>
          <NumberInput min={0} max={48} step={0.5} value={entryOffsetHours}
            onChange={setEntryOffsetHours} />
        </>
      )}

      <LevelRow label="Stop loss" on={slOn} setOn={setSlOn}
        mode={slMode} setMode={setSlMode} value={slValue} setValue={setSlValue} />
      <LevelRow label="Take profit" on={tpOn} setOn={setTpOn}
        mode={tpMode} setMode={setTpMode} value={tpValue} setValue={setTpValue} />

      <div className="check">
        <input type="checkbox" checked={timeStopOn}
          onChange={(e) => setTimeStopOn(e.target.checked)} />
        <label>{isFollow ? "Time stop after entry (hours)" : "Time stop after gap (hours)"}</label>
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

function updateAt(
  list: string[],
  set: (v: string[]) => void,
  i: number,
  value: string
) {
  set(list.map((x, k) => (k === i ? value : x)));
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

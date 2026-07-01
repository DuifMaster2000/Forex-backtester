import NumberInput from "./NumberInput";
import type { BacktestConfig, PriceLevel, Strategy } from "../api/client";

// The strategy-parameter inputs shared by the single/stability StrategyForm and
// each portfolio leg. It owns no state: the parent holds a StrategyFieldState and
// converts it to a BacktestConfig via `strategyFieldsToConfig`.

export type LevelMode = PriceLevel["mode"];

// All the tunable strategy fields, in UI-friendly units (durations in hours).
export interface StrategyFieldState {
  gapWindow: number;
  gapSigma: number;
  direction: "fade" | "follow";
  entryOffsetHours: number;
  entryTimes: string[];
  timeoutHours: number;
  invertOn: boolean;
  invertMult: number;
  invertOffsetHours: number;
  invCustomExits: boolean;
  invSlOn: boolean;
  invSlMode: LevelMode;
  invSlValue: number;
  invTpOn: boolean;
  invTpMode: LevelMode;
  invTpValue: number;
  slOn: boolean;
  slMode: LevelMode;
  slValue: number;
  tpOn: boolean;
  tpMode: LevelMode;
  tpValue: number;
  timeStopOn: boolean;
  timeStopHours: number;
  spread: number;
  intrabar: "stop_first" | "target_first";
}

export function defaultStrategyFields(): StrategyFieldState {
  return {
    gapWindow: 20,
    gapSigma: 1.5,
    direction: "fade",
    entryOffsetHours: 0,
    entryTimes: ["14:00"],
    timeoutHours: 48,
    invertOn: false,
    invertMult: 1.0,
    invertOffsetHours: 1,
    invCustomExits: false,
    invSlOn: true,
    invSlMode: "gap_multiple",
    invSlValue: 1.0,
    invTpOn: true,
    invTpMode: "gap_multiple",
    invTpValue: 1.0,
    slOn: true,
    slMode: "gap_multiple",
    slValue: 1.0,
    tpOn: true,
    tpMode: "gap_multiple",
    tpValue: 1.0,
    timeStopOn: true,
    timeStopHours: 24,
    spread: 0,
    intrabar: "stop_first",
  };
}

// Hours -> whole minutes snapped to 30-min intervals (NaN propagates when blank).
export function snapMinutes(hours: number): number {
  return Math.max(0, Math.round((hours * 60) / 30) * 30);
}

export function isValidTime(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

// Build the engine config from the current field state, for a given strategy and
// session. follow_filters is follow-only and drives entry via entry_times.
export function strategyFieldsToConfig(
  strategy: Strategy,
  session: string,
  s: StrategyFieldState
): BacktestConfig {
  const isFollow = strategy === "follow_filters";
  return {
    strategy,
    session,
    gap_window: s.gapWindow,
    gap_sigma: s.gapSigma,
    direction: isFollow ? "follow" : s.direction,
    entry_offset_minutes: isFollow ? 0 : snapMinutes(s.entryOffsetHours),
    entry_times: isFollow ? s.entryTimes.filter(isValidTime) : [],
    entry_timeout_minutes: snapMinutes(s.timeoutHours),
    invert_enabled: isFollow ? s.invertOn : false,
    invert_gap_multiple: s.invertMult,
    invert_entry_offset_minutes: snapMinutes(s.invertOffsetHours),
    invert_custom_exits: isFollow ? s.invCustomExits : false,
    invert_stop_loss: s.invCustomExits && s.invSlOn ? { mode: s.invSlMode, value: s.invSlValue } : null,
    invert_take_profit: s.invCustomExits && s.invTpOn ? { mode: s.invTpMode, value: s.invTpValue } : null,
    adr_window: 20,
    stop_loss: s.slOn ? { mode: s.slMode, value: s.slValue } : null,
    take_profit: s.tpOn ? { mode: s.tpMode, value: s.tpValue } : null,
    time_stop_minutes: s.timeStopOn ? snapMinutes(s.timeStopHours) : null,
    intrabar: s.intrabar,
    spread: Number.isFinite(s.spread) ? s.spread : 0, // blank = frictionless
  };
}

// All required numeric fields are real, and follow_filters has ≥1 valid entry time.
export function strategyFieldsValid(strategy: Strategy, s: StrategyFieldState): boolean {
  const isFollow = strategy === "follow_filters";
  const required = [s.gapWindow, s.gapSigma];
  if (isFollow) {
    required.push(s.timeoutHours);
    if (s.invertOn) {
      required.push(s.invertMult, s.invertOffsetHours);
      if (s.invCustomExits && s.invSlOn) required.push(s.invSlValue);
      if (s.invCustomExits && s.invTpOn) required.push(s.invTpValue);
    }
  } else {
    required.push(s.entryOffsetHours);
  }
  if (s.slOn) required.push(s.slValue);
  if (s.tpOn) required.push(s.tpValue);
  if (s.timeStopOn) required.push(s.timeStopHours);
  if (required.some((n) => !Number.isFinite(n))) return false;
  if (isFollow && s.entryTimes.filter(isValidTime).length === 0) return false;
  return true;
}

interface Props {
  strategy: Strategy;
  value: StrategyFieldState;
  onChange: (next: StrategyFieldState) => void;
}

export default function StrategyFields({ strategy, value: s, onChange }: Props) {
  const isFollow = strategy === "follow_filters";
  const set = (patch: Partial<StrategyFieldState>) => onChange({ ...s, ...patch });

  return (
    <>
      <div className="row">
        <div>
          <label>Gap window (sessions)</label>
          <NumberInput min={2} value={s.gapWindow} onChange={(v) => set({ gapWindow: v })} />
        </div>
        <div>
          <label>Sigma threshold</label>
          <NumberInput step={0.1} min={0} value={s.gapSigma} onChange={(v) => set({ gapSigma: v })} />
        </div>
      </div>

      {isFollow ? (
        <>
          <label>Entry times (session tz)</label>
          {s.entryTimes.map((t, i) => (
            <div className="row entry-time" key={i}>
              <input
                type="time"
                value={t}
                onChange={(e) => set({ entryTimes: s.entryTimes.map((x, k) => (k === i ? e.target.value : x)) })}
              />
              <button
                className="chip"
                title="Remove"
                onClick={() => set({ entryTimes: s.entryTimes.filter((_, k) => k !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button className="chip" onClick={() => set({ entryTimes: [...s.entryTimes, "14:00"] })}>
            + Add time
          </button>
          <div className="muted small">
            The first time whose pullback condition holds (price back through the gap
            level) is taken. Use bar-aligned times, e.g. 14:00 / 14:30 for 30-min data.
          </div>

          <label>Wait timeout (hours)</label>
          <NumberInput min={0.5} step={0.5} value={s.timeoutHours} onChange={(v) => set({ timeoutHours: v })} />
          <div className="muted small">
            Signal is voided (no trade) if no good entry appears within this window.
          </div>

          <div className="check">
            <input type="checkbox" checked={s.invertOn} onChange={(e) => set({ invertOn: e.target.checked })} />
            <label>Inversion clause</label>
          </div>
          {s.invertOn && (
            <>
              <div className="row">
                <div>
                  <label>Reach (× gap)</label>
                  <NumberInput min={0} step={0.1} value={s.invertMult} onChange={(v) => set({ invertMult: v })} />
                </div>
                <div>
                  <label>Inverted entry (h after next open)</label>
                  <NumberInput min={0} step={0.5} value={s.invertOffsetHours} onChange={(v) => set({ invertOffsetHours: v })} />
                </div>
              </div>
              <div className="muted small">
                If no follow entry fires and the next session opens more than this
                multiple of the gap further in the gap direction, fade it at the
                configured time after that open.
              </div>

              <div className="check">
                <input type="checkbox" checked={s.invCustomExits} onChange={(e) => set({ invCustomExits: e.target.checked })} />
                <label>Custom SL/TP for inversion trades</label>
              </div>
              {s.invCustomExits && (
                <>
                  <LevelRow label="Inversion stop loss" on={s.invSlOn} setOn={(v) => set({ invSlOn: v })}
                    mode={s.invSlMode} setMode={(v) => set({ invSlMode: v })} value={s.invSlValue} setValue={(v) => set({ invSlValue: v })} />
                  <LevelRow label="Inversion take profit" on={s.invTpOn} setOn={(v) => set({ invTpOn: v })}
                    mode={s.invTpMode} setMode={(v) => set({ invTpMode: v })} value={s.invTpValue} setValue={(v) => set({ invTpValue: v })} />
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
          <select value={s.direction} onChange={(e) => set({ direction: e.target.value as "fade" | "follow" })}>
            <option value="fade">Fade the gap</option>
            <option value="follow">Follow the gap</option>
          </select>

          <label>Entry delay after gap (hours)</label>
          <NumberInput min={0} max={48} step={0.5} value={s.entryOffsetHours} onChange={(v) => set({ entryOffsetHours: v })} />
        </>
      )}

      <LevelRow label="Stop loss" on={s.slOn} setOn={(v) => set({ slOn: v })}
        mode={s.slMode} setMode={(v) => set({ slMode: v })} value={s.slValue} setValue={(v) => set({ slValue: v })} />
      <LevelRow label="Take profit" on={s.tpOn} setOn={(v) => set({ tpOn: v })}
        mode={s.tpMode} setMode={(v) => set({ tpMode: v })} value={s.tpValue} setValue={(v) => set({ tpValue: v })} />

      <div className="check">
        <input type="checkbox" checked={s.timeStopOn} onChange={(e) => set({ timeStopOn: e.target.checked })} />
        <label>{isFollow ? "Time stop after entry (hours)" : "Time stop after gap (hours)"}</label>
        <NumberInput min={0.5} max={96} step={0.5} value={s.timeStopHours} disabled={!s.timeStopOn} onChange={(v) => set({ timeStopHours: v })} />
      </div>

      <label>Spread (price units, per trade)</label>
      <NumberInput min={0} step={0.0001} value={s.spread} onChange={(v) => set({ spread: v })} />
      <div className="muted small">e.g. 0.00015 = 1.5 pips · gold 0.30 · blank = none</div>

      <label>Same-bar SL/TP resolution</label>
      <select value={s.intrabar} onChange={(e) => set({ intrabar: e.target.value as "stop_first" | "target_first" })}>
        <option value="stop_first">Stop first (conservative)</option>
        <option value="target_first">Target first (optimistic)</option>
      </select>
    </>
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

export function LevelRow({ label, on, setOn, mode, setMode, value, setValue }: LevelProps) {
  return (
    <div className="level">
      <div className="check">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <label>{label}</label>
      </div>
      <div className="row">
        <select value={mode} disabled={!on} onChange={(e) => setMode(e.target.value as LevelMode)}>
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

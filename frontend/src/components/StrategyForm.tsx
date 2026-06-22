import { useState } from "react";
import type { BacktestConfig, PriceLevel, Session } from "../api/client";

interface Props {
  sessions: Session[];
  session: string;
  onSessionChange: (session: string) => void;
  disabled: boolean;
  onRun: (config: BacktestConfig) => void;
}

type LevelMode = PriceLevel["mode"];

export default function StrategyForm({
  sessions,
  session,
  onSessionChange,
  disabled,
  onRun,
}: Props) {
  const [gapWindow, setGapWindow] = useState(20);
  const [gapSigma, setGapSigma] = useState(1.5);
  const [direction, setDirection] = useState<"fade" | "follow">("fade");
  const [entryOffset, setEntryOffset] = useState(0);

  const [slOn, setSlOn] = useState(true);
  const [slMode, setSlMode] = useState<LevelMode>("gap_multiple");
  const [slValue, setSlValue] = useState(1.0);

  const [tpOn, setTpOn] = useState(true);
  const [tpMode, setTpMode] = useState<LevelMode>("gap_multiple");
  const [tpValue, setTpValue] = useState(1.0);

  const [timeStopOn, setTimeStopOn] = useState(true);
  const [timeStopAt, setTimeStopAt] = useState("17:00");
  const [intrabar, setIntrabar] = useState<"stop_first" | "target_first">("stop_first");

  function submit() {
    const config: BacktestConfig = {
      session,
      gap_window: gapWindow,
      gap_sigma: gapSigma,
      direction,
      entry_offset_bars: entryOffset,
      stop_loss: slOn ? { mode: slMode, value: slValue } : null,
      take_profit: tpOn ? { mode: tpMode, value: tpValue } : null,
      time_stop_bars: null,
      time_stop_at: timeStopOn ? timeStopAt : null,
      intrabar,
    };
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
          <input type="number" min={2} value={gapWindow}
            onChange={(e) => setGapWindow(+e.target.value)} />
        </div>
        <div>
          <label>Sigma threshold</label>
          <input type="number" step={0.1} min={0} value={gapSigma}
            onChange={(e) => setGapSigma(+e.target.value)} />
        </div>
      </div>

      <label>Direction</label>
      <select value={direction} onChange={(e) => setDirection(e.target.value as "fade" | "follow")}>
        <option value="fade">Fade the gap</option>
        <option value="follow">Follow the gap</option>
      </select>

      <label>Entry offset (bars after open)</label>
      <input type="number" min={0} value={entryOffset}
        onChange={(e) => setEntryOffset(+e.target.value)} />

      <LevelRow label="Stop loss" on={slOn} setOn={setSlOn}
        mode={slMode} setMode={setSlMode} value={slValue} setValue={setSlValue} />
      <LevelRow label="Take profit" on={tpOn} setOn={setTpOn}
        mode={tpMode} setMode={setTpMode} value={tpValue} setValue={setTpValue} />

      <div className="check">
        <input type="checkbox" checked={timeStopOn}
          onChange={(e) => setTimeStopOn(e.target.checked)} />
        <label>Time stop at (session zone)</label>
        <input type="time" value={timeStopAt} disabled={!timeStopOn}
          onChange={(e) => setTimeStopAt(e.target.value)} />
      </div>

      <label>Same-bar SL/TP resolution</label>
      <select value={intrabar}
        onChange={(e) => setIntrabar(e.target.value as "stop_first" | "target_first")}>
        <option value="stop_first">Stop first (conservative)</option>
        <option value="target_first">Target first (optimistic)</option>
      </select>

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
        </select>
        <input type="number" step={0.1} min={0} value={value} disabled={!on}
          onChange={(e) => setValue(+e.target.value)} />
      </div>
    </div>
  );
}

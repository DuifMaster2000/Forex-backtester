import { useEffect, useMemo, useState } from "react";
import StrategyFields, {
  defaultStrategyFields,
  strategyFieldsToConfig,
  strategyFieldsValid,
  type StrategyFieldState,
} from "./StrategyFields";
import type { BacktestConfig, Session, Strategy } from "../api/client";

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
  const [fields, setFields] = useState<StrategyFieldState>(defaultStrategyFields);
  const [err, setErr] = useState<string | null>(null);

  const config = useMemo<BacktestConfig>(
    () => strategyFieldsToConfig(strategy, session, fields),
    [strategy, session, fields]
  );

  useEffect(() => onChange?.(config), [config, onChange]);

  function submit() {
    if (!strategyFieldsValid(strategy, fields)) {
      setErr(
        isFollow && fields.entryTimes.filter((t) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(t.trim())).length === 0
          ? "Add at least one valid entry time (HH:MM)."
          : "Please fill in all fields before running."
      );
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

      <StrategyFields strategy={strategy} value={fields} onChange={setFields} />

      {err && <p className="error field-error">{err}</p>}
      <button className="run" disabled={disabled} onClick={submit}>
        Run backtest
      </button>
    </div>
  );
}

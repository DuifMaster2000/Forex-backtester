import { useMemo, useState } from "react";
import NumberInput from "./NumberInput";
import StrategyFields, {
  defaultStrategyFields,
  strategyFieldsToConfig,
  strategyFieldsValid,
  type StrategyFieldState,
} from "./StrategyFields";
import type { DatasetMeta, PortfolioRunSpec, Session, Strategy } from "../api/client";

interface Props {
  sessions: Session[];
  datasets: DatasetMeta[];
  running: boolean;
  onUpload: (file: File) => Promise<DatasetMeta>;
  onRun: (spec: PortfolioRunSpec) => void;
}

// One leg of the portfolio: a dataset + a strategy config + a fixed position
// size. Two legs may point at the same dataset with different sessions, so the
// same instrument can run several independent strategies at once.
interface LegState {
  id: string;
  datasetId: string;
  label: string;
  positionSize: number;
  strategy: Strategy;
  session: string;
  fields: StrategyFieldState;
}

let seq = 0;
const nextId = () => `leg${++seq}`;

function newLeg(datasetId: string, session: string): LegState {
  return {
    id: nextId(),
    datasetId,
    label: "",
    positionSize: 1,
    strategy: "base",
    session,
    fields: defaultStrategyFields(),
  };
}

export default function PortfolioForm({ sessions, datasets, running, onUpload, onRun }: Props) {
  const [startingCapital, setStartingCapital] = useState(10000);
  const [maxOpen, setMaxOpen] = useState(3);
  const [legs, setLegs] = useState<LegState[]>([]);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const firstSession = sessions[0]?.name ?? "NY";
  const dsById = useMemo(() => new Map(datasets.map((d) => [d.id, d])), [datasets]);

  async function handleFile(file: File) {
    setUploadBusy(true);
    setErr(null);
    try {
      await onUpload(file);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setUploadBusy(false);
    }
  }

  function updateLeg(id: string, patch: Partial<LegState>) {
    setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  function addLeg() {
    if (datasets.length === 0) return;
    setLegs((ls) => [...ls, newLeg(datasets[0].id, firstSession)]);
  }

  function legLabel(l: LegState): string {
    const ds = dsById.get(l.datasetId);
    const inst = ds?.instrument ?? "?";
    return l.label.trim() || `${inst} · ${l.session} · ${l.strategy === "follow_filters" ? "follow+" : "gap"}`;
  }

  function submit() {
    if (legs.length === 0) {
      setErr("Add at least one strategy leg.");
      return;
    }
    for (const l of legs) {
      if (!dsById.has(l.datasetId)) {
        setErr(`Leg "${legLabel(l)}" references a dataset that is no longer loaded.`);
        return;
      }
      if (!Number.isFinite(l.positionSize) || l.positionSize <= 0) {
        setErr(`Leg "${legLabel(l)}" needs a position size greater than 0.`);
        return;
      }
      if (!strategyFieldsValid(l.strategy, l.fields)) {
        setErr(`Leg "${legLabel(l)}" has empty or invalid strategy fields.`);
        return;
      }
    }
    if (!Number.isFinite(startingCapital) || startingCapital <= 0) {
      setErr("Starting capital must be greater than 0.");
      return;
    }
    setErr(null);
    onRun({
      starting_capital: startingCapital,
      max_open_trades: Number.isFinite(maxOpen) ? maxOpen : 0,
      legs: legs.map((l) => ({
        id: l.id,
        dataset_id: l.datasetId,
        label: legLabel(l),
        position_size: l.positionSize,
        config: strategyFieldsToConfig(l.strategy, l.session, l.fields),
      })),
    });
  }

  return (
    <>
      <div className="panel">
        <h3>Portfolio data</h3>
        <input
          type="file"
          accept=".csv"
          disabled={uploadBusy}
          onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
        />
        <div className="muted small" style={{ marginTop: 6 }}>
          Upload one CSV per instrument. Add several to trade different instruments at once.
        </div>
        {uploadBusy && <p className="muted">Uploading…</p>}
        {datasets.length > 0 && (
          <ul className="ds-list">
            {datasets.map((d) => (
              <li key={d.id}>
                <b>{d.instrument}</b> · {d.interval_minutes}m · {d.rows} bars
                <span className="muted"> ({d.start.slice(0, 10)}→{d.end.slice(0, 10)})</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <h3>Portfolio settings</h3>
        <div className="row">
          <div>
            <label>Starting capital</label>
            <NumberInput min={0} step={1000} value={startingCapital} onChange={setStartingCapital} />
          </div>
          <div>
            <label>Max open trades</label>
            <NumberInput min={0} step={1} value={maxOpen} onChange={setMaxOpen} />
          </div>
        </div>
        <div className="muted small">
          Max open trades caps how many positions can be open simultaneously across the
          whole portfolio; a signal that would exceed it is skipped. 0 = unlimited.
        </div>
      </div>

      {legs.map((l, i) => (
        <div className="panel leg" key={l.id}>
          <div className="leg-head">
            <h3>Leg {i + 1}</h3>
            <button className="chip" title="Remove leg" onClick={() => setLegs((ls) => ls.filter((x) => x.id !== l.id))}>
              ✕
            </button>
          </div>

          <label>Instrument (dataset)</label>
          <select value={l.datasetId} onChange={(e) => updateLeg(l.id, { datasetId: e.target.value })}>
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.instrument} ({d.rows} bars)
              </option>
            ))}
          </select>

          <label>Label (optional)</label>
          <input
            type="text"
            value={l.label}
            placeholder={legLabel(l)}
            onChange={(e) => updateLeg(l.id, { label: e.target.value })}
          />

          <div className="row">
            <div>
              <label>Position size (units)</label>
              <NumberInput min={0} step={1} value={l.positionSize} onChange={(v) => updateLeg(l.id, { positionSize: v })} />
            </div>
            <div>
              <label>Strategy</label>
              <select value={l.strategy} onChange={(e) => updateLeg(l.id, { strategy: e.target.value as Strategy })}>
                <option value="base">Base strategy</option>
                <option value="follow_filters">Follow + filters</option>
              </select>
            </div>
          </div>

          <label>Session</label>
          <select value={l.session} onChange={(e) => updateLeg(l.id, { session: e.target.value })}>
            {sessions.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.open_time}–{s.close_time} {s.tz})
              </option>
            ))}
          </select>

          <StrategyFields strategy={l.strategy} value={l.fields} onChange={(f) => updateLeg(l.id, { fields: f })} />
        </div>
      ))}

      <div className="panel">
        <button className="chip add-leg" disabled={datasets.length === 0} onClick={addLeg}>
          + Add strategy leg
        </button>
        {datasets.length === 0 && <div className="muted small">Upload a CSV to add legs.</div>}
        {err && <p className="error field-error">{err}</p>}
        <button className="run" disabled={running || legs.length === 0} onClick={submit}>
          {running ? "Running…" : "Run portfolio"}
        </button>
      </div>
    </>
  );
}

import { useRef, useState } from "react";
import { uploadDataset, type DatasetMeta } from "../api/client";

interface Props {
  onLoaded: (meta: DatasetMeta) => void;
}

export default function UploadPanel({ onLoaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [meta, setMeta] = useState<DatasetMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const m = await uploadDataset(file);
      setMeta(m);
      onLoaded(m);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>Data</h3>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        disabled={busy}
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />
      {busy && <p className="muted">Uploading…</p>}
      {error && <p className="error">{error}</p>}
      {meta && (
        <div className="meta">
          <div><b>{meta.instrument}</b> · {meta.interval_minutes}m · {meta.rows} bars</div>
          <div className="muted">Source offset {meta.source_offset}</div>
          <div className="muted">{meta.start.slice(0, 10)} → {meta.end.slice(0, 10)}</div>
        </div>
      )}
    </div>
  );
}

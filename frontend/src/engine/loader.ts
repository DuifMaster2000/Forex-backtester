// CSV loading + validation. Mirrors backend/app/data/loader.py.

import type { Bar, Dataset } from "./types";

const REQUIRED = ["time", "open", "high", "low", "close"];

export function parseCsv(text: string, filename?: string): Dataset {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV has no data rows.");

  const header = splitRow(lines[0]).map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const col of [...REQUIRED, "volume"]) {
    const i = header.indexOf(col);
    if (i >= 0) idx[col] = i;
  }
  const missing = REQUIRED.filter((c) => !(c in idx));
  if (missing.length) {
    throw new Error(
      `CSV is missing required column(s): ${missing.join(", ")}. Found: ${header.join(", ")}`
    );
  }

  const firstTime = splitRow(lines[1])[idx.time];
  const sourceOffset = extractOffset(firstTime);

  const bars: Bar[] = [];
  let precision = 0;
  for (let r = 1; r < lines.length; r++) {
    const cells = splitRow(lines[r]);
    const rawTime = cells[idx.time];
    const ms = new Date(rawTime).getTime();
    if (Number.isNaN(ms)) throw new Error(`Could not parse timestamp: "${rawTime}"`);

    const open = Number(cells[idx.open]);
    const high = Number(cells[idx.high]);
    const low = Number(cells[idx.low]);
    const close = Number(cells[idx.close]);
    if ([open, high, low, close].some((v) => Number.isNaN(v))) continue;
    const volume = "volume" in idx ? Number(cells[idx.volume]) || 0 : 0;

    // Track the most decimal places seen, to size P/L formatting per instrument.
    for (const col of ["open", "high", "low", "close"] as const) {
      precision = Math.max(precision, decimalsOf(cells[idx[col]]));
    }

    bars.push({ ms, open, high, low, close, volume });
  }

  if (bars.length === 0) throw new Error("No valid rows remained after parsing.");

  // Sort ascending and drop duplicate timestamps (keep last).
  bars.sort((a, b) => a.ms - b.ms);
  const deduped: Bar[] = [];
  for (const b of bars) {
    const last = deduped[deduped.length - 1];
    if (last && last.ms === b.ms) deduped[deduped.length - 1] = b;
    else deduped.push(b);
  }

  return {
    bars: deduped,
    instrument: inferInstrument(filename),
    interval_minutes: inferInterval(deduped),
    source_offset: sourceOffset,
    price_precision: precision,
  };
}

// Decimal places in a numeric string like "1.08345" (-> 5). Capped at 8.
function decimalsOf(s: string): number {
  if (!s) return 0;
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  return Math.min(8, s.trim().length - dot - 1);
}

function splitRow(line: string): string[] {
  // OANDA/TradingView exports are simple comma-separated with no quoted commas.
  return line.split(",");
}

function inferInstrument(filename?: string): string {
  if (!filename) return "UNKNOWN";
  const stem = filename.split("/").pop()!.replace(/\.[^.]+$/, "");
  const parts = stem.split("_");
  for (let i = 0; i < parts.length; i++) {
    // The OANDA token may be hyphen-prefixed, e.g. "5f7f2016-OANDA".
    if (parts[i].toUpperCase().includes("OANDA") && i + 1 < parts.length) {
      return parts[i + 1].toUpperCase();
    }
  }
  return stem;
}

function inferInterval(bars: Bar[]): number {
  if (bars.length < 2) return 0;
  const counts = new Map<number, number>();
  for (let i = 1; i < bars.length; i++) {
    const d = Math.round((bars[i].ms - bars[i - 1].ms) / 60000);
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let modal = 0;
  let best = -1;
  for (const [d, c] of counts) {
    if (c > best) {
      best = c;
      modal = d;
    }
  }
  return modal;
}

function extractOffset(iso: string): string {
  if (!iso) return "";
  if (iso.endsWith("Z")) return "+00:00";
  const tail = iso.slice(-6);
  if (tail.length === 6 && (tail[0] === "+" || tail[0] === "-") && tail[3] === ":") {
    return tail;
  }
  return "";
}

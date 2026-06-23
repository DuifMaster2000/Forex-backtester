// Session-gap detection. Mirrors backend/app/strategies/gap.py.

import type { Bar, Gap, Session } from "./types";
import { sessionBars } from "./sessions";
import { DISPLAY_TZ, wallClockISO } from "./tz";

interface RawGap {
  date: string;
  prevCloseMs: number;
  prevClose: number;
  openMs: number;
  openPrice: number;
  gap: number;
  absGap: number;
  direction: "up" | "down";
}

export function computeGaps(
  bars: Bar[],
  session: Session,
  window = 20,
  sigma = 1.5
): Gap[] {
  const days = sessionBars(bars, session);
  if (days.length < 2) return [];

  const raw: RawGap[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1];
    const cur = days[i];
    const gap = cur.openPrice - prev.closePrice;
    raw.push({
      date: cur.date,
      prevCloseMs: prev.closeMs,
      prevClose: prev.closePrice,
      openMs: cur.openMs,
      openPrice: cur.openPrice,
      gap,
      absGap: Math.abs(gap),
      direction: gap >= 0 ? "up" : "down",
    });
  }

  const out: Gap[] = [];
  for (let k = 0; k < raw.length; k++) {
    let mean: number | null = null;
    let std: number | null = null;
    let threshold: number | null = null;
    let isBig = false;

    // Rolling stats over the previous `window` absolute gaps (excludes current).
    if (k >= window) {
      const slice = raw.slice(k - window, k).map((g) => g.absGap);
      mean = slice.reduce((a, b) => a + b, 0) / window;
      const variance =
        slice.reduce((a, b) => a + (b - mean!) ** 2, 0) / (window - 1); // sample std
      std = Math.sqrt(variance);
      threshold = mean + sigma * std;
      isBig = raw[k].absGap > threshold;
    }

    out.push({
      date: raw[k].date,
      prev_close_ts: wallClockISO(raw[k].prevCloseMs, DISPLAY_TZ),
      prev_close: raw[k].prevClose,
      open_ts: wallClockISO(raw[k].openMs, DISPLAY_TZ),
      open_price: raw[k].openPrice,
      gap: raw[k].gap,
      abs_gap: raw[k].absGap,
      direction: raw[k].direction,
      threshold,
      is_big: isBig,
    });
  }

  return out;
}

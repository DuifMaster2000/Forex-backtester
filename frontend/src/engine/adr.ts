// Average Daily Range (ADR): the mean daily high-low range over a window of days.
// Used to size stop-loss / take-profit in instrument-agnostic terms.
//
// Days are bucketed on the New York display axis (DISPLAY_TZ) so the metric is
// consistent with the rest of the app and independent of the chosen session.

import type { Bar } from "./types";
import { zonedParts } from "./tz";

export interface DayRange {
  date: string; // YYYY-MM-DD on the display axis
  range: number; // high - low for that day
}

// Per-day high-low range, ascending by date.
export function dailyRanges(bars: Bar[], tz: string): DayRange[] {
  const byDay = new Map<string, { hi: number; lo: number }>();
  for (const b of bars) {
    const key = zonedParts(b.ms, tz).dayKey;
    const cur = byDay.get(key);
    if (cur) {
      cur.hi = Math.max(cur.hi, b.high);
      cur.lo = Math.min(cur.lo, b.low);
    } else {
      byDay.set(key, { hi: b.high, lo: b.low });
    }
  }
  return [...byDay.entries()]
    .map(([date, v]) => ({ date, range: v.hi - v.lo }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ADR over up to `window` days strictly before `refDate` (no look-ahead).
// Returns null when there is no prior day.
export function adrBefore(ranges: DayRange[], refDate: string, window: number): number | null {
  const prior = ranges.filter((r) => r.date < refDate);
  if (prior.length === 0) return null;
  const slice = prior.slice(-window);
  return slice.reduce((a, r) => a + r.range, 0) / slice.length;
}

// Most recent ADR: mean range of the last `window` days in the data (for display).
export function latestAdr(bars: Bar[], window: number, tz: string): number | null {
  const ranges = dailyRanges(bars, tz);
  if (ranges.length === 0) return null;
  const slice = ranges.slice(-window);
  return slice.reduce((a, r) => a + r.range, 0) / slice.length;
}

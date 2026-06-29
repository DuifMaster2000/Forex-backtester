// "Follow only + filters" strategy: entry selection.
//
// Mirrors backend/app/strategies/follow_filters.py. The gap detection and the
// trade-management loop are shared with the base strategy; only the way an entry
// bar is chosen differs. Here we always follow the gap and wait for a "good
// entry" — a pullback back through the gap level (the session open price) — at one
// of a list of configured times of day, giving up if none arrives before a
// timeout.

import type { Bar, Gap, Session } from "./types";
import { zonedParts } from "./tz";

// "HH:MM" -> minutes since midnight. Returns null for malformed values so callers
// can ignore them rather than match every bar at minute 0.
export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Has price pulled back through the gap level in the follow direction? For an up
// gap we go long, so a good (cheaper) entry is price back below the open; for a
// down gap we go short, so a good entry is price back above the open. Tested on a
// bar's open price (no intrabar look-ahead — the same convention the base
// strategy uses to fill).
export function isGoodEntry(open: number, gapLevel: number, gapDir: "up" | "down"): boolean {
  return gapDir === "up" ? open < gapLevel : open > gapLevel;
}

// Index of the bar to enter on, or null to void the signal. Scans forward from the
// bar after the gap open up to the timeout (counted in trading bars so weekends /
// closures don't consume the budget), and at every bar whose session-zone
// time-of-day is one of `entryTimes` checks the good-entry condition; the first
// qualifying bar wins.
export function findFollowEntry(
  bars: Bar[],
  session: Session,
  sig: Gap,
  gapLoc: number,
  stepMinutes: number,
  entryTimes: string[],
  timeoutMinutes: number
): number | null {
  if (sig.open_price == null) return null;
  const gapLevel = sig.open_price;
  const wanted = new Set(
    entryTimes.map(parseHHMM).filter((m): m is number => m != null)
  );
  if (wanted.size === 0) return null;

  const timeoutLoc = gapLoc + Math.round(timeoutMinutes / stepMinutes);
  const lastLoc = Math.min(timeoutLoc, bars.length - 1);
  for (let j = gapLoc + 1; j <= lastLoc; j++) {
    const minutesOfDay = zonedParts(bars[j].ms, session.tz).minutesOfDay;
    if (!wanted.has(minutesOfDay)) continue;
    if (isGoodEntry(bars[j].open, gapLevel, sig.direction)) return j;
  }
  return null;
}

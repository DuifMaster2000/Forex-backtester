// Session definitions + per-day open/close bar lookup. Mirrors backend/app/sessions.py.

import type { Bar, Session } from "./types";
import { zonedParts } from "./tz";

export const DEFAULT_SESSIONS: Session[] = [
  { name: "NY", tz: "America/New_York", open_time: "09:30", close_time: "17:00" },
  { name: "London", tz: "Europe/London", open_time: "08:00", close_time: "16:30" },
  { name: "Tokyo", tz: "Asia/Tokyo", open_time: "09:00", close_time: "15:00" },
];

export function getSession(name: string): Session {
  const s = DEFAULT_SESSIONS.find((x) => x.name === name);
  if (!s) throw new Error(`Unknown session '${name}'`);
  return s;
}

function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

export interface SessionDay {
  date: string;
  openMs: number;
  openPrice: number;
  closeMs: number;
  closePrice: number;
}

// One row per session-zone calendar day that has an open bar. The open bar is the
// first bar at/after the open time; the close bar is the last bar at/before the
// close time on the same day.
export function sessionBars(bars: Bar[], session: Session): SessionDay[] {
  const openMin = hhmmToMinutes(session.open_time);
  const closeMin = hhmmToMinutes(session.close_time);

  // Group bar indices by session-zone day, preserving ascending order.
  const byDay = new Map<string, { idx: number; minutes: number }[]>();
  for (let i = 0; i < bars.length; i++) {
    const p = zonedParts(bars[i].ms, session.tz);
    if (!byDay.has(p.dayKey)) byDay.set(p.dayKey, []);
    byDay.get(p.dayKey)!.push({ idx: i, minutes: p.minutesOfDay });
  }

  const days: SessionDay[] = [];
  for (const [dayKey, entries] of byDay) {
    const openEntry = entries.find((e) => e.minutes >= openMin);
    const closeCandidates = entries.filter((e) => e.minutes <= closeMin);
    if (!openEntry || closeCandidates.length === 0) continue;
    const closeEntry = closeCandidates[closeCandidates.length - 1];
    days.push({
      date: dayKey,
      openMs: bars[openEntry.idx].ms,
      openPrice: bars[openEntry.idx].open,
      closeMs: bars[closeEntry.idx].ms,
      closePrice: bars[closeEntry.idx].close,
    });
  }

  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  return days;
}

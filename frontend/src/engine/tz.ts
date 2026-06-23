// DST-correct timezone conversion using the browser's built-in tz database.
//
// `new Date(iso)` already captures the true UTC instant from an offset-bearing
// ISO string. To get a bar's wall-clock in a *session* timezone (e.g. ET), we
// format that instant with Intl.DateTimeFormat({ timeZone }). Intl applies the
// correct DST offset for the given instant, so this is the JS equivalent of
// Python's tzdata `tz_convert`.

// Everything is *displayed* on a single New York axis: candles, session bands and
// trade/gap markers all use this zone, so sessions detected in their own timezone
// (e.g. London) appear at the correct NY-time position. Session detection uses the
// session's own tz; only display formatting uses DISPLAY_TZ.
export const DISPLAY_TZ = "America/New_York";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  minutesOfDay: number; // hour*60 + minute, for time-of-day comparisons
  dayKey: string; // "YYYY-MM-DD" in the session zone, for grouping by day
}

// Intl.formatToParts is comparatively expensive, and the same (ms, tz) pairs are
// hit repeatedly (every grid backtest re-walks the same bars). Memoise results so
// the cost is paid once per bar/zone for the whole session.
const partsCache = new Map<string, Map<number, ZonedParts>>();

export function zonedParts(ms: number, tz: string): ZonedParts {
  let byMs = partsCache.get(tz);
  if (!byMs) {
    byMs = new Map();
    partsCache.set(tz, byMs);
  }
  const cached = byMs.get(ms);
  if (cached) return cached;

  const parts = formatter(tz).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0; // some engines emit "24" for midnight under h23
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const minute = get("minute");
  const second = get("second");
  const result: ZonedParts = {
    year,
    month,
    day,
    hour,
    minute,
    second,
    minutesOfDay: hour * 60 + minute,
    dayKey: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
  };
  byMs.set(ms, result);
  return result;
}

// "YYYY-MM-DDTHH:MM:SS" wall-clock string in the session zone. Chart.toChartTime
// parses exactly this shape to place candles/markers on the session-time axis.
export function wallClockISO(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}T${pad(p.hour, 2)}:${pad(
    p.minute,
    2
  )}:${pad(p.second, 2)}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

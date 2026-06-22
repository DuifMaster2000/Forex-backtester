"""Trading session definitions and bar-location helpers.

A session is a named window (open/close time-of-day) in a specific timezone.
Session logic always operates on the price frame *converted to the session zone*,
so DST is handled by tzdata rather than by assuming a fixed offset.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import time
from zoneinfo import ZoneInfo

import pandas as pd


@dataclass(frozen=True)
class Session:
    name: str
    tz: str
    open_time: time
    close_time: time

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "tz": self.tz,
            "open_time": self.open_time.strftime("%H:%M"),
            "close_time": self.close_time.strftime("%H:%M"),
        }


# Built-in presets. NY is the default for the gap strategy.
DEFAULT_SESSIONS: dict[str, Session] = {
    "NY": Session("NY", "America/New_York", time(9, 30), time(17, 0)),
    "London": Session("London", "Europe/London", time(8, 0), time(16, 30)),
    "Tokyo": Session("Tokyo", "Asia/Tokyo", time(9, 0), time(15, 0)),
}


def _parse_hhmm(value: str) -> time:
    h, m = value.split(":")
    return time(int(h), int(m))


def session_from_dict(d: dict) -> Session:
    return Session(
        name=d["name"],
        tz=d["tz"],
        open_time=_parse_hhmm(d["open_time"]),
        close_time=_parse_hhmm(d["close_time"]),
    )


def localize(df: pd.DataFrame, tz: str) -> pd.DataFrame:
    """Convert a UTC-indexed frame to the given timezone (DST-aware)."""
    out = df.copy()
    out.index = out.index.tz_convert(ZoneInfo(tz))
    return out


def session_bars(df_local: pd.DataFrame, session: Session) -> pd.DataFrame:
    """Index session open/close bars per calendar day in the session zone.

    Returns one row per day that has an open bar, with columns:
    ``open_ts, open_price, close_ts, close_price``. The open bar is the first bar
    at/after the session open time; the close bar is the last bar at/before the
    session close time on the same day. Robust to the underlying bar grid.
    """
    idx = df_local.index
    tod = pd.Index(idx.time)
    day = pd.Index(idx.normalize())

    rows = []
    for d, grp in df_local.groupby(day):
        grp_tod = pd.Index(grp.index.time)
        open_mask = grp_tod >= session.open_time
        close_mask = grp_tod <= session.close_time
        if not open_mask.any() or not close_mask.any():
            continue
        open_bar = grp[open_mask].iloc[0]
        open_ts = grp.index[open_mask][0]
        close_bar = grp[close_mask].iloc[-1]
        close_ts = grp.index[close_mask][-1]
        rows.append(
            {
                "date": pd.Timestamp(d).date(),
                "open_ts": open_ts,
                "open_price": float(open_bar["open"]),
                "close_ts": close_ts,
                "close_price": float(close_bar["close"]),
            }
        )

    return pd.DataFrame(rows)

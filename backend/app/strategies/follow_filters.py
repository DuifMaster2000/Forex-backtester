"""Entry selection for the "follow only + filters" strategy.

Backend mirror of frontend/src/engine/followFilters.ts. Gap detection (gap.py)
and the trade-management loop (engine.py) are shared with the base strategy; only
the way an entry bar is chosen differs. Here we always follow the gap and wait for
a "good entry" — a pullback back through the gap level (the session open price) —
at one of a list of configured times of day, giving up if none arrives before a
timeout.
"""
from __future__ import annotations

import re

import pandas as pd

_HHMM = re.compile(r"^(\d{1,2}):(\d{2})$")


def parse_hhmm(value: str) -> int | None:
    """``"HH:MM"`` -> minutes since midnight, or None when malformed."""
    m = _HHMM.match(value.strip())
    if not m:
        return None
    h, minute = int(m.group(1)), int(m.group(2))
    if not (0 <= h <= 23 and 0 <= minute <= 59):
        return None
    return h * 60 + minute


def is_good_entry(open_price: float, gap_level: float, gap_dir: str) -> bool:
    """Has price pulled back through the gap level in the follow direction?

    Up gap -> we go long, so a good (cheaper) entry is price back *below* the open;
    down gap -> we go short, so a good entry is price back *above* the open. Tested
    on a bar's open price (no intrabar look-ahead — the convention base uses too).
    """
    return open_price < gap_level if gap_dir == "up" else open_price > gap_level


def find_follow_entry(
    df_local: pd.DataFrame,
    sig: pd.Series,
    gap_loc: int,
    step_minutes: int,
    entry_times: list[str],
    timeout_minutes: int,
) -> int | None:
    """Integer location of the bar to enter on, or None to void the signal.

    Scans forward from the bar after the gap open up to the timeout (counted in
    trading bars), and at every bar whose session-zone time-of-day is one of
    ``entry_times`` checks the good-entry condition; the first qualifying bar wins.
    ``df_local`` is already localized to the session timezone, so the index carries
    the session-local wall clock.
    """
    gap_level = sig.get("open_price")
    if gap_level is None or pd.isna(gap_level):
        return None
    wanted = {m for m in (parse_hhmm(t) for t in entry_times) if m is not None}
    if not wanted:
        return None

    idx = df_local.index
    timeout_loc = gap_loc + round(timeout_minutes / step_minutes)
    last_loc = min(timeout_loc, len(df_local) - 1)
    for j in range(gap_loc + 1, last_loc + 1):
        ts = idx[j]
        if (ts.hour * 60 + ts.minute) not in wanted:
            continue
        if is_good_entry(float(df_local.iloc[j]["open"]), float(gap_level), sig["direction"]):
            return j
    return None

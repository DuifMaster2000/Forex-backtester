"""Average Daily Range (ADR): mean daily high-low range over a window of days.

Days are bucketed on the New York display axis (DISPLAY_TZ) so the metric is
consistent with the rest of the app and independent of the chosen session.
Mirrors frontend/src/engine/adr.ts.
"""
from __future__ import annotations

import pandas as pd

from ..sessions import DISPLAY_TZ, localize


def daily_ranges(df_utc: pd.DataFrame, tz: str = DISPLAY_TZ) -> pd.Series:
    """Per-day high-low range, indexed by ``YYYY-MM-DD`` date string (ascending)."""
    loc = localize(df_utc, tz)
    keys = loc.index.strftime("%Y-%m-%d")
    hi = loc["high"].groupby(keys).max()
    lo = loc["low"].groupby(keys).min()
    return (hi - lo).sort_index()


def adr_before(ranges: pd.Series, ref_key: str, window: int) -> float | None:
    """ADR over up to ``window`` days strictly before ``ref_key`` (no look-ahead)."""
    prior = ranges[ranges.index < ref_key]
    if len(prior) == 0:
        return None
    return float(prior.iloc[-window:].mean())


def latest_adr(df_utc: pd.DataFrame, window: int, tz: str = DISPLAY_TZ) -> float | None:
    """Most recent ADR: mean range of the last ``window`` days (for display)."""
    ranges = daily_ranges(df_utc, tz)
    if len(ranges) == 0:
        return None
    return float(ranges.iloc[-window:].mean())

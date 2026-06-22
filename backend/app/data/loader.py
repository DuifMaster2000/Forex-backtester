"""CSV loading, validation, and daylight-savings-correct timezone handling.

OANDA / TradingView exports use ISO-8601 timestamps that carry the chart's local
UTC offset (e.g. ``2026-05-19T15:00:00+02:00``). The offset reflects the export
zone, *not* the session zone, and it changes across DST boundaries. To keep
session-time logic (e.g. NY 09:30 open) correct, we always parse to a true UTC
instant first, then convert to the session zone via the tz database, which knows
each zone's DST transition dates.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from io import BytesIO
from zoneinfo import ZoneInfo

import pandas as pd

REQUIRED_COLUMNS = ["time", "open", "high", "low", "close"]
# Canonical column names we expose downstream.
OHLC = ["open", "high", "low", "close"]


@dataclass
class Dataset:
    """A loaded, cleaned price series plus metadata.

    The frame is indexed by a tz-aware UTC ``DatetimeIndex`` and always contains
    ``open/high/low/close`` (float) and ``volume`` (float, 0 if absent).
    """

    df: pd.DataFrame
    instrument: str
    interval_minutes: int
    source_offset: str
    rows: int = field(init=False)

    def __post_init__(self) -> None:
        self.rows = len(self.df)

    def localize(self, tz: str) -> pd.DataFrame:
        """Return a copy of the frame with the index converted to ``tz``.

        Conversion goes through UTC, so DST is applied correctly by tzdata.
        """
        out = self.df.copy()
        out.index = out.index.tz_convert(ZoneInfo(tz))
        return out


def _infer_instrument(filename: str | None) -> str:
    if not filename:
        return "UNKNOWN"
    stem = filename.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    # TradingView exports look like "OANDA_XAUUSD_30" or "5f7f2016-OANDA_XAUUSD_30".
    parts = stem.split("_")
    for i, p in enumerate(parts):
        # The OANDA token may be hyphen-prefixed, e.g. "5f7f2016-OANDA".
        if "OANDA" in p.upper() and i + 1 < len(parts):
            return parts[i + 1].upper()
    return stem


def _infer_interval_minutes(index: pd.DatetimeIndex) -> int:
    if len(index) < 2:
        return 0
    deltas = index.to_series().diff().dropna()
    if deltas.empty:
        return 0
    modal = deltas.mode()
    seconds = (modal.iloc[0] if not modal.empty else deltas.median()).total_seconds()
    return int(round(seconds / 60))


def load_csv(content: bytes, filename: str | None = None) -> Dataset:
    """Parse raw CSV bytes into a cleaned :class:`Dataset`.

    Raises ``ValueError`` on missing columns or unparseable timestamps.
    """
    raw = pd.read_csv(BytesIO(content))
    # Normalise column names: case-insensitive match to our schema.
    rename = {}
    lower_map = {c.lower(): c for c in raw.columns}
    for canonical in REQUIRED_COLUMNS + ["volume"]:
        if canonical in lower_map:
            rename[lower_map[canonical]] = canonical
    raw = raw.rename(columns=rename)

    missing = [c for c in REQUIRED_COLUMNS if c not in raw.columns]
    if missing:
        raise ValueError(
            f"CSV is missing required column(s): {', '.join(missing)}. "
            f"Found columns: {', '.join(raw.columns)}"
        )

    # Capture the source offset (for display) before normalising to UTC.
    sample_time = str(raw["time"].iloc[0]) if len(raw) else ""
    source_offset = _extract_offset(sample_time)

    # Parse to a true UTC instant regardless of the per-row offset.
    times = pd.to_datetime(raw["time"], utc=True, errors="coerce")
    if times.isna().any():
        bad = raw.loc[times.isna(), "time"].head(3).tolist()
        raise ValueError(f"Could not parse timestamp(s): {bad}")

    for col in OHLC:
        raw[col] = pd.to_numeric(raw[col], errors="coerce")
    raw["volume"] = (
        pd.to_numeric(raw["volume"], errors="coerce") if "volume" in raw.columns else 0.0
    )

    df = raw[OHLC + ["volume"]].copy()
    df.index = pd.DatetimeIndex(times)
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df.dropna(subset=OHLC)

    if df.empty:
        raise ValueError("No valid rows remained after parsing.")

    return Dataset(
        df=df,
        instrument=_infer_instrument(filename),
        interval_minutes=_infer_interval_minutes(df.index),
        source_offset=source_offset,
    )


def _extract_offset(iso_time: str) -> str:
    """Pull the trailing ``+HH:MM`` / ``-HH:MM`` / ``Z`` offset for display."""
    if not iso_time:
        return ""
    if iso_time.endswith("Z"):
        return "+00:00"
    tail = iso_time[-6:]
    if len(tail) == 6 and tail[0] in "+-" and tail[3] == ":":
        return tail
    return ""

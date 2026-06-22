"""Session-gap detection.

A "gap" is the price move between one session's close and the next session's
open (e.g. NY 17:00 ET close -> next 09:30 ET open). The market may still trade
overnight, so this is the price *displacement* across the period the session is
closed, not a no-trade gap.

A gap is "big" when its magnitude exceeds ``mean + sigma * std`` of the absolute
value of the previous ``window`` gaps (the rolling stats exclude the current gap
to avoid look-ahead).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from ..sessions import Session, localize, session_bars


def compute_gaps(
    df_utc: pd.DataFrame,
    session: Session,
    window: int = 20,
    sigma: float = 1.5,
) -> pd.DataFrame:
    """Return a per-gap frame with detection flags.

    Columns: ``date, prev_close_ts, prev_close, open_ts, open_price, gap,
    abs_gap, direction, mean, std, threshold, is_big``.

    ``direction`` is ``"up"`` when the open is above the prior close, else
    ``"down"``. Rolling stats use only the prior ``window`` gaps.
    """
    df_local = localize(df_utc, session.tz)
    bars = session_bars(df_local, session)
    if len(bars) < 2:
        return _empty_gaps()

    bars = bars.sort_values("date").reset_index(drop=True)

    # Gap N links session day N-1 close -> session day N open.
    rows = []
    for i in range(1, len(bars)):
        prev = bars.iloc[i - 1]
        cur = bars.iloc[i]
        gap = cur["open_price"] - prev["close_price"]
        rows.append(
            {
                "date": cur["date"],
                "prev_close_ts": prev["close_ts"],
                "prev_close": prev["close_price"],
                "open_ts": cur["open_ts"],
                "open_price": cur["open_price"],
                "gap": gap,
                "abs_gap": abs(gap),
                "direction": "up" if gap >= 0 else "down",
            }
        )

    gaps = pd.DataFrame(rows)

    # Rolling stats over the previous `window` absolute gaps, excluding current.
    prev_abs = gaps["abs_gap"].shift(1)
    gaps["mean"] = prev_abs.rolling(window, min_periods=window).mean()
    gaps["std"] = prev_abs.rolling(window, min_periods=window).std(ddof=1)
    gaps["threshold"] = gaps["mean"] + sigma * gaps["std"]
    gaps["is_big"] = gaps["abs_gap"] > gaps["threshold"]
    gaps["is_big"] = gaps["is_big"].fillna(False)

    return gaps


def _empty_gaps() -> pd.DataFrame:
    cols = [
        "date", "prev_close_ts", "prev_close", "open_ts", "open_price",
        "gap", "abs_gap", "direction", "mean", "std", "threshold", "is_big",
    ]
    return pd.DataFrame({c: pd.Series(dtype="object") for c in cols})

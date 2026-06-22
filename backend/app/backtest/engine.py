"""Position simulation for the session-gap strategy.

Given detected big gaps, the engine opens one position per signal and manages it
with optional price-based stop-loss / take-profit and a time-based stop. Because
the data is 30-minute OHLC, intrabar fills are approximations: when a bar's range
spans both the stop and the target, we resolve the ambiguity with a configurable
ordering rule (default: stop fills first, the conservative assumption).
"""
from __future__ import annotations

from datetime import time
from enum import Enum
from typing import Literal

import pandas as pd
from pydantic import BaseModel, Field

from ..sessions import Session, localize
from ..strategies.gap import compute_gaps


class Direction(str, Enum):
    fade = "fade"      # trade against the gap (short an up-gap, long a down-gap)
    follow = "follow"  # trade with the gap (long an up-gap, short a down-gap)


class PriceLevel(BaseModel):
    """A price distance from entry, expressed in one of several units."""

    mode: Literal["points", "percent", "gap_multiple"] = "points"
    value: float = Field(gt=0)

    def distance(self, entry_price: float, gap_abs: float) -> float:
        if self.mode == "points":
            return self.value
        if self.mode == "percent":
            return entry_price * self.value / 100.0
        return gap_abs * self.value  # gap_multiple


class BacktestConfig(BaseModel):
    session: str = "NY"
    gap_window: int = Field(default=20, ge=2)
    gap_sigma: float = Field(default=1.5, ge=0)
    direction: Direction = Direction.fade
    # Enter k bars after the session open bar (0 = at the open bar's open price).
    entry_offset_bars: int = Field(default=0, ge=0)
    stop_loss: PriceLevel | None = None
    take_profit: PriceLevel | None = None
    # Time stop: exit after this many bars, and/or at this wall-clock time (ET).
    time_stop_bars: int | None = Field(default=None, ge=1)
    time_stop_at: str | None = None  # "HH:MM" in the session zone
    # Same-bar SL/TP resolution.
    intrabar: Literal["stop_first", "target_first"] = "stop_first"


def _side_for(direction: Direction, gap_direction: str) -> int:
    """+1 long, -1 short."""
    if direction == Direction.fade:
        return -1 if gap_direction == "up" else 1
    return 1 if gap_direction == "up" else -1


def _parse_hhmm(value: str) -> time:
    h, m = value.split(":")
    return time(int(h), int(m))


def run_backtest(df_utc: pd.DataFrame, session: Session, config: BacktestConfig) -> dict:
    """Run the gap backtest and return trades + summary metrics + chart markers."""
    df_local = localize(df_utc, session.tz)
    gaps = compute_gaps(df_utc, session, config.gap_window, config.gap_sigma)
    signals = gaps[gaps["is_big"]] if len(gaps) else gaps

    trades: list[dict] = []
    for _, sig in signals.iterrows():
        trade = _simulate_trade(df_local, sig, session, config)
        if trade is not None:
            trades.append(trade)

    from .metrics import summarize

    return {
        "trades": trades,
        "metrics": summarize(trades),
        "signals": int(len(signals)),
    }


def _simulate_trade(
    df_local: pd.DataFrame, sig: pd.Series, session: Session, config: BacktestConfig
) -> dict | None:
    idx = df_local.index
    # Entry bar = the signal's open bar, shifted by entry_offset_bars.
    loc = idx.get_indexer([sig["open_ts"]])[0]
    if loc < 0:
        return None
    entry_loc = loc + config.entry_offset_bars
    if entry_loc >= len(df_local):
        return None

    side = _side_for(config.direction, sig["direction"])
    entry_bar = df_local.iloc[entry_loc]
    entry_price = float(entry_bar["open"])
    entry_ts = idx[entry_loc]
    gap_abs = float(sig["abs_gap"])

    sl_dist = config.stop_loss.distance(entry_price, gap_abs) if config.stop_loss else None
    tp_dist = config.take_profit.distance(entry_price, gap_abs) if config.take_profit else None
    sl_price = entry_price - side * sl_dist if sl_dist is not None else None
    tp_price = entry_price + side * tp_dist if tp_dist is not None else None

    stop_at = _parse_hhmm(config.time_stop_at) if config.time_stop_at else None
    max_bar = (
        entry_loc + config.time_stop_bars if config.time_stop_bars is not None else None
    )

    exit_price = None
    exit_ts = None
    exit_reason = None

    for j in range(entry_loc, len(df_local)):
        bar = df_local.iloc[j]
        ts = idx[j]
        high, low = float(bar["high"]), float(bar["low"])

        hit_sl = sl_price is not None and (
            (side == 1 and low <= sl_price) or (side == -1 and high >= sl_price)
        )
        hit_tp = tp_price is not None and (
            (side == 1 and high >= tp_price) or (side == -1 and low <= tp_price)
        )

        if hit_sl and hit_tp:
            if config.intrabar == "stop_first":
                exit_price, exit_reason = sl_price, "stop_loss"
            else:
                exit_price, exit_reason = tp_price, "take_profit"
            exit_ts = ts
            break
        if hit_sl:
            exit_price, exit_reason, exit_ts = sl_price, "stop_loss", ts
            break
        if hit_tp:
            exit_price, exit_reason, exit_ts = tp_price, "take_profit", ts
            break

        # Time-based exits evaluated at bar close.
        if max_bar is not None and j >= max_bar:
            exit_price, exit_reason, exit_ts = float(bar["close"]), "time_stop_bars", ts
            break
        if stop_at is not None and ts.time() >= stop_at and j > entry_loc:
            exit_price, exit_reason, exit_ts = float(bar["close"]), "time_stop_at", ts
            break

    if exit_price is None:  # ran out of data — close at last bar
        last = df_local.iloc[-1]
        exit_price, exit_reason, exit_ts = float(last["close"]), "end_of_data", idx[-1]

    pnl = side * (exit_price - entry_price)
    r_multiple = (pnl / sl_dist) if sl_dist else None

    return {
        "signal_date": str(sig["date"]),
        "side": "long" if side == 1 else "short",
        "gap": float(sig["gap"]),
        "entry_ts": entry_ts.isoformat(),
        "entry_price": round(entry_price, 5),
        "exit_ts": exit_ts.isoformat(),
        "exit_price": round(exit_price, 5),
        "exit_reason": exit_reason,
        "pnl": round(pnl, 5),
        "r_multiple": round(r_multiple, 3) if r_multiple is not None else None,
    }

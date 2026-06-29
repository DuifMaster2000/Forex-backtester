"""Position simulation for the session-gap strategy.

Given detected big gaps, the engine opens one position per signal and manages it
with optional price-based stop-loss / take-profit and a time-based stop. Because
the data is 30-minute OHLC, intrabar fills are approximations: when a bar's range
spans both the stop and the target, we resolve the ambiguity with a configurable
ordering rule (default: stop fills first, the conservative assumption).
"""
from __future__ import annotations

from enum import Enum
from typing import Literal

import pandas as pd
from pydantic import BaseModel, Field

from ..sessions import DISPLAY_TZ, Session, localize
from ..strategies.gap import compute_gaps
from ..strategies.follow_filters import find_follow_entry
from .adr import adr_before, daily_ranges


class Direction(str, Enum):
    fade = "fade"      # trade against the gap (short an up-gap, long a down-gap)
    follow = "follow"  # trade with the gap (long an up-gap, short a down-gap)


class Strategy(str, Enum):
    base = "base"                      # original: fixed offset after the open, fade/follow
    follow_filters = "follow_filters"  # follow only, wait for a "good entry" at set times


class PriceLevel(BaseModel):
    """A price distance from entry, expressed in one of several units."""

    mode: Literal["points", "percent", "gap_multiple", "adr_multiple"] = "points"
    value: float = Field(gt=0)

    def distance(self, entry_price: float, gap_abs: float, adr: float | None) -> float | None:
        if self.mode == "points":
            return self.value
        if self.mode == "percent":
            return entry_price * self.value / 100.0
        if self.mode == "adr_multiple":
            return None if adr is None else adr * self.value
        return gap_abs * self.value  # gap_multiple


class BacktestConfig(BaseModel):
    strategy: Strategy = Strategy.base
    session: str = "NY"
    gap_window: int = Field(default=20, ge=2)
    gap_sigma: float = Field(default=1.5, ge=0)
    direction: Direction = Direction.fade
    # Delay from the gap (session open) before entering, in minutes (30-min steps,
    # up to 48h). 0 = enter at the session open bar's open price. Base strategy only.
    entry_offset_minutes: int = Field(default=0, ge=0, le=2880)
    # follow_filters: allowed entry times of day ("HH:MM" in the session timezone).
    # The first one whose good-entry condition holds is taken.
    entry_times: list[str] = Field(default_factory=list)
    # follow_filters: void the signal if no good entry appears within this many
    # minutes of the gap (trading time, so it skips weekends/closures). Default 48h.
    entry_timeout_minutes: int = Field(default=2880, ge=30, le=20160)
    # Days used for the Average Daily Range when SL/TP is in adr_multiple mode.
    adr_window: int = Field(default=20, ge=2)
    stop_loss: PriceLevel | None = None
    take_profit: PriceLevel | None = None
    # Time stop: exit this many minutes after the gap (30-min steps, up to 96h),
    # or None to disable. Measured from real timestamps, so it skips overnight /
    # weekend periods that have no bars.
    time_stop_minutes: int | None = Field(default=None, ge=30, le=5760)
    # Same-bar SL/TP resolution.
    intrabar: Literal["stop_first", "target_first"] = "stop_first"
    # Round-trip transaction cost in price units, deducted from each trade's P/L
    # (e.g. EURUSD 0.00015 = 1.5 pips; gold 0.30). 0 = frictionless.
    spread: float = Field(default=0.0, ge=0)


def _side_for(direction: Direction, gap_direction: str) -> int:
    """+1 long, -1 short."""
    if direction == Direction.fade:
        return -1 if gap_direction == "up" else 1
    return 1 if gap_direction == "up" else -1


def _bar_step_minutes(idx: pd.DatetimeIndex) -> int:
    """Most common gap between consecutive bars, in minutes (the bar interval)."""
    if len(idx) < 2:
        return 30
    deltas = idx.to_series().diff().dropna()
    deltas = deltas[deltas > pd.Timedelta(0)]
    if deltas.empty:
        return 30
    modal = deltas.mode()
    seconds = (modal.iloc[0] if not modal.empty else deltas.median()).total_seconds()
    return int(round(seconds / 60))


def run_backtest(df_utc: pd.DataFrame, session: Session, config: BacktestConfig) -> dict:
    """Run the gap backtest and return trades + summary metrics + chart markers."""
    df_local = localize(df_utc, session.tz)
    gaps = compute_gaps(df_utc, session, config.gap_window, config.gap_sigma)
    signals = gaps[gaps["is_big"]] if len(gaps) else gaps
    ranges = daily_ranges(df_utc)  # daily ranges on the NY axis for ADR stops
    step_minutes = _bar_step_minutes(df_local.index)

    trades: list[dict] = []
    for _, sig in signals.iterrows():
        trade = _simulate_trade(df_local, sig, ranges, step_minutes, config)
        if trade is not None:
            trades.append(trade)

    from .metrics import summarize

    return {
        "trades": trades,
        "metrics": summarize(trades),
        "signals": int(len(signals)),
    }


def _simulate_trade(
    df_local: pd.DataFrame,
    sig: pd.Series,
    ranges: pd.Series,
    step_minutes: int,
    config: BacktestConfig,
) -> dict | None:
    idx = df_local.index
    # The gap reference is the signal's session open bar. Entry and time-stop are
    # counted in *trading bars* from it, so weekends and closures (which have no
    # bars) don't consume the budget.
    loc = idx.get_indexer([sig["open_ts"]])[0]
    if loc < 0:
        return None
    gap_ts = idx[loc]

    # Entry depends on the strategy.
    #  - base: a fixed number of trading bars after the gap bar, always taken,
    #    direction fade or follow.
    #  - follow_filters: follow the gap and wait for a "good entry" at one of the
    #    configured times; the signal is voided (no trade) if none arrives in time.
    if config.strategy == Strategy.follow_filters:
        found = find_follow_entry(
            df_local, sig, loc, step_minutes, config.entry_times, config.entry_timeout_minutes
        )
        if found is None:
            return None
        entry_loc = found
        side = 1 if sig["direction"] == "up" else -1  # follow only
    else:
        entry_loc = loc + round(config.entry_offset_minutes / step_minutes)
        if entry_loc >= len(df_local):
            return None
        side = _side_for(config.direction, sig["direction"])

    entry_bar = df_local.iloc[entry_loc]
    entry_price = float(entry_bar["open"])
    entry_ts = idx[entry_loc]
    gap_abs = float(sig["abs_gap"])
    # ADR over the days strictly before this signal's NY day (no look-ahead).
    ref_key = gap_ts.tz_convert(DISPLAY_TZ).strftime("%Y-%m-%d")
    adr = adr_before(ranges, ref_key, config.adr_window)

    sl_dist = config.stop_loss.distance(entry_price, gap_abs, adr) if config.stop_loss else None
    tp_dist = config.take_profit.distance(entry_price, gap_abs, adr) if config.take_profit else None
    sl_price = entry_price - side * sl_dist if sl_dist is not None else None
    tp_price = entry_price + side * tp_dist if tp_dist is not None else None

    # Time stop: exit this many trading bars after the reference bar (counting bars
    # skips weekends/closures so a 48h stop spans a weekend rather than expiring
    # inside it). Base measures from the gap bar; follow_filters measures from
    # entry, since entry can land far from the gap (a cap on how long the trade is
    # held rather than on how long since the gap).
    time_stop_ref = entry_loc if config.strategy == Strategy.follow_filters else loc
    stop_loc = (
        time_stop_ref + round(config.time_stop_minutes / step_minutes)
        if config.time_stop_minutes is not None
        else None
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

        # Time-based exit evaluated at bar close.
        if stop_loc is not None and j >= stop_loc and j > entry_loc:
            exit_price, exit_reason, exit_ts = float(bar["close"]), "time_stop", ts
            break

    if exit_price is None:  # ran out of data — close at last bar
        last = df_local.iloc[-1]
        exit_price, exit_reason, exit_ts = float(last["close"]), "end_of_data", idx[-1]

    # Deduct the round-trip spread cost from every trade.
    pnl = side * (exit_price - entry_price) - config.spread
    r_multiple = (pnl / sl_dist) if sl_dist else None

    return {
        "signal_date": str(sig["date"]),
        "side": "long" if side == 1 else "short",
        "gap": float(sig["gap"]),
        # Timestamps are rendered on the shared New York display axis.
        "entry_ts": entry_ts.tz_convert(DISPLAY_TZ).isoformat(),
        "entry_price": round(entry_price, 5),
        "exit_ts": exit_ts.tz_convert(DISPLAY_TZ).isoformat(),
        "exit_price": round(exit_price, 5),
        "exit_reason": exit_reason,
        "pnl": round(pnl, 5),
        "r_multiple": round(r_multiple, 3) if r_multiple is not None else None,
    }

"""Brute-force / grid-search optimiser (backend mirror of frontend/src/engine/grid.ts).

Expands a parameter grid into individual backtest configs, runs them all, and
ranks by a chosen metric. Reuses run_backtest, so per-config results match the
single-backtest path exactly.
"""
from __future__ import annotations

from itertools import product
from typing import Literal

import pandas as pd
from pydantic import BaseModel, Field

from ..sessions import DEFAULT_SESSIONS, Session
from .engine import BacktestConfig, PriceLevel, Strategy, make_runner

# Wait timeout used for base-strategy configs (where it's irrelevant): 48h.
_DEFAULT_ENTRY_TIMEOUT_MIN = 2880

LevelMode = Literal["points", "percent", "gap_multiple", "adr_multiple"]
RankMetric = Literal[
    "total_r", "total_pnl", "return_dd", "profit_factor", "win_rate", "expectancy"
]


class NumRange(BaseModel):
    vary: bool = False
    fixed: float = 0
    min: float = 0
    max: float = 0
    step: float = 1


class ToggleRange(NumRange):
    enabled: bool = False


class LevelRange(ToggleRange):
    mode: LevelMode = "adr_multiple"


class GridSpec(BaseModel):
    strategy: Strategy = Strategy.base
    sessions: list[str] = ["NY"]
    directions: list[str] = ["fade"]
    gap_window: NumRange = NumRange(fixed=20)
    gap_sigma: NumRange = NumRange(fixed=1.5)
    entry_offset_hours: NumRange = NumRange(fixed=0)  # base strategy only
    entry_times: list[str] = []  # follow_filters: fixed list of entry times ("HH:MM")
    # follow_filters: when varied, sweep an entry time as hours after the session
    # open (0..24); when not varied, entry_times is used.
    entry_time: NumRange = NumRange(fixed=9.5)
    # follow_filters: when entry_time is swept AND this is varied, add a second
    # swept entry time (hours after open) -> two-element entry_times list.
    entry_time2: NumRange = NumRange()
    entry_timeout: NumRange = NumRange(fixed=48)  # follow_filters: wait timeout in hours
    # follow_filters inversion clause: which settings to test ([False], [True], or
    # both). The multiple/offset are NumRanges so the stability sweep can vary them
    # (the optimiser keeps them fixed, vary=False).
    invert: list[bool] = [False]
    invert_multiple: NumRange = NumRange(fixed=1.0)
    invert_offset_hours: NumRange = NumRange(fixed=1.0)
    # When custom exits are on, inversion trades use invert_sl/invert_tp instead of
    # the follow trades' sl/tp.
    invert_custom_exits: bool = False
    invert_sl: LevelRange = LevelRange(enabled=False, fixed=0.5)
    invert_tp: LevelRange = LevelRange(enabled=False, fixed=1.0)
    time_stop: ToggleRange = ToggleRange(enabled=True, fixed=24)
    sl: LevelRange = LevelRange(enabled=True, fixed=0.5)
    tp: LevelRange = LevelRange(enabled=True, fixed=1.0)
    spread: float = 0.0  # static round-trip cost applied to every config
    rank_by: RankMetric = "total_r"
    top_n: int = Field(default=100, ge=1)


def _hours_to_hhmm(hours: float) -> str:
    """Hours-of-day -> "HH:MM", snapped to the 30-min grid and wrapped to a day
    (9.5 -> "09:30", 25.5 -> "01:30"). Wrapping lets a "hours after open" duration
    that crosses midnight resolve to the right clock time the next day."""
    m = int(round(hours * 60 / 30) * 30)
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


def _session_open_hours(name: str) -> float:
    """A session's open time as hours-of-day (NY 09:30 -> 9.5). Defaults to 9.5."""
    s = DEFAULT_SESSIONS.get(name)
    return (s.open_time.hour + s.open_time.minute / 60) if s else 9.5


def range_values(r: NumRange) -> list[float]:
    """Inclusive value list for a range (or just [fixed] when not varying)."""
    if not r.vary:
        return [r.fixed]
    if r.step <= 0 or r.max < r.min:
        return [r.min]
    out: list[float] = []
    eps = r.step * 1e-6
    v = r.min
    while v <= r.max + eps:
        out.append(round(v, 6))
        v += r.step
    return out


def expand_grid(spec: GridSpec) -> list[BacktestConfig]:
    # follow_filters varies the wait timeout (not the entry offset) and follows
    # only; base varies the entry offset and fade/follow. The unused axis collapses
    # to a single value so it doesn't inflate the product.
    is_follow = spec.strategy == Strategy.follow_filters
    gap_windows = [int(round(v)) for v in range_values(spec.gap_window)]
    gap_sigmas = range_values(spec.gap_sigma)
    directions = ["follow"] if is_follow else spec.directions
    entry_offsets = (
        [0] if is_follow else [int(round(h * 60 / 30) * 30) for h in range_values(spec.entry_offset_hours)]
    )
    entry_timeouts = (
        [int(round(h * 60 / 30) * 30) for h in range_values(spec.entry_timeout)]
        if is_follow
        else [_DEFAULT_ENTRY_TIMEOUT_MIN]
    )
    # When swept, the entry time is a duration in *hours after the session open*
    # (0..24), resolved to a clock time per session below (so it can cross midnight
    # into the next day). When not swept, the fixed entry_times list is used.
    swept_durations: list[float] | None = (
        range_values(spec.entry_time) if is_follow and spec.entry_time.vary else None
    )
    swept_durations2: list[float] | None = (
        range_values(spec.entry_time2) if swept_durations is not None and spec.entry_time2.vary else None
    )
    time_stops: list[int | None] = (
        [int(round(h * 60 / 30) * 30) for h in range_values(spec.time_stop)]
        if spec.time_stop.enabled
        else [None]
    )
    sls: list[PriceLevel | None] = (
        [PriceLevel(mode=spec.sl.mode, value=v) for v in range_values(spec.sl)]
        if spec.sl.enabled
        else [None]
    )
    tps: list[PriceLevel | None] = (
        [PriceLevel(mode=spec.tp.mode, value=v) for v in range_values(spec.tp)]
        if spec.tp.enabled
        else [None]
    )
    inv_custom = is_follow and spec.invert_custom_exits
    inv_sls: list[PriceLevel | None] = (
        [PriceLevel(mode=spec.invert_sl.mode, value=v) for v in range_values(spec.invert_sl)]
        if inv_custom and spec.invert_sl.enabled
        else [None]
    )
    inv_tps: list[PriceLevel | None] = (
        [PriceLevel(mode=spec.invert_tp.mode, value=v) for v in range_values(spec.invert_tp)]
        if inv_custom and spec.invert_tp.enabled
        else [None]
    )
    inverts = spec.invert if is_follow and spec.invert else [False]
    invert_multiples = range_values(spec.invert_multiple) if is_follow else [1.0]
    invert_offsets = (
        [int(round(h * 60 / 30) * 30) for h in range_values(spec.invert_offset_hours)]
        if is_follow
        else [60]
    )

    configs: list[BacktestConfig] = []
    for session in spec.sessions:
        # Resolve the entry-time axis for this session: swept durations become clock
        # times anchored to *this* session's open; otherwise use the fixed list.
        # With a second swept time, each config carries both (ordered by time).
        if swept_durations is not None and swept_durations2 is not None:
            open_h = _session_open_hours(session)
            entry_times_axis = [
                [_hours_to_hhmm(open_h + min(h1, h2)), _hours_to_hhmm(open_h + max(h1, h2))]
                for h1 in swept_durations
                for h2 in swept_durations2
            ]
        elif swept_durations is not None:
            open_h = _session_open_hours(session)
            entry_times_axis = [[_hours_to_hhmm(open_h + h)] for h in swept_durations]
        else:
            entry_times_axis = [spec.entry_times if is_follow else []]

        for direction, gw, gs, eo, ets, et, inv, invm, invo, invsl, invtp, ts, sl, tp in product(
            directions, gap_windows, gap_sigmas,
            entry_offsets, entry_times_axis, entry_timeouts, inverts,
            invert_multiples, invert_offsets, inv_sls, inv_tps, time_stops, sls, tps,
        ):
            configs.append(
                BacktestConfig(
                    strategy=spec.strategy,
                    session=session,
                    gap_window=gw,
                    gap_sigma=gs,
                    direction=direction,
                    entry_offset_minutes=eo,
                    entry_times=ets,
                    entry_timeout_minutes=et,
                    invert_enabled=inv,
                    invert_gap_multiple=invm,
                    invert_entry_offset_minutes=invo,
                    invert_custom_exits=inv_custom,
                    invert_stop_loss=invsl,
                    invert_take_profit=invtp,
                    adr_window=20,
                    stop_loss=sl,
                    take_profit=tp,
                    time_stop_minutes=ts,
                    intrabar="stop_first",
                    spread=spec.spread,
                )
            )
    return configs


def _metric_value(metrics: dict, rank_by: RankMetric) -> float:
    if rank_by == "return_dd":
        dd = metrics["max_drawdown"]
        pnl = metrics["total_pnl"]
        if dd > 0:
            return pnl / dd
        return float("inf") if pnl > 0 else 0.0
    v = metrics.get(rank_by)
    if v is None:
        return float("-inf")
    return float(v)


def run_grid(df_utc: pd.DataFrame, sessions: dict[str, Session], spec: GridSpec) -> dict:
    """Run every config and return the count plus the top-N ranked results."""
    configs = expand_grid(spec)
    run = make_runner(df_utc, sessions)  # memoizes signal-level work across configs
    results = []
    for config in configs:
        metrics = run(config)["metrics"]
        results.append({"config": config.model_dump(), "metrics": metrics})

    results.sort(key=lambda r: _metric_value(r["metrics"], spec.rank_by), reverse=True)
    return {"count": len(configs), "results": results[: spec.top_n]}

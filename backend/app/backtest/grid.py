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

from ..sessions import Session
from .engine import BacktestConfig, PriceLevel, run_backtest

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
    sessions: list[str] = ["NY"]
    directions: list[str] = ["fade"]
    gap_window: NumRange = NumRange(fixed=20)
    gap_sigma: NumRange = NumRange(fixed=1.5)
    entry_offset_hours: NumRange = NumRange(fixed=0)
    time_stop: ToggleRange = ToggleRange(enabled=True, fixed=24)
    sl: LevelRange = LevelRange(enabled=True, fixed=0.5)
    tp: LevelRange = LevelRange(enabled=True, fixed=1.0)
    spread: float = 0.0  # static round-trip cost applied to every config
    rank_by: RankMetric = "total_r"
    top_n: int = Field(default=100, ge=1)


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
    gap_windows = [int(round(v)) for v in range_values(spec.gap_window)]
    gap_sigmas = range_values(spec.gap_sigma)
    entry_offsets = [int(round(h * 60 / 30) * 30) for h in range_values(spec.entry_offset_hours)]
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

    configs: list[BacktestConfig] = []
    for session, direction, gw, gs, eo, ts, sl, tp in product(
        spec.sessions, spec.directions, gap_windows, gap_sigmas,
        entry_offsets, time_stops, sls, tps,
    ):
        configs.append(
            BacktestConfig(
                session=session,
                gap_window=gw,
                gap_sigma=gs,
                direction=direction,
                entry_offset_minutes=eo,
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
    results = []
    for config in configs:
        metrics = run_backtest(df_utc, sessions[config.session], config)["metrics"]
        results.append({"config": config.model_dump(), "metrics": metrics})

    results.sort(key=lambda r: _metric_value(r["metrics"], spec.rank_by), reverse=True)
    return {"count": len(configs), "results": results[: spec.top_n]}

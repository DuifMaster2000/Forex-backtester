"""Stability / sensitivity sweep (backend mirror of frontend/src/engine/sweep.ts).

Varies a single parameter (optionally split into a few series) and reports a
chosen metric across its range, so robustness can be judged as a plateau rather
than a single spike. Built on top of the grid engine.
"""
from __future__ import annotations

from typing import Literal

import pandas as pd
from pydantic import BaseModel

from ..sessions import DEFAULT_SESSIONS, Session
from .engine import BacktestConfig, run_backtest
from .grid import LevelRange, NumRange, ToggleRange, expand_grid, GridSpec

SweepParam = Literal[
    "entry_delay", "time_stop", "gap_window", "gap_sigma", "sl_value", "tp_value"
]
SweepMetric = Literal[
    "total_pnl", "profit_factor", "total_r", "win_rate", "expectancy", "trades"
]
SeriesBy = Literal["none", "direction", "session"]


class SweepSpec(BaseModel):
    param: SweepParam
    min: float
    max: float
    step: float
    series: SeriesBy = "none"
    metric: SweepMetric = "total_pnl"


class SweepRequest(BaseModel):
    base: BacktestConfig
    spec: SweepSpec


def _fixed(v: float) -> NumRange:
    return NumRange(vary=False, fixed=v, min=v, max=v, step=1)


def _varied(s: SweepSpec) -> NumRange:
    return NumRange(vary=True, fixed=s.min, min=s.min, max=s.max, step=s.step)


def build_grid_spec(base: BacktestConfig, spec: SweepSpec) -> GridSpec:
    p = spec.param
    return GridSpec(
        sessions=[s.name for s in DEFAULT_SESSIONS.values()] if spec.series == "session" else [base.session],
        directions=["fade", "follow"] if spec.series == "direction" else [base.direction],
        gap_window=_varied(spec) if p == "gap_window" else _fixed(base.gap_window),
        gap_sigma=_varied(spec) if p == "gap_sigma" else _fixed(base.gap_sigma),
        entry_offset_hours=_varied(spec) if p == "entry_delay" else _fixed(base.entry_offset_minutes / 60),
        time_stop=ToggleRange(
            enabled=base.time_stop_minutes is not None or p == "time_stop",
            **(_varied(spec) if p == "time_stop" else _fixed((base.time_stop_minutes or 1440) / 60)).model_dump(),
        ),
        sl=LevelRange(
            enabled=base.stop_loss is not None or p == "sl_value",
            mode=base.stop_loss.mode if base.stop_loss else "adr_multiple",
            **(_varied(spec) if p == "sl_value" else _fixed(base.stop_loss.value if base.stop_loss else 0.5)).model_dump(),
        ),
        tp=LevelRange(
            enabled=base.take_profit is not None or p == "tp_value",
            mode=base.take_profit.mode if base.take_profit else "adr_multiple",
            **(_varied(spec) if p == "tp_value" else _fixed(base.take_profit.value if base.take_profit else 1.0)).model_dump(),
        ),
    )


def extract_x(config: BacktestConfig, param: SweepParam) -> float:
    if param == "entry_delay":
        return config.entry_offset_minutes / 60
    if param == "time_stop":
        return (config.time_stop_minutes or 0) / 60
    if param == "gap_window":
        return config.gap_window
    if param == "gap_sigma":
        return config.gap_sigma
    if param == "sl_value":
        return config.stop_loss.value if config.stop_loss else 0
    return config.take_profit.value if config.take_profit else 0


def get_metric(metrics: dict, metric: SweepMetric) -> float | None:
    if metric == "win_rate":
        return metrics["win_rate"] * 100
    return metrics.get(metric)


def run_sweep(df_utc: pd.DataFrame, sessions: dict[str, Session], base: BacktestConfig, spec: SweepSpec) -> dict:
    configs = expand_grid(build_grid_spec(base, spec))
    lines: dict[str, list[dict]] = {}
    for config in configs:
        metrics = run_backtest(df_utc, sessions[config.session], config)["metrics"]
        if spec.series == "direction":
            label = config.direction
        elif spec.series == "session":
            label = config.session
        else:
            label = "result"
        lines.setdefault(label, []).append(
            {"x": extract_x(config, spec.param), "y": get_metric(metrics, spec.metric)}
        )

    series = [
        {"label": label, "points": sorted(points, key=lambda p: p["x"])}
        for label, points in lines.items()
    ]
    return {"series": series, "param": spec.param, "metric": spec.metric}

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
from ..strategies.follow_filters import parse_hhmm
from .engine import BacktestConfig, Strategy, make_runner
from .grid import LevelRange, NumRange, ToggleRange, expand_grid, GridSpec

SweepParam = Literal[
    "entry_delay", "entry_time", "entry_timeout", "invert_multiple", "invert_offset",
    "time_stop", "gap_window", "gap_sigma", "sl_value", "tp_value",
    "invert_sl_value", "invert_tp_value",
]
SweepMetric = Literal[
    "total_pnl", "return_dd", "profit_factor", "total_r", "win_rate", "expectancy", "trades"
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


def _entry_hours_after_open(config: BacktestConfig) -> float:
    """A follow config's entry time as hours after the session open (0..24), the
    duration the entry_time sweep ranges over. Inverse of the grid's resolution."""
    if not config.entry_times:
        return 0.0
    m = parse_hhmm(config.entry_times[0])
    clock = (m / 60) if m is not None else 0.0
    s = DEFAULT_SESSIONS.get(config.session)
    open_h = (s.open_time.hour + s.open_time.minute / 60) if s else 9.5
    return (clock - open_h) % 24


def _base_entry_hour(base: BacktestConfig) -> float:
    """Neutral fixed value when entry_time isn't swept (then it's unused anyway)."""
    return _entry_hours_after_open(base)


def _fixed(v: float) -> NumRange:
    return NumRange(vary=False, fixed=v, min=v, max=v, step=1)


def _varied(s: SweepSpec) -> NumRange:
    return NumRange(vary=True, fixed=s.min, min=s.min, max=s.max, step=s.step)


def build_grid_spec(base: BacktestConfig, spec: SweepSpec) -> GridSpec:
    p = spec.param
    # follow_filters is follow-only, so the "direction" series collapses to follow.
    is_follow = base.strategy == Strategy.follow_filters
    return GridSpec(
        strategy=base.strategy,
        sessions=[s.name for s in DEFAULT_SESSIONS.values()] if spec.series == "session" else [base.session],
        directions=["fade", "follow"] if spec.series == "direction" and not is_follow else [base.direction],
        gap_window=_varied(spec) if p == "gap_window" else _fixed(base.gap_window),
        gap_sigma=_varied(spec) if p == "gap_sigma" else _fixed(base.gap_sigma),
        entry_offset_hours=_varied(spec) if p == "entry_delay" else _fixed(base.entry_offset_minutes / 60),
        entry_times=base.entry_times,
        # When not sweeping entry_time, leave it non-varying so the fixed
        # entry_times list above is used (its value is then irrelevant).
        entry_time=_varied(spec) if p == "entry_time" else _fixed(_base_entry_hour(base)),
        entry_timeout=_varied(spec) if p == "entry_timeout" else _fixed(base.entry_timeout_minutes / 60),
        invert=[base.invert_enabled],  # carry the base's inversion setting through the sweep
        invert_multiple=_varied(spec) if p == "invert_multiple" else _fixed(base.invert_gap_multiple),
        invert_offset_hours=_varied(spec) if p == "invert_offset" else _fixed(base.invert_entry_offset_minutes / 60),
        invert_custom_exits=base.invert_custom_exits or p in ("invert_sl_value", "invert_tp_value"),
        invert_sl=LevelRange(
            enabled=base.invert_stop_loss is not None or p == "invert_sl_value",
            mode=base.invert_stop_loss.mode if base.invert_stop_loss else "adr_multiple",
            **(_varied(spec) if p == "invert_sl_value" else _fixed(base.invert_stop_loss.value if base.invert_stop_loss else 0.5)).model_dump(),
        ),
        invert_tp=LevelRange(
            enabled=base.invert_take_profit is not None or p == "invert_tp_value",
            mode=base.invert_take_profit.mode if base.invert_take_profit else "adr_multiple",
            **(_varied(spec) if p == "invert_tp_value" else _fixed(base.invert_take_profit.value if base.invert_take_profit else 1.0)).model_dump(),
        ),
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
        spread=base.spread,
    )


def extract_x(config: BacktestConfig, param: SweepParam) -> float:
    if param == "entry_delay":
        return config.entry_offset_minutes / 60
    if param == "entry_time":
        return _entry_hours_after_open(config)
    if param == "entry_timeout":
        return config.entry_timeout_minutes / 60
    if param == "invert_multiple":
        return config.invert_gap_multiple
    if param == "invert_offset":
        return config.invert_entry_offset_minutes / 60
    if param == "time_stop":
        return (config.time_stop_minutes or 0) / 60
    if param == "gap_window":
        return config.gap_window
    if param == "gap_sigma":
        return config.gap_sigma
    if param == "invert_sl_value":
        return config.invert_stop_loss.value if config.invert_stop_loss else 0
    if param == "invert_tp_value":
        return config.invert_take_profit.value if config.invert_take_profit else 0
    if param == "sl_value":
        return config.stop_loss.value if config.stop_loss else 0
    return config.take_profit.value if config.take_profit else 0


def get_metric(metrics: dict, metric: SweepMetric) -> float | None:
    if metric == "win_rate":
        return metrics["win_rate"] * 100
    if metric == "return_dd":
        dd = metrics["max_drawdown"]
        return metrics["total_pnl"] / dd if dd > 0 else None
    return metrics.get(metric)


def run_sweep(df_utc: pd.DataFrame, sessions: dict[str, Session], base: BacktestConfig, spec: SweepSpec) -> dict:
    configs = expand_grid(build_grid_spec(base, spec))
    run = make_runner(df_utc, sessions)  # memoizes signal-level work across the sweep
    lines: dict[str, list[dict]] = {}
    for config in configs:
        metrics = run(config)["metrics"]
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

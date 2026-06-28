"""Stability sweep tests."""
from datetime import time

import numpy as np
import pandas as pd

from app.backtest.engine import BacktestConfig, PriceLevel
from app.backtest.sweep import SweepSpec, build_grid_spec, run_sweep
from app.sessions import DEFAULT_SESSIONS


def _base() -> BacktestConfig:
    return BacktestConfig(
        session="NY", gap_window=3, gap_sigma=1.5, direction="fade",
        entry_offset_minutes=0, time_stop_minutes=1440,
        stop_loss=PriceLevel(mode="adr_multiple", value=1.0), take_profit=None,
    )


def _gap_df():
    days = pd.bdate_range("2026-03-02", periods=5, tz="America/New_York")
    opens = [100, 100.1, 100.1, 100.1, 110]
    frames = []
    for d, op in zip(days, opens):
        idx = pd.date_range(d.replace(hour=9, minute=30), d.replace(hour=17), freq="30min")
        price = np.full(len(idx), 100.0)
        price[0] = op
        frames.append(pd.DataFrame(
            {"open": price, "high": price, "low": price, "close": price, "volume": 1.0},
            index=idx,
        ))
    df = pd.concat(frames)
    df.index = df.index.tz_convert("UTC")
    return df


def test_build_grid_spec_varies_only_target():
    spec = SweepSpec(param="gap_sigma", min=1.0, max=2.0, step=0.5, series="none", metric="total_pnl")
    g = build_grid_spec(_base(), spec)
    assert g.gap_sigma.vary is True
    assert g.gap_window.vary is False and g.gap_window.fixed == 3
    assert g.sessions == ["NY"] and g.directions == ["fade"]


def test_sweep_single_series_sorted_points():
    spec = SweepSpec(param="time_stop", min=4, max=8, step=2, series="none", metric="total_pnl")
    out = run_sweep(_gap_df(), DEFAULT_SESSIONS, _base(), spec)
    assert len(out["series"]) == 1
    pts = out["series"][0]["points"]
    assert [p["x"] for p in pts] == [4.0, 6.0, 8.0]  # hours, sorted


def test_sweep_direction_series():
    spec = SweepSpec(param="gap_sigma", min=1.0, max=2.0, step=0.5, series="direction", metric="total_pnl")
    out = run_sweep(_gap_df(), DEFAULT_SESSIONS, _base(), spec)
    labels = {s["label"] for s in out["series"]}
    assert labels == {"fade", "follow"}
    for s in out["series"]:
        assert len(s["points"]) == 3

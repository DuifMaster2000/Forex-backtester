"""Grid-search optimiser tests."""
from datetime import time

import numpy as np
import pandas as pd

from app.backtest.grid import (
    GridSpec, LevelRange, NumRange, ToggleRange, _metric_value, _rank_value,
    expand_grid, range_values, run_grid,
)
from app.backtest.metrics import summarize
from app.sessions import DEFAULT_SESSIONS, Session

NY = Session("NY", "America/New_York", time(9, 30), time(17, 0))


def test_return_dd_metric_value():
    assert _metric_value({"total_pnl": 100.0, "max_drawdown": 40.0}, "return_dd") == 2.5
    assert _metric_value({"total_pnl": -30.0, "max_drawdown": 20.0}, "return_dd") == -1.5
    # No drawdown: a profitable run ranks at the top, a flat/negative one at 0.
    assert _metric_value({"total_pnl": 50.0, "max_drawdown": 0.0}, "return_dd") == float("inf")
    assert _metric_value({"total_pnl": -5.0, "max_drawdown": 0.0}, "return_dd") == 0.0


def _trades(pnls):
    return [
        {"pnl": float(p), "side": "long", "exit_ts": f"2021-01-{i + 1:02d}T00:00:00", "r_multiple": None}
        for i, p in enumerate(pnls)
    ]


def test_equity_linearity_metrics():
    # A perfectly straight rising equity curve -> r2 == 1, positive slope, huge K.
    steady = summarize(_trades([1.0] * 12))
    assert steady["r2"] == 1.0
    assert steady["equity_slope"] == 1.0
    assert steady["k_ratio"] > 1000  # perfect-line sentinel

    # "Gains then chop": big early wins then flat -> clearly less linear, lower K.
    lumpy = summarize(_trades([10, 10, 10] + [0] * 9))
    assert lumpy["r2"] < steady["r2"]
    assert lumpy["r2"] < 0.9
    assert lumpy["k_ratio"] < steady["k_ratio"]


def test_linear_score_and_k_ratio_metric_value():
    # linear_score = (pnl / max_dd) * r2.
    assert _metric_value({"total_pnl": 100.0, "max_drawdown": 40.0, "r2": 0.5}, "linear_score") == 1.25
    # No drawdown uses a finite sentinel, so the product never becomes inf*0 = nan.
    assert _metric_value({"total_pnl": 50.0, "max_drawdown": 0.0, "r2": 0.0}, "linear_score") == 0.0
    assert _metric_value({"k_ratio": 3.2}, "k_ratio") == 3.2
    assert _metric_value({"k_ratio": None}, "k_ratio") == float("-inf")


def test_rank_min_trades_gate():
    low = {"trades": 5, "total_pnl": 999.0, "max_drawdown": 1.0}
    high = {"trades": 50, "total_pnl": 10.0, "max_drawdown": 1.0}
    # Below the gate -> forced last regardless of how good the metric looks.
    assert _rank_value(low, "total_pnl", 10) == float("-inf")
    assert _rank_value(high, "total_pnl", 10) == 10.0
    # Gate off -> normal value.
    assert _rank_value(low, "total_pnl", 0) == 999.0


def test_spread_propagates_to_every_config():
    configs = expand_grid(GridSpec(
        spread=0.5, gap_sigma=NumRange(vary=True, min=1.0, max=2.0, step=0.5),
    ))
    assert len(configs) > 1
    assert all(c.spread == 0.5 for c in configs)


def test_range_values():
    assert range_values(NumRange(vary=False, fixed=1.5)) == [1.5]
    assert range_values(NumRange(vary=True, min=1.0, max=2.0, step=0.5)) == [1.0, 1.5, 2.0]
    assert range_values(NumRange(vary=True, min=10, max=10, step=5)) == [10]


def test_expand_grid_count():
    spec = GridSpec(
        sessions=["NY", "London"],
        directions=["fade", "follow"],
        gap_sigma=NumRange(vary=True, min=1.0, max=2.0, step=0.5),   # 3
        time_stop=ToggleRange(enabled=True, vary=True, min=24, max=72, step=24),  # 3
        sl=LevelRange(enabled=True, vary=True, min=0.5, max=1.0, step=0.5),  # 2
        tp=LevelRange(enabled=False),  # 1
    )
    configs = expand_grid(spec)
    # 2 sessions * 2 dirs * 1 window * 3 sigma * 1 entry * 3 stop * 2 sl * 1 tp = 72
    assert len(configs) == 72
    assert all(c.take_profit is None for c in configs)
    assert {c.session for c in configs} == {"NY", "London"}


def _gap_df():
    """Five NY sessions with one big up-gap on the last day."""
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


def test_run_grid_ranks_and_limits():
    spec = GridSpec(
        sessions=["NY"],
        directions=["fade", "follow"],
        gap_window=NumRange(fixed=3),
        gap_sigma=NumRange(fixed=1.5),
        time_stop=ToggleRange(enabled=True, fixed=24),
        sl=LevelRange(enabled=False),
        tp=LevelRange(enabled=False),
        rank_by="total_pnl",
        top_n=1,
    )
    out = run_grid(_gap_df(), DEFAULT_SESSIONS, spec)
    assert out["count"] == 2          # fade + follow
    assert len(out["results"]) == 1   # top_n applied
    # Results are sorted best-first by the ranking metric.
    best = out["results"][0]
    assert best["metrics"]["total_pnl"] == max(
        run_grid(_gap_df(), DEFAULT_SESSIONS, spec.model_copy(update={"top_n": 99}))["results"][i]["metrics"]["total_pnl"]
        for i in range(2)
    )

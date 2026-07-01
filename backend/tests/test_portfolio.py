"""Portfolio combiner: position sizing, capital, and the max-open-trades cap."""
from datetime import time

import numpy as np
import pandas as pd

from app.backtest.engine import BacktestConfig, Direction, run_backtest
from app.backtest.portfolio import run_portfolio
from app.sessions import Session

NY = Session("NY", "America/New_York", time(9, 30), time(17, 0))


def _big_gap_df() -> pd.DataFrame:
    """One NY session per business day, with a big +10 up-gap on the fifth day."""
    opens = [100, 100.1, 100.1, 100.1, 110]
    closes = [100, 100, 100, 100, 100]
    days = pd.bdate_range("2026-03-02", periods=len(opens), tz="America/New_York")
    frames = []
    for d, op, cl in zip(days, opens, closes):
        idx = pd.date_range(d.replace(hour=9, minute=30), d.replace(hour=17, minute=0), freq="30min")
        price = np.full(len(idx), 100.0)
        price[0] = op
        price[-1] = cl
        frames.append(pd.DataFrame(
            {"open": price, "high": price, "low": price, "close": price, "volume": 1.0}, index=idx
        ))
    df = pd.concat(frames)
    df.index = df.index.tz_convert("UTC")
    return df


def _leg(leg_id: str, df: pd.DataFrame, position_size: float) -> dict:
    cfg = BacktestConfig(gap_window=3, gap_sigma=1.5, direction=Direction.fade, time_stop_minutes=60)
    return {
        "id": leg_id,
        "label": leg_id,
        "instrument": "TEST",
        "session": NY,
        "position_size": position_size,
        "df": df,
        "config": cfg,
    }


def test_position_size_scales_cash_pnl_and_capital():
    df = _big_gap_df()
    single = run_backtest(df, NY, BacktestConfig(
        gap_window=3, gap_sigma=1.5, direction=Direction.fade, time_stop_minutes=60,
    ))
    trade_pnl = single["trades"][0]["pnl"]

    res = run_portfolio([_leg("a", df, 2.0)], starting_capital=10_000, max_open_trades=0)
    assert res["taken"] == 1 and res["skipped"] == 0
    t = res["trades"][0]
    # Cash P/L is price P/L times the position size; capital moves by that amount.
    assert round(t["cash_pnl"], 6) == round(trade_pnl * 2.0, 6)
    assert round(res["ending_capital"], 6) == round(10_000 + trade_pnl * 2.0, 6)
    assert round(res["metrics"]["total_pnl"], 6) == round(trade_pnl * 2.0, 6)
    # R-multiple is size-independent (both P/L and stop distance scale together).
    assert t["r_multiple"] == single["trades"][0]["r_multiple"]


def test_max_open_trades_skips_overlapping_signal():
    df = _big_gap_df()
    legs = [_leg("a", df, 1.0), _leg("b", df, 1.0)]

    # Both legs fire the same trade at the same time. Cap of 1 => one is skipped.
    capped = run_portfolio(legs, starting_capital=10_000, max_open_trades=1)
    assert capped["taken"] == 1
    assert capped["skipped"] == 1
    assert capped["peak_concurrent"] == 1
    # The skipped candidate is retained (flagged), so the missed signal is visible.
    assert sum(1 for t in capped["trades"] if not t["taken"]) == 1

    # Unlimited (0) takes both simultaneous trades.
    uncapped = run_portfolio(legs, starting_capital=10_000, max_open_trades=0)
    assert uncapped["taken"] == 2
    assert uncapped["skipped"] == 0
    assert uncapped["peak_concurrent"] == 2


def test_per_leg_breakdown_sums_to_total():
    df = _big_gap_df()
    res = run_portfolio([_leg("a", df, 1.0), _leg("b", df, 3.0)], starting_capital=5_000, max_open_trades=0)
    assert len(res["legs"]) == 2
    total = sum(l["cash_pnl"] for l in res["legs"])
    assert round(total, 6) == round(res["metrics"]["total_pnl"], 6)
    assert round(res["return_pct"], 6) == round(res["metrics"]["total_pnl"] / 5_000 * 100, 3)

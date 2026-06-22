"""Gap detection and backtest engine tests using synthetic ET sessions."""
from datetime import time

import numpy as np
import pandas as pd

from app.backtest.engine import BacktestConfig, Direction, PriceLevel, run_backtest
from app.sessions import Session
from app.strategies.gap import compute_gaps

NY = Session("NY", "America/New_York", time(9, 30), time(17, 0))


def build_sessions(open_prices, close_prices, base=100.0) -> pd.DataFrame:
    """Build a 30-min UTC-indexed frame, one NY session per business day.

    Each session spans 09:30..17:00 ET. The 09:30 bar opens at the given
    open price; the 17:00 bar closes at the given close price. Other bars are
    filled flat so highs/lows don't accidentally trigger exits.
    """
    days = pd.bdate_range("2026-03-02", periods=len(open_prices), tz="America/New_York")
    frames = []
    for d, op, cl in zip(days, open_prices, close_prices):
        start = d.replace(hour=9, minute=30)
        end = d.replace(hour=17, minute=0)
        idx = pd.date_range(start, end, freq="30min")
        price = np.full(len(idx), base)
        price[0] = op
        price[-1] = cl
        frame = pd.DataFrame(
            {"open": price, "high": price, "low": price, "close": price, "volume": 1.0},
            index=idx,
        )
        frames.append(frame)
    df = pd.concat(frames)
    df.index = df.index.tz_convert("UTC")
    return df


def test_gap_flags_outlier():
    # Four sessions with tiny gaps, then a big up-gap on the fifth.
    closes = [100, 100, 100, 100, 100]
    opens = [100, 100.1, 100.1, 100.1, 110]  # last open jumps +10 from prior close
    df = build_sessions(opens, closes)
    gaps = compute_gaps(df, NY, window=3, sigma=1.5)
    # Last gap is the big one.
    assert bool(gaps.iloc[-1]["is_big"]) is True
    assert gaps.iloc[-1]["direction"] == "up"
    assert abs(gaps.iloc[-1]["gap"] - 10.0) < 1e-6
    # Earlier small gaps are not flagged.
    assert not gaps["is_big"].iloc[:-1].any()


def _big_gap_df():
    closes = [100, 100, 100, 100, 100]
    opens = [100, 100.1, 100.1, 100.1, 110]
    return build_sessions(opens, closes)


def test_engine_fade_take_profit():
    # Fade a +10 up-gap => short at 110. Make session drift down to hit TP.
    df = _big_gap_df()
    # Move the last session's bars below entry so TP (short) triggers.
    last_day = df.index.normalize().unique()[-1]
    mask = df.index.normalize() == last_day
    df.loc[mask, ["high", "low", "close", "open"]] = 105.0
    df.loc[df.index[df.index.get_indexer([df[mask].index[0]])[0]], ["open"]] = 110.0

    cfg = BacktestConfig(
        gap_window=3, gap_sigma=1.5, direction=Direction.fade,
        take_profit=PriceLevel(mode="points", value=3),
        stop_loss=PriceLevel(mode="points", value=10),
        intrabar="stop_first",
    )
    res = run_backtest(df, NY, cfg)
    assert res["metrics"]["trades"] == 1
    t = res["trades"][0]
    assert t["side"] == "short"
    assert t["exit_reason"] == "take_profit"
    assert t["pnl"] > 0
    # Total R aggregates the per-trade R-multiple (single trade here).
    assert res["metrics"]["total_r"] == t["r_multiple"]
    assert res["metrics"]["avg_r"] == t["r_multiple"]


def test_engine_time_stop_after_gap():
    # Time stop 1h after the gap (09:30) -> exit at the 10:30 bar close.
    df = _big_gap_df()
    cfg = BacktestConfig(
        gap_window=3, gap_sigma=1.5, direction=Direction.fade,
        time_stop_minutes=60,
    )
    res = run_backtest(df, NY, cfg)
    t = res["trades"][0]
    assert t["exit_reason"] == "time_stop"
    assert t["exit_ts"].startswith("2026-03-06T10:30")  # one hour after the open


def test_engine_entry_delay_after_gap():
    # Entry delayed 1h after the gap enters at the 10:30 open (100), not 110.
    df = _big_gap_df()
    cfg = BacktestConfig(
        gap_window=3, gap_sigma=1.5, direction=Direction.fade,
        entry_offset_minutes=60,
    )
    res = run_backtest(df, NY, cfg)
    t = res["trades"][0]
    assert t["entry_ts"].startswith("2026-03-06T10:30")
    assert t["entry_price"] == 100.0


def test_engine_stop_before_target_same_bar():
    # Both SL and TP within the entry bar -> stop_first wins.
    df = _big_gap_df()
    last_day = df.index.normalize().unique()[-1]
    mask = df.index.normalize() == last_day
    first_ts = df[mask].index[0]
    # Entry bar straddles both levels (short entry at 110).
    df.loc[first_ts, ["open", "high", "low", "close"]] = [110, 115, 105, 108]

    cfg = BacktestConfig(
        gap_window=3, gap_sigma=1.5, direction=Direction.fade,
        stop_loss=PriceLevel(mode="points", value=3),     # short SL at 113
        take_profit=PriceLevel(mode="points", value=3),   # short TP at 107
        intrabar="stop_first",
    )
    res = run_backtest(df, NY, cfg)
    assert res["trades"][0]["exit_reason"] == "stop_loss"

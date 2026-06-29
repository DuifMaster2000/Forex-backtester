"""Gap detection and backtest engine tests using synthetic ET sessions."""
from datetime import time

import numpy as np
import pandas as pd

from app.backtest.engine import BacktestConfig, Direction, PriceLevel, run_backtest
from app.sessions import Session, localize, session_bars
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


def test_session_open_anchored_across_dst():
    # 10 business days spanning the 2026-03-08 spring-forward transition.
    n = 10
    df = build_sessions([100.0] * n, [100.0] * n)
    df_local = localize(df, NY.tz)
    days = session_bars(df_local, NY)
    assert len(days) == n
    # Every session open stays anchored to 09:30 ET regardless of DST.
    assert all(ts.strftime("%H:%M") == "09:30" for ts in days["open_ts"])
    # The underlying UTC offset shifts -05:00 (EST) -> -04:00 (EDT) across 03-08,
    # which is exactly the DST compensation we want.
    before = days[days["date"] < pd.Timestamp("2026-03-08").date()]
    after = days[days["date"] > pd.Timestamp("2026-03-08").date()]
    assert all(ts.utcoffset().total_seconds() == -5 * 3600 for ts in before["open_ts"])
    assert all(ts.utcoffset().total_seconds() == -4 * 3600 for ts in after["open_ts"])


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


def test_spread_reduces_pnl_per_trade():
    df = _big_gap_df()
    base = dict(gap_window=3, gap_sigma=1.5, direction=Direction.fade, time_stop_minutes=60)
    gross = run_backtest(df, NY, BacktestConfig(**base))
    net = run_backtest(df, NY, BacktestConfig(**base, spread=2.0))
    assert gross["metrics"]["trades"] == net["metrics"]["trades"] == 1
    # Each trade's P/L drops by exactly the spread.
    assert round(gross["trades"][0]["pnl"] - net["trades"][0]["pnl"], 6) == 2.0


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


def test_time_stop_counts_trading_bars_over_weekend():
    # Big gap on Friday 2026-03-06; a 10h (20-bar) time stop must skip the
    # weekend and land 20 *trading* bars later (Monday), not expire in the
    # closed weekend. Friday's session has 16 bars (09:30..17:00), so bar 16 is
    # Monday 09:30 and bar 20 is Monday 11:30.
    opens = [100, 100, 100, 100, 110, 100, 100, 100]  # Fri (index 4) gaps up
    closes = [100] * 8
    df = build_sessions(opens, closes)
    cfg = BacktestConfig(
        gap_window=3, gap_sigma=1.5, direction=Direction.fade,
        time_stop_minutes=600,  # 10h == 20 thirty-minute bars
    )
    res = run_backtest(df, NY, cfg)
    assert res["metrics"]["trades"] == 1
    t = res["trades"][0]
    assert t["exit_reason"] == "time_stop"
    # Exits Monday, well past the Friday gap, having held the full 20 bars.
    assert t["exit_ts"].startswith("2026-03-09T11:30")


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

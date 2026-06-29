"""Tests for the "follow only + filters" strategy entry logic.

The strategy follows the gap and waits for a "good entry" — a pullback back
through the gap level (the session open) — at one of a list of configured times of
day, voiding the signal if none arrives before a timeout.
"""
from datetime import date, time

import numpy as np
import pandas as pd

from app.backtest.engine import BacktestConfig, Strategy, run_backtest
from app.backtest.grid import GridSpec, NumRange, run_grid
from app.backtest.sweep import SweepSpec, run_sweep
from app.sessions import DEFAULT_SESSIONS, Session

NY = Session("NY", "America/New_York", time(9, 30), time(17, 0))


def build_sessions(open_prices, close_prices, base=100.0) -> pd.DataFrame:
    """One NY 09:30..17:00 session per business day, intermediate bars flat at base."""
    days = pd.bdate_range("2026-03-02", periods=len(open_prices), tz="America/New_York")
    frames = []
    for d, op, cl in zip(days, open_prices, close_prices):
        idx = pd.date_range(d.replace(hour=9, minute=30), d.replace(hour=17, minute=0), freq="30min")
        price = np.full(len(idx), base)
        price[0] = op
        price[-1] = cl
        frames.append(
            pd.DataFrame(
                {"open": price, "high": price, "low": price, "close": price, "volume": 1.0},
                index=idx,
            )
        )
    df = pd.concat(frames)
    df.index = df.index.tz_convert("UTC")
    return df


def _up_gap_df() -> pd.DataFrame:
    # Big +10 up-gap on the 5th session (2026-03-06); gap level (open) = 110.
    return build_sessions([100, 100.1, 100.1, 100.1, 110], [100] * 5)


def _down_gap_df() -> pd.DataFrame:
    # Big -10 down-gap on the 5th session (2026-03-06); gap level (open) = 90.
    return build_sessions([100, 99.9, 99.9, 99.9, 90], [100] * 5)


def _follow_cfg(**kw) -> BacktestConfig:
    base = dict(strategy=Strategy.follow_filters, gap_window=3, gap_sigma=1.5)
    base.update(kw)
    return BacktestConfig(**base)


def _set_open(df: pd.DataFrame, day: date, hhmm: str, value: float) -> None:
    """Set a single bar's open price, addressing it by its NY wall-clock time."""
    ny = df.index.tz_convert("America/New_York")
    h, m = (int(x) for x in hhmm.split(":"))
    sel = (ny.hour == h) & (ny.minute == m) & (ny.date == day)
    df.loc[sel, "open"] = value


def test_up_gap_good_entry_goes_long():
    # Up gap -> follow long. At 14:00 the bar opens at 100 (< gap level 110), a
    # good pullback entry. Enter long there.
    df = _up_gap_df()
    res = run_backtest(df, NY, _follow_cfg(entry_times=["14:00"]))
    assert res["metrics"]["trades"] == 1
    t = res["trades"][0]
    assert t["side"] == "long"
    assert t["entry_ts"].startswith("2026-03-06T14:00")
    assert t["entry_price"] == 100.0


def test_down_gap_good_entry_goes_short():
    # Down gap -> follow short. At 14:00 the bar opens at 100 (> gap level 90), a
    # good pullback entry. Enter short there.
    df = _down_gap_df()
    res = run_backtest(df, NY, _follow_cfg(entry_times=["14:00"]))
    assert res["metrics"]["trades"] == 1
    t = res["trades"][0]
    assert t["side"] == "short"
    assert t["entry_ts"].startswith("2026-03-06T14:00")
    assert t["entry_price"] == 100.0


def test_first_qualifying_entry_time_is_taken():
    # Condition fails at 14:00 (open 120 > gap level 110) but holds at 15:00
    # (open 105 < 110). The later, first-qualifying time is taken.
    df = _up_gap_df()
    gap_day = date(2026, 3, 6)
    _set_open(df, gap_day, "14:00", 120.0)
    _set_open(df, gap_day, "15:00", 105.0)
    res = run_backtest(df, NY, _follow_cfg(entry_times=["14:00", "15:00"]))
    assert res["metrics"]["trades"] == 1
    t = res["trades"][0]
    assert t["entry_ts"].startswith("2026-03-06T15:00")
    assert t["entry_price"] == 105.0


def test_no_good_entry_before_timeout_is_void():
    # The only entry time (16:30) lies well past a 30-minute timeout, so the
    # signal is voided and no trade is opened.
    df = _up_gap_df()
    res = run_backtest(df, NY, _follow_cfg(entry_times=["16:30"], entry_timeout_minutes=30))
    assert res["metrics"]["trades"] == 0


def test_condition_never_met_is_void():
    # Up gap with the only entry time's bar opening above the gap level (no
    # pullback) -> never a good entry -> void.
    df = _up_gap_df()
    _set_open(df, date(2026, 3, 6), "14:00", 130.0)  # above gap level 110
    res = run_backtest(df, NY, _follow_cfg(entry_times=["14:00"]))
    assert res["metrics"]["trades"] == 0


def test_time_stop_measured_from_entry():
    # 1h time stop, entry at 14:00 -> exits one hour later at 15:00 (measured from
    # entry, not from the 09:30 gap).
    df = _up_gap_df()
    res = run_backtest(df, NY, _follow_cfg(entry_times=["14:00"], time_stop_minutes=60))
    t = res["trades"][0]
    assert t["exit_reason"] == "time_stop"
    assert t["exit_ts"].startswith("2026-03-06T15:00")


def test_base_strategy_default_is_unaffected():
    # Without an explicit strategy the config defaults to base, which still enters
    # at the gap open and can fade.
    df = _up_gap_df()
    res = run_backtest(df, NY, BacktestConfig(gap_window=3, gap_sigma=1.5))
    assert BacktestConfig().strategy == Strategy.base
    t = res["trades"][0]
    assert t["side"] == "short"  # fade an up gap
    assert t["entry_ts"].startswith("2026-03-06T09:30")


def test_grid_follow_filters_smoke():
    df = _up_gap_df()
    spec = GridSpec(
        strategy=Strategy.follow_filters,
        entry_times=["14:00"],
        entry_timeout=NumRange(vary=True, min=24, max=48, step=24),  # 2 timeouts
        gap_window=NumRange(fixed=3),
        gap_sigma=NumRange(fixed=1.5),
        time_stop=dict(enabled=False),
        sl=dict(enabled=False),
        tp=dict(enabled=False),
    )
    out = run_grid(df, DEFAULT_SESSIONS, spec)
    assert out["count"] == 2
    assert out["results"]
    for r in out["results"]:
        assert r["config"]["strategy"] == "follow_filters"
        assert r["config"]["direction"] == "follow"


def test_sweep_entry_timeout_smoke():
    df = _up_gap_df()
    base = _follow_cfg(entry_times=["14:00"])
    spec = SweepSpec(param="entry_timeout", min=24, max=48, step=24, series="none", metric="trades")
    out = run_sweep(df, DEFAULT_SESSIONS, base, spec)
    assert out["param"] == "entry_timeout"
    assert len(out["series"]) == 1
    assert [p["x"] for p in out["series"][0]["points"]] == [24, 48]


def test_grid_sweeps_single_entry_time():
    # Sweeping entry time as 4..5 hours after the 09:30 open (30-min step) yields
    # one config per time -> clock times 13:30/14:00/14:30, follow direction.
    df = _up_gap_df()
    spec = GridSpec(
        strategy=Strategy.follow_filters,
        entry_time=NumRange(vary=True, min=4, max=5, step=0.5),  # hours after open
        gap_window=NumRange(fixed=3),
        gap_sigma=NumRange(fixed=1.5),
        time_stop=dict(enabled=False),
        sl=dict(enabled=False),
        tp=dict(enabled=False),
    )
    out = run_grid(df, DEFAULT_SESSIONS, spec)
    assert out["count"] == 3
    times = {tuple(r["config"]["entry_times"]) for r in out["results"]}
    assert times == {("13:30",), ("14:00",), ("14:30",)}
    assert all(r["config"]["direction"] == "follow" for r in out["results"])


def test_grid_entry_time_crosses_midnight():
    # 20 hours after a 09:30 open is 05:30 the next day — a duration past one day
    # that the old clock-time picker couldn't express.
    df = _up_gap_df()
    spec = GridSpec(
        strategy=Strategy.follow_filters,
        entry_time=NumRange(vary=True, min=20, max=20, step=0.5),
        gap_window=NumRange(fixed=3),
        gap_sigma=NumRange(fixed=1.5),
        time_stop=dict(enabled=False),
        sl=dict(enabled=False),
        tp=dict(enabled=False),
    )
    out = run_grid(df, DEFAULT_SESSIONS, spec)
    assert out["count"] == 1
    assert out["results"][0]["config"]["entry_times"] == ["05:30"]


def test_grid_fixed_entry_times_unaffected():
    # With entry_time not varied, the fixed list is used and there's one config.
    df = _up_gap_df()
    spec = GridSpec(
        strategy=Strategy.follow_filters,
        entry_times=["14:00", "15:00"],
        gap_window=NumRange(fixed=3),
        gap_sigma=NumRange(fixed=1.5),
        time_stop=dict(enabled=False),
        sl=dict(enabled=False),
        tp=dict(enabled=False),
    )
    out = run_grid(df, DEFAULT_SESSIONS, spec)
    assert out["count"] == 1
    assert out["results"][0]["config"]["entry_times"] == ["14:00", "15:00"]


def test_sweep_entry_time_smoke():
    # Sweep entry time as hours after open; x-axis is that duration (not clock).
    df = _up_gap_df()
    base = _follow_cfg(entry_times=["14:00"])
    spec = SweepSpec(param="entry_time", min=4, max=5, step=0.5, series="none", metric="trades")
    out = run_sweep(df, DEFAULT_SESSIONS, base, spec)
    assert out["param"] == "entry_time"
    assert [p["x"] for p in out["series"][0]["points"]] == [4.0, 4.5, 5.0]

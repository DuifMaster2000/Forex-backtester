"""Average Daily Range tests."""
import pandas as pd

from app.backtest.adr import adr_before, daily_ranges, latest_adr


def _df(day_ranges: dict[str, float]) -> pd.DataFrame:
    """Build a UTC frame: each day has two midday bars whose high-low spans range."""
    rows = []
    for date, rng in day_ranges.items():
        for hh, hi, lo in [(14, 100 + rng, 100), (15, 100, 100)]:
            rows.append((pd.Timestamp(f"{date}T{hh}:00:00", tz="UTC"), hi, lo))
    idx = pd.DatetimeIndex([t for t, _, _ in rows])
    return pd.DataFrame(
        {
            "open": [hi for _, hi, _ in rows],
            "high": [hi for _, hi, _ in rows],
            "low": [lo for _, _, lo in rows],
            "close": [lo for _, _, lo in rows],
            "volume": 1.0,
        },
        index=idx,
    )


def test_daily_ranges_and_adr():
    df = _df({"2026-06-01": 10.0, "2026-06-02": 20.0, "2026-06-03": 30.0})
    ranges = daily_ranges(df)
    assert list(ranges.round(6)) == [10.0, 20.0, 30.0]

    # ADR excludes the reference day itself (no look-ahead).
    assert adr_before(ranges, "2026-06-03", 20) == 15.0   # mean(10, 20)
    assert adr_before(ranges, "2026-06-02", 20) == 10.0   # mean(10)
    assert adr_before(ranges, "2026-06-01", 20) is None   # no prior day

    # Window caps how many prior days are averaged.
    assert adr_before(ranges, "2026-06-03", 1) == 20.0    # only the latest prior day

    # latest_adr averages the last `window` days.
    assert latest_adr(df, 2) == 25.0                      # mean(20, 30)
    assert latest_adr(df, 20) == 20.0                     # mean(10, 20, 30)

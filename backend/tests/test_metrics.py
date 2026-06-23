"""Per-side (long/short) metric breakdown tests."""
from app.backtest.metrics import summarize


def test_by_side_splits_long_and_short():
    trades = [
        {"side": "long", "pnl": 10.0, "r_multiple": 1.0, "exit_ts": "t1"},
        {"side": "long", "pnl": -5.0, "r_multiple": -0.5, "exit_ts": "t2"},
        {"side": "short", "pnl": -3.0, "r_multiple": -1.0, "exit_ts": "t3"},
    ]
    m = summarize(trades)

    lng = m["by_side"]["long"]
    assert lng["trades"] == 2
    assert lng["total_pnl"] == 5.0
    assert lng["win_rate"] == 0.5
    assert lng["total_r"] == 0.5
    assert lng["avg_r"] == 0.25
    assert lng["profit_factor"] == 2.0

    sht = m["by_side"]["short"]
    assert sht["trades"] == 1
    assert sht["total_pnl"] == -3.0
    assert sht["total_r"] == -1.0
    assert sht["profit_factor"] == 0.0  # no winning P/L

    # Aggregate is unchanged by the split.
    assert m["total_pnl"] == 2.0
    assert m["trades"] == 3


def test_by_side_present_when_empty():
    m = summarize([])
    assert m["by_side"]["long"]["trades"] == 0
    assert m["by_side"]["short"]["trades"] == 0
    assert m["by_side"]["long"]["total_r"] is None

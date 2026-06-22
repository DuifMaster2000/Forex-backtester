"""Loader + DST-correctness tests."""
from zoneinfo import ZoneInfo

from app.data.loader import load_csv


def _csv(rows: list[str]) -> bytes:
    header = "time,open,high,low,close,Volume\n"
    return (header + "\n".join(rows) + "\n").encode()


def test_parses_and_infers_metadata():
    content = _csv(
        [
            "2026-05-19T15:00:00+02:00,100,101,99,100.5,10",
            "2026-05-19T15:30:00+02:00,100.5,102,100,101,12",
        ]
    )
    ds = load_csv(content, "5f7f2016-OANDA_XAUUSD_30.csv")
    assert ds.instrument == "XAUUSD"
    assert ds.interval_minutes == 30
    assert ds.source_offset == "+02:00"
    assert ds.rows == 2


def test_summer_offset_converts_to_correct_et():
    # 15:00 CEST (+02:00) == 13:00 UTC == 09:00 ET (EDT, -04:00) in summer.
    content = _csv(["2026-05-19T15:00:00+02:00,100,101,99,100.5,10"])
    ds = load_csv(content)
    et = ds.localize("America/New_York")
    ts = et.index[0]
    assert (ts.hour, ts.minute) == (9, 0)
    assert ts.utcoffset().total_seconds() == -4 * 3600


def test_winter_offset_converts_with_dst_shift():
    # 15:00 CET (+01:00) in January == 14:00 UTC == 09:00 ET (EST, -05:00).
    content = _csv(["2026-01-15T15:00:00+01:00,100,101,99,100.5,10"])
    ds = load_csv(content)
    et = ds.localize("America/New_York")
    ts = et.index[0]
    assert (ts.hour, ts.minute) == (9, 0)
    assert ts.utcoffset().total_seconds() == -5 * 3600


def test_detects_price_precision():
    eur = _csv(["2026-05-19T15:00:00+02:00,1.08345,1.084,1.083,1.08372,10"])
    assert load_csv(eur).price_precision == 5
    gold = _csv(["2026-05-19T15:00:00+02:00,4559.775,4560.03,4546.055,4547.29,12"])
    assert load_csv(gold).price_precision == 3


def test_missing_column_raises():
    bad = b"time,open,high,close\n2026-05-19T15:00:00+02:00,1,2,3\n"
    try:
        load_csv(bad)
        assert False, "expected ValueError"
    except ValueError as e:
        assert "low" in str(e)

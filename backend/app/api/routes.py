"""HTTP API for uploading data, charting, gap detection, and backtesting."""
from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, File, HTTPException, UploadFile

from ..backtest.engine import BacktestConfig, run_backtest
from ..data.store import store
from ..sessions import DEFAULT_SESSIONS, Session, localize, session_from_dict
from ..strategies.gap import compute_gaps

router = APIRouter()

# Session presets are mutable at runtime (built-ins + user additions).
_sessions: dict[str, Session] = dict(DEFAULT_SESSIONS)


def _resolve_session(name: str) -> Session:
    if name not in _sessions:
        raise HTTPException(404, f"Unknown session '{name}'. Known: {list(_sessions)}")
    return _sessions[name]


@router.post("/datasets")
async def upload_dataset(file: UploadFile = File(...)) -> dict:
    content = await file.read()
    try:
        dataset_id, ds = store.add(content, file.filename)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {
        "id": dataset_id,
        "instrument": ds.instrument,
        "interval_minutes": ds.interval_minutes,
        "rows": ds.rows,
        "source_offset": ds.source_offset,
        "start": ds.df.index[0].isoformat(),
        "end": ds.df.index[-1].isoformat(),
    }


@router.get("/datasets")
def list_datasets() -> list[dict]:
    return store.list()


@router.get("/datasets/{dataset_id}/candles")
def get_candles(dataset_id: str, tz: str = "America/New_York") -> dict:
    ds = _get(dataset_id)
    df = localize(ds.df, tz)
    candles = [
        {
            "time": ts.isoformat(),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["volume"]),
        }
        for ts, r in df.iterrows()
    ]
    return {"tz": tz, "candles": candles}


@router.get("/datasets/{dataset_id}/gaps")
def get_gaps(
    dataset_id: str, session: str = "NY", window: int = 20, sigma: float = 1.5
) -> dict:
    ds = _get(dataset_id)
    sess = _resolve_session(session)
    gaps = compute_gaps(ds.df, sess, window, sigma)
    return {"session": sess.to_dict(), "gaps": _gaps_to_json(gaps)}


@router.post("/datasets/{dataset_id}/backtest")
def backtest(dataset_id: str, config: BacktestConfig) -> dict:
    ds = _get(dataset_id)
    sess = _resolve_session(config.session)
    return run_backtest(ds.df, sess, config)


@router.get("/sessions")
def get_sessions() -> list[dict]:
    return [s.to_dict() for s in _sessions.values()]


@router.post("/sessions")
def add_session(payload: dict) -> dict:
    sess = session_from_dict(payload)
    _sessions[sess.name] = sess
    return sess.to_dict()


def _get(dataset_id: str):
    try:
        return store.get(dataset_id)
    except KeyError:
        raise HTTPException(404, f"Dataset '{dataset_id}' not found")


def _gaps_to_json(gaps: pd.DataFrame) -> list[dict]:
    out = []
    for _, g in gaps.iterrows():
        out.append(
            {
                "date": str(g["date"]),
                "prev_close_ts": _iso(g["prev_close_ts"]),
                "prev_close": _num(g["prev_close"]),
                "open_ts": _iso(g["open_ts"]),
                "open_price": _num(g["open_price"]),
                "gap": _num(g["gap"]),
                "abs_gap": _num(g["abs_gap"]),
                "direction": g["direction"],
                "threshold": _num(g["threshold"]),
                "is_big": bool(g["is_big"]),
            }
        )
    return out


def _iso(v):
    return v.isoformat() if hasattr(v, "isoformat") else (None if pd.isna(v) else str(v))


def _num(v):
    return None if pd.isna(v) else float(v)

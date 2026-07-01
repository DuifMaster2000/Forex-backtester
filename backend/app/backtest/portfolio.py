"""Portfolio / multi-strategy combiner (mirror of frontend/src/engine/portfolio.ts).

Runs several independent "legs" — each a (dataset, session, strategy config) pair
— and merges their trades onto one shared clock to simulate real-world execution,
where signals from different instruments (or different sessions on the same
instrument) may fire at the same time. Each leg has a fixed position size; trades
are scaled to cash P/L and applied to a simulated starting capital. A global cap
limits how many trades can be open at once: when it is reached, a new signal is
skipped (missed) rather than queued.
"""
from __future__ import annotations

import pandas as pd
from pydantic import BaseModel, Field

from .engine import BacktestConfig, run_backtest
from .metrics import summarize


class PortfolioLegSpec(BaseModel):
    """One leg as configured by the client: a dataset + strategy config, with a
    fixed position size (units per trade) and an optional display label."""

    id: str = ""
    dataset_id: str
    label: str = ""
    position_size: float = Field(default=1.0, gt=0)
    config: BacktestConfig


class PortfolioRequest(BaseModel):
    starting_capital: float = Field(default=10000.0, gt=0)
    # Maximum simultaneously-open trades across the whole portfolio. <= 0 = unlimited.
    max_open_trades: int = 0
    legs: list[PortfolioLegSpec]


def run_portfolio(
    prepared_legs: list[dict],
    starting_capital: float,
    max_open_trades: int,
) -> dict:
    """Combine legs onto one clock. Each item of ``prepared_legs`` is a dict with
    keys: ``id, label, instrument, position_size, session (Session), config, df``
    (df being the leg's UTC-indexed frame)."""
    cap = max_open_trades if max_open_trades and max_open_trades > 0 else None

    # Run each leg independently and lift its trades into portfolio trades.
    candidates: list[dict] = []
    leg_meta: dict[str, dict] = {}
    for leg in prepared_legs:
        res = run_backtest(leg["df"], leg["session"], leg["config"])
        leg_meta[leg["id"]] = {
            "leg_id": leg["id"],
            "label": leg["label"],
            "instrument": leg["instrument"],
            "session": leg["config"].session,
            "candidates": len(res["trades"]),
            "taken": 0,
            "skipped": 0,
            "cash_pnl": 0.0,
        }
        for t in res["trades"]:
            candidates.append(
                {
                    **t,
                    "leg_id": leg["id"],
                    "leg_label": leg["label"],
                    "instrument": leg["instrument"],
                    "position_size": leg["position_size"],
                    "cash_pnl": round(t["pnl"] * leg["position_size"], 5),
                    "taken": False,
                }
            )

    # Deterministic order on the shared clock: entry, then exit, then stable ties.
    candidates.sort(key=lambda t: (t["entry_ms"], t["exit_ms"], t["leg_id"], t["signal_date"]))

    # Walk trades in entry order, tracking the exit times of currently-open taken
    # trades. A trade occupies a slot over [entry, exit); one that has already
    # exited by the new entry frees its slot. If a free slot exists (or the cap is
    # unlimited) take the trade, else skip it (the signal is missed).
    open_exits: list[int] = []
    peak_concurrent = 0
    for t in candidates:
        open_exits = [e for e in open_exits if e > t["entry_ms"]]
        if cap is None or len(open_exits) < cap:
            t["taken"] = True
            open_exits.append(t["exit_ms"])
            peak_concurrent = max(peak_concurrent, len(open_exits))
            m = leg_meta[t["leg_id"]]
            m["taken"] += 1
            m["cash_pnl"] = round(m["cash_pnl"] + t["cash_pnl"], 5)
        else:
            leg_meta[t["leg_id"]]["skipped"] += 1

    taken = [t for t in candidates if t["taken"]]
    # Portfolio metrics run on cash P/L, in close order, so the equity curve and
    # drawdown reflect the realised sequence across all instruments. R-multiples
    # are size-independent, so they carry through unchanged.
    cash_trades = sorted(taken, key=lambda t: (t["exit_ms"], t["entry_ms"], t["leg_id"], t["signal_date"]))
    cash_trades = [{**t, "pnl": t["cash_pnl"]} for t in cash_trades]
    metrics = summarize(cash_trades)

    ending_capital = round(starting_capital + metrics["total_pnl"], 5)
    return_pct = round(metrics["total_pnl"] / starting_capital * 100, 3) if starting_capital else 0.0
    equity_curve = [
        {"exit_ts": p["exit_ts"], "equity": round(starting_capital + p["equity"], 5)}
        for p in metrics["equity_curve"]
    ]

    return {
        "trades": candidates,
        "metrics": metrics,
        "starting_capital": starting_capital,
        "ending_capital": ending_capital,
        "return_pct": return_pct,
        "max_open_trades": max_open_trades if (max_open_trades and max_open_trades > 0) else 0,
        "peak_concurrent": peak_concurrent,
        "taken": len(taken),
        "skipped": len(candidates) - len(taken),
        "legs": [leg_meta[l["id"]] for l in prepared_legs],
        "equity_curve": equity_curve,
    }

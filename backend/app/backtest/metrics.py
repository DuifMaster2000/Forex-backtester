"""Aggregate performance metrics and equity curve from a trade list."""
from __future__ import annotations

import math


def _equity_linearity(equities: list[float]) -> tuple[float, float, float | None]:
    """Least-squares fit of the per-trade equity curve vs trade index.

    Returns ``(r2, slope, k_ratio)``:
    - ``r2`` in [0, 1] — how close the equity curve is to a straight line (1 = a
      perfect line, low = lumpy / "gains then chop").
    - ``slope`` — the per-trade trend (expected equity gain per trade).
    - ``k_ratio`` — the slope's t-statistic divided by sqrt(n) (Kestner-style): a
      sample-size-adjusted measure of how reliably the curve trends upward. None
      when there are too few trades to estimate it.

    The fit is against trade index (not calendar time) so that low / irregular
    trade frequency isn't itself penalised — only a flat run of *trades*.
    """
    n = len(equities)
    if n < 3:
        return 0.0, 0.0, None
    x_mean = (n - 1) / 2
    y_mean = sum(equities) / n
    sxx = sum((i - x_mean) ** 2 for i in range(n))
    sxy = sum((i - x_mean) * (y - y_mean) for i, y in enumerate(equities))
    syy = sum((y - y_mean) ** 2 for y in equities)
    if sxx == 0:
        return 0.0, 0.0, None
    slope = sxy / sxx
    ss_res = max(syy - slope * sxy, 0.0)  # Σ(y - ŷ)^2
    r2 = 0.0 if syy == 0 else max(0.0, min(1.0, 1 - ss_res / syy))
    if ss_res == 0:  # perfect line -> infinite t-stat; finite sentinel by sign
        k = 0.0 if slope == 0 else math.copysign(1e6, slope)
    else:
        se_slope = math.sqrt(ss_res / (n - 2) / sxx)
        k = (slope / se_slope) / math.sqrt(n)
    return round(r2, 5), round(slope, 8), round(k, 5)


def _side_stats(trades: list[dict]) -> dict:
    """Per-side performance (long vs short), to expose directional asymmetry."""
    n = len(trades)
    pnls = [t["pnl"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_win = sum(wins)
    gross_loss = -sum(losses)
    total = sum(pnls)
    r_values = [t["r_multiple"] for t in trades if t.get("r_multiple") is not None]
    total_r = round(sum(r_values), 3) if r_values else None
    return {
        "trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / n, 4) if n else 0.0,
        "total_pnl": round(total, 5),
        "avg_pnl": round(total / n, 5) if n else 0.0,
        "total_r": total_r,
        "avg_r": round(total_r / len(r_values), 3) if total_r is not None else None,
        "profit_factor": round(gross_win / gross_loss, 3) if gross_loss > 0 else None,
    }


def summarize(trades: list[dict]) -> dict:
    n = len(trades)
    by_side = {
        "long": _side_stats([t for t in trades if t["side"] == "long"]),
        "short": _side_stats([t for t in trades if t["side"] == "short"]),
    }
    if n == 0:
        return {
            "trades": 0, "wins": 0, "losses": 0, "win_rate": 0.0,
            "total_pnl": 0.0, "avg_pnl": 0.0, "expectancy": 0.0,
            "profit_factor": None, "max_drawdown": 0.0,
            "avg_win": 0.0, "avg_loss": 0.0,
            "total_r": None, "avg_r": None, "r2": 0.0, "equity_slope": 0.0,
            "k_ratio": None, "by_side": by_side, "equity_curve": [],
        }

    pnls = [t["pnl"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p < 0]
    gross_win = sum(wins)
    gross_loss = -sum(losses)

    # R-multiples (pnl / stop distance) for trades that defined a stop loss.
    r_values = [t["r_multiple"] for t in trades if t.get("r_multiple") is not None]
    total_r = round(sum(r_values), 3) if r_values else None
    avg_r = round(sum(r_values) / len(r_values), 3) if r_values else None

    equity = 0.0
    curve = []
    peak = 0.0
    max_dd = 0.0
    for t in trades:
        equity += t["pnl"]
        peak = max(peak, equity)
        max_dd = max(max_dd, peak - equity)
        curve.append({"exit_ts": t["exit_ts"], "equity": round(equity, 5)})

    total = sum(pnls)
    r2, slope, k_ratio = _equity_linearity([c["equity"] for c in curve])
    return {
        "trades": n,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / n, 4),
        "total_pnl": round(total, 5),
        "avg_pnl": round(total / n, 5),
        "expectancy": round(total / n, 5),
        "profit_factor": round(gross_win / gross_loss, 3) if gross_loss > 0 else None,
        "max_drawdown": round(max_dd, 5),
        "avg_win": round(sum(wins) / len(wins), 5) if wins else 0.0,
        "avg_loss": round(sum(losses) / len(losses), 5) if losses else 0.0,
        "total_r": total_r,
        "avg_r": avg_r,
        "r2": r2,
        "equity_slope": slope,
        "k_ratio": k_ratio,
        "by_side": by_side,
        "equity_curve": curve,
    }

"""Aggregate performance metrics and equity curve from a trade list."""
from __future__ import annotations


def summarize(trades: list[dict]) -> dict:
    n = len(trades)
    if n == 0:
        return {
            "trades": 0, "wins": 0, "losses": 0, "win_rate": 0.0,
            "total_pnl": 0.0, "avg_pnl": 0.0, "expectancy": 0.0,
            "profit_factor": None, "max_drawdown": 0.0,
            "avg_win": 0.0, "avg_loss": 0.0,
            "total_r": None, "avg_r": None, "equity_curve": [],
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
        "equity_curve": curve,
    }

"""Settled round results from Polymarket's own Data API (user decision 2026-10-01).

The venue's closed-positions and positions are the source of truth for what
a finished round made or lost; the ledger only covers the round still in
progress. This module reads them from the account reader's cached snapshot
(already fetched every refresh, so no extra request) and keys them by
(asset, roundId) via the market slug "<asset>-updown-5m-<roundId>".

- closed-positions: a redeemed or sold position; realizedPnl is final and
  includes fees.
- positions: a resolved position not yet redeemed (redeemable, price 0 or 1);
  the result is cashPnl (value - cost) plus realizedPnl (fees already paid).
  A losing token is never redeemed, so a loss lives here for good.

One round can have a token in each list (e.g. the ladder bought both sides).
"""
from __future__ import annotations

import re

SLUG = re.compile(r"^([a-z0-9]+)-updown-5m-(\d+)$")
EPS = 1e-9


def _number(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _round_of(item):
    match = SLUG.match(str(item.get("slug") or ""))
    return (match.group(1), match.group(2)) if match else None


def _resolved_open(item):
    """A still-held position whose market has resolved to 0 or 1."""
    price = _number(item.get("curPrice"))
    return item.get("redeemable") is True and price is not None and (price <= EPS or price >= 1 - EPS)


def round_results(snapshot) -> dict | None:
    """(asset, roundId) -> {"pnl", "cost", "tokens"} for every settled round.

    None when the venue data is not available, so callers can say so instead
    of showing zeros."""
    # A stale snapshot is old data (BUGS A2), and a section whose later pages
    # failed is a partial list: page 1 of closed positions is sorted by
    # realised PnL, so it showed all-time -3.56 as +131 (BUGS A1).
    if not isinstance(snapshot, dict) or snapshot.get("stale") is True:
        return None
    closed = snapshot.get("closed_positions") or {}
    held = snapshot.get("positions") or {}
    if any(section.get("available") is not True or section.get("complete") is False for section in (closed, held)):
        return None
    results: dict = {}
    seen = set()

    def add(item, pnl, cost):
        key = _round_of(item)
        token = item.get("asset")
        if key is None or pnl is None or (key, token) in seen:
            return
        seen.add((key, token))
        entry = results.setdefault(key, {"pnl": 0.0, "cost": 0.0, "tokens": 0})
        entry["pnl"] += pnl
        entry["cost"] += cost or 0.0
        entry["tokens"] += 1

    for item in closed.get("items") or []:
        bought, average = _number(item.get("totalBought")), _number(item.get("avgPrice"))
        add(item, _number(item.get("realizedPnl")), bought * average if bought is not None and average is not None else None)
    for item in held.get("items") or []:
        if not _resolved_open(item):
            continue
        cash, fees = _number(item.get("cashPnl")), _number(item.get("realizedPnl")) or 0.0
        add(item, None if cash is None else cash + fees, _number(item.get("initialValue")))
    for entry in results.values():
        entry["pnl"] = round(entry["pnl"], 6)
        entry["cost"] = round(entry["cost"], 6)
    return results


def summarize(results: dict, keys) -> dict:
    """Settled PnL and win/loss counts over the given (asset, roundId) keys."""
    pnl = [results[key]["pnl"] for key in keys if key in results]
    wins = sum(1 for value in pnl if value > EPS)
    losses = sum(1 for value in pnl if value < -EPS)
    return {"settled_pnl": round(sum(pnl), 6) if pnl else None, "settled_markets": len(pnl),
            "settled_wins": wins, "settled_losses": losses, "settled_draws": len(pnl) - wins - losses,
            "win_rate": wins / (wins + losses) if wins + losses else None}

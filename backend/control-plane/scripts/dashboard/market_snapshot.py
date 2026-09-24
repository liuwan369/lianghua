"""Validate the dashboard's read-only public CLOB market projection."""
from __future__ import annotations

import math
import time
from datetime import datetime


def number(value):
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


def canonical_snapshot(row: dict):
    """Return the lossless paired snapshot embedded by the public collector."""
    if not isinstance(row, dict):
        return None
    for key in ("snapshot", "paired_snapshot", "pairedSnapshot"):
        value = row.get(key)
        if isinstance(value, dict):
            return value
    if all(key in row for key in ("marketId", "roundId", "YES", "NO")):
        return row
    return None


def _canonical_side(value: dict) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("assetId"), str) or not value["assetId"]:
        return False
    bid, ask = number(value.get("bid")), number(value.get("ask"))
    if bid is None or ask is None or not 0 < bid <= ask < 1:
        return False
    for key in ("sourceAt", "expiresAt"):
        if value.get(key) is not None and number(value.get(key)) is None:
            return False
    return True


def canonical_snapshot_fresh(value: dict, now: float) -> bool:
    """Validate collector identity and freshness without making it executable."""
    if not isinstance(value, dict):
        return False
    market_id, round_id = value.get("marketId"), value.get("roundId")
    sequence = value.get("sequence")
    source_at, expires_at = number(value.get("sourceAt")), number(value.get("expiresAt"))
    return (isinstance(market_id, str) and bool(market_id)
            and isinstance(round_id, str) and bool(round_id)
            and type(sequence) is int and sequence >= 0
            and source_at is not None and source_at <= now + 1
            and expires_at is not None and expires_at > now
            and _canonical_side(value.get("YES")) and _canonical_side(value.get("NO")))


def validate_snapshot(value: dict, now: float | None = None) -> dict:
    """Reading a stale file must never give its contents a new market clock."""
    if not isinstance(value, dict):
        raise ValueError("snapshot must be an object")
    value = dict(value)
    now = time.time() if now is None else now
    try:
        age = now - datetime.fromisoformat(value["checked_at"]).timestamp()
        fresh = -5 <= age <= 15
    except (KeyError, TypeError, ValueError):
        fresh = False
    if not fresh:
        value.update(collector_online=False, current_markets=[], stale_reason="行情投影超过 15 秒未更新")
    elif value.get("source") == "polymarket-ws":
        # The file heartbeat is not a quote clock; recheck quotes on every read.
        limit = number(value.get("stale_after_ms"))
        rows = value.get("current_markets")
        try:
            canonical_rows = [canonical_snapshot(row) for row in rows or []
                              if isinstance(row, dict) and canonical_snapshot(row) is not None]
            if canonical_rows:
                quotes_fresh = (value.get("collector_connected") is True
                                and bool(rows) and all(canonical_snapshot_fresh(row, now) for row in canonical_rows))
                if not quotes_fresh or value.get("collector_online") is not True:
                    # Keep the last canonical object so the API can expose its
                    # sourceAt/expiresAt and mark it stale instead of clearing it.
                    value.update(collector_online=False)
                    value.setdefault("stale_reason", "CLOB canonical paired snapshot 过期或连接不可用")
                return value
            quotes_fresh = (limit is not None and 0 < limit <= 15_000
                            and value.get("collector_connected") is True
                            and isinstance(rows, list) and bool(rows)
                            and all(isinstance(row, dict)
                                    and all(isinstance(row.get(key), str) and row.get(key) for key in ("slug", "up_token", "down_token"))
                                    and row["up_token"] != row["down_token"]
                                    and all(type(row.get(key)) in (int, float) and math.isfinite(row[key]) for key in ("start", "end"))
                                    and row["start"] <= now < row["end"]
                                    and all(type(row.get(key)) in (int, float) and math.isfinite(row[key]) and 0 < row[key] < 1 for key in ("up_bid", "up_ask", "down_bid", "down_ask"))
                                    and row["up_bid"] <= row["up_ask"] <= 1
                                    and row["down_bid"] <= row["down_ask"] <= 1
                                    and isinstance(row.get("quote_at"), str) and row.get("quote_at")
                                    and -1_000 <= (now - datetime.fromisoformat(row["quote_at"]).timestamp()) * 1000 <= limit
                                    for row in rows))
        except (KeyError, TypeError, ValueError, OverflowError):
            quotes_fresh = False
        if not quotes_fresh or value.get("collector_online") is not True:
            value.update(collector_online=False, current_markets=[])
            value.setdefault("stale_reason", "CLOB 行情过期或场次已结束")
    return value

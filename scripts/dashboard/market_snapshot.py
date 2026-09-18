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

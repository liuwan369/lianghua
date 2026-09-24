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


def _valid_paired_snapshot(row: dict, now: float, stale_after_ms: float) -> bool:
    pair = row.get("paired_snapshot")
    if not isinstance(pair, dict):
        return False
    market_id, round_id = pair.get("marketId"), pair.get("roundId")
    sequence = pair.get("sequence")
    source_at, expires_at = number(pair.get("sourceAt")), number(pair.get("expiresAt"))
    start, end = number(row.get("start")), number(row.get("end"))
    yes, no = pair.get("YES"), pair.get("NO")
    if (row.get("healthy") is not True or not isinstance(market_id, str) or not market_id
            or market_id != row.get("condition_id") or not isinstance(round_id, str)
            or not round_id.isdigit() or round_id != str(int(round_id))
            or type(sequence) is not int or sequence < 0 or source_at is None or expires_at is None
            or start is None or end is None or start % 300 != 0 or end - start != 300
            or round_id != str(int(start)) or expires_at <= now or expires_at > end
            or (now - source_at) * 1000 < -1_000 or (now - source_at) * 1000 > stale_after_ms):
        return False
    if not isinstance(yes, dict) or not isinstance(no, dict):
        return False
    if yes.get("assetId") != row.get("up_token") or no.get("assetId") != row.get("down_token"):
        return False
    for side in (yes, no):
        bid, ask = number(side.get("bid")), number(side.get("ask"))
        side_at, side_expiry = number(side.get("sourceAt")), number(side.get("expiresAt"))
        side_sequence = side.get("sequence")
        if (bid is None or ask is None or not 0 < bid <= ask < 1
                or side_at is None or side_expiry is None or side_expiry <= now
                or (now - side_at) * 1000 < -1_000 or (now - side_at) * 1000 > stale_after_ms
                or side_sequence != sequence):
            return False
    return True


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
            modern_attempt = isinstance(rows, list) and any(
                isinstance(row, dict) and "paired_snapshot" in row for row in rows)
            common_fresh = (limit is not None and 0 < limit <= 15_000
                            and value.get("collector_connected") is True
                            and isinstance(rows, list) and bool(rows))
            if modern_attempt:
                quotes_fresh = common_fresh and all(
                    isinstance(row, dict) and _valid_paired_snapshot(row, now, limit)
                    for row in rows)
            else:
                quotes_fresh = common_fresh and all(
                    isinstance(row, dict)
                    and all(isinstance(row.get(key), str) and row.get(key) for key in ("slug", "up_token", "down_token"))
                    and row["up_token"] != row["down_token"]
                    and all(type(row.get(key)) in (int, float) and math.isfinite(row[key]) for key in ("start", "end"))
                    and row["start"] <= now < row["end"]
                    and all(type(row.get(key)) in (int, float) and math.isfinite(row[key]) and 0 < row[key] < 1 for key in ("up_bid", "up_ask", "down_bid", "down_ask"))
                    and row["up_bid"] <= row["up_ask"] <= 1
                    and row["down_bid"] <= row["down_ask"] <= 1
                    and isinstance(row.get("quote_at"), str) and row.get("quote_at")
                    and -1_000 <= (now - datetime.fromisoformat(row["quote_at"]).timestamp()) * 1000 <= limit
                    for row in rows)
        except (KeyError, TypeError, ValueError, OverflowError):
            quotes_fresh = False
        if not quotes_fresh or value.get("collector_online") is not True:
            value.update(collector_online=False, current_markets=[])
            value.setdefault("stale_reason", "CLOB 行情过期或场次已结束")
    return value

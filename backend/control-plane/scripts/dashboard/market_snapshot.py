"""Validate the dashboard's read-only public CLOB market projection."""
from __future__ import annotations

import math
import time
from datetime import datetime

DEFAULT_STALE_AFTER_MS = 2_000.0
MAX_STALE_AFTER_MS = 15_000.0


def number(value):
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else None
    except (TypeError, ValueError):
        return None


def normalize_stale_after_ms(value):
    """Normalize the quote-age limit; invalid explicit values fail closed."""
    if value is None:
        return DEFAULT_STALE_AFTER_MS
    if type(value) not in (int, float):
        return None
    parsed = number(value)
    if parsed is None or not 0 < parsed <= MAX_STALE_AFTER_MS:
        return None
    return parsed


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


def canonical_snapshot_fresh(value: dict, now: float, stale_after_ms: float | None = None) -> bool:
    """Validate collector identity and freshness without making it executable."""
    if not isinstance(value, dict):
        return False
    market_id, round_id = value.get("marketId"), value.get("roundId")
    sequence = value.get("sequence")
    source_at, expires_at = number(value.get("sourceAt")), number(value.get("expiresAt"))
    side_times = [number(side.get("sourceAt")) for side in (value.get("YES"), value.get("NO"))
                  if isinstance(side, dict) and side.get("sourceAt") is not None]
    side_expiry = [number(side.get("expiresAt")) for side in (value.get("YES"), value.get("NO"))
                   if isinstance(side, dict) and side.get("expiresAt") is not None]
    limit_ms = normalize_stale_after_ms(stale_after_ms)
    if limit_ms is None:
        return False
    age_limit = limit_ms / 1000
    return (isinstance(market_id, str) and bool(market_id)
            and isinstance(round_id, str) and bool(round_id)
            and type(sequence) is int and sequence >= 0
            and source_at is not None and source_at <= now + 1
            and source_at >= now - age_limit
            and all(value is not None and now - age_limit <= value <= now + 1
                    for value in side_times)
            and all(value is not None and value > now for value in side_expiry)
            and expires_at is not None and expires_at > now
            and _canonical_side(value.get("YES")) and _canonical_side(value.get("NO"))
            and value["YES"]["assetId"] != value["NO"]["assetId"])


def _legacy_row_fresh(row: dict, now: float, limit: float) -> bool:
    try:
        return (all(isinstance(row.get(key), str) and row.get(key) for key in ("slug", "up_token", "down_token"))
                and row["up_token"] != row["down_token"]
                and all(type(row.get(key)) in (int, float) and math.isfinite(row[key]) for key in ("start", "end"))
                and row["start"] <= now < row["end"]
                and all(type(row.get(key)) in (int, float) and math.isfinite(row[key]) and 0 < row[key] < 1
                        for key in ("up_bid", "up_ask", "down_bid", "down_ask"))
                and row["up_bid"] <= row["up_ask"]
                and row["down_bid"] <= row["down_ask"]
                and isinstance(row.get("quote_at"), str)
                and -1_000 <= (now - datetime.fromisoformat(row["quote_at"]).timestamp()) * 1000 <= limit)
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def _row_healthy(row: dict, parent: dict) -> bool:
    """An explicit per-market health signal is independent of other assets."""
    book = row.get("bookStatus", row.get("book_status"))
    book = book if isinstance(book, dict) else {}
    flags = [row.get(key) for key in ("healthy", "quote_fresh", "quoteFresh", "collector_online", "collector_connected")]
    flags.extend(book.get(key) for key in ("healthy", "connected"))
    if any(flag is False for flag in flags) or row.get("stale") is True:
        return False
    if row.get("stale_book") is True or row.get("transport_disconnected") is True:
        return False
    if any(source.get(key) in ("stale_book", "transport_disconnected")
           for source in (row, book) for key in ("status", "reason", "stale_reason")):
        return False
    if row.get("healthy") is True or row.get("collector_online") is True or book.get("healthy") is True:
        return True
    return parent.get("collector_online") is True and parent.get("collector_connected") is True


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
    if fresh and value.get("source") != "polymarket-ws":
        return value
    # The file heartbeat is not a quote clock. Validate every market without
    # letting one asset's disconnection erase another asset's accepted pair.
    limit = normalize_stale_after_ms(value.get("stale_after_ms"))
    rows = value.get("current_markets")
    rows = rows if isinstance(rows, list) else []
    validated = []
    healthy_count = 0
    for original in rows:
        if not isinstance(original, dict):
            continue
        row = dict(original)
        snapshot = canonical_snapshot(row)
        row_limit = normalize_stale_after_ms(row.get("stale_after_ms", value.get("stale_after_ms")))
        valid = fresh and limit is not None and row_limit is not None and _row_healthy(row, value)
        if valid:
            if snapshot is not None:
                valid = canonical_snapshot_fresh(snapshot, now, row_limit)
                for field, alias in (("assetId", "asset_id"), ("marketId", "market_id"), ("roundId", "round_id")):
                    outer = row.get(field) or row.get(alias)
                    inner = snapshot.get(field) or snapshot.get(alias)
                    if outer is not None and inner is not None and outer != inner:
                        valid = False
            else:
                valid = _legacy_row_fresh(row, now, row_limit)
        # Never mutate the canonical object, its prices, source clock or identity.
        row.update(collector_online=valid, healthy=valid, quote_fresh=valid, stale=not valid,
                   strategyEligible=False)
        if not valid:
            row["stale_reason"] = ("行情投影超过 15 秒未更新" if not fresh else
                                   row.get("stale_reason") or "CLOB 行情过期、身份不一致或连接不可用")
        healthy_count += int(valid)
        validated.append(row)
    all_healthy = bool(rows) and healthy_count == len(rows)
    value.update(current_markets=validated, collector_online=bool(healthy_count),
                 strategyEligible=False, stale=not all_healthy,
                 partial=bool(healthy_count) and not all_healthy)
    if not all_healthy:
        value["stale_reason"] = ("行情投影超过 15 秒未更新" if not fresh else
                                 value.get("stale_reason") or "部分 CLOB 行情过期或连接不可用")
    else:
        value.pop("stale_reason", None)
    return value

from __future__ import annotations

import argparse
import bisect
import ctypes
import gc
import heapq
import json
import math
import re
import sqlite3
import time
import zlib
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


DAILY_DB_RE = re.compile(r"^(.*?)(\d{4}-\d{2}-\d{2})(\.sqlite3)$")
SAFETY_LAGS_MS = (0, 50, 100, 250)
HEALTH_FRESHNESS_SECONDS = 120
MAX_HEALTH_GAP_SECONDS = 150


def quantile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.floor((len(ordered) - 1) * fraction))]


def stats(values: list[float]) -> dict[str, float | None]:
    return {
        "count": len(values),
        "median": None if not values else round(quantile(values, .5), 6),
        "p95": None if not values else round(quantile(values, .95), 6),
    }


def iter_chunks_connection(
    connection: sqlite3.Connection,
    source: str,
    since_second: int,
    until_second: int,
    sort_index: int = 1,
):
    rows = connection.execute(
        """SELECT codec,payload_blob FROM event_chunks
           WHERE source=? AND received_second>=? AND received_second<=? ORDER BY received_second""",
        (source, since_second, until_second),
    )
    for index, (codec, blob) in enumerate(rows, start=1):
        if codec != "zlib-json-v2":
            continue
        chunk = json.loads(zlib.decompress(blob).decode("utf-8"))
        yield from sorted(chunk, key=lambda row: row[sort_index] if row[sort_index] is not None else row[1])
        del chunk
        if index % 60 == 0:
            gc.collect()
            try:
                ctypes.CDLL("libc.so.6").malloc_trim(0)
            except (OSError, AttributeError):
                pass


def iter_chunks_connections(
    connections: list[sqlite3.Connection],
    source: str,
    since_second: int,
    until_second: int,
    sort_index: int = 1,
):
    streams = [
        iter_chunks_connection(connection, source, since_second, until_second, sort_index)
        for connection in connections
    ]
    key = lambda row: row[sort_index] if row[sort_index] is not None else row[1]
    yield from heapq.merge(*streams, key=key)


def discover_database_paths(path: Path, since_ns: int, until_ns: int) -> tuple[list[Path], list[str]]:
    resolved = path.resolve(strict=False)
    daily_dir = resolved.parent if resolved.parent.name == "days" else path.parent / "days"
    match = DAILY_DB_RE.match(resolved.name)
    if not daily_dir.exists() or match is None:
        return ([resolved] if resolved.exists() else []), ([] if resolved.exists() else [str(resolved)])

    prefix, _date, suffix = match.groups()
    start = datetime.fromtimestamp(since_ns / 1_000_000_000, timezone.utc).date()
    end = datetime.fromtimestamp(until_ns / 1_000_000_000, timezone.utc).date()
    expected: list[Path] = []
    current = start
    while current <= end:
        expected.append(daily_dir / f"{prefix}{current.isoformat()}{suffix}")
        current += timedelta(days=1)
    existing = [candidate.resolve() for candidate in expected if candidate.exists()]
    missing = [str(candidate) for candidate in expected if not candidate.exists()]
    return list(dict.fromkeys(existing)), missing


def chunk_event_count(connection: sqlite3.Connection, source: str, since_second: int, until_second: int) -> int:
    row = connection.execute(
        """SELECT COALESCE(SUM(event_count),0) FROM event_chunks
           WHERE source=? AND received_second>=? AND received_second<=?""",
        (source, since_second, until_second),
    ).fetchone()
    return int(row[0])


def chunk_event_count_all(connections: list[sqlite3.Connection], source: str, since_second: int, until_second: int) -> int:
    return sum(chunk_event_count(connection, source, since_second, until_second) for connection in connections)


def chunk_bounds(connection: sqlite3.Connection, source: str, since_second: int, until_second: int) -> tuple[int | None, int | None]:
    row = connection.execute(
        """SELECT MIN(received_second),MAX(received_second) FROM event_chunks
           WHERE source=? AND received_second>=? AND received_second<=?""",
        (source, since_second, until_second),
    ).fetchone()
    return (None, None) if row[0] is None else (int(row[0]), int(row[1]))


def chunk_bounds_all(
    connections: list[sqlite3.Connection], source: str, since_second: int, until_second: int,
) -> tuple[int | None, int | None]:
    bounds = [chunk_bounds(connection, source, since_second, until_second) for connection in connections]
    starts = [start for start, _end in bounds if start is not None]
    ends = [end for _start, end in bounds if end is not None]
    return (min(starts), max(ends)) if starts and ends else (None, None)


def load_events(connection: sqlite3.Connection, source: str, since_ns: int, until_ns: int) -> list[dict[str, Any]]:
    rows = connection.execute(
        """SELECT event_type,event_key,received_at_ns,source_time_ms,slug,token_id,payload_json
           FROM events WHERE source=? AND received_at_ns>=? AND received_at_ns<=? ORDER BY received_at_ns""",
        (source, since_ns, until_ns),
    )
    return [{
        "event_type": row[0], "event_key": row[1], "received_ns": row[2], "source_ms": row[3],
        "slug": row[4], "token": row[5], "payload": json.loads(row[6]),
    } for row in rows]


def load_events_all(
    connections: list[sqlite3.Connection], source: str, since_ns: int, until_ns: int,
) -> list[dict[str, Any]]:
    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    for connection in connections:
        for row in load_events(connection, source, since_ns, until_ns):
            if row["event_key"] in seen:
                continue
            seen.add(row["event_key"])
            output.append(row)
    return sorted(output, key=lambda row: row["received_ns"])


def load_health_all(
    connections: list[sqlite3.Connection], since_ns: int, until_ns: int,
) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for connection in connections:
        for row in connection.execute(
            "SELECT recorded_at,queue_depth,counters_json,source_status_json FROM health ORDER BY id"
        ):
            recorded_ns = int(datetime.fromisoformat(row[0]).timestamp() * 1_000_000_000)
            if since_ns <= recorded_ns <= until_ns:
                output.append({
                    "recorded_at": row[0], "recorded_ns": recorded_ns, "queue_depth": row[1],
                    "counters": json.loads(row[2]), "sources": json.loads(row[3]),
                })
    return sorted(output, key=lambda row: row["recorded_ns"])


def best_level(levels: dict[float, float], side: str) -> tuple[float | None, float | None]:
    if not levels:
        return None, None
    price = max(levels) if side == "bid" else min(levels)
    return price, levels[price]


def reconstruct_target_fills(clob_rows, target_transactions: set[str]) -> dict[tuple[str, str], list[dict[str, Any]]]:
    books: dict[str, dict[str, dict[float, float]]] = defaultdict(lambda: {"bids": {}, "asks": {}})
    level_changed_ms: dict[tuple[str, str, float], int] = {}
    matches: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    # v2 row: event_type, received_ns, source_ms, slug-or-null, token, compact_payload
    for event_type, received_ns, source_ms, _slug, token, payload in clob_rows:
        if event_type == "book" and token:
            event_ms, bids, asks, _tick = payload
            new_bids = {float(price): float(size) for price, size in bids if float(size) > 0}
            new_asks = {float(price): float(size) for price, size in asks if float(size) > 0}
            old_bids, old_asks = books[token]["bids"], books[token]["asks"]
            if old_bids or old_asks:
                for price in set(old_bids) | set(new_bids):
                    if old_bids.get(price) != new_bids.get(price):
                        level_changed_ms[(token, "BUY", price)] = int(event_ms)
                for price in set(old_asks) | set(new_asks):
                    if old_asks.get(price) != new_asks.get(price):
                        level_changed_ms[(token, "SELL", price)] = int(event_ms)
            books[token]["bids"] = new_bids
            books[token]["asks"] = new_asks
        elif event_type == "price_change":
            event_ms, changes = payload
            for changed_token, price_raw, size_raw, side, _best_bid, _best_ask in changes:
                price, size = float(price_raw), float(size_raw)
                levels = books[str(changed_token)]["bids" if str(side).upper() == "BUY" else "asks"]
                if size <= 0:
                    levels.pop(price, None)
                else:
                    levels[price] = size
                level_changed_ms[(str(changed_token), str(side).upper(), price)] = int(event_ms)
        elif event_type == "last_trade_price" and token:
            event_ms, price_raw, size_raw, side, fee_bps, transaction_hash = payload
            tx = str(transaction_hash or "").lower()
            if tx not in target_transactions:
                continue
            price = float(price_raw)
            bid, bid_size = best_level(books[token]["bids"], "bid")
            ask, ask_size = best_level(books[token]["asks"], "ask")
            bid_level_size = books[token]["bids"].get(price)
            ask_level_size = books[token]["asks"].get(price)
            bid_last_change = level_changed_ms.get((token, "BUY", price))
            ask_last_change = level_changed_ms.get((token, "SELL", price))
            matches[(tx, token)].append({
                "transaction_hash": tx,
                "token": token,
                "clob_source_ms": int(event_ms),
                "clob_received_ns": int(received_ns),
                "fill_price": price,
                "fill_size": float(size_raw),
                "aggressor_side_from_trade_message": str(side).upper(),
                "fee_rate_bps_message": fee_bps,
                "best_bid_at_trade_message": bid,
                "best_bid_size_at_trade_message": bid_size,
                "best_ask_at_trade_message": ask,
                "best_ask_size_at_trade_message": ask_size,
                "bid_level_remaining_at_fill_price": bid_level_size,
                "ask_level_remaining_at_fill_price": ask_level_size,
                "bid_level_last_observed_change_ms": bid_last_change,
                "ask_level_last_observed_change_ms": ask_last_change,
                "bid_level_observed_age_ms": None if bid_last_change is None else max(0, int(event_ms) - bid_last_change),
                "ask_level_observed_age_ms": None if ask_last_change is None else max(0, int(event_ms) - ask_last_change),
                "bid_level_age_left_censored": bid_last_change is None and bid_level_size is not None,
                "ask_level_age_left_censored": ask_last_change is None and ask_level_size is not None,
            })
    return matches


def assign_clob_matches(trades: list[dict[str, Any]], matches: dict[tuple[str, str], list[dict[str, Any]]]) -> tuple[list[dict[str, Any] | None], int]:
    assignments: list[dict[str, Any] | None] = [None] * len(trades)
    by_key: dict[tuple[str, str], list[int]] = defaultdict(list)
    for index, row in enumerate(trades):
        payload = row["payload"]
        by_key[(
            str(payload.get("transactionHash") or "").lower(),
            str(payload.get("asset") or ""),
        )].append(index)
    ambiguous = 0
    for key, trade_indices in by_key.items():
        candidates = matches.get(key) or []
        scored: list[tuple[tuple[float, float, float], int, int]] = []
        scores_by_trade: dict[int, list[tuple[float, float, float]]] = defaultdict(list)
        for trade_index in trade_indices:
            payload = trades[trade_index]["payload"]
            expected_price = float(payload.get("price") or 0)
            expected_size = float(payload.get("size") or 0)
            expected_ms = int(float(payload.get("timestamp") or 0) * 1000)
            for candidate_index, candidate in enumerate(candidates):
                score = (
                    abs(candidate["fill_price"] - expected_price),
                    abs(candidate["fill_size"] - expected_size),
                    abs(candidate["clob_source_ms"] - expected_ms),
                )
                scored.append((score, trade_index, candidate_index))
                scores_by_trade[trade_index].append(score)
        for values in scores_by_trade.values():
            ordered = sorted(values)
            if len(ordered) > 1 and ordered[0] == ordered[1]:
                ambiguous += 1
        used_trades: set[int] = set()
        used_candidates: set[int] = set()
        for _score, trade_index, candidate_index in sorted(scored):
            if trade_index in used_trades or candidate_index in used_candidates:
                continue
            assignments[trade_index] = candidates[candidate_index]
            used_trades.add(trade_index)
            used_candidates.add(candidate_index)
    return assignments, ambiguous


def resolve_binance_queries(rows, query_times: set[int]) -> dict[int, float]:
    ordered_queries = sorted(query_times)
    output: dict[int, float] = {}
    query_index = 0
    previous_price: float | None = None
    previous_time: int | None = None
    for event_type, _received_ns, source_ms, _slug, _token, payload in rows:
        if event_type != "agg_trade":
            continue
        _agg_id, price_raw, _quantity, _first, _last, trade_ms, _maker = payload
        timestamp = int(trade_ms or source_ms)
        price = float(price_raw)
        while query_index < len(ordered_queries) and ordered_queries[query_index] < timestamp:
            if previous_price is not None and previous_time is not None and previous_time <= ordered_queries[query_index]:
                output[ordered_queries[query_index]] = previous_price
            query_index += 1
        previous_price = price
        previous_time = timestamp
    while query_index < len(ordered_queries):
        if previous_price is not None and previous_time is not None and previous_time <= ordered_queries[query_index]:
            output[ordered_queries[query_index]] = previous_price
        query_index += 1
    return output


def prior_price(times: list[int], prices: list[float], timestamp_ms: int) -> float | None:
    index = bisect.bisect_right(times, timestamp_ms) - 1
    return None if index < 0 else prices[index]


def signed_momentum(times: list[int], prices: list[float], timestamp_ms: int, horizon_ms: int, direction: int) -> float | None:
    current = prior_price(times, prices, timestamp_ms)
    past = prior_price(times, prices, timestamp_ms - horizon_ms)
    if current is None or past is None or past == 0:
        return None
    return direction * (current / past - 1) * 10_000


def signed_momentum_from_queries(prices: dict[int, float], timestamp_ms: int, horizon_ms: int, direction: int) -> float | None:
    current = prices.get(timestamp_ms)
    past = prices.get(timestamp_ms - horizon_ms)
    if current is None or past is None or past == 0:
        return None
    return direction * (current / past - 1) * 10_000


def resolve_binance_received_queries(rows, query_times_ns: set[int]) -> dict[int, float]:
    ordered_queries = sorted(query_times_ns)
    output: dict[int, float] = {}
    query_index = 0
    previous_price: float | None = None
    previous_received_ns: int | None = None
    for event_type, received_ns, _source_ms, _slug, _token, payload in rows:
        if event_type != "agg_trade":
            continue
        price = float(payload[1])
        received_ns = int(received_ns)
        while query_index < len(ordered_queries) and ordered_queries[query_index] < received_ns:
            if previous_price is not None and previous_received_ns is not None:
                output[ordered_queries[query_index]] = previous_price
            query_index += 1
        previous_price = price
        previous_received_ns = received_ns
    while query_index < len(ordered_queries):
        if previous_price is not None and previous_received_ns is not None:
            output[ordered_queries[query_index]] = previous_price
        query_index += 1
    return output


def is_collector_gap_event(row: dict[str, Any]) -> bool:
    return row["event_type"] in {"feed_reconnect", "sequence_gap"} or "gap_ms" in row["payload"]


def collector_gap_windows(events: list[dict[str, Any]], feed: str) -> list[tuple[int, int]]:
    windows: list[tuple[int, int]] = []
    for row in events:
        payload = row["payload"]
        if not is_collector_gap_event(row) or payload.get("feed") != feed:
            continue
        gap_ns = int(float(payload.get("gap_ms") or 0) * 1_000_000)
        windows.append((row["received_ns"] - gap_ns, row["received_ns"]))
    return windows


def polygon_target_token(payload: dict[str, Any]) -> str:
    # A short-lived decoder version mislabeled orderSide/tokenId as asset ids.
    if payload.get("makerAssetId") is not None and payload.get("takerAssetId") is not None:
        return str(payload["takerAssetId"])
    return str(payload.get("tokenId") or "")


def polygon_target_side(payload: dict[str, Any]) -> str:
    if payload.get("makerAssetId") is not None:
        order_side = int(payload["makerAssetId"])
    elif payload.get("orderSide") is not None:
        order_side = int(payload["orderSide"])
    else:
        order_side = int(payload.get("side") or 0)
    if payload.get("targetSide") and payload.get("makerAssetId") is None:
        return str(payload["targetSide"]).upper()
    return "BUY" if (payload.get("role") == "maker") == (order_side == 0) else "SELL"


def coverage_diagnostics(
    health_rows: list[dict[str, Any]], collector_events: list[dict[str, Any]],
    missing_databases: list[str], source_bounds: dict[str, tuple[int | None, int | None]],
    since_ns: int, until_ns: int,
) -> list[str]:
    reasons: list[str] = []
    reasons.extend(f"missing_daily_database:{path}" for path in missing_databases)
    tolerance_ns = HEALTH_FRESHNESS_SECONDS * 1_000_000_000
    for source, (first_second, last_second) in source_bounds.items():
        if first_second is None or last_second is None:
            reasons.append(f"{source}_has_no_chunk_data")
            continue
        if first_second * 1_000_000_000 > since_ns + tolerance_ns:
            reasons.append(f"{source}_starts_after_requested_window")
        if last_second * 1_000_000_000 < until_ns - tolerance_ns:
            reasons.append(f"{source}_is_stale")

    if not health_rows:
        reasons.append("health_has_no_records")
    else:
        if health_rows[0]["recorded_ns"] > since_ns + tolerance_ns:
            reasons.append("health_starts_after_requested_window")
        if health_rows[-1]["recorded_ns"] < until_ns - tolerance_ns:
            reasons.append("latest_health_is_stale")
        gaps = [
            (right["recorded_ns"] - left["recorded_ns"]) / 1_000_000_000
            for left, right in zip(health_rows, health_rows[1:])
        ]
        if gaps and max(gaps) > MAX_HEALTH_GAP_SECONDS:
            reasons.append(f"health_gap_seconds:{max(gaps):.3f}")
        if any(row["queue_depth"] >= 1000 for row in health_rows):
            reasons.append("sqlite_queue_depth_reached_1000")
        for row in health_rows:
            sources = row["sources"]
            for source in ("activity", "binance", "clob", "polygon"):
                if sources.get(source, {}).get("state") not in {"ok", "connected"}:
                    reasons.append(f"{source}_unhealthy_at:{row['recorded_at']}")
                    break
            if sources.get("activity", {}).get("pagination_complete") is not True:
                reasons.append(f"activity_pagination_incomplete_at:{row['recorded_at']}")
            if int(sources.get("binance", {}).get("sequence_gaps") or 0) > 0:
                reasons.append(f"binance_sequence_gap_at:{row['recorded_at']}")

        previous = health_rows[0]["counters"]
        for row in health_rows[1:]:
            current = row["counters"]
            for name in set(previous) | set(current):
                if not (name.startswith("error_") or name.startswith("gap_")):
                    continue
                before, after = int(previous.get(name, 0)), int(current.get(name, 0))
                delta = after - before if after >= before else after
                if delta > 0:
                    reasons.append(f"counter_increment:{name}:{delta}")
            previous = current
    for row in collector_events:
        if not is_collector_gap_event(row):
            continue
        payload = row["payload"]
        reasons.append(
            f"collector_gap:{payload.get('feed', 'unknown')}:{payload.get('reason', row['event_type'])}:"
            f"{payload.get('gap_ms', 'unknown')}ms"
        )
    return list(dict.fromkeys(reasons))


def analyze(path: Path, hours: float) -> dict[str, Any]:
    now_ns = time.time_ns()
    since_ns = now_ns - int(hours * 3600 * 1_000_000_000)
    since_second = since_ns // 1_000_000_000
    until_second = now_ns // 1_000_000_000
    database_paths, missing_databases = discover_database_paths(path, since_ns, now_ns)
    if not database_paths:
        raise FileNotFoundError(f"no evidence databases found for {path}")
    connections = [sqlite3.connect(database_path) for database_path in database_paths]
    try:
        for connection in connections:
            connection.execute("BEGIN")
        activities = load_events_all(connections, "activity", since_ns, now_ns)
        polygons = load_events_all(connections, "polygon", since_ns, now_ns)
        collector_events = load_events_all(connections, "collector", since_ns, now_ns)
        health_rows = load_health_all(connections, since_ns, now_ns)
        clob_count = chunk_event_count_all(connections, "clob", since_second, until_second)
        binance_count = chunk_event_count_all(connections, "binance", since_second, until_second)
        clob_bounds = chunk_bounds_all(connections, "clob", since_second, until_second)
        binance_bounds = chunk_bounds_all(connections, "binance", since_second, until_second)

        candidate_trades = [
            row for row in activities
            if row["event_type"] == "trade"
            and str(row["payload"].get("side") or "").upper() == "BUY"
            and str(row["payload"].get("slug") or "").startswith("btc-updown-5m-")
        ]
        clob_first_second, clob_last_second = clob_bounds
        trades = [
            row for row in candidate_trades
            if clob_first_second is not None and clob_last_second is not None
            and int(float(row["payload"].get("timestamp") or 0)) >= clob_first_second
            and int(float(row["payload"].get("timestamp") or 0)) <= clob_last_second
        ]
        txs = {str(row["payload"].get("transactionHash") or "").lower() for row in trades}
        txs.discard("")
        clob_matches = reconstruct_target_fills(
            iter_chunks_connections(connections, "clob", since_second, until_second), txs,
        )
        assigned_matches, ambiguous_clob = assign_clob_matches(trades, clob_matches)
        query_times_ns: set[int] = set()
        for match in assigned_matches:
            if not match:
                continue
            for lag_ms in SAFETY_LAGS_MS:
                safe_ns = match["clob_received_ns"] - lag_ms * 1_000_000
                query_times_ns.add(safe_ns)
                query_times_ns.update(safe_ns - seconds * 1_000_000_000 for seconds in (1, 3, 5, 15))
        binance_received_prices = resolve_binance_received_queries(
            iter_chunks_connections(connections, "binance", since_second, until_second, sort_index=1),
            query_times_ns,
        )
    finally:
        for connection in connections:
            connection.rollback()
            connection.close()

    polygon_keys: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in polygons:
        key = (
            str(row["payload"].get("transactionHash") or "").lower(),
            polygon_target_token(row["payload"]),
        )
        polygon_keys[key].append(row["payload"])
    details: list[dict[str, Any]] = []
    activity_delays: list[float] = []
    clob_delays: list[float] = []
    price_vs_bid: list[float] = []
    level_ages: list[float] = []
    role_counts: dict[str, int] = defaultdict(int)
    clob_gaps = collector_gap_windows(collector_events, "clob")
    momentum: dict[str, dict[str, dict[str, list[float]]]] = {
        f"{lag_ms}ms": {
            group: {label: [] for label in ("1s", "3s", "5s", "15s")}
            for group in ("all", "maker", "taker", "mixed", "pending_confirmation", "unknown")
        }
        for lag_ms in SAFETY_LAGS_MS
    }
    for row, match in zip(trades, assigned_matches):
        payload = row["payload"]
        tx = str(payload.get("transactionHash") or "").lower()
        token = str(payload.get("asset") or "")
        key = (tx, token)
        source_ms = int(float(payload.get("timestamp") or 0) * 1000)
        activity_delay = row["received_ns"] / 1_000_000 - source_ms
        activity_delays.append(activity_delay)
        outcome = str(payload.get("outcome") or "").lower()
        direction = 1 if outcome == "up" else -1
        chain_candidates = sorted(polygon_keys.get(key) or [], key=lambda item: item.get("logIndex", 0))
        chain = chain_candidates[0] if chain_candidates else None
        roles = {str(item.get("role") or "unknown") for item in chain_candidates}
        pending_polygon = not roles and now_ns / 1_000_000 - source_ms < HEALTH_FRESHNESS_SECONDS * 1000
        if roles == {"maker"}:
            role = "maker"
        elif roles == {"taker"}:
            role = "taker"
        elif roles:
            role = "mixed"
        else:
            role = "pending_confirmation" if pending_polygon else "unknown"
        role_counts[role] += 1
        in_clob_gap = bool(match) and any(start <= match["clob_received_ns"] <= end for start, end in clob_gaps)
        signed_by_lag: dict[str, dict[str, float | None]] = {}
        if match:
            clob_delays.append(match["clob_received_ns"] / 1_000_000 - match["clob_source_ms"])
            for lag_ms in SAFETY_LAGS_MS:
                lag_label = f"{lag_ms}ms"
                safe_ns = match["clob_received_ns"] - lag_ms * 1_000_000
                signed = {
                    label: signed_momentum_from_queries(
                        binance_received_prices, safe_ns, seconds * 1_000_000_000, direction,
                    )
                    for label, seconds in (("1s", 1), ("3s", 3), ("5s", 5), ("15s", 15))
                }
                signed_by_lag[lag_label] = signed
                for label, value in signed.items():
                    if value is not None:
                        momentum[lag_label]["all"][label].append(value)
                        momentum[lag_label][role][label].append(value)
        if match and role == "maker" and not in_clob_gap:
            if match["best_bid_at_trade_message"] is not None:
                price_vs_bid.append(match["fill_price"] - match["best_bid_at_trade_message"])
            if match["bid_level_observed_age_ms"] is not None:
                level_ages.append(match["bid_level_observed_age_ms"])
        details.append({
            "slug": payload.get("slug"), "transaction_hash": tx, "token": token,
            "activity_timestamp_ms": source_ms, "activity_observed_delay_ms": round(activity_delay, 3),
            "outcome": payload.get("outcome"), "price": payload.get("price"), "shares": payload.get("size"),
            "clob_match": match, "polygon_match": chain,
            "polygon_role_status": role, "polygon_matching_log_count": len(chain_candidates),
            "clob_gap_overlap": in_clob_gap,
            "binance_received_clock_signed_momentum_bps": signed_by_lag,
        })

    matched_clob = sum(item["clob_match"] is not None for item in details)
    matched_polygon = sum(item["polygon_role_status"] in {"maker", "taker", "mixed"} for item in details)
    at_bid = sum(abs(value) < 1e-9 for value in price_vs_bid)
    latest_health = health_rows[-1] if health_rows else None
    source_bounds = {"clob": clob_bounds, "binance": binance_bounds}
    collector_gap_events = [row for row in collector_events if is_collector_gap_event(row)]
    incomplete_reasons = coverage_diagnostics(
        health_rows, collector_events, missing_databases, source_bounds, since_ns, now_ns,
    )
    coverage_gate = not incomplete_reasons
    strategy_sample_reasons: list[str] = []
    if matched_clob < 100:
        strategy_sample_reasons.append(f"clob_hash_matches_below_100:{matched_clob}")
    if matched_polygon < 100:
        strategy_sample_reasons.append(f"polygon_role_matches_below_100:{matched_polygon}")
    if role_counts.get("maker", 0) < 100:
        strategy_sample_reasons.append(f"maker_samples_below_100:{role_counts.get('maker', 0)}")
    strategy_evidence_sufficient = coverage_gate and not strategy_sample_reasons
    return {
        "run_type": "pm_r25_live_evidence_analysis",
        "trade_authorization": False,
        "window_hours": hours,
        "database_paths": [str(database_path) for database_path in database_paths],
        "source_counts": {
            "activity_events": len(activities),
            "target_btc_buy_fills_in_requested_window": len(candidate_trades),
            "target_btc_buy_fills_inside_clob_coverage": len(trades),
            "target_btc_buy_fills_excluded_outside_clob_coverage": len(candidate_trades) - len(trades),
            "clob_chunk_events": clob_count, "binance_chunk_events": binance_count, "polygon_events": len(polygons),
        },
        "matching": {
            "clob_transaction_hash_matches": matched_clob,
            "clob_match_pct": None if not trades else round(100 * matched_clob / len(trades), 4),
            "ambiguous_clob_candidate_records": ambiguous_clob,
            "polygon_transaction_token_matches": matched_polygon,
            "polygon_match_pct": None if not trades else round(100 * matched_polygon / len(trades), 4),
            "polygon_role_counts": dict(sorted(role_counts.items())),
        },
        "completeness": {
            "requested_start_received_at_ns": since_ns,
            "analysis_snapshot_received_at_ns": now_ns,
            "source_chunk_bounds_seconds": source_bounds,
            "health_records": len(health_rows),
            "collector_gap_events": len(collector_gap_events),
            "collector_gap_details": [row["payload"] for row in collector_gap_events],
            "operational_coverage_gate_passed": coverage_gate,
            "incomplete_reasons": incomplete_reasons,
            "strategy_sample_reasons": strategy_sample_reasons,
            "strategy_evidence_sufficient": strategy_evidence_sufficient,
            "latest_health": latest_health,
            "clob_trade_hash_linkage_pct": None if not trades else round(100 * matched_clob / len(trades), 4),
            "status": "observed_interval_no_recorded_outages" if coverage_gate else "incomplete_operational_coverage",
            "note": "CLOB公开market流没有连续序列号，无法声称逐消息100%完整；交易哈希未匹配部分不得用于挂单参数结论。重连会重新获取book，但断线区间无法官方回补。",
        },
        "latency_ms": {
            "activity_publication": stats(activity_delays),
            "clob_websocket_transport": stats(clob_delays),
        },
        "maker_price_evidence": {
            "eligibility": "only Polygon-confirmed maker-only transaction/token fills outside recorded CLOB gaps; mixed maker+taker records are excluded",
            "matched_fills_with_bid_context": len(price_vs_bid),
            "fill_equal_best_bid_pct_at_trade_message": None if not price_vs_bid else round(100 * at_bid / len(price_vs_bid), 4),
            "fill_minus_best_bid": stats(price_vs_bid),
            "target_buy_bid_level_observed_age_ms": stats(level_ages),
            "caution": "目标Activity为BUY，因此只用bid层作为挂单证据。初次快照已存在的价位年龄为左截断未知；同一成交引起的盘口变更也可能先于成交消息，所以排队量仍是代理值。",
            "conclusion_status": "usable_for_parameter_fit" if strategy_evidence_sufficient else "raw_observation_only",
        },
        "binance_received_clock_signed_momentum_bps": {
            lag_label: {
                group: {
                    label: {
                        **stats(values),
                        "positive_pct": None if not values else round(100 * sum(value > 0 for value in values) / len(values), 4),
                    }
                    for label, values in horizons.items()
                }
                for group, horizons in groups.items()
            }
            for lag_label, groups in momentum.items()
        },
        "binance_timing_interpretation": {
            "taker": "成交时刻可近似主动执行时刻，但仍不是下单发送时刻。",
            "maker": "成交由对手方触发，只能说明成交状态与BTC走势相关，不能当作目标地址的决策时刻。",
            "mixed": "同一交易和Token同时出现maker/taker链上角色，不用于推断单一执行方式。",
            "clock": "主口径只使用东京服务器先收到的Binance消息，并分别保留0/50/100/250毫秒安全滞后。",
        },
        "strategy_conclusion_status": "usable_for_parameter_fit" if strategy_evidence_sufficient else "raw_observation_only",
        "details": details,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze Tokyo CLOB, Binance, Activity and Polygon evidence")
    parser.add_argument("--db", default="data/pm-r25-live/tokyo-evidence.sqlite3")
    parser.add_argument("--hours", type=float, default=24)
    parser.add_argument("--out", default="data/pm-r25-live/live-analysis.json")
    args = parser.parse_args()
    result = analyze(Path(args.db), args.hours)
    output = Path(args.out)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output)
    print(json.dumps({key: result[key] for key in (
        "source_counts", "matching", "completeness", "latency_ms", "maker_price_evidence",
        "binance_received_clock_signed_momentum_bps",
    )}, ensure_ascii=False))
    print("read_only=true trade_authorization=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

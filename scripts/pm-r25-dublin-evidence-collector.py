from __future__ import annotations

import argparse
import hashlib
import json
import os
import queue
import signal
import sqlite3
import threading
import time
import zlib
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
import websocket


EXCHANGES = {
    "ctf_exchange_v2": "0xe111180000d2663c0091e4f400237545b87b996b",
    "neg_risk_exchange_v2": "0xe2222d279d744050d28e00520010520000310f59",
}
ORDER_FILLED_TOPIC = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee"
USER_AGENT = "pm-r25-dublin-read-only-evidence/1.0"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def prepare_database_path(config: dict[str, Any]) -> Path:
    date = datetime.now(timezone.utc).date().isoformat()
    path = Path(str(config["sqlite_path"]).format(date=date))
    link_value = config.get("sqlite_symlink")
    if link_value:
        link = Path(str(link_value))
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.exists() and not link.is_symlink():
            raise RuntimeError(f"refusing to replace regular database with symlink: {link}")
        link.unlink(missing_ok=True)
        relative_target = os.path.relpath(path, link.parent)
        link.symlink_to(relative_target)
    config["sqlite_path"] = str(path)
    return path


def canonical_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def as_int(value: Any) -> int | None:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


@dataclass(slots=True)
class Event:
    source: str
    event_type: str
    event_key: str
    received_at_ns: int
    source_time_ms: int | None
    slug: str | None
    token_id: str | None
    payload: dict[str, Any] | list[Any]


class EvidenceStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.queue: queue.Queue[Event | None] = queue.Queue(maxsize=100_000)
        self.stop = threading.Event()
        self.counters: dict[str, int] = {}
        self.counter_lock = threading.Lock()
        self.failure: BaseException | None = None
        self.started = False
        self.thread = threading.Thread(target=self._run, name="sqlite-writer", daemon=True)

    @staticmethod
    def connect(path: Path) -> sqlite3.Connection:
        connection = sqlite3.connect(path, timeout=30)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("PRAGMA busy_timeout=30000")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                event_type TEXT NOT NULL,
                event_key TEXT NOT NULL UNIQUE,
                received_at_ns INTEGER NOT NULL,
                source_time_ms INTEGER,
                slug TEXT,
                token_id TEXT,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_source_time ON events(source, source_time_ms);
            CREATE INDEX IF NOT EXISTS idx_events_slug_time ON events(slug, received_at_ns);
            CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, received_at_ns);
            CREATE TABLE IF NOT EXISTS checkpoints (
                name TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS health (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                recorded_at TEXT NOT NULL,
                queue_depth INTEGER NOT NULL,
                counters_json TEXT NOT NULL,
                source_status_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS event_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source TEXT NOT NULL,
                received_second INTEGER NOT NULL,
                event_count INTEGER NOT NULL,
                codec TEXT NOT NULL,
                payload_blob BLOB NOT NULL,
                UNIQUE(source, received_second)
            );
            CREATE INDEX IF NOT EXISTS idx_chunks_source_second ON event_chunks(source, received_second);
            """
        )
        return connection

    def start(self) -> None:
        self.thread.start()
        self.started = True

    def submit(self, event: Event) -> None:
        if self.failure is not None:
            raise RuntimeError(f"SQLite writer failed: {self.failure}") from self.failure
        if self.started and not self.thread.is_alive():
            raise RuntimeError("SQLite writer is not running")
        self.queue.put(event, timeout=10)

    def increment(self, name: str, amount: int = 1) -> None:
        with self.counter_lock:
            self.counters[name] = self.counters.get(name, 0) + amount

    def snapshot_counters(self) -> dict[str, int]:
        with self.counter_lock:
            return dict(self.counters)

    def _run(self) -> None:
        connection: sqlite3.Connection | None = None
        try:
            connection = self.connect(self.path)
            self._write_loop(connection)
        except BaseException as exc:
            self.failure = exc
        finally:
            if connection is not None:
                connection.close()

    def _write_loop(self, connection: sqlite3.Connection) -> None:
        pending = 0
        committed_at = time.monotonic()
        chunks: dict[tuple[str, int], list[list[Any]]] = defaultdict(list)
        chunk_keys: dict[tuple[str, int], set[str]] = defaultdict(set)

        def flush_chunks(force: bool = False) -> None:
            nonlocal pending
            current_second = time.time_ns() // 1_000_000_000
            ready = [key for key in chunks if force or key[1] < current_second - 1]
            for key in ready:
                rows = chunks.pop(key)
                chunk_keys.pop(key, None)
                existing = connection.execute(
                    "SELECT event_count,codec,payload_blob FROM event_chunks WHERE source=? AND received_second=?",
                    key,
                ).fetchone()
                if existing is None:
                    payload = zlib.compress(
                        json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 6,
                    )
                    connection.execute(
                        """INSERT INTO event_chunks
                           (source,received_second,event_count,codec,payload_blob) VALUES(?,?,?,?,?)""",
                        (key[0], key[1], len(rows), "zlib-json-v2", payload),
                    )
                else:
                    if existing[1] != "zlib-json-v2":
                        raise RuntimeError(f"unsupported existing chunk codec: {existing[1]}")
                    combined = json.loads(zlib.decompress(existing[2]).decode("utf-8"))
                    combined.extend(rows)
                    payload = zlib.compress(
                        json.dumps(combined, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 6,
                    )
                    connection.execute(
                        """UPDATE event_chunks SET event_count=?,payload_blob=?
                           WHERE source=? AND received_second=?""",
                        (int(existing[0]) + len(rows), payload, key[0], key[1]),
                    )
                    self.increment(f"appended_late_{key[0]}", len(rows))
                self.increment(f"stored_{key[0]}", len(rows))
                pending += 1
        while not self.stop.is_set() or not self.queue.empty():
                try:
                    event = self.queue.get(timeout=.5)
                except queue.Empty:
                    event = None
                if event is not None:
                    if event.source in {"clob", "binance"}:
                        chunk_key = (event.source, event.received_at_ns // 1_000_000_000)
                        if event.event_key in chunk_keys[chunk_key]:
                            self.increment(f"duplicate_{event.source}")
                        else:
                            chunk_keys[chunk_key].add(event.event_key)
                            chunks[chunk_key].append([
                                event.event_type, event.received_at_ns, event.source_time_ms,
                                event.slug if event.source != "clob" else None,
                                event.token_id, event.payload,
                            ])
                    else:
                        cursor = connection.execute(
                            """INSERT OR IGNORE INTO events
                               (source,event_type,event_key,received_at_ns,source_time_ms,slug,token_id,payload_json)
                               VALUES (?,?,?,?,?,?,?,?)""",
                            (
                                event.source, event.event_type, event.event_key, event.received_at_ns,
                                event.source_time_ms, event.slug, event.token_id,
                                json.dumps(event.payload, ensure_ascii=False, separators=(",", ":")),
                            ),
                        )
                        if cursor.rowcount:
                            self.increment(f"stored_{event.source}")
                        else:
                            self.increment(f"duplicate_{event.source}")
                    pending += 1
                # Keep delayed chunks in memory until a small batch is ready.
                # Flushing every late event caused a decompress/recompress cycle
                # per message and let the queue grow faster than SQLite could write.
                should_flush = event is None or pending >= 250 or (pending and time.monotonic() - committed_at >= 1)
                if should_flush:
                    flush_chunks()
                if pending >= 250 or (pending and time.monotonic() - committed_at >= 1):
                    connection.commit()
                    pending = 0
                    committed_at = time.monotonic()
        flush_chunks(force=True)
        connection.commit()

    def close(self) -> None:
        self.stop.set()
        self.thread.join(timeout=30)
        if self.thread.is_alive():
            raise RuntimeError(f"SQLite writer did not drain {self.queue.qsize()} queued events")
        if self.failure is not None:
            raise RuntimeError(f"SQLite writer failed: {self.failure}") from self.failure


class RuntimeStatus:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.values: dict[str, dict[str, Any]] = {}

    def update(self, source: str, **values: Any) -> None:
        with self.lock:
            current = self.values.setdefault(source, {})
            current.update(values)
            current["updated_at"] = utc_now()

    def snapshot(self) -> dict[str, dict[str, Any]]:
        with self.lock:
            return json.loads(json.dumps(self.values))


def discover_markets(config: dict[str, Any], session: requests.Session) -> list[dict[str, Any]]:
    current = int(time.time()) // 300 * 300
    markets: list[dict[str, Any]] = []
    for start in (current, current + 300):
        slug = f"btc-updown-5m-{start}"
        response = session.get(
            config["gamma_events_url"], params={"slug": slug}, headers={"User-Agent": USER_AGENT}, timeout=20,
        )
        response.raise_for_status()
        events = response.json()
        if not events:
            continue
        for market in events[0].get("markets") or []:
            tokens = json.loads(market.get("clobTokenIds") or "[]")
            outcomes = json.loads(market.get("outcomes") or "[]")
            by_outcome = dict(zip(outcomes, tokens))
            if "Up" not in by_outcome or "Down" not in by_outcome:
                continue
            markets.append({
                "slug": slug,
                "start_at": start,
                "end_at": start + 300,
                "condition_id": str(market.get("conditionId") or ""),
                "gamma_market_id": str(market.get("id") or ""),
                "up_token": str(by_outcome["Up"]),
                "down_token": str(by_outcome["Down"]),
                "closed": bool(market.get("closed")),
                "accepting_orders": market.get("acceptingOrders"),
            })
            break
    if not markets:
        raise RuntimeError("Gamma did not return current or next BTC 5-minute market")
    return markets


def token_map(markets: list[dict[str, Any]]) -> dict[str, tuple[str, str]]:
    output: dict[str, tuple[str, str]] = {}
    for market in markets:
        output[market["up_token"]] = (market["slug"], "Up")
        output[market["down_token"]] = (market["slug"], "Down")
    return output


def clob_event_source_time(event: dict[str, Any]) -> int | None:
    value = as_int(event.get("timestamp"))
    if value is None:
        return None
    return value if value > 10_000_000_000 else value * 1000


def compact_clob(event_type: str, event: dict[str, Any]) -> dict[str, Any] | list[Any]:
    if event_type == "price_change":
        return [
            event.get("timestamp"),
            [[
                item.get("asset_id"), item.get("price"), item.get("size"), item.get("side"),
                item.get("best_bid"), item.get("best_ask"),
            ] for item in event.get("price_changes") or []],
        ]
    if event_type == "book":
        return [
            event.get("timestamp"),
            [[row.get("price"), row.get("size")] for row in event.get("bids") or []],
            [[row.get("price"), row.get("size")] for row in event.get("asks") or []],
            event.get("tick_size"),
        ]
    if event_type == "best_bid_ask":
        return [event.get("timestamp"), event.get("best_bid"), event.get("best_ask"), event.get("spread")]
    if event_type == "last_trade_price":
        return [
            event.get("timestamp"), event.get("price"), event.get("size"), event.get("side"),
            event.get("fee_rate_bps"), event.get("transaction_hash"),
        ]
    return event


def compact_binance(event_type: str, data: dict[str, Any]) -> list[Any]:
    if event_type == "agg_trade":
        return [data.get(key) for key in ("a", "p", "q", "f", "l", "T", "m")]
    return [data.get(key) for key in ("u", "b", "B", "a", "A", "E")]


def run_clob(config: dict[str, Any], store: EvidenceStore, status: RuntimeStatus, stop: threading.Event) -> None:
    backoff = 1.0
    session = requests.Session()
    last_book_at_ms: dict[str, int] = {}
    book_min_interval_ms = max(0, int(config.get("clob_book_min_interval_ms", 0)))
    disconnected_at_ns: int | None = None
    disconnected_reason: str | None = None
    connections = 0
    while not stop.is_set():
        ws = None
        try:
            markets = discover_markets(config, session)
            mapping = token_map(markets)
            tokens = sorted(mapping)
            subscribed_tokens = set(tokens)
            received_ns = time.time_ns()
            for market in markets:
                store.submit(Event(
                    "gamma", "market_metadata", f"market:{market['slug']}:{canonical_hash(market)}",
                    received_ns, market["start_at"] * 1000, market["slug"], None, market,
                ))
            ws = websocket.create_connection(config["clob_ws_url"], timeout=15, enable_multithread=True)
            ws.settimeout(10)
            ws.send(json.dumps({
                "assets_ids": tokens,
                "type": "market",
                "initial_dump": True,
                "level": 2,
                "custom_feature_enabled": True,
            }))
            connections += 1
            if disconnected_at_ns is not None:
                gap_ms = (time.time_ns() - disconnected_at_ns) / 1_000_000
                store.submit(Event(
                    "collector", "feed_reconnect", f"clob-reconnect:{connections}:{time.time_ns()}",
                    time.time_ns(), None, None, None,
                    {
                        "feed": "clob", "gap_ms": round(gap_ms, 3), "connections": connections,
                        "reason": disconnected_reason or "unknown",
                    },
                ))
                disconnected_at_ns = None
                disconnected_reason = None
            status.update(
                "clob", state="connected", error=None, tokens=len(tokens),
                slugs=[m["slug"] for m in markets], connections=connections,
                sequence_gap_detection="unavailable_from_public_market_feed",
            )
            backoff = 1.0
            next_market_refresh = (int(time.time()) // 300 + 1) * 300 + 1
            while not stop.is_set():
                try:
                    raw = ws.recv()
                except websocket.WebSocketTimeoutException:
                    ws.send("PING")
                    raw = None
                received_ns = time.time_ns()
                if raw and raw not in {"PONG", "PING"}:
                    payload = json.loads(raw)
                    events = payload if isinstance(payload, list) else [payload]
                    for event in events:
                        if not isinstance(event, dict):
                            continue
                        token = str(event.get("asset_id") or event.get("asset") or "")
                        if not token and event.get("price_changes"):
                            changed = sorted({str(item.get("asset_id") or "") for item in event["price_changes"]})
                            token = changed[0] if len(changed) == 1 else ""
                        slug = mapping.get(token, (None, None))[0]
                        event_type = str(event.get("event_type") or event.get("type") or "unknown")
                        source_ms = clob_event_source_time(event)
                        if event_type == "book" and book_min_interval_ms > 0:
                            book_at_ms = source_ms or received_ns // 1_000_000
                            previous_at_ms = last_book_at_ms.get(token)
                            if previous_at_ms is not None and book_at_ms - previous_at_ms < book_min_interval_ms:
                                store.increment("downsampled_clob_book")
                                continue
                            last_book_at_ms[token] = book_at_ms
                        event_key = f"clob:{event_type}:{token}:{source_ms}:{canonical_hash(event)}"
                        store.submit(Event(
                            "clob", event_type, event_key, received_ns, source_ms, slug, token or None,
                            compact_clob(event_type, event),
                        ))
                    status.update("clob", state="connected", last_message_at=utc_now())

                if time.time() >= next_market_refresh:
                    try:
                        refreshed_markets = discover_markets(config, session)
                        refreshed_mapping = token_map(refreshed_markets)
                        refreshed_tokens = set(refreshed_mapping)
                        added = sorted(refreshed_tokens - subscribed_tokens)
                        removed = sorted(subscribed_tokens - refreshed_tokens)
                        if added:
                            ws.send(json.dumps({"assets_ids": added, "operation": "subscribe"}))
                        if removed:
                            ws.send(json.dumps({"assets_ids": removed, "operation": "unsubscribe"}))
                        metadata_received_ns = time.time_ns()
                        for market in refreshed_markets:
                            store.submit(Event(
                                "gamma", "market_metadata", f"market:{market['slug']}:{canonical_hash(market)}",
                                metadata_received_ns, market["start_at"] * 1000, market["slug"], None, market,
                            ))
                        store.submit(Event(
                            "collector", "market_subscription_update",
                            f"clob-subscription-update:{metadata_received_ns}", metadata_received_ns,
                            None, None, None, {"feed": "clob", "added": added, "removed": removed},
                        ))
                        markets = refreshed_markets
                        mapping = refreshed_mapping
                        subscribed_tokens = refreshed_tokens
                        status.update(
                            "clob", state="connected", error=None, tokens=len(subscribed_tokens),
                            slugs=[market["slug"] for market in markets], connections=connections,
                        )
                        next_market_refresh = (int(time.time()) // 300 + 1) * 300 + 1
                    except Exception as refresh_exc:
                        store.increment("error_clob_market_refresh")
                        status.update("clob", refresh_error=f"{type(refresh_exc).__name__}: {refresh_exc}")
                        next_market_refresh = time.time() + 5
        except Exception as exc:
            disconnected_at_ns = disconnected_at_ns or time.time_ns()
            disconnected_reason = disconnected_reason or f"error:{type(exc).__name__}"
            store.increment("error_clob")
            status.update("clob", state="error", error=f"{type(exc).__name__}: {exc}")
            stop.wait(backoff)
            backoff = min(30.0, backoff * 2)
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass


def run_binance(config: dict[str, Any], store: EvidenceStore, status: RuntimeStatus, stop: threading.Event) -> None:
    backoff = 1.0
    last_agg_id: int | None = None
    sequence_gaps = 0
    disconnected_at_ns: int | None = None
    connections = 0
    while not stop.is_set():
        ws = None
        try:
            ws = websocket.create_connection(config["binance_ws_url"], timeout=15, enable_multithread=True)
            ws.settimeout(10)
            connections += 1
            if disconnected_at_ns is not None:
                gap_ms = (time.time_ns() - disconnected_at_ns) / 1_000_000
                store.submit(Event(
                    "collector", "feed_reconnect", f"binance-reconnect:{connections}:{time.time_ns()}",
                    time.time_ns(), None, None, None,
                    {"feed": "binance", "gap_ms": round(gap_ms, 3), "connections": connections},
                ))
                disconnected_at_ns = None
            status.update("binance", state="connected", error=None, connections=connections, sequence_gaps=sequence_gaps)
            backoff = 1.0
            while not stop.is_set():
                try:
                    raw = ws.recv()
                except websocket.WebSocketTimeoutException:
                    ws.ping()
                    continue
                received_ns = time.time_ns()
                payload = json.loads(raw)
                data = payload.get("data") or payload
                stream = str(payload.get("stream") or "")
                event_type = "agg_trade" if "aggTrade" in stream or data.get("e") == "aggTrade" else "book_ticker"
                sequence = data.get("a") if event_type == "agg_trade" else data.get("u")
                if event_type == "agg_trade" and sequence is not None:
                    agg_id = int(sequence)
                    if last_agg_id is not None and agg_id > last_agg_id + 1:
                        missing = agg_id - last_agg_id - 1
                        sequence_gaps += missing
                        store.increment("gap_binance_agg_trade", missing)
                        store.submit(Event(
                            "collector", "sequence_gap", f"binance-agg-gap:{last_agg_id}:{agg_id}",
                            received_ns, as_int(data.get("T") or data.get("E")), None, None,
                            {"feed": "binance_agg_trade", "after": last_agg_id, "before": agg_id, "missing": missing},
                        ))
                    if last_agg_id is not None and agg_id <= last_agg_id:
                        store.increment("duplicate_binance_agg_trade")
                        continue
                    last_agg_id = agg_id
                source_ms = as_int(data.get("T") or data.get("E"))
                key = f"binance:{event_type}:{sequence}:{source_ms}"
                store.submit(Event(
                    "binance", event_type, key, received_ns, source_ms, None, None,
                    compact_binance(event_type, data),
                ))
                status.update(
                    "binance", state="connected", last_message_at=utc_now(),
                    last_agg_trade_id=last_agg_id, sequence_gaps=sequence_gaps,
                )
        except Exception as exc:
            disconnected_at_ns = disconnected_at_ns or time.time_ns()
            store.increment("error_binance")
            status.update("binance", state="error", error=f"{type(exc).__name__}: {exc}")
            stop.wait(backoff)
            backoff = min(30.0, backoff * 2)
        finally:
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass


def activity_key(row: dict[str, Any]) -> str:
    fields = (
        row.get("transactionHash"), row.get("asset"), row.get("timestamp"), row.get("type"),
        row.get("side"), row.get("size"), row.get("price"), row.get("usdcSize"),
    )
    return "activity:" + canonical_hash(fields if any(fields) else row)


def run_activity(config: dict[str, Any], store: EvidenceStore, status: RuntimeStatus, stop: threading.Event) -> None:
    session = requests.Session()
    interval = float(config["activity_poll_seconds"])
    while not stop.is_set():
        started = time.monotonic()
        now = int(time.time())
        rows_seen = 0
        next_delay = interval
        try:
            pagination_complete = False
            for offset in range(0, 5_000, 500):
                response = session.get(
                    config["activity_url"],
                    params={
                        "user": config["target_address"], "limit": 500, "offset": offset,
                        "start": now - int(config["activity_lookback_seconds"]), "end": now,
                        "sortDirection": "ASC",
                    },
                    headers={"User-Agent": USER_AGENT, "Accept": "application/json"}, timeout=20,
                )
                response.raise_for_status()
                rows = response.json()
                if not isinstance(rows, list):
                    raise RuntimeError("Activity response is not a list")
                rows_seen += len(rows)
                received_ns = time.time_ns()
                for row in rows:
                    timestamp = as_int(row.get("timestamp"))
                    store.submit(Event(
                        "activity", str(row.get("type") or "unknown").lower(), activity_key(row),
                        received_ns, None if timestamp is None else timestamp * 1000,
                        str(row.get("slug") or "") or None, str(row.get("asset") or "") or None, row,
                    ))
                if len(rows) < 500:
                    pagination_complete = True
                    break
            if not pagination_complete:
                raise RuntimeError("Activity pagination truncated at 5000 rows inside the 15-minute overlap")
            status.update(
                "activity", state="ok", error=None, rows_last_poll=rows_seen, pagination_complete=True,
                request_ms=round((time.monotonic() - started) * 1000, 2),
            )
        except Exception as exc:
            store.increment("error_activity")
            status.update("activity", state="error", error=f"{type(exc).__name__}: {exc}")
            if isinstance(exc, requests.HTTPError) and exc.response is not None and exc.response.status_code == 429:
                retry_after = exc.response.headers.get("Retry-After")
                try:
                    next_delay = max(interval, min(120.0, float(retry_after))) if retry_after else 60.0
                except ValueError:
                    next_delay = 60.0
        stop.wait(max(0, next_delay - (time.monotonic() - started)))


def rpc(session: requests.Session, url: str, method: str, params: list[Any]) -> Any:
    response = session.post(url, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, timeout=30)
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise RuntimeError(str(payload["error"]))
    return payload.get("result")


def address_topic(address: str) -> str:
    return "0x" + "0" * 24 + address.lower().removeprefix("0x")


def checkpoint_get(path: Path, name: str) -> str | None:
    connection = EvidenceStore.connect(path)
    try:
        row = connection.execute("SELECT value FROM checkpoints WHERE name=?", (name,)).fetchone()
        return None if row is None else str(row[0])
    finally:
        connection.close()


def persist_polygon_batch(path: Path, events: list[Event], checkpoint_name: str, checkpoint_value: str) -> int:
    connection = EvidenceStore.connect(path)
    try:
        connection.execute("BEGIN IMMEDIATE")
        inserted = 0
        for event in events:
            cursor = connection.execute(
                """INSERT OR IGNORE INTO events
                   (source,event_type,event_key,received_at_ns,source_time_ms,slug,token_id,payload_json)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    event.source, event.event_type, event.event_key, event.received_at_ns,
                    event.source_time_ms, event.slug, event.token_id,
                    json.dumps(event.payload, ensure_ascii=False, separators=(",", ":")),
                ),
            )
            inserted += max(0, cursor.rowcount)
        connection.execute(
            """INSERT INTO checkpoints(name,value,updated_at) VALUES(?,?,?)
               ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at""",
            (checkpoint_name, checkpoint_value, utc_now()),
        )
        connection.commit()
        return inserted
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()


def decode_order_filled(log: dict[str, Any], exchange: str, role: str, block_time_ms: int | None) -> dict[str, Any]:
    data = str(log.get("data") or "0x")
    words = [int(data[2 + index * 64:2 + (index + 1) * 64], 16) for index in range(7)]
    order_side, token_id = words[0], words[1]
    target_side = "BUY" if (role == "maker") == (order_side == 0) else "SELL"
    return {
        "transactionHash": log["transactionHash"],
        "blockNumber": int(log["blockNumber"], 16),
        "logIndex": int(log["logIndex"], 16),
        "exchange": exchange,
        "role": role,
        "orderHash": log["topics"][1],
        "maker": "0x" + log["topics"][2][-40:].lower(),
        "taker": "0x" + log["topics"][3][-40:].lower(),
        "orderSide": order_side,
        "targetSide": target_side,
        "tokenId": str(token_id),
        "makerAmountFilled": words[2],
        "takerAmountFilled": words[3],
        "feeRaw": words[4],
        "feeUsdc": words[4] / 1_000_000,
        "blockTimeMs": block_time_ms,
    }


def run_polygon(config: dict[str, Any], store: EvidenceStore, status: RuntimeStatus, stop: threading.Event) -> None:
    session = requests.Session()
    db_path = Path(config["sqlite_path"])
    checkpoint_name = "polygon_last_complete_block"
    wallet_topic = address_topic(config["target_address"])
    interval = float(config["polygon_poll_seconds"])
    confirmation_blocks = int(config.get("polygon_confirmation_blocks", 12))
    overlap_blocks = int(config.get("polygon_overlap_blocks", 64))
    while not stop.is_set():
        started = time.monotonic()
        try:
            latest = int(rpc(session, config["polygon_rpc_url"], "eth_blockNumber", []), 16)
            saved = checkpoint_get(db_path, checkpoint_name)
            to_block = max(0, latest - confirmation_blocks)
            base_block = to_block if saved is None else min(int(saved), to_block)
            from_block = max(0, base_block - overlap_blocks + 1)
            logs: list[tuple[dict[str, Any], str, str]] = []
            if from_block <= to_block:
                for exchange_name, exchange_address in EXCHANGES.items():
                    for role, topics in (
                        ("maker", [ORDER_FILLED_TOPIC, None, wallet_topic]),
                        ("taker", [ORDER_FILLED_TOPIC, None, None, wallet_topic]),
                    ):
                        params = {
                            "fromBlock": hex(from_block), "toBlock": hex(to_block),
                            "address": exchange_address, "topics": topics,
                        }
                        for log in rpc(session, config["polygon_rpc_url"], "eth_getLogs", [params]) or []:
                            logs.append((log, exchange_name, role))
                block_times: dict[int, int] = {}
                for log, _, _ in logs:
                    block_number = int(log["blockNumber"], 16)
                    if block_number not in block_times:
                        block = rpc(session, config["polygon_rpc_url"], "eth_getBlockByNumber", [hex(block_number), False])
                        block_times[block_number] = int(block["timestamp"], 16) * 1000
                received_ns = time.time_ns()
                events: list[Event] = []
                for log, exchange_name, role in logs:
                    block_number = int(log["blockNumber"], 16)
                    decoded = decode_order_filled(log, exchange_name, role, block_times.get(block_number))
                    key = f"polygon:{decoded['transactionHash'].lower()}:{decoded['logIndex']}"
                    events.append(Event(
                        "polygon", "order_filled", key, received_ns, decoded["blockTimeMs"], None,
                        decoded["tokenId"], decoded,
                    ))
                inserted = persist_polygon_batch(db_path, events, checkpoint_name, str(to_block))
                store.increment("stored_polygon", inserted)
                store.increment("duplicate_polygon", len(events) - inserted)
            else:
                inserted = 0
            status.update(
                "polygon", state="ok", latest_block=latest, completed_confirmed_block=to_block,
                confirmation_blocks=confirmation_blocks, overlap_blocks=overlap_blocks,
                logs_last_poll=len(logs), new_logs_last_poll=inserted,
                request_ms=round((time.monotonic() - started) * 1000, 2),
            )
        except Exception as exc:
            store.increment("error_polygon")
            status.update("polygon", state="error", error=f"{type(exc).__name__}: {exc}")
        stop.wait(max(0, interval - (time.monotonic() - started)))


def run_health(config: dict[str, Any], store: EvidenceStore, status: RuntimeStatus, stop: threading.Event) -> None:
    interval = float(config["health_interval_seconds"])
    while not stop.wait(interval):
        counters = store.snapshot_counters()
        statuses = status.snapshot()
        connection = EvidenceStore.connect(Path(config["sqlite_path"]))
        try:
            connection.execute(
                "INSERT INTO health(recorded_at,queue_depth,counters_json,source_status_json) VALUES(?,?,?,?)",
                (utc_now(), store.queue.qsize(), json.dumps(counters), json.dumps(statuses)),
            )
            connection.commit()
        finally:
            connection.close()
        print(json.dumps({
            "type": "health", "at": utc_now(), "trade_authorization": False,
            "queue": store.queue.qsize(), "counters": counters, "sources": statuses,
        }, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Dublin read-only evidence collector for the 0x3048 strategy")
    parser.add_argument("--config", default="config/pm-r25-dublin-collector.json")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    if config.get("trade_authorization") is not False:
        raise SystemExit("trade_authorization must be false")
    stop = threading.Event()
    database_path = prepare_database_path(config)
    store = EvidenceStore(database_path)
    status = RuntimeStatus()
    store.start()

    def request_stop(signum: int, _frame: Any) -> None:
        print(json.dumps({"type": "shutdown", "signal": signum, "at": utc_now()}), flush=True)
        stop.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    workers = [
        threading.Thread(target=run_clob, args=(config, store, status, stop), name="clob", daemon=True),
        threading.Thread(target=run_binance, args=(config, store, status, stop), name="binance", daemon=True),
        threading.Thread(target=run_activity, args=(config, store, status, stop), name="activity", daemon=True),
        threading.Thread(target=run_polygon, args=(config, store, status, stop), name="polygon", daemon=True),
        threading.Thread(target=run_health, args=(config, store, status, stop), name="health", daemon=True),
    ]
    for worker in workers:
        worker.start()
    print(json.dumps({
        "type": "started", "at": utc_now(), "trade_authorization": False,
        "target_address": config["target_address"], "sqlite": config["sqlite_path"],
    }), flush=True)
    writer_failed = False
    start_date = datetime.now(timezone.utc).date()
    while not stop.wait(1):
        if datetime.now(timezone.utc).date() != start_date:
            print(json.dumps({"type": "daily_rollover", "at": utc_now()}), flush=True)
            stop.set()
            break
        if not store.thread.is_alive() or any(not worker.is_alive() for worker in workers):
            dead = [worker.name for worker in workers if not worker.is_alive()]
            if not store.thread.is_alive():
                dead.append("sqlite-writer")
            print(json.dumps({"type": "fatal", "dead_workers": dead}), flush=True)
            writer_failed = store.failure is not None or not store.thread.is_alive()
            stop.set()
            break
    for worker in workers:
        worker.join(timeout=15)
    try:
        store.close()
    except RuntimeError as exc:
        print(json.dumps({"type": "fatal", "writer_error": str(exc)}), flush=True)
        writer_failed = True
    print(json.dumps({"type": "stopped", "at": utc_now(), "trade_authorization": False}), flush=True)
    return 1 if writer_failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

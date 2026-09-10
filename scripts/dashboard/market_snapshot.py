"""Read-only incremental projection of collector chunks for the live dashboard.

The collector can append to or replace an existing (source, second) chunk.  We
compare its actual bytes, not a row-id/high-water mark, and decode only changed
chunks. Normal append-only traffic applies only new events. Corrections replay
the retained window from decoded records, never re-decompress unchanged data.
"""
from __future__ import annotations

import json
from contextlib import closing
import math
import os
import sqlite3
import subprocess
import time
import zlib
from datetime import datetime, timezone
from pathlib import Path


def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


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
    return value


def publish_snapshot(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(temporary, path)


class MarketSnapshot:
    def __init__(self, data_dir: Path, evidence_glob: str, collector_service: str, node_label: str):
        self.data_dir, self.evidence_glob = Path(data_dir), evidence_glob
        self.collector_service, self.node_label = collector_service, node_label
        self.identity = None
        self.chunks: dict[int, tuple[str, bytes, list]] = {}
        self.books: dict[str, dict] = {}
        self.last_received_ns = 0
        self.max_event_id = 0
        self.service = "unknown"
        self.service_checked = float("-inf")
        self.metrics = {"chunks_decoded": 0, "events_applied": 0, "chunk_bytes_read": 0, "correction_replays": 0, "database_resets": 0}

    def _service(self) -> str:
        if time.monotonic() - self.service_checked >= 10:
            try:
                self.service = subprocess.run(["systemctl", "is-active", self.collector_service], capture_output=True, text=True, timeout=3).stdout.strip() or "unknown"
            except (OSError, subprocess.SubprocessError):
                self.service = "unknown"
            self.service_checked = time.monotonic()
        return self.service

    def _reset(self, identity) -> None:
        self.identity = identity
        self.chunks.clear()
        self.books.clear()
        self.last_received_ns = 0
        self.max_event_id = 0
        self.metrics["database_resets"] += 1

    def _apply(self, row: list) -> None:
        event_type, received_ns, source_ms, _slug, token, payload = row
        if event_type not in ("book", "best_bid_ask", "price_change"):
            return  # Trades and tick notifications must not refresh quote freshness.
        clock = (number(source_ms) if source_ms is not None else received_ns / 1e6, received_ns)
        if clock[0] is None:
            return
        changes = payload[1] or [] if event_type == "price_change" else []
        tokens = {str(change[0]) for change in changes if change[0]} if event_type == "price_change" else ({str(token)} if token else set())
        for asset in tokens:
            state = self.books.setdefault(asset, {"bids": {}, "asks": {}, "clock": (-1, -1), "received_ns": 0, "depth_ready": False})
            if clock < state["clock"]:
                continue
            if event_type == "book":
                state["bids"] = {float(price): float(size) for price, size in (payload[1] or []) if number(price) is not None and number(size) is not None and float(size) > 0}
                state["asks"] = {float(price): float(size) for price, size in (payload[2] or []) if number(price) is not None and number(size) is not None and float(size) > 0}
                state["depth_ready"] = True
                state["bid"], state["ask"] = max(state["bids"], default=None), min(state["asks"], default=None)
                if len(payload) > 3:
                    state["tick_size"] = number(payload[3])
            elif event_type == "best_bid_ask":
                # BBO is a view, not synthetic depth. Null explicitly clears a side.
                state["bid"], state["ask"] = number(payload[1]), number(payload[2])
            else:
                relevant = [change for change in changes if str(change[0]) == asset]
                applied = False
                for _, price, size, side, best_bid, best_ask in relevant:
                    if number(price) is None or number(size) is None or str(side).upper() not in ("BUY", "BID", "SELL", "ASK"):
                        continue
                    levels = state["bids"] if str(side).upper() in ("BUY", "BID") else state["asks"]
                    if float(size) > 0:
                        levels[float(price)] = float(size)
                    else:
                        levels.pop(float(price), None)
                    # Protocol deltas carry the resulting BBO. When omitted, only
                    # a known full-depth baseline can safely reconstruct it.
                    state["bid"] = number(best_bid) if best_bid is not None else (max(state["bids"], default=None) if state["depth_ready"] else None)
                    state["ask"] = number(best_ask) if best_ask is not None else (min(state["asks"], default=None) if state["depth_ready"] else None)
                    applied = True
                if not applied:
                    continue
            state["clock"], state["received_ns"] = clock, received_ns
            self.metrics["events_applied"] += 1

    def _update_books(self, conn: sqlite3.Connection, cutoff: int) -> None:
        additions, seen, correction = [], set(), False
        for second, codec, blob in conn.execute("SELECT received_second,codec,payload_blob FROM event_chunks WHERE source='clob' AND received_second>=? ORDER BY received_second", (cutoff,)):
            seen.add(second)
            self.metrics["chunk_bytes_read"] += len(blob)
            previous = self.chunks.get(second)
            if previous is not None and previous[0] == codec and previous[1] == blob:
                continue
            if codec != "zlib-json-v2":
                raise ValueError("unsupported collector chunk codec")
            rows = json.loads(zlib.decompress(blob).decode("utf-8"))
            if not isinstance(rows, list) or any(not isinstance(row, list) or len(row) != 6 for row in rows):
                raise ValueError("invalid collector chunk")
            self.metrics["chunks_decoded"] += 1
            self.chunks[second] = (codec, blob, rows)
            old_rows = previous[2] if previous is not None else []
            if previous is not None and rows[:len(old_rows)] != old_rows:
                correction = True
            new_rows = rows[len(old_rows):] if rows[:len(old_rows)] == old_rows else rows
            if any(row[1] < self.last_received_ns for row in new_rows):
                correction = True
            additions.extend(new_rows)
        # Deletion within the live window is a correction, unlike ordinary expiry.
        if any(second >= cutoff and second not in seen for second in self.chunks):
            correction = True
        self.chunks = {second: entry for second, entry in self.chunks.items() if second in seen}
        if correction:
            self.books.clear()
            additions = [row for _, _, rows in self.chunks.values() for row in rows]
            self.last_received_ns = 0
            self.metrics["correction_replays"] += 1
        for row in sorted(additions, key=lambda item: item[1]):
            self._apply(row)
            self.last_received_ns = max(self.last_received_ns, row[1])
        self.books = {token: book for token, book in self.books.items() if book["received_ns"] >= cutoff * 1_000_000_000}

    def snapshot(self, now: float | None = None) -> dict:
        try:
            return self._snapshot(now)
        except Exception:
            # A failed decode/apply must never poison the next incremental poll.
            # Raw SQLite remains authoritative, so recover by a complete bootstrap.
            self._reset(None)
            raise

    def _snapshot(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        result = {"checked_at": iso(now), "service": self._service(), "node_label": self.node_label, "current_markets": [], "collector_online": False}
        paths = sorted(self.data_dir.glob(self.evidence_glob))
        if not paths:
            self._reset(None)
            result["error"] = self.node_label + " SQLite missing"
            return result
        path = paths[-1]
        stat = path.stat()
        identity = (str(path.resolve()), stat.st_dev, stat.st_ino)
        if identity != self.identity:
            self._reset(identity)
        result.update(db=path.name, db_bytes=stat.st_size, db_mtime=iso(stat.st_mtime))
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=3)) as conn:
            conn.execute("BEGIN")  # Metadata, chunks and counters share one committed snapshot.
            max_id = conn.execute("SELECT COALESCE(MAX(id),0) FROM events").fetchone()[0]
            if max_id < self.max_event_id:
                self._reset(identity)
            self.max_event_id = max_id
            now_ns, second = int(now * 1e9), int(now)
            tail = list(conn.execute("SELECT source,received_at_ns FROM events ORDER BY id DESC LIMIT 10000"))
            sources = ("clob", "binance", "activity", "gamma", "polygon", "collector")
            latest = {}
            for source in sources:
                last = conn.execute("SELECT received_second FROM event_chunks WHERE source=? ORDER BY received_second DESC LIMIT 1", (source,)).fetchone()
                if last:
                    latest[source] = int(last[0]) * 1_000_000_000
            for source, timestamp in tail:
                latest[source] = max(latest.get(source, 0), timestamp)
            for name, seconds in (("1m", 60), ("5m", 300)):
                complete = len(tail) < 10000
                count = sum(conn.execute("SELECT COALESCE(SUM(event_count),0) FROM event_chunks WHERE source=? AND received_second>=?", (source, second-seconds)).fetchone()[0] for source in sources)
                result["events_" + name] = int(count) + sum(timestamp >= now_ns-seconds*1e9 for _, timestamp in tail) if complete else None
                result["events_" + name + "_complete"] = complete
            result["latest_by_source"], result["latest_event_ns"] = latest, max(latest.values(), default=None)
            if result["latest_event_ns"] is not None:
                result["latest_event_at"] = iso(result["latest_event_ns"] / 1e9)
            metadata = {}
            for row in conn.execute("SELECT payload_json FROM events WHERE event_type='market_metadata' AND source='gamma' ORDER BY received_at_ns DESC LIMIT 20"):
                item = json.loads(row[0])
                metadata.setdefault(item.get("slug"), item)
            self._update_books(conn, second-180)
            for slug, item in metadata.items():
                if not (float(item.get("start_at", 0)) <= now < float(item.get("end_at", 0))):
                    continue
                up, down = self.books.get(str(item.get("up_token")), {}), self.books.get(str(item.get("down_token")), {})
                ua, da = up.get("ask"), down.get("ask")
                quote_ns = min(up.get("received_ns", 0), down.get("received_ns", 0))
                result["current_markets"].append({"slug": slug, "condition_id": item.get("condition_id") or item.get("conditionId") or "", "up_token": item.get("up_token") or "", "down_token": item.get("down_token") or "", "start": item.get("start_at"), "end": item.get("end_at"), "up_bid": up.get("bid"), "up_ask": ua, "down_bid": down.get("bid"), "down_ask": da, "ask_sum": ua+da if ua is not None and da is not None else None, "quote_at": iso(quote_ns/1e9) if quote_ns else None})
            result["current_markets"].sort(key=lambda market: float(market.get("end") or 1e20))
            row = conn.execute("SELECT recorded_at,queue_depth,counters_json,source_status_json FROM health ORDER BY id DESC LIMIT 1").fetchone()
            if row:
                result.update(health_at=row[0], queue_depth=row[1], counters=json.loads(row[2]), sources=json.loads(row[3]))
        freshness = {key: max(0., now-datetime.fromisoformat(result[key]).timestamp()) for key in ("health_at", "latest_event_at") if result.get(key)}
        result["freshness_seconds"] = freshness
        result["collector_online"] = result["service"] == "active" and bool(result.get("health_at")) and all(age <= 120 for age in freshness.values())
        if any(age > 120 for age in freshness.values()):
            result["stale_reason"] = "stale data older than 120 seconds"
        result["projection_metrics"] = dict(self.metrics)
        return result

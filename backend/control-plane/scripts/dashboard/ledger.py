"""Bounded journal analytics. Never call ingestion from a trading/request loop.

Journal PnL is engine settlement PnL (payout - cost - fees), not wallet cash
reconciliation. Missing order identifiers prevent reliable order lifecycle metrics.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from contextlib import contextmanager
import json
import math
import os
import re
from pathlib import Path
import sqlite3
import time


SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
 run_id TEXT PRIMARY KEY, mode TEXT NOT NULL, account_id TEXT, path TEXT NOT NULL,
 config_revision INTEGER, created_at REAL NOT NULL, source_identity TEXT,
 byte_offset INTEGER NOT NULL DEFAULT 0, prefix_length INTEGER NOT NULL DEFAULT 0,
 prefix_hash TEXT, tail_hash TEXT, source_error TEXT,
 record_count INTEGER NOT NULL DEFAULT 0, invalid_records INTEGER NOT NULL DEFAULT 0,
 duplicate_records INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0,
 fill_count INTEGER NOT NULL DEFAULT 0, fill_notional REAL NOT NULL DEFAULT 0,
 missing_notional INTEGER NOT NULL DEFAULT 0, known_fees REAL NOT NULL DEFAULT 0,
 missing_fees INTEGER NOT NULL DEFAULT 0, settled_markets INTEGER NOT NULL DEFAULT 0,
 known_settled_pnl REAL NOT NULL DEFAULT 0, missing_pnl INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id),
 byte_offset INTEGER NOT NULL, kind TEXT NOT NULL, stable_id TEXT, payload TEXT NOT NULL,
 UNIQUE(run_id, byte_offset)
);
CREATE UNIQUE INDEX IF NOT EXISTS stable_event ON events(run_id, kind, stable_id)
 WHERE stable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_page ON events(run_id, id);
CREATE INDEX IF NOT EXISTS order_event_page ON events(run_id, kind, id);
CREATE TABLE IF NOT EXISTS markets (
 run_id TEXT NOT NULL REFERENCES runs(run_id), market TEXT NOT NULL,
 fills INTEGER NOT NULL DEFAULT 0, settled INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(run_id, market)
);
CREATE TABLE IF NOT EXISTS kind_counts (
 run_id TEXT NOT NULL REFERENCES runs(run_id), kind TEXT NOT NULL, count INTEGER NOT NULL,
 PRIMARY KEY(run_id,kind)
);
CREATE TABLE IF NOT EXISTS market_details (
 run_id TEXT NOT NULL REFERENCES runs(run_id), market TEXT NOT NULL,
 turnover REAL NOT NULL DEFAULT 0, pnl REAL, status TEXT NOT NULL DEFAULT '运行中',
 last_time REAL NOT NULL DEFAULT 0, PRIMARY KEY(run_id,market)
);
CREATE INDEX IF NOT EXISTS latest_markets ON market_details(run_id,last_time DESC);
CREATE TABLE IF NOT EXISTS latency_samples (
 run_id TEXT NOT NULL REFERENCES runs(run_id), metric TEXT NOT NULL,
 byte_offset INTEGER NOT NULL, time REAL NOT NULL, duration_ms REAL NOT NULL,
 PRIMARY KEY(run_id,byte_offset)
);
CREATE INDEX IF NOT EXISTS latency_recent ON latency_samples(run_id,metric,time DESC);
CREATE TABLE IF NOT EXISTS platform_runtime (
 run_id TEXT PRIMARY KEY REFERENCES runs(run_id), source_at REAL NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_details (
 run_id TEXT NOT NULL REFERENCES runs(run_id), client_order_id TEXT NOT NULL,
 accepted INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0,
 updated_at REAL NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,client_order_id)
);
CREATE TABLE IF NOT EXISTS trade_details (
 run_id TEXT NOT NULL REFERENCES runs(run_id), trade_id TEXT NOT NULL, order_id TEXT NOT NULL,
 payload TEXT NOT NULL, PRIMARY KEY(run_id,trade_id,order_id)
);
"""
EVENT_KINDS = frozenset({"quote", "fill", "taker", "cancel", "resolved", "reset", "stopped", "unresolved", "error",
                         "order", "settlement", "platform_status"})
LATENCY_METRICS = frozenset({
    "market_age", "book_processing", "book_batch_apply", "strategy_decision", "ws_receive_to_decision",
    "durable_commit", "order_sign", "trigger_to_http_post", "decision_to_http_post",
    "order_submit_roundtrip", "order_http_ack", "reaction", "authenticated_trade_report", "cancel_http_ack",
    "order_risk_metadata",
    # Retained while old journals remain readable.
    "order_ack", "cancel_ack", "fill_report",
})
LATENCY_LIMIT = 5000
RUNTIME_MAX_AGE = 10
ORDER_STATUSES = frozenset({"SUBMITTING", "OPEN", "PARTIAL", "FILLED", "CANCELLED", "REJECTED", "UNKNOWN"})


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _text(value, maximum=200):
    return value[:maximum] if isinstance(value, str) else None


def _trade_revision(prior, event):
    if not prior or prior.get("trade_status") not in ("CONFIRMED", "FAILED"):
        return event
    if (prior.get("trade_status") == event.get("trade_status") == "CONFIRMED"
            and (prior.get("fee_source") != "reported" or prior.get("fee") is None)
            and event.get("fee_source") == "reported" and event.get("fee") is not None
            and event["fee"] >= 0):
        # A final fee can improve without changing an already final trade's size or price.
        return {**prior, "fee": event["fee"], "fee_source": "reported", "fee_estimate": None}
    return None


def _strategy_projection(value):
    if not isinstance(value, dict) or value.get("strategyId") != "btc-reversal":
        return None
    def config(source):
        if not isinstance(source, dict):
            return None
        result = {key: _number(source.get(key)) for key in (
            "triggerPrice", "confirmationPrice", "maxBuyPrice", "maxStages", "roundBudgetUsd",
            "totalBudgetUsd", "maxQuoteAgeSeconds", "maxQuoteSkewSeconds")}
        result.update(revision=_text(str(source["revision"])) if source.get("revision") is not None else None,
                      stageShares=[_number(n) for n in source.get("stageShares", [])[:100]]
                      if isinstance(source.get("stageShares"), list) else [])
        return result
    def round_view(source):
        if not isinstance(source, dict):
            return None
        result = {key: _text(source.get(key)) for key in (
            "marketId", "name", "upTokenId", "downTokenId", "status", "reason", "lastStageDirection",
            "lastConfirmedDirection", "nextDirection", "resultScope", "resultReason")}
        result.update({key: _number(source.get(key)) for key in (
            "startsAt", "endsAt", "confirmationCount", "nextStage", "nextShares",
            "costUsd", "reservedUsd", "upShares", "downShares", "netIfUpUsd", "netIfDownUsd")})
        result["feesVerified"] = source.get("feesVerified") if isinstance(source.get("feesVerified"), bool) else None
        result["configRevision"] = _text(str(source["configRevision"])) if source.get("configRevision") is not None else None
        result["config"] = config(source.get("config"))
        stages = source.get("stages") if isinstance(source.get("stages"), list) else []
        result["stages"] = [{**{key: _text(stage.get(key)) for key in (
            "direction", "tokenId", "clientOrderId", "orderId", "trigger", "status", "error")},
            **{key: _number(stage.get(key)) for key in ("stage", "price", "shares", "createdAt", "filledShares")}}
            for stage in stages[:100] if isinstance(stage, dict)]
        return result
    rounds = value.get("rounds") if isinstance(value.get("rounds"), list) else []
    result = {"strategyId": "btc-reversal", "schemaVersion": 1,
              "instanceId": _text(value.get("instanceId")), "paused": value.get("paused") is True,
              "savedRevision": _text(str(value["savedRevision"])) if value.get("savedRevision") is not None else None,
              "config": config(value.get("config")),
              "currentRound": round_view(value.get("currentRound")),
              "rounds": [round_view(r) for r in rounds[-8:] if isinstance(r, dict)],
              "truncated": len(rounds) > 8}
    return result


def _runtime_projection(value, mode):
    if (not isinstance(value, dict) or type(value.get("schemaVersion")) is not int
            or value.get("schemaVersion") != 1 or value.get("engine") != "platform"
            or value.get("execution") not in ("observation", "strategy")
            or value.get("status") not in ("starting", "running", "stopped", "failed")
            or value.get("mode") != mode):
        return None
    result = {key: value[key] for key in ("schemaVersion", "engine", "execution", "status", "mode")}
    result["strategy_id"] = _text(value.get("strategy_id"))
    result["strategy_runtime"] = _strategy_projection(value.get("strategy_runtime"))
    positions = value.get("positions") if isinstance(value.get("positions"), list) else []
    result["positions"] = [{"tokenId": _text(p.get("tokenId")),
                            **{key: _number(p.get(key)) for key in ("shares", "costUsd", "realizedPnlUsd")}}
                           for p in positions[:1000] if isinstance(p, dict)]
    if ((result["execution"] == "observation" and result["strategy_id"] is not None)
            or (result["execution"] == "strategy" and not result["strategy_id"])):
        return None
    for key in ("started_at", "cash_usd", "positions_count", "orders_count", "active_orders", "fills_count"):
        result[key] = _number(value.get(key))
    risk = value.get("risk")
    result["risk"] = None
    if isinstance(risk, dict):
        result["risk"] = {key: _number(risk.get(key)) for key in (
            "baselineAt", "baselineEquityUsd", "equityUsd", "dailyPnlUsd", "occupiedUsd", "availableUsd",
            "cashFlowCoverageFrom", "cashFlowCoverageUntil", "netExternalFlowUsd", "unresolvedOrderCount")}
        result["risk"].update(halted=risk.get("halted") if isinstance(risk.get("halted"), bool) else None,
                              reconciliationRequired=risk.get("reconciliationRequired") if isinstance(risk.get("reconciliationRequired"), bool) else None,
                              reason=_text(risk.get("reason")), day=_text(risk.get("day")),
                              cashFlowComplete=risk.get("cashFlowComplete") if isinstance(risk.get("cashFlowComplete"), bool) else None,
                              pnlVerified=risk.get("pnlVerified") if isinstance(risk.get("pnlVerified"), bool) else None,
                              cashFlowReason=_text(risk.get("cashFlowReason")),
                              dailyLossStatus=risk.get("dailyLossStatus") if risk.get("dailyLossStatus") in ("disabled", "active", "estimated") else None)
    limits = value.get("limits")
    result["limits"] = {key: _number(limits.get(key)) for key in (
        "capitalUsd", "dailyLossUsd", "maxOrderUsd", "maxOpenOrders")} if isinstance(limits, dict) else None
    markets = value.get("markets") if isinstance(value.get("markets"), list) else []
    books = value.get("books") if isinstance(value.get("books"), list) else []
    result.update(markets=[], books=[], truncated=len(markets) > 8 or len(books) > 16)
    now = time.time()
    def market_priority(market):
        start, end = _number(market.get("startsAt")), _number(market.get("endsAt"))
        return (int(start is not None and end is not None and start <= now < end),
                int(start is not None and start > now), end or 0)
    selected_markets = sorted((m for m in markets if isinstance(m, dict)), key=market_priority, reverse=True)[:8]
    for market in selected_markets:
        if not isinstance(market, dict):
            continue
        item = {key: _text(market.get(key)) for key in ("id", "name")}
        item.update({key: _number(market.get(key)) for key in ("startsAt", "endsAt")})
        instruments = market.get("instruments") if isinstance(market.get("instruments"), list) else []
        item["instruments"] = [{**{key: _text(i.get(key)) for key in ("tokenId", "marketId", "outcome")},
                                **{key: _number(i.get(key)) for key in ("tickSize", "minOrderSize")}}
                               for i in instruments[:2] if isinstance(i, dict)]
        result["truncated"] |= len(instruments) > 2
        result["markets"].append(item)
    selected_tokens = {i["tokenId"] for m in result["markets"] for i in m["instruments"]}
    selected_books = sorted((b for b in books if isinstance(b, dict)),
                            key=lambda b: (b.get("tokenId") in selected_tokens, _number(b.get("ts")) or 0), reverse=True)[:16]
    for book in selected_books:
        if not isinstance(book, dict):
            continue
        item = {"tokenId": _text(book.get("tokenId")), "source": _text(book.get("source"))}
        item.update({key: _number(book.get(key)) for key in (
            "ts", "exchangeTs", "receivedAt", "processingLatencyMs", "sourceAgeMs", "received_age_ms",
            "bid", "ask", "bidSize", "askSize")})
        for field in ("market_expired", "stale"):
            item[field] = book.get(field) if isinstance(book.get(field), bool) else None
        for side in ("bids", "asks"):
            levels = book.get(side) if isinstance(book.get(side), list) else []
            item[side] = [[_number(level[0]), _number(level[1])] for level in levels[:10]
                          if isinstance(level, list) and len(level) == 2
                          and all(_number(n) is not None for n in level)]
        result["books"].append(item)
    return result


def _projection(record):
    """Only these typed business fields leave the journal; no raw messages/config."""
    result = {"event": record["event"], "market": _text(record.get("market_slug")),
              "side": record.get("side") if record.get("side") in ("UP", "DOWN", "up", "down") else None,
              "winner": record.get("winner") if record.get("winner") in ("UP", "DOWN", "up", "down") else None}
    if record["event"] in ("order", "fill"):
        result["side"] = _text(record.get("side"))
    for field, source in (("time", "recv_ts"), ("engine_ts", "engine_ts"),
                          ("price", "price"), ("shares", "shares"), ("fee", "fee"), ("pnl", "pnl")):
        result[field] = _number(record.get(source))
    result["is_maker"] = record.get("is_maker") if isinstance(record.get("is_maker"), bool) else None
    result["trade_status"] = record.get("trade_status") if record.get("trade_status") in (
        "MATCHED", "MATCHED_NOT_BROADCASTED", "MINED", "RETRYING", "CONFIRMED", "FAILED") else None
    result["fee_source"] = record.get("fee_source") if record.get("fee_source") in ("reported", "rate-derived", "estimate") else None
    if result["fee_source"] in ("rate-derived", "estimate"):
        result["fee_estimate"] = result["fee"]
        result["fee"] = None
    for field in ("client_order_id", "order_id", "token_id", "strategy_id", "trade_id", "code", "phase", "failure_phase",
                  "market_id", "transaction_id"):
        result[field] = _text(record.get(field))
    result["direction"] = record.get("direction") if record.get("direction") in ("BUY", "SELL") else None
    result["status"] = record.get("status") if isinstance(record.get("status"), str) and record["status"] in ORDER_STATUSES else None
    result["venue_status"] = record.get("venue_status") if record.get("venue_status") in (
        "live", "matched", "delayed", "unmatched", "canceled", "cancelled", "expired") else None
    result["state"] = record.get("state") if record.get("state") in ("confirmed", "pending", "unsupported") else None
    if record["event"] == "settlement":
        amounts = {field: _number(record.get(field)) for field in
                   ("credited_usd", "expected_payout_usd", "cash_before_usd", "cash_after_usd")}
        credit, expected = amounts["credited_usd"], amounts["expected_payout_usd"]
        verified = (record.get("payout_verified") is True and result["state"] == "confirmed"
                    and bool(re.fullmatch(r"0x[0-9a-fA-F]{64}", result["transaction_id"] or ""))
                    and credit is not None and expected is not None and credit >= expected >= 0)
        result["payout_verified"] = verified
        result.update({field: amount if verified and amount is not None and amount >= 0 else None
                       for field, amount in amounts.items()})
    for field in ("filled_shares", "reserved_usd", "reserved_shares", "sign_latency_ms", "risk_metadata_latency_ms", "ack_latency_ms", "total_ack_latency_ms",
                  "cancel_requested_at", "cancel_ack_at", "cancel_ack_latency_ms", "venue_status_at",
                  "venue_status_latency_ms", "venue_status_after_ack_latency_ms", "updated_at"):
        result[field] = _number(record.get(field))
    result["venue_status_source"] = record.get("venue_status_source") if record.get("venue_status_source") in (
        "http_ack", "user_ws", "account_read") else None
    result["cancellation_source"] = record.get("cancellation_source") if record.get("cancellation_source") in (
        "local_http", "user_ws", "account_read") else None
    price, shares = result["price"], result["shares"]
    result["amount"] = _number(price * shares) if price is not None and shares is not None and price >= 0 and shares >= 0 else None
    # Stopped/unresolved snapshots are never settlement PnL.
    if record["event"] != "resolved":
        result["pnl"] = None
    return result


class Ledger:
    def __init__(self, path, *, readonly=False):
        self.path = Path(path).resolve()
        self.readonly = readonly
        self._idle_sources = OrderedDict()
        if not readonly:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.executescript(SCHEMA)

    @contextmanager
    def _connect(self):
        target = self.path.as_uri() + "?mode=ro" if self.readonly else str(self.path)
        db = sqlite3.connect(target, uri=self.readonly, timeout=2)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def register_run(self, run_id, mode, account_id, path, config_revision=None):
        if not isinstance(run_id, str) or not run_id or len(run_id) > 200:
            raise ValueError("Invalid run ID")
        if mode != "live":
            raise ValueError("Invalid run mode")
        if config_revision is not None and (type(config_revision) is not int or config_revision < 0):
            raise ValueError("Invalid config revision")
        values = (mode, account_id, str(Path(path).resolve()), config_revision)
        with self._connect() as db:
            prior = db.execute("SELECT mode,account_id,path,config_revision FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if prior is not None:
                normalized = (prior["mode"], prior["account_id"], prior["path"],
                              int(prior["config_revision"]) if prior["config_revision"] is not None else None)
                if normalized != values:
                    raise ValueError("Run registration is immutable")
                return
            db.execute("INSERT INTO runs(run_id,mode,account_id,path,config_revision,created_at) VALUES(?,?,?,?,?,?)",
                       (run_id, *values, time.time()))

    @staticmethod
    def _run(db, run_id):
        row = db.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise KeyError("Run is not registered")
        return row

    @staticmethod
    def _has_table(db, name):
        # Read-only historical APIs can be opened before the new worker migrates a database.
        return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None

    def list_runs(self, *, limit=100):
        limit = max(1, min(int(limit), 200))
        with self._connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT run_id,mode,account_id,config_revision,created_at FROM runs ORDER BY created_at DESC LIMIT ?", (limit,))]

    @staticmethod
    def _fingerprints(source, offset, prefix_length):
        source.seek(0)
        prefix = hashlib.sha256(source.read(prefix_length)).hexdigest()
        source.seek(max(0, offset - 256))
        tail = hashlib.sha256(source.read(min(offset, 256))).hexdigest()
        return prefix, tail

    def ingest(self, run_id, *, max_bytes=1048576, max_records=2000):
        max_bytes = max(1, min(int(max_bytes), 8 * 1048576))
        max_records = max(1, min(int(max_records), 10000))
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            run = self._run(db, run_id)
            offset = run["byte_offset"]
            result = {"run_id": run_id, "records": 0, "inserted": 0, "bytes": 0,
                      "byte_offset": offset, "pending": False, "error": run["source_error"]}
            if run["source_error"]:
                return result
            try:
                source = open(run["path"], "rb")
            except FileNotFoundError:
                result["pending"] = True
                return result
            with source:
                stat = os.fstat(source.fileno())
                result.update(source_bytes=stat.st_size, lag_bytes=max(0, stat.st_size-offset))
                identity = f"{stat.st_dev}:{stat.st_ino}"
                prefix, tail = self._fingerprints(source, offset, run["prefix_length"])
                if ((run["source_identity"] is not None and identity != run["source_identity"])
                        or stat.st_size < offset
                        or (offset and (prefix != run["prefix_hash"] or tail != run["tail_hash"]))):
                    result["error"] = "Journal replaced, truncated, or rewritten; register a new run"
                    db.execute("UPDATE runs SET source_error=? WHERE run_id=?", (result["error"], run_id))
                    return result
                db.execute("UPDATE runs SET source_identity=? WHERE run_id=?", (identity, run_id))
                source.seek(offset)
                block = source.read(max_bytes)
                cursor = 0
                latency_metrics = set()
                while result["records"] < max_records:
                    end = block.find(b"\n", cursor)
                    if end < 0:
                        break
                    raw = block[cursor:end]
                    record_offset = offset + cursor
                    cursor = end + 1
                    result["records"] += 1
                    try:
                        record = json.loads(raw)
                        if not isinstance(record, dict):
                            raise ValueError("Record must be an object")
                    except (UnicodeDecodeError, ValueError):
                        db.execute("UPDATE runs SET invalid_records=invalid_records+1 WHERE run_id=?", (run_id,))
                        continue
                    kind = record.get("event")
                    aliases = {"platform_error": "error", "platform_stopped": "stopped", "platform_settlement": "settlement"}
                    if isinstance(kind, str) and kind in aliases:
                        kind = aliases[kind]
                        record = {**record, "event": kind}
                    if kind == "latency":
                        metric, duration, at = record.get("metric"), _number(record.get("duration_ms")), _number(record.get("recv_ts"))
                        event_mode = record.get("mode")
                        if (metric in LATENCY_METRICS and duration is not None and duration >= 0
                                and at is not None and at > 0
                                and (event_mode is None or event_mode == "live")):
                            db.execute("INSERT OR IGNORE INTO latency_samples VALUES(?,?,?,?,?)",
                                       (run_id, metric, record_offset, at, duration))
                            latency_metrics.add(metric)
                        continue
                    if not isinstance(kind, str) or kind not in EVENT_KINDS:
                        continue
                    runtime = None
                    if kind == "platform_status":
                        runtime = _runtime_projection(record.get("runtime"), run["mode"])
                        at = _number(record.get("recv_ts"))
                        if runtime is None or at is None or at <= 0:
                            db.execute("UPDATE runs SET invalid_records=invalid_records+1 WHERE run_id=?", (run_id,))
                            continue
                    projected = _projection(record)
                    if kind == "resolved":
                        prior_market = db.execute("SELECT fills FROM markets WHERE run_id=? AND market=?",
                                                  (run_id, projected["market"])).fetchone()
                        projected["has_observed_fills"] = bool(prior_market and prior_market["fills"])
                        if not projected["has_observed_fills"]:
                            projected["pnl"] = None
                    stable_id = None
                    for key in ("event_id", "eventId") + (("fill_id", "trade_id", "tradeId") if kind == "fill" else ()):
                        candidate = record.get(key)
                        if isinstance(candidate, (str, int)) and not isinstance(candidate, bool) and str(candidate):
                            stable_id = f"{key}:{candidate}"
                            break
                    inserted = db.execute("INSERT OR IGNORE INTO events(run_id,byte_offset,kind,stable_id,payload) VALUES(?,?,?,?,?)",
                                          (run_id, record_offset, kind, stable_id, json.dumps(projected, allow_nan=False))).rowcount
                    if not inserted:
                        db.execute("UPDATE runs SET duplicate_records=duplicate_records+1 WHERE run_id=?", (run_id,))
                        continue
                    result["inserted"] += 1
                    self._accumulate(db, run_id, projected)
                    if runtime is not None:
                        db.execute("""INSERT INTO platform_runtime VALUES(?,?,?)
                            ON CONFLICT(run_id) DO UPDATE SET source_at=excluded.source_at,payload=excluded.payload
                            WHERE excluded.source_at>=platform_runtime.source_at""",
                                   (run_id, at, json.dumps(runtime, allow_nan=False)))
                new_offset = offset + cursor
                for metric in latency_metrics:
                    db.execute("""DELETE FROM latency_samples WHERE run_id=? AND byte_offset IN
                        (SELECT byte_offset FROM latency_samples WHERE run_id=? AND metric=?
                         ORDER BY time DESC,byte_offset DESC LIMIT -1 OFFSET ?)""",
                               (run_id, run_id, metric, LATENCY_LIMIT))
                if not cursor and len(block) == max_bytes and b"\n" not in block:
                    result["error"] = "Journal line exceeds ingestion byte budget"
                prefix_length = min(new_offset, 256)
                prefix, tail = self._fingerprints(source, new_offset, prefix_length)
                db.execute("""UPDATE runs SET byte_offset=?,prefix_length=?,prefix_hash=?,tail_hash=?,
                    record_count=record_count+?,event_count=event_count+?,source_error=? WHERE run_id=?""",
                           (new_offset, prefix_length, prefix, tail, result["records"], result["inserted"], result["error"], run_id))
                size = os.fstat(source.fileno()).st_size
                result.update(bytes=cursor, byte_offset=new_offset, source_bytes=size,
                              lag_bytes=max(0, size-new_offset), pending=new_offset < size)
                return result

    @staticmethod
    def _source_stamp(path):
        stat = Path(path).stat()
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)

    def ingest_if_changed(self, run_id, **limits):
        """Single-writer worker fast path; pending/error sources always recheck.

        Metadata changes still pass through ingest's identity and content checks.
        Cache only a stable, caught-up source, bounded across historical runs.
        Ordinary ingest remains uncached for callers sharing a writer database.
        """
        cached = self._idle_sources.pop(run_id, None)
        if cached:
            path, stamp, result = cached
            try:
                if self._source_stamp(path) == stamp:
                    self._idle_sources[run_id] = cached
                    return {**result, "records": 0, "inserted": 0, "bytes": 0}
            except OSError:
                pass
        else:
            with self._connect() as db:
                path = self._run(db, run_id)["path"]
        try:
            before = self._source_stamp(path)
        except OSError:
            before = None
        result = self.ingest(run_id, **limits)
        if not result["pending"] and not result["error"] and before is not None:
            try:
                if before == self._source_stamp(path):
                    self._idle_sources[run_id] = (path, before, dict(result))
                    while len(self._idle_sources) > 256:
                        self._idle_sources.popitem(last=False)
            except OSError:
                pass
        return result

    @staticmethod
    def _accumulate(db, run_id, event):
        kind, market = event["event"], event["market"]
        if kind == "fill" and event.get("trade_status") and event.get("trade_id") and event.get("order_id"):
            Ledger._accumulate_trade(db, run_id, event)
            return
        db.execute("INSERT INTO kind_counts VALUES(?,?,1) ON CONFLICT(run_id,kind) DO UPDATE SET count=count+1", (run_id, kind))
        if kind == "fill" and event["is_maker"] is False:
            db.execute("INSERT INTO kind_counts VALUES(?,'taker_fill',1) ON CONFLICT(run_id,kind) DO UPDATE SET count=count+1", (run_id,))
        if kind == "order" and event["client_order_id"] and event["status"]:
            prior = db.execute("SELECT * FROM order_details WHERE run_id=? AND client_order_id=?",
                               (run_id, event["client_order_id"])).fetchone()
            accepted = bool(event["order_id"] and event["status"] in ("OPEN", "PARTIAL", "FILLED"))
            cancelled = event["status"] == "CANCELLED"
            for name, seen, existing in (("quote", accepted, prior["accepted"] if prior else False),
                                         ("cancel", cancelled, prior["cancelled"] if prior else False)):
                if seen and not existing:
                    db.execute("INSERT INTO kind_counts VALUES(?,?,1) ON CONFLICT(run_id,kind) DO UPDATE SET count=count+1",
                               (run_id, name))
            updated_at = event["updated_at"] if event["updated_at"] is not None else event["time"] or 0
            payload = json.dumps(event, allow_nan=False)
            if prior and updated_at < prior["updated_at"]:
                updated_at, payload = prior["updated_at"], prior["payload"]
            db.execute("""INSERT INTO order_details VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,client_order_id)
                DO UPDATE SET accepted=excluded.accepted,cancelled=excluded.cancelled,
                updated_at=excluded.updated_at,payload=excluded.payload""",
                       (run_id, event["client_order_id"], int(accepted or bool(prior and prior["accepted"])),
                        int(cancelled or bool(prior and prior["cancelled"])), updated_at, payload))
        if market:
            db.execute("INSERT OR IGNORE INTO markets(run_id,market) VALUES(?,?)", (run_id, market))
            db.execute("INSERT INTO market_details(run_id,market,last_time) VALUES(?,?,?) ON CONFLICT(run_id,market) DO UPDATE SET last_time=MAX(last_time,excluded.last_time)", (run_id, market, event["time"] or 0))
        if kind == "fill":
            db.execute("""UPDATE runs SET fill_count=fill_count+1,fill_notional=fill_notional+?,
                missing_notional=missing_notional+?,known_fees=known_fees+?,missing_fees=missing_fees+? WHERE run_id=?""",
                       (event["amount"] or 0, int(event["amount"] is None), event["fee"] or 0, int(event["fee"] is None), run_id))
            if market:
                db.execute("UPDATE markets SET fills=fills+1 WHERE run_id=? AND market=?", (run_id, market))
                db.execute("UPDATE market_details SET turnover=turnover+? WHERE run_id=? AND market=?", (event["amount"] or 0, run_id, market))
        elif kind == "resolved" and market:
            # A resolved market with no observed fills is not a trading settlement.
            row = db.execute("SELECT fills,settled FROM markets WHERE run_id=? AND market=?", (run_id, market)).fetchone()
            if row["fills"] and not row["settled"]:
                db.execute("UPDATE markets SET settled=1 WHERE run_id=? AND market=?", (run_id, market))
                db.execute("UPDATE market_details SET pnl=?,status='已结算' WHERE run_id=? AND market=?", (event["pnl"], run_id, market))
                db.execute("""UPDATE runs SET settled_markets=settled_markets+1,
                    known_settled_pnl=known_settled_pnl+?,missing_pnl=missing_pnl+? WHERE run_id=?""",
                           (event["pnl"] or 0, int(event["pnl"] is None), run_id))
            elif not row["fills"]:
                db.execute("UPDATE market_details SET status='无成交' WHERE run_id=? AND market=?", (run_id, market))
        elif kind in {"stopped", "unresolved"} and market:
            db.execute("UPDATE market_details SET status='未结算（已停止）' WHERE run_id=? AND market=? AND pnl IS NULL", (run_id, market))

    @staticmethod
    def _accumulate_trade(db, run_id, event):
        """A trade's status changes its contribution, never creates a second fill."""
        row = db.execute("SELECT payload FROM trade_details WHERE run_id=? AND trade_id=? AND order_id=?",
                         (run_id, event["trade_id"], event["order_id"])).fetchone()
        prior = json.loads(row[0]) if row else None
        event = _trade_revision(prior, event)
        if event is None:
            return
        for item, sign in ((prior, -1), (event, 1)):
            if item is None or item["trade_status"] == "FAILED":
                continue
            amount, fee, market = item.get("amount"), item.get("fee"), item.get("market")
            db.execute("""UPDATE runs SET fill_count=fill_count+?,fill_notional=fill_notional+?,
                missing_notional=missing_notional+?,known_fees=known_fees+?,missing_fees=missing_fees+? WHERE run_id=?""",
                       (sign, sign * (amount or 0), sign * int(amount is None), sign * (fee or 0), sign * int(fee is None), run_id))
            for kind in (["fill", "taker_fill"] if item.get("is_maker") is False else ["fill"]):
                db.execute("INSERT INTO kind_counts VALUES(?,?,?) ON CONFLICT(run_id,kind) DO UPDATE SET count=count+excluded.count",
                           (run_id, kind, sign))
            if market:
                db.execute("INSERT OR IGNORE INTO markets(run_id,market) VALUES(?,?)", (run_id, market))
                db.execute("UPDATE markets SET fills=fills+? WHERE run_id=? AND market=?", (sign, run_id, market))
                db.execute("INSERT OR IGNORE INTO market_details(run_id,market,last_time) VALUES(?,?,?)", (run_id, market, item.get("time") or 0))
                db.execute("UPDATE market_details SET turnover=turnover+?,last_time=MAX(last_time,?) WHERE run_id=? AND market=?",
                           (sign * (amount or 0), item.get("time") or 0, run_id, market))
        db.execute("INSERT INTO trade_details VALUES(?,?,?,?) ON CONFLICT(run_id,trade_id,order_id) DO UPDATE SET payload=excluded.payload",
                   (run_id, event["trade_id"], event["order_id"], json.dumps(event, allow_nan=False)))

    def orders_page(self, run_id, *, limit=10, offset=0, status=None, market=None, as_of=None, snapshot_event_id=None):
        """Page order snapshots at one journal cutoff so new events do not shift pages."""
        if type(limit) is not int or limit not in (10, 20, 50) or type(offset) is not int or offset < 0:
            raise ValueError("invalid order page")
        if status is not None and status not in ORDER_STATUSES | {"active", "failed"}:
            raise ValueError("invalid order status")
        if market is not None and (not isinstance(market, str) or len(market) > 200):
            raise ValueError("invalid market")
        stamp = time.time() if as_of is None else _number(as_of)
        if stamp is None or stamp <= 0 or stamp > time.time() + 1:
            raise ValueError("invalid order snapshot time")
        if snapshot_event_id is not None and (type(snapshot_event_id) is not int or snapshot_event_id < 0):
            raise ValueError("invalid snapshot event id")
        cte = """WITH selected AS (
            SELECT id,payload,
                   ROW_NUMBER() OVER (PARTITION BY json_extract(payload,'$.client_order_id') ORDER BY id DESC) AS n,
                   MIN(id) OVER (PARTITION BY json_extract(payload,'$.client_order_id')) AS first_id
            FROM events WHERE run_id=? AND kind='order' AND id<=?
              AND json_extract(payload,'$.client_order_id') IS NOT NULL
              AND json_extract(payload,'$.time')<=?
        ), filtered AS (SELECT * FROM selected WHERE n=1
            AND (? IS NULL OR json_extract(payload,'$.status')=?
              OR (?='active' AND json_extract(payload,'$.status') IN ('SUBMITTING','OPEN','PARTIAL','UNKNOWN'))
              OR (?='failed' AND json_extract(payload,'$.status')='REJECTED'))
            AND (? IS NULL OR json_extract(payload,'$.market')=?)) """
        with self._connect() as db:
            self._run(db, run_id)
            cutoff = snapshot_event_id if snapshot_event_id is not None else db.execute(
                "SELECT COALESCE(MAX(id),0) FROM events WHERE run_id=?", (run_id,)).fetchone()[0]
            args = (run_id, cutoff, stamp, status, status, status, status, market, market)
            total = db.execute(cte + "SELECT COUNT(*) FROM filtered", args).fetchone()[0]
            rows = db.execute(cte + "SELECT payload FROM filtered ORDER BY first_id DESC LIMIT ? OFFSET ?",
                              (*args, limit, offset)).fetchall()
            orders = [json.loads(row[0]) for row in rows]
            order_ids = [order["order_id"] for order in orders if order.get("order_id")]
            fills = {}
            if order_ids:
                fill_rows = db.execute("SELECT payload FROM events WHERE run_id=? AND kind='fill' AND id<=? "
                    "AND (json_extract(payload,'$.time')<=? OR json_extract(payload,'$.time') IS NULL) "
                    f"AND json_extract(payload,'$.order_id') IN ({','.join('?' for _ in order_ids)}) ORDER BY id",
                    (run_id, cutoff, stamp, *order_ids))
                for row in fill_rows:
                    fill = json.loads(row[0])
                    key = (fill.get("trade_id"), fill["order_id"])
                    prior = fills.get(key)
                    revision = _trade_revision(prior, fill)
                    if revision is not None:
                        fills[key] = revision
        for order in orders:
            actual = [f for f in fills.values() if f["order_id"] == order.get("order_id") and f.get("trade_status") != "FAILED"]
            complete = abs(sum(f.get("shares") or 0 for f in actual) - (order.get("filled_shares") or 0)) < 1e-6
            order["order_notional"] = order.get("amount")
            order["amount"] = sum(f["amount"] for f in actual) if complete and all(f.get("amount") is not None for f in actual) else None
            order["fee"] = sum(f["fee"] for f in actual) if complete and all(f.get("fee") is not None for f in actual) else None
            order["fills"] = actual
        return {"orders": orders, "total": total, "limit": limit, "offset": offset,
                "has_more": offset + len(orders) < total, "asOf": stamp, "snapshotEventId": cutoff}

    def runtime_stats(self, run_id, *, summary=None):
        """Current BTC reversal runtime projection."""
        summary = self.summary(run_id) if summary is None else summary
        with self._connect() as db:
            counts = {r["kind"]: r["count"] for r in db.execute("SELECT kind,count FROM kind_counts WHERE run_id=?", (run_id,))}
            traded = db.execute("SELECT COUNT(*) FROM markets WHERE run_id=? AND fills>0", (run_id,)).fetchone()[0]
            markets = [dict(r) for r in db.execute("""SELECT d.market,m.fills,d.turnover,d.pnl,d.status,d.last_time
                FROM market_details d JOIN markets m ON d.run_id=m.run_id AND d.market=m.market
                WHERE d.run_id=? ORDER BY d.last_time DESC LIMIT 50""", (run_id,))]
            orders, order_count, runtime_row = [], 0, None
            if self._has_table(db, "order_details"):
                orders = [json.loads(row[0]) for row in db.execute(
                    "SELECT payload FROM order_details WHERE run_id=? ORDER BY updated_at DESC,client_order_id LIMIT 50", (run_id,))]
                order_count = db.execute("SELECT COUNT(*) FROM order_details WHERE run_id=?", (run_id,)).fetchone()[0]
            if self._has_table(db, "platform_runtime"):
                runtime_row = db.execute("SELECT source_at,payload FROM platform_runtime WHERE run_id=?", (run_id,)).fetchone()
        runtime = None
        if runtime_row:
            at = runtime_row["source_at"]
            age = max(0, time.time() - at)
            runtime = {**json.loads(runtime_row["payload"]), "source_at": at,
                       "expires_at": at + RUNTIME_MAX_AGE, "age_seconds": age,
                       "stale": age > RUNTIME_MAX_AGE or at > time.time() + 1 or summary["completeness"] != "caught_up"}
        events = self.events(run_id, limit=20)["events"]
        for event in events:
            event["side"] = event["side"] or event.get("winner")
            if event["event"] == "resolved" and not event.get("has_observed_fills"):
                event["event"] = "resolved_empty"
        return {"available": True, "file": None, "quotes": counts.get("quote", 0),
                "fills": summary["fill_count"], "takers": counts.get("taker_fill", 0),
                "cancels": counts.get("cancel", 0), "markets": counts.get("reset", 0),
                "traded_markets": traded, "fill_notional": summary["fill_notional"],
                "fees": summary["fees"], "settled_markets": summary["settled_markets"],
                "pnl": summary["settled_pnl"], "pnl_semantics": summary["pnl_semantics"],
                "last_event": events[0]["event"] if events else None,
                "error": ("交易日志待核对" if summary["error"] or summary["invalid_records"]
                          else "引擎报告异常，请检查运行状态" if counts.get("error", 0) else None),
                "events": list(reversed(events)), "market_summaries": markets,
                "latency": summary.get("latency"), "runtime": runtime,
                "orders": orders, "order_count": order_count, "orders_truncated": order_count > len(orders)}

    def summary(self, run_id):
        with self._connect() as db:
            run = self._run(db, run_id)
            result = {key: run[key] for key in ("run_id", "mode", "account_id", "config_revision", "created_at",
                      "byte_offset", "record_count", "invalid_records", "duplicate_records", "event_count", "fill_count", "settled_markets")}
            result.update(fill_notional=None if run["missing_notional"] else run["fill_notional"],
                          known_fill_notional=run["fill_notional"],
                          fees=None if run["missing_fees"] else run["known_fees"],
                          known_fees=run["known_fees"], missing_fee_count=run["missing_fees"],
                          settled_pnl=run["known_settled_pnl"] if run["settled_markets"] and not run["missing_pnl"] else None,
                          pnl_semantics="engine_settlement_net_of_fees; not_wallet_reconciliation",
                          order_lifecycle_available=self._has_table(db, "order_details") and bool(db.execute(
                              "SELECT 1 FROM order_details WHERE run_id=? LIMIT 1", (run_id,)).fetchone()),
                          error=run["source_error"])
            try:
                source_bytes = Path(run["path"]).stat().st_size
                lag = max(0, source_bytes - run["byte_offset"])
            except OSError:
                source_bytes, lag = None, None
            result.update(source_bytes=source_bytes, lag_bytes=lag,
                          completeness=("incomplete" if run["source_error"] or run["invalid_records"]
                                        else "waiting" if lag is None else "catching_up" if lag else "caught_up"))
            now = time.time()
            grouped = {}
            for row in db.execute("""SELECT metric,time,duration_ms FROM latency_samples
                    WHERE run_id=? AND time>? AND time<=? ORDER BY metric,time,byte_offset""", (run_id, now-300, now)):
                grouped.setdefault(row["metric"], []).append((row["time"], float(row["duration_ms"])))
            latency = {"run_id": run_id, "mode": run["mode"], "as_of": now,
                       "window_seconds": 300, "sample_limit": LATENCY_LIMIT, "metrics": {}}
            for metric, samples in grouped.items():
                values = [sample[1] for sample in samples]
                ordered = sorted(values)
                latency["metrics"][metric] = {"latest_ms": values[-1], "p50_ms": ordered[(len(ordered)-1)//2],
                    "p95_ms": ordered[math.ceil(len(ordered)*.95)-1],
                    "p99_ms": ordered[math.ceil(len(ordered)*.99)-1], "max_ms": ordered[-1], "samples": len(values),
                    "latest_at": samples[-1][0], "expires_at": samples[0][0]+300,
                    "limit_reached": len(values) == LATENCY_LIMIT}
            result["latency"] = latency
            return result

    def list_runs_page(self, *, before_id=None, limit=50):
        """Return a bounded, stable page of runs without reading journal files."""
        limit = max(1, min(int(limit), 200))
        with self._connect() as db:
            args = []
            clause = ""
            if before_id is not None:
                clause = " WHERE rowid < ?"
                args.append(int(before_id))
            args.append(limit + 1)
            rows = list(db.execute("""SELECT rowid AS id,run_id,mode,account_id,config_revision,created_at
                FROM runs""" + clause + " ORDER BY rowid DESC LIMIT ?", args))
            runs = [dict(row) for row in rows[:limit]]
            return {"runs": runs, "next_before_id": runs[-1]["id"] if len(rows) > limit else None}

    def events(self, run_id, *, before_id=None, limit=100):
        limit = max(1, min(int(limit), 200))
        with self._connect() as db:
            self._run(db, run_id)
            args = [run_id]
            clause = ""
            if before_id is not None:
                clause = " AND id < ?"
                args.append(int(before_id))
            args.append(limit + 1)
            rows = list(db.execute("SELECT id,byte_offset,payload FROM events WHERE run_id=? AND kind!='platform_status'"
                                   + clause + " ORDER BY id DESC LIMIT ?", args))
            items = [{"id": row["id"], "byte_offset": row["byte_offset"], **json.loads(row["payload"])} for row in rows[:limit]]
            return {"run_id": run_id, "events": items,
                    "next_before_id": items[-1]["id"] if len(rows) > limit else None}

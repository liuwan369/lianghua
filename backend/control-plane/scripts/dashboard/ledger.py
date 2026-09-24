"""Bounded journal analytics. Never call ingestion from a trading/request loop.

Journal PnL is engine settlement PnL (payout - cost - fees), not wallet cash
reconciliation. Missing order identifiers prevent reliable order lifecycle metrics.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime, timezone
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
 byte_offset INTEGER NOT NULL, kind TEXT NOT NULL, stable_id TEXT, asset_id TEXT NOT NULL DEFAULT 'btc', payload TEXT NOT NULL,
 UNIQUE(run_id, byte_offset)
);
CREATE UNIQUE INDEX IF NOT EXISTS stable_event ON events(run_id, kind, stable_id)
 WHERE stable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_page ON events(run_id, id);
CREATE INDEX IF NOT EXISTS order_event_page ON events(run_id, kind, id);
CREATE TABLE IF NOT EXISTS markets (
 run_id TEXT NOT NULL REFERENCES runs(run_id), market TEXT NOT NULL, asset_id TEXT NOT NULL DEFAULT 'btc', round_id TEXT,
 fills INTEGER NOT NULL DEFAULT 0, settled INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(run_id, market)
);
CREATE TABLE IF NOT EXISTS kind_counts (
 run_id TEXT NOT NULL REFERENCES runs(run_id), kind TEXT NOT NULL, count INTEGER NOT NULL,
 PRIMARY KEY(run_id,kind)
);
CREATE TABLE IF NOT EXISTS market_details (
 run_id TEXT NOT NULL REFERENCES runs(run_id), market TEXT NOT NULL, asset_id TEXT NOT NULL DEFAULT 'btc', round_id TEXT,
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
 run_id TEXT NOT NULL REFERENCES runs(run_id), client_order_id TEXT NOT NULL, asset_id TEXT NOT NULL DEFAULT 'btc',
 accepted INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0,
 updated_at REAL NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(run_id,client_order_id)
);
CREATE TABLE IF NOT EXISTS trade_details (
 run_id TEXT NOT NULL REFERENCES runs(run_id), trade_id TEXT NOT NULL, order_id TEXT NOT NULL, asset_id TEXT NOT NULL DEFAULT 'btc',
 payload TEXT NOT NULL, PRIMARY KEY(run_id,trade_id,order_id)
);
CREATE TABLE IF NOT EXISTS market_aliases (
 run_id TEXT NOT NULL, market_id TEXT NOT NULL, market TEXT NOT NULL, asset_id TEXT NOT NULL DEFAULT 'btc', round_id TEXT,
 PRIMARY KEY(run_id,market_id)
);
CREATE INDEX IF NOT EXISTS market_alias_slug ON market_aliases(run_id,market);
CREATE TABLE IF NOT EXISTS settlement_details (
 run_id TEXT NOT NULL, market TEXT NOT NULL, market_id TEXT, asset_id TEXT NOT NULL DEFAULT 'btc', round_id TEXT,
 source_at REAL NOT NULL, verified INTEGER NOT NULL DEFAULT 0, pnl REAL, payload TEXT NOT NULL,
 PRIMARY KEY(run_id,market)
);
CREATE INDEX IF NOT EXISTS settlement_period ON settlement_details(run_id,source_at);
CREATE INDEX IF NOT EXISTS order_identity_history ON events(
 run_id,json_extract(payload,'$.client_order_id'),id DESC) WHERE kind='order';
CREATE INDEX IF NOT EXISTS order_market_history ON events(
 run_id,json_extract(payload,'$.market'),id DESC) WHERE kind='order';
CREATE INDEX IF NOT EXISTS fill_order_history ON events(
 run_id,json_extract(payload,'$.order_id'),id) WHERE kind='fill';
CREATE INDEX IF NOT EXISTS trade_market ON trade_details(run_id,json_extract(payload,'$.market'));
CREATE INDEX IF NOT EXISTS trade_economic_id ON trade_details(run_id,json_extract(payload,'$.trade_id'),json_extract(payload,'$.order_id'));
CREATE INDEX IF NOT EXISTS order_economic_id ON order_details(run_id,json_extract(payload,'$.client_order_id'));
CREATE TABLE IF NOT EXISTS projection_migrations (name TEXT PRIMARY KEY);
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
ASSET_ID_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z")


def _asset_id(value, *, default=None):
    """Unknown or malformed identity must never silently become BTC."""
    if isinstance(value, str):
        value = value.strip().lower()
        if ASSET_ID_RE.fullmatch(value):
            return value
    return default


def _asset_from(value):
    if not isinstance(value, dict):
        return None
    if value.get("asset_identity_invalid"):
        return None
    for key in ("asset_id", "assetId", "asset"):
        if value.get(key) is not None:
            return _asset_id(value[key])
    # Older BTC journals carry an unambiguous market slug, but no asset field.
    for key in ("market_slug", "market", "name", "marketSlug"):
        if re.fullmatch(r"btc-updown-5m-[0-9]+", value.get(key) or ""):
            return "btc"
    return None


def _query_asset(value):
    result = _asset_id(value)
    if value is not None and result is None:
        raise ValueError("invalid asset identity")
    return result


def _business_identity(value):
    return (_asset_from(value), value.get("market_id") or value.get("marketId") or value.get("market"),
            value.get("round_id") or value.get("roundId"))


def _economic_key(event, identifier):
    return json.dumps([*_business_identity(event), identifier], separators=(",", ":"))


def _identity_key(asset, value):
    """Namespace legacy SQLite keys so equal ids cannot cross assets."""
    if not isinstance(value, str) or not value:
        return value
    return value if asset == "btc" else f"{asset or 'unknown'}::{value}"


def _identity_value(asset, value):
    if not isinstance(value, str):
        return value
    prefix = f"{asset or 'unknown'}::"
    return value[len(prefix):] if asset != "btc" and value.startswith(prefix) else value


def _market_value(asset, value):
    if isinstance(value, str) and value.startswith("@round:"):
        value = json.loads(value[len("@round:"):])[0]
    return _identity_value(asset, value)


def _market_key(db, run_id, event):
    """Keep legacy keys unless a source explicitly reuses a market in another round."""
    asset = _asset_from(event) or ""
    key = _identity_key(asset, event.get("market"))
    row = db.execute("SELECT round_id FROM markets WHERE run_id=? AND market=? AND asset_id=?",
                     (run_id, key, asset)).fetchone()
    round_id = event.get("round_id")
    if row and row["round_id"] is not None and round_id is not None and row["round_id"] != round_id:
        return "@round:" + json.dumps([key, round_id], separators=(",", ":"))
    return key


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
    """Merge one economic trade's lifecycle revisions into one projection."""
    if not prior:
        return event
    ranks = {"MATCHED_NOT_BROADCASTED": 1, "MATCHED": 1, "RETRYING": 1,
             "MINED": 2, "CONFIRMED": 3, "FAILED": 0}
    old_status, new_status = prior.get("trade_status"), event.get("trade_status")
    old_rank, new_rank = ranks.get(old_status, -1), ranks.get(new_status, -1)
    old_time = _number(prior.get("engine_ts")) or _number(prior.get("time")) or 0
    new_time = _number(event.get("engine_ts")) or _number(event.get("time")) or 0
    fee_upgrade = (event.get("fee_source") == "reported" and event.get("fee") is not None
                   and event.get("fee") >= 0
                   and (prior.get("fee_source") != "reported" or prior.get("fee") is None))
    recovery = (old_status == "FAILED" and new_status in ranks and new_status != "FAILED"
                and new_time >= old_time)
    # The runtime treats CONFIRMED as terminal. A later journal record from a
    # restart must not regress it to FAILED; FAILED is only a valid transition
    # while the fill is still non-terminal.
    newer_failure = (new_status == "FAILED" and old_status not in ("CONFIRMED", "FAILED")
                     and new_time > old_time)
    if old_time > 0 and new_time > 0 and new_time < old_time:
        return None
    if new_status == old_status:
        if not fee_upgrade:
            return None
        # Fee-only revisions from the runtime intentionally omit the original
        # market, quantity and price fields. Preserve those economic fields;
        # replacing them with null would make a previously reconcilable fill
        # look incomplete.
        merged = dict(prior)
        for key in ("fee", "fee_source", "trade_status", "engine_ts", "time"):
            if event.get(key) is not None:
                merged[key] = event[key]
        merged["fee_estimate"] = None
        return merged
    if recovery or new_rank > old_rank or newer_failure:
        return {**prior, **{key: value for key, value in event.items() if value is not None}}
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
            "marketId", "roundId", "round_id", "name", "upTokenId", "downTokenId", "status", "reason", "lastStageDirection",
            "lastConfirmedDirection", "nextDirection", "resultScope", "resultReason")}
        result["assetId"] = _asset_from(source)
        result["marketId"] = result.get("marketId") or _text(source.get("market_id"))
        result["name"] = result.get("name") or _text(source.get("market_slug"))
        # `name` is retained as a display/compatibility field. It is not a
        # round identity unless the runtime explicitly supplies roundId.
        result["roundId"] = result.get("roundId") or result.get("round_id")
        result.pop("round_id", None)
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
    result = {"strategyId": _text(value.get("strategyId")) or "btc-reversal", "schemaVersion": 1,
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
    result["assetId"] = _asset_from(value)
    result["strategy_id"] = _text(value.get("strategy_id"))
    result["strategy_runtime"] = _strategy_projection(value.get("strategy_runtime"))
    snapshots = value.get("snapshots") if isinstance(value.get("snapshots"), list) else []
    # Keep the accepted paired snapshot lossless enough for the read-only
    # market DTO. Never rebuild it from the legacy token books below.
    result["snapshots"] = [json.loads(json.dumps(snapshot, allow_nan=False))
                            for snapshot in snapshots[:64] if isinstance(snapshot, dict)]
    positions = value.get("positions") if isinstance(value.get("positions"), list) else []
    result["positions"] = [{"tokenId": _text(p.get("tokenId")),
                            **{key: _number(p.get(key)) for key in ("shares", "costUsd", "realizedPnlUsd")}}
                           for p in positions[:1000] if isinstance(p, dict)]
    result["positions_complete"] = (isinstance(value.get("positions"), list) and len(positions) <= 1000
        and _number(value.get("positions_count")) == len(positions)
        and len(result["positions"]) == len(positions)
        and all(p["tokenId"] and p["shares"] is not None and p["shares"] >= 0
                and p["costUsd"] is not None and p["costUsd"] >= 0 for p in result["positions"]))
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
        item = {key: _text(market.get(key)) for key in ("id", "name", "roundId", "round_id")}
        item["assetId"] = _asset_from(market)
        item["id"] = item.get("id") or _text(market.get("marketId") or market.get("market_id"))
        item["name"] = item.get("name") or _text(market.get("marketSlug") or market.get("market_slug"))
        item["roundId"] = item.get("roundId") or item.get("round_id")
        item.pop("round_id", None)
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
    asset_id = _asset_from(record)
    result = {"event": record["event"], "asset_id": asset_id, "assetId": asset_id,
              "market": _text(record.get("market_slug")) or _text(record.get("market_id")),
              "side": record.get("side") if record.get("side") in ("UP", "DOWN", "up", "down") else None,
              "winner": record.get("winner") if record.get("winner") in ("UP", "DOWN", "up", "down") else None}
    if any(record.get(key) is not None and _asset_id(record[key]) is None for key in ("asset_id", "assetId", "asset")):
        result["asset_identity_invalid"] = True
    result["message"] = _text(record.get("message"), 500)
    result["source_event"] = _text(record.get("source_event"))
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
                  "market_id", "round_id", "transaction_id"):
        result[field] = _text(record.get(field))
    result["market_id"] = result["market_id"] or _text(record.get("marketId"))
    result["round_id"] = result["round_id"] or _text(record.get("roundId"))
    result["market"] = result["market"] or _text(record.get("marketSlug")) or result["market_id"]
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
    for field in ("created_at", "average_price", "filled_shares", "reserved_usd", "reserved_shares", "sign_latency_ms", "risk_metadata_latency_ms", "ack_latency_ms", "total_ack_latency_ms",
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
                # Keep existing projection databases readable while adding the
                # runtime-owned round identity.  The journal remains the source
                # of truth; these columns are only indexed projection fields.
                for table, column in (("events", "asset_id"),
                                      ("markets", "asset_id"), ("markets", "round_id"),
                                      ("market_details", "asset_id"),
                                      ("market_details", "round_id"),
                                      ("order_details", "asset_id"),
                                      ("trade_details", "asset_id"),
                                      ("market_aliases", "asset_id"),
                                      ("market_aliases", "round_id"),
                                      ("settlement_details", "asset_id"),
                                      ("settlement_details", "round_id")):
                    columns = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
                    if column not in columns:
                        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} TEXT NOT NULL DEFAULT 'btc'" if column == "asset_id"
                                   else f"ALTER TABLE {table} ADD COLUMN {column} TEXT")
                db.execute("CREATE INDEX IF NOT EXISTS market_asset ON markets(run_id,asset_id,market)")
                db.execute("CREATE INDEX IF NOT EXISTS market_detail_asset ON market_details(run_id,asset_id,market)")
                db.execute("CREATE INDEX IF NOT EXISTS alias_asset ON market_aliases(run_id,asset_id,market_id,market,round_id)")
                db.execute("CREATE INDEX IF NOT EXISTS settlement_asset ON settlement_details(run_id,asset_id,market)")
                # Older projections did not have round identity. Keep those
                # rows unknown until a runtime snapshot supplies roundId.
                db.execute("UPDATE markets SET round_id=(SELECT a.round_id FROM market_aliases a "
                           "WHERE a.run_id=markets.run_id AND a.market=markets.market) "
                           "WHERE round_id IS NULL")
                db.execute("UPDATE market_details SET round_id=(SELECT a.round_id FROM market_aliases a "
                           "WHERE a.run_id=market_details.run_id AND a.market=market_details.market) "
                           "WHERE round_id IS NULL")
                db.execute("UPDATE settlement_details SET round_id=(SELECT a.round_id FROM market_aliases a "
                           "WHERE a.run_id=settlement_details.run_id AND a.market=settlement_details.market) "
                           "WHERE round_id IS NULL")
                # Keep identity backfill independent from the older settlement
                # migration marker. Existing databases may already have the
                # settlement marker while still lacking round_id projections.
                if not db.execute("SELECT 1 FROM projection_migrations WHERE name='round_identity_v1'").fetchone():
                    for row in db.execute("SELECT run_id,payload FROM platform_runtime").fetchall():
                        runtime = json.loads(row["payload"])
                        identities = list(runtime.get("markets", []))
                        strategy = runtime.get("strategy_runtime") if isinstance(runtime.get("strategy_runtime"), dict) else {}
                        identities.extend(strategy.get("rounds", []) if isinstance(strategy.get("rounds"), list) else [])
                        if isinstance(strategy.get("currentRound"), dict):
                            identities.append(strategy["currentRound"])
                        for market in identities:
                            if not isinstance(market, dict):
                                continue
                            market_id = market.get("id") or market.get("marketId") or market.get("market_id")
                            market_name = (market.get("name") or market.get("marketSlug")
                                           or market.get("market_slug") or market_id)
                            if market_id and market_name:
                                market_asset = _asset_from(market) or _asset_from(runtime)
                                if market_asset:
                                    stored_id = _identity_key(market_asset, market_id)
                                    stored_name = _identity_key(market_asset, market_name)
                                    db.execute("INSERT INTO market_aliases(run_id,market_id,market,asset_id,round_id) VALUES(?,?,?,?,?) "
                                               "ON CONFLICT(run_id,market_id) DO UPDATE SET market=excluded.market,asset_id=excluded.asset_id,"
                                               "round_id=COALESCE(excluded.round_id,market_aliases.round_id)",
                                               (row["run_id"], stored_id, stored_name, market_asset,
                                                market.get("roundId") or market.get("round_id")))
                                    self._backfill_identity(db, row["run_id"], market_id, market_asset)
                    # Existing journals were already consumed; backfill only settlement projections once.
                    for row in db.execute("SELECT run_id,payload FROM events WHERE kind='settlement' ORDER BY id").fetchall():
                        event = json.loads(row["payload"])
                        event["market"] = event.get("market") or event.get("market_id")
                        if event["market"]:
                            alias = db.execute("SELECT market_id,round_id FROM market_aliases WHERE run_id=? AND market=?",
                                               (row["run_id"], event["market"])).fetchone()
                            if alias:
                                event["market_id"] = event.get("market_id") or alias["market_id"]
                                event["round_id"] = event.get("round_id") or alias["round_id"]
                            db.execute("INSERT OR IGNORE INTO markets(run_id,market,round_id) VALUES(?,?,?)",
                                       (row["run_id"], event["market"], event.get("round_id")))
                            db.execute("INSERT OR IGNORE INTO market_details(run_id,market,round_id,last_time) VALUES(?,?,?,?)",
                                       (row["run_id"], event["market"], event.get("round_id"), event.get("time") or 0))
                            self._record_settlement(db, row["run_id"], event)
                    db.execute("INSERT OR IGNORE INTO projection_migrations VALUES('platform_settlements_v1')")
                    db.execute("INSERT INTO projection_migrations VALUES('round_identity_v1')")

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

    @staticmethod
    def _apply_identity(db, run_id, event):
        """Resolve event identity only from an observed runtime market map.

        A slug, condition id, and round id are deliberately kept separate. If
        the runtime has not published a mapping yet, the unknown fields remain
        null; wall-clock time is never used to infer an old round.
        """
        asset_id = _asset_from(event)
        market_id = event.get("market_id")
        market = event.get("market")
        round_id = event.get("round_id")
        stored_market_id = _identity_key(asset_id, market_id)
        stored_market = _identity_key(asset_id, market)
        row = None
        if asset_id is None and not event.get("asset_identity_invalid"):
            candidates = []
            for candidate in db.execute("SELECT asset_id,market_id,market,round_id FROM market_aliases WHERE run_id=?", (run_id,)):
                candidate_asset = candidate["asset_id"] or None
                if (market_id and _identity_value(candidate_asset, candidate["market_id"]) != market_id
                        or round_id and candidate["round_id"] != round_id
                        or market and market not in (_identity_value(candidate_asset, candidate["market"]),
                                                    _identity_value(candidate_asset, candidate["market_id"]))):
                    continue
                if market_id or market or round_id:
                    candidates.append(candidate)
            if len(candidates) == 1:
                row = candidates[0]
                asset_id = row["asset_id"] or None
                event["asset_id"] = event["assetId"] = asset_id
        if row is None and market_id and asset_id is not None:
            row = db.execute("SELECT market_id,market,round_id FROM market_aliases "
                             "WHERE run_id=? AND asset_id=? AND market_id=?", (run_id, asset_id, stored_market_id)).fetchone()
        if row is None and market and asset_id is not None:
            rows = db.execute("SELECT market_id,market,round_id FROM market_aliases "
                              "WHERE run_id=? AND asset_id=? AND market=? LIMIT 2", (run_id, asset_id, stored_market)).fetchall()
            if len(rows) == 1:
                row = rows[0]
        if row is None and round_id and asset_id is not None:
            rows = db.execute("SELECT market_id,market,round_id FROM market_aliases "
                              "WHERE run_id=? AND asset_id=? AND round_id=? LIMIT 2", (run_id, asset_id, round_id)).fetchall()
            if len(rows) == 1:
                row = rows[0]
        if row is None:
            return event
        if ((market_id and _identity_value(asset_id, row["market_id"]) != market_id)
                or (round_id and row["round_id"] and row["round_id"] != round_id)):
            return event
        event["market_id"] = event.get("market_id") or _identity_value(asset_id, row["market_id"])
        # The observed runtime map is authoritative when a legacy slug and a
        # condition id disagree; never preserve a mixed identity pair.
        event["market"] = _identity_value(asset_id, row["market"])
        # The runtime mapping is authoritative. Never keep a conflicting
        # event round paired with the mapped market condition.
        event["round_id"] = row["round_id"] or event.get("round_id")
        return event

    @staticmethod
    def _revision_identity(db, run_id, event):
        """Fill omitted revision identity only when one observed entity matches."""
        if event["event"] == "fill" and event.get("trade_id") and event.get("order_id"):
            rows = db.execute("SELECT rowid,payload FROM trade_details WHERE run_id=? "
                              "AND json_extract(payload,'$.trade_id')=? AND json_extract(payload,'$.order_id')=?",
                              (run_id, event["trade_id"], event["order_id"])).fetchall()
        elif event["event"] == "order" and event.get("client_order_id"):
            rows = db.execute("SELECT rowid,payload FROM order_details WHERE run_id=? "
                              "AND json_extract(payload,'$.client_order_id')=?",
                              (run_id, event["client_order_id"])).fetchall()
        else:
            return None
        candidates = []
        for row in rows:
            prior = json.loads(row["payload"])
            if any(left is not None and right is not None and left != right
                   for left, right in zip(_business_identity(event), _business_identity(prior))):
                continue
            candidates.append((row["rowid"], prior))
        if len(candidates) != 1 or event.get("asset_identity_invalid"):
            return None
        rowid, prior = candidates[0]
        for key in ("asset_id", "assetId", "market_id", "market", "round_id"):
            if event.get(key) is None and prior.get(key) is not None:
                event[key] = prior[key]
        return rowid

    @staticmethod
    def _backfill_identity(db, run_id, market_id, asset_id=None):
        """Backfill events emitted before the first platform_status snapshot."""
        if not asset_id:
            return
        aliases = db.execute("SELECT market_id,market,round_id FROM market_aliases "
                             "WHERE run_id=? AND asset_id=? AND market_id=?", (run_id, asset_id, market_id)).fetchone()
        if aliases is None:
            return

        canonical, old_key, round_id = aliases["market"], aliases["market_id"], aliases["round_id"]
        if canonical and old_key and canonical != old_key:
            # Events without market_slug may have created a temporary
            # condition-id bucket before the runtime map arrived. Merge that
            # bucket into the canonical slug instead of splitting fills or
            # making the later settlement look untraded.
            old_market = db.execute("SELECT * FROM markets WHERE run_id=? AND asset_id=? AND market=?",
                                    (run_id, asset_id, old_key)).fetchone()
            new_market = db.execute("SELECT * FROM markets WHERE run_id=? AND asset_id=? AND market=?",
                                    (run_id, asset_id, canonical)).fetchone()
            if old_market and new_market:
                db.execute("UPDATE markets SET fills=fills+?,settled=MAX(settled,?),round_id=COALESCE(round_id,?) "
                           "WHERE run_id=? AND asset_id=? AND market=?",
                           (old_market["fills"], old_market["settled"], round_id, run_id, asset_id, canonical))
                db.execute("DELETE FROM markets WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, old_key))
            elif old_market:
                db.execute("UPDATE markets SET market=?,round_id=? WHERE run_id=? AND asset_id=? AND market=?",
                           (canonical, round_id, run_id, asset_id, old_key))
            old_detail = db.execute("SELECT * FROM market_details WHERE run_id=? AND asset_id=? AND market=?",
                                    (run_id, asset_id, old_key)).fetchone()
            new_detail = db.execute("SELECT * FROM market_details WHERE run_id=? AND asset_id=? AND market=?",
                                    (run_id, asset_id, canonical)).fetchone()
            if old_detail and new_detail:
                db.execute("UPDATE market_details SET turnover=turnover+?,pnl=COALESCE(pnl,?),"
                           "round_id=COALESCE(round_id,?),last_time=MAX(last_time,?) "
                           "WHERE run_id=? AND asset_id=? AND market=?",
                           (old_detail["turnover"], old_detail["pnl"], round_id,
                            old_detail["last_time"], run_id, asset_id, canonical))
                db.execute("DELETE FROM market_details WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, old_key))
            elif old_detail:
                db.execute("UPDATE market_details SET market=?,round_id=? WHERE run_id=? AND asset_id=? AND market=?",
                           (canonical, round_id, run_id, asset_id, old_key))
        db.execute("UPDATE markets SET round_id=COALESCE(round_id,?) WHERE run_id=? AND asset_id=? AND market=?",
                   (round_id, run_id, asset_id, canonical))
        db.execute("UPDATE market_details SET round_id=COALESCE(round_id,?) WHERE run_id=? AND asset_id=? AND market=?",
                   (round_id, run_id, asset_id, canonical))

        def update_payload(payload):
            try:
                event = json.loads(payload)
            except (TypeError, ValueError):
                return payload, False
            before = (event.get("asset_id"), event.get("market_id"), event.get("market"), event.get("round_id"))
            Ledger._apply_identity(db, run_id, event)
            after = (event.get("asset_id"), event.get("market_id"), event.get("market"), event.get("round_id"))
            return (json.dumps(event, allow_nan=False), before != after)

        for row in db.execute("SELECT id,payload FROM events WHERE run_id=?", (run_id,)).fetchall():
            payload, changed = update_payload(row["payload"])
            if changed:
                db.execute("UPDATE events SET payload=?,asset_id=? WHERE id=?", (payload, _asset_from(json.loads(payload)) or "", row["id"]))
        for table, where in (("order_details", "run_id=?"), ("trade_details", "run_id=?")):
            if not Ledger._has_table(db, table):
                continue
            for row in db.execute(f"SELECT rowid,payload FROM {table} WHERE {where}", (run_id,)).fetchall():
                payload, changed = update_payload(row["payload"])
                if changed:
                    db.execute(f"UPDATE {table} SET payload=?,asset_id=? WHERE rowid=?", (payload, _asset_from(json.loads(payload)) or "", row["rowid"]))
        # A settlement can arrive before the status snapshot and initially be
        # keyed by condition id. Move it to the canonical slug without losing
        # the already projected status or payout evidence.
        for row in db.execute("SELECT market,asset_id,payload FROM settlement_details "
                              "WHERE run_id=? AND asset_id IN (?, '') AND (market_id=? OR market=?)",
                              (run_id, asset_id, _identity_value(asset_id, market_id), canonical)).fetchall():
            payload, changed = update_payload(row["payload"])
            event = json.loads(payload)
            if _asset_from(event) != asset_id:
                continue
            target_market = _market_key(db, run_id, event)
            if event.get("market") and target_market != row["market"]:
                conflict = db.execute("SELECT 1 FROM settlement_details WHERE run_id=? AND asset_id=? AND market=?",
                                      (run_id, asset_id, target_market)).fetchone()
                if conflict is None:
                    db.execute("UPDATE settlement_details SET market=?,market_id=?,round_id=?,payload=?,asset_id=? "
                               "WHERE run_id=? AND asset_id=? AND market=?",
                               (target_market, event.get("market_id"), event.get("round_id"), payload, asset_id,
                                run_id, row["asset_id"], row["market"]))
                else:
                    # Merge payout evidence before removing a temporary condition
                    # bucket; a pending canonical row must not erase confirmation.
                    Ledger._record_settlement(db, run_id, event)
                    db.execute("DELETE FROM settlement_details WHERE run_id=? AND asset_id=? AND market=?",
                               (run_id, row["asset_id"], row["market"]))
            elif changed:
                db.execute("UPDATE settlement_details SET market_id=?,round_id=?,payload=? WHERE run_id=? AND asset_id=? AND market=?",
                           (event.get("market_id"), event.get("round_id"), payload, run_id, asset_id, row["market"]))

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
                    aliases = {"platform_error": "error", "platform_stopped": "stopped", "platform_settlement": "settlement",
                               "order_abandoned": "error"}
                    if isinstance(kind, str) and kind in aliases:
                        source_event = kind
                        kind = aliases[kind]
                        record = {**record, "event": kind, "source_event": source_event}
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
                    self._apply_identity(db, run_id, projected)
                    self._revision_identity(db, run_id, projected)
                    if kind == "resolved":
                        resolved_market_key = _market_key(db, run_id, projected) if projected.get("market") else None
                        prior_market = db.execute("SELECT fills FROM markets WHERE run_id=? AND asset_id=? AND market=?",
                                                  (run_id, projected.get("asset_id") or "", resolved_market_key)).fetchone() \
                            if resolved_market_key else None
                        projected["has_observed_fills"] = bool(prior_market and prior_market["fills"])
                        if not projected["has_observed_fills"]:
                            projected["pnl"] = None
                    stable_id = None
                    for key in ("event_id", "eventId") + (("fill_id", "trade_id", "tradeId") if kind == "fill" else ()):
                        candidate = record.get(key)
                        if isinstance(candidate, (str, int)) and not isinstance(candidate, bool) and str(candidate):
                            stable_id = f"{key}:{candidate}"
                            if kind == "fill" and key not in ("event_id", "eventId"):
                                # A trade id identifies the economic fill, not
                                # one status/fee update of it.
                                stable_id += ":" + hashlib.sha256(json.dumps(projected, sort_keys=True).encode()).hexdigest()
                            break
                    asset_id = projected.get("asset_id") or ""
                    if stable_id:
                        stable_id = _economic_key(projected, stable_id)
                    inserted = db.execute("INSERT OR IGNORE INTO events(run_id,byte_offset,kind,stable_id,asset_id,payload) VALUES(?,?,?,?,?,?)",
                                          (run_id, record_offset, kind, stable_id, asset_id, json.dumps(projected, allow_nan=False))).rowcount
                    if not inserted:
                        db.execute("UPDATE runs SET duplicate_records=duplicate_records+1 WHERE run_id=?", (run_id,))
                        continue
                    result["inserted"] += 1
                    self._accumulate(db, run_id, projected)
                    if runtime is not None:
                        accepted_runtime = db.execute("""INSERT INTO platform_runtime VALUES(?,?,?)
                            ON CONFLICT(run_id) DO UPDATE SET source_at=excluded.source_at,payload=excluded.payload
                            WHERE excluded.source_at>=platform_runtime.source_at""",
                                   (run_id, at, json.dumps(runtime, allow_nan=False))).rowcount
                        if not accepted_runtime:
                            continue
                        rounds = runtime.get("strategy_runtime") or {}
                        identities = runtime["markets"] + [
                            {"id": item.get("marketId"), "name": item.get("name"), "assetId": item.get("assetId"),
                             "roundId": item.get("roundId") or item.get("round_id")}
                            for item in rounds.get("rounds", []) if isinstance(item, dict)]
                        if isinstance(rounds.get("currentRound"), dict):
                            identities.append({"id": rounds["currentRound"].get("marketId"),
                                               "name": rounds["currentRound"].get("name"),
                                               "assetId": rounds["currentRound"].get("assetId"),
                                               "roundId": rounds["currentRound"].get("roundId")
                                                         or rounds["currentRound"].get("round_id")})
                        changed_identity_ids = set()
                        for identity_row in identities:
                            identity_id = identity_row.get("id") or identity_row.get("marketId") \
                                or identity_row.get("market_id")
                            identity_name = identity_row.get("name") or identity_row.get("marketSlug") \
                                or identity_row.get("market_slug") or identity_id
                            identity_round = identity_row.get("roundId") or identity_row.get("round_id")
                            if identity_id and identity_name:
                                asset_id = _asset_from(identity_row) or runtime.get("assetId")
                                if not asset_id:
                                    continue
                                stored_id = _identity_key(asset_id, identity_id)
                                stored_name = _identity_key(asset_id, identity_name)
                                prior_alias = db.execute(
                                    "SELECT market,round_id FROM market_aliases WHERE run_id=? AND asset_id=? AND market_id=?",
                                    (run_id, asset_id, stored_id)).fetchone()
                                db.execute("INSERT INTO market_aliases(run_id,market_id,market,asset_id,round_id) VALUES(?,?,?,?,?) "
                                           "ON CONFLICT(run_id,market_id) DO UPDATE SET market=excluded.market,"
                                           "asset_id=excluded.asset_id,round_id=COALESCE(excluded.round_id,market_aliases.round_id)",
                                           (run_id, stored_id, stored_name, asset_id, identity_round))
                                if (prior_alias is None or prior_alias["market"] != stored_name
                                        or (identity_round is not None and prior_alias["round_id"] != identity_round)):
                                    changed_identity_ids.add((stored_id, asset_id))
                        # platform_status is frequent. Only scan historical
                        # projection rows when an observed identity actually
                        # adds or changes a market/round mapping.
                        for identity_id, identity_asset in changed_identity_ids:
                            self._backfill_identity(db, run_id, identity_id, identity_asset)
                        # A settlement can be emitted before the next status snapshot. Revisit
                        # pending settlement rows once authoritative positions arrive.
                        if self._has_table(db, "settlement_details"):
                            for settlement in db.execute(
                                    "SELECT market,market_id,asset_id,round_id,payload FROM settlement_details WHERE run_id=? AND verified=1", (run_id,)):
                                payload = json.loads(settlement["payload"])
                                coverage = self._coverage_from_runtime(runtime, settlement["market_id"],
                                    _market_value(settlement["asset_id"], settlement["market"]),
                                    settlement["round_id"], settlement["asset_id"])
                                if coverage is not None and payload.get("coverage") is None:
                                    payload["coverage"] = coverage
                                    db.execute("UPDATE settlement_details SET payload=? WHERE run_id=? AND market=?",
                                               (json.dumps(payload, allow_nan=False), run_id, settlement["market"]))
                                self._refresh_settlement(db, run_id, settlement["market"], settlement["asset_id"])
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
        asset_id = _asset_from(event) or ""
        market_key = _market_key(db, run_id, event)
        if kind == "fill" and event.get("trade_status") and event.get("trade_id") and event.get("order_id"):
            Ledger._accumulate_trade(db, run_id, event)
            return
        db.execute("INSERT INTO kind_counts VALUES(?,?,1) ON CONFLICT(run_id,kind) DO UPDATE SET count=count+1", (run_id, kind))
        if kind == "fill" and event["is_maker"] is False:
            db.execute("INSERT INTO kind_counts VALUES(?,'taker_fill',1) ON CONFLICT(run_id,kind) DO UPDATE SET count=count+1", (run_id,))
        if kind == "order" and event["client_order_id"] and event["status"]:
            prior_id = Ledger._revision_identity(db, run_id, event)
            prior = db.execute("SELECT * FROM order_details WHERE rowid=?", (prior_id,)).fetchone() if prior_id else None
            order_key = prior["client_order_id"] if prior else _economic_key(event, event["client_order_id"])
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
            db.execute("""INSERT INTO order_details
                (run_id,client_order_id,asset_id,accepted,cancelled,updated_at,payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,client_order_id)
                DO UPDATE SET accepted=excluded.accepted,cancelled=excluded.cancelled,
                updated_at=excluded.updated_at,payload=excluded.payload""",
                       (run_id, order_key, asset_id, int(accepted or bool(prior and prior["accepted"])),
                        int(cancelled or bool(prior and prior["cancelled"])), updated_at, payload))
        if market:
            db.execute("INSERT OR IGNORE INTO markets(run_id,market,asset_id,round_id) VALUES(?,?,?,?)",
                       (run_id, market_key, asset_id, event.get("round_id")))
            db.execute("UPDATE markets SET round_id=COALESCE(round_id,?) WHERE run_id=? AND asset_id=? AND market=?",
                       (event.get("round_id"), run_id, asset_id, market_key))
            db.execute("INSERT INTO market_details(run_id,market,asset_id,round_id,last_time) VALUES(?,?,?,?,?) "
                       "ON CONFLICT(run_id,market) DO UPDATE SET round_id=COALESCE(excluded.round_id,market_details.round_id),"
                       "asset_id=excluded.asset_id,last_time=MAX(last_time,excluded.last_time)",
                       (run_id, market_key, asset_id, event.get("round_id"), event["time"] or 0))
        if kind == "fill":
            db.execute("""UPDATE runs SET fill_count=fill_count+1,fill_notional=fill_notional+?,
                missing_notional=missing_notional+?,known_fees=known_fees+?,missing_fees=missing_fees+? WHERE run_id=?""",
                       (event["amount"] or 0, int(event["amount"] is None), event["fee"] or 0, int(event["fee"] is None), run_id))
            if market:
                db.execute("UPDATE markets SET fills=fills+1 WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, market_key))
                db.execute("UPDATE market_details SET turnover=turnover+? WHERE run_id=? AND asset_id=? AND market=?", (event["amount"] or 0, run_id, asset_id, market_key))
        elif kind == "resolved" and market:
            # A resolved market with no observed fills is not a trading settlement.
            row = db.execute("SELECT fills,settled FROM markets WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, market_key)).fetchone()
            if row["fills"] and not row["settled"]:
                db.execute("UPDATE markets SET settled=1 WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, market_key))
                db.execute("UPDATE market_details SET pnl=?,status='已结算' WHERE run_id=? AND asset_id=? AND market=?", (event["pnl"], run_id, asset_id, market_key))
                db.execute("""UPDATE runs SET settled_markets=settled_markets+1,
                    known_settled_pnl=known_settled_pnl+?,missing_pnl=missing_pnl+? WHERE run_id=?""",
                           (event["pnl"] or 0, int(event["pnl"] is None), run_id))
            elif not row["fills"]:
                db.execute("UPDATE market_details SET status='无成交' WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, market_key))
        elif kind == "settlement" and market:
            Ledger._record_settlement(db, run_id, event)
        elif kind in {"stopped", "unresolved"} and market:
            db.execute("UPDATE market_details SET status='未结算（已停止）' WHERE run_id=? AND asset_id=? AND market=? AND pnl IS NULL", (run_id, asset_id, market_key))

    @staticmethod
    def _accumulate_trade(db, run_id, event):
        """A trade's status changes its contribution, never creates a second fill."""
        prior_id = Ledger._revision_identity(db, run_id, event)
        row = db.execute("SELECT * FROM trade_details WHERE rowid=?", (prior_id,)).fetchone() if prior_id else None
        asset_id = _asset_from(event) or ""
        trade_key = row["trade_id"] if row else _economic_key(event, event["trade_id"])
        order_key = row["order_id"] if row else _economic_key(event, event["order_id"])
        prior = json.loads(row["payload"]) if row else None
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
                market_key = _market_key(db, run_id, item)
                db.execute("INSERT OR IGNORE INTO markets(run_id,market,asset_id,round_id) VALUES(?,?,?,?)",
                           (run_id, market_key, asset_id, item.get("round_id")))
                db.execute("UPDATE markets SET round_id=COALESCE(round_id,?) WHERE run_id=? AND asset_id=? AND market=?",
                           (item.get("round_id"), run_id, asset_id, market_key))
                db.execute("UPDATE markets SET fills=fills+? WHERE run_id=? AND asset_id=? AND market=?", (sign, run_id, asset_id, market_key))
                db.execute("INSERT OR IGNORE INTO market_details(run_id,market,asset_id,round_id,last_time) VALUES(?,?,?,?,?)",
                           (run_id, market_key, asset_id, item.get("round_id"), item.get("time") or 0))
                db.execute("UPDATE market_details SET round_id=COALESCE(?,round_id),turnover=turnover+?,"
                           "last_time=MAX(last_time,?) WHERE run_id=? AND asset_id=? AND market=?",
                           (item.get("round_id"), sign * (amount or 0), item.get("time") or 0, run_id, asset_id, market_key))
        db.execute("INSERT INTO trade_details(run_id,trade_id,order_id,asset_id,payload) VALUES(?,?,?,?,?) ON CONFLICT(run_id,trade_id,order_id) DO UPDATE SET payload=excluded.payload,asset_id=excluded.asset_id",
                   (run_id, trade_key, order_key, asset_id, json.dumps(event, allow_nan=False)))
        for item in (prior, event):
            if item and item.get("market"):
                Ledger._refresh_settlement(db, run_id, _market_key(db, run_id, item), asset_id)

    @staticmethod
    def _record_settlement(db, run_id, event):
        asset_id = _asset_from(event) or ""
        market_key = _market_key(db, run_id, event)
        prior = db.execute("SELECT verified,source_at,payload FROM settlement_details WHERE run_id=? AND asset_id=? AND market=?",
                           (run_id, asset_id, market_key)).fetchone()
        verified = event.get("payout_verified") is True
        if prior and (prior["verified"] and not verified or prior["source_at"] > (event.get("time") or 0)):
            return
        payload = dict(event)
        payload["coverage"] = None
        row = db.execute("SELECT source_at,payload FROM platform_runtime WHERE run_id=?", (run_id,)).fetchone()
        if row and event.get("time") and 0 <= event["time"] - row["source_at"] <= RUNTIME_MAX_AGE:
            payload["coverage"] = Ledger._coverage_from_runtime(
                json.loads(row["payload"]), event.get("market_id"), event.get("market"), event.get("round_id"), asset_id)
        if payload["coverage"] is None and prior:
            payload["coverage"] = json.loads(prior["payload"]).get("coverage")
        db.execute("""INSERT INTO settlement_details
            (run_id,market,market_id,asset_id,round_id,source_at,verified,pnl,payload)
            VALUES(?,?,?,?,?,?,?,?,?)
            ON CONFLICT(run_id,market) DO UPDATE SET market_id=COALESCE(excluded.market_id,settlement_details.market_id),
            asset_id=excluded.asset_id,
            round_id=COALESCE(excluded.round_id,settlement_details.round_id),source_at=excluded.source_at,
            verified=excluded.verified,payload=excluded.payload""",
                   (run_id, market_key, event.get("market_id"), asset_id, event.get("round_id"),
                    event.get("time") or 0, int(verified), None, json.dumps(payload, allow_nan=False)))
        Ledger._refresh_settlement(db, run_id, market_key, asset_id)

    @staticmethod
    def _coverage_from_runtime(runtime, market_id, market, round_id=None, asset_id=None):
        if not isinstance(runtime, dict) or runtime.get("positions_complete") is not True:
            return None
        if (runtime.get("risk") or {}).get("reconciliationRequired"):
            return None
        strategy = runtime.get("strategy_runtime") or {}
        rounds = [strategy.get("currentRound")] + strategy.get("rounds", [])
        matches = {}
        for candidate in rounds:
            if not isinstance(candidate, dict):
                continue
            candidate_round = candidate.get("roundId") or candidate.get("round_id")
            # A settlement without an explicit round must not borrow coverage
            # from a runtime round that does have one. This avoids carrying a
            # position across consecutive rounds sharing a condition id.
            if round_id is not None and candidate_round != round_id:
                continue
            if round_id is None and candidate_round is not None:
                continue
            if _asset_from(candidate) != (asset_id or None):
                continue
            if market_id is not None and candidate.get("marketId") != market_id:
                continue
            if market_id is None and (not market or candidate.get("name") != market):
                continue
            tokens = (candidate.get("upTokenId"), candidate.get("downTokenId"))
            shares = (candidate.get("upShares"), candidate.get("downShares"))
            if all(tokens) and all(_number(value) is not None and value >= 0 for value in shares):
                matches.setdefault(_business_identity(candidate), dict(zip(tokens, shares)))
        return next(iter(matches.values())) if len(matches) == 1 else None

    @staticmethod
    def _refresh_settlement(db, run_id, market, asset_id=None):
        if not asset_id:
            return
        row = db.execute("SELECT * FROM settlement_details WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, market)).fetchone()
        if row is None:
            return
        payload = json.loads(row["payload"])
        pnl = None
        reason = "payout_unverified"
        if row["verified"]:
            round_id = row["round_id"]
            trades = [json.loads(item[0]) for item in db.execute(
                "SELECT payload FROM trade_details WHERE run_id=? AND json_extract(payload,'$.market')=? "
                "AND json_extract(payload,'$.round_id') IS ? AND COALESCE(json_extract(payload,'$.asset_id'),asset_id)=?",
                (run_id, _market_value(asset_id, market), round_id, asset_id))]
            trades = [item for item in trades if item.get("trade_status") != "FAILED"]
            coverage = payload.get("coverage")
            reason = "cost_basis_unverified"
            if (trades and isinstance(coverage, dict)
                    and all(item.get("trade_status") == "CONFIRMED" and item.get("fee_source") == "reported"
                            and item.get("amount") is not None and item.get("fee") is not None
                            and item["fee"] >= 0 and item.get("shares") is not None
                            and item.get("direction") in ("BUY", "SELL") and item.get("token_id") in coverage
                            for item in trades)):
                net_shares = {token: 0.0 for token in coverage}
                net_cost = 0.0
                for item in trades:
                    sign = 1 if item["direction"] == "BUY" else -1
                    net_shares[item["token_id"]] += sign * item["shares"]
                    net_cost += sign * item["amount"] + item["fee"]
                if all(abs(net_shares[token] - shares) < 1e-6 for token, shares in coverage.items()):
                    pnl = _number(payload["credited_usd"] - net_cost)
                    reason = None if pnl is not None else "invalid_pnl"
        payload.update(pnl=pnl, accounting_state="confirmed" if row["verified"] else "pending", pnl_error=reason)
        db.execute("UPDATE settlement_details SET pnl=?,payload=? WHERE run_id=? AND asset_id=? AND market=?",
                   (pnl, json.dumps(payload, allow_nan=False), run_id, asset_id, market))
        prior = db.execute("SELECT m.settled,m.fills,d.pnl FROM markets m JOIN market_details d "
                           "ON d.run_id=m.run_id AND d.asset_id=m.asset_id AND d.market=m.market WHERE m.run_id=? AND m.asset_id=? AND m.market=?",
                           (run_id, asset_id, market)).fetchone()
        if row["verified"] and prior and prior["fills"]:
            settled, old_pnl = prior["settled"], prior["pnl"]
            db.execute("UPDATE markets SET settled=1 WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, market))
            db.execute("UPDATE market_details SET pnl=?,status='已结算' WHERE run_id=? AND asset_id=? AND market=?", (pnl, run_id, asset_id, market))
            db.execute("""UPDATE runs SET settled_markets=settled_markets+?,
                known_settled_pnl=known_settled_pnl+?,missing_pnl=missing_pnl+? WHERE run_id=?""",
                       (int(not settled), (pnl or 0) - ((old_pnl or 0) if settled else 0),
                        int(pnl is None) - int(bool(settled) and old_pnl is None), run_id))
        elif prior and not prior["fills"]:
            db.execute("UPDATE market_details SET status='无成交' WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, market))
        elif prior and not prior["settled"]:
            db.execute("UPDATE market_details SET status='待结算' WHERE run_id=? AND asset_id=? AND market=?", (run_id, asset_id, market))

    def orders_page(self, run_id, *, limit=10, offset=0, status=None, market=None, asset_id=None, market_id=None, round_id=None, as_of=None, snapshot_event_id=None):
        """Page order snapshots at one journal cutoff so new events do not shift pages."""
        if type(limit) is not int or limit not in (10, 20, 50) or type(offset) is not int or offset < 0:
            raise ValueError("invalid order page")
        if status is not None and status not in ORDER_STATUSES | {"active", "failed"}:
            raise ValueError("invalid order status")
        if market is not None and (not isinstance(market, str) or len(market) > 200):
            raise ValueError("invalid market")
        asset_id = _query_asset(asset_id)
        stamp = time.time() if as_of is None else _number(as_of)
        if stamp is None or stamp <= 0 or stamp > time.time() + 1:
            raise ValueError("invalid order snapshot time")
        if snapshot_event_id is not None and (type(snapshot_event_id) is not int or snapshot_event_id < 0):
            raise ValueError("invalid snapshot event id")
        cte = """WITH selected AS (
            SELECT e.id,e.payload,e.asset_id,
                   (SELECT MIN(first.id) FROM events first WHERE first.run_id=e.run_id AND first.kind='order'
                    AND json_extract(first.payload,'$.client_order_id')=json_extract(e.payload,'$.client_order_id')
                    AND NULLIF(first.asset_id,'') IS NULLIF(e.asset_id,'')
                    AND COALESCE(json_extract(first.payload,'$.market_id'),json_extract(first.payload,'$.market'))
                        IS COALESCE(json_extract(e.payload,'$.market_id'),json_extract(e.payload,'$.market'))
                    AND json_extract(first.payload,'$.round_id') IS json_extract(e.payload,'$.round_id')) AS first_id
            FROM events e WHERE e.run_id=? AND e.kind='order' AND e.id<=?
              AND json_extract(e.payload,'$.client_order_id') IS NOT NULL
              AND json_extract(e.payload,'$.time')<=?
              AND NOT EXISTS (SELECT 1 FROM events newer WHERE newer.run_id=e.run_id AND newer.kind='order'
                  AND json_extract(newer.payload,'$.client_order_id')=json_extract(e.payload,'$.client_order_id')
                  AND NULLIF(newer.asset_id,'') IS NULLIF(e.asset_id,'')
                  AND COALESCE(json_extract(newer.payload,'$.market_id'),json_extract(newer.payload,'$.market'))
                      IS COALESCE(json_extract(e.payload,'$.market_id'),json_extract(e.payload,'$.market'))
                  AND json_extract(newer.payload,'$.round_id') IS json_extract(e.payload,'$.round_id')
                  AND (COALESCE(json_extract(newer.payload,'$.updated_at'),json_extract(newer.payload,'$.time'))
                         > COALESCE(json_extract(e.payload,'$.updated_at'),json_extract(e.payload,'$.time'))
                       OR (COALESCE(json_extract(newer.payload,'$.updated_at'),json_extract(newer.payload,'$.time'))
                           IS COALESCE(json_extract(e.payload,'$.updated_at'),json_extract(e.payload,'$.time')) AND newer.id>e.id))
                  AND newer.id<=? AND json_extract(newer.payload,'$.time')<=?)
        ), filtered AS (SELECT * FROM selected WHERE 1=1
            AND (? IS NULL OR json_extract(payload,'$.status')=?
              OR (?='active' AND json_extract(payload,'$.status') IN ('SUBMITTING','OPEN','PARTIAL','UNKNOWN'))
              OR (?='failed' AND json_extract(payload,'$.status')='REJECTED'))
            AND (? IS NULL OR asset_id=? )
            AND (? IS NULL OR json_extract(payload,'$.market_id')=?)
            AND (? IS NULL OR json_extract(payload,'$.round_id')=?)
            AND (? IS NULL OR json_extract(payload,'$.market')=?))"""
        with self._connect() as db:
            self._run(db, run_id)
            cutoff = snapshot_event_id if snapshot_event_id is not None else db.execute(
                "SELECT COALESCE(MAX(id),0) FROM events WHERE run_id=?", (run_id,)).fetchone()[0]
            aliases = []
            if market and market_id is None and round_id is None and self._has_table(db, "market_aliases"):
                aliases = [item for item in db.execute("SELECT asset_id,market,market_id,round_id FROM market_aliases "
                           "WHERE run_id=? AND (? IS NULL OR asset_id=?)", (run_id, asset_id, asset_id))
                           if market in (_identity_value(item["asset_id"], item["market"]),
                                         _identity_value(item["asset_id"], item["market_id"]), item["round_id"])]
                if len(aliases) > 1:
                    raise ValueError("ambiguous market identity; supply assetId, marketId and roundId")
            alias = aliases[0] if aliases else None
            legacy_market = (_identity_value(alias["asset_id"], alias["market"]) if alias else market) if market_id is None and round_id is None else None
            args = (run_id, cutoff, stamp, cutoff, stamp, status, status, status, status,
                    asset_id, asset_id, market_id, market_id, round_id, round_id,
                    legacy_market, legacy_market)
            total = db.execute(cte + "SELECT COUNT(*) FROM filtered", args).fetchone()[0]
            rows = db.execute(cte + "SELECT payload FROM filtered ORDER BY first_id DESC LIMIT ? OFFSET ?",
                              (*args, limit, offset)).fetchall()
            orders = [json.loads(row[0]) for row in rows]
            order_ids = [order["order_id"] for order in orders if order.get("order_id")]
            fills = {}
            if order_ids:
                fill_rows = db.execute("SELECT payload FROM events WHERE run_id=? AND kind='fill' AND id<=? "
                    "AND (json_extract(payload,'$.time')<=? OR json_extract(payload,'$.time') IS NULL) "
                    "AND (? IS NULL OR asset_id=?) "
                    f"AND json_extract(payload,'$.order_id') IN ({','.join('?' for _ in order_ids)}) ORDER BY id",
                    (run_id, cutoff, stamp, asset_id, asset_id, *order_ids))
                for row in fill_rows:
                    fill = json.loads(row[0])
                    key = (*_business_identity(fill), fill.get("trade_id"), fill["order_id"])
                    prior = fills.get(key)
                    revision = _trade_revision(prior, fill)
                    if revision is not None:
                        fills[key] = revision
        for order in orders:
            actual = [f for f in fills.values()
                      if f["order_id"] == order.get("order_id")
                      and _business_identity(f) == _business_identity(order)
                      and f.get("trade_status") != "FAILED"]
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
            markets = [dict(r) for r in db.execute("""SELECT d.market,d.asset_id,COALESCE(m.round_id,d.round_id) AS round_id,
                m.fills,d.turnover,d.pnl,d.status,d.last_time
                FROM market_details d JOIN markets m ON d.run_id=m.run_id AND d.asset_id=m.asset_id AND d.market=m.market
                WHERE d.run_id=? ORDER BY d.last_time DESC LIMIT 50""", (run_id,))]
            for market in markets:
                market["market"] = _market_value(market.get("asset_id"), market.get("market"))
                market["assetId"] = market.get("asset_id")
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
                "fees": summary["fees"], "estimated_fees": summary.get("estimated_fees", 0),
                "settled_markets": summary["settled_markets"],
                "pnl": summary["settled_pnl"], "pnl_semantics": summary["pnl_semantics"],
                "settled_wins": summary.get("settled_wins", 0),
                "settled_losses": summary.get("settled_losses", 0),
                "settled_draws": summary.get("settled_draws", 0),
                "pending_settlements": summary.get("pending_settlements", 0),
                "settled_pnl_pending": summary.get("settled_pnl_pending", 0),
                "win_rate": summary.get("win_rate"),
                "last_event": events[0]["event"] if events else None,
                "error": ("交易日志待核对" if summary["error"] or summary["invalid_records"]
                          else "引擎报告异常，请检查运行状态" if counts.get("error", 0) else None),
                "events": list(reversed(events)), "market_summaries": markets,
                "latency": summary.get("latency"), "runtime": runtime,
                "orders": orders, "order_count": order_count, "orders_truncated": order_count > len(orders)}

    def position(self, run_id, round_id=None, *, asset_id=None, market_id=None):
        """Return the latest projected BTC reversal round position.

        This reads the platform status projection only.  It never queries the
        exchange from an HTTP request and reports an unavailable/stale result
        when the projection has no authoritative position snapshot.
        """
        asset_id = _query_asset(asset_id)
        unavailable = {"available": False, "stale": True, "runId": run_id, "assetId": asset_id,
                       "roundId": round_id,
                       "marketId": None, "stage": None, "confirmations": None, "yesShares": None,
                       "noShares": None, "averagePrice": None, "occupiedUsd": None,
                       "outcomePnl": {"yes": None, "no": None}, "updatedAt": None}
        with self._connect() as db:
            run = self._run(db, run_id)
            if not self._has_table(db, "platform_runtime"):
                return {**unavailable, "error": "position projection unavailable"}
            row = db.execute("SELECT source_at,payload FROM platform_runtime WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            return {**unavailable, "error": "position projection pending"}
        try:
            runtime = json.loads(row["payload"])
        except (TypeError, ValueError):
            return {**unavailable, "error": "position projection invalid"}
        if not isinstance(runtime, dict):
            return {**unavailable, "error": "position projection invalid"}
        now, at = time.time(), row["source_at"]
        error = "position snapshot expired" if now - at > RUNTIME_MAX_AGE or at > now + 1 else None
        try:
            caught_up = Path(run["path"]).stat().st_size == run["byte_offset"]
        except OSError:
            caught_up = False
        if run["source_error"] or run["invalid_records"] or not caught_up:
            error = "position projection incomplete"
        if runtime.get("status") != "running":
            error = "runtime is not running"
        if (runtime.get("risk") or {}).get("reconciliationRequired"):
            error = "account reconciliation pending"
        strategy = runtime.get("strategy_runtime") if isinstance(runtime, dict) else None
        candidates = []
        if isinstance(strategy, dict):
            current = strategy.get("currentRound")
            if isinstance(current, dict):
                candidates.append(current)
            candidates.extend(item for item in strategy.get("rounds", []) if isinstance(item, dict))
        selected = None
        matches = {}
        legacy_market_lookup = (market_id is None and isinstance(round_id, str) and round_id.startswith("0x"))
        if round_id is None and market_id is None and isinstance(strategy, dict) and isinstance(strategy.get("currentRound"), dict):
            candidates = [strategy["currentRound"]]
        for item in candidates:
            if (((round_id is None or item.get("roundId") == round_id)
                 or (legacy_market_lookup and item.get("marketId") == round_id))
                    and (market_id is None or item.get("marketId") == market_id)
                    and (asset_id is None or _asset_from(item) == asset_id)):
                matches.setdefault(_business_identity(item), item)
        if len(matches) > 1:
            return {**unavailable, "error": "ambiguous round position; supply assetId and marketId", "updatedAt": at}
        selected = next(iter(matches.values()), None)
        if selected is None or not selected.get("roundId"):
            return {**unavailable, "error": "round position unavailable", "updatedAt": at}
        positions = runtime.get("positions") if isinstance(runtime.get("positions"), list) else []
        by_token = {item.get("tokenId"): item for item in positions if isinstance(item, dict)}
        yes = by_token.get(selected.get("upTokenId"), {})
        no = by_token.get(selected.get("downTokenId"), {})
        complete = runtime.get("positions_complete") is True
        yes_shares = _number(yes.get("shares")) if yes else 0 if complete and selected.get("upTokenId") else None
        no_shares = _number(no.get("shares")) if no else 0 if complete and selected.get("downTokenId") else None
        costs = [_number(item.get("costUsd")) if item else 0 if complete else None for item in (yes, no)]
        occupied = sum(costs) if all(value is not None for value in costs) else None
        total_shares = yes_shares + no_shares if yes_shares is not None and no_shares is not None else None
        if not complete:
            error = "position snapshot incomplete"
        return {
            "available": True,
            "stale": error is not None,
            "error": error,
            "runId": run_id,
            # Only the runtime's explicit round identity is returned here.
            "assetId": _asset_from(selected),
            "roundId": selected.get("roundId"),
            "marketId": selected.get("marketId"),
            "stage": selected.get("nextStage"),
            "confirmations": selected.get("confirmationCount"),
            "yesShares": yes_shares,
            "noShares": no_shares,
            "averagePrice": occupied / total_shares if total_shares and total_shares > 0 and occupied is not None else None,
            "occupiedUsd": occupied,
            "outcomePnl": {"yes": selected.get("netIfUpUsd"), "no": selected.get("netIfDownUsd")},
            "updatedAt": at,
            "expiresAt": at + RUNTIME_MAX_AGE,
        }

    def summary(self, run_id, *, range=None):
        if range not in (None, "run", "today", "all"):
            raise ValueError("invalid metrics range")
        if range in ("today", "all"):
            return self.metrics_summary(run_id, range=range)
        with self._connect() as db:
            run = self._run(db, run_id)
            result = {key: run[key] for key in ("run_id", "mode", "account_id", "config_revision", "created_at",
                      "byte_offset", "record_count", "invalid_records", "duplicate_records", "event_count", "fill_count", "settled_markets")}
            estimated_fees = 0.0
            for row in db.execute("SELECT payload FROM trade_details WHERE run_id=?", (run_id,)):
                trade = json.loads(row[0])
                # A failed/reverted trade is excluded from all final fill
                # totals, including any estimate left on its earlier event.
                if trade.get("trade_status") != "FAILED":
                    estimated_fees += _number(trade.get("fee_estimate")) or 0
            result.update(fill_notional=None if run["missing_notional"] else run["fill_notional"],
                          known_fill_notional=run["fill_notional"],
                          fees=None if run["missing_fees"] else run["known_fees"],
                          known_fees=run["known_fees"], missing_fee_count=run["missing_fees"],
                          estimated_fees=estimated_fees,
                          settled_pnl=run["known_settled_pnl"] if run["settled_markets"] and not run["missing_pnl"] else None,
                          pnl_semantics="engine_settlement_net_of_fees; not_wallet_reconciliation",
                          order_lifecycle_available=self._has_table(db, "order_details") and bool(db.execute(
                              "SELECT 1 FROM order_details WHERE run_id=? LIMIT 1", (run_id,)).fetchone()),
                          error=run["source_error"])
            settled = db.execute("""SELECT
                    SUM(CASE WHEN pnl > 0.000000001 THEN 1 ELSE 0 END) AS wins,
                    SUM(CASE WHEN pnl < -0.000000001 THEN 1 ELSE 0 END) AS losses,
                    SUM(CASE WHEN ABS(pnl) <= 0.000000001 THEN 1 ELSE 0 END) AS draws
                FROM market_details WHERE run_id=? AND status='已结算' AND pnl IS NOT NULL""", (run_id,)).fetchone()
            wins = int(settled["wins"] or 0)
            losses = int(settled["losses"] or 0)
            result.update(settled_wins=wins, settled_losses=losses,
                          settled_draws=int(settled["draws"] or 0), settled_pnl_pending=run["missing_pnl"],
                          pending_settlements=db.execute("SELECT COUNT(*) FROM settlement_details WHERE run_id=? AND verified=0",
                                                        (run_id,)).fetchone()[0] if self._has_table(db, "settlement_details") else 0,
                          win_rate=(wins / (wins + losses) if wins + losses else None))
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

    def metrics_summary(self, run_id, *, range="today", asset_id=None, market_id=None, round_id=None):
        """Slow, read-only statistics scoped to one account and UTC calendar days."""
        if range not in ("run", "today", "all"):
            raise ValueError("invalid metrics range")
        asset_id = _query_asset(asset_id)
        now = time.time()
        start = datetime.fromtimestamp(now, timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).timestamp() \
            if range == "today" else None
        if range == "run" and asset_id is None and market_id is None and round_id is None:
            return {**self.summary(run_id), "range": range, "from": None, "to": now, "as_of": now}
        with self._connect() as db:
            selected = self._run(db, run_id)
            runs = list(db.execute("SELECT * FROM runs WHERE mode='live' AND account_id=?", (selected["account_id"],))) \
                if selected["account_id"] and range != "run" else [selected]
            run_ids = [row["run_id"] for row in runs]
            placeholders = ",".join("?" for _ in run_ids)
            period = " AND COALESCE(json_extract(payload,'$.engine_ts'),json_extract(payload,'$.time'))>=?" \
                " AND COALESCE(json_extract(payload,'$.engine_ts'),json_extract(payload,'$.time'))<=?" if start is not None else ""
            parameters = (*run_ids, start, now) if start is not None else tuple(run_ids)
            fill_rows = db.execute(f"SELECT run_id,NULL AS id,asset_id,payload FROM trade_details WHERE run_id IN ({placeholders})" + period
                + " UNION ALL SELECT run_id,id,asset_id,payload FROM events "
                + f"WHERE run_id IN ({placeholders}) AND kind='fill' AND (json_extract(payload,'$.trade_status') IS NULL "
                + "OR json_extract(payload,'$.trade_id') IS NULL OR json_extract(payload,'$.order_id') IS NULL)" + period,
                (*parameters, *parameters))
            latest_fills = {}
            for row in fill_rows:
                fill = json.loads(row["payload"])
                if "asset_id" not in fill and "assetId" not in fill:
                    fill["asset_id"] = row["asset_id"] or None
                if asset_id is not None and _asset_from(fill) != asset_id:
                    continue
                if market_id is not None and fill.get("market_id") != market_id:
                    continue
                if round_id is not None and fill.get("round_id") != round_id:
                    continue
                fill_asset = _asset_from(fill)
                identity = _business_identity(fill)
                key = (*identity, fill.get("trade_id"), fill.get("order_id")) \
                    if fill.get("trade_id") and fill.get("order_id") and fill_asset is not None \
                       and (identity[1] is not None or identity[2] is not None) else \
                    (fill_asset, fill.get("trade_id"), fill.get("order_id")) \
                    if fill.get("trade_id") and fill.get("order_id") and fill_asset is not None \
                    else (row["run_id"], row["id"])
                revised = _trade_revision(latest_fills.get(key), fill)
                if revised is not None:
                    latest_fills[key] = revised
            count, notional, fees, estimated_fees, missing_notional, missing_fees = 0, 0.0, 0.0, 0.0, 0, 0
            for fill in latest_fills.values():
                if fill.get("trade_status") == "FAILED":
                    continue
                count += 1
                notional += fill.get("amount") or 0
                fees += fill.get("fee") or 0
                estimated_fees += _number(fill.get("fee_estimate")) or 0
                missing_notional += int(fill.get("amount") is None)
                missing_fees += int(fill.get("fee") is None)
            settled_rows = list(db.execute(f"SELECT d.run_id,d.market,d.asset_id,d.round_id,d.pnl,d.last_time FROM market_details d "
                + f"WHERE d.run_id IN ({placeholders}) AND d.status='已结算'"
                + (" AND d.asset_id=?" if asset_id is not None else "")
                + (" AND d.round_id=?" if round_id is not None else ""),
                (*run_ids, *(([asset_id] if asset_id is not None else [])), *(([round_id] if round_id is not None else [])))))
            settlements = {(row["run_id"], row["market"]): dict(row) for row in db.execute(
                f"SELECT * FROM settlement_details WHERE run_id IN ({placeholders})", run_ids)} \
                if self._has_table(db, "settlement_details") else {}
            settlements = {key: item for key, item in settlements.items()
                           if (asset_id is None or item.get("asset_id") == asset_id)
                           and (market_id is None or item.get("market_id") == market_id)
                           and (round_id is None or item.get("round_id") == round_id)}
            settled_markets = {}
            for row in settled_rows:
                if market_id is not None:
                    modern_market = db.execute("SELECT market_id FROM settlement_details WHERE run_id=? AND asset_id=? AND market=?",
                                               (row["run_id"], row["asset_id"], row["market"])).fetchone()
                    if not modern_market or modern_market["market_id"] != market_id:
                        continue
                modern = settlements.get((row["run_id"], row["market"]))
                if modern:
                    at = modern["source_at"]
                else:
                    stamp = db.execute("SELECT MIN(json_extract(payload,'$.time')) FROM events WHERE run_id=? "
                                       "AND kind='resolved' AND json_extract(payload,'$.market')=?",
                                       (row["run_id"], row["market"])).fetchone()[0]
                    at = stamp if stamp is not None else row["last_time"]
                if start is None or start <= at <= now:
                    key = (row["asset_id"], modern.get("market_id") or row["market"], row["round_id"]) if modern else (row["asset_id"], row["market"], row["round_id"])
                    prior = settled_markets.get(key)
                    if key not in settled_markets or prior is None:
                        settled_markets[key] = row["pnl"]
            pnl_values = list(settled_markets.values())
            def settlement_identity(item):
                return (item["asset_id"], item.get("market_id") or item["market"], item["round_id"])
            pending_markets = {settlement_identity(item) for item in settlements.values()
                               if not item["verified"] and (start is None or start <= item["source_at"] <= now)}
            pending_markets.difference_update(settlement_identity(item)
                                             for item in settlements.values() if item["verified"])
            wins = sum(value is not None and value > 1e-9 for value in pnl_values)
            losses = sum(value is not None and value < -1e-9 for value in pnl_values)
            draws = sum(value is not None and abs(value) <= 1e-9 for value in pnl_values)
            missing_pnl = sum(value is None for value in pnl_values)
            stale, lag = False, 0
            for run in runs:
                try:
                    pending = max(0, Path(run["path"]).stat().st_size - run["byte_offset"])
                except OSError:
                    pending = None
                stale |= bool(run["source_error"] or run["invalid_records"] or pending is None or pending)
                lag += pending or 0
            return {"run_id": run_id, "mode": "live", "account_id": selected["account_id"], "range": range,
                    "from": start, "to": now, "as_of": now, "run_count": len(runs),
                    "fill_count": count, "fill_notional": None if missing_notional else notional,
                    "known_fill_notional": notional, "fees": None if missing_fees else fees, "known_fees": fees,
                    "estimated_fees": estimated_fees,
                    "missing_fee_count": missing_fees, "settled_markets": len(pnl_values),
                    "settled_pnl": sum(pnl_values) if pnl_values and not missing_pnl else None,
                    "settled_wins": wins, "settled_losses": losses, "settled_draws": draws,
                    "settled_pnl_pending": missing_pnl, "win_rate": wins / (wins + losses) if wins + losses else None,
                    "pending_settlements": len(pending_markets),
                    "pnl_semantics": "engine_settlement_net_of_fees; not_wallet_reconciliation",
                    "completeness": "incomplete" if stale else "caught_up", "lag_bytes": lag,
                    "error": "statistics projection incomplete" if stale else None}

    def list_runs_page(self, *, before_id=None, limit=50, account_id=None):
        """Return a bounded, stable page of runs without reading journal files."""
        limit = max(1, min(int(limit), 200))
        with self._connect() as db:
            args = []
            clause = ""
            if before_id is not None:
                clause = " WHERE rowid < ?"
                args.append(int(before_id))
            if account_id is not None:
                clause += " AND " if clause else " WHERE "
                clause += "account_id=?"
                args.append(account_id)
            args.append(limit + 1)
            rows = list(db.execute("""SELECT rowid AS id,run_id,mode,account_id,config_revision,created_at
                FROM runs""" + clause + " ORDER BY rowid DESC LIMIT ?", args))
            runs = [dict(row) for row in rows[:limit]]
            return {"runs": runs, "next_before_id": runs[-1]["id"] if len(rows) > limit else None}

    def run_account_id(self, run_id):
        """Return the durable account owner for access control checks."""
        with self._connect() as db:
            return self._run(db, run_id)["account_id"]

    def events(self, run_id, *, before_id=None, limit=100, kinds=None, asset_id=None, market_id=None, round_id=None):
        limit = max(1, min(int(limit), 200))
        with self._connect() as db:
            self._run(db, run_id)
            args = [run_id]
            clause = ""
            if before_id is not None:
                clause = " AND id < ?"
                args.append(int(before_id))
            if kinds is not None:
                kinds = tuple(kinds)
                if not kinds or any(kind not in EVENT_KINDS for kind in kinds):
                    raise ValueError("invalid event kinds")
                clause += f" AND kind IN ({','.join('?' for _ in kinds)})"
                args.extend(kinds)
            if asset_id is not None:
                asset_id = _query_asset(asset_id)
                clause += " AND asset_id=?"
                args.append(asset_id)
            if market_id is not None:
                clause += " AND json_extract(payload,'$.market_id')=?"
                args.append(market_id)
            if round_id is not None:
                clause += " AND json_extract(payload,'$.round_id')=?"
                args.append(round_id)
            args.append(limit + 1)
            rows = list(db.execute("SELECT id,byte_offset,payload FROM events WHERE run_id=? AND kind!='platform_status'"
                                   + clause + " ORDER BY id DESC LIMIT ?", args))
            items = [{"id": row["id"], "byte_offset": row["byte_offset"], **json.loads(row["payload"])} for row in rows[:limit]]
            return {"run_id": run_id, "events": items,
                    "next_before_id": items[-1]["id"] if len(rows) > limit else None}

    def settlements_page(self, run_id, *, before_id=None, limit=100, asset_id=None, market_id=None, round_id=None):
        limit = max(1, min(int(limit), 200))
        with self._connect() as db:
            self._run(db, run_id)
            if not self._has_table(db, "settlement_details"):
                return {"run_id": run_id, "settlements": [], "next_before_id": None,
                        "available": False, "error": "settlement projection unavailable"}
            args = [run_id]
            clause = ""
            if before_id is not None:
                clause = " AND rowid<?"
                args.append(int(before_id))
            if asset_id is not None:
                clause += " AND asset_id=?"
                args.append(_query_asset(asset_id))
            if market_id is not None:
                clause += " AND market_id=?"
                args.append(market_id)
            if round_id is not None:
                clause += " AND round_id=?"
                args.append(round_id)
            args.append(limit + 1)
            rows = list(db.execute("SELECT rowid AS id,payload FROM settlement_details WHERE run_id=?"
                                   + clause + " ORDER BY rowid DESC LIMIT ?", args))
            items = [{"id": row["id"], **json.loads(row["payload"])} for row in rows[:limit]]
            return {"run_id": run_id, "settlements": items,
                    "next_before_id": items[-1]["id"] if len(rows) > limit else None}

    def metadata(self, run_id):
        """Return projection freshness without ingesting or reading journal contents."""
        with self._connect() as db:
            run = self._run(db, run_id)
            runtime = db.execute("SELECT source_at FROM platform_runtime WHERE run_id=?", (run_id,)).fetchone() \
                if self._has_table(db, "platform_runtime") else None
            latest_event = db.execute("SELECT MAX(COALESCE(json_extract(payload,'$.engine_ts'),json_extract(payload,'$.time'))) "
                                      "FROM events WHERE run_id=?", (run_id,)).fetchone()[0]
        try:
            pending = max(0, Path(run["path"]).stat().st_size - run["byte_offset"])
        except OSError:
            pending = None
        as_of = runtime["source_at"] if runtime else latest_event
        stale = bool(run["source_error"] or run["invalid_records"] or pending is None or pending or as_of is None)
        return {"source": "ledger", "asOf": as_of,
                "stale": stale, "error": "ledger_projection_incomplete" if stale else None,
                "runId": run_id}

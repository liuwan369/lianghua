from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import sys
import time

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dashboard.ledger import Ledger, RUNTIME_MAX_AGE
from dashboard.projection_worker import ProjectionWorker, bounded_snapshot
from dashboard.read_model import MAX_SNAPSHOT_BYTES, atomic_json, read_json


def append(path, *records):
    with path.open("a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")


def runtime(at=None, **changes):
    at = time.time() if at is None else at
    return {"event": "platform_status", "recv_ts": at, "event_id": f"runtime:{at}", "runtime": {
        "schemaVersion": 1, "engine": "platform", "execution": "observation", "strategy_id": None,
        "status": "running", "mode": "paper", "started_at": at, "cash_usd": 1000,
        "positions_count": 0, "orders_count": 0, "active_orders": 0, "fills_count": 0,
        "risk": {"halted": False, "equityUsd": 1000, "dailyPnlUsd": 0},
        "limits": {"capitalUsd": 1000, "dailyLossUsd": 1000, "maxOrderUsd": 10, "maxOpenOrders": 100},
        "markets": [], "books": [], **changes}}


def order(status, at, **changes):
    return {"event": "order", "event_id": f"o:{at}", "recv_ts": at, "updated_at": at,
            "client_order_id": "c1", "order_id": "v1", "token_id": "t1", "strategy_id": "plugin",
            "market_slug": "market", "side": "UP", "direction": "BUY", "price": .4,
            "shares": 5, "filled_shares": 0, "reserved_usd": 2, "reserved_shares": 0,
            "status": status, **changes}


def selected(tmp_path):
    journal = tmp_path / "run.jsonl"
    journal.touch()
    directory = tmp_path / "view"
    atomic_json(directory / "selection.json", {"run_id": "one", "mode": "paper", "path": str(journal)})
    return ProjectionWorker(directory), journal


def test_observation_has_zero_orders_unknown_profit_and_survives_restart(tmp_path):
    worker, journal = selected(tmp_path)
    record = runtime()
    append(journal, record)
    worker.step()
    snapshot = read_json(worker.directory / "snapshot.json")
    assert snapshot["stats"]["runtime"]["execution"] == "observation"
    assert snapshot["stats"]["runtime"]["strategy_id"] is None
    assert snapshot["stats"]["runtime"]["stale"] is False
    assert snapshot["stats"]["orders"] == []
    assert snapshot["stats"]["fills"] == 0
    assert snapshot["stats"]["pnl"] is None
    restarted = ProjectionWorker(worker.directory)
    restarted.step()
    second = read_json(worker.directory / "snapshot.json")
    assert second["stats"] == snapshot["stats"] | {
        "runtime": second["stats"]["runtime"], "latency": second["stats"]["latency"]}
    assert second["stats"]["runtime"]["source_at"] == record["recv_ts"]
    assert second["summary"]["event_count"] == 1


@pytest.mark.parametrize("state,verified,credit,visible", [
    ("confirmed", True, 5, 5), ("confirmed", True, 0, 0),
    ("pending", True, 5, None), ("confirmed", False, 5, None),
    ("confirmed", True, -1, None),
])
def test_settlement_preserves_receipt_amounts_without_inventing_profit(tmp_path, state, verified, credit, visible):
    worker, journal = selected(tmp_path)
    append(journal, {"event": "platform_settlement", "event_id": "settlement:one",
                    "recv_ts": time.time(), "market_id": "condition", "market_slug": "btc-round",
                    "state": state, "transaction_id": "0x" + "a" * 64,
                    "payout_verified": verified, "credited_usd": credit, "expected_payout_usd": max(0, credit),
                    "cash_before_usd": 10, "cash_after_usd": 25})
    worker.step()
    event = worker.ledger.events("one")["events"][0]
    assert event["credited_usd"] == visible
    assert event["payout_verified"] is (visible is not None)
    assert event["cash_after_usd"] == (25 if visible is not None else None)
    assert event["pnl"] is None
    assert worker.ledger.summary("one")["settled_pnl"] is None


def test_platform_heartbeat_cannot_keep_stalled_runtime_fresh(tmp_path, monkeypatch):
    worker, journal = selected(tmp_path)
    now = time.time()
    append(journal, runtime(now))
    worker.step()
    monkeypatch.setattr(time, "time", lambda: now + RUNTIME_MAX_AGE + 1)
    worker.step()
    snapshot = read_json(worker.directory / "snapshot.json")
    assert snapshot["stats"]["runtime"]["stale"] is True
    assert snapshot["stats"]["runtime"]["source_at"] == now
    assert read_json(worker.directory / "heartbeat.json")["as_of"] > now
    prior = (worker.directory / "snapshot.json").stat().st_mtime_ns
    worker.step()
    assert (worker.directory / "snapshot.json").stat().st_mtime_ns == prior


def test_lifecycle_updates_keep_ownership_and_count_accept_cancel_once(tmp_path):
    worker, journal = selected(tmp_path)
    events = [order("SUBMITTING", 1, order_id=None), order("OPEN", 2), order("PARTIAL", 3, filled_shares=2),
              order("CANCELLED", 4, filled_shares=2, cancel_requested_at=3.75,
                    cancel_ack_at=4, cancel_ack_latency_ms=250),
              order("CANCELLED", 5, filled_shares=2, cancel_requested_at=3.75,
                    cancel_ack_at=4, cancel_ack_latency_ms=250)]
    append(journal, *events, events[-1])
    worker.step()
    stats = worker.ledger.legacy_stats("one")
    assert stats["quotes"] == 1 and stats["cancels"] == 1
    assert stats["order_count"] == 1 and stats["orders_truncated"] is False
    assert stats["orders"][0]["status"] == "CANCELLED"
    assert stats["orders"][0]["strategy_id"] == "plugin"
    assert stats["orders"][0]["direction"] == "BUY"
    assert stats["orders"][0]["cancel_requested_at"] == 3.75
    assert stats["orders"][0]["cancel_ack_at"] == 4
    assert stats["orders"][0]["cancel_ack_latency_ms"] == 250
    assert worker.ledger.summary("one")["order_lifecycle_available"] is True
    assert worker.ledger.summary("one")["duplicate_records"] == 1
    append(journal, order("OPEN", 2.5))
    worker.step()
    assert worker.ledger.legacy_stats("one")["orders"][0]["status"] == "CANCELLED"


def test_composite_fill_dedup_and_settlement_does_not_invent_profit(tmp_path):
    worker, journal = selected(tmp_path)
    first = {"event": "fill", "event_id": 'fill:["trade","one"]', "trade_id": "trade", "order_id": "one",
             "market_slug": "m", "price": .4, "shares": 5, "fee": None, "direction": "BUY", "is_maker": True}
    second = {**first, "event_id": 'fill:["trade","two"]', "order_id": "two"}
    append(journal, first, first, second, {"event": "settlement", "market_slug": "m", "state": "confirmed", "pnl": 100})
    worker.step()
    stats = worker.ledger.legacy_stats("one")
    assert stats["fills"] == 2 and stats["fill_notional"] == 4
    assert stats["fees"] is None and stats["pnl"] is None and stats["settled_markets"] == 0


@pytest.mark.parametrize("changes", [{"mode": "live"}, {"execution": []}, {"status": []},
                                    {"strategy_id": "unexpected"}])
def test_invalid_runtime_is_rejected_without_losing_legacy_events(tmp_path, changes):
    worker, journal = selected(tmp_path)
    append(journal, runtime(**changes), {"event": "quote", "market_slug": "old", "price": .4, "shares": 5})
    worker.step()
    stats = worker.ledger.legacy_stats("one")
    assert stats["runtime"] is None and stats["quotes"] == 1
    assert worker.ledger.summary("one")["invalid_records"] == 1


def test_runtime_allowlist_depth_limit_and_latest_source_timestamp(tmp_path):
    worker, journal = selected(tmp_path)
    now = time.time()
    record = runtime(now, books=[{"tokenId": "t", "bids": [[.4, 5]] * 20, "asks": [[.6, 5]] * 20,
                                 "received_age_ms": 123, "stale": False, "market_expired": False,
                                 "secret": "SECRET"}], secret="SECRET")
    append(journal, record, runtime(now - 1, cash_usd=999))
    worker.step()
    stats = worker.ledger.legacy_stats("one")
    assert stats["runtime"]["cash_usd"] == 1000
    assert len(stats["runtime"]["books"][0]["bids"]) == 10
    assert stats["runtime"]["books"][0]["received_age_ms"] == 123
    assert stats["runtime"]["books"][0]["stale"] is False
    assert stats["runtime"]["books"][0]["market_expired"] is False
    assert "SECRET" not in json.dumps(stats)


def test_snapshot_budget_truncates_display_only(tmp_path):
    sample = {"stats": {"runtime": {"books": [], "markets": []}, "orders": [{"order_id": "x" * 6000}] * 100,
                        "order_count": 100, "orders_truncated": False, "events": [], "market_summaries": []}}
    projected = bounded_snapshot(sample)
    assert projected["stats"]["orders_truncated"] and projected["stats"]["snapshot_truncated"]
    assert projected["stats"]["order_count"] == 100
    path = tmp_path / "snapshot.json"
    atomic_json(path, projected)
    assert path.stat().st_size <= MAX_SNAPSHOT_BYTES
    assert read_json(path)["stats"]["order_count"] == 100


def test_readonly_legacy_database_works_before_platform_table_migration(tmp_path):
    journal = tmp_path / "old.jsonl"
    append(journal, {"event": "fill", "market_slug": "old", "price": .4, "shares": 5, "fee": 0})
    ledger = Ledger(tmp_path / "legacy.sqlite3")
    ledger.register_run("old", "paper", None, journal)
    ledger.ingest("old")
    with sqlite3.connect(ledger.path) as db:
        db.execute("DROP TABLE platform_runtime")
        db.execute("DROP TABLE order_details")
    historical = Ledger(ledger.path, readonly=True)
    stats = historical.legacy_stats("old")
    assert stats["runtime"] is None and stats["orders"] == [] and stats["fills"] == 1
    assert historical.summary("old")["order_lifecycle_available"] is False


def test_platform_error_alias_and_unknown_starting_balances(tmp_path):
    worker, journal = selected(tmp_path)
    append(journal, runtime(status="starting", cash_usd=None, active_orders=None, fills_count=None, risk=None),
           {"event": "platform_error", "event_id": "e1", "code": "run_failed", "phase": "state_open",
            "message": "SECRET"},
           {"event": "platform_settlement", "event_id": "s1", "state": "confirmed", "market_id": "market", "pnl": 55})
    worker.step()
    stats = worker.ledger.legacy_stats("one")
    assert stats["runtime"]["cash_usd"] is None and stats["runtime"]["risk"] is None
    assert stats["error"] and stats["pnl"] is None
    events = worker.ledger.events("one")["events"]
    assert next(e for e in events if e["event"] == "error")["phase"] == "state_open"
    assert next(e for e in events if e["event"] == "settlement")["state"] == "confirmed"
    assert "SECRET" not in json.dumps(stats)


def test_heartbeats_do_not_hide_business_events_or_change_pagination(tmp_path):
    worker, journal = selected(tmp_path)
    now = time.time()
    fill = {"event": "fill", "event_id": "fill:first", "recv_ts": now,
            "market_slug": "m", "side": "YES", "price": .4, "shares": 5, "fee": 0}
    append(journal, fill, *[runtime(now + i / 100) for i in range(30)], order("OPEN", now + 1, side="YES"))
    worker.step()
    stats = worker.ledger.legacy_stats("one")
    assert [event["event"] for event in stats["events"]] == ["fill", "order"]
    assert all(event["side"] == "YES" for event in stats["events"])
    first = worker.ledger.events("one", limit=1)
    assert first["events"][0]["event"] == "order"
    second = worker.ledger.events("one", before_id=first["next_before_id"], limit=1)
    assert second["events"][0]["event"] == "fill"
    assert second["next_before_id"] is None
    assert worker.ledger.summary("one")["event_count"] == 32

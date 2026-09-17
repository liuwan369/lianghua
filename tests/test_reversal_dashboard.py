from __future__ import annotations

from collections import deque
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import sys
import time
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from dashboard.strategy_config import StrategyConfigStore, default_config, validate_config
from dashboard.config import ConfigConflictError, ConfigStoreError
from dashboard.ledger import Ledger, _runtime_projection

SPEC = importlib.util.spec_from_file_location("reversal_dashboard_test", ROOT / "scripts/system-dashboard-server.py")
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


def test_editable_config_survives_restart_and_versions_are_exclusive(tmp_path):
    path = tmp_path / "strategy.json"
    store = StrategyConfigStore(path)
    config = {**default_config(), "stageShares": [5, 9, 18, 36, 72], "maxStages": 5,
              "roundBudgetUsd": 200, "totalBudgetUsd": 600, "dailyLossUsd": None}
    assert store.save(config, 0)["savedRevision"] == 1
    assert StrategyConfigStore(path).get()["config"] == config
    def save(_):
        try:
            return StrategyConfigStore(path).save(config, 1)["savedRevision"]
        except ConfigConflictError:
            return "conflict"
    with ThreadPoolExecutor(4) as executor:
        assert sorted(map(str, executor.map(save, range(4)))) == ["2", "conflict", "conflict", "conflict"]
    path.write_text("{", encoding="utf-8")
    with pytest.raises(ConfigStoreError):
        StrategyConfigStore(path).get()


@pytest.mark.parametrize("change", [
    {"maxStages": 5}, {"maxStages": True}, {"triggerPrice": .8}, {"stageShares": [5, float("nan")]},
    {"totalBudgetUsd": 0}, {"dailyLossUsd": True}, {"durationMinutes": float("inf")},
    {"maxQuoteAgeSeconds": "2"}, {"private_key": "not-allowed"},
])
def test_bad_configuration_cannot_reach_runner(change):
    with pytest.raises(ValueError):
        validate_config({**default_config(), **change})


@pytest.fixture
def runner(monkeypatch, tmp_path):
    cli = tmp_path / "dist/cli/platform.js"
    cli.parent.mkdir(parents=True)
    cli.touch()
    monkeypatch.setattr(SERVER, "TRADING_ROOT", tmp_path)
    for key in ("_trading_process", "_trading_pid", "_trading_log", "_trading_console_log", "_trading_params",
                "_trading_run_id", "_trading_mode", "_trading_request_id", "_trading_config_revision", "_strategy_config_store"):
        monkeypatch.setattr(SERVER, key, None)
    monkeypatch.setattr(SERVER, "_trading_state_loaded", True)
    monkeypatch.setattr(SERVER, "_projection_pending", deque())
    monkeypatch.setattr(SERVER, "_process_matches", lambda *a: False)
    monkeypatch.setattr(SERVER, "_trading_environment", lambda: {})
    monkeypatch.setattr(SERVER, "account_config_status", lambda: {"execution_credentials_ready": True, "wallet": "0xabc"})
    monkeypatch.setattr(SERVER, "account_action", lambda *_: {"account_ready": True})
    monkeypatch.setenv("PM_TRADING_LIVE_UNLOCK", "1")
    calls = []
    class Child:
        pid = 123
        def poll(self):
            return None
    def start(args, **kw):
        calls.append(args)
        return Child()
    monkeypatch.setattr(SERVER.subprocess, "Popen", start)
    return calls


def test_real_strategy_start_uses_saved_config_and_stable_account_recovery(runner, monkeypatch):
    store = SERVER.strategy_config_store()
    store.save({**default_config(), "totalBudgetUsd": 148}, 0)
    request = {"action": "start", "revision": 1, "request_id": str(uuid.uuid4())}
    result = SERVER.strategy_control(request)
    assert result["strategy_id"] == "btc-reversal" and result["mode"] == "live"
    assert result["execution"] == "strategy"
    args = runner[0]
    assert args[args.index("--strategy") + 1] == "btc-reversal"
    assert args[args.index("--strategy-config") + 1] == str(store.path)
    assert "--capital-usd" not in args and "--daily-loss-usd" not in args
    state = args[args.index("--state-file") + 1]
    SERVER.strategy_control(request)
    assert len(runner) == 1
    pause = SERVER.strategy_control({"action": "pause"})
    assert pause["control_pending"] and pause["running"]
    control = Path(args[args.index("--control-file") + 1])
    assert json.loads(control.read_text())["paused"] is True
    SERVER.strategy_control({"action": "resume"})
    assert json.loads(control.read_text())["paused"] is False
    monkeypatch.setattr(SERVER, "_trading_process", None)
    SERVER.strategy_control({**request, "request_id": str(uuid.uuid4())})
    assert runner[1][runner[1].index("--state-file") + 1] == state
    assert runner[1][runner[1].index("--journal-file") + 1] != args[args.index("--journal-file") + 1]


def test_stale_or_unsaved_start_cannot_create_process(runner):
    with pytest.raises(ValueError):
        SERVER.strategy_control({"action": "start", "revision": 0, "request_id": str(uuid.uuid4())})
    SERVER.strategy_config_store().save(default_config(), 0)
    with pytest.raises(ConfigConflictError):
        SERVER.strategy_control({"action": "start", "revision": 2, "request_id": str(uuid.uuid4())})
    assert not runner


def test_order_pagination_groups_lifecycle_and_freezes_history(tmp_path):
    journal = tmp_path / "orders.jsonl"
    now = time.time() - 20
    def event(i, state, stamp):
        return {"event": "order", "recv_ts": stamp, "client_order_id": f"s:{i}",
                "order_id": f"o:{i}" if state != "SUBMITTING" else None,
                "status": state, "market_slug": "btc-round", "shares": 5, "price": .7}
    rows = [event(i, state, now + i / 100) for i in range(65) for state in ("SUBMITTING", "OPEN", "FILLED")]
    journal.write_text("\n".join(map(json.dumps, rows)) + "\n")
    ledger = Ledger(tmp_path / "ledger.sqlite3")
    ledger.register_run("r", "live", "account", journal)
    ledger.ingest("r")
    first = ledger.orders_page("r", limit=20)
    assert first["total"] == 65 and first["has_more"]
    assert len(first["orders"]) == 20
    with journal.open("a") as handle:
        handle.write(json.dumps(event(99, "OPEN", first["asOf"] + .1)) + "\n")
    ledger.ingest("r")
    pages = [first] + [ledger.orders_page("r", limit=20, offset=i, as_of=first["asOf"]) for i in (20, 40, 60)]
    ids = [order["order_id"] for page in pages for order in page["orders"]]
    assert len(ids) == len(set(ids)) == 65
    assert not pages[-1]["has_more"]
    assert ledger.orders_page("r", status="OPEN", as_of=first["asOf"])["total"] == 0


def test_matched_failed_and_confirmed_trade_updates_never_double_count(tmp_path):
    journal = tmp_path / "trades.jsonl"
    journal.touch()
    ledger = Ledger(tmp_path / "ledger.sqlite3")
    ledger.register_run("r", "live", "a", journal)
    def append(trade, status, *, fee=.02, source="reported"):
        with journal.open("a") as out:
            out.write(json.dumps({"event": "fill", "event_id": f"{trade}:{status}", "trade_id": trade,
                "order_id": "o", "trade_status": status, "market_slug": "btc", "price": .7,
                "shares": 5, "fee": fee, "fee_source": source, "is_maker": False}) + "\n")
        ledger.ingest("r")
        return ledger.legacy_stats("r")
    assert append("t", "MATCHED")["fills"] == 1
    assert append("t", "MINED")["fill_notional"] == 3.5
    failed = append("t", "FAILED")
    assert failed["fills"] == 0 and failed["fill_notional"] == 0 and failed["fees"] == 0
    assert append("t", "CONFIRMED")["fills"] == 0
    assert append("t2", "MATCHED", source="estimate")["fees"] is None
    final = append("t2", "CONFIRMED", fee=.03)
    assert final["fills"] == 1 and final["fees"] == pytest.approx(.03)
    assert append("t2", "FAILED")["fills"] == 1


def test_continuous_runtime_keeps_current_books_after_twenty_rounds():
    now = time.time()
    markets = [{"id": str(i), "name": f"btc-{i}", "startsAt": now - (19-i)*300-1,
                "endsAt": now - (18-i)*300-1, "instruments": [
                    {"tokenId": f"u{i}"}, {"tokenId": f"d{i}"}]} for i in range(20)]
    books = [{"tokenId": f"{side}{i}", "ts": now, "asks": [[.7, 5]], "bids": [[.6, 5]]}
             for i in range(20) for side in ("u", "d")]
    result = _runtime_projection({"schemaVersion": 1, "engine": "platform", "execution": "strategy",
        "strategy_id": "btc-reversal", "status": "running", "mode": "live", "markets": markets, "books": books}, "live")
    assert result["markets"][0]["id"] == "19"
    assert {"u19", "d19"} <= {b["tokenId"] for b in result["books"]}


def test_runtime_preserves_confirmed_economics_without_inventing_unknown_results():
    current = {"marketId": "btc", "costUsd": 3.55, "reservedUsd": 2.1,
               "upShares": 5, "downShares": 0, "feesVerified": False,
               "netIfUpUsd": None, "netIfDownUsd": None,
               "resultScope": "account_market", "resultReason": "成交或实际费用尚待确认"}
    runtime = {"schemaVersion": 1, "engine": "platform", "execution": "strategy",
               "strategy_id": "btc-reversal", "status": "running", "mode": "live",
               "strategy_runtime": {"strategyId": "btc-reversal", "currentRound": current}}
    result = _runtime_projection(runtime, "live")["strategy_runtime"]["currentRound"]
    assert all(result[key] == value for key, value in current.items())
    current.update(feesVerified=True, netIfUpUsd=1.45, netIfDownUsd=-3.55, resultReason=None)
    result = _runtime_projection(runtime, "live")["strategy_runtime"]["currentRound"]
    assert result["feesVerified"] and result["netIfUpUsd"] == 1.45 and result["netIfDownUsd"] == -3.55


def test_final_trade_can_receive_actual_fee_once_without_changing_fill(tmp_path):
    journal = tmp_path / "fees.jsonl"
    rows = [{"event": "order", "client_order_id": "c", "order_id": "o", "status": "FILLED",
             "shares": 5, "filled_shares": 5, "price": .7, "recv_ts": time.time()-10}]
    base = {"event": "fill", "trade_id": "t", "order_id": "o", "trade_status": "CONFIRMED",
            "market_slug": "btc", "price": .7, "shares": 5, "is_maker": False}
    rows.append({**base, "event_id": "estimated", "fee": .1, "fee_source": "estimate"})
    journal.write_text("\n".join(map(json.dumps, rows))+"\n")
    ledger = Ledger(tmp_path / "fees.sqlite3")
    ledger.register_run("r", "live", "a", journal)
    ledger.ingest("r")
    assert ledger.legacy_stats("r")["fees"] is None
    for event_id, fee in (("reported", .05), ("duplicate", .05), ("conflicting", .2)):
        with journal.open("a") as out:
            out.write(json.dumps({**base, "event_id": event_id, "fee": fee, "fee_source": "reported"})+"\n")
        ledger.ingest("r")
        stats = ledger.legacy_stats("r")
        assert stats["fills"] == 1 and stats["fill_notional"] == 3.5 and stats["fees"] == .05
        order = ledger.orders_page("r")["orders"][0]
        assert order["fee"] == .05 and order["amount"] == 3.5 and len(order["fills"]) == 1


def test_paging_ignores_later_ingestion_of_older_messages_and_shows_actual_fills(tmp_path):
    journal = tmp_path / "late.jsonl"
    stamp = time.time()-10
    rows = [{"event": "order", "recv_ts": stamp, "client_order_id": f"c{i}", "order_id": f"o{i}",
             "status": "PARTIAL", "filled_shares": 2, "price": .7, "shares": 5} for i in range(30)]
    journal.write_text("\n".join(map(json.dumps, rows))+"\n")
    ledger = Ledger(tmp_path / "ledger.sqlite3")
    ledger.register_run("r", "live", "a", journal)
    ledger.ingest("r", max_records=20)
    first = ledger.orders_page("r", limit=10)
    ledger.ingest("r")
    second = ledger.orders_page("r", offset=10, as_of=first["asOf"], snapshot_event_id=first["snapshotEventId"])
    assert first["total"] == second["total"] == 20
    assert not {o["order_id"] for o in first["orders"]} & {o["order_id"] for o in second["orders"]}
    assert first["orders"][0]["amount"] is None
    with journal.open("a") as out:
        out.write(json.dumps({"event":"fill","recv_ts":stamp,"trade_id":"t","order_id":"o29", "price":.65,
                             "shares":2,"fee":.01,"fee_source":"reported","trade_status":"CONFIRMED"})+"\n")
    ledger.ingest("r")
    order = ledger.orders_page("r")["orders"][0]
    assert order["amount"] == 1.3 and order["order_notional"] == 3.5 and order["fee"] == .01

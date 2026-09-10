from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import sys
import threading
import time
import uuid

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from dashboard.config import ConfigStore
from dashboard.read_model import ReadModel
from dashboard.ledger import Ledger

SPEC = importlib.util.spec_from_file_location("dashboard_v1_test", ROOT / "scripts/system-dashboard-server.py")
SERVER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SERVER
SPEC.loader.exec_module(SERVER)


def wait_snapshot(model, run_id, count):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        value = model.snapshot(run_id)
        if value.get("summary", {}).get("fill_count") == count:
            return value
        time.sleep(0.03)
    raise AssertionError(model.snapshot(run_id))


def test_separate_worker_partial_records_and_restart(tmp_path):
    journal = tmp_path / "journal.jsonl"
    fill = {"event": "fill", "market_slug": "btc-test", "price": 0.4, "shares": 5, "fee": 0}
    journal.write_text(json.dumps(fill) + "\n", encoding="utf-8")
    model = ReadModel(tmp_path / "view")
    try:
        model.select("r1", "paper", None, journal, 2)
        first = wait_snapshot(model, "r1", 1)
        assert first["stats"]["fill_notional"] == 2
        assert first["stats"]["pnl"] is None
        assert model._process.pid != __import__("os").getpid()
        with journal.open("a", encoding="utf-8") as out:
            out.write(json.dumps(fill))
        time.sleep(0.3)
        assert model.snapshot("r1")["summary"]["fill_count"] == 1
        with journal.open("a", encoding="utf-8") as out:
            out.write("\n")
        assert wait_snapshot(model, "r1", 2)["summary"]["fill_notional"] == 4
        model.close()
        assert model.snapshot("r1")["stale"]
        model._next_restart = 0
        model.select("r1", "paper", None, journal, 2)
        with journal.open("a", encoding="utf-8") as out:
            out.write(json.dumps(fill) + "\n")
        assert wait_snapshot(model, "r1", 3)["summary"]["config_revision"] == 2
    finally:
        model.close()


def test_slow_statistics_does_not_hold_trading_control_lock(monkeypatch):
    entered, release, acquired = threading.Event(), threading.Event(), threading.Event()
    monkeypatch.setattr(SERVER, "_restore_trading_state", lambda: None)
    monkeypatch.setattr(SERVER, "_trading_process", None)
    monkeypatch.setattr(SERVER, "_process_matches", lambda *a: False)
    monkeypatch.setattr(SERVER, "account_config_status", lambda: {"execution_credentials_ready": False})
    def slow(*args):
        entered.set()
        assert release.wait(3)
        return {}
    monkeypatch.setattr(SERVER, "trade_log_stats", slow)
    def control():
        with SERVER._trading_lock:
            acquired.set()
    with ThreadPoolExecutor(2) as pool:
        status = pool.submit(SERVER.trading_status)
        assert entered.wait(1)
        check = pool.submit(control)
        try:
            assert acquired.wait(0.5), "stats blocked trading lock"
        finally:
            release.set()
        status.result()
        check.result()


def test_revision_bound_start_is_idempotent_and_does_not_switch_mode(monkeypatch, tmp_path):
    store = ConfigStore(tmp_path / "config.json")
    saved = store.save({"mode": "paper", "order_usd": 3}, 0)
    monkeypatch.setattr(SERVER, "_config_store", store)
    monkeypatch.setattr(SERVER, "_restore_trading_state", lambda: None)
    monkeypatch.setattr(SERVER, "_trading_request_id", None)
    monkeypatch.setattr(SERVER, "_trading_config_revision", None)
    monkeypatch.setattr(SERVER, "trading_status", lambda **kw: {"running": True, "config_revision": SERVER._trading_config_revision})
    calls = []
    def start(params, *, config_revision, request_id):
        calls.append(params)
        SERVER._trading_config_revision = config_revision
        SERVER._trading_request_id = request_id
        return {"config_revision": config_revision}
    monkeypatch.setattr(SERVER, "start_trading", start)
    request = {"revision": saved["revision"], "request_id": str(uuid.uuid4())}
    SERVER.start_configured_paper(request)
    SERVER.start_configured_paper(request)
    assert len(calls) == 1 and calls[0]["order_usd"] == 3
    store.save({"mode": "live"}, 1)
    with pytest.raises(PermissionError):
        SERVER.start_configured_paper({"revision": 2, "request_id": str(uuid.uuid4())})
    assert len(calls) == 1


@pytest.mark.parametrize("field", ["order_usd", "duration_min", "max_orders"])
@pytest.mark.parametrize("value", [None, True, {}, "2", 10 ** 400])
def test_legacy_start_rejects_invalid_numbers_before_process_creation(monkeypatch, tmp_path, field, value):
    cli = tmp_path / "dist" / "cli" / "live.js"
    cli.parent.mkdir(parents=True)
    cli.touch()
    monkeypatch.setattr(SERVER, "TRADING_ROOT", tmp_path)
    monkeypatch.setattr(SERVER, "_trading_environment", lambda: pytest.fail("invalid request reached execution"))
    with pytest.raises(ValueError, match="finite JSON number"):
        SERVER.start_trading({"mode": "paper", field: value})


def test_ledger_compatibility_deduplicates_and_preserves_unknown_fee(tmp_path):
    journal = tmp_path / "test.jsonl"
    fill = {"event": "fill", "event_id": "f1", "market_slug": "m", "price": 0.4, "shares": 5}
    resolved = {"event": "resolved", "market_slug": "m", "pnl": -2}
    journal.write_text("\n".join(json.dumps(v) for v in [fill, fill, resolved, resolved]) + "\n")
    ledger = Ledger(tmp_path / "ledger.sqlite3")
    ledger.register_run("run", "paper", None, journal)
    ledger.ingest("run")
    stats = ledger.legacy_stats("run")
    assert stats["fills"] == 1 and stats["fees"] is None
    assert stats["pnl"] == -2 and stats["settled_markets"] == 1


def test_slow_collector_does_not_run_on_http_read(monkeypatch):
    monkeypatch.setattr(SERVER, "_live_cache", {"collector_online": True, "current_markets": [{"slug": "old"}]})
    monkeypatch.setattr(SERVER, "_live_cache_at", time.monotonic() - 20)
    monkeypatch.setattr(SERVER, "live_status", lambda: pytest.fail("blocking fetch from request"))
    snapshot = SERVER.cached_live_status()
    assert snapshot["collector_online"] is False
    assert snapshot["current_markets"] == []


def test_legacy_events_keep_errors_and_suppress_empty_settlement(tmp_path):
    journal = tmp_path / "run.jsonl"
    journal.write_text(json.dumps({"event": "error", "message": "sensitive raw text"}) + "\n" +
                       json.dumps({"event": "resolved", "market_slug": "empty", "winner": "UP", "pnl": 99}) + "\n")
    ledger = Ledger(tmp_path / "ledger.sqlite3")
    ledger.register_run("r", "paper", None, journal)
    ledger.ingest("r")
    stats = ledger.legacy_stats("r")
    assert stats["error"] and "sensitive" not in json.dumps(stats)
    assert stats["events"][-1]["event"] == "resolved_empty"
    assert stats["events"][-1]["side"] == "UP"
    assert stats["events"][-1]["pnl"] is None


def test_stop_control_does_not_read_analytics(monkeypatch):
    monkeypatch.setattr(SERVER, "_restore_trading_state", lambda: None)
    monkeypatch.setattr(SERVER, "_trading_process", None)
    monkeypatch.setattr(SERVER, "_process_matches", lambda *a: False)
    monkeypatch.setattr(SERVER, "account_config_status", lambda: {"execution_credentials_ready": False})
    monkeypatch.setattr(SERVER, "_persist_trading_state", lambda: None)
    monkeypatch.setattr(SERVER, "trade_log_stats", lambda *a: pytest.fail("analytics in stop"))
    assert SERVER.stop_trading()["running"] is False


def test_live_stop_timeout_keeps_reconciliation_process_alive(monkeypatch):
    signals = []
    class Process:
        pid = 12345
        def poll(self): return None
        def send_signal(self, value): signals.append(value)
        def wait(self, timeout):
            assert timeout == 8
            raise SERVER.subprocess.TimeoutExpired("test-node", timeout)
        def kill(self): pytest.fail("must not kill live cancellation/reconciliation")
    process = Process()
    monkeypatch.setattr(SERVER, "_restore_trading_state", lambda: None)
    monkeypatch.setattr(SERVER, "_persist_trading_state", lambda: None)
    monkeypatch.setattr(SERVER, "_trading_process", process)
    monkeypatch.setattr(SERVER, "_trading_pid", process.pid)
    monkeypatch.setattr(SERVER, "_trading_mode", "live")
    monkeypatch.setattr(SERVER, "_trading_exit_code", None)
    monkeypatch.setattr(SERVER, "_trading_stop_result", None)
    monkeypatch.setattr(SERVER, "_process_matches", lambda *args: True)
    monkeypatch.setattr(SERVER, "trading_status", lambda **kwargs: {"stop_result": SERVER._trading_stop_result})
    result = SERVER.stop_trading()["stop_result"]
    assert result["confirmed"] is False and result["process_stopped"] is False
    assert "对账" in result["message"]
    assert SERVER._trading_process is process and SERVER._trading_pid == process.pid
    assert SERVER.stop_trading()["stop_result"] == result
    assert len(signals) == 1


def test_new_run_does_not_abandon_old_tail(tmp_path):
    first, second = tmp_path / "old.jsonl", tmp_path / "new.jsonl"
    fill = {"event": "fill", "market_slug": "m", "price": 0.4, "shares": 5, "fee": 0}
    first.write_text((json.dumps(fill) + "\n") * 2300 + json.dumps({"event": "resolved", "market_slug": "m", "pnl": -3}) + "\n")
    second.write_text(json.dumps(fill) + "\n")
    model = ReadModel(tmp_path / "view")
    try:
        model.select("old", "paper", None, first, 1)
        model.select("new", "paper", None, second, 2)
        wait_snapshot(model, "new", 1)
        ledger = Ledger(model.db_path, readonly=True)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and ledger.summary("old")["settled_markets"] != 1:
            time.sleep(0.03)
        assert ledger.summary("old")["fill_count"] == 2300
        assert ledger.summary("old")["settled_pnl"] == -3
    finally:
        model.close()

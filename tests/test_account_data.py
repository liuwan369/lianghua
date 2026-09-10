from __future__ import annotations
import io
import json
import queue
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dashboard.account_data import AccountData


def data(wallet):
    return {"wallet": wallet, "read_only": True, "checked_at": datetime.now(timezone.utc).isoformat(), **{key: {"available": True, "complete": True, "items": []} for key in ("collateral", "open_orders", "trades", "positions", "closed_positions", "activity")}}


class Process:
    stdin = None
    stdout = None
    def __init__(self): self.stdin = io.StringIO()
    def poll(self): return None
    def terminate(self): pass
    def wait(self, timeout=None): pass


def bridge(tmp_path, values, monkeypatch):
    reader = AccountData(tmp_path, lambda: dict(values), timeout=.1)
    calls = []
    def spawn(current):
        calls.append(current)
        proc, messages = Process(), queue.Queue()
        messages.put(json.dumps(data(current["POLYMARKET_WALLET_ADDRESS"])))
        reader._process, reader._queue = proc, messages
        return proc, messages
    monkeypatch.setattr(reader, "_spawn", spawn)
    return reader, calls


def test_background_refresh_snapshot_and_rate_limit(tmp_path, monkeypatch):
    values = {"POLYMARKET_WALLET_ADDRESS": "wallet", "POLYMARKET_OWNER_PRIVATE_KEY": "secret"}
    reader, calls = bridge(tmp_path, values, monkeypatch)
    assert reader.snapshot()["available"] is False
    assert reader.refresh() is True
    assert reader.snapshot()["available"] is True
    assert reader.refresh() is False
    assert len(calls) == 1
    assert "secret" not in json.dumps(reader.snapshot())
    snap = reader.snapshot(); snap["collateral"]["items"].append("mutated")
    assert reader.snapshot()["collateral"]["items"] == []


def test_identity_change_and_key_rotation_clear_data_immediately(tmp_path, monkeypatch):
    values = {"POLYMARKET_WALLET_ADDRESS": "wallet", "POLYMARKET_OWNER_PRIVATE_KEY": "secret"}
    reader, calls = bridge(tmp_path, values, monkeypatch)
    reader.refresh()
    values["POLYMARKET_OWNER_PRIVATE_KEY"] = "new-secret"
    assert reader.snapshot()["available"] is False
    assert "collateral" not in reader.snapshot()
    reader.refresh()
    values["POLYMARKET_WALLET_ADDRESS"] = "new-wallet"
    assert reader.snapshot()["wallet"] == "new-wallet"
    assert reader.snapshot()["available"] is False


def test_worker_reused_and_timeout_clears_old_results(tmp_path, monkeypatch):
    values = {"POLYMARKET_WALLET_ADDRESS": "wallet"}
    reader, calls = bridge(tmp_path, values, monkeypatch)
    reader.refresh()
    reader._attempt = float("-inf")
    reader._queue.put(json.dumps(data("wallet")))
    assert reader.refresh()
    assert len(calls) == 1
    reader._attempt = float("-inf")
    assert reader.refresh() is False  # No queued response.
    assert reader.snapshot()["available"] is False
    assert reader.snapshot()["error_code"] == "account_data_fetch_failed"


def test_wallet_mismatch_and_changed_identity_inflight_are_discarded(tmp_path, monkeypatch):
    values = {"POLYMARKET_WALLET_ADDRESS": "wallet"}
    reader, _ = bridge(tmp_path, values, monkeypatch)
    reader.refresh()
    reader._attempt = float("-inf")
    reader._queue.put(json.dumps(data("different-wallet")))
    assert reader.refresh() is False
    assert reader.snapshot()["available"] is False
    reader._attempt = float("-inf")
    assert reader.refresh() is True
    reader._attempt = float("-inf")
    class ChangingQueue:
        def get(self, timeout):
            values["POLYMARKET_WALLET_ADDRESS"] = "changed-during-fetch"
            return json.dumps(data("wallet"))
    reader._queue = ChangingQueue()
    assert reader.refresh() is False
    assert reader.snapshot()["wallet"] == "changed-during-fetch"
    assert reader.snapshot()["available"] is False


def test_http_snapshot_never_starts_node_and_old_cache_marks_stale(tmp_path, monkeypatch):
    values = {"POLYMARKET_WALLET_ADDRESS": "wallet"}
    reader, calls = bridge(tmp_path, values, monkeypatch)
    for _ in range(10): reader.snapshot()
    assert calls == []
    reader.refresh()
    reader._checked -= 121
    assert reader.snapshot()["stale"] is True
    assert reader.snapshot()["available"] is False

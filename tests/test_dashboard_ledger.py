from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest


SPEC = importlib.util.spec_from_file_location("dashboard_ledger", Path(__file__).resolve().parents[1] / "scripts/dashboard/ledger.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
Ledger = MODULE.Ledger


def append(path, *records):
    with path.open("ab") as source:
        for record in records:
            source.write(json.dumps(record).encode() + b"\n")


@pytest.fixture
def fixture(tmp_path):
    path = tmp_path / "journal.jsonl"
    ledger = Ledger(tmp_path / "ledger.sqlite3")
    ledger.register_run("one", "paper", None, path, 1)
    return ledger, path


def fill(**kwargs):
    return {"event": "fill", "market_slug": "btc-1", "price": 0.4, "shares": 10, "fee": 0.1, **kwargs}


def test_restart_partial_line_and_identical_legitimate_fills(fixture):
    ledger, path = fixture
    append(path, fill(), fill())
    with path.open("ab") as source:
        source.write(b'{"event":"cancel"')
    first = ledger.ingest("one", max_records=1)
    assert first["records"] == 1
    restarted = Ledger(ledger.path)
    assert restarted.ingest("one")["inserted"] == 1
    assert restarted.summary("one")["fill_count"] == 2
    assert restarted.ingest("one")["records"] == 0
    with path.open("ab") as source:
        source.write(b'}\n')
    assert restarted.ingest("one")["inserted"] == 1
    assert restarted.summary("one")["fill_notional"] == 8
    assert restarted.summary("one")["fees"] == 0.2


def test_stable_id_dedup_and_run_scoping(fixture, tmp_path):
    ledger, path = fixture
    append(path, fill(event_id="stable"), fill(event_id="stable"), fill(), fill())
    ledger.ingest("one")
    assert ledger.summary("one")["fill_count"] == 3
    assert ledger.summary("one")["duplicate_records"] == 1
    other = tmp_path / "other.jsonl"
    append(other, fill(event_id="stable"))
    ledger.register_run("two", "live", "account2", other)
    ledger.ingest("two")
    page = ledger.events("one", limit=2)
    assert len(page["events"]) == 2
    remaining = ledger.events("one", before_id=page["next_before_id"], limit=2)
    assert len(remaining["events"]) == 1
    assert remaining["next_before_id"] is None
    assert ledger.summary("two")["fill_count"] == 1
    with pytest.raises(KeyError):
        ledger.events("unknown")


def test_summary_unknown_fees_and_net_settlement(fixture):
    ledger, path = fixture
    append(path, fill(fee=None), {"event": "stopped", "market_slug": "btc-1", "pnl": 500},
           {"event": "resolved", "market_slug": "empty", "pnl": 99},
           {"event": "resolved", "market_slug": "btc-1", "pnl": 5.9, "fees": 0.1},
           {"event": "resolved", "market_slug": "btc-1", "pnl": 5.9})
    ledger.ingest("one")
    summary = ledger.summary("one")
    assert summary["fees"] is None
    assert summary["missing_fee_count"] == 1
    assert summary["settled_markets"] == 1
    assert summary["settled_pnl"] == 5.9  # Engine already deducted fees.
    assert summary["order_lifecycle_available"] is False
    stopped = next(row for row in ledger.events("one")["events"] if row["event"] == "stopped")
    assert stopped["pnl"] is None


@pytest.mark.parametrize("change", ["truncate", "rewrite", "replace"])
def test_unsafe_source_change_is_sticky_error(fixture, change):
    ledger, path = fixture
    append(path, fill())
    ledger.ingest("one")
    if change == "truncate":
        path.write_bytes(b"")
    elif change == "rewrite":
        path.write_bytes(path.read_bytes().replace(b"0.4", b"0.5"))
    else:
        path.rename(path.with_suffix(".old"))
        append(path, fill())
    assert ledger.ingest("one")["error"]
    append(path, fill())
    assert ledger.ingest("one")["error"]
    assert ledger.summary("one")["fill_count"] == 1


def test_ingestion_transaction_rolls_back_checkpoint_and_rows(fixture, monkeypatch):
    ledger, path = fixture
    append(path, fill(), fill())
    def fail(*args):
        raise RuntimeError("simulated process failure")
    monkeypatch.setattr(ledger, "_accumulate", fail)
    with pytest.raises(RuntimeError):
        ledger.ingest("one")
    restarted = Ledger(ledger.path)
    assert restarted.summary("one")["byte_offset"] == 0
    assert restarted.events("one")["events"] == []
    assert restarted.ingest("one")["inserted"] == 2


def test_allowlist_and_invalid_numbers(fixture):
    ledger, path = fixture
    append(path, fill(price=float("nan"), fee=True, message="SECRET", private_key="SECRET", config={"secret": "SECRET"}),
           {"event": "error", "message": "SECRET", "error": "SECRET"})
    with path.open("ab") as source:
        source.write(b"invalid json\n")
    ledger.ingest("one")
    summary = ledger.summary("one")
    assert summary["invalid_records"] == 1
    assert summary["fill_notional"] is None
    assert summary["fees"] is None
    assert "SECRET" not in json.dumps(ledger.events("one"))
    assert "path" not in summary


def test_byte_bound_and_waiting_for_initial_file(fixture):
    ledger, path = fixture
    assert ledger.ingest("one")["pending"]
    append(path, fill(), fill())
    line_size = len(path.read_bytes().splitlines(keepends=True)[0])
    result = ledger.ingest("one", max_bytes=line_size + 3)
    assert result["bytes"] == line_size
    assert result["records"] == 1
    assert result["pending"]
    assert ledger.ingest("one")["inserted"] == 1


def test_registration_immutable_and_wal_readonly(fixture):
    ledger, path = fixture
    ledger.register_run("one", "paper", None, path, 1)
    with pytest.raises(ValueError):
        ledger.register_run("one", "live", None, path, 1)
    with sqlite3.connect(ledger.path) as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    reader = Ledger(ledger.path, readonly=True)
    assert reader.summary("one")["event_count"] == 0
    assert reader.list_runs()[0]["run_id"] == "one"
    with pytest.raises(sqlite3.OperationalError):
        reader.register_run("other", "paper", None, path)

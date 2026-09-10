from __future__ import annotations

import json
from pathlib import Path
import sys
import time
from unittest.mock import Mock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dashboard.ledger import Ledger
from dashboard.projection_worker import ProjectionWorker
from dashboard.read_model import ReadModel, atomic_json, read_json


def append(path, record=None):
    with path.open("ab") as handle:
        handle.write(json.dumps(record or {"event": "fill", "price": .4, "shares": 5, "fee": 0}).encode() + b"\n")


def selected(tmp_path):
    journal = tmp_path / "journal.jsonl"
    append(journal)
    directory = tmp_path / "view"
    atomic_json(directory / "selection.json", {"run_id": "one", "mode": "paper", "path": str(journal)})
    worker = ProjectionWorker(directory)
    return worker, journal


def test_idle_cycles_do_not_recompute_or_rewrite_data(tmp_path, monkeypatch):
    worker, journal = selected(tmp_path)
    counts = {}
    for name in ("summary", "legacy_stats", "ingest"):
        counts[name] = Mock(wraps=getattr(worker.ledger, name))
        monkeypatch.setattr(worker.ledger, name, counts[name])
    worker.step()
    snapshot = (worker.directory / "snapshot.json").stat().st_mtime_ns
    first_version = read_json(worker.directory / "snapshot.json")["snapshot_version"]
    for _ in range(40):
        worker.step()
    assert {name: fn.call_count for name, fn in counts.items()} == {"summary": 1, "legacy_stats": 1, "ingest": 1}
    assert (worker.directory / "snapshot.json").stat().st_mtime_ns == snapshot
    append(journal)
    worker.step()
    value = read_json(worker.directory / "snapshot.json")
    assert value["summary"]["fill_count"] == 2
    assert value["snapshot_version"] != first_version
    assert read_json(worker.directory / "heartbeat.json")["snapshot_version"] == value["snapshot_version"]


def test_idle_ingest_does_not_open_sqlite(tmp_path, monkeypatch):
    worker, _ = selected(tmp_path)
    worker.step()
    monkeypatch.setattr(worker.ledger, "_connect", lambda: pytest.fail("idle ingest opened SQLite"))
    assert worker.ledger.ingest_if_changed("one")["records"] == 0


@pytest.mark.parametrize("change", ["truncate", "rewrite", "replace"])
def test_metadata_change_keeps_journal_integrity_checks(tmp_path, change):
    worker, journal = selected(tmp_path)
    worker.step()
    if change == "truncate":
        journal.write_bytes(b"")
    elif change == "rewrite":
        journal.write_bytes(journal.read_bytes().replace(b"0.4", b"0.5"))
    else:
        journal.rename(journal.with_suffix(".old"))
        append(journal)
    worker.step()
    assert read_json(worker.directory / "snapshot.json")["ingestion"]["error"]
    assert "one" not in worker.ledger._idle_sources


def test_pending_invalid_records_and_recovery_are_not_hidden(tmp_path):
    worker, journal = selected(tmp_path)
    worker.step()
    with journal.open("ab") as handle:
        handle.write(b'invalid\n{"event":"cancel"')
    worker.step()
    value = read_json(worker.directory / "snapshot.json")
    assert value["summary"]["invalid_records"] == 1
    assert value["ingestion"]["pending"] is True
    with journal.open("ab") as handle:
        handle.write(b'}\n')
    worker.step()
    value = read_json(worker.directory / "snapshot.json")
    assert value["summary"]["event_count"] == 2
    assert value["summary"]["invalid_records"] == 1
    assert value["ingestion"]["pending"] is False


def test_new_historical_registration_append_and_selection_remain_visible(tmp_path):
    worker, first = selected(tmp_path)
    worker.step()
    historical = tmp_path / "historical.jsonl"
    append(historical)
    external = Ledger(worker.ledger.path)
    external.register_run("two", "paper", None, historical)
    worker.step()
    assert external.summary("two")["fill_count"] == 1
    append(historical)
    worker.step()
    assert external.summary("two")["fill_count"] == 2
    atomic_json(worker.directory / "selection.json", {"run_id": "two", "mode": "paper", "path": str(historical)})
    append(first)
    worker.step()
    assert read_json(worker.directory / "snapshot.json")["run_id"] == "two"
    assert external.summary("one")["fill_count"] == 2


def test_heartbeat_keeps_idle_data_fresh_but_cannot_mask_dead_or_stalled_worker(tmp_path):
    worker, _ = selected(tmp_path)
    worker.step()
    model = ReadModel(worker.directory)
    model._process = Mock()
    model._process.poll.return_value = None
    value = read_json(worker.directory / "snapshot.json")
    value["as_of"] = time.time() - 60
    atomic_json(worker.directory / "snapshot.json", value)
    assert model.snapshot("one")["stale"] is False
    model._process.poll.return_value = 0
    assert model.snapshot("one")["stale"] is True
    model._process.poll.return_value = None
    heartbeat = read_json(worker.directory / "heartbeat.json")
    heartbeat["as_of"] = time.time() - 4
    atomic_json(worker.directory / "heartbeat.json", heartbeat)
    assert model.snapshot("one")["stale"] is True
    heartbeat.update(as_of=time.time(), snapshot_version="different-worker-version")
    atomic_json(worker.directory / "heartbeat.json", heartbeat)
    assert model.snapshot("one")["stale"] is True

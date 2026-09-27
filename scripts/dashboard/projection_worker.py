"""Read-only journal projection worker; never loads account configuration."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import threading
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.ledger import Ledger
from dashboard.read_model import MAX_SNAPSHOT_BYTES, atomic_json, read_json


def bounded_snapshot(value):
    """Keep the HTTP snapshot bounded while full lifecycle history stays in SQLite."""
    stats = value["stats"]
    runtime = stats.get("runtime") or {}
    arrays = [(stats, "orders"), (stats, "market_summaries"), (stats, "events"),
              (runtime, "books"), (runtime, "markets")]
    while len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        for owner, key in arrays:
            if owner.get(key):
                owner[key] = owner[key][:len(owner[key]) // 2]
                stats["snapshot_truncated"] = True
                if key == "orders":
                    stats["orders_truncated"] = True
                elif owner is runtime:
                    runtime["truncated"] = True
                break
        else:
            raise ValueError("projection metadata exceeds snapshot budget")
    return value


class ProjectionWorker:
    def __init__(self, directory: Path):
        self.directory = directory
        self.ledger = Ledger(directory / "ledger.sqlite3")
        self.selected = None
        self.progress_state = None
        self.snapshot_version = None
        self.last_heartbeat = 0.0
        self.runtime_expires_at = None

    def step(self):
        iteration = time.monotonic()
        selection_path = self.directory / "selection.json"
        selection = read_json(selection_path, 8192)
        source_path = Path(selection.get("path", ""))
        if not source_path.is_file():
            # A removed stopped run must not keep the worker pending forever.
            # A new run writes its journal before publishing a fresh selection.
            selection_path.unlink(missing_ok=True)
            self.selected = None
            self.progress_state = None
            self.runtime_expires_at = None
            return
        run_id = selection["run_id"]
        changed_selection = selection != self.selected
        if changed_selection:
            self.ledger.register_run(run_id, selection["mode"], selection.get("account_id"),
                                     selection["path"], selection.get("config_revision"))
        progress = self.ledger.ingest_if_changed(run_id, max_bytes=262144, max_records=1000)
        state = {key: value for key, value in progress.items() if key not in {"records", "inserted", "bytes"}}
        expired = self.runtime_expires_at is not None and time.time() > self.runtime_expires_at
        projected = changed_selection or state != self.progress_state or bool(progress["records"]) or expired
        if projected:
            summary = self.ledger.summary(run_id)
            stats = self.ledger.runtime_stats(run_id, summary=summary)
            if progress.get("error"):
                stats["error"] = "交易日志变化或损坏，统计待核对"
            version = uuid.uuid4().hex
            atomic_json(self.directory / "snapshot.json", bounded_snapshot({
                "schemaVersion": 2, "run_id": run_id, "as_of": time.time(),
                "snapshot_version": version,
                "stats": stats, "summary": summary, "ingestion": progress,
                "projection_ms": (time.monotonic() - iteration) * 1000,
            }))
            runtime = stats.get("runtime")
            self.runtime_expires_at = runtime["expires_at"] if runtime and not runtime["stale"] else None
            self.snapshot_version = version
            self.progress_state = state
            self.selected = selection
        # A successful source check refreshes liveness without rewriting data.
        # Version binding prevents a previous worker/selection blessing old data.
        if projected or iteration - self.last_heartbeat >= 1:
            atomic_json(self.directory / "heartbeat.json", {
                "run_id": run_id, "snapshot_version": self.snapshot_version,
                "as_of": time.time(),
            })
            self.last_heartbeat = iteration


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--parent-pipe", action="store_true")
    args = parser.parse_args()
    if args.parent_pipe:
        def watch_parent():
            sys.stdin.buffer.read()
            os._exit(0)  # SQLite rolls back incomplete work; no orphan on parent crash.
        threading.Thread(target=watch_parent, daemon=True).start()
    directory = args.directory.resolve()
    if hasattr(os, "nice"):
        os.nice(5)
    worker = ProjectionWorker(directory)
    while True:
        iteration = time.monotonic()
        try:
            worker.step()
        except Exception:
            # Existing snapshot ages out. Never overwrite it with fabricated zeros
            # or expose raw exceptions, journal records or local paths in errors.
            pass
        time.sleep(max(0.05, 0.25 - (time.monotonic() - iteration)))


if __name__ == "__main__":
    main()

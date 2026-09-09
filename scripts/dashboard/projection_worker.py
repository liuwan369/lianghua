"""Read-only journal projection worker; never loads account configuration."""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.ledger import Ledger
from dashboard.read_model import atomic_json, read_json


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
    ledger = Ledger(directory / "ledger.sqlite3")
    selected = None
    historical_cursor = ""
    while True:
        iteration = time.monotonic()
        try:
            selection = read_json(directory / "selection.json", 8192)
            run_id = selection["run_id"]
            if selection != selected:
                ledger.register_run(run_id, selection["mode"], selection.get("account_id"),
                                    selection["path"], selection.get("config_revision"))
                selected = selection
            progress = ledger.ingest(run_id, max_bytes=262144, max_records=1000)
            prior = ledger.next_historical_run(run_id, historical_cursor)
            if prior:
                ledger.ingest(prior, max_bytes=262144, max_records=1000)
                historical_cursor = prior
            summary = ledger.summary(run_id)
            stats = ledger.legacy_stats(run_id)
            if progress.get("error"):
                stats["error"] = "交易日志变化或损坏，统计待核对"
            atomic_json(directory / "snapshot.json", {
                "schemaVersion": 1, "run_id": run_id, "as_of": time.time(),
                "stats": stats, "summary": summary, "ingestion": progress,
                "projection_ms": (time.monotonic() - iteration) * 1000,
            })
        except Exception:
            # Existing snapshot ages out. Never overwrite it with fabricated zeros
            # or expose raw exceptions, journal records or local paths in errors.
            pass
        time.sleep(max(0.05, 0.25 - (time.monotonic() - iteration)))


if __name__ == "__main__":
    main()

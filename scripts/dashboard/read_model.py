"""A bounded snapshot reader and a separate, low-priority analytics process.

HTTP handlers never ingest journals. The child receives no trading credentials;
it only reads a manifest written by the controller and produces an atomic view.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from .ledger import Ledger

MAX_SNAPSHOT_BYTES = 256 * 1024


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, allow_nan=False)
        handle.flush()
    os.replace(temporary, path)


def read_json(path: Path, maximum: int = MAX_SNAPSHOT_BYTES) -> dict:
    with path.open("rb") as handle:
        raw = handle.read(maximum + 1)
    if len(raw) > maximum:
        raise ValueError("snapshot exceeds size limit")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("invalid snapshot")
    return result


class ReadModel:
    def __init__(self, directory: Path):
        self.directory = Path(directory).resolve()
        self._lock = threading.Lock()
        self._selection: dict | None = None
        self._process: subprocess.Popen | None = None
        self._cache: dict = {}
        self._cached_mtime: int | None = None
        self._next_restart = 0.0

    @property
    def db_path(self) -> Path:
        return self.directory / "ledger.sqlite3"

    def select(self, run_id: str, mode: str, account_id: str | None,
               path: Path, config_revision: int | None = None) -> None:
        selection = {"run_id": run_id, "mode": mode, "account_id": account_id,
                     "path": str(path.resolve()), "config_revision": config_revision}
        with self._lock:
            if selection != self._selection:
                Ledger(self.db_path).register_run(run_id, mode, account_id, path, config_revision)
                atomic_json(self.directory / "selection.json", selection)
                self._selection = selection
                self._cache = {}
                self._cached_mtime = None
            self._ensure_worker()

    def _ensure_worker(self) -> None:
        if self._process is not None and self._process.poll() is None:
            return
        if time.monotonic() < self._next_restart:
            return
        self._next_restart = time.monotonic() + 5
        # Explicit allowlist: no inherited Owner, Relayer, Builder or .env keys.
        allowed = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"}
        env = {k: v for k, v in os.environ.items() if k.upper() in allowed}
        env["PYTHONIOENCODING"] = "utf-8"
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
        script = Path(__file__).with_name("projection_worker.py")
        self._process = subprocess.Popen(
            [sys.executable, str(script), "--directory", str(self.directory), "--parent-pipe"],
            env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=flags,
        )

    def snapshot(self, run_id: str | None) -> dict:
        with self._lock:
            alive = self._process is not None and self._process.poll() is None
            try:
                path = self.directory / "snapshot.json"
                modified = path.stat().st_mtime_ns
                if modified != self._cached_mtime:
                    value = read_json(path)
                    if value.get("run_id") == run_id:
                        self._cache = value
                        self._cached_mtime = modified
            except (OSError, ValueError):
                # Preserve last known values as stale; never replace them with 0.
                alive = False
            value = copy.deepcopy(self._cache) if self._cache.get("run_id") == run_id else {}
            age = max(0, time.time() - value.get("as_of", 0)) if value else None
            damaged = bool(value.get("ingestion", {}).get("error") or
                           value.get("summary", {}).get("invalid_records"))
            return {**value, "run_id": run_id, "worker_alive": alive,
                    "age_seconds": age,
                    "stale": not alive or age is None or age > 3,
                    "state": "incomplete" if damaged else ("catching_up" if value.get("ingestion", {}).get("pending")
                              else "ready" if value else "waiting")}

    def close(self) -> None:
        with self._lock:
            process, self._process = self._process, None
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        if process and process.stdin:
            process.stdin.close()

"""One long-lived, read-only account bridge; HTTP callers only read snapshots."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import queue
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


class AccountData:
    def __init__(self, engine: Path, values_loader, interval: float = 30, timeout: float = 90):
        self.engine, self.values_loader = Path(engine), values_loader
        self.interval, self.timeout = max(30., interval), timeout
        self._lock = threading.RLock()
        self._refresh_lock = threading.Lock()
        self._identity = None
        self._process = None
        self._queue = None
        self._cache = self._empty(None, "not_checked")
        self._checked = 0.
        self._attempt = float("-inf")

    @staticmethod
    def _empty(wallet, code):
        return {"schemaVersion": 1, "wallet": wallet or None, "read_only": True, "available": False, "stale": True, "checked_at": None, "error_code": code}

    def _account(self):
        try:
            values = {key: value.strip().strip("'\"").strip() for key, value in self.values_loader().items() if isinstance(value, str)}
            wallet = values.get("POLYMARKET_WALLET_ADDRESS") or values.get("POLY_FUNDER") or ""
            identity = hashlib.sha256(json.dumps(values, sort_keys=True).encode()).digest()
        except Exception:
            values, wallet, identity = {}, "", b"invalid"
        with self._lock:
            if identity != self._identity:
                self._identity = identity
                self._cache = self._empty(wallet, "account_changed")
                self._checked, self._attempt = 0., float("-inf")
                self._stop_process()
        return values, wallet, identity

    def _stop_process(self):
        process, self._process = self._process, None
        self._queue = None
        if process is not None:
            try:
                process.terminate()
            except OSError:
                pass
            # Reaping is asynchronous; changing account never blocks HTTP.
            def reap():
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                finally:
                    for stream in (process.stdin, process.stdout):
                        if stream:
                            stream.close()
            threading.Thread(target=reap, name="account-reader-reap", daemon=True).start()

    def _spawn(self, values):
        env = os.environ.copy()
        for key in ("POLYMARKET_WALLET_ADDRESS", "POLYMARKET_OWNER_PRIVATE_KEY", "POLYMARKET_PRIVATE_KEY", "POLYMARKET_SESSION_PRIVATE_KEY", "POLY_FUNDER", "POLY_SIGNATURE_TYPE", "RELAYER_API_KEY", "RELAYER_API_KEY_ADDRESS", "POLY_BUILDER_API_KEY", "POLY_BUILDER_SECRET", "POLY_BUILDER_PASSPHRASE"):
            env.pop(key, None)
        for key in ("POLYMARKET_WALLET_ADDRESS", "POLYMARKET_OWNER_PRIVATE_KEY", "POLYMARKET_PRIVATE_KEY", "POLY_FUNDER"):
            if values.get(key):
                env[key] = values[key]
        if os.environ.get("PM_ACCOUNT_RPC_URL"):
            env["POLYGON_RPC"] = os.environ["PM_ACCOUNT_RPC_URL"]
        if os.environ.get("PM_ACCOUNT_NODE_COMPILE_CACHE"):
            env["NODE_COMPILE_CACHE"] = os.environ["PM_ACCOUNT_NODE_COMPILE_CACHE"]
        process = subprocess.Popen(["node", str(self.engine / "dist" / "cli" / "account-data.js")], cwd=self.engine,
                                   env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   text=True, encoding="utf-8", bufsize=1)
        messages = queue.Queue(maxsize=2)
        def read():
            try:
                for line in process.stdout:
                    if len(line) > 32_000_000:
                        messages.put(None)
                        break
                    messages.put(line)
            finally:
                try:
                    messages.put_nowait(None)
                except queue.Full:
                    pass
        threading.Thread(target=read, name="account-reader-json", daemon=True).start()
        self._process, self._queue = process, messages
        return process, messages

    def snapshot(self):
        self._account()  # Account changes invalidate immediately, before any refresh.
        with self._lock:
            result = copy.deepcopy(self._cache)
            age = time.monotonic()-self._checked if self._checked else None
        result["cache_age_seconds"] = age
        result["stale"] = age is None or age > max(120., self.interval*3)
        if result["stale"]:
            result["available"] = False
        return result

    def refresh(self):
        """Background-only. Nonoverlapping, rate-limited and account-bound."""
        if not self._refresh_lock.acquire(blocking=False):
            return False
        try:
            values, wallet, identity = self._account()
            with self._lock:
                if time.monotonic()-self._attempt < self.interval:
                    return False
                self._attempt = time.monotonic()
                if not wallet:
                    self._cache = self._empty(None, "account_not_configured")
                    return False
                process, messages = (self._process, self._queue)
                if process is None or process.poll() is not None:
                    process, messages = self._spawn(values)
            try:
                process.stdin.write('{"command":"refresh"}\n')
                process.stdin.flush()
                line = messages.get(timeout=self.timeout)
                if line is None:
                    raise ValueError("reader closed")
                result = json.loads(line)
                if not isinstance(result, dict) or result.get("error_code") or str(result.get("wallet", "")).lower() != wallet.lower():
                    raise ValueError("invalid response")
                source_age = time.time()-datetime.fromisoformat(result["checked_at"]).timestamp()
                if not (-5 <= source_age <= self.timeout+5) or result.get("read_only") is not True:
                    raise ValueError("invalid source clock")
                for key in ("collateral", "open_orders", "trades", "positions", "closed_positions", "activity"):
                    section = result.get(key)
                    if not isinstance(section, dict) or not isinstance(section.get("available"), bool) or not isinstance(section.get("complete"), bool) or not isinstance(section.get("items"), list):
                        raise ValueError("missing account section")
                result["available"] = any(result[key].get("available") for key in ("collateral", "open_orders", "trades", "positions", "closed_positions", "activity"))
                # Reject a reply if the saved account changed during network I/O.
                _, _, current = self._account()
                with self._lock:
                    if current != identity:
                        return False
                    self._cache, self._checked = result, time.monotonic()
                return True
            except Exception:
                with self._lock:
                    if identity == self._identity:
                        self._stop_process()
                        self._cache = self._empty(wallet, "account_data_fetch_failed")
                        self._checked = 0.
                return False
        finally:
            self._refresh_lock.release()

    def run(self, stop: threading.Event):
        try:
            while not stop.is_set():
                try:
                    self.refresh()
                except Exception:
                    # Missing runtime/profile is a typed unavailable state, not a dead worker.
                    with self._lock:
                        self._cache = self._empty(None, "account_reader_unavailable")
                stop.wait(1)
        finally:
            with self._lock:
                self._stop_process()

    def invalidate(self):
        with self._lock:
            self._identity = None
        self._account()

    def close(self):
        with self._lock:
            self._stop_process()

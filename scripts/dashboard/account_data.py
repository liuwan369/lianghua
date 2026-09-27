"""One long-lived, read-only account bridge; HTTP callers only read snapshots."""
from __future__ import annotations

import copy
import hashlib
import json
import queue
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from dashboard_account import child_environment, contains_secret


class _ReaderError(RuntimeError):
    """Fixed diagnostic codes only; never expose a child error or environment."""


_SECTIONS = ("collateral", "open_orders", "trades", "positions", "closed_positions", "activity")


class AccountData:
    def __init__(self, engine: Path, values_loader, interval: float = 30, timeout: float = 90):
        self.engine, self.values_loader = Path(engine).resolve(), values_loader
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
        env = child_environment(values)
        entry = self.engine / "dist" / "cli" / "account-data.js"
        if not self.engine.is_dir():
            raise _ReaderError("account_engine_missing")
        if not entry.is_file():
            raise _ReaderError("account_reader_build_missing")
        node = shutil.which("node")
        if not node:
            raise _ReaderError("account_node_missing")
        try:
            process = subprocess.Popen([node, str(entry)], cwd=self.engine,
                                       env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                       text=True, encoding="utf-8", bufsize=1)
        except ValueError:
            raise _ReaderError("account_reader_config_invalid") from None
        messages = queue.Queue(maxsize=2)
        def read():
            try:
                for line in process.stdout:
                    if len(line) > 32_000_000:
                        break
                    try:
                        messages.put_nowait(line)
                    except queue.Full:
                        break
            except (OSError, UnicodeError):
                pass
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
        result["stale"] = bool(result.get("error_code")) or age is None or age > max(120., self.interval*3)
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
            try:
                with self._lock:
                    process, messages = (self._process, self._queue)
                    if process is None or process.poll() is not None:
                        process, messages = self._spawn(values)
                process.stdin.write('{"command":"refresh"}\n')
                process.stdin.flush()
                line = messages.get(timeout=self.timeout)
                if line is None:
                    raise _ReaderError("account_reader_exited")
                result = json.loads(line)
                if isinstance(result, dict) and result.get("error_code"):
                    raise _ReaderError("account_data_fetch_failed")
                if not isinstance(result, dict) or contains_secret(result, values) or str(result.get("wallet", "")).lower() != wallet.lower():
                    raise ValueError("invalid response")
                source_age = time.time()-datetime.fromisoformat(result["checked_at"]).timestamp()
                if not (-5 <= source_age <= self.timeout+5) or result.get("read_only") is not True:
                    raise ValueError("invalid source clock")
                for key in _SECTIONS:
                    section = result.get(key)
                    if not isinstance(section, dict) or not isinstance(section.get("available"), bool) or not isinstance(section.get("complete"), bool) or not isinstance(section.get("items"), list):
                        raise ValueError("missing account section")
                # Reject a reply if the saved account changed during network I/O.
                _, _, current = self._account()
                with self._lock:
                    if current != identity:
                        return False
                    # A failed section must not erase the last observed balance
                    # or orders while unrelated public queries still succeed.
                    for key in (*_SECTIONS, "order_history", "fees", "rewards", "reconciliation", "occupancy"):
                        section, previous = result.get(key), self._cache.get(key)
                        if (isinstance(section, dict)
                                and (section.get("available") is False or (key in _SECTIONS and section.get("error_code") and not section.get("complete")))
                                and isinstance(previous, dict)):
                            result[key] = {**previous, "available": False, "complete": False, "stale": True,
                                           "error_code": section.get("error_code") or "account_section_fetch_failed",
                                           "attempted_at": section.get("checked_at")}
                    result["available"] = any(result[key].get("available") for key in _SECTIONS)
                    if not result["available"]:
                        result["error_code"] = "account_sections_unavailable"
                    self._cache, self._checked = result, time.monotonic()
                return True
            except Exception as exc:
                if isinstance(exc, _ReaderError):
                    code = str(exc)
                elif isinstance(exc, PermissionError):
                    code = "account_reader_permission_denied"
                elif isinstance(exc, FileNotFoundError):
                    code = "account_reader_executable_missing"
                elif isinstance(exc, (queue.Empty, subprocess.TimeoutExpired)):
                    code = "account_reader_timeout"
                elif isinstance(exc, (ValueError, TypeError, KeyError, UnicodeError)):
                    code = "account_response_invalid"
                elif isinstance(exc, (BrokenPipeError, OSError)):
                    code = "account_reader_io_failed"
                else:
                    code = "account_reader_unavailable"
                with self._lock:
                    if identity == self._identity:
                        self._stop_process()
                        if self._checked:
                            self._cache = {
                                **self._cache,
                                "error_code": code,
                            }
                        else:
                            self._cache = self._empty(wallet, code)
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
                        if self._cache.get("available") or self._cache.get("checked_at"):
                            self._cache = {**self._cache, "error_code": "account_reader_unavailable", "stale": True}
                        else:
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

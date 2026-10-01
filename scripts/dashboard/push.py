"""Server-sent push for the console (PUSH-ARCHITECTURE.md).

A browser subscribes to the exact REST paths it would otherwise poll. Each
distinct path is rendered by the real GET handler, so a pushed body is the REST
body by construction. The hub renders every subscribed path on its own cadence,
each in its own worker so one slow source (the trading lock is held up to 8 s
on stop) never delays the others, and hands a browser a block only when its
content changed. A slow browser only ever holds the latest body per path.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

# Fields that change on every render without the data changing.
VOLATILE_KEYS = frozenset({"asOf", "as_of", "age_seconds", "ageSeconds", "cache_age_seconds", "cacheAgeSeconds",
                           "checked_at", "checkedAt", "refreshing", "ageMs", "quoteAgeMs", "lag_bytes",
                           "to"})  # metrics: the range end is "now"

# Pushable paths and how often each is re-rendered, seconds. The collector
# writes every 250 ms and the ledger about 4 times a second.
CADENCE = (
    ("/api/markets", 0.1),
    ("/api/runtime/status", 0.25),
    ("/api/rounds", 0.5),
    ("/api/fills", 0.5),
    ("/api/settlements", 1.0),
    ("/api/events", 1.0),
    ("/api/account/snapshot", 1.0),
    ("/api/metrics/summary", 2.0),
    ("/api/account/status", 2.0),
    ("/api/runtime/market-pool", 2.0),
    ("/api/strategy/config", 2.0),
    ("/api/diagnostics/health", 2.0),
)
MAX_PATHS_PER_CLIENT = 24
KEEPALIVE_SEC = 5.0


def cadence(path: str) -> float | None:
    route = path.split("?", 1)[0]
    for prefix, seconds in CADENCE:
        if route == prefix or route.startswith(prefix + "/"):
            return seconds
    return None


def fingerprint(value) -> str:
    def strip(item):
        if isinstance(item, dict):
            return {key: strip(sub) for key, sub in item.items() if key not in VOLATILE_KEYS}
        if isinstance(item, list):
            return [strip(sub) for sub in item]
        return item
    return hashlib.sha256(json.dumps(strip(value), sort_keys=True, ensure_ascii=False,
                                     default=str).encode("utf-8")).hexdigest()


class Client:
    def __init__(self, paths: list[str]):
        self.paths = paths
        self.pending: dict[str, tuple[int, bytes]] = {}
        self.cond = threading.Condition()
        self.closed = False

    def offer(self, path: str, version: int, body: bytes) -> None:
        with self.cond:
            self.pending[path] = (version, body)  # older body for this path is dropped
            self.cond.notify()

    def take(self, timeout: float) -> dict[str, tuple[int, bytes]]:
        with self.cond:
            if not self.pending and not self.closed:
                self.cond.wait(timeout)
            ready, self.pending = self.pending, {}
            return ready

    def close(self) -> None:
        with self.cond:
            self.closed = True
            self.cond.notify()


class PushHub:
    def __init__(self, render, *, token=None, max_clients: int = 50, workers: int = 6, tick: float = 0.05):
        """render(path) -> (status, body_bytes) using the real GET handler.
        token(path) -> a cheap value that changes whenever the path's source
        data may have changed (e.g. the ledger file's mtime), or None when
        unknown. An unchanged token skips the render until the keepalive."""
        self.render = render
        self.token = token or (lambda path: None)
        self.rendered_token: dict[str, object] = {}
        self.max_clients = max_clients
        self.tick = tick
        self.lock = threading.Lock()
        self.clients: set[Client] = set()
        self.latest: dict[str, tuple[int, str, bytes, float]] = {}   # path -> (version, fingerprint, body, sent_at)
        self.next_due: dict[str, float] = {}
        self.in_flight: set[str] = set()
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="push-render")

    @staticmethod
    def valid_paths(paths: list[str]) -> list[str]:
        unique = []
        for path in paths:
            if (isinstance(path, str) and path.startswith("/api/") and len(path) <= 512
                    and cadence(path) is not None and path not in unique):
                unique.append(path)
        return unique[:MAX_PATHS_PER_CLIENT]

    def subscribe(self, paths: list[str]) -> Client | None:
        client = Client(self.valid_paths(paths))
        with self.lock:
            if len(self.clients) >= self.max_clients:
                return None
            self.clients.add(client)
            for path in client.paths:
                self.next_due.setdefault(path, 0.0)
                if path in self.latest:   # a new browser starts from the full current value
                    version, _, body, _ = self.latest[path]
                    client.offer(path, version, body)
        return client

    def unsubscribe(self, client: Client) -> None:
        client.close()
        with self.lock:
            self.clients.discard(client)
            wanted = {path for other in self.clients for path in other.paths}
            for path in list(self.next_due):
                if path not in wanted:
                    self.next_due.pop(path, None)
                    self.latest.pop(path, None)
                    self.rendered_token.pop(path, None)

    def _render(self, path: str) -> None:
        try:
            # Read the token before rendering: the body is then at least as new.
            token = self.token(path)
            now = time.monotonic()
            with self.lock:
                prior = self.latest.get(path)
                fresh = prior is not None and now - prior[3] < KEEPALIVE_SEC
                if token is not None and fresh and self.rendered_token.get(path) == token:
                    return  # the source did not change; skip the render entirely
            status, body = self.render(path)
            self.rendered_token[path] = token
            if status != 200:
                return  # keep the last good body; the browser's REST fallback reports the error
            mark = fingerprint(json.loads(body))
            now = time.monotonic()
            with self.lock:
                prior = self.latest.get(path)
                # Unchanged content is still re-sent every KEEPALIVE seconds so
                # the browser's copy carries an honest, recent asOf.
                if prior and prior[1] == mark and now - prior[3] < KEEPALIVE_SEC:
                    return
                version = (prior[0] + 1) if prior else 1
                self.latest[path] = (version, mark, body, now)
                targets = [client for client in self.clients if path in client.paths]
            for client in targets:
                client.offer(path, version, body)
        except Exception:
            pass  # one broken source never stops the hub or the other blocks
        finally:
            with self.lock:
                self.in_flight.discard(path)

    def step(self, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        with self.lock:
            due = [path for path, at in self.next_due.items() if at <= now and path not in self.in_flight]
            for path in due:
                self.in_flight.add(path)
                self.next_due[path] = now + (cadence(path) or 1.0)
        for path in due:
            self.pool.submit(self._render, path)

    def run(self, stop: threading.Event) -> None:
        while not stop.wait(self.tick):
            self.step()
        self.pool.shutdown(wait=False, cancel_futures=True)
        with self.lock:
            for client in self.clients:
                client.close()

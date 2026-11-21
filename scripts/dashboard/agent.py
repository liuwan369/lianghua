"""The console's client of one engine box's agent (scripts/engine_agent.py).

One poller per console polls GET /state each second and keeps the answer in
memory; every page and push render reads that cache, so the engine box is
asked once a second however many browsers are open. Unreachable is its own
state: the cache keeps the last answer for display but `process_running()` is
None ("unknown"), and every write is refused until the agent answers again.
Writes are also refused when the agent's box or wallet is not the one this
console expects (a tunnel pointed at the wrong box).

The same client drives journal replication into the console's replica dir.
"""
from __future__ import annotations

import base64
import json
import threading
import time
import urllib.error
import urllib.request

from .replica import JournalReplica

POLL_SECONDS = 1.0
# A stop waits up to 8 s on the agent before answering; the browser allows 30 s.
WRITE_TIMEOUT = 20.0
READ_TIMEOUT = 5.0
# The previous poll is "fresh" for this long; past it the agent counts as unreachable.
STALE_AFTER = 5.0


class AgentUnavailable(RuntimeError):
    """The agent cannot be trusted with a write right now (unreachable, wrong box/wallet, replica behind)."""


class AgentError(RuntimeError):
    """The agent answered with an error: its HTTP status and message pass through."""

    def __init__(self, status: int, message: str, body: dict | None = None):
        super().__init__(message)
        self.status, self.body = status, body or {}


class AgentClient:
    def __init__(self, url: str, *, expected_box: str, expected_wallet: str | None,
                 replica: JournalReplica, chunk_bytes: int = 1 << 20):
        self.url = url.rstrip("/")
        self.expected_box = expected_box
        self.expected_wallet = (expected_wallet or "").lower() or None
        self.replica = replica
        self.chunk_bytes = chunk_bytes
        self._lock = threading.Lock()
        self._state: dict | None = None
        self._polled_at = 0.0           # monotonic time of the last good poll
        self._error: str | None = None
        self._snapshot: dict | None = None
        self._snapshot_version = None
        self._replicated: dict[str, int] = {}   # run -> bytes copied
        self._diverged: set[str] = set()

    # --- transport ---
    def _request(self, method: str, path: str, body: dict | None = None, timeout: float = READ_TIMEOUT) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as error:
            try:
                value = json.loads(error.read() or b"{}")
            except ValueError:
                value = {}
            raise AgentError(error.code, str(value.get("error") or f"引擎机返回 {error.code}"), value) from None
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise AgentUnavailable("连不上引擎机") from error

    # --- the cached state ---
    def poll(self) -> None:
        try:
            state = self._request("GET", "/state")
            version = (state.get("accountSnapshot") or {}).get("version")
            snapshot = None
            if version != self._snapshot_version:
                snapshot = self._request("GET", "/account/snapshot")
        except (AgentUnavailable, AgentError) as error:
            with self._lock:
                self._error = str(error)
            return
        with self._lock:
            self._state, self._polled_at, self._error = state, time.monotonic(), None
            if snapshot is not None:
                self._snapshot, self._snapshot_version = snapshot, version

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self.poll()
            try:
                self.replicate()
            except (AgentUnavailable, AgentError, OSError, ValueError):
                pass
            stop.wait(POLL_SECONDS)

    def reachable(self) -> bool:
        with self._lock:
            return self._state is not None and self._error is None and time.monotonic() - self._polled_at <= STALE_AFTER

    def _mismatch(self, state: dict | None) -> str | None:
        if not state:
            return None
        if self.expected_box and state.get("box") != self.expected_box:
            return f"引擎机不对：应该是 {self.expected_box}，连上的是 {state.get('box') or '未知'}"
        wallet = ((state.get("status") or {}).get("account") or {}).get("wallet") or ""
        if self.expected_wallet and wallet.lower() != self.expected_wallet:
            return "引擎机上的钱包和这个账户不一致"
        return None

    def view(self) -> dict:
        """What the console renders: the last state, whether it is current, and why not."""
        with self._lock:
            state = self._state
            error = self._error
            age = time.monotonic() - self._polled_at if self._polled_at else None
        reachable = state is not None and error is None and age is not None and age <= STALE_AFTER
        skew = (state.get("now") - time.time()) if reachable and isinstance((state or {}).get("now"), (int, float)) else None
        return {"reachable": reachable, "error": error if not reachable else None, "ageSeconds": age,
                "mismatch": self._mismatch(state), "clockSkewSeconds": skew, "state": state}

    def process_running(self) -> bool | None:
        view = self.view()
        if not view["reachable"] or view["mismatch"]:
            return None
        return (view["state"].get("status") or {}).get("running") is True

    def account_snapshot(self) -> dict | None:
        with self._lock:
            return self._snapshot

    # --- writes ---
    def _guard(self) -> dict:
        view = self.view()
        if not view["reachable"]:
            raise AgentUnavailable("连不上引擎机，暂时不能操作")
        if view["mismatch"]:
            raise AgentUnavailable(view["mismatch"])
        return view["state"]

    def post(self, path: str, body: dict) -> dict:
        self._guard()
        return self._request("POST", path, body, timeout=WRITE_TIMEOUT)

    def command(self, payload: dict) -> dict:
        state = self._guard()
        if payload.get("action") == "start":
            # The previous run's journal must be fully copied (and so fully
            # ingested before the new run is selected), or its tail is lost.
            for run in state.get("runs") or []:
                if not self.replica_complete(run.get("run_id")):
                    raise AgentUnavailable("上一次的运行记录还没复制完，稍等几秒再启动")
        return self._request("POST", "/commands", payload, timeout=WRITE_TIMEOUT)

    # --- replication ---
    def replica_complete(self, run_id: str | None) -> bool:
        if not run_id:
            return True
        view = self.view()
        runs = {run.get("run_id"): run.get("bytes") for run in ((view["state"] or {}).get("runs") or [])}
        if run_id not in runs:
            return True
        try:
            held = self.replica.path(run_id).stat().st_size
        except FileNotFoundError:
            held = 0
        return run_id not in self._diverged and held >= (runs[run_id] or 0)

    def replicate(self) -> dict:
        """Copy one chunk of each run the agent lists. {"behind": more remains anywhere}."""
        view = self.view()
        behind = False
        for run in (view["state"] or {}).get("runs") or []:
            run_id = run.get("run_id")
            if not run_id or run_id in self._diverged:
                continue
            request = self.replica.pull_request(run_id)
            if request["offset"] >= (run.get("bytes") or 0):
                continue
            chunk = self._request("GET", f"/journal?run={run_id}&offset={request['offset']}"
                                         f"&tail={request['tail']}&max={self.chunk_bytes}")
            chunk["data"] = base64.b64decode(chunk.get("data") or "")
            result = self.replica.apply(run_id, chunk)
            if result["diverged"]:
                self._diverged.add(run_id)
                continue
            behind = behind or result["behind"]
        return {"behind": behind, "diverged": sorted(self._diverged)}

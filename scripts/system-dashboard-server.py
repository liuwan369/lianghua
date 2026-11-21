from __future__ import annotations

import argparse
import copy
from collections import OrderedDict
import hashlib
import io
import json
import math
import os
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dashboard.agent import AgentClient, AgentError, AgentUnavailable
from dashboard.strategy_config import STRATEGY_ID, ASSET_ID
from dashboard.ledger import Ledger, LEAD_RANGES, _range_start
from dashboard.read_model import ReadModel
from dashboard.replica import JournalReplica
from dashboard.push import PushHub
from dashboard import official_pnl
from dashboard.system_metrics import SystemMetrics
from dashboard.timestamps import epoch as _epoch


CONSOLE_ROOT = Path(__file__).resolve().parents[1]
# This console's own data: the ledger, its projection files, the journal
# replica and the run selection. Never the engine box's results/ (on the same
# box the agent writes backend/engine/results; this is data/console).
DATA_DIR = Path(os.environ.get("PM_CONSOLE_DATA", str(CONSOLE_ROOT / "data" / "console")))
AGENT_URL = os.environ.get("PM_AGENT_URL", "http://127.0.0.1:18767")
EXPECTED_BOX = os.environ.get("PM_AGENT_BOX", "")
EXPECTED_WALLET = os.environ.get("PM_ACCOUNT_WALLET", "")
# Which account this instance serves (config/accounts.json); every page it
# serves lives under /acct/<id>/ behind nginx. Empty = the bare paths.
ACCOUNT_ID = os.environ.get("PM_ACCOUNT_ID", "")
ACCOUNTS_FILE = CONSOLE_ROOT / "config" / "accounts.json"
_trading_lock = threading.RLock()
_official_cache: tuple = (None, None)   # (account snapshot, round results)
_official_last_good: tuple | None = None   # (round results, time) of the last complete venue read
_ACCOUNT_HISTORY_SECTIONS = frozenset({"trades", "activity", "closed_positions", "order_history", "fees", "rewards", "reconciliation"})
_agent: AgentClient | None = None
_agent_lock = threading.Lock()
_read_model: ReadModel | None = None
_read_model_init_lock = threading.Lock()
_config_control_lock = threading.RLock()
_system_metrics: SystemMetrics | None = None
_system_metrics_lock = threading.Lock()
_modern_cache_lock = threading.Lock()
_modern_response_cache: OrderedDict = OrderedDict()
# The run the console shows: the agent's current run, kept here so a stopped
# run stays selected after a restart (data/console/selection-run.json).
_selected: dict | None = None

_STATIC_CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


def _static_content_type(path: Path) -> str:
    return _STATIC_CONTENT_TYPES.get(path.suffix.lower(), "application/octet-stream")


def agent() -> AgentClient:
    global _agent
    with _agent_lock:
        if _agent is None:
            _agent = AgentClient(AGENT_URL, expected_box=EXPECTED_BOX, expected_wallet=EXPECTED_WALLET,
                                 replica=JournalReplica(DATA_DIR / "replica"))
        return _agent


_fill_watermark: tuple | None = None
_fill_watermark_lock = threading.Lock()


def _note_fill_watermark(value: dict) -> None:
    """Ask the agent to re-read the account when a newer fill appears.

    Balance only moves on fills, so instead of polling the wallet harder we let
    the fills projection drive the refresh. Cheap: compares the newest fill
    identity and does nothing when unchanged. Never raises into the response.
    """
    global _fill_watermark
    try:
        items = value.get("items") if isinstance(value, dict) else None
        if not isinstance(items, list) or not items:
            return
        newest = items[0] if isinstance(items[0], dict) else {}
        mark = (newest.get("id"), newest.get("tradeId") or newest.get("trade_id"),
                newest.get("orderId") or newest.get("order_id"))
        if not any(part is not None for part in mark):
            return
        with _fill_watermark_lock:
            if _fill_watermark == mark:
                return
            first_seen = _fill_watermark is None
            _fill_watermark = mark
        # Skip the very first observation: it is the existing history, not a new
        # fill, and a refresh there would cost a wallet read on every restart.
        if first_seen:
            return

        def refresh():
            try:
                agent().post("/account/refresh", {})
            except (AgentUnavailable, AgentError):
                pass
        threading.Thread(target=refresh, daemon=True).start()
    except Exception:
        return


def _account_snapshot() -> dict:
    """The agent's last account snapshot; stale whenever the agent is unreachable."""
    view = agent().view()
    snapshot = agent().account_snapshot()
    if not isinstance(snapshot, dict):
        return {"schemaVersion": 1, "read_only": True, "available": False, "stale": True, "checked_at": None,
                "error_code": "account_reader_unavailable" if view["reachable"] else "engine_box_unreachable"}
    if not view["reachable"]:
        return {**snapshot, "available": False, "stale": True, "error_code": "engine_box_unreachable"}
    meta = (view["state"] or {}).get("accountSnapshot") or {}
    return {**snapshot, "stale": bool(snapshot.get("stale") or meta.get("stale")),
            "cache_age_seconds": meta.get("cacheAgeSeconds")}


def _metric_services() -> dict:
    """This box's console processes; the engine box reports its own through the agent."""
    with _read_model_init_lock:
        projection_process = getattr(_read_model, "_process", None) if _read_model else None
        projection_pid = getattr(projection_process, "pid", None)
        projection_running = bool(projection_process and projection_process.poll() is None)
    return {
        "dashboard": {"pid": os.getpid(), "state": "active"},
        "projection": {"pid": projection_pid if projection_running else None, "state": "active" if projection_running else "stopped"},
    }


def system_metrics() -> SystemMetrics:
    global _system_metrics
    with _system_metrics_lock:
        if _system_metrics is None:
            _system_metrics = SystemMetrics(CONSOLE_ROOT, _metric_services)
        return _system_metrics


def refresh_system_metrics(stop: threading.Event) -> None:
    system_metrics().run(stop)


def _selection_path() -> Path:
    return DATA_DIR / "selection-run.json"


def _load_selection() -> dict | None:
    global _selected
    if _selected is None:
        try:
            value = json.loads(_selection_path().read_text(encoding="utf-8"))
            _selected = value if isinstance(value, dict) and isinstance(value.get("run_id"), str) else {}
        except (OSError, ValueError):
            _selected = {}
    return _selected or None


def _save_selection(value: dict | None) -> None:
    global _selected
    _selected = value or {}
    path = _selection_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(_selected, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def _sync_selection() -> None:
    """Follow the agent's current run; a stopped run stays selected."""
    view = agent().view()
    status = (view["state"] or {}).get("status") or {}
    run_id = status.get("run_id")
    if not view["reachable"] or view["mismatch"] or not isinstance(run_id, str) or not run_id:
        return
    current = _load_selection() or {}
    wanted = {"run_id": run_id, "account_id": status.get("account_id"),
              "config_revision": status.get("config_revision"), "mode": "live"}
    if {key: current.get(key) for key in wanted} != wanted:
        # The replica must exist before the run is selected (the projection
        # worker reads a missing journal as a removed run and drops it).
        agent().replica.ensure(run_id)
        with _trading_lock:
            _save_selection(wanted)
            _modern_response_cache.clear()


def _selection_tuple() -> tuple:
    selected = _load_selection() or {}
    run_id = selected.get("run_id")
    path = agent().replica.path(run_id) if run_id else None
    return (run_id, path, "live" if run_id else None, selected.get("account_id"), selected.get("config_revision"))


def supervise_projection(stop: threading.Event) -> None:
    while not stop.wait(1):
        try:
            _sync_selection()
            _activate_projection()
        except (OSError, sqlite3.Error, ValueError):
            pass


def account_config_status() -> dict:
    """The engine box's account status (from the agent), or an unknown state."""
    view = agent().view()
    account = ((view["state"] or {}).get("status") or {}).get("account")
    if not view["reachable"] or not isinstance(account, dict):
        return {"wallet": EXPECTED_WALLET or "", "account_check_state": "unknown", "account_check_ready": False,
                "accountCheckState": "unknown", "accountCheckReady": False, "live_start_ready": False,
                "liveStartReady": False, "last_check": None, "last_check_at": None,
                "last_check_error": "engine_box_unreachable", "server_live_enabled": None}
    return account


def trading_status(include_stats: bool = True) -> dict:
    """The engine box's process facts (agent) merged with this console's
    projection of the replicated journal. Unreachable is "unknown": running is
    None, never False."""
    view = agent().view()
    agent_status = dict(((view["state"] or {}).get("status")) or {})
    reachable = view["reachable"] and not view["mismatch"]
    running = agent_status.get("running") if reachable else None
    status = {**agent_status, "running": running,
              "agent": {"reachable": view["reachable"], "error": view["error"], "mismatch": view["mismatch"],
                        "box": (view["state"] or {}).get("box"), "clockSkewSeconds": view["clockSkewSeconds"],
                        "ageSeconds": view["ageSeconds"]}}
    if not reachable:
        status["service_state"] = "unknown"
        status["command_status"] = "executing"
    if not include_stats:
        return status
    stats = trade_log_stats(_selection_tuple())
    projection = stats.get("projection")
    if isinstance(projection, dict):
        stats = {**stats, "projection": {**projection, "trader_alive": running}}
    runtime = stats.get("runtime")
    if running is False and isinstance(runtime, dict):
        runtime = dict(runtime)
        stop_result = status.get("stop_result") or {}
        automatic = stop_result if stop_result.get("automatic") else {}
        runtime["status"] = ("failed" if automatic.get("reason") in {
            "journal_failed", "market_end_event_failed", "process_failed",
        } else "stopped")
        runtime["stale"] = True
        stats = {**stats, "runtime": runtime}
    status["stats"] = stats
    runtime = stats.get("runtime")
    if running is True:
        strategy_runtime = runtime.get("strategy_runtime") if isinstance(runtime, dict) else None
        if isinstance(strategy_runtime, dict) and strategy_runtime.get("paused") is True:
            status["service_state"] = "paused"
        elif isinstance(runtime, dict) and runtime.get("status") == "running":
            status["service_state"] = "running"
        else:
            status["service_state"] = "starting"
        params = status.get("params") or {}
        pending = params.get("pendingControl") or {}
        source_at = _epoch(runtime.get("source_at")) if isinstance(runtime, dict) else None
        expires_at = _epoch(runtime.get("expires_at")) if isinstance(runtime, dict) else None
        # The last pause/resume decides; before any, how the run was started.
        expected_paused = pending.get("action") == "pause" if pending else params.get("startPaused") is True
        projection_ready = (isinstance(projection, dict)
                            and projection.get("state") == "ready"
                            and projection.get("stale") is False)
        # No runtime row exists for the first 0-3 s of a run (BUGS P2-11).
        runtime_row_fresh = (isinstance(runtime, dict) and runtime.get("stale") is not True
                              and source_at is not None and source_at <= time.time() + 1
                              and expires_at is not None and expires_at > time.time())
        confirmed = (isinstance(runtime, dict) and runtime.get("status") == "running"
                     and source_at is not None
                     and (runtime_row_fresh or projection_ready)
                     and source_at >= (pending.get("requestedAt") or status.get("started_at") or float("inf"))
                     and isinstance(strategy_runtime, dict)
                     and strategy_runtime.get("paused") is expected_paused)
        status["command_status"] = "confirmed" if confirmed else "executing"
    return status


def _run_identity() -> str | None:
    return (_load_selection() or {}).get("run_id")


def _projection_snapshot(selection: tuple | None = None) -> dict:
    selection = selection or _selection_tuple()
    run_id, path, mode, account, revision = selection
    if not path or not run_id or mode != "live":
        return {"state": "idle", "run_id": None, "stale": True}
    try:
        with _read_model_init_lock:
            view = _read_model.snapshot(run_id) if _read_model else {"state": "waiting", "run_id": run_id, "stale": True}
    except (OSError, ValueError):
        return {"state": "unavailable", "run_id": run_id, "stale": True}
    # The replica compares itself with itself, so a stalled copy would look
    # caught up. The agent's size of this run is the truth.
    if not agent().replica_complete(run_id):
        view = {**view, "stale": True, "replication_behind": True,
                "state": "catching_up" if view.get("state") == "ready" else view.get("state")}
    return view


def _activate_projection() -> None:
    """Single supervisor owns analytics selection; requests cannot rewind it."""
    global _read_model
    run_id, path, mode, account, revision = _selection_tuple()
    if not path or mode != "live":
        return
    with _read_model_init_lock:
        if _read_model is None:
            _read_model = ReadModel(DATA_DIR)
        _read_model.select(run_id, mode, account, path, revision)


def trade_log_stats(selection: tuple | None = None) -> dict:
    view = _projection_snapshot(selection)
    stats = view.get("stats")
    if not isinstance(stats, dict):
        stats = {"available": False, "file": None, "quotes": 0, "fills": 0, "takers": 0, "cancels": 0,
                 "markets": 0, "traded_markets": 0, "fill_notional": 0.0, "fees": None, "settled_markets": 0,
                 "pnl": None, "last_event": None, "error": None, "events": [], "market_summaries": []}
    runtime = stats.get("runtime")
    if isinstance(runtime, dict):
        runtime = dict(runtime)
        source_at, expires_at = runtime.get("source_at"), runtime.get("expires_at")
        valid_times = (type(source_at) in {int, float} and type(expires_at) in {int, float}
                       and math.isfinite(source_at) and math.isfinite(expires_at))
        runtime["age_seconds"] = max(0, time.time() - source_at) if valid_times else None
        runtime["stale"] = bool(runtime.get("stale") or view.get("stale") or not valid_times
                                or time.time() >= expires_at)
    return {**stats, "runtime": runtime, "projection": {k: view.get(k) for k in
             ("state", "run_id", "as_of", "age_seconds", "stale", "worker_alive", "projection_ms", "replication_behind")},
            "pending": bool(stats.get("pending") or view.get("ingestion", {}).get("pending"))}


NODE_LABEL = os.environ.get("PM_NODE_LABEL", "爱尔兰")
MUTATING_ROUTES = frozenset({"/api/runtime/commands", "/api/strategy/drafts", "/api/strategy/activate",
                             "/api/ledger/reset"})


def _mutation_request_error(headers) -> tuple[int, str] | None:
    """The one login is nginx Basic Auth over HTTPS (config/pm-console-nginx.conf).

    nginx overwrites X-PM-Authenticated with the authenticated user and
    X-Forwarded-Proto with the scheme; the backend listens on loopback only.
    A mutation needs both, plus PM_TRUST_ACCOUNT_PROXY=1 on this server, a JSON
    body (a cross-site form cannot send one without a CORS preflight) and an
    https Origin naming this host. Anything else, a direct loopback request
    included, is refused.
    """
    content_type = (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return 415, "请求格式必须是 JSON"
    origin, host = headers.get("Origin") or "", headers.get("Host") or ""
    parsed = urlsplit(origin)
    if not origin or parsed.scheme != "https" or not host or parsed.netloc != host:
        return 403, "请求来源不允许"
    if (os.environ.get("PM_TRUST_ACCOUNT_PROXY") != "1" or not headers.get("X-PM-Authenticated")
            or headers.get("X-Forwarded-Proto") != "https"):
        return 401, "请从带登录保护的 HTTPS 页面操作"
    return None


def _running_runtime() -> tuple[bool, dict | None, dict]:
    """(engine process running, its latest projected runtime, projection view).

    Reads the agent cache and the projection snapshot only, so a 1 s push of
    the book stays cheap. Unknown counts as not running here: no book is shown
    for an engine nobody can see."""
    if agent().process_running() is not True:
        return False, None, {}
    stats = trade_log_stats(_selection_tuple())
    runtime = stats.get("runtime") if isinstance(stats.get("runtime"), dict) else None
    return True, runtime, stats.get("projection") or {}


def _book_side(side, token_id):
    if not isinstance(side, dict):
        return None
    levels = lambda key: [level for level in (side.get(key) or [])[:5]
                          if isinstance(level, list) and len(level) == 2][:5]
    return {"tokenId": side.get("assetId") or token_id,
            **{key: side.get(key) for key in ("bid", "ask", "bidSize", "askSize", "sourceAt", "expiresAt",
                                              "depthSourceAt", "depthExpiresAt")},
            "bids": levels("bids"), "asks": levels("asks")}


def runtime_book() -> dict:
    """GET /api/runtime/book: the running engine's book of its current round.

    The engine's paired snapshot (best bid/ask and 5 levels a side, venue
    times) as it rode the last platform_status line (every 2 s), so the book is
    up to ~2 s behind the venue. {running: false} without an engine."""
    running, runtime, projection = _running_runtime()
    empty = {"schemaVersion": 1, "running": running, "available": False, "source": "platform-runtime",
             "asOf": None, "stale": True}
    if not running:
        return {**empty, "error": None}
    if not runtime:
        return {**empty, "error": "runtime_snapshot_pending"}
    now = time.time()
    strategy = runtime.get("strategy_runtime") if isinstance(runtime.get("strategy_runtime"), dict) else {}
    current = strategy.get("currentRound") if isinstance(strategy.get("currentRound"), dict) else {}
    markets = [m for m in runtime.get("markets") or [] if isinstance(m, dict)]
    market = next((m for m in markets if current.get("marketId") and m.get("id") == current.get("marketId")), None) \
        or next((m for m in markets if (m.get("startsAt") or 0) <= now < (m.get("endsAt") or 0)), None)
    if market is None:
        return {**empty, "asOf": runtime.get("source_at"), "error": "no_current_round"}
    snapshot = next((item for item in runtime.get("snapshots") or []
                     if isinstance(item, dict) and item.get("marketId") == market.get("id")), None)
    tokens = {i.get("outcome"): i.get("tokenId") for i in market.get("instruments") or [] if isinstance(i, dict)}
    expires_at = _epoch((snapshot or {}).get("expiresAt"))
    source_at = _epoch((snapshot or {}).get("sourceAt"))
    stale = bool(snapshot is None or runtime.get("stale") or expires_at is None or expires_at <= now)
    up = _book_side((snapshot or {}).get("YES"), tokens.get("Up"))
    down = _book_side((snapshot or {}).get("NO"), tokens.get("Down"))
    return {"schemaVersion": 1, "running": True, "available": snapshot is not None,
            "source": "platform-runtime", "asOf": source_at, "stale": stale,
            "error": None if not stale else "book_snapshot_unavailable" if snapshot is None else "book_snapshot_stale",
            "marketId": market.get("id"), "roundId": market.get("roundId"), "name": market.get("name"),
            "startsAt": market.get("startsAt"), "endsAt": market.get("endsAt"),
            "sequence": (snapshot or {}).get("sequence"), "sourceAt": source_at, "expiresAt": expires_at,
            "runtimeAt": runtime.get("source_at"),
            "ageMs": round((now - source_at) * 1000) if source_at is not None else None,
            "up": up, "down": down,
            "twoSided": bool(up and down and up.get("ask") is not None and down.get("ask") is not None),
            # What the strategy saw in this book at its last frame (binance-lead.ts LeadQuote).
            "strategyView": current.get("latest") if current.get("marketId") == market.get("id") else None,
            "projection": {key: projection.get(key) for key in ("state", "stale", "age_seconds")}}


def _lead_feed_view(runtime: dict | None, running: bool) -> dict:
    """Lead feed per venue and line from the latest runtime, plus the relay listener."""
    runtime = runtime or {}
    lines = runtime.get("lead_lines") if isinstance(runtime.get("lead_lines"), dict) else {}
    now_ms = time.time() * 1000
    venues = {}
    for venue, by_line in (lines.get("venues") or {}).items():
        venues[venue] = {}
        for line, counters in (by_line or {}).items():
            last = counters.get("lastAt")
            venues[venue][line] = {**counters,
                                   "lastTradeAgeSeconds": round((now_ms - last) / 1000, 3) if last else None}
    return {"running": running, "healthy": runtime.get("lead_feed_healthy") if running else None,
            "venues": runtime.get("lead_venues"), "relayConfigured": runtime.get("lead_relay"),
            "direct": runtime.get("lead_direct"),
            "lines": venues, "relayListener": lines.get("relay"), "asOf": runtime.get("source_at")}


def health() -> dict:
    """GET /api/diagnostics/health: the engine box through its agent (CPU,
    memory, engine, account reader), this console box (projection) and the
    lead feed. Problems are listed in `error`."""
    status = trading_status()
    view = agent().view()
    engine_box = (view["state"] or {}).get("metrics") or {}
    console_box = system_metrics().snapshot()
    runtime_view = _modern_runtime(status)
    stats = status.get("stats") or {}
    runtime = stats.get("runtime") if isinstance(stats.get("runtime"), dict) else None
    projection = stats.get("projection") or {}
    account = _account_snapshot()
    problems = []
    if not view["reachable"]:
        problems.append("engine_box_unreachable")
    elif view["mismatch"]:
        problems.append("engine_box_mismatch")
    if view["clockSkewSeconds"] is not None and abs(view["clockSkewSeconds"]) > 1:
        problems.append("clock_skew")
    # A stopped process intentionally has an expired last-round snapshot. That
    # is not a runtime outage when it stopped cleanly; report failures, and
    # stale runtime data while a process is expected to publish.
    stop_result = status.get("stop_result") if isinstance(status.get("stop_result"), dict) else {}
    clean_stopped = (status.get("running") is False and status.get("command_status") == "confirmed"
                     and stop_result.get("remote_orders_state") == "confirmed"
                     and stop_result.get("confirmed") is not False
                     and stop_result.get("reason") not in {"journal_failed", "market_end_event_failed", "process_failed"})
    if runtime_view["status"] == "failed" or (runtime_view["stale"] and not clean_stopped and status.get("run_id")):
        problems.append("trading_runtime_unavailable")
    if status.get("run_id") and (projection.get("stale", True) or projection.get("state") != "ready"):
        problems.append("ledger_projection_unavailable")
    metric_at = _epoch(console_box.get("asOf"))
    if metric_at is None or not -1 <= time.time() - metric_at <= 15 or console_box.get("stale"):
        problems.append("resource_snapshot_stale")
    feed = _lead_feed_view(runtime, status.get("running") is True)
    if feed["running"] and feed["healthy"] is False:
        problems.append("lead_feed_unhealthy")
    relay = feed.get("relayListener") or {}
    if feed["running"] and feed.get("relayConfigured") and (relay.get("listening") is False or relay.get("error")):
        problems.append("relay_listener_down")
    if account.get("error_code") not in (None, "account_not_configured", "not_checked") and account.get("stale"):
        problems.append("account_bridge_unavailable")
    engine_services = engine_box.get("services") or {}
    console_services = console_box.get("services") or {}
    return {"schemaVersion": 1, "status": "degraded" if problems else "ok", "nodeLabel": NODE_LABEL,
            "source": "control-plane", "asOf": metric_at, "stale": bool(problems),
            "engineBox": {"box": (view["state"] or {}).get("box"), "reachable": view["reachable"],
                          "mismatch": view["mismatch"], "clockSkewSeconds": view["clockSkewSeconds"]},
            "services": {
                "engine": {"running": status.get("running"), "pid": status.get("pid"),
                           "state": status.get("service_state"), "runId": status.get("run_id"),
                           "runtimeStale": runtime_view["stale"], "runtimeAsOf": runtime_view["asOf"],
                           "process": engine_services.get("trader")},
                "accountBridge": {"available": account.get("available"), "stale": account.get("stale"),
                                  "error": account.get("error_code"),
                                  "cacheAgeSeconds": account.get("cache_age_seconds"),
                                  "process": engine_services.get("account_bridge")},
                "projection": {**projection, "process": console_services.get("projection")},
                "console": {"process": console_services.get("dashboard")}},
            "leadFeed": feed, "resources": engine_box, "consoleResources": console_box,
            "error": "; ".join(problems) if problems else None}


def strategy_config_status() -> dict:
    """The published config lives on the engine box (the engine hot-reloads it)."""
    view = agent().view()
    saved = (view["state"] or {}).get("config")
    if not isinstance(saved, dict):
        raise RuntimeError("engine_box_unreachable")
    status = trading_status()
    runtime = (status.get("stats", {}).get("runtime") or {}).get("strategy_runtime") or {}
    active = (runtime.get("currentRound") or {}).get("configRevision") if status.get("running") else None
    if isinstance(active, str) and active.isdigit():
        active = int(active)
    return {**saved, "assetId": saved["config"].get("assetId", "btc"), "activeRevision": active,
            "nextRoundRevision": saved["savedRevision"] if status.get("running") and active != saved["savedRevision"] else None,
            "stale": not view["reachable"]}


def accounts_view() -> dict:
    """GET /api/accounts: every account on this console box, for the switcher.
    Labels, colours and box names only; ports and agent URLs stay here."""
    try:
        accounts = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8")).get("accounts") or []
    except (OSError, ValueError):
        accounts = []
    return {"schemaVersion": 1, "source": "control-plane", "asOf": time.time(), "stale": False, "error": None,
            "current": ACCOUNT_ID or None,
            "accounts": [{key: item.get(key) for key in ("id", "label", "color", "box")}
                         for item in accounts if isinstance(item, dict) and item.get("id")]}


def _prefix() -> str:
    return f"/acct/{ACCOUNT_ID}" if ACCOUNT_ID else ""


def strategy_draft() -> dict | None:
    return (agent().view()["state"] or {}).get("draft")


def strategy_control(payload: dict) -> dict:
    """Run control goes to the engine box's agent; the answer is its status
    merged with this console's view, like a status read."""
    result = agent().command(payload)
    agent().poll()   # the next status read reflects the command at once
    status = trading_status(include_stats=False)
    return {**status, **{key: result[key] for key in ("command_status", "control_requested", "control_pending",
                                                       "requested_state") if key in result}}


def _console_reset() -> dict:
    """Delete this console's ledger, projection files and journal replicas.
    The engine box deletes its own journals and state first (agent /reset)."""
    global _read_model
    report = {"replicas": 0, "projection": False}
    with _read_model_init_lock:
        if _read_model is not None:
            _read_model.close()
            _read_model = None
    replicas = DATA_DIR / "replica"
    for path in replicas.glob("dashboard-*.jsonl") if replicas.is_dir() else []:
        path.unlink()
        report["replicas"] += 1
    for suffix in ("", "-wal", "-shm"):
        projection = DATA_DIR / f"ledger.sqlite3{suffix}"
        if projection.exists():
            projection.unlink()
            report["projection"] = True
    Ledger(DATA_DIR / "ledger.sqlite3")
    for name in ("selection.json", "snapshot.json", "heartbeat.json"):
        stale = DATA_DIR / name
        if stale.exists():
            stale.unlink()
    with _trading_lock:
        _save_selection(None)
        _modern_response_cache.clear()
    return report


def _money(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def _modern_runtime(status: dict) -> dict:
    stats = status.get("stats") if isinstance(status, dict) else {}
    projection = stats.get("projection") if isinstance(stats, dict) else {}
    runtime = stats.get("runtime") if isinstance(stats, dict) else None
    projection = projection if isinstance(projection, dict) else {}
    runtime = runtime if isinstance(runtime, dict) else {}
    risk = runtime.get("risk") if isinstance(runtime.get("risk"), dict) else {}
    strategy_runtime = runtime.get("strategy_runtime") if isinstance(runtime.get("strategy_runtime"), dict) else {}
    current_round = strategy_runtime.get("currentRound") if isinstance(strategy_runtime.get("currentRound"), dict) else {}
    amount = lambda value: value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None
    # These values are only copied when the runtime explicitly reported them.
    # Unknown cash, reservations, costs, or fees stay null instead of looking
    # like released funds after a stop or an incomplete account refresh.
    funds = {
        "availableUsd": amount(risk.get("availableUsd")),
        "occupiedUsd": amount(risk.get("occupiedUsd")),
        "reservedUsd": amount(current_round.get("reservedUsd")),
        "positionCostUsd": amount(current_round.get("costUsd")),
        "estimatedFeesUsd": amount(runtime.get("estimated_fees_usd")),
        "confirmedFeesUsd": amount(runtime.get("confirmed_fees_usd")),
    }
    process_running = status.get("running") if type(status.get("running")) is bool else None
    if process_running is True:
        state = "paused" if (runtime.get("strategy_runtime") or {}).get("paused") else runtime.get("status") or "starting"
    else:
        stop_reason = (status.get("stop_result") or {}).get("reason")
        state = "failed" if stop_reason in {"journal_failed", "market_end_event_failed", "process_failed"} else "stopped"
    source_at = _epoch(runtime.get("source_at"))
    expires_at = _epoch(runtime.get("expires_at"))
    # A stopped process intentionally marks its last runtime snapshot stale;
    # that is different from the low-priority ledger projection being behind.
    # While the trading process is still alive, however, the journal
    # projection may have a fresh heartbeat even when its last platform
    # runtime row has crossed the row-level expiry. The process fact and the
    # projection heartbeat are then the authoritative control-state signals;
    # do not turn an old business snapshot into a false "runtime unavailable"
    # state. Missing runtime clocks remain stale because there is no identity
    # or freshness evidence to retain.
    projection_stale = (projection.get("stale") is True
                        or (projection.get("state") is not None and projection.get("state") != "ready"))
    runtime_snapshot_missing = not runtime or source_at is None or expires_at is None
    now = time.time()
    runtime_snapshot_expired = (not runtime_snapshot_missing and expires_at <= now)
    runtime_snapshot_clock_invalid = source_at is not None and source_at > now + 1
    projection_fresh_while_running = (
        process_running is True
        and projection.get("state") == "ready"
        and projection.get("stale") is False
    )
    stale = bool(runtime_snapshot_missing or runtime_snapshot_clock_invalid or projection_stale
                 or (runtime_snapshot_expired and not projection_fresh_while_running))
    stop_result = status.get("stop_result") if isinstance(status.get("stop_result"), dict) else {}
    # The engine's market list carries id and roundId (MarketInfo); name the
    # identity fields the way every other console DTO does.
    markets = [{**item, "marketId": item.get("id") or item.get("marketId"), "roundId": item.get("roundId")}
               for item in (runtime.get("markets") if isinstance(runtime.get("markets"), list) else [])
               if isinstance(item, dict)]
    return {"schemaVersion": 1, "status": state, "state": state,
            "serviceState": status.get("service_state") or state,
            "commandStatus": status.get("command_status") or ("executing" if status.get("running") else "confirmed"),
            # This is the direct local process fact from trading_status(); it
            # is independent from asynchronous ledger projection freshness.
            "processRunning": process_running,
            "remoteOrdersState": stop_result.get("remote_orders_state"),
            "stopResult": stop_result or None,
            "source": "platform-runtime" if runtime else "control-plane",
            "asOf": source_at,
            "stale": stale, "runId": status.get("run_id"),
            "strategyId": status.get("strategy_id") or STRATEGY_ID, "assetId": ASSET_ID,
            "configRevision": status.get("config_revision"),
            "startedAt": status.get("started_at"),
            "paused": strategy_runtime.get("paused") is True if strategy_runtime else None,
            "leadFeedHealthy": runtime.get("lead_feed_healthy") if isinstance(runtime.get("lead_feed_healthy"), bool) else None,
            # The running feed's venues and lines, fixed when the engine started.
            "leadVenues": runtime.get("lead_venues"),
            "leadRelay": runtime.get("lead_relay"),
            "leadDirect": runtime.get("lead_direct"),
            "leadLines": runtime.get("lead_lines"),
            # The strategy's verdict on the latest signals (lead_signal, newest first).
            "leadSignals": runtime.get("lead_signals") if isinstance(runtime.get("lead_signals"), list) else [],
            "currentRound": current_round or None,
            "execution": status.get("execution"), "risk": risk or None, "funds": funds, "markets": markets,
            "error": runtime.get("error") or projection.get("error")
                or ("ledger_projection_incomplete" if projection_stale else "runtime_snapshot_stale" if stale else None)
                or ((status.get("stop_result") or {}).get("message") if state == "failed" else None),
            "projection": projection}


def _api_run_id() -> str | None:
    return _run_identity()


def _official_results() -> dict | None:
    """Settled round results from the venue's Data API, via the account
    reader's last snapshot (no extra request). Recomputed only when that
    snapshot changes."""
    global _official_cache, _official_last_good
    raw = agent().account_snapshot()
    snapshot = _account_snapshot()
    marker = (id(raw), snapshot.get("stale") is True)
    if raw is not None and _official_cache[0] == marker:
        return _official_cache[1]
    results = official_pnl.round_results(snapshot)
    if results is not None:
        _official_last_good = (results, time.time())
    _official_cache = (marker, results)
    return results


def _official_or_last() -> tuple[dict | None, float | None]:
    """The venue's results, or its last good ones with their time when the
    current read is unavailable. Never the ledger's own figures: switching
    sources made the headline numbers jump between two calculations (BUGS A3)."""
    results = _official_results()
    if results is not None:
        return results, None
    if _official_last_good is not None:
        return _official_last_good
    return None, None


def _apply_official(stats: dict, run_id: str, range_name: str, asset_id, market_id=None, round_filter=None) -> dict:
    """Replace the ledger's settled figures with the venue's own (user decision
    2026-10-01). Rounds the engine traded that the venue has not settled yet
    stay as committed cost. Unchanged when the venue data is unavailable."""
    results, stale_since = _official_or_last()
    if results is None:
        return {**stats, "pnl_source": "ledger", "pnl_source_error": "official_data_unavailable",
                "status": "stale", "stale": True}
    traded = _api_ledger().traded_rounds(run_id, range=range_name, asset_id=asset_id)
    start = _range_start_for(range_name)
    if range_name == "run":
        keys = [key for key in traded if key in results]
    else:
        keys = [key for key in results if (asset_id is None or key[0] == asset_id)
                and (start is None or int(key[1]) >= start)]
    if round_filter is not None:
        keys = [key for key in keys if key[1] == str(round_filter)]
    now = time.time()
    pending = {key: cost for key, cost in traded.items()
               if key not in results and int(key[1]) + 300 <= now and (round_filter is None or key[1] == str(round_filter))}
    summary = official_pnl.summarize(results, keys)
    unsettled_cost = round(sum(pending.values()), 6)
    settled = summary["settled_pnl"]
    official_stale = {"status": "stale", "stale": True, "pnl_source_error": "official_data_stale",
                      "pnl_source_as_of": stale_since} if stale_since is not None else {}
    # Pending settlements follow the same rule as unsettled rounds: traded,
    # ended, not settled by the venue. The ledger's own count kept a round the
    # venue redeemed after the engine stopped pending forever (BUGS C2).
    return {**stats, **summary, **official_stale, "settled_pnl_pending": len(pending), "pending_settlements": len(pending),
            "unsettled_cost": unsettled_cost, "unsettled_rounds": len(pending),
            "exposed_pnl": None if settled is None and not pending else round((settled or 0) - unsettled_cost, 6),
            "pnl_source": "polymarket-data-api",
            "pnl_semantics": "venue_realized_pnl_net_of_fees"}


def _range_start_for(range_name: str):
    return _range_start(range_name, time.time())


def _api_ledger() -> Ledger:
    return Ledger(DATA_DIR / "ledger.sqlite3", readonly=True)


_lead_cache: OrderedDict = OrderedDict()


def _ledger_stamp() -> tuple:
    """Changes whenever a ledger view may change: the ledger's data version
    (every business write; a platform_status line alone leaves it), and the
    projection's freshness, which the views report as `stale`. The file mtime
    moved on every 2 s status line, so a cached view was never reused."""
    try:
        version = _api_ledger().data_version()
    except (OSError, sqlite3.Error):
        version = None
    view = _projection_snapshot()
    return (version, view.get("run_id"), view.get("state"), bool(view.get("stale")))


def _cached_view(key: tuple, build) -> dict:
    """A ledger view's data from memory while `key` (path, run, official
    results, _ledger_stamp()) is unchanged; built once otherwise. The caller
    adds fresh metadata (asOf, stale) to a copy."""
    with _modern_cache_lock:
        cached = _lead_cache.get(key)
    if cached is None:
        cached = build()
        with _modern_cache_lock:
            _lead_cache[key] = cached
            while len(_lead_cache) > 32:
                _lead_cache.popitem(last=False)
    return copy.deepcopy(cached)


def _current_account_id() -> str | None:
    account_id = (_load_selection() or {}).get("account_id")
    if account_id:
        return account_id.lower()
    wallet = EXPECTED_WALLET or account_config_status().get("wallet")
    return wallet.lower() if isinstance(wallet, str) and wallet else None


def _scoped_run_id(run_id: str | None) -> str | None:
    if not isinstance(run_id, str) or not run_id or len(run_id) > 200:
        return None
    account_id = _current_account_id()
    if not account_id:
        return None
    try:
        owner = _api_ledger().run_account_id(run_id)
    except (KeyError, OSError, sqlite3.Error, RuntimeError):
        return None
    return run_id if isinstance(owner, str) and owner.lower() == account_id else None


def _ledger_metadata(run_id: str | None) -> dict:
    view = _projection_snapshot()
    current = run_id is not None and view.get("run_id") == run_id
    try:
        metadata = _api_ledger().metadata(run_id) if run_id else {
            "source": "ledger", "asOf": None, "stale": True, "error": "ledger_projection_unavailable"}
        # snapshot/heartbeat clocks describe projection liveness, not business
        # source time. Keep API asOf tied to runtime/event source_at while
        # still propagating a stale or damaged worker state.
        if current and (view.get("state") != "ready" or view.get("stale")):
            metadata = {**metadata, "stale": True,
                        "error": metadata.get("error") or "ledger_projection_unavailable"}
        return metadata
    except (KeyError, OSError, sqlite3.Error, RuntimeError):
        return {"source": "ledger", "asOf": None, "stale": True, "error": "ledger_projection_unavailable"}


def _event_dto(event: dict) -> dict:
    kind = event.get("event") or event.get("kind") or "unknown"
    market = event.get("market")
    market_id = (event.get("marketId") or event.get("market_id") or
                 (market if isinstance(market, str) and market.startswith("0x") else None))
    round_id = event.get("roundId") or event.get("round_id")
    # kind=error is a channel, not a severity: account_recovery_started is a
    # notice and market_feed_unhealthy a warning. Leave those to the console's
    # code-based rule (view-model eventSeverity) instead of painting them red (BUGS P3-1).
    severity = None if kind == "error" else "warning" if kind == "unresolved" else "info"
    asset_id = event.get("assetId") or event.get("asset_id")
    trade_id = event.get("tradeId") or event.get("trade_id")
    order_id = event.get("orderId") or event.get("order_id")
    client_order_id = event.get("clientOrderId") or event.get("client_order_id")
    token_id = event.get("tokenId") or event.get("token_id")
    trade_status = event.get("tradeStatus") or event.get("trade_status")
    fee_source = event.get("feeSource") or event.get("fee_source")
    result = {**event, "assetId": asset_id, "asset_id": asset_id, "kind": kind, "marketId": market_id, "roundId": round_id,
            "time": _epoch(event.get("time")), "severity": severity,
            "message": event.get("message") or event.get("reason") or kind}
    # Journal projection stores canonical snake_case fields. Modern clients
    # consume camelCase DTOs, so expose both without changing revision rows or
    # inventing identifiers that were absent from the journal.
    result.update({"tradeId": trade_id, "orderId": order_id,
                   "clientOrderId": client_order_id, "tokenId": token_id,
                   "tradeStatus": trade_status, "feeSource": fee_source,
                   "feeUsd": _money(event.get("fee")),
                   "status": event.get("status") or (trade_status if kind == "fill" else None)})
    if kind == "settlement":
        result.update({"payoutVerified": event.get("payout_verified") is True,
                       "accountingState": event.get("accounting_state"),
                       "pnlError": event.get("pnl_error"),
                       "pnl": _money(event.get("pnl")),
                       "settlementRequired": event.get("settlement_required"),
                       "redemptionRequired": event.get("redemption_required"),
                       "settlement_required": event.get("settlement_required"),
                       "redemption_required": event.get("redemption_required")})
    return result


def _order_dto(order: dict) -> dict:
    result = dict(order)
    market = order.get("market")
    market_id = order.get("marketId") or order.get("market_id") or (
        market if isinstance(market, str) and market.startswith("0x") else None)
    round_id = order.get("roundId") or order.get("round_id")
    asset_id = order.get("assetId") or order.get("asset_id")
    result.update({"assetId": asset_id, "asset_id": asset_id,
                   "clientOrderId": order.get("client_order_id"), "orderId": order.get("order_id"),
                   "marketId": market_id, "roundId": round_id,
                   "filledShares": order.get("filled_shares"), "updatedAt": _epoch(order.get("updated_at") or order.get("time")),
                   "createdAt": _epoch(order.get("created_at")),
                   "averagePrice": order.get("average_price")})
    result["fills"] = [_event_dto(fill) for fill in order.get("fills", []) if isinstance(fill, dict)]
    return result


def _modern_events(run_id: str | None, query: dict, kinds=None) -> dict:
    if not run_id:
        return {"schemaVersion": 1, "status": "unavailable", "available": False,
                "items": None, "cursor": None, "runId": None,
                "source": "ledger", "asOf": None, "stale": True,
                "error": "当前没有运行记录"}
    cursor = query.get("cursor", [None])[0]
    requested_asset = (query.get("assetId") or [None])[0]
    try:
        before_id, limit = int(cursor) if cursor else None, int(query.get("limit", ["50"])[0])
        key = ("events", run_id, tuple(sorted(kinds)) if kinds else None,
               tuple(sorted((name, tuple(values)) for name, values in query.items())), _ledger_stamp())
        result = _cached_view(key, lambda: _api_ledger().events(
            run_id, before_id=before_id, limit=limit, kinds=kinds, asset_id=requested_asset,
            market_id=(query.get("marketId") or [None])[0], round_id=(query.get("roundId") or [None])[0]))
    except KeyError:
        return {"schemaVersion": 1, "status": "unavailable", "available": False,
                "items": None, "cursor": None, "runId": run_id,
                "source": "ledger", "asOf": None, "stale": True,
                "error": "ledger_projection_unavailable"}
    items = [_event_dto(event) for event in result["events"]]
    metadata = _ledger_metadata(run_id)
    return {"schemaVersion": 1, "status": "stale" if metadata["stale"] else "ready",
            "available": True, "items": items,
            "cursor": result.get("next_before_id"), "runId": run_id,
            **metadata}


def _modern_settlements(run_id: str | None, query: dict) -> dict:
    if not run_id:
        return {"schemaVersion": 1, "status": "unavailable", "available": False,
                "items": None, "cursor": None, "runId": None,
                "source": "ledger", "asOf": None, "stale": True,
                "error": "当前没有运行记录"}
    cursor = query.get("cursor", [None])[0]
    requested_asset = (query.get("assetId") or [None])[0]
    try:
        result = _api_ledger().settlements_page(run_id, before_id=int(cursor) if cursor else None,
                                                limit=int(query.get("limit", ["50"])[0]),
                                                asset_id=requested_asset,
                                                market_id=(query.get("marketId") or [None])[0],
                                                round_id=(query.get("roundId") or [None])[0])
    except KeyError:
        return {"schemaVersion": 1, "status": "unavailable", "available": False,
                "items": None, "cursor": None, "runId": run_id,
                "source": "ledger", "asOf": None, "stale": True,
                "error": "ledger_projection_unavailable"}
    available = result.get("available", True)
    items = [_event_dto(item) for item in result.get("settlements", [])] if available else None
    metadata = _ledger_metadata(run_id)
    stale = bool(result.get("available") is False) or metadata["stale"]
    return {"schemaVersion": 1, "status": "unavailable" if not available else "stale" if stale else "ready",
            "items": items,
            "cursor": result.get("next_before_id"), "runId": run_id, "available": available,
            **metadata,
            "error": result.get("error") or metadata["error"],
            "stale": stale}


def _unavailable_metrics_summary(run_id: str | None, range_name: str, error: str,
                                 *, completeness: str = "unavailable") -> dict:
    return {"schemaVersion": 1, "status": "unavailable", "available": False,
            "runId": run_id, "range": range_name, "from": None, "to": None, "asOf": None,
            "fill_count": None, "fills": None, "order_count": None, "orders": None,
            "fill_notional": None, "known_fill_notional": None, "fees": None,
            "known_fees": None, "estimated_fees": None, "missing_fee_count": None,
            "settled_markets": None, "settled_pnl": None, "pnl": None,
            "settled_wins": None, "wins": None, "settled_losses": None, "losses": None,
            "settled_draws": None, "settled_pnl_pending": None, "win_rate": None,
            "unsettled_cost": None, "unsettled_rounds": None, "exposed_pnl": None,
            "pending_settlements": None,
            "pnl_semantics": "engine_settlement_net_of_fees; not_wallet_reconciliation",
            "completeness": completeness, "lag_bytes": None, "source": "ledger",
            "stale": True, "error": error}


def make_handler(root: Path):
    # The release publisher installs the console under frontend/console.
    # Keep static serving rooted at the published frontend tree so /console/
    # resolves to the same files that are deployed and tested.
    docs = root / "frontend"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            try:
                self._get()
            except KeyError:
                self._send_json(b'{"error":"record_not_found","stale":true}', 404)
            except (ValueError, TypeError, OverflowError):
                self._send_json(b'{"error":"invalid_query","stale":true}', 400)
            except (OSError, sqlite3.Error, RuntimeError):
                self._send_json(b'{"error":"data_unavailable","stale":true}', 503)

        def _get(self) -> None:
            path = unquote(self.path.split("?", 1)[0])
            query = parse_qs(urlsplit(self.path).query)
            if path == "/api/stream":
                self._stream(query.get("p", []))
                return
            if path == "/api/runtime/status":
                status = trading_status()
                self._send_json(json.dumps(_modern_runtime(status), ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/runtime/book":
                self._send_json(json.dumps(runtime_book(), ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/strategy/config":
                config = strategy_config_status()
                draft = strategy_draft()
                if draft:
                    draft = {**draft, "savedAt": _epoch(draft.get("savedAt"))}
                self._send_json(json.dumps({"schemaVersion": 1, "source": "control-plane",
                    "asOf": _epoch(config.get("savedAt")), "stale": False, "error": None,
                    **config, "savedAt": _epoch(config.get("savedAt")), "draft": draft,
                    "activationScope": "future_uncreated_round"}, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/account/snapshot":
                snapshot = _account_snapshot()
                # The console reads balance, occupancy, positions and open
                # orders. Trade history, on-chain activity, closed positions and
                # fee history were 400 KB of the 440 KB body, pushed every
                # refresh to a browser that never read them.
                snapshot = {key: value for key, value in snapshot.items() if key not in _ACCOUNT_HISTORY_SECTIONS}
                self._send_json(json.dumps({"source": "account-reader",
                    "asOf": _epoch(snapshot.get("checked_at")),
                    "error": snapshot.get("error_code"), **snapshot},
                    ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/diagnostics/health":
                self._send_json(json.dumps(health(), ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path in {"/api/stats/lead", "/api/orders/lead"}:
                requested_range = query.get("range", ["run"])[0]
                if requested_range not in LEAD_RANGES:
                    raise ValueError("invalid lead range")
                run_id = _api_run_id()
                if not run_id:
                    self._send_json(json.dumps({"schemaVersion": 1, "available": False, "runId": None,
                                                "range": requested_range, "source": "ledger", "asOf": None,
                                                "stale": True, "error": "当前没有运行记录"},
                                               ensure_ascii=False).encode("utf-8"))
                    return
                results, _ = _official_or_last()
                # The figures change only with a business write to the ledger
                # (not a status line) or new venue results: repeats from memory.
                def build():
                    if path == "/api/stats/lead":
                        # The saved size: the switches comparison's base when no mid-edge order says it.
                        shares = (((agent().view()["state"] or {}).get("config") or {}).get("config") or {}).get("shares")
                        return _api_ledger().lead_stats(run_id, range=requested_range, official=results,
                                                        base_shares=shares if isinstance(shares, (int, float)) else None)
                    before = query.get("before", [None])[0]
                    return _api_ledger().lead_orders_page(
                        run_id, range=requested_range, limit=int(query.get("limit", ["200"])[0]),
                        before=float(before) if before is not None else None, official=results)
                try:
                    data = _cached_view((self.path, run_id, id(results), _ledger_stamp()), build)
                except KeyError:
                    self._send_json(json.dumps({"schemaVersion": 1, "available": False, "runId": run_id,
                                                "range": requested_range, "source": "ledger", "asOf": None,
                                                "stale": True, "error": "ledger_projection_unavailable"},
                                               ensure_ascii=False).encode("utf-8"))
                    return
                metadata = _ledger_metadata(run_id)
                self._send_json(json.dumps({"schemaVersion": 1, "available": True, **data, **metadata},
                                           ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/metrics/summary":
                requested_range = query.get("range", ["today"])[0]
                if requested_range not in {"run", "today", "month", "all"}:
                    raise ValueError("invalid metrics range")
                requested_run_id = query.get("runId", [None])[0]
                if requested_run_id is not None:
                    run_id = _scoped_run_id(requested_run_id)
                    if run_id is None:
                        self._send_json(b'{"error":"run_not_found","stale":true}', 404)
                        return
                else:
                    run_id = _api_run_id()
                if not run_id:
                    # No run is a valid unavailable state. Keep the response
                    # successful so clients can render the last-known/empty
                    # state without treating this as a missing route.
                    self._send_json(json.dumps(_unavailable_metrics_summary(
                        None, requested_range, "当前没有运行记录"),
                        ensure_ascii=False, allow_nan=False).encode("utf-8"))
                    return
                asset_id = (query.get("assetId") or [None])[0]
                market_id = (query.get("marketId") or [None])[0]
                round_id_filter = (query.get("roundId") or [None])[0]
                try:
                    if asset_id is None and market_id is None and round_id_filter is None:
                        stats = _api_ledger().summary(run_id, range=requested_range)
                    else:
                        stats = _api_ledger().metrics_summary(run_id, range=requested_range,
                                                              asset_id=asset_id, market_id=market_id,
                                                              round_id=round_id_filter)
                except KeyError:
                    self._send_json(json.dumps(_unavailable_metrics_summary(
                        run_id, requested_range, "ledger_projection_unavailable", completeness="waiting"),
                        ensure_ascii=False, allow_nan=False).encode("utf-8"))
                    return
                stats = _apply_official(stats, run_id, requested_range, asset_id, market_id, round_id_filter)
                metadata = _ledger_metadata(run_id)
                # Official figures that are old or missing make the summary stale too (BUGS A3).
                stale = metadata["stale"] or stats.get("completeness") != "caught_up" or stats.get("stale") is True
                value = {"schemaVersion": 1, "status": "stale" if stale else "ready",
                         "available": True, **stats, **metadata,
                         "fills": stats.get("fill_count"), "orders": stats.get("order_count"),
                         "wins": stats.get("settled_wins"), "losses": stats.get("settled_losses"),
                         "pnl": stats.get("settled_pnl"),
                         "exposedPnl": stats.get("exposed_pnl"),
                         "unsettledCost": stats.get("unsettled_cost"),
                         "unsettledRounds": stats.get("unsettled_rounds"),
                         "stale": stale,
                         "error": metadata["error"] or stats.get("error")}
                self._send_json(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path in {"/api/events", "/api/fills", "/api/settlements"}:
                try:
                    requested_run_id = query.get("runId", [None])[0]
                    event_run_id = (_scoped_run_id(requested_run_id) if requested_run_id is not None
                                    else _api_run_id())
                    if requested_run_id is not None and event_run_id is None:
                        self._send_json(b'{"error":"run_not_found","stale":true}', 404)
                        return
                    value = (_modern_settlements(event_run_id, query) if path == "/api/settlements"
                             else _modern_events(event_run_id, query, kinds={"fill"} if path == "/api/fills" else None))
                    if path == "/api/settlements":
                        # Same PnL as the history table: the venue's (official_pnl).
                        results, _ = _official_or_last()
                        for item in value.get("items") or []:
                            official = None if results is None else results.get((item.get("assetId"), str(item.get("roundId"))))
                            item["pnl"] = official["pnl"] if official else None
                            item["pnlSource"] = "polymarket-data-api" if official else None
                            if official:
                                item["state"] = "confirmed"
                                item["accountingState"] = "confirmed"
                    # A new fill changes the wallet balance. Drop the account
                    # cache so the next /api/account/snapshot reflects it instead
                    # of waiting out the refresh interval.
                    if path == "/api/fills":
                        _note_fill_watermark(value)
                    self._send_json(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                except (ValueError, TypeError):
                    self._send_json(b'{"error":"invalid_event_query","stale":true}', 400)
                return
            if path == "/api/rounds":
                run_id = (_scoped_run_id(query["runId"][0]) if query.get("runId") else _api_run_id())
                if not run_id:
                    self._send_json(b'{"schemaVersion":1,"available":false,"stale":true,'
                                    b'"rounds":[],"error":"\xe5\xbd\x93\xe5\x89\x8d\xe6\xb2\xa1\xe6\x9c\x89\xe8\xbf\x90\xe8\xa1\x8c\xe8\xae\xb0\xe5\xbd\x95"}')
                    return
                try:
                    limit = int((query.get("limit") or [50])[0])
                    data = _cached_view((self.path, run_id, _ledger_stamp()), lambda: _api_ledger().rounds_page(
                        run_id,
                        before_round_id=(query.get("beforeRoundId") or [None])[0],
                        limit=limit,
                        asset_id=(query.get("assetId") or [None])[0],
                        round_id=(query.get("roundId") or [None])[0]))
                    # A finished round's result is the venue's (official_pnl);
                    # the ledger lists what the engine traded and its cost.
                    results, _ = _official_or_last()
                    for item in data.get("rounds") or []:
                        official = None if results is None else results.get((item.get("assetId"), str(item.get("roundId"))))
                        item["pnl"] = official["pnl"] if official else None
                        item["pnlSource"] = "polymarket-data-api" if official else None
                        if official:
                            # One state per round: the venue settled it (BUGS C2).
                            item["status"] = "已结算"
                            item["settled"] = True
                            item["settlementState"] = "confirmed"
                            item["settlementReason"] = "官方已结算"
                    metadata = _ledger_metadata(run_id)
                    value = {"schemaVersion": 1, "available": True, "source": "ledger", **data,
                             "asOf": metadata.get("asOf"), "stale": metadata["stale"],
                             "error": data.get("error") or metadata["error"]}
                except (ValueError, TypeError):
                    self._send_json(b'{"error":"invalid_rounds_query","stale":true}', 400)
                    return
                except (KeyError, OSError, sqlite3.Error, RuntimeError):
                    value = {"schemaVersion": 1, "available": False, "stale": True, "rounds": [],
                             "source": "ledger", "asOf": None, "error": "ledger_projection_unavailable"}
                self._send_json(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path.startswith("/api/rounds/") and path.endswith("/orders"):
                round_id = path[len("/api/rounds/"):-len("/orders")].strip("/")
                run_id = _api_run_id()
                if not run_id:
                    self._send_json(json.dumps({"schemaVersion": 1, "status": "unavailable", "available": False,
                        "orders": None, "total": None,
                        "roundId": round_id, "source": "ledger", "asOf": None, "stale": True,
                        "error": "当前没有运行记录"}, ensure_ascii=False).encode("utf-8"))
                    return
                try:
                    legacy_market_id = (query.get("marketId") or [None])[0]
                    explicit_round = (query.get("roundId") or [None])[0]
                    if explicit_round is not None and explicit_round != round_id:
                        raise ValueError("conflicting round identity")
                    legacy_round_id = round_id
                    if (legacy_market_id is None and explicit_round is None
                            and round_id.startswith("0x")):
                        legacy_market_id, legacy_round_id = round_id, None
                    result = _api_ledger().orders_page(run_id, limit=int(query.get("limit", ["50"])[0]),
                                                       offset=int(query.get("offset", ["0"])[0]),
                                                       asset_id=(query.get("assetId") or [None])[0],
                                                       market_id=legacy_market_id,
                                                       round_id=legacy_round_id)
                    result["orders"] = [_order_dto(order) for order in result.get("orders", [])]
                    metadata = _ledger_metadata(run_id)
                    self._send_json(json.dumps({"schemaVersion": 1,
                        "status": "stale" if metadata["stale"] else "ready", "available": True,
                        "roundId": round_id,
                        **result, **metadata},
                        ensure_ascii=False, allow_nan=False).encode("utf-8"))
                except KeyError:
                    self._send_json(json.dumps({"schemaVersion": 1, "status": "unavailable", "available": False,
                        "orders": None, "total": None, "roundId": round_id, "runId": run_id,
                        "source": "ledger", "asOf": None, "stale": True,
                        "error": "ledger_projection_unavailable"}, ensure_ascii=False).encode("utf-8"))
                except (ValueError, TypeError):
                    self._send_json(b'{"error":"invalid_order_query","stale":true}', 400)
                return
            if path.startswith("/api/rounds/") and path.endswith("/position"):
                round_id = path[len("/api/rounds/"):-len("/position")].strip("/")
                run_id = _api_run_id()
                if not run_id:
                    value = {"schemaVersion": 1, "available": False, "stale": True,
                             "source": "ledger", "asOf": None,
                             "error": "当前没有运行记录", "roundId": round_id}
                else:
                    try:
                        if query.get("roundId") and query["roundId"][0] != round_id:
                            raise ValueError("conflicting round identity")
                        value = {"schemaVersion": 1, "source": "ledger", **_api_ledger().position(
                            run_id, round_id,
                            asset_id=(query.get("assetId") or [None])[0],
                            market_id=(query.get("marketId") or [None])[0])}
                        metadata = _ledger_metadata(run_id)
                        value["stale"] = value.get("stale", True) or metadata["stale"]
                        value["error"] = value.get("error") or metadata["error"]
                        value.setdefault("asOf", value.get("updatedAt"))
                    except (ValueError, TypeError):
                        self._send_json(b'{"error":"invalid_position_query","stale":true}', 400)
                        return
                    except (KeyError, OSError, sqlite3.Error, RuntimeError):
                        value = {"schemaVersion": 1, "available": False, "stale": True,
                                 "source": "ledger", "asOf": None, "error": "ledger_projection_unavailable",
                                 "roundId": round_id}
                self._send_json(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/accounts":
                self._send_json(json.dumps(accounts_view(), ensure_ascii=False).encode("utf-8"))
                return
            if path == "/":
                self.send_response(302)
                self.send_header("Location", f"{_prefix()}/console/")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if path == "/api/account/status":
                account = account_config_status()
                self._send_json(json.dumps({**account, "schemaVersion": 1,
                    "source": "control-plane", "asOf": account.get("last_check_at"),
                    "stale": account.get("account_check_state") != "ready",
                    "error": account.get("last_check_error"),
                    "node_label": NODE_LABEL}, ensure_ascii=False).encode("utf-8"))
                return
            relative = "console/index.html" if path in {"/console", "/console/"} else path.lstrip("/")
            candidate = (docs / relative).resolve()
            if docs not in candidate.parents or not candidate.is_file():
                self.send_error(404)
                return
            body = candidate.read_bytes()
            content_type = _static_content_type(candidate)
            is_html = candidate.suffix == ".html"
            if is_html:
                config = ('<script>window.__POLY_PREVIEW_CONFIG__={mode:"backend",demo:false,'
                          f'apiBase:{json.dumps(_prefix())},account:{json.dumps(ACCOUNT_ID)},apiFlavor:"contract"}};</script>').encode("utf-8")
                body = body.replace(b"<head>", b"<head>" + config, 1)
            # HTML stays uncached (it carries injected config and must reflect a
            # deploy immediately). JS/CSS/assets are revalidated with an ETag over
            # the served bytes: the browser caches them but always asks, and the
            # server answers 304 with no body when unchanged. This removes the
            # per-navigation re-download that no-store forced, while a deploy that
            # changes the bytes changes the ETag, so assets can never go stale.
            etag = None
            if not is_html:
                etag = '"' + hashlib.sha256(body).hexdigest()[:32] + '"'
                if self.headers.get("If-None-Match") == etag:
                    self.send_response(304)
                    self.send_header("ETag", etag)
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            if etag is not None:
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "no-cache")
            else:
                self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _stream(self, paths: list[str]) -> None:
            """GET /api/stream?p=<rest path>&p=...: server-sent events. Every
            message is {"path", "version", "body"} where body is exactly what a
            GET of that path returns. A new connection first gets the current
            value of each path, then only changes. Heartbeat every 15 s."""
            client = self.push_hub.subscribe(paths)
            if client is None:
                self._send_json(b'{"error":"stream_capacity","stale":true}', 503)
                return
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                self.wfile.write(b"retry: 2000\n\n")
                self.wfile.flush()
                last_write = time.monotonic()
                while not client.closed:
                    ready = client.take(5.0)
                    if ready:
                        out = bytearray()
                        for path, (version, body) in ready.items():
                            out += (b'data: {"path":' + json.dumps(path).encode("utf-8")
                                    + b',"version":' + str(version).encode() + b',"body":' + body + b"}\n\n")
                        self.wfile.write(bytes(out))
                        self.wfile.flush()
                        last_write = time.monotonic()
                    elif time.monotonic() - last_write >= 15:
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_write = time.monotonic()
            except (OSError, ValueError):
                pass  # the browser went away; EventSource reconnects by itself
            finally:
                self.push_hub.unsubscribe(client)
                self.close_connection = True

        def _send_json(self, body: bytes, status: int = 200, response_headers: dict[str, str] | None = None) -> None:
            path = self.path.split("?", 1)[0]
            modern = path.startswith("/api/") and path != "/api/account/status"
            if modern:
                value = json.loads(body)
                cacheable = self.command == "GET" and (path in {
                    "/api/events", "/api/fills", "/api/settlements", "/api/metrics/summary",
                    "/api/rounds", "/api/stats/lead", "/api/orders/lead"} or path.startswith("/api/rounds/"))
                key = (_run_identity(), self.path)
                with _modern_cache_lock:
                    if cacheable and status >= 500 and key in _modern_response_cache:
                        value = {**_modern_response_cache[key], "stale": True, "error": value.get("error")}
                    elif cacheable and status == 200 and value.get("stale") is False and len(body) <= 262144:
                        _modern_response_cache[key] = value
                        _modern_response_cache.move_to_end(key)
                        while len(_modern_response_cache) > 32:
                            _modern_response_cache.popitem(last=False)
                value.setdefault("schemaVersion", 1)
                value.setdefault("source", "ledger" if cacheable else "control-plane")
                value.setdefault("asOf", None if status >= 400 else time.time())
                value["asOf"] = _epoch(value["asOf"])
                value.setdefault("stale", status >= 400)
                value.setdefault("error", None)
                body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            for name, value in (response_headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path not in MUTATING_ROUTES:
                self._send_json(b'{"error":"not found"}', 404)
                return
            try:
                auth_error = _mutation_request_error(self.headers)
                if auth_error:
                    code, message = auth_error
                    self._send_json(json.dumps({"accepted": False, "error": message}, ensure_ascii=False).encode("utf-8"), code)
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 32_000:
                    raise ValueError("请求内容为空或过大")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("request body must be an object")
                if path == "/api/runtime/commands":
                    action = payload.get("action")
                    translated = {"action": action, "strategy_id": payload.get("strategyId", STRATEGY_ID),
                                  "revision": payload.get("revision"), "request_id": payload.get("requestId"),
                                  "start_paused": payload.get("startPaused") is True}
                    if action == "start" and translated["revision"] is None:
                        translated["revision"] = payload.get("expectedRevision")
                    result = strategy_control(translated)
                    stop_result = result.get("stop_result") if isinstance(result.get("stop_result"), dict) else {}
                    self._send_json(json.dumps({"accepted": True, "status": result,
                        "commandStatus": result.get("command_status") or "accepted",
                        "serviceState": result.get("service_state"),
                        "remoteOrdersState": stop_result.get("remote_orders_state"),
                        "source": "control-plane", "asOf": time.time(), "stale": False},
                        ensure_ascii=False, allow_nan=False).encode("utf-8"))
                    return
                if path == "/api/strategy/drafts":
                    modern_config = payload.get("config", payload)
                    expected = payload.get("expectedRevision", payload.get("revision"))
                    if payload.get("strategyId", STRATEGY_ID) != STRATEGY_ID:
                        raise ValueError("策略不存在")
                    with _config_control_lock:
                        result = agent().post("/config/draft", {"config": modern_config, "expectedRevision": expected})
                        agent().poll()
                    self._send_json(json.dumps({"accepted": True, **result, "savedRevision": result["expectedRevision"],
                                                "revision": result["expectedRevision"], "savedAt": _epoch(result.get("savedAt"))}, ensure_ascii=False,
                                                allow_nan=False).encode("utf-8"))
                    return
                if path == "/api/strategy/activate":
                    if payload.get("strategyId", STRATEGY_ID) != STRATEGY_ID:
                        raise ValueError("策略不存在")
                    if payload.get("effectiveRoundId") is not None:
                        self._send_json(b'{"accepted":false,"status":"unsupported","error":"activation_at_round_unsupported"}', 501)
                        return
                    with _config_control_lock:
                        config = agent().post("/config/activate", {"expectedRevision": payload.get("expectedRevision"),
                                                                  "draftId": payload.get("draftId")})
                        agent().poll()
                    self._send_json(json.dumps({"accepted": True, "strategyId": STRATEGY_ID,
                        "revision": config["savedRevision"], "savedRevision": config["savedRevision"], "effectiveRoundId": None,
                        "activationScope": "future_uncreated_round", "status": "published",
                        "source": "control-plane", "asOf": time.time(), "stale": False},
                        ensure_ascii=False, allow_nan=False).encode("utf-8"))
                    return
                if path == "/api/ledger/reset":
                    if payload.get("confirm") != "RESET":
                        self._send_json(json.dumps({"accepted": False, "error": "缺少确认标记，未清空任何数据"},
                                                   ensure_ascii=False).encode("utf-8"), 400)
                        return
                    # The engine box deletes its journals and state first and
                    # refuses while an engine runs (or when it cannot tell);
                    # only then does this console drop its ledger and replicas.
                    try:
                        with _trading_lock:
                            engine = agent().post("/reset", {"confirm": "RESET"})
                            report = {**(engine.get("report") or {}), "console": _console_reset()}
                    except AgentUnavailable as exc:
                        self._send_json(json.dumps({"accepted": False, "error": str(exc)},
                                                   ensure_ascii=False).encode("utf-8"), 503)
                        return
                    except AgentError as exc:
                        self._send_json(json.dumps({"accepted": False, "error": str(exc)},
                                                   ensure_ascii=False).encode("utf-8"), exc.status)
                        return
                    except (OSError, sqlite3.Error) as exc:
                        self._send_json(json.dumps({"accepted": False, "error": f"清空失败：{exc}"},
                                                   ensure_ascii=False).encode("utf-8"), 503)
                        return
                    self._send_json(json.dumps({"accepted": True, "report": report,
                        "source": "control-plane", "asOf": time.time(), "stale": False, "error": None},
                        ensure_ascii=False).encode("utf-8"))
                    return
                raise ValueError("不支持的交易接口")
            except AgentUnavailable as exc:
                self._send_json(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8"), 503)
            except AgentError as exc:
                # The engine box's own refusal (unlock off, stale revision,
                # account check, ...) with its status and fields.
                passed = {key: value for key, value in exc.body.items()
                          if key in {"error_code", "retryable", "current_revision"}}
                self._send_json(json.dumps({**passed, "ok": False, "error": str(exc)},
                                           ensure_ascii=False).encode("utf-8"), exc.status)
            except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
                self._send_json(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8"), 400)

        def log_message(self, *_: object) -> None:
            return

    class _Capture(Handler):
        """Run the real GET handler for one path and keep the response in memory,
        so a pushed block is byte-for-byte what polling that path returns."""
        def __init__(self, path: str):  # noqa: D107 - no socket, no BaseHTTPRequestHandler setup
            self.path, self.command, self.headers = path, "GET", {}
            self.request_version, self.client_address = "HTTP/1.1", ("push", 0)
            self.wfile, self.status = io.BytesIO(), 200

        def send_response(self, code, message=None):
            self.status = code

        def send_header(self, keyword, value):
            pass

        def end_headers(self):
            pass

        def send_error(self, code, message=None, explain=None):
            self.status = code

        def log_message(self, format, *args):
            pass

    def render(path: str) -> tuple[int, bytes]:
        capture = _Capture(path)
        capture.do_GET()
        return capture.status, capture.wfile.getvalue()

    ledger_dir = DATA_DIR

    def token(path: str):
        # Ledger-backed blocks change only when the projection writes the
        # ledger; one stat per path instead of a full render (76 ms for a run
        # summary) every cadence tick.
        route = path.split("?", 1)[0]
        try:
            ledger = tuple((ledger_dir / name).stat().st_mtime_ns if (ledger_dir / name).exists() else 0
                           for name in ("ledger.sqlite3", "ledger.sqlite3-wal", "snapshot.json"))
        except OSError:
            return None
        # The book follows every status line (the runtime row); the ledger
        # views only a business write or a projection state change.
        if route == "/api/runtime/book":
            return ledger
        if route.startswith(("/api/rounds", "/api/fills", "/api/settlements", "/api/events", "/api/metrics/",
                             "/api/stats/", "/api/orders/")):
            return _ledger_stamp()
        if route == "/api/account/snapshot":
            return id(agent().account_snapshot())
        return None

    Handler.push_hub = PushHub(render, token=token)
    return Handler


def main() -> int:
    parser = argparse.ArgumentParser(description="Trading dashboard and isolated analytics")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("交易控制台只允许监听本机地址")
    system_metrics().refresh()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(Path(args.root).resolve()))
    stop = threading.Event()
    threading.Thread(target=agent().run, args=(stop,), name="engine-agent", daemon=True).start()
    threading.Thread(target=supervise_projection, args=(stop,), daemon=True).start()
    threading.Thread(target=refresh_system_metrics, args=(stop,), daemon=True).start()
    threading.Thread(target=server.RequestHandlerClass.push_hub.run, args=(stop,),
                     name="console-push", daemon=True).start()
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()
        if _read_model:
            _read_model.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

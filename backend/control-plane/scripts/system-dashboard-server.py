from __future__ import annotations

import argparse
from contextlib import contextmanager
from collections import deque, OrderedDict
import hmac
import hashlib
import json
import math
import os
import secrets
import signal
import shlex
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
import re
from http.cookies import SimpleCookie
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, unquote

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows development fallback
    fcntl = None

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dashboard_account as account_store
from dashboard.config import ConfigConflictError
from dashboard.strategy_config import StrategyConfigStore, STRATEGY_ID, SUPPORTED_ASSET_IDS
from dashboard.ledger import Ledger
from dashboard.read_model import ReadModel
from dashboard.market_snapshot import (canonical_snapshot, normalize_stale_after_ms,
                                       validate_snapshot)
from dashboard.account_data import AccountData
from dashboard.system_metrics import SystemMetrics


_REPO_ENGINE = Path(__file__).resolve().parents[2] / "engine"
_DEPLOYED_ENGINE = Path(__file__).resolve().parents[1] / "backend" / "engine"
_EXTERNAL_ENGINE = Path(__file__).resolve().parents[1] / "_external" / "btc-5m-market-trading-bot"
TRADING_ROOT = next((path for path in (_DEPLOYED_ENGINE, _REPO_ENGINE, _EXTERNAL_ENGINE)
                     if (path / "package.json").is_file()), _REPO_ENGINE)
DEPLOYMENT_LOCK_PATH = TRADING_ROOT.parents[1] / "data" / "dashboard" / "deployment.lock"
_trading_lock = threading.RLock()
_account_check_lock = threading.Lock()
_trading_process: subprocess.Popen[str] | None = None
_trading_pid: int | None = None
_trading_started_at: float | None = None
_trading_mode: str | None = None
_trading_params: dict | None = None
_trading_log: Path | None = None
_trading_console_log: Path | None = None
_trading_exit_code: int | None = None
_trading_stop_result: dict | None = None
_trading_state_loaded = False
_trade_cache: dict = {}
_live_lock = threading.RLock()
_live_fetch_lock = threading.Lock()
_live_cache: dict = {"collector_online": False, "error": "尚未检查"}
_live_cache_at = 0.0
_account_report: dict | None = None
_account_report_identity: str | None = None
_account_check_error: str | None = None
_account_startup_check_error: str | None = None
_account_data: AccountData | None = None
_account_data_lock = threading.Lock()
_read_model: ReadModel | None = None
_strategy_config_store: StrategyConfigStore | None = None
_config_control_lock = threading.RLock()
_read_model_init_lock = threading.Lock()
_trading_run_id: str | None = None
_trading_config_revision: int | None = None
_trading_account_id: str | None = None
_trading_request_id: str | None = None
_trading_engine: str | None = None
_projection_pending: deque = deque()
_system_metrics: SystemMetrics | None = None
_system_metrics_lock = threading.Lock()
_modern_cache_lock = threading.Lock()
_modern_market_cache: dict = {}
_modern_response_cache: OrderedDict = OrderedDict()
_market_pool_cache: dict = {}

_BTC_POOL_ID = "btc"
_ASSET_ID_RE = re.compile(r"[a-z][a-z0-9_-]{0,31}\Z")

_CONTROL_SESSION_COOKIE = "pm_control_session"
_CONTROL_SESSION_VERSION = "v1"
_CONTROL_SESSION_TTL_SECONDS = 12 * 60 * 60


@contextmanager
def deployment_mutex():
    """Serialize operator starts with the release script's OS-level lock."""
    DEPLOYMENT_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    handle = DEPLOYMENT_LOCK_PATH.open("a+")
    try:
        if fcntl is not None:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("程序正在更新，请更新完成后再启动") from None
        yield
    finally:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()

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


def _live_config() -> dict:
    project_root = Path(__file__).resolve().parents[1]
    local_setting = os.environ.get("PM_LIVE_LOCAL", "")
    snapshot_path = Path(os.environ.get("PM_MARKET_SNAPSHOT_PATH", str(project_root / "data" / "dashboard" / "market-snapshot.json")))
    collector_is_local = local_setting == "1" if local_setting else snapshot_path.is_file()
    return {
        "node_label": os.environ.get("PM_NODE_LABEL", "都柏林节点"),
        "collector_is_local": collector_is_local,
        "collector_service": os.environ.get(
            "PM_COLLECTOR_SERVICE", "pm-clob-market-snapshot.service"
        ),
        "ssh_key": Path(
            os.environ.get(
                "PM_REMOTE_SSH_KEY",
                str(Path.home() / ".ssh" / "id_ed25519_dublin_pm"),
            )
        ),
        "remote_host": os.environ.get("PM_REMOTE_HOST", "root@34.242.206.196"),
        "remote_port": os.environ.get("PM_REMOTE_PORT", "22"),
        "connect_timeout": os.environ.get("PM_REMOTE_CONNECT_TIMEOUT", "5"),
        "snapshot_path": snapshot_path,
        "remote_snapshot_path": os.environ.get("PM_REMOTE_SNAPSHOT_PATH", "/root/pm-system/data/dashboard/market-snapshot.json"),
    }


def _state_path() -> Path:
    return TRADING_ROOT / "results" / "dashboard-state.json"


def _market_pool_path() -> Path:
    return TRADING_ROOT / "results" / "dashboard" / "market_pool.json"


def _pool_ids(value, *, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{field} 必须是数组")
    result = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"{field} 包含无效市场 ID")
        normalized = item.strip().lower()
        if not _ASSET_ID_RE.fullmatch(normalized):
            raise ValueError(f"{field} 包含无效资产 ID")
        if normalized not in SUPPORTED_ASSET_IDS:
            raise ValueError(f"{field} 包含当前运行时不支持的资产")
        if normalized not in result:
            result.append(normalized)
    return result


def market_pool() -> dict:
    """Read the server-owned pool without using request time as its clock."""
    global _market_pool_cache
    default = {"schemaVersion": 1, "available": False, "desiredIds": [], "currentIds": [],
               "nextRoundIds": [], "effectiveRoundId": None, "updatedAt": None,
               "source": "control-plane", "asOf": None, "stale": True,
               "error": "market_pool_unavailable"}
    try:
        value = json.loads(_market_pool_path().read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("market pool must be an object")
        desired = _pool_ids(value.get("desiredIds"), field="desiredIds")
        current = _pool_ids(value.get("currentIds"), field="currentIds")
        next_ids = _pool_ids(value.get("nextRoundIds"), field="nextRoundIds")
        if any(len(ids) > 1 for ids in (desired, current, next_ids)):
            raise ValueError("单实例交易运行池只能包含一个资产")
        updated = value.get("updatedAt")
        if type(updated) not in (int, float) or not math.isfinite(updated) or updated <= 0:
            raise ValueError("market pool updatedAt is unavailable")
        result = {"schemaVersion": 1, "available": True, "desiredIds": desired,
                  "currentIds": current, "nextRoundIds": next_ids,
                  "effectiveRoundId": value.get("effectiveRoundId") if isinstance(value.get("effectiveRoundId"), str) else None,
                  "updatedAt": updated, "source": "control-plane", "asOf": updated,
                  "stale": False, "error": None}
        with _modern_cache_lock:
            _market_pool_cache = result
        return result
    except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
        with _modern_cache_lock:
            if _market_pool_cache:
                return {**_market_pool_cache, "stale": True,
                        "error": "market_pool_unavailable"}
        return {**default, "error": "market_pool_invalid" if isinstance(exc, ValueError) else default["error"]}


def save_market_pool(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("运行池请求必须是对象")
    allowed = {"desiredIds", "currentIds", "nextRoundIds", "effectiveRoundId"}
    if set(payload) - allowed:
        raise ValueError("运行池字段不正确")
    current = market_pool()
    desired = _pool_ids(payload.get("desiredIds", current["desiredIds"]), field="desiredIds")
    if len(desired) != 1:
        raise ValueError("单实例交易运行池必须且只能选择一个资产")
    # Current and next membership are runtime-owned. The request can assert
    # their IDs only as compatibility input, but cannot rewrite live state.
    if "currentIds" in payload:
        _pool_ids(payload["currentIds"], field="currentIds")
    if "nextRoundIds" in payload:
        _pool_ids(payload["nextRoundIds"], field="nextRoundIds")
    effective = current.get("effectiveRoundId")
    if "effectiveRoundId" in payload and payload["effectiveRoundId"] is not None:
        if not isinstance(payload["effectiveRoundId"], str) or not payload["effectiveRoundId"].strip():
            raise ValueError("effectiveRoundId 无效")
        effective = payload["effectiveRoundId"].strip()
    value = {"schemaVersion": 1, "desiredIds": desired,
             "currentIds": current.get("currentIds", []),
             "nextRoundIds": current.get("nextRoundIds", []),
             "effectiveRoundId": effective, "source": "control-plane",
             "updatedAt": time.time()}
    path = _market_pool_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    temporary.replace(path)
    return market_pool()


def _pool_runtime_view(value: dict) -> dict:
    status = trading_status()
    runtime = (status.get("stats") or {}).get("runtime") or {}
    strategy = runtime.get("strategy_runtime") or {}
    current = strategy.get("currentRound") or {}
    asset = current.get("assetId") or (strategy.get("config") or {}).get("assetId") or (status.get("params") or {}).get("assetId")
    expires = _epoch(runtime.get("expires_at"))
    fresh = (status.get("running") is True and runtime.get("status") == "running"
             and runtime.get("stale") is not True and expires is not None and expires > time.time())
    return {**value, "currentIds": [asset] if fresh and asset in SUPPORTED_ASSET_IDS else [],
            "nextRoundIds": [], "effectiveRoundId": current.get("roundId") if fresh else None,
            "runtimeAsOf": _epoch(runtime.get("source_at")), "runtimeStale": not fresh}


def control_source() -> dict:
    """Market data may be remote; account/config/control always belong here."""
    config = _live_config()
    local = config["collector_is_local"]
    return {"scope": "collector_host" if local else "local_preview",
            "label": config["node_label"] if local else "本机预览服务",
            "market_node": config["node_label"]}


def account_data() -> AccountData:
    global _account_data
    with _account_data_lock:
        if _account_data is None:
            _account_data = AccountData(TRADING_ROOT, _account_values)
        return _account_data


def _remote_orders_empty_from_fresh_snapshot() -> bool:
    """Return true only when a fresh account read proves there are no orders.

    This is a cache-only check.  Stop handling must not perform network I/O or
    wait for the slow account reader; an unavailable or incomplete snapshot
    remains unconfirmed until a later account refresh provides the evidence.
    """
    try:
        snapshot = account_data().snapshot()
    except Exception:
        return False
    if not isinstance(snapshot, dict) or snapshot.get("available") is not True or snapshot.get("stale") is not False:
        return False
    orders = snapshot.get("open_orders")
    return (isinstance(orders, dict)
            and orders.get("available") is True
            and orders.get("complete") is True
            and isinstance(orders.get("items"), list)
            and not orders["items"])


def _metric_services() -> dict:
    """Return process identities from memory; the sampler performs OS reads."""
    with _trading_lock:
        trader_pid, trader_log = _trading_pid, _trading_log
    trader_running = _process_matches(trader_pid, trader_log)
    with _live_lock:
        collector_online = bool(_live_cache.get("collector_online"))
    with _read_model_init_lock:
        projection_process = getattr(_read_model, "_process", None) if _read_model else None
        projection_pid = getattr(projection_process, "pid", None)
        projection_running = bool(projection_process and projection_process.poll() is None)
    return {
        "dashboard": {"pid": os.getpid(), "state": "active"},
        "collector": {"pid": None, "state": "active" if collector_online else "unavailable"},
        "trader": {"pid": trader_pid if trader_running else None, "state": "active" if trader_running else "stopped"},
        "projection": {"pid": projection_pid if projection_running else None, "state": "active" if projection_running else "stopped"},
        "journal_backlog": len(_projection_pending),
        "event_loop_lag_ms": None,
    }


def system_metrics() -> SystemMetrics:
    global _system_metrics
    with _system_metrics_lock:
        if _system_metrics is None:
            config = _live_config()
            _system_metrics = SystemMetrics(Path(__file__).resolve().parents[1], _metric_services,
                                           config["collector_service"] if config["collector_is_local"] else None)
        return _system_metrics


def refresh_system_metrics(stop: threading.Event) -> None:
    system_metrics().run(stop)


def _persist_trading_state() -> None:
    """Persist enough state for the dashboard to recover after a restart."""
    state = {
        "pid": _trading_pid,
        "started_at": _trading_started_at,
        "mode": _trading_mode,
        "params": _trading_params,
        "log": str(_trading_log) if _trading_log else None,
        "console_log": str(_trading_console_log) if _trading_console_log else None,
        "exit_code": _trading_exit_code,
        "stop_result": _trading_stop_result,
        "run_id": _trading_run_id,
        "config_revision": _trading_config_revision,
        "account_id": _trading_account_id,
        "request_id": _trading_request_id,
        "engine": _trading_engine,
    }
    path = _state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        # A read-only filesystem must not prevent the trading engine from stopping.
        pass


def _process_command(pid: int) -> str:
    """Return a process command line so a recycled PID is never trusted blindly."""
    proc_cmdline = Path(f"/proc/{pid}/cmdline")
    try:
        if proc_cmdline.is_file():
            return shlex.join(part.decode("utf-8", "replace") for part in proc_cmdline.read_bytes().split(b"\0") if part)
    except OSError:
        return ""
    if os.name == "nt":
        try:
            completed = subprocess.run(
                [
                    "powershell", "-NoProfile", "-NonInteractive", "-Command",
                    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); "
                    f"(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="strict",
                timeout=5,
            )
            return completed.stdout.strip() if completed.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError, UnicodeError):
            return ""
    return ""


def _process_matches(pid: int | None, log_path: Path | None) -> bool:
    if not pid or pid <= 0 or log_path is None:
        return False
    try:
        args = shlex.split(_process_command(pid).replace("\\", "/"))
    except ValueError:
        return False
    # Match the exact journal argument as well as the executable; a recycled
    # PID or another run with a similar filename must never receive a signal.
    executable, flag = "dist/cli/platform.js", "--journal-file"
    if not any(arg == executable or arg.endswith("/" + executable) for arg in args) or flag not in args:
        return False
    index = args.index(flag) + 1
    expected = os.path.normcase(str(log_path).replace("\\", "/"))
    return index < len(args) and os.path.normcase(args[index]) == expected


def _restore_trading_state() -> None:
    with _trading_lock:
        _restore_trading_state_locked()


def _restore_trading_state_locked() -> None:
    global _trading_pid, _trading_started_at, _trading_mode, _trading_params
    global _trading_log, _trading_console_log, _trading_exit_code
    global _trading_stop_result, _trading_state_loaded
    global _trading_run_id, _trading_config_revision, _trading_account_id, _trading_request_id
    global _trading_engine
    if _trading_state_loaded:
        return
    _trading_state_loaded = True
    try:
        state = json.loads(_state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(state, dict):
        return
    log_value = state.get("log")
    console_value = state.get("console_log")
    _trading_log = Path(log_value) if isinstance(log_value, str) and log_value else None
    _trading_console_log = Path(console_value) if isinstance(console_value, str) and console_value else None
    _trading_started_at = state.get("started_at") if isinstance(state.get("started_at"), (int, float)) else None
    _trading_mode = "live" if state.get("mode") == "live" else None
    _trading_params = state.get("params") if isinstance(state.get("params"), dict) else None
    _trading_exit_code = state.get("exit_code") if isinstance(state.get("exit_code"), int) else None
    _trading_stop_result = state.get("stop_result") if isinstance(state.get("stop_result"), dict) else None
    _trading_run_id = state.get("run_id") if isinstance(state.get("run_id"), str) else None
    _trading_config_revision = state.get("config_revision") if type(state.get("config_revision")) is int else None
    _trading_account_id = state.get("account_id") if isinstance(state.get("account_id"), str) else None
    _trading_request_id = state.get("request_id") if isinstance(state.get("request_id"), str) else None
    _trading_engine = "platform" if state.get("engine") == "platform" else None
    candidate_pid = state.get("pid") if isinstance(state.get("pid"), int) else None
    _trading_pid = candidate_pid if _process_matches(candidate_pid, _trading_log) else None
    # A stopped run may be deliberately removed during a data reset. Do not
    # resurrect its missing journal as a live dashboard selection on restart.
    if _trading_pid is None and (_trading_log is None or not _trading_log.is_file()):
        _trading_started_at = None
        _trading_mode = None
        _trading_params = None
        _trading_log = None
        _trading_console_log = None
        _trading_exit_code = None
        _trading_stop_result = None
        _trading_run_id = None
        _trading_config_revision = None
        _trading_account_id = None
        _trading_request_id = None
        _trading_engine = None
        _persist_trading_state()


def _tail_lines(path: Path | None, count: int = 100, max_bytes: int = 131_072) -> list[str]:
    if path is None or not path.is_file():
        return []
    try:
        with path.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, size - max_bytes))
            text = handle.read().decode("utf-8", "replace")
        return text.splitlines()[-count:]
    except OSError:
        return []


_AUTOMATIC_STOP_MESSAGES = {
    "journal_failed": "交易进程因交易日志写入异常自动停止。",
    "duration_elapsed": "交易进程已按配置运行时长自动停止。",
    "markets_expired": "交易进程因所选市场已结束而自动停止。",
    "market_end_event_failed": "交易进程因场次结束处理异常自动停止。",
    "controller_stop": "交易进程已响应停止请求。",
    "SIGINT": "交易进程收到中断信号后停止。",
    "SIGTERM": "交易进程收到终止信号后停止。",
    "SIGBREAK": "交易进程收到中断信号后停止。",
}


def _automatic_stop_result(exit_code: int | None, console_path: Path | None) -> dict:
    terminal_status = None
    terminal_reason = None
    for line in reversed(_tail_lines(console_path)):
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        if not isinstance(event, dict) or event.get("kind") != "platform_status":
            continue
        if event.get("status") not in {"stopped", "failed"}:
            continue
        terminal_status = event["status"]
        candidate = event.get("reason")
        terminal_reason = candidate if candidate in _AUTOMATIC_STOP_MESSAGES else None
        break
    # The platform can finish its own drain after receiving SIGTERM/SIGINT and
    # still leave a non-zero process code.  A terminal platform_status event is
    # the authoritative outcome; only an explicit failed event or an exit
    # without a known terminal status is an execution failure.
    failed = terminal_status == "failed" or (terminal_status is None and exit_code is not None and exit_code != 0)
    reason = terminal_reason or ("process_failed" if failed else "process_exited")
    message = _AUTOMATIC_STOP_MESSAGES.get(
        reason,
        "交易进程异常退出，请核对运行记录。" if failed else "交易进程已停止，请核对订单与持仓状态。",
    )
    remote_confirmed = _remote_orders_empty_from_fresh_snapshot()
    return {"confirmed": remote_confirmed, "process_stopped": True, "automatic": True,
            "remote_orders_state": "confirmed" if remote_confirmed else "unconfirmed",
            "exit_code": exit_code, "reason": reason, "message": message}


def _account_values() -> dict[str, str]:
    """Load only supported account fields; never return them through the API."""
    names = {
        "POLYMARKET_WALLET_ADDRESS", "POLY_FUNDER",
        "POLY_SIGNATURE_TYPE",
        "POLYMARKET_OWNER_PRIVATE_KEY", "POLYMARKET_PRIVATE_KEY",
        "POLYMARKET_SESSION_PRIVATE_KEY", "RELAYER_API_KEY",
        "RELAYER_API_KEY_ADDRESS", "POLY_BUILDER_API_KEY",
        "POLY_BUILDER_SECRET", "POLY_BUILDER_PASSPHRASE",
    }
    profile = account_store.load_profile()
    result = {name: os.environ.get(name, "") for name in names}
    env_path = TRADING_ROOT / ".env"
    try:
        for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            name = name.strip()
            if name in names and not result.get(name):
                result[name] = value
    except OSError:
        pass
    if profile is not None:
        profile_wallet = profile.get("POLYMARKET_WALLET_ADDRESS") or profile.get("POLY_FUNDER")
        env_wallet = result.get("POLYMARKET_WALLET_ADDRESS") or result.get("POLY_FUNDER")
        clean = lambda value: str(value or "").strip().strip("'\"").lower()
        # Missing fields may inherit the same account's bootstrap. Explicit
        # empty fields clear values; switching wallets never inherits secrets.
        if profile_wallet and clean(profile_wallet) != clean(env_wallet):
            result = {name: "" for name in names}
        result.update({name: profile[name] for name in names if name in profile})
        if not result.get("POLYMARKET_OWNER_PRIVATE_KEY") and profile.get("POLYMARKET_PRIVATE_KEY"):
            result["POLYMARKET_PRIVATE_KEY"] = profile["POLYMARKET_PRIVATE_KEY"]
    if not result.get("POLYMARKET_WALLET_ADDRESS"):
        result["POLYMARKET_WALLET_ADDRESS"] = result.get("POLY_FUNDER", "")
    return result


def _account_identity(values: dict) -> str:
    fields = {name: str(values.get(name, "")).strip().strip("'\"")
              for name in account_store.ACCOUNT_ENV_FIELDS if name != account_store.CONTROL_FIELD}
    fields["POLYMARKET_OWNER_PRIVATE_KEY"] = (fields.get("POLYMARKET_OWNER_PRIVATE_KEY")
                                               or values.get("POLYMARKET_PRIVATE_KEY", ""))
    fields.pop("POLYMARKET_PRIVATE_KEY", None)
    return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()


def _meaningful_account_value(value: str) -> bool:
    clean = value.strip().strip("'\"").strip()
    if not clean or (clean.startswith("<") and clean.endswith(">")):
        return False
    lowered = clean.lower()
    return "your_" not in lowered and "真实值" not in clean and "已隐藏" not in clean


def account_config_status() -> dict:
    """Describe credential roles without exposing credential values."""
    try:
        values = _account_values()
        config_error = None
    except RuntimeError as exc:
        values = {}
        config_error = str(exc)
    present = lambda name: _meaningful_account_value(values.get(name, ""))
    wallet_value = values.get("POLYMARKET_WALLET_ADDRESS") or values.get("POLY_FUNDER", "")
    wallet_clean = wallet_value.strip().strip("'\"").strip()
    wallet_valid = bool(
        len(wallet_clean) == 42
        and wallet_clean.startswith("0x")
        and all(char in "0123456789abcdefABCDEF" for char in wallet_clean[2:])
    )
    # An explicitly invalid new key must not fall back to a legacy private key.
    owner_raw = values.get("POLYMARKET_OWNER_PRIVATE_KEY", "") or values.get("POLYMARKET_PRIVATE_KEY", "")
    owner_signer = bool(account_store.KEY.fullmatch(owner_raw.strip().strip("'\"")))
    session_signer = present("POLYMARKET_SESSION_PRIVATE_KEY")
    builder = all(present(name) for name in (
        "POLY_BUILDER_API_KEY", "POLY_BUILDER_SECRET", "POLY_BUILDER_PASSPHRASE"
    ))
    report = _account_report if isinstance(_account_report, dict) else None
    report_wallet = report.get("wallet") if report else None
    report_matches = bool(wallet_valid and isinstance(report_wallet, str)
                          and report_wallet.lower() == wallet_clean.lower()
                          and _account_report_identity == _account_identity(values))
    checked_at = _epoch(report.get("checked_at")) if report else None
    check_fresh = bool(checked_at is not None and 0 <= time.time() - checked_at <= 15 * 60)
    check_error = _account_check_error or _account_startup_check_error
    account_check_ready = bool(not check_error and report_matches and check_fresh
                               and report.get("account_ready") is True
                               and report.get("signer_matches") is True
                               and report.get("approvals_ready") is True
                               and report.get("compromised") is not True)
    if _account_check_error:
        check_state = "failed"
    elif account_check_ready:
        check_state = "ready"
    elif report is None or not report_matches:
        check_state = "unknown"
    else:
        check_state = "stale"
    return {
        "wallet": wallet_clean if wallet_valid else "",
        "config_error": config_error,
        "server_live_enabled": os.environ.get("PM_TRADING_LIVE_UNLOCK") == "1",
        "last_check": report,
        "last_check_error": check_error,
        "startup_check_error": _account_startup_check_error,
        "last_check_at": checked_at,
        "account_check_state": check_state,
        "account_check_ready": account_check_ready,
        "accountCheckState": check_state,
        "accountCheckReady": account_check_ready,
        "wallet_configured": wallet_valid,
        "owner_signer_configured": owner_signer,
        "session_signer_configured": session_signer,
        "relayer_api_configured": present("RELAYER_API_KEY") and present("RELAYER_API_KEY_ADDRESS"),
        "builder_api_configured": builder,
        # The current execution adapter uses the Owner signer. Session Key is
        # an optional delegated signer and is not required for this route.
        "execution_credentials_ready": wallet_valid and owner_signer,
        # Trading runtime requires an explicit settlement readiness result.
        # Missing/unknown is deliberately not enough for live start: an EOA
        # or Deposit Wallet may otherwise discover redeem credentials only
        # after a real position has been traded.
        "live_start_ready": bool(wallet_valid and owner_signer and account_check_ready
                                  and report and report.get("settlement_credentials_ready") is True),
        "executionCredentialsReady": wallet_valid and owner_signer,
        "liveStartReady": bool(wallet_valid and owner_signer and account_check_ready
                                and report and report.get("settlement_credentials_ready") is True),
        "wallet_kind": report.get("wallet_kind") if report else None,
        "signature_type": report.get("signature_type") if report else None,
        "settlement_credentials_ready": (report.get("settlement_credentials_ready")
                                          if report and isinstance(report.get("settlement_credentials_ready"), bool)
                                          else None),
        "settlement_reason": report.get("settlement_reason") if report else None,
        "walletKind": report.get("wallet_kind") if report else None,
        "signatureType": report.get("signature_type") if report else None,
        "settlementCredentialsReady": (report.get("settlement_credentials_ready")
                                        if report and isinstance(report.get("settlement_credentials_ready"), bool)
                                        else None),
        "read_only_only": wallet_valid and not owner_signer and not session_signer,
    }


def account_action(payload: dict, save: bool = False) -> dict:
    # Do not queue another slow chain check past the browser's request deadline.
    if not _account_check_lock.acquire(blocking=False):
        raise account_store.AccountCheckError("account_check_busy")
    try:
        return _checked_account_action(payload, save)
    finally:
        _account_check_lock.release()


def warm_account_check() -> None:
    """Refresh the saved account check after startup without blocking serving."""
    global _account_report, _account_report_identity, _account_check_error, _account_startup_check_error
    if not _account_check_lock.acquire(blocking=False):
        return
    try:
        values = _account_values()
        if not values.get("POLYMARKET_WALLET_ADDRESS"):
            return
        identity = _account_identity(values)
        report = account_store.check_account(TRADING_ROOT, values)
        with _trading_lock:
            # A browser save may have replaced the credentials while the RPC
            # check was in flight. Never attach an old report to the new account.
            if _account_identity(_account_values()) != identity:
                return
            _account_report = report
            _account_report_identity = identity
            _account_check_error = None
            _account_startup_check_error = None
    except Exception as exc:
        # Startup probing is best effort. A failed probe leaves the durable
        # config intact and deliberately keeps readiness at unknown.
        with _trading_lock:
            _account_startup_check_error = getattr(exc, "code", None) or "account_check_failed"
            if _account_report is None:
                _account_report_identity = None
                _account_check_error = None
    finally:
        _account_check_lock.release()


def _clear_account_run_selection() -> None:
    """Drop the last account's default selection without deleting its ledger."""
    global _trading_run_id, _trading_config_revision, _trading_account_id, _trading_request_id
    global _trading_log, _trading_console_log, _trading_started_at, _trading_exit_code
    global _trading_stop_result, _trading_engine
    _trading_run_id = None
    _trading_config_revision = None
    _trading_account_id = None
    _trading_request_id = None
    _trading_log = None
    _trading_console_log = None
    _trading_started_at = None
    _trading_exit_code = None
    _trading_stop_result = None
    _trading_engine = None
    _projection_pending.clear()
    _modern_market_cache.clear()
    _modern_response_cache.clear()
    _trade_cache.clear()
    _persist_trading_state()


def _checked_account_action(payload: dict, save: bool = False) -> dict:
    global _account_report, _account_report_identity, _account_check_error, _account_startup_check_error
    global _trading_run_id, _trading_config_revision, _trading_account_id, _trading_request_id
    global _trading_log, _trading_console_log, _trading_started_at, _trading_exit_code
    global _trading_stop_result, _trading_engine
    # The account-check lock prevents a concurrent start; slow RPC work must
    # not hold the runtime status/control lock.
    with _trading_lock:
        if trading_status(include_stats=False)["running"]:
            raise ValueError("请先停止交易，再检查或更换账户")
        values = _account_values()
        saved_identity = _account_identity(values)
        if save or payload:
            # _account_values intentionally omits the control password.  Merge
            # the private profile here so an ordinary account save cannot
            # accidentally erase the durable control credential.
            profile = account_store.load_profile() or {}
            previous = {**values, **profile}
            if account_store.CONTROL_FIELD not in previous:
                previous[account_store.CONTROL_FIELD] = _control_token()
            values = account_store.candidate_profile(payload, previous)
        if not values.get("POLYMARKET_WALLET_ADDRESS"):
            raise ValueError("请先填写资金钱包地址")
    candidate_identity = _account_identity(values)
    try:
        report = account_store.check_account(TRADING_ROOT, values)
    except account_store.AccountCheckError as exc:
        # Local candidate_profile validation has already completed. A failed
        # RPC/reader check must not discard a correctly formatted account, but
        # it also must not be reported as a successful readiness check.
        if (not save) or exc.code in {"invalid_account_config", "account_changed_during_check"}:
            if candidate_identity == saved_identity:
                _account_check_error = exc.code
                _account_startup_check_error = None
            raise
        with _trading_lock:
            if _account_identity(_account_values()) != saved_identity:
                raise account_store.AccountCheckError("account_changed_during_check")
            account_store.save_profile(values)
            if _account_data is not None:
                _account_data.invalidate()
            if candidate_identity != saved_identity:
                _clear_account_run_selection()
            # Do not retain a readiness report for the prior credential set.
            _account_report = None
            _account_report_identity = candidate_identity
            _account_check_error = exc.code
            _account_startup_check_error = None
            return {
                "saved": True,
                "wallet": values.get("POLYMARKET_WALLET_ADDRESS") or values.get("POLY_FUNDER", ""),
                "read_only": True,
                "account_check_state": "failed",
                "account_check_ready": False,
                "live_start_ready": False,
                "settlement_credentials_ready": None,
                "check_error": exc.code,
                "error": str(exc),
            }
    with _trading_lock:
        if _account_identity(_account_values()) != saved_identity:
            raise account_store.AccountCheckError("account_changed_during_check")
        if save:
            if values.get("POLYMARKET_OWNER_PRIVATE_KEY") and not report.get("signer_matches"):
                raise ValueError("签名私钥与资金账户不匹配，未保存")
            if report.get("compromised"):
                raise ValueError("此签名账户有凭据暴露记录，请使用新的安全账户；未保存")
            account_store.save_profile(values)
            if _account_data is not None:
                _account_data.invalidate()
            if candidate_identity != saved_identity:
                # A stopped run is still useful as history, but it belongs to
                # the previous credential set. Do not let default modern API
                # queries select that run after an account switch or signer
                # replacement; the SQLite projection remains untouched.
                _clear_account_run_selection()
        # Readiness belongs to the exact credential set, never wallet alone.
        if save or candidate_identity == saved_identity:
            _account_report = report
            _account_report_identity = _account_identity(_account_values()) if save else saved_identity
            _account_check_error = None
            _account_startup_check_error = None
        return report


def _account_request_error(headers) -> tuple[int, str] | None:
    origin, host = headers.get("Origin", ""), headers.get("Host", "")
    parsed = urlsplit(origin)
    if not origin or parsed.netloc != host or parsed.scheme not in {"http", "https"}:
        return 403, "账户操作必须从当前页面发起"
    if headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
        return 415, "请求格式必须是 JSON"
    # Backend listens only on loopback. Nginx overwrites these identity headers.
    trusted_https = (os.environ.get("PM_TRUST_ACCOUNT_PROXY") == "1"
                     and headers.get("X-Forwarded-Proto") == "https" and parsed.scheme == "https")
    # Explicit deployment opt-in for the operator-requested public console.
    # An origin is routing/CSRF protection, not an authenticated identity:
    # anyone reaching this configured console may check/change its account.
    public_origin = os.environ.get("PM_ACCOUNT_PUBLIC_ORIGIN", "").strip()
    public_allowed = bool(public_origin) and origin == public_origin
    if trusted_https and (headers.get("X-PM-Authenticated") or public_allowed):
        return None
    if parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        return 403, "请使用带登录保护的 HTTPS 页面接入账户"
    return _control_request_error(headers, "live")


def private_key_configured() -> bool:
    """Backward-compatible live gate for the current Owner-signer adapter."""
    return bool(account_config_status()["execution_credentials_ready"])


def _control_token() -> str:
    # A saved account profile is the durable source for the operator control
    # password.  The environment value remains the bootstrap fallback for a
    # fresh server before the first account-access save.
    try:
        saved = account_store.saved_control_token()
    except RuntimeError:
        saved = ""
    return saved or os.environ.get("PM_DASHBOARD_CONTROL_TOKEN", "").strip()


def _control_session_ttl() -> int:
    raw = os.environ.get("PM_CONTROL_SESSION_TTL_SECONDS", "")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = _CONTROL_SESSION_TTL_SECONDS
    return max(300, min(value, 7 * 24 * 60 * 60))


def _control_cookie_value(configured_token: str, issued_at: int | None = None) -> str:
    """Create a stateless signed browser session from the saved password."""
    stamp = int(time.time()) if issued_at is None else int(issued_at)
    body = f"{_CONTROL_SESSION_VERSION}.{stamp}.{secrets.token_urlsafe(18)}"
    signature = hmac.new(configured_token.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{signature}"


def _request_cookie(headers, name: str) -> str:
    raw = headers.get("Cookie", "") or ""
    parsed = SimpleCookie()
    try:
        parsed.load(raw)
    except Exception:
        return ""
    morsel = parsed.get(name)
    return morsel.value if morsel else ""


def _valid_control_session(cookie: str, configured_token: str, now: float | None = None) -> bool:
    if not cookie or not configured_token:
        return False
    parts = cookie.split(".")
    if len(parts) != 4 or parts[0] != _CONTROL_SESSION_VERSION:
        return False
    try:
        issued_at = int(parts[1])
    except ValueError:
        return False
    current = time.time() if now is None else now
    age = current - issued_at
    if age < -60 or age > _control_session_ttl():
        return False
    body = ".".join(parts[:3])
    expected = hmac.new(configured_token.encode("utf-8"), body.encode("ascii"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(parts[3], expected)


def _control_cookie_secure(headers) -> bool:
    configured = os.environ.get("PM_CONTROL_COOKIE_SECURE")
    if configured is not None:
        return configured == "1"
    origin = headers.get("Origin", "") or ""
    return headers.get("X-Forwarded-Proto") == "https" or origin.startswith("https://")


def _control_cookie_header(value: str, headers) -> str:
    attributes = [f"{_CONTROL_SESSION_COOKIE}={value}", f"Max-Age={_control_session_ttl()}", "Path=/", "HttpOnly", "SameSite=Strict"]
    if _control_cookie_secure(headers):
        attributes.insert(3, "Secure")
    return "; ".join(attributes)


def _control_request_error(headers, mode: str | None, *, allow_session: bool = True) -> tuple[int, str] | None:
    """Validate same-origin control access using a signed browser session or password."""
    content_type = (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return 415, "请求格式必须是 JSON"

    origin = headers.get("Origin")
    host = headers.get("Host")
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme not in {"http", "https"} or not host or parsed.netloc != host:
            return 403, "请求来源不允许"

    # The public deployment already authenticates every request with nginx
    # Basic Auth and forwards the authenticated operator identity.  Treat that
    # HTTPS proxy identity as the control session so a fresh server does not
    # require a second password that was never configured.  The backend is
    # loopback-only; direct HTTP callers still need the signed control token.
    proxy_authenticated = (
        os.environ.get("PM_TRUST_ACCOUNT_PROXY") == "1"
        and bool(headers.get("X-PM-Authenticated"))
        and headers.get("X-Forwarded-Proto") == "https"
        and bool(origin)
        and parsed.scheme == "https"
    )
    if proxy_authenticated:
        return None

    configured_token = _control_token()
    token_required = bool(configured_token) or os.environ.get("PM_TRADING_LIVE_UNLOCK") == "1" or mode == "live"
    if not token_required:
        return None
    if not configured_token:
        return 503, "服务器尚未配置交易控制密码"
    if allow_session and origin and _valid_control_session(_request_cookie(headers, _CONTROL_SESSION_COOKIE), configured_token):
        return None
    authorization = headers.get("Authorization") or ""
    supplied_token = headers.get("X-PM-Control-Token", "") or (authorization[7:].strip() if authorization.startswith("Bearer ") else "")
    if not supplied_token or not hmac.compare_digest(supplied_token, configured_token):
        return 401, "交易控制密码错误"
    return None


def _supplied_control_token(headers) -> str:
    authorization = headers.get("Authorization") or ""
    return headers.get("X-PM-Control-Token", "") or (
        authorization[7:].strip() if authorization.startswith("Bearer ") else ""
    )


def live_status() -> dict:
    """Return one cached snapshot and prevent overlapping collector probes."""
    if not _live_fetch_lock.acquire(blocking=False):
        with _live_lock:
            return {
                **_live_cache,
                "node_label": _live_config()["node_label"],
                "refreshing": True,
            }
    try:
        return _live_status_fetch()
    finally:
        _live_fetch_lock.release()


def cached_live_status() -> dict:
    """HTTP/feed clients only read the last background collector snapshot."""
    with _live_lock:
        value = validate_snapshot(_live_cache)
        age = time.monotonic() - _live_cache_at if _live_cache_at else None
    value.update(node_label=_live_config()["node_label"], cache_age_seconds=age,
                 refreshing=age is None or age >= 5)
    value.setdefault("current_markets", [])
    value.setdefault("collector_online", False)
    if age is None or age > 15:
        value["collector_online"] = False
        value["current_markets"] = []
        value["stale_reason"] = "行情汇总尚未更新"
    return value


def _running_engine_market_status(status: dict | None = None) -> dict | None:
    """Expose accepted runtime pairs without rebuilding them from token books."""
    if status is None:
        # The status endpoint is polled beside markets. Do not run the full
        # status/analytics path a second time just to render the same quote;
        # a fresh platform runtime is sufficient evidence for this read-only
        # projection and the normal status request still owns process checks.
        with _trading_lock:
            process = _trading_process
            running = (_trading_engine == "platform" and
                       ((process is not None and process.poll() is None) or _trading_pid is not None))
            selection = (_run_identity(), _trading_log, _trading_mode, _trading_account_id, _trading_config_revision)
        if not running:
            return None
        stats = trade_log_stats(selection)
        status = {"running": True, "stats": stats}
    if not isinstance(status, dict) or status.get("running") is not True:
        return None
    stats = status.get("stats")
    runtime = stats.get("runtime") if isinstance(stats, dict) else None
    if not isinstance(runtime, dict) or runtime.get("engine") != "platform":
        return None
    markets = runtime.get("markets") if isinstance(runtime.get("markets"), list) else []
    snapshots = runtime.get("snapshots") if isinstance(runtime.get("snapshots"), list) else []
    strategy_runtime = runtime.get("strategy_runtime") if isinstance(runtime.get("strategy_runtime"), dict) else {}
    strategy_config = strategy_runtime.get("config") if isinstance(strategy_runtime.get("config"), dict) else {}
    current_round = strategy_runtime.get("currentRound") if isinstance(strategy_runtime.get("currentRound"), dict) else {}
    current_config = current_round.get("config") if isinstance(current_round.get("config"), dict) else {}
    configured_age = strategy_config.get("maxQuoteAgeSeconds", current_config.get("maxQuoteAgeSeconds"))
    if configured_age is None:
        runtime_age_ms = runtime.get("stale_after_ms", runtime.get("quote_max_age_ms"))
    else:
        runtime_age_ms = _epoch(configured_age) * 1000 if _epoch(configured_age) is not None else configured_age
    stale_after_ms = normalize_stale_after_ms(runtime_age_ms)
    stale_after_invalid = runtime_age_ms is not None and stale_after_ms is None
    runtime_stale = runtime.get("stale") is True
    market_by_id = {str(market.get("id")): market for market in markets
                    if isinstance(market, dict) and market.get("id")}
    rows = []
    for snapshot in snapshots:
        if not isinstance(snapshot, dict):
            continue
        market_id = snapshot.get("marketId") or snapshot.get("market_id")
        round_id = snapshot.get("roundId") or snapshot.get("round_id")
        yes, no = snapshot.get("YES"), snapshot.get("NO")
        sequence = snapshot.get("sequence")
        source_at = _epoch(snapshot.get("sourceAt") if snapshot.get("sourceAt") is not None
                           else snapshot.get("source_at"))
        expires_at = _epoch(snapshot.get("expiresAt") if snapshot.get("expiresAt") is not None
                            else snapshot.get("expires_at"))
        if (not isinstance(market_id, str) or not market_id or not isinstance(round_id, str) or not round_id
                or not isinstance(yes, dict) or not isinstance(no, dict)
                or type(sequence) is not int or sequence < 0
                or source_at is None or expires_at is None):
            continue
        if not isinstance(yes.get("assetId"), str) or not yes.get("assetId") \
                or not isinstance(no.get("assetId"), str) or not no.get("assetId"):
            continue
        market = market_by_id.get(market_id, {})
        rows.append({"slug": market.get("name") or market_id, "name": market.get("name") or market_id,
                     "assetId": snapshot.get("assetId") or market.get("assetId") or strategy_config.get("assetId"),
                     "condition_id": market_id, "round_id": round_id,
                     "start": _epoch(market.get("startsAt")), "end": _epoch(market.get("endsAt")),
                     "paired_snapshot": snapshot, "source": "platform-runtime",
                     "stale_after_ms": stale_after_ms, "_stale_after_invalid": stale_after_invalid,
                     "_runtime_stale": runtime_stale})
    if not rows:
        return None
    return {"collector_online": status.get("running") is True and runtime.get("status") == "running",
            "current_markets": rows, "source": "platform-runtime",
            "stale": runtime_stale,
            "stale_reason": runtime.get("error") or ("runtime_snapshot_stale" if runtime.get("stale") else None),
            "asOf": _epoch(runtime.get("source_at"))}


def refresh_live_background(stop: threading.Event) -> None:
    while not stop.is_set():
        live_status()
        stop.wait(1)


def supervise_projection(stop: threading.Event) -> None:
    while not stop.wait(1):
        try:
            _activate_projection()
        except (OSError, sqlite3.Error, ValueError):
            pass


def _live_status_fetch() -> dict:
    """Read a public collector snapshot without rewriting its source clock."""
    global _live_cache, _live_cache_at
    config = _live_config()
    with _live_lock:
        if time.monotonic() - _live_cache_at < 1:
            return {**validate_snapshot(_live_cache), "node_label": config["node_label"]}
    try:
        if config["collector_is_local"]:
            value = validate_snapshot(json.loads(config["snapshot_path"].read_text(encoding="utf-8")))
        else:
            if not config["ssh_key"].is_file():
                raise FileNotFoundError("remote SSH key missing")
            command = ["ssh", "-i", str(config["ssh_key"]), "-p", str(config["remote_port"]),
                       "-o", "BatchMode=yes", "-o", f"ConnectTimeout={config['connect_timeout']}",
                       "-o", "StrictHostKeyChecking=yes", config["remote_host"],
                       "cat -- " + shlex.quote(config["remote_snapshot_path"])]
            completed = subprocess.run(command, text=True, encoding="utf-8", capture_output=True, timeout=10)
            if completed.returncode != 0:
                raise RuntimeError("remote snapshot read failed")
            value = validate_snapshot(json.loads(completed.stdout))
        value["node_label"] = config["node_label"]
    except Exception:
        value = {"collector_online": False, "checked_at": datetime.now(timezone.utc).isoformat(),
                 "node_label": config["node_label"], "current_markets": [], "error_code": "collector_connection_failed",
                 "error": f"无法读取{config['node_label']}行情投影，请检查采集服务、快照和连接。"}
    with _live_lock:
        _live_cache, _live_cache_at = value, time.monotonic()
        return dict(value)


def trading_status(include_stats: bool = True) -> dict:
    global _trading_process, _trading_pid, _trading_exit_code
    global _trading_stop_result
    _restore_trading_state()
    with _trading_lock:
        process = _trading_process
        if process is not None:
            _trading_exit_code = process.poll()
            if _trading_exit_code is not None:
                if not _trading_stop_result:
                    _trading_stop_result = _automatic_stop_result(_trading_exit_code, _trading_console_log)
                _trading_process = None
                _trading_pid = None
                _persist_trading_state()
        running = (process is not None and process.poll() is None) or _process_matches(_trading_pid, _trading_log)
        # The account reader is intentionally asynchronous.  A stop request
        # can finish before its next cache refresh, so reconcile the persisted
        # stop result on later status reads as soon as a fresh, complete empty
        # open-order snapshot becomes available.  This is cache-only and never
        # waits for the reader or performs network I/O on the status path.
        if (not running and isinstance(_trading_stop_result, dict)
                and _trading_stop_result.get("confirmed") is not True
                and _remote_orders_empty_from_fresh_snapshot()):
            _trading_stop_result = {
                **_trading_stop_result,
                "confirmed": True,
                "remote_orders_state": "confirmed",
                "message": "进程已停止，账户快照已确认无远端挂单。",
            }
            _persist_trading_state()
        account = account_config_status()
        stop_reason = (_trading_stop_result or {}).get("reason")
        stop_failed = stop_reason in {"journal_failed", "market_end_event_failed", "process_failed"}
        status = {
            "available": (TRADING_ROOT / "dist" / "cli" / "platform.js").is_file(),
            "execution_target": "platform",
            "engine": _trading_engine,
            "execution": (("strategy" if (_trading_params or {}).get("strategy_id") else "observation") if _trading_engine == "platform" else None),
            "strategy_id": (_trading_params or {}).get("strategy_id"),
            "running": running,
            "mode": _trading_mode,
            "pid": process.pid if process and running else (_trading_pid if running else None),
            "exit_code": _trading_exit_code,
            "started_at": _trading_started_at,
            "params": dict(_trading_params or {}),
            "stop_result": dict(_trading_stop_result or {}),
            "live_unlocked": os.environ.get("PM_TRADING_LIVE_UNLOCK") == "1",
            # A present .env is not enough: report configured only when the key
            # exists and is non-empty after dotenv loading by the child process.
            "account_configured": account["live_start_ready"],
            "service_state": "running" if running else ("failed" if stop_failed else "stopped"),
            # Process exit only confirms the local process. A live stop is
            # confirmed after the runtime/account projection confirms remote
            # order reconciliation; until then keep the command executing.
            "command_status": "executing" if running else ("failed" if stop_failed
                              else "confirmed" if (_trading_stop_result or {}).get("confirmed") is True
                              else "executing"),
            "account": account,
            "log": str(_trading_log).replace("\\", "/") if _trading_log else None,
            "run_id": _trading_run_id,
            "config_revision": _trading_config_revision,
            "account_id": _trading_account_id,
        }
    # No journal parsing, database aggregation or console scans in this lock.
        selection = (_run_identity(), _trading_log, _trading_mode, _trading_account_id, _trading_config_revision)
    if include_stats:
        stats = trade_log_stats(selection)
        projection = stats.get("projection")
        if isinstance(projection, dict):
            # `worker_alive` describes the low-priority analytics worker. It is
            # intentionally allowed to outlive a finished run, so expose the
            # trading process state separately instead of making the UI infer
            # execution state from the projection worker.
            stats = {**stats, "projection": {**projection, "trader_alive": running}}
        runtime = stats.get("runtime")
        if not running and isinstance(runtime, dict):
            runtime = dict(runtime)
            automatic = status["stop_result"] if status["stop_result"].get("automatic") else {}
            runtime["status"] = ("failed" if automatic.get("reason") in {
                "journal_failed", "market_end_event_failed", "process_failed",
            } else "stopped")
            runtime["stale"] = True
            stats = {**stats, "runtime": runtime}
        status["stats"] = stats
        runtime = stats.get("runtime")
        if running:
            strategy_runtime = runtime.get("strategy_runtime") if isinstance(runtime, dict) else None
            if isinstance(strategy_runtime, dict) and strategy_runtime.get("paused") is True:
                status["service_state"] = "paused"
            elif isinstance(runtime, dict) and runtime.get("status") == "running":
                status["service_state"] = "running"
            else:
                status["service_state"] = "starting"
            pending = (status.get("params") or {}).get("pendingControl") or {}
            source_at = _epoch(runtime.get("source_at")) if isinstance(runtime, dict) else None
            expires_at = _epoch(runtime.get("expires_at")) if isinstance(runtime, dict) else None
            expected_paused = pending.get("action") == "pause"
            confirmed = (isinstance(runtime, dict) and runtime.get("status") == "running"
                         and runtime.get("stale") is not True and source_at is not None
                         and expires_at is not None and expires_at > time.time()
                         and source_at >= (pending.get("requestedAt") or status.get("started_at") or float("inf"))
                         and isinstance(strategy_runtime, dict)
                         and strategy_runtime.get("paused") is expected_paused)
            status["command_status"] = "confirmed" if confirmed else "executing"
    return status


def _new_trade_cache(path: Path) -> dict:
    return {
        "path": str(path), "offset": 0, "fragment": b"", "markets": {}, "traded_market_keys": set(),
        "stats": {
            "available": True, "file": str(path).replace("\\", "/"),
            "quotes": 0, "fills": 0, "takers": 0, "cancels": 0, "markets": 0, "traded_markets": 0,
            "fill_notional": 0.0, "fees": 0.0, "settled_markets": 0,
            "pnl": None, "last_event": None, "error": None, "events": [],
        },
    }




def _run_identity() -> str | None:
    if _trading_run_id:
        return _trading_run_id
    return None


def _projection_snapshot(selection: tuple | None = None) -> dict:
    # Snapshot the selection once so a concurrent new run cannot mix fields.
    if selection is None:
        with _trading_lock:
            selection = (_run_identity(), _trading_log, _trading_mode, _trading_account_id, _trading_config_revision)
    run_id, path, mode, account, revision = selection
    if not path or not run_id or mode != "live":
        return {"state": "idle", "run_id": None, "stale": True}
    try:
        with _read_model_init_lock:
            return _read_model.snapshot(run_id) if _read_model else {"state": "waiting", "run_id": run_id, "stale": True}
    except (OSError, ValueError):
        return {"state": "unavailable", "run_id": run_id, "stale": True}


def _activate_projection() -> None:
    """Single supervisor owns analytics selection; requests cannot rewind it."""
    global _read_model
    with _trading_lock:
        selection = (_projection_pending[0] if _projection_pending else
                     (_run_identity(), _trading_log, _trading_mode, _trading_account_id, _trading_config_revision))
    run_id, path, mode, account, revision = selection
    if not path or mode != "live":
        return
    with _read_model_init_lock:
        if _read_model is None:
            _read_model = ReadModel(TRADING_ROOT / "results" / "dashboard")
        _read_model.select(run_id, mode, account, path, revision)
    with _trading_lock:
        if _projection_pending and _projection_pending[0] == selection:
            _projection_pending.popleft()


def trade_log_stats(selection: tuple | None = None) -> dict:
    view = _projection_snapshot(selection)
    stats = view.get("stats")
    if not isinstance(stats, dict):
        stats = {**_new_trade_cache(Path(""))["stats"], "available": False,
                 "file": None, "pnl": None, "fees": None, "market_summaries": []}
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
             ("state", "run_id", "as_of", "age_seconds", "stale", "worker_alive", "projection_ms")},
            "pending": bool(stats.get("pending") or view.get("ingestion", {}).get("pending"))}


def strategy_config_store() -> StrategyConfigStore:
    global _strategy_config_store
    path = (TRADING_ROOT / "results" / "dashboard" / "btc-reversal-config.json").resolve()
    if _strategy_config_store is None or _strategy_config_store.path != path:
        _strategy_config_store = StrategyConfigStore(path)
    return _strategy_config_store


def strategy_config_status() -> dict:
    saved = strategy_config_store().get()
    status = trading_status()
    runtime = (status.get("stats", {}).get("runtime") or {}).get("strategy_runtime") or {}
    active = (runtime.get("currentRound") or {}).get("configRevision") if status.get("running") else None
    if isinstance(active, str) and active.isdigit():
        active = int(active)
    return {**saved, "assetId": saved["config"].get("assetId", "btc"), "activeRevision": active,
            "nextRoundRevision": saved["savedRevision"] if status.get("running") and active != saved["savedRevision"] else None}


def save_strategy_config(payload: dict) -> dict:
    if set(payload) - {"strategyId", "expectedRevision", "config"} or not {"expectedRevision", "config"} <= set(payload):
        raise ValueError("请提交策略参数和当前版本")
    if payload.get("strategyId", STRATEGY_ID) != STRATEGY_ID:
        raise ValueError("策略不存在")
    with _config_control_lock:
        _validate_running_asset(payload["config"])
        strategy_config_store().save(payload["config"], payload["expectedRevision"])
        return strategy_config_status()


def _validate_running_asset(config: dict) -> None:
    status = trading_status(include_stats=False)
    active = (status.get("params") or {}).get("assetId")
    requested = config.get("assetId", active) if isinstance(config, dict) else None
    if status.get("running") and active and (not isinstance(requested, str) or requested.strip().lower() != active):
        raise ValueError("请先停止交易，再切换策略资产")


def strategy_control(payload: dict) -> dict:
    action = payload.get("action")
    if payload.get("strategy_id", STRATEGY_ID) != STRATEGY_ID:
        raise ValueError("策略不存在")
    if action == "stop":
        return stop_trading()
    if action in {"pause", "resume"}:
        with _trading_lock:
            status = trading_status(include_stats=False)
            if not status["running"] or status["strategy_id"] != STRATEGY_ID or not _trading_log:
                raise ValueError("反转策略尚未运行")
            control = _trading_log.with_suffix(".control.json")
            temporary = control.with_suffix(".next")
            temporary.write_text(json.dumps({"paused": action == "pause"}), encoding="utf-8")
            temporary.replace(control)
            if _trading_params is not None:
                _trading_params["pendingControl"] = {"action": action, "requestedAt": time.time()}
                _persist_trading_state()
            return {**status, "control_requested": action, "control_pending": True,
                    "command_status": "accepted", "requested_state": "paused" if action == "pause" else "running"}
    if action != "start":
        raise ValueError("操作必须为start、pause、resume或stop")
    if type(payload.get("revision")) is not int:
        raise ValueError("启动需要已保存的策略版本")
    try:
        request_id = str(uuid.UUID(payload.get("request_id")))
    except (ValueError, TypeError, AttributeError):
        raise ValueError("启动请求编号必须是UUID") from None
    with _config_control_lock, _trading_lock:
        _restore_trading_state()
        selection = {"assetId": payload.get("asset_id"), "marketIds": payload.get("market_ids")}
        if request_id == _trading_request_id:
            if payload["revision"] != _trading_config_revision:
                raise ValueError("同一启动请求不能改变配置版本")
            if selection != (_trading_params or {}).get("requestSelection", {"assetId": None, "marketIds": None}):
                raise ValueError("同一启动请求不能改变资产或市场选择")
            return trading_status(include_stats=False)
        saved = strategy_config_store().get()
        if payload["revision"] != saved["savedRevision"]:
            raise ConfigConflictError(saved["savedRevision"])
        if not saved["savedRevision"]:
            raise ValueError("请先保存策略参数")
        config = saved["config"]
        selected_asset = config.get("assetId", "btc")
        requested_asset = payload.get("asset_id")
        if requested_asset is not None:
            if not isinstance(requested_asset, str) or requested_asset.strip().lower() != selected_asset:
                raise ValueError("命令 assetId 与策略配置不一致")
        requested_markets = payload.get("market_ids")
        expected_market_identity = None
        if requested_markets is None:
            raise ValueError("启动必须指定 marketIds，以绑定初始 marketId 和 roundId")
        if requested_markets is not None:
            if (not isinstance(requested_markets, list)
                    or len(requested_markets) != 1
                    or not isinstance(requested_markets[0], (str, dict))):
                raise ValueError("单实例启动必须指定一个有效 marketId")
            selected = requested_markets[0]
            if isinstance(selected, dict):
                item_asset = selected.get("assetId") or selected.get("asset_id")
                if item_asset is not None and (not isinstance(item_asset, str)
                                               or item_asset.strip().lower() != selected_asset):
                    raise ValueError("命令 marketIds 与策略 assetId 不一致")
                market_id = (selected.get("marketId") or selected.get("market_id")
                             or selected.get("conditionId") or selected.get("condition_id"))
                requested_round = selected.get("roundId") or selected.get("round_id")
            else:
                market_id, requested_round = selected.strip(), None
            if not isinstance(market_id, str) or not market_id or market_id.lower() in SUPPORTED_ASSET_IDS:
                raise ValueError("命令 marketIds 必须是明确的市场 ID")
            if requested_round is not None and (not isinstance(requested_round, str)
                                                or not requested_round.isdigit()
                                                or int(requested_round) % 300 != 0):
                raise ValueError("命令 marketIds 缺少有效的五分钟 roundId")
            catalog = _modern_markets({"assetId": [selected_asset]}).get("items") or []
            matches = [row for row in catalog if row.get("marketId") == market_id
                       and row.get("assetId") == selected_asset
                       and (requested_round is None or row.get("roundId") == requested_round)]
            identities = {(row.get("marketId"), row.get("roundId")) for row in matches
                          if isinstance(row.get("marketId"), str) and row.get("marketId")
                          and isinstance(row.get("roundId"), str) and row.get("roundId").isdigit()}
            if len(identities) != 1:
                raise ValueError("命令 marketId/roundId 未能唯一映射到所选资产，请刷新市场")
            identity_market_id, identity_round_id = next(iter(identities))
            if int(identity_round_id) % 300 != 0:
                raise ValueError("市场目录的 roundId 无效，请刷新市场")
            expected_market_identity = {"marketId": identity_market_id, "roundId": identity_round_id}
        pool = market_pool()
        if pool.get("error") == "market_pool_invalid" or (pool.get("available") and pool.get("stale")):
            raise ValueError("运行池配置无效，请先选择一个资产")
        desired_assets = pool.get("desiredIds") or []
        if desired_assets and desired_assets[0] != selected_asset:
            raise ValueError("运行池资产与策略 assetId 不一致，请先统一配置")
        return start_trading({"mode": config["mode"], "confirm_live": True,
                              "_request_selection": selection,
                              "_expected_market_identity": expected_market_identity,
                              "duration_min": config["durationMinutes"]},
                             config_revision=saved["savedRevision"], request_id=request_id,
                             strategy_config=saved)


def _start_trading(payload: dict, *, config_revision: int | None = None, request_id: str | None = None,
                  strategy_config: dict | None = None) -> dict:
    global _trading_process, _trading_pid, _trading_started_at, _trading_mode, _trading_params
    global _trading_log, _trading_console_log, _trading_exit_code, _trading_stop_result
    global _trading_run_id, _trading_config_revision, _trading_account_id, _trading_request_id
    global _trading_engine
    if _account_check_lock.locked():
        raise account_store.AccountCheckError("account_check_busy")
    mode = str(payload.get("mode") or "live").lower()
    if mode != "live":
        raise ValueError("新版交易入口只支持 live 模式")
    if not TRADING_ROOT.is_dir() or not (TRADING_ROOT / "dist" / "cli" / "platform.js").is_file():
        raise RuntimeError("交易引擎尚未构建")
    if mode == "live":
        if payload.get("confirm_live") is not True:
            raise PermissionError("实盘必须明确确认")
        if os.environ.get("PM_TRADING_LIVE_UNLOCK") != "1":
            raise PermissionError("服务器未开启实盘解锁")
        account_status = account_config_status()
        if not account_status["execution_credentials_ready"]:
            raise PermissionError("未配置交易账户")
        if (not account_status["account_check_ready"]
                or account_status["settlement_credentials_ready"] is not True):
            raise PermissionError("账户尚未通过最近一次钱包、签名、授权和余额检查")
    # 运行时间允许填 0，表示不按时间自动停止，直到用户手动停止。
    duration_raw = payload.get("duration_min", 15)
    if type(duration_raw) not in {int, float}:
        raise ValueError("duration_min must be a finite JSON number")
    try:
        duration_min = float(duration_raw)
    except OverflowError:
        raise ValueError("duration_min must be a finite JSON number") from None
    if not math.isfinite(duration_min) or duration_min < 0:
        raise ValueError("duration_min 必须为非负数字")
    if not math.isfinite(duration_min) or duration_min < 0 or (duration_min != 0 and duration_min < 0.1):
        raise ValueError("duration_min 必须为 0（一直运行）或至少 0.1 分钟")
    with _trading_lock:
        if _account_check_lock.locked():
            raise account_store.AccountCheckError("account_check_busy")
        _restore_trading_state()
        if _trading_process is None and _process_matches(_trading_pid, _trading_log):
            raise RuntimeError("已有交易进程运行中")
        if _trading_process is not None and _trading_process.poll() is None:
            raise RuntimeError("已有交易进程运行中")
        if mode == "live":
            account_status = account_config_status()
            if (os.environ.get("PM_TRADING_LIVE_UNLOCK") != "1"
                    or not account_status["execution_credentials_ready"]
                    or not account_status["account_check_ready"]
                    or account_status["settlement_credentials_ready"] is not True):
                raise PermissionError("账户配置或实盘授权已变化，请重新检查")
        log_dir = TRADING_ROOT / "results" / "live"
        log_dir.mkdir(parents=True, exist_ok=True)
        run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:12]
        candidate_log = log_dir / f"dashboard-{run_id}.jsonl"
        candidate_console_log = log_dir / f"dashboard-{run_id}.console.log"
        candidate_state = log_dir / f"dashboard-{run_id}.platform-state.json"
        account_wallet = account_config_status().get("wallet") if mode == "live" else None
        # Account aggregation and restart deduplication are case-insensitive
        # for Ethereum addresses; keep the internal account key canonical.
        account_id = account_wallet.lower() if isinstance(account_wallet, str) and account_wallet else None
        if strategy_config:
            identity = hashlib.sha256((account_id or "live").lower().encode()).hexdigest()[:20]
            candidate_state = log_dir / f"btc-reversal-{identity}.platform-state.json"
        # Create the selected journal before returning the start response.
        # The status endpoint must never fall back to a previous run while the
        # child process is still starting.
        candidate_log.touch()
        if strategy_config:
            # A new operator start resumes the saved strategy. Reusing a
            # process/state alone must still preserve an intentional pause.
            candidate_log.with_suffix(".control.json").write_text(
                json.dumps({"paused": False}), encoding="utf-8")
        console_handle = candidate_console_log.open("a", encoding="utf-8")
        args = [
            "node", "dist/cli/platform.js", "--live",
            "--duration-sec", str(duration_min * 60), "--status-sec", "2",
            "--journal-file", str(candidate_log), "--state-file", str(candidate_state),
            "--stop-file", str(candidate_log.with_suffix(".stop")),
        ]
        if strategy_config:
            configured_asset = strategy_config.get("config", {}).get("assetId", "btc")
            args.extend(["--strategy", STRATEGY_ID, "--asset", configured_asset,
                         "--strategy-config", str(strategy_config_store().path),
                         "--control-file", str(candidate_log.with_suffix(".control.json"))])
            expected_identity = payload.get("_expected_market_identity")
            if expected_identity is not None:
                market_id = expected_identity.get("marketId") if isinstance(expected_identity, dict) else None
                round_id = expected_identity.get("roundId") if isinstance(expected_identity, dict) else None
                if (not isinstance(market_id, str) or not market_id
                        or not isinstance(round_id, str) or not round_id.isdigit()
                        or int(round_id) % 300 != 0):
                    raise ValueError("启动市场身份无效")
                args.extend(["--expected-market-id", market_id, "--expected-round-id", round_id])
        env = _trading_environment()
        env["LIVE"] = "true"
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            _trading_process = subprocess.Popen(
                args, cwd=TRADING_ROOT, env=env, stdout=console_handle,
                stderr=subprocess.STDOUT,
                creationflags=creationflags,
            )
        except Exception:
            console_handle.close()
            raise
        console_handle.close()
        _trading_log = candidate_log
        _trading_console_log = candidate_console_log
        _trading_pid = _trading_process.pid
        _trading_started_at = time.time()
        _trading_mode = mode
        _trading_run_id = run_id
        _trading_engine = "platform"
        _trading_config_revision = config_revision
        _trading_request_id = request_id
        _trading_account_id = account_id
        _trading_params = {"mode": mode, "duration_min": duration_min}
        if strategy_config:
            _trading_params = {"strategy_id": STRATEGY_ID, "mode": mode,
                               "requestSelection": payload.get("_request_selection"),
                               "initialMarketIdentity": payload.get("_expected_market_identity"),
                               "duration_min": duration_min, "assetId": strategy_config["config"].get("assetId", "btc"),
                               "config": strategy_config["config"]}
        _trading_exit_code = None
        _trading_stop_result = None
        _persist_trading_state()
        _projection_pending.append((_trading_run_id, _trading_log, _trading_mode, _trading_account_id, _trading_config_revision))
        return trading_status(include_stats=False)


def start_trading(payload: dict, *, config_revision: int | None = None, request_id: str | None = None,
                  strategy_config: dict | None = None) -> dict:
    with deployment_mutex():
        return _start_trading(payload, config_revision=config_revision, request_id=request_id,
                              strategy_config=strategy_config)


def _trading_environment() -> dict:
    env = os.environ.copy()
    env.update(_account_values())
    if not env.get("POLYMARKET_OWNER_PRIVATE_KEY") and env.get("POLYMARKET_PRIVATE_KEY"):
        env["POLYMARKET_OWNER_PRIVATE_KEY"] = env["POLYMARKET_PRIVATE_KEY"]
    # Control-plane and diagnostic credentials/configuration belong to the
    # parent process. Do not leak them into a trading child environment.
    for name in ("PM_DASHBOARD_CONTROL_TOKEN", "PM_ACCOUNT_PROFILE", "PM_ACCOUNT_RPC_URL",
                 "PM_ACCOUNT_RPC_FALLBACK_URL", "PM_TRADING_LIVE_UNLOCK"):
        env.pop(name, None)
    # Pin the exact checked wallet; blank also prevents dotenv restoring overrides.
    env["POLY_FUNDER"] = env.get("POLYMARKET_WALLET_ADDRESS") or env.get("POLY_FUNDER", "")
    # Preserve an explicitly configured legacy signature mode. An empty value
    # remains empty for deployments whose runtime selects the default.
    env["POLY_SIGNATURE_TYPE"] = env.get("POLY_SIGNATURE_TYPE", "")
    return env


def stop_trading() -> dict:
    global _trading_process, _trading_pid, _trading_exit_code, _trading_stop_result
    _restore_trading_state()
    with _trading_lock:
        process = _trading_process
        restored_pid = _trading_pid if process is None else None
        candidate_pid = restored_pid or (process.pid if process else None)
        if (_trading_mode == "live" and candidate_pid
                and (_trading_stop_result or {}).get("requested_pid") == candidate_pid
                and not (_trading_stop_result or {}).get("process_stopped")
                and _process_matches(candidate_pid, _trading_log)):
            # A repeated signal can terminate a child whose one-shot signal
            # handler is already draining orders. The first request owns stop.
            return trading_status(include_stats=False)
        stop_requested = False
        if process is None and not _process_matches(candidate_pid, _trading_log):
            remote_confirmed = _remote_orders_empty_from_fresh_snapshot()
            _trading_stop_result = {
                "confirmed": remote_confirmed,
                "process_stopped": True,
                "remote_orders_state": "confirmed" if remote_confirmed else "unconfirmed",
                "message": ("当前没有正在运行的交易任务，账户快照已确认无远端挂单。"
                            if remote_confirmed else "当前没有正在运行的交易任务，远端挂单状态尚未通过账户查询确认。"),
            }
            _persist_trading_state()
            return trading_status(include_stats=False)
        if process is None and restored_pid and _process_matches(restored_pid, _trading_log):
            try:
                if os.name == "nt":
                    if _trading_engine == "platform" and _trading_log:
                        _trading_log.with_suffix(".stop").touch()
                    else:
                        subprocess.run(["taskkill", "/PID", str(restored_pid), "/T"], timeout=10, check=False)
                else:
                    os.kill(restored_pid, signal.SIGTERM)
                stop_requested = True
                deadline = time.monotonic() + (8 if _trading_mode == "live" else 20)
                while time.monotonic() < deadline and _process_matches(restored_pid, _trading_log):
                    time.sleep(0.2)
            except (ProcessLookupError, OSError, subprocess.SubprocessError):
                pass
        if process is not None and process.poll() is None:
            try:
                if os.name == "nt":
                    if _trading_engine == "platform" and _trading_log:
                        _trading_log.with_suffix(".stop").touch()
                    else:
                        process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    process.send_signal(signal.SIGTERM)
                stop_requested = True
            except (ProcessLookupError, OSError):
                pass
            try:
                process.wait(timeout=8 if _trading_mode == "live" else 20)
            except subprocess.TimeoutExpired:
                # Live shutdown drains in-flight POSTs, cancels, and reconciles
                # fills. Keep it alive and report pending instead of killing
                # the very process responsible for resolving remote exposure.
                if _trading_mode != "live":
                    try:
                        process.kill()
                    except (ProcessLookupError, OSError):
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
        _trading_exit_code = process.poll() if process else None
        stopped = not _process_matches(restored_pid or (process.pid if process else None), _trading_log)
        # A stopped process does not prove remote live orders were cancelled.
        # Only a fresh, complete account snapshot with an empty open-order
        # section can confirm the remote side of the stop.
        confirmed = bool(stopped and _remote_orders_empty_from_fresh_snapshot())
        if not stopped:
            message = "已请求停止，正在等待撤单及成交对账完成；后台进程保留，请稍后核对。"
        elif confirmed:
            message = "进程已停止，账户快照已确认无远端挂单。"
        else:
            message = "进程已停止；实盘挂单尚未通过账户查询确认。"
        _trading_stop_result = {"confirmed": confirmed, "process_stopped": stopped,
                                "remote_orders_state": "confirmed" if confirmed else "unconfirmed",
                                "message": message}
        if stop_requested:
            _trading_stop_result["requested_pid"] = candidate_pid
        if stopped:
            _trading_process = None
            _trading_pid = None
        _persist_trading_state()
        return trading_status(include_stats=False)


def _epoch(value):
    if type(value) in (int, float):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return stamp.timestamp() if stamp.tzinfo else None
        except (ValueError, OverflowError, OSError):
            pass
    return None


def _money(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def _modern_market(row: dict, *, now: float | None = None, stale_after_ms: float | None = None) -> dict:
    """Map runtime accepted pairs; keep collector fallback display-only."""
    now = time.time() if now is None else now
    book_status = row.get("bookStatus") if isinstance(row.get("bookStatus"), dict) else row.get("book_status")
    row_health_stale = (row.get("healthy") is False
                        or row.get("quote_fresh") is False
                        or row.get("quoteFresh") is False
                        or row.get("collector_online") is False
                        or row.get("_collector_online") is False
                        or (isinstance(book_status, dict) and book_status.get("healthy") is False))
    if isinstance(book_status, dict):
        row_health_stale = row_health_stale or book_status.get("stale_book") is True \
            or book_status.get("transport_disconnected") is True \
            or any(book_status.get(key) in {"stale_book", "transport_disconnected"}
                   for key in ("status", "reason", "stale_reason"))
    row_health_stale = row_health_stale or row.get("stale_book") is True \
        or row.get("transport_disconnected") is True \
        or any(row.get(key) in {"stale_book", "transport_disconnected"}
               for key in ("status", "reason", "stale_reason"))
    snapshot = canonical_snapshot(row)
    asset_id = row.get("assetId") or row.get("asset_id") or row.get("asset")
    if isinstance(snapshot, dict):
        asset_id = snapshot.get("assetId") or snapshot.get("asset_id") or asset_id
    asset_id = asset_id.strip().lower() if isinstance(asset_id, str) and _ASSET_ID_RE.fullmatch(asset_id.strip().lower()) else None
    # The standalone public collector carries the asset in its canonical slug
    # (for example btc-updown-5m-...). Keep the asset identity available to
    # the API and UI even though the paired snapshot intentionally contains
    # only market and outcome token identities.
    if asset_id is None:
        slug_hint = str(row.get("slug") or row.get("name") or "").strip().lower()
        match = re.match(r"^([a-z0-9]+)-updown-5m-", slug_hint)
        if match and _ASSET_ID_RE.fullmatch(match.group(1)):
            asset_id = match.group(1)
    symbol = row.get("symbol") if isinstance(row.get("symbol"), str) else (asset_id.upper() if asset_id else None)
    cycle = row.get("cycle") if isinstance(row.get("cycle"), str) else "5m"
    slug = str(row.get("slug") or "")
    start, end = _epoch(row.get("start")), _epoch(row.get("end"))
    if not isinstance(snapshot, dict):
        quote_at = _epoch(row.get("quote_at") or row.get("quoteAt"))
        market_id = row.get("condition_id") or row.get("conditionId") or row.get("marketId") or row.get("market_id")
        round_id = row.get("roundId") or row.get("round_id")
        yes = {"assetId": row.get("up_token") or row.get("yesToken"),
               "bid": row.get("up_bid", row.get("yesBid")),
               "ask": row.get("up_ask", row.get("yesAsk"))}
        no = {"assetId": row.get("down_token") or row.get("noToken"),
              "bid": row.get("down_bid", row.get("noBid")),
              "ask": row.get("down_ask", row.get("noAsk"))}
        stale_after = normalize_stale_after_ms(row.get("stale_after_ms", stale_after_ms))
        expires_at = (quote_at + stale_after / 1000 if quote_at is not None and stale_after is not None
                      else None)
        market_id = market_id if isinstance(market_id, str) and market_id else None
        round_id = round_id if isinstance(round_id, str) and round_id else None
        supported = asset_id in SUPPORTED_ASSET_IDS
        return {"assetId": asset_id, "symbol": symbol, "supported": supported, "canEnable": supported,
                "name": str(row.get("name") or slug or (f"{symbol} 五分钟反转" if symbol else "市场")),
                "marketId": market_id, "roundId": round_id, "market_id": market_id, "round_id": round_id,
                "cycle": cycle, "startAt": start, "endAt": end, "yes": yes, "no": no,
                "yesToken": yes["assetId"], "noToken": no["assetId"], "yesBid": yes["bid"],
                "yesAsk": yes["ask"], "noBid": no["bid"], "noAsk": no["ask"],
                "volume": row.get("volume"), "liquidity": row.get("liquidity"),
                "quoteAt": quote_at, "sourceAt": quote_at, "expiresAt": expires_at, "sequence": None,
                "orderBook": {"marketId": market_id, "roundId": round_id, "yes": yes, "no": no,
                              "sequence": None, "sourceAt": quote_at, "expiresAt": expires_at, "stale": True},
                "depthAvailable": False, "strategyEligible": False, "enabled": True,
                "current": isinstance(start, (int, float)) and isinstance(end, (int, float)) and start <= now < end,
                "stale": True, "source": row.get("source") or "collector",
                "error": "accepted_runtime_snapshot_unavailable", "nextRound": False}
    market_id = snapshot.get("marketId") or snapshot.get("market_id")
    market_id = market_id if isinstance(market_id, str) and market_id else None
    round_id = snapshot.get("roundId") or snapshot.get("round_id")
    round_id = round_id if isinstance(round_id, str) and round_id else None
    yes, no = snapshot.get("YES"), snapshot.get("NO")
    yes = dict(yes) if isinstance(yes, dict) else None
    no = dict(no) if isinstance(no, dict) else None
    sequence = snapshot.get("sequence")
    source_at = _epoch(snapshot.get("sourceAt") if snapshot.get("sourceAt") is not None
                       else snapshot.get("source_at"))
    expires_at = _epoch(snapshot.get("expiresAt") if snapshot.get("expiresAt") is not None
                        else snapshot.get("expires_at"))
    complete = (market_id is not None and round_id is not None and yes is not None and no is not None
                and isinstance(yes.get("assetId"), str) and isinstance(no.get("assetId"), str)
                and type(sequence) is int and sequence >= 0 and source_at is not None and expires_at is not None)
    expired = expires_at is None or expires_at <= now
    stale_after = normalize_stale_after_ms(row.get("stale_after_ms", stale_after_ms))
    age_limit = stale_after / 1000 if stale_after is not None else None
    side_times = [_epoch(side.get("sourceAt")) for side in (yes, no)
                  if isinstance(side, dict) and side.get("sourceAt") is not None]
    stale = (not complete or expired or source_at is None or source_at > now + 1
             or row_health_stale
             or row.get("_runtime_stale") is True or row.get("_stale_after_invalid") is True
             or stale_after is None
             or (age_limit is not None and (source_at < now - age_limit
                 or any(value is None or value < now - age_limit or value > now + 1 for value in side_times))))
    quote_times = [_epoch(value.get("sourceAt")) for value in (yes, no) if value]
    quote_times = [value for value in quote_times if value is not None]
    quote_at = min(quote_times, default=source_at)
    yes = yes or {}
    no = no or {}
    depth_available = all(isinstance(side.get(key), list) and len(side[key]) >= 5
                          for side in (yes, no) for key in ("bids", "asks"))
    depth_available = depth_available and not stale and all(
        side.get("depthExpiresAt") is None or (
            _epoch(side["depthExpiresAt"]) is not None and _epoch(side["depthExpiresAt"]) > now)
        for side in (yes, no))
    supported = asset_id in SUPPORTED_ASSET_IDS
    return {
        "assetId": asset_id,
        "symbol": symbol,
        "supported": supported,
        "canEnable": supported,
        "name": str(row.get("name") or slug or (f"{symbol} 五分钟反转" if symbol else "市场")),
        "marketId": market_id,
        "roundId": round_id,
        "market_id": market_id,
        "round_id": round_id,
        "cycle": cycle,
        "startAt": start,
        "endAt": end,
        "yes": yes,
        "no": no,
        "yesToken": yes.get("assetId"),
        "noToken": no.get("assetId"),
        "yesBid": yes.get("bid"),
        "yesAsk": yes.get("ask"),
        "noBid": no.get("bid"),
        "noAsk": no.get("ask"),
        "volume": row.get("volume"),
        "liquidity": row.get("liquidity"),
        "quoteAt": quote_at,
        "sourceAt": source_at,
        "expiresAt": expires_at,
        "sequence": sequence if type(sequence) is int else None,
        "depthAvailable": depth_available,
        "strategyEligible": bool(row.get("source") == "platform-runtime") and supported and complete and not stale,
        "orderBook": {"marketId": market_id, "roundId": round_id, "yes": yes, "no": no,
                      "sequence": sequence if type(sequence) is int else None,
                      "sourceAt": source_at, "expiresAt": expires_at, "stale": stale},
        "enabled": True,
        "current": isinstance(start, (int, float)) and isinstance(end, (int, float)) and start <= now < end,
        "stale": stale,
        "source": row.get("source") or "platform-runtime",
        "error": ("accepted_snapshot_incomplete" if not complete else
                   "market_snapshot_expired" if expired else
                   "market_snapshot_unhealthy" if row_health_stale else None),
        "nextRound": False,
    }


def _modern_markets(query: dict | None = None) -> dict:
    """Merge cached sources per asset, retaining failures as stale evidence."""
    global _modern_market_cache
    runtime = _running_engine_market_status()
    collector = cached_live_status()

    def mapped(raw):
        if not isinstance(raw, dict):
            return []
        rows = raw.get("current_markets") or []
        return [_modern_market({**row, "source": row.get("source") or raw.get("source"),
                                "stale_after_ms": row.get("stale_after_ms", raw.get("stale_after_ms")),
                                "_collector_online": row.get("collector_online", raw.get("collector_online")) is True})
                for row in rows if isinstance(row, dict)]

    runtime_items = mapped(runtime)
    runtime_assets = {item["assetId"] for item in runtime_items if item["assetId"] is not None}
    items = [item for item in mapped(collector) if item["assetId"] not in runtime_assets] + runtime_items
    key = lambda item: (item.get("assetId"), item.get("marketId"), item.get("roundId"))
    def failed(item, error):
        return {**item, "stale": True, "strategyEligible": False, "error": error,
                "orderBook": {**item.get("orderBook", {}), "stale": True}}

    with _modern_cache_lock:
        previous = dict(_modern_market_cache)
        next_cache = {}
        for index, item in enumerate(items):
            old = previous.get(key(item))
            item_source_at, old_source_at = item.get("sourceAt"), old.get("sourceAt") if old else None
            item_sequence, old_sequence = item.get("sequence"), old.get("sequence") if old else None
            regressed = (old is not None and item.get("source") == old.get("source")
                         and ((isinstance(item_source_at, (int, float)) and isinstance(old_source_at, (int, float))
                               and item_source_at < old_source_at)
                              or (type(item_sequence) is int and type(old_sequence) is int
                                  and item_sequence < old_sequence)))
            if old and (item["stale"] or regressed):
                items[index] = failed(old, item.get("error") or "market_snapshot_regressed")
                next_cache[key(old)] = old
            elif not item["stale"]:
                next_cache[key(item)] = item
        seen = {key(item) for item in items}
        replaced_assets = {item["assetId"] for item in items if not item["stale"]}
        for identity, old in previous.items():
            if identity not in seen and old["assetId"] not in replaced_assets:
                items.append(failed(old, "market_snapshot_unavailable"))
                next_cache[identity] = old
        _modern_market_cache = dict(list(next_cache.items())[-128:])
    if query:
        requested = query.get("assetId", [])
        if not requested and query.get("asset") and query.get("asset") != ["crypto"]:
            requested = query.get("asset")
        if requested:
            wanted = {str(value).strip().lower() for value in requested if isinstance(value, str)}
            items = [item for item in items if item.get("assetId") in wanted]
    stale = not items or any(item["stale"] for item in items)
    sources = {item.get("source") for item in items if item.get("source")}
    return {"schemaVersion": 1, "items": items or None, "markets": items or None,
            "source": next(iter(sources)) if len(sources) == 1 else "market-projection",
            "asOf": min((item["sourceAt"] for item in items if item["sourceAt"] is not None), default=None),
            "stale": stale, "partial": bool(items) and stale and any(not item["stale"] for item in items),
            "error": "market_snapshot_stale" if stale else None,
            "collector_online": any(not item["stale"] for item in items), "available": bool(items)}


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
    projection_stale = (projection.get("stale") is True
                        or (projection.get("state") is not None and projection.get("state") != "ready"))
    stale = bool(not runtime or source_at is None or expires_at is None or expires_at <= time.time()
                 or projection_stale)
    stop_result = status.get("stop_result") if isinstance(status.get("stop_result"), dict) else {}
    params = status.get("params") if isinstance(status.get("params"), dict) else {}
    config = params.get("config") if isinstance(params.get("config"), dict) else {}
    asset_id = runtime.get("assetId") or runtime.get("asset_id") or params.get("assetId") \
        or params.get("asset_id") or config.get("assetId") or config.get("asset_id")
    if not isinstance(asset_id, str) or not _ASSET_ID_RE.fullmatch(asset_id.strip().lower()):
        asset_id = None
    else:
        asset_id = asset_id.strip().lower()

    def identity_value(item, *keys):
        if not isinstance(item, dict):
            return None
        for key in keys:
            value = item.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    def identity_view(item):
        return {
            "marketId": identity_value(item, "marketId", "market_id", "id"),
            "roundId": identity_value(item, "roundId", "round_id"),
            "assetId": identity_value(item, "assetId", "asset_id"),
            "name": identity_value(item, "name", "marketSlug", "market_slug"),
        }

    # Runtime market rows are the primary source. Older runtime snapshots can
    # omit one of the identity fields while strategy_runtime has the same
    # explicit market/round identity. Merge only an unambiguous match from
    # that payload; never infer a round from time, slug text, or row order.
    runtime_markets = runtime.get("markets") if isinstance(runtime.get("markets"), list) else []
    strategy_candidates = []
    for candidate in ([strategy_runtime.get("currentRound")] if current_round else []):
        if isinstance(candidate, dict):
            strategy_candidates.append(candidate)
    rounds = strategy_runtime.get("rounds") if isinstance(strategy_runtime.get("rounds"), list) else []
    strategy_candidates.extend(candidate for candidate in rounds if isinstance(candidate, dict))

    candidate_views = [(candidate, identity_view(candidate)) for candidate in strategy_candidates]
    market_rows = []
    seen_rows = set()
    for source in runtime_markets:
        if not isinstance(source, dict):
            continue
        row = dict(source)
        view = identity_view(source)
        matches = []
        for candidate, candidate_view in candidate_views:
            if view["assetId"] and candidate_view["assetId"] and view["assetId"].lower() != candidate_view["assetId"].lower():
                continue
            if view["marketId"]:
                if candidate_view["marketId"] != view["marketId"]:
                    continue
            elif view["name"]:
                if candidate_view["name"] != view["name"]:
                    continue
            else:
                continue
            if view["roundId"] and candidate_view["roundId"] and candidate_view["roundId"] != view["roundId"]:
                continue
            matches.append(candidate_view)
        # A field can be backfilled only when all matching runtime candidates
        # agree. This allows a market id to be known even if its round is
        # ambiguous, while refusing to assign the wrong historical round.
        for field in ("marketId", "roundId"):
            if view[field] is None:
                values = {match[field] for match in matches if match[field] is not None}
                if len(values) == 1:
                    view[field] = values.pop()
        if view["marketId"] and not identity_value(source, "marketId", "market_id"):
            row["marketId"] = view["marketId"]
        if view["roundId"] and not identity_value(source, "roundId", "round_id"):
            row["roundId"] = view["roundId"]
        if view["assetId"] and not identity_value(source, "assetId", "asset_id"):
            row["assetId"] = view["assetId"]
        row_key = (view["assetId"], view["marketId"], view["roundId"], view["name"])
        if row_key not in seen_rows:
            seen_rows.add(row_key)
            market_rows.append(row)

    # If the runtime market list is absent, the explicit strategy round
    # records are still valid read-only runtime identity sources. Do not add
    # historical strategy rows when runtime already supplied its market list.
    if not runtime_markets:
        for candidate, view in candidate_views:
            if not view["marketId"] and not view["roundId"]:
                continue
            row_key = (view["assetId"], view["marketId"], view["roundId"], view["name"])
            if row_key in seen_rows:
                continue
            row = dict(candidate)
            if view["marketId"]:
                row["marketId"] = view["marketId"]
                row.setdefault("id", view["marketId"])
            if view["roundId"]:
                row["roundId"] = view["roundId"]
            if view["assetId"]:
                row["assetId"] = view["assetId"]
            seen_rows.add(row_key)
            market_rows.append(row)

    return {"schemaVersion": 1, "status": state, "state": state,
            "serviceState": status.get("service_state") or state,
            "commandStatus": status.get("command_status") or ("executing" if status.get("running") else "confirmed"),
            # This is the direct local process fact from trading_status(); it
            # is independent from asynchronous ledger projection freshness.
            "processRunning": process_running,
            "remoteOrdersState": stop_result.get("remote_orders_state"),
            "source": "platform-runtime" if runtime else "control-plane",
            "asOf": source_at,
            "stale": stale, "runId": status.get("run_id"),
            "strategyId": status.get("strategy_id") or "btc-reversal", "assetId": asset_id,
            "execution": status.get("execution"), "risk": risk or None, "funds": funds, "markets": [
                {**item, "marketId": item.get("marketId") or item.get("market_id") or item.get("id"),
                 "roundId": item.get("roundId") or item.get("round_id")}
                for item in market_rows],
            "error": runtime.get("error") or projection.get("error")
                or ("ledger_projection_incomplete" if projection_stale else "runtime_snapshot_stale" if stale else None)
                or ((status.get("stop_result") or {}).get("message") if state == "failed" else None),
            "projection": projection}


def _api_run_id() -> str | None:
    _restore_trading_state()
    with _trading_lock:
        run_id = _run_identity()
        # A test or an in-process root switch can leave the previous runtime
        # identity loaded while its journal belongs to another data root.
        # Never let that stale identity make modern read endpoints probe an
        # unrelated or missing ledger projection.
        if run_id and _trading_log is None:
            return None
        if run_id and _trading_log is not None:
            try:
                _trading_log.resolve().relative_to((TRADING_ROOT / "results").resolve())
            except (OSError, RuntimeError, ValueError):
                return None
        return run_id


def _api_ledger() -> Ledger:
    return Ledger(TRADING_ROOT / "results" / "dashboard" / "ledger.sqlite3", readonly=True)


def _current_account_id() -> str | None:
    with _trading_lock:
        account_id = _trading_account_id
    if account_id:
        return account_id.lower()
    wallet = account_config_status().get("wallet")
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
    severity = "error" if kind == "error" else "warning" if kind == "unresolved" else "info"
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
                       "pnl": _money(event.get("pnl"))})
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
                "items": None, "events": None, "cursor": None, "runId": None,
                "source": "ledger", "asOf": None, "stale": True,
                "error": "当前没有运行记录"}
    cursor = query.get("cursor", [None])[0]
    requested_asset = (query.get("assetId") or [None])[0]
    try:
        result = _api_ledger().events(run_id, before_id=int(cursor) if cursor else None,
                                      limit=int(query.get("limit", ["50"])[0]), kinds=kinds,
                                      asset_id=requested_asset,
                                      market_id=(query.get("marketId") or [None])[0],
                                      round_id=(query.get("roundId") or [None])[0])
    except KeyError:
        return {"schemaVersion": 1, "status": "unavailable", "available": False,
                "items": None, "events": None, "cursor": None, "runId": run_id,
                "source": "ledger", "asOf": None, "stale": True,
                "error": "ledger_projection_unavailable"}
    items = [_event_dto(event) for event in result["events"]]
    metadata = _ledger_metadata(run_id)
    return {"schemaVersion": 1, "status": "stale" if metadata["stale"] else "ready",
            "available": True, "items": items, "events": items,
            "cursor": result.get("next_before_id"), "runId": run_id,
            **metadata}


def _modern_settlements(run_id: str | None, query: dict) -> dict:
    if not run_id:
        return {"schemaVersion": 1, "status": "unavailable", "available": False,
                "items": None, "settlements": None, "cursor": None, "runId": None,
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
                "items": None, "settlements": None, "cursor": None, "runId": run_id,
                "source": "ledger", "asOf": None, "stale": True,
                "error": "ledger_projection_unavailable"}
    available = result.get("available", True)
    items = [_event_dto(item) for item in result.get("settlements", [])] if available else None
    metadata = _ledger_metadata(run_id)
    stale = bool(result.get("available") is False) or metadata["stale"]
    return {"schemaVersion": 1, "status": "unavailable" if not available else "stale" if stale else "ready",
            "items": items, "settlements": items,
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
            if path == "/api/bootstrap":
                status = trading_status()
                runtime = _modern_runtime(status)
                self._send_json(json.dumps({
                    "schemaVersion": 1, "app": "polymarket-btc-reversal",
                    "strategyId": "btc-reversal", "assetId": runtime.get("assetId"), "cycle": "5m",
                    "source": "control-plane", "asOf": runtime["asOf"], "stale": runtime["stale"],
                    "error": runtime["error"],
                    "capabilities": ["markets", "runtime", "orders", "positions", "metrics", "events"],
                    "capabilityDetails": {"fills": True, "settlements": True, "strategyDrafts": True,
                        "strategyActivate": True, "activateAtRound": False, "cancelOrder": False,
                        "flatten": False, "editMarketPool": True, "presets": False, "streams": False,
                        "restRefresh": True},
                    "streams": {"available": False, "transport": None,
                        "endpoints": {"markets": None, "runtime": None, "orders": None},
                        "fallbackTransport": "rest",
                        "restEndpoints": {"markets": "/api/markets", "runtime": "/api/runtime/status",
                            "orders": "/api/rounds/{roundId}/orders", "fills": "/api/fills",
                            "settlements": "/api/settlements", "metrics": "/api/metrics/summary",
                            "events": "/api/events"}},
                    "runtime": runtime,
                }, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/markets":
                self._send_json(json.dumps(_modern_markets(query), ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path.startswith("/api/markets/") and path.endswith("/snapshot"):
                market_id = path[len("/api/markets/"):-len("/snapshot")].strip("/")
                catalog = _modern_markets(query)
                requested_round = (query.get("roundId") or [None])[0]
                requested_market = (query.get("marketId") or [None])[0]
                matches = [item for item in (catalog.get("items") or [])
                           if (item.get("marketId") == market_id or
                               (requested_market is None and requested_round is None and item.get("roundId") == market_id))
                           and (requested_round is None or item.get("roundId") == requested_round)
                           and (requested_market is None or item.get("marketId") == requested_market)]
                market = matches[0] if len(matches) == 1 else None
                if market is None:
                    self._send_json(json.dumps({"available": False, "market": None, "error": "market not found",
                                                 "source": catalog["source"], "asOf": catalog["asOf"],
                                                 "stale": catalog["stale"]}).encode("utf-8"), 404)
                    return
                self._send_json(json.dumps({"schemaVersion": 1, **market,
                    "orderBook": market["orderBook"],
                    "source": market["source"], "asOf": market["sourceAt"],
                    "stale": market["stale"], "error": market["error"]},
                    ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/runtime/status":
                status = trading_status()
                self._send_json(json.dumps(_modern_runtime(status), ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/runtime/market-pool":
                self._send_json(json.dumps(_pool_runtime_view(market_pool()), ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/strategy/config":
                config = strategy_config_status()
                draft = strategy_config_store().get_draft()
                if draft:
                    draft = {**draft, "savedAt": _epoch(draft.get("savedAt"))}
                self._send_json(json.dumps({"schemaVersion": 1, "source": "control-plane",
                    "asOf": _epoch(config.get("savedAt")), "stale": False, "error": None,
                    **config, "savedAt": _epoch(config.get("savedAt")), "draft": draft,
                    "activationScope": "future_uncreated_round"}, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/account/snapshot":
                snapshot = account_data().snapshot()
                self._send_json(json.dumps({"source": "account-reader",
                    "asOf": _epoch(snapshot.get("checked_at")),
                    "error": snapshot.get("error_code"), **snapshot},
                    ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/diagnostics/health":
                status = trading_status()
                metrics = system_metrics().snapshot()
                collector = _modern_markets()
                runtime = _modern_runtime(status)
                projection = (status.get("stats") or {}).get("projection") or {}
                problems = []
                if collector["stale"]:
                    problems.append("market_snapshot_stale")
                if runtime["status"] == "failed" or runtime["stale"]:
                    problems.append("trading_runtime_unavailable")
                if status.get("run_id") and (projection.get("stale", True) or projection.get("state") != "ready"):
                    problems.append("ledger_projection_unavailable")
                metric_at = _epoch(metrics.get("asOf"))
                if metric_at is None or not -1 <= time.time() - metric_at <= 15 or metrics.get("stale"):
                    problems.append("resource_snapshot_stale")
                value = {"schemaVersion": 1, "status": "degraded" if problems else "ok",
                         "source": "control-plane", "asOf": _epoch(metrics.get("asOf")),
                         "stale": bool(problems),
                         "services": {"trading": runtime, "collector": collector, "projection": projection},
                         "resources": metrics, "error": "; ".join(problems) if problems else None}
                self._send_json(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                return
            if path == "/api/metrics/summary":
                requested_range = query.get("range", ["today"])[0]
                if requested_range not in {"run", "today", "all"}:
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
                metadata = _ledger_metadata(run_id)
                stale = metadata["stale"] or stats.get("completeness") != "caught_up"
                value = {"schemaVersion": 1, "status": "stale" if stale else "ready",
                         "available": True, **stats, **metadata,
                         "fills": stats.get("fill_count"), "orders": stats.get("order_count"),
                         "wins": stats.get("settled_wins"), "losses": stats.get("settled_losses"),
                         "pnl": stats.get("settled_pnl"),
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
                    self._send_json(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
                except (ValueError, TypeError):
                    self._send_json(b'{"error":"invalid_event_query","stale":true}', 400)
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
            if path == "/api/strategy-config":
                try:
                    self._send_json(json.dumps(strategy_config_status(), ensure_ascii=False).encode("utf-8"))
                except (ValueError, RuntimeError, OSError) as exc:
                    self._send_json(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8"), 503)
                return
            if path.startswith("/api/v1/"):
                self._get_v1(path)
                return
            # There is one user-facing trading page. Keep the former advanced
            # dashboard URL as a compatibility redirect so stale bookmarks do
            # not open a second, disconnected control surface.
            if path in {"/", "/system-dashboard.html", "/system-dashboard-advanced.html", "/demo-trading-console.html"}:
                self.send_response(302)
                self.send_header("Location", "/console/")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if path == "/api/account/status":
                account = account_config_status()
                self._send_json(json.dumps({**account, "schemaVersion": 1,
                    "source": "control-plane", "asOf": account.get("last_check_at"),
                    "stale": account.get("account_check_state") != "ready",
                    "error": account.get("last_check_error"),
                    "control_source": control_source()}, ensure_ascii=False).encode("utf-8"))
                return
            if path == "/api/live":
                self._send_json(json.dumps(cached_live_status(), ensure_ascii=False).encode("utf-8"))
                return
            relative = "console/index.html" if path in {"/console", "/console/"} else path.lstrip("/")
            candidate = (docs / relative).resolve()
            if docs not in candidate.parents or not candidate.is_file():
                self.send_error(404)
                return
            body = candidate.read_bytes()
            content_type = _static_content_type(candidate)
            if candidate.suffix == ".html":
                config = b'<script>window.__POLY_PREVIEW_CONFIG__={mode:"backend",demo:false,apiBase:"",apiFlavor:"contract"};</script>'
                body = body.replace(b"<head>", b"<head>" + config, 1)
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _get_v1(self, path: str) -> None:
            try:
                if path == "/api/v1/status":
                    status = trading_status()
                    value = {"schemaVersion": 1, "asOf": time.time(),
                             **{k: status[k] for k in ("running", "mode", "run_id", "config_revision",
                                   "account_id", "params", "stop_result", "live_unlocked",
                                   "execution_target", "engine", "execution", "strategy_id")},
                             "projection": status["stats"].get("projection"),
                             "stats": status["stats"]}
                elif path == "/api/v1/markets":
                    # During a platform run, expose the same paired WS frame
                    # that drove the strategy. The collector remains the
                    # fallback when the engine has no complete fresh pair.
                    market_status = _running_engine_market_status()
                    if isinstance(market_status, dict) and isinstance(market_status.get("current_markets"), list):
                        # Preserve the old slug-shaped field only in the v1
                        # compatibility response. Modern DTOs stay strict.
                        market_status = {**market_status, "current_markets": [
                            {**row, "round_id": row.get("round_id") or row.get("legacy_round_id") or row.get("name")}
                            for row in market_status["current_markets"] if isinstance(row, dict)]}
                    value = {"schemaVersion": 1, "asOf": time.time(), **(market_status or cached_live_status())}
                elif path == "/api/v1/account-data":
                    value = account_data().snapshot()
                elif path == "/api/v1/system-metrics":
                    value = system_metrics().snapshot()
                elif path == "/api/v1/orders":
                    query = parse_qs(urlsplit(self.path).query)
                    run_id = query.get("run_id", [None])[0]
                    if not run_id or len(run_id) > 200:
                        raise ValueError("请指定运行编号")
                    run_id = _scoped_run_id(run_id)
                    if run_id is None:
                        raise KeyError("Run is not registered")
                    ledger = Ledger(TRADING_ROOT / "results" / "dashboard" / "ledger.sqlite3", readonly=True)
                    stamp = query.get("as_of", [None])[0]
                    cutoff = query.get("snapshot_event_id", [None])[0]
                    value = {"schemaVersion": 1, **ledger.orders_page(run_id,
                             limit=int(query.get("limit", ["10"])[0]),
                             offset=int(query.get("offset", ["0"])[0]),
                             status=query.get("status", [None])[0], market=query.get("market", [None])[0],
                             as_of=float(stamp) if stamp else None,
                             snapshot_event_id=int(cutoff) if cutoff else None)}
                elif path in {"/api/v1/runs", "/api/v1/events", "/api/v1/summary"}:
                    query = parse_qs(urlsplit(self.path).query)
                    if path.endswith("/runs"):
                        account_id = _current_account_id()
                        if not account_id:
                            # A missing account identity must never turn into
                            # an unscoped historical listing.
                            value = {"schemaVersion": 1, "runs": [], "next_before_id": None,
                                     "available": False, "stale": True,
                                     "error": "account_not_configured"}
                        else:
                            ledger = Ledger(TRADING_ROOT / "results" / "dashboard" / "ledger.sqlite3", readonly=True)
                            before_id = query.get("before_id", [None])[0]
                            limit = int(query.get("limit", ["50"])[0])
                            value = {"schemaVersion": 1, **ledger.list_runs_page(
                                before_id=int(before_id) if before_id else None, limit=limit,
                                account_id=account_id)}
                    else:
                        ledger = Ledger(TRADING_ROOT / "results" / "dashboard" / "ledger.sqlite3", readonly=True)
                        run_id = query.get("run_id", [None])[0]
                        if not run_id or len(run_id) > 200:
                            raise ValueError("请指定运行编号")
                        run_id = _scoped_run_id(run_id)
                        if run_id is None:
                            raise KeyError("Run is not registered")
                        if path.endswith("/summary"):
                            value = {"schemaVersion": 1, "summary": ledger.summary(run_id)}
                        else:
                            cursor = query.get("before_id", [None])[0]
                            value = {"schemaVersion": 1, **ledger.events(run_id,
                                     before_id=int(cursor) if cursor else None,
                                     limit=int(query.get("limit", ["50"])[0]))}
                else:
                    self._send_json(b'{"error":"not found"}', 404)
                    return
                if path != "/api/v1/markets":
                    value["control_source"] = control_source()
                self._send_json(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))
            except KeyError:
                self._send_json(b'{"error":"run not found"}', 404)
            except (ValueError, TypeError):
                self._send_json('{"error":"请求参数不正确"}'.encode(), 400)
            except (OSError, sqlite3.Error, RuntimeError):
                self._send_json('{"error":"数据暂不可用，请稍后重试"}'.encode(), 503)

        def _send_json(self, body: bytes, status: int = 200, response_headers: dict[str, str] | None = None) -> None:
            path = self.path.split("?", 1)[0]
            modern = path.startswith("/api/") and not path.startswith(("/api/v1/", "/api/trading/")) and path not in {
                "/api/strategy-config", "/api/live", "/api/account/status", "/api/account/check", "/api/account/save"}
            if modern:
                value = json.loads(body)
                cacheable = self.command == "GET" and (path in {
                    "/api/events", "/api/fills", "/api/settlements", "/api/metrics/summary"} or path.startswith("/api/rounds/"))
                key = (_trading_run_id, self.path)
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

        def do_PUT(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path == "/api/runtime/market-pool":
                self.do_POST()
                return
            if path != "/api/strategy-config":
                self._send_json(b'{"error":"not found"}', 404)
                return
            self.do_POST()

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            modern_order_path = path.startswith("/api/orders/") and path.endswith("/cancel")
            if path not in {"/api/account/check", "/api/account/save", "/api/strategy-config",
                            "/api/trading/control", "/api/trading/auth/session", "/api/runtime/commands",
                            "/api/strategy/drafts", "/api/strategy/activate", "/api/runtime/flatten",
                            "/api/runtime/market-pool"} and not modern_order_path:
                self._send_json(b'{"error":"not found"}', 404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or (length == 0 and not (modern_order_path or path == "/api/runtime/flatten")) or length > 32_000:
                    raise ValueError("请求内容为空或过大")
                raw = self.rfile.read(length)
                payload = json.loads(raw.decode("utf-8") or "{}") if raw else {}
                if not isinstance(payload, dict):
                    raise ValueError("request body must be an object")
                if path in {"/api/runtime/commands", "/api/strategy/drafts", "/api/strategy/activate",
                            "/api/runtime/flatten", "/api/runtime/market-pool"} or modern_order_path:
                    auth_error = _control_request_error(self.headers, "live")
                    if auth_error:
                        code, message = auth_error
                        self._send_json(json.dumps({"accepted": False, "error": message}, ensure_ascii=False).encode("utf-8"), code)
                        return
                if path.startswith("/api/account/"):
                    auth_error = _account_request_error(self.headers)
                    if auth_error:
                        code, message = auth_error
                        self._send_json(json.dumps({"ok": False, "error": message}, ensure_ascii=False).encode("utf-8"), code)
                        return
                    report = account_action(payload, save=path.endswith("/save"))
                    self._send_json(json.dumps({"ok": True, "report": report}, ensure_ascii=False).encode("utf-8"))
                    return
                if path == "/api/trading/auth/session":
                    auth_error = _control_request_error(self.headers, "live", allow_session=False)
                    if auth_error:
                        status, message = auth_error
                        self._send_json(
                            json.dumps({"ok": False, "error": message}, ensure_ascii=False).encode("utf-8"),
                            status,
                        )
                        return
                    supplied_token = _supplied_control_token(self.headers).strip()
                    if not supplied_token:
                        # Basic Auth at the HTTPS proxy is already a valid
                        # control identity.  Do not force the operator to
                        # invent and persist a second token on first deploy.
                        if (os.environ.get("PM_TRUST_ACCOUNT_PROXY") == "1"
                                and self.headers.get("X-PM-Authenticated")
                                and self.headers.get("X-Forwarded-Proto") == "https"):
                            self._send_json(
                                b'{"ok":true,"persistent":false,"proxy_authenticated":true}',
                            )
                            return
                        self._send_json(
                            json.dumps({"ok": False, "error": "请填写交易控制密码"}, ensure_ascii=False).encode("utf-8"),
                            400,
                        )
                        return
                    account_store.save_control_token(supplied_token)
                    configured_token = _control_token()
                    session = _control_cookie_value(configured_token)
                    self._send_json(
                        json.dumps({"ok": True, "expires_in": _control_session_ttl(), "persistent": True}, ensure_ascii=False).encode("utf-8"),
                        response_headers={"Set-Cookie": _control_cookie_header(session, self.headers)},
                    )
                    return
                if path == "/api/runtime/market-pool":
                    self._send_json(json.dumps(_pool_runtime_view(save_market_pool(payload)), ensure_ascii=False,
                                                allow_nan=False).encode("utf-8"))
                    return
                if path == "/api/runtime/commands":
                    action = payload.get("action")
                    translated = {"action": action, "strategy_id": payload.get("strategyId", "btc-reversal"),
                                  "revision": payload.get("revision"), "request_id": payload.get("requestId"),
                                  "asset_id": payload.get("assetId"), "market_ids": payload.get("marketIds")}
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
                        result = strategy_config_store().save_draft(modern_config, expected)
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
                        draft = strategy_config_store().get_draft()
                        if draft:
                            _validate_running_asset(draft["config"])
                        config = strategy_config_store().activate_draft(payload.get("expectedRevision"), payload.get("draftId"))
                    self._send_json(json.dumps({"accepted": True, "strategyId": "btc-reversal",
                        "revision": config["savedRevision"], "savedRevision": config["savedRevision"], "effectiveRoundId": None,
                        "activationScope": "future_uncreated_round", "status": "published",
                        "source": "control-plane", "asOf": time.time(), "stale": False},
                        ensure_ascii=False, allow_nan=False).encode("utf-8"))
                    return
                if path == "/api/runtime/flatten" or modern_order_path:
                    self._send_json(json.dumps({"accepted": False, "status": "unsupported",
                        "source": "control-plane", "asOf": time.time(), "stale": False,
                        "error": "当前运行时只提供账本查询；撤单和清余量由交易运行会话处理"},
                        ensure_ascii=False).encode("utf-8"), 501)
                    return
                mode = payload.get("mode", "live")
                if path == "/api/trading/control":
                    mode = (strategy_config_store().get()["config"]["mode"] if payload.get("action") == "start"
                            else trading_status(include_stats=False).get("mode"))
                auth_error = _control_request_error(self.headers, mode)
                if auth_error:
                    status, message = auth_error
                    self._send_json(
                        json.dumps({"ok": False, "error": message}, ensure_ascii=False).encode("utf-8"),
                        status,
                    )
                    return
                if path == "/api/strategy-config":
                    result = save_strategy_config(payload)
                    self._send_json(json.dumps({"ok": True, **result}, ensure_ascii=False).encode("utf-8"))
                    return
                elif path == "/api/trading/control":
                    result = strategy_control(payload)
                else:
                    raise ValueError("不支持的交易接口")
                self._send_json(json.dumps({"ok": True, "status": result}, ensure_ascii=False).encode("utf-8"))
            except account_store.AccountCheckError as exc:
                self._send_json(json.dumps({"ok": False, "error": str(exc), "error_code": exc.code,
                                            "retryable": exc.retryable}, ensure_ascii=False).encode("utf-8"), exc.http_status)
            except ConfigConflictError as exc:
                self._send_json(json.dumps({"ok": False, "error": str(exc), "current_revision": exc.current_revision}, ensure_ascii=False).encode(), 409)
            except PermissionError as exc:
                self._send_json(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8"), 403)
            except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
                self._send_json(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8"), 400)

        def log_message(self, *_: object) -> None:
            return

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
    collector = threading.Thread(target=refresh_live_background, args=(stop,), daemon=True)
    collector.start()
    threading.Thread(target=supervise_projection, args=(stop,), daemon=True).start()
    threading.Thread(target=account_data().run, args=(stop,), daemon=True).start()
    threading.Thread(target=refresh_system_metrics, args=(stop,), daemon=True).start()
    threading.Thread(target=warm_account_check, name="account-check-startup", daemon=True).start()
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()
        if _read_model:
            _read_model.close()
        if _account_data:
            _account_data.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import argparse
from contextlib import contextmanager
from collections import deque
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
from http.cookies import SimpleCookie
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows development fallback
    fcntl = None

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dashboard_account as account_store
from dashboard.config import ConfigConflictError
from dashboard.strategy_config import StrategyConfigStore, STRATEGY_ID
from dashboard.ledger import Ledger
from dashboard.read_model import ReadModel
from dashboard.market_snapshot import validate_snapshot
from dashboard.account_data import AccountData
from dashboard.system_metrics import SystemMetrics


_SCRIPT_ROOT = Path(__file__).resolve().parents[1]
_REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
_TRADING_ROOT_CANDIDATES = (
    _SCRIPT_ROOT / "_external" / "btc-5m-market-trading-bot",
    _REPOSITORY_ROOT / "backend" / "engine",
    _REPOSITORY_ROOT / "_external" / "btc-5m-market-trading-bot",
)
TRADING_ROOT = next((path for path in _TRADING_ROOT_CANDIDATES if path.is_dir()), _TRADING_ROOT_CANDIDATES[0])
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
    failed = terminal_status == "failed" or (exit_code is not None and exit_code != 0)
    reason = terminal_reason or ("process_failed" if failed else "process_exited")
    message = _AUTOMATIC_STOP_MESSAGES.get(
        reason,
        "交易进程异常退出，请核对运行记录。" if failed else "交易进程已停止，请核对订单与持仓状态。",
    )
    return {"confirmed": False, "process_stopped": True, "automatic": True,
            "exit_code": exit_code, "reason": reason, "message": message}


def _account_values() -> dict[str, str]:
    """Load only supported account fields; never return them through the API."""
    names = {
        "POLYMARKET_WALLET_ADDRESS", "POLY_FUNDER",
        "POLYMARKET_OWNER_PRIVATE_KEY", "POLYMARKET_PRIVATE_KEY",
        "POLYMARKET_SESSION_PRIVATE_KEY", "RELAYER_API_KEY",
        "RELAYER_API_KEY_ADDRESS", "POLY_BUILDER_API_KEY",
        "POLY_BUILDER_SECRET", "POLY_BUILDER_PASSPHRASE",
    }
    profile = account_store.load_profile()
    # A control-only save must not hide an operator's existing environment
    # account bootstrap. Once any account field is present, the profile is
    # authoritative (including explicit empty values used to clear secrets).
    if profile is not None and any(profile.get(name, "") for name in names):
        return {name: profile.get(name, "") for name in names}
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
    return result


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
    return {
        "wallet": wallet_clean if wallet_valid else "",
        "config_error": config_error,
        "last_check": _account_report,
        "wallet_configured": wallet_valid,
        "owner_signer_configured": owner_signer,
        "session_signer_configured": session_signer,
        "relayer_api_configured": present("RELAYER_API_KEY") and present("RELAYER_API_KEY_ADDRESS"),
        "builder_api_configured": builder,
        # The current execution adapter uses the Owner signer. Session Key is
        # an optional delegated signer and is not required for this route.
        "execution_credentials_ready": wallet_valid and owner_signer,
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


def _checked_account_action(payload: dict, save: bool = False) -> dict:
    global _account_report
    # Serialise account changes with start/stop, including the chain check.
    with _trading_lock:
        if trading_status(include_stats=False)["running"]:
            raise ValueError("请先停止交易，再检查或更换账户")
        values = _account_values()
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
        report = account_store.check_account(TRADING_ROOT, values)
        if save:
            if values.get("POLYMARKET_OWNER_PRIVATE_KEY") and not report.get("signer_matches"):
                raise ValueError("签名私钥与资金账户不匹配，未保存")
            if report.get("compromised"):
                raise ValueError("此签名账户有凭据暴露记录，请使用新的安全账户；未保存")
            account_store.save_profile(values)
            # A changed account can never inherit a running process's unlock.
            os.environ.pop("PM_TRADING_LIVE_UNLOCK", None)
        # Candidate checks are not reported as checks of the saved account.
        if save or not payload:
            _account_report = report
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

    configured_token = _control_token()
    token_required = bool(configured_token) or os.environ.get("PM_TRADING_LIVE_UNLOCK") == "1" or mode == "live"
    if not token_required:
        return None
    if not configured_token:
        return 503, "服务器尚未配置交易控制密码"
    if allow_session and _valid_control_session(_request_cookie(headers, _CONTROL_SESSION_COOKIE), configured_token):
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
    """Project the engine's current complete pair into the public market shape.

    While a live platform run is active, the engine's paired WS frame is the
    decision source. The standalone collector can be a few milliseconds behind
    at a five-minute boundary, so using it for the console would show a stale
    wait state while the strategy already has a valid pair. Return ``None``
    unless both sides are present and fresh; callers can then use the normal
    collector snapshot without ever fabricating a quote.
    """
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
    if (not isinstance(runtime, dict) or runtime.get("engine") != "platform"
            or runtime.get("status") != "running" or runtime.get("stale") is True):
        return None
    markets = runtime.get("markets") if isinstance(runtime.get("markets"), list) else []
    books = runtime.get("books") if isinstance(runtime.get("books"), list) else []
    now = time.time()
    book_by_token = {str(book.get("tokenId")): book for book in books
                     if isinstance(book, dict) and book.get("tokenId")}
    rows = []
    for market in markets:
        if not isinstance(market, dict):
            continue
        start, end = market.get("startsAt"), market.get("endsAt")
        if not all(type(value) in (int, float) and math.isfinite(value) for value in (start, end)) or not start <= now < end:
            continue
        instruments = market.get("instruments") if isinstance(market.get("instruments"), list) else []
        by_outcome = {str(item.get("outcome", "")).upper(): item for item in instruments if isinstance(item, dict)}
        up, down = by_outcome.get("UP"), by_outcome.get("DOWN")
        if not isinstance(up, dict) or not isinstance(down, dict):
            continue
        up_book, down_book = book_by_token.get(str(up.get("tokenId"))), book_by_token.get(str(down.get("tokenId")))
        if not isinstance(up_book, dict) or not isinstance(down_book, dict):
            continue
        paired = []
        valid = True
        for book in (up_book, down_book):
            bid, ask = book.get("bid"), book.get("ask")
            received = book.get("receivedAt", book.get("ts"))
            age = book.get("received_age_ms")
            if not all(type(value) in (int, float) and math.isfinite(value) for value in (bid, ask, received)):
                valid = False
                break
            if not 0 < bid <= ask < 1 or (type(age) not in (int, float) or not math.isfinite(age) or age > 2_000):
                valid = False
                break
            paired.append((bid, ask, received))
        if not valid:
            continue
        quote_at = max(pair[2] for pair in paired)
        rows.append({"slug": str(market.get("id")), "name": str(market.get("name", market.get("id"))),
                     "start": start, "end": end, "up_token": str(up.get("tokenId")),
                     "down_token": str(down.get("tokenId")), "up_bid": paired[0][0], "up_ask": paired[0][1],
                     "down_bid": paired[1][0], "down_ask": paired[1][1], "ask_sum": paired[0][1] + paired[1][1],
                     "quote_at": datetime.fromtimestamp(quote_at, timezone.utc).isoformat(),
                     "source": "platform-runtime"})
    if not rows:
        return None
    return {"collector_online": True, "collector_connected": True, "current_markets": rows,
            "cache_age_seconds": max(0, now - max(datetime.fromisoformat(row["quote_at"]).timestamp() for row in rows)),
            "checked_at": datetime.now(timezone.utc).isoformat(), "source": "platform-runtime",
            "stale_reason": None, "node_label": _live_config()["node_label"]}


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
        account = account_config_status()
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
            "account_configured": account["execution_credentials_ready"],
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
            } or (_trading_exit_code is not None and _trading_exit_code != 0) else "stopped")
            runtime["stale"] = True
            stats = {**stats, "runtime": runtime}
        status["stats"] = stats
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
    return {**saved, "activeRevision": active,
            "nextRoundRevision": saved["savedRevision"] if status.get("running") and active != saved["savedRevision"] else None}


def save_strategy_config(payload: dict) -> dict:
    if set(payload) - {"strategyId", "expectedRevision", "config"} or not {"expectedRevision", "config"} <= set(payload):
        raise ValueError("请提交策略参数和当前版本")
    if payload.get("strategyId", STRATEGY_ID) != STRATEGY_ID:
        raise ValueError("策略不存在")
    with _config_control_lock:
        strategy_config_store().save(payload["config"], payload["expectedRevision"])
        return strategy_config_status()


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
            return {**status, "control_requested": action, "control_pending": True}
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
        if request_id == _trading_request_id:
            if payload["revision"] != _trading_config_revision:
                raise ValueError("同一启动请求不能改变配置版本")
            return trading_status(include_stats=False)
        saved = strategy_config_store().get()
        if payload["revision"] != saved["savedRevision"]:
            raise ConfigConflictError(saved["savedRevision"])
        if not saved["savedRevision"]:
            raise ValueError("请先保存策略参数")
        config = saved["config"]
        return start_trading({"mode": config["mode"], "confirm_live": True,
                              "duration_min": config["durationMinutes"]},
                             config_revision=saved["savedRevision"], request_id=request_id,
                             strategy_config=saved)


def _start_trading(payload: dict, *, config_revision: int | None = None, request_id: str | None = None,
                  strategy_config: dict | None = None) -> dict:
    global _trading_process, _trading_pid, _trading_started_at, _trading_mode, _trading_params
    global _trading_log, _trading_console_log, _trading_exit_code, _trading_stop_result
    global _trading_run_id, _trading_config_revision, _trading_account_id, _trading_request_id
    global _trading_engine
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
        if not private_key_configured():
            raise PermissionError("未配置交易账户")
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
        _restore_trading_state()
        if _trading_process is None and _process_matches(_trading_pid, _trading_log):
            raise RuntimeError("已有交易进程运行中")
        if _trading_process is not None and _trading_process.poll() is None:
            raise RuntimeError("已有交易进程运行中")
        if mode == "live":
            if os.environ.get("PM_TRADING_LIVE_UNLOCK") != "1" or not private_key_configured():
                raise PermissionError("账户配置或实盘授权已变化，请重新检查")
            # The engine performs the authoritative current-account read when
            # it connects. Running the full dashboard chain/RPC check here
            # duplicated that work and blocked startup on historical finance
            # scans; a failed engine bootstrap is reported by its own status.
        log_dir = TRADING_ROOT / "results" / "live"
        log_dir.mkdir(parents=True, exist_ok=True)
        run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:12]
        candidate_log = log_dir / f"dashboard-{run_id}.jsonl"
        candidate_console_log = log_dir / f"dashboard-{run_id}.console.log"
        candidate_state = log_dir / f"dashboard-{run_id}.platform-state.json"
        account_id = (account_config_status().get("wallet") or None) if mode == "live" else None
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
            args.extend(["--strategy", STRATEGY_ID, "--strategy-config", str(strategy_config_store().path),
                         "--control-file", str(candidate_log.with_suffix(".control.json"))])
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
                               "duration_min": duration_min, "config": strategy_config["config"]}
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
    # Pin the exact checked wallet; blank also prevents dotenv restoring overrides.
    env["POLY_FUNDER"] = env.get("POLYMARKET_WALLET_ADDRESS") or env.get("POLY_FUNDER", "")
    env["POLY_SIGNATURE_TYPE"] = ""
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
            _trading_stop_result = {
                "confirmed": False,
                "process_stopped": True,
                "message": "当前没有正在运行的交易任务。",
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
        confirmed = False
        if not stopped:
            message = "已请求停止，正在等待撤单及成交对账完成；后台进程保留，请稍后核对。"
        else:
            message = "进程已停止；实盘挂单尚未通过账户查询确认。"
        _trading_stop_result = {"confirmed": confirmed, "process_stopped": stopped, "message": message}
        if stop_requested:
            _trading_stop_result["requested_pid"] = candidate_pid
        if stopped:
            _trading_process = None
            _trading_pid = None
        _persist_trading_state()
        return trading_status(include_stats=False)


def make_handler(root: Path):
    frontend_root = root / "frontend" / "console"
    generated_docs = root / "docs"
    docs = frontend_root if frontend_root.is_dir() else generated_docs
    generated_console = (docs / "console").is_dir()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
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
                self._send_json(json.dumps({**account_config_status(), "control_source": control_source()}, ensure_ascii=False).encode("utf-8"))
                return
            if path == "/api/live":
                self._send_json(json.dumps(cached_live_status(), ensure_ascii=False).encode("utf-8"))
                return
            if path in {"/console", "/console/"}:
                relative = "console/index.html" if generated_console else "index.html"
            elif path.startswith("/console/") and not generated_console:
                relative = path.removeprefix("/console/")
            else:
                relative = path.lstrip("/")
            candidate = (docs / relative).resolve()
            if docs not in candidate.parents or not candidate.is_file():
                self.send_error(404)
                return
            body = candidate.read_bytes()
            content_type = _static_content_type(candidate)
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
                    ledger = Ledger(TRADING_ROOT / "results" / "dashboard" / "ledger.sqlite3", readonly=True)
                    query = parse_qs(urlsplit(self.path).query)
                    if path.endswith("/runs"):
                        before_id = query.get("before_id", [None])[0]
                        limit = int(query.get("limit", ["50"])[0])
                        value = {"schemaVersion": 1, **ledger.list_runs_page(
                            before_id=int(before_id) if before_id else None, limit=limit)}
                    else:
                        run_id = query.get("run_id", [None])[0]
                        if not run_id or len(run_id) > 200:
                            raise ValueError("请指定运行编号")
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
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            for name, value in (response_headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_PUT(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] != "/api/strategy-config":
                self._send_json(b'{"error":"not found"}', 404)
                return
            self.do_POST()

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path not in {"/api/account/check", "/api/account/save", "/api/strategy-config",
                            "/api/trading/control", "/api/trading/auth/session"}:
                self._send_json(b'{"error":"not found"}', 404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > 32_000:
                    raise ValueError("请求内容为空或过大")
                raw = self.rfile.read(length)
                payload = json.loads(raw.decode("utf-8") or "{}") if raw else {}
                if not isinstance(payload, dict):
                    raise ValueError("request body must be an object")
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
                    auth_error = _control_request_error(self.headers, "live")
                    if auth_error:
                        status, message = auth_error
                        self._send_json(
                            json.dumps({"ok": False, "error": message}, ensure_ascii=False).encode("utf-8"),
                            status,
                        )
                        return
                    supplied_token = _supplied_control_token(self.headers).strip()
                    if not supplied_token:
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
    default_root = (_REPOSITORY_ROOT if (_REPOSITORY_ROOT / "frontend" / "console").is_dir()
                    else Path(__file__).resolve().parents[1])
    parser.add_argument("--root", default=str(default_root))
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

from __future__ import annotations

import argparse
from collections import deque
import hmac
import hashlib
import json
import math
import os
import signal
import shlex
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dashboard_account as account_store
from dashboard.config import ConfigStore, ConfigConflictError
from dashboard.ledger import Ledger
from dashboard.read_model import ReadModel
from dashboard.market_snapshot import MarketSnapshot, publish_snapshot, validate_snapshot
from dashboard.account_data import AccountData


TRADING_ROOT = Path(__file__).resolve().parents[1] / "_external" / "btc-5m-market-trading-bot"
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
_market_projection: MarketSnapshot | None = None
_market_projection_config: tuple | None = None
_account_report: dict | None = None
_account_data: AccountData | None = None
_account_data_lock = threading.Lock()
_read_model: ReadModel | None = None
_config_store: ConfigStore | None = None
_config_control_lock = threading.RLock()
_read_model_init_lock = threading.Lock()
_trading_run_id: str | None = None
_trading_config_revision: int | None = None
_trading_account_id: str | None = None
_trading_request_id: str | None = None
_projection_pending: deque = deque()

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
    local_data_dir = Path(
        os.environ.get(
            "PM_LIVE_DATA_DIR",
            str(project_root / "data" / "pm-r25-live" / "days"),
        )
    )
    local_setting = os.environ.get("PM_LIVE_LOCAL", "")
    collector_is_local = local_setting == "1" if local_setting else local_data_dir.is_dir()
    return {
        "node_label": os.environ.get("PM_NODE_LABEL", "都柏林节点"),
        "local_data_dir": local_data_dir,
        "collector_is_local": collector_is_local,
        "remote_data_dir": os.environ.get(
            "PM_REMOTE_DATA_DIR", "/root/pm-system/data/pm-r25-live/days"
        ),
        "evidence_glob": os.environ.get("PM_EVIDENCE_GLOB", "dublin-evidence-*.sqlite3"),
        "collector_service": os.environ.get(
            "PM_COLLECTOR_SERVICE", "pm-r25-dublin-collector.service"
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
        "remote_python": os.environ.get("PM_REMOTE_PYTHON", "python3"),
        "snapshot_path": Path(os.environ.get("PM_MARKET_SNAPSHOT_PATH", str(project_root / "data" / "dashboard" / "market-snapshot.json"))),
        "remote_snapshot_path": os.environ.get("PM_REMOTE_SNAPSHOT_PATH", "/root/pm-system/data/dashboard/market-snapshot.json"),
    }


def _state_path() -> Path:
    return TRADING_ROOT / "results" / "dashboard-state.json"


def control_source() -> dict:
    """Market data may be remote; account/config/control always belong here."""
    local = _live_config()["collector_is_local"]
    return {"scope": "collector_host" if local else "local_preview",
            "label": _live_config()["node_label"] if local else "本机预览服务",
            "market_node": _live_config()["node_label"]}


def account_data() -> AccountData:
    global _account_data
    with _account_data_lock:
        if _account_data is None:
            _account_data = AccountData(TRADING_ROOT, _account_values)
        return _account_data


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
            return proc_cmdline.read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return ""
    if os.name == "nt":
        try:
            completed = subprocess.run(
                [
                    "powershell", "-NoProfile", "-NonInteractive", "-Command",
                    f"(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").CommandLine",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return completed.stdout.strip() if completed.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            return ""
    return ""


def _process_matches(pid: int | None, log_path: Path | None) -> bool:
    if not pid or pid <= 0:
        return False
    command = _process_command(pid)
    if "dist/cli/live.js" not in command.replace("\\", "/"):
        return False
    return log_path is None or log_path.name in command


def _restore_trading_state() -> None:
    with _trading_lock:
        _restore_trading_state_locked()


def _restore_trading_state_locked() -> None:
    global _trading_pid, _trading_started_at, _trading_mode, _trading_params
    global _trading_log, _trading_console_log, _trading_exit_code
    global _trading_stop_result, _trading_state_loaded
    global _trading_run_id, _trading_config_revision, _trading_account_id, _trading_request_id
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
    _trading_mode = state.get("mode") if state.get("mode") in {"paper", "live"} else None
    _trading_params = state.get("params") if isinstance(state.get("params"), dict) else None
    _trading_exit_code = state.get("exit_code") if isinstance(state.get("exit_code"), int) else None
    _trading_stop_result = state.get("stop_result") if isinstance(state.get("stop_result"), dict) else None
    _trading_run_id = state.get("run_id") if isinstance(state.get("run_id"), str) else None
    _trading_config_revision = state.get("config_revision") if type(state.get("config_revision")) is int else None
    _trading_account_id = state.get("account_id") if isinstance(state.get("account_id"), str) else None
    _trading_request_id = state.get("request_id") if isinstance(state.get("request_id"), str) else None
    candidate_pid = state.get("pid") if isinstance(state.get("pid"), int) else None
    _trading_pid = candidate_pid if _process_matches(candidate_pid, _trading_log) else None


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
    if profile is not None:
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
            values = account_store.candidate_profile(payload, values)
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


def _control_request_error(headers, mode: str | None) -> tuple[int, str] | None:
    """Validate browser origin and the optional deployment control password."""
    content_type = (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return 415, "请求格式必须是 JSON"

    origin = headers.get("Origin")
    host = headers.get("Host")
    if origin:
        parsed = urlsplit(origin)
        if parsed.scheme not in {"http", "https"} or not host or parsed.netloc != host:
            return 403, "请求来源不允许"

    configured_token = os.environ.get("PM_DASHBOARD_CONTROL_TOKEN", "").strip()
    token_required = bool(configured_token) or os.environ.get("PM_TRADING_LIVE_UNLOCK") == "1" or mode == "live"
    if not token_required:
        return None
    if not configured_token:
        return 503, "服务器尚未配置交易控制密码"
    authorization = headers.get("Authorization") or ""
    supplied_token = headers.get("X-PM-Control-Token", "") or (authorization[7:].strip() if authorization.startswith("Bearer ") else "")
    if not supplied_token or not hmac.compare_digest(supplied_token, configured_token):
        return 401, "交易控制密码错误"
    return None


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
    """Background-only incremental local projection or remote snapshot read."""
    global _live_cache, _live_cache_at, _market_projection, _market_projection_config
    config = _live_config()
    with _live_lock:
        if time.monotonic() - _live_cache_at < 1:
            return {**validate_snapshot(_live_cache), "node_label": config["node_label"]}
    try:
        if config["collector_is_local"]:
            identity = (str(config["local_data_dir"]), config["evidence_glob"], config["collector_service"], config["node_label"])
            if _market_projection is None or _market_projection_config != identity:
                _market_projection = MarketSnapshot(config["local_data_dir"], config["evidence_glob"], config["collector_service"], config["node_label"])
                _market_projection_config = identity
            value = _market_projection.snapshot()
            publish_snapshot(config["snapshot_path"], value)
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
        if config["collector_is_local"]:
            try:
                publish_snapshot(config["snapshot_path"], value)
            except OSError:
                pass  # Readers will reject the previous file by its source clock.
    with _live_lock:
        _live_cache, _live_cache_at = value, time.monotonic()
        return dict(value)


def trading_status(include_stats: bool = True) -> dict:
    global _trading_process, _trading_pid, _trading_exit_code
    _restore_trading_state()
    with _trading_lock:
        process = _trading_process
        if process is not None:
            _trading_exit_code = process.poll()
            if _trading_exit_code is not None:
                _trading_process = None
                _trading_pid = None
                _persist_trading_state()
        running = (process is not None and process.poll() is None) or _process_matches(_trading_pid, _trading_log)
        account = account_config_status()
        status = {
            "available": (TRADING_ROOT / "dist" / "cli" / "live.js").is_file(),
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
        status["stats"] = trade_log_stats(selection)
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
    if _trading_log:
        # Legacy journals have no trustworthy account/config metadata.
        return "legacy-" + hashlib.sha256(str(_trading_log.resolve()).encode()).hexdigest()[:24]
    return None


def _projection_snapshot(selection: tuple | None = None) -> dict:
    # Snapshot the selection once so a concurrent new run cannot mix fields.
    if selection is None:
        with _trading_lock:
            selection = (_run_identity(), _trading_log, _trading_mode, _trading_account_id, _trading_config_revision)
    run_id, path, mode, account, revision = selection
    if not path or not run_id or mode not in {"paper", "live"}:
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
    if not path or mode not in {"paper", "live"}:
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
    return {**stats, "projection": {k: view.get(k) for k in
             ("state", "run_id", "as_of", "age_seconds", "stale", "worker_alive", "projection_ms")},
            "pending": bool(stats.get("pending") or view.get("ingestion", {}).get("pending"))}


def config_store() -> ConfigStore:
    global _config_store
    if _config_store is None:
        _config_store = ConfigStore(TRADING_ROOT / "results" / "dashboard" / "config.json")
    return _config_store


def save_config(payload: dict) -> dict:
    if set(payload) != {"params", "expected_revision"}:
        raise ValueError("请提交参数与预期配置版本")
    with _config_control_lock:
        return config_store().save(payload["params"], payload["expected_revision"])


def start_configured_paper(payload: dict) -> dict:
    global _trading_config_revision, _trading_request_id
    if set(payload) != {"revision", "request_id"} or type(payload["revision"]) is not int:
        raise ValueError("启动需要配置版本与唯一请求编号")
    try:
        request_id = str(uuid.UUID(payload["request_id"]))
    except (ValueError, TypeError, AttributeError):
        raise ValueError("请求编号必须是 UUID") from None
    with _config_control_lock, _trading_lock:
        _restore_trading_state()
        if request_id == _trading_request_id:
            if payload["revision"] != _trading_config_revision:
                raise ValueError("同一启动请求不能改变配置版本")
            return trading_status(include_stats=False)
        saved = config_store().get()
        if payload["revision"] != saved["revision"]:
            raise ConfigConflictError(saved["revision"])
        if saved["revision"] == 0:
            raise ValueError("请先保存配置")
        if saved["params"]["mode"] != "paper":
            raise PermissionError("新版配置启动目前仅验收模拟模式")
        return start_trading(saved["params"], config_revision=saved["revision"], request_id=request_id)


def start_trading(payload: dict, *, config_revision: int | None = None, request_id: str | None = None) -> dict:
    global _trading_process, _trading_pid, _trading_started_at, _trading_mode, _trading_params
    global _trading_log, _trading_console_log, _trading_exit_code, _trading_stop_result
    global _trading_run_id, _trading_config_revision, _trading_account_id, _trading_request_id
    mode = str(payload.get("mode") or "paper").lower()
    if mode not in {"paper", "live"}:
        raise ValueError("mode must be paper or live")
    if not TRADING_ROOT.is_dir() or not (TRADING_ROOT / "dist" / "cli" / "live.js").is_file():
        raise RuntimeError("交易引擎尚未构建")
    if mode == "live":
        if payload.get("confirm_live") is not True:
            raise PermissionError("实盘必须明确确认")
        if os.environ.get("PM_TRADING_LIVE_UNLOCK") != "1":
            raise PermissionError("服务器未开启实盘解锁")
        if not private_key_configured():
            raise PermissionError("未配置交易账户")
    def positive(name: str, default: float, minimum: float) -> float:
        raw_value = payload.get(name, default)
        if type(raw_value) not in {int, float}:
            raise ValueError(f"{name} must be a finite JSON number")
        try:
            value = float(raw_value)
        except OverflowError:
            raise ValueError(f"{name} must be a finite JSON number") from None
        if not math.isfinite(value) or value < minimum:
            raise ValueError(f"{name} must be >= {minimum}")
        return value
    order_usd = positive("order_usd", 2, 0.01)
    pair_cost_max = positive("pair_cost_max", 0.99, 0.90)
    if pair_cost_max > 1.0:
        raise ValueError("pair_cost_max 必须在 0.90 到 1.00 之间")
    max_orders_value = positive("max_orders", 50, 1)
    if not max_orders_value.is_integer():
        raise ValueError("max_orders 必须是整数")
    max_orders = int(max_orders_value)
    max_total_usd = positive("max_total_usd", 10 if mode == "live" else 100, 0.01)
    # 运行时间允许填 0，表示不按时间自动停止，直到用户手动停止。
    duration_min = positive("duration_min", 15 if mode == "live" else 5, 0)
    if not math.isfinite(duration_min) or duration_min < 0 or (duration_min != 0 and duration_min < 0.1):
        raise ValueError("duration_min 必须为 0（一直运行）或至少 0.1 分钟")
    maker_life_sec = positive("maker_life_sec", 15, 1)
    decision_interval_ms = positive("decision_interval_ms", 0, 0)
    defensive_cancel_bps = positive("defensive_cancel_bps", 0, 0)
    if max_total_usd > 100000 or order_usd > 1000 or max_orders > 10000 or duration_min > 1440 or maker_life_sec > 300 or decision_interval_ms > 60000 or defensive_cancel_bps > 1000:
        raise ValueError("参数超过安全上限")
    with _trading_lock:
        _restore_trading_state()
        if _trading_process is None and _process_matches(_trading_pid, _trading_log):
            raise RuntimeError("已有交易进程运行中")
        if _trading_process is not None and _trading_process.poll() is None:
            raise RuntimeError("已有交易进程运行中")
        if mode == "live":
            if os.environ.get("PM_TRADING_LIVE_UNLOCK") != "1" or not private_key_configured():
                raise PermissionError("账户配置或实盘授权已变化，请重新检查")
            report = account_action({})
            if not report.get("account_ready"):
                raise PermissionError("账户检查未通过，请在“账户”查看未完成项")
        log_dir = TRADING_ROOT / "results" / ("live" if mode == "live" else "paper")
        log_dir.mkdir(parents=True, exist_ok=True)
        run_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:12]
        candidate_log = log_dir / f"dashboard-{run_id}.jsonl"
        candidate_console_log = log_dir / f"dashboard-{run_id}.console.log"
        # Create the selected journal before returning the start response.
        # The status endpoint must never fall back to a previous run while the
        # child process is still starting.
        candidate_log.touch()
        console_handle = candidate_console_log.open("a", encoding="utf-8")
        args = [
            "node", "dist/cli/live.js", "run", "--paper" if mode == "paper" else "--live",
            "--order-usd", str(order_usd), "--max-orders", str(max_orders), "--pair-cost-max", str(pair_cost_max),
            "--max-total-usd", str(max_total_usd), "--duration-min", str(duration_min),
            "--maker-life-sec", str(maker_life_sec), "--decision-interval-ms", str(decision_interval_ms),
            "--defensive-cancel-bps", str(defensive_cancel_bps),
            "--log-file", str(candidate_log), "--traded-file", str(log_dir / "traded.jsonl"),
        ]
        env = _trading_environment()
        account_id = account_config_status().get("wallet") or None
        env["LIVE"] = "false" if mode == "paper" else "true"
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
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
        _trading_config_revision = config_revision
        _trading_request_id = request_id
        _trading_account_id = account_id
        _trading_params = {
            "mode": mode, "pair_cost_max": pair_cost_max, "order_usd": order_usd,
            "max_total_usd": max_total_usd, "max_orders": max_orders,
            "duration_min": duration_min, "maker_life_sec": maker_life_sec,
            "decision_interval_ms": decision_interval_ms,
            "defensive_cancel_bps": defensive_cancel_bps,
        }
        _trading_exit_code = None
        _trading_stop_result = None
        _persist_trading_state()
        _projection_pending.append((_trading_run_id, _trading_log, _trading_mode, _trading_account_id, _trading_config_revision))
        return trading_status(include_stats=False)


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
        # Paper mode has no remote orders; live mode needs an account query.
        confirmed = stopped and _trading_mode == "paper"
        if not stopped:
            message = ("已请求停止，正在等待撤单及成交对账完成；后台进程保留，请稍后核对。"
                       if _trading_mode == "live" else "停止未完成，请检查后台进程。")
        elif _trading_mode == "live":
            message = "进程已停止；实盘挂单尚未通过账户查询确认。"
        else:
            message = "模拟已停止，没有真实挂单。"
        _trading_stop_result = {"confirmed": confirmed, "process_stopped": stopped, "message": message}
        if stop_requested:
            _trading_stop_result["requested_pid"] = candidate_pid
        if stopped:
            _trading_process = None
            _trading_pid = None
        _persist_trading_state()
        return trading_status(include_stats=False)


def make_handler(root: Path):
    docs = root / "docs"

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path.startswith("/api/v1/"):
                self._get_v1(path)
                return
            # There is one user-facing trading page. Keep the former advanced
            # dashboard URL as a compatibility redirect so stale bookmarks do
            # not open a second, disconnected control surface.
            if path == "/system-dashboard-advanced.html":
                self.send_response(302)
                self.send_header("Location", "/system-dashboard.html")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            if path == "/api/trading/status":
                body = json.dumps(trading_status(), ensure_ascii=False).encode("utf-8")
                self._send_json(body)
                return
            if path == "/api/account/status":
                self._send_json(json.dumps({**account_config_status(), "control_source": control_source()}, ensure_ascii=False).encode("utf-8"))
                return
            if path == "/api/trading/log":
                status = trading_status()
                log_path = Path(status["log"]) if status.get("log") else None
                console_path = _trading_console_log
                lines: list[str] = []
                if log_path and log_path.is_file():
                    lines = _tail_lines(log_path)
                console_lines: list[str] = []
                if console_path and console_path.is_file():
                    console_lines = _tail_lines(console_path)
                self._send_json(json.dumps({"log": lines, "console": console_lines, "status": status}, ensure_ascii=False).encode("utf-8"))
                return
            if path == "/api/live":
                self._send_json(json.dumps(cached_live_status(), ensure_ascii=False).encode("utf-8"))
                return
            relative = "system-dashboard.html" if path in {"/", "/system-dashboard.html"} else (
                "console/index.html" if path in {"/console", "/console/"} else path.lstrip("/")
            )
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
                if path == "/api/v1/config":
                    with _config_control_lock:
                        value = config_store().get()
                elif path == "/api/v1/status":
                    status = trading_status()
                    value = {"schemaVersion": 1, "asOf": time.time(),
                             **{k: status[k] for k in ("running", "mode", "run_id", "config_revision",
                                   "account_id", "params", "stop_result", "live_unlocked")},
                             "projection": status["stats"].get("projection"),
                             "stats": status["stats"]}
                elif path == "/api/v1/markets":
                    value = {"schemaVersion": 1, "asOf": time.time(), **cached_live_status()}
                elif path == "/api/v1/account-data":
                    value = account_data().snapshot()
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

        def _send_json(self, body: bytes, status: int = 200) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path not in {"/api/trading/start", "/api/trading/stop", "/api/account/check", "/api/account/save",
                            "/api/v1/config", "/api/v1/trading/start", "/api/v1/trading/stop"}:
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
                mode = trading_status(include_stats=False).get("mode") if path.endswith("/stop") else payload.get("mode", "paper")
                auth_error = _control_request_error(self.headers, mode)
                if auth_error:
                    status, message = auth_error
                    self._send_json(
                        json.dumps({"ok": False, "error": message}, ensure_ascii=False).encode("utf-8"),
                        status,
                    )
                    return
                if path == "/api/v1/config":
                    result = save_config(payload)
                elif path == "/api/v1/trading/start":
                    result = start_configured_paper(payload)
                else:
                    result = stop_trading() if path.endswith("/stop") else start_trading(payload)
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
    server = ThreadingHTTPServer((args.host, args.port), make_handler(Path(args.root).resolve()))
    stop = threading.Event()
    collector = threading.Thread(target=refresh_live_background, args=(stop,), daemon=True)
    collector.start()
    threading.Thread(target=supervise_projection, args=(stop,), daemon=True).start()
    threading.Thread(target=account_data().run, args=(stop,), daemon=True).start()
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

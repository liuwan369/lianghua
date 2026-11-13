from __future__ import annotations

import argparse
from contextlib import contextmanager
from collections import deque, OrderedDict
import hashlib
import io
import json
import math
import os
import shutil
import signal
import shlex
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
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
from dashboard.strategy_config import StrategyConfigStore, STRATEGY_ID, ASSET_ID
from dashboard.ledger import Ledger, LEAD_RANGES, _range_start
from dashboard.read_model import ReadModel
from dashboard.account_data import AccountData
from dashboard.push import PushHub
from dashboard import official_pnl
from dashboard.system_metrics import SystemMetrics


_REPO_ENGINE = Path(__file__).resolve().parents[2] / "engine"
_DEPLOYED_ENGINE = Path(__file__).resolve().parents[1] / "backend" / "engine"
TRADING_ROOT = next((path for path in (_DEPLOYED_ENGINE, _REPO_ENGINE)
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
_official_cache: tuple = (None, None)   # (account checked marker, round results)
_official_last_good: tuple | None = None   # (round results, time) of the last complete venue read
_ACCOUNT_HISTORY_SECTIONS = frozenset({"trades", "activity", "closed_positions", "order_history", "fees", "rewards", "reconciliation"})
_account_report: dict | None = None
_account_report_identity: str | None = None
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
_modern_response_cache: OrderedDict = OrderedDict()
# Account checks are read-only RPC probes. Refresh before the 15-minute
# readiness window expires so a long-running dashboard does not become stale.
_ACCOUNT_CHECK_REFRESH_SECONDS = 10 * 60


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


def _state_path() -> Path:
    return TRADING_ROOT / "results" / "dashboard-state.json"


def account_data() -> AccountData:
    global _account_data
    with _account_data_lock:
        if _account_data is None:
            _account_data = AccountData(TRADING_ROOT, _account_values)
        return _account_data


_fill_watermark: tuple | None = None
_fill_watermark_lock = threading.Lock()


def _note_fill_watermark(value: dict) -> None:
    """Invalidate the cached account snapshot when a newer fill appears.

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
        # fill, and invalidating there would cost a wallet read on every restart.
        if first_seen:
            return
        reader = _account_data
        if reader is not None:
            reader.invalidate()
    except Exception:
        return


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
    bridge = getattr(_account_data, "_process", None) if _account_data else None
    bridge_running = bool(bridge and bridge.poll() is None)
    with _read_model_init_lock:
        projection_process = getattr(_read_model, "_process", None) if _read_model else None
        projection_pid = getattr(projection_process, "pid", None)
        projection_running = bool(projection_process and projection_process.poll() is None)
    return {
        "dashboard": {"pid": os.getpid(), "state": "active"},
        "account_bridge": {"pid": bridge.pid if bridge_running else None, "state": "active" if bridge_running else "stopped"},
        "trader": {"pid": trader_pid if trader_running else None, "state": "active" if trader_running else "stopped"},
        "projection": {"pid": projection_pid if projection_running else None, "state": "active" if projection_running else "stopped"},
        "journal_backlog": len(_projection_pending),
        "event_loop_lag_ms": None,
    }


def system_metrics() -> SystemMetrics:
    global _system_metrics
    with _system_metrics_lock:
        if _system_metrics is None:
            _system_metrics = SystemMetrics(Path(__file__).resolve().parents[1], _metric_services)
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


def _engine_process_present() -> bool | None:
    """True if any trading engine process exists, None when that cannot be determined.

    `_process_matches` answers "is THIS pid still our run", and returns False
    whenever the persisted state was lost — which must never be read as "nothing
    is running" before a destructive action. This asks the OS instead.
    """
    try:
        listing = subprocess.run(["ps", "-eo", "args="], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if listing.returncode != 0:
        return None
    target = "dist/cli/platform.js"
    return any(target in line.replace("\\", "/") for line in listing.stdout.splitlines())


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
    if candidate_pid and _trading_pid is None and (not _trading_stop_result or _trading_stop_result.get("process_stopped") is False):
        # The engine died with the control plane (systemd stops the whole
        # unit). Without a stop result the run stayed "executing" forever and
        # nothing said why (BUGS P3-7). Record what happened instead.
        outcome = _automatic_stop_result(_trading_exit_code, _trading_console_log)
        # Relabel only a run that left no terminal status: a normal finish or a
        # reported failure keeps the engine's own reason (review).
        if not _console_terminal_status(_trading_console_log):
            outcome = {**outcome, "reason": "control_plane_restarted",
                       "message": "控制面重启时交易进程一起停止了；远端挂单以账户快照为准，请核对。"}
        _trading_stop_result = outcome
        _persist_trading_state()
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
    "round_limit_reached": "交易进程已按设定场数运行完毕，自动停止。",
    "timer_event_failed": "交易进程因定时任务异常停止。",
    "status_failed": "交易进程因状态上报异常停止。",
    "control_plane_restarted": "控制面重启时交易进程一起停止了；远端挂单以账户快照为准，请核对。",
}


def _console_terminal_status(console_path: Path | None) -> str | None:
    for line in reversed(_tail_lines(console_path)):
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(event, dict) and event.get("kind") == "platform_status" and event.get("status") in {"stopped", "failed"}:
            return event["status"]
    return None


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
    if failed:
        # Show the engine's own (already secret-filtered) cause next to the
        # generic text, so a failed start says why (BUGS P2-7).
        for line in reversed(_tail_lines(console_path)):
            try:
                event = json.loads(line)
            except (TypeError, ValueError):
                continue
            if (isinstance(event, dict) and event.get("kind") == "platform_error"
                    and event.get("code") == "platform_run_failed" and isinstance(event.get("message"), str)):
                message = f"{message}（{event.get('phase') or '未知阶段'}：{event['message'][:300]}）"
                break
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
              for name in account_store.ACCOUNT_ENV_FIELDS}
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
    # The background refresh may fail transiently while the last report is
    # still inside its 15-minute validity window. Keep that verified report
    # usable; only surface the refresh error once it cannot support readiness.
    check_error = (_account_startup_check_error
                   if not (report_matches and check_fresh) else None)
    account_check_ready = bool(not check_error and report_matches and check_fresh
                               and report.get("account_ready") is True
                               and report.get("signer_matches") is True
                               and report.get("approvals_ready") is True
                               and report.get("compromised") is not True)
    if account_check_ready:
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


def warm_account_check() -> None:
    """Refresh the saved account check after startup without blocking serving."""
    global _account_report, _account_report_identity, _account_startup_check_error
    if not _account_check_lock.acquire(blocking=False):
        return
    try:
        values = _account_values()
        if not values.get("POLYMARKET_WALLET_ADDRESS"):
            return
        identity = _account_identity(values)
        report = account_store.check_account(TRADING_ROOT, values)
        with _trading_lock:
            # The operator may have replaced the profile while the RPC check
            # was in flight. Never attach an old report to the new account.
            if _account_identity(_account_values()) != identity:
                return
            _account_report = report
            _account_report_identity = identity
            _account_startup_check_error = None
    except Exception as exc:
        # Startup probing is best effort. A failed probe leaves the durable
        # config intact and deliberately keeps readiness at unknown.
        with _trading_lock:
            _account_startup_check_error = getattr(exc, "code", None) or "account_check_failed"
            if _account_report is None:
                _account_report_identity = None
    finally:
        _account_check_lock.release()


def account_check_background(stop: threading.Event) -> None:
    """Keep the saved account readiness report fresh without blocking runtime."""
    while not stop.is_set():
        warm_account_check()
        stop.wait(_ACCOUNT_CHECK_REFRESH_SECONDS)


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
    _modern_response_cache.clear()
    _persist_trading_state()


def supervise_projection(stop: threading.Event) -> None:
    while not stop.wait(1):
        try:
            _activate_projection()
        except (OSError, sqlite3.Error, ValueError):
            pass


def trading_status(include_stats: bool = True) -> dict:
    global _trading_process, _trading_pid, _trading_exit_code
    global _trading_stop_result
    _restore_trading_state()
    with _trading_lock:
        process = _trading_process
        if process is not None:
            _trading_exit_code = process.poll()
            if _trading_exit_code is not None:
                # A stop that timed out left a "still stopping" result; the
                # process exiting later is the real outcome (BUGS P3-9).
                if not _trading_stop_result or _trading_stop_result.get("process_stopped") is False:
                    _trading_stop_result = _automatic_stop_result(_trading_exit_code, _trading_console_log)
                _trading_process = None
                _trading_pid = None
                _persist_trading_state()
        running = (process is not None and process.poll() is None) or _process_matches(_trading_pid, _trading_log)
        if (not running and process is None and isinstance(_trading_stop_result, dict)
                and _trading_stop_result.get("process_stopped") is False):
            # A restored pid that exited after a slow stop: same as above.
            _trading_stop_result = {**_automatic_stop_result(None, _trading_console_log),
                                    "requested_pid": _trading_stop_result.get("requested_pid")}
            _trading_pid = None
            _persist_trading_state()
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
             ("state", "run_id", "as_of", "age_seconds", "stale", "worker_alive", "projection_ms")},
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

    Reads process state and the projection snapshot only: no account status or
    console scan, so a 0.5 s push of the book stays cheap."""
    _restore_trading_state()
    with _trading_lock:
        process = _trading_process
        running = (_trading_engine == "platform"
                   and ((process is not None and process.poll() is None)
                        or _process_matches(_trading_pid, _trading_log)))
        selection = (_run_identity(), _trading_log, _trading_mode, _trading_account_id, _trading_config_revision)
    if not running:
        return False, None, {}
    stats = trade_log_stats(selection)
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
            "lines": venues, "relayListener": lines.get("relay"), "asOf": runtime.get("source_at")}


def health() -> dict:
    """GET /api/diagnostics/health: this box, the engine, the account bridge,
    the projection worker and the lead feed. Problems are listed in `error`."""
    status = trading_status()
    metrics = system_metrics().snapshot()
    runtime_view = _modern_runtime(status)
    stats = status.get("stats") or {}
    runtime = stats.get("runtime") if isinstance(stats.get("runtime"), dict) else None
    projection = stats.get("projection") or {}
    account = account_data().snapshot()
    problems = []
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
    metric_at = _epoch(metrics.get("asOf"))
    if metric_at is None or not -1 <= time.time() - metric_at <= 15 or metrics.get("stale"):
        problems.append("resource_snapshot_stale")
    feed = _lead_feed_view(runtime, status.get("running") is True)
    if feed["running"] and feed["healthy"] is False:
        problems.append("lead_feed_unhealthy")
    relay = feed.get("relayListener") or {}
    if feed["running"] and feed.get("relayConfigured") and (relay.get("listening") is False or relay.get("error")):
        problems.append("relay_listener_down")
    if account.get("error_code") not in (None, "account_not_configured", "not_checked") and account.get("stale"):
        problems.append("account_bridge_unavailable")
    services = metrics.get("services") or {}
    return {"schemaVersion": 1, "status": "degraded" if problems else "ok", "nodeLabel": NODE_LABEL,
            "source": "control-plane", "asOf": metric_at, "stale": bool(problems),
            "services": {
                "engine": {"running": status.get("running"), "pid": status.get("pid"),
                           "state": status.get("service_state"), "runId": status.get("run_id"),
                           "runtimeStale": runtime_view["stale"], "runtimeAsOf": runtime_view["asOf"],
                           "process": services.get("trader")},
                "accountBridge": {"available": account.get("available"), "stale": account.get("stale"),
                                  "error": account.get("error_code"),
                                  "cacheAgeSeconds": account.get("cache_age_seconds"),
                                  "process": services.get("account_bridge")},
                "projection": {**projection, "process": services.get("projection")},
                "console": {"process": services.get("dashboard")}},
            "leadFeed": feed, "resources": metrics,
            "error": "; ".join(problems) if problems else None}


def strategy_config_store() -> StrategyConfigStore:
    """binance-lead's own file. The retired btc-reversal-config.json beside it
    is never read: until a binance-lead config is published the store answers
    the defaults at revision 0, and a start needs a published revision."""
    global _strategy_config_store
    path = (TRADING_ROOT / "results" / "dashboard" / f"{STRATEGY_ID}-config.json").resolve()
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
                raise ValueError("策略尚未运行")
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
        if request_id == _trading_request_id:
            if payload["revision"] != _trading_config_revision:
                raise ValueError("同一启动请求不能改变配置版本")
            return trading_status(include_stats=False)
        saved = strategy_config_store().get()
        if payload["revision"] != saved["savedRevision"]:
            raise ConfigConflictError(saved["savedRevision"])
        if not saved["savedRevision"]:
            raise ValueError("请先在策略页保存并发布 binance-lead 参数")
        # No market is chosen here: the engine discovers the current round
        # itself (Gamma) and waits for the next one when started mid-round.
        return start_trading({"mode": saved["config"]["mode"], "confirm_live": True,
                              "duration_min": saved["config"]["durationMinutes"]},
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
    # Rounds are the operator's real unit; a five-minute window means any minute
    # count can cut off mid round. 0 keeps the previous time-only behaviour.
    rounds_raw = payload.get("max_rounds", (strategy_config or {}).get("config", {}).get("maxRounds", 0) or 0)
    if type(rounds_raw) not in {int, float}:
        raise ValueError("max_rounds must be a finite JSON number")
    if not math.isfinite(float(rounds_raw)) or float(rounds_raw) < 0 or float(rounds_raw) != int(rounds_raw):
        raise ValueError("max_rounds 必须为非负整数")
    max_rounds = int(rounds_raw)
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
        # A stop still waiting for its child must finish first: a start here
        # could be overwritten by that stop and run unseen (review).
        if isinstance(_trading_stop_result, dict) and _trading_stop_result.get("process_stopped") is False:
            raise RuntimeError("上一次停止仍在进行，请等它完成后再启动")
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
        # Journals grew 69-113 MB/h while trading and nothing removed them.
        prune_run_journals(log_dir, RUN_JOURNALS_KEPT - 1)
        candidate_log = log_dir / f"dashboard-{run_id}.jsonl"
        candidate_console_log = log_dir / f"dashboard-{run_id}.console.log"
        candidate_state = log_dir / f"dashboard-{run_id}.platform-state.json"
        account_wallet = account_config_status().get("wallet") if mode == "live" else None
        # Account aggregation and restart deduplication are case-insensitive
        # for Ethereum addresses; keep the internal account key canonical.
        account_id = account_wallet.lower() if isinstance(account_wallet, str) and account_wallet else None
        if strategy_config:
            identity = hashlib.sha256((account_id or "live").lower().encode()).hexdigest()[:20]
            # The account's state, shared by every run and every strategy. The
            # engine keeps settlement records at <state>.settlements.json, so a
            # new name would orphan an unfinished redemption and the account's
            # orders/positions; the "btc-reversal" prefix is only a file name.
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
            "--max-rounds", str(max_rounds),
            "--journal-file", str(candidate_log), "--state-file", str(candidate_state),
            "--stop-file", str(candidate_log.with_suffix(".stop")),
        ]
        if strategy_config:
            configured_asset = strategy_config.get("config", {}).get("assetId", "btc")
            args.extend(["--strategy", STRATEGY_ID, "--asset", configured_asset,
                         "--strategy-config", str(strategy_config_store().path),
                         "--control-file", str(candidate_log.with_suffix(".control.json"))])
        env = _trading_environment()
        env["LIVE"] = "true"
        # The engine runs in its own systemd scope: in this unit's cgroup a
        # control-plane restart, crash or OOM kill took the live engine down
        # mid-round (BUGS O2). The scope survives; restore reattaches by pid.
        systemd_run = shutil.which("systemd-run") if os.environ.get("INVOCATION_ID") else None
        if systemd_run:
            args = _engine_scope_args(systemd_run, run_id, args)
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
                               "duration_min": duration_min, "assetId": strategy_config["config"].get("assetId", "btc"),
                               "config": strategy_config["config"]}
        _trading_exit_code = None
        _trading_stop_result = None
        _persist_trading_state()
        _projection_pending.append((_trading_run_id, _trading_log, _trading_mode, _trading_account_id, _trading_config_revision))
        return trading_status(include_stats=False)


ENGINE_NICE = -5
ENGINE_CPU_WEIGHT = 200


def _engine_scope_args(systemd_run: str, run_id: str, args: list[str]) -> list[str]:
    """The engine's command inside its own transient scope.

    `systemd-run --scope` puts the scope in system.slice, beside pm-console,
    not under it: the console's cgroup limits (CPUWeight, IOWeight, MemoryMax)
    and a console restart or OOM kill never reach the engine (BUGS O2), and
    the scope gets its own CPUWeight. A scope runs the command in place, so the
    pid stays the engine's (stop and restore signal and match it directly),
    but that also means the engine inherits the console's process niceness
    (Nice=10), which is not a cgroup setting and which a scope cannot set.
    `nice -n` resets it to ENGINE_NICE; choom makes the kernel pick anything
    else first under memory pressure. nice and choom both exec in place.
    """
    current = os.nice(0) if hasattr(os, "nice") else 0
    return [systemd_run, "--scope", "--quiet", "--collect", f"--unit=pm-engine-{run_id}",
            "-p", f"CPUWeight={ENGINE_CPU_WEIGHT}",
            "nice", "-n", str(ENGINE_NICE - current),
            "choom", "-n", "-500", "--", *args]


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
    for name in ("PM_ACCOUNT_PROFILE", "PM_ACCOUNT_RPC_URL",
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
        if stop_requested:
            # Recorded before waiting, so a repeated stop request does not signal
            # a child that is already draining (see the guard above).
            _trading_stop_result = {"confirmed": False, "process_stopped": False, "remote_orders_state": "unconfirmed",
                                    "requested_pid": candidate_pid,
                                    "message": "已请求停止，正在等待撤单及成交对账完成。"}
            _persist_trading_state()
        mode, log, run_id = _trading_mode, _trading_log, _trading_run_id
    # Wait without _trading_lock: holding it for up to 8 s blocked every status
    # read and the console's requests timed out mid-stop (BUGS P3-8).
    timeout = 8 if mode == "live" else 20
    if process is None and restored_pid:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and _process_matches(restored_pid, log):
            time.sleep(0.2)
    elif process is not None and process.poll() is None:
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                # Live shutdown drains in-flight POSTs, cancels, and reconciles
                # fills. Keep it alive and report pending instead of killing
                # the very process responsible for resolving remote exposure.
                if mode != "live":
                    try:
                        process.kill()
                    except (ProcessLookupError, OSError):
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        pass
    with _trading_lock:
        # Only the stop's own run may be updated. While it waited, another poll
        # may have closed it and a new run started; touching state then would
        # hide a live engine (review).
        if _trading_run_id != run_id or (process is not None and _trading_process not in (process, None)):
            return trading_status(include_stats=False)
        _trading_exit_code = process.poll() if process else None
        stopped = (process.poll() is not None) if process is not None else not _process_matches(restored_pid, _trading_log)
        if stopped and stop_requested and _trading_console_log:
            # Report the engine's own outcome, including a failure (BUGS P3-9).
            outcome = _automatic_stop_result(_trading_exit_code, _trading_console_log)
            if outcome.get("reason") not in (None, "process_exited"):
                _trading_stop_result = {**outcome, "requested_pid": candidate_pid}
                _trading_process = None
                _trading_pid = None
                _persist_trading_state()
                return trading_status(include_stats=False)
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


def _official_results() -> dict | None:
    """Settled round results from the venue's Data API, via the account
    reader's last snapshot (no extra request). Recomputed only when that
    snapshot changes."""
    global _official_cache, _official_last_good
    reader = account_data()
    snapshot = reader.snapshot()
    marker = (reader._checked, snapshot.get("stale") is True)
    if marker[0] and _official_cache[0] == marker:
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
    return Ledger(TRADING_ROOT / "results" / "dashboard" / "ledger.sqlite3", readonly=True)


_lead_cache: OrderedDict = OrderedDict()


def _ledger_stamp() -> tuple:
    """mtimes of the ledger files: changes whenever the projection writes."""
    directory = TRADING_ROOT / "results" / "dashboard"
    stamp = []
    for name in ("ledger.sqlite3", "ledger.sqlite3-wal"):
        try:
            stamp.append((directory / name).stat().st_mtime_ns)
        except OSError:
            stamp.append(0)
    return tuple(stamp)


RUN_JOURNALS_KEPT = 20


def prune_run_journals(live: Path, keep: int = RUN_JOURNALS_KEPT) -> list[str]:
    """Delete the files of all but the newest `keep` runs (journal growth).

    A run is `dashboard-<run_id>.*`: journal, console log, control and stop
    files. Settlement records and the strategy's platform-state are shared
    across runs and never touched. Called before a new run starts, with no
    engine running, so no file here is being written.
    """
    runs: dict[str, list[Path]] = {}
    for path in live.glob("dashboard-*") if live.exists() else []:
        if not path.is_file() or ".settlements.json" in path.name or ".platform-state.json" in path.name:
            continue
        runs.setdefault(path.name.split(".", 1)[0], []).append(path)
    newest = sorted(runs, key=lambda run: max(p.stat().st_mtime for p in runs[run]), reverse=True)
    removed = []
    for run in newest[keep:]:
        for path in runs[run]:
            path.unlink(missing_ok=True)
            removed.append(path.name)
    return removed


def reset_ledger_data() -> dict:
    """Delete run journals and the projection so statistics start from empty.

    Deliberately preserved:
    - `*.settlements.json` — the on-chain settlement records. A `prepared` or
      `submitted` record is an unfinished redemption; losing it would abandon
      winnings that are still on chain. Money state is never console-resettable.
    - strategy config and drafts — configuration, not run data.

    Deleted (this was the gap): the main `*.platform-state.json` engine state —
    orders, fills, positions, cash. It is run data, so a reset that kept it left
    the next run replaying old fills.

    The caller MUST hold `_trading_lock` and must already have proven that no
    trading process is running: this deletes the journal a live run is appending
    to, and the engine would keep writing to an unlinked inode.
    """
    global _read_model
    results = TRADING_ROOT / "results"
    live, dashboard = results / "live", results / "dashboard"
    report = {"journals": 0, "logs": 0, "controls": 0, "state": 0, "bytes": 0, "projection": False, "preserved": []}
    # The projection worker opens ledger.sqlite3 once and never reopens it, and
    # the supervisor only respawns a *dead* worker. Unlinking under it would
    # leave it ingesting into a deleted inode, so every later run would report
    # zero fills and flat PnL until the server restarted. Stop it first and let
    # the supervisor rebuild it against the new file.
    if _read_model is not None:
        _read_model.close()
        _read_model = None
    for path in sorted(live.glob("*")) if live.exists() else []:
        if not path.is_file():
            continue
        name = path.name
        # Only the SETTLEMENT side is money state (an unfinished redemption would
        # be abandoned if deleted). The main platform-state file is run data —
        # orders, fills, positions, cash — but the old `.platform-state.json`
        # substring preserved it too, so a reset left 42 terminal orders and 38
        # fills behind for the next run's recovery scan to replay as new fills.
        if ".settlements.json" in name:
            report["preserved"].append(name)
            continue
        key = ("journals" if name.endswith(".jsonl") else "logs" if name.endswith(".console.log")
               else "controls" if name.endswith(".control.json")
               else "state" if ".platform-state.json" in name else None)
        if key is None:
            continue
        size = path.stat().st_size
        path.unlink()
        report[key] += 1
        report["bytes"] += size
    for suffix in ("", "-wal", "-shm"):
        projection = dashboard / f"ledger.sqlite3{suffix}"
        if projection.exists():
            projection.unlink()
            report["projection"] = True
    # Recreate an empty projection so readers get "no runs" instead of an error.
    Ledger(dashboard / "ledger.sqlite3")
    for name in ("selection.json", "snapshot.json", "heartbeat.json"):
        stale = dashboard / name
        if stale.exists():
            stale.unlink()
    # Drop this run's identity, cached responses and projection bookkeeping. The
    # caller holds _trading_lock, which these globals are guarded by.
    _clear_account_run_selection()
    return report


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
        result = _api_ledger().events(run_id, before_id=int(cursor) if cursor else None,
                                      limit=int(query.get("limit", ["50"])[0]), kinds=kinds,
                                      asset_id=requested_asset,
                                      market_id=(query.get("marketId") or [None])[0],
                                      round_id=(query.get("roundId") or [None])[0])
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
                # The figures change only when the projection writes the ledger
                # or the venue's results change: answer repeats from memory.
                cache_key = (self.path, run_id, _ledger_stamp(), id(results))
                with _modern_cache_lock:
                    cached = _lead_cache.get(cache_key)
                if cached is not None:
                    self._send_json(cached)
                    return
                try:
                    if path == "/api/stats/lead":
                        data = _api_ledger().lead_stats(run_id, range=requested_range, official=results)
                    else:
                        before = query.get("before", [None])[0]
                        data = _api_ledger().lead_orders_page(
                            run_id, range=requested_range, limit=int(query.get("limit", ["200"])[0]),
                            before=float(before) if before is not None else None, official=results)
                except KeyError:
                    self._send_json(json.dumps({"schemaVersion": 1, "available": False, "runId": run_id,
                                                "range": requested_range, "source": "ledger", "asOf": None,
                                                "stale": True, "error": "ledger_projection_unavailable"},
                                               ensure_ascii=False).encode("utf-8"))
                    return
                metadata = _ledger_metadata(run_id)
                body = json.dumps({"schemaVersion": 1, "available": True, **data, **metadata},
                                  ensure_ascii=False, allow_nan=False).encode("utf-8")
                with _modern_cache_lock:
                    _lead_cache[cache_key] = body
                    while len(_lead_cache) > 16:
                        _lead_cache.popitem(last=False)
                self._send_json(body)
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
                    data = _api_ledger().rounds_page(
                        run_id,
                        before_round_id=(query.get("beforeRoundId") or [None])[0],
                        limit=int((query.get("limit") or [50])[0]),
                        asset_id=(query.get("assetId") or [None])[0],
                        round_id=(query.get("roundId") or [None])[0])
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
            if path == "/":
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
                config = b'<script>window.__POLY_PREVIEW_CONFIG__={mode:"backend",demo:false,apiBase:"",apiFlavor:"contract"};</script>'
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
                                  "revision": payload.get("revision"), "request_id": payload.get("requestId")}
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
                        config = strategy_config_store().activate_draft(payload.get("expectedRevision"), payload.get("draftId"))
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
                    # Wiping the projection while a run is writing to it would
                    # discard records for capital already committed on chain, so
                    # the liveness check and the delete must be atomic: without
                    # the lock, _start_trading can win the gap and the engine
                    # ends up appending to an unlinked journal. The guard also
                    # fails closed — "cannot prove it is stopped" is not
                    # "stopped", because _process_matches() reports False
                    # whenever the persisted trading state was lost.
                    try:
                        with _trading_lock:
                            present = _engine_process_present()
                            if present is None:
                                raise RuntimeError("无法确认交易进程是否已停止，未清空任何数据")
                            if present or _process_matches(_trading_pid, _trading_log):
                                raise RuntimeError("交易进程仍在运行，请先停止交易再清空数据")
                            report = reset_ledger_data()
                    except RuntimeError as exc:
                        self._send_json(json.dumps({"accepted": False, "error": str(exc)},
                                                   ensure_ascii=False).encode("utf-8"), 409)
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

    ledger_dir = TRADING_ROOT / "results" / "dashboard"

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
        if route.startswith(("/api/rounds", "/api/fills", "/api/settlements", "/api/events", "/api/metrics/",
                             "/api/stats/", "/api/orders/", "/api/runtime/book")):
            return ledger
        if route == "/api/account/snapshot":
            return account_data()._checked
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
    threading.Thread(target=supervise_projection, args=(stop,), daemon=True).start()
    threading.Thread(target=account_data().run, args=(stop,), daemon=True).start()
    threading.Thread(target=refresh_system_metrics, args=(stop,), daemon=True).start()
    threading.Thread(target=account_check_background, args=(stop,),
                     name="account-check-background", daemon=True).start()
    threading.Thread(target=server.RequestHandlerClass.push_hub.run, args=(stop,),
                     name="console-push", daemon=True).start()
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

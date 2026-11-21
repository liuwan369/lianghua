"""The engine box's agent: everything that touches the trading engine process and
the account keys, behind a small loopback-only HTTP API the console reaches
through an SSH tunnel (ARCHITECTURE.md, engine agent).

It owns, on its own box:
- the engine process: start (command line, environment, systemd scope), stop
  (SIGTERM, wait, the engine's own outcome), pause/resume (control file), the
  persisted run and reattach after a restart (/proc);
- the account: profile/.env values, the read-only account check, the account
  reader (dist/cli/account-data.js) and its snapshot, "remote orders confirmed";
- the published strategy config the engine hot-reloads;
- the run journals, served by byte offset for the console's replica;
- box metrics (CPU, steal, memory, disk) and its own processes.

Nothing it returns carries a secret. It binds 127.0.0.1 only and refuses any
other address. Moved out of scripts/system-dashboard-server.py (the console
no longer starts engines or reads keys).

  python3 scripts/engine_agent.py --port 18767 --box pm-a
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows development fallback
    fcntl = None

sys.path.insert(0, str(Path(__file__).resolve().parent))
import dashboard_account as account_store
from dashboard.config import ConfigConflictError, ConfigValidationError, ConfigStoreError
from dashboard.strategy_config import StrategyConfigStore, STRATEGY_ID
from dashboard.account_data import AccountData
from dashboard.replica import source_chunk
from dashboard.system_metrics import SystemMetrics
from dashboard.timestamps import epoch

_REPO_ENGINE = Path(__file__).resolve().parents[2] / "engine"
_DEPLOYED_ENGINE = Path(__file__).resolve().parents[1] / "backend" / "engine"
TRADING_ROOT = next((path for path in (_DEPLOYED_ENGINE, _REPO_ENGINE)
                     if (path / "package.json").is_file()), _REPO_ENGINE)
DEPLOYMENT_LOCK_PATH = TRADING_ROOT.parents[1] / "data" / "dashboard" / "deployment.lock"
BOX = os.environ.get("PM_BOX_ID", "")
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
_trading_run_id: str | None = None
_trading_config_revision: int | None = None
_trading_account_id: str | None = None
_trading_request_id: str | None = None
_trading_engine: str | None = None
_account_report: dict | None = None
_account_report_identity: str | None = None
_account_startup_check_error: str | None = None
_account_data: AccountData | None = None
_account_data_lock = threading.Lock()
_strategy_config_store: StrategyConfigStore | None = None
_config_control_lock = threading.RLock()
_system_metrics: SystemMetrics | None = None
_system_metrics_lock = threading.Lock()
# Account checks are read-only RPC probes. Refresh before the 15-minute
# readiness window expires so a long-running agent does not become stale.
_ACCOUNT_CHECK_REFRESH_SECONDS = 10 * 60
# The account reader's regular refresh. Each read costs ~1.6 s of CPU; at 15 s
# it took ~11% of a core, half the AWS box's 20% baseline (2026-11-21). A fill
# still refreshes at once (POST /account/refresh), and 60 s stays well inside
# the 180 s a snapshot counts as fresh for confirming a stop.
_ACCOUNT_READ_SECONDS = 60
RUN_ID = re.compile(r"\d{8}-\d{6}-[0-9a-f]{12}\Z")
JOURNAL_CHUNK_MAX = 1 << 20


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


def _state_path() -> Path:
    return TRADING_ROOT / "results" / "engine-run.json"


def _live_dir() -> Path:
    return TRADING_ROOT / "results" / "live"


def account_data() -> AccountData:
    global _account_data
    with _account_data_lock:
        if _account_data is None:
            _account_data = AccountData(TRADING_ROOT, _account_values, interval=_ACCOUNT_READ_SECONDS)
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
    bridge = getattr(_account_data, "_process", None) if _account_data else None
    bridge_running = bool(bridge and bridge.poll() is None)
    return {
        "agent": {"pid": os.getpid(), "state": "active"},
        "account_bridge": {"pid": bridge.pid if bridge_running else None, "state": "active" if bridge_running else "stopped"},
        "trader": {"pid": trader_pid if trader_running else None, "state": "active" if trader_running else "stopped"},
    }


def system_metrics() -> SystemMetrics:
    global _system_metrics
    with _system_metrics_lock:
        if _system_metrics is None:
            _system_metrics = SystemMetrics(Path(__file__).resolve().parents[1], _metric_services)
        return _system_metrics


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
    checked_at = epoch(report.get("checked_at")) if report else None
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



def strategy_config_store() -> StrategyConfigStore:
    """binance-lead's own file. The retired btc-reversal-config.json beside it
    is never read: until a binance-lead config is published the store answers
    the defaults at revision 0, and a start needs a published revision."""
    global _strategy_config_store
    path = (TRADING_ROOT / "results" / "dashboard" / f"{STRATEGY_ID}-config.json").resolve()
    if _strategy_config_store is None or _strategy_config_store.path != path:
        _strategy_config_store = StrategyConfigStore(path)
    return _strategy_config_store



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
        # Journals grew 69-113 MB/h while trading; older runs go to results/archive.
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
            # A new operator start resumes the saved strategy unless it asks to
            # start paused (a dry run: feeds, signals and skip reasons, no
            # orders until 继续). Reusing a process/state alone must still
            # preserve an intentional pause.
            candidate_log.with_suffix(".control.json").write_text(
                json.dumps({"paused": payload.get("start_paused") is True}), encoding="utf-8")
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
        return trading_status()


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
            return trading_status()
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
            return trading_status()
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
            return trading_status()
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
                return trading_status()
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
        return trading_status()



RUN_JOURNALS_KEPT = 3


def prune_run_journals(live: Path, keep: int = RUN_JOURNALS_KEPT, archive: Path | None = None) -> list[str]:
    """Keep the newest `keep` runs in `live`; pack each older one into
    `archive/<run>.tar.gz` and remove its files (2026-11-13: the box keeps 3
    raw runs, old runs are 6.5 GB raw / 0.36 GB packed; nothing is deleted
    unpacked). The console statistics only read the runs the ledger has.

    A run is `dashboard-<run_id>.*`: journal, console log, control and stop
    files. Settlement records and the strategy's platform-state are shared
    across runs and never touched. Called before a new run starts, with no
    engine running, so no file here is being written. A run whose pack fails
    is left in place.
    """
    import tarfile
    archive = archive or live.parent / "archive"
    runs: dict[str, list[Path]] = {}
    for path in live.glob("dashboard-*") if live.exists() else []:
        if not path.is_file() or ".settlements.json" in path.name or ".platform-state.json" in path.name:
            continue
        runs.setdefault(path.name.split(".", 1)[0], []).append(path)
    newest = sorted(runs, key=lambda run: max(p.stat().st_mtime for p in runs[run]), reverse=True)
    removed = []
    for run in newest[keep:]:
        archive.mkdir(parents=True, exist_ok=True)
        target = archive / f"{run}.tar.gz"
        partial = target.with_name(target.name + ".part")
        try:
            with tarfile.open(partial, "w:gz", compresslevel=6) as pack:
                for path in runs[run]:
                    pack.add(path, arcname=path.name)
            partial.replace(target)
        except OSError:
            partial.unlink(missing_ok=True)
            continue
        for path in runs[run]:
            path.unlink(missing_ok=True)
            removed.append(path.name)
    return removed


def trading_status() -> dict:
    """The engine process facts on this box (no projection: the console owns
    the ledger and merges these with its replica's runtime)."""
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
        return {
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
            # confirmed once the account snapshot confirms no remote orders;
            # until then keep the command executing.
            "command_status": "executing" if running else ("failed" if stop_failed
                              else "confirmed" if (_trading_stop_result or {}).get("confirmed") is True
                              else "executing"),
            "account": account,
            "run_id": _trading_run_id,
            "config_revision": _trading_config_revision,
            "account_id": _trading_account_id,
            "request_id": _trading_request_id,
        }


def strategy_control(payload: dict) -> dict:
    action = payload.get("action")
    if payload.get("strategy_id", STRATEGY_ID) != STRATEGY_ID:
        raise ValueError("策略不存在")
    if action == "stop":
        return stop_trading()
    if action in {"pause", "resume"}:
        with _trading_lock:
            status = trading_status()
            if not status["running"] or status["strategy_id"] != STRATEGY_ID or not _trading_log:
                raise ValueError("策略尚未运行")
            control = _trading_log.with_suffix(".control.json")
            temporary = control.with_suffix(".next")
            temporary.write_text(json.dumps({"paused": action == "pause"}), encoding="utf-8")
            temporary.replace(control)
            if _trading_params is not None:
                _trading_params["pendingControl"] = {"action": action, "requestedAt": time.time()}
                _persist_trading_state()
            return {**trading_status(), "control_requested": action, "control_pending": True,
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
            return trading_status()
        saved = strategy_config_store().get()
        if payload["revision"] != saved["savedRevision"]:
            raise ConfigConflictError(saved["savedRevision"])
        if not saved["savedRevision"]:
            raise ValueError("请先在策略页保存并发布 binance-lead 参数")
        # No market is chosen here: the engine discovers the current round
        # itself (Gamma) and waits for the next one when started mid-round.
        return start_trading({"mode": saved["config"]["mode"], "confirm_live": True,
                              "duration_min": saved["config"]["durationMinutes"],
                              "start_paused": payload.get("start_paused") is True},
                             config_revision=saved["savedRevision"], request_id=request_id,
                             strategy_config=saved)


def _runs() -> list[dict]:
    """This box's run journals, newest first: id and size (the replica's work list)."""
    live = _live_dir()
    rows = []
    for path in live.glob("dashboard-*.jsonl") if live.is_dir() else []:
        run_id = path.name[len("dashboard-"):-len(".jsonl")]
        if RUN_ID.fullmatch(run_id):
            stat = path.stat()
            rows.append({"run_id": run_id, "bytes": stat.st_size, "mtime": stat.st_mtime})
    return sorted(rows, key=lambda row: row["mtime"], reverse=True)


def journal_chunk(run_id: str, offset: int, tail: str, max_bytes: int) -> dict:
    """GET /journal: bytes of one run's journal from `offset`, by run id only (never a path)."""
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise ValueError("invalid run id")
    if offset < 0 or not re.fullmatch(r"[0-9a-f]{64}", tail or ""):
        raise ValueError("invalid offset or tail")
    path = _live_dir() / f"dashboard-{run_id}.jsonl"
    if not path.is_file():
        raise KeyError("run not found")
    chunk = source_chunk(path, offset, tail, max_bytes=max(1, min(int(max_bytes), JOURNAL_CHUNK_MAX)))
    return {**chunk, "data": base64.b64encode(chunk["data"]).decode("ascii")}


# The console reads balance, occupancy, positions and open orders, and
# official_pnl reads closed_positions. Trade history, on-chain activity and fee
# history were 400 KB of a 440 KB snapshot that nobody read.
_ACCOUNT_HISTORY_SECTIONS = frozenset({"trades", "activity", "order_history", "fees", "rewards", "reconciliation"})


def account_snapshot() -> dict:
    snapshot = account_data().snapshot()
    return {key: value for key, value in snapshot.items() if key not in _ACCOUNT_HISTORY_SECTIONS}


def state() -> dict:
    """GET /state: one poll gives the console everything it caches each second."""
    status = trading_status()
    reader = account_data()
    meta = reader.snapshot()
    return {"schemaVersion": 1, "box": BOX, "now": time.time(), "status": status,
            "config": strategy_config_store().get(), "draft": strategy_config_store().get_draft(),
            # A changed version tells the console to fetch /account/snapshot again.
            "accountSnapshot": {"version": reader._checked, "stale": meta.get("stale") is True,
                                "error": meta.get("error_code"), "cacheAgeSeconds": meta.get("cache_age_seconds")},
            "metrics": system_metrics().snapshot(), "runs": _runs()[:RUN_JOURNALS_KEPT + 2]}


def reset_engine_data() -> dict:
    """Delete this box's run journals, console logs, controls and the account's
    engine state (orders, fills, positions, cash). *.settlements.json stays: an
    unfinished redemption would be abandoned. The caller proves no engine runs."""
    global _trading_log, _trading_console_log, _trading_run_id, _trading_config_revision
    global _trading_account_id, _trading_request_id, _trading_started_at, _trading_exit_code
    global _trading_stop_result, _trading_engine, _trading_params, _trading_mode
    report = {"journals": 0, "logs": 0, "controls": 0, "state": 0, "bytes": 0, "preserved": []}
    live = _live_dir()
    for path in sorted(live.glob("*")) if live.exists() else []:
        if not path.is_file():
            continue
        name = path.name
        if ".settlements.json" in name:
            report["preserved"].append(name)
            continue
        key = ("journals" if name.endswith(".jsonl") else "logs" if name.endswith(".console.log")
               else "controls" if name.endswith(".control.json")
               else "state" if ".platform-state.json" in name else None)
        if key is None:
            continue
        report["bytes"] += path.stat().st_size
        path.unlink()
        report[key] += 1
    _trading_log = _trading_console_log = _trading_run_id = _trading_config_revision = None
    _trading_account_id = _trading_request_id = _trading_started_at = _trading_exit_code = None
    _trading_stop_result = _trading_engine = _trading_params = _trading_mode = None
    _persist_trading_state()
    return report


def make_handler():
    class Handler(BaseHTTPRequestHandler):
        def _send(self, value, status=200):
            body = json.dumps(value, ensure_ascii=False, allow_nan=False, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _error(self, status, message, **extra):
            self._send({"ok": False, "error": message, **extra}, status)

        def do_GET(self):  # noqa: N802
            parts = urlsplit(self.path)
            query = parse_qs(parts.query)
            try:
                if parts.path == "/state":
                    self._send(state())
                elif parts.path == "/account/snapshot":
                    self._send(account_snapshot())
                elif parts.path == "/journal":
                    self._send(journal_chunk(query.get("run", [""])[0], int(query.get("offset", ["0"])[0]),
                                             query.get("tail", [""])[0], int(query.get("max", [str(JOURNAL_CHUNK_MAX)])[0])))
                else:
                    self._error(404, "not found")
            except KeyError:
                self._error(404, "run not found")
            except (ValueError, TypeError):
                self._error(400, "invalid query")
            except Exception as exc:   # one broken source never stops the agent
                self._error(503, type(exc).__name__)

        def do_POST(self):  # noqa: N802
            path = urlsplit(self.path).path
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > 64_000:
                    raise ValueError("请求内容过大")
                payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
                if not isinstance(payload, dict):
                    raise ValueError("request body must be an object")
                if path == "/commands":
                    self._send(strategy_control(payload))
                elif path == "/account/refresh":
                    account_data().invalidate()
                    self._send({"ok": True})
                elif path == "/config/draft":
                    with _config_control_lock:
                        self._send(strategy_config_store().save_draft(payload.get("config"), payload.get("expectedRevision")))
                elif path == "/config/activate":
                    with _config_control_lock:
                        self._send(strategy_config_store().activate_draft(payload.get("expectedRevision"), payload.get("draftId")))
                elif path == "/reset":
                    if payload.get("confirm") != "RESET":
                        raise ValueError("缺少确认标记，未清空任何数据")
                    # The liveness check and the delete are atomic, and fail
                    # closed: "cannot prove it is stopped" is not "stopped".
                    with _trading_lock:
                        present = _engine_process_present()
                        if present is None:
                            raise RuntimeError("无法确认交易进程是否已停止，未清空任何数据")
                        if present or _process_matches(_trading_pid, _trading_log):
                            raise RuntimeError("交易进程仍在运行，请先停止交易再清空数据")
                        self._send({"ok": True, "report": reset_engine_data()})
                else:
                    self._error(404, "not found")
            except account_store.AccountCheckError as exc:
                self._error(exc.http_status, str(exc), error_code=exc.code, retryable=exc.retryable)
            except ConfigConflictError as exc:
                self._error(409, str(exc), current_revision=exc.current_revision)
            except PermissionError as exc:
                self._error(403, str(exc))
            except (ValueError, json.JSONDecodeError) as exc:
                self._error(400, str(exc))
            except (RuntimeError, OSError) as exc:
                self._error(409, str(exc))

        def log_message(self, *_):
            return

    return Handler


def main() -> int:
    global BOX
    parser = argparse.ArgumentParser(description="Engine box agent (loopback only)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18767)
    parser.add_argument("--box", default=BOX, help="this box's id (pm-a, pm-b, pm-ire); the console checks it")
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("引擎代理只允许监听本机地址")
    BOX = args.box
    system_metrics().refresh()
    server = ThreadingHTTPServer((args.host, args.port), make_handler())
    stop = threading.Event()
    threading.Thread(target=account_data().run, args=(stop,), daemon=True).start()
    threading.Thread(target=system_metrics().run, args=(stop,), daemon=True).start()
    threading.Thread(target=account_check_background, args=(stop,), name="account-check-background", daemon=True).start()
    try:
        server.serve_forever()
    finally:
        stop.set()
        server.server_close()
        if _account_data:
            _account_data.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())



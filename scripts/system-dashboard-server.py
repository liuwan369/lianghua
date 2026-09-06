from __future__ import annotations

import argparse
import hmac
import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


TRADING_ROOT = Path(__file__).resolve().parents[1] / "_external" / "btc-5m-market-trading-bot"
_trading_lock = threading.RLock()
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


def _environment(primary: str, legacy: str | None, default: str) -> str:
    """Read a generic setting while retaining compatibility with Tokyo deployments."""
    if primary in os.environ:
        return os.environ[primary]
    if legacy and legacy in os.environ:
        return os.environ[legacy]
    return default


def _live_config() -> dict:
    project_root = Path(__file__).resolve().parents[1]
    local_data_dir = Path(
        _environment(
            "PM_LIVE_DATA_DIR",
            None,
            str(project_root / "data" / "pm-r25-live" / "days"),
        )
    )
    local_setting = _environment("PM_LIVE_LOCAL", "PM_TOKYO_LIVE_LOCAL", "")
    collector_is_local = local_setting == "1" if local_setting else local_data_dir.is_dir()
    return {
        "node_label": _environment("PM_NODE_LABEL", None, "东京节点"),
        "local_data_dir": local_data_dir,
        "collector_is_local": collector_is_local,
        "remote_data_dir": _environment(
            "PM_REMOTE_DATA_DIR",
            "PM_TOKYO_REMOTE_DATA_DIR",
            "/root/pm-system/data/pm-r25-live/days",
        ),
        "evidence_glob": _environment("PM_EVIDENCE_GLOB", None, "tokyo-evidence-*.sqlite3"),
        "collector_service": _environment(
            "PM_COLLECTOR_SERVICE", None, "pm-r25-tokyo-collector.service"
        ),
        "ssh_key": Path(
            _environment(
                "PM_REMOTE_SSH_KEY",
                "PM_TOKYO_SSH_KEY",
                str(Path.home() / ".ssh" / "id_ed25519_tokyo"),
            )
        ),
        "remote_host": _environment("PM_REMOTE_HOST", None, "root@13.115.254.211"),
        "remote_port": _environment("PM_REMOTE_PORT", None, "22"),
        "connect_timeout": _environment("PM_REMOTE_CONNECT_TIMEOUT", None, "5"),
        "remote_python": _environment("PM_REMOTE_PYTHON", None, "python3"),
    }


def _state_path() -> Path:
    return TRADING_ROOT / "results" / "dashboard-state.json"


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
    global _trading_pid, _trading_started_at, _trading_mode, _trading_params
    global _trading_log, _trading_console_log, _trading_exit_code
    global _trading_stop_result, _trading_state_loaded
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


def private_key_configured() -> bool:
    """Check for a non-empty key without exposing its value in the API."""
    def meaningful(value: str) -> bool:
        # Treat quoted whitespace as empty; this avoids showing a false
        # "account configured" state when a placeholder was copied to .env.
        return bool(value.strip().strip("'\"").strip())

    if meaningful(os.environ.get("POLYMARKET_PRIVATE_KEY", "")):
        return True
    env_path = TRADING_ROOT / ".env"
    try:
        for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            if name.strip() == "POLYMARKET_PRIVATE_KEY" and meaningful(value):
                return True
    except OSError:
        pass
    return False


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
    supplied_token = authorization[7:].strip() if authorization.startswith("Bearer ") else ""
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


def _live_status_fetch() -> dict:
    """Read a small, read-only health snapshot from the configured collector.

    The full SQLite database stays on the collector host. Only aggregate counters,
    timestamps, and the latest health JSON cross the SSH connection.
    """
    global _live_cache, _live_cache_at
    config = _live_config()
    now = time.monotonic()
    with _live_lock:
        if now - _live_cache_at < 5:
            return {**_live_cache, "node_label": config["node_label"]}
    data_dir = config["local_data_dir"] if config["collector_is_local"] else Path(config["remote_data_dir"])
    script = r'''# -*- coding: utf-8 -*-
import glob, json, os, sqlite3, subprocess, time, zlib
from datetime import datetime, timezone
data_dir = __DATA_DIR__
evidence_glob = __EVIDENCE_GLOB__
collector_service = __COLLECTOR_SERVICE__
node_label = __NODE_LABEL__
paths = sorted(glob.glob(os.path.join(data_dir, evidence_glob)))
result = {'checked_at': datetime.now(timezone.utc).isoformat(), 'service': 'unknown', 'node_label': node_label}
try:
    result['service'] = subprocess.run(['systemctl', 'is-active', collector_service], capture_output=True, text=True, timeout=3).stdout.strip()
except Exception as exc:
    result['service_error'] = type(exc).__name__
if not paths:
    result['error'] = node_label + ' SQLite missing'
else:
    path = paths[-1]
    result['db'] = os.path.basename(path)
    result['db_bytes'] = os.path.getsize(path)
    result['db_mtime'] = datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).isoformat()
    conn = sqlite3.connect('file:' + path + '?mode=ro', uri=True, timeout=3)
    try:
        now_ns = time.time_ns()
        now_second = int(now_ns // 1_000_000_000)
        for name, seconds in (('1m', 60), ('5m', 300)):
            chunk_count = conn.execute(
                'SELECT COALESCE(SUM(event_count),0) FROM event_chunks WHERE received_second >= ?',
                (now_second - seconds,),
            ).fetchone()[0]
            event_count = conn.execute(
                'SELECT COUNT(*) FROM events WHERE received_at_ns >= ?',
                (now_ns - seconds * 1_000_000_000,),
            ).fetchone()[0]
            result['events_' + name] = int(chunk_count or 0) + int(event_count or 0)
        latest = {row[0]: int(row[1]) * 1_000_000_000 for row in conn.execute('SELECT source, MAX(received_second) FROM event_chunks GROUP BY source')}
        latest.update({row[0]: row[1] for row in conn.execute('SELECT source, MAX(received_at_ns) FROM events GROUP BY source')})
        result['latest_by_source'] = latest
        result['latest_event_ns'] = max(latest.values()) if latest else None
        if result['latest_event_ns'] is not None:
            result['latest_event_at'] = datetime.fromtimestamp(result['latest_event_ns'] / 1_000_000_000, timezone.utc).isoformat()
        metadata = {}
        for row in conn.execute("SELECT payload_json FROM events WHERE source='gamma' AND event_type='market_metadata' ORDER BY received_at_ns DESC LIMIT 20"):
            try:
                item = json.loads(row[0])
                metadata[item.get('slug')] = item
            except Exception:
                pass
        books = {}
        for codec, blob in conn.execute("SELECT codec,payload_blob FROM event_chunks WHERE source='clob' AND received_second >= ? ORDER BY received_second", (now_second - 180,)):
            if codec != 'zlib-json-v2':
                continue
            try:
                rows = json.loads(zlib.decompress(blob).decode('utf-8'))
            except Exception:
                continue
            for event_type, received_ns, source_ms, _slug, token, payload in rows:
                if not token:
                    continue
                state = books.setdefault(str(token), {'bids': {}, 'asks': {}, 'received_ns': received_ns})
                state['received_ns'] = max(state.get('received_ns', 0), received_ns)
                if event_type == 'book':
                    state['bids'] = {str(price): float(size) for price, size in (payload[1] or []) if float(size) > 0}
                    state['asks'] = {str(price): float(size) for price, size in (payload[2] or []) if float(size) > 0}
                elif event_type == 'best_bid_ask':
                    if payload[1] is not None: state['bids'] = {str(payload[1]): 1.0}
                    if payload[2] is not None: state['asks'] = {str(payload[2]): 1.0}
                elif event_type == 'price_change':
                    for changed_token, price, size, side, _best_bid, _best_ask in (payload[1] or []):
                        if str(changed_token) != str(token):
                            continue
                        levels = state['bids'] if str(side).upper() in ('BUY', 'BID') else state['asks']
                        if float(size) > 0: levels[str(price)] = float(size)
                        else: levels.pop(str(price), None)
        current = []
        now_sec = time.time()
        for slug, item in metadata.items():
            try:
                if not (float(item.get('start_at', 0)) <= now_sec < float(item.get('end_at', 0))):
                    continue
                up = books.get(str(item.get('up_token')), {})
                down = books.get(str(item.get('down_token')), {})
                ub = max((float(x) for x in up.get('bids', {})), default=None)
                ua = min((float(x) for x in up.get('asks', {})), default=None)
                db = max((float(x) for x in down.get('bids', {})), default=None)
                da = min((float(x) for x in down.get('asks', {})), default=None)
                current.append({'slug': slug, 'condition_id': item.get('condition_id') or item.get('conditionId') or '',
                                'up_token': item.get('up_token') or item.get('upToken') or '', 'down_token': item.get('down_token') or item.get('downToken') or '',
                                'start': item.get('start_at'), 'end': item.get('end_at'), 'up_bid': ub, 'up_ask': ua, 'down_bid': db, 'down_ask': da,
                                'ask_sum': ua + da if ua is not None and da is not None else None,
                                'quote_at': datetime.fromtimestamp(max(up.get('received_ns', 0), down.get('received_ns', 0)) / 1_000_000_000, timezone.utc).isoformat() if max(up.get('received_ns', 0), down.get('received_ns', 0)) else None})
            except (TypeError, ValueError):
                continue
        # Keep one deterministic selection rule for every client: the market
        # ending soonest is first, while the full active set remains visible.
        result['current_markets'] = sorted(current, key=lambda market: float(market.get('end') or 10**20))
        row = conn.execute('SELECT recorded_at,queue_depth,counters_json,source_status_json FROM health ORDER BY id DESC LIMIT 1').fetchone()
        if row:
            result['health_at'] = row[0]
            result['queue_depth'] = row[1]
            result['counters'] = json.loads(row[2])
            result['sources'] = json.loads(row[3])
    finally:
        conn.close()
result['collector_online'] = result.get('service') == 'active' and bool(result.get('health_at'))
now = datetime.now(timezone.utc)
freshness = {}
for key in ('health_at', 'latest_event_at'):
    value = result.get(key)
    if value:
        try:
            freshness[key] = max(0.0, (now - datetime.fromisoformat(value)).total_seconds())
        except ValueError:
            freshness[key] = None
result['freshness_seconds'] = freshness
stale = [key for key, seconds in freshness.items() if seconds is None or seconds > 120]
if stale:
    result['collector_online'] = False
    result['stale_reason'] = 'stale data older than 120 seconds: ' + ','.join(stale)
print(json.dumps(result, ensure_ascii=True))
'''
    try:
        # On a collector host the database is local. Running SSH back
        # into the same host adds a long timeout and makes the dashboard look
        # frozen. A separate dashboard host can read aggregates over SSH.
        replacements = {
            "__DATA_DIR__": str(data_dir).replace("\\", "/"),
            "__EVIDENCE_GLOB__": config["evidence_glob"],
            "__COLLECTOR_SERVICE__": config["collector_service"],
            "__NODE_LABEL__": config["node_label"],
        }
        for marker, value in replacements.items():
            script = script.replace(marker, json.dumps(value, ensure_ascii=True))
        if config["collector_is_local"]:
            command = [sys.executable, "-c", script]
        else:
            command = [
                "ssh", "-i", str(config["ssh_key"]), "-p", str(config["remote_port"]),
                "-o", "BatchMode=yes", "-o", f"ConnectTimeout={config['connect_timeout']}",
                "-o", "StrictHostKeyChecking=no", config["remote_host"], config["remote_python"], "-",
            ]
        completed = subprocess.run(command, input=script, text=True, capture_output=True, timeout=30)
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr.strip() or f"ssh exit {completed.returncode}")
        value = json.loads(completed.stdout)
        if not isinstance(value, dict):
            raise RuntimeError(f"{config['node_label']}状态返回格式错误")
        value["node_label"] = config["node_label"]
    except Exception as exc:
        value = {
            "collector_online": False,
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "node_label": config["node_label"],
            "error": f"无法读取{config['node_label']}采集器：{type(exc).__name__}: {exc}",
        }
    with _live_lock:
        _live_cache = value
        _live_cache_at = time.monotonic()
        return dict(value)


def trading_status() -> dict:
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
        return {
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
            "account_configured": private_key_configured(),
            "log": str(_trading_log).replace("\\", "/") if _trading_log else None,
            "stats": trade_log_stats(),
        }


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


def _apply_trade_record(cache: dict, rec: dict) -> None:
    stats = cache["stats"]
    market_map = cache["markets"]
    event = rec.get("event")
    stats["last_event"] = event or stats["last_event"]
    market = str(rec.get("market_slug") or "未标记市场")
    summary = None
    if event in {"quote", "fill", "taker", "cancel", "resolved", "reset", "stopped"}:
        summary = market_map.setdefault(
            market,
            {"market": market, "fills": 0, "turnover": 0.0, "pnl": None, "status": "运行中", "last_time": 0},
        )
        event_time = rec.get("recv_ts")
        if isinstance(event_time, (int, float)):
            summary["last_time"] = max(float(event_time), float(summary["last_time"]))
        amount = None
        if rec.get("price") is not None and rec.get("shares") is not None:
            try:
                amount = float(rec["price"]) * float(rec["shares"])
            except (TypeError, ValueError):
                pass
        event_label = event
        if event == "resolved" and summary is not None and summary["fills"] == 0:
            event_label = "resolved_empty"
        stats["events"].append({
            "time": event_time, "event": event_label, "side": rec.get("side") or rec.get("winner"),
            "price": rec.get("price"), "shares": rec.get("shares"), "amount": amount,
            "pnl": None if event_label == "resolved_empty" else rec.get("pnl"),
            "market": rec.get("market_slug"),
        })
        stats["events"] = stats["events"][-20:]
    if event == "quote":
        stats["quotes"] += 1
    elif event == "fill" and summary is not None:
        stats["fills"] += 1
        if market not in cache["traded_market_keys"]:
            cache["traded_market_keys"].add(market)
            stats["traded_markets"] = len(cache["traded_market_keys"])
        try:
            amount = float(rec.get("price") or 0) * float(rec.get("shares") or 0)
            stats["fill_notional"] += amount
            stats["fees"] += float(rec.get("fee") or 0)
            summary["turnover"] += amount
        except (TypeError, ValueError):
            stats["error"] = "交易日志含无效数字"
        summary["fills"] += 1
        if rec.get("is_maker") is False:
            stats["takers"] += 1
    elif event == "taker":
        # A live taker is counted when its confirmed non-maker fill arrives.
        pass
    elif event == "cancel":
        stats["cancels"] += 1
    elif event == "reset":
        stats["markets"] += 1
    elif event == "resolved" and summary is not None:
        if summary["fills"] == 0:
            summary["status"] = "无成交"
            return
        stats["settled_markets"] += 1
        summary["status"] = "已结算"
        if isinstance(rec.get("pnl"), (int, float)):
            value = float(rec["pnl"])
            stats["pnl"] = float(stats["pnl"] or 0) + value
            summary["pnl"] = value
    elif event == "stopped" and summary is not None:
        # The market did not reach its official resolution. Keep it visible,
        # but never count it as settled or include it in PnL.
        summary["status"] = "未结算（已停止）"
    elif event == "error":
        stats["error"] = str(rec.get("message") or rec.get("error") or "引擎错误")


def trade_log_stats() -> dict:
    """Incrementally summarize one journal, keeping long-running totals correct."""
    path = _trading_log
    # During startup the child process may not have created its journal yet.
    # Keep reporting the selected new journal instead of falling back to an
    # older run, which otherwise makes the first status response look stale.
    if path is not None and not path.is_file():
        empty = _new_trade_cache(path)["stats"]
        empty["market_summaries"] = []
        return empty
    if path is None:
        candidates = sorted(
            list((TRADING_ROOT / "results" / "paper").glob("dashboard-*.jsonl"))
            + list((TRADING_ROOT / "results" / "live").glob("dashboard-*.jsonl")),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        path = candidates[0] if candidates else None
    if not path or not path.is_file():
        return {**_new_trade_cache(Path(""))["stats"], "available": False, "file": None, "market_summaries": []}

    global _trade_cache
    try:
        size = path.stat().st_size
        reset_cache = _trade_cache.get("path") != str(path) or size < int(_trade_cache.get("offset", 0))
        if reset_cache:
            _trade_cache = _new_trade_cache(path)
        if reset_cache:
            # Rebuild totals from the complete journal once. Subsequent polls use
            # offsets, so a long-running dashboard stays cheap without losing the
            # beginning of a session after a dashboard restart.
            chunk = path.read_bytes()
            _trade_cache["offset"] = size
        else:
            with path.open("rb") as handle:
                handle.seek(int(_trade_cache["offset"]))
                chunk = handle.read()
                _trade_cache["offset"] = handle.tell()
        if chunk:
            pieces = (_trade_cache["fragment"] + chunk).split(b"\n")
            _trade_cache["fragment"] = pieces.pop()
            for raw in pieces:
                if not raw.strip():
                    continue
                try:
                    rec = json.loads(raw.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if isinstance(rec, dict):
                    _apply_trade_record(_trade_cache, rec)
    except OSError as exc:
        _trade_cache = _new_trade_cache(path)
        _trade_cache["stats"]["error"] = str(exc)

    stats = json.loads(json.dumps(_trade_cache["stats"]))
    if not stats["error"]:
        error_lines = [
            line.strip() for line in _tail_lines(path.with_suffix(".console.log"), count=100)
            if any(token in line for token in ("Error", "error", "Timeout", "failed"))
        ]
        if error_lines:
            stats["error"] = error_lines[-1][:300]
    if stats["pnl"] is not None:
        stats["pnl"] = round(float(stats["pnl"]), 6)
    stats["fill_notional"] = round(float(stats["fill_notional"]), 6)
    stats["fees"] = round(float(stats["fees"]), 6)
    stats["market_summaries"] = [
        {**item, "turnover": round(float(item["turnover"]), 6)}
        for item in sorted(_trade_cache["markets"].values(), key=lambda item: item["last_time"], reverse=True)[:50]
    ]
    return stats


def start_trading(payload: dict) -> dict:
    global _trading_process, _trading_pid, _trading_started_at, _trading_mode, _trading_params
    global _trading_log, _trading_console_log, _trading_exit_code, _trading_stop_result
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
        value = float(payload.get(name, default))
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
    duration_min = float(payload.get("duration_min", 15 if mode == "live" else 5))
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
        log_dir = TRADING_ROOT / "results" / ("live" if mode == "live" else "paper")
        log_dir.mkdir(parents=True, exist_ok=True)
        run_id = time.strftime("%Y%m%d-%H%M%S")
        _trading_log = log_dir / f"dashboard-{run_id}.jsonl"
        _trading_console_log = log_dir / f"dashboard-{run_id}.console.log"
        # Create the selected journal before returning the start response.
        # The status endpoint must never fall back to a previous run while the
        # child process is still starting.
        _trading_log.touch()
        console_handle = _trading_console_log.open("a", encoding="utf-8")
        args = [
            "node", "dist/cli/live.js", "run", "--paper" if mode == "paper" else "--live",
            "--order-usd", str(order_usd), "--max-orders", str(max_orders), "--pair-cost-max", str(pair_cost_max),
            "--max-total-usd", str(max_total_usd), "--duration-min", str(duration_min),
            "--maker-life-sec", str(maker_life_sec), "--decision-interval-ms", str(decision_interval_ms),
            "--defensive-cancel-bps", str(defensive_cancel_bps),
            "--log-file", str(_trading_log), "--traded-file", str(log_dir / "traded.jsonl"),
        ]
        env = os.environ.copy()
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
        _trading_pid = _trading_process.pid
        _trading_started_at = time.time()
        _trading_mode = mode
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
        return trading_status()


def stop_trading() -> dict:
    global _trading_process, _trading_pid, _trading_exit_code, _trading_stop_result
    _restore_trading_state()
    with _trading_lock:
        process = _trading_process
        restored_pid = _trading_pid if process is None else None
        candidate_pid = restored_pid or (process.pid if process else None)
        if process is None and not _process_matches(candidate_pid, _trading_log):
            _trading_stop_result = {
                "confirmed": False,
                "process_stopped": True,
                "message": "当前没有正在运行的交易任务。",
            }
            _persist_trading_state()
            return trading_status()
        if process is None and restored_pid and _process_matches(restored_pid, _trading_log):
            try:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(restored_pid), "/T"], timeout=10, check=False)
                else:
                    os.kill(restored_pid, signal.SIGTERM)
                deadline = time.monotonic() + 20
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
            except (ProcessLookupError, OSError):
                pass
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
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
            message = "停止未完成，请检查后台进程。"
        elif _trading_mode == "live":
            message = "进程已停止；实盘挂单尚未通过账户查询确认。"
        else:
            message = "模拟已停止，没有真实挂单。"
        _trading_stop_result = {"confirmed": confirmed, "process_stopped": stopped, "message": message}
        if stopped:
            _trading_process = None
            _trading_pid = None
        _persist_trading_state()
        return trading_status()


def main() -> int:
    parser = argparse.ArgumentParser(description="Local read-only strategy dashboard server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()
    root = Path(args.root).resolve()
    docs = root / "docs"
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("交易控制台只允许监听本机地址")

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
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
            if path == "/api/trading/log":
                status = trading_status()
                log_path = Path(status["log"]) if status.get("log") else None
                console_path = _trading_console_log
                lines: list[str] = []
                if log_path and log_path.is_file():
                    try:
                        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-100:]
                    except OSError:
                        lines = []
                console_lines: list[str] = []
                if console_path and console_path.is_file():
                    try:
                        console_lines = console_path.read_text(encoding="utf-8", errors="replace").splitlines()[-100:]
                    except OSError:
                        console_lines = []
                self._send_json(json.dumps({"log": lines, "console": console_lines, "status": status}, ensure_ascii=False).encode("utf-8"))
                return
            if path == "/api/live":
                self._send_json(json.dumps(live_status(), ensure_ascii=False).encode("utf-8"))
                return
            relative = "system-dashboard.html" if path in {"/", "/system-dashboard.html"} else path.lstrip("/")
            candidate = (docs / relative).resolve()
            if docs not in candidate.parents or not candidate.is_file():
                self.send_error(404)
                return
            body = candidate.read_bytes()
            content_type = "text/html; charset=utf-8" if candidate.suffix == ".html" else "text/plain; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, body: bytes, status: int = 200) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path not in {"/api/trading/start", "/api/trading/stop"}:
                self._send_json(b'{"error":"not found"}', 404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(max(0, min(length, 32_000)))
                payload = json.loads(raw.decode("utf-8") or "{}") if raw else {}
                if not isinstance(payload, dict):
                    raise ValueError("request body must be an object")
                mode = trading_status().get("mode") if path.endswith("/stop") else payload.get("mode")
                auth_error = _control_request_error(self.headers, mode)
                if auth_error:
                    status, message = auth_error
                    self._send_json(
                        json.dumps({"ok": False, "error": message}, ensure_ascii=False).encode("utf-8"),
                        status,
                    )
                    return
                result = stop_trading() if path.endswith("/stop") else start_trading(payload)
                self._send_json(json.dumps({"ok": True, "status": result}, ensure_ascii=False).encode("utf-8"))
            except PermissionError as exc:
                self._send_json(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8"), 403)
            except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as exc:
                self._send_json(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False).encode("utf-8"), 400)

        def log_message(self, *_: object) -> None:
            return

    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

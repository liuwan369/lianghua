"""The account profile (read-only here) and its read-only check. Responses never
include secret values. The operator writes the profile on the server; the
console never writes it."""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
from pathlib import Path

# Account settings the profile (and the engine's .env) may carry.
ACCOUNT_ENV_FIELDS = ("POLYMARKET_WALLET_ADDRESS", "POLY_FUNDER", "POLY_SIGNATURE_TYPE",
                      "POLYMARKET_OWNER_PRIVATE_KEY", "POLYMARKET_SESSION_PRIVATE_KEY",
                      "RELAYER_API_KEY", "RELAYER_API_KEY_ADDRESS",
                      "POLY_BUILDER_API_KEY", "POLY_BUILDER_SECRET", "POLY_BUILDER_PASSPHRASE")
LEGACY_OWNER_FIELD = "POLYMARKET_PRIVATE_KEY"
# The retired console password. A profile copied from the old box may still
# carry it; it is dropped on read and never used.
RETIRED_PROFILE_FIELDS = frozenset({"PM_DASHBOARD_CONTROL_TOKEN"})
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
KEY = re.compile(r"(?:0x)?[0-9a-fA-F]{64}\Z")


class AccountCheckError(RuntimeError):
    """Safe diagnostic categories; never include child output or submitted keys."""

    def __init__(self, code: str):
        errors = {
            "invalid_account_config": (400, False, "钱包地址或签名私钥不可用，请核对服务器上的账户配置文件。"),
            "account_rpc_timeout": (504, True, "链上查询超时，未能完成账户检查，请稍后重试。"),
            "account_rpc_failed": (503, True, "链上查询节点暂时不可用，请稍后重试。"),
            "account_check_failed": (503, True, "账户检查服务暂时未能完成查询，请稍后重试。"),
            "account_checker_unavailable": (503, False, "服务器账户检查程序不可用，请联系管理员。"),
            "account_engine_missing": (503, False, "服务器交易引擎目录不存在，请联系管理员。"),
            "account_reader_build_missing": (503, False, "服务器账户检查程序尚未构建，请联系管理员。"),
            "account_node_missing": (503, False, "服务器 Node.js 运行时不可用，请联系管理员。"),
            "account_response_invalid": (502, False, "账户检查返回数据不完整，请重试。"),
            "account_check_busy": (429, True, "账户检查正在进行，请等待完成后重试。"),
        }
        self.code = code
        self.http_status, self.retryable, message = errors[code]
        super().__init__(message)


def profile_path() -> Path:
    return Path(os.environ.get("PM_ACCOUNT_PROFILE", str(Path.home() / ".config" / "pm-system" / "account.json")))


def load_profile() -> dict | None:
    path = profile_path()
    if path.is_symlink():
        raise RuntimeError("账户配置路径不安全，已停止使用旧配置。")
    if not path.exists():
        return None
    try:
        if path.is_symlink() or (os.name != "nt" and path.stat().st_mode & 0o077):
            raise ValueError()
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or set(data) - (set(ACCOUNT_ENV_FIELDS) | {LEGACY_OWNER_FIELD} | RETIRED_PROFILE_FIELDS):
            raise ValueError()
        if any(not isinstance(v, str) for v in data.values()):
            raise ValueError()
        return {name: value for name, value in data.items() if name not in RETIRED_PROFILE_FIELDS}
    except (ValueError, OSError):
        raise RuntimeError("账户配置无法安全读取，请检查文件权限；已停止使用旧配置。") from None


def child_environment(values: dict) -> dict:
    """Inject the same account identity into both read-only child processes."""
    env = os.environ.copy()
    protected = set(ACCOUNT_ENV_FIELDS) | {LEGACY_OWNER_FIELD}
    for name in list(env):
        upper = name.upper()
        if name not in protected and any(marker in upper for marker in
                                         ("TOKEN", "SECRET", "PRIVATE_KEY", "API_KEY", "PASSWORD", "PASSPHRASE", "AUTHORIZATION")):
            env.pop(name, None)
    for name in (*ACCOUNT_ENV_FIELDS, LEGACY_OWNER_FIELD, "PM_TRADING_LIVE_UNLOCK"):
        env.pop(name, None)
    clean = {name: value.strip().strip("'\"").strip() for name, value in values.items()
             if name in {*ACCOUNT_ENV_FIELDS, LEGACY_OWNER_FIELD} and isinstance(value, str)}
    env.update(clean)
    if not env.get("POLYMARKET_OWNER_PRIVATE_KEY") and clean.get(LEGACY_OWNER_FIELD):
        env["POLYMARKET_OWNER_PRIVATE_KEY"] = clean[LEGACY_OWNER_FIELD]
    if not env.get("POLYMARKET_WALLET_ADDRESS") and clean.get("POLY_FUNDER"):
        env["POLYMARKET_WALLET_ADDRESS"] = clean["POLY_FUNDER"]
    # Reuse compiled modules, never account results or submitted credentials.
    # Keep this performance setting scoped to the read-only checker process.
    compile_cache = os.environ.get("PM_ACCOUNT_NODE_COMPILE_CACHE", "").strip()
    if compile_cache:
        env["NODE_COMPILE_CACHE"] = compile_cache
    # Account diagnostics can use a separate RPC without changing the engine's
    # trading environment. The child never receives it from a browser payload.
    account_rpc = os.environ.get("PM_ACCOUNT_RPC_URL", "").strip()
    if account_rpc:
        env["POLYGON_RPC"] = account_rpc
    return env


def contains_secret(value, values: dict) -> bool:
    """Reject unexpected private fields or credential echoes before caching output."""
    public = {"POLYMARKET_WALLET_ADDRESS", "POLY_FUNDER", "POLY_SIGNATURE_TYPE", "RELAYER_API_KEY_ADDRESS"}
    secrets = [item.strip().strip("'\"").strip() for key, item in values.items()
               if key not in public and isinstance(item, str) and len(item.strip()) >= 8]
    # `token` is also a public chain-data field (for example, a token
    # contract address in fee and transfer evidence).  Match credential
    # fields explicitly while leaving public asset identifiers inspectable.
    private_names = {"private_key", "privatekey", "owner_key", "session_private_key", "secret",
                     "api_key", "apikey", "passphrase", "authorization", "headers", "env"}
    environment_names = {*ACCOUNT_ENV_FIELDS, LEGACY_OWNER_FIELD}

    def visit(item):
        if isinstance(item, dict):
            return any(str(key).lower() in private_names or str(key).upper() in environment_names
                       or visit(child) for key, child in item.items())
        if isinstance(item, list):
            return any(visit(child) for child in item)
        if isinstance(item, str):
            return any(secret and secret in item for secret in secrets)
        return False
    return visit(value)


def _public_check_report(report: dict, values: dict) -> dict:
    allowed = {"wallet", "owner", "signer_matches", "compromised", "balance", "approvals_ready", "account_ready", "checks", "checked_at", "read_only",
               "wallet_kind", "signature_type", "settlement_credentials_ready", "settlement_reason", "clob_balance", "clob_balance_status"}
    if (not isinstance(report, dict) or set(report) - allowed or contains_secret(report, values)
            or report.get("read_only") is not True or not isinstance(report.get("checks"), list)):
        raise AccountCheckError("account_response_invalid")
    for name in ("wallet", "owner"):
        if report.get(name) is not None and (not isinstance(report[name], str) or not ADDRESS.fullmatch(report[name])):
            raise AccountCheckError("account_response_invalid")
    target_wallet = values.get("POLYMARKET_WALLET_ADDRESS") or values.get("POLY_FUNDER", "")
    if str(report.get("wallet", "")).lower() != target_wallet.strip().strip("'\"").strip().lower():
        raise AccountCheckError("account_response_invalid")
    for name in ("signer_matches", "compromised", "account_ready"):
        if not isinstance(report.get(name), bool):
            raise AccountCheckError("account_response_invalid")
    for name in ("approvals_ready", "settlement_credentials_ready"):
        if report.get(name) is not None and not isinstance(report[name], bool):
            raise AccountCheckError("account_response_invalid")
    for name in ("balance", "clob_balance"):
        if report.get(name) is not None and (type(report[name]) not in (int, float) or not math.isfinite(report[name]) or report[name] < 0):
            raise AccountCheckError("account_response_invalid")
    for name in ("checked_at", "wallet_kind", "signature_type", "settlement_reason", "clob_balance_status"):
        if report.get(name) is not None and (not isinstance(report[name], (str, int)) or isinstance(report[name], bool)):
            raise AccountCheckError("account_response_invalid")
    for item in report["checks"]:
        if (not isinstance(item, dict) or set(item) - {"name", "ok", "detail"}
                or not isinstance(item.get("name"), str) or not isinstance(item.get("ok"), bool)
                or not isinstance(item.get("detail"), str)):
            raise AccountCheckError("account_response_invalid")
    return report


def check_account(engine: Path, values: dict) -> dict:
    env = child_environment(values)
    engine = Path(engine).resolve()
    if not engine.is_dir():
        raise AccountCheckError("account_engine_missing")
    if not (engine / "dist" / "cli" / "account-check.js").is_file():
        raise AccountCheckError("account_reader_build_missing")
    node = shutil.which("node")
    if not node:
        raise AccountCheckError("account_node_missing")
    rpcs = [env.get("POLYGON_RPC", "")]
    fallback = os.environ.get("PM_ACCOUNT_RPC_FALLBACK_URL", "").strip()
    if fallback and fallback not in rpcs:
        rpcs.append(fallback)
    # Bound both attempts inside the browser/proxy deadline. Only the read-only
    # checker is retried.
    for index, rpc in enumerate(rpcs):
        child_env = dict(env)
        if rpc:
            child_env["POLYGON_RPC"] = rpc
        timeout = (25 if index == 0 else 20) if len(rpcs) > 1 else 45
        try:
            result = subprocess.run([node, "dist/cli/account-check.js"], cwd=engine, env=child_env,
                                    capture_output=True, text=True, encoding="utf-8", timeout=timeout)
        except subprocess.TimeoutExpired:
            failure = AccountCheckError("account_rpc_timeout")
        except UnicodeError:
            raise AccountCheckError("account_response_invalid") from None
        except FileNotFoundError:
            raise AccountCheckError("account_checker_unavailable") from None
        except (OSError, subprocess.SubprocessError):
            raise AccountCheckError("account_checker_unavailable") from None
        else:
            try:
                report = json.loads(result.stdout)
            except (ValueError, UnicodeError):
                report = None
            if result.returncode != 0:
                code = report.get("error_code") if isinstance(report, dict) else None
                if code == "invalid_account_config":
                    raise AccountCheckError(code)
                failure = AccountCheckError("account_rpc_failed" if code == "account_rpc_failed" else "account_check_failed")
            else:
                report = _public_check_report(report, values)
                if report.get("approvals_ready", False) is None:
                    # Unknown means an RPC query failed, unlike False which
                    # is a completed query confirming missing approvals.
                    failure = AccountCheckError("account_rpc_failed")
                else:
                    return report
        if index == len(rpcs) - 1:
            raise failure from None
    raise AccountCheckError("account_check_failed")

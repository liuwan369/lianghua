"""Single-operator account onboarding. Responses never include secret values."""
from __future__ import annotations

import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

FIELDS = {
    "wallet": "POLYMARKET_WALLET_ADDRESS",
    "funder": "POLY_FUNDER",
    "signature_type": "POLY_SIGNATURE_TYPE",
    "owner_key": "POLYMARKET_OWNER_PRIVATE_KEY",
    "session_private_key": "POLYMARKET_SESSION_PRIVATE_KEY",
    "relayer_key": "RELAYER_API_KEY",
    "relayer_address": "RELAYER_API_KEY_ADDRESS",
    "builder_api_key": "POLY_BUILDER_API_KEY",
    "builder_secret": "POLY_BUILDER_SECRET",
    "builder_passphrase": "POLY_BUILDER_PASSPHRASE",
}
CONTROL_FIELD = "PM_DASHBOARD_CONTROL_TOKEN"
PROFILE_FIELDS = {**FIELDS, "control_token": CONTROL_FIELD}
ACCOUNT_ENV_FIELDS = tuple(FIELDS.values())
LEGACY_OWNER_FIELD = "POLYMARKET_PRIVATE_KEY"
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
KEY = re.compile(r"(?:0x)?[0-9a-fA-F]{64}\Z")


class AccountCheckError(RuntimeError):
    """Safe diagnostic categories; never include child output or submitted keys."""

    def __init__(self, code: str):
        errors = {
            "invalid_account_config": (400, False, "钱包地址或签名私钥不可用，请核对填写内容；没有保存账户。"),
            "account_rpc_timeout": (504, True, "链上查询超时，未能完成账户检查；没有保存账户，请稍后重试。"),
            "account_rpc_failed": (503, True, "链上查询节点暂时不可用；没有保存账户，请稍后重试。"),
            "account_check_failed": (503, True, "账户检查服务暂时未能完成查询；没有保存账户，请稍后重试。"),
            "account_checker_unavailable": (503, False, "服务器账户检查程序不可用；没有保存账户，请联系管理员。"),
            "account_engine_missing": (503, False, "服务器交易引擎目录不存在；没有保存账户，请联系管理员。"),
            "account_reader_build_missing": (503, False, "服务器账户检查程序尚未构建；没有保存账户，请联系管理员。"),
            "account_node_missing": (503, False, "服务器 Node.js 运行时不可用；没有保存账户，请联系管理员。"),
            "account_response_invalid": (502, False, "账户检查返回数据不完整；没有保存账户，请重试。"),
            "account_check_busy": (429, True, "已有账户检查或保存正在进行，请等待完成后重试。"),
            "account_changed_during_check": (409, True, "检查期间服务器账户配置已变更；没有保存账户，请重新检查。"),
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
        if not isinstance(data, dict) or set(data) - (set(PROFILE_FIELDS.values()) | {LEGACY_OWNER_FIELD}):
            raise ValueError()
        if any(not isinstance(v, str) for v in data.values()):
            raise ValueError()
        return data
    except (ValueError, OSError):
        raise RuntimeError("账户配置无法安全读取，请检查文件权限；已停止使用旧配置。") from None


def candidate_profile(payload: dict, previous: dict) -> dict:
    if set(payload) - set(PROFILE_FIELDS):
        raise ValueError("账户参数不支持，请刷新页面后重试")
    if any(not isinstance(v, str) for v in payload.values()):
        raise ValueError("账户字段必须是文本")
    wallet = payload.get("wallet", "").strip()
    if not ADDRESS.fullmatch(wallet):
        raise ValueError("请填写完整的资金钱包地址（0x 开头）")
    # Switching accounts must not silently carry the old account's secrets.
    previous = {name: value if name == CONTROL_FIELD else value.strip().strip("'\"").strip() for name, value in previous.items()
                if isinstance(value, str)}
    same = wallet.lower() == (previous.get("POLYMARKET_WALLET_ADDRESS") or previous.get("POLY_FUNDER", "")).lower()
    # The control password belongs to this local account profile, but is
    # independent of the wallet identity and must survive an account switch.
    result = dict(previous) if same else {CONTROL_FIELD: previous.get(CONTROL_FIELD, "")}
    if same and not result.get("POLYMARKET_OWNER_PRIVATE_KEY") and result.get(LEGACY_OWNER_FIELD):
        result["POLYMARKET_OWNER_PRIVATE_KEY"] = result[LEGACY_OWNER_FIELD]
    result["POLYMARKET_WALLET_ADDRESS"] = wallet
    for field, env_name in FIELDS.items():
        value = payload.get(field, "").strip()
        if value:
            result[env_name] = value
    if "control_token" in payload:
        token = payload.get("control_token", "").strip()
        if token and len(token) > 1024:
            raise ValueError("交易控制密码过长")
        result[CONTROL_FIELD] = token
    key = result.get("POLYMARKET_OWNER_PRIVATE_KEY", "")
    if key and not KEY.fullmatch(key):
        raise ValueError("订单签名私钥格式错误，请检查是否混入说明文字")
    session_key = result.get("POLYMARKET_SESSION_PRIVATE_KEY", "")
    if session_key and not KEY.fullmatch(session_key):
        raise ValueError("Session 签名私钥格式错误")
    funder = result.get("POLY_FUNDER", "")
    if funder and not ADDRESS.fullmatch(funder):
        raise ValueError("资金账户地址格式错误")
    signature = result.get("POLY_SIGNATURE_TYPE", "")
    if signature and signature not in {"0", "1", "2", "3"}:
        raise ValueError("签名类型必须为 0、1、2 或 3")
    relayer = result.get("RELAYER_API_KEY", "")
    addr = result.get("RELAYER_API_KEY_ADDRESS", "")
    if bool(relayer) != bool(addr):
        raise ValueError("Relayer 密钥与对应地址需要一起填写")
    if relayer and not re.fullmatch(r"[A-Za-z0-9._~+/=-]{16,256}", relayer):
        raise ValueError("Relayer 密钥格式错误，请去掉说明文字")
    if addr and not ADDRESS.fullmatch(addr):
        raise ValueError("Relayer 地址格式错误")
    builder_values = [result.get(name, "") for name in (
        "POLY_BUILDER_API_KEY", "POLY_BUILDER_SECRET", "POLY_BUILDER_PASSPHRASE"
    )]
    if any(value and any(char.isspace() for char in value) for value in builder_values):
        raise ValueError("Builder 凭据不能包含空白字符")
    if any(builder_values) and not all(builder_values):
        raise ValueError("Builder API Key、Secret 和 Passphrase 需要一起填写")
    if any(len(value) > 512 for value in builder_values):
        raise ValueError("Builder 凭据长度超出限制")
    return {name: result.get(name, "") for name in PROFILE_FIELDS.values()}


def child_environment(values: dict) -> dict:
    """Inject the same account identity into both read-only child processes."""
    env = os.environ.copy()
    protected = set(ACCOUNT_ENV_FIELDS) | {LEGACY_OWNER_FIELD, CONTROL_FIELD}
    for name in list(env):
        upper = name.upper()
        if name not in protected and any(marker in upper for marker in
                                         ("TOKEN", "SECRET", "PRIVATE_KEY", "API_KEY", "PASSWORD", "PASSPHRASE", "AUTHORIZATION")):
            env.pop(name, None)
    for name in (*ACCOUNT_ENV_FIELDS, LEGACY_OWNER_FIELD, CONTROL_FIELD, "PM_TRADING_LIVE_UNLOCK"):
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
    environment_names = {*ACCOUNT_ENV_FIELDS, LEGACY_OWNER_FIELD, CONTROL_FIELD}

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
    # checker is retried; persistence runs once after a successful check.
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


def save_profile(values: dict) -> None:
    if os.name == "nt":
        raise RuntimeError("请在部署到服务器的 HTTPS 页面保存账户；Windows 开发页面只提供检查。")
    _write_profile(values)


def _write_profile(values: dict) -> None:
    """Atomically write the private profile on the local server."""
    path = profile_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.parent.is_symlink():
        raise RuntimeError("账户配置路径不安全")
    os.chmod(path.parent, 0o700)
    fd, temporary = tempfile.mkstemp(prefix=".account-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            os.chmod(temporary, 0o600)
            json.dump(values, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_control_token(token: str) -> None:
    """Persist the dashboard control password in the private account profile."""
    value = token.strip()
    if not value:
        raise ValueError("交易控制密码不能为空")
    if len(value) > 1024:
        raise ValueError("交易控制密码过长")
    previous = load_profile() or {}
    previous[CONTROL_FIELD] = value
    # Control-session persistence is also useful on the Windows development
    # console; account signing secrets remain Linux-server-only via
    # save_profile above.
    _write_profile({name: previous[name] for name in PROFILE_FIELDS.values() if name in previous})


def saved_control_token() -> str:
    """Read the persisted control password without exposing the account profile."""
    profile = load_profile()
    return profile.get(CONTROL_FIELD, "").strip() if profile else ""

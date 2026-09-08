"""Single-operator account onboarding. Responses never include secret values."""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

FIELDS = {
    "wallet": "POLYMARKET_WALLET_ADDRESS",
    "owner_key": "POLYMARKET_OWNER_PRIVATE_KEY",
    "relayer_key": "RELAYER_API_KEY",
    "relayer_address": "RELAYER_API_KEY_ADDRESS",
}
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}\Z")
KEY = re.compile(r"(?:0x)?[0-9a-fA-F]{64}\Z")


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
        if not isinstance(data, dict) or set(data) - set(FIELDS.values()):
            raise ValueError()
        if any(not isinstance(v, str) for v in data.values()):
            raise ValueError()
        return data
    except (ValueError, OSError):
        raise RuntimeError("账户配置无法安全读取，请检查文件权限；已停止使用旧配置。") from None


def candidate_profile(payload: dict, previous: dict) -> dict:
    if set(payload) - set(FIELDS):
        raise ValueError("账户参数不支持，请刷新页面后重试")
    if any(not isinstance(v, str) for v in payload.values()):
        raise ValueError("账户字段必须是文本")
    wallet = payload.get("wallet", "").strip()
    if not ADDRESS.fullmatch(wallet):
        raise ValueError("请填写完整的资金钱包地址（0x 开头）")
    # Switching accounts must not silently carry the old account's secrets.
    same = wallet.lower() == previous.get("POLYMARKET_WALLET_ADDRESS", "").lower()
    result = dict(previous) if same else {}
    result["POLYMARKET_WALLET_ADDRESS"] = wallet
    for field, env_name in FIELDS.items():
        value = payload.get(field, "").strip()
        if value:
            result[env_name] = value
    key = result.get("POLYMARKET_OWNER_PRIVATE_KEY", "")
    if key and not KEY.fullmatch(key):
        raise ValueError("订单签名私钥格式错误，请检查是否混入说明文字")
    relayer = result.get("RELAYER_API_KEY", "")
    addr = result.get("RELAYER_API_KEY_ADDRESS", "")
    if bool(relayer) != bool(addr):
        raise ValueError("Relayer 密钥与对应地址需要一起填写")
    if relayer and not re.fullmatch(r"[A-Za-z0-9._~+/=-]{16,256}", relayer):
        raise ValueError("Relayer 密钥格式错误，请去掉说明文字")
    if addr and not ADDRESS.fullmatch(addr):
        raise ValueError("Relayer 地址格式错误")
    return {name: result.get(name, "") for name in FIELDS.values()}


def check_account(engine: Path, values: dict) -> dict:
    env = os.environ.copy()
    # No dotenv import in account-check: old private keys cannot leak into it.
    for name in ("POLYMARKET_PRIVATE_KEY", "POLYMARKET_SESSION_PRIVATE_KEY", "POLY_FUNDER", "POLY_SIGNATURE_TYPE"):
        env.pop(name, None)
    env.update({name: values.get(name, "") for name in FIELDS.values()})
    try:
        result = subprocess.run(["node", "dist/cli/account-check.js"], cwd=engine, env=env,
                                capture_output=True, text=True, encoding="utf-8", timeout=45)
        if result.returncode != 0:
            raise ValueError()
        report = json.loads(result.stdout)
        allowed = {"wallet", "owner", "signer_matches", "compromised", "balance", "approvals_ready", "account_ready", "checks", "checked_at", "read_only"}
        if not isinstance(report, dict) or set(report) - allowed or not isinstance(report.get("checks"), list):
            raise ValueError()
        return report
    except (subprocess.SubprocessError, OSError, ValueError):
        # Never include stderr/stdout: upstream libraries may log request data.
        raise RuntimeError("账户检查未完成，请检查地址、网络或稍后重试；没有修改账户。") from None


def save_profile(values: dict) -> None:
    if os.name == "nt":
        raise RuntimeError("请在部署到服务器的 HTTPS 页面保存账户；Windows 开发页面只提供检查。")
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

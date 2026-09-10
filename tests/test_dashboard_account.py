from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "system-dashboard-server.py"
SPEC = importlib.util.spec_from_file_location("dashboard_onboarding_test", SCRIPT)
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)
STORE = SERVER.account_store
A = "0x" + "1" * 40
B = "0x" + "2" * 40


def test_switch_account_cannot_inherit_previous_secrets():
    old = {"POLYMARKET_WALLET_ADDRESS": A, "POLYMARKET_OWNER_PRIVATE_KEY": "0x" + "1" * 64,
           "RELAYER_API_KEY": "secret-test-key-value", "RELAYER_API_KEY_ADDRESS": A}
    switched = STORE.candidate_profile({"wallet": B}, old)
    assert switched["POLYMARKET_OWNER_PRIVATE_KEY"] == ""
    assert switched["RELAYER_API_KEY"] == ""
    assert STORE.candidate_profile({"wallet": A}, old) == old


@pytest.mark.parametrize("payload", [
    {"wallet": A, "owner_key": "bad secret value"},
    {"wallet": A, "owner_key": "0x" + "1" * 64 + "\nLIVE=true"},
    {"wallet": A, "relayer_key": "test-test-test-test"},
    {"wallet": A, "unknown": "unsafe"},
    {"wallet": A, "owner_key": ["secret"]},
])
def test_invalid_profile_rejected_without_echo(payload):
    with pytest.raises(ValueError) as caught:
        STORE.candidate_profile(payload, {})
    assert "bad secret value" not in str(caught.value)
    assert "LIVE=true" not in str(caught.value)


def test_check_failure_does_not_echo_child_output(monkeypatch, tmp_path):
    def failure(*args, **kwargs):
        return SimpleNamespace(returncode=1, stdout="PRIVATE KEY contents", stderr="RELAYER KEY contents")
    monkeypatch.setattr(STORE.subprocess, "run", failure)
    with pytest.raises(RuntimeError) as caught:
        STORE.check_account(tmp_path, {})
    assert "contents" not in str(caught.value)


def test_check_does_not_inherit_old_account(monkeypatch, tmp_path):
    monkeypatch.setenv("POLYMARKET_PRIVATE_KEY", "old-secret")
    monkeypatch.setenv("POLYMARKET_SESSION_PRIVATE_KEY", "old-session")
    monkeypatch.setenv("POLY_FUNDER", A)
    monkeypatch.setenv("POLYMARKET_OWNER_PRIVATE_KEY", "old-owner")
    def run(*args, **kwargs):
        env = kwargs["env"]
        assert "POLYMARKET_PRIVATE_KEY" not in env
        assert "POLYMARKET_SESSION_PRIVATE_KEY" not in env
        assert "POLY_FUNDER" not in env
        assert env["POLYMARKET_OWNER_PRIVATE_KEY"] == ""
        assert env["POLYMARKET_WALLET_ADDRESS"] == B
        return SimpleNamespace(returncode=0, stdout=json.dumps({"checks": [], "wallet": B}))
    monkeypatch.setattr(STORE.subprocess, "run", run)
    assert STORE.check_account(tmp_path, {"POLYMARKET_WALLET_ADDRESS": B})["wallet"] == B


def test_account_rpc_override_is_local_to_read_only_child(monkeypatch, tmp_path):
    monkeypatch.setenv("POLYGON_RPC", "https://trading.example.test")
    monkeypatch.setenv("PM_ACCOUNT_RPC_URL", "https://account.example.test")

    def run(*args, **kwargs):
        assert kwargs["env"]["POLYGON_RPC"] == "https://account.example.test"
        return SimpleNamespace(returncode=0, stdout=json.dumps({"wallet": B, "checks": [], "read_only": True}))

    monkeypatch.setattr(STORE.subprocess, "run", run)
    assert STORE.check_account(tmp_path, {"POLYMARKET_WALLET_ADDRESS": B})["read_only"] is True
    assert os.environ["POLYGON_RPC"] == "https://trading.example.test"


def test_invalid_saved_profile_never_falls_back_to_environment(monkeypatch, tmp_path):
    target = tmp_path / "account.json"
    target.write_text("invalid json")
    monkeypatch.setenv("PM_ACCOUNT_PROFILE", str(target))
    monkeypatch.setenv("POLYMARKET_OWNER_PRIVATE_KEY", "0x" + "1" * 64)
    monkeypatch.setenv("POLYMARKET_WALLET_ADDRESS", A)
    assert SERVER.account_config_status()["execution_credentials_ready"] is False
    assert SERVER.account_config_status()["config_error"]


def test_dangling_symlink_is_not_absent_profile(monkeypatch, tmp_path):
    link = tmp_path / "account.json"
    try:
        link.symlink_to(tmp_path / "missing")
    except OSError:
        pytest.skip("symlink permission unavailable")
    monkeypatch.setenv("PM_ACCOUNT_PROFILE", str(link))
    with pytest.raises(RuntimeError):
        STORE.load_profile()


@pytest.mark.skipif(os.name == "nt", reason="production persistence is Linux-only")
def test_profile_saved_atomically_with_private_permissions(monkeypatch, tmp_path):
    target = tmp_path / "private" / "account.json"
    monkeypatch.setenv("PM_ACCOUNT_PROFILE", str(target))
    values = STORE.candidate_profile({"wallet": A}, {})
    STORE.save_profile(values)
    assert STORE.load_profile() == values
    assert target.stat().st_mode & 0o777 == 0o600
    assert target.parent.stat().st_mode & 0o777 == 0o700
    assert list(target.parent.iterdir()) == [target]


def test_account_http_requires_verified_https_login_or_local_control(monkeypatch):
    monkeypatch.delenv("PM_TRUST_ACCOUNT_PROXY", raising=False)
    h = {"Content-Type": "application/json", "Origin": "https://example.test:80", "Host": "example.test:80",
         "X-Forwarded-Proto": "https", "X-PM-Authenticated": "operator"}
    assert SERVER._account_request_error(h)[0] == 403
    monkeypatch.setenv("PM_TRUST_ACCOUNT_PROXY", "1")
    assert SERVER._account_request_error(h) is None
    assert SERVER._account_request_error({**h, "Origin": "https://evil.test"})[0] == 403
    assert SERVER._account_request_error({**h, "Origin": ""})[0] == 403
    assert SERVER._account_request_error({**h, "X-PM-Authenticated": ""})[0] == 403
    monkeypatch.setenv("PM_DASHBOARD_CONTROL_TOKEN", "local-control")
    local = {"Content-Type": "application/json", "Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765"}
    assert SERVER._account_request_error(local)[0] == 401
    assert SERVER._account_request_error({**local, "X-PM-Control-Token": "local-control"}) is None


def test_failed_or_compromised_identity_never_saved(monkeypatch):
    monkeypatch.setattr(SERVER, "trading_status", lambda **kw: {"running": False})
    monkeypatch.setattr(SERVER, "_account_values", lambda: {})
    called = []
    monkeypatch.setattr(STORE, "save_profile", lambda v: called.append(v))
    for check in ({"signer_matches": False}, {"signer_matches": True, "compromised": True}):
        monkeypatch.setattr(STORE, "check_account", lambda *a: check)
        with pytest.raises(ValueError):
            SERVER.account_action({"wallet": A, "owner_key": "0x" + "1" * 64}, save=True)
    assert not called


def test_changing_account_is_blocked_during_run(monkeypatch):
    monkeypatch.setattr(SERVER, "trading_status", lambda **kw: {"running": True})
    with pytest.raises(ValueError, match="先停止"):
        SERVER.account_action({"wallet": A}, save=True)


def test_saving_account_removes_current_unlock(monkeypatch):
    monkeypatch.setattr(SERVER, "trading_status", lambda **kw: {"running": False})
    monkeypatch.setattr(SERVER, "_account_values", lambda: {})
    monkeypatch.setattr(STORE, "check_account", lambda *a: {"signer_matches": True})
    monkeypatch.setattr(STORE, "save_profile", lambda *a: None)
    monkeypatch.setenv("PM_TRADING_LIVE_UNLOCK", "1")
    SERVER.account_action({"wallet": A}, save=True)
    assert "PM_TRADING_LIVE_UNLOCK" not in os.environ


def test_empty_save_rejected(monkeypatch):
    monkeypatch.setattr(SERVER, "trading_status", lambda **kw: {"running": False})
    monkeypatch.setattr(SERVER, "_account_values", lambda: {"POLYMARKET_WALLET_ADDRESS": A})
    with pytest.raises(ValueError, match="完整"):
        SERVER.account_action({}, save=True)


def test_executor_receives_checked_wallet_not_old_funder(monkeypatch):
    monkeypatch.setenv("POLY_FUNDER", A)
    monkeypatch.setenv("POLY_SIGNATURE_TYPE", "1")
    monkeypatch.setattr(SERVER, "_account_values", lambda: {"POLYMARKET_WALLET_ADDRESS": B, "POLY_FUNDER": ""})
    env = SERVER._trading_environment()
    assert env["POLY_FUNDER"] == B
    assert env["POLY_SIGNATURE_TYPE"] == ""


def test_live_start_rechecks_unlock_after_acquiring_lock(monkeypatch, tmp_path):
    cli = tmp_path / "dist" / "cli" / "live.js"
    cli.parent.mkdir(parents=True)
    cli.touch()
    monkeypatch.setattr(SERVER, "TRADING_ROOT", tmp_path)
    monkeypatch.setenv("PM_TRADING_LIVE_UNLOCK", "1")
    monkeypatch.setattr(SERVER, "private_key_configured", lambda: True)
    monkeypatch.setattr(SERVER, "_restore_trading_state", lambda: None)
    monkeypatch.setattr(SERVER, "_process_matches", lambda *a: False)
    monkeypatch.setattr(SERVER, "_trading_process", None)
    class RevokedWhileWaiting:
        def __enter__(self):
            os.environ.pop("PM_TRADING_LIVE_UNLOCK")
        def __exit__(self, *args):
            return False
    monkeypatch.setattr(SERVER, "_trading_lock", RevokedWhileWaiting())
    with pytest.raises(PermissionError, match="已变化"):
        SERVER.start_trading({"mode": "live", "confirm_live": True})

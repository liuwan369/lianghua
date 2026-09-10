"""Public account enrollment is explicit and does not authorize trading."""
from __future__ import annotations

import http.client
import importlib.util
import json
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "system-dashboard-server.py"
SPEC = importlib.util.spec_from_file_location("dashboard_public_account_test", SCRIPT)
SERVER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SERVER
SPEC.loader.exec_module(SERVER)
ORIGIN = "https://example.test"
WALLET = "0x" + "2" * 40
HEADERS = {
    "Content-Type": "application/json",
    "Origin": ORIGIN,
    "Host": "example.test",
    "X-Forwarded-Proto": "https",
}


@pytest.fixture
def public_access(monkeypatch):
    monkeypatch.setenv("PM_ACCOUNT_PUBLIC_ORIGIN", ORIGIN)
    monkeypatch.setenv("PM_TRUST_ACCOUNT_PROXY", "1")
    monkeypatch.delenv("PM_DASHBOARD_CONTROL_TOKEN", raising=False)
    monkeypatch.delenv("PM_TRADING_LIVE_UNLOCK", raising=False)


@pytest.fixture
def account_http(public_access, monkeypatch, tmp_path):
    """Use an ephemeral local listener, in-memory profiles, and no chain calls."""
    checks, saved = [], []
    monkeypatch.setattr(SERVER, "_account_values", lambda: {})
    monkeypatch.setattr(SERVER, "trading_status", lambda **kw: {"running": False, "mode": "live"})
    monkeypatch.setattr(SERVER, "_account_report", {})

    def check(_root, values):
        checks.append(dict(values))
        return {"wallet": values["POLYMARKET_WALLET_ADDRESS"], "signer_matches": True, "checks": []}

    monkeypatch.setattr(SERVER.account_store, "check_account", check)
    monkeypatch.setattr(SERVER.account_store, "save_profile", lambda values: saved.append(dict(values)))
    server = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.make_handler(tmp_path))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def post(path, payload, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        try:
            conn.request("POST", path, json.dumps(payload), headers=HEADERS if headers is None else headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    try:
        yield post, checks, saved
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_public_enrollment_requires_explicit_opt_in(public_access, monkeypatch):
    assert SERVER._account_request_error(HEADERS) is None
    monkeypatch.delenv("PM_ACCOUNT_PUBLIC_ORIGIN")
    assert SERVER._account_request_error(HEADERS)[0] == 403
    assert SERVER._account_request_error({**HEADERS, "X-PM-Authenticated": "operator"}) is None


@pytest.mark.parametrize("changes", [
    {"Origin": "https://evil.test"},
    {"Origin": ""},
    {"Host": "evil.test"},
    {"Origin": "http://example.test", "X-Forwarded-Proto": "http"},
    {"X-Forwarded-Proto": "http"},
    {"X-Forwarded-Proto": ""},
    {"Origin": "https://example.test/other"},
    {"Origin": "https://example.test:444", "Host": "example.test:444"},
])
def test_public_enrollment_rejects_wrong_origin_or_transport(account_http, changes):
    post, checks, saved = account_http
    for path in ("/api/account/check", "/api/account/save"):
        status, result = post(path, {"wallet": WALLET}, {**HEADERS, **changes})
        assert status == 403, result
        assert result["ok"] is False
    assert checks == saved == []


def test_public_enrollment_rejects_untrusted_proxy(account_http, monkeypatch):
    post, checks, saved = account_http
    monkeypatch.delenv("PM_TRUST_ACCOUNT_PROXY")
    status, result = post("/api/account/save", {"wallet": WALLET})
    assert status == 403, result
    assert checks == saved == []


def test_public_enrollment_requires_json(account_http):
    post, checks, saved = account_http
    status, result = post("/api/account/save", {"wallet": WALLET}, {**HEADERS, "Content-Type": "text/plain"})
    assert status == 415, result
    assert checks == saved == []


def test_public_account_check_does_not_persist(account_http):
    post, checks, saved = account_http
    status, result = post("/api/account/check", {"wallet": WALLET})
    assert status == 200, result
    assert result["ok"] is True
    assert result["report"]["wallet"] == WALLET
    assert len(checks) == 1
    assert saved == []


def test_public_account_save_persists_checked_profile_and_revokes_unlock(account_http, monkeypatch):
    post, checks, saved = account_http
    monkeypatch.setenv("PM_TRADING_LIVE_UNLOCK", "1")
    status, result = post("/api/account/save", {"wallet": WALLET})
    assert status == 200, result
    assert result["ok"] is True
    assert saved == checks
    assert saved[0]["POLYMARKET_WALLET_ADDRESS"] == WALLET
    assert SERVER.os.environ.get("PM_TRADING_LIVE_UNLOCK") is None


@pytest.mark.parametrize("payload", [{}, {"wallet": "invalid"}, {"wallet": WALLET, "unexpected": True}])
def test_public_invalid_save_never_persists(account_http, payload):
    post, checks, saved = account_http
    status, result = post("/api/account/save", payload)
    assert status == 400, result
    assert result["ok"] is False
    assert checks == saved == []


@pytest.mark.parametrize('code,status',[('account_rpc_timeout',504),('account_rpc_failed',503),('invalid_account_config',400)])
def test_public_checker_failures_keep_specific_status_without_saving(account_http,monkeypatch,code,status):
    post, checks, saved = account_http
    def fail(*args): raise SERVER.account_store.AccountCheckError(code)
    monkeypatch.setattr(SERVER.account_store,'check_account',fail)
    actual,result=post('/api/account/save',{'wallet':WALLET})
    assert actual==status
    assert result['error_code']==code
    assert result['ok'] is False
    assert saved==[]


def test_public_account_opt_in_does_not_authorize_live_trading(account_http, monkeypatch, tmp_path):
    post, checks, saved = account_http
    payload = {"mode": "live", "confirm_live": True}
    status, result = post("/api/trading/start", payload)
    assert status == 503, result
    monkeypatch.setenv("PM_DASHBOARD_CONTROL_TOKEN", "isolated-test-token")
    status, result = post("/api/trading/start", payload)
    assert status == 401, result

    # Even the right control token cannot substitute for the live unlock.
    cli = tmp_path / "engine" / "dist" / "cli" / "live.js"
    cli.parent.mkdir(parents=True)
    cli.touch()
    monkeypatch.setattr(SERVER, "TRADING_ROOT", tmp_path / "engine")
    status, result = post("/api/trading/start", payload, {**HEADERS, "X-PM-Control-Token": "isolated-test-token"})
    assert status == 403, result
    assert "未开启实盘解锁" in result["error"]
    assert checks == saved == []

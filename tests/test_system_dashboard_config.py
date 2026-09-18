from __future__ import annotations

import importlib.util
import http.client
import json
import os
import subprocess
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "system-dashboard-server.py"
SPEC = importlib.util.spec_from_file_location("system_dashboard_server", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

GENERIC_ENV = (
    "PM_NODE_LABEL",
    "PM_COLLECTOR_SERVICE",
    "PM_LIVE_LOCAL",
    "PM_REMOTE_SSH_KEY",
    "PM_REMOTE_HOST",
    "PM_REMOTE_PORT",
    "PM_REMOTE_CONNECT_TIMEOUT",
    "PM_MARKET_SNAPSHOT_PATH",
    "PM_REMOTE_SNAPSHOT_PATH",
)


def clear_live_environment(monkeypatch) -> None:
    for name in GENERIC_ENV:
        monkeypatch.delenv(name, raising=False)


def test_default_configuration_uses_current_dublin_deployment(monkeypatch) -> None:
    clear_live_environment(monkeypatch)
    config = MODULE._live_config()
    assert config["node_label"] == "都柏林节点"
    assert config["collector_service"] == "pm-clob-market-snapshot.service"
    assert config["remote_host"] == "root@34.242.206.196"
    assert config["ssh_key"].name == "id_ed25519_dublin_pm"


def test_missing_key_returns_typed_empty_markets_without_leaking_paths(monkeypatch, tmp_path):
    clear_live_environment(monkeypatch)
    monkeypatch.setenv("PM_LIVE_LOCAL", "0")
    monkeypatch.setenv("PM_REMOTE_SSH_KEY", str(tmp_path / "missing-key"))
    monkeypatch.setattr(MODULE, "_live_cache_at", 0.0)
    monkeypatch.setattr(MODULE, "_live_cache", {})
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("must not connect without key")))
    result = MODULE._live_status_fetch()
    assert result["error_code"] == "collector_connection_failed"
    assert result["collector_online"] is False
    assert result["current_markets"] == []
    assert str(tmp_path) not in json.dumps(result)
    assert MODULE.cached_live_status()["current_markets"] == []
    assert MODULE.control_source()["scope"] == "local_preview"


def test_local_snapshot_read_preserves_source_clock_and_does_not_rewrite(monkeypatch, tmp_path):
    import time
    from datetime import datetime, timezone
    clear_live_environment(monkeypatch)
    monkeypatch.setenv("PM_LIVE_LOCAL", "1")
    target = tmp_path / "snapshot.json"
    monkeypatch.setenv("PM_MARKET_SNAPSHOT_PATH", str(target))
    monkeypatch.setattr(MODULE, "_live_cache_at", 0.0)
    monkeypatch.setattr(MODULE, "_live_cache", {})
    now = time.time()
    timestamp = datetime.fromtimestamp(now - .2, timezone.utc).isoformat()
    value = {"checked_at": timestamp, "source": "polymarket-ws", "collector_online": True, "collector_connected": True,
             "stale_after_ms": 2000, "current_markets": [{"slug": "btc-test", "up_token": "up",
                 "down_token": "down", "start": now - 100, "end": now + 150, "up_bid": .4, "up_ask": .5,
                 "down_bid": .4, "down_ask": .5, "quote_at": timestamp}]}
    target.write_text(json.dumps(value), encoding="utf-8")
    before = target.read_bytes(), target.stat().st_mtime_ns
    monkeypatch.setattr(subprocess, "run", lambda *a, **kw: (_ for _ in ()).throw(AssertionError("no subprocess needed")))
    result=MODULE._live_status_fetch()
    assert not result.get('error'), result
    market=result['current_markets'][0]
    assert market['up_token']=='up'
    assert market['up_ask']==.5
    assert market['quote_at'] == timestamp
    assert result['checked_at'] == timestamp
    assert (target.read_bytes(), target.stat().st_mtime_ns) == before


def test_generic_environment_configures_collector(monkeypatch, tmp_path: Path) -> None:
    clear_live_environment(monkeypatch)
    monkeypatch.setenv("PM_LIVE_LOCAL", "0")
    monkeypatch.setenv("PM_REMOTE_SNAPSHOT_PATH", "/new/data/market-snapshot.json")
    monkeypatch.setenv("PM_REMOTE_SSH_KEY", str(tmp_path / "new-key"))
    config = MODULE._live_config()
    assert config["collector_is_local"] is False
    assert config["remote_snapshot_path"] == "/new/data/market-snapshot.json"
    assert config["ssh_key"] == tmp_path / "new-key"


def test_missing_local_snapshot_is_offline_without_child_or_file_write(monkeypatch, tmp_path: Path) -> None:
    clear_live_environment(monkeypatch)
    monkeypatch.setenv("PM_LIVE_LOCAL", "1")
    monkeypatch.setenv("PM_MARKET_SNAPSHOT_PATH", str(tmp_path / "snapshot.json"))
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout="active", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    MODULE._live_cache_at = 0.0
    value = MODULE._live_status_fetch()
    assert value["node_label"] == "都柏林节点"
    assert calls == []
    MODULE._live_cache_at = 0.0
    MODULE._live_status_fetch()
    assert calls == []
    assert value["collector_online"] is False
    assert not (tmp_path / "snapshot.json").exists()


def test_busy_live_status_still_returns_configured_node(monkeypatch) -> None:
    clear_live_environment(monkeypatch)
    monkeypatch.setenv("PM_NODE_LABEL", "都柏林节点")
    MODULE._live_cache = {"collector_online": False}
    assert MODULE._live_fetch_lock.acquire(blocking=False)
    try:
        value = MODULE.live_status()
    finally:
        MODULE._live_fetch_lock.release()
    assert value["node_label"] == "都柏林节点"
    assert value["refreshing"] is True


def test_invalid_local_snapshot_returns_offline_without_overwriting_producer(monkeypatch, tmp_path):
    clear_live_environment(monkeypatch)
    monkeypatch.setenv("PM_LIVE_LOCAL", "1")
    target = tmp_path / "snapshot.json"
    monkeypatch.setenv("PM_MARKET_SNAPSHOT_PATH", str(target))
    target.write_text('{"collector_online":', encoding="utf-8")
    before = target.read_bytes()
    monkeypatch.setattr(MODULE, "_live_cache_at", 0.)
    assert MODULE._live_status_fetch()["collector_online"] is False
    assert target.read_bytes() == before


@pytest.mark.parametrize("row_update", [
    {"up_bid": None},
    {"down_ask": 1.1},
    {"up_bid": .7, "up_ask": .6},
    {"down_ask": "0.5"},
    {"down_token": "up"},
    {"quote_at": None},
    {"collector_connected": False},
])
def test_invalid_clob_snapshot_is_cleared(monkeypatch, tmp_path, row_update):
    import time
    from datetime import datetime, timezone
    clear_live_environment(monkeypatch)
    monkeypatch.setenv("PM_LIVE_LOCAL", "1")
    target = tmp_path / "snapshot.json"
    monkeypatch.setenv("PM_MARKET_SNAPSHOT_PATH", str(target))
    now = time.time()
    stamp = datetime.fromtimestamp(now, timezone.utc).isoformat()
    value = {"checked_at": stamp, "source": "polymarket-ws", "collector_online": True,
             "collector_connected": True, "stale_after_ms": 2000,
             "current_markets": [{"slug": "btc", "up_token": "up", "down_token": "down",
                 "start": now - 10, "end": now + 100, "up_bid": .4, "up_ask": .5,
                 "down_bid": .4, "down_ask": .5, "quote_at": stamp}]}
    value.update({key: update for key, update in row_update.items() if key == "collector_connected"})
    if "collector_connected" not in row_update:
        value["current_markets"][0].update(row_update)
    target.write_text(json.dumps(value), encoding="utf-8")
    monkeypatch.setattr(MODULE, "_live_cache_at", 0.)
    assert MODULE._live_status_fetch()["current_markets"] == []


def test_remote_status_reads_lightweight_snapshot_with_configured_host_key_port(monkeypatch, tmp_path: Path) -> None:
    clear_live_environment(monkeypatch)
    key = tmp_path / "id_ed25519"
    key.touch()
    monkeypatch.setenv("PM_LIVE_LOCAL", "0")
    monkeypatch.setenv("PM_NODE_LABEL", "远程节点")
    monkeypatch.setenv("PM_REMOTE_HOST", "collector@example.test")
    monkeypatch.setenv("PM_REMOTE_SSH_KEY", str(key))
    monkeypatch.setenv("PM_REMOTE_PORT", "2222")
    monkeypatch.setenv("PM_REMOTE_SNAPSHOT_PATH", "/srv/project data/snapshot.json")
    calls = []

    def fake_run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout='{"collector_online": true}', stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    MODULE._live_cache_at = 0.0
    value = MODULE._live_status_fetch()
    command = calls[0]
    assert value["node_label"] == "远程节点"
    assert command[0] == "ssh"
    assert command[command.index("-i") + 1] == str(key)
    assert command[command.index("-p") + 1] == "2222"
    assert command[-2:] == ["collector@example.test", "cat -- '/srv/project data/snapshot.json'"]
    assert value["collector_online"] is False  # Missing source generation clock fails closed.


def test_removed_dashboard_routes_redirect_to_console() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MODULE.make_handler(ROOT))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for path in ("/", "/system-dashboard.html", "/system-dashboard-advanced.html", "/demo-trading-console.html"):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            connection.request("GET", path)
            response = connection.getresponse()
            response.read()
            assert response.status == 302 and response.getheader("Location") == "/console/"
            connection.close()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        connection.request("GET", "/console/")
        response = connection.getresponse()
        response.read()
        assert response.status == 200
        connection.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_static_javascript_uses_executable_mime_type() -> None:
    assert MODULE._static_content_type(Path("console.js")) == "application/javascript; charset=utf-8"
    assert MODULE._static_content_type(Path("console.html")) == "text/html; charset=utf-8"
    assert MODULE._static_content_type(Path("unknown.bin")) == "application/octet-stream"


def test_control_request_requires_json_same_origin_and_live_password(monkeypatch) -> None:
    monkeypatch.delenv("PM_DASHBOARD_CONTROL_TOKEN", raising=False)
    monkeypatch.delenv("PM_TRADING_LIVE_UNLOCK", raising=False)
    paper_headers = {"Content-Type": "application/json", "Host": "127.0.0.1:8765"}
    assert MODULE._control_request_error(paper_headers, "paper") is None
    assert MODULE._control_request_error({"Content-Type": "text/plain"}, "paper")[0] == 415
    wrong_origin = {**paper_headers, "Origin": "https://attacker.example"}
    assert MODULE._control_request_error(wrong_origin, "paper")[0] == 403
    assert MODULE._control_request_error(paper_headers, "live")[0] == 503

    monkeypatch.setenv("PM_DASHBOARD_CONTROL_TOKEN", "correct horse")
    assert MODULE._control_request_error(paper_headers, "paper")[0] == 401
    authorized = {**paper_headers, "Authorization": "Bearer correct horse"}
    assert MODULE._control_request_error(authorized, "live") is None


def test_account_roles_are_reported_separately_without_exposing_values(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(MODULE, "TRADING_ROOT", tmp_path)
    names = (
        "POLYMARKET_WALLET_ADDRESS", "POLY_FUNDER", "POLYMARKET_OWNER_PRIVATE_KEY",
        "POLYMARKET_PRIVATE_KEY", "POLYMARKET_SESSION_PRIVATE_KEY", "RELAYER_API_KEY",
        "RELAYER_API_KEY_ADDRESS", "POLY_BUILDER_API_KEY", "POLY_BUILDER_SECRET",
        "POLY_BUILDER_PASSPHRASE",
    )
    for name in names:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("POLYMARKET_WALLET_ADDRESS", "0x0000000000000000000000000000000000000001")
    monkeypatch.setenv("RELAYER_API_KEY", "relayer-secret")
    monkeypatch.setenv("RELAYER_API_KEY_ADDRESS", "0x0000000000000000000000000000000000000002")
    status = MODULE.account_config_status()
    assert status["wallet_configured"] is True
    assert status["relayer_api_configured"] is True
    assert status["execution_credentials_ready"] is False
    assert status["read_only_only"] is True
    assert "relayer-secret" not in json.dumps(status)


def test_account_placeholders_do_not_enable_live_trading(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(MODULE, "TRADING_ROOT", tmp_path)
    monkeypatch.setenv("POLYMARKET_WALLET_ADDRESS", "<已隐藏>")
    monkeypatch.setenv("POLYMARKET_OWNER_PRIVATE_KEY", "真实值")
    assert MODULE.account_config_status()["execution_credentials_ready"] is False
    assert MODULE.private_key_configured() is False


def test_dublin_service_bundle_is_consistent() -> None:
    snapshot = (ROOT / "config" / "pm-clob-market-snapshot.service").read_text(encoding="utf-8")
    dashboard = (ROOT / "config" / "pm-system-dashboard-dublin.service").read_text(encoding="utf-8")
    nginx = (ROOT / "config" / "paper-grid-dublin.server.conf").read_text(encoding="utf-8")
    assert "dist/cli/market-snapshot.js" in snapshot
    assert "data/dashboard/market-snapshot.json" in snapshot
    assert "PM_MARKET_SNAPSHOT_STALE_MS=2000" in snapshot
    assert "pm-clob-market-snapshot.service" in dashboard
    assert "PM_COLLECTOR_SERVICE=pm-clob-market-snapshot.service" in dashboard
    assert "PM_NODE_LABEL=都柏林节点" in dashboard
    assert "EnvironmentFile=-/root/pm-system/config/dashboard-secret.env" in dashboard
    assert "listen 127.0.0.1:8765" in nginx
    assert "listen 0.0.0.0" not in nginx

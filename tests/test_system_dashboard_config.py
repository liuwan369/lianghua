from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "system-dashboard-server.py"
SPEC = importlib.util.spec_from_file_location("system_dashboard_server", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)

GENERIC_ENV = (
    "PM_NODE_LABEL",
    "PM_LIVE_DATA_DIR",
    "PM_EVIDENCE_GLOB",
    "PM_COLLECTOR_SERVICE",
    "PM_LIVE_LOCAL",
    "PM_REMOTE_DATA_DIR",
    "PM_REMOTE_SSH_KEY",
    "PM_REMOTE_HOST",
    "PM_REMOTE_PORT",
    "PM_REMOTE_CONNECT_TIMEOUT",
    "PM_REMOTE_PYTHON",
)
LEGACY_ENV = ("PM_TOKYO_LIVE_LOCAL", "PM_TOKYO_REMOTE_DATA_DIR", "PM_TOKYO_SSH_KEY")


def clear_live_environment(monkeypatch) -> None:
    for name in GENERIC_ENV + LEGACY_ENV:
        monkeypatch.delenv(name, raising=False)


def test_default_configuration_remains_tokyo_compatible(monkeypatch) -> None:
    clear_live_environment(monkeypatch)
    config = MODULE._live_config()
    assert config["node_label"] == "东京节点"
    assert config["evidence_glob"] == "tokyo-evidence-*.sqlite3"
    assert config["collector_service"] == "pm-r25-tokyo-collector.service"
    assert config["remote_host"] == "root@13.115.254.211"


def test_generic_environment_takes_precedence_over_legacy(monkeypatch, tmp_path: Path) -> None:
    clear_live_environment(monkeypatch)
    monkeypatch.setenv("PM_LIVE_LOCAL", "0")
    monkeypatch.setenv("PM_TOKYO_LIVE_LOCAL", "1")
    monkeypatch.setenv("PM_REMOTE_DATA_DIR", "/new/data")
    monkeypatch.setenv("PM_TOKYO_REMOTE_DATA_DIR", "/old/data")
    monkeypatch.setenv("PM_REMOTE_SSH_KEY", str(tmp_path / "new-key"))
    monkeypatch.setenv("PM_TOKYO_SSH_KEY", str(tmp_path / "old-key"))
    config = MODULE._live_config()
    assert config["collector_is_local"] is False
    assert config["remote_data_dir"] == "/new/data"
    assert config["ssh_key"] == tmp_path / "new-key"


def test_dublin_local_status_uses_local_python_and_returns_node(monkeypatch, tmp_path: Path) -> None:
    clear_live_environment(monkeypatch)
    monkeypatch.setenv("PM_NODE_LABEL", "都柏林节点")
    monkeypatch.setenv("PM_LIVE_LOCAL", "1")
    monkeypatch.setenv("PM_LIVE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PM_EVIDENCE_GLOB", "dublin-evidence-*.sqlite3")
    monkeypatch.setenv("PM_COLLECTOR_SERVICE", "pm-r25-dublin-collector.service")
    calls = []

    def fake_run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout='{"collector_online": false}', stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    MODULE._live_cache_at = 0.0
    value = MODULE._live_status_fetch()
    assert value["node_label"] == "都柏林节点"
    assert calls[0][0][:2] == [sys.executable, "-c"]
    assert "ssh" not in calls[0][0]
    assert "dublin-evidence-*.sqlite3" in calls[0][1]["input"]
    assert "pm-r25-dublin-collector.service" in calls[0][1]["input"]


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


def test_remote_status_uses_configured_host_key_port_and_python(monkeypatch, tmp_path: Path) -> None:
    clear_live_environment(monkeypatch)
    key = tmp_path / "id_ed25519"
    monkeypatch.setenv("PM_LIVE_LOCAL", "0")
    monkeypatch.setenv("PM_NODE_LABEL", "远程节点")
    monkeypatch.setenv("PM_REMOTE_HOST", "collector@example.test")
    monkeypatch.setenv("PM_REMOTE_SSH_KEY", str(key))
    monkeypatch.setenv("PM_REMOTE_PORT", "2222")
    monkeypatch.setenv("PM_REMOTE_PYTHON", "/usr/bin/python3.12")
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
    assert command[-3:] == ["collector@example.test", "/usr/bin/python3.12", "-"]


def test_dashboard_uses_node_label_from_api() -> None:
    html = (ROOT / "docs" / "system-dashboard.html").read_text(encoding="utf-8")
    javascript = (ROOT / "docs" / "system-dashboard.js").read_text(encoding="utf-8")
    assert 'id="nodeLabel"' in html
    assert "data.node_label" in javascript
    assert "东京" not in html
    assert "东京" not in javascript


def test_static_javascript_uses_executable_mime_type() -> None:
    assert MODULE._static_content_type(Path("system-dashboard.js")) == "application/javascript; charset=utf-8"
    assert MODULE._static_content_type(Path("system-dashboard.html")) == "text/html; charset=utf-8"
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
    collector_text = (ROOT / "config" / "pm-r25-dublin-collector.json").read_text(encoding="utf-8")
    collector = json.loads(collector_text)
    dashboard = (ROOT / "config" / "pm-system-dashboard-dublin.service").read_text(encoding="utf-8")
    analyzer = (ROOT / "config" / "pm-r25-dublin-live-analyzer.service").read_text(encoding="utf-8")
    restart = (ROOT / "config" / "pm-r25-dublin-daily-restart.service").read_text(encoding="utf-8")
    nginx = (ROOT / "config" / "paper-grid-dublin.server.conf").read_text(encoding="utf-8")
    assert collector["sqlite_path"].endswith("dublin-evidence-{date}.sqlite3")
    assert collector["trade_authorization"] is False
    assert "pm-r25-dublin-collector.service" in dashboard
    assert "PM_NODE_LABEL=都柏林节点" in dashboard
    assert "EnvironmentFile=-/root/pm-system/config/dashboard-secret.env" in dashboard
    assert "dublin-evidence.sqlite3" in analyzer
    assert "pm-r25-dublin-collector.service" in restart
    assert "listen 127.0.0.1:8765" in nginx
    assert "listen 0.0.0.0" not in nginx

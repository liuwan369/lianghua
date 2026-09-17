import http.client
import importlib.util
import json
import sys
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

from scripts.dashboard.system_metrics import SystemMetrics

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("dashboard_system_metrics_test", ROOT / "scripts/system-dashboard-server.py")
SERVER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SERVER
SPEC.loader.exec_module(SERVER)


def test_metrics_are_cached_and_keep_unknown_values_explicit(monkeypatch, tmp_path):
    samples = iter([(100, 20), (200, 50)])
    monkeypatch.setattr(SystemMetrics, "_cpu_times", staticmethod(lambda: next(samples)))
    monkeypatch.setattr(SystemMetrics, "_memory", staticmethod(lambda: {"used_bytes": 25, "total_bytes": 100, "percent": 25.0}))
    monkeypatch.setattr("scripts.dashboard.system_metrics.os.getloadavg", lambda: (1.0, .5, .25), raising=False)
    metrics = SystemMetrics(tmp_path, lambda: {
        "dashboard": {"pid": None, "state": "active"},
        "trader": {"pid": None, "state": "stopped"},
        "journal_backlog": 2,
        "event_loop_lag_ms": None,
    })
    first = metrics.refresh()
    assert first["cpu"]["percent"] is None
    second = metrics.refresh()
    assert second["cpu"]["percent"] == 70.0
    assert second["memory"]["percent"] == 25.0
    assert second["services"]["trader"] == {"state": "stopped", "pid": None, "rss_bytes": None, "uptime_seconds": None}
    assert second["journal_backlog"] == 2 and second["event_loop_lag_ms"] is None
    copy = metrics.snapshot();copy["cpu"]["percent"] = 0
    assert metrics.snapshot()["cpu"]["percent"] == 70.0
    assert SystemMetrics._process(12345, "stopped") == {
        "state": "stopped", "pid": None, "rss_bytes": None, "uptime_seconds": None}


def test_system_metrics_endpoint_only_returns_cached_snapshot(monkeypatch, tmp_path):
    expected = {"schemaVersion": 1, "asOf": 1000, "cpu": {"percent": 12.5, "cores": 2},
                "load": {"one": .1, "five": .2, "fifteen": .3},
                "memory": {"used_bytes": 1, "total_bytes": 2, "percent": 50},
                "disk": {"used_bytes": 3, "total_bytes": 4, "free_bytes": 1, "percent": 75},
                "services": {}, "journal_backlog": 0, "event_loop_lag_ms": None}
    class Cached:
        def snapshot(self): return expected.copy()
        def refresh(self): raise AssertionError("HTTP request must not collect OS metrics")
    monkeypatch.setattr(SERVER, "_system_metrics", Cached())
    server = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.make_handler(tmp_path))
    thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
    try:
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        connection.request("GET", "/api/v1/system-metrics")
        response = connection.getresponse();payload = json.loads(response.read())
        assert response.status == 200 and payload["cpu"]["percent"] == 12.5
        assert "control_source" in payload
    finally:
        connection.close();server.shutdown();server.server_close();thread.join(timeout=5)

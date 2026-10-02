"""P2-11: /api/runtime/status crashed for the first 0-3 s of every run.

trading_status() guarded every runtime read with isinstance(runtime, dict)
except runtime_row_fresh, which called runtime.get() while the new run had no
runtime row yet. AttributeError is not in do_GET's except list, so the client
got a dropped connection (5 on the live log, each 0-1 s after a start).

Runs the real trading_status() with a running process and no runtime row.

Run:  python scripts/regress/P2-11.py
"""
import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class Running:
    pid = 0

    def poll(self):
        return None


class P2_11(unittest.TestCase):
    def setUp(self):
        self.saved = {name: getattr(server, name) for name in (
            "_restore_trading_state", "trade_log_stats", "account_config_status", "_trading_process", "_trading_engine")}
        server._restore_trading_state = lambda: None
        server.account_config_status = lambda: {"live_start_ready": True}
        server._trading_process = Running()
        server._trading_engine = "platform"

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(server, name, value)

    def test_bug_no_runtime_row_yet(self):
        server.trade_log_stats = lambda selection: {"runtime": None,
                                                    "projection": {"state": "ready", "stale": False}}
        status = server.trading_status()
        self.assertTrue(status["running"])
        self.assertEqual(status["service_state"], "starting", "a run without a runtime row is still starting")

    def test_control_running_runtime_row(self):
        import time
        now = time.time()
        server.trade_log_stats = lambda selection: {"runtime": {"status": "running", "stale": False,
                                                                "source_at": now, "expires_at": now + 5},
                                                    "projection": {"state": "ready", "stale": False}}
        self.assertEqual(server.trading_status()["service_state"], "running")


if __name__ == "__main__":
    unittest.main()

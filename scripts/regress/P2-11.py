"""P2-11: /api/runtime/status crashed for the first 0-3 s of every run.

trading_status() guarded every runtime read with isinstance(runtime, dict)
except runtime_row_fresh, which called runtime.get() while the new run had no
runtime row yet. AttributeError is not in do_GET's except list, so the client
got a dropped connection (5 on the live log, each 0-1 s after a start).

Runs the real trading_status() with the engine agent reporting a running
process and no runtime row in the console's projection yet.

Run:  python scripts/regress/P2-11.py
"""
import importlib.util
import sys
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class Agent:
    """The agent cache of a running engine."""
    def view(self):
        return {"reachable": True, "error": None, "mismatch": None, "clockSkewSeconds": 0.0, "ageSeconds": 0.2,
                "state": {"box": "pm-test", "status": {"running": True, "started_at": time.time() - 2,
                                                       "params": {}, "stop_result": {}}}}


class P2_11(unittest.TestCase):
    def setUp(self):
        self.saved = {name: getattr(server, name) for name in ("agent", "trade_log_stats")}
        server.agent = lambda: Agent()

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
        now = time.time()
        server.trade_log_stats = lambda selection: {"runtime": {"status": "running", "stale": False,
                                                                "source_at": now, "expires_at": now + 5},
                                                    "projection": {"state": "ready", "stale": False}}
        self.assertEqual(server.trading_status()["service_state"], "running")

    def test_paused_start_confirms_as_paused(self):
        """A start with startPaused set no pendingControl, so the expected state
        was "not paused" and commandStatus stayed executing for the whole
        paused run (live 2026-11-21). The start's own paused flag decides."""
        now = time.time()
        server.trade_log_stats = lambda selection: {"runtime": {"status": "running", "stale": False,
                                                                "source_at": now, "expires_at": now + 5,
                                                                "strategy_runtime": {"paused": True}},
                                                    "projection": {"state": "ready", "stale": False}}
        saved = Agent.view
        Agent.view = lambda self: {**saved(self), "state": {**saved(self)["state"], "status": {
            **saved(self)["state"]["status"], "params": {"startPaused": True}}}}
        try:
            status = server.trading_status()
        finally:
            Agent.view = saved
        self.assertEqual((status["service_state"], status["command_status"]), ("paused", "confirmed"))


if __name__ == "__main__":
    unittest.main()

"""P3-7, P3-8, P3-9: the stop path, on the real control-plane module.

P3-8: stop_trading waited up to 8 s for the child inside _trading_lock, so
      every status read blocked and the console's requests timed out.
P3-9: a stop that outlasted 8 s left a "still stopping" result; when the
      engine then exited (even failed) that result was never replaced.
P3-7: after a control-plane restart the engine is gone, but nothing recorded
      a stop result, so the run stayed "executing" forever.

Run:  python scripts/regress/P3-7-8-9.py
"""
import importlib.util
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))


def load():
    spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Child:
    """A live child that drains for `seconds`, then exits with `code`."""
    def __init__(self, seconds, code):
        self.pid, self.ends, self.code = 4242, time.monotonic() + seconds, code

    def poll(self):
        return self.code if time.monotonic() >= self.ends else None

    def send_signal(self, signum):
        pass

    def wait(self, timeout=None):
        left = self.ends - time.monotonic()
        if timeout is not None and left > timeout:
            time.sleep(timeout)
            import subprocess
            raise subprocess.TimeoutExpired("engine", timeout)
        time.sleep(max(0, left))
        return self.code


class Stop(unittest.TestCase):
    def setUp(self):
        self.server = load()
        s = self.server
        self.tmp = Path(tempfile.mkdtemp())
        self.console = self.tmp / "run.console.log"
        self.console.write_text("", encoding="utf-8")
        s.TRADING_ROOT = self.tmp
        (self.tmp / "results").mkdir()
        s._trading_state_loaded = True
        s._remote_orders_empty_from_fresh_snapshot = lambda: False
        s.account_config_status = lambda: {"live_start_ready": True}
        s.trade_log_stats = lambda selection: {"runtime": None, "projection": {"state": "ready", "stale": False}}
        s._trading_mode, s._trading_engine = "live", "platform"
        s._trading_log, s._trading_console_log = self.tmp / "run.jsonl", self.console
        s._trading_stop_result = None

    def test_p3_8_status_reads_do_not_wait_for_the_stop(self):
        s = self.server
        s._trading_process = Child(seconds=3, code=0)
        stopper = threading.Thread(target=s.stop_trading)
        stopper.start()
        time.sleep(0.3)
        started = time.monotonic()
        s.trading_status(include_stats=False)
        self.assertLess(time.monotonic() - started, 1.0, "a status read during a stop returns at once")
        stopper.join()

    def test_p3_9_a_late_failed_exit_is_reported(self):
        s = self.server
        child = Child(seconds=9, code=1)
        s._trading_process = child
        s.stop_trading()                                 # gives up waiting after 8 s
        self.assertIs(s._trading_stop_result.get("process_stopped"), False)
        self.console.write_text(json.dumps({"kind": "platform_error", "phase": "drain", "code": "platform_run_failed",
                                            "message": "cancel failed"}) + "\n"
                                + json.dumps({"kind": "platform_status", "status": "failed"}) + "\n", encoding="utf-8")
        time.sleep(max(0, child.ends - time.monotonic()) + 0.1)
        status = s.trading_status(include_stats=False)
        self.assertEqual(s._trading_stop_result.get("reason"), "process_failed", "the real exit outcome replaces 'still stopping'")
        self.assertIn("cancel failed", s._trading_stop_result.get("message", ""))
        self.assertFalse(status["running"])

    def test_p3_7_restart_records_why_the_run_ended(self):
        s = self.server
        s._trading_state_loaded = False
        s._process_matches = lambda pid, log: False      # the engine died with the control plane
        s._trading_log.write_text("{}", encoding="utf-8")  # its journal survives (no data reset)
        (self.tmp / "results" / "dashboard-state.json").write_text(json.dumps({
            "pid": 4242, "log": str(s._trading_log), "console_log": str(self.console), "mode": "live",
            "engine": "platform", "run_id": "r1", "stop_result": None}), encoding="utf-8")
        s._restore_trading_state()
        self.assertIsNotNone(s._trading_stop_result, "a stop result is recorded")
        self.assertEqual(s._trading_stop_result.get("reason"), "control_plane_restarted")

    def test_review_a_normal_finish_keeps_its_reason(self):
        s = self.server
        s._trading_state_loaded = False
        s._process_matches = lambda pid, log: False
        s._trading_log.write_text("{}", encoding="utf-8")
        self.console.write_text(json.dumps({"kind": "platform_status", "status": "stopped", "reason": "round_limit_reached"}) + chr(10),
                                encoding="utf-8")
        (self.tmp / "results" / "dashboard-state.json").write_text(json.dumps({
            "pid": 4242, "log": str(s._trading_log), "console_log": str(self.console), "mode": "live",
            "engine": "platform", "run_id": "r1", "stop_result": None}), encoding="utf-8")
        s._restore_trading_state()
        self.assertEqual(s._trading_stop_result.get("reason"), "round_limit_reached")

    def test_review_start_is_refused_while_a_stop_waits(self):
        s = self.server
        s._trading_process = None
        s._trading_pid = None
        s._trading_stop_result = {"process_stopped": False, "requested_pid": 4242}
        s._account_check_lock = threading.Lock()
        import os
        (self.tmp / "dist" / "cli").mkdir(parents=True)
        (self.tmp / "dist" / "cli" / "platform.js").write_text("", encoding="utf-8")
        os.environ["PM_TRADING_LIVE_UNLOCK"] = "1"
        s.account_config_status = lambda: {"execution_credentials_ready": True, "account_check_ready": True,
                                           "settlement_credentials_ready": True, "live_start_ready": True}
        try:
            with self.assertRaisesRegex(RuntimeError, "停止仍在进行"):
                s._start_trading({"mode": "live", "confirm_live": True, "duration_min": 0}, config_revision=22)
        finally:
            os.environ.pop("PM_TRADING_LIVE_UNLOCK", None)


if __name__ == "__main__":
    unittest.main()

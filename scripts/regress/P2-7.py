"""BUGS.md P2-7, control-plane half: a failed run's stop message now carries the
engine's own cause instead of only "交易进程异常退出".

Uses the console-log shape of the real failed start on 2026-09-30
(run 20260930-161215, phase state_open) with the message the engine now adds.

Run:  python scripts/regress/P2-7.py
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class P2_7(unittest.TestCase):
    def console(self, lines):
        path = Path(tempfile.mkdtemp()) / "run.console.log"
        path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")
        return path

    def setUp(self):
        self.saved = server._remote_orders_empty_from_fresh_snapshot
        server._remote_orders_empty_from_fresh_snapshot = lambda: True

    def tearDown(self):
        server._remote_orders_empty_from_fresh_snapshot = self.saved

    def test_bug_failed_start_says_why(self):
        path = self.console([
            {"kind": "platform_status", "status": "starting"},
            {"kind": "platform_error", "phase": "state_open", "code": "platform_run_failed",
             "message": "invalid persisted reversal stage"},
            {"kind": "platform_status", "status": "failed"},
        ])
        result = server._automatic_stop_result(1, path)
        self.assertEqual(result["reason"], "process_failed")
        self.assertIn("state_open", result["message"])
        self.assertIn("invalid persisted reversal stage", result["message"])

    def test_control_normal_stop_unchanged(self):
        path = self.console([{"kind": "platform_status", "status": "stopped", "reason": "round_limit_reached"}])
        result = server._automatic_stop_result(0, path)
        self.assertNotIn("（", result["message"])


if __name__ == "__main__":
    unittest.main()

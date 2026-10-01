"""BUGS.md P3-1 / P3-2: event severity and size.

P3-1: _event_dto marked every kind=error event "error", so account_recovery_started
(a notice) was red; the console's code-based rule never ran because the server's
severity wins. Now kind=error carries no severity and the console decides.
P3-2: /api/events sent its list twice (items and events), as did /api/settlements.

Run:  python scripts/regress/P3-1.py
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


class P3_1(unittest.TestCase):
    def test_error_channel_has_no_server_severity(self):
        dto = server._event_dto({"event": "error", "code": "account_recovery_started", "message": "account_recovery_started"})
        self.assertIsNone(dto["severity"], "the console's code rule decides")

    def test_other_kinds_unchanged(self):
        self.assertEqual(server._event_dto({"event": "unresolved"})["severity"], "warning")
        self.assertEqual(server._event_dto({"event": "fill"})["severity"], "info")

    def test_one_list_per_response(self):
        source = (SCRIPTS / "system-dashboard-server.py").read_text(encoding="utf-8")
        self.assertNotIn('"events": items', source)
        self.assertNotIn('"settlements": items', source)


if __name__ == "__main__":
    unittest.main()

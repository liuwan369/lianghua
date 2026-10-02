"""P2-2: the market endpoint re-read the collector file only once a second.

The collector rewrites market-snapshot.json every 250 ms; _live_status_fetch
returned its cache for a full second, so quotes ran up to 27 frames behind
(median quote age 0.94 s against a 2 s stale limit).

Drives the real _live_status_fetch against a temp collector file.

Run:  python scripts/regress/P2-2.py
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class P2_2(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / "market-snapshot.json"
        self.saved = (server._live_config, server.validate_snapshot)
        server._live_config = lambda: {"collector_is_local": True, "snapshot_path": self.path, "node_label": "test"}
        server.validate_snapshot = lambda value: dict(value)
        server._live_cache, server._live_cache_at, server._live_cache_mtime = {}, 0.0, None

    def tearDown(self):
        server._live_config, server.validate_snapshot = self.saved

    def write(self, frame):
        self.path.write_text(json.dumps({"frame": frame, "collector_online": True}))
        stamp = 1_790_000_000_000_000_000 + frame * 250_000_000
        os.utime(self.path, ns=(stamp, stamp))

    def test_bug_new_frame_is_read_at_once(self):
        self.write(1)
        self.assertEqual(server._live_status_fetch()["frame"], 1)
        self.write(2)  # 250 ms later, well inside the old 1 s cache
        self.assertEqual(server._live_status_fetch()["frame"], 2, "a rewritten collector file is read immediately")

    def test_unchanged_file_is_not_reparsed(self):
        self.write(1)
        server._live_status_fetch()
        self.path.write_text("not json")  # same mtime: must not be read again
        stamp = 1_790_000_000_000_000_000 + 250_000_000
        os.utime(self.path, ns=(stamp, stamp))
        self.assertEqual(server._live_status_fetch()["frame"], 1)


if __name__ == "__main__":
    unittest.main()

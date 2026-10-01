"""BUGS.md P2-15: a read between the projection worker's two writes said "stale".

The worker writes snapshot.json, then heartbeat.json. A read in between sees a
new snapshot_version with the old heartbeat; read_model set checked_at = 0, so
age was ~1.7e9 s and stale=True. Push polls every 100 ms and would hit it often.

Run:  python scripts/regress/P2-15.py
"""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.read_model import ReadModel  # noqa: E402

RUN = "20260930-170531-cb02c3f1c1d8"


class Alive:
    def poll(self):
        return None


class P2_15(unittest.TestCase):
    def model(self, snapshot_version, heartbeat_version):
        directory = Path(tempfile.mkdtemp())
        now = time.time()
        (directory / "snapshot.json").write_text(json.dumps({"schemaVersion": 2, "run_id": RUN, "as_of": now,
            "snapshot_version": snapshot_version, "stats": {}, "summary": {}, "ingestion": {}}))
        (directory / "heartbeat.json").write_text(json.dumps({"run_id": RUN, "snapshot_version": heartbeat_version,
                                                               "as_of": now - 0.5}))
        model = ReadModel(directory)
        model._process = Alive()
        return model.snapshot(RUN)

    def test_bug_new_snapshot_old_heartbeat_is_not_stale(self):
        view = self.model("new", "old")
        self.assertLess(view["age_seconds"], 3, "the fresh snapshot's own time proves liveness")
        self.assertFalse(view["stale"])

    def test_control_matching_heartbeat(self):
        view = self.model("v1", "v1")
        self.assertFalse(view["stale"])
        self.assertAlmostEqual(view["age_seconds"], 0.5, delta=0.5)


if __name__ == "__main__":
    unittest.main()

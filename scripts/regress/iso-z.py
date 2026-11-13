"""Migration to the new server (2026-10-10, Ubuntu 22.04 / Python 3.10): the
Node account reader writes timestamps as "...T15:38:11.843Z".
datetime.fromisoformat accepts the "Z" only from Python 3.11, so on 3.10 the
account snapshot was "account_response_invalid". This test runs the parsing
path on the "Z" form whatever the local Python is.

Run:  python scripts/regress/iso-z.py
"""
import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard import timestamps
from dashboard.timestamps import parse_iso


class _Py310Datetime(datetime):
    """datetime whose fromisoformat rejects "Z" exactly as Python 3.10 does."""
    @classmethod
    def fromisoformat(cls, value):
        if isinstance(value, str) and value.endswith("Z"):
            raise ValueError(f"Invalid isoformat string: {value!r}")
        return super().fromisoformat(value)


class IsoZ(unittest.TestCase):
    def setUp(self):
        self.saved = timestamps.datetime
        timestamps.datetime = _Py310Datetime

    def tearDown(self):
        timestamps.datetime = self.saved

    def test_parse_iso_accepts_z(self):
        self.assertAlmostEqual(parse_iso("2026-10-10T15:38:11.843Z"), 1791646691.843, places=3)
        self.assertAlmostEqual(parse_iso("2026-10-10T15:38:11+00:00"), 1791646691.0, places=3)

    def test_no_bare_fromisoformat_on_node_timestamps(self):
        # The account reader's checked_at comes from Node's toISOString() too.
        root = Path(__file__).resolve().parents[1]
        for name in ("dashboard/account_data.py",):
            self.assertNotIn("fromisoformat(", (root / name).read_text(encoding="utf-8"),
                             f"{name} parses Node timestamps with parse_iso")


if __name__ == "__main__":
    unittest.main()

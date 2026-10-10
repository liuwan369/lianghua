"""Migration to the new server (2026-10-10, Ubuntu 22.04 / Python 3.10): the
Node collector and account reader write timestamps as "...T15:38:11.843Z".
datetime.fromisoformat accepts the "Z" only from Python 3.11, so on 3.10 every
market row was stale (the console could not start trading) and the account
snapshot was "account_response_invalid". This test runs the parsing paths on
the "Z" form whatever the local Python is.

Run:  python scripts/regress/iso-z.py
"""
import sys
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard import market_snapshot, timestamps
from dashboard.timestamps import parse_iso


class _Py310Datetime(datetime):
    """datetime whose fromisoformat rejects "Z" exactly as Python 3.10 does."""
    @classmethod
    def fromisoformat(cls, value):
        if isinstance(value, str) and value.endswith("Z"):
            raise ValueError(f"Invalid isoformat string: {value!r}")
        return super().fromisoformat(value)


def z(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class IsoZ(unittest.TestCase):
    def setUp(self):
        self.saved = timestamps.datetime
        timestamps.datetime = _Py310Datetime

    def tearDown(self):
        timestamps.datetime = self.saved

    def test_parse_iso_accepts_z(self):
        self.assertAlmostEqual(parse_iso("2026-10-10T15:38:11.843Z"), 1791646691.843, places=3)
        self.assertAlmostEqual(parse_iso("2026-10-10T15:38:11+00:00"), 1791646691.0, places=3)

    def test_collector_file_with_z_is_fresh(self):
        now = time.time()
        side = lambda asset, bid, ask: {"assetId": asset, "bid": bid, "ask": ask, "sourceAt": now - 0.2, "expiresAt": now + 1.8}
        value = {"checked_at": z(now), "source": "polymarket-ws", "collector_online": True, "collector_connected": True,
                 "stale_after_ms": 2000,
                 "current_markets": [{"assetId": "btc", "marketId": "0xm", "roundId": "1", "healthy": True, "quote_fresh": True,
                                      "snapshot": {"marketId": "0xm", "roundId": "1", "sequence": 3, "sourceAt": now - 0.2,
                                                   "expiresAt": now + 1.8, "YES": side("up", 0.4, 0.41), "NO": side("dn", 0.58, 0.59)}}]}
        out = market_snapshot.validate_snapshot(value, now=now)
        self.assertTrue(out["current_markets"][0]["quote_fresh"], "a fresh row stays fresh with a Z timestamp")
        self.assertTrue(out["collector_online"])

    def test_no_bare_fromisoformat_on_node_timestamps(self):
        # The account reader's checked_at comes from Node's toISOString() too.
        root = Path(__file__).resolve().parents[1]
        for name in ("dashboard/account_data.py", "dashboard/market_snapshot.py"):
            self.assertNotIn("fromisoformat(", (root / name).read_text(encoding="utf-8"),
                             f"{name} parses Node timestamps with parse_iso")


if __name__ == "__main__":
    unittest.main()

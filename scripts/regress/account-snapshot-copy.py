"""2026-11-22: the agent spent 19% CPU on pm-a copying account 1's snapshot.

GET /state (every second) called AccountData.snapshot(), which deep-copied
the whole cached account read: 680 held losers and 1075 closed positions,
1.17 MB, 130 ms of CPU per call. The cache is never changed in place (a
refresh replaces it), so a reader needs only its own top-level dict.

Run:  python scripts/regress/account-snapshot-copy.py
"""
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.account_data import AccountData  # noqa: E402

WALLET = "0x" + "a1" * 20


class SnapshotCopy(unittest.TestCase):
    def reader(self):
        data = AccountData(Path("."), lambda: {"POLYMARKET_WALLET_ADDRESS": WALLET})
        data._account()
        rows = [{"asset": str(i), "conditionId": "c%d" % i, "size": 5, "currentValue": 0, "redeemable": True}
                for i in range(2000)]
        data._cache = {"schemaVersion": 1, "wallet": WALLET, "available": True, "stale": False,
                       "checked_at": "2026-11-22T00:00:00Z", "error_code": None,
                       "positions": {"available": True, "complete": True, "items": rows}}
        data._checked = time.monotonic()
        return data

    def test_bug_snapshot_does_not_copy_sections(self):
        data = self.reader()
        snapshot = data.snapshot()
        self.assertIs(snapshot["positions"], data._cache["positions"], "sections are shared, not copied")

    def test_control_caller_cannot_change_the_cache(self):
        data = self.reader()
        snapshot = data.snapshot()
        snapshot["available"] = False
        snapshot["stale"] = True
        self.assertTrue(data._cache["available"])
        self.assertFalse(data.snapshot()["stale"])


if __name__ == "__main__":
    unittest.main()

"""P2-14: account balance went blank ~3.2 s after every fill.

A fill calls AccountData.invalidate() to refresh at once; invalidate() dropped
the identity, so _account() treated it as a new account: the cache became
account_changed (available=False) and the reader process was killed.

Run:  python scripts/regress/P2-14.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.account_data import AccountData  # noqa: E402

VALUES = {"POLYMARKET_WALLET_ADDRESS": "0x" + "a1" * 20}


class P2_14(unittest.TestCase):
    def reader(self, values):
        data = AccountData(Path("."), lambda: dict(values))
        data._account()
        killed = []
        data._stop_process = lambda: killed.append(True)
        good = {"schemaVersion": 1, "wallet": VALUES["POLYMARKET_WALLET_ADDRESS"], "available": True,
                "stale": False, "checked_at": "2026-10-01T00:00:00Z", "error_code": None}
        data._cache, data._checked = dict(good), 1.0
        return data, killed

    def test_bug_fill_refresh_keeps_last_balance(self):
        data, killed = self.reader(VALUES)
        data.invalidate()
        self.assertTrue(data._cache["available"], "the last good balance stays until a new one arrives")
        self.assertIsNone(data._cache.get("error_code"))
        self.assertEqual(killed, [], "the reader process keeps running")
        self.assertEqual(data._attempt, float("-inf"), "the next refresh is not throttled")

    def test_control_real_account_change_still_resets(self):
        values = dict(VALUES)
        data, killed = self.reader(values)
        values["POLYMARKET_WALLET_ADDRESS"] = "0x" + "b2" * 20
        data.values_loader = lambda: dict(values)
        data.invalidate()
        self.assertEqual(data._cache["error_code"], "account_changed")
        self.assertEqual(killed, [True])


if __name__ == "__main__":
    unittest.main()

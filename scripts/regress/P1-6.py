"""BUGS.md P1-6: a trade that goes MATCHED then FAILED stays a ghost fill.

The engine writes every revision of one trade with engine_ts = the venue's
match_time, which never changes. _trade_revision accepted a FAILED only when
its time was strictly later, so MATCHED -> FAILED at the same engine_ts was
dropped and the fill counted as real in notional, fees and settlement coverage.

Run:  python scripts/regress/P1-6.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.ledger import _trade_revision  # noqa: E402

T = 1790704238.402
MATCHED = {"trade_id": "t1", "trade_status": "MATCHED", "engine_ts": T, "quantity": 5.0, "price": 0.68}


class P1_6(unittest.TestCase):
    def test_bug_failed_at_same_time_is_applied(self):
        merged = _trade_revision(MATCHED, {"trade_id": "t1", "trade_status": "FAILED", "engine_ts": T})
        self.assertIsNotNone(merged, "a FAILED revision at the same match_time must be applied")
        self.assertEqual(merged["trade_status"], "FAILED")
        self.assertEqual(merged["quantity"], 5.0, "economic fields are kept")

    def test_control_failed_later_still_applied(self):
        merged = _trade_revision(MATCHED, {"trade_id": "t1", "trade_status": "FAILED", "engine_ts": T + 5})
        self.assertEqual(merged["trade_status"], "FAILED")

    def test_edge_confirmed_never_regresses_to_failed(self):
        confirmed = {**MATCHED, "trade_status": "CONFIRMED"}
        self.assertIsNone(_trade_revision(confirmed, {"trade_id": "t1", "trade_status": "FAILED", "engine_ts": T}))

    def test_edge_older_failed_is_ignored(self):
        self.assertIsNone(_trade_revision(MATCHED, {"trade_id": "t1", "trade_status": "FAILED", "engine_ts": T - 1}))


if __name__ == "__main__":
    unittest.main()

"""BUGS.md P2-4: /api/metrics/summary crashed with None - float.

metrics_summary computed exposed_pnl as known_pnl - unsettled_cost whenever
there were unsettled rounds, even when no round had a known PnL yet. Live run
20260930-170531 (two traded rounds, neither with a PnL) returned 400 for
range=run&assetId=btc while summary() gave -7.05 for the same run.

Both paths now share _exposed_pnl().

Run:  python scripts/regress/P2-4.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard import ledger  # noqa: E402


class P2_4(unittest.TestCase):
    def test_bug_unknown_pnl_with_unsettled_rounds(self):
        self.assertAlmostEqual(ledger._exposed_pnl(None, 7.04966, 2), -7.04966)

    def test_control_known_pnl(self):
        self.assertAlmostEqual(ledger._exposed_pnl(1.47513, 6.90355, 2), 1.47513 - 6.90355)

    def test_edge_nothing_traded(self):
        self.assertIsNone(ledger._exposed_pnl(None, 0.0, 0))

    def test_both_paths_use_one_formula(self):
        source = Path(ledger.__file__).read_text(encoding="utf-8")
        self.assertEqual(source.count("_exposed_pnl("), 3, "definition plus summary() and metrics_summary()")


if __name__ == "__main__":
    unittest.main()

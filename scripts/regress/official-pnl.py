"""Settled PnL comes from the venue (user decision 2026-10-01).

Uses the wallet's real closed-positions and positions from Polymarket's
public Data API (fixtures/official-20261001.json, captured 2026-10-01).
Checks against the venue's own numbers, rounds the ledger got wrong or
never had, and that a round traded by the engine but not yet reported by
the venue stays committed cost.

Run:  python scripts/regress/official-pnl.py
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from dashboard import official_pnl  # noqa: E402

FIXTURE = json.loads((Path(__file__).resolve().parent / "fixtures" / "official-20261001.json").read_text(encoding="utf-8"))


class Official(unittest.TestCase):
    def setUp(self):
        self.results = official_pnl.round_results(FIXTURE)

    def test_matches_the_venue_per_round(self):
        self.assertAlmostEqual(self.results[("btc", "1790828100")]["pnl"], 1.6214, places=4)   # redeemed win
        self.assertAlmostEqual(self.results[("btc", "1790828400")]["pnl"], -3.3785, places=4)  # unredeemed loss, fee included

    def test_rounds_the_ledger_got_wrong_or_missed(self):
        self.assertAlmostEqual(self.results[("btc", "1790687700")]["pnl"], -8.0456, places=4, msg="both ladder sides; ledger said -8.60")
        self.assertEqual(self.results[("btc", "1790687700")]["tokens"], 2)
        self.assertAlmostEqual(self.results[("btc", "1790773800")]["pnl"], 1.5726, places=4, msg="ledger had none")
        self.assertAlmostEqual(self.results[("btc", "1790691600")]["pnl"], 2.0022, places=4, msg="ledger had none")

    def test_a1_a_partial_list_is_not_published(self):
        # Page 1 of 3 only: the venue sorts by realised PnL, so it is mostly wins.
        partial = {**FIXTURE, "closed_positions": {**FIXTURE["closed_positions"], "items": FIXTURE["closed_positions"]["items"][:50],
                                                    "complete": False, "error_code": "fetch_or_pagination_failed"}}
        self.assertIsNone(official_pnl.round_results(partial), "BUGS A1: a partial closed-positions list is not complete data")

    def test_a2_a_stale_snapshot_is_not_published(self):
        self.assertIsNone(official_pnl.round_results({**FIXTURE, "stale": True, "available": False}), "BUGS A2")

    def test_unavailable_venue_data_is_not_zero(self):
        self.assertIsNone(official_pnl.round_results({"closed_positions": {"available": False}, "positions": {"available": True}}))
        self.assertIsNone(official_pnl.round_results(None))

    def test_summary(self):
        s = official_pnl.summarize(self.results, [("btc", "1790828100"), ("btc", "1790828400")])
        self.assertEqual((s["settled_wins"], s["settled_losses"]), (1, 1))
        self.assertAlmostEqual(s["settled_pnl"], 1.6214 - 3.3785, places=4)
        self.assertIsNone(official_pnl.summarize(self.results, [])["settled_pnl"])


class Route(unittest.TestCase):
    """_apply_official on the control plane, with the ledger's traded rounds stubbed."""
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
        cls.server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.server)

    def test_run_scope_uses_traded_rounds_and_keeps_pending_cost(self):
        server = self.server
        results = official_pnl.round_results(FIXTURE)
        traded = {("btc", "1790828100"): 3.3785, ("btc", "1790828400"): 3.3785, ("btc", "1790000000"): 3.5}
        class Ledger:
            def traded_rounds(self, run_id, range, asset_id): return traded
        saved = (server._official_results, server._api_ledger)
        server._official_results, server._api_ledger = (lambda: results), (lambda: Ledger())
        try:
            out = server._apply_official({"settled_pnl": 999}, "run", "run", "btc")
        finally:
            server._official_results, server._api_ledger = saved
        self.assertEqual(out["pnl_source"], "polymarket-data-api")
        self.assertAlmostEqual(out["settled_pnl"], 1.6214 - 3.3785, places=4)
        self.assertEqual((out["settled_wins"], out["settled_losses"]), (1, 1))
        self.assertEqual(out["unsettled_rounds"], 1, "a traded round the venue has not reported stays pending")
        self.assertAlmostEqual(out["unsettled_cost"], 3.5)


class OfficialFallback(unittest.TestCase):
    """BUGS A3 + C2 on the control plane: when the venue read fails, keep its
    last good figures marked stale instead of swapping in the ledger's; a
    round the venue settled is no longer counted as pending."""

    def test_a3_last_good_official_marked_stale_and_c2_pending(self):
        spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        good = official_pnl.round_results(FIXTURE)

        class Ledger:
            def traded_rounds(self, run_id, range=None, asset_id=None):
                return {("btc", "1790828100"): 3.38, ("btc", "1790828400"): 3.38}

        saved = (server._official_results, server._api_ledger)
        server._api_ledger = lambda: Ledger()
        try:
            server._official_results = lambda: good
            server._official_last_good = (good, 1_790_900_000.0)
            fresh = server._apply_official({"settled_pnl": 999, "pending_settlements": 1}, "run", "run", "btc")
            self.assertEqual(fresh["pnl_source"], "polymarket-data-api")
            self.assertEqual(fresh["pending_settlements"], 0, "C2: both rounds are settled by the venue, none pending")
            self.assertNotEqual(fresh.get("status"), "stale")
            server._official_results = lambda: None          # the venue read now fails
            later = server._apply_official({"settled_pnl": 999}, "run", "run", "btc")
            self.assertEqual(later["pnl_source"], "polymarket-data-api", "A3: not the ledger's own figures")
            self.assertAlmostEqual(later["settled_pnl"], fresh["settled_pnl"], places=6)
            self.assertEqual(later["status"], "stale")
            self.assertEqual(later["pnl_source_as_of"], 1_790_900_000.0)
        finally:
            server._official_results, server._api_ledger = saved


if __name__ == "__main__":
    unittest.main()

import copy
import unittest
from datetime import datetime, timezone

from dashboard.market_snapshot import canonical_snapshot_fresh, validate_snapshot


class MarketSnapshotTests(unittest.TestCase):
    now = 1_800_000_010.

    def row(self, asset="btc"):
        return {"assetId": asset, "healthy": True, "snapshot": {
            "marketId": "0x" + asset, "roundId": "1800000000", "sequence": 4,
            "sourceAt": self.now - .1, "expiresAt": self.now + 1.9,
            "YES": {"assetId": asset + "-yes", "bid": .49, "ask": .51,
                    "sourceAt": self.now - .1, "expiresAt": self.now + 1.9},
            "NO": {"assetId": asset + "-no", "bid": .49, "ask": .51,
                   "sourceAt": self.now - .1, "expiresAt": self.now + 1.9}}}

    def payload(self, rows, **overrides):
        return {"checked_at": datetime.fromtimestamp(self.now, timezone.utc).isoformat(),
                "collector_online": True, "collector_connected": True,
                "source": "polymarket-ws", "stale_after_ms": 2000,
                "current_markets": rows, **overrides}

    def test_expired_eth_keeps_btc_healthy_and_preserves_both_pairs(self):
        btc, eth = self.row(), self.row("eth")
        eth["snapshot"]["expiresAt"] = self.now - 1
        raw = self.payload([btc, eth])
        original = copy.deepcopy(raw)
        result = validate_snapshot(raw, self.now)
        self.assertTrue(result["collector_online"])
        self.assertTrue(result["partial"])
        self.assertTrue(result["stale"])
        self.assertFalse(result["current_markets"][0]["stale"])
        self.assertTrue(result["current_markets"][1]["stale"])
        self.assertEqual([row["snapshot"] for row in result["current_markets"]],
                         [btc["snapshot"], eth["snapshot"]])
        self.assertEqual(raw, original)
        self.assertTrue(all(row["strategyEligible"] is False for row in result["current_markets"]))

    def test_explicit_row_health_survives_aggregate_offline(self):
        btc, eth = self.row(), self.row("eth")
        eth.update(healthy=False, collector_connected=False, quote_fresh=False)
        result = validate_snapshot(self.payload([btc, eth], collector_online=False,
                                               collector_connected=False), self.now)
        self.assertTrue(result["current_markets"][0]["collector_online"])
        self.assertFalse(result["current_markets"][1]["collector_online"])
        self.assertTrue(result["collector_online"])

    def test_missing_row_health_uses_legacy_transport_state_without_guessing_asset(self):
        row = self.row()
        row.pop("assetId")
        row.pop("healthy")
        raw = self.payload([row])
        result = validate_snapshot(raw, self.now)
        self.assertTrue(result["collector_online"])
        self.assertNotIn("assetId", result["current_markets"][0])
        self.assertNotIn("assetId", result["current_markets"][0]["snapshot"])
        raw["collector_connected"] = False
        self.assertFalse(validate_snapshot(raw, self.now)["collector_online"])

    def test_bad_row_does_not_hide_or_poison_good_row(self):
        good = self.row()
        for bad in (None, {"assetId": "eth", "healthy": True}, self.row("eth")):
            if isinstance(bad, dict) and "snapshot" in bad:
                bad["snapshot"].pop("NO")
            with self.subTest(bad=bad):
                result = validate_snapshot(self.payload([good, bad]), self.now)
                self.assertTrue(result["current_markets"][0]["collector_online"])
                self.assertTrue(result["partial"])
                if isinstance(bad, dict):
                    self.assertFalse(result["current_markets"][1]["collector_online"])

    def test_old_file_retains_every_pair_but_marks_every_row_unavailable(self):
        raw = self.payload([self.row(), self.row("sol")])
        raw["checked_at"] = datetime.fromtimestamp(self.now - 16, timezone.utc).isoformat()
        result = validate_snapshot(raw, self.now)
        self.assertFalse(result["collector_online"])
        self.assertEqual(len(result["current_markets"]), 2)
        for original, row in zip(raw["current_markets"], result["current_markets"]):
            self.assertEqual(row["snapshot"], original["snapshot"])
            self.assertTrue(row["stale"])
            self.assertFalse(row["strategyEligible"])

    def test_explicit_unhealthy_flags_and_identity_conflicts_fail_only_that_row(self):
        cases = [{"healthy": False}, {"quoteFresh": False}, {"bookStatus": {"healthy": False}},
                 {"transport_disconnected": True}, {"bookStatus": {"reason": "stale_book"}},
                 {"marketId": "different"}, {"roundId": "different"}]
        for changes in cases:
            with self.subTest(changes=changes):
                eth = {**self.row("eth"), **changes}
                result = validate_snapshot(self.payload([self.row(), eth]), self.now)
                self.assertTrue(result["current_markets"][0]["collector_online"])
                self.assertFalse(result["current_markets"][1]["collector_online"])
        eth = self.row("eth")
        eth["snapshot"]["assetId"] = "btc"
        result = validate_snapshot(self.payload([self.row(), eth]), self.now)
        self.assertFalse(result["current_markets"][1]["collector_online"])

    def test_row_quote_age_limit_isolated_but_invalid_global_limit_blocks_all(self):
        eth = self.row("eth")
        eth["stale_after_ms"] = 60000
        result = validate_snapshot(self.payload([self.row(), eth]), self.now)
        self.assertTrue(result["current_markets"][0]["collector_online"])
        self.assertFalse(result["current_markets"][1]["collector_online"])
        result = validate_snapshot(self.payload([self.row(), self.row("eth")], stale_after_ms=60000), self.now)
        self.assertFalse(result["collector_online"])
        self.assertTrue(all(row["stale"] for row in result["current_markets"]))

    def test_side_clocks_use_configured_age_and_honor_expiry(self):
        snapshot = self.row()["snapshot"]
        snapshot["sourceAt"] = snapshot["YES"]["sourceAt"] = snapshot["NO"]["sourceAt"] = self.now - 1.5
        self.assertTrue(canonical_snapshot_fresh(snapshot, self.now, 2000))
        self.assertFalse(canonical_snapshot_fresh(snapshot, self.now, 1000))
        snapshot["YES"]["expiresAt"] = self.now
        self.assertFalse(canonical_snapshot_fresh(snapshot, self.now, 2000))

    def test_duplicate_outcome_tokens_are_not_a_valid_pair(self):
        snapshot = self.row()["snapshot"]
        snapshot["NO"]["assetId"] = snapshot["YES"]["assetId"]
        self.assertFalse(canonical_snapshot_fresh(snapshot, self.now))

    def test_legacy_btc_row_is_preserved_without_invented_identity(self):
        row = {"slug": "btc-updown-5m-1800000000", "up_token": "yes", "down_token": "no",
               "start": self.now - 10, "end": self.now + 290,
               "up_bid": .49, "up_ask": .51, "down_bid": .49, "down_ask": .51,
               "quote_at": datetime.fromtimestamp(self.now, timezone.utc).isoformat()}
        result = validate_snapshot(self.payload([row]), self.now)
        self.assertTrue(result["collector_online"])
        self.assertFalse(result["current_markets"][0]["strategyEligible"])
        self.assertNotIn("assetId", result["current_markets"][0])
        self.assertNotIn("roundId", result["current_markets"][0])


if __name__ == "__main__":
    unittest.main()

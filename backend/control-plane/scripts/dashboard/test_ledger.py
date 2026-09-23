import json
from pathlib import Path
import tempfile
import time
import unittest

try:
    from dashboard.ledger import Ledger
except ModuleNotFoundError:
    from ledger import Ledger


class LedgerRegressionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.ledger = Ledger(self.root / "ledger.sqlite")
        self.now = time.time() - 1
        self.slug = "btc-updown-5m-1800000000"
        self.market_id = "0x" + "a" * 64
        self.event_number = 0

    def write(self, run, events, account="account-a"):
        path = self.root / (run + ".jsonl")
        with path.open("a", encoding="utf-8") as stream:
            for event in events:
                self.event_number += 1
                stream.write(json.dumps({"recv_ts": self.now, "event_id": str(self.event_number), **event}) + "\n")
        self.ledger.register_run(run, "live", account, path)
        self.ledger.ingest(run)

    def runtime(self, shares=10, cost=4.1, **extra):
        current = {"marketId": self.market_id, "name": self.slug, "upTokenId": "yes", "downTokenId": "no",
                   "nextStage": 2, "confirmationCount": 1, "upShares": shares, "downShares": 0,
                   "costUsd": cost, "feesVerified": True, "netIfUpUsd": shares - cost, "netIfDownUsd": -cost}
        return {"event": "platform_status", "runtime": {
            "schemaVersion": 1, "engine": "platform", "execution": "strategy", "status": "running", "mode": "live",
            "strategy_id": "btc-reversal", "positions_count": 1,
            "positions": [{"tokenId": "yes", "shares": shares, "costUsd": cost, "realizedPnlUsd": 0}],
            "markets": [{"id": self.market_id, "name": self.slug}],
            "strategy_runtime": {"strategyId": "btc-reversal", "currentRound": current, "rounds": [current]}, **extra}}

    def fill(self, **extra):
        return {"event": "fill", "trade_id": "trade-a", "order_id": "order-a", "market_slug": self.slug,
                "token_id": "yes", "direction": "BUY", "shares": 10, "price": .4, "fee": .1,
                "fee_source": "reported", "trade_status": "CONFIRMED", "engine_ts": self.now, **extra}

    def settlement(self, **extra):
        return {"event": "platform_settlement", "market_id": self.market_id, "market_slug": self.slug,
                "state": "confirmed", "transaction_id": "0x" + "b" * 64, "payout_verified": True,
                "credited_usd": 10, "expected_payout_usd": 10, **extra}

    def test_verified_settlement_is_idempotent_and_fee_complete(self):
        self.write("run-a", [self.fill(), self.runtime(), self.settlement(), self.settlement()])
        summary = self.ledger.summary("run-a")
        self.assertEqual(summary["settled_markets"], 1)
        self.assertAlmostEqual(summary["settled_pnl"], 5.9)
        self.assertEqual(summary["win_rate"], 1)
        page = self.ledger.settlements_page("run-a")
        self.assertEqual(len(page["settlements"]), 1)
        self.assertIsNone(page["settlements"][0]["pnl_error"])
        self.assertAlmostEqual(page["settlements"][0]["pnl"], 5.9)
        self.assertEqual(len(self.ledger.events("run-a", kinds={"settlement"})["events"]), 2)

    def test_unknown_cost_stays_null_and_late_reported_fee_repairs_pnl(self):
        self.write("run-a", [self.fill(fee_source="estimate"), self.runtime(), self.settlement()])
        summary = self.ledger.summary("run-a")
        self.assertEqual(summary["settled_markets"], 1)
        self.assertEqual(summary["settled_pnl_pending"], 1)
        self.assertIsNone(summary["settled_pnl"])
        self.write("run-a", [self.fill()])
        self.assertAlmostEqual(self.ledger.summary("run-a")["settled_pnl"], 5.9)
        self.write("run-b", [self.settlement()])
        self.assertIsNone(self.ledger.summary("run-b")["settled_pnl"])
        self.write("run-c", [self.fill(), self.runtime(), self.settlement(payout_verified=False)])
        self.assertEqual(self.ledger.summary("run-c")["settled_markets"], 0)
        self.assertEqual(self.ledger.summary("run-c")["pending_settlements"], 1)

    def test_confirmed_platform_settlement_without_fills_is_not_traded_market(self):
        self.write("run-a", [self.runtime(), self.settlement()])
        summary = self.ledger.summary("run-a")
        self.assertEqual(summary["settled_markets"], 0)
        self.assertEqual(summary["settled_pnl_pending"], 0)

    def test_late_runtime_snapshot_completes_earlier_confirmed_settlement(self):
        self.write("run-a", [self.fill(), self.settlement()])
        self.assertIsNone(self.ledger.summary("run-a")["settled_pnl"])
        self.write("run-a", [self.runtime()])
        self.assertAlmostEqual(self.ledger.summary("run-a")["settled_pnl"], 5.9)

    def test_draw_is_not_loss(self):
        self.write("run-a", [self.fill(price=1, fee=0), self.runtime(cost=10), self.settlement()])
        summary = self.ledger.summary("run-a")
        self.assertEqual(summary["settled_pnl"], 0)
        self.assertEqual(summary["settled_draws"], 1)
        self.assertEqual(summary["settled_losses"], 0)
        self.assertIsNone(summary["win_rate"])

    def test_position_aliases_staleness_missing_and_unread_journal(self):
        self.write("run-a", [self.runtime()])
        for identity in (None, self.market_id, self.slug):
            view = self.ledger.position("run-a", identity)
            self.assertEqual(view["roundId"], self.slug)
            self.assertEqual(view["marketId"], self.market_id)
            self.assertEqual(view["yesShares"], 10)
            self.assertFalse(view["stale"])
        missing = self.ledger.position("run-a", "missing")
        self.assertFalse(missing["available"])
        self.assertIsNone(missing["yesShares"])
        with (self.root / "run-a.jsonl").open("a", encoding="utf-8") as stream:
            stream.write('{}\n')
        stale = self.ledger.position("run-a", self.slug)
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["yesShares"], 10)
        self.write("old", [{**self.runtime(), "recv_ts": self.now - 30}])
        self.assertTrue(self.ledger.position("old")["stale"])

    def test_order_identity_alias_and_cutoff_are_stable(self):
        order = {"event": "order", "client_order_id": "client-a", "order_id": "order-a", "status": "OPEN",
                 "market_slug": self.slug, "updated_at": self.now, "shares": 10, "price": .4, "filled_shares": 0}
        self.write("run-a", [self.runtime(), order])
        first = self.ledger.orders_page("run-a", market=self.market_id)
        self.assertEqual(first["total"], 1)
        self.write("run-a", [{**order, "status": "FILLED", "filled_shares": 10}, self.fill()])
        frozen = self.ledger.orders_page("run-a", market=self.slug, as_of=first["asOf"], snapshot_event_id=first["snapshotEventId"])
        self.assertEqual(frozen["orders"][0]["status"], "OPEN")
        current = self.ledger.orders_page("run-a", market=self.slug)
        self.assertEqual(current["orders"][0]["status"], "FILLED")
        self.assertAlmostEqual(current["orders"][0]["fee"], .1)

    def test_range_is_utc_account_scoped_and_restart_deduplicated(self):
        self.write("run-a", [self.fill(), self.runtime(), self.settlement()])
        self.write("run-b", [self.fill(), self.runtime(), self.settlement()])
        self.write("other-account", [self.fill(trade_id="other-trade")], account="account-b")
        yesterday = self.now - 86400
        self.write("yesterday", [self.fill(trade_id="yesterday", engine_ts=yesterday, recv_ts=yesterday)])
        today = self.ledger.summary("run-a", range="today")
        self.assertEqual(today["run_count"], 3)
        self.assertEqual(today["fill_count"], 1)
        self.assertEqual(today["settled_markets"], 1)
        self.assertAlmostEqual(today["settled_pnl"], 5.9)
        self.assertEqual(self.ledger.summary("run-a", range="all")["fill_count"], 2)
        with self.assertRaises(ValueError):
            self.ledger.summary("run-a", range="unsupported")


if __name__ == "__main__":
    unittest.main()

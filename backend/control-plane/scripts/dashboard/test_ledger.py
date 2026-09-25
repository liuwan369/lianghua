import json
from pathlib import Path
import sqlite3
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
        self.round_id = "1800000000"
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
        current = {"marketId": self.market_id, "name": self.slug, "roundId": self.round_id,
                   "upTokenId": "yes", "downTokenId": "no",
                   "nextStage": 2, "confirmationCount": 1, "upShares": shares, "downShares": 0,
                   "costUsd": cost, "feesVerified": True, "netIfUpUsd": shares - cost, "netIfDownUsd": -cost}
        return {"event": "platform_status", "runtime": {
            "schemaVersion": 1, "engine": "platform", "execution": "strategy", "status": "running", "mode": "live",
            "strategy_id": "btc-reversal", "positions_count": 1,
            "positions": [{"tokenId": "yes", "shares": shares, "costUsd": cost, "realizedPnlUsd": 0}],
            "markets": [{"id": self.market_id, "name": self.slug, "roundId": self.round_id}],
            "strategy_runtime": {"strategyId": "btc-reversal", "currentRound": current, "rounds": [current]}, **extra}}

    def fill(self, **extra):
        return {"event": "fill", "trade_id": "trade-a", "order_id": "order-a", "market_slug": self.slug,
                "token_id": "yes", "direction": "BUY", "shares": 10, "price": .4, "fee": .1,
                "fee_source": "reported", "trade_status": "CONFIRMED", "engine_ts": self.now, **extra}

    def settlement(self, **extra):
        return {"event": "platform_settlement", "market_id": self.market_id, "market_slug": self.slug,
                "round_id": self.round_id,
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
        self.assertAlmostEqual(summary["estimated_fees"], .1)
        self.write("run-a", [{"event": "fill", "trade_id": "trade-a", "order_id": "order-a",
                              "fee": .1, "fee_source": "reported", "trade_status": "CONFIRMED",
                              "engine_ts": self.now + 1}])
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

    def test_legacy_resolved_event_never_counts_as_final_settlement(self):
        self.write("run-a", [self.fill(), {"event": "resolved", "market_slug": self.slug,
                                            "pnl": 99, "winner": "UP"}])
        summary = self.ledger.summary("run-a")
        self.assertEqual(summary["settled_markets"], 0)
        self.assertIsNone(summary["settled_pnl"])
        self.assertEqual(self.ledger.events("run-a", kinds={"resolved"})["events"][0]["pnl"], None)
        self.assertEqual(self.ledger.runtime_stats("run-a")["market_summaries"][0]["status"], "待结算")

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
        for identity in (None, self.market_id, self.round_id):
            view = self.ledger.position("run-a", identity)
            self.assertEqual(view["roundId"], self.round_id)
            self.assertEqual(view["marketId"], self.market_id)
            self.assertEqual(view["yesShares"], 10)
            self.assertFalse(view["stale"])
        missing = self.ledger.position("run-a", "missing")
        self.assertFalse(missing["available"])
        self.assertIsNone(missing["yesShares"])
        with (self.root / "run-a.jsonl").open("a", encoding="utf-8") as stream:
            stream.write('{}\n')
        stale = self.ledger.position("run-a", self.round_id)
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["yesShares"], 10)
        self.write("old", [{**self.runtime(), "recv_ts": self.now - 30}])
        self.assertTrue(self.ledger.position("old")["stale"])

    def test_order_identity_alias_and_cutoff_are_stable(self):
        order = {"event": "order", "client_order_id": "client-a", "order_id": "order-a", "status": "OPEN",
                 "market_slug": self.slug, "updated_at": self.now, "shares": 10, "price": .4, "filled_shares": 0}
        order.update({"created_at": self.now - 1, "average_price": .4})
        self.write("run-a", [self.runtime(), order])
        first = self.ledger.orders_page("run-a", market=self.market_id)
        self.assertEqual(first["total"], 1)
        by_round = self.ledger.orders_page("run-a", market=self.round_id)
        self.assertEqual(by_round["total"], 1)
        self.write("run-a", [{**order, "status": "FILLED", "filled_shares": 10}, self.fill()])
        frozen = self.ledger.orders_page("run-a", market=self.slug, as_of=first["asOf"], snapshot_event_id=first["snapshotEventId"])
        self.assertEqual(frozen["orders"][0]["status"], "OPEN")
        current = self.ledger.orders_page("run-a", market=self.slug)
        self.assertEqual(current["orders"][0]["status"], "FILLED")
        self.assertAlmostEqual(current["orders"][0]["fee"], .1)
        self.assertAlmostEqual(current["orders"][0]["created_at"], self.now - 1)
        self.assertAlmostEqual(current["orders"][0]["average_price"], .4)
        self.assertEqual(self.ledger.summary("run-a")["order_count"], 1)

    def test_summary_counts_trade_without_order_projection(self):
        self.write("run-a", [self.fill(order_id="fill-only-order", trade_id="fill-only-trade")])
        summary = self.ledger.summary("run-a")
        self.assertEqual(summary["fill_count"], 1)
        self.assertEqual(summary["order_count"], 1)

    def test_account_order_count_deduplicates_restarted_order_identity(self):
        order = {"event": "order", "client_order_id": "client-reused", "order_id": "order-reused",
                 "status": "OPEN", "market_id": self.market_id, "round_id": self.round_id,
                 "market_slug": self.slug, "updated_at": self.now}
        self.write("run-a", [order])
        self.write("run-b", [order])
        summary = self.ledger.metrics_summary("run-a", range="all")
        self.assertEqual(summary["order_count"], 1)
        self.assertEqual(summary["fill_count"], 0)

    def test_account_order_count_merges_late_market_identity_across_restart(self):
        order = {"event": "order", "client_order_id": "client-late-order", "order_id": "order-late",
                 "status": "OPEN", "market_slug": self.slug, "updated_at": self.now}
        self.write("run-a", [order])
        self.write("run-b", [{**order, "market_id": self.market_id, "round_id": self.round_id}])
        summary = self.ledger.metrics_summary("run-a", range="all")
        self.assertEqual(summary["order_count"], 1)

    def test_account_order_count_splits_reused_order_id_when_identity_conflicts(self):
        order = {"event": "order", "client_order_id": "client-reused", "order_id": "order-reused",
                 "status": "OPEN", "market_id": self.market_id, "market_slug": self.slug,
                 "updated_at": self.now}
        self.write("run-a", [{**order, "round_id": self.round_id}])
        self.write("run-b", [{**order, "round_id": "1800000300"}])
        summary = self.ledger.metrics_summary("run-a", range="all")
        self.assertEqual(summary["order_count"], 2)

    def test_composite_identity_filters_do_not_cross_assets(self):
        btc_order = {"event": "order", "assetId": "btc", "client_order_id": "btc-client",
                     "order_id": "shared-order", "status": "OPEN", "market_id": self.market_id,
                     "round_id": self.round_id, "market_slug": self.slug, "updated_at": self.now}
        eth_order = {"event": "order", "assetId": "eth", "client_order_id": "eth-client",
                     "order_id": "shared-order", "status": "OPEN", "market_id": self.market_id,
                     "round_id": self.round_id, "market_slug": self.slug, "updated_at": self.now}
        btc_fill = self.fill(assetId="btc", order_id="shared-order", trade_id="shared-trade")
        eth_fill = self.fill(assetId="eth", order_id="shared-order", trade_id="shared-trade")
        btc_fill.update(market_id=self.market_id, round_id=self.round_id)
        eth_fill.update(market_id=self.market_id, round_id=self.round_id)
        btc_settlement = self.settlement(assetId="btc")
        eth_settlement = self.settlement(assetId="eth")
        self.write("run-a", [btc_order, eth_order, btc_fill, eth_fill, btc_settlement, eth_settlement])

        btc_orders = self.ledger.orders_page("run-a", asset_id="btc", market_id=self.market_id,
                                             round_id=self.round_id)
        eth_orders = self.ledger.orders_page("run-a", asset_id="eth", market_id=self.market_id,
                                             round_id=self.round_id)
        self.assertEqual(btc_orders["total"], 1)
        self.assertEqual(eth_orders["total"], 1)
        self.assertEqual(btc_orders["orders"][0]["asset_id"], "btc")
        self.assertEqual(eth_orders["orders"][0]["asset_id"], "eth")
        self.assertEqual(len(btc_orders["orders"][0]["fills"]), 1)
        self.assertEqual(len(eth_orders["orders"][0]["fills"]), 1)

        self.assertEqual(len(self.ledger.events("run-a", asset_id="eth", market_id=self.market_id,
                                                round_id=self.round_id)["events"]), 3)
        self.assertEqual(len(self.ledger.settlements_page("run-a", asset_id="eth",
                                                           market_id=self.market_id,
                                                           round_id=self.round_id)["settlements"]), 1)

    def test_position_composite_identity_selects_the_requested_asset(self):
        runtime = self.runtime()["runtime"]
        btc_round = runtime["strategy_runtime"]["currentRound"]
        eth_round = json.loads(json.dumps(btc_round))
        eth_round.update({"assetId": "eth", "upTokenId": "eth-yes", "downTokenId": "eth-no",
                          "upShares": 7, "downShares": 0, "costUsd": 3.2})
        runtime["markets"] = [{**runtime["markets"][0], "assetId": "btc"},
                               {**runtime["markets"][0], "assetId": "eth"}]
        runtime["strategy_runtime"]["rounds"] = [btc_round, eth_round]
        runtime["positions"] = [
            {"tokenId": "yes", "shares": 10, "costUsd": 4.1, "realizedPnlUsd": 0},
            {"tokenId": "eth-yes", "shares": 7, "costUsd": 3.2, "realizedPnlUsd": 0},
        ]
        runtime["positions_count"] = 2
        self.write("run-a", [{"event": "platform_status", "runtime": runtime}])
        btc = self.ledger.position("run-a", self.round_id, asset_id="btc", market_id=self.market_id)
        eth = self.ledger.position("run-a", self.round_id, asset_id="eth", market_id=self.market_id)
        self.assertEqual(btc["yesShares"], 10)
        self.assertEqual(eth["yesShares"], 7)

    def test_order_abandoned_and_error_message_are_visible(self):
        self.write("run-a", [{"event": "order_abandoned", "order_id": "abandoned-order",
                              "message": "venue timeout", "market_slug": self.slug}])
        item = self.ledger.events("run-a")["events"][0]
        self.assertEqual(item["event"], "error")
        self.assertEqual(item["source_event"], "order_abandoned")
        self.assertEqual(item["message"], "venue timeout")

    def test_runtime_mapping_backfills_late_market_and_round_identity(self):
        # Runtime status is allowed to arrive after journal business events.
        # The ledger must use that observed mapping, never infer a round from
        # the event timestamp.
        order = {"event": "order", "client_order_id": "client-late", "order_id": "order-late",
                 "status": "OPEN", "market_slug": self.slug, "updated_at": self.now,
                 "shares": 10, "price": .4, "filled_shares": 0}
        settlement = {"event": "platform_settlement", "market_id": self.market_id,
                      "state": "pending", "payout_verified": False}
        runtime = self.runtime()
        runtime["runtime"]["markets"][0]["roundId"] = self.round_id
        runtime["runtime"]["strategy_runtime"]["currentRound"]["roundId"] = self.round_id
        runtime["runtime"]["strategy_runtime"]["rounds"][0]["roundId"] = self.round_id
        self.write("run-a", [order, self.fill(trade_id="late-trade", market_id=self.market_id), settlement, runtime])
        events = self.ledger.events("run-a", kinds={"order", "fill", "settlement"})["events"]
        by_event = {item["event"]: item for item in events}
        for item in by_event.values():
            self.assertEqual(item["marketId"] if "marketId" in item else item["market_id"], self.market_id)
            self.assertEqual(item["roundId"] if "roundId" in item else item["round_id"], self.round_id)
        page = self.ledger.settlements_page("run-a")["settlements"]
        self.assertEqual(page[0]["market_id"], self.market_id)
        self.assertEqual(page[0]["round_id"], self.round_id)

    def test_multi_asset_round_migration_uses_namespaced_alias_key(self):
        path = self.root / "legacy.sqlite"
        ledger = Ledger(path)
        journal = self.root / "legacy.jsonl"
        ledger.register_run("run-eth", "live", "account-a", journal)
        market_id = "0x" + "c" * 64
        slug = "eth-updown-5m-1800000000"
        round_id = "1800000000"
        runtime = {"markets": [{"id": market_id, "name": slug, "assetId": "eth", "roundId": round_id}]}
        db = sqlite3.connect(path)
        try:
            db.execute("INSERT INTO platform_runtime(run_id,source_at,payload) VALUES(?,?,?)",
                       ("run-eth", self.now, json.dumps(runtime)))
            db.execute("INSERT INTO markets(run_id,market,asset_id) VALUES(?,?,?)",
                       ("run-eth", slug, "btc"))
            db.execute("INSERT INTO market_details(run_id,market,asset_id,last_time) VALUES(?,?,?,?)",
                       ("run-eth", slug, "btc", self.now))
            settlement_payload = {"event": "settlement", "market_slug": slug,
                                  "market_id": market_id, "state": "confirmed",
                                  "payout_verified": True, "transaction_id": "0x" + "d" * 64,
                                  "credited_usd": 1, "expected_payout_usd": 1, "time": self.now}
            db.execute("INSERT INTO events(run_id,byte_offset,kind,asset_id,payload) VALUES(?,?,?,?,?)",
                       ("run-eth", 10, "settlement", "btc", json.dumps(settlement_payload)))
            db.execute("INSERT INTO settlement_details(run_id,market,market_id,asset_id,source_at,verified,payload) "
                       "VALUES(?,?,?,?,?,?,?)",
                       ("run-eth", slug, market_id, "btc", self.now, 1, json.dumps(settlement_payload)))
            # Simulate a database where v1 was recorded before the
            # multi-asset repair was shipped. v1 must remain present while v2
            # reruns the repair exactly once.
            db.execute("DELETE FROM projection_migrations WHERE name='round_identity_v2'")
            db.commit()
        finally:
            db.close()
        Ledger(path)
        db = sqlite3.connect(path)
        try:
            market = db.execute("SELECT market,asset_id,round_id FROM markets WHERE run_id=? AND asset_id=?",
                                ("run-eth", "eth")).fetchone()
            detail = db.execute("SELECT market,asset_id,round_id FROM market_details WHERE run_id=? AND asset_id=?",
                                ("run-eth", "eth")).fetchone()
        finally:
            db.close()
        self.assertEqual(market, ("eth::" + slug, "eth", round_id))
        self.assertEqual(detail, ("eth::" + slug, "eth", round_id))
        db = sqlite3.connect(path)
        try:
            markers = {row[0] for row in db.execute("SELECT name FROM projection_migrations")}
        finally:
            db.close()
        self.assertIn("round_identity_v1", markers)
        self.assertIn("round_identity_v2", markers)
        db = sqlite3.connect(path)
        try:
            settlements = db.execute("SELECT market,asset_id,round_id FROM settlement_details WHERE run_id=?",
                                     ("run-eth",)).fetchall()
        finally:
            db.close()
        self.assertEqual(settlements, [("eth::" + slug, "eth", round_id)])

    def test_unknown_round_identity_is_not_guessed(self):
        fill = self.fill(market_slug="unknown-old-slug", trade_id="unknown-round")
        self.write("run-a", [fill])
        item = self.ledger.events("run-a", kinds={"fill"})["events"][0]
        self.assertIsNone(item["market_id"])
        self.assertIsNone(item["round_id"])

    def test_explicit_old_round_is_not_reassigned_by_current_runtime(self):
        self.write("run-a", [self.fill(market_id=self.market_id, round_id="old-round"), self.runtime()])
        item = self.ledger.events("run-a", kinds={"fill"})["events"][0]
        self.assertEqual(item["round_id"], "old-round")
        self.assertEqual(len(self.ledger.events("run-a", round_id=self.round_id)["events"]), 0)

    def test_unknown_and_invalid_asset_do_not_become_btc(self):
        self.write("run-a", [self.fill(market_slug="unidentified", trade_id="unknown"),
                             self.fill(assetId="!invalid", trade_id="invalid")])
        events = self.ledger.events("run-a", kinds={"fill"})["events"]
        self.assertTrue(all(item["asset_id"] is None for item in events))
        self.assertEqual(self.ledger.events("run-a", asset_id="btc")["events"], [])
        self.assertEqual(self.ledger.metrics_summary("run-a", range="run", asset_id="btc")["fill_count"], 0)
        with self.assertRaises(ValueError):
            self.ledger.metrics_summary("run-a", range="run", asset_id="!invalid")

    def test_shared_economic_ids_are_distinct_across_assets_and_rounds(self):
        entries = []
        identities = [("btc", "market-a", "round-a", .1), ("eth", "market-a", "round-a", .2),
                      ("btc", "market-b", "round-b", .3)]
        for asset, market, round_id, fee in identities:
            entries.extend([
                {"event": "order", "assetId": asset, "market_id": market, "market_slug": market,
                 "round_id": round_id, "client_order_id": "same-client", "order_id": "same-order",
                 "status": "FILLED", "filled_shares": 10, "updated_at": self.now},
                self.fill(assetId=asset, market_id=market, market_slug=market, round_id=round_id,
                          trade_id="same-trade", order_id="same-order", fee=fee),
            ])
        self.write("run-a", entries)
        self.write("run-b", entries)
        self.assertEqual(self.ledger.orders_page("run-a")["total"], 3)
        self.assertEqual(self.ledger.summary("run-a")["fill_count"], 3)
        self.assertEqual(self.ledger.metrics_summary("run-a", range="all")["fill_count"], 3)
        for asset, market, round_id, fee in identities:
            page = self.ledger.orders_page("run-a", asset_id=asset, market_id=market, round_id=round_id)
            self.assertEqual(page["total"], 1)
            self.assertEqual(len(page["orders"][0]["fills"]), 1)
            self.assertAlmostEqual(page["orders"][0]["fee"], fee)
            summary = self.ledger.metrics_summary("run-a", range="run", asset_id=asset, market_id=market,
                                                  round_id=round_id)
            self.assertEqual(summary["fill_count"], 1)
            self.assertEqual(summary["run_count"], 1)
            self.assertAlmostEqual(summary["fees"], fee)
        self.assertEqual(self.ledger.orders_page("run-a", asset_id="eth", market_id="market-b",
                                                round_id="round-a")["total"], 0)

    def test_legacy_null_order_identity_keeps_one_latest_lifecycle(self):
        self.write("run-a", [{"event": "order", "client_order_id": "legacy", "order_id": "order",
                              "status": "OPEN"},
                             {"event": "order", "client_order_id": "legacy", "order_id": "order",
                              "status": "CANCELLED"}])
        page = self.ledger.orders_page("run-a")
        self.assertEqual(page["total"], 1)
        self.assertEqual(page["orders"][0]["status"], "CANCELLED")

    def test_position_ambiguous_round_requires_composite_identity(self):
        runtime = self.runtime()["runtime"]
        first = runtime["strategy_runtime"]["currentRound"]
        second = {**first, "assetId": "eth", "marketId": "market-eth", "name": "eth-round"}
        runtime["strategy_runtime"]["rounds"] = [first, second]
        self.write("run-a", [{"event": "platform_status", "runtime": runtime}])
        ambiguous = self.ledger.position("run-a", self.round_id)
        self.assertFalse(ambiguous["available"])
        self.assertIn("ambiguous", ambiguous["error"])
        self.assertTrue(self.ledger.position("run-a", self.round_id, asset_id="btc", market_id=self.market_id)["available"])

    def test_eth_settlement_late_runtime_preserves_pnl_after_position_cleared(self):
        runtime = self.runtime()["runtime"]
        runtime["assetId"] = "eth"
        runtime["markets"][0]["assetId"] = "eth"
        runtime["strategy_runtime"]["currentRound"]["assetId"] = "eth"
        self.write("run-a", [self.fill(assetId="eth", market_id=self.market_id, round_id=self.round_id),
                             self.settlement(assetId="eth"), {"event": "platform_status", "runtime": runtime}])
        page = self.ledger.settlements_page("run-a", asset_id="eth")["settlements"]
        self.assertEqual(len(page), 1)
        self.assertAlmostEqual(page[0]["pnl"], 5.9)
        runtime["strategy_runtime"]["currentRound"]["upShares"] = 0
        runtime["strategy_runtime"]["currentRound"]["costUsd"] = 0
        runtime["positions"] = []
        runtime["positions_count"] = 0
        self.write("run-a", [{"event": "platform_status", "runtime": runtime, "recv_ts": self.now + .1}])
        page = self.ledger.settlements_page("run-a", asset_id="eth")["settlements"]
        self.assertEqual(len(page), 1)
        self.assertAlmostEqual(page[0]["pnl"], 5.9)

    def test_older_runtime_cannot_overwrite_mapping_or_settlement_evidence(self):
        self.write("run-a", [self.fill(), self.runtime(), self.settlement()])
        older = self.runtime()
        older["recv_ts"] = self.now - 1
        older["runtime"]["markets"][0]["roundId"] = "old-round"
        older["runtime"]["strategy_runtime"]["currentRound"]["roundId"] = "old-round"
        self.write("run-a", [older])
        item = self.ledger.events("run-a", kinds={"fill"})["events"][0]
        self.assertEqual(item["round_id"], self.round_id)
        self.assertAlmostEqual(self.ledger.summary("run-a")["settled_pnl"], 5.9)

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

    def test_same_economic_fill_across_restart_counts_once(self):
        self.write("run-a", [self.fill(trade_id="same-trade", order_id="same-order")])
        self.write("run-b", [self.fill(trade_id="same-trade", order_id="same-order")])
        summary = self.ledger.summary("run-a", range="all")
        self.assertEqual(summary["run_count"], 2)
        self.assertEqual(summary["fill_count"], 1)
        self.assertAlmostEqual(summary["fill_notional"], 4.0)

    def test_late_market_identity_does_not_duplicate_cross_run_fill(self):
        self.write("run-a", [self.fill(market_id=None, round_id=None)])
        self.write("run-b", [self.fill(market_id=self.market_id, round_id=self.round_id)])
        summary = self.ledger.summary("run-a", range="all")
        self.assertEqual(summary["fill_count"], 1)
        self.assertAlmostEqual(summary["fill_notional"], 4.0)

    def test_failed_fill_can_be_repaired_only_by_newer_confirmation(self):
        self.write("run-a", [self.fill(trade_id="repair-trade", order_id="repair-order",
                                        trade_status="FAILED", fee_source="estimate", engine_ts=self.now + 2)])
        self.assertEqual(self.ledger.summary("run-a")["estimated_fees"], 0)
        self.write("run-b", [self.fill(trade_id="repair-trade", order_id="repair-order",
                                        trade_status="CONFIRMED", engine_ts=self.now + 1)])
        self.assertEqual(self.ledger.summary("run-a", range="all")["fill_count"], 0)
        self.write("run-c", [self.fill(trade_id="repair-trade", order_id="repair-order",
                                        trade_status="CONFIRMED", engine_ts=self.now + 3)])
        self.assertEqual(self.ledger.summary("run-a", range="all")["fill_count"], 1)

    def test_confirmed_fill_is_terminal_against_later_failure(self):
        self.write("run-a", [self.fill(trade_id="terminal-trade", order_id="terminal-order")])
        self.write("run-b", [self.fill(trade_id="terminal-trade", order_id="terminal-order",
                                        trade_status="FAILED", engine_ts=self.now + 1)])
        summary = self.ledger.summary("run-a", range="all")
        self.assertEqual(summary["fill_count"], 1)
        self.assertAlmostEqual(summary["fill_notional"], 4.0)


if __name__ == "__main__":
    unittest.main()

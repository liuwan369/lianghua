"""Local HTTP regressions; no account credentials or exchange calls."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("dashboard_server_test", SCRIPTS / "system-dashboard-server.py")
server_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server_module)

from dashboard.strategy_config import default_config
from dashboard.account_data import AccountData
from dashboard.read_model import ReadModel, atomic_json


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.engine_patch = patch.object(server_module, "TRADING_ROOT", self.root)
        self.engine_patch.start()
        server_module._modern_response_cache.clear()
        server_module._modern_market_cache = {}
        server_module._market_pool_cache = {}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), server_module.make_handler(self.root))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.engine_patch.stop()
        self.temporary.cleanup()

    def request(self, path, payload=None, method=None):
        client = HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            client.request(method or ("POST" if payload is not None else "GET"), path,
                           body=json.dumps(payload) if payload is not None else None,
                           headers={"Content-Type": "application/json"})
            response = client.getresponse()
            return response.status, json.loads(response.read())
        finally:
            client.close()

    def assert_metadata(self, value):
        self.assertTrue({"schemaVersion", "source", "asOf", "stale", "error"} <= set(value))
        self.assertTrue(value["asOf"] is None or type(value["asOf"]) in (int, float))

    def test_mutation_auth_precedes_side_effects(self):
        with patch.object(server_module, "_control_request_error", return_value=(401, "authentication_required")), \
                patch.object(server_module, "strategy_config_store") as store:
            for path in ("/api/strategy/drafts", "/api/strategy/activate", "/api/runtime/commands",
                         "/api/orders/id/cancel", "/api/runtime/flatten"):
                code, body = self.request(path, {})
                self.assertEqual(code, 401)
                self.assertFalse(body["accepted"])
                self.assert_metadata(body)
            store.assert_not_called()

    def test_draft_then_publish_and_unsupported_round(self):
        with patch.object(server_module, "_control_request_error", return_value=None):
            code, draft = self.request("/api/strategy/drafts", {"expectedRevision": 0, "config": default_config()})
            self.assertEqual(code, 200)
            self.assertEqual(server_module.strategy_config_store().get()["savedRevision"], 0)
            request = {"expectedRevision": 0, "draftId": draft["draftId"]}
            code, rejected = self.request("/api/strategy/activate", {**request, "effectiveRoundId": "btc-updown-5m-1"})
            self.assertEqual(code, 501)
            self.assertFalse(rejected["accepted"])
            code, published = self.request("/api/strategy/activate", request)
            self.assertEqual(code, 200)
            self.assertEqual(published["status"], "published")
            self.assertEqual(server_module.strategy_config_status()["assetId"], "btc")
            self.assertEqual(server_module.strategy_config_store().get()["savedRevision"], 1)
            self.assert_metadata(published)

    def test_runtime_command_rejects_selected_asset_mismatch(self):
        server_module.strategy_config_store().save(default_config(), 0)
        with patch.object(server_module, "_control_request_error", return_value=None):
            code, body = self.request("/api/runtime/commands", {
                "action": "start", "strategyId": "btc-reversal", "assetId": "eth",
                "revision": 1, "requestId": "00000000-0000-4000-8000-000000000001",
            })
        self.assertEqual(code, 400)
        self.assertFalse(body.get("ok", True))
        self.assertIn("assetId", body["error"])
        with patch.object(server_module, "_control_request_error", return_value=None):
            code, body = self.request("/api/runtime/commands", {
                "action": "start", "strategyId": "btc-reversal", "assetId": "btc",
                "marketIds": ["eth"], "revision": 1,
                "requestId": "00000000-0000-4000-8000-000000000002",
            })
            self.assertEqual(code, 400)
            self.assertFalse(body.get("ok", True))
            self.assertIn("marketIds", body["error"])

    def test_unimplemented_commands_do_not_report_success(self):
        with patch.object(server_module, "_control_request_error", return_value=None):
            for path in ("/api/orders/id/cancel", "/api/runtime/flatten"):
                code, body = self.request(path, {})
                self.assertEqual(code, 501)
                self.assertFalse(body["accepted"])
                self.assert_metadata(body)

    def test_market_identity_time_and_last_success(self):
        now = time.time()
        row = {"slug": "btc-updown-5m-1", "condition_id": "0xcondition", "round_id": "1800000000", "start": now - 5,
               "end": now + 295, "quote_at": now, "stale_after_ms": 2000,
               "up_bid": .4, "up_ask": .5, "down_bid": .5, "down_ask": .6}
        raw = {"collector_online": True, "source": "platform-runtime", "current_markets": [row]}
        with patch.object(server_module, "_running_engine_market_status", return_value=raw), \
                patch.object(server_module, "cached_live_status") as collector:
            code, first = self.request("/api/markets")
            collector.assert_not_called()
        self.assertEqual(code, 200)
        market = first["items"][0]
        self.assertEqual(market["marketId"], "0xcondition")
        self.assertEqual(market["roundId"], row["round_id"])
        self.assertIsNone(market["volume"])
        self.assertIsInstance(market["quoteAt"], float)
        self.assertTrue(market["stale"])
        self.assertFalse(market["depthAvailable"])
        with patch.object(server_module, "_running_engine_market_status", return_value=None), \
                patch.object(server_module, "cached_live_status", return_value={"collector_online": False, "error": "offline"}):
            _, stale = self.request("/api/markets")
        self.assertTrue(stale["stale"])
        self.assertIsNone(stale["items"])
        self.assertIsNone(stale["asOf"])

    def test_modern_market_preserves_runtime_paired_snapshot(self):
        levels = [[0.49 - i * 0.01, 10 - i] for i in range(5)]
        asks = [[0.51 + i * 0.01, 11 + i] for i in range(5)]
        now = time.time()
        snapshot = {"marketId": "0xaccepted", "roundId": "1800000000", "sequence": 7,
                    "sourceAt": now, "expiresAt": now + 1.5,
                    "YES": {"assetId": "yes-token", "bid": .49, "ask": .51, "bids": levels, "asks": asks},
                    "NO": {"assetId": "no-token", "bid": .49, "ask": .51, "bids": levels, "asks": asks}}
        with patch.object(server_module, "_running_engine_market_status", return_value={
                "collector_online": True, "source": "platform-runtime", "current_markets": [
                    {"paired_snapshot": snapshot, "start": now - 1, "end": now + 299}]}), \
                patch.object(server_module, "cached_live_status", side_effect=AssertionError("collector fallback")):
            value = server_module._modern_markets()
        market = value["items"][0]
        self.assertEqual(market["roundId"], "1800000000")
        self.assertEqual(market["round_id"], "1800000000")
        self.assertEqual(market["yes"]["assetId"], "yes-token")
        self.assertEqual(market["orderBook"]["yes"]["bids"], levels)
        self.assertEqual(market["sequence"], 7)
        self.assertEqual(market["sourceAt"], now)
        self.assertEqual(market["expiresAt"], now + 1.5)
        self.assertTrue(market["depthAvailable"])
        self.assertFalse(market["stale"])

    def test_collector_canonical_snapshot_is_lossless_but_not_strategy_eligible(self):
        now = time.time()
        levels = [[0.49 - i * 0.01, 10 - i] for i in range(5)]
        asks = [[0.51 + i * 0.01, 11 + i] for i in range(5)]
        snapshot = {"marketId": "0xcollector", "roundId": "1800000000", "sequence": 4,
                    "sourceAt": now - .1, "expiresAt": now + 1.9,
                    "YES": {"assetId": "collector-yes", "bid": .49, "ask": .51,
                            "sourceAt": now - .1, "bids": levels, "asks": asks},
                    "NO": {"assetId": "collector-no", "bid": .49, "ask": .51,
                           "sourceAt": now - .1, "bids": levels, "asks": asks}}
        raw = {"checked_at": datetime.fromtimestamp(now, timezone.utc).isoformat(),
               "collector_online": True, "collector_connected": True,
               "source": "polymarket-ws", "stale_after_ms": 2000,
               "current_markets": [{"snapshot": snapshot, "slug": "btc-updown-5m-1800000000",
                                     "name": "BTC", "start": now - 1, "end": now + 299}]}
        validated = server_module.validate_snapshot(raw, now=now)
        self.assertTrue(validated["collector_online"])
        with patch.object(server_module, "_running_engine_market_status", return_value=None), \
                patch.object(server_module, "cached_live_status", return_value=validated):
            value = server_module._modern_markets()
        market = value["items"][0]
        self.assertEqual(market["marketId"], "0xcollector")
        self.assertEqual(market["roundId"], "1800000000")
        self.assertEqual(market["orderBook"]["yes"]["bids"], levels)
        self.assertEqual(market["sequence"], 4)
        self.assertEqual(market["sourceAt"], now - .1)
        self.assertEqual(market["expiresAt"], now + 1.9)
        self.assertTrue(market["depthAvailable"])
        self.assertFalse(market["strategyEligible"])
        self.assertFalse(market["stale"])

    def test_expired_collector_canonical_snapshot_is_retained_and_marked_stale(self):
        now = time.time()
        snapshot = {"marketId": "0xcollector", "roundId": "1800000000", "sequence": 4,
                    "sourceAt": now - 3, "expiresAt": now - 1,
                    "YES": {"assetId": "collector-yes", "bid": .49, "ask": .51},
                    "NO": {"assetId": "collector-no", "bid": .49, "ask": .51}}
        raw = {"checked_at": datetime.fromtimestamp(now, timezone.utc).isoformat(),
               "collector_online": True, "collector_connected": True,
               "source": "polymarket-ws", "stale_after_ms": 2000,
               "current_markets": [{"snapshot": snapshot}]}
        validated = server_module.validate_snapshot(raw, now=now)
        self.assertFalse(validated["collector_online"])
        self.assertEqual(validated["current_markets"][0]["snapshot"], snapshot)

    def test_old_collector_canonical_snapshot_is_retained_but_not_usable(self):
        now = time.time()
        snapshot = {"marketId": "0xcollector", "roundId": "1800000000", "sequence": 5,
                    "sourceAt": now - 5, "expiresAt": now + 5,
                    "YES": {"assetId": "collector-yes", "bid": .49, "ask": .51,
                            "sourceAt": now - 5},
                    "NO": {"assetId": "collector-no", "bid": .49, "ask": .51,
                           "sourceAt": now - 5}}
        raw = {"checked_at": datetime.fromtimestamp(now, timezone.utc).isoformat(),
               "collector_online": True, "collector_connected": True,
               "source": "polymarket-ws", "stale_after_ms": 2000,
               "current_markets": [{"snapshot": snapshot}]}
        validated = server_module.validate_snapshot(raw, now=now)
        self.assertFalse(validated["collector_online"])
        self.assertEqual(validated["current_markets"][0]["snapshot"], snapshot)
        with patch.object(server_module, "_running_engine_market_status", return_value=None), \
                patch.object(server_module, "cached_live_status", return_value=validated):
            value = server_module._modern_markets()
        self.assertTrue(value["stale"])
        self.assertTrue(value["items"][0]["stale"])
        self.assertFalse(value["items"][0]["strategyEligible"])

    def test_invalid_collector_freshness_limit_fails_closed(self):
        now = time.time()
        snapshot = {"marketId": "0xcollector", "roundId": "1800000000", "sequence": 6,
                    "sourceAt": now - 1, "expiresAt": now + 5,
                    "YES": {"assetId": "collector-yes", "bid": .49, "ask": .51},
                    "NO": {"assetId": "collector-no", "bid": .49, "ask": .51}}
        raw = {"checked_at": datetime.fromtimestamp(now, timezone.utc).isoformat(),
               "collector_online": True, "collector_connected": True,
               "source": "polymarket-ws", "stale_after_ms": 60000,
               "current_markets": [{"snapshot": snapshot}]}
        validated = server_module.validate_snapshot(raw, now=now)
        self.assertFalse(validated["collector_online"])
        self.assertEqual(validated["current_markets"][0]["snapshot"], snapshot)
        with patch.object(server_module, "_running_engine_market_status", return_value=None), \
                patch.object(server_module, "cached_live_status", return_value=validated):
            value = server_module._modern_markets()
        self.assertTrue(value["items"][0]["stale"])
        self.assertFalse(value["items"][0]["strategyEligible"])

    def test_runtime_snapshot_uses_strategy_quote_age_and_parent_stale(self):
        now = time.time()
        snapshot = {"marketId": "0xruntime", "roundId": "1800000000", "sequence": 8,
                    "sourceAt": now - 3, "expiresAt": now + 5,
                    "YES": {"assetId": "runtime-yes", "bid": .49, "ask": .51,
                            "sourceAt": now - 3},
                    "NO": {"assetId": "runtime-no", "bid": .49, "ask": .51,
                           "sourceAt": now - 3}}
        status = {"running": True, "stats": {"runtime": {
            "engine": "platform", "status": "running", "stale": False,
            "source_at": now, "expires_at": now + 10,
            "strategy_runtime": {"config": {"maxQuoteAgeSeconds": 2}},
            "markets": [{"id": "0xruntime", "name": "btc-updown-5m-1800000000",
                         "startsAt": now - 5, "endsAt": now + 295}],
            "snapshots": [snapshot]}}}
        market_status = server_module._running_engine_market_status(status)
        self.assertEqual(market_status["current_markets"][0]["stale_after_ms"], 2000)
        market = server_module._modern_market(market_status["current_markets"][0], now=now)
        self.assertTrue(market["stale"])
        self.assertFalse(market["strategyEligible"])

    def test_runtime_parent_stale_blocks_fresh_snapshot(self):
        now = time.time()
        snapshot = {"marketId": "0xruntime", "roundId": "1800000000", "sequence": 9,
                    "sourceAt": now, "expiresAt": now + 5,
                    "YES": {"assetId": "runtime-yes", "bid": .49, "ask": .51},
                    "NO": {"assetId": "runtime-no", "bid": .49, "ask": .51}}
        status = {"running": True, "stats": {"runtime": {
            "engine": "platform", "status": "running", "stale": True,
            "source_at": now, "expires_at": now + 10,
            "markets": [{"id": "0xruntime", "name": "btc-updown-5m-1800000000"}],
            "snapshots": [snapshot]}}}
        market_status = server_module._running_engine_market_status(status)
        market = server_module._modern_market(market_status["current_markets"][0], now=now)
        self.assertTrue(market["stale"])
        self.assertFalse(market["strategyEligible"])

    def test_collector_unhealthy_row_is_stale_even_before_expires_at(self):
        now = time.time()
        levels = [[0.49 - i * 0.01, 10 - i] for i in range(5)]
        asks = [[0.51 + i * 0.01, 11 + i] for i in range(5)]
        snapshot = {"marketId": "0xunhealthy", "roundId": "1800000000", "sequence": 10,
                    "sourceAt": now, "expiresAt": now + 30,
                    "YES": {"assetId": "yes-token", "bid": .49, "ask": .51,
                            "bids": levels, "asks": asks},
                    "NO": {"assetId": "no-token", "bid": .49, "ask": .51,
                           "bids": levels, "asks": asks}}
        raw = {"checked_at": datetime.fromtimestamp(now, timezone.utc).isoformat(),
               "collector_online": True, "collector_connected": True,
               "source": "polymarket-ws", "stale_after_ms": 2000,
               "current_markets": [{"snapshot": snapshot, "healthy": False,
                                     "quote_fresh": False, "collector_online": False}]}
        validated = server_module.validate_snapshot(raw, now=now)
        with patch.object(server_module, "_running_engine_market_status", return_value=None), \
                patch.object(server_module, "cached_live_status", return_value=validated):
            value = server_module._modern_markets()
        market = value["items"][0]
        self.assertTrue(market["stale"])
        self.assertFalse(market["strategyEligible"])
        self.assertEqual(market["expiresAt"], now + 30)
        self.assertEqual(market["error"], "market_snapshot_unhealthy")

    def test_market_pool_reads_saved_state_and_accepts_normalized_assets(self):
        path = self.root / "results" / "dashboard" / "market_pool.json"
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"desiredIds": ["btc"], "currentIds": ["btc"],
                                    "nextRoundIds": [], "effectiveRoundId": "1800000000",
                                    "updatedAt": 1234.5}), encoding="utf-8")
        code, value = self.request("/api/runtime/market-pool")
        self.assertEqual(code, 200)
        self.assertEqual(value["desiredIds"], ["btc"])
        self.assertEqual(value["asOf"], 1234.5)
        self.assertEqual(value["updatedAt"], 1234.5)
        with patch.object(server_module, "_control_request_error", return_value=None):
            code, saved_eth = self.request("/api/runtime/market-pool", {"desiredIds": [" ETH ", "btc", "eth"]}, method="PUT")
            self.assertEqual(code, 400)
            self.assertIn("只能选择一个", saved_eth["error"])
            code, saved_eth = self.request("/api/runtime/market-pool", {"desiredIds": [" ETH "]}, method="PUT")
            self.assertEqual(code, 200)
            self.assertEqual(saved_eth["desiredIds"], ["eth"])
            code, rejected_unknown = self.request("/api/runtime/market-pool", {"desiredIds": ["xrp"]}, method="PUT")
            self.assertEqual(code, 400)
            self.assertIn("不支持", rejected_unknown["error"])
            code, saved = self.request("/api/runtime/market-pool", {"desiredIds": ["btc"]}, method="PUT")
        self.assertEqual(code, 200)
        self.assertEqual(saved["desiredIds"], ["btc"])

    def test_bootstrap_does_not_fabricate_a_fresh_clock(self):
        with patch.object(server_module, "trading_status", return_value={
                "running": False, "exit_code": None, "stats": {}}):
            code, body = self.request("/api/bootstrap")
        self.assertEqual(code, 200)
        self.assertIsNone(body["asOf"])
        self.assertTrue(body["stale"])
        self.assertFalse(body["capabilityDetails"]["streams"])

    def test_read_failure_keeps_data_and_clock(self):
        good = {"items": [{"id": 1}], "source": "ledger", "asOf": 1234., "stale": False, "error": None}
        with patch.object(server_module, "_api_run_id", return_value="run"), \
                patch.object(server_module, "_modern_events", side_effect=[good, sqlite3.OperationalError("busy")]):
            _, first = self.request("/api/events")
            code, failed = self.request("/api/events")
        self.assertEqual(code, 503)
        self.assertEqual(failed["items"], first["items"])
        self.assertEqual(failed["asOf"], 1234.)
        self.assertTrue(failed["stale"])
        self.assert_metadata(failed)

    def test_ledger_metadata_uses_source_clock_not_projection_clock(self):
        with patch.object(server_module, "_projection_snapshot", return_value={
                "run_id": "run", "state": "ready", "stale": False, "as_of": time.time() + 1000}), \
                patch.object(server_module, "_api_ledger") as ledger:
            ledger.return_value.metadata.return_value = {
                "source": "ledger", "asOf": 1234.0, "stale": False, "error": None}
            value = server_module._ledger_metadata("run")
        self.assertEqual(value["asOf"], 1234.0)
        self.assertFalse(value["stale"])

    def test_event_mapping_and_query_errors(self):
        mapped = server_module._event_dto({"id": 2, "event": "fill", "market": "btc-updown-5m-1",
                                           "market_id": "0xcondition", "round_id": "1800000000", "time": 12.})
        self.assertTrue({"id", "time", "kind", "marketId", "roundId", "severity", "message"} <= set(mapped))
        self.assertEqual(mapped["marketId"], "0xcondition")
        self.assertEqual(mapped["roundId"], "1800000000")
        with patch.object(server_module, "_api_run_id", return_value="run"):
            code, error = self.request("/api/events?cursor=invalid")
        self.assertEqual(code, 400)
        self.assert_metadata(error)

    def test_unavailable_modern_reads_have_no_source_clock(self):
        for path in ("/api/events", "/api/settlements", "/api/rounds/unknown/orders", "/api/rounds/unknown/position"):
            code, body = self.request(path)
            self.assertIn(code, (200, 404))
            self.assertIsNone(body["asOf"])
            self.assertTrue(body["stale"])

    def test_settlements_are_latest_per_round_and_canonical(self):
        ledger = Mock()
        ledger.settlements_page.return_value = {"settlements": [{
            "id": 4, "event": "settlement", "market": "btc-updown-5m-1",
            "market_id": "0xcondition", "round_id": "1800000000", "time": 12., "state": "confirmed",
            "payout_verified": True, "pnl": 1.5, "accounting_state": "confirmed",
            "pnl_error": None}], "next_before_id": None}
        with patch.object(server_module, "_api_run_id", return_value="run"), \
                patch.object(server_module, "_api_ledger", return_value=ledger), \
                patch.object(server_module, "_ledger_metadata", return_value={"source": "ledger", "asOf": 12., "stale": False, "error": None}):
            code, body = self.request("/api/settlements")
        self.assertEqual(code, 200)
        self.assertEqual(body["items"][0]["marketId"], "0xcondition")
        self.assertEqual(body["items"][0]["roundId"], "1800000000")
        self.assertEqual(body["items"][0]["pnl"], 1.5)
        self.assertEqual(body["items"][0]["accountingState"], "confirmed")

    def test_diagnostics_requires_projection_and_runtime(self):
        status = {"running": True, "run_id": "run", "stats": {"projection": {"state": "waiting", "stale": True}}}
        with patch.object(server_module, "trading_status", return_value=status), \
                patch.object(server_module, "_modern_markets", return_value={"stale": False, "collector_online": True}), \
                patch.object(server_module, "system_metrics", return_value=Mock(snapshot=lambda: {"asOf": time.time()})):
            _, body = self.request("/api/diagnostics/health")
        self.assertEqual(body["status"], "degraded")
        self.assertIn("ledger_projection_unavailable", body["error"])

    def test_runtime_without_source_snapshot_has_null_clock(self):
        with patch.object(server_module, "trading_status", return_value={"running": True, "run_id": "run", "stats": {}}):
            code, body = self.request("/api/runtime/status")
        self.assertEqual(code, 200)
        self.assertIsNone(body["asOf"])
        self.assertTrue(body["stale"])

    def test_read_endpoints_do_not_probe_or_ingest(self):
        with patch.object(server_module, "_api_run_id", return_value="run"), \
                patch.object(server_module, "_api_ledger") as ledger, \
                patch.object(server_module, "_ledger_metadata", return_value={"source": "ledger", "asOf": 10., "stale": False, "error": None}), \
                patch.object(server_module, "live_status", side_effect=AssertionError("collector probe")), \
                patch.object(server_module, "_activate_projection", side_effect=AssertionError("ingestion")):
            ledger.return_value.summary.return_value = {"settled_pnl": 1., "completeness": "caught_up"}
            code, body = self.request("/api/metrics/summary?range=today")
            self.assertEqual(code, 200)
            self.assertEqual(body["pnl"], 1.)
            ledger.return_value.summary.assert_called_once_with("run", range="today")

    def test_legacy_summary_keeps_shape(self):
        with patch.object(server_module, "Ledger") as ledger:
            ledger.return_value.summary.return_value = {"settled_pnl": 2.}
            code, body = self.request("/api/v1/summary?run_id=run")
        self.assertEqual(code, 200)
        self.assertEqual(body["summary"]["settled_pnl"], 2.)

    def test_settlement_credentials_are_displayed_as_runtime_tristate(self):
        wallet = "0x" + "a" * 40
        values = {"POLYMARKET_WALLET_ADDRESS": wallet,
                  "POLYMARKET_OWNER_PRIVATE_KEY": "0x" + "b" * 64}
        base_report = {"wallet": wallet, "account_ready": True, "signer_matches": True,
                       "approvals_ready": True, "compromised": False,
                       "checked_at": time.time(), "checks": [],
                       "wallet_kind": "eoa", "signature_type": "eoa"}
        with patch.object(server_module, "_account_values", return_value=values), \
                patch.object(server_module, "_account_check_error", None):
            for supplied, expected in ((True, True), (False, False), ("unknown", None), (None, None)):
                report = {**base_report}
                if supplied is not None:
                    report["settlement_credentials_ready"] = supplied
                with patch.object(server_module, "_account_report", report):
                    status = server_module.account_config_status()
                self.assertIs(status["settlement_credentials_ready"], expected)
                self.assertIs(status["settlementCredentialsReady"], expected)
                self.assertEqual(status["live_start_ready"], expected is True)
                self.assertEqual(status["liveStartReady"], expected is True)
                self.assertNotIn("POLY_BUILDER_SECRET", status)
                self.assertNotIn("POLY_BUILDER_PASSPHRASE", status)

    def test_account_without_check_is_not_live_ready(self):
        values = {"POLYMARKET_WALLET_ADDRESS": "0x" + "a" * 40,
                  "POLYMARKET_OWNER_PRIVATE_KEY": "0x" + "b" * 64}
        with patch.object(server_module, "_account_values", return_value=values), \
                patch.object(server_module, "_account_report", None), \
                patch.object(server_module, "_account_check_error", None):
            status = server_module.account_config_status()
        self.assertFalse(status["live_start_ready"])
        self.assertFalse(status["liveStartReady"])


class SnapshotTests(unittest.TestCase):
    def test_engine_frame_is_rechecked_at_read_time(self):
        now = time.time()
        books = [{"tokenId": token, "bid": .4, "ask": .5, "receivedAt": now - 3,
                  "received_age_ms": 0} for token in ("yes", "no")]
        market = {"id": "0xcondition", "name": "btc-updown-5m-1", "roundId": "1800000000", "startsAt": now - 5, "endsAt": now + 295,
                  "instruments": [{"outcome": "UP", "tokenId": "yes"}, {"outcome": "DOWN", "tokenId": "no"}]}
        status = {"running": True, "stats": {"runtime": {"engine": "platform", "status": "running",
                  "stale": False, "markets": [market], "books": books}}}
        self.assertIsNone(server_module._running_engine_market_status(status))
        for book in books:
            book["receivedAt"] = time.time()
        self.assertIsNone(server_module._running_engine_market_status(status),
                          "legacy token books must not be rebuilt into modern market snapshots")

    def test_incomplete_projection_never_fresh(self):
        with tempfile.TemporaryDirectory() as directory:
            reader = ReadModel(Path(directory))
            reader._process = Mock(poll=lambda: None)
            atomic_json(Path(directory) / "snapshot.json", {"run_id": "run", "as_of": time.time(),
                        "ingestion": {"pending": True}, "stats": {"pnl": 3.}})
            view = reader.snapshot("run")
            self.assertTrue(view["stale"])
            self.assertEqual(view["stats"]["pnl"], 3.)

    def test_account_failure_marks_cached_values_stale(self):
        reader = AccountData(Path("unused"), lambda: {})
        reader._account()
        reader._cache = {"available": True, "collateral": {"items": [12.]}, "error_code": "account_data_fetch_failed"}
        reader._checked = time.monotonic()
        value = reader.snapshot()
        self.assertTrue(value["stale"])
        self.assertEqual(value["collateral"]["items"], [12.])


if __name__ == "__main__":
    unittest.main()

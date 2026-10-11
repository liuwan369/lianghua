"""One-sided book near the close (2026-10-10): the collector now publishes the
venue's top while one side is empty as `one_sided`. The market API passes it on
as `oneSided` for display, and the row stays stale and not strategy-eligible.

Run:  python scripts/regress/one-sided-display.py
"""
import importlib.util
import sys
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def collector_row(now, one_sided):
    paired_at = now - 3
    side = lambda asset, bid, ask: {"assetId": asset, "bid": bid, "ask": ask, "sourceAt": paired_at, "expiresAt": paired_at + 2}
    start = int(now // 300 * 300)
    return {"assetId": "sol", "marketId": "0xm", "roundId": str(start), "slug": f"sol-updown-5m-{start}",
            "start": start, "end": start + 300, "healthy": False, "quote_fresh": False, "source": "polymarket-ws",
            "stale_after_ms": 2000, "one_sided": one_sided,
            "snapshot": {"marketId": "0xm", "roundId": str(start), "sequence": 7, "sourceAt": paired_at,
                         "expiresAt": paired_at + 2, "YES": side("up", 0.97, 0.99), "NO": side("dn", 0.01, 0.03)}}


class OneSided(unittest.TestCase):
    def test_one_sided_top_is_shown_but_not_tradable(self):
        now = time.time()
        row = collector_row(now, {"at": now - 0.5, "up_bid": 0.98, "up_ask": None, "down_bid": None, "down_ask": 0.02})
        item = server._modern_market(row, now=now)
        self.assertEqual(item["oneSided"], {"at": now - 0.5, "yesBid": 0.98, "yesAsk": None, "noBid": None, "noAsk": 0.02})
        self.assertTrue(item["stale"], "the paired quote stays stale")
        self.assertFalse(item["strategyEligible"])
        self.assertEqual(item["yesAsk"], 0.99, "the paired prices are untouched")

    def test_old_or_superseded_top_is_dropped(self):
        now = time.time()
        old = collector_row(now, {"at": now - 30, "up_bid": 0.98, "up_ask": None, "down_bid": None, "down_ask": 0.02})
        self.assertIsNone(server._modern_market(old, now=now)["oneSided"], "a top older than 15 s is not shown")
        before = collector_row(now, {"at": now - 5, "up_bid": 0.98, "up_ask": None, "down_bid": None, "down_ask": 0.02})
        self.assertIsNone(server._modern_market(before, now=now)["oneSided"], "a top older than the paired quote is not shown")

    def test_retained_pair_keeps_the_newer_one_sided_top(self):
        now = time.time()
        fresh = server._modern_market(collector_row(now, None) | {"healthy": True, "quote_fresh": True,
            "snapshot": collector_row(now, None)["snapshot"] | {"sourceAt": now, "expiresAt": now + 2,
                "YES": {"assetId": "up", "bid": 0.97, "ask": 0.99, "sourceAt": now, "expiresAt": now + 2},
                "NO": {"assetId": "dn", "bid": 0.01, "ask": 0.03, "sourceAt": now, "expiresAt": now + 2}}}, now=now)
        self.assertFalse(fresh["stale"], "control: a fresh pair is cached")
        later = now + 3
        stale = collector_row(later, {"at": later - 0.2, "up_bid": 0.98, "up_ask": None, "down_bid": None, "down_ask": 0.02})
        saved = (server._running_engine_market_status, server.cached_live_status, server.market_pool, server.time.time)
        server._running_engine_market_status = lambda: None
        server.cached_live_status = lambda: {"current_markets": [stale], "source": "polymarket-ws", "stale_after_ms": 2000}
        server.market_pool = lambda: {"desiredIds": ["sol"]}
        server._modern_market_cache = {(fresh["assetId"], fresh["marketId"], fresh["roundId"]): fresh}
        server.time.time = lambda: later
        try:
            out = server._modern_markets({"assetId": ["sol"]})
        finally:
            (server._running_engine_market_status, server.cached_live_status, server.market_pool, server.time.time) = saved
            server._modern_market_cache = {}
        item = out["items"][0]
        self.assertTrue(item["stale"])
        self.assertFalse(item["strategyEligible"])
        self.assertEqual(item["oneSided"]["yesAsk"], None)
        self.assertEqual(item["oneSided"]["noAsk"], 0.02)


class QuietBook(unittest.TestCase):
    """2026-10-11: a quiet two-sided book (nobody changed a price) went stale
    after 2 s. The collector confirms it against the venue's REST book; the API
    passes the time on as quietConfirmedAt for display, still stale."""

    def test_confirmed_quiet_book_is_shown_but_not_tradable(self):
        now = time.time()
        item = server._modern_market({**collector_row(now, None), "quiet_confirmed_at": now - 0.4}, now=now)
        self.assertAlmostEqual(item["quietConfirmedAt"], now - 0.4)
        self.assertTrue(item["stale"], "the quote is still stale for trading")
        self.assertFalse(item["strategyEligible"])

    def test_old_confirmation_is_dropped(self):
        now = time.time()
        item = server._modern_market({**collector_row(now, None), "quiet_confirmed_at": now - 10}, now=now)
        self.assertIsNone(item["quietConfirmedAt"], "a check older than 3 s says nothing about now")


if __name__ == "__main__":
    unittest.main()

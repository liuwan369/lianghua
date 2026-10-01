"""BUGS.md P3-10: after a round change, /api/markets could return the round
that just ended as current.

_modern_markets keeps a cached row when the fresh one is stale (failed()),
but kept its old `current`/`nextRound` flags, and the selector prefers
current=True. Five seconds past the boundary with both rounds stale it
returned the ended round (endAt - now = -5 s) as the live one.

Run:  python scripts/regress/P3-10.py
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


class P3_10(unittest.TestCase):
    def test_ended_cached_round_is_not_current(self):
        now = time.time()
        boundary = now - 5
        old = {"assetId": "btc", "marketId": "0xold", "roundId": str(int(boundary - 300)), "startAt": boundary - 300,
               "endAt": boundary, "current": True, "nextRound": False, "stale": False, "sourceAt": boundary - 10,
               "sequence": 9, "source": "polymarket-ws", "orderBook": {}, "error": None}
        fresh = {**old, "marketId": "0xnew", "roundId": str(int(boundary)), "startAt": boundary, "endAt": boundary + 300,
                 "current": True, "stale": True, "sourceAt": None, "sequence": None, "error": "stale"}
        saved = (server._running_engine_market_status, server.cached_live_status, server._modern_market, server.market_pool)
        server._running_engine_market_status = lambda: None
        server.cached_live_status = lambda: {"current_markets": [{"x": "new"}], "source": "polymarket-ws"}
        server._modern_market = lambda row, pool_desired=None: dict(fresh)
        server.market_pool = lambda: {"desiredIds": ["btc"]}
        server._modern_market_cache = {(old["assetId"], old["marketId"], old["roundId"]): old}
        try:
            out = server._modern_markets({"assetId": ["btc"]})
        finally:
            (server._running_engine_market_status, server.cached_live_status, server._modern_market, server.market_pool) = saved
            server._modern_market_cache = {}
        chosen = out["items"][0]
        self.assertNotEqual(chosen["marketId"], "0xold", "a round that ended 5 s ago is not served as the live one")


if __name__ == "__main__":
    unittest.main()

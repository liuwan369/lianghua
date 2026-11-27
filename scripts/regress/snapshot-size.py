"""/api/account/snapshot grew with every losing round ever played (2026-11-27).

The venue keeps a settled losing round in the positions list forever, at $0
and "redeemable" for nothing. Account 1 had 830 of them: 636 KB of a 638 KB
body, pushed once a second to every open live page (8.9 MB a minute, 533 MB an
hour), until the console's 400 MB memory ceiling stalled it.

The page never lists those rows; settings.js only counts them. So the route
sends their count instead of the rows:
- positions.items keeps every position worth something (held, or a settled
  winner still to redeem) and drops only the $0 redeemable ones;
- positions.settled_lost is how many were dropped;
- the body no longer grows with the account's age;
- official PnL still reads the untrimmed snapshot (it needs every row).

Run:  python scripts/regress/snapshot-size.py
"""
import importlib.util
import json
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def position(title, value, redeemable, price):
    # A realistic row: the venue sends about 760 bytes per position.
    return {"title": title, "size": 10, "avgPrice": 0.4, "curPrice": price, "currentValue": value,
            "redeemable": redeemable, "asset": "1" * 77, "conditionId": "0x" + "c" * 64,
            "oppositeAsset": "2" * 77, "eventSlug": "btc-updown-5m-1795000000", "endDate": "2026-11-16",
            "cashPnl": -4.0, "initialValue": 4.0, "mergeable": False, "negativeRisk": False, "outcome": "Up",
            "icon": "https://polymarket-upload.s3.us-east-2.amazonaws.com/" + "x" * 80}


def snapshot(losers):
    return {"checked_at": 1795740000, "stale": False, "collateral": {"available": True, "value": 171.6},
            "open_orders": {"available": True, "items": []},
            "closed_positions": {"available": True, "items": [{"x": 1}] * 50},
            "trades": {"available": True, "items": [{"x": 1}] * 50},
            "positions": {"available": True, "complete": True, "items":
                          [position("held now", 3.2, False, 0.32), position("won, to redeem", 10.0, True, 1.0)]
                          + [position(f"lost {n}", 0, True, 0) for n in range(losers)]}}


class SnapshotSize(unittest.TestCase):
    def test_bug_losers_are_counted_not_sent(self):
        body = server.account_snapshot_view(snapshot(830))
        items = body["positions"]["items"]
        self.assertEqual([p["title"] for p in items], ["held now", "won, to redeem"],
                         "every position worth something stays, nothing else")
        self.assertEqual(body["positions"]["settled_lost"], 830)
        size = len(json.dumps(body, ensure_ascii=False))
        self.assertLess(size, 8000, f"{size} bytes: the body must not carry the $0 rows")

    def test_body_does_not_grow_with_age(self):
        small = len(json.dumps(server.account_snapshot_view(snapshot(10))))
        large = len(json.dumps(server.account_snapshot_view(snapshot(5000))))
        self.assertLess(large - small, 16, "5000 more losing rounds add only digits to a count")

    def test_history_sections_still_dropped(self):
        body = server.account_snapshot_view(snapshot(3))
        for section in ("closed_positions", "trades"):
            self.assertNotIn(section, body)
        self.assertEqual(body["collateral"]["value"], 171.6)

    def test_source_snapshot_untouched(self):
        """official_pnl reads the same snapshot object: the view must copy."""
        raw = snapshot(5)
        server.account_snapshot_view(raw)
        self.assertEqual(len(raw["positions"]["items"]), 7)
        self.assertIn("closed_positions", raw)

    def test_unavailable_positions_pass_through(self):
        raw = snapshot(0)
        raw["positions"] = {"available": False, "error": "timeout"}
        self.assertEqual(server.account_snapshot_view(raw)["positions"], {"available": False, "error": "timeout"})


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    print("snapshot-size OK" if result.wasSuccessful() else "snapshot-size FAILED")
    sys.exit(0 if result.wasSuccessful() else 1)

"""/api/sim summary and distribution (模拟交易).

The paper simulator writes per-round firing counts to data/sim/<asset>.jsonl.
The control plane's _api_sim reads them and must report, uncapped:
- the max firings in any round and which round it was;
- a distribution with a bucket for every value 0..max (no gaps, no capping);
- rounds latest-first, and the count of rounds with >= 1 firing.

Run:  PYTHONIOENCODING=utf-8 python scripts/regress/sim-api.py
"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def write_rounds(sim_dir: Path, asset: str, rounds: list[dict]) -> None:
    sim_dir.mkdir(parents=True, exist_ok=True)
    with (sim_dir / f"{asset}.jsonl").open("w", encoding="utf-8") as handle:
        for row in rounds:
            handle.write(json.dumps({"schemaVersion": 2, **row}) + "\n")


class SimApi(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sim_dir = Path(self.tmp.name) / "sim"
        self._saved = server.SIM_DIR
        server.SIM_DIR = self.sim_dir

    def tearDown(self):
        server.SIM_DIR = self._saved
        self.tmp.cleanup()

    def test_distribution_and_max_uncapped(self):
        base = 1_799_900_100  # recent, within the day window
        rounds = [
            {"asset": "btc", "roundId": str(base), "startsAt": base, "firings": 67, "reversals": 66,
             "winner": "UP", "simPnl4": 1.5, "events": [{"i": 1, "t": 10, "dir": "UP", "ask": 0.68, "shares": 5}]},
            {"asset": "btc", "roundId": str(base + 300), "startsAt": base + 300, "firings": 0, "reversals": 0,
             "winner": "DOWN", "simPnl4": 0, "events": []},
            {"asset": "btc", "roundId": str(base + 600), "startsAt": base + 600, "firings": 2, "reversals": 1,
             "winner": None, "simPnl4": -0.3, "events": []},
        ]
        write_rounds(self.sim_dir, "btc", rounds)
        out = server._api_sim("btc", 3650)
        summary = out["summary"]
        self.assertEqual(summary["rounds"], 3)
        self.assertEqual(summary["withFiring"], 2)
        self.assertEqual(summary["maxFirings"], 67, "max firings is uncapped")
        self.assertEqual(summary["maxRound"]["roundId"], str(base))
        # Every value 0..67 has a bucket, even the empty ones (no gaps).
        self.assertEqual(len(summary["distribution"]), 68)
        self.assertEqual(summary["distribution"]["67"], 1)
        self.assertEqual(summary["distribution"]["0"], 1)
        self.assertEqual(summary["distribution"]["2"], 1)
        self.assertEqual(summary["distribution"]["5"], 0, "an unseen value is present and zero")
        # Latest-first.
        self.assertEqual(out["rounds"][0]["roundId"], str(base + 600))
        self.assertAlmostEqual(summary["simPnl4Total"], 1.2, places=3)

    def test_missing_file_is_empty_not_error(self):
        out = server._api_sim("eth", 10)
        self.assertEqual(out["summary"]["rounds"], 0)
        self.assertEqual(out["summary"]["maxFirings"], 0)
        self.assertEqual(out["rounds"], [])

    def test_day_window_filters_old_rounds(self):
        rounds = [
            {"asset": "btc", "roundId": "1799900100", "startsAt": 1799900100, "firings": 3, "events": []},
            {"asset": "btc", "roundId": "100", "startsAt": 100, "firings": 9, "events": []},  # ancient
        ]
        write_rounds(self.sim_dir, "btc", rounds)
        out = server._api_sim("btc", 10)
        self.assertEqual(out["summary"]["rounds"], 1, "the ancient round is outside the day window")
        self.assertEqual(out["summary"]["maxFirings"], 3)

    def test_median_in_summary(self):
        base = 1_799_900_100
        write_rounds(self.sim_dir, "btc", [
            {"asset": "btc", "roundId": str(base + i), "startsAt": base + i, "firings": f, "events": []}
            for i, f in enumerate([1, 1, 2, 5, 67])])
        self.assertEqual(server._api_sim("btc", 3650)["summary"]["medianFirings"], 2)

    def test_overview_lists_seven_coins(self):
        base = 1_799_900_100
        write_rounds(self.sim_dir, "btc", [
            {"asset": "btc", "roundId": str(base + i), "startsAt": base + i, "firings": f,
             "simPnl4": 0.5, "events": []}
            for i, f in enumerate([0, 1, 2, 4, 5, 67])])
        coins = server._api_sim_overview(3650)["coins"]
        self.assertEqual([c["assetId"] for c in coins], ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"])
        btc = coins[0]
        self.assertEqual(btc["rounds"], 6)
        self.assertEqual(btc["maxFirings"], 67)
        self.assertEqual(btc["medianFirings"], 3)
        self.assertEqual(btc["over4"], 2)
        self.assertAlmostEqual(btc["over4Pct"], 33.3, places=1)
        self.assertAlmostEqual(btc["simPnl4Total"], 3.0, places=3)
        self.assertEqual(coins[1]["rounds"], 0)
        self.assertEqual(coins[1]["over4Pct"], 0)
        self.assertEqual(coins[1]["medianFirings"], 0)

    def test_v1_lines_ignored_and_last_line_per_round_wins(self):
        base = 1_799_900_100
        write_rounds(self.sim_dir, "btc", [
            {"schemaVersion": 1, "roundId": str(base - 300), "startsAt": base - 300, "firings": 58, "events": []},
            {"roundId": str(base), "startsAt": base, "firings": 9, "firingsRaw": 9, "events": []},
            {"roundId": str(base), "startsAt": base, "firings": 2, "firingsRaw": 13, "events": []}])
        out = server._api_sim("btc", 3650)
        self.assertEqual(out["summary"]["rounds"], 1, "v1 line ignored, duplicate round deduped")
        self.assertEqual(out["rounds"][0]["firings"], 2, "the last line for a round wins")
        self.assertEqual(out["summary"]["maxFirings"], 2)

    def test_raw_comparison_and_rung_fill(self):
        base = 1_799_900_100
        ev = lambda i, status, filled, avail: {"i": i, "t": 10 + i, "dir": "UP", "ask": 0.68, "shares": 20,
                                               "avail": avail, "filled": filled, "cost": 0, "status": status}
        write_rounds(self.sim_dir, "btc", [
            {"roundId": str(base), "startsAt": base, "firings": 5, "firingsRaw": 13, "depthOk": True, "events": [
                ev(1, "full", 20, 100), ev(2, "partial", 5, 5), ev(3, "none", 0, 0), ev(4, "too_late", 0, None),
                ev(5, "full", 20, 40)]},
            {"roundId": str(base + 300), "startsAt": base + 300, "firings": 1, "firingsRaw": 3, "depthOk": True,
             "events": [ev(1, "partial", 10, 10)]},
            {"roundId": str(base + 600), "startsAt": base + 600, "firings": 1, "firingsRaw": 1, "depthOk": False,
             "events": [ev(1, "no_depth", None, None)]}])
        summary = server._api_sim("btc", 3650)["summary"]
        self.assertEqual(summary["rawMax"], 13)
        self.assertAlmostEqual(summary["rawAvg"], 5.67, places=2)
        self.assertEqual(summary["rawOver4"], 1)
        self.assertEqual(summary["over4"], 1)
        fill = summary["rungFill"]
        self.assertEqual(list(fill), ["1", "2", "3", "4", "5+"])
        self.assertEqual(fill["1"]["count"], 2, "no_depth events are left out")
        self.assertEqual((fill["1"]["full"], fill["1"]["partial"]), (1, 1))
        self.assertEqual(fill["1"]["fullPct"], 50.0)
        self.assertEqual(fill["1"]["avgFilledPct"], 75.0)
        self.assertEqual(fill["1"]["avgAvail"], 55.0)
        self.assertEqual(fill["3"]["none"], 1)
        self.assertEqual(fill["4"]["tooLate"], 1)
        self.assertEqual(fill["5+"]["full"], 1)
        coin = server._api_sim_overview(3650)["coins"][0]
        self.assertEqual(coin["rawMax"], 13)
        self.assertEqual(coin["rungFullPct"], {"1": 50.0, "2": 0.0, "3": 0.0, "4": 0.0})

    def test_bad_asset_rejected(self):
        with self.assertRaises(ValueError):
            server._api_sim("../etc", 10)


if __name__ == "__main__":
    unittest.main()

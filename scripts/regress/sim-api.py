"""/api/sim summary per variant and the three-variant compare block (模拟交易).

The paper simulator writes one schemaVersion 3 line per round to
data/sim/<asset>.jsonl with variants A (实盘现状), B1 (建议·立即), B2 (建议·停1秒).
_api_sim(asset, days, variant) must report, uncapped, for the chosen variant:
max firings and which round, a distribution bucket for every value 0..max,
per-rung fill rates and PnL; plus `compare` for all three. Older lines are ignored.

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

BASE = 1_799_900_100


def ev(rung, status, filled, want=20, avail=None):
    return {"rung": rung, "t": 10 + rung, "dir": "UP", "ask": 0.68, "want": want, "cap": 0.7, "avail": avail,
            "filled": filled, "avgPrice": 0.68 if filled else None, "cost": 0, "fee": 0, "status": status}


def variant(firings, events=(), pnl=None):
    return {"firings": firings, "rawSeconds": [], "events": list(events), "held": {"UP": 0, "DOWN": 0},
            "cost": 0, "pnl": pnl}


def row(i, a, b1, b2=None):
    return {"schemaVersion": 3, "asset": "btc", "roundId": str(BASE + i * 300), "marketId": f"0x{i}",
            "startsAt": BASE + i * 300, "depthOk": True, "winner": "UP",
            "variants": {"A": a, "B1": b1, "B2": b2 or variant(0)}}


def write_rows(sim_dir: Path, asset: str, rows: list[dict]) -> None:
    sim_dir.mkdir(parents=True, exist_ok=True)
    with (sim_dir / f"{asset}.jsonl").open("w", encoding="utf-8") as handle:
        for item in rows:
            handle.write(json.dumps(item) + "\n")


class SimApi(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sim_dir = Path(self.tmp.name) / "sim"
        self._saved = server.SIM_DIR
        server.SIM_DIR = self.sim_dir

    def tearDown(self):
        server.SIM_DIR = self._saved
        self.tmp.cleanup()

    def test_variant_param_distribution_uncapped(self):
        write_rows(self.sim_dir, "btc", [
            row(0, variant(67, pnl=-30.0), variant(4, pnl=1.5)),
            row(1, variant(0, pnl=0.0), variant(0, pnl=0.0)),
            row(2, variant(2, pnl=None), variant(1, pnl=-0.5))])
        a = server._api_sim("btc", 3650, "A")
        self.assertEqual(a["variant"], "A")
        self.assertEqual(a["summary"]["maxFirings"], 67, "max firings is uncapped")
        self.assertEqual(a["summary"]["maxRound"]["roundId"], str(BASE))
        self.assertEqual(len(a["summary"]["distribution"]), 68)
        self.assertEqual(a["summary"]["distribution"]["5"], 0, "an unseen value is present and zero")
        self.assertEqual(a["summary"]["over4"], 1)
        self.assertEqual(a["rounds"][0]["roundId"], str(BASE + 600), "latest first")
        self.assertEqual(a["rounds"][0]["firings"], 2, "rounds carry the chosen variant")
        b1 = server._api_sim("btc", 3650)
        self.assertEqual(b1["variant"], "B1", "B1 is the default")
        self.assertEqual(b1["summary"]["maxFirings"], 4)
        self.assertEqual(b1["summary"]["medianFirings"], 1)
        self.assertAlmostEqual(b1["summary"]["pnlTotal"], 1.0, places=3)
        self.assertAlmostEqual(b1["summary"]["pnlPerRound"], 0.333, places=3)
        self.assertEqual(b1["summary"]["worstRound"]["pnl"], -0.5)
        with self.assertRaises(ValueError):
            server._api_sim("btc", 10, "C")
    def test_compare_block(self):
        write_rows(self.sim_dir, "btc", [
            row(0, variant(6, [ev(1, "full", 5, 5)], pnl=-8.6),
                variant(2, [ev(1, "full", 5, 5), ev(2, "partial", 3)], pnl=2.0),
                variant(1, [ev(1, "none", 0, 5), ev(1, "full", 5, 5)], pnl=1.0)),
            row(1, variant(1, [ev(1, "none", 0, 5)], pnl=-3.5), variant(0, [ev(1, "none", 0, 5)], pnl=0.0))])
        compare = server._api_sim("btc", 3650, "B2")["compare"]
        self.assertEqual(list(compare), ["A", "B1", "B2"])
        self.assertEqual(compare["A"]["maxFirings"], 6)
        self.assertEqual(compare["A"]["over4"], 1)
        self.assertEqual(compare["A"]["avgFirings"], 3.5)
        self.assertAlmostEqual(compare["A"]["pnlTotal"], -12.1, places=3)
        self.assertAlmostEqual(compare["A"]["pnlPerRound"], -6.05, places=3)
        self.assertEqual(compare["A"]["worstPnl"], -8.6)
        self.assertEqual(compare["A"]["rungFullPct"]["1"], 50.0)
        self.assertEqual(compare["B1"]["rungFullPct"], {"1": 50.0, "2": 0.0, "3": 0, "4": 0})
        self.assertEqual(compare["B2"]["rungFullPct"]["1"], 50.0)
        self.assertEqual(compare["B2"]["roundsWithPnl"], 1)

    def test_rung_fill_statuses(self):
        write_rows(self.sim_dir, "btc", [row(0, variant(0), variant(3, [
            ev(1, "full", 5, 5, avail=100), ev(2, "over_cap", 0, avail=0), ev(2, "partial", 5, avail=5),
            ev(2, "topup", 15), ev(3, "gap", 0), ev(3, "too_late", 0), ev(4, "no_depth", None),
            ev(5, "none", 0, 140, avail=0)]))])
        fill = server._api_sim("btc", 3650)["summary"]["rungFill"]
        self.assertEqual(list(fill), ["1", "2", "3", "4", "5+"])
        self.assertEqual(fill["1"]["fullPct"], 100.0)
        self.assertEqual(fill["2"]["count"], 2, "top-ups are not new attempts")
        self.assertEqual((fill["2"]["overCap"], fill["2"]["partial"]), (1, 1))
        self.assertEqual(fill["2"]["avgFilledPct"], 12.5)
        self.assertEqual(fill["2"]["avgAvail"], 2.5)
        self.assertEqual(fill["3"]["gap"], 1)
        self.assertEqual(fill["3"]["count"], 1, "too_late is left out")
        self.assertEqual(fill["4"]["count"], 0, "no_depth is left out")
        self.assertEqual(fill["5+"]["none"], 1)

    def test_old_lines_ignored_last_line_wins_and_day_window(self):
        ancient = row(1, variant(7), variant(7))
        ancient["startsAt"] = 100
        write_rows(self.sim_dir, "btc", [
            {"schemaVersion": 2, "roundId": str(BASE - 300), "startsAt": BASE - 300, "firings": 58, "events": []},
            row(0, variant(9), variant(9)), row(0, variant(2), variant(2)), ancient])
        out = server._api_sim("btc", 10, "A")
        self.assertEqual(out["summary"]["rounds"], 1, "v2 ignored, duplicate deduped, ancient outside the window")
        self.assertEqual(out["rounds"][0]["firings"], 2, "the last line for a round wins")

    def test_missing_file_is_empty_not_error(self):
        out = server._api_sim("eth", 10)
        self.assertEqual(out["summary"]["rounds"], 0)
        self.assertEqual(out["summary"]["maxFirings"], 0)
        self.assertEqual(out["summary"]["pnlPerRound"], 0)
        self.assertEqual(out["rounds"], [])
        self.assertEqual(out["compare"]["A"]["avgFirings"], 0)

    def test_overview_per_coin_per_variant(self):
        write_rows(self.sim_dir, "btc", [row(i, variant(f, pnl=-1.0), variant(1, pnl=0.5))
                                         for i, f in enumerate([0, 1, 5, 67])])
        coins = server._api_sim_overview(3650)["coins"]
        self.assertEqual([c["assetId"] for c in coins], ["btc", "eth", "sol", "xrp", "doge", "hype", "bnb"])
        btc = coins[0]
        self.assertEqual(btc["rounds"], 4)
        self.assertEqual(btc["variants"]["A"], {"maxFirings": 67, "avgFirings": 18.25, "over4": 2,
                                                "pnlTotal": -4.0, "pnlPerRound": -1.0})
        self.assertEqual(btc["variants"]["B1"]["pnlTotal"], 2.0)
        self.assertEqual(coins[1]["variants"]["B2"]["pnlPerRound"], 0)

    def test_bad_asset_rejected(self):
        with self.assertRaises(ValueError):
            server._api_sim("../etc", 10)


if __name__ == "__main__":
    unittest.main()

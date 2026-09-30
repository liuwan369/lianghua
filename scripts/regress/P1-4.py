"""BUGS.md P1-4, ledger half: winning rounds got no PnL; win rate was fiction.

Replays batch 2's two real live runs (fixtures/: trimmed journals of runs
20260930-162501 and 20260930-170531; settlement events carry the fields the
fixed engine now writes: the venue's payout tx for auto-redeemed winners and
payout_proof=zero_payout for the loss). Three ledger bugs hid the results:

- coverage required held == bought, but a redeemed winner holds 0;
- a payout proven 0 (no transaction) was never verified;
- the venue settles after the trading run stops, so the confirmation lands in
  the next run, which has no fills, and was booked there as no-trade.

Truth: the wallet went 211.116499 -> 213.638439 over these two runs, +2.52194.

Run:  python scripts/regress/P1-4.py
"""
import gzip
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.ledger import Ledger  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ACCOUNT = "0xa693a0e0e40bdec3d9d4a40bd4d087a5cecfd7cd"
RUN1, RUN2 = "20260930-162501-1fb3a0266703", "20260930-170531-cb02c3f1c1d8"


class P1_4(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.ledger = Ledger(root / "ledger.sqlite3")
        for run_id in (RUN1, RUN2):
            journal = root / f"{run_id}.jsonl"
            journal.write_bytes(gzip.decompress((FIXTURES / f"journal-{run_id}.jsonl.gz").read_bytes()))
            cls.ledger.register_run(run_id, "live", ACCOUNT, str(journal))
            for _ in range(100):
                if not cls.ledger.ingest(run_id, max_bytes=8 << 20, max_records=20000).get("inserted"):
                    break
        db = sqlite3.connect(root / "ledger.sqlite3")
        cls.pnl = {(run, rnd): pnl for run, rnd, pnl in db.execute(
            "SELECT run_id, round_id, pnl FROM settlement_details")}
        db.close()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_auto_redeemed_winners_have_pnl(self):
        self.assertAlmostEqual(self.pnl[(RUN2, "1790788200")], 1.4265, places=4)
        self.assertAlmostEqual(self.pnl[(RUN2, "1790788500")], 1.52384, places=4)
        self.assertAlmostEqual(self.pnl[(RUN1, "1790786100")], 1.57261, places=4)

    def test_loss_settled_in_the_next_run_is_booked_where_it_traded(self):
        self.assertAlmostEqual(self.pnl[(RUN1, "1790785800")], -3.47616, places=4)
        self.assertIsNone(self.pnl[(RUN2, "1790785800")], "the settling run has no fills and books nothing")

    def test_control_own_redeem_unchanged(self):
        self.assertAlmostEqual(self.pnl[(RUN1, "1790786400")], 1.47513, places=4)

    def test_totals_match_the_wallet(self):
        one = self.ledger.metrics_summary(RUN1, range="run", asset_id="btc")
        two = self.ledger.metrics_summary(RUN2, range="run", asset_id="btc")
        self.assertEqual((one["settled_wins"], one["settled_losses"]), (2, 1))
        self.assertEqual((two["settled_wins"], two["settled_losses"]), (2, 0))
        self.assertEqual(one["settled_pnl_pending"] + two["settled_pnl_pending"], 0)
        self.assertAlmostEqual(one["settled_pnl"] + two["settled_pnl"], 213.638439 - 211.116499, places=4)


if __name__ == "__main__":
    unittest.main()

"""UI U5: the console's 历史订单 is "the last N rounds", not "this run's rounds".

/api/rounds read only the selected run, and one run trades two or three rounds,
so the table showed 2 rows. rounds_page now covers every live run of the
account, with each round's settled PnL from the run that traded it (P1-4).

Replays the two real batch-2 journals (fixtures/, same as P1-4.py).

Run:  python scripts/regress/U5-rounds.py
"""
import gzip
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.ledger import Ledger  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
ACCOUNT = "0xa693a0e0e40bdec3d9d4a40bd4d087a5cecfd7cd"
RUN1, RUN2 = "20260930-162501-1fb3a0266703", "20260930-170531-cb02c3f1c1d8"


class Rounds(unittest.TestCase):
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

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_latest_run_lists_rounds_of_earlier_runs(self):
        page = self.ledger.rounds_page(RUN2, limit=10)
        ids = [r["roundId"] for r in page["rounds"]]
        self.assertEqual(ids, sorted(ids, reverse=True), "newest first")
        self.assertEqual(set(ids), {"1790785800", "1790786100", "1790786400", "1790788200", "1790788500"})

    def test_each_round_carries_its_settled_pnl(self):
        pnl = {r["roundId"]: r["pnl"] for r in self.ledger.rounds_page(RUN2, limit=10)["rounds"]}
        self.assertAlmostEqual(pnl["1790785800"], -3.47616, places=4)   # booked in RUN1, settled in RUN2
        self.assertAlmostEqual(pnl["1790788500"], 1.52384, places=4)
        self.assertAlmostEqual(sum(pnl.values()), 2.52194, places=4)

    def test_limit_and_paging(self):
        first = self.ledger.rounds_page(RUN2, limit=2)
        self.assertEqual(len(first["rounds"]), 2)
        rest = self.ledger.rounds_page(RUN2, limit=10, before_round_id=first["next_before_round_id"])
        self.assertEqual(len(rest["rounds"]), 3)


if __name__ == "__main__":
    unittest.main()

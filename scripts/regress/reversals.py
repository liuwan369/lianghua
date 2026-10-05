"""反转统计 (REVERSAL.md): count firings per round from the market recordings.

Definition under test:
- price = each side's ask; only rows inside the round (R <= t < R+300);
- a clean frame has both asks and ask sum <= 1.05; only clean frames cross;
- the first clean frame is the baseline only;
- a side crosses when its previous clean ask < 0.67 and this one >= 0.67;
- firing 1 = first cross; afterwards only the side opposite the last firing counts;
- one-sided rows (k "o") never cross but set the winner; trade rows are ignored;
- a round needs a clean frame within 10 s of R and rows up to R+240.

Run:  python scripts/regress/reversals.py
"""
import gzip
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import dashboard.reversals as reversals  # noqa: E402

R = 1_800_000_000


def book(t, ua, da, ub=None, db=None, r=R):
    return {"t": r + t, "a": "btc", "m": "0xm", "r": str(r), "ua": ua, "da": da,
            "ub": ua - 0.01 if ub is None else ub, "db": da - 0.01 if db is None else db}


def full_round(rows, r=R):
    """Pad a round so it counts as complete: a frame at +250 s keeps the last asks."""
    last = [x for x in rows if "ua" in x and x.get("k") is None][-1]
    return rows + [book(250, last["ua"], last["da"], r=r)]


class Count(unittest.TestCase):
    def count(self, rows):
        return reversals.count_round([json.loads(json.dumps(x)) for x in rows], R)

    def test_baseline_only_first_frame(self):
        result = self.count(full_round([book(1, 0.70, 0.31), book(2, 0.71, 0.30)]))
        self.assertEqual(result["firings"], 0, "already above 0.67 at the first frame is not a cross")

    def test_cross_and_same_side_again(self):
        rows = [book(1, 0.50, 0.51), book(2, 0.68, 0.33), book(3, 0.60, 0.41), book(4, 0.69, 0.32)]
        result = self.count(full_round(rows))
        self.assertEqual((result["firings"], result["sides"]), (1, ["UP"]), "the same side again does not count")

    def test_alternating_nine(self):
        rows = [book(1, 0.50, 0.51)]
        up = True
        for i in range(9):
            rows.append(book(10 + i * 10, 0.68 if up else 0.33, 0.33 if up else 0.68))
            rows.append(book(15 + i * 10, 0.50, 0.51))
            up = not up
        result = self.count(full_round(rows))
        self.assertEqual((result["firings"], result["reversals"]), (9, 8))
        self.assertEqual(result["seconds"][:2], [10.0, 20.0])

    def test_wide_frame_ignored(self):
        # The only frame where UP is >= 0.67 has ask sum 1.30: no cross.
        rows = [book(1, 0.50, 0.51), book(2, 0.70, 0.60), book(3, 0.55, 0.46)]
        self.assertEqual(self.count(full_round(rows))["firings"], 0)

    def test_one_sided_rows(self):
        rows = full_round([book(1, 0.50, 0.51), book(2, 0.68, 0.33)])
        rows.append({"t": R + 290, "a": "btc", "m": "0xm", "r": str(R), "k": "o", "ub": 0.99, "da": 0.01})
        result = self.count(rows)
        self.assertEqual(result["firings"], 1, "a one-sided row never crosses")
        self.assertEqual(result["winner"], "UP", "but it sets the winner")
        self.assertTrue(result["firstFiringWon"])

    def test_pre_open_and_trades_ignored(self):
        rows = [book(-30, 0.50, 0.51), book(-20, 0.68, 0.33),            # before the open
                {"t": R + 1, "a": "btc", "m": "0xm", "r": str(R), "k": "t", "tok": "u", "p": 0.9, "s": 5, "side": "BUY"},
                book(1, 0.70, 0.31), book(2, 0.71, 0.30)]
        self.assertEqual(self.count(full_round(rows))["firings"], 0, "pre-open quotes never count")

    def test_incomplete_round(self):
        late_start = self.count([book(30, 0.50, 0.51), book(250, 0.50, 0.51)])
        self.assertTrue(late_start["incomplete"], "no clean frame in the first 10 s")
        r2 = reversals.ONE_SIDED_FROM // 300 * 300 + 300                  # a round recorded with one-sided rows
        short = reversals.count_round([book(1, 0.50, 0.51, r=r2), book(100, 0.68, 0.33, r=r2)], r2)
        self.assertTrue(short["incomplete"], "a new-era recording that stopped before 240 s")
        old = self.count([book(1, 0.50, 0.51), book(100, 0.68, 0.33)])      # R is before ONE_SIDED_FROM? not here
        self.assertEqual(old["firings"], 1)


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.history = self.tmp / "market-history"
        (self.history / "btc").mkdir(parents=True)
        self.cache = self.tmp / "reversals"

    def write(self, name, rows, truncate=False):
        path = self.history / "btc" / name
        data = gzip.compress("".join(json.dumps(x) + "\n" for x in rows).encode())
        path.write_bytes(data[:-20] if truncate else data)
        return path

    def test_truncated_member_and_cache(self):
        rows = full_round([book(1, 0.50, 0.51), book(2, 0.68, 0.33)])
        rows += full_round([book(1, 0.50, 0.51, r=R + 300)], r=R + 300)
        self.write("2027-01-15.jsonl.gz", rows, truncate=True)
        day = reversals.day_rounds(self.history, self.cache, "btc", "2027-01-15")
        self.assertGreaterEqual(len(day), 1, "rows before a truncated end are kept")
        self.assertEqual(day[0]["firings"], 1)
        opened = []
        original = gzip.open
        gzip.open = lambda *a, **k: opened.append(a) or original(*a, **k)
        try:
            reversals.day_rounds(self.history, self.cache, "btc", "2027-01-15", now=time.time() + 3600)
        finally:
            gzip.open = original
        self.assertEqual(opened, [], "an unchanged file is answered from the cache")

    def test_summary_distribution(self):
        rows = []
        for k, n in enumerate([0, 1, 1, 3]):
            r = R + 300 * k
            seq = [book(1, 0.50, 0.51, r=r)]
            up = True
            for i in range(n):
                seq.append(book(10 + i * 10, 0.68 if up else 0.33, 0.33 if up else 0.68, r=r))
                seq.append(book(15 + i * 10, 0.50, 0.51, r=r))
                up = not up
            rows += full_round(seq, r=r)
        self.write("2027-01-15.jsonl.gz", rows)
        result = reversals.summary(self.history, self.cache, "btc", days=10, today="2027-01-15")
        total = result["total"]
        self.assertEqual(total["rounds"], 4)
        self.assertEqual(total["maxFirings"], 3)
        self.assertEqual(total["distribution"], {"0": 1, "1": 2, "2": 0, "3": 1}, "every value 0..max is listed")
        self.assertEqual(result["days"][0]["date"], "2027-01-15")

    def test_request_never_parses(self):
        """A full day takes about a minute to parse and holding it got the
        control plane OOM-killed: a request reads only the cache."""
        rows = full_round([book(1, 0.50, 0.51), book(2, 0.68, 0.33)])
        self.write("2027-01-15.jsonl.gz", rows)
        empty = reversals.summary(self.history, self.cache, "btc", days=1, today="2027-01-15", cached_only=True)
        self.assertEqual(empty["total"]["rounds"], 0, "nothing parsed on the request path")
        import subprocess
        subprocess.run([sys.executable, str(ROOT / "scripts" / "dashboard" / "reversals.py"), "--history", str(self.history),
                        "--cache", str(self.cache), "--assets", "btc", "--days", "1", "--today", "2027-01-15"], check=True)
        warm = reversals.summary(self.history, self.cache, "btc", days=1, today="2027-01-15", cached_only=True)
        self.assertEqual(warm["total"]["rounds"], 1, "the warmer filled the cache")


if __name__ == "__main__":
    unittest.main()

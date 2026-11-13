"""scripts/backtest.py, the recording readers the research scripts import:
Round gives a round's winner and whether its recording is complete;
read_lines streams a day file past an unfinished gzip member.

Run:  python scripts/regress/recordings.py
"""
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import backtest as bt  # noqa: E402

R = bt.ONE_SIDED_FROM // 300 * 300 + 300       # a round recorded with one-sided rows


def book(t, ua, da, ub=None, db=None, ue=None, de=None, ual=None, dal=None, k=None):
    """A recorded book row; exchange times default to the receive time (fresh);
    the five levels default to 100 shares at the best ask."""
    row = {"t": R + t, "r": str(R), "ua": ua, "da": da,
           "ub": ua - 0.01 if ub is None and ua is not None else ub,
           "db": da - 0.01 if db is None and da is not None else db,
           "ue": R + t if ue is None else R + ue, "de": R + t if de is None else R + de,
           "ual": [[ua, 100]] if ual is None and ua is not None else ual,
           "dal": [[da, 100]] if dal is None and da is not None else dal}
    if k:
        row["k"] = k
    return row


def dense(rows):
    """An active book: a fresh frame every second between two rows with the
    earlier asks (live drops its starting point after 2 s without one)."""
    out, last = [], None
    for row in rows:
        if row.get("k") is None:
            if last is not None:
                second = int(last["t"] - R) + 1
                while R + second < row["t"]:
                    out.append(book(second, last["ua"], last["da"], ual=last["ual"], dal=last["dal"]))
                    second += 1
            last = row
        out.append(row)
    return out


def run(rows, end=None):
    """Feed a round padded to +250 s with the last asks, or with `end` (up, down)."""
    last = [x for x in rows if x.get("k") is None][-1]
    tail = book(250, *(end or (last["ua"], last["da"])))
    item = bt.Round(R, (5,))
    for row in dense(rows + [tail]):
        item.feed(json.loads(json.dumps(row)))
    return item


class Recording(unittest.TestCase):
    def test_first_frame_is_baseline_only(self):
        self.assertEqual(run([book(1, 0.70, 0.31), book(2, 0.71, 0.30)]).sides, [])

    def test_cross_and_same_side_again(self):
        item = run([book(1, 0.50, 0.51), book(2, 0.68, 0.33), book(3, 0.60, 0.41), book(4, 0.69, 0.32)])
        self.assertEqual(item.sides, ["UP"], "the same side again does not count")

    def test_one_sided_row_restarts_and_gives_winner(self):
        one_sided = book(1.5, 0.50, None, k="o")
        self.assertEqual(run([book(1, 0.50, 0.51), one_sided, book(1.8, 0.68, 0.33)]).sides, [])
        item = run([book(1, 0.50, 0.51), book(2, 0.68, 0.33)])
        item.feed(book(290, None, 0.01, ub=0.99, k="o"))
        self.assertEqual(item.winner, "UP")

    def test_incomplete(self):
        self.assertTrue(run([book(1, 0.50, 0.51)]).complete())
        late = bt.Round(R, (5,))
        for row in [book(30, 0.50, 0.51), book(250, 0.50, 0.51)]:
            late.feed(row)
        self.assertFalse(late.complete(), "no clean frame in the first 10 s")
        short = bt.Round(R, (5,))
        for row in dense([book(1, 0.50, 0.51), book(100, 0.50, 0.51)]):
            short.feed(row)
        self.assertFalse(short.complete(), "the recording stopped before 240 s")

    def test_before_one_sided_recording(self):
        # The first k:"o" row of every coin is at 1791179393 (2026-10-05 05:49:53
        # UTC); a round ten hours earlier lacks its last ~50 s and is not used.
        early = bt.Round(1791150000, (5,))
        for second in range(1, 251):
            early.feed({"t": 1791150000 + second, "r": "1791150000", "ua": 0.50, "da": 0.51,
                        "ue": 1791150000 + second, "de": 1791150000 + second})
        self.assertFalse(early.complete())


class Files(unittest.TestCase):
    def test_broken_member_mid_file(self):
        """2026-10-07: an unfinished member in the middle of a day file; reading
        resumes at the next member."""
        tmp = Path(tempfile.mkdtemp())
        first = [book(1, 0.50, 0.51)]
        second = [{**book(1, 0.50, 0.51), "r": str(R + 300), "t": R + 301}]
        path = tmp / "day.jsonl.gz"
        broken = gzip.compress("".join(json.dumps(x) + chr(10) for x in first).encode())[:-30]
        whole = gzip.compress("".join(json.dumps(x) + chr(10) for x in second).encode())
        path.write_bytes(broken + whole)
        rounds = {json.loads(line).get("r") for line in bt.read_lines(path) if line}
        self.assertIn(str(R + 300), rounds)

    def test_subclass_hook_still_called(self):
        """forward-binance-agg.py and others subclass Round with _place(*args)."""
        calls = []

        class W(bt.Round):
            def _place(self, *args):
                calls.append(args[0])
        item = W(R, (5,))
        for row in dense([book(1, 0.50, 0.51), book(2, 0.68, 0.33), book(250, 0.68, 0.33)]):
            item.feed(row)
        self.assertEqual(calls, ["UP"])


if __name__ == "__main__":
    unittest.main()

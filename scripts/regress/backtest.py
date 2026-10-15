"""scripts/backtest.py: crossings counted like live, orders filled by depth.

Run:  python scripts/regress/backtest.py
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
LADDER = (5, 13, 60)


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


def run(rows, end=None, ladder=LADDER):
    """Feed a round padded to +250 s with the last asks, or with `end` (up, down)."""
    last = [x for x in rows if x.get("k") is None][-1]
    tail = book(250, *(end or (last["ua"], last["da"])))
    item = bt.Round(R, ladder)
    for row in dense(rows + [tail]):
        item.feed(json.loads(json.dumps(row)))
    return item


class Count(unittest.TestCase):
    def test_first_frame_is_baseline_only(self):
        self.assertEqual(run([book(1, 0.70, 0.31), book(2, 0.71, 0.30)]).sides, [])

    def test_cross_and_same_side_again(self):
        item = run([book(1, 0.50, 0.51), book(2, 0.68, 0.33), book(3, 0.60, 0.41), book(4, 0.69, 0.32)])
        self.assertEqual(item.sides, ["UP"], "the same side again does not count")

    def test_alternating(self):
        rows, up = [book(1, 0.50, 0.51)], True
        for i in range(9):
            rows += [book(10 + i * 10, 0.68 if up else 0.33, 0.33 if up else 0.68), book(15 + i * 10, 0.50, 0.51)]
            up = not up
        item = run(rows)
        self.assertEqual(len(item.sides), 9)
        self.assertEqual(item.seconds[:2], [10.0, 20.0])

    def test_wide_frame_skipped_baseline_kept(self):
        self.assertEqual(run([book(1, 0.50, 0.51), book(2, 0.70, 0.60), book(3, 0.55, 0.46)]).sides, [],
                         "the only frame over 0.67 sums to 1.30")
        self.assertEqual(run([book(1, 0.50, 0.51), book(1.5, 0.70, 0.60), book(2, 0.68, 0.33)]).sides, ["UP"],
                         "the next clean frame still crosses against the kept baseline")

    def test_late_quotes_restart(self):
        rows = [book(1, 0.50, 0.51), book(2, 0.60, 0.41), book(8, 0.68, 0.33, ue=2.3, de=2.3), book(8.5, 0.69, 0.32)]
        self.assertEqual(run(rows).sides, [])

    def test_silence_over_two_seconds_restarts(self):
        item = bt.Round(R, LADDER)
        for row in [book(1, 0.50, 0.51), book(4, 0.33, 0.72), book(250, 0.33, 0.72)]:
            item.feed(row)
        self.assertEqual(item.sides, [])
        self.assertEqual(run([book(1, 0.50, 0.51), book(2, 0.33, 0.72)]).sides, ["DOWN"], "1 s later it is a cross")

    def test_skewed_and_backwards_times_restart(self):
        self.assertEqual(run([book(1, 0.50, 0.51), book(2, 0.68, 0.33, ue=2.0, de=0.4), book(2.5, 0.60, 0.41)]).sides, [])
        self.assertEqual(run([book(1, 0.50, 0.51, ue=1.0, de=1.0), book(1.5, 0.52, 0.49, ue=0.8, de=1.5),
                              book(2, 0.68, 0.33)]).sides, [])

    def test_one_sided_row_restarts_and_gives_winner(self):
        one_sided = book(1.5, 0.50, None, k="o")
        self.assertEqual(run([book(1, 0.50, 0.51), one_sided, book(1.8, 0.68, 0.33)]).sides, [])
        item = run([book(1, 0.50, 0.51), book(2, 0.68, 0.33)])
        item.feed(book(290, None, 0.01, ub=0.99, k="o"))
        self.assertEqual(item.winner, "UP")

    def test_trades_and_prices_ignored(self):
        trade = {"t": R + 1.5, "r": str(R), "k": "t", "tok": "u", "p": 0.9, "s": 5, "side": "BUY"}
        price = {"t": R + 1.6, "r": str(R), "k": "c", "e": R + 1, "p": 1.0}
        self.assertEqual(run([book(1, 0.50, 0.51), trade, price, book(2, 0.68, 0.33)]).sides, ["UP"])

    def test_incomplete(self):
        self.assertTrue(run([book(1, 0.50, 0.51)]).complete())
        late = bt.Round(R, LADDER)
        for row in [book(30, 0.50, 0.51), book(250, 0.50, 0.51)]:
            late.feed(row)
        self.assertFalse(late.complete(), "no clean frame in the first 10 s")
        short = bt.Round(R, LADDER)
        for row in dense([book(1, 0.50, 0.51), book(100, 0.50, 0.51)]):
            short.feed(row)
        self.assertFalse(short.complete(), "the recording stopped before 240 s")

    def test_before_one_sided_recording(self):
        # The first k:"o" row of every coin is at 1791179393 (2026-10-05 05:49:53
        # UTC); a round ten hours earlier lacks its last ~50 s and is not used.
        early = bt.Round(1791150000, LADDER)
        for second in range(1, 251):
            early.feed({"t": 1791150000 + second, "r": "1791150000", "ua": 0.50, "da": 0.51,
                        "ue": 1791150000 + second, "de": 1791150000 + second})
        self.assertFalse(early.complete())


class Fill(unittest.TestCase):
    def test_rungs_at_070(self):
        win = lambda n: run([book(1, 0.50, 0.51)] + [
            book(10 + 10 * i, *((0.70, 0.31) if i % 2 == 0 else (0.31, 0.70))) for i in range(n)],
            end=(0.95, 0.05) if n % 2 else (0.05, 0.95)).pnl()
        maker = lambda s: s * 0.70 + s * 0.07 * 0.70 * 0.30
        self.assertAlmostEqual(win(1), 5 - maker(5), places=6)
        self.assertAlmostEqual(win(2), 13 - maker(18), places=6)
        self.assertAlmostEqual(win(3), 65 - maker(78), places=6)

    def test_fourth_reversal_buys_nothing(self):
        rows = [book(1, 0.50, 0.51)] + [book(10 + 10 * i, *((0.70, 0.31) if i % 2 == 0 else (0.31, 0.70))) for i in range(4)]
        item = run(rows, end=(0.05, 0.95))
        self.assertEqual(len(item.orders), 3)
        self.assertAlmostEqual(item.pnl(), 13 - 78 * (0.70 + 0.07 * 0.70 * 0.30), places=6)

    def test_takes_only_depth_under_limit(self):
        """At the cross only the asks <= 0.70 fill, each at its own price."""
        rows = [book(1, 0.50, 0.51), book(2, 0.68, 0.33, ual=[[0.68, 2], [0.70, 1], [0.72, 50]])]
        item = run(rows, end=(0.95, 0.05))
        order = item.orders[0]
        self.assertAlmostEqual(order.taken, 3)
        fee = lambda p: p + 0.07 * p * (1 - p)
        self.assertAlmostEqual(order.cost, 2 * fee(0.68) + fee(0.70), places=6)

    def test_rest_fills_from_largest_later_frame(self):
        """The rest rests at 0.70: it fills from the largest quantity <= 0.70 in
        any one later frame, not the sum over frames."""
        rows = [book(1, 0.50, 0.51), book(2, 0.68, 0.33, ual=[[0.68, 1]]),
                book(3, 0.71, 0.30, ual=[[0.70, 1], [0.71, 9]]), book(4, 0.70, 0.31, ual=[[0.70, 2]])]
        order = run(rows, end=(0.95, 0.05)).orders[0]
        self.assertAlmostEqual(order.filled()[0], 1 + 2, msg="1 at the cross, then 2 (the largest frame), not 1+2+...")
        never = run([book(1, 0.50, 0.51), book(2, 0.68, 0.33, ual=[[0.68, 1]]), book(3, 0.75, 0.26, ual=[[0.75, 9]])],
                    end=(0.95, 0.05)).orders[0]
        self.assertAlmostEqual(never.filled()[0], 1, msg="never back to 0.70: the rest stays unfilled")

    def test_resting_rung1_fills_before_the_other_side_crosses(self):
        """On a clean frame the other side at >= 0.67 puts this side's ask at
        <= 0.38, so a resting rung 1 fills first: the other cross is rung 2."""
        item = run([book(1, 0.50, 0.51), book(2, 0.72, 0.29, ual=[[0.72, 50]]), book(3, 0.31, 0.68)], end=(0.05, 0.95))
        self.assertEqual([(o.side, o.shares, o.live) for o in item.orders], [("UP", 5, True), ("DOWN", 13, True)])
        self.assertAlmostEqual(item.orders[0].filled()[0], 5)

    def test_rest_fills_from_trades_the_book_missed(self):
        """2026-10-15 audit: the price can jump through 0.70 between two recorded
        frames, or the five levels can be missing while the best ask is <= 0.70;
        the frames then show nothing <= 0.70 though real trades printed there.
        A resting 0.70 buy also fills from the tape: a taker SELL of this token at
        <= 0.70, or a taker BUY of the other token at >= 0.30 (minted against it)."""
        trade = lambda t, tok, p, s, side: {"t": R + t, "r": str(R), "k": "t", "tok": tok, "p": p, "s": s, "side": side}
        base = [book(1, 0.50, 0.51), book(2, 0.68, 0.33, ual=[[0.68, 1]]), book(3, 0.75, 0.26, ual=[[0.75, 9]])]
        sold = run(base + [trade(3.5, "u", 0.69, 3, "SELL"), book(4, 0.75, 0.26, ual=[[0.75, 9]])], end=(0.95, 0.05))
        self.assertAlmostEqual(sold.orders[0].filled()[0], 1 + 3, msg="a SELL of UP at 0.69 fills 3 of the resting rest")
        minted = run(base + [trade(3.5, "d", 0.31, 2, "BUY"), book(4, 0.75, 0.26, ual=[[0.75, 9]])], end=(0.95, 0.05))
        self.assertAlmostEqual(minted.orders[0].filled()[0], 1 + 2, msg="a BUY of DOWN at 0.31 is a match against UP at 0.69")
        above = run(base + [trade(3.5, "u", 0.72, 9, "SELL"), trade(3.6, "d", 0.27, 9, "BUY"),
                            book(4, 0.75, 0.26, ual=[[0.75, 9]])], end=(0.95, 0.05))
        self.assertAlmostEqual(above.orders[0].filled()[0], 1, msg="trades above the limit fill nothing")
        before = run([book(1, 0.50, 0.51), trade(1.5, "u", 0.60, 9, "SELL"), book(2, 0.68, 0.33, ual=[[0.68, 1]]),
                      book(3, 0.75, 0.26, ual=[[0.75, 9]])], end=(0.95, 0.05))
        self.assertAlmostEqual(before.orders[0].filled()[0], 1, msg="a trade before the order was placed does not fill it")
        capped = run(base + [trade(3.5, "u", 0.69, 50, "SELL")], end=(0.95, 0.05))
        self.assertAlmostEqual(capped.orders[0].filled()[0], 5, msg="never more than the order's size")

    def test_from_trigger_k(self):
        """--from-trigger K: the first K-1 crossings are counted, not traded; the
        K-th places rung 1, then the ladder goes on as usual."""
        rows = [book(1, 0.50, 0.51)] + [book(10 + 10 * i, *((0.70, 0.31) if i % 2 == 0 else (0.31, 0.70))) for i in range(4)]
        item = bt.Round(R, LADDER, from_trigger=3)
        for row in dense(rows + [book(250, 0.05, 0.95)]):
            item.feed(json.loads(json.dumps(row)))
        self.assertEqual(item.sides, ["UP", "DOWN", "UP", "DOWN"], "all crossings still counted and alternating")
        self.assertEqual([(o.side, o.shares) for o in item.orders], [("UP", 5), ("DOWN", 13)])
        maker = lambda s: s * 0.70 + s * 0.07 * 0.70 * 0.30
        self.assertAlmostEqual(item.pnl(), 13 - maker(18), places=6)
        early = bt.Round(R, LADDER, from_trigger=5)
        for row in dense(rows + [book(250, 0.05, 0.95)]):
            early.feed(json.loads(json.dumps(row)))
        self.assertEqual(early.orders, [], "never reached the 5th crossing: nothing bought")

    def test_unfilled_rung1_moves(self):
        """STRATEGY.md 4: rung 1 with nothing filled when the other side crosses
        is cancelled and placed there as rung 1 (5 shares)."""
        item = bt.Round(R, LADDER)
        item._place("UP", book(2, 0.72, 0.29, ual=[[0.72, 50]]), R + 2)
        item._place("DOWN", book(3, 0.31, 0.68), R + 3)
        self.assertEqual([(o.side, o.shares, o.live) for o in item.orders], [("UP", 5, False), ("DOWN", 5, True)])
        self.assertEqual(item.orders[0].filled(), (0.0, 0.0), "the cancelled order buys nothing")


class Files(unittest.TestCase):
    def test_broken_member_mid_file(self):
        """2026-10-07: an unfinished member in the middle of a day file; reading
        resumes at the next member."""
        tmp = Path(tempfile.mkdtemp())
        first = [book(1, 0.50, 0.51)]
        second = [{**book(1, 0.50, 0.51), "r": str(R + 300), "t": R + 301}]
        path = tmp / "day.jsonl.gz"
        broken = gzip.compress("".join(json.dumps(x) + "\n" for x in first).encode())[:-30]
        whole = gzip.compress("".join(json.dumps(x) + "\n" for x in second).encode())
        path.write_bytes(broken + whole)
        self.assertIn(R + 300, [item.start for item in bt.day_rounds(path, LADDER)])


if __name__ == "__main__":
    unittest.main()

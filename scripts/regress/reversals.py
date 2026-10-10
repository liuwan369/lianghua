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


def book(t, ua, da, ub=None, db=None, r=R, ue=None, de=None):
    """A recorded book row; exchange times default to the receive time (fresh)."""
    return {"t": r + t, "a": "btc", "m": "0xm", "r": str(r), "ua": ua, "da": da,
            "ub": ua - 0.01 if ub is None else ub, "db": da - 0.01 if db is None else db,
            "ue": r + t if ue is None else r + ue, "de": r + t if de is None else r + de}


def dense(rows, r=R):
    """An active book: between two book rows, a fresh frame every second with
    the earlier asks (live drops its baseline after 2 s without one)."""
    out, last = [], None
    for row in rows:
        if row.get("k") is None and "ua" in row:
            if last is not None:
                second = int(last["t"] - r) + 1
                while r + second < row["t"]:
                    out.append(book(second, last["ua"], last["da"], r=r))
                    second += 1
            last = row
        out.append(row)
    return out


def full_round(rows, r=R):
    """Pad a round so it counts as complete: fresh frames up to +250 s keep the last asks."""
    last = [x for x in rows if "ua" in x and x.get("k") is None][-1]
    return dense(rows + [book(250, last["ua"], last["da"], r=r)], r=r)


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

    # --- Freshness like live (operator 2026-10-11): the engine trusts a pair
    # only if each side's exchange time is at most 2 s old when it arrives and
    # the two are at most 1.5 s apart; otherwise its starting point is dropped
    # and the next usable pair is a new starting point, never a cross. The page
    # counted these and showed ~11-35% more firings than live would trade.

    def test_late_quotes_drop_the_baseline(self):
        """Data arriving late (exchange time 5.7 s old, as on 10-07..09) is not
        trusted: no cross from it, and the next fresh pair only restarts."""
        rows = [book(1, 0.50, 0.51), book(2, 0.60, 0.41),
                book(8, 0.68, 0.33, ue=2.3, de=2.3),     # 5.7 s old on arrival: unusable
                book(8.5, 0.69, 0.32)]                   # fresh, but only a new baseline
        self.assertEqual(self.count(full_round(rows))["firings"], 0)

    def test_silence_over_two_seconds_restarts(self):
        """Nothing usable for more than 2 s: live's feed reports a stale book and
        the strategy restarts, so the jump across the silence is not a cross."""
        rows = [book(1, 0.50, 0.51), book(4, 0.33, 0.72)]          # 3 s with no frame
        self.assertEqual(self.count(rows + [book(250, 0.33, 0.72)])["firings"], 0)
        self.assertEqual(self.count(full_round([book(1, 0.50, 0.51), book(2, 0.33, 0.72)]))["firings"], 1,
                         "control: the same move 1 s later is a cross")

    def test_skewed_sides_are_not_used(self):
        """The two sides' exchange times more than 1.5 s apart: not a usable pair."""
        rows = [book(1, 0.50, 0.51), book(2, 0.68, 0.33, ue=2.0, de=0.4), book(2.5, 0.60, 0.41)]
        self.assertEqual(self.count(full_round(rows))["firings"], 0)

    def test_one_sided_book_restarts(self):
        """A one-sided book is no usable pair either: live restarts after it."""
        one_sided = {"t": R + 1.5, "a": "btc", "m": "0xm", "r": str(R), "k": "o", "ub": 0.49, "ua": 0.50, "db": 0.50}
        rows = [book(1, 0.50, 0.51), one_sided, book(1.8, 0.68, 0.33)]
        self.assertEqual(self.count(full_round(rows))["firings"], 0)
        self.assertEqual(self.count(full_round([book(1, 0.50, 0.51), book(1.8, 0.68, 0.33)]))["firings"], 1,
                         "control: without the one-sided frame it is a cross")

    def test_wide_frame_keeps_the_baseline(self):
        """STRATEGY rule 2: a wide frame (> 1.05) is skipped, the baseline stays."""
        rows = [book(1, 0.50, 0.51), book(1.5, 0.70, 0.60), book(2, 0.68, 0.33)]
        self.assertEqual(self.count(full_round(rows))["firings"], 1)

    def test_exchange_time_going_back_restarts(self):
        rows = [book(1, 0.50, 0.51, ue=1.0, de=1.0), book(1.5, 0.52, 0.49, ue=0.8, de=1.5), book(2, 0.68, 0.33)]
        self.assertEqual(self.count(full_round(rows))["firings"], 0)

    def test_incomplete_round(self):
        late_start = self.count([book(30, 0.50, 0.51), book(250, 0.50, 0.51)])
        self.assertTrue(late_start["incomplete"], "no clean frame in the first 10 s")
        r2 = reversals.ONE_SIDED_FROM // 300 * 300 + 300                  # a round recorded with one-sided rows
        short = reversals.count_round([book(1, 0.50, 0.51, r=r2), book(100, 0.68, 0.33, r=r2)], r2)
        self.assertTrue(short["incomplete"], "a new-era recording that stopped before 240 s")
        old = self.count(dense([book(1, 0.50, 0.51), book(100, 0.68, 0.33)]))  # R is before ONE_SIDED_FROM
        self.assertEqual(old["firings"], 1)

    def test_price_rows_do_not_extend_the_book(self):
        """Coin (k "p") and Chainlink (k "c") rows arrive every second to the
        end of the round; a book cut off at 100 s is still incomplete."""
        r2 = reversals.ONE_SIDED_FROM // 300 * 300 + 300
        rows = dense([book(1, 0.50, 0.51, r=r2), book(100, 0.68, 0.33, r=r2)], r=r2)
        rows += [{"t": r2 + s, "a": "btc", "r": str(r2), "k": k, "e": r2 + s, "p": 1.0} for s in range(101, 300) for k in ("p", "c")]
        self.assertTrue(reversals.count_round(rows, r2)["incomplete"])


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
        original = reversals.read_lines
        reversals.read_lines = lambda *a, **k: opened.append(a) or original(*a, **k)
        try:
            reversals.day_rounds(self.history, self.cache, "btc", "2027-01-15", now=time.time() + 3600)
        finally:
            reversals.read_lines = original
        self.assertEqual(opened, [], "an unchanged file is answered from the cache")

    def test_broken_member_mid_file(self):
        """2026-10-07: a collector restart left an unfinished member in the
        middle of every day file; gzip.open stopped there and lost the rest of
        the day. Reading resumes at the next member."""
        # Three rows per member, as before: this checks the reader, not the counter.
        first = [book(1, 0.50, 0.51), book(2, 0.68, 0.33), book(250, 0.68, 0.33)]
        second = [book(1, 0.50, 0.51, r=R + 300), book(2, 0.33, 0.68, r=R + 300), book(250, 0.33, 0.68, r=R + 300)]
        path = self.history / "btc" / "2027-01-15.jsonl.gz"
        broken = gzip.compress("".join(json.dumps(x) + "\n" for x in first).encode())[:-30]
        whole = gzip.compress("".join(json.dumps(x) + "\n" for x in second).encode())
        path.write_bytes(broken + whole)
        day = reversals.day_rounds(self.history, self.cache, "btc", "2027-01-15")
        self.assertIn(str(R + 300), [str(x["startsAt"]) for x in day], "the round after the broken member is read")

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


class Ladder(unittest.TestCase):
    """STRATEGY.md section 6: up to 3 rungs 5/13/60 at a 0.70 limit; a rung
    whose ask at the cross is above 0.70 buys nothing; no 4th rung."""

    def count(self, rows):
        return reversals.count_round([json.loads(json.dumps(x)) for x in rows], R)

    def round_(self, sides, asks, winner):
        return {"sides": sides, "asks": asks, "winner": winner, "firings": len(sides)}

    def test_outcomes_at_070(self):
        p = lambda r: reversals.ladder_pnl(r, fee=False)
        self.assertAlmostEqual(p(self.round_(["UP"], [0.70], "UP")), 1.50)
        self.assertAlmostEqual(p(self.round_(["UP", "DOWN"], [0.70, 0.70], "DOWN")), 0.40)
        self.assertAlmostEqual(p(self.round_(["UP", "DOWN", "UP"], [0.70] * 3, "UP")), 10.40)
        self.assertAlmostEqual(p(self.round_(["UP", "DOWN", "UP", "DOWN"], [0.70] * 4, "DOWN")), -41.60,
                               msg="a 4th reversal buys nothing; the held shares settle")

    def test_above_limit_not_bought(self):
        r = self.round_(["UP", "DOWN"], [0.70, 0.75], "DOWN")
        self.assertAlmostEqual(reversals.ladder_pnl(r, fee=False), -3.50, msg="the 0.75 hedge is not filled at a 0.70 limit")

    def test_no_winner(self):
        self.assertIsNone(reversals.ladder_pnl(self.round_(["UP"], [0.70], None)))

    def test_summary_has_ladder(self):
        rounds = [{**self.round_(["UP"], [0.68], "UP"), "incomplete": False, "firstFiringWon": True,
                   "partialLastMinute": False, "roundId": "1", "startsAt": 1}]
        stats = reversals._stats(rounds, "btc")
        self.assertIn("ladder", stats)
        self.assertEqual(stats["ladder"]["rounds"], 1)
        self.assertGreater(stats["ladder"]["total"], 1.5, "bought at 0.68, cheaper than the limit")

    def test_resting_order_fills_when_price_comes_back(self):
        """Like live (operator 2026-10-07): an order whose ask at the cross is
        above 0.70 keeps resting; it fills at 0.70 (maker, no fee) the first
        time that side's ask comes back to 0.70 or below, else never."""
        rows = [book(1, 0.50, 0.51), book(10, 0.68, 0.33),            # rung 1 UP at 0.68
                book(20, 0.50, 0.51), book(21, 0.12, 0.88),           # DOWN jumps to 0.88: rung 2 rests
                book(40, 0.32, 0.69)]                                  # DOWN back to 0.69: filled at 0.70
        counted = self.count(full_round(rows))
        self.assertEqual(counted["fills"], [10.0, 40.0])
        never = self.count(full_round([book(1, 0.50, 0.51), book(10, 0.68, 0.33), book(20, 0.50, 0.51), book(21, 0.10, 0.88)]))
        self.assertEqual(never["fills"], [10.0, None], "never back below 0.70: not filled")
        item = {**counted, "winner": "DOWN"}
        self.assertAlmostEqual(reversals.ladder_pnl(item), 13 - 13 * 0.70 - 5 * (0.68 + 0.07 * 0.68 * 0.32), places=4)

    def test_unfilled_rung1_moves_to_the_other_side(self):
        """STRATEGY.md 4: rung 1 not filled when the other side crosses first is
        cancelled and placed on the other side, still as rung 1 (5 shares)."""
        item = {"sides": ["UP", "DOWN", "UP"], "asks": [0.80, 0.67, 0.67], "seconds": [10.0, 20.0, 30.0],
                "fills": [25.0, 20.0, 30.0], "winner": "DOWN"}             # UP would fill at 25 s, after DOWN crossed
        self.assertAlmostEqual(reversals.ladder_pnl(item, fee=False), 5 - (5 + 13) * 0.70,
                               msg="DOWN is rung 1 (5), UP rung 2 (13); the cancelled UP order never fills")
        filled_first = {**item, "fills": [15.0, 20.0, 30.0], "winner": "UP"}  # UP filled at 15 s, before DOWN
        self.assertAlmostEqual(reversals.ladder_pnl(filled_first, fee=False), 65 - 78 * 0.70)

    def test_each_firing_count_on_its_own(self):
        """After rung 3 nothing more is bought: an odd count ends on the side of
        rungs 1+3 (65 shares, a profit), an even one on the rung-2 side."""
        base = {"incomplete": False, "firstFiringWon": True, "partialLastMinute": False, "roundId": "1", "startsAt": 1}
        def round_n(n):
            sides = ["UP" if i % 2 == 0 else "DOWN" for i in range(n)]
            return {**base, "sides": sides, "asks": [0.70] * n, "seconds": [10.0 * (i + 1) for i in range(n)],
                    "fills": [10.0 * (i + 1) for i in range(n)], "winner": sides[-1], "firings": n}
        by = reversals._stats([round_n(n) for n in (1, 3, 4, 5, 10)], "btc")["ladder"]["byFirings"]
        self.assertEqual(list(by), ["1", "3", "4", "5", "10"], "every count, in numeric order, no 4+ bucket")
        self.assertGreater(by["5"]["total"], 0, "5 reversals: the rung 1+3 side wins")
        self.assertLess(by["4"]["total"], 0)
        self.assertLess(by["10"]["total"], 0)

    def test_flow_share_at_first_trigger(self):
        """Operator 2026-10-08: the share of the trades in the 5 s before the first
        trigger that push the triggered side up (taker BUY of its token or taker
        SELL of the other token), by volume. Older trades and later ones don't count."""
        trade = lambda t, tok, side, s: {"t": R + t, "a": "btc", "m": "0xm", "r": str(R), "k": "t", "tok": tok, "p": 0.6, "s": s, "side": side}
        rows = [book(1, 0.50, 0.51),
                trade(2, "u", "BUY", 100),                       # 8 s before the trigger: outside the window
                trade(6, "u", "BUY", 30), trade(7, "d", "SELL", 30), trade(8, "u", "SELL", 20),   # pushes UP: 60 of 80
                book(10, 0.68, 0.33),                            # first trigger: UP at 10 s
                trade(11, "d", "BUY", 500)]                      # after the trigger: ignored
        counted = self.count(full_round(rows))
        self.assertEqual(counted["sides"], ["UP"])
        self.assertAlmostEqual(counted["flow5"], 0.75)
        quiet = self.count(full_round([book(1, 0.50, 0.51), book(10, 0.68, 0.33)]))
        self.assertIsNone(quiet["flow5"], "no trades in the window: no reading")

    def test_late_flow_group(self):
        base = {"incomplete": False, "firstFiringWon": True, "partialLastMinute": False, "roundId": "1", "startsAt": 1}
        late_buy = {**base, **self.round_(["UP"], [0.70], "UP"), "seconds": [75.0], "flow5": 0.80}
        late_sell = {**base, **self.round_(["UP"], [0.70], "DOWN"), "seconds": [80.0], "flow5": 0.30}
        early = {**base, **self.round_(["UP"], [0.70], "UP"), "seconds": [12.0], "flow5": 0.90}
        stats = reversals._stats([late_buy, late_sell, early], "eth")
        self.assertEqual(stats["ladderLateFlow"]["rounds"], 1, "after 60 s and flow share > 55%")
        self.assertEqual(stats["ladderLateFlow"]["flowShare"], 0.55)

    def test_late_entry_group(self):
        """The operator's test (2026-10-07): only rounds whose first trigger comes
        at or after 60 s are traded; earlier rounds are skipped (no position)."""
        base = {"incomplete": False, "firstFiringWon": True, "partialLastMinute": False, "roundId": "1", "startsAt": 1}
        early = {**base, **self.round_(["UP"], [0.70], "DOWN"), "seconds": [12.0]}     # would lose 3.5
        late = {**base, **self.round_(["UP"], [0.70], "UP"), "seconds": [75.0]}        # wins
        stats = reversals._stats([early, late], "eth")
        self.assertEqual(stats["ladder"]["rounds"], 2)
        self.assertEqual(stats["ladderLate"]["rounds"], 1, "only the round triggered at or after 60 s")
        self.assertGreater(stats["ladderLate"]["total"], 0)
        self.assertEqual(stats["ladderLate"]["fromSecond"], 60)

    def test_late_entry_second_per_coin(self):
        """Operator 2026-10-10: each coin has its own second (picked on
        10-05/06): BTC 10, ETH 60, SOL 30, XRP 120, DOGE 45, HYPE 120, BNB 120."""
        base = {"incomplete": False, "firstFiringWon": True, "partialLastMinute": False, "roundId": "1", "startsAt": 1}
        at_12 = {**base, **self.round_(["UP"], [0.70], "UP"), "seconds": [12.0]}
        at_50 = {**base, **self.round_(["UP"], [0.70], "UP"), "seconds": [50.0]}
        btc = reversals._stats([at_12, at_50], "btc")["ladderLate"]
        self.assertEqual((btc["fromSecond"], btc["rounds"]), (10, 2), "BTC: 10 s, both rounds count")
        xrp = reversals._stats([at_12, at_50], "xrp")["ladderLate"]
        self.assertEqual((xrp["fromSecond"], xrp["rounds"]), (120, 0), "XRP: 120 s, neither counts")
        self.assertEqual(reversals._stats([at_12, at_50], "sol")["ladderLateFlow"]["fromSecond"], 30,
                         "the flow group uses the same per-coin second")
        self.assertEqual(set(reversals.LATE_FROM_SEC), {"btc", "eth", "sol", "xrp", "doge", "hype", "bnb"})


if __name__ == "__main__":
    unittest.main()

"""Maker backtest on the btc 5m recordings: one BUY limit per side at the best
bid, held to settlement (.claude-mm-spec.md). Read-only; run on the server:

    nice -n 19 python3 scripts/mm_backtest.py --from 2026-10-05 --to 2026-10-06 --out /tmp/rounds.csv
    python3 scripts/mm_backtest.py --selftest

Choices the spec leaves open (B on the server, /tmp/mm_b/mm_b.py, makes the
same ones; per-round results must match):
- rows are processed in file order (equal times keep file order); only rows
  with R <= t < R+300 of their own round count, and only rounds that open on
  the Beijing date of the file (the file ends with warm-up rows of the next
  day's first round).
- book rows are those without `k` and `k == "o"`. The quote price is the top
  of the ladder, ubl[0] / dbl[0], never the ub/db fields (they often run ahead
  of the ladder, so the queue would not be found). A missing or empty ladder
  is an empty side: no quote decision for it this frame, the working order
  stays, and live orders on it get ahead = 0.
- near the edges the venue ticks in 0.001 (0.996, 0.004), which rounds to 0
  or 100 cents; a target outside 1..99 is no decision, like an empty ladder.
- ub+db > 99 is checked on those ladder prices when both exist; such a frame
  places and reprices nothing, but the inventory cancel still runs.
- an order decided at frame t is live for events with t' >= t+0.3. Its
  `ahead` is set right before the first such event from the latest book frame
  received before that event (quantity at c in ubl / dbl).
- a cancel decided at t stops fills for events with t' >= t+0.3. The first
  event (book or trade) with t-R >= 240 cancels everything at t+0.3 and the
  round quotes no more.
- at a book frame: activate/expire orders, then ahead = min(ahead, level qty)
  for live orders, then winner, then the 240 s stop, then quote decisions.
- a trade's quantity is shared out oldest order first (a cancelling order
  before its replacement); what an order fills is gone for the later ones,
  for queue fills and through fills alike. Queue ahead is per order.
- a partly filled order that is repriced is cancelled for the rest and the
  new one is a full SIZE; a filled order is replaced at the next frame with a
  fresh queue.
- inventory: a side is not quoted (working order cancelled) while its held
  shares minus the other side's >= 30, checked at book frames only.
- rounds with no fills count with pnl 0; only an undetermined winner skips.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import date, datetime, timedelta
from multiprocessing import Pool
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backtest import BEIJING, HISTORY, ONE_SIDED_FROM, ROUND_SEC, WIN_PRICE, read_lines  # noqa: E402

EPS = 1e-9
INF = float("inf")
FEE_RATE = 0.07         # taker fee curve C x 0.07 x p (1-p); the rebate is a share of it


def _qty(levels, c: int) -> float:
    for p, q in levels:
        if round(p * 100) == c:
            return q
    return 0.0


class Order:
    __slots__ = ("c", "rem", "ahead", "live_from", "dead_at", "cancelled")

    def __init__(self, c: int, size: float, live_from: float):
        self.c, self.rem, self.ahead = c, size, None
        self.live_from, self.dead_at, self.cancelled = live_from, INF, False


# trade (tok, taker side) -> the bid book it hits, and whether its price is mirrored
HITS = {("u", "SELL"): ("UP", False), ("d", "BUY"): ("UP", True),
        ("d", "SELL"): ("DOWN", False), ("u", "BUY"): ("DOWN", True)}


class Round:
    def __init__(self, start: int, args):
        self.start, self.a = start, args
        self.orders = {"UP": [], "DOWN": []}
        self.held = {"UP": 0.0, "DOWN": 0.0}
        self.cost = {"UP": 0.0, "DOWN": 0.0}
        self.levels = {"UP": [], "DOWN": []}
        self.winner: str | None = None
        self.stopped = False
        self.rebate = 0.0

    def feed(self, row: dict) -> None:
        t, kind = row.get("t"), row.get("k")
        if not isinstance(t, (int, float)) or not (self.start <= t < self.start + ROUND_SEC):
            return
        if kind not in (None, "o", "t"):
            return
        self._tick(t)
        if kind == "t":
            self._trade(row)
            self._stop(t)
            return
        ubl, dbl = row.get("ubl") or [], row.get("dbl") or []
        for side, levels in (("UP", ubl), ("DOWN", dbl)):
            for o in self.orders[side]:
                if o.ahead is not None:
                    o.ahead = min(o.ahead, _qty(levels, o.c))
        self.levels = {"UP": ubl, "DOWN": dbl}
        ua, da, ub, db = row.get("ua"), row.get("da"), row.get("ub"), row.get("db")
        if (ua or 0) >= WIN_PRICE or (ub or 0) >= WIN_PRICE:      # backtest.py winner rule
            self.winner = "UP"
        elif (da or 0) >= WIN_PRICE or (db or 0) >= WIN_PRICE:
            self.winner = "DOWN"
        elif ua is not None and da is not None:
            self.winner = None
        self._stop(t)
        self._quote(t)

    def _tick(self, t: float) -> None:
        for side, orders in self.orders.items():
            keep = []
            for o in orders:
                if t >= o.dead_at or o.rem <= EPS:
                    continue
                if o.ahead is None and t >= o.live_from:
                    o.ahead = _qty(self.levels[side], o.c)
                keep.append(o)
            self.orders[side] = keep

    def _stop(self, t: float) -> None:
        if self.stopped or t - self.start < self.a.end:
            return
        self.stopped = True
        at = round(t + self.a.latency, 6)
        for orders in self.orders.values():
            for o in orders:
                o.cancelled, o.dead_at = True, min(o.dead_at, at)

    def _trade(self, row: dict) -> None:
        hit = HITS.get((row.get("tok"), row.get("side")))
        p, left = row.get("p"), row.get("s")
        if hit is None or not isinstance(p, (int, float)) or not isinstance(left, (int, float)):
            return
        side, mirrored = hit
        c = 100 - round(p * 100) if mirrored else round(p * 100)   # price on our bid book
        for o in self.orders[side]:                                # oldest first
            if left <= EPS:
                break
            if o.ahead is None or o.rem <= EPS:
                continue
            if c < o.c:                                            # through our price
                fill = min(o.rem, left)
            elif c == o.c:
                o.ahead -= left
                fill = 0.0
                if o.ahead < 0:
                    fill = min(-o.ahead, o.rem)
                    o.ahead = 0.0
            else:
                continue
            if fill > 0:
                left -= fill
                o.rem -= fill
                self.held[side] += fill
                self.cost[side] += fill * o.c / 100
                p = o.c / 100
                self.rebate += fill * self.a.rebate * FEE_RATE * p * (1 - p)

    def _quote(self, t: float) -> None:
        a = self.a
        if self.stopped or t - self.start < a.begin:
            return
        target = {s: round(lv[0][0] * 100) if lv else None for s, lv in self.levels.items()}
        wide = target["UP"] is not None and target["DOWN"] is not None and target["UP"] + target["DOWN"] > a.max_sum
        at = round(t + a.latency, 6)
        for side, other in (("UP", "DOWN"), ("DOWN", "UP")):
            working = [o for o in self.orders[side] if not o.cancelled and o.rem > EPS]
            if self.held[side] - self.held[other] >= a.inventory:
                for o in working:
                    o.cancelled, o.dead_at = True, min(o.dead_at, at)
                continue
            c = target[side]
            if c is not None:
                c -= a.offset
                if a.pair_cap is not None:
                    # keep this side's price + the other side's average (or its bid if none held) <= cap
                    ref = self.cost[other] / self.held[other] * 100 if self.held[other] > EPS else target[other]
                    if ref is not None:
                        c = min(c, math.floor(a.pair_cap - ref + 1e-9))
            if wide or c is None or not 0 < c < 100 or (working and working[-1].c == c):
                continue
            for o in working:
                o.cancelled, o.dead_at = True, min(o.dead_at, at)
            self.orders[side].append(Order(c, a.size, at))

    def result(self) -> tuple:
        up, dn = self.held["UP"], self.held["DOWN"]
        pnl = (None if self.winner is None
               else self.held[self.winner] - self.cost["UP"] - self.cost["DOWN"] + self.rebate)
        return (self.start, up, self.cost["UP"] / up if up else 0.0,
                dn, self.cost["DOWN"] / dn if dn else 0.0, self.winner, pnl)


def _work(job) -> tuple[str, list[tuple]]:
    path, day, args = job
    rounds: dict[str, Round] = {}
    for line in read_lines(path / f"{day}.jsonl.gz"):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        rid = row.get("r")
        if not (isinstance(rid, str) and rid.isdigit()):
            continue
        item = rounds.get(rid)
        if item is None:
            item = rounds[rid] = Round(int(rid), args)
        item.feed(row)
    d = date.fromisoformat(day)            # only rounds opening on this Beijing date
    lo = int(datetime(d.year, d.month, d.day, tzinfo=BEIJING).timestamp())
    return day, [rounds[k].result() for k in sorted(rounds, key=int) if lo <= int(k) < lo + 86400]


def _stat(label: str, rows: list[tuple]) -> str:
    done = [r for r in rows if r[6] is not None]
    pnls = [r[6] for r in done]
    n = len(pnls)
    shares = sum(r[1] + r[3] for r in done)
    total = sum(pnls)
    mean = total / n if n else float("nan")
    sd = math.sqrt(sum((v - mean) ** 2 for v in pnls) / (n - 1)) if n > 1 else 0.0
    t = mean / sd * math.sqrt(n) if sd else float("nan")
    per = total / shares if shares else float("nan")
    return (f"{label:<12} 场数 {n:>4} 跳过 {len(rows) - n:>3} 成交股数 {shares:>9.1f} 每股 {per:+.4f} "
            f"总pnl {total:+9.2f} 每场 {mean:+.3f} t {t:+.2f}")


def selftest() -> None:
    a = argparse.Namespace(size=10.0, begin=10.0, end=240.0, latency=0.3, max_sum=99, inventory=30.0,
                           offset=0, pair_cap=None, rebate=0.0)
    R = 1_800_000_000

    def book(r, s, ub, db, ubl, dbl, ua=None, da=None):
        r.feed({"t": R + s, "ub": ub, "db": db, "ua": ua, "da": da, "ubl": ubl, "dbl": dbl})

    def trade(r, s, tok, side, p, q):
        r.feed({"t": R + s, "k": "t", "tok": tok, "side": side, "p": p, "s": q})

    # queue ahead decrements before we fill; mirror tok=d BUY @100-c counts
    r = Round(R, a)
    book(r, 10, 0.50, 0.48, [[0.50, 20]], [[0.48, 5]])
    trade(r, 10.2, "u", "SELL", 0.50, 100)          # before t+0.3: not live
    assert r.held["UP"] == 0
    trade(r, 10.4, "u", "SELL", 0.50, 15)           # ahead 20 -> 5
    assert r.held["UP"] == 0 and r.orders["UP"][0].ahead == 5
    trade(r, 10.5, "d", "BUY", 0.50, 8)             # mirror at 100-50: ahead -3 -> fill 3
    assert abs(r.held["UP"] - 3) < EPS and r.held["DOWN"] == 0
    # a new frame caps ahead at the level's new quantity
    book(r, 11, 0.50, 0.48, [[0.50, 2]], [[0.48, 9]])
    assert r.orders["DOWN"][0].ahead == 5           # DOWN ahead 5 (min 5, 9)
    # through: tok=d BUY above 100-48 fills our DOWN? no: that's UP-mirror; DOWN through is tok=u BUY > 52
    trade(r, 11.1, "u", "BUY", 0.53, 0.1)           # through fills only the trade's 0.1
    assert abs(r.held["DOWN"] - 0.1) < EPS
    trade(r, 11.15, "u", "BUY", 0.53, 100)
    assert abs(r.held["DOWN"] - 10) < EPS and abs(r.cost["DOWN"] - 4.8) < EPS
    trade(r, 11.2, "u", "SELL", 0.49, 100)          # through for UP: rest 7 at 0.50
    assert abs(r.held["UP"] - 10) < EPS and abs(r.cost["UP"] - 5.0) < EPS
    # filled: the next frame places a fresh order with a reset queue
    book(r, 12, 0.50, 0.48, [[0.50, 40]], [[0.48, 9]])
    trade(r, 12.4, "d", "BUY", 0.50, 30)
    assert abs(r.held["UP"] - 10) < EPS and r.orders["UP"][-1].ahead == 10

    # requote resets the queue; the old order still fills inside the 0.3 s
    r = Round(R, a)
    book(r, 10, 0.50, 0.48, [[0.50, 0]], [[0.48, 0]])
    book(r, 11, 0.51, 0.48, [[0.51, 50], [0.50, 0]], [[0.48, 0]])   # replace UP 50 -> 51
    trade(r, 11.1, "u", "SELL", 0.50, 4)            # old 0.50 still live (cancel at 11.3)
    assert abs(r.held["UP"] - 4) < EPS
    trade(r, 11.5, "u", "SELL", 0.50, 40)           # old gone; new 51 sees a lower print = through
    assert abs(r.held["UP"] - 14) < EPS and abs(r.cost["UP"] - (0.04 * 50 + 0.10 * 51)) < 1e-6
    # one print is shared oldest first: old 50 (cancelling) takes 10, new 51 the 5 left
    r = Round(R, a)
    for c in (50, 51):
        o = Order(c, 10.0, R)
        o.ahead = 0.0
        r.orders["UP"].append(o)
    trade(r, 11, "d", "BUY", 0.52, 15)              # mirror 48 < both: through for both
    assert abs(r.held["UP"] - 15) < EPS and abs(r.cost["UP"] - (0.10 * 50 + 0.05 * 51)) < 1e-6
    r = Round(R, a)
    for c, ahead in ((50, 2.0), (50, 0.0)):
        o = Order(c, 10.0, R)
        o.ahead = ahead
        r.orders["UP"].append(o)
    trade(r, 11, "u", "SELL", 0.50, 5)              # old: 2 ahead then 3 filled; new sees 5-3=2
    assert abs(r.held["UP"] - 5) < EPS and abs(r.orders["UP"][1].rem - 8) < EPS
    trade(r, 11.1, "u", "SELL", 0.50, 30)           # old takes its last 7, new the 8 it lacks
    assert abs(r.held["UP"] - 20) < EPS
    # partial fill then reprice: the rest is cancelled, the new order is a full SIZE
    r = Round(R, a)
    book(r, 10, 0.50, 0.48, [[0.50, 0]], [[0.48, 0]])
    trade(r, 10.5, "u", "SELL", 0.50, 4)
    book(r, 11, 0.52, 0.46, [[0.52, 0]], [[0.46, 0]])
    trade(r, 11.5, "u", "SELL", 0.40, 100)
    assert abs(r.held["UP"] - 14) < EPS and abs(r.cost["UP"] - (0.04 * 50 + 0.10 * 52)) < 1e-6
    # the quote is the ladder top, not the ub field; no ladder = no decision, old order stays, ahead 0
    r = Round(R, a)
    book(r, 10, 0.51, 0.48, [[0.50, 30]], [[0.48, 0]])
    assert r.orders["UP"][-1].c == 50
    trade(r, 10.4, "u", "SELL", 0.50, 1)            # ahead 30 -> 29
    r.feed({"t": R + 10.5, "k": "o", "dbl": [[0.48, 0]]})   # UP book empty
    assert len(r.orders["UP"]) == 1 and r.orders["UP"][0].ahead == 0
    trade(r, 10.6, "u", "SELL", 0.50, 3)
    assert abs(r.held["UP"] - 3) < EPS
    # sub-cent ticks near the edges round to 0 / 100: not a price the venue takes, no decision
    r = Round(R, a)
    book(r, 10, 0.50, 0.004, [[0.50, 1]], [[0.004, 1]])
    assert not r.orders["DOWN"] and r.orders["UP"][-1].c == 50
    book(r, 11, 0.996, 0.004, [[0.996, 1]], [[0.004, 1]])
    assert len(r.orders["UP"]) == 1 and not r.orders["UP"][0].cancelled
    # ub+db > 99 on the ladder prices blocks placing even when the fields look fine
    r = Round(R, a)
    book(r, 10, 0.40, 0.40, [[0.50, 1]], [[0.50, 1]])
    assert not r.orders["UP"] and not r.orders["DOWN"]
    r = Round(R, a)
    book(r, 10, 0.50, 0.48, [[0.50, 0]], [[0.48, 0]])
    book(r, 11, 0.51, 0.48, [[0.51, 50]], [[0.48, 0]])
    trade(r, 11.5, "u", "SELL", 0.51, 45)           # new order: ahead 50 -> 5, no fill
    assert r.held["UP"] == 0

    # inventory: UP 30 ahead of DOWN stops UP quoting
    r = Round(R, a)
    for i in range(3):
        book(r, 10 + i, 0.50, 0.40, [[0.50, 0]], [[0.40, 1000]])
        trade(r, 10.5 + i, "u", "SELL", 0.49, 10)
    assert abs(r.held["UP"] - 30) < EPS
    book(r, 13, 0.50, 0.40, [[0.50, 0]], [[0.40, 1000]])
    assert not any(not o.cancelled for o in r.orders["UP"])
    trade(r, 13.5, "u", "SELL", 0.49, 10)
    assert abs(r.held["UP"] - 30) < EPS
    # winner and pnl: UP wins -> 30 - 15
    book(r, 250, 0.95, 0.04, [[0.95, 1]], [[0.04, 1]], ua=0.96, da=0.05)
    assert r.result()[5] == "UP" and abs(r.result()[6] - 15) < EPS
    # inventory is checked at book frames only: a fill on a trade does not cancel until the next frame
    r = Round(R, a)
    r.held["UP"] = 25.0
    book(r, 10, 0.50, 0.40, [[0.50, 0]], [[0.40, 1000]])
    trade(r, 10.5, "u", "SELL", 0.49, 5)
    assert abs(r.held["UP"] - 30) < EPS and not r.orders["UP"][-1].cancelled
    book(r, 10.6, 0.50, 0.40, [[0.50, 0]], [[0.40, 1000]])
    assert r.orders["UP"][-1].cancelled
    # 240 s: the first event at rel >= 240 (a trade here) cancels all at +0.3
    r = Round(R, a)
    book(r, 239.5, 0.50, 0.48, [[0.50, 0]], [[0.48, 0]])
    trade(r, 240.1, "u", "SELL", 0.30, 0.01)      # stop event; still fills, dies at 240.4
    trade(r, 240.3, "u", "SELL", 0.40, 1)           # inside the 0.3 s: still fills
    assert abs(r.held["UP"] - 1.01) < EPS
    trade(r, 240.4, "u", "SELL", 0.40, 1)
    book(r, 241, 0.50, 0.48, [[0.50, 0]], [[0.48, 0]])
    trade(r, 242, "u", "SELL", 0.40, 1)
    assert abs(r.held["UP"] - 1.01) < EPS and not any(not o.cancelled for o in r.orders["UP"])
    # offset: quote 2 cents under the best bid
    r = Round(R, argparse.Namespace(**{**vars(a), "offset": 2}))
    book(r, 10, 0.50, 0.48, [[0.50, 0]], [[0.48, 0]])
    assert r.orders["UP"][-1].c == 48 and r.orders["DOWN"][-1].c == 46
    # pair cap 97: with nothing held the cap uses the other bid (50+48 -> UP 49, DOWN 47);
    # after DOWN fills at 47 the UP quote is capped at 97-47 = 50 -> the bid 50 stands
    r = Round(R, argparse.Namespace(**{**vars(a), "pair_cap": 97.0}))
    book(r, 10, 0.50, 0.48, [[0.50, 0]], [[0.48, 0]])
    assert r.orders["UP"][-1].c == 49 and r.orders["DOWN"][-1].c == 47
    trade(r, 10.5, "d", "SELL", 0.46, 10)
    assert abs(r.held["DOWN"] - 10) < EPS
    book(r, 11, 0.50, 0.48, [[0.50, 0]], [[0.48, 0]])
    assert r.orders["UP"][-1].c == 50
    # rebate 0.20: 10 shares filled at 0.50 earn 10 x 0.2 x 0.07 x 0.25 = 0.035
    r = Round(R, argparse.Namespace(**{**vars(a), "rebate": 0.2}))
    book(r, 10, 0.50, 0.48, [[0.50, 0]], [[0.48, 0]])
    trade(r, 10.5, "u", "SELL", 0.49, 10)
    assert abs(r.held["UP"] - 10) < EPS and abs(r.rebate - 0.035) < 1e-12
    # rounds outside the Beijing day are dropped
    d = date(2026, 10, 5)
    lo = int(datetime(d.year, d.month, d.day, tzinfo=BEIJING).timestamp())
    assert lo == 1791129600
    print("selftest ok")


def main() -> None:
    p = argparse.ArgumentParser(description="Maker backtest, btc 5m.")
    p.add_argument("--history", type=Path, default=HISTORY / "btc")
    p.add_argument("--from", dest="first", default="2026-10-05")
    p.add_argument("--to", dest="last", default="2026-10-06")
    p.add_argument("--size", type=float, default=10.0)
    p.add_argument("--begin", type=float, default=10.0)
    p.add_argument("--end", type=float, default=240.0)
    p.add_argument("--latency", type=float, default=0.3)
    p.add_argument("--max-sum", dest="max_sum", type=int, default=99)
    p.add_argument("--inventory", type=float, default=30.0)
    p.add_argument("--offset", type=int, default=0, help="quote this many cents below the best bid")
    p.add_argument("--pair-cap", dest="pair_cap", type=float, default=None,
                   help="cents; quote <= cap - other side's average cost (its bid if none held)")
    p.add_argument("--rebate", type=float, default=0.0,
                   help="maker rebate as a share of the fee curve 0.07 p (1-p); crypto pays 0.20")
    p.add_argument("--procs", type=int, default=4)
    p.add_argument("--out", type=Path)
    p.add_argument("--selftest", action="store_true")
    args = p.parse_args()
    if args.selftest:
        selftest()
        return
    first, last = date.fromisoformat(args.first), date.fromisoformat(args.last)
    days = [(first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)]
    with Pool(max(1, min(args.procs, 4, len(days)))) as pool:
        by_day = dict(pool.imap_unordered(_work, [(args.history, d, args) for d in days]))
    if args.out:
        with args.out.open("w") as f:
            f.write("day,rid,up_shares,up_avg,down_shares,down_avg,winner,pnl\n")
            for d in days:
                for r in by_day[d]:
                    pnl = "" if r[6] is None else f"{r[6]:.6f}"
                    f.write(f"{d},{r[0]},{r[1]:.6f},{r[2]:.4f},{r[3]:.6f},{r[4]:.4f},{r[5] or ''},{pnl}\n")
    every = [r for d in days for r in by_day[d]]
    for d in days:
        print(_stat(d, by_day[d]))
    print(_stat("合计", every))
    print(_stat("合计 R>=单边起", [r for r in every if r[0] >= ONE_SIDED_FROM]))


if __name__ == "__main__":
    main()

"""Backtest the reversal ladder on the market recordings. Read-only; run it
locally on the E: copy, never on the server:

    python scripts/backtest.py --history E:/pm-backup/market-history --coins btc --from 2026-10-17

Crossings, like live (STRATEGY.md 2-5, REVERSAL.md):
- each side's ask, only rows inside the round (R <= t < R+300);
- a frame is usable only if both asks are present and each side's exchange
  time is at most 2 s old and the two at most 1.5 s apart; an unusable or
  one-sided frame, more than 2 s without a usable one, or an exchange time
  going back drops the starting point; the next usable frame only restarts;
- a frame whose asks sum above 1.05 is skipped and keeps the starting point;
- a side crosses when its previous ask < 0.67 and this one >= 0.67; after a
  firing only the other side counts.
Orders (STRATEGY.md 4-6), each a 0.70 limit:
- at the cross it takes the recorded asks <= 0.70 (taker, each at its own
  price, fee 0.07 p (1-p)); the rest rests and fills at 0.70 (maker) from the
  largest quantity <= 0.70 seen in any one later frame of the round;
- rung 1 not yet filled when the other side crosses is cancelled and placed
  there, still as rung 1; nothing after the last rung.
Winner: the last book frame with an ask or bid >= 0.9 (wrong on 12 of 17,280
rounds checked against the official result, mostly books emptied at the close).
Limits: only five levels are recorded (deeper asks are missed: under-fills)
and no queue ahead of us is modelled (over-fills).
"""
from __future__ import annotations

import argparse
import json
import math
import zlib
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from multiprocessing import Pool
from pathlib import Path

LINE = 0.67
WIDE_SUM = 1.05
MAX_AGE_SEC = 2.0       # live maxQuoteAgeSeconds
MAX_SKEW_SEC = 1.5      # live maxQuoteSkewSeconds
ROUND_SEC = 300
START_GRACE_SEC = 10
MIN_END_SEC = 240
WIN_PRICE = 0.9
LIMIT = 0.70
TAKER_FEE = 0.07
EPS = 1e-9
# One-sided books near the close are recorded from the round 1791179100 on (the
# first k:"o" row of every coin, 2026-10-05 05:49:53 UTC); earlier rounds lack
# about their last 50 seconds and are not used.
ONE_SIDED_FROM = 1791179100
HISTORY = Path("/root/pm-system/data/market-history")
COINS = ("btc", "eth", "sol", "xrp", "doge", "hype", "bnb")
BEIJING = timezone(timedelta(hours=8))


def _under(levels) -> list[tuple[float, float]]:
    return [(p, q) for p, q in (levels or []) if p <= LIMIT + EPS]


class Order:
    """One 0.70 limit, filled by depth and by the trade tape."""
    __slots__ = ("side", "shares", "at", "live", "taken", "cost", "rest", "traded")

    def __init__(self, side: str, shares: int, levels, at: float):
        self.side, self.shares, self.at, self.live = side, shares, at, True
        self.taken = self.cost = self.rest = self.traded = 0.0
        for price, qty in _under(levels):
            take = min(shares - self.taken, qty)
            if take <= EPS:
                break
            self.taken += take
            self.cost += take * (price + TAKER_FEE * price * (1 - price))

    def frame(self, levels) -> None:
        self.rest = max(self.rest, sum(q for _, q in _under(levels)))

    def trade(self, row: dict) -> None:
        """A trade that would have matched this resting buy: a taker SELL of this
        token at <= LIMIT, or a taker BUY of the other token at >= 1 - LIMIT (the
        venue mints a pair against it). Each trade is its own match, so they add
        up, unlike a book level that shows the same resting quantity frame after
        frame (2026-10-15 audit: the five levels missed jumps through the limit)."""
        price, size = row.get("p"), row.get("s")
        if not isinstance(price, (int, float)) or not isinstance(size, (int, float)):
            return
        mine = row.get("tok") == ("u" if self.side == "UP" else "d")
        if (mine and row.get("side") == "SELL" and price <= LIMIT + EPS) or \
                (not mine and row.get("side") == "BUY" and price >= 1 - LIMIT - EPS):
            self.traded += size

    def filled(self) -> tuple[float, float]:
        if not self.live:
            return self.taken, self.cost
        more = min(self.shares - self.taken, max(self.rest, self.traded))
        return self.taken + more, self.cost + more * LIMIT


class Round:
    """Counter and ladder of one round, fed one row at a time (a day of one
    coin is ~860k rows: never hold them)."""

    def __init__(self, start: int, ladder: tuple[int, ...], from_trigger: int = 1):
        self.start, self.ladder, self.from_trigger = start, ladder, from_trigger
        self.prev: tuple[float, float, float, float] | None = None   # up ask, down ask, up time, down time
        self.floor: tuple[float, float] | None = None                # times of a dropped starting point
        self.last_fresh: float | None = None
        self.sides: list[str] = []
        self.seconds: list[float] = []
        self.orders: list[Order] = []
        self.winner: str | None = None
        self.first_clean = self.last_t = None

    def feed(self, row: dict) -> None:
        t, start, kind = row.get("t"), self.start, row.get("k")
        if not isinstance(t, (int, float)) or not (start <= t < start + ROUND_SEC):
            return
        if kind == "t":
            for order in self.orders:
                if order.live and t > order.at:
                    order.trade(row)
            return
        if kind not in (None, "o"):
            return      # coin and settlement prices: no book
        self.last_t = t
        ua, da, ub, db = row.get("ua"), row.get("da"), row.get("ub"), row.get("db")
        if (ua or 0) >= WIN_PRICE or (ub or 0) >= WIN_PRICE:
            self.winner = "UP"
        elif (da or 0) >= WIN_PRICE or (db or 0) >= WIN_PRICE:
            self.winner = "DOWN"
        elif ua is not None and da is not None:
            self.winner = None
        for order in self.orders:
            if order.live and t > order.at:
                order.frame(row.get("ual") if order.side == "UP" else row.get("dal"))
        ue, de = row.get("ue"), row.get("de")
        usable = (kind != "o" and ua is not None and da is not None and 0 < ua < 1 and 0 < da < 1
                  and isinstance(ue, (int, float)) and isinstance(de, (int, float))
                  and t - min(ue, de) <= MAX_AGE_SEC and abs(ue - de) <= MAX_SKEW_SEC)
        if not usable:
            self._drop()
            return
        if self.last_fresh is not None and t - self.last_fresh > MAX_AGE_SEC:
            self._drop()                      # live: the feed reports a stale book in between
        self.last_fresh = min(t, ue, de)
        if ua + da > WIDE_SUM:
            return                            # skipped, the starting point stays
        if self.first_clean is None:
            self.first_clean = t
        if self.floor is not None and not (ue > self.floor[0] and de > self.floor[1]):
            return
        if self.prev is None:
            self.prev, self.floor = (ua, da, ue, de), None
            return
        if ue < self.prev[2] or de < self.prev[3]:
            self._drop()
            return
        if ue - self.prev[2] > MAX_AGE_SEC or de - self.prev[3] > MAX_AGE_SEC:
            self.prev = (ua, da, ue, de)      # a side jumped more than 2 s: a new starting point only
            return
        for side, before, now in (("UP", self.prev[0], ua), ("DOWN", self.prev[1], da)):
            if before < LINE <= now and (not self.sides or self.sides[-1] != side):
                self.sides.append(side)
                self.seconds.append(round(t - start, 1))
                if len(self.sides) >= self.from_trigger:
                    self._place(side, row, t)  # crossings before the K-th: counted, not traded
                break                         # live takes one direction per frame
        self.prev = (ua, da, ue, de)

    def _place(self, side: str, row: dict, t: float) -> None:
        live = [order for order in self.orders if order.live]
        if not any(order.taken > EPS or order.rest > EPS for order in live):
            for order in live:
                order.live = False            # rung 1 not filled: cancel, place rung 1 here
            shares = self.ladder[0]
        elif len(live) < len(self.ladder):
            shares = self.ladder[len(live)]
        else:
            return
        self.orders.append(Order(side, shares, row.get("ual") if side == "UP" else row.get("dal"), t))

    def _drop(self) -> None:
        if self.prev is not None:
            self.floor = (self.prev[2], self.prev[3])
        self.prev = None

    def complete(self) -> bool:
        return (self.start >= ONE_SIDED_FROM and self.first_clean is not None
                and self.first_clean - self.start <= START_GRACE_SEC
                and self.last_t is not None and self.last_t - self.start >= MIN_END_SEC)

    def pnl(self) -> float | None:
        if self.winner is None:
            return None
        held, cost = {"UP": 0.0, "DOWN": 0.0}, 0.0
        for order in self.orders:
            shares, spent = order.filled()
            held[order.side] += shares
            cost += spent
        return held[self.winner] - cost


GZIP_HEADER = b"\x1f\x8b\x08\x00\x00\x00\x00\x00"  # what the collector's zlib writes


def read_lines(path: Path):
    """Complete lines of a multi-member gzip day file, streamed. A member a
    collector restart left unfinished (2026-10-07) is read up to its last whole
    line; reading resumes at the next member header instead of stopping."""
    try:
        data = path.read_bytes()      # compressed: tens of MB a day; the text is ~10x
    except OSError:
        return
    pos, pending, inflate = 0, b"", zlib.decompressobj(31)
    while pos < len(data):
        piece = data[pos:pos + 65536]
        try:
            out = inflate.decompress(piece)
        except zlib.error:
            at = data.find(GZIP_HEADER, pos + 1)
            if at < 0:
                return
            pos, pending, inflate = at, b"", zlib.decompressobj(31)
            continue
        if out:
            *lines, pending = (pending + out).split(b"\n")
            for line in lines:
                yield line.decode("utf-8", "replace")
        if inflate.eof:
            pos += len(piece) - len(inflate.unused_data)
            pending, inflate = b"", zlib.decompressobj(31)
        else:
            pos += len(piece)


def day_rounds(path: Path, ladder: tuple[int, ...], from_trigger: int = 1) -> list[Round]:
    rounds: dict[str, Round] = {}
    for line in read_lines(path):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        round_id = row.get("r")
        if not (isinstance(round_id, str) and round_id.isdigit()):
            continue
        counter = rounds.get(round_id)
        if counter is None:
            counter = rounds[round_id] = Round(int(round_id), ladder, from_trigger)
        counter.feed(row)
    return sorted(rounds.values(), key=lambda item: item.start)


def _work(job: tuple[Path, str, str, tuple[int, ...], int]) -> list[tuple]:
    history, coin, day, ladder, from_trigger = job
    out = []
    for item in day_rounds(history / coin / f"{day}.jsonl.gz", ladder, from_trigger):
        pnl = item.pnl()
        if item.complete() and pnl is not None and len(item.sides) >= from_trigger:
            out.append((coin, day, item.seconds[0], len(item.sides), item.sides[0] == item.winner, pnl))
    return out


def _stat(values: list[float]) -> str:
    n = len(values)
    if not n:
        return "    0"
    mean = sum(values) / n
    sd = math.sqrt(sum((v - mean) ** 2 for v in values) / (n - 1)) if n > 1 else 0.0
    t = mean / (sd / math.sqrt(n)) if sd else float("nan")
    return f"{n:>5} 合计 {sum(values):+8.1f} 每场 {mean:+.3f} t {t:+.2f}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Backtest the reversal ladder on the recordings.")
    parser.add_argument("--history", type=Path, default=HISTORY)
    parser.add_argument("--coins", default=",".join(COINS))
    parser.add_argument("--from", dest="first", help="first Beijing day (YYYY-MM-DD); default 2026-10-05")
    parser.add_argument("--to", dest="last", help="last Beijing day; default yesterday")
    parser.add_argument("--ladder", default="5,13,60")
    parser.add_argument("--first-after", type=float, default=0.0,
                        help="trade only rounds whose first trigger is at or after this second")
    parser.add_argument("--from-trigger", type=int, default=1,
                        help="count the first K-1 triggers without trading; rung 1 at the K-th")
    parser.add_argument("--jobs", type=int, default=3)
    args = parser.parse_args()
    ladder = tuple(int(x) for x in args.ladder.split(","))
    first = date.fromisoformat(args.first or "2026-10-05")
    last = date.fromisoformat(args.last) if args.last else datetime.now(BEIJING).date() - timedelta(days=1)
    days = [(first + timedelta(days=i)).isoformat() for i in range((last - first).days + 1)]
    coins = args.coins.split(",")
    with Pool(args.jobs) as pool:
        jobs = [(args.history, c, d, ladder, args.from_trigger) for c in coins for d in days]
        rows = [row for chunk in pool.imap_unordered(_work, jobs)
                for row in chunk]
    rows = [row for row in rows if row[2] >= args.first_after]
    print(f"阶梯 {'/'.join(map(str, ladder))}，第一次触发 >= {args.first_after:g} 秒，"
          f"从第 {args.from_trigger} 次触发开始，{days[0]} ~ {days[-1]}")
    for coin in coins:
        mine = [row for row in rows if row[0] == coin]
        win = sum(row[4] for row in mine) / len(mine) if mine else float("nan")
        print(f"== {coin}  胜率 {win:.1%}  {_stat([row[5] for row in mine])}")
        for day in days:
            print(f"   {day} {_stat([row[5] for row in mine if row[1] == day])}")
        by = defaultdict(list)
        for row in mine:
            by[min(row[3], 5)].append(row[5])
        for count in sorted(by):
            print(f"   触发 {count}{'+' if count == 5 else ' '}次 {_stat(by[count])}")


if __name__ == "__main__":
    main()

"""反转统计: count how often the reversal trigger fires per round, from the
market recordings (data/market-history/<asset>/<UTC+8 date>.jsonl.gz).

Definition (REVERSAL.md, confirmed with the operator 2026-10-05):
- price is each side's ask; only rows inside the round (R <= t < R+300);
- a clean frame has both asks and ask sum <= 1.05; only clean frames cross;
- freshness like live (operator 2026-10-11): a frame is usable only if each
  side's exchange time is at most 2 s old when received and the two are at
  most 1.5 s apart; an unusable or one-sided frame, more than 2 s without a
  usable one, or an exchange time going back, drops the starting point, and
  the next usable clean frame is a new starting point only (a wide frame is
  skipped and keeps it);
- the first clean frame of a round is the baseline only;
- a side crosses when its previous clean ask < 0.67 and this one >= 0.67;
- firing 1 is the first cross; afterwards only the side opposite the last
  firing counts (the same side again does not);
- one-sided rows (k "o", near the close) never cross but give the winner;
  trade rows (k "t") are ignored.
A round counts only if a clean frame arrives within 10 s of the open and the
recording reaches +240 s. Nothing here trades; it only reads recordings.
"""
from __future__ import annotations

import json
import time
import zlib
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path

LINE = 0.67
WIDE_SUM = 1.05
# Live freshness (btc-reversal maxQuoteAgeSeconds / maxQuoteSkewSeconds, feed
# PM_WS_SOURCE_FRESH_MAX_MS): what the engine trusts, so what can be traded.
MAX_AGE_SEC = 2.0
MAX_SKEW_SEC = 1.5
ROUND_SEC = 300
START_GRACE_SEC = 10
MIN_END_SEC = 240
WIN_PRICE = 0.9
# One-sided books near the close were recorded from here on (2026-10-05 05:50
# UTC); earlier rounds lack the book for roughly their last 50 seconds.
ONE_SIDED_FROM = 1791143400
LIVE_RECOMPUTE_SEC = 60
BEIJING = timezone(timedelta(hours=8))
CACHE_VERSION = 4
# STRATEGY.md section 6: the ladder under test and its limit price.
LADDER = (5, 13, 60)
LIMIT = 0.70
TAKER_FEE = 0.07


class _Round:
    """Counter state of one round, fed one row at a time (rows are never kept:
    a day of one coin is ~860k rows and holding them got the control plane
    OOM-killed)."""
    __slots__ = ("start", "prev", "floor", "last_fresh", "sides", "seconds", "asks", "fills", "winner",
                 "first_clean", "last_t", "trades", "flow5")

    def __init__(self, start: int):
        self.start = start
        # Starting point: (up ask, down ask, up exchange time, down exchange time).
        self.prev: tuple[float, float, float, float] | None = None
        # Exchange times of a dropped starting point: the next one must be newer
        # on both sides (live referenceFloor).
        self.floor: tuple[float, float] | None = None
        self.last_fresh: float | None = None
        self.sides: list[str] = []
        self.seconds: list[float] = []
        self.asks: list[float] = []
        # Second at which a 0.70 limit placed at each firing would fill: the
        # first row, from the firing on, where that side's ask is <= 0.70
        # (live: the order rests until a seller comes down to it). None: never.
        self.fills: list[float | None] = []
        self.winner = None
        self.first_clean = self.last_t = None
        # Trades until the first trigger: (t, token, taker side, size).
        self.trades: deque[tuple[float, str, str, float]] = deque()
        self.flow5: float | None = None

    def feed(self, row: dict) -> None:
        t, start = row.get("t"), self.start
        if not isinstance(t, (int, float)) or not (start <= t < start + ROUND_SEC):
            return
        if row.get("k") == "t":
            if not self.sides:
                self.trades.append((t, row.get("tok"), row.get("side"), float(row.get("s") or 0)))
                while self.trades[0][0] < t - FLOW_WINDOW_SEC - 1:     # only the last window is ever read
                    self.trades.popleft()
            return
        if row.get("k") in ("p", "c"):
            return      # coin and settlement prices: no book (they kept a cut-off book looking complete)
        self.last_t = t
        ua, da, ub, db = row.get("ua"), row.get("da"), row.get("ub"), row.get("db")
        if (ua or 0) >= WIN_PRICE or (ub or 0) >= WIN_PRICE:
            self.winner = "UP"
        elif (da or 0) >= WIN_PRICE or (db or 0) >= WIN_PRICE:
            self.winner = "DOWN"
        elif ua is not None and da is not None:
            self.winner = None
        for index, fill in enumerate(self.fills):
            if fill is None:
                ask = ua if self.sides[index] == "UP" else da
                if ask is not None and ask <= LIMIT + 1e-9:
                    self.fills[index] = round(t - start, 1)
        ue, de = row.get("ue"), row.get("de")
        usable = (row.get("k") != "o" and ua is not None and da is not None and 0 < ua < 1 and 0 < da < 1
                  and isinstance(ue, (int, float)) and isinstance(de, (int, float))
                  and t - min(ue, de) <= MAX_AGE_SEC and abs(ue - de) <= MAX_SKEW_SEC)
        if not usable:
            self._drop()
            return
        if self.last_fresh is not None and t - self.last_fresh > MAX_AGE_SEC:
            self._drop()                      # live: the feed reports a stale book in between
        self.last_fresh = min(t, ue, de)
        if ua + da > WIDE_SUM:
            return                            # rule 2: skipped, the starting point stays
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
                if not self.sides:
                    self.flow5 = self._flow_share(side, t)
                    self.trades.clear()
                self.sides.append(side)
                self.seconds.append(round(t - start, 1))
                self.asks.append(now)
                self.fills.append(round(t - start, 1) if now <= LIMIT + 1e-9 else None)
                break                         # live takes one direction per frame
        self.prev = (ua, da, ue, de)

    def _drop(self) -> None:
        if self.prev is not None:
            self.floor = (self.prev[2], self.prev[3])
        self.prev = None

    def _flow_share(self, side: str, at: float) -> float | None:
        """Share of the traded volume in the window before `at` that pushed
        `side` up (taker BUY of its token or taker SELL of the other one)."""
        mine = "u" if side == "UP" else "d"
        push = total = 0.0
        for t, token, taker, size in self.trades:
            if not (at - FLOW_WINDOW_SEC <= t < at):
                continue
            total += size
            if (token == mine) == (taker == "BUY"):
                push += size
        return round(push / total, 4) if total > 0 else None

    def result(self) -> dict:
        start, sides = self.start, self.sides
        # Before one-sided rows were recorded the book simply stops when the
        # winner has no asks (median ~242 s): such a round still counts, flagged.
        ends_early = self.last_t is None or self.last_t - start < MIN_END_SEC
        incomplete = (self.first_clean is None or self.first_clean - start > START_GRACE_SEC
                      or (ends_early and start >= ONE_SIDED_FROM))
        return {"roundId": str(start), "startsAt": start, "firings": len(sides), "reversals": max(0, len(sides) - 1),
                "sides": sides, "seconds": self.seconds, "asks": self.asks, "fills": self.fills, "flow5": self.flow5, "winner": self.winner,
                "firstFiringSide": sides[0] if sides else None,
                "firstFiringWon": (sides[0] == self.winner) if sides and self.winner else None,
                "incomplete": incomplete, "partialLastMinute": start < ONE_SIDED_FROM}


def count_round(rows: list[dict], start: int) -> dict:
    """Firings of one round from its rows in time order."""
    counter = _Round(start)
    for row in rows:
        counter.feed(row)
    return counter.result()


GZIP_HEADER = b"\x1f\x8b\x08\x00\x00\x00\x00\x00"  # what the collector's zlib writes


def read_lines(path: Path):
    """Complete lines of a multi-member gzip day file, streamed. A member a
    collector restart left unfinished (2026-10-07: one in the middle of every
    day file) is read up to its last whole line; reading resumes at the next
    member header instead of stopping, so the rest of the day is kept."""
    try:
        data = path.read_bytes()  # compressed: a few MB a day; the text is ~10x
    except OSError:
        return
    pos, pending, inflate = 0, b"", zlib.decompressobj(31)
    while pos < len(data):
        piece = data[pos:pos + 65536]
        try:
            out = inflate.decompress(piece)
        except zlib.error:
            # Broken member: drop its partial line, resume at the next header.
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


def _count_file(path: Path) -> list[dict]:
    """Count every round of a day file in one pass. Rows of one round arrive
    in time order (one collector writes them)."""
    rounds: dict[str, _Round] = {}
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
            counter = rounds[round_id] = _Round(int(round_id))
        counter.feed(row)
    return sorted((counter.result() for counter in rounds.values()), key=lambda item: item["startsAt"])


def day_rounds(history: Path, cache: Path, asset: str, day: str, *, now: float | None = None,
               cached_only: bool = False) -> list[dict]:
    """Counted rounds of one recording day, cached by file size and mtime. A
    file still being written is recomputed at most every LIVE_RECOMPUTE_SEC.
    cached_only: answer from the cache even if stale and never parse (an HTTP
    request must not spend a minute on a day file; the warmer does that)."""
    source = history / asset / f"{day}.jsonl.gz"
    try:
        stat = source.stat()
    except OSError:
        return []
    stamp = [stat.st_size, stat.st_mtime_ns]
    target = cache / asset / f"{day}.json"
    now = time.time() if now is None else now
    try:
        cached = json.loads(target.read_text(encoding="utf-8"))
        fresh = cached.get("stamp") == stamp or now - cached.get("computedAt", 0) < LIVE_RECOMPUTE_SEC
        if cached.get("version") == CACHE_VERSION and (fresh or cached_only):
            return cached["rounds"]
    except (OSError, ValueError, KeyError, AttributeError):
        pass
    if cached_only:
        return []
    counted = _count_file(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": CACHE_VERSION, "stamp": stamp, "computedAt": now,
                                     "rounds": counted}), encoding="utf-8")
    temporary.replace(target)
    return counted


# STRATEGY.md section 6 (2026-10-07): up to 3 rungs at a 0.70 limit, placed
# like live (see ladder_pnl). No queue or competition, so live will be
# somewhat worse.
# Under test (operator 2026-10-07): trade only rounds whose first trigger comes
# at or after this second; an earlier first trigger means the round is skipped.
# Each coin has its own second (operator 2026-10-10), picked on 10-05/06 and
# checked on 10-07..09.
LATE_FROM_SEC = {"btc": 10, "eth": 60, "sol": 30, "xrp": 120, "doge": 45, "hype": 120, "bnb": 120}
# Under test (operator 2026-10-08): among those, only rounds where most of the
# trades in the 5 s before the first trigger pushed the triggered side up.
FLOW_WINDOW_SEC = 5.0
FLOW_SHARE = 0.55


def ladder_pnl(item: dict, ladder=LADDER, *, fee: bool = True) -> float | None:
    """Settled result of one round under the ladder, placed like live; None if
    the winner is unknown. Every firing places a 0.70 limit: filled at the
    cross (at the ask, taker fee) when the ask is <= 0.70, else it rests and
    fills at 0.70 (maker, no fee) when that side's ask first comes back down;
    never if it does not. STRATEGY.md 4: while rung 1 has not filled, a cross
    of the other side cancels it and places rung 1 there. A hedge counts as a
    rung once placed; nothing is placed after the last rung."""
    winner = item.get("winner")
    if winner not in ("UP", "DOWN"):
        return None
    sides, asks, seconds = item.get("sides") or [], item.get("asks") or [], item.get("seconds") or []
    fills = item.get("fills")
    if fills is None:       # rows counted before resting fills were tracked
        fills = [second if ask <= LIMIT + 1e-9 else None for second, ask in zip(seconds or [0.0] * len(asks), asks)]
    orders: list[tuple[str, int, float | None, float, bool]] = []      # side, shares, fill second, ask, at the cross
    for index, side in enumerate(sides):
        at = seconds[index] if index < len(seconds) else 0.0
        fill, ask = fills[index] if index < len(fills) else None, asks[index]
        order = (side, 0, fill, ask, fill is not None and fill <= at + 1e-9 and ask <= LIMIT + 1e-9)
        if not any(o[2] is not None and o[2] <= at + 1e-9 for o in orders):
            orders = [(side, ladder[0], *order[2:])]          # no position yet: (re)place rung 1 here
        elif len(orders) < len(ladder):
            orders.append((side, ladder[len(orders)], *order[2:]))
        else:
            break
    held = {"UP": 0.0, "DOWN": 0.0}
    cost = 0.0
    for side, shares, fill, ask, at_cross in orders:
        if fill is None:
            continue
        price = ask if (fee and at_cross) else LIMIT
        held[side] += shares
        cost += shares * (price + (TAKER_FEE * price * (1 - price) if fee and at_cross else 0.0))
    return round(held[winner] - cost, 4)


def _stats(rounds: list[dict], asset: str) -> dict:
    complete = [item for item in rounds if not item["incomplete"]]
    late = LATE_FROM_SEC[asset]
    firings = sorted(item["firings"] for item in complete)
    top = max(firings, default=0)
    distribution = {str(value): 0 for value in range(top + 1)}
    for value in firings:
        distribution[str(value)] += 1
    peak = max(complete, key=lambda item: item["firings"], default=None)
    judged = [item for item in complete if item["firstFiringWon"] is not None]
    count = len(firings)
    over4 = sum(1 for value in firings if value > 4)
    return {"rounds": count, "incomplete": len(rounds) - count,
            "firingsTotal": sum(firings), "reversalsTotal": sum(max(0, value - 1) for value in firings),
            "avgFirings": round(sum(firings) / count, 2) if count else None,
            "medianFirings": firings[count // 2] if count else None,
            "maxFirings": top, "maxRound": ({"roundId": peak["roundId"], "startsAt": peak["startsAt"]}
                                            if peak and peak["firings"] else None),
            "over4": over4, "over4Pct": round(100 * over4 / count, 1) if count else None,
            "firstFiringWinPct": (round(100 * sum(item["firstFiringWon"] for item in judged) / len(judged), 1)
                                  if judged else None),
            "distribution": distribution,
            "partialLastMinute": any(item["partialLastMinute"] for item in complete),
            "partialRounds": sum(1 for item in complete if item["partialLastMinute"]),
            "ladder": _ladder_stats(complete),
            "ladderLate": {**_ladder_stats([item for item in complete if item.get("seconds")
                                            and item["seconds"][0] >= late]), "fromSecond": late},
            "ladderLateFlow": {**_ladder_stats([item for item in complete if item.get("seconds")
                                                and item["seconds"][0] >= late
                                                and (item.get("flow5") or 0) > FLOW_SHARE]),
                               "fromSecond": late, "flowWindow": FLOW_WINDOW_SEC, "flowShare": FLOW_SHARE}}


def _ladder_stats(complete: list[dict]) -> dict:
    """The ladder's result per firing count, over rounds with a known winner
    and the full last minute recorded (older rounds would hide late reversals)."""
    judged = [(item, ladder_pnl(item)) for item in complete if not item["partialLastMinute"]]
    judged = [(item, value) for item, value in judged if value is not None]
    groups: dict[str, list[float]] = {}
    for item, value in judged:
        # Every count on its own (operator): after rung 3 the side of rungs 1+3
        # (65 shares) wins on an odd count and the rung-2 side on an even one.
        groups.setdefault(str(item["firings"]), []).append(value)
    values = [value for _, value in judged]
    wins = [item["sides"][0] == item["winner"] for item, _ in judged if item.get("sides")]
    return {"ladder": list(LADDER), "limit": LIMIT, "rounds": len(values),
            "firstWinPct": round(100 * sum(wins) / len(wins), 1) if wins else None,
            "total": round(sum(values), 2), "perRound": round(sum(values) / len(values), 3) if values else None,
            "worst": round(min(values), 2) if values else None,
            "byFirings": {key: {"rounds": len(group), "total": round(sum(group), 2),
                                "perRound": round(sum(group) / len(group), 3)}
                          for key, group in sorted(groups.items(), key=lambda pair: int(pair[0]))}}


def warm(history: Path, cache: Path, assets, *, days: int = 10, today: str | None = None) -> None:
    """Recount every day file whose cache is missing or stale (run in a
    low-priority child process: parsing a day takes about a minute)."""
    today = datetime.strptime(today, "%Y-%m-%d") if today else datetime.now(BEIJING)
    for offset in range(days):
        day = (today - timedelta(days=offset)).strftime("%Y-%m-%d")
        for asset in assets:
            day_rounds(history, cache, asset, day)


def summary(history: Path, cache: Path, asset: str, *, days: int, today: str | None = None,
            cached_only: bool = False) -> dict:
    """Per-day and total statistics plus the latest rounds, newest first."""
    today = today or datetime.now(BEIJING).strftime("%Y-%m-%d")
    first = datetime.strptime(today, "%Y-%m-%d")
    dates = [(first - timedelta(days=offset)).strftime("%Y-%m-%d") for offset in range(days)]
    per_day, everything = [], []
    for date in dates:
        rounds = day_rounds(history, cache, asset, date, cached_only=cached_only)
        if not rounds:
            continue
        everything.extend(rounds)
        per_day.append({"date": date, **_stats(rounds, asset)})
    latest = sorted((item for item in everything if not item["incomplete"]),
                    key=lambda item: item["startsAt"], reverse=True)[:300]
    return {"schemaVersion": 1, "assetId": asset, "asOf": time.time(), "days": per_day,
            "total": _stats(everything, asset), "rounds": latest}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Recount the reversal cache from the recordings.")
    parser.add_argument("--history", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--assets", default="btc,eth,sol,xrp,doge,hype,bnb")
    parser.add_argument("--days", type=int, default=10)
    parser.add_argument("--today", help="last day to count (YYYY-MM-DD, Beijing); default today")
    options = parser.parse_args()
    warm(options.history, options.cache, options.assets.split(","), days=options.days, today=options.today)

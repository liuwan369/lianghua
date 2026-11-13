"""Readers for the market recordings (E:/pm-backup/market-history), kept for
the research scripts that `import backtest as bt` (forward-binance-agg.py and
the research-1027.. directories): read_lines streams a day file, Round gives a
round's winner and whether its recording is complete. The reversal ladder
backtest that used to live here is retired.

Winner: the last book frame with an ask or bid >= 0.9 (wrong on 12 of 17,280
rounds checked against the official result, mostly books emptied at the close).
A round is complete when it starts at or after ONE_SIDED_FROM, has a clean
frame in its first 10 s and its recording reaches 240 s.

Round also tracks the old engine's usable-frame rule (both asks present, each
side's exchange time at most 2 s old, the two at most 1.5 s apart, asks summing
to at most 1.05), because complete() depends on the first clean frame. A
subclass may override _place(side, row, t), called where the old rule saw an
ask cross 0.67; the default does nothing.
"""
from __future__ import annotations

import zlib
from pathlib import Path  # noqa: F401  (research scripts use bt.Path)

LINE = 0.67
WIDE_SUM = 1.05
MAX_AGE_SEC = 2.0       # live maxQuoteAgeSeconds
MAX_SKEW_SEC = 1.5      # live maxQuoteSkewSeconds
ROUND_SEC = 300
START_GRACE_SEC = 10
MIN_END_SEC = 240
WIN_PRICE = 0.9
# One-sided books near the close are recorded from the round 1791179100 on (the
# first k:"o" row of every coin, 2026-10-05 05:49:53 UTC); earlier rounds lack
# about their last 50 seconds and are not used.
ONE_SIDED_FROM = 1791179100


class Round:
    """One round of one coin, fed one recorded row at a time (a day of one
    coin is ~860k rows: never hold them). The second argument is the retired
    ladder; it is accepted and ignored so Round(start, (5,)) keeps working."""

    def __init__(self, start: int, _ladder=None, _from_trigger: int = 1):
        self.start = start
        self.prev: tuple[float, float, float, float] | None = None   # up ask, down ask, up time, down time
        self.floor: tuple[float, float] | None = None                # times of a dropped starting point
        self.last_fresh: float | None = None
        self.sides: list[str] = []
        self.winner: str | None = None
        self.first_clean = self.last_t = None

    def feed(self, row: dict) -> None:
        t, start, kind = row.get("t"), self.start, row.get("k")
        if not isinstance(t, (int, float)) or not (start <= t < start + ROUND_SEC):
            return
        if kind not in (None, "o"):
            return      # trades, coin and settlement prices: no book
        self.last_t = t
        ua, da, ub, db = row.get("ua"), row.get("da"), row.get("ub"), row.get("db")
        if (ua or 0) >= WIN_PRICE or (ub or 0) >= WIN_PRICE:
            self.winner = "UP"
        elif (da or 0) >= WIN_PRICE or (db or 0) >= WIN_PRICE:
            self.winner = "DOWN"
        elif ua is not None and da is not None:
            self.winner = None
        ue, de = row.get("ue"), row.get("de")
        usable = (kind != "o" and ua is not None and da is not None and 0 < ua < 1 and 0 < da < 1
                  and isinstance(ue, (int, float)) and isinstance(de, (int, float))
                  and t - min(ue, de) <= MAX_AGE_SEC and abs(ue - de) <= MAX_SKEW_SEC)
        if not usable:
            self._drop()
            return
        if self.last_fresh is not None and t - self.last_fresh > MAX_AGE_SEC:
            self._drop()
        self.last_fresh = min(t, ue, de)
        if ua + da > WIDE_SUM:
            return
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
            self.prev = (ua, da, ue, de)
            return
        for side, before, now in (("UP", self.prev[0], ua), ("DOWN", self.prev[1], da)):
            if before < LINE <= now and (not self.sides or self.sides[-1] != side):
                self.sides.append(side)
                self._place(side, row, t)
                break
        self.prev = (ua, da, ue, de)

    def _place(self, side: str, row: dict, t: float) -> None:
        """Hook for subclasses; the retired ladder placed its orders here."""

    def _drop(self) -> None:
        if self.prev is not None:
            self.floor = (self.prev[2], self.prev[3])
        self.prev = None

    def complete(self) -> bool:
        return (self.start >= ONE_SIDED_FROM and self.first_clean is not None
                and self.first_clean - self.start <= START_GRACE_SEC
                and self.last_t is not None and self.last_t - self.start >= MIN_END_SEC)


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

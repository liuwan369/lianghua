"""反转统计: count how often the reversal trigger fires per round, from the
market recordings (data/market-history/<asset>/<UTC+8 date>.jsonl.gz).

Definition (REVERSAL.md, confirmed with the operator 2026-10-05):
- price is each side's ask; only rows inside the round (R <= t < R+300);
- a clean frame has both asks and ask sum <= 1.05; only clean frames cross;
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

import gzip
import json
import time
import zlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

LINE = 0.67
WIDE_SUM = 1.05
ROUND_SEC = 300
START_GRACE_SEC = 10
MIN_END_SEC = 240
WIN_PRICE = 0.9
# One-sided books near the close were recorded from here on (2026-10-05 05:50
# UTC); earlier rounds lack the book for roughly their last 50 seconds.
ONE_SIDED_FROM = 1791143400
LIVE_RECOMPUTE_SEC = 60
BEIJING = timezone(timedelta(hours=8))
CACHE_VERSION = 1


def count_round(rows: list[dict], start: int) -> dict:
    """Firings of one round from its rows in time order."""
    prev: tuple[float, float] | None = None
    sides: list[str] = []
    seconds: list[float] = []
    asks: list[float] = []
    winner = None
    first_clean = last_t = None
    for row in rows:
        t = row.get("t")
        if not isinstance(t, (int, float)) or not (start <= t < start + ROUND_SEC) or row.get("k") == "t":
            continue
        last_t = t
        ua, da, ub, db = row.get("ua"), row.get("da"), row.get("ub"), row.get("db")
        if (ua or 0) >= WIN_PRICE or (ub or 0) >= WIN_PRICE:
            winner = "UP"
        elif (da or 0) >= WIN_PRICE or (db or 0) >= WIN_PRICE:
            winner = "DOWN"
        elif ua is not None and da is not None:
            winner = None
        if row.get("k") == "o" or ua is None or da is None or ua + da > WIDE_SUM:
            continue
        if first_clean is None:
            first_clean = t
        if prev is not None:
            for side, before, now in (("UP", prev[0], ua), ("DOWN", prev[1], da)):
                if before < LINE <= now and (not sides or sides[-1] != side):
                    sides.append(side)
                    seconds.append(round(t - start, 1))
                    asks.append(now)
        prev = (ua, da)
    # Before one-sided rows were recorded the book simply stops when the winner
    # has no asks (median ~242 s): such a round is still counted, and flagged.
    ends_early = last_t is None or last_t - start < MIN_END_SEC
    incomplete = (first_clean is None or first_clean - start > START_GRACE_SEC
                  or (ends_early and start >= ONE_SIDED_FROM))
    return {"roundId": str(start), "startsAt": start, "firings": len(sides), "reversals": max(0, len(sides) - 1),
            "sides": sides, "seconds": seconds, "asks": asks, "winner": winner,
            "firstFiringSide": sides[0] if sides else None,
            "firstFiringWon": (sides[0] == winner) if sides and winner else None,
            "incomplete": incomplete, "partialLastMinute": start < ONE_SIDED_FROM}


def _read_rows(path: Path) -> dict[str, list[dict]]:
    """Rows per round. The day file is multi-member gzip and the member being
    written may end mid-way: keep what was read."""
    rounds: dict[str, list[dict]] = {}
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            for line in handle:
                if '"k":"t"' in line or '"k": "t"' in line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    break
                round_id = row.get("r")
                if isinstance(round_id, str) and round_id.isdigit():
                    rounds.setdefault(round_id, []).append(row)
    except (EOFError, OSError, zlib.error):
        pass
    return rounds


def day_rounds(history: Path, cache: Path, asset: str, day: str, *, now: float | None = None) -> list[dict]:
    """Counted rounds of one recording day, cached by file size and mtime. A
    file still being written is recomputed at most every LIVE_RECOMPUTE_SEC."""
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
        if cached.get("version") == CACHE_VERSION and fresh:
            return cached["rounds"]
    except (OSError, ValueError, KeyError, AttributeError):
        pass
    rows = _read_rows(source)
    counted = sorted((count_round(sorted(items, key=lambda row: row.get("t", 0)), int(round_id))
                      for round_id, items in rows.items()), key=lambda item: item["startsAt"])
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps({"version": CACHE_VERSION, "stamp": stamp, "computedAt": now,
                                     "rounds": counted}), encoding="utf-8")
    temporary.replace(target)
    return counted


def _stats(rounds: list[dict]) -> dict:
    complete = [item for item in rounds if not item["incomplete"]]
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
            "partialLastMinute": any(item["partialLastMinute"] for item in complete)}


def summary(history: Path, cache: Path, asset: str, *, days: int, today: str | None = None) -> dict:
    """Per-day and total statistics plus the latest rounds, newest first."""
    today = today or datetime.now(BEIJING).strftime("%Y-%m-%d")
    first = datetime.strptime(today, "%Y-%m-%d")
    dates = [(first - timedelta(days=offset)).strftime("%Y-%m-%d") for offset in range(days)]
    per_day, everything = [], []
    for date in dates:
        rounds = day_rounds(history, cache, asset, date)
        if not rounds:
            continue
        everything.extend(rounds)
        per_day.append({"date": date, **_stats(rounds)})
    latest = sorted((item for item in everything if not item["incomplete"]),
                    key=lambda item: item["startsAt"], reverse=True)[:300]
    return {"schemaVersion": 1, "assetId": asset, "asOf": time.time(), "days": per_day,
            "total": _stats(everything), "rounds": latest}

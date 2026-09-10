"""Bounded journal analytics. Never call ingestion from a trading/request loop.

Journal PnL is engine settlement PnL (payout - cost - fees), not wallet cash
reconciliation. Missing order identifiers prevent reliable order lifecycle metrics.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import sqlite3
import time


SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
 run_id TEXT PRIMARY KEY, mode TEXT NOT NULL, account_id TEXT, path TEXT NOT NULL,
 config_revision INTEGER, created_at REAL NOT NULL, source_identity TEXT,
 byte_offset INTEGER NOT NULL DEFAULT 0, prefix_length INTEGER NOT NULL DEFAULT 0,
 prefix_hash TEXT, tail_hash TEXT, source_error TEXT,
 record_count INTEGER NOT NULL DEFAULT 0, invalid_records INTEGER NOT NULL DEFAULT 0,
 duplicate_records INTEGER NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0,
 fill_count INTEGER NOT NULL DEFAULT 0, fill_notional REAL NOT NULL DEFAULT 0,
 missing_notional INTEGER NOT NULL DEFAULT 0, known_fees REAL NOT NULL DEFAULT 0,
 missing_fees INTEGER NOT NULL DEFAULT 0, settled_markets INTEGER NOT NULL DEFAULT 0,
 known_settled_pnl REAL NOT NULL DEFAULT 0, missing_pnl INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(run_id),
 byte_offset INTEGER NOT NULL, kind TEXT NOT NULL, stable_id TEXT, payload TEXT NOT NULL,
 UNIQUE(run_id, byte_offset)
);
CREATE UNIQUE INDEX IF NOT EXISTS stable_event ON events(run_id, kind, stable_id)
 WHERE stable_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_page ON events(run_id, id);
CREATE TABLE IF NOT EXISTS markets (
 run_id TEXT NOT NULL REFERENCES runs(run_id), market TEXT NOT NULL,
 fills INTEGER NOT NULL DEFAULT 0, settled INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(run_id, market)
);
CREATE TABLE IF NOT EXISTS kind_counts (
 run_id TEXT NOT NULL REFERENCES runs(run_id), kind TEXT NOT NULL, count INTEGER NOT NULL,
 PRIMARY KEY(run_id,kind)
);
CREATE TABLE IF NOT EXISTS market_details (
 run_id TEXT NOT NULL REFERENCES runs(run_id), market TEXT NOT NULL,
 turnover REAL NOT NULL DEFAULT 0, pnl REAL, status TEXT NOT NULL DEFAULT '运行中',
 last_time REAL NOT NULL DEFAULT 0, PRIMARY KEY(run_id,market)
);
CREATE INDEX IF NOT EXISTS latest_markets ON market_details(run_id,last_time DESC);
"""
EVENT_KINDS = frozenset({"quote", "fill", "taker", "cancel", "resolved", "reset", "stopped", "unresolved", "error"})


def _number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        result = float(value)
    except (OverflowError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _text(value, maximum=200):
    return value[:maximum] if isinstance(value, str) else None


def _projection(record):
    """Only these typed business fields leave the journal; no raw messages/config."""
    result = {"event": record["event"], "market": _text(record.get("market_slug")),
              "side": record.get("side") if record.get("side") in ("UP", "DOWN", "up", "down") else None,
              "winner": record.get("winner") if record.get("winner") in ("UP", "DOWN", "up", "down") else None}
    for field, source in (("time", "recv_ts"), ("engine_ts", "engine_ts"),
                          ("price", "price"), ("shares", "shares"), ("fee", "fee"), ("pnl", "pnl")):
        result[field] = _number(record.get(source))
    result["is_maker"] = record.get("is_maker") if isinstance(record.get("is_maker"), bool) else None
    price, shares = result["price"], result["shares"]
    result["amount"] = _number(price * shares) if price is not None and shares is not None and price >= 0 and shares >= 0 else None
    # Stopped/unresolved snapshots are never settlement PnL.
    if record["event"] != "resolved":
        result["pnl"] = None
    return result


class Ledger:
    def __init__(self, path, *, readonly=False):
        self.path = Path(path).resolve()
        self.readonly = readonly
        self._idle_sources = OrderedDict()
        if not readonly:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self._connect() as db:
                db.execute("PRAGMA journal_mode=WAL")
                db.executescript(SCHEMA)

    @contextmanager
    def _connect(self):
        target = self.path.as_uri() + "?mode=ro" if self.readonly else str(self.path)
        db = sqlite3.connect(target, uri=self.readonly, timeout=2)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def register_run(self, run_id, mode, account_id, path, config_revision=None):
        if not isinstance(run_id, str) or not run_id or len(run_id) > 200:
            raise ValueError("Invalid run ID")
        if mode not in {"paper", "live", "shadow"}:
            raise ValueError("Invalid run mode")
        if config_revision is not None and (type(config_revision) is not int or config_revision < 0):
            raise ValueError("Invalid config revision")
        values = (mode, account_id, str(Path(path).resolve()), config_revision)
        with self._connect() as db:
            prior = db.execute("SELECT mode,account_id,path,config_revision FROM runs WHERE run_id=?", (run_id,)).fetchone()
            if prior is not None:
                normalized = (prior["mode"], prior["account_id"], prior["path"],
                              int(prior["config_revision"]) if prior["config_revision"] is not None else None)
                if normalized != values:
                    raise ValueError("Run registration is immutable")
                return
            db.execute("INSERT INTO runs(run_id,mode,account_id,path,config_revision,created_at) VALUES(?,?,?,?,?,?)",
                       (run_id, *values, time.time()))

    @staticmethod
    def _run(db, run_id):
        row = db.execute("SELECT * FROM runs WHERE run_id=?", (run_id,)).fetchone()
        if row is None:
            raise KeyError("Run is not registered")
        return row

    def list_runs(self, *, limit=100):
        limit = max(1, min(int(limit), 200))
        with self._connect() as db:
            return [dict(row) for row in db.execute(
                "SELECT run_id,mode,account_id,config_revision,created_at FROM runs ORDER BY created_at DESC LIMIT ?", (limit,))]

    @staticmethod
    def _fingerprints(source, offset, prefix_length):
        source.seek(0)
        prefix = hashlib.sha256(source.read(prefix_length)).hexdigest()
        source.seek(max(0, offset - 256))
        tail = hashlib.sha256(source.read(min(offset, 256))).hexdigest()
        return prefix, tail

    def next_historical_run(self, current, after=""):
        """Round-robin all runs without loading their full journals."""
        with self._connect() as db:
            row = db.execute("SELECT run_id FROM runs WHERE run_id != ? AND run_id > ? ORDER BY run_id LIMIT 1",
                             (current, after)).fetchone()
            if row is None and after:
                row = db.execute("SELECT run_id FROM runs WHERE run_id != ? ORDER BY run_id LIMIT 1", (current,)).fetchone()
            return row[0] if row else None

    def ingest(self, run_id, *, max_bytes=1048576, max_records=2000):
        max_bytes = max(1, min(int(max_bytes), 8 * 1048576))
        max_records = max(1, min(int(max_records), 10000))
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            run = self._run(db, run_id)
            offset = run["byte_offset"]
            result = {"run_id": run_id, "records": 0, "inserted": 0, "bytes": 0,
                      "byte_offset": offset, "pending": False, "error": run["source_error"]}
            if run["source_error"]:
                return result
            try:
                source = open(run["path"], "rb")
            except FileNotFoundError:
                result["pending"] = True
                return result
            with source:
                stat = os.fstat(source.fileno())
                result.update(source_bytes=stat.st_size, lag_bytes=max(0, stat.st_size-offset))
                identity = f"{stat.st_dev}:{stat.st_ino}"
                prefix, tail = self._fingerprints(source, offset, run["prefix_length"])
                if ((run["source_identity"] is not None and identity != run["source_identity"])
                        or stat.st_size < offset
                        or (offset and (prefix != run["prefix_hash"] or tail != run["tail_hash"]))):
                    result["error"] = "Journal replaced, truncated, or rewritten; register a new run"
                    db.execute("UPDATE runs SET source_error=? WHERE run_id=?", (result["error"], run_id))
                    return result
                db.execute("UPDATE runs SET source_identity=? WHERE run_id=?", (identity, run_id))
                source.seek(offset)
                block = source.read(max_bytes)
                cursor = 0
                while result["records"] < max_records:
                    end = block.find(b"\n", cursor)
                    if end < 0:
                        break
                    raw = block[cursor:end]
                    record_offset = offset + cursor
                    cursor = end + 1
                    result["records"] += 1
                    try:
                        record = json.loads(raw)
                        if not isinstance(record, dict):
                            raise ValueError("Record must be an object")
                    except (UnicodeDecodeError, ValueError):
                        db.execute("UPDATE runs SET invalid_records=invalid_records+1 WHERE run_id=?", (run_id,))
                        continue
                    kind = record.get("event")
                    if not isinstance(kind, str) or kind not in EVENT_KINDS:
                        continue
                    projected = _projection(record)
                    if kind == "resolved":
                        prior_market = db.execute("SELECT fills FROM markets WHERE run_id=? AND market=?",
                                                  (run_id, projected["market"])).fetchone()
                        projected["has_observed_fills"] = bool(prior_market and prior_market["fills"])
                        if not projected["has_observed_fills"]:
                            projected["pnl"] = None
                    stable_id = None
                    for key in ("event_id", "eventId") + (("fill_id", "trade_id", "tradeId") if kind == "fill" else ()):
                        candidate = record.get(key)
                        if isinstance(candidate, (str, int)) and not isinstance(candidate, bool) and str(candidate):
                            stable_id = f"{key}:{candidate}"
                            break
                    inserted = db.execute("INSERT OR IGNORE INTO events(run_id,byte_offset,kind,stable_id,payload) VALUES(?,?,?,?,?)",
                                          (run_id, record_offset, kind, stable_id, json.dumps(projected, allow_nan=False))).rowcount
                    if not inserted:
                        db.execute("UPDATE runs SET duplicate_records=duplicate_records+1 WHERE run_id=?", (run_id,))
                        continue
                    result["inserted"] += 1
                    self._accumulate(db, run_id, projected)
                new_offset = offset + cursor
                if not cursor and len(block) == max_bytes and b"\n" not in block:
                    result["error"] = "Journal line exceeds ingestion byte budget"
                prefix_length = min(new_offset, 256)
                prefix, tail = self._fingerprints(source, new_offset, prefix_length)
                db.execute("""UPDATE runs SET byte_offset=?,prefix_length=?,prefix_hash=?,tail_hash=?,
                    record_count=record_count+?,event_count=event_count+?,source_error=? WHERE run_id=?""",
                           (new_offset, prefix_length, prefix, tail, result["records"], result["inserted"], result["error"], run_id))
                size = os.fstat(source.fileno()).st_size
                result.update(bytes=cursor, byte_offset=new_offset, source_bytes=size,
                              lag_bytes=max(0, size-new_offset), pending=new_offset < size)
                return result

    @staticmethod
    def _source_stamp(path):
        stat = Path(path).stat()
        return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)

    def ingest_if_changed(self, run_id, **limits):
        """Single-writer worker fast path; pending/error sources always recheck.

        Metadata changes still pass through ingest's identity and content checks.
        Cache only a stable, caught-up source, bounded across historical runs.
        Ordinary ingest remains uncached for callers sharing a writer database.
        """
        cached = self._idle_sources.pop(run_id, None)
        if cached:
            path, stamp, result = cached
            try:
                if self._source_stamp(path) == stamp:
                    self._idle_sources[run_id] = cached
                    return {**result, "records": 0, "inserted": 0, "bytes": 0}
            except OSError:
                pass
        else:
            with self._connect() as db:
                path = self._run(db, run_id)["path"]
        try:
            before = self._source_stamp(path)
        except OSError:
            before = None
        result = self.ingest(run_id, **limits)
        if not result["pending"] and not result["error"] and before is not None:
            try:
                if before == self._source_stamp(path):
                    self._idle_sources[run_id] = (path, before, dict(result))
                    while len(self._idle_sources) > 256:
                        self._idle_sources.popitem(last=False)
            except OSError:
                pass
        return result

    @staticmethod
    def _accumulate(db, run_id, event):
        kind, market = event["event"], event["market"]
        db.execute("INSERT INTO kind_counts VALUES(?,?,1) ON CONFLICT(run_id,kind) DO UPDATE SET count=count+1", (run_id, kind))
        if kind == "fill" and event["is_maker"] is False:
            db.execute("INSERT INTO kind_counts VALUES(?,'taker_fill',1) ON CONFLICT(run_id,kind) DO UPDATE SET count=count+1", (run_id,))
        if market:
            db.execute("INSERT OR IGNORE INTO markets(run_id,market) VALUES(?,?)", (run_id, market))
            db.execute("INSERT INTO market_details(run_id,market,last_time) VALUES(?,?,?) ON CONFLICT(run_id,market) DO UPDATE SET last_time=MAX(last_time,excluded.last_time)", (run_id, market, event["time"] or 0))
        if kind == "fill":
            db.execute("""UPDATE runs SET fill_count=fill_count+1,fill_notional=fill_notional+?,
                missing_notional=missing_notional+?,known_fees=known_fees+?,missing_fees=missing_fees+? WHERE run_id=?""",
                       (event["amount"] or 0, int(event["amount"] is None), event["fee"] or 0, int(event["fee"] is None), run_id))
            if market:
                db.execute("UPDATE markets SET fills=fills+1 WHERE run_id=? AND market=?", (run_id, market))
                db.execute("UPDATE market_details SET turnover=turnover+? WHERE run_id=? AND market=?", (event["amount"] or 0, run_id, market))
        elif kind == "resolved" and market:
            # A resolved market with no observed fills is not a trading settlement.
            row = db.execute("SELECT fills,settled FROM markets WHERE run_id=? AND market=?", (run_id, market)).fetchone()
            if row["fills"] and not row["settled"]:
                db.execute("UPDATE markets SET settled=1 WHERE run_id=? AND market=?", (run_id, market))
                db.execute("UPDATE market_details SET pnl=?,status='已结算' WHERE run_id=? AND market=?", (event["pnl"], run_id, market))
                db.execute("""UPDATE runs SET settled_markets=settled_markets+1,
                    known_settled_pnl=known_settled_pnl+?,missing_pnl=missing_pnl+? WHERE run_id=?""",
                           (event["pnl"] or 0, int(event["pnl"] is None), run_id))
            elif not row["fills"]:
                db.execute("UPDATE market_details SET status='无成交' WHERE run_id=? AND market=?", (run_id, market))
        elif kind in {"stopped", "unresolved"} and market:
            db.execute("UPDATE market_details SET status='未结算（已停止）' WHERE run_id=? AND market=? AND pnl IS NULL", (run_id, market))

    def legacy_stats(self, run_id, *, summary=None):
        """Old UI shape, built only from the same deduplicated ledger."""
        summary = self.summary(run_id) if summary is None else summary
        with self._connect() as db:
            counts = {r["kind"]: r["count"] for r in db.execute("SELECT kind,count FROM kind_counts WHERE run_id=?", (run_id,))}
            traded = db.execute("SELECT COUNT(*) FROM markets WHERE run_id=? AND fills>0", (run_id,)).fetchone()[0]
            markets = [dict(r) for r in db.execute("""SELECT d.market,m.fills,d.turnover,d.pnl,d.status,d.last_time
                FROM market_details d JOIN markets m ON d.run_id=m.run_id AND d.market=m.market
                WHERE d.run_id=? ORDER BY d.last_time DESC LIMIT 50""", (run_id,))]
        events = self.events(run_id, limit=20)["events"]
        for event in events:
            event["side"] = event["side"] or event.get("winner")
            if event["event"] == "resolved" and not event.get("has_observed_fills"):
                event["event"] = "resolved_empty"
        return {"available": True, "file": None, "quotes": counts.get("quote", 0),
                "fills": summary["fill_count"], "takers": counts.get("taker_fill", 0),
                "cancels": counts.get("cancel", 0), "markets": counts.get("reset", 0),
                "traded_markets": traded, "fill_notional": summary["fill_notional"],
                "fees": summary["fees"], "settled_markets": summary["settled_markets"],
                "pnl": summary["settled_pnl"], "pnl_semantics": summary["pnl_semantics"],
                "last_event": events[0]["event"] if events else None,
                "error": ("交易日志待核对" if summary["error"] or summary["invalid_records"]
                          else "引擎报告异常，请检查运行状态" if counts.get("error", 0) else None),
                "events": list(reversed(events)), "market_summaries": markets}

    def summary(self, run_id):
        with self._connect() as db:
            run = self._run(db, run_id)
            result = {key: run[key] for key in ("run_id", "mode", "account_id", "config_revision", "created_at",
                      "byte_offset", "record_count", "invalid_records", "duplicate_records", "event_count", "fill_count", "settled_markets")}
            result.update(fill_notional=None if run["missing_notional"] else run["fill_notional"],
                          known_fill_notional=run["fill_notional"],
                          fees=None if run["missing_fees"] else run["known_fees"],
                          known_fees=run["known_fees"], missing_fee_count=run["missing_fees"],
                          settled_pnl=run["known_settled_pnl"] if run["settled_markets"] and not run["missing_pnl"] else None,
                          pnl_semantics="engine_settlement_net_of_fees; not_wallet_reconciliation",
                          order_lifecycle_available=False, error=run["source_error"])
            try:
                source_bytes = Path(run["path"]).stat().st_size
                lag = max(0, source_bytes - run["byte_offset"])
            except OSError:
                source_bytes, lag = None, None
            result.update(source_bytes=source_bytes, lag_bytes=lag,
                          completeness=("incomplete" if run["source_error"] or run["invalid_records"]
                                        else "waiting" if lag is None else "catching_up" if lag else "caught_up"))
            return result

    def list_runs_page(self, *, before_id=None, limit=50):
        """Return a bounded, stable page of runs without reading journal files."""
        limit = max(1, min(int(limit), 200))
        with self._connect() as db:
            args = []
            clause = ""
            if before_id is not None:
                clause = " WHERE rowid < ?"
                args.append(int(before_id))
            args.append(limit + 1)
            rows = list(db.execute("""SELECT rowid AS id,run_id,mode,account_id,config_revision,created_at
                FROM runs""" + clause + " ORDER BY rowid DESC LIMIT ?", args))
            runs = [dict(row) for row in rows[:limit]]
            return {"runs": runs, "next_before_id": runs[-1]["id"] if len(rows) > limit else None}

    def events(self, run_id, *, before_id=None, limit=100):
        limit = max(1, min(int(limit), 200))
        with self._connect() as db:
            self._run(db, run_id)
            args = [run_id]
            clause = ""
            if before_id is not None:
                clause = " AND id < ?"
                args.append(int(before_id))
            args.append(limit + 1)
            rows = list(db.execute("SELECT id,byte_offset,payload FROM events WHERE run_id=?" + clause + " ORDER BY id DESC LIMIT ?", args))
            items = [{"id": row["id"], "byte_offset": row["byte_offset"], **json.loads(row["payload"])} for row in rows[:limit]]
            return {"run_id": run_id, "events": items,
                    "next_before_id": items[-1]["id"] if len(rows) > limit else None}

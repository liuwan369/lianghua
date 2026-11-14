"""lead_stats at the server's scale (2026-11-14: /api/stats/lead took 17-19 s
under load on the 2 vCPU box).

Every 2 s the engine wrote a platform_status line, each stored as an events
row; lead_stats scanned every lead_signal payload of the range and classified
its Chinese reason (_skip_bucket) on each call, and the server's cache was keyed
on the ledger file's mtime, which every status line moved.

Now status lines only replace the run's platform_runtime row; lead_signal rows
get their skip bucket once at ingest (lead_signals), lead_stats is one GROUP
BY, and its ledger side is cached under the ledger's data version, which a
status line does not move. Fed 10k signals and 3k status lines:

- the numbers equal a direct count over the journal with _skip_bucket;
- no platform_status row is stored as an event;
- after a status line, the second call is answered from the cache (< 100 ms);
- a new signal does move the version and the figures;
- an existing ledger (status rows in events, no lead_signals) migrates in place.

Run:  python scripts/regress/lead-stats-scale.py
"""
import json
import random
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from dashboard.ledger import Ledger, SKIP_BUCKETS, _skip_bucket  # noqa: E402

ACCOUNT = "0x" + "ab" * 20
REASONS = ["信号在开盘后 3.0 秒，不在本场 [15, 265) 秒内", "信号离开盘前 60 秒均价 领先 6.0 bp，超出 ±5 bp，等下一个信号",
           "卖价 0.85 高于上限 0.80，等下一个信号", "当前盘口一边没有卖价，等下一个信号", "本场已尝试，未成交",
           "超过单场预算，本场不下", "已暂停新增交易", "中途启动，等待下一场", "交易所规则暂不可用", None]
OUTCOMES = ["skipped"] * 8 + ["stopping", "no_round", "order_submitted"]


def runtime(at):
    return {"schemaVersion": 1, "engine": "platform", "execution": "strategy", "strategy_id": "binance-lead",
            "status": "running", "mode": "live", "assetId": "btc", "positions": [], "positions_count": 0,
            "strategy_runtime": {"strategyId": "binance-lead", "currentRound": {
                "marketId": "0xm", "roundId": str(int(at // 300) * 300), "name": f"btc-updown-5m-{int(at // 300) * 300}",
                "assetId": "btc", "upTokenId": "U", "downTokenId": "D", "upShares": 0, "downShares": 0}, "rounds": []},
            "markets": [], "snapshots": []}


def journal_lines(now, signals=10_000, statuses=3_000):
    random.seed(11)
    lines = []
    for i in range(signals):
        at = now - 86_400 * 2 + i * 17
        outcome = random.choice(OUTCOMES)
        lines.append({"event": "lead_signal", "event_id": f"lead:{i}", "recv_ts": at, "received_at": at,
                      "asset_id": "btc", "venue": "bybit", "line": "direct", "trade_id": i, "direction": "UP",
                      "outcome": outcome, "reason": random.choice(REASONS)})
    for i in range(statuses):
        at = now - statuses * 2 + i * 2
        lines.append({"event": "platform_status", "recv_ts": at, "runtime": runtime(at)})
    lines.sort(key=lambda line: line["recv_ts"])
    return lines


def expected(lines, start=None):
    """The figures, counted straight from the journal with the classifier."""
    signals = [line for line in lines if line["event"] == "lead_signal" and (start is None or line["received_at"] >= start)]
    skips = {bucket: 0 for bucket in SKIP_BUCKETS}
    for line in signals:
        if line["outcome"] in ("skipped", "stopping"):
            skips[_skip_bucket(line["reason"])] += 1
    return {"signals": len(signals), "signals_in_window": sum(line["outcome"] != "no_round" for line in signals),
            "skips": skips}


def write(path, lines, mode="w"):
    with path.open(mode, encoding="utf-8") as handle:
        for line in lines:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")


def ingest(ledger, run_id):
    while ledger.ingest(run_id, max_bytes=8 << 20, max_records=10_000)["pending"]:
        pass


class LeadStatsScale(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.tmp.name)
        cls.now = time.time()
        cls.lines = journal_lines(cls.now)
        cls.journal = cls.root / "run.jsonl"
        write(cls.journal, cls.lines)
        cls.ledger = Ledger(cls.root / "ledger.sqlite3")
        cls.ledger.register_run("run-1", "live", ACCOUNT, str(cls.journal))
        ingest(cls.ledger, "run-1")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def stats(self, range_name="all"):
        return Ledger(self.root / "ledger.sqlite3", readonly=True).lead_stats("run-1", range=range_name, now=self.now)

    def test_1_numbers_match_the_journal(self):
        for range_name, start in (("all", None), ("today", self.stats("today")["from"])):
            got = self.stats(range_name)
            want = expected(self.lines, start)
            self.assertEqual((got["funnel"]["signals"], got["funnel"]["signals_in_window"], got["skips"]),
                             (want["signals"], want["signals_in_window"], want["skips"]), range_name)
        self.assertEqual(self.stats()["funnel"]["signals"], 10_000)

    def test_2_status_lines_are_not_events(self):
        with self.ledger._connect() as db:
            kinds = {row[0]: row[1] for row in db.execute("SELECT kind,COUNT(*) FROM events GROUP BY kind")}
            runtime_rows = db.execute("SELECT COUNT(*) FROM platform_runtime").fetchone()[0]
        self.assertNotIn("platform_status", kinds, "a status line is not an events row")
        self.assertEqual(kinds["lead_signal"], 10_000)
        self.assertEqual(runtime_rows, 1, "only the latest runtime is kept")
        self.assertEqual(self.ledger.runtime_stats("run-1")["runtime"]["status"], "running")

    def test_3_second_call_is_cached_across_a_status_line(self):
        self.stats()
        # A status line arrives: platform_runtime moves, the data version does not.
        version = self.ledger.data_version()
        at = self.now + 1
        write(self.journal, [{"event": "platform_status", "recv_ts": at, "runtime": runtime(at)}], "a")
        ingest(self.ledger, "run-1")
        self.assertEqual(self.ledger.data_version(), version, "a status line leaves the data version")
        started = time.perf_counter()
        second = self.stats()
        elapsed_ms = (time.perf_counter() - started) * 1000
        self.assertLess(elapsed_ms, 100, f"second call {elapsed_ms:.1f} ms")
        self.assertEqual(second["funnel"]["signals"], 10_000)

    def test_4_a_new_signal_moves_the_figures(self):
        before = self.stats()["funnel"]["signals"]
        version = self.ledger.data_version()
        extra = {"event": "lead_signal", "event_id": "lead:extra", "recv_ts": self.now, "received_at": self.now,
                 "asset_id": "btc", "venue": "okx", "line": "tokyo", "trade_id": 99_999, "direction": "DOWN",
                 "outcome": "skipped", "reason": "卖价 0.85 高于上限 0.80，等下一个信号"}
        write(self.journal, [extra], "a")
        self.lines.append(extra)
        ingest(self.ledger, "run-1")
        self.assertGreater(self.ledger.data_version(), version)
        after = self.stats()
        self.assertEqual(after["funnel"]["signals"], before + 1)
        self.assertEqual(after["skips"], expected(self.lines)["skips"])


class Migration(unittest.TestCase):
    def test_existing_ledger_migrates_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            now = time.time()
            lines = journal_lines(now, signals=500, statuses=200)
            journal = root / "run.jsonl"
            write(journal, lines)
            path = root / "ledger.sqlite3"
            ledger = Ledger(path)
            ledger.register_run("run-1", "live", ACCOUNT, str(journal))
            ingest(ledger, "run-1")
            # Make it an older ledger: status rows in events, no lead_signals.
            db = sqlite3.connect(path)
            db.executemany("INSERT INTO events(run_id,byte_offset,kind,stable_id,asset_id,payload) VALUES(?,?,?,?,?,?)",
                           [("run-1", 10_000_000 + i, "platform_status", None, "", '{"event":"platform_status"}')
                            for i in range(200)])
            db.execute("UPDATE runs SET event_count=event_count+200")
            db.execute("DROP TABLE lead_signals")
            db.execute("DELETE FROM projection_migrations WHERE name='status_events_v1'")
            db.commit()
            db.close()
            migrated = Ledger(path)
            with migrated._connect() as conn:
                status_rows = conn.execute("SELECT COUNT(*) FROM events WHERE kind='platform_status'").fetchone()[0]
                signal_rows = conn.execute("SELECT COUNT(*) FROM lead_signals").fetchone()[0]
                event_count = conn.execute("SELECT event_count FROM runs").fetchone()[0]
                events = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
            self.assertEqual((status_rows, signal_rows, event_count), (0, 500, events))
            got = migrated.lead_stats("run-1", range="all", now=now)
            want = expected(lines)
            self.assertEqual((got["funnel"]["signals"], got["skips"]), (want["signals"], want["skips"]))


if __name__ == "__main__":
    unittest.main()

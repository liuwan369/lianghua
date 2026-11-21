"""Journal replication (dashboard/replica.py): the console copies the engine
box's journal byte-for-byte into its own results/replica/ and the ledger reads
that copy. Checks the properties the ledger depends on:

- chunks split mid-line reassemble to exactly the source bytes;
- the ledger on the replica matches the ledger on the original journal;
- appends keep the same inode (never temp-file + rename: the ledger flags a new
  inode at offset 0 as JOURNAL_REWRITTEN);
- a source whose tail no longer matches what we hold is divergence: the pull is
  rejected and nothing is appended;
- the replicator refuses when the replica path resolves to the source journal
  (a local agent on the same box must not append the engine's file onto itself);
- a capped chunk leaves bytes behind, reported as "behind".

Run:  python scripts/regress/replica.py
"""
import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from dashboard.ledger import Ledger  # noqa: E402
from dashboard.replica import JournalReplica, source_chunk  # noqa: E402

LINES = [
    '{"event":"platform_status","recv_ts":1,"runtime":{"schemaVersion":1,"engine":"platform","execution":"strategy","status":"running"}}',
    '{"event":"lead_signal","recv_ts":2,"venue":"bybit","line":"tokyo","direction":"UP","move_bp":2.1,"received_at":2.0,"outcome":"skipped","reason":"x"}',
    '{"event":"lead_order","recv_ts":3,"client_order_id":"c1","market_id":"0xm","round_start":1800000000}',
]
JOURNAL = ("\n".join(LINES) + "\n").encode("utf-8")


class Replica(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.source = self.tmp / "source" / "dashboard-R1.jsonl"
        self.source.parent.mkdir(parents=True)
        self.replica = JournalReplica(self.tmp / "replica")

    def source_identity(self):
        st = self.source.stat()
        return f"{st.st_dev}:{st.st_ino}"

    def drive(self, run_id, max_bytes):
        """Pull the source into the replica in chunks of at most max_bytes until caught up."""
        while True:
            request = self.replica.pull_request(run_id)
            chunk = source_chunk(self.source, request["offset"], request["tail"], max_bytes=max_bytes)
            result = self.replica.apply(run_id, chunk)
            if not result["appended"] and not result["behind"]:
                return result

    def test_mid_line_chunks_reassemble(self):
        self.source.write_bytes(JOURNAL)
        # 7 bytes at a time splits every line across several chunks.
        self.drive("R1", max_bytes=7)
        self.assertEqual(self.replica.path("R1").read_bytes(), JOURNAL, "byte-for-byte copy")

    def test_ledger_on_replica_matches_original(self):
        self.source.write_bytes(JOURNAL)
        self.drive("R1", max_bytes=13)
        original = Ledger(self.tmp / "orig.sqlite3")
        original.register_run("R1", "live", "0xacct", self.source, 1)
        original.ingest("R1")
        replicated = Ledger(self.tmp / "repl.sqlite3")
        replicated.register_run("R1", "live", "0xacct", self.replica.path("R1"), 1)
        replicated.ingest("R1")
        a = original.lead_stats("R1", range="run")["funnel"]
        b = replicated.lead_stats("R1", range="run")["funnel"]
        self.assertEqual(a, b)
        self.assertGreaterEqual(a["orders"], 1, "the order line was ingested from the replica")

    def test_appends_keep_the_same_inode(self):
        self.source.write_bytes(JOURNAL)
        self.drive("R1", max_bytes=1 << 20)
        inode = self.replica.path("R1").stat().st_ino
        self.source.write_bytes(JOURNAL + b'{"event":"fill","recv_ts":4,"clientOrderId":"c1"}\n')
        self.drive("R1", max_bytes=1 << 20)
        self.assertEqual(self.replica.path("R1").stat().st_ino, inode, "appended in place, never renamed")

    def test_divergent_source_is_rejected(self):
        self.source.write_bytes(JOURNAL)
        self.drive("R1", max_bytes=1 << 20)
        before = self.replica.path("R1").read_bytes()
        # The source is rewritten with different bytes up to our offset.
        self.source.write_bytes(b'{"event":"different"}\n' + JOURNAL)
        request = self.replica.pull_request("R1")
        chunk = source_chunk(self.source, request["offset"], request["tail"], max_bytes=1 << 20)
        self.assertTrue(chunk["diverged"], "the source tail no longer matches what we hold")
        result = self.replica.apply("R1", chunk)
        self.assertTrue(result["diverged"])
        self.assertEqual(result["appended"], 0)
        self.assertEqual(self.replica.path("R1").read_bytes(), before, "nothing is appended on divergence")

    def test_refuses_when_replica_is_the_source(self):
        same = JournalReplica(self.source.parent)
        same_run = self.source.stem.split("dashboard-", 1)[-1]  # "R1"
        self.source.write_bytes(JOURNAL)
        request = same.pull_request(same_run)
        chunk = source_chunk(self.source, request["offset"], request["tail"], max_bytes=1 << 20)
        chunk = {**chunk, "source_path": str(self.source)}
        with self.assertRaisesRegex(ValueError, "replica"):
            same.apply(same_run, chunk)

    def test_capped_chunk_reports_behind(self):
        self.source.write_bytes(JOURNAL)
        request = self.replica.pull_request("R1")
        chunk = source_chunk(self.source, request["offset"], request["tail"], max_bytes=20)
        result = self.replica.apply("R1", chunk)
        self.assertTrue(result["behind"], "more bytes remain at the source")
        self.assertLess(self.replica.path("R1").stat().st_size, len(JOURNAL))

    def test_offset_zero_has_empty_tail(self):
        self.source.write_bytes(JOURNAL)
        request = self.replica.pull_request("R1")
        self.assertEqual(request["offset"], 0)
        chunk = source_chunk(self.source, 0, request["tail"], max_bytes=1 << 20)
        self.assertFalse(chunk["diverged"], "an empty tail matches at offset 0")
        self.assertEqual(chunk["source_identity"], self.source_identity())


if __name__ == "__main__":
    unittest.main()

"""scripts/migrate_console_data.py on a copy of today's pm-ire layout:

- the ledger is copied to data/console/ with every run's path pointed at a
  byte copy in data/console/replica/, and still ingests (offsets hold);
- the selected run and the agent's run state carry over;
- nothing under backend/engine/results is changed or removed (the rollback);
- a second run changes nothing.

Run:  python scripts/regress/migrate-console-data.py
"""
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from dashboard.ledger import Ledger  # noqa: E402

spec = importlib.util.spec_from_file_location("migrate", SCRIPTS / "migrate_console_data.py")
migrate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migrate)
RUN = "20261121-054005-de094a82fe3e"


def tree_hash(root: Path) -> dict:
    # SQLite's -wal/-shm side files appear when the backup opens the ledger;
    # they are SQLite's, not data, so only real files are compared.
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob("*"))
            if p.is_file() and not p.name.endswith(("-wal", "-shm"))}


class Migrate(unittest.TestCase):
    def test_layout(self):
        root = Path(tempfile.mkdtemp())
        results = root / "backend" / "engine" / "results"
        (results / "live").mkdir(parents=True)
        (results / "dashboard").mkdir()
        journal = results / "live" / f"dashboard-{RUN}.jsonl"
        journal.write_bytes(b'{"event":"lead_order","recv_ts":1,"client_order_id":"c1","market_id":"0xm","round_start":1800000000}\n')
        ledger = Ledger(results / "dashboard" / "ledger.sqlite3")
        ledger.register_run(RUN, "live", "0xacct", journal, 35)
        ledger.ingest(RUN)
        (results / "dashboard-state.json").write_text(json.dumps(
            {"run_id": RUN, "account_id": "0xacct", "config_revision": 35, "pid": None, "log": str(journal)}), encoding="utf-8")
        before = tree_hash(results)

        report = migrate.migrate(root)
        self.assertTrue(report["ledger"])
        self.assertEqual((report["selection"], report["rewritten"]), (RUN, 1))
        console = root / "data" / "console"
        copy = console / "replica" / journal.name
        self.assertEqual(copy.read_bytes(), journal.read_bytes())
        moved = Ledger(console / "ledger.sqlite3")
        with moved._connect() as db:
            self.assertEqual(db.execute("SELECT path FROM runs WHERE run_id=?", (RUN,)).fetchone()[0], str(copy.resolve()))
        self.assertGreaterEqual(moved.lead_stats(RUN, range="run")["funnel"]["orders"], 1, "the copied ledger keeps its data")
        # New bytes on the replica are ingested from the stored offset.
        with copy.open("ab") as handle:
            handle.write(b'{"event":"lead_order","recv_ts":2,"client_order_id":"c2","market_id":"0xm","round_start":1800000300}\n')
        self.assertIsNone(moved.ingest(RUN)["error"], "offsets and fingerprints hold on the copy")
        self.assertEqual(json.loads((console / "selection-run.json").read_text(encoding="utf-8"))["run_id"], RUN)
        self.assertTrue((results / "engine-run.json").exists())
        after = tree_hash(results)
        self.assertEqual({k: v for k, v in after.items() if k != "engine-run.json"}, before, "the engine's results are untouched")

        again = migrate.migrate(root)
        self.assertEqual((again["ledger"], again["replicas"], again["selection"], again["engine_run"]), (False, [], None, False))

    def test_single_console_becomes_account_1(self):
        """The first split left one data/console; per-account consoles keep
        data/console-<id>. Account 1 takes the existing dir over (renamed, the
        ledger's replica paths rewritten), once."""
        root = Path(tempfile.mkdtemp())
        console = root / "data" / "console"
        (console / "replica").mkdir(parents=True)
        journal = console / "replica" / f"dashboard-{RUN}.jsonl"
        journal.write_bytes(b'{"event":"lead_order","recv_ts":1,"client_order_id":"c1","market_id":"0xm","round_start":1800000000}\n')
        ledger = Ledger(console / "ledger.sqlite3")
        ledger.register_run(RUN, "live", "0xacct", journal, 35)
        ledger.ingest(RUN)
        report = migrate.migrate_account_one(root)
        self.assertTrue(report["moved"])
        moved = root / "data" / "console-1"
        self.assertFalse(console.exists())
        with Ledger(moved / "ledger.sqlite3")._connect() as db:
            path = db.execute("SELECT path FROM runs WHERE run_id=?", (RUN,)).fetchone()[0]
        self.assertEqual(path, str((moved / "replica" / journal.name).resolve()))
        self.assertIsNone(Ledger(moved / "ledger.sqlite3").ingest(RUN)["error"], "the moved ledger still reads its replica")
        self.assertFalse(migrate.migrate_account_one(root)["moved"], "once")


if __name__ == "__main__":
    unittest.main()

"""The console's side of the engine agent (scripts/dashboard/agent.py) against a
fake agent on a local port:

- the poller caches /state; an unreachable agent is "unknown", never "stopped":
  processRunning is null and every write (start, publish, reset) is refused;
- a wallet or box that differs from what this console expects refuses writes;
- the account snapshot is fetched only when its version changes;
- agent errors pass through with their HTTP status and message;
- replication copies the agent's journal byte-for-byte into the console's
  replica dir, chunk by chunk, and reports "behind" until caught up;
- a start is refused while the previous run's replica is not complete.

Run:  python scripts/regress/console-agent.py
"""
import base64
import hashlib
import json
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
from dashboard.agent import AgentClient, AgentError, AgentUnavailable  # noqa: E402
from dashboard.replica import JournalReplica, source_chunk  # noqa: E402

WALLET = "0x" + "ab" * 20
RUN = "20261121-120000-0123456789ab"


class FakeAgent:
    """What engine_agent.py answers, with knobs."""
    def __init__(self, journal: Path):
        self.journal = journal
        self.box, self.wallet = "pm-a", WALLET
        self.snapshot_version, self.snapshot_fetches = 1.0, 0
        self.commands, self.fail_start = [], None

    def state(self):
        return {"schemaVersion": 1, "box": self.box, "now": time.time(),
                "status": {"running": False, "account": {"wallet": self.wallet}, "run_id": RUN, "stop_result": {}},
                "config": {"savedRevision": 3, "config": {"shares": 5}}, "draft": None,
                "accountSnapshot": {"version": self.snapshot_version, "stale": False, "error": None},
                "metrics": {"cpu": {"percent": 12}}, "runs": [{"run_id": RUN, "bytes": self.journal.stat().st_size}]}

    def handler(self):
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def send(self, status, value):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):  # noqa: N802
                parts = urlsplit(self.path)
                query = {k: v[0] for k, v in parse_qs(parts.query).items()}
                if parts.path == "/state":
                    self.send(200, fake.state())
                elif parts.path == "/account/snapshot":
                    fake.snapshot_fetches += 1
                    self.send(200, {"available": True, "stale": False, "wallet": fake.wallet, "collateral": {"value": 80.5}})
                elif parts.path == "/journal":
                    chunk = source_chunk(fake.journal, int(query["offset"]), query["tail"], max_bytes=int(query.get("max", 1 << 20)))
                    self.send(200, {**chunk, "data": base64.b64encode(chunk["data"]).decode()})
                else:
                    self.send(404, {"error": "not found"})

            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
                fake.commands.append((self.path, body))
                if self.path == "/commands" and fake.fail_start:
                    self.send(*fake.fail_start)
                else:
                    self.send(200, {"ok": True, "command_status": "accepted"})

            def log_message(self, *_):
                return
        return Handler


class ConsoleAgent(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.journal = self.tmp / "agent" / f"dashboard-{RUN}.jsonl"
        self.journal.parent.mkdir()
        self.journal.write_bytes(b'{"event":"a","n":1}\n{"event":"b","n":2}\n{"event":"c","n":3}\n')
        self.fake = FakeAgent(self.journal)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self.fake.handler())
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.client = AgentClient(self.url, expected_box="pm-a", expected_wallet=WALLET,
                                  replica=JournalReplica(self.tmp / "replica"), chunk_bytes=16)

    def tearDown(self):
        self.httpd.shutdown()

    def test_state_is_cached_and_reachable(self):
        self.client.poll()
        view = self.client.view()
        self.assertTrue(view["reachable"])
        self.assertEqual((view["state"]["box"], view["state"]["status"]["running"]), ("pm-a", False))
        self.assertIsNone(view["mismatch"])
        self.assertLess(abs(view["clockSkewSeconds"]), 0.2)
        # The skew is measured when the answer arrives, not against the clock
        # at read time: a cache read a second later must not drift by that second.
        first = view["clockSkewSeconds"]
        time.sleep(1.2)
        self.assertEqual(self.client.view()["clockSkewSeconds"], first, "the skew does not age with the cache")

    def test_unreachable_is_unknown_and_refuses_writes(self):
        self.client.poll()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.client.poll()
        view = self.client.view()
        self.assertFalse(view["reachable"], "an unreachable agent is not reported reachable")
        self.assertIsNone(self.client.process_running(), "unknown, never 'stopped'")
        for call in (lambda: self.client.command({"action": "start", "revision": 3}),
                     lambda: self.client.post("/config/draft", {}), lambda: self.client.post("/reset", {"confirm": "RESET"})):
            with self.assertRaises(AgentUnavailable):
                call()

    def test_wrong_wallet_or_box_refuses_writes(self):
        self.fake.wallet = "0x" + "cd" * 20
        self.client.poll()
        self.assertIn("钱包", self.client.view()["mismatch"])
        with self.assertRaises(AgentUnavailable):
            self.client.command({"action": "pause"})
        self.fake.wallet, self.fake.box = WALLET, "pm-b"
        self.client.poll()
        self.assertIn("pm-b", self.client.view()["mismatch"])
        with self.assertRaises(AgentUnavailable):
            self.client.command({"action": "pause"})
        self.assertEqual(self.fake.commands, [], "nothing reached the agent")

    def test_snapshot_fetched_only_on_a_new_version(self):
        for _ in range(3):
            self.client.poll()
        self.assertEqual(self.fake.snapshot_fetches, 1)
        self.assertEqual(self.client.account_snapshot()["collateral"]["value"], 80.5)
        self.fake.snapshot_version = 2.0
        self.client.poll()
        self.assertEqual(self.fake.snapshot_fetches, 2)

    def test_agent_errors_pass_through(self):
        self.client.poll()
        while self.client.replicate()["behind"]:
            pass
        self.fake.fail_start = (403, {"ok": False, "error": "服务器未开启实盘解锁"})
        with self.assertRaises(AgentError) as raised:
            self.client.command({"action": "start", "revision": 3})
        self.assertEqual((raised.exception.status, str(raised.exception)), (403, "服务器未开启实盘解锁"))

    def test_replication_is_byte_exact(self):
        self.client.poll()
        for _ in range(20):
            if not self.client.replicate()["behind"]:
                break
        replica = self.tmp / "replica" / f"dashboard-{RUN}.jsonl"
        self.assertEqual(replica.read_bytes(), self.journal.read_bytes())
        self.assertTrue(self.client.replica_complete(RUN))
        with self.journal.open("ab") as handle:
            handle.write(b'{"event":"d"}\n')
        self.client.poll()
        self.assertFalse(self.client.replica_complete(RUN), "new bytes at the source: behind")
        self.client.replicate()
        self.assertEqual(replica.read_bytes(), self.journal.read_bytes())

    def test_start_waits_for_the_previous_replica(self):
        self.client.poll()
        with self.assertRaisesRegex(AgentUnavailable, "运行记录"):
            self.client.command({"action": "start", "revision": 3})
        for _ in range(20):
            if not self.client.replicate()["behind"]:
                break
        self.client.poll()
        self.client.command({"action": "start", "revision": 3})
        self.assertEqual(self.fake.commands[-1][0], "/commands")


if __name__ == "__main__":
    unittest.main()

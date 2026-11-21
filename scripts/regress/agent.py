"""The engine agent's HTTP API (scripts/engine_agent.py), on a local port with
the engine process stubbed:

- GET /state carries the process facts, the published config, the box id and a
  clock, and never a secret (the account values are fake but secret-shaped);
- GET /journal serves a run's bytes by run id only: a path or a malformed id is
  400, an unknown run 404, a capped read says behind, a wrong tail says diverged;
- POST /commands start is refused without the live unlock (403) and with a
  stale revision (409); pause/resume need a running engine (400);
- POST /reset refuses while an engine process exists (409);
- the agent will not bind a non-loopback address.

Run:  python scripts/regress/agent.py
"""
import base64
import hashlib
import http.client
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("engine_agent", SCRIPTS / "engine_agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

KEY = "0x" + "7f" * 32
WALLET = "0x" + "ab" * 20
RUN = "20261121-120000-0123456789ab"


class Agent(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        engine = cls.tmp / "backend" / "engine"
        (engine / "dist" / "cli").mkdir(parents=True)
        (engine / "dist" / "cli" / "platform.js").write_text("", encoding="utf-8")
        (engine / "results" / "live").mkdir(parents=True)
        agent.TRADING_ROOT = engine
        agent.DEPLOYMENT_LOCK_PATH = cls.tmp / "data" / "deployment.lock"
        agent.BOX = "pm-test"
        agent._trading_state_loaded = True
        agent._account_values = lambda: {"POLYMARKET_WALLET_ADDRESS": WALLET, "POLYMARKET_OWNER_PRIVATE_KEY": KEY,
                                         "POLY_BUILDER_SECRET": "s3cr3t-builder-value"}
        agent._remote_orders_empty_from_fresh_snapshot = lambda: False
        cls.journal = engine / "results" / "live" / f"dashboard-{RUN}.jsonl"
        cls.journal.write_bytes(b'{"event":"a"}\n{"event":"b"}\n')
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), agent.make_handler())
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def call(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        data = json.dumps(body).encode() if body is not None else None
        conn.request(method, path, body=data, headers={"Content-Type": "application/json"} if data else {})
        response = conn.getresponse()
        status, value = response.status, json.loads(response.read() or b"{}")
        conn.close()
        return status, value

    def test_state_has_facts_and_no_secret(self):
        status, value = self.call("GET", "/state")
        self.assertEqual(status, 200)
        self.assertEqual((value["box"], value["status"]["running"]), ("pm-test", False))
        self.assertIn("savedRevision", value["config"])
        self.assertIsInstance(value["now"], float)
        self.assertIn("cpu", value["metrics"])
        self.assertEqual([run["run_id"] for run in value["runs"]], [RUN])
        raw = json.dumps(value)
        for secret in (KEY, KEY[2:], "s3cr3t-builder-value"):
            self.assertNotIn(secret, raw, "no secret in /state")

    def test_journal_by_run_id(self):
        empty = hashlib.sha256(b"").hexdigest()
        status, chunk = self.call("GET", f"/journal?run={RUN}&offset=0&tail={empty}&max=8")
        self.assertEqual(status, 200)
        self.assertEqual(base64.b64decode(chunk["data"]), b'{"event"')
        self.assertTrue(chunk["behind"])
        self.assertFalse(chunk["diverged"])
        status, chunk = self.call("GET", f"/journal?run={RUN}&offset=8&tail={'0' * 64}&max=8")
        self.assertTrue(chunk["diverged"], "a tail the source does not have")
        for bad in ("../../etc/passwd", "x", RUN + "/..", ""):
            self.assertEqual(self.call("GET", f"/journal?run={bad}&offset=0&tail={empty}")[0], 400, bad)
        self.assertEqual(self.call("GET", f"/journal?run=20261121-120000-ffffffffffff&offset=0&tail={empty}")[0], 404)
        self.assertEqual(self.call("GET", f"/journal?run={RUN}&offset=-1&tail={empty}")[0], 400)

    def test_start_refusals(self):
        os.environ.pop("PM_TRADING_LIVE_UNLOCK", None)
        store = agent.strategy_config_store()
        draft = store.save_draft(store.get()["config"], store.get()["savedRevision"])
        revision = store.activate_draft(draft["expectedRevision"], draft["draftId"])["savedRevision"]
        start = {"action": "start", "strategy_id": "binance-lead", "request_id": str(uuid.uuid4())}
        self.assertEqual(self.call("POST", "/commands", {**start, "revision": revision + 5})[0], 409, "stale revision")
        status, value = self.call("POST", "/commands", {**start, "revision": revision})
        self.assertEqual(status, 403, value)
        self.assertIn("实盘解锁", value["error"])
        self.assertEqual(self.call("POST", "/commands", {"action": "pause", "strategy_id": "binance-lead"})[0], 400,
                         "pause needs a running engine")
        self.assertEqual(self.call("POST", "/commands", {"action": "launch"})[0], 400)

    def test_reset_refused_while_an_engine_exists(self):
        saved = agent._engine_process_present
        try:
            agent._engine_process_present = lambda: True
            self.assertEqual(self.call("POST", "/reset", {"confirm": "RESET"})[0], 409)
            agent._engine_process_present = lambda: None
            self.assertEqual(self.call("POST", "/reset", {"confirm": "RESET"})[0], 409, "unknown is not stopped")
            self.assertEqual(self.call("POST", "/reset", {})[0], 400, "needs the confirmation")
        finally:
            agent._engine_process_present = saved
        self.assertTrue(self.journal.exists(), "nothing deleted")

    def test_loopback_only(self):
        done = subprocess.run([sys.executable, str(SCRIPTS / "engine_agent.py"), "--host", "0.0.0.0", "--port", "0"],
                              capture_output=True, text=True, encoding="utf-8", timeout=30,
                              env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("本机", done.stderr)


if __name__ == "__main__":
    unittest.main()

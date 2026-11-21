"""The console and the engine agent end to end, both real, on local ports.

The agent's engine is a stand-in node script that writes a journal with a
running platform_status line and a lead order every 0.2 s, and stops on
SIGTERM (or the stop file) with a terminal status, like the real engine. The
console talks to the agent over HTTP, replicates the journal and projects it.

- publish a config through the console; it lands on the agent (the engine's file);
- start through the console; the agent spawns the engine; /api/runtime/status
  turns running, the replica fills, /api/stats/lead counts the order;
- pause reaches the engine's control file;
- stop through the console; the run ends stopped, the replica equals the journal;
- the agent goes away: processRunning is null ("unknown"), writes are refused (503).

Run:  python scripts/regress/split-e2e.py
"""
import http.client
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
WALLET = "0x" + "ab" * 20

ENGINE = r"""
const fs = require("fs");
const args = process.argv.slice(2);
const flag = (n) => args[args.indexOf(n) + 1];
const journal = flag("--journal-file"), stop = flag("--stop-file"), control = flag("--control-file");
let n = 0, done = false;
const line = (o) => fs.appendFileSync(journal, JSON.stringify({ ...o, recv_ts: Date.now() / 1000 }) + "\n");
const status = (s) => ({ event: "platform_status", runtime: { schemaVersion: 1, engine: "platform", execution: "strategy",
  strategy_id: "binance-lead", status: s, mode: "live", source_at: Date.now() / 1000, expires_at: Date.now() / 1000 + 10,
  strategy_runtime: { strategyId: "binance-lead", paused: JSON.parse(fs.readFileSync(control, "utf8")).paused } } });
const finish = (reason) => { if (done) return; done = true;
  line(status("stopped"));
  console.log(JSON.stringify({ kind: "platform_status", status: "stopped", reason }));
  process.exit(0); };
process.on("SIGTERM", () => finish("SIGTERM"));
setInterval(() => {
  if (fs.existsSync(stop)) finish("controller_stop");
  line(status("running"));
  if (n++ === 2) line({ event: "lead_order", client_order_id: "c1", market_id: "0xm", round_start: 1800000000,
    venue: "bybit", line: "tokyo", direction: "UP", status: "FILLED", limit_price: 0.55, filled_shares: 5 });
}, 200);
"""


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Split(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        engine_root = cls.tmp / "box" / "backend" / "engine"
        (engine_root / "dist" / "cli").mkdir(parents=True)
        (engine_root / "dist" / "cli" / "platform.js").write_text(ENGINE, encoding="utf-8")
        (engine_root / "results" / "live").mkdir(parents=True)
        os.environ["PM_TRADING_LIVE_UNLOCK"] = "1"
        os.environ.pop("INVOCATION_ID", None)
        a = cls.agent = load("engine_agent", "engine_agent.py")
        a.TRADING_ROOT = engine_root
        a.DEPLOYMENT_LOCK_PATH = cls.tmp / "box" / "data" / "deployment.lock"
        a.BOX = "pm-test"
        a._trading_state_loaded = True
        a._account_values = lambda: {"POLYMARKET_WALLET_ADDRESS": WALLET}
        a.account_config_status = lambda: {"wallet": WALLET, "execution_credentials_ready": True, "account_check_ready": True,
                                           "settlement_credentials_ready": True, "live_start_ready": True}
        a._remote_orders_empty_from_fresh_snapshot = lambda: True
        cls.agent_httpd = ThreadingHTTPServer(("127.0.0.1", 0), a.make_handler())
        threading.Thread(target=cls.agent_httpd.serve_forever, daemon=True).start()

        c = cls.console = load("dashboard_server", "system-dashboard-server.py")
        c.DATA_DIR = cls.tmp / "console"
        c.AGENT_URL = f"http://127.0.0.1:{cls.agent_httpd.server_address[1]}"
        c.EXPECTED_BOX, c.EXPECTED_WALLET = "pm-test", WALLET
        os.environ["PM_TRUST_ACCOUNT_PROXY"] = "1"
        cls.stop = threading.Event()
        threading.Thread(target=c.agent().run, args=(cls.stop,), daemon=True).start()
        threading.Thread(target=c.supervise_projection, args=(cls.stop,), daemon=True).start()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), c.make_handler(SCRIPTS.parent))
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.stop.set()
        cls.httpd.shutdown()
        with cls.console._read_model_init_lock:
            if cls.console._read_model:
                cls.console._read_model.close()
        process = cls.agent._trading_process
        if process and process.poll() is None:
            process.kill()

    PROXY = {"Content-Type": "application/json", "Origin": "https://console.test", "Host": "console.test",
             "X-PM-Authenticated": "operator", "X-Forwarded-Proto": "https"}

    def request(self, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request(method, path, body=json.dumps(body).encode() if body is not None else None,
                     headers=self.PROXY if method == "POST" else {})
        response = conn.getresponse()
        status, value = response.status, json.loads(response.read() or b"{}")
        conn.close()
        return status, value

    def until(self, check, seconds=15):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            value = check()
            if value:
                return value
            time.sleep(0.2)
        return check()

    def test_split(self):
        # Publish through the console: the config lands on the engine box.
        ready = self.until(lambda: self.request("GET", "/api/strategy/config")[0] == 200)
        self.assertTrue(ready, "the console reads the config once the agent answers")
        _, config = self.request("GET", "/api/strategy/config")
        self.assertEqual(config["savedRevision"], 0, config)
        status, draft = self.request("POST", "/api/strategy/drafts",
                                     {"strategyId": "binance-lead", "config": config["config"], "expectedRevision": 0})
        self.assertEqual(status, 200, draft)
        status, published = self.request("POST", "/api/strategy/activate",
                                         {"strategyId": "binance-lead", "expectedRevision": 0, "draftId": draft["draftId"]})
        self.assertEqual((status, published["savedRevision"]), (200, 1), published)
        self.assertEqual(self.agent.strategy_config_store().get()["savedRevision"], 1, "the engine box holds the config")

        # Start: the agent spawns the engine; the console sees it running and projects the replica.
        status, started = self.request("POST", "/api/runtime/commands",
                                       {"action": "start", "strategyId": "binance-lead", "revision": 1, "requestId": str(uuid.uuid4())})
        self.assertEqual(status, 200, started)
        running = self.until(lambda: (self.request("GET", "/api/runtime/status")[1].get("processRunning") is True))
        self.assertTrue(running, "the console reports the agent's engine running")
        orders = self.until(lambda: ((self.request("GET", "/api/stats/lead?range=run")[1].get("funnel") or {}).get("orders") or 0) >= 1)
        self.assertTrue(orders, "the order written on the engine box reaches the console's statistics")

        # Pause reaches the engine's control file.
        status, _ = self.request("POST", "/api/runtime/commands", {"action": "pause", "strategyId": "binance-lead"})
        self.assertEqual(status, 200)
        control = self.agent._trading_log.with_suffix(".control.json")
        self.assertEqual(json.loads(control.read_text(encoding="utf-8")), {"paused": True})
        paused = self.until(lambda: self.request("GET", "/api/runtime/status")[1].get("paused") is True)
        self.assertTrue(paused, "the engine's paused status line comes back through the replica")

        # Stop: stopped, confirmed, and the replica is the journal byte for byte.
        status, stopped = self.request("POST", "/api/runtime/commands", {"action": "stop", "strategyId": "binance-lead"})
        self.assertEqual(status, 200, stopped)
        done = self.until(lambda: self.request("GET", "/api/runtime/status")[1].get("processRunning") is False)
        self.assertTrue(done)
        journal = self.agent._trading_log
        replica = self.console.DATA_DIR / "replica" / journal.name
        same = self.until(lambda: replica.is_file() and replica.read_bytes() == journal.read_bytes())
        self.assertTrue(same, "replica equals the engine's journal")

        # The agent goes away: unknown, and writes are refused.
        self.agent_httpd.shutdown()
        self.agent_httpd.server_close()
        unknown = self.until(lambda: self.request("GET", "/api/runtime/status")[1].get("processRunning") is None, 12)
        self.assertTrue(unknown, "an unreachable engine box is unknown, not stopped")
        status, refused = self.request("POST", "/api/runtime/commands",
                                       {"action": "start", "strategyId": "binance-lead", "revision": 1, "requestId": str(uuid.uuid4())})
        self.assertEqual(status, 503, refused)
        self.assertIn("连不上", refused["error"])


if __name__ == "__main__":
    unittest.main()

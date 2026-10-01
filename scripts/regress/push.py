"""Console push (PUSH-ARCHITECTURE.md step 3): GET /api/stream.

Runs the real control-plane handler on a local port with stubbed data
sources and checks what a browser would rely on:
- a new connection first gets the current value of every subscribed path;
- the pushed body is the body a GET of that path returns;
- an unchanged source pushes nothing; a change arrives within ~0.3 s;
- a source stuck for seconds (the trading lock on stop) does not delay others;
- connections past the cap are refused; a closed browser is unsubscribed.

Run:  python scripts/regress/push.py
"""
import http.client
import importlib.util
import json
import queue
import sys
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
from dashboard.push import fingerprint  # noqa: E402

MARKETS = "/api/markets?asset=crypto&duration=5m"
RUNTIME = "/api/runtime/status"


class Source:
    def __init__(self):
        self.frame = 1
        self.runtime_delay = 0.0

    def markets(self, query=None):
        return {"schemaVersion": 1, "source": "test", "asOf": time.time(), "stale": False, "error": None,
                "items": [{"marketId": "0xm", "frame": self.frame}], "markets": []}

    def runtime(self, status):
        time.sleep(self.runtime_delay)
        return {"schemaVersion": 1, "status": "stopped", "processRunning": False, "asOf": time.time(),
                "stale": False, "error": None}


class Reader:
    """Collect SSE data messages from a response on a background thread."""
    def __init__(self, response):
        self.messages = queue.Queue()
        threading.Thread(target=self._run, args=(response,), daemon=True).start()

    def _run(self, response):
        buffer = b""
        try:
            while True:
                chunk = response.fp.read1(65536)
                if not chunk:
                    return
                buffer += chunk
                while b"\n\n" in buffer:
                    event, buffer = buffer.split(b"\n\n", 1)
                    for line in event.split(b"\n"):
                        if line.startswith(b"data: "):
                            self.messages.put(json.loads(line[6:]))
        except (OSError, ValueError, AttributeError):
            return

    def read(self, count, timeout):
        out, deadline = [], time.monotonic() + timeout
        while len(out) < count:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            try:
                out.append(self.messages.get(timeout=left))
            except queue.Empty:
                break
        return out


class Push(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = Source()
        cls.saved = (server._modern_markets, server._modern_runtime, server.trading_status)
        server._modern_markets = cls.source.markets
        server._modern_runtime = cls.source.runtime
        server.trading_status = lambda include_stats=True: {}
        handler = server.make_handler(SCRIPTS.parent)
        handler.push_hub.max_clients = 3
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.hub = handler.push_hub
        cls.stop = threading.Event()
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        threading.Thread(target=cls.hub.run, args=(cls.stop,), daemon=True).start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.stop.set()
        cls.httpd.shutdown()
        server._modern_markets, server._modern_runtime, server.trading_status = cls.saved

    def open(self, *paths):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        query = "&".join("p=" + quote(path, safe="") for path in paths)
        conn.request("GET", "/api/stream?" + query)
        response = conn.getresponse()
        response.reader = Reader(response) if response.status == 200 else None
        return conn, response

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", path)
        body = json.loads(conn.getresponse().read())
        conn.close()
        return body

    def test_1_full_value_then_changes_only(self):
        self.wait_empty(8)
        conn, response = self.open(MARKETS, RUNTIME)
        self.assertEqual(response.status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type"))
        first = response.reader.read(2, 3)
        self.assertEqual({m["path"] for m in first}, {MARKETS, RUNTIME}, "a new connection gets every path at once")
        pushed = next(m for m in first if m["path"] == MARKETS)["body"]
        self.assertEqual(fingerprint(pushed), fingerprint(self.get(MARKETS)), "pushed body == polled body")
        self.assertEqual(response.reader.read(1, 0.8), [], "an unchanged source pushes nothing")
        started = time.monotonic()
        self.source.frame += 1
        changed = response.reader.read(1, 2)
        self.assertEqual(changed[0]["path"], MARKETS)
        self.assertEqual(changed[0]["body"]["items"][0]["frame"], self.source.frame)
        self.assertLess(time.monotonic() - started, 0.5, "a change arrives within one collector frame or so")
        response.close()
        conn.close()

    def test_2_slow_source_does_not_delay_others(self):
        conn, response = self.open(MARKETS, RUNTIME)
        response.reader.read(2, 3)
        self.source.runtime_delay = 3.0
        time.sleep(0.4)
        started = time.monotonic()
        self.source.frame += 1
        changed = response.reader.read(1, 2)
        self.assertTrue(changed and changed[0]["path"] == MARKETS, "markets still flows while runtime is stuck")
        self.assertLess(time.monotonic() - started, 0.6)
        self.source.runtime_delay = 0.0
        response.close()
        conn.close()

    def wait_empty(self, seconds):
        deadline = time.monotonic() + seconds
        while self.hub.clients and time.monotonic() < deadline:
            self.source.frame += 1  # a write tells a handler its browser is gone
            time.sleep(0.3)

    def test_3_capacity_and_unsubscribe(self):
        self.wait_empty(8)
        opened = [self.open(MARKETS) for _ in range(3)]
        for _, response in opened:
            self.assertEqual(response.status, 200)
        conn, refused = self.open(MARKETS)
        self.assertEqual(refused.status, 503, "past the cap a browser is refused and keeps polling")
        conn.close()
        for conn, response in opened:
            response.close()
            conn.close()
        self.wait_empty(8)
        self.assertEqual(len(self.hub.clients), 0, "closed browsers are unsubscribed")

    def test_4_unknown_paths_are_ignored(self):
        self.assertEqual(self.hub.valid_paths(["/api/stream", "/etc/passwd", "/api/runtime/commands", MARKETS]), [MARKETS])


class Tokens(unittest.TestCase):
    def test_unchanged_source_is_not_rendered_again(self):
        from dashboard.push import PushHub
        calls, token = [], {"value": 1}
        def render(path):
            calls.append(path)
            return 200, json.dumps({"n": len(calls) if token["value"] == 2 else 0}).encode()
        hub = PushHub(render, token=lambda path: token["value"])
        hub.subscribe(["/api/fills"])
        for _ in range(3):
            hub._render("/api/fills")
        self.assertEqual(len(calls), 1, "an unchanged ledger is not re-rendered")
        token["value"] = 2
        hub._render("/api/fills")
        self.assertEqual(len(calls), 2, "a changed ledger is rendered at once")


if __name__ == "__main__":
    unittest.main()

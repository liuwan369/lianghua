"""Several accounts on one console box (config/accounts.json):

- the file lists distinct ids, labels, colours, ports and agent URLs; no wallet
  or key ever sits in it;
- config/pm-console-nginx.conf routes /acct/<id>/ to that account's port for
  every account, and nothing else to an account port;
- a console instance started for account <id> injects apiBase /acct/<id> and
  its own account into every page, and its / redirect stays under the prefix;
- GET /api/accounts lists every account with this one marked current.

Run:  python scripts/regress/accounts.py
"""
import http.client
import importlib.util
import json
import re
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
ACCOUNTS = json.loads((ROOT / "config" / "accounts.json").read_text(encoding="utf-8"))["accounts"]


def load():
    spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class File(unittest.TestCase):
    def test_accounts_file(self):
        self.assertGreaterEqual(len(ACCOUNTS), 2)
        for key in ("id", "label", "color", "port", "box", "agentUrl"):
            values = [a[key] for a in ACCOUNTS]
            if key not in ("box",):
                self.assertEqual(len(values), len(set(values)), f"{key} is unique")
        for account in ACCOUNTS:
            self.assertRegex(account["id"], r"^[a-z0-9]{1,16}$")
            self.assertRegex(account["color"], r"^#[0-9a-f]{6}$")
            self.assertTrue(account["agentUrl"].startswith("http://127.0.0.1:"), "agents are reached on loopback (tunnel)")
        # An engine box is reached through its tunnel: the account's agent URL
        # is that tunnel's local port (scripts/deploy.py TUNNEL_PORTS).
        spec = importlib.util.spec_from_file_location("deploy", SCRIPTS / "deploy.py")
        deploy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(deploy)
        for account in ACCOUNTS:
            if account["box"] in deploy.TUNNEL_PORTS:
                self.assertEqual(account["agentUrl"], f"http://127.0.0.1:{deploy.TUNNEL_PORTS[account['box']]}",
                                 f"account {account['id']} reaches {account['box']} through its tunnel")
        raw = (ROOT / "config" / "accounts.json").read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"0x[0-9a-fA-F]{40}", raw), "no wallet address in the repo file")
        self.assertNotRegex(raw.lower(), r"key|secret|passphrase")

    def test_nginx_routes_each_account(self):
        conf = (ROOT / "config" / "pm-console-nginx.conf").read_text(encoding="utf-8")
        for account in ACCOUNTS:
            block = re.search(r"location \^~ /acct/%s/ \{(.*?)\n    \}" % account["id"], conf, re.S)
            self.assertIsNotNone(block, f"/acct/{account['id']}/ is routed")
            self.assertIn(f"proxy_pass http://127.0.0.1:{account['port']}/;", block.group(1),
                          "to its own port, prefix stripped")
            stream = re.search(r"location = /acct/%s/api/stream \{(.*?)\n    \}" % account["id"], conf, re.S)
            self.assertIsNotNone(stream, f"account {account['id']}'s push stream is unbuffered")
            self.assertIn("proxy_buffering off;", stream.group(1))
            write = re.search(r"location ~ \^/acct/%s/api/\(runtime/commands\|strategy/\|ledger/reset\) \{(.*?)\n    \}" % account["id"], conf, re.S)
            self.assertIsNotNone(write, f"account {account['id']}'s writes are rate limited")
        ports = {int(p) for p in re.findall(r"proxy_pass http://127\.0\.0\.1:(\d+)", conf)}
        self.assertEqual(ports, {a["port"] for a in ACCOUNTS} | {18766}, "no stray backend")


class Instance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load()
        cls.server.ACCOUNT_ID = ACCOUNTS[1]["id"]
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), cls.server.make_handler(ROOT))
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.port = cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", path)
        response = conn.getresponse()
        value = (response.status, dict(response.getheaders()), response.read())
        conn.close()
        return value

    def test_page_gets_its_prefix_and_account(self):
        status, _, body = self.get("/console/auto-trade.html")
        self.assertEqual(status, 200)
        account = ACCOUNTS[1]
        self.assertIn(f'apiBase:"/acct/{account["id"]}"'.encode(), body)
        self.assertIn(f'account:"{account["id"]}"'.encode(), body)

    def test_root_redirect_stays_under_the_prefix(self):
        status, headers, _ = self.get("/")
        self.assertEqual(status, 302)
        self.assertEqual(headers["Location"], f"/acct/{ACCOUNTS[1]['id']}/console/")

    def test_accounts_list(self):
        status, _, body = self.get("/api/accounts")
        self.assertEqual(status, 200)
        value = json.loads(body)
        self.assertEqual([a["id"] for a in value["accounts"]], [a["id"] for a in ACCOUNTS])
        self.assertEqual(value["current"], ACCOUNTS[1]["id"])
        for item in value["accounts"]:
            self.assertEqual(set(item), {"id", "label", "color", "box"}, "no port or agent URL leaves the box")


if __name__ == "__main__":
    unittest.main()

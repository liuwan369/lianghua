"""Starting binance-lead from the control plane, on the real module.

- the published reversal config (btc-reversal-config.json, revision 22, as on
  the server) is never read: the strategy shows new defaults at revision 0, a
  start is refused until a binance-lead config is saved and published, and the
  old file is left as it was;
- the start command carries --strategy binance-lead and the published
  binance-lead-config.json, which the built engine parses and reads as saved;
- a start names no market: the engine discovers the round itself, so the
  command has no --expected-market-id/--expected-round-id; nothing reads a
  market catalog or collector;
- the same requestId again returns the running state instead of starting twice;
- under systemd the engine runs in its own scope at Nice -5 / CPUWeight 200,
  still exec'd in place (same pid);
- the account's state file keeps its name (btc-reversal-<hash>): the engine
  finds its settlement records at <state>.settlements.json, so a new name
  would orphan an unfinished redemption.

Needs `cd backend/engine && npm run build` first.
Run:  python scripts/regress/lead-start.py
"""
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1]
DIST = SCRIPTS.parent / "backend" / "engine" / "dist"
sys.path.insert(0, str(SCRIPTS))
from dashboard.config import ConfigConflictError  # noqa: E402
from dashboard.strategy_config import default_config  # noqa: E402

WALLET = "0x" + "ab" * 20
ROUND = "1800000000"
REVERSAL = {"schemaVersion": 1, "strategyId": "btc-reversal", "savedRevision": 22, "savedAt": "2026-10-20T00:00:00Z",
            "config": {"assetId": "btc", "triggerPrice": .67, "confirmationPrice": .70, "maxBuyPrice": .70,
                       "stageShares": [5], "maxStages": 1, "roundBudgetUsd": None, "totalBudgetUsd": None,
                       "dailyLossUsd": None, "durationMinutes": 0, "maxRounds": 0, "mode": "live",
                       "maxQuoteAgeSeconds": 2, "maxQuoteSkewSeconds": 1.5, "firstTriggerFromSec": 0}}


def load():
    spec = importlib.util.spec_from_file_location("dashboard_server", SCRIPTS / "system-dashboard-server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Child:
    pid = 4343

    def poll(self):
        return None


class LeadStart(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.engine = root / "backend" / "engine"
        (self.engine / "dist" / "cli").mkdir(parents=True)
        (self.engine / "dist" / "cli" / "platform.js").write_text("", encoding="utf-8")
        (self.engine / "results" / "dashboard").mkdir(parents=True)
        self.old_config = self.engine / "results" / "dashboard" / "btc-reversal-config.json"
        self.old_config.write_text(json.dumps(REVERSAL), encoding="utf-8")
        s = self.server = load()
        s.TRADING_ROOT = self.engine
        s.DEPLOYMENT_LOCK_PATH = root / "data" / "deployment.lock"
        s._trading_state_loaded = True
        s.account_config_status = lambda: {"execution_credentials_ready": True, "account_check_ready": True,
                                           "settlement_credentials_ready": True, "live_start_ready": True,
                                           "wallet": WALLET}
        s._account_values = lambda: {}
        s._remote_orders_empty_from_fresh_snapshot = lambda: False
        s.trade_log_stats = lambda selection=None: {"runtime": None, "projection": {"state": "ready", "stale": False}}
        self.spawned = []
        self.popen = s.subprocess.Popen
        s.subprocess.Popen = lambda args, **kw: self.spawned.append((args, kw)) or Child()
        self.environ = dict(os.environ)
        os.environ["PM_TRADING_LIVE_UNLOCK"] = "1"
        os.environ.pop("INVOCATION_ID", None)

    def tearDown(self):
        self.server.subprocess.Popen = self.popen
        os.environ.clear()
        os.environ.update(self.environ)
        self.tmp.cleanup()

    def start(self, revision, request_id=None):
        return self.server.strategy_control({"action": "start", "strategy_id": "binance-lead", "revision": revision,
                                             "request_id": request_id or str(uuid.uuid4())})

    def publish(self, **changes):
        store = self.server.strategy_config_store()
        config = {**store.get()["config"], **changes}
        draft = store.save_draft(config, store.get()["savedRevision"])
        return store.activate_draft(draft["expectedRevision"], draft["draftId"])

    def test_old_reversal_config_is_not_read_and_blocks_start(self):
        s = self.server
        status = s.strategy_config_status()
        self.assertEqual(status["strategyId"], "binance-lead")
        self.assertEqual(status["savedRevision"], 0, "nothing published for binance-lead yet")
        self.assertEqual(status["config"], default_config())
        self.assertNotIn("triggerPrice", status["config"])
        with self.assertRaises(ConfigConflictError):
            self.start(22)
        with self.assertRaisesRegex(ValueError, "保存并发布 binance-lead 参数"):
            self.start(0)
        self.assertEqual(self.spawned, [], "no engine is started")
        self.assertEqual(json.loads(self.old_config.read_text(encoding="utf-8")), REVERSAL, "the old file is left as it was")

    def test_start_command_runs_binance_lead_with_the_published_config(self):
        published = self.publish(shares=7, maxRounds=3, durationMinutes=30, thresholdBp=2.5)
        self.assertEqual(published["savedRevision"], 1)
        result = self.start(1)
        self.assertTrue(result["running"])
        self.assertEqual(len(self.spawned), 1)
        args, options = self.spawned[0]
        self.assertEqual(args[:3], ["node", "dist/cli/platform.js", "--live"])
        flag = lambda name: args[args.index(name) + 1]
        self.assertEqual(flag("--strategy"), "binance-lead")
        self.assertEqual(flag("--asset"), "btc")
        self.assertEqual(flag("--max-rounds"), "3")
        self.assertEqual(float(flag("--duration-sec")), 30 * 60)
        self.assertNotIn("--expected-market-id", args, "the engine discovers the round itself")
        self.assertNotIn("--expected-round-id", args)
        config_path = Path(flag("--strategy-config"))
        self.assertEqual(config_path.name, "binance-lead-config.json")
        saved = json.loads(config_path.read_text(encoding="utf-8"))
        self.assertEqual((saved["strategyId"], saved["savedRevision"]), ("binance-lead", 1))
        self.assertEqual(saved["config"]["shares"], 7)
        state = Path(flag("--state-file"))
        identity = hashlib.sha256(WALLET.lower().encode()).hexdigest()[:20]
        self.assertEqual(state.name, f"btc-reversal-{identity}.platform-state.json",
                         "the account's state file, and with it <state>.settlements.json, keeps its name")
        self.assertEqual(Path(options["cwd"]), self.engine)
        self.server._process_command = lambda pid: ""
        self.assertEqual(self.server.trading_status(include_stats=False)["strategy_id"], "binance-lead")
        self.server.subprocess.Popen = self.popen
        # The built engine accepts this exact command line and reads the file as saved.
        probe = Path(self.tmp.name) / "probe.mjs"
        probe.write_text(
            "import { pathToFileURL } from 'node:url';\n"
            f"const dist = {json.dumps(str(DIST))};\n"
            "const { parsePlatformOptions, readStrategyConfig } = await import(pathToFileURL(`${dist}/cli/platform.js`).href);\n"
            "const options = parsePlatformOptions(JSON.parse(process.argv[2]));\n"
            "const read = readStrategyConfig(options.strategyConfigFile);\n"
            "console.log(JSON.stringify({ strategy: options.strategy, maxRounds: options.maxRounds,"
            " durationSec: options.durationSec, assetId: options.assetId, config: read.config }));\n", encoding="utf-8")
        done = subprocess.run(["node", str(probe), json.dumps(args[2:])], capture_output=True, text=True,
                              encoding="utf-8", cwd=self.engine, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        engine = json.loads(done.stdout)
        self.assertEqual((engine["strategy"], engine["maxRounds"], engine["durationSec"], engine["assetId"]),
                         ("binance-lead", 3, 1800, "btc"))
        self.assertEqual((engine["config"]["shares"], engine["config"]["thresholdBp"], engine["config"]["revision"]),
                         (7, 2.5, "1"))


    def test_same_request_id_does_not_start_twice(self):
        self.publish()
        request = str(uuid.uuid4())
        self.start(1, request)
        self.server._process_command = lambda pid: ""
        again = self.start(1, request)
        self.assertEqual(len(self.spawned), 1, "a retried request returns the run it started")
        self.assertIn("running", again)
        with self.assertRaisesRegex(ValueError, "UUID"):
            self.start(1, "not-a-uuid")

    def test_refused_without_unlock_or_fresh_account_check(self):
        self.publish()
        os.environ.pop("PM_TRADING_LIVE_UNLOCK")
        with self.assertRaisesRegex(PermissionError, "实盘解锁"):
            self.start(1)
        os.environ["PM_TRADING_LIVE_UNLOCK"] = "1"
        self.server.account_config_status = lambda: {"execution_credentials_ready": True, "account_check_ready": False,
                                                     "settlement_credentials_ready": True, "wallet": WALLET}
        with self.assertRaisesRegex(PermissionError, "账户尚未通过"):
            self.start(1)
        self.assertEqual(self.spawned, [])

    def test_engine_scope_under_systemd(self):
        s = self.server
        args = s._engine_scope_args("/usr/bin/systemd-run", "r1", ["node", "dist/cli/platform.js"])
        self.assertEqual(args[:6], ["/usr/bin/systemd-run", "--scope", "--quiet", "--collect", "--unit=pm-engine-r1", "-p"])
        self.assertEqual(args[6], "CPUWeight=200")
        self.assertEqual(args[7:9], ["nice", "-n"])
        own = os.nice(0) if hasattr(os, "nice") else 0
        self.assertEqual(int(args[9]) + own, -5, "nice -n is relative: the engine lands at -5 whatever the console's Nice")
        self.assertEqual(args[10:14], ["choom", "-n", "-500", "--"])
        self.assertEqual(args[14:], ["node", "dist/cli/platform.js"], "every wrapper execs in place: pid is the engine's")


if __name__ == "__main__":
    unittest.main()

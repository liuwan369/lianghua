"""scripts/deploy.py: what ships, what a sync may never touch, the dirty-worktree
refusal, arguments and the pm-relay unit. No server, no build.

Run:  python scripts/regress/deploy.py
"""
import contextlib
import importlib.util
import io
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("deploy", REPO / "scripts" / "deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
E = "backend/engine/"


class Ships(unittest.TestCase):
    def test_ireland_gets_program_files(self):
        for name in (E + "dist/cli/platform.js", E + "dist/cli/relay.js", E + "package.json", E + "package-lock.json",
                     E + ".env.example", E + ".release", E + "scripts/check-order-path.mjs", "frontend/console/live.js",
                     "frontend/console/shared/stream.js", "scripts/system-dashboard-server.py",
                     "scripts/dashboard/ledger.py", "scripts/deploy.py", "config/pm-console.service"):
            self.assertTrue(deploy.ships(name, "ireland"), name)

    def test_tests_sources_and_runtime_stay_home(self):
        for name in (E + "src/cli/platform.ts", E + "tsconfig.json", E + "scripts/regress/P0-1.mjs",
                     "scripts/regress/deploy.py", "scripts/regress/fixtures/official-20261001.json",
                     "frontend/console/regress/pages.mjs", "scripts/__pycache__/backtest.cpython-314.pyc",
                     E + "node_modules/ws/index.js", E + "results/dashboard/ledger.sqlite3", E + ".env", "data/x"):
            self.assertFalse(deploy.ships(name, "ireland"), name)

    def test_tokyo_gets_only_engine_runtime(self):
        self.assertTrue(deploy.ships(E + "dist/cli/relay.js", "tokyo"))
        self.assertTrue(deploy.ships(E + "package-lock.json", "tokyo"))
        for name in ("frontend/console/live.js", "scripts/system-dashboard-server.py", "config/pm-relay.service",
                     E + ".env.example", E + "scripts/check-order-path.mjs"):
            self.assertFalse(deploy.ships(name, "tokyo"), name)


class Protected(unittest.TestCase):
    RUNTIME = (E + "results/dashboard/ledger.sqlite3", E + "results/live/x.jsonl", E + "node_modules/ws/index.js",
               E + ".env", "config/dashboard-secret.env", E + ".env.local", "data/dashboard/deployment.lock",
               "scripts/dashboard/__pycache__/push.cpython-311.pyc", E + "dist/node_modules/x.js")

    def test_runtime_paths_are_protected(self):
        for name in self.RUNTIME:
            self.assertTrue(deploy.protected(name), name)
        for name in (E + ".env.example", E + "dist/results.js", "scripts/dashboard/push.py"):
            self.assertFalse(deploy.protected(name), name)

    def test_sync_never_deletes_runtime_data(self):
        sweep = deploy.TARGETS["ireland"]["sweep"] + (E, "data/", "")
        existing = {name: "old" for name in self.RUNTIME + ("scripts/old-helper.py", E + "dist/old.js")}
        write, delete = deploy.plan({E + "dist/new.js": "n"}, existing, sweep)
        self.assertEqual(write, [E + "dist/new.js"])
        self.assertEqual(delete, [E + "dist/old.js", "scripts/old-helper.py"])

    def test_only_swept_prefixes_are_deleted(self):
        existing = {"frontend/console/old.js": "x", E + "dist/old.js": "x", E + "package.json": "same"}
        write, delete = deploy.plan({E + "package.json": "same"}, existing, deploy.TARGETS["tokyo"]["sweep"])
        self.assertEqual((write, delete), ([], [E + "dist/old.js"]))

    def test_release_may_not_carry_runtime_data(self):
        with self.assertRaises(ValueError):
            deploy.plan({E + "results/dashboard/ledger.sqlite3": "x"}, {}, ())

    def test_installed_walk_skips_protected_dirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("scripts/a.py", "scripts/dashboard/__pycache__/a.pyc", E + "dist/node_modules/x.js",
                         E + "dist/cli/relay.js", E + "results/r.json", "config/dashboard-secret.env"):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text("x")
            found = deploy.installed(root, {E + "package.json": "x"}, deploy.TARGETS["ireland"]["sweep"])
            self.assertEqual(sorted(found), ["backend/engine/dist/cli/relay.js", "config/dashboard-secret.env", "scripts/a.py"])
            self.assertEqual(deploy.plan({}, found, deploy.TARGETS["ireland"]["sweep"])[1],
                             ["backend/engine/dist/cli/relay.js", "scripts/a.py"])


class Refusals(unittest.TestCase):
    def git(self, root, *args):
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], cwd=root, check=True, capture_output=True)

    def test_dirty_worktree_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.git(root, "init", "-q")
            (root / "config").mkdir()
            (root / "config/pm-console.service").write_text("a")
            (root / "notes.txt").write_text("a")
            self.git(root, "add", ".")
            self.git(root, "commit", "-qm", "x")
            self.assertEqual(deploy.dirty(root), [])
            (root / "notes.txt").write_text("outside deployed paths")
            self.assertEqual(deploy.dirty(root), [])
            (root / "config/pm-console.service").write_text("b")
            (root / "scripts").mkdir()
            (root / "scripts/new.py").write_text("untracked")
            self.assertEqual(len(deploy.dirty(root)), 2)
            saved, deploy.ROOT = deploy.ROOT, root
            try:
                with self.assertRaises(SystemExit) as refused:
                    deploy.main(["ireland"])
                self.assertIn("uncommitted changes", str(refused.exception))
            finally:
                deploy.ROOT = saved

    def test_engine_running(self):
        self.assertIsNone(deploy.engine_running("", "", {"processRunning": False}))
        self.assertIsNone(deploy.engine_running("\n", "", None))   # console down, no unit, no process
        self.assertIn("pm-engine-abc.scope", deploy.engine_running("pm-engine-abc.scope loaded active running x\n", "", None))
        self.assertIn("4242", deploy.engine_running("", "4242\n", {"processRunning": False}))
        self.assertIsNotNone(deploy.engine_running("", "", {"processRunning": True}))
        self.assertIsNotNone(deploy.engine_running("", "", {"processRunning": None}))


class Arguments(unittest.TestCase):
    def test_parse(self):
        args = deploy.parse_args([])
        self.assertEqual((args.target, args.dry_run, args.wait_status), ("all", False, False))
        args = deploy.parse_args(["--dry-run", "tokyo", "--wait-status"])
        self.assertEqual((args.target, args.dry_run, args.wait_status), ("tokyo", True, True))
        for target in ("ireland", "setup-ireland", "setup-tokyo"):
            self.assertEqual(deploy.parse_args([target]).target, target)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            deploy.parse_args(["pm-new"])

    def test_setup_prints_no_secret_values(self):
        text = deploy.SETUP["setup-ireland"] + deploy.SETUP["setup-tokyo"] + deploy.SETUP["setup-engine"]
        self.assertIn("openssl rand -hex 32 > /root/.config/pm-system/relay.key", text)
        self.assertIn("scp -3 pm-ire:/root/.config/pm-system/relay.key pm-tokyo:/root/.config/pm-system/relay.key", text)
        self.assertIn("SHASUMS256.txt | sha256sum -c -", text)
        self.assertNotIn("cat /root/.config/pm-system/relay.key", text)


class EngineBoxes(unittest.TestCase):
    """One engine box per account (pm-a, pm-b): the agent and the engine only."""

    def test_targets(self):
        for name, host in (("engine-a", "pm-a"), ("engine-b", "pm-b")):
            t = deploy.TARGETS[name]
            self.assertEqual((t["host"], t["root"], t["box"]), (host, "/root/pm-system", host))
            self.assertEqual(t["units"], ("pm-agent.service",), "an engine box runs no console")
            self.assertEqual(set(t["system"]), {"/etc/systemd/system/pm-agent.service"})
            self.assertEqual(deploy.parse_args([name]).target, name)
        self.assertNotIn("engine-a", deploy.ALL_TARGETS, "an engine box is never part of `all` by accident")

    def test_ships_the_agent_and_engine_but_no_console(self):
        for name in (E + "dist/cli/platform.js", E + "dist/cli/account-data.js", "scripts/engine_agent.py",
                     "scripts/dashboard/account_data.py", "scripts/dashboard/strategy_config.py",
                     "scripts/dashboard_account.py", "config/pm-agent.service"):
            self.assertTrue(deploy.ships(name, "engine-a"), name)
        for name in ("frontend/console/live.js", "scripts/system-dashboard-server.py", "config/pm-console-nginx.conf",
                     "config/pm-console@.service", "config/accounts.json", "scripts/dashboard/ledger.py"):
            self.assertFalse(deploy.ships(name, "engine-a"), name)

    def test_box_guard(self):
        """A release names its box; the box says who it is in /root/.config/pm-system/box-id."""
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "box-id"
            with self.assertRaisesRegex(SystemExit, "no box id"):
                deploy.check_box("pm-a", marker)
            marker.write_text("pm-b\n")
            with self.assertRaisesRegex(SystemExit, "pm-b"):
                deploy.check_box("pm-a", marker)
            marker.write_text("pm-a\n")
            deploy.check_box("pm-a", marker)

    def test_tunnel(self):
        """pm-ire reaches each engine box's agent through ssh -L; the key can only forward that port."""
        unit = (REPO / "config" / "pm-tunnel@.service").read_text(encoding="utf-8")
        self.assertIn("ExecStart=/usr/bin/ssh -N -F /root/.ssh/tunnels.config %i", unit)
        self.assertIn("Restart=always", unit)
        for account, (host, port) in {"a": ("pm-a", 18777), "b": ("pm-b", 18787)}.items():
            line = deploy.tunnel_authorized_key("ssh-ed25519 AAAAkey pm-ire-tunnel")
            self.assertTrue(line.startswith('restrict,port-forwarding,permitopen="127.0.0.1:18767",command="/bin/false" '), line)
            config = deploy.tunnel_config({host: (port, "1.2.3.4")})
            self.assertIn(f"LocalForward 127.0.0.1:{port} 127.0.0.1:18767", config)
            self.assertIn("ExitOnForwardFailure yes", config)
            self.assertIn(f"HostKeyAlias {host}", config, "an IP change does not break the host key")


class RelayUnit(unittest.TestCase):
    def test_unit_text(self):
        text = (REPO / "config/pm-relay.service").read_text(encoding="utf-8")
        lines = {line.split("=", 1)[0]: line.split("=", 1)[1] for line in text.splitlines() if "=" in line and not line.startswith("#")}
        self.assertEqual(lines["ExecStart"], "/usr/local/bin/node /root/pm-relay/backend/engine/dist/cli/relay.js")
        self.assertEqual(lines["EnvironmentFile"], "/root/.config/pm-system/relay.env")
        self.assertEqual((lines["Restart"], lines["RestartSec"], lines["Nice"]), ("always", "2", "-5"))
        self.assertEqual((lines["NoNewPrivileges"], lines["ProtectSystem"]), ("true", "full"))
        self.assertEqual(deploy.TARGETS["tokyo"]["system"], {"/etc/systemd/system/pm-relay.service": "config/pm-relay.service"})


if __name__ == "__main__":
    unittest.main()

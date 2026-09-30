"""BUGS.md P1-11: the deploy cleanup deleted every untracked file under config/.

The remote script swept config/ like a program directory, so an operator file
such as config/dashboard-secret.env (referenced by the dashboard unit's
EnvironmentFile=) was unlinked by the next successful deploy.

This runs the real sweep block of REMOTE_SCRIPT against a temp tree. Importing
deploy-reversal-release.py would run git and a build, so the block is cut out
of the source text between its first and last statements.

Run:  python scripts/regress/P1-11.py
"""
import ast
import tempfile
import unittest
from pathlib import Path

SOURCE = (Path(__file__).resolve().parents[1] / "deploy-reversal-release.py").read_text(encoding="utf-8")


def remote_script() -> str:
    for node in ast.parse(SOURCE).body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", None) == "REMOTE_SCRIPT":
            return node.value.value
    raise AssertionError("REMOTE_SCRIPT not found")


def sweep_block() -> str:
    script = remote_script()
    start = script.index("obsolete=set(manifest.get('removed',[]))")
    end = script.index("\n", script.index("obsolete=sorted("))
    return script[start:end]


def run_sweep(root: Path, files: dict, removed=()) -> list:
    manifest = {"files": {name: "x" for name in files}, "removed": list(removed),
                "generatedPrefixes": ["backend/engine/dist/"]}
    for name in files:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("tracked")
    scope = {"root": root, "manifest": manifest,
             "checked_target": lambda name: (root / name).resolve(),
             "unit_names": {}}
    exec(sweep_block(), scope)
    return scope["obsolete"]


class P1_11(unittest.TestCase):
    TRACKED = {"config/pm-system-dashboard-dublin.service": 1, "scripts/system-dashboard-server.py": 1,
               "backend/engine/dist/index.js": 1}

    def test_bug_untracked_config_file_survives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            secret = root / "config/dashboard-secret.env"
            secret.parent.mkdir(parents=True)
            secret.write_text("TOKEN=placeholder")
            obsolete = run_sweep(root, self.TRACKED)
            self.assertNotIn("config/dashboard-secret.env", obsolete)

    def test_control_stale_program_files_still_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ("scripts/old-helper.py", "backend/engine/dist/old.js"):
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_text("stale")
            obsolete = run_sweep(root, self.TRACKED)
            self.assertIn("scripts/old-helper.py", obsolete)
            self.assertIn("backend/engine/dist/old.js", obsolete)

    def test_edge_config_file_git_deleted_is_still_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            old = root / "config/retired.conf"
            old.parent.mkdir(parents=True)
            old.write_text("was tracked")
            obsolete = run_sweep(root, self.TRACKED, removed=["config/retired.conf"])
            self.assertIn("config/retired.conf", obsolete)


if __name__ == "__main__":
    unittest.main()

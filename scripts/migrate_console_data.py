"""One-time move of the console's data out of the engine's results/ (the
console/engine split, 2026-11-21). Idempotent; copies, never deletes.

On the box that runs both today (pm-ire), the console's ledger, projection
files and run selection lived in backend/engine/results/{dashboard,dashboard-state.json}
beside the engine's journals. After the split:
- the console keeps data/console/ (ledger.sqlite3 and its projection files,
  replica/ with byte copies of the journals, selection-run.json);
- the engine agent keeps backend/engine/results/ (journals, account state, the
  published config, engine-run.json).

The ledger registers each run with its journal's absolute path, so the copied
ledger's paths are rewritten to the replica copies (same bytes, so the ledger's
offsets and fingerprints still hold). The old files stay where they are as
the rollback.

  python3 scripts/migrate_console_data.py --root /root/pm-system
"""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from pathlib import Path


def migrate(root: Path) -> dict:
    results = root / "backend" / "engine" / "results"
    console = root / "data" / "console"
    replica = console / "replica"
    report = {"ledger": False, "replicas": [], "selection": None, "engine_run": False, "rewritten": 0}
    replica.mkdir(parents=True, exist_ok=True)

    # 1. The ledger and its projection snapshot, once.
    ledger = console / "ledger.sqlite3"
    source = results / "dashboard" / "ledger.sqlite3"
    if not ledger.exists() and source.exists():
        with sqlite3.connect(source) as src, sqlite3.connect(ledger) as dst:
            src.backup(dst)   # a consistent copy even with a WAL beside it
        report["ledger"] = True

    # 2. Every journal the ledger knows, copied byte for byte into replica/,
    #    and the ledger's paths pointed at the copies.
    if ledger.exists():
        with sqlite3.connect(ledger) as db:
            for run_id, path in db.execute("SELECT run_id, path FROM runs").fetchall():
                original = Path(path)
                target = replica / original.name
                if original.parent == replica:
                    continue
                if original.is_file() and not target.exists():
                    shutil.copyfile(original, target)
                    report["replicas"].append(target.name)
                db.execute("UPDATE runs SET path=? WHERE run_id=?", (str(target.resolve()), run_id))
                report["rewritten"] += 1

    # 3. The selected run: the console follows the agent from now on, but keeps
    #    the last run selected until the agent reports a newer one.
    state = results / "dashboard-state.json"
    selection = console / "selection-run.json"
    if state.exists() and not selection.exists():
        old = json.loads(state.read_text(encoding="utf-8"))
        if isinstance(old.get("run_id"), str):
            value = {"run_id": old["run_id"], "account_id": old.get("account_id"),
                     "config_revision": old.get("config_revision"), "mode": "live"}
            selection.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            report["selection"] = value["run_id"]

    # 4. The agent's run state takes the console's old file over (same fields).
    engine_run = results / "engine-run.json"
    if state.exists() and not engine_run.exists():
        shutil.copyfile(state, engine_run)
        report["engine_run"] = True
    return report


def migrate_account_one(root: Path) -> dict:
    """Per-account consoles keep data/console-<id>. The single console of the
    first split (data/console) becomes account 1: renamed in place (same disk,
    so the replicas keep their bytes) and the ledger's run paths rewritten."""
    old, new = root / "data" / "console", root / "data" / "console-1"
    if not old.is_dir() or new.exists():
        return {"moved": False, "rewritten": 0}
    old.rename(new)
    rewritten = 0
    ledger = new / "ledger.sqlite3"
    if ledger.exists():
        with sqlite3.connect(ledger) as db:
            for run_id, path in db.execute("SELECT run_id, path FROM runs").fetchall():
                target = new / "replica" / Path(path).name
                if Path(path).parent.resolve() == (old / "replica").resolve():
                    db.execute("UPDATE runs SET path=? WHERE run_id=?", (str(target.resolve()), run_id))
                    rewritten += 1
    return {"moved": True, "rewritten": rewritten}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()
    root = Path(args.root).resolve()
    print(json.dumps({"split": migrate(root), "account_one": migrate_account_one(root)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Second audit, journal growth: run journals were never removed (69-113 MB/h
while trading; 52 GB fills in 20-31 days of nonstop running).

Checks the real prune_run_journals: only the newest runs' files stay, shared
settlement and platform-state files are never touched, and a pruned run that
was fully read does not mark account-wide statistics stale.
Run:  python scripts/regress/journal-retention.py
"""
import importlib.util, os, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("server", ROOT / "scripts" / "system-dashboard-server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

with tempfile.TemporaryDirectory() as tmp:
    live = Path(tmp)
    for i in range(25):
        for suffix in (".jsonl", ".console.log", ".control.json"):
            path = live / f"dashboard-2026100{i % 10}-{i:06d}-abc{i:02d}{suffix}"
            path.write_text("x")
            os.utime(path, (1_790_000_000 + i, 1_790_000_000 + i))
    shared = [live / "btc-reversal-c284.platform-state.json", live / "btc-reversal-c284.platform-state.json.settlements.json",
              live / "dashboard-20260925-104129-1579.platform-state.json.settlements.json"]
    for path in shared:
        path.write_text("{}")
    archive = live.parent / f"{live.name}-archive"
    assert server.RUN_JOURNALS_KEPT == 3, "the box keeps the newest 3 runs raw (2026-11-13)"
    removed = server.prune_run_journals(live, 3, archive)
    runs = {p.name.split(".", 1)[0] for p in live.glob("dashboard-*.jsonl")}
    assert len(runs) == 3, f"keeps the newest 3 runs; kept {len(runs)}"
    assert "dashboard-20261004-000024-abc24" in runs and "dashboard-20261000-000000-abc00" not in runs, "the oldest go first"
    assert len(removed) == 66, f"all files of the 22 oldest runs leave the live directory; removed {len(removed)}"
    assert all(path.exists() for path in shared), "settlement records and platform state are never pruned"
    # Nothing is lost: each moved run is one gzip'd tar in the archive, with all its files.
    import tarfile
    packs = sorted(archive.glob("dashboard-*.tar.gz"))
    assert len(packs) == 22, f"one archive per old run; got {len(packs)}"
    with tarfile.open(archive / "dashboard-20261000-000000-abc00.tar.gz") as pack:
        assert sorted(pack.getnames()) == sorted(f"dashboard-20261000-000000-abc00{s}" for s in (".jsonl", ".console.log", ".control.json"))
        assert pack.extractfile("dashboard-20261000-000000-abc00.jsonl").read() == b"x"
    assert not list(archive.glob("*.part")), "no half-written archive is left"

# A pruned, fully-read run is final, not stale.
import dashboard.ledger as ledger_module
with tempfile.TemporaryDirectory() as tmp:
    journal = Path(tmp) / "dashboard-run1.jsonl"
    journal.write_text("")
    led = ledger_module.Ledger(Path(tmp) / "ledger.sqlite3")
    led.register_run("run1", "live", "0xabc", str(journal), None)
    with led._connect() as db:
        db.execute("UPDATE runs SET byte_offset=100 WHERE run_id='run1'")
    journal.unlink()
    summary = led.metrics_summary("run1", range="all")
    assert summary.get("completeness") == "caught_up" and summary.get("error") is None,         f"a pruned run does not make the account stats incomplete; got {summary.get('completeness')}, {summary.get('error')}"
print("journal-retention OK")

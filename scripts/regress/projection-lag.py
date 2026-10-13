"""A projection a line behind the journal is current, not stale (2026-10-13).

The engine appends a status line every 2 s and the projection reads every
0.25 s, so it is a line behind about 14 % of the time. Rounds, fills,
settlements, statistics and the position all reported "stale" whenever ANY
byte was unread, and the console blanked them as 成交回报待确认 / 结算记录待确认
every few seconds. Stale now means the unread bytes have been waiting longer
than the runtime freshness window (10 s), or the source is broken.

Run:  python scripts/regress/projection-lag.py
"""
import json, os, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import dashboard.ledger as ledger_module  # noqa: E402

FILL = {"event": "fill", "recv_ts": 0, "event_id": "f1", "trade_id": "t1", "market_id": "0xm", "round_id": "1800000000",
        "asset_id": "eth", "side": "DOWN", "token_id": "1", "shares": 5, "price": 0.7, "trade_status": "CONFIRMED"}


def setup(tmp):
    journal = Path(tmp) / "dashboard-run1.jsonl"
    journal.write_text(json.dumps(FILL) + "\n")
    led = ledger_module.Ledger(Path(tmp) / "ledger.sqlite3")
    led.register_run("run1", "live", "0xabc", str(journal), 23)
    led.ingest("run1")
    return journal, led


def stale_views(led):
    rounds = led.metadata("run1")
    stats = led.metrics_summary("run1", range="all")
    return {"metadata": rounds["stale"], "statistics": stats["completeness"] != "caught_up"}


with tempfile.TemporaryDirectory() as tmp:
    journal, led = setup(tmp)
    assert not any(stale_views(led).values()), f"fully read is current: {stale_views(led)}"

    # --- bug: one fresh line not read yet made every view stale ---
    with journal.open("a") as out:
        out.write(json.dumps({**FILL, "event_id": "f2", "trade_id": "t2"}) + "\n")
    views = stale_views(led)
    assert not any(views.values()), f"a line written a moment ago is not stale: {views}"

    # --- still stale when the unread bytes have waited past the window ---
    old = time.time() - ledger_module.RUNTIME_MAX_AGE - 5
    os.utime(journal, (old, old))
    views = stale_views(led)
    assert all(views.values()), f"unread for longer than {ledger_module.RUNTIME_MAX_AGE} s is stale: {views}"

    # --- a fresh but large backlog (catching up after a restart) is stale too ---
    led.ingest("run1")
    with journal.open("a") as out:
        out.write(json.dumps({**FILL, "event_id": "f3", "trade_id": "t3", "pad": "x" * ledger_module.CURRENT_LAG_BYTES}) + "\n")
    views = stale_views(led)
    assert all(views.values()), f"more than one read pass behind is stale even if just written: {views}"

    # --- reading it clears it ---
    led.ingest("run1")
    assert not any(stale_views(led).values()), "caught up again"

    # --- a broken source is stale however fresh ---
    with led._connect() as db:
        db.execute("UPDATE runs SET source_error='x' WHERE run_id='run1'")
    assert all(stale_views(led).values()), "a source error is always stale"

# --- 2026-10-10 server move: a journal copied to a new disk keeps its bytes but
# gets a new inode. It was flagged "replaced or rewritten" for good, so the
# account statistics read 统计待核对 ever since. Same content is the same journal. ---
with tempfile.TemporaryDirectory() as tmp:
    journal, led = setup(tmp)
    data = journal.read_bytes()
    journal.unlink()
    journal.write_bytes(data)                      # same bytes, new inode
    led.ingest("run1")
    with led._connect() as db:
        error = db.execute("SELECT source_error FROM runs WHERE run_id='run1'").fetchone()[0]
    assert error is None, f"a copied journal is not a rewrite: {error}"
    assert not any(stale_views(led).values()), "and its statistics are current"

    # --- an already flagged copy (the server's 10-02 run) is cleared on the next read ---
    with led._connect() as db:
        db.execute("UPDATE runs SET source_error=?, source_identity='1:1' WHERE run_id='run1'", (ledger_module.JOURNAL_REWRITTEN,))
    led.ingest("run1")
    assert not any(stale_views(led).values()), "a stale rewrite flag on unchanged content clears"

    # --- a real rewrite is still caught ---
    journal.write_bytes(b"x" * len(data))
    led.ingest("run1")
    with led._connect() as db:
        error = db.execute("SELECT source_error FROM runs WHERE run_id='run1'").fetchone()[0]
    assert error == ledger_module.JOURNAL_REWRITTEN, f"different content is a rewrite: {error}"
print("projection-lag OK")

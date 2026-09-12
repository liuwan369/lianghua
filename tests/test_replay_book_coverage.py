import importlib.util
import json
import sqlite3
import subprocess
import sys
import zlib
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/pm-r26-historical-shadow-replay.py"
SPEC = importlib.util.spec_from_file_location("replay_coverage", SCRIPT)
replay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(replay)
META = {"slug": "btc-updown-5m-1788739200", "start_at": 1788739200, "end_at": 1788739500,
        "condition_id": "condition", "up_token": "11", "down_token": "22"}


def test_atomic_delta_cannot_hedge_against_an_ask_removed_in_same_message():
    def setup():
        engine = replay.MakerShadowEngine(order_size=10, taker_hedge_after_ms=10_000, max_taker_pair_cost=1.03)
        engine.start_market({**META, "market_id": "condition"})
        books = {
            "11": {"bids": [{"price": "0.4", "size": "100"}], "asks": [{"price": "0.5", "size": "100"}]},
            "22": {"bids": [{"price": "0.39", "size": "100"}], "asks": [{"price": "0.6", "size": "100"}]},
        }
        for token, book in books.items():
            engine.update_book(token, dict(book), META["start_at"] * 1000, refresh=False)
        engine.market.inventory["Down"] = 10
        engine.market.cost["Down"] = 4
        engine.market.first_unpaired_at_ms = META["start_at"] * 1000
        state = {"meta": META, "coverage_by_token": {}, "books": books, "engines": {"hedger": engine}}
        return engine, {META["slug"]: state}

    changes = [["22", "0.39", "12", "BUY"], ["11", "0.5", "0", "SELL"], ["11", "0.9", "100", "SELL"]]
    source_ms = (META["start_at"] + 20) * 1000
    mapping = {"11": (META["slug"], "Up"), "22": (META["slug"], "Down")}
    engine, states = setup()
    replay.apply_price_change_message(states, mapping, [str(source_ms), changes], source_ms, source_ms * 1_000_000)
    assert engine.market.taker_hedges == 0
    assert engine.market.inventory["Up"] == 0
    assert engine.market.cost["Up"] == 0

    # Separate messages at the same time retain their own decision boundaries.
    engine, states = setup()
    replay.apply_price_change_message(states, mapping, [str(source_ms), changes[:1]], source_ms, source_ms * 1_000_000)
    replay.apply_price_change_message(states, mapping, [str(source_ms), changes[1:]], source_ms, source_ms * 1_000_000)
    assert engine.market.taker_hedges == 1
    assert engine.market.inventory["Up"] == 10


def observe(tokens, token, second, kind="book", delay=0):
    source_ms = (META["start_at"] + second) * 1000
    replay.observe_book_coverage(tokens, token, kind, source_ms, (source_ms + delay) * 1_000_000)


def test_other_side_cannot_hide_missing_tail_or_internal_gap():
    tokens = {}
    for second in range(0, 301, 30):
        observe(tokens, "11", second)
        if second in (0, 30, 60, 180):
            observe(tokens, "22", second)
    result = replay.market_book_coverage(META, tokens)
    assert not result["complete_5m_window"]
    assert result["sides"]["Up"]["complete"]
    assert set(result["sides"]["Down"]["reasons"]) == {"missing_tail", "book_receive_gap"}


def test_trades_and_deltas_cannot_replace_initial_book():
    tokens = {}
    for second in range(0, 301, 30):
        observe(tokens, "11", second)
        observe(tokens, "22", second, "last_trade_price")
        observe(tokens, "22", second, "price_change")
    assert replay.market_book_coverage(META, tokens)["sides"]["Down"]["reasons"] == ["missing_initial_book"]


def test_late_received_initial_book_is_not_complete_despite_source_time():
    tokens = {}
    for second in range(0, 301, 30):
        observe(tokens, "11", second)
        observe(tokens, "22", second, delay=31_000)
    assert replay.market_book_coverage(META, tokens)["sides"]["Down"]["reasons"] == ["late_initial_book"]


def test_boundary_and_gap_tolerance_apply_per_side():
    tokens = {}
    for token in ("11", "22"):
        for second in range(30, 271, 60):
            observe(tokens, token, second, "book" if second == 30 else "price_change")
    assert replay.market_book_coverage(META, tokens)["complete_5m_window"]


def test_replay_summary_and_market_details_use_same_coverage(tmp_path):
    db = tmp_path / "capture.sqlite3"
    out = tmp_path / "report.json"
    with sqlite3.connect(db) as conn:
        conn.executescript("CREATE TABLE events(source TEXT, event_type TEXT, payload_json TEXT);"
                           "CREATE TABLE event_chunks(id INTEGER PRIMARY KEY, source TEXT, received_second INTEGER, payload_blob BLOB);")
        conn.execute("INSERT INTO events VALUES(?,?,?)", ("gamma", "market_metadata", json.dumps(META)))
        for second in range(0, 301, 30):
            timestamp = META["start_at"] + second
            rows = [["book", timestamp * 1_000_000_000, timestamp * 1000, META["slug"], "11",
                     [timestamp * 1000, [["0.4", "100"]], [["0.6", "100"]], "0.01"]]]
            if second == 0:
                rows.append([*rows[0][:4], "22", rows[0][-1]])
            conn.execute("INSERT INTO event_chunks(source,received_second,payload_blob) VALUES(?,?,?)",
                         ("clob", timestamp, zlib.compress(json.dumps(rows).encode())))
    result = subprocess.run([sys.executable, str(SCRIPT), "--sqlite", str(db), "--history-dir", str(tmp_path),
                             "--out", str(out)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    report = json.loads(out.read_text(encoding="utf-8"))
    assert report["coverage"]["complete_markets"] == 0
    assert report["coverage"]["excluded_markets"] == [META["slug"]]
    for name, summary in report["summary"].items():
        assert summary["complete_markets"] == 0
        assert summary["simulated_official_settlement_pnl_usdc"] is None
        assert not report["markets"][name][0]["snapshot"]["coverage"]["complete_5m_window"]

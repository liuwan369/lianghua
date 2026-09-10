from __future__ import annotations

import json
from contextlib import closing
import sqlite3
import sys
import zlib
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dashboard.market_snapshot import MarketSnapshot, iso, publish_snapshot, validate_snapshot

NOW = 1_800_000_000.


@pytest.fixture
def projection(tmp_path, monkeypatch):
    path = tmp_path / "dublin-evidence-2027.sqlite3"
    create_db(path)
    monkeypatch.setattr(MarketSnapshot, "_service", lambda _: "active")
    return MarketSnapshot(tmp_path, "dublin-evidence-*.sqlite3", "test.service", "都柏林节点"), path


def create_db(path):
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript("""
        CREATE TABLE events(id INTEGER PRIMARY KEY,source TEXT,event_type TEXT,received_at_ns INTEGER,payload_json TEXT);
        CREATE TABLE event_chunks(source TEXT,received_second INTEGER,event_count INTEGER,codec TEXT,payload_blob BLOB,UNIQUE(source,received_second));
        CREATE INDEX idx_chunks_source_second ON event_chunks(source,received_second);
        CREATE TABLE health(id INTEGER PRIMARY KEY,recorded_at TEXT,queue_depth INTEGER,counters_json TEXT,source_status_json TEXT);
        """)
        db.execute("INSERT INTO health VALUES(1,?,0,'{}','{}')", (iso(NOW),))
        metadata = {"slug": "btc-test", "up_token": "up", "down_token": "down", "start_at": NOW-100, "end_at": NOW+200}
        db.execute("INSERT INTO events VALUES(1,'gamma','market_metadata',?,?)", (int(NOW*1e9), json.dumps(metadata)))


def book(token="up", at=NOW-2, bid=.4, ask=.5, source=None):
    return ["book", int(at*1e9), source, "btc-test", token, [None, [] if bid is None else [[bid, 5]], [] if ask is None else [[ask, 5]]]]


def chunk(path, second, rows):
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("INSERT INTO event_chunks VALUES('clob',?,?,'zlib-json-v2',?) ON CONFLICT(source,received_second) DO UPDATE SET event_count=excluded.event_count,payload_blob=excluded.payload_blob", (int(second), len(rows), zlib.compress(json.dumps(rows).encode())))


def market(reader, now=NOW):
    return reader.snapshot(now)["current_markets"][0]


def test_warm_poll_has_zero_decode_and_replay(projection):
    reader, path = projection
    chunk(path, NOW-2, [book(), book("down")])
    first = reader.snapshot(NOW)
    before = dict(reader.metrics)
    second = reader.snapshot(NOW)
    assert second["current_markets"] == first["current_markets"]
    assert reader.metrics["chunks_decoded"] == before["chunks_decoded"] == 1
    assert reader.metrics["events_applied"] == before["events_applied"] == 2
    chunk(path, NOW-1, [book(at=NOW-1, ask=.6)])
    assert market(reader)["up_ask"] == .6
    assert reader.metrics["chunks_decoded"] == 2
    assert reader.metrics["events_applied"] == 3


def test_same_second_append_and_same_length_replacement_are_detected(projection):
    reader, path = projection
    rows = [book(), book("down")]
    chunk(path, NOW-2, rows)
    assert market(reader)["up_ask"] == .5
    rows.append(book(at=NOW-1, ask=.6))
    chunk(path, NOW-2, rows)
    assert market(reader)["up_ask"] == .6
    assert reader.metrics["events_applied"] == 3
    rows[-1] = book(at=NOW-1, ask=.7)
    chunk(path, NOW-2, rows)
    assert market(reader)["up_ask"] == .7
    assert reader.metrics["correction_replays"] == 1


def test_late_chunk_insert_replays_in_time_order(projection):
    reader, path = projection
    chunk(path, NOW-1, [book(at=NOW-1, ask=.7), book("down")])
    assert market(reader)["up_ask"] == .7
    chunk(path, NOW-3, [book(at=NOW-3, ask=.3)])
    assert market(reader)["up_ask"] == .7
    assert reader.metrics["correction_replays"] == 1


def test_deleted_chunk_and_table_truncation_clear_quotes(projection):
    reader, path = projection
    chunk(path, NOW-2, [book(), book("down")])
    assert market(reader)["up_ask"] == .5
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("DELETE FROM event_chunks")
    assert market(reader)["up_ask"] is None
    assert market(reader)["quote_at"] is None


def test_day_roll_and_same_path_database_replacement_reset(projection):
    reader, path = projection
    chunk(path, NOW-2, [book(), book("down")])
    assert market(reader)["up_ask"] == .5
    new = path.with_name("dublin-evidence-2028.sqlite3")
    create_db(new)
    assert market(reader)["up_ask"] is None
    chunk(new, NOW-1, [book(ask=.8), book("down")])
    assert market(reader)["up_ask"] == .8
    replacement = path.with_name("replacement.sqlite3")
    create_db(replacement)
    replacement.replace(new)
    assert market(reader)["up_ask"] is None
    assert reader.metrics["database_resets"] == 3


def test_empty_book_and_bbo_clear_side_and_old_bbo_does_not_override_depth(projection):
    reader, path = projection
    rows = [book(source=(NOW-2)*1000), book("down"), ["best_bid_ask", int((NOW-1)*1e9), (NOW-3)*1000, "btc-test", "up", [None, .1, .2]]]
    chunk(path, NOW-2, rows)
    assert market(reader)["up_ask"] == .5
    rows.append(["best_bid_ask", int(NOW*1e9), NOW*1000, "btc-test", "up", [None, .4, None]])
    chunk(path, NOW-2, rows)
    assert market(reader)["up_ask"] is None
    rows.append(book(at=NOW+1, bid=None, ask=None, source=(NOW+1)*1000))
    chunk(path, NOW-2, rows)
    assert market(reader, NOW+1)["up_bid"] is None


def test_multi_token_delta_without_parent_token_updates_both_sides(projection):
    reader, path = projection
    rows = [book(), book("down"), ["price_change", int((NOW-1)*1e9), None, None, None, [None, [["up", .5, 0, "SELL", .4, .6], ["down", .5, 0, "SELL", .4, .7]]]]]
    chunk(path, NOW-2, rows)
    value = market(reader)
    assert value["up_ask"] == .6
    assert value["down_ask"] == .7


def test_bbo_does_not_synthesize_depth_and_trade_cannot_refresh_quote(projection):
    reader, path = projection
    rows = [book(), book("down", at=NOW-10), ["best_bid_ask", int((NOW-1)*1e9), None, None, "up", [None, .45, .55]]]
    chunk(path, NOW-2, rows)
    value = market(reader)
    assert reader.books["up"]["asks"] == {.5: 5}
    rows.append(["last_trade_price", int(NOW*1e9), None, None, "down", [None, .5, 1]])
    chunk(path, NOW-2, rows)
    assert market(reader)["quote_at"] == iso(NOW-10)


def test_invalid_delta_cannot_refresh_existing_quote(projection):
    reader, path = projection
    rows = [book(at=NOW-10), book("down", at=NOW-10)]
    chunk(path, NOW-10, rows)
    assert market(reader)["quote_at"] == iso(NOW-10)
    chunk(path, NOW-1, [["price_change", int((NOW-1)*1e9), None, None, None,
                       [None, [["up", "bad", 1, "BUY", .4, .5], ["down", .4, 1, "TYPO", .4, .5]]]]])
    assert market(reader)["quote_at"] == iso(NOW-10)


def test_expired_quotes_do_not_survive_when_other_sources_are_fresh(projection):
    reader, path = projection
    chunk(path, NOW-2, [book(), book("down")])
    assert market(reader)["up_ask"] == .5
    assert market(reader, NOW+179)["up_ask"] is None


def test_corrupt_or_unknown_chunk_fails_closed(projection):
    reader, path = projection
    chunk(path, NOW-2, [book(), book("down")])
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("INSERT INTO event_chunks VALUES('clob',?,1,'zlib-json-v2',X'1234')", (int(NOW-1),))
    for _ in range(2):
        with pytest.raises(zlib.error):
            reader.snapshot(NOW)
        assert reader.books == {}
        assert reader.chunks == {}
    chunk(path, NOW-1, [book(at=NOW-1, ask=.7)])
    assert market(reader)["up_ask"] == .7
    assert market(reader)["down_ask"] == .5


def test_invalid_event_payload_does_not_poison_following_poll(projection):
    reader, path = projection
    chunk(path, NOW-2, [book(), ["book", int(NOW*1e9), None, None, "down", None]])
    for _ in range(2):
        with pytest.raises(TypeError):
            reader.snapshot(NOW)
        assert reader.books == {}
    chunk(path, NOW-2, [book(), book("down")])
    assert market(reader)["down_ask"] == .5


@pytest.mark.parametrize("checked_at", [iso(NOW-16), iso(NOW+6), "bad", None])
def test_remote_stale_or_invalid_generation_clock_fails_closed(checked_at):
    value = validate_snapshot({"checked_at": checked_at, "collector_online": True, "current_markets": [{"up_ask": .4}]}, NOW)
    assert value["collector_online"] is False
    assert value["current_markets"] == []


def test_published_snapshot_preserves_source_quote_clock_and_is_atomic(tmp_path):
    value = {"checked_at": iso(NOW), "collector_online": True, "current_markets": [{"quote_at": iso(NOW-10)}]}
    path = tmp_path / "snapshot.json"
    publish_snapshot(path, value)
    assert validate_snapshot(json.loads(path.read_text(encoding="utf-8")), NOW) == value
    assert not path.with_name(path.name + ".tmp").exists()

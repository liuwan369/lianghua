import importlib.util
import json
import sqlite3
import zlib
from pathlib import Path

import pytest


REPLAY_PATH = Path(__file__).parents[1] / "scripts" / "pm-r26-historical-shadow-replay.py"
SPEC = importlib.util.spec_from_file_location("pm_r26_streaming", REPLAY_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def _write_capture(path: Path, events: list[tuple[int, str]]) -> None:
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE event_chunks (
                id INTEGER PRIMARY KEY,
                source TEXT NOT NULL,
                received_second INTEGER NOT NULL,
                event_count INTEGER NOT NULL,
                codec TEXT NOT NULL,
                payload_blob BLOB NOT NULL
            )
            """
        )
        for received_ns, token in events:
            row = ["last_trade_price", received_ns, 1_000 + received_ns // 1_000_000, None, token, ["1", "0.50", "1", "SELL"]]
            blob = zlib.compress(json.dumps([row]).encode("utf-8"))
            conn.execute(
                "INSERT INTO event_chunks(source,received_second,event_count,codec,payload_blob) VALUES(?,?,?,?,?)",
                ("clob", received_ns // 1_000_000_000, 1, "zlib", blob),
            )
        conn.commit()


def test_iter_clob_merges_capture_files_in_receive_order(tmp_path: Path) -> None:
    token = "token"
    first = tmp_path / "first.sqlite3"
    second = tmp_path / "second.sqlite3"
    _write_capture(first, [(2_000_000_000, token), (4_000_000_000, token)])
    _write_capture(second, [(1_000_000_000, token), (3_000_000_000, token)])

    events = list(MODULE.iter_clob([first, second], {token: (0, 10_000)}))

    assert [event[0] for event in events] == [1_000_000_000, 2_000_000_000, 3_000_000_000, 4_000_000_000]


def test_compact_multi_token_changes_reach_only_their_own_books(tmp_path):
    db = tmp_path / "multi.sqlite3"
    _write_capture(db, [])
    changes = [["up", "0.40", "12", "BUY", "0.4", "0.6"],
               ["down", "0.45", "8", "BUY", "0.45", "0.55"],
               ["up", "0.60", "0", "SELL", "0.4", "0.7"],
               ["other", "0.20", "5", "BUY", "0.2", "0.8"]]
    row = ["price_change", 2_000_000_000, 2000, None, None, ["2000", changes]]
    with sqlite3.connect(db) as conn:
        conn.execute("INSERT INTO event_chunks(source,received_second,event_count,codec,payload_blob) VALUES(?,?,?,?,?)",
                     ("clob", 2, 1, "zlib", zlib.compress(json.dumps([row]).encode())))
    events = list(MODULE.iter_clob([db], {"up": (0, 3000), "down": (0, 3000)}))
    assert len(events) == 1
    assert events[0][3] == ""
    routed = dict(MODULE.token_payloads("price_change", None, events[0][4]))
    assert routed["down"] == ["2000", [changes[1]]]
    assert routed["up"] == ["2000", [changes[0], changes[2]]]
    book = {"bids": [], "asks": [{"price": "0.60", "size": "3"}]}
    MODULE.apply_changes(book, routed["up"])
    assert book["bids"] == [{"price": "0.40", "size": "12"}]
    assert book["asks"] == []
    assert list(MODULE.iter_clob([db], {"up": (40_000, 50_000)})) == []

    # Equal timestamps do not combine two independently observed messages.
    row[5] = ["2000", [changes[1]]]
    with sqlite3.connect(db) as conn:
        conn.execute("INSERT INTO event_chunks(source,received_second,event_count,codec,payload_blob) VALUES(?,?,?,?,?)",
                     ("clob", 2, 1, "zlib", zlib.compress(json.dumps([row]).encode())))
    assert len(list(MODULE.iter_clob([db], {"up": (0, 3000), "down": (0, 3000)}))) == 2


def test_price_change_uses_inner_identity_even_with_outer_token_and_rejects_unknown_identity():
    change = ["down", "0.4", "1", "BUY"]
    assert list(MODULE.token_payloads("price_change", "up", ["1", [change]])) == [("down", ["1", [change]])]
    for payload in (["1", [[None, "0.4", "1", "BUY"]]], ["1", {}], ["1"]):
        with pytest.raises(ValueError, match="price_change"):
            list(MODULE.token_payloads("price_change", None, payload))

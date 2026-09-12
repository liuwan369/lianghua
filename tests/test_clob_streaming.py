import importlib.util
import json
import sqlite3
import zlib
from pathlib import Path


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

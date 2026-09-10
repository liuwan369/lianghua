from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import time
import zlib
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pm-r25-dublin-evidence-collector.py"
SPEC = importlib.util.spec_from_file_location("pm_r25_collector", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def test_activity_key_separates_distinct_fills() -> None:
    base = {"transactionHash": "0x1", "asset": "7", "timestamp": 10, "side": "BUY", "size": 20, "price": .4}
    changed = {**base, "size": 21}
    assert MODULE.activity_key(base) != MODULE.activity_key(changed)


def test_decode_order_filled_extracts_wallet_roles_and_token() -> None:
    words = [0, 123, 2_000_000, 4_000_000, 50_000, 0, 0]
    log = {
        "transactionHash": "0xabc", "blockNumber": "0x10", "logIndex": "0x2",
        "topics": [MODULE.ORDER_FILLED_TOPIC, "0x" + "1" * 64, "0x" + "0" * 24 + "a" * 40, "0x" + "0" * 24 + "b" * 40],
        "data": "0x" + "".join(f"{word:064x}" for word in words),
    }
    row = MODULE.decode_order_filled(log, "ctf", "maker", 1000)
    assert row["tokenId"] == "123"
    assert row["feeUsdc"] == .05
    assert row["maker"] == "0x" + "a" * 40
    assert row["targetSide"] == "BUY"


def test_decode_taker_buy_uses_target_token_and_opposite_side() -> None:
    words = [1, 456, 20_000_000, 10_000_000, 0, 0, 0]
    log = {
        "transactionHash": "0xdef", "blockNumber": "0x10", "logIndex": "0x3",
        "topics": [MODULE.ORDER_FILLED_TOPIC, "0x" + "1" * 64, "0x" + "0" * 24 + "a" * 40, "0x" + "0" * 24 + "b" * 40],
        "data": "0x" + "".join(f"{word:064x}" for word in words),
    }
    row = MODULE.decode_order_filled(log, "ctf", "taker", 1000)
    assert row["tokenId"] == "456"
    assert row["targetSide"] == "BUY"


def test_trade_authorization_is_absent_from_collector_capabilities() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    assert "private_key" not in source.lower()
    assert "create_order" not in source.lower()
    assert '"operation": "subscribe"' in source
    assert '"operation": "unsubscribe"' in source


def test_late_second_chunk_is_appended_not_dropped(tmp_path: Path) -> None:
    path = tmp_path / "evidence.sqlite3"
    store = MODULE.EvidenceStore(path)
    store.start()
    old_ns = (time.time_ns() // 1_000_000_000 - 10) * 1_000_000_000
    store.submit(MODULE.Event("clob", "x", "one", old_ns, None, None, None, {"n": 1}))
    time.sleep(.7)
    store.submit(MODULE.Event("clob", "x", "two", old_ns + 1, None, None, None, {"n": 2}))
    time.sleep(.7)
    store.close()
    connection = sqlite3.connect(path)
    count, blob = connection.execute("SELECT event_count,payload_blob FROM event_chunks").fetchone()
    rows = json.loads(zlib.decompress(blob))
    assert count == 2
    assert [row[-1]["n"] for row in rows] == [1, 2]


def test_polygon_events_and_checkpoint_commit_together(tmp_path: Path) -> None:
    path = tmp_path / "polygon.sqlite3"
    event = MODULE.Event("polygon", "order_filled", "p:1", 1, 2, None, "7", {"blockNumber": 3})
    inserted = MODULE.persist_polygon_batch(path, [event], "polygon_last_complete_block", "3")
    connection = sqlite3.connect(path)
    assert inserted == 1
    assert connection.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
    assert connection.execute("SELECT value FROM checkpoints").fetchone()[0] == "3"

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from dashboard.market_snapshot import validate_snapshot

NOW = 1_800_000_000.0


def iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def clob_snapshot(**row_update) -> dict:
    row = {"slug": "btc", "up_token": "up", "down_token": "down",
           "up_bid": .4, "up_ask": .5, "down_bid": .4, "down_ask": .5,
           "start": NOW - 60, "end": NOW + 60, "quote_at": iso(NOW)}
    row.update(row_update)
    return {"checked_at": iso(NOW), "source": "polymarket-ws", "stale_after_ms": 2000,
            "collector_online": True, "collector_connected": True, "current_markets": [row]}


@pytest.mark.parametrize("checked_at", [iso(NOW - 16), iso(NOW + 6), "bad", None])
def test_remote_stale_or_invalid_generation_clock_fails_closed(checked_at):
    value = validate_snapshot({"checked_at": checked_at, "collector_online": True,
                               "current_markets": [{"up_ask": .4}]}, NOW)
    assert value["collector_online"] is False
    assert value["current_markets"] == []


@pytest.mark.parametrize("quote_age,end,online", [
    (3, NOW + 60, True),
    (.1, NOW, True),
    (.1, NOW + 60, False),
    (-1.001, NOW + 60, True),
])
def test_clob_heartbeat_cannot_refresh_old_expired_or_disconnected_quotes(quote_age, end, online):
    value = clob_snapshot(end=end, quote_at=iso(NOW - quote_age))
    value["collector_online"] = online
    result = validate_snapshot(value, NOW)
    assert result["collector_online"] is False
    assert result["current_markets"] == []
    assert value["current_markets"]


@pytest.mark.parametrize("row_update", [
    {"up_bid": None},
    {"down_ask": 1.1},
    {"up_bid": .7, "up_ask": .6},
    {"down_ask": "0.5"},
    {"down_token": "up"},
    {"quote_at": None},
    {"start": "old"},
])
def test_clob_snapshot_rejects_invalid_market_fields(row_update):
    result = validate_snapshot(clob_snapshot(**row_update), NOW)
    assert result["collector_online"] is False
    assert result["current_markets"] == []


def test_clob_snapshot_rejects_disconnected_collector():
    value = clob_snapshot()
    value["collector_connected"] = False
    result = validate_snapshot(value, NOW)
    assert result["collector_online"] is False
    assert result["current_markets"] == []


def test_clob_snapshot_accepts_bounded_clock_skew_without_rewriting_source_time():
    quote_at = iso(NOW + .5)
    value = clob_snapshot(quote_at=quote_at)
    result = validate_snapshot(value, NOW)
    assert result["collector_online"] is True
    assert result["current_markets"][0]["quote_at"] == quote_at

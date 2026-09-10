from __future__ import annotations

import importlib.util
import math
import time
from datetime import datetime, timezone
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pm-r25-live-evidence-analysis.py"
SPEC = importlib.util.spec_from_file_location("pm_r25_live_analysis", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def test_prior_price_is_strictly_historical_or_equal() -> None:
    times = [1000, 2000, 3000]
    prices = [10.0, 20.0, 30.0]
    assert MODULE.prior_price(times, prices, 2500) == 20
    assert MODULE.prior_price(times, prices, 999) is None


def test_signed_momentum_changes_with_outcome_direction() -> None:
    times = [1000, 2000]
    prices = [100.0, 101.0]
    assert math.isclose(MODULE.signed_momentum(times, prices, 2000, 1000, 1), 100)
    assert math.isclose(MODULE.signed_momentum(times, prices, 2000, 1000, -1), -100)


def test_best_level_uses_high_bid_and_low_ask() -> None:
    levels = {.4: 10, .5: 20}
    assert MODULE.best_level(levels, "bid") == (.5, 20)
    assert MODULE.best_level(levels, "ask") == (.4, 10)


def test_query_resolution_uses_latest_trade_not_after_query() -> None:
    rows = [
        ["agg_trade", 1, 1000, None, None, [1, "100", "1", 1, 1, 1000, False]],
        ["agg_trade", 2, 2000, None, None, [2, "102", "1", 2, 2, 2000, False]],
    ]
    result = MODULE.resolve_binance_queries(rows, {1500, 2000, 2500})
    assert result[1500] == 100
    assert result[2000] == 102
    assert result[2500] == 102


def test_unchanged_book_snapshot_does_not_reset_bid_age() -> None:
    token = "7"
    tx = "0xabc"
    book = ["1000", [["0.5", "10"]], [["0.6", "10"]], "0.01"]
    rows = [
        ["book", 1, 1000, None, token, book],
        ["book", 2, 1500, None, token, ["1500", [["0.5", "10"]], [["0.6", "10"]], "0.01"]],
        ["last_trade_price", 3, 2000, None, token, ["2000", "0.5", "5", "SELL", "0", tx]],
    ]
    match = MODULE.reconstruct_target_fills(rows, {tx})[(tx, token)][0]
    assert match["bid_level_observed_age_ms"] is None
    assert match["bid_level_age_left_censored"] is True


def test_price_change_starts_observed_bid_age() -> None:
    token = "7"
    tx = "0xabc"
    rows = [
        ["book", 1, 1000, None, token, ["1000", [["0.5", "10"]], [], "0.01"]],
        ["price_change", 2, 1600, None, None, ["1600", [[token, "0.5", "12", "BUY", "0.5", "0.6"]]]],
        ["last_trade_price", 3, 2000, None, token, ["2000", "0.5", "5", "SELL", "0", tx]],
    ]
    match = MODULE.reconstruct_target_fills(rows, {tx})[(tx, token)][0]
    assert match["bid_level_observed_age_ms"] == 400
    assert match["bid_level_age_left_censored"] is False


def test_binance_received_query_never_uses_later_arrival() -> None:
    rows = [
        ["agg_trade", 1_000_000_000, 900, None, None, [1, "100", "1", 1, 1, 900, False]],
        ["agg_trade", 2_000_000_000, 1500, None, None, [2, "102", "1", 2, 2, 1500, False]],
    ]
    result = MODULE.resolve_binance_received_queries(rows, {1_500_000_000, 2_000_000_000})
    assert result[1_500_000_000] == 100
    assert result[2_000_000_000] == 102


def test_legacy_taker_buy_token_is_recovered() -> None:
    payload = {"role": "taker", "side": 1, "tokenId": "456"}
    assert MODULE.polygon_target_token(payload) == "456"
    assert MODULE.polygon_target_side(payload) == "BUY"


def test_polygon_role_matching_keeps_taker_rows_for_activity_buy() -> None:
    assert MODULE.polygon_target_token({"role": "taker", "orderSide": 0, "tokenId": "456"}) == "456"


def test_daily_database_discovery_requires_every_utc_day(tmp_path: Path) -> None:
    days = tmp_path / "days"
    days.mkdir()
    first = days / "dublin-evidence-2026-08-27.sqlite3"
    first.touch()
    start = int(datetime(2026, 8, 27, 23, 59, tzinfo=timezone.utc).timestamp() * 1_000_000_000)
    end = start + 120 * 1_000_000_000
    paths, missing = MODULE.discover_database_paths(first, start, end)
    assert first.resolve() in paths
    assert any("2026-08-28" in path for path in missing)


def test_short_collection_cannot_pass_a_24_hour_request() -> None:
    now_ns = time.time_ns()
    since_ns = now_ns - 24 * 3600 * 1_000_000_000
    recent_second = now_ns // 1_000_000_000 - 60
    reasons = MODULE.coverage_diagnostics(
        [], [], [], {"clob": (recent_second, recent_second), "binance": (recent_second, recent_second)},
        since_ns, now_ns,
    )
    assert "clob_starts_after_requested_window" in reasons
    assert "binance_starts_after_requested_window" in reasons
    assert "health_has_no_records" in reasons


def test_market_subscription_update_is_not_a_feed_gap() -> None:
    update = {
        "event_type": "market_subscription_update", "received_ns": 10,
        "payload": {"feed": "clob", "added": ["new"], "removed": ["old"]},
    }
    reconnect = {
        "event_type": "feed_reconnect", "received_ns": 20,
        "payload": {"feed": "clob", "gap_ms": 5, "reason": "error"},
    }
    assert MODULE.is_collector_gap_event(update) is False
    assert MODULE.collector_gap_windows([update, reconnect], "clob") == [(20 - 5_000_000, 20)]

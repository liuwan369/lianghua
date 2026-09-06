from __future__ import annotations

import importlib.util
import gzip
import hashlib
import json
import math
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pm-r25-binance-signal-analysis.py"
SPEC = importlib.util.spec_from_file_location("pm_r25_binance_signal", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def test_required_seconds_never_uses_future_as_past() -> None:
    batches = [{"timestamp": 1000, "market_start": 900}]
    needed = MODULE.required_seconds(batches)
    points = set().union(*needed.values())
    assert 969 in points
    assert 968 in points
    assert 1000 in points
    assert 1030 in points
    assert 900 in points


def test_direction_alignment_uses_signed_return() -> None:
    rows = [
        {"direction": 1, "signal": .01},
        {"direction": -1, "signal": -.02},
        {"direction": -1, "signal": .03},
    ]
    result = MODULE.rate_summary(rows, "signal")
    assert result["aligned_with_buy_direction_pct"] == 66.6667
    assert result["aligned_pct_excluding_flat"] == 66.6667


def test_safe_return_requires_both_observed_seconds() -> None:
    assert math.isclose(MODULE.safe_return({1: 100, 2: 101}, 1, 2), .01)
    assert MODULE.safe_return({1: 100}, 1, 2) is None


def test_inventory_action_distinguishes_repair_from_expansion() -> None:
    rows = [
        {"slug": "m", "timestamp": 1, "up_shares": 20, "down_shares": 0},
        {"slug": "m", "timestamp": 2, "up_shares": 5, "down_shares": 0},
        {"slug": "m", "timestamp": 3, "up_shares": 0, "down_shares": 10},
    ]
    MODULE.annotate_inventory_actions(rows)
    assert [row["inventory_action"] for row in rows] == ["start", "expand", "repair"]


def test_signal_ends_before_activity_timestamp_second() -> None:
    batch = {
        "slug": "btc-updown-5m-900", "market_start": 900, "timestamp": 1000,
        "up_shares": 20.0, "down_shares": 0.0, "up_cost": 10.0, "down_cost": 0.0,
    }
    prices = {900: 90.0, 994: 100.0, 999: 101.0, 1000: 50.0, 1299: 100.0}
    result = MODULE.analyze([batch], prices)
    assert result["past_momentum_alignment"]["5s"]["aligned_pct_excluding_flat"] == 100.0


def test_incomplete_report_suppresses_strategy_numbers() -> None:
    report = MODULE.render_report(
        {"decision_batches": 999}, False, {"missing_files": ["x"], "gaps": []}, ["2026-01-01"],
    )
    assert "禁止输出策略结论" in report
    assert "999" not in report


def test_single_verified_window_is_not_mislabeled_as_30_days(tmp_path: Path) -> None:
    window = tmp_path / "1-2.json.gz"
    with gzip.open(window, "wt", encoding="utf-8") as handle:
        json.dump({"records": []}, handle)
    digest = hashlib.sha256(window.read_bytes()).hexdigest()
    (tmp_path / "index.json").write_text(json.dumps({
        "request": {
            "requested_days": 30, "addresses": [MODULE.ADDRESS],
            "requested_start_epoch": 1, "requested_end_epoch": 2,
        },
        "windows": [{
            "file": window.name, "start_epoch": 1, "end_epoch": 2,
            "pagination_complete": True, "sha256": digest,
        }],
    }), encoding="utf-8")
    coverage = MODULE.validate_history_index(tmp_path)
    assert coverage["complete"] is False
    assert coverage["request_metadata_valid"] is False

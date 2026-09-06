from __future__ import annotations

import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "pm-r25-infer-state-machine.py"
SPEC = importlib.util.spec_from_file_location("pm_r25_state_machine", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def test_same_second_is_one_batch_and_does_not_invent_order() -> None:
    rows = [
        {"timestamp": 100, "outcome": "Up", "size": 20, "price": .6, "usdcSize": 12, "transactionHash": "a"},
        {"timestamp": 100, "outcome": "Down", "size": 10, "price": .4, "usdcSize": 4, "transactionHash": "b"},
    ]
    batches = MODULE.group_timestamp_batches(rows)
    assert len(batches) == 1
    assert batches[0]["up_shares"] == 20
    assert batches[0]["down_shares"] == 10
    assert MODULE.classify_action(50, 20, 10) == "both"


def test_repair_and_expand_are_relative_to_pretrade_inventory() -> None:
    assert MODULE.classify_action(50, 0, 10) == "repair"
    assert MODULE.classify_action(50, 10, 0) == "expand"
    assert MODULE.classify_action(-50, 10, 0) == "repair"
    assert MODULE.classify_action(-50, 0, 10) == "expand"


def test_interval_boundaries_are_stable() -> None:
    assert MODULE.interval_label(20, MODULE.IMBALANCE_BOUNDS) == "20-50"
    assert MODULE.interval_label(999, MODULE.IMBALANCE_BOUNDS) == "500+"


def test_missing_history_index_blocks_conclusions(tmp_path: Path) -> None:
    coverage = MODULE.validate_history_index(tmp_path)
    assert coverage["complete"] is False
    report = MODULE.render_report({"markets": 999}, coverage)
    assert "禁止输出策略结论" in report
    assert "999" not in report

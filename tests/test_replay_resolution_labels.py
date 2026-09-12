import importlib.util
import json
from pathlib import Path

import pytest


SPEC = importlib.util.spec_from_file_location("replay_labels", Path(__file__).resolve().parents[1] / "scripts/pm-r26-historical-shadow-replay.py")
replay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(replay)


def label():
    slug = "btc-updown-5m-1788739200"
    return {"slug": slug, "status": "resolved", "winner": "Down", "condition_id": "0xabc",
            "up_token": "11", "down_token": "22", "official_closed": True,
            "official_resolution_status": "resolved", "reported_payouts": {"Up": 0, "Down": 1},
            "source_url": f"https://gamma-api.polymarket.com/events?slug={slug}", "snapshot_sha256": "a" * 64}


def test_load_labels_rejects_false_finality_and_duplicates(tmp_path):
    path = tmp_path / "labels.json"
    for rows in ([{**label(), "official_closed": False}], [label(), label()], [{**label(), "winner": "Up"}]):
        path.write_text(json.dumps({"schema_version": 1, "labels": rows}))
        with pytest.raises(ValueError):
            replay.load_resolution_labels(path)


def test_named_official_winner_selects_existing_net_pnl_without_double_fee_deduction():
    meta = {"slug": label()["slug"], "market_id": "0xabc", "up_token": "11", "down_token": "22"}
    snapshot = {"settlement_pnl_if_up_usdc": -4.2, "settlement_pnl_if_down_usdc": 1.8, "taker_fee_usdc": 0.2}
    result = replay.attach_resolution(snapshot, meta, label())
    assert result["simulated_official_settlement_pnl_usdc"] == 1.8
    assert result["official_winner"] == "Down"
    assert "official_winner" not in snapshot
    assert replay.attach_resolution(snapshot, meta, None)["simulated_official_settlement_pnl_usdc"] is None
    with pytest.raises(ValueError, match="does not match"):
        replay.attach_resolution(snapshot, {**meta, "up_token": "12"}, label())

import importlib.util
import json
from pathlib import Path

import pytest


SPEC = importlib.util.spec_from_file_location("resolution_audit", Path(__file__).resolve().parents[1] / "scripts/pm-r33-resolution-audit.py")
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def market():
    return {"slug": "btc-updown-5m-1788739200", "condition_id": "0x" + "a" * 64, "up_token": "123", "down_token": "456"}


def official(**overrides):
    return {
        "slug": market()["slug"], "conditionId": market()["condition_id"],
        "outcomes": '["Down", "Up"]', "clobTokenIds": '["456", "123"]',
        "outcomePrices": '["0", "1"]', "closed": True, "umaResolutionStatus": "resolved",
        **overrides,
    }


def test_resolves_by_named_outcome_not_array_position():
    result = audit.classify_resolution(market(), [official()])
    assert result["winner"] == "Up"
    assert result["status"] == "resolved"


@pytest.mark.parametrize("overrides,reason", [
    ({"closed": False}, "official_resolution_not_final"),
    ({"closed": "true"}, "official_resolution_not_final"),
    ({"umaResolutionStatus": "proposed"}, "official_resolution_not_final"),
    ({"umaResolutionStatus": None}, "official_resolution_not_final"),
    ({"outcomePrices": '["0.5", "0.5"]'}, "non_binary_final_payout"),
    ({"outcomePrices": '["0.001", "0.999"]'}, "non_binary_final_payout"),
    ({"conditionId": "0x" + "b" * 64}, "condition_id_mismatch"),
    ({"clobTokenIds": '["123", "456"]'}, "token_identity_mismatch"),
    ({"outcomePrices": '[false, true]'}, "invalid_outcomes_or_prices"),
    ({"outcomePrices": '["NaN", "1"]'}, "invalid_outcomes_or_prices"),
    ({"outcomes": '["Up", "Up"]'}, "invalid_outcomes_or_prices"),
])
def test_never_infers_winner_from_ambiguous_or_unfinalized_response(overrides, reason):
    result = audit.classify_resolution(market(), [official(**overrides)])
    assert result["winner"] is None
    assert result["reason"] == reason


@pytest.mark.parametrize("response", [None, {}, [], [official(), official()]])
def test_rejects_missing_duplicate_and_malformed_market(response):
    assert audit.classify_resolution(market(), response)["status"] == "invalid"


def test_final_cache_is_revalidated_against_capture_identity(tmp_path, monkeypatch):
    cached = {"url": audit.GAMMA_URL, "slug": market()["slug"], "fetched_at": "2026-09-13T00:00:00Z", "response": [{"slug": market()["slug"], "markets": [official()]}]}
    path = tmp_path / (market()["slug"] + ".json")
    path.write_text(json.dumps(cached), encoding="utf-8")
    monkeypatch.setattr(audit.requests, "get", lambda *args, **kwargs: pytest.fail("resolved cache should avoid network"))
    result = audit.read_market(market(), tmp_path)
    assert result["winner"] == "Up"
    assert result["snapshot_sha256"] == audit.sha256_file(path)


@pytest.mark.parametrize("response", [[], {}, [{"slug": "wrong", "markets": [official()]}], [{"slug": market()["slug"], "markets": None}]])
def test_event_response_requires_exact_parent_identity(response):
    with pytest.raises(ValueError):
        audit.event_markets(market()["slug"], response)


def test_snapshot_wal_prevents_hashing_incomplete_input(tmp_path):
    path = tmp_path / "input.sqlite3"
    path.touch()
    path.with_name(path.name + "-wal").write_bytes(b"pending")
    with pytest.raises(ValueError, match="active WAL"):
        audit.inventory([path])


def test_damaged_cache_is_refetched_instead_of_aborting_audit(tmp_path, monkeypatch):
    path = tmp_path / (market()["slug"] + ".json")
    path.write_text(json.dumps({"url": audit.GAMMA_URL, "slug": market()["slug"],
                                "response": [{"slug": market()["slug"], "markets": [official()]}]}))
    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return [{"slug": market()["slug"], "markets": [official()]}]

    monkeypatch.setattr(audit.requests, "get", lambda *args, **kwargs: Response())
    assert audit.read_market(market(), tmp_path)["status"] == "resolved"

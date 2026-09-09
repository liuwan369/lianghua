from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path

import pytest


SPEC = importlib.util.spec_from_file_location(
    "dashboard_config_store_tests", Path(__file__).resolve().parents[1] / "scripts/dashboard/config.py")
CONFIG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONFIG)


def test_defaults_restart_and_defensive_copies(tmp_path):
    path = tmp_path / "nested/config.json"
    store = CONFIG.ConfigStore(path)
    initial = store.get()
    assert initial["revision"] == 0 and initial["savedAt"] is None
    assert initial["params"]["mode"] == "paper"
    params = {"order_usd": 3.25, "duration_min": 0}
    saved = store.save(params, 0)
    assert saved["revision"] == 1
    assert saved["savedAt"].endswith("Z")
    params["order_usd"] = 99
    saved["params"]["order_usd"] = 99
    saved["capabilities"]["supportedFields"].clear()
    restarted = CONFIG.ConfigStore(path)
    actual = restarted.get()
    assert actual["revision"] == 1
    assert actual["params"]["order_usd"] == 3.25
    assert actual["params"]["duration_min"] == 0
    assert "order_usd" in actual["capabilities"]["supportedFields"]
    assert restarted.save({"mode": "live"}, 1)["params"]["max_total_usd"] == 10
    assert restarted.get()["params"]["duration_min"] == 15


@pytest.mark.parametrize("params", [
    [], None, {"private_key": "DO_NOT_ECHO"}, {"confirm_live": True},
    {"cap": 0.99}, {"target": 0.98}, {"dailyLoss": 10},
    {"mode": "LIVE"}, {"mode": None}, {"mode": []},
    {"order_usd": "2"}, {"order_usd": True}, {"max_orders": False},
    {"order_usd": None}, {"max_orders": 1.5}, {"pair_cost_max": 1.01},
    {"duration_min": 0.01}, {"duration_min": -1},
    {"defensive_cancel_bps": float("nan")}, {"order_usd": float("inf")},
    {"max_orders": 10 ** 1000}, {"order_usd": 1000.01},
])
def test_reject_invalid_without_persisting_or_echoing(tmp_path, params):
    store = CONFIG.ConfigStore(tmp_path / "config.json")
    with pytest.raises(CONFIG.ConfigValidationError) as caught:
        store.save(params, 0)
    assert "DO_NOT_ECHO" not in str(caught.value)
    assert not store.path.exists()


@pytest.mark.parametrize("name,minimum,maximum", [
    ("order_usd", 0.01, 1000), ("pair_cost_max", 0.9, 1),
    ("max_total_usd", 0.01, 100000), ("max_orders", 1, 10000),
    ("duration_min", 0, 1440), ("maker_life_sec", 1, 300),
    ("decision_interval_ms", 0, 60000), ("defensive_cancel_bps", 0, 1000),
])
def test_each_legacy_parameter_boundary(name, minimum, maximum):
    assert CONFIG.validate_params({name: minimum})[name] == minimum
    assert CONFIG.validate_params({name: maximum})[name] == maximum
    for invalid in (minimum - 0.01, maximum + 0.01, True, float("nan"), float("inf")):
        with pytest.raises(CONFIG.ConfigValidationError):
            CONFIG.validate_params({name: invalid})


@pytest.mark.parametrize("revision", [True, False, None, "0", 0.0, -1])
def test_revision_is_strict_integer(tmp_path, revision):
    with pytest.raises(CONFIG.ConfigValidationError):
        CONFIG.ConfigStore(tmp_path / "config.json").save({}, revision)


def test_atomic_compare_and_swap_across_threads_and_instances(tmp_path):
    path = tmp_path / "config.json"
    stores = [CONFIG.ConfigStore(path) for _ in range(8)]
    def attempt(store):
        try:
            return store.save({}, 0)["revision"]
        except CONFIG.ConfigConflictError as exc:
            assert exc.current_revision == 1
            return "conflict"
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(attempt, stores))
    assert results.count(1) == 1
    assert results.count("conflict") == 7
    assert all(store.get()["revision"] == 1 for store in stores)


@pytest.mark.parametrize("damage", [
    "{", "[]", '{"schemaVersion": 1, "schemaVersion": 1}',
    "schema", "revision", "boolean_revision", "params", "extra", "secret", "nan", "timestamp", "utf8",
])
def test_corrupted_persistence_fails_closed_even_after_restart(tmp_path, damage):
    path = tmp_path / "config.json"
    CONFIG.ConfigStore(path).save({}, 0)
    document = json.loads(path.read_text(encoding="utf-8"))
    if damage == "utf8":
        path.write_bytes(b"\xff\xfe")
    elif damage in {"{", "[]", '{"schemaVersion": 1, "schemaVersion": 1}'}:
        path.write_text(damage, encoding="utf-8")
    else:
        if damage == "schema": document["schemaVersion"] = 2
        if damage == "revision": document["revision"] = 0
        if damage == "boolean_revision": document["revision"] = True
        if damage == "params": del document["params"]["order_usd"]
        if damage == "extra": document["extra"] = "DO_NOT_ECHO"
        if damage == "secret": document["params"]["private_key"] = "DO_NOT_ECHO"
        if damage == "nan": document["params"]["order_usd"] = float("nan")
        if damage == "timestamp": document["savedAt"] = "invalid"
        path.write_text(json.dumps(document), encoding="utf-8")
    before = path.read_bytes()
    restarted = CONFIG.ConfigStore(path)
    for action in (restarted.get, lambda: restarted.save({}, 0)):
        with pytest.raises(CONFIG.ConfigStoreError) as caught:
            action()
        assert "DO_NOT_ECHO" not in str(caught.value)
    assert path.read_bytes() == before


def test_failed_replace_keeps_previous_revision(tmp_path, monkeypatch):
    store = CONFIG.ConfigStore(tmp_path / "config.json")
    store.save({"order_usd": 4}, 0)
    before = store.path.read_bytes()
    def fail(*args):
        raise OSError("disk unavailable")
    monkeypatch.setattr(CONFIG.os, "replace", fail)
    with pytest.raises(CONFIG.ConfigStoreError):
        store.save({"order_usd": 5}, 1)
    assert store.path.read_bytes() == before
    assert store.get()["revision"] == 1
    assert list(tmp_path.glob("*.tmp")) == []


def test_deleted_known_file_cannot_silently_reset(tmp_path):
    store = CONFIG.ConfigStore(tmp_path / "config.json")
    store.save({}, 0)
    store.path.unlink()
    with pytest.raises(CONFIG.ConfigStoreError):
        store.get()
    with pytest.raises(CONFIG.ConfigStoreError):
        store.save({}, 0)


def test_capabilities_make_missing_semantics_explicit():
    caps = CONFIG.capabilities()
    assert not caps["pairCostMaxIsUniversalHardCap"]
    assert not caps["separatePairTargetAndHardCap"]
    assert {"target", "cap", "capital", "market", "effective"} <= set(caps["unsupportedDemoFields"])
    assert caps["versionedStartModes"] == ["paper"]
    assert caps["effectivePolicy"] == "next_start"

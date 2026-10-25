"""The control plane's binance-lead strategy config.

- default_config() is BINANCE_LEAD_DEFAULTS plus the control plane's run
  settings (mode/durationMinutes/maxRounds/assetId), read from the built engine;
- validate_config() accepts exactly what the engine's readStrategyConfig
  (normalizeBinanceLeadConfig) accepts, checked case by case against the engine;
- a file the store writes is read by the engine as written;
- a reversal config is never loaded: not at the new path (ConfigStoreError,
  never replaced by defaults), not as a draft (ConfigValidationError).

Needs `cd backend/engine && npm run build` first.
Run:  python scripts/regress/lead-config.py
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from dashboard.config import ConfigStoreError, ConfigValidationError  # noqa: E402
from dashboard.strategy_config import STRATEGY_ID, StrategyConfigStore, default_config, validate_config  # noqa: E402

RUN_SETTINGS = {"mode", "durationMinutes", "maxRounds", "assetId"}
DIST = ROOT / "backend" / "engine" / "dist"


def engine(script_body: str, payload) -> object:
    """Run an ES module against the built engine; payload in, JSON out."""
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "probe.mjs"
        script.write_text(
            "import { pathToFileURL } from 'node:url';\n"
            f"const dist = {json.dumps(str(DIST))};\n"
            "const load = (p) => import(pathToFileURL(`${dist}/${p}`).href);\n"
            "const payload = JSON.parse(await new Promise((r) => { let s = ''; process.stdin.on('data', (c) => s += c);"
            " process.stdin.on('end', () => r(s)); }));\n"
            + script_body, encoding="utf-8")
        done = subprocess.run(["node", str(script)], input=json.dumps(payload), capture_output=True,
                              text=True, encoding="utf-8", timeout=60)
        assert done.returncode == 0, done.stderr
        return json.loads(done.stdout)


def document(config):
    return {"schemaVersion": 1, "strategyId": STRATEGY_ID, "savedRevision": 1,
            "savedAt": "2026-10-25T00:00:00Z", "config": config}


# --- defaults are the engine's ---
assert STRATEGY_ID == "binance-lead"
defaults = default_config()
engine_defaults = engine("const { BINANCE_LEAD_DEFAULTS } = await load('strategies/binance-lead.js');\n"
                         "console.log(JSON.stringify(BINANCE_LEAD_DEFAULTS));", None)
strategy_fields = {k: v for k, v in defaults.items() if k not in RUN_SETTINGS}
for key in ("instanceId", "revision", "assetId"):
    engine_defaults.pop(key)
assert {k: v for k, v in strategy_fields.items() if v is not None} == engine_defaults, (strategy_fields, engine_defaults)
assert {k for k, v in strategy_fields.items() if v is None} == {"roundBudgetUsd", "totalBudgetUsd", "dailyLossUsd"}
assert defaults["assetId"] == "btc" and defaults["mode"] == "live"
assert defaults["durationMinutes"] == 0 and defaults["maxRounds"] == 0
validate_config(defaults)

# --- every boundary is judged the same way by the control plane and the engine ---
CASES = [("shares", v) for v in (0, -1, 0.5, 5, 10000, 10000.1, "5", True, None)]
CASES += [("thresholdBp", v) for v in (0, 0.1, 2, 1000, 1000.5, -2)]
CASES += [("windowMs", v) for v in (0, 1, 250, 60000, 60001)]
CASES += [("limitPremium", v) for v in (-0.01, 0, 0.03, 0.99, 1)]
CASES += [(("fromSec", "toSec"), v) for v in ((0, 300), (-1, 265), (265, 265), (270, 265), (15, 301), (0, 0.5), (299, 300))]
CASES += [("maxQuoteAgeSeconds", v) for v in (0, 0.1, 2, -1)]
CASES += [("maxQuoteSkewSeconds", v) for v in (0, 1.5, -1)]
CASES += [(key, v) for key in ("roundBudgetUsd", "totalBudgetUsd", "dailyLossUsd") for v in (None, 0, -5, 5)]
configs, python_ok = [], []
for key, value in CASES:
    config = dict(defaults)
    if isinstance(key, tuple):
        config.update(zip(key, value))
    else:
        config[key] = value
    configs.append(config)
    try:
        validate_config(config)
        python_ok.append(True)
    except ConfigValidationError:
        python_ok.append(False)
with tempfile.TemporaryDirectory() as tmp:
    paths = []
    for index, config in enumerate(configs):
        path = Path(tmp) / f"case-{index}.json"
        path.write_text(json.dumps(document(config)), encoding="utf-8")
        paths.append(str(path))
    engine_ok = engine("const { readStrategyConfig } = await load('cli/platform.js');\n"
                       "console.log(JSON.stringify(payload.map((p) => { try { readStrategyConfig(p); return true; }"
                       " catch { return false; } })));", paths)
for (key, value), mine, theirs in zip(CASES, python_ok, engine_ok):
    assert mine == theirs, f"{key}={value!r}: control plane {'accepts' if mine else 'rejects'}, engine {'accepts' if theirs else 'rejects'}"
assert python_ok.count(False) >= 20 and python_ok.count(True) >= 15, "both sides of every boundary are exercised"

# Values JSON cannot carry, and the control plane's own run settings.
for key, value in (("shares", float("nan")), ("thresholdBp", float("inf")), ("durationMinutes", -1),
                   ("maxRounds", 1.5), ("maxRounds", 10001), ("mode", "paper"), ("assetId", "doge2"),
                   ("assetId", "BTC ")):
    try:
        result = validate_config({**defaults, key: value})
    except ConfigValidationError:
        continue
    assert key == "assetId" and result["assetId"] == "btc", f"{key}={value!r} must be rejected"
assert validate_config({**defaults, "maxRounds": 3.0})["maxRounds"] == 3

# --- the exact field set: no reversal field, nothing missing ---
for extra in ("triggerPrice", "stageShares", "firstTriggerFromSec", "confirmationPrice"):
    try:
        validate_config({**defaults, extra: 0.67})
    except ConfigValidationError:
        continue
    raise AssertionError(f"{extra} is not a binance-lead field")
for missing in defaults:
    try:
        validate_config({k: v for k, v in defaults.items() if k != missing})
    except ConfigValidationError:
        continue
    raise AssertionError(f"a config without {missing} must be rejected")

REVERSAL = {"assetId": "btc", "triggerPrice": .67, "confirmationPrice": .70, "maxBuyPrice": .70,
            "stageShares": [5], "maxStages": 1, "roundBudgetUsd": 5, "totalBudgetUsd": 10, "dailyLossUsd": 10,
            "durationMinutes": 0, "maxRounds": 3, "mode": "live", "maxQuoteAgeSeconds": 2,
            "maxQuoteSkewSeconds": 1.5, "firstTriggerFromSec": 0}
with tempfile.TemporaryDirectory() as tmp:
    store = StrategyConfigStore(Path(tmp) / "binance-lead-config.json")
    # --- nothing published: new defaults, revision 0 ---
    fresh = store.get()
    assert fresh["strategyId"] == STRATEGY_ID and fresh["savedRevision"] == 0 and fresh["config"] == defaults
    # --- a reversal draft is rejected, nothing written ---
    try:
        store.save_draft(REVERSAL, 0)
    except ConfigValidationError:
        pass
    else:
        raise AssertionError("a reversal config cannot be saved as a binance-lead draft")
    assert store.get_draft() is None
    # --- save -> the engine reads exactly what was saved ---
    chosen = {**defaults, "shares": 7, "thresholdBp": 2.5, "windowMs": 300, "limitPremium": 0.02, "fromSec": 20,
              "toSec": 260, "roundBudgetUsd": 5, "totalBudgetUsd": 50, "dailyLossUsd": 10, "maxRounds": 3}
    draft = store.save_draft(chosen, 0)
    saved = store.activate_draft(0, draft["draftId"])
    assert saved["savedRevision"] == 1 and saved["config"] == chosen
    on_disk = json.loads(store.path.read_text(encoding="utf-8"))
    assert on_disk["strategyId"] == "binance-lead" and on_disk["config"] == chosen
    read = engine("const { readStrategyConfig } = await load('cli/platform.js');\n"
                  "console.log(JSON.stringify(readStrategyConfig(payload)));", str(store.path))
    assert read["savedRevision"] == "1" and read["dailyLossUsd"] == 10
    expected = {k: v for k, v in chosen.items() if k not in {"mode", "durationMinutes", "maxRounds"}}
    assert read["config"] == {**expected, "instanceId": "binance-lead", "revision": "1"}, read["config"]
    # --- a reversal document at the new path is damage, never silently replaced ---
    store.path.write_text(json.dumps({"schemaVersion": 1, "strategyId": "btc-reversal", "savedRevision": 22,
                                      "savedAt": "2026-10-20T00:00:00Z", "config": REVERSAL}), encoding="utf-8")
    for read_old in (StrategyConfigStore(store.path).get, store.get):
        try:
            read_old()
        except ConfigStoreError:
            continue
        raise AssertionError("a reversal document is not a binance-lead config")
    store.path.write_text(json.dumps(document(REVERSAL)), encoding="utf-8")
    try:
        StrategyConfigStore(store.path).get()
    except ConfigStoreError:
        pass
    else:
        raise AssertionError("reversal fields under the new strategy id are rejected too")
print("lead-config OK")

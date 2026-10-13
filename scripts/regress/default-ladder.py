"""Control-plane strategy config defaults and the fields added later.

- STRATEGY.md rule 6: the default ladder is 5 / 13 / 60, at most 3 rungs (it
  still was 5 / 20 / 60 / 140, 4 rungs). The engine default is checked in
  backend/engine/scripts/regress/default-ladder.mjs.
- STRATEGY.md rule 3 (2026-10-13): firstTriggerFromSec, default 0, in [0, 300);
  a config saved before the field existed still loads (revision 22 on the
  server has none).

Run:  python scripts/regress/default-ladder.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.config import ConfigValidationError  # noqa: E402
from dashboard.strategy_config import default_config, validate_config  # noqa: E402

config = default_config()
assert config["stageShares"] == [5, 13, 60], config["stageShares"]
assert config["maxStages"] == 3, config["maxStages"]
assert config["firstTriggerFromSec"] == 0, config
validate_config(config)       # the default itself must pass validation

assert validate_config({**config, "firstTriggerFromSec": 60})["firstTriggerFromSec"] == 60
for bad in (-1, 300, "60", None, float("nan")):
    try:
        validate_config({**config, "firstTriggerFromSec": bad})
    except ConfigValidationError:
        continue
    raise AssertionError(f"firstTriggerFromSec {bad!r} must be rejected")

saved_before = {k: v for k, v in config.items() if k != "firstTriggerFromSec"}
assert validate_config(saved_before)["firstTriggerFromSec"] == 0, "an older saved config loads with 0"
try:
    validate_config({**saved_before, "unknown": 1})
except ConfigValidationError:
    pass
else:
    raise AssertionError("an unknown field is still rejected")
print("default-ladder OK")

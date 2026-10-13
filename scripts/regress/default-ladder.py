"""STRATEGY.md rule 6: the control plane's default ladder is 5 / 13 / 60, at
most 3 rungs (it still was 5 / 20 / 60 / 140, 4 rungs). The engine default is
checked in backend/engine/scripts/regress/default-ladder.mjs.

Run:  python scripts/regress/default-ladder.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.strategy_config import default_config, validate_config  # noqa: E402

config = default_config()
assert config["stageShares"] == [5, 13, 60], config["stageShares"]
assert config["maxStages"] == 3, config["maxStages"]
validate_config(config)       # the default itself must pass validation
print("default-ladder OK")

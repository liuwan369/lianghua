"""BUGS.md P2-1: with the ladder used up, "current stage" showed "--".

The engine publishes consumedStages, but the ledger's round projection
whitelist dropped it, so the frontend fell back to nextStage - 1, and nextStage
is null once every rung is used.

Run:  python scripts/regress/P2-1.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.ledger import _strategy_projection  # noqa: E402

ROUND = {"assetId": "btc", "marketId": "0xm", "roundId": "1790704200", "status": "ended",
         "consumedStages": 1, "nextStage": None, "stages": []}


class P2_1(unittest.TestCase):
    def view(self, round_):
        return _strategy_projection({"strategyId": "btc-reversal", "rounds": [round_], "currentRound": None})

    def test_bug_consumed_stages_survive_projection(self):
        projected = self.view(ROUND)["rounds"][-1]
        self.assertEqual(projected.get("consumedStages"), 1, "a full ladder still reports how many stages were used")

    def test_control_next_stage_still_projected(self):
        projected = self.view({**ROUND, "consumedStages": 0, "nextStage": 1})["rounds"][-1]
        self.assertEqual(projected.get("nextStage"), 1)


if __name__ == "__main__":
    unittest.main()

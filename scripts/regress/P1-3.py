"""BUGS.md P1-3: "today" had two day boundaries.

The engine's daily-loss stop resets at 00:00 UTC+8 (core.ts dayOf); the ledger's
range=today and range=month started at 00:00 UTC. Between 00:00 and 08:00
Beijing time the two "today" figures covered different days.

The ledger now uses UTC+8 like the engine.

Run:  python scripts/regress/P1-3.py
"""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dashboard.ledger import _range_start  # noqa: E402

BEIJING = timezone(timedelta(hours=8))


class P1_3(unittest.TestCase):
    def test_bug_early_morning_beijing_is_the_new_day(self):
        # 2026-10-01 03:00 Beijing = 2026-09-30 19:00 UTC.
        now = datetime(2026, 10, 1, 3, 0, tzinfo=BEIJING).timestamp()
        self.assertEqual(_range_start("today", now), datetime(2026, 10, 1, tzinfo=BEIJING).timestamp())

    def test_month_starts_at_beijing_midnight(self):
        now = datetime(2026, 10, 1, 3, 0, tzinfo=BEIJING).timestamp()
        self.assertEqual(_range_start("month", now), datetime(2026, 10, 1, tzinfo=BEIJING).timestamp())

    def test_control_afternoon_same_day(self):
        now = datetime(2026, 9, 30, 15, 0, tzinfo=BEIJING).timestamp()
        self.assertEqual(_range_start("today", now), datetime(2026, 9, 30, tzinfo=BEIJING).timestamp())

    def test_matches_engine_day(self):
        # core.ts: dayOf(ts) = new Date(ts*1000 + 8h).toISOString().slice(0, 10)
        now = datetime(2026, 10, 1, 0, 30, tzinfo=BEIJING).timestamp()
        engine_day = datetime.fromtimestamp(now + 8 * 3600, timezone.utc).strftime("%Y-%m-%d")
        start = datetime.fromtimestamp(_range_start("today", now), BEIJING).strftime("%Y-%m-%d")
        self.assertEqual(start, engine_day)

    def test_run_and_all_have_no_start(self):
        self.assertIsNone(_range_start("run", 0))
        self.assertIsNone(_range_start("all", 0))


if __name__ == "__main__":
    unittest.main()

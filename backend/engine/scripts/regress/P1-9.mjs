// P1-9: --max-rounds counted every closed market toward the limit,
// including the round already running at startup (the strategy parks it as
// waiting_next_round and never trades it) and old markets restored from the
// state file for settlement recovery. So "run N rounds" traded at most N-1,
// and maxRounds=1 traded none. Live run 20260929-174516 set maxRounds=3 and
// traded exactly 1 round.
//
// Replays that run's real markets through the exported predicate used by
// scheduleMarketEnd. Run after `npm run build`:  node scripts/regress/P1-9.mjs
import assert from "node:assert/strict";
import { countsTowardRoundLimit } from "../../dist/cli/platform.js";

// Live run 20260929-174516: started 1790703917.698 (17s into round 1790703900).
const startedAt = 1790703917.698;
const old = { startsAt: 1790691600 };          // restored for settlement recovery, ended 3.3h earlier
const midRound = { startsAt: 1790703900 };     // already running at startup -> waiting_next_round
const r1 = { startsAt: 1790704200 };           // first round the run could trade
const r2 = { startsAt: 1790704500 };
const r3 = { startsAt: 1790704800 };

assert.equal(countsTowardRoundLimit(old, startedAt), false, "an old restored market must not count");
assert.equal(countsTowardRoundLimit(midRound, startedAt), false, "the round running at startup must not count");
assert.equal(countsTowardRoundLimit(r1, startedAt), true, "a round starting after the run began counts");

// Replay scheduleMarketEnd's stop rule over the markets in the order they close.
const replay = (maxRounds) => {
  let counted = 0, traded = 0;
  for (const m of [old, midRound, r1, r2, r3]) {        // closing order
    if (countsTowardRoundLimit(m, startedAt)) { counted += 1; traded += 1; }
    if (maxRounds > 0 && counted >= maxRounds) return traded;
  }
  return traded;
};
assert.equal(replay(3), 3, "maxRounds=3 must trade 3 rounds (was 1 live)");
assert.equal(replay(2), 2, "maxRounds=2 must trade 2 rounds (was 0)");
assert.equal(replay(1), 1, "maxRounds=1 must trade 1 round (was 0: stopped at startup)");

// A round starting exactly at the run's start instant is tradeable (now <= startsAt).
assert.equal(countsTowardRoundLimit({ startsAt: startedAt }, startedAt), true, "boundary: startsAt == startedAt counts");
// A round whose boundary passes during startup, before discovery finishes, is
// parked by the strategy (waiting_next_round) and never traded. It starts after
// the process did, so the timestamp rule alone would count it; the strategy's
// verdict must win.
assert.equal(countsTowardRoundLimit({ startsAt: startedAt + 3 }, startedAt, true), false,
  "a round the strategy parked must not count even if it started after the run");
assert.equal(countsTowardRoundLimit({ startsAt: startedAt + 3 }, startedAt, false), true,
  "a round the strategy did not park counts");
assert.equal(countsTowardRoundLimit({ startsAt: startedAt + 3 }, startedAt, undefined), true,
  "with no strategy verdict the timestamp rule applies");
console.log("P1-9 OK");

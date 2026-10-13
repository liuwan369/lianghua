// STRATEGY.md rule 6: the ladder is 5 / 13 / 60, at most 3 rungs. The engine
// default still was 5 / 20 / 60 / 140, 4 rungs. The control plane's default
// (scripts/dashboard/strategy_config.py) is checked in scripts/regress/default-ladder.py.
//
// Run after `npm run build`:  node scripts/regress/default-ladder.mjs
import assert from "node:assert/strict";
import { BTC_REVERSAL_DEFAULTS, normalizeBtcReversalConfig } from "../../dist/strategies/btc-reversal.js";

assert.deepEqual(BTC_REVERSAL_DEFAULTS.stageShares, [5, 13, 60], "default ladder is 5 / 13 / 60");
assert.equal(BTC_REVERSAL_DEFAULTS.maxStages, 3, "at most 3 rungs");
const normalized = normalizeBtcReversalConfig({});
assert.deepEqual([normalized.stageShares, normalized.maxStages], [[5, 13, 60], 3], "an empty config gets the agreed ladder");
console.log("default-ladder OK");

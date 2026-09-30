// BUGS.md P2-23 (found in the batch 2 live run): once a round's settlement was
// confirmed, every 15 s pass settled it again. The adapter answered from its
// record, but the CLI ran connection.recoverAccount() on every "confirmed",
// and each recovery emits account_recovery_started, which resets the
// strategy's quote baselines. Run 20260930-162501: 160 recoveries in 23 min,
// 65 repeat confirmations each for 1790773800 and 1790691600.
//
// Fix: settlementPassWants() skips a market this process already saw confirmed
// or terminal.
//
// Run after `npm run build`:  node scripts/regress/P2-23.mjs
import assert from "node:assert/strict";
import { settlementPassWants } from "../../dist/cli/platform.js";

const now = 1_790_787_000;
const ended = { id: "0xended", endsAt: now - 600 };
const live = { id: "0xlive", endsAt: now + 120 };
const done = new Set(["0xended"]);

// --- bug: a confirmed market is not settled again ---
assert.equal(settlementPassWants(ended, now, done), false, "a confirmed market must not be re-settled every pass");
// --- control: an ended market not yet settled is still settled ---
assert.equal(settlementPassWants(ended, now, new Set()), true, "an unsettled ended market is still settled");
// --- edge: a market that has not ended is never settled ---
assert.equal(settlementPassWants(live, now, new Set()), false, "a live market is not settled");
console.log("P2-23 OK");

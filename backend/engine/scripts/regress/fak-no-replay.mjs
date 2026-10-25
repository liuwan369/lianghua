// A FAK must never be sent twice. Account recovery repeats a signed order the
// venue answers 404 for (the POST may never have arrived), exactly as signed,
// while its round is open. For binance-lead's fill-and-kill that repeat lands
// seconds later on a signal that is long gone: a fresh buy at a stale price.
// A FAK that is SUBMITTING/UNKNOWN stays UNKNOWN until the account read or the
// user feed gives its terminal state.
//
// Tests the recovery's replay decision in platform/polymarket.ts.
// Run after `npm run build`:  node scripts/regress/fak-no-replay.mjs
import assert from "node:assert/strict";
import { replaysPreparedOrder } from "../../dist/platform/polymarket.js";

const NOW = 1_800_000_100;
const market = { endsAt: 1_800_000_300 };
const order = (extra = {}) => ({ status: "UNKNOWN", timeInForce: "GTC", preparedReplayAttempts: 0,
  prepared: { orderHash: "0x" + "ab".repeat(32), signedPayload: { sig: "s" }, preparedAt: NOW - 5 }, ...extra });

// --- bug: an uncertain FAK is replayed ---
assert.equal(replaysPreparedOrder(order({ timeInForce: "FAK" }), undefined, market, NOW), false, "an UNKNOWN FAK is never replayed");
assert.equal(replaysPreparedOrder(order({ timeInForce: "FAK", status: "SUBMITTING" }), undefined, market, NOW), false,
  "a SUBMITTING FAK is never replayed");
// --- control: a resting GTC keeps the bounded exact replay ---
assert.equal(replaysPreparedOrder(order(), undefined, market, NOW), true, "an UNKNOWN GTC is replayed once more");
assert.equal(replaysPreparedOrder(order({ status: "SUBMITTING" }), undefined, market, NOW), true);
// --- edges that already held for every order ---
assert.equal(replaysPreparedOrder(order({ preparedReplayAttempts: 2 }), undefined, market, NOW), false, "two replays at most");
assert.equal(replaysPreparedOrder(order(), undefined, market, market.endsAt), false, "never after the round closed");
assert.equal(replaysPreparedOrder(order(), "live", market, NOW), false, "the venue knows it: no replay");
assert.equal(replaysPreparedOrder(order({ venueStatus: "canceled" }), undefined, market, NOW), false);
assert.equal(replaysPreparedOrder(order({ prepared: undefined }), undefined, market, NOW), false, "nothing signed to repeat");
assert.equal(replaysPreparedOrder(order({ status: "OPEN" }), undefined, market, NOW), false);
assert.equal(replaysPreparedOrder(order(), undefined, undefined, NOW), false, "unknown market");
console.log("fak-no-replay OK");

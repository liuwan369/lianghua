// BUGS.md P2-9: the engine's round result (netIfUpUsd / netIfDownUsd) accepted
// only venue-reported fees, while the ledger also accepts rate-derived ones.
// Taker fills rarely get a reported fee, so the same round had a ledger PnL
// and blank UP/DOWN result columns.
//
// Run after `npm run build`:  node scripts/regress/P2-9.mjs
import assert from "node:assert/strict";
import { roundOutcome } from "../../dist/cli/platform.js";

const round = { upTokenId: "u", downTokenId: "d" };
const state = (fill) => ({ positions: [{ tokenId: "d", shares: 5, costUsd: 3.43, realizedPnlUsd: 0 }], orders: [],
  fills: [{ tradeId: "t", orderId: "o", tokenId: "d", direction: "BUY", shares: 5, price: 0.68, ts: 1,
    status: "CONFIRMED", feeUsd: 0.03, ...fill }] });

// --- bug: a confirmed taker fill with a rate-derived fee publishes a result ---
const taker = roundOutcome(round, state({ feeSource: "rate-derived" }));
assert.equal(taker.feesVerified, true, "rate-derived fees are accepted like the ledger does");
assert.ok(Math.abs(taker.netIfDownUsd - (5 - 3.43)) < 1e-9, "DOWN result is published");
assert.ok(Math.abs(taker.netIfUpUsd + 3.43) < 1e-9, "UP result is published");
// --- control: reported fees still publish ---
assert.equal(roundOutcome(round, state({ feeSource: "reported" })).feesVerified, true);
// --- edge: an estimated fee or an unconfirmed fill still withholds the result ---
assert.equal(roundOutcome(round, state({ feeSource: "estimate" })).netIfDownUsd, null, "estimate is not enough");
assert.equal(roundOutcome(round, state({ feeSource: "rate-derived", status: "MATCHED" })).netIfDownUsd, null,
  "an unconfirmed fill withholds the result");
console.log("P2-9 OK");

// BUGS.md P1-13 (found in the batch 2 live run): Gamma /markets defaults to
// closed=false, so the settlement lookup by condition_ids returns [] for any
// round once it closes. The round we had just traded (1790785800, 5 DOWN held)
// went pending -> "unsupported settlement_market_not_found" and stayed there:
// our own redeem path could never run on a closed round, and a losing round's
// worthless tokens would requeue as not_found every 15 s forever.
//
// Fix: gammaMarketRow() asks the default (open) listing first, then
// closed=true. Checked live on 2026-09-30: an open market is only in the
// default listing, a closed one only in closed=true.
//
// Run after `npm run build`:  node scripts/regress/P1-13.mjs
import assert from "node:assert/strict";
import { gammaMarketRow, createLiveSettlementAdapter } from "../../dist/platform/live-settlement.js";

const ID = "0x" + "ab".repeat(32);
const row = { conditionId: ID, clobTokenIds: '["1","2"]', negRisk: false };
// Stub Gamma exactly as observed live.
const gamma = (closed) => async (url) => {
  const wantsClosed = /[?&]closed=true/.test(url);
  return { ok: true, json: async () => (wantsClosed === closed ? [row] : []) };
};

// --- bug: a closed market is found through closed=true ---
assert.deepEqual(await gammaMarketRow(ID, gamma(true)), row, "a closed round must still be found");
// --- control: an open (ended, not yet resolved) market is found as before ---
assert.deepEqual(await gammaMarketRow(ID, gamma(false)), row, "an open round is found in the default listing");
// --- edge: a market in neither listing is still reported missing ---
const nowhere = async () => ({ ok: true, json: async () => [] });
assert.equal(await gammaMarketRow(ID, nowhere), undefined, "a truly delisted round is still missing");
// --- edge: an HTTP failure is not mistaken for "missing" ---
const down = async () => ({ ok: false, json: async () => [] });
await assert.rejects(() => gammaMarketRow(ID, down), /settlement_market_unavailable/, "HTTP failure stays retryable");
// --- edge (review): now that closed rounds are found, a round where we hold only
// the losing token must be recorded settled with NO transaction (payout 0) ---
{
  const WALLET = "0x" + "a1".repeat(20), UP = "111", DOWN = "222";
  const req = { assetId: "btc", marketId: ID, roundId: "1790785800", tokenIds: [UP, DOWN] };
  const sent = [];
  const backend = (numerators) => ({
    wallet: WALLET,
    async market() { return { tokenIds: [UP, DOWN], negRisk: false, denominator: 1n, numerators }; },
    async balances(ids) { return { balances: ids.map((id) => (id === DOWN ? 5_000_000n : 0n)), cash: 200_000_000n, block: 1000n }; },
    async approved() { return true; },
    async prepare(call) { sent.push(call); return { kind: "eoa", transactionHash: "0x" + "cd".repeat(32) }; },
    async submit() { return "0x" + "cd".repeat(32); },
    async receipt() { return undefined; },
    async externalPayout() { return undefined; },
  });
  const settleLost = await createLiveSettlementAdapter({ backend: backend([1n, 0n]),
    restore: { schemaVersion: 1, wallet: WALLET, records: {} }, persist: () => {} });
  const lost = await settleLost(req);
  assert.equal(lost.state, "confirmed", "a losing round settles as confirmed");
  assert.equal(sent.length, 0, "a zero-payout round sends no transaction");
  // Control: the winning side still goes through the redeem transaction.
  const settleWon = await createLiveSettlementAdapter({ backend: backend([0n, 1n]),
    restore: { schemaVersion: 1, wallet: WALLET, records: {} }, persist: () => {} });
  await settleWon(req);
  assert.equal(sent.length, 1, "a winning round still prepares a redeem");
}
console.log("P1-13 OK");

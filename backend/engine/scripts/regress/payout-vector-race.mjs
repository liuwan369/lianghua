// A payout vector read in the seconds after resolution can be inconsistent
// (live 2026-11-28, account 2 on pm-b, rounds 1795811400 and 1795825500;
// account 1 once on 11-26): the three reads (payoutDenominator and the two
// payoutNumerators) went out in parallel through a load-balanced public RPC
// with no block pinned, so one node already had the denominator and another
// did not yet have the numerator (n0 + n1 != denominator). That returned
// "unsupported settlement_invalid_payout_vector", which the run loop treats as
// terminal: the round was never retried, its loss never booked (-6.36 missing
// from the day's PnL), and a WINNING round hit the same way would never be
// redeemed. Read again an hour later from the same box: 1/1, 0, valid.
//
// - an inconsistent vector is "pending" (read again on the next pass), not
//   terminal; the next consistent read settles the round;
// - a vector that is malformed for good (three outcomes, a negative) is still
//   unsupported;
// - the run loop's terminal list no longer holds settlement_invalid_payout_vector;
// - the V1 reads are pinned to one block, so a single read cannot mix nodes.
// Run after `npm run build`:  node scripts/regress/payout-vector-race.mjs
import assert from "node:assert/strict";
import { createLiveSettlementAdapter } from "../../dist/platform/live-settlement.js";
import { isTerminalSettlementResult } from "../../dist/cli/platform.js";

const ID = "0x" + "ab".repeat(32), WALLET = "0x" + "a1".repeat(20), UP = "111", DOWN = "222";
const req = { assetId: "btc", marketId: ID, roundId: "1795811400", tokenIds: [UP, DOWN] };

function adapterWith(vectors, held = { [UP]: 0n, [DOWN]: 5_000_000n }) {
  const reads = [...vectors];
  const backend = {
    wallet: WALLET,
    async market() { const v = reads.length > 1 ? reads.shift() : reads[0]; return { tokenIds: [UP, DOWN], negRisk: false, ...v }; },
    async balances(ids) { return { balances: ids.map(id => held[id] ?? 0n), cash: 200_000_000n, block: 1000n }; },
    async approved() { return true; },
    async prepare() { return { kind: "eoa", transactionHash: "0x" + "cd".repeat(32) }; },
    async submit() { return "0x" + "cd".repeat(32); },
    async receipt() { return undefined; },
    async externalPayout() { return undefined; },
  };
  return createLiveSettlementAdapter({ backend, restore: { schemaVersion: 1, wallet: WALLET, records: {} }, persist: () => {} });
}

// The 11-28 read: the denominator is in, numerator 0 not yet (0 + 0 != 1), then consistent.
{
  const settle = await adapterWith([{ denominator: 1n, numerators: [0n, 0n] }, { denominator: 1n, numerators: [1n, 0n] }]);
  const first = await settle(req);
  assert.equal(first.state, "pending", `an inconsistent vector is read again, not terminal: ${first.state} ${first.reason}`);
  assert.equal(isTerminalSettlementResult(first), false, "the run loop keeps it queued");
  const second = await settle(req);
  assert.equal(second.state, "confirmed", "the next consistent read settles the losing round");
}
// A winning round hit the same way still gets redeemed on the retry.
{
  const settle = await adapterWith([{ denominator: 1n, numerators: [0n, 0n] }, { denominator: 1n, numerators: [0n, 1n] }]);
  assert.equal((await settle(req)).state, "pending");
  const again = await settle(req);
  assert.notEqual(again.state, "unsupported", "the winner is not dropped");
}
// Malformed for good: still unsupported.
for (const bad of [{ denominator: 1n, numerators: [1n, 0n, 0n] }, { denominator: 1n, numerators: [-1n, 2n] }]) {
  const settle = await adapterWith([bad]);
  const result = await settle(req);
  assert.equal(result.state, "unsupported", `malformed ${JSON.stringify(bad, (k, v) => typeof v === "bigint" ? String(v) : v)}`);
}
// The run loop: an old engine's "unsupported settlement_invalid_payout_vector"
// already in a state file is retried by the new one (not in the terminal list).
assert.equal(isTerminalSettlementResult({ state: "unsupported", reason: "settlement_invalid_payout_vector" }), false,
  "the reason is not terminal any more");
console.log("payout-vector-race OK");

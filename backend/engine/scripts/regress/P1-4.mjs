// BUGS.md P1-4, engine half: winning rounds almost never got a PnL. The venue
// usually auto-redeems a winner before we do; that payout was found and stored
// (settlements.json creditedPusd 5000000) but without its transaction hash, so
// result() reported payoutVerified=false and dropped creditedUsd, and the
// ledger could never book the win. Live: 1790788200, 1790788500. A losing round
// (payout proven 0, no transaction) was likewise never verified: 1790785800.
//
// Fix: externalPayout returns the paying transaction; a zero payout carries
// payoutProof "zero_payout".
//
// Run after `npm run build`:  node scripts/regress/P1-4.mjs
import assert from "node:assert/strict";
import { createLiveSettlementAdapter } from "../../dist/platform/live-settlement.js";

const WALLET = "0x" + "a1".repeat(20), UP = "111", DOWN = "222", TX = "0x" + "ef".repeat(32);
const req = { assetId: "btc", marketId: "0x" + "ab".repeat(32), roundId: "1790788500", tokenIds: [UP, DOWN] };
const backend = ({ held, numerators, external }) => ({
  wallet: WALLET,
  async market() { return { tokenIds: [UP, DOWN], negRisk: false, denominator: 1n, numerators }; },
  async balances(ids) { return { balances: ids.map((id) => BigInt(held[id] ?? 0)), cash: 200_000_000n, block: 1000n }; },
  async approved() { return true; },
  async prepare() { throw new Error("must not send a transaction"); },
  async submit() { throw new Error("must not send a transaction"); },
  async receipt() { return undefined; },
  async externalPayout() { return external; },
});
const settle = async (opts) => (await createLiveSettlementAdapter({ backend: backend(opts),
  restore: { schemaVersion: 1, wallet: WALLET, records: {} }, persist: () => {} }))(req);

// --- bug (a): venue auto-redeemed a winner; its payout is verified with the venue's tx ---
{
  const r = await settle({ held: {}, numerators: [0n, 1n], external: { creditedPusd: 5_000_000n, transactionHash: TX } });
  assert.equal(r.state, "confirmed");
  assert.equal(r.payoutVerified, true, "an auto-redeemed payout is verified");
  assert.equal(r.transactionId, TX, "the venue's paying transaction is the evidence");
  assert.equal(r.creditedUsd, 5, "the credited amount reaches the ledger");
}
// --- bug (b): only losing tokens held; a proven zero payout is verified without a tx ---
{
  const r = await settle({ held: { [UP]: 5_000_000 }, numerators: [0n, 1n], external: undefined });
  assert.equal(r.state, "confirmed");
  assert.equal(r.payoutVerified, true, "a proven zero payout is verified");
  assert.equal(r.payoutProof, "zero_payout");
  assert.equal(r.creditedUsd, 0);
}
// --- control: empty wallet and no payout found stays unverified (could be a missed payout) ---
{
  const r = await settle({ held: {}, numerators: [0n, 1n], external: undefined });
  assert.equal(r.state, "confirmed");
  assert.equal(r.payoutVerified, false, "no evidence, no verification");
  assert.equal(r.payoutProof, undefined);
}
// --- edge (review): the ladder bought both sides; the venue auto-redeemed the
// winner and the loser is still held. The payout is the venue's, not zero. ---
{
  const r = await settle({ held: { [UP]: 5_000_000 }, numerators: [0n, 1n],
    external: { creditedPusd: 18_000_000n, transactionHash: TX } });
  assert.equal(r.payoutProof, undefined, "not booked as a zero payout");
  assert.equal(r.creditedUsd, 18, "the auto-redeemed winner's payout is credited");
  assert.equal(r.transactionId, TX);
}
// --- edge (review): records confirmed by the old code get their evidence once ---
{
  const key = JSON.stringify([req.assetId, req.marketId, req.roundId]);
  const old = (extra) => ({ schemaVersion: 1, wallet: WALLET, records: { [key]: { marketId: req.marketId,
    roundId: req.roundId, assetId: "btc", tokenIds: [UP, DOWN], status: "confirmed", operation: "redeem",
    prepared: { kind: "eoa" }, fromBlock: "5000", cashBefore: "1", cashAfter: "1", ...extra } } });
  let saved;
  const win = await (await createLiveSettlementAdapter({ backend: backend({ held: {}, numerators: [0n, 1n],
    external: { creditedPusd: 5_000_000n, transactionHash: TX } }),
    restore: old({ balancesBefore: ["0", "0"], creditedPusd: "5000000", expectedPayout: "5000000" }),
    persist: (st) => { saved = st; } }))(req);
  assert.equal(win.payoutVerified, true, "an old auto-redeem record is verified after the lookup");
  assert.equal(saved.records[key].transactionHash, TX, "and the evidence is saved");
  const loss = await (await createLiveSettlementAdapter({ backend: backend({ held: {}, numerators: [0n, 1n], external: undefined }),
    restore: old({ balancesBefore: ["0", "5000000"], creditedPusd: "0", expectedPayout: "0" }), persist: () => {} }))(req);
  assert.equal(loss.payoutVerified, true, "an old zero-payout record with tokens held is a proven loss");
  assert.equal(loss.payoutProof, "zero_payout");
  const never = await (await createLiveSettlementAdapter({ backend: backend({ held: {}, numerators: [0n, 1n], external: undefined }),
    restore: old({ balancesBefore: ["0", "0"], creditedPusd: "0", expectedPayout: "0" }), persist: () => {} }))(req);
  assert.equal(never.payoutVerified, false, "an old never-held record without any payout stays unverified");
}
console.log("P1-4 OK");

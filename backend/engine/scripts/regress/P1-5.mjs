// BUGS.md P1-5 (root cause of P2-19): when the wallet already holds 0 of a
// round's tokens, live-settlement's zero-balance branch recognises that the
// venue's auto-redeem relayer cashed them out and returns "confirmed" -- but it
// never writes state.records[key] nor calls save(). The next poll therefore has
// no record, re-runs backend.market(), and once Gamma stops listing the round
// that throws settlement_market_not_found forever: the round is never recorded
// as settled and keeps requeueing every 15 s (P2-19).
//
// Real createLiveSettlementAdapter; only the IO backend is injected.
// Run after `npm run build`:  node scripts/regress/P1-5.mjs
import assert from "node:assert/strict";
import { createLiveSettlementAdapter } from "../../dist/platform/live-settlement.js";

const WALLET = "0x" + "a1".repeat(20);
const UP = "111", DOWN = "222";
const req = { assetId: "btc", marketId: "0x" + "cd".repeat(32), roundId: "1790773800", tokenIds: [UP, DOWN] };

function backend({ marketFound = () => true,
  external = { creditedPusd: 5_000_000n, transactionHash: "0x" + "ef".repeat(32) } } = {}) {
  const calls = { market: 0 };
  return { calls, b: {
    wallet: WALLET,
    async market() {
      calls.market += 1;
      if (!marketFound()) { const e = new Error("settlement_market_not_found"); e.name = "UnsupportedSettlement"; throw Object.assign(new (class UnsupportedSettlement extends Error {})("settlement_market_not_found")); }
      return { tokenIds: [UP, DOWN], denominator: 1n, numerators: [0n, 1n], negRisk: false };
    },
    async balances() { return { balances: [0n, 0n], cash: 211_116_499n, block: 1000n }; },   // already auto-redeemed
    async approved() { return true; },
    async prepare() { throw new Error("must not prepare: nothing to redeem"); },
    async submit() { throw new Error("must not submit"); },
    async receipt() { return undefined; },
    async externalPayout() { return external; },
  } };
}

// --- bug case: zero-balance auto-redeem must be persisted and stay confirmed ---
{
  let persisted;
  let listed = true;
  const { b, calls } = backend({ marketFound: () => listed });
  const settle = await createLiveSettlementAdapter({ backend: b, restore: { schemaVersion: 1, wallet: WALLET, records: {} },
    persist: (st) => { persisted = st; } });
  const r1 = await settle(req);
  assert.equal(r1.state, "confirmed", "first poll recognises the venue auto-redeem as confirmed");
  const key = JSON.stringify([req.assetId, req.marketId, req.roundId]);
  assert.ok(persisted?.records?.[key], "P1-5: the confirmed auto-redeem must be written to state.records and saved");
  assert.equal(persisted.records[key].status, "confirmed", "P1-5: persisted record status is confirmed");
  // Gamma stops listing the round. The next poll must answer from the record,
  // not re-query the market (which would throw settlement_market_not_found).
  listed = false;
  const marketCallsBefore = calls.market;
  const r2 = await settle(req);
  assert.equal(r2.state, "confirmed", "P1-5: once recorded, a later poll stays confirmed even if the market is gone");
  assert.equal(calls.market, marketCallsBefore, "P1-5: a recorded confirmation must not re-query the market");
  console.log("PASS bug: zero-balance auto-redeem is persisted and stays confirmed after the market disappears");
}
// --- control: genuinely held positions still go through the normal redeem path ---
{
  let prepared = false;
  const b = {
    wallet: WALLET,
    async market() { return { tokenIds: [UP, DOWN], denominator: 1n, numerators: [0n, 1n], negRisk: false }; },
    async balances() { return { balances: [0n, 5_000_000n], cash: 206_000_000n, block: 1000n }; }, // still holds the winner
    async approved() { return true; },
    async prepare() { prepared = true; return { kind: "eoa", transactionHash: "0x" + "ee".repeat(32) }; },
    async submit() { return { transactionHash: "0x" + "ee".repeat(32) }; },
    async receipt() { return undefined; },
    async externalPayout() { return undefined; },
  };
  const settle = await createLiveSettlementAdapter({ backend: b, restore: { schemaVersion: 1, wallet: WALLET, records: {} }, persist: () => {} });
  const r = await settle(req);
  assert.ok(prepared, "control: a held winning position is still redeemed normally");
  assert.equal(r.state, "pending", "control: a submitted redemption is pending until its receipt");
  console.log("PASS control: a held position still takes the normal redeem path");
}
console.log("P1-5 OK");

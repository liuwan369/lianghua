// P2-19: a round that Gamma no longer lists makes backend.market()
// throw settlement_market_not_found BEFORE the zero-balance branch runs, and
// the lane catches it as "unsupported" without writing any record. So an old
// round that was already auto-redeemed (under the pre-P1-5 code nothing was
// persisted) can never be recorded as settled: it requeues every 15 s and eats
// a --max-rounds count on every start. Live: round 1790691600, 36-39 events
// per run.
//
// Fix: on not_found, read the round's token balances on chain. All zero means
// nothing left to redeem, so record it confirmed. Non-zero means real tokens
// are still held, so keep retrying (never drop redeemable funds).
//
// Real createLiveSettlementAdapter; only the IO backend is injected.
import assert from "node:assert/strict";
import { createLiveSettlementAdapter, UnsupportedSettlement } from "../../dist/platform/live-settlement.js";

const WALLET = "0x" + "a1".repeat(20);
const UP = "111", DOWN = "222";
const req = { assetId: "btc", marketId: "0x" + "ab".repeat(32), roundId: "1790691600", tokenIds: [UP, DOWN] };
const key = JSON.stringify([req.assetId, req.marketId, req.roundId]);
const make = (held) => {
  const calls = { market: 0 };
  return { calls, b: {
    wallet: WALLET,
    async market() { calls.market += 1; throw new UnsupportedSettlement("settlement_market_not_found"); },
    async balances(tokenIds) { return { balances: tokenIds.map((id) => BigInt(held[id] ?? 0)), cash: 211_116_499n, block: 1000n }; },
    async approved() { return true; },
    async prepare() { throw new Error("must not prepare"); },
    async submit() { throw new Error("must not submit"); },
    async receipt() { return undefined; },
    async externalPayout() { return undefined; },
  } };
};

// --- bug case: market gone, wallet holds nothing -> record confirmed, stop requeueing ---
{
  let persisted;
  const { b, calls } = make({});
  const settle = await createLiveSettlementAdapter({ backend: b, restore: { schemaVersion: 1, wallet: WALLET, records: {} },
    persist: (st) => { persisted = st; } });
  const r1 = await settle(req);
  assert.equal(r1.state, "confirmed", "P2-19: a delisted round with zero balance is settled, not unsupported");
  assert.equal(persisted?.records?.[key]?.status, "confirmed", "P2-19: the confirmation is persisted");
  const before = calls.market;
  const r2 = await settle(req);
  assert.equal(r2.state, "confirmed", "P2-19: the next poll answers from the record");
  assert.equal(calls.market, before, "P2-19: a recorded confirmation no longer queries the delisted market");
  console.log("PASS bug: delisted zero-balance round is recorded confirmed and stops requeueing");
}
// --- control: market gone but tokens still held -> must NOT be dropped ---
{
  let persisted;
  const { b } = make({ [DOWN]: 5_000_000 });
  const settle = await createLiveSettlementAdapter({ backend: b, restore: { schemaVersion: 1, wallet: WALLET, records: {} },
    persist: (st) => { persisted = st; } });
  const r = await settle(req);
  assert.notEqual(r.state, "confirmed", "control: held tokens on a delisted round must not be marked settled");
  assert.ok(!persisted?.records?.[key] || persisted.records[key].status !== "confirmed",
    "control: no confirmed record is written while tokens are still held");
  console.log("PASS control: a delisted round with tokens still held keeps retrying");
}
console.log("P2-19 OK");

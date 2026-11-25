// Polymarket Protocol V2 settlement (docs migrate/polymarket-v2/contract-
// integrations, resources/contracts): a V2 round's positions live in
// PositionManager (0x006F54F7...), and a winner is redeemed through Router
// (0x12121212...) `redeem(bytes31 conditionId, uint256 outcomeIndex, uint256
// amount)`, outcomeIndex 0 = YES/Up, 1 = NO/Down, after PositionManager
// `setApprovalForAll(ROUTER, true)`. CTF (V1) rounds are unchanged (adapter
// redeemPositions, CTF setApprovalForAll(adapter)).
// - redemptionPlanV2: Router.redeem with the narrowed bytes31 condition (its
//   final byte must be zero), the winning outcome's index and held amount;
// - a V2 round's first redeem asks for the Router approval on PositionManager,
//   then redeems; a V1 round keeps the adapter path;
// - a V2 round where only the loser is held settles with no transaction.
// Run after `npm run build`:  node scripts/regress/settlement-v2.mjs
import assert from "node:assert/strict";
import { decodeFunctionData, parseAbi } from "viem";
import { createLiveSettlementAdapter } from "../../dist/platform/live-settlement.js";
import { redemptionPlan, redemptionPlanV2, POSITION_MANAGER, ROUTER } from "../../dist/platform/settlement.js";

assert.equal(POSITION_MANAGER, "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF");
assert.equal(ROUTER, "0x12121212006e4CD160D18e3f00711DA5c3372600");
const routerAbi = parseAbi(["function redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)"]);
const pmAbi = parseAbi(["function setApprovalForAll(address operator, bool approved)"]);
const V2_ID = "0x01c3c0f9e4a02e50a09237576d84139573000000000000000000000000000000";   // the 11-24 test round
const UP = "798179898617452349377818383492013402217559367369383810129520465787159052288";
const DOWN = "798179898617452349377818383492013402217559367369383810129520465787159052289";

// --- the call ---
{
  const call = redemptionPlanV2(V2_ID, 1, 5_000_000n);
  assert.equal(call.to, ROUTER);
  const { functionName, args } = decodeFunctionData({ abi: routerAbi, data: call.data });
  assert.equal(functionName, "redeem");
  assert.equal(args[0], V2_ID.slice(0, 64), "bytes31: the padded condition without its zero final byte");
  assert.deepEqual([args[1], args[2]], [1n, 5_000_000n]);
  assert.throws(() => redemptionPlanV2("0x" + "ab".repeat(32), 0, 1n), /bytes31/, "a non-zero final byte is not a V2 condition");
  assert.throws(() => redemptionPlanV2(V2_ID, 2, 1n), /outcome/);
  assert.throws(() => redemptionPlanV2(V2_ID, 0, 0n), /amount/);
  // V1 unchanged.
  assert.equal(redemptionPlan({ marketId: "0x" + "ab".repeat(32), tokenIds: ["1", "2"] }).to, "0xAdA100Db00Ca00073811820692005400218FcE1f");
}

// --- the adapter: approval, then redeem; a loser sends nothing ---
const WALLET = "0x" + "a1".repeat(20);
const req = { assetId: "btc", marketId: V2_ID, roundId: "1795543200", tokenIds: [UP, DOWN] };
const backend = ({ numerators, held, approved }) => {
  const sent = [];
  let isApproved = approved;
  return { sent, impl: {
    wallet: WALLET,
    async market() { return { tokenIds: [UP, DOWN], negRisk: false, version: "v2", denominator: 1n, numerators }; },
    async balances(ids) { return { balances: ids.map(id => held[id] ?? 0n), cash: 100_000_000n, block: 1000n }; },
    async approved(version) { assert.equal(version, "v2", "the approval asked is the V2 one"); return isApproved; },
    async prepare(call) { sent.push(call); return { kind: "eoa", transactionHash: "0x" + "cd".repeat(32) }; },
    async submit() { return { transactionHash: "0x" + "cd".repeat(32) }; },
    async receipt() { return undefined; },
    async externalPayout() { return undefined; },
  } };
};
{
  const b = backend({ numerators: [0n, 1n], held: { [DOWN]: 5_000_000n }, approved: false });
  const settle = await createLiveSettlementAdapter({ backend: b.impl, restore: { schemaVersion: 1, wallet: WALLET, records: {} }, persist: () => {} });
  await settle(req);
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].to, POSITION_MANAGER, "first the Router approval on PositionManager");
  const approval = decodeFunctionData({ abi: pmAbi, data: b.sent[0].data });
  assert.deepEqual([approval.functionName, approval.args[0], approval.args[1]], ["setApprovalForAll", ROUTER, true]);
}
{
  const b = backend({ numerators: [0n, 1n], held: { [DOWN]: 5_000_000n }, approved: true });
  const settle = await createLiveSettlementAdapter({ backend: b.impl, restore: { schemaVersion: 1, wallet: WALLET, records: {} }, persist: () => {} });
  const r = await settle(req);
  assert.equal(r.state, "pending", r.reason);
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].to, ROUTER, "approved: the redeem");
  const { args } = decodeFunctionData({ abi: routerAbi, data: b.sent[0].data });
  assert.deepEqual([args[1], args[2]], [1n, 5_000_000n], "Down won: outcome 1, the held Down amount");
}
{
  const b = backend({ numerators: [1n, 0n], held: { [DOWN]: 5_000_000n }, approved: true });
  const settle = await createLiveSettlementAdapter({ backend: b.impl, restore: { schemaVersion: 1, wallet: WALLET, records: {} }, persist: () => {} });
  const r = await settle(req);
  assert.equal(r.state, "confirmed");
  assert.equal(b.sent.length, 0, "only the loser held: nothing to send");
}
console.log("settlement-v2 OK");

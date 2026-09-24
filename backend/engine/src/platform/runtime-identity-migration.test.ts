import { strict as assert } from "node:assert";
import { createLiveSettlementAdapter, type LiveSettlementBackend, type LiveSettlementRecord, type LiveSettlementState } from "./live-settlement.js";
import { TradingPlatform } from "./platform.js";
import type { AccountSnapshot, GatewayAck, Instrument, MarketInfo, OrderRequest } from "./contracts.js";

const marketId = `0x${"1".repeat(64)}`;
const yes: Instrument = { tokenId: "1001", marketId, outcome: "UP", tickSize: 0.01, minOrderSize: 1 };
const no: Instrument = { tokenId: "1002", marketId, outcome: "DOWN", tickSize: 0.01, minOrderSize: 1 };
const market: MarketInfo = { id: marketId, roundId: "1000", name: "btc-updown-5m-1000", startsAt: 1000,
  endsAt: 1300, instruments: [yes, no] };

class Gateway {
  readonly mode = "live" as const;
  async submit(request: OrderRequest): Promise<GatewayAck> {
    return { status: "accepted", orderId: `venue-${request.clientOrderId}`, venueStatus: "live" };
  }
  async cancel(): Promise<boolean> { return true; }
}

function account(openOrders: AccountSnapshot["openOrders"] = []): AccountSnapshot {
  return { accountId: "migration-test", at: 1000, cashUsd: 100, positions: [], openOrders, complete: true };
}

const platform = new TradingPlatform({ account: account(), instruments: [yes, no],
  limits: { capitalUsd: 100, dailyLossUsd: null, maxOrderUsd: 100, maxOpenOrders: 10 },
  adapters: { gateway: new Gateway(), estimateFee: () => 0 }, now: () => 1000 });
platform.ingest({ kind: "market", market });
const submitted = await platform.orders.submit({ clientOrderId: "legacy-order", strategyId: "btc-reversal",
  tokenId: yes.tokenId, direction: "BUY", price: 0.5, shares: 1, timeInForce: "GTC", postOnly: false });
assert.equal(submitted.status, "OPEN");
const legacyState = platform.account.current() as any;
delete legacyState.markets[0].roundId;
delete legacyState.orders[0].marketId;
delete legacyState.orders[0].roundId;
const restarted = new TradingPlatform({ account: account(legacyState.orders), instruments: [yes, no],
  limits: { capitalUsd: 100, dailyLossUsd: null, maxOrderUsd: 100, maxOpenOrders: 10 },
  adapters: { gateway: new Gateway(), estimateFee: () => 0 }, now: () => 1000, restored: legacyState });
restarted.ingest({ kind: "market", market });
assert.equal(restarted.account.current().markets?.[0]?.roundId, "1000");
assert.equal(restarted.orders.get(submitted.orderId!)?.marketId, marketId);
assert.equal(restarted.orders.get(submitted.orderId!)?.roundId, "1000");

const wallet = `0x${"2".repeat(40)}` as `0x${string}`;
const settlementMarketId = `0x${"3".repeat(64)}`;
const txHash = `0x${"4".repeat(64)}` as `0x${string}`;
let persisted: LiveSettlementState | undefined;
const backend: LiveSettlementBackend = {
  wallet,
  async market() { throw new Error("legacy confirmed record should not query market"); },
  async balances() { throw new Error("legacy confirmed record should not query balances"); },
  async approved() { return true; },
  async prepare() { throw new Error("legacy confirmed record should not prepare"); },
  async submit() { throw new Error("legacy confirmed record should not submit"); },
  async receipt() { throw new Error("legacy confirmed record should not query receipt"); },
};
const legacySettlement: LiveSettlementState = {
  schemaVersion: 1,
  wallet,
  records: {
    [settlementMarketId]: {
      marketId: settlementMarketId,
      tokenIds: ["5001", "5002"], status: "confirmed", operation: "redeem",
      prepared: { kind: "eoa" }, fromBlock: "1", balancesBefore: ["1", "0"], cashBefore: "0",
      expectedPayout: "1000000", transactionHash: txHash, creditedPusd: "1000000", cashAfter: "1000000",
    },
  } as any,
};
const settle = await createLiveSettlementAdapter({ backend, restore: legacySettlement,
  persist: state => { persisted = state; } });
const settlement = await settle({ marketId: settlementMarketId, assetId: "btc", roundId: "2000", tokenIds: ["5001", "5002"] });
assert.equal(settlement.state, "confirmed");
assert.equal(settlement.roundId, "2000");
assert.equal(settlement.assetId, "btc");
assert.ok(persisted?.records[JSON.stringify(["btc", settlementMarketId, "2000"])]);
assert.equal(persisted?.records[settlementMarketId], undefined);

const ethAttempt = await settle({ marketId: settlementMarketId, assetId: "eth", roundId: "2000", tokenIds: ["5001", "5002"] });
assert.equal(ethAttempt.state, "unsupported");
assert.equal(ethAttempt.reason, "settlement_asset_identity_changed");

const request = { marketId: settlementMarketId, assetId: "btc", roundId: "2000", tokenIds: ["5001", "5002"] };
const canonicalKey = JSON.stringify([request.assetId, request.marketId, request.roundId]);
const oldRoundKey = JSON.stringify([request.marketId, request.roundId]);
const confirmed = structuredClone(persisted!.records[canonicalKey]!);
const invalidRecords: Array<{ key: string; changes: Partial<LiveSettlementRecord>; reason: string }> = [
  { key: oldRoundKey, changes: { marketId }, reason: "settlement_market_identity_changed" },
  { key: oldRoundKey, changes: { roundId: "1999" }, reason: "settlement_round_identity_changed" },
  { key: oldRoundKey, changes: { tokenIds: ["5001", "5003"] }, reason: "settlement_token_identity_changed" },
  { key: oldRoundKey, changes: { assetId: "eth" }, reason: "settlement_asset_identity_changed" },
  { key: request.marketId, changes: { marketId, roundId: undefined }, reason: "settlement_market_identity_changed" },
  { key: request.marketId, changes: { roundId: "1999" }, reason: "settlement_round_identity_changed" },
  { key: canonicalKey, changes: { marketId }, reason: "settlement_market_identity_changed" },
];
for (const { key, changes, reason } of invalidRecords) {
  const restore: LiveSettlementState = { schemaVersion: 1, wallet,
    records: { [key]: { ...structuredClone(confirmed), ...changes } } };
  const before = structuredClone(restore);
  let saves = 0;
  const adapter = await createLiveSettlementAdapter({ backend, restore, persist: () => { saves++; } });
  const rejected = await adapter(request);
  assert.equal(rejected.state, "unsupported", `${key}: ${reason}`);
  assert.equal(rejected.reason, reason);
  assert.equal(saves, 0, "invalid persisted identity must never be migrated or saved");
  assert.deepEqual(restore, before, "invalid persisted identity must remain unchanged");
}

for (const key of [oldRoundKey, request.marketId]) {
  const legacy = structuredClone(confirmed);
  if (key === request.marketId) delete legacy.roundId;
  // Explicit asset identity must survive a failed persistence, including an
  // otherwise valid migration that will be retried in this same process.
  const restore: LiveSettlementState = { schemaVersion: 1, wallet, records: { [key]: legacy } };
  const before = structuredClone(restore);
  let attempts = 0;
  const adapter = await createLiveSettlementAdapter({ backend, restore, persist: () => {
    if (++attempts === 1) throw new Error("storage unavailable");
  } });
  assert.equal((await adapter(request)).state, "pending");
  assert.deepEqual(restore, before, "failed migration preserves every original identity field");
  const retried = await adapter(request);
  assert.equal(retried.state, "confirmed");
  assert.equal(retried.payoutVerified, true);
  assert.equal(restore.records[key], undefined);
  assert.equal(restore.records[canonicalKey]?.assetId, "btc");
  assert.equal(restore.records[canonicalKey]?.roundId, "2000");
}

const unlabelledRound = structuredClone(confirmed);
delete unlabelledRound.assetId;
const roundRestore: LiveSettlementState = { schemaVersion: 1, wallet, records: { [oldRoundKey]: unlabelledRound } };
const roundAdapter = await createLiveSettlementAdapter({ backend, restore: roundRestore, persist: () => {} });
assert.equal((await roundAdapter(request)).state, "confirmed", "unlabelled BTC round remains migratable");
assert.equal(roundRestore.records[canonicalKey]?.assetId, "btc");

console.log("runtime-identity-migration.test: PASS");

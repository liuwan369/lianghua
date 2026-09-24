import { strict as assert } from "node:assert";
import { createLiveSettlementAdapter, type LiveSettlementBackend, type LiveSettlementState } from "./live-settlement.js";
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
const settlement = await settle({ marketId: settlementMarketId, roundId: "2000", tokenIds: ["5001", "5002"] });
assert.equal(settlement.state, "confirmed");
assert.equal(settlement.roundId, "2000");
assert.ok(persisted?.records[JSON.stringify([settlementMarketId, "2000"])]);
assert.equal(persisted?.records[settlementMarketId], undefined);

console.log("runtime-identity-migration.test: PASS");

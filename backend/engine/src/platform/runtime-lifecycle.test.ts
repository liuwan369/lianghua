import { strict as assert } from "node:assert";
import { TradingPlatform } from "./platform.js";
import { validateMarketSnapshot } from "./snapshot-gate.js";
import { createBtcReversalStrategy } from "../strategies/btc-reversal.js";
import type { AccountSnapshot, GatewayAck, Instrument, MarketBookSnapshot, MarketInfo, OrderRequest, TradeFill } from "./contracts.js";

const marketId = "0x" + "1".repeat(64);
const yes: Instrument = { tokenId: "yes-1", marketId, outcome: "UP", tickSize: 0.01, minOrderSize: 1 };
const no: Instrument = { tokenId: "no-1", marketId, outcome: "DOWN", tickSize: 0.01, minOrderSize: 1 };
const market: MarketInfo = { id: marketId, roundId: "1000", name: "btc-updown-5m-1000", startsAt: 1000, endsAt: 1300, instruments: [yes, no] };

function snapshot(sequence: number, at: number, yesAsk: number, noAsk: number): MarketBookSnapshot {
  return {
    marketId, roundId: "1000", sequence, sourceAt: at, expiresAt: 1299, tsUnix: at,
    YES: { assetId: yes.tokenId, bid: yesAsk - 0.05, ask: yesAsk, bidSize: 10, askSize: 10,
      sourceAt: at, expiresAt: 1299, sequence },
    NO: { assetId: no.tokenId, bid: noAsk - 0.05, ask: noAsk, bidSize: 10, askSize: 10,
      sourceAt: at, expiresAt: 1299, sequence },
  };
}

class FakeGateway {
  readonly mode = "live" as const;
  submissions: OrderRequest[] = [];
  cancellations: string[] = [];
  closed = false;
  async submit(request: OrderRequest): Promise<GatewayAck> {
    this.submissions.push(structuredClone(request));
    return { status: "accepted", orderId: `venue-${request.clientOrderId}`, venueStatus: "live" };
  }
  async cancel(orderId: string): Promise<boolean> {
    this.cancellations.push(orderId);
    return true;
  }
  async close(): Promise<void> { this.closed = true; }
}

function createPlatform(now: () => number, gateway: FakeGateway,
  restored?: ReturnType<TradingPlatform["account"]["current"]>, readAccount?: () => Promise<AccountSnapshot>): TradingPlatform {
  return new TradingPlatform({
    account: restored ? {
      accountId: "runtime-lifecycle", at: now(), cashUsd: restored.cashUsd, positions: restored.positions,
      openOrders: restored.orders, complete: true,
    } : { accountId: "runtime-lifecycle", at: now(), cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments: [yes, no], limits: { capitalUsd: 100, dailyLossUsd: null, maxOrderUsd: 100, maxOpenOrders: 10 },
    adapters: { gateway, estimateFee: () => 0, readAccount }, now, restored,
  });
}

const lifecycle = async () => {
  let now = 1000;
  const gateway = new FakeGateway();
  const platform = createPlatform(() => now, gateway, undefined, async () => ({ accountId: "runtime-lifecycle", at: 1005,
    cashUsd: 99.3, positions: [{ tokenId: yes.tokenId, shares: 1, costUsd: 0.7, realizedPnlUsd: 0 }], openOrders: [], complete: true }));
  const events: string[] = [];
  platform.subscribe(event => {
    events.push(event.kind);
    if (event.kind === "order" && event.order.clientOrderId === "btc-reversal:0x1111111111111111111111111111111111111111111111111111111111111111:1") {
      assert.equal(event.roundId, "1000");
      assert.equal(event.order.roundId, "1000");
    }
  });
  platform.ingest({ kind: "market", market });
  const strategy = createBtcReversalStrategy({ triggerPrice: 0.6, confirmationPrice: 0.65,
    maxBuyPrice: 0.7, stageShares: [1], maxStages: 1, maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 });
  platform.attach(strategy);

  let watermark = validateMarketSnapshot(snapshot(1, 1000, 0.5, 0.5),
    { marketId, roundId: "1000", endsAt: 1300, yesAssetId: yes.tokenId, noAssetId: no.tokenId }, undefined, now, true);
  assert.equal(watermark.ok, true);
  platform.ingestSnapshot(snapshot(1, 1000, 0.5, 0.5));
  now = 1001;
  const crossing = snapshot(2, 1001, 0.7, 0.5);
  const accepted = validateMarketSnapshot(crossing,
    { marketId, roundId: "1000", endsAt: 1300, yesAssetId: yes.tokenId, noAssetId: no.tokenId },
    watermark.ok ? watermark.watermark : undefined, now, true);
  assert.equal(accepted.ok, true);
  if (accepted.ok) watermark = accepted;
  platform.ingestSnapshot(crossing);
  await platform.idle();
  assert.equal(gateway.submissions.length, 1, "one crossing creates one venue submission");
  assert.equal(gateway.submissions[0]?.marketId, marketId);
  assert.equal(gateway.submissions[0]?.roundId, "1000");
  const order = platform.orders.list()[0]!;
  assert.equal(order.marketId, marketId);
  assert.equal(order.roundId, "1000");
  assert.equal(order.status, "OPEN");
  assert.equal(platform.risk.current().occupiedUsd, 0.7, "BUY reserve is held before fill");

  await platform.orders.submit({ ...gateway.submissions[0] });
  await platform.idle();
  assert.equal(gateway.submissions.length, 1, "same economic order is idempotent after ACK");
  assert.equal(validateMarketSnapshot(crossing,
    { marketId, roundId: "1000", endsAt: 1300, yesAssetId: yes.tokenId, noAssetId: no.tokenId },
    watermark.ok ? watermark.watermark : undefined, now, true).ok, false,
  "same sequence cannot trigger a second decision");

  const fill: TradeFill = { tradeId: "trade-1", orderId: order.orderId!, tokenId: yes.tokenId,
    direction: "BUY", price: 0.7, shares: 1, feeUsd: 0, ts: now, isMaker: true, status: "CONFIRMED", feeSource: "reported" };
  platform.ingest({ kind: "fill", fill });
  platform.ingest({ kind: "fill", fill });
  assert.equal(platform.portfolio.fills().length, 1, "duplicate trade event is ignored");
  assert.equal(platform.portfolio.fills()[0]?.marketId, marketId);
  assert.equal(platform.portfolio.fills()[0]?.roundId, "1000");
  assert.throws(() => platform.ingest({ kind: "fill", fill: { ...fill, status: "MINED", roundId: "1100" } }),
    /trade market identity changed/, "a duplicate trade status update cannot cross rounds");
  assert.throws(() => platform.ingest({ kind: "fill", fill: { ...fill, orderId: "foreign-order" } }),
    /trade identity collision/, "one venue trade cannot be attached to two orders");
  assert.equal(platform.orders.get(order.orderId!)?.status, "FILLED");
  assert.equal(platform.orders.get(order.orderId!)?.reservedUsd, 0, "fill releases the working-order reserve");
  assert.equal(platform.risk.current().occupiedUsd, 0.7, "filled cost moves into position occupancy");

  const open = await platform.orders.submit({ clientOrderId: "manual-open", strategyId: "btc-reversal", tokenId: no.tokenId,
    direction: "BUY", price: 0.5, shares: 1, timeInForce: "GTC", postOnly: false });
  await platform.idle();
  assert.equal(open.status, "OPEN");
  const cancelled = await platform.orders.cancel(open.orderId!);
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.venueStatus, "canceled");
  assert.equal(cancelled.cancellationSource, "local_http");
  assert.equal(gateway.cancellations.length, 1);
  platform.core.observeVenueStatus(open.orderId!, "canceled", { source: "user_ws", observedAt: now });
  platform.core.confirmCancelled(open.orderId!, false, "user_ws", now);
  platform.account.reconcile({ accountId: "runtime-lifecycle", at: 1002, cashUsd: 99.3,
    positions: [{ tokenId: yes.tokenId, shares: 1, costUsd: 0.7, realizedPnlUsd: 0 }], openOrders: [], complete: true });
  assert.equal(platform.orders.get(open.orderId!)?.reconciliationPending, false, "account evidence releases cancel reserve");

  const restoredState = platform.account.current();
  const restoredGateway = new FakeGateway();
  const restarted = createPlatform(() => now, restoredGateway, restoredState);
  const restoredStrategy = createBtcReversalStrategy({}, { restoredState: strategy.exportState() });
  restarted.ingest({ kind: "market", market });
  restarted.attach(restoredStrategy);
  assert.equal(restarted.risk.current().reconciliationRequired, false);
  const replay = await restarted.orders.submit({ ...gateway.submissions[0] });
  assert.equal(replay.orderId, order.orderId, "restart returns the persisted economic order");
  assert.equal(restoredGateway.submissions.length, 0, "restart does not submit a duplicate order");
  restarted.ingestSnapshot(snapshot(3, 1002, 0.5, 0.5));
  await restarted.stop("restart-test-stop");
  assert.equal(restoredGateway.closed, true);

  const settlementEvents: string[] = [];
  const settlementPlatform = createPlatform(() => now, new FakeGateway());
  settlementPlatform.ingest({ kind: "market", market });
  settlementPlatform.subscribe(event => { if (event.kind === "settlement") settlementEvents.push(event.result.state); });
  const result = await settlementPlatform.settlement.redeem({ marketId, tokenIds: [yes.tokenId, no.tokenId] });
  assert.equal(result.state, "unsupported");
  assert.equal(result.roundId, "1000");
  assert.deepEqual(settlementEvents, ["unsupported"]);

  const stopOpen = await platform.orders.submit({ clientOrderId: "stop-open", strategyId: "btc-reversal", tokenId: no.tokenId,
    direction: "BUY", price: 0.5, shares: 1, timeInForce: "GTC", postOnly: false });
  assert.equal(stopOpen.status, "OPEN");
  await platform.stop("lifecycle-test-stop");
  assert.equal(gateway.cancellations.length, 2, "stop cancels the remaining active order");
  assert.equal(events.at(-1), "stopped", "stop always emits the terminal event");
  await settlementPlatform.stop("settlement-test-stop");
};

await lifecycle();
console.log("runtime-lifecycle.test: PASS");

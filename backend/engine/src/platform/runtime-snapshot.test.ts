import { strict as assert } from "node:assert";
import { TradingPlatform } from "./platform.js";
import { createBtcReversalStrategy } from "../strategies/btc-reversal.js";
import type { Instrument, MarketBookSnapshot, MarketInfo } from "./contracts.js";

const yes: Instrument = { tokenId: "yes-1", marketId: "market-1", outcome: "UP", tickSize: 0.01, minOrderSize: 1 };
const no: Instrument = { tokenId: "no-1", marketId: "market-1", outcome: "DOWN", tickSize: 0.01, minOrderSize: 1 };
const market: MarketInfo = { id: "market-1", roundId: "1000", name: "btc-updown-5m-1000", startsAt: 1000, endsAt: 1300,
  instruments: [no, yes] };

function createPlatform(now: () => number): TradingPlatform {
  return new TradingPlatform({
    account: { accountId: "snapshot-test", at: 1000, cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments: [no, yes], limits: { capitalUsd: 100, dailyLossUsd: null, maxOrderUsd: 100, maxOpenOrders: 10 },
    adapters: { gateway: {
      mode: "live",
      submit: async request => ({ status: "accepted", orderId: `venue-${request.clientOrderId}` }),
      cancel: async () => true,
    } }, now,
  });
}

function paired(sequence: number, at: number, yesAsk: number, noAsk: number): MarketBookSnapshot {
  return { marketId: "market-1", roundId: "1000", sequence, sourceAt: at, expiresAt: 1299, tsUnix: at,
    YES: { assetId: "yes-1", bid: yesAsk - 0.05, ask: yesAsk, sourceAt: at, expiresAt: 1299,
      depthSourceAt: at, depthExpiresAt: 1298, bids: [[yesAsk - 0.05, 10]], asks: [[yesAsk, 10]], sequence },
    NO: { assetId: "no-1", bid: noAsk - 0.05, ask: noAsk, sourceAt: at, expiresAt: 1299,
      depthSourceAt: at, depthExpiresAt: 1298, bids: [[noAsk - 0.05, 10]], asks: [[noAsk, 10]], sequence } };
}

function pairedWithConflictingDepth(sequence: number, at: number, yesAsk: number, noAsk: number): MarketBookSnapshot {
  const value = paired(sequence, at, yesAsk, noAsk);
  return { ...value,
    YES: { ...value.YES!, bid: yesAsk - 0.04, bids: [[yesAsk - 0.01, 9]], asks: [[yesAsk - 0.01, 11]] },
    NO: { ...value.NO!, bid: noAsk - 0.04, bids: [[noAsk + 0.01, 9]], asks: [[noAsk + 0.01, 11]] } };
}

{
  let now = 1000;
  const platform = createPlatform(() => now);
  platform.ingest({ kind: "market", market });
  let observed: MarketBookSnapshot | undefined;
  let strategyObserved: MarketBookSnapshot | undefined;
  platform.subscribe(event => { if (event.kind === "book" && event.snapshot) observed = event.snapshot; });
  const strategy = createBtcReversalStrategy({}, { persist: () => undefined });
  platform.attach(strategy);
  platform.attach({ id: "snapshot-observer", onEvent: event => {
    if (event.kind === "book" && event.snapshot) strategyObserved = event.snapshot;
    return [];
  } });
  const first = paired(1, 1000, 0.5, 0.5);
  assert.equal(platform.ingestSnapshot(first), true);
  const accepted = { ...first, assetId: "btc" };
  assert.deepEqual(observed, accepted, "listeners receive the registered market asset and original paired snapshot");
  assert.deepEqual(strategyObserved, accepted, "strategy receives the same paired shape");
  assert.deepEqual(platform.market.snapshots()[0], accepted, "status snapshots preserve the accepted paired object");
  const status = strategy.getStatus();
  assert.equal(status.rounds[0]?.roundId, "1000", "strategy status exposes the explicit round identity");
  assert.equal(status.currentRound?.roundId, "1000", "strategy status exposes the current round identity");
  assert.equal(platform.market.book("yes-1")?.ask, 0.5);
  assert.equal(platform.market.book("no-1")?.ask, 0.5);
  assert.deepEqual(platform.market.depth("yes-1")?.asks, [[0.5, 10]], "valid L2 depth is preserved");
  now = 1298;
  assert.equal(platform.market.depth("yes-1"), undefined, "expired L2 depth is unavailable");
  now = 1000;
  assert.equal(platform.ingestSnapshot({ ...first, sequence: 2,
    YES: { ...first.YES!, assetId: "wrong" }, }), false, "wrong token identity is rejected");
  assert.throws(() => platform.ingest({ kind: "market", market: { ...market, roundId: "1100" } }),
    /market round identity is required/, "market round identity must match the five-minute start");
}

{
  let now = 1000;
  const platform = createPlatform(() => now);
  platform.ingest({ kind: "market", market });
  const strategy = createBtcReversalStrategy({ triggerPrice: 0.6, confirmationPrice: 0.65,
    maxBuyPrice: 0.7, stageShares: [1], maxStages: 1, maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 },
    { persist: () => undefined });
  platform.attach(strategy);

  let listenerSnapshot: MarketBookSnapshot | undefined;
  let strategySnapshot: MarketBookSnapshot | undefined;
  let strategyContextBook: { tokenId: string; bids?: unknown[]; asks?: unknown[] } | undefined;
  platform.subscribe(event => { if (event.kind === "book" && event.snapshot) listenerSnapshot = event.snapshot; });
  const strategyOnEvent = strategy.onEvent.bind(strategy);
  strategy.onEvent = (event, context) => {
    if (event.kind === "book" && event.snapshot) {
      strategySnapshot = event.snapshot;
      strategyContextBook = context.books.find(book => book.tokenId === "yes-1");
    }
    return strategyOnEvent(event, context);
  };
  const baseline = pairedWithConflictingDepth(1, 1000, 0.41, 0.59);
  assert.equal(platform.ingestSnapshot(baseline), true,
    "a fresh BBO remains executable while L2 top levels are temporarily different");
  const accepted = { ...baseline, assetId: "btc" };
  assert.deepEqual(listenerSnapshot, accepted, "the platform listener receives the accepted paired snapshot");
  assert.deepEqual(strategySnapshot, accepted, "the strategy listener receives the same paired snapshot");
  assert.ok(Math.abs(platform.market.snapshots()[0]?.YES?.bids?.[0]?.[0]! - 0.4) < 1e-9,
    "the accepted snapshot keeps the venue L2 for API display");
  assert.equal(platform.market.book("yes-1")?.ask, 0.41, "the market book exposes the fast BBO ask");
  assert.equal(platform.market.book("no-1")?.ask, 0.59, "the market book exposes the fast BBO ask");
  assert.ok(Math.abs(platform.market.depth("yes-1")?.asks?.[0]?.[0]! - 0.4) < 1e-9,
    "display depth keeps the original L2 instead of rewriting it to BBO");
  assert.equal(strategyContextBook?.bids, undefined,
    "strategy context does not expose conflicting L2 to execution logic");
  assert.equal(strategyContextBook?.asks, undefined,
    "strategy context does not expose conflicting L2 asks to execution logic");
  const coreBooks = (platform.core as unknown as { books: Map<string, { bids?: unknown[]; asks?: unknown[] }> }).books;
  assert.equal(coreBooks.get("yes-1")?.bids, undefined,
    "conflicting L2 is removed from the core execution book");
  assert.equal(coreBooks.get("yes-1")?.asks, undefined,
    "conflicting L2 asks are removed from the core execution book");

  now = 1001;
  assert.equal(platform.ingestSnapshot(pairedWithConflictingDepth(2, 1001, 0.7, 0.5)), true,
    "a later BBO crossing is accepted despite the same temporary L2 skew");
  assert.equal(strategy.exportState().rounds[0]?.stages[0]?.direction, "UP",
    "the strategy consumes the fresh BBO and can trigger normally");
}

{
  let now = 1000;
  const platform = createPlatform(() => now);
  platform.ingest({ kind: "market", market });
  const strategy = createBtcReversalStrategy({ triggerPrice: 0.6, confirmationPrice: 0.65,
    maxBuyPrice: 0.7, stageShares: [1], maxStages: 1, maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5 });
  platform.attach(strategy);
  platform.ingestSnapshot(paired(1, 1000, 0.5, 0.5));
  now = 1001;
  platform.ingest({ kind: "error", strategyId: "btc-reversal", marketId: market.id,
    code: "market_feed_unhealthy", message: "market_feed_unhealthy:transport_disconnected" });
  platform.ingestSnapshot(paired(2, 1001, 0.7, 0.5));
  assert.equal(strategy.exportState().rounds[0]?.stages.length, 0,
    "the first paired snapshot after reconnect only rebuilds the baseline");
  platform.ingestBooks([
    { tokenId: "yes-1", ts: 1001, receivedAt: 1001, bid: 0.65, ask: 0.7 },
    { tokenId: "no-1", ts: 1001, receivedAt: 1001, bid: 0.45, ask: 0.5 },
  ]);
  assert.equal(strategy.exportState().rounds[0]?.stages.length, 0,
    "legacy unpaired books cannot trigger the BTC strategy");
  now = 1002;
  platform.ingestSnapshot(paired(3, 1002, 0.5, 0.5));
  now = 1003;
  platform.ingestSnapshot(paired(4, 1003, 0.7, 0.5));
  assert.equal(strategy.exportState().rounds[0]?.stages[0]?.direction, "UP",
    "a fresh paired crossing triggers one stage after recovery");
}

console.log("runtime-snapshot.test: PASS");

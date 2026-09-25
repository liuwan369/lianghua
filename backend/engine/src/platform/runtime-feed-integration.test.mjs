import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mock, test } from "node:test";

// Exercise the real feed/parser/queue/connector together. All account and
// transport IO is replaced before loading the connector; no credentials or
// network are used, and any attempt to submit an order fails the test.
class Socket extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  readyState = 0;
  sent = [];
  constructor() {
    super(); Socket.instances.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit("open"); });
  }
  send(data) { this.sent.push(data); }
  terminate() { if (this.readyState !== 3) { this.readyState = 3; this.emit("close"); } }
  frame(value) { this.emit("message", JSON.stringify(value)); }
}
mock.module("ws", { defaultExport: Socket });
mock.module("../../dist/live/account.js", { namedExports: { ownerSignerPrivateKey: () => "test-only-placeholder" } });
mock.module("../../dist/live/account-data.js", { namedExports: { connectAccountReader: async () => async () => ({
  wallet: "test-account", checked_at: new Date(Date.now()).toISOString(),
  collateral: { available: true, complete: true, value: 100 },
  positions: { available: true, complete: true, items: [] },
  open_orders: { available: true, complete: true, items: [] },
}) } });
mock.module("../../dist/live/clob/client.js", { namedExports: {
  geocheck: async () => {},
  ClobWrapper: { connect: async () => ({
    warmMarket: async () => {}, feeRule: () => undefined,
    startHeartbeat: () => () => {}, stopHeartbeat: () => {},
    submitOrder: async () => { throw new Error("unexpected order in feed-only integration test"); },
  }) },
} });
mock.module("../../dist/live/feeds/user.js", { namedExports: {
  parseAuthenticatedTrade: () => { throw new Error("unexpected account trade"); },
  runUserFeed: sink => {
    queueMicrotask(() => sink({ kind: "userStatus", healthy: true, tsUnix: Date.now() / 1000 }));
    return { stop: () => {}, isHealthy: () => true, isContinuous: () => true,
      registerOrder: () => {}, waitUntilReady: async () => {} };
  },
} });
mock.module("../../dist/platform/cash-flows.js", { namedExports: {
  readCashFlowEvidence: async () => { throw new Error("background history unavailable in test"); },
} });

const { connectPolymarketPlatform } = await import("../../dist/platform/polymarket.js");

test("actual feed shape reaches runtime and status; disconnect and round identities stay isolated", async t => {
  let nowMs = 1800000010000;
  mock.method(Date, "now", () => nowMs);
  const forbiddenFetch = mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
  t.after(() => mock.restoreAll());
  const market = (start, id) => ({
    id, assetId: "btc", referenceProducer: "btc-reference", roundId: String(start),
    name: `btc-updown-5m-${start}`, startsAt: start, endsAt: start + 300,
    instruments: ["YES", "NO"].map(outcome => ({ tokenId: `${id}-${outcome}`, marketId: id,
      outcome, tickSize: 0.01, minOrderSize: 1 })),
  });
  const current = market(1800000000, "current"), next = market(1800000300, "next");
  const connection = await connectPolymarketPlatform({ mode: "live", assetId: "btc", markets: [current, next],
    limits: { capitalUsd: 10, maxOrderUsd: 5, maxOpenOrders: 2 }, persist: () => {}, durationSec: 600 });
  t.after(() => connection.stop("test complete"));
  const decisions = [], displayed = [];
  connection.platform.attach({ id: "feed-observer", onEvent: event => {
    if (event.kind === "book" && event.snapshot) decisions.push(event.snapshot);
    return [];
  } });
  connection.platform.subscribe(event => { if (event.kind === "book" && event.snapshot) displayed.push(event.snapshot); });
  await connection.start();
  await delay(0);
  const socketFor = id => Socket.instances.find(socket => socket.readyState === 1
    && socket.sent.some(message => JSON.parse(message).assets_ids?.includes(`${id}-YES`)));
  const book = (id, outcome, timestamp, ask = 0.5) => ({ event_type: "book", asset_id: `${id}-${outcome}`,
    timestamp: String(timestamp), bids: [{ price: String(ask - 0.05), size: "10" }],
    asks: [{ price: String(ask), size: "10" }] });
  const pair = (id, timestamp, ask = 0.5) => [book(id, "YES", timestamp, ask), book(id, "NO", timestamp)];
  const currentSocket = socketFor("current"), nextSocket = socketFor("next");
  assert.ok(currentSocket && nextSocket, "identity-aware feed with default fifth parameter starts");
  currentSocket.frame(pair("current", nowMs - 100));
  nextSocket.frame(pair("next", nowMs - 100));
  await delay(0);
  assert.deepEqual(decisions.map(s => s.marketId).sort(), ["current", "next"], "neither market replaces the other in FeedQueue");
  assert.deepEqual(displayed, decisions, "display and strategy consume one accepted shape");
  for (const snapshot of decisions) {
    assert.equal(snapshot.assetId, "btc");
    assert.equal(snapshot.sourceAt, (nowMs - 100) / 1000, "venue timestamp is preserved");
    assert.equal(snapshot.YES.assetId, `${snapshot.marketId}-YES`);
  }

  // A busy current round must not starve the prewarmed next round. Refill the
  // current queue synchronously from its own consumer callback and verify the
  // next market is still delivered while that stream remains busy.
  let currentFlood = 0;
  let nextDuringFlood = false;
  const unsubscribeFairness = connection.platform.subscribe(event => {
    if (event.kind !== "book" || !event.snapshot) return;
    if (event.snapshot.marketId === "next" && currentFlood > 0) nextDuringFlood = true;
    if (event.snapshot.marketId !== "current" || currentFlood >= 1000) return;
    currentFlood += 1;
    currentSocket.frame(pair("current", nowMs - 90 + currentFlood, 0.51));
  });
  currentSocket.frame(pair("current", nowMs - 90, 0.51));
  nextSocket.frame(pair("next", nowMs - 90, 0.51));
  for (let i = 0; i < 20 && !nextDuringFlood; i++) await delay(5);
  unsubscribeFairness();
  assert.equal(nextDuringFlood, true, "a busy current queue cannot starve the next round");
  assert.ok(currentFlood > 0, "the current queue stayed busy during the fairness check");

  currentSocket.terminate();
  await delay(0);
  const count = decisions.length;
  currentSocket.frame(pair("current", nowMs - 90, 0.6));
  await delay(0);
  assert.equal(decisions.length, count, "a disconnected feed cannot use a late frame");
  for (let i = 0; i < 100 && !socketFor("current"); i++) await delay(10);
  const reconnected = socketFor("current");
  assert.ok(reconnected && reconnected !== currentSocket);
  reconnected.frame(pair("current", nowMs - 100, 0.6));
  await delay(0);
  assert.equal(decisions.length, count, "reconnect rejects replayed venue timestamps");
  nowMs += 100;
  reconnected.frame(book("current", "YES", nowMs - 50, 0.6));
  await delay(0);
  assert.equal(decisions.length, count, "one fresh side cannot reopen execution");
  reconnected.frame(book("current", "NO", nowMs - 50, 0.51));
  await delay(0);
  assert.equal(decisions.length, count + 1, `a new complete pair restores execution: ${JSON.stringify(
    connection.platform.history.events().filter(e => e.kind === "error"))}`);
  assert.equal(decisions.at(-1).roundId, current.roundId);
  assert.equal(connection.platform.market.snapshots().find(s => s.marketId === "next").roundId, next.roundId);
  assert.equal(connection.platform.orders.list().length, 0);
  assert.equal(forbiddenFetch.mock.callCount(), 0, "no network request escaped mocked IO");
});

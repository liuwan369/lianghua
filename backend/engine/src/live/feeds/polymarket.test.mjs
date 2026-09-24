import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mock, test } from "node:test";

class Socket extends EventEmitter {
  static OPEN = 1;
  static instances = [];
  static autoOpen = true;
  readyState = 0;
  sent = [];
  constructor() {
    super();
    Socket.instances.push(this);
    queueMicrotask(() => {
      if (Socket.autoOpen && this.readyState !== 3) { this.readyState = 1; this.emit("open"); }
    });
  }
  send(data) { this.sent.push(data); }
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  frame(value) { this.emit("message", JSON.stringify(value)); }
}

mock.module("ws", { defaultExport: Socket });
const { runPolymarketFeed, reconnectDelayMs } = await import("../../../dist/live/feeds/polymarket.js");
const stamp = () => Date.now() - 100;
const book = (asset, time, bid = 0.4, ask = 0.6) => ({
  event_type: "book", asset_id: asset, timestamp: String(time),
  bids: [{ price: String(bid), size: "10" }], asks: [{ price: String(ask), size: "12" }],
});
const top = (asset, time, bid = 0.45, ask = 0.55) => ({
  event_type: "best_bid_ask", asset_id: asset, timestamp: String(time), best_bid: bid, best_ask: ask,
});
async function harness(t) {
  const events = [];
  const feed = runPolymarketFeed(e => events.push(e), "yes", "no", Date.now() / 1000 + 60,
    { marketId: "market", roundId: "round" });
  t.after(() => feed.stop());
  await delay(0);
  const socket = Socket.instances.at(-1);
  assert.deepEqual(JSON.parse(socket.sent[0]).assets_ids, ["yes", "no"]);
  return { feed, socket, events, books: () => events.filter(e => e.kind === "book").map(e => e.snapshot) };
}

test("same-frame timestamps use wire order; older fast quote cannot override newer L2", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("yes", time), book("no", time), top("yes", time)]);
  assert.equal(h.books().at(-1).YES.bid, 0.45);
  h.socket.frame([book("yes", time + 20, 0.48), top("yes", time + 10, 0.41)]);
  assert.equal(h.books().at(-1).YES.bid, 0.48);
  h.socket.frame([top("yes", time + 30, 0.47), book("yes", time + 30, 0.49)]);
  assert.equal(h.books().at(-1).YES.bid, 0.49);
  const count = h.books().length;
  h.socket.frame(top("yes", time + 30, 0.1));
  assert.equal(h.books().length, count);
});

test("nested price_change uses the frame timestamp and last valid top", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("yes", time), book("no", time)]);
  h.socket.frame({ event_type: "price_change", timestamp: String(time + 1), price_changes: [
    { asset_id: "yes", price: "0.41", size: "10", side: "BUY", best_bid: "0.41", best_ask: "0.6" },
    { asset_id: "yes", price: "0.42", size: "10", side: "BUY", best_bid: "0.42", best_ask: "0.6" },
  ] });
  assert.equal(h.books().at(-1).YES.bid, 0.42);
  assert.equal(h.books().at(-1).upExchangeTsUnix, (time + 1) / 1000);
});

test("multiple feeds emit scoped health and snapshots without leaking other markets", async t => {
  const h = await harness(t), time = stamp();
  const otherEvents = [];
  const other = runPolymarketFeed(e => otherEvents.push(e), "eth-yes", "eth-no", Date.now() / 1000 + 60,
    { marketId: "eth-market", roundId: "round" });
  t.after(() => other.stop());
  await delay(0);
  const otherSocket = Socket.instances.at(-1);
  h.socket.frame([book("eth-yes", time), book("eth-no", time)]);
  assert.equal(h.books().length, 0);
  h.socket.frame([book("yes", time), book("no", time)]);
  otherSocket.frame([book("eth-yes", time), book("eth-no", time)]);
  h.feed.stop();
  assert.equal(other.isHealthy(), true);
  for (const status of h.events.filter(e => e.kind === "bookStatus")) {
    assert.equal(status.marketId, "market");
    assert.equal(status.roundId, "round");
    assert.equal(status.yesAssetId, "yes");
    assert.equal(status.noAssetId, "no");
  }
  for (const status of otherEvents.filter(e => e.kind === "bookStatus")) {
    assert.equal(status.marketId, "eth-market");
    assert.equal(status.yesAssetId, "eth-yes");
    assert.equal(status.noAssetId, "eth-no");
  }
  assert.equal(otherEvents.find(e => e.kind === "book").snapshot.marketId, "eth-market");
});

test("empty top invalidates both same-frame and later equal-time L2", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("yes", time), book("no", time)]);
  h.socket.frame([book("yes", time + 1, 0.46), top("yes", time + 1, "", null)]);
  assert.equal(h.feed.isHealthy(), false);
  const count = h.books().length;
  h.socket.frame(book("yes", time + 1));
  assert.equal(h.books().length, count);
  assert.equal(h.feed.isHealthy(), false);
  h.socket.frame(top("yes", time + 2, 0.47));
  assert.equal(h.books().at(-1).YES.bid, 0.47);
  assert.equal(h.feed.isHealthy(), true);
});

test("fast tombstone cannot be restored by a different channel's equal-time book", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("yes", time), book("no", time)]);
  h.socket.frame(top("yes", time + 1, null, ""));
  const count = h.books().length;
  h.socket.frame(book("yes", time + 1, 0.49));
  assert.equal(h.books().length, count);
  assert.equal(h.feed.isHealthy(), false);
});

test("malformed control frames do not close the socket or erase quotes", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("yes", time), book("no", time)]);
  h.socket.emit("message", "not-json");
  h.socket.frame({ event_type: "unknown" });
  assert.equal(h.socket.readyState, Socket.OPEN);
  assert.equal(h.books().at(-1).YES.bid, 0.4);
  assert.equal(h.feed.isHealthy(), true);
});

test("missing timestamps, sizes, and malformed decimals cannot mutate a healthy book", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("yes", time), book("no", time)]);
  const malformed = book("yes", time + 1, 0.49);
  delete malformed.timestamp;
  h.socket.frame(malformed);
  h.socket.frame({ event_type: "price_change", timestamp: String(time + 2),
    price_changes: [{ asset_id: "yes", side: "BUY", price: "0.4" }] });
  const badSnapshot = book("yes", time + 3, 0.48);
  badSnapshot.bids[0].size = "garbage";
  h.socket.frame(badSnapshot);
  h.socket.frame(top("yes", time + 4, "0.49garbage", "0.6"));
  h.socket.frame({ event_type: "tick_size_change", asset_id: "yes", new_tick_size: "0.001" });
  assert.equal(h.books().length, 1);
  assert.equal(h.books().at(-1).YES.bid, 0.4);
  assert.equal(h.events.some(e => e.kind === "tickSize"), false);
  assert.equal(h.feed.isHealthy(), true);
});

test("zero-size and boundary-price snapshot levels cannot initialize depth", async t => {
  const h = await harness(t), time = stamp();
  const bad = book("yes", time);
  bad.bids = [{ price: "0", size: "10" }];
  bad.asks = [{ price: "1", size: "10" }];
  const no = book("no", time);
  h.socket.frame([bad, no]);
  assert.equal(h.books().length, 0);
  assert.equal(h.feed.isHealthy(), false);
});

test("no complete depth is published before an L2 baseline", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("no", time), { event_type: "price_change", timestamp: String(time),
    price_changes: [
      { asset_id: "yes", side: "BUY", price: "0.4", size: "10" },
      { asset_id: "yes", side: "SELL", price: "0.6", size: "12" },
    ] }]);
  assert.equal(h.books().length, 0);
  h.socket.frame(top("yes", time + 1));
  assert.equal(h.books().at(-1).YES.bid, 0.45);
  assert.equal(h.books().at(-1).YES.bids, undefined);
});

test("source age continues to increase after receipt", async t => {
  const h = await harness(t), now = Date.now();
  h.socket.frame([book("yes", now - 1900), book("no", now - 1900)]);
  assert.equal(h.feed.isHealthy(), true);
  t.mock.method(Date, "now", () => now + 200);
  assert.equal(h.feed.isHealthy(), false);
});

test("an older side keeps its own source time and limits paired snapshot expiry", async t => {
  const h = await harness(t), now = Date.now();
  h.socket.frame([book("yes", now - 1500), book("no", now - 100)]);
  const latest = h.books().at(-1);
  assert.equal(latest.YES.sourceAt, (now - 1500) / 1000);
  assert.equal(latest.NO.sourceAt, (now - 100) / 1000);
  assert.equal(latest.expiresAt, (now + 500) / 1000);
});

test("reconnect rejects older replay and continues sequence after fresh quotes", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("yes", time), book("no", time)]);
  const initial = h.books().at(-1);
  h.socket.terminate();
  await delay(300);
  const socket = Socket.instances.at(-1);
  assert.notEqual(socket, h.socket);
  socket.frame([book("yes", time - 1), book("no", time - 1)]);
  assert.equal(h.books().length, 1);
  assert.equal(h.feed.isHealthy(), false);
  socket.frame([book("yes", Date.now()), book("no", Date.now())]);
  assert.ok(h.books().at(-1).sequence > initial.sequence);
  assert.ok(h.books().at(-1).sourceAt >= initial.sourceAt);
  assert.equal(h.feed.isHealthy(), true);
});

test("equal-time reconnect snapshot rebuilds depth without refreshing quotes", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("yes", time), book("no", time)]);
  h.socket.terminate();
  await delay(300);
  const socket = Socket.instances.at(-1);
  socket.frame([book("yes", time), book("no", time)]);
  assert.equal(h.books().length, 1);
  assert.equal(h.feed.isHealthy(), false);
  const fresh = Date.now();
  socket.frame({ event_type: "price_change", timestamp: String(fresh), price_changes: [
    { asset_id: "yes", side: "BUY", price: "0.45", size: "5" },
    { asset_id: "no", side: "BUY", price: "0.45", size: "5" },
  ] });
  assert.deepEqual(h.books().at(-1).YES.bids, [[0.45, 5], [0.4, 10]]);
  assert.deepEqual(h.books().at(-1).YES.asks, [[0.6, 12]]);
  assert.equal(h.feed.isHealthy(), true);
});

test("stop rejects buffered old-socket events", async t => {
  const h = await harness(t), time = stamp();
  h.socket.frame([book("yes", time), book("no", time)]);
  h.feed.stop();
  h.socket.frame(top("yes", time + 1));
  assert.equal(h.books().length, 1);
  assert.equal(h.feed.isHealthy(), false);
});

test("stop cancels a pending connection without creating another socket", async t => {
  Socket.autoOpen = false;
  t.after(() => { Socket.autoOpen = true; });
  const count = Socket.instances.length;
  const feed = runPolymarketFeed(() => {}, "yes", "no", Date.now() / 1000 + 60);
  feed.stop();
  await delay(0);
  assert.equal(Socket.instances.length, count + 1);
  assert.equal(Socket.instances.at(-1).readyState, 3);
});

test("fresh same-price top updates refresh timestamps without waiting for depth", async t => {
  const h = await harness(t), time = Date.now();
  h.socket.frame([top("yes", time), top("no", time)]);
  t.mock.method(Date, "now", () => time + 300);
  h.socket.frame([top("yes", time + 300), top("no", time + 300)]);
  assert.equal(h.books().length, 2);
  assert.equal(h.books().at(-1).YES.sourceAt, (time + 300) / 1000);
});

test("heartbeat does not keep expired quotes healthy", async t => {
  const h = await harness(t), time = Date.now();
  h.socket.frame([book("yes", time), book("no", time)]);
  t.mock.method(Date, "now", () => time + 2100);
  h.socket.emit("message", "PONG");
  assert.equal(h.feed.isHealthy(), false);
  await delay(1050);
  assert.equal(h.events.at(-1).reason, "stale_book");
});

test("backoff grows exponentially with jitter and caps at 30 seconds", () => {
  assert.deepEqual([0, 1, 2, 20].map(n => reconnectDelayMs(n, 1)), [250, 500, 1000, 30000]);
  assert.equal(reconnectDelayMs(2, 0.5), 500);
});

test("repeated open-then-close failures increase the reconnect delay", async t => {
  t.mock.method(Math, "random", () => 1);
  const h = await harness(t);
  h.socket.terminate();
  await delay(300);
  const second = Socket.instances.at(-1);
  assert.notEqual(second, h.socket);
  second.terminate();
  await delay(300);
  assert.equal(Socket.instances.at(-1), second);
  await delay(250);
  assert.notEqual(Socket.instances.at(-1), second);
});

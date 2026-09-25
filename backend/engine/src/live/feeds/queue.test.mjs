import assert from "node:assert/strict";
import { test } from "node:test";
import { FeedQueue } from "../../../dist/live/feeds/index.js";

const ROUND = 1_800_000_000;
function clock(t, initial = ROUND + 100) {
  let now = initial;
  t.mock.method(Date, "now", () => now * 1000);
  return value => { now = value; };
}

function book(asset = "btc", sequence = 1, overrides = {}) {
  const now = Date.now() / 1000;
  const roundId = overrides.roundId ?? String(ROUND);
  return {
    kind: "book",
    snapshot: {
      marketId: `${asset}-condition-${roundId}`, roundId, sequence,
      sourceAt: now - 0.1, expiresAt: now + 1.9, tsUnix: now,
      YES: { assetId: `${asset}-yes-${roundId}`, bid: 0.4, ask: 0.5, sourceAt: now - 0.1 },
      NO: { assetId: `${asset}-no-${roundId}`, bid: 0.4, ask: 0.5, sourceAt: now - 0.1 },
      ...overrides,
    },
  };
}

function drain(queue) {
  const events = [];
  for (let event; (event = queue.tryPop());) events.push(event);
  return events;
}

test("coalesces each market independently without moving a busy market to the back", t => {
  clock(t);
  const queue = new FeedQueue();
  queue.push(book("eth"));
  queue.push(book("btc"));
  queue.push(book("eth", 2));
  assert.deepEqual(drain(queue).map(e => [e.snapshot.marketId, e.snapshot.sequence]), [
    [`eth-condition-${ROUND}`, 2], [`btc-condition-${ROUND}`, 1],
  ]);
});

test("rejects replay, sequence downgrade and per-side timestamp regression after draining", t => {
  clock(t);
  const queue = new FeedQueue();
  const accepted = book("eth", 5);
  queue.push(accepted);
  assert.equal(queue.tryPop(), accepted);
  queue.push(book("eth", 4));
  queue.push(book("eth", 5));
  queue.push(book("eth", 6, { sequence: undefined }));
  queue.push(book("eth", 6, { sourceAt: accepted.snapshot.sourceAt - 1 }));
  queue.push(book("eth", 6, { YES: { ...accepted.snapshot.YES, sourceAt: ROUND + 90 } }));
  queue.push(book("eth", 6, { NO: { ...accepted.snapshot.NO, sourceAt: ROUND + 90 } }));
  assert.equal(queue.tryPop(), undefined);
  const fresh = book("eth", 6);
  queue.push(fresh);
  assert.equal(queue.tryPop(), fresh);
});

test("prefetching next round preserves current round and new condition/token ids reset sequences", t => {
  clock(t, ROUND + 299);
  const queue = new FeedQueue();
  const current = book("eth", 90);
  const next = book("eth", 1, { roundId: String(ROUND + 300) });
  assert.notEqual(current.snapshot.marketId, next.snapshot.marketId);
  assert.notEqual(current.snapshot.YES.assetId, next.snapshot.YES.assetId);
  queue.push(current);
  queue.push(next);
  assert.deepEqual(drain(queue), [current, next]);
});

test("old round cannot escape at the boundary even with a later expiry and higher sequence", t => {
  const setNow = clock(t, ROUND + 299);
  const queue = new FeedQueue();
  queue.push(book("btc", 90, { expiresAt: ROUND + 310 }));
  const next = book("btc", 1, { roundId: String(ROUND + 300), expiresAt: ROUND + 301 });
  queue.push(next);
  setNow(ROUND + 300);
  queue.push(book("btc", 100, { expiresAt: ROUND + 310 }));
  assert.deepEqual(drain(queue), [next]);
  assert.equal(queue.acceptedBooks.size, 1);
});

test("book expiry is checked on enqueue and dequeue, including each outcome", t => {
  const setNow = clock(t);
  const queue = new FeedQueue();
  queue.push(book("btc", 10, { expiresAt: ROUND + 99 }));
  const invalidSide = book("eth", 10);
  invalidSide.snapshot.NO.expiresAt = ROUND + 99;
  queue.push(invalidSide);
  assert.equal(queue.tryPop(), undefined);
  queue.push(book("btc", 1));
  setNow(ROUND + 102);
  assert.equal(queue.tryPop(), undefined);
  queue.push(book("btc", 2));
  assert.equal(queue.tryPop()?.snapshot.sequence, 2);
});

test("expired optional depth is stripped while a fresh paired BBO remains usable", t => {
  const setNow = clock(t);
  const queue = new FeedQueue();
  const event = book("btc", 12, {
    YES: {
      ...book("btc", 12).snapshot.YES,
      bidSize: 10,
      askSize: 11,
      bids: [[0.4, 10]],
      asks: [[0.5, 11]],
      depthSourceAt: ROUND + 100,
      depthExpiresAt: ROUND + 101,
    },
    NO: {
      ...book("btc", 12).snapshot.NO,
      bidSize: 12,
      askSize: 13,
      bids: [[0.4, 12]],
      asks: [[0.5, 13]],
      depthSourceAt: ROUND + 100,
      depthExpiresAt: ROUND + 102,
    },
  });
  const originalYes = structuredClone(event.snapshot.YES);
  queue.push(event);

  setNow(ROUND + 101.5);
  const result = queue.tryPop();
  assert.ok(result);
  assert.equal(result.snapshot.YES.bid, 0.4);
  assert.equal(result.snapshot.YES.ask, 0.5);
  assert.equal(result.snapshot.YES.bidSize, undefined);
  assert.equal(result.snapshot.YES.bids, undefined);
  assert.equal(result.snapshot.YES.depthExpiresAt, undefined);
  assert.equal(result.snapshot.NO.bidSize, 12);
  assert.deepEqual(event.snapshot.YES, originalYes);
});

test("rejects nonfinite metadata without poisoning later valid updates", t => {
  clock(t);
  const queue = new FeedQueue();
  for (const overrides of [
    { sequence: NaN }, { sequence: Infinity }, { sequence: 1.5 },
    { sourceAt: NaN }, { expiresAt: NaN }, { expiresAt: Infinity },
  ]) queue.push(book("btc", 10, overrides));
  assert.equal(queue.tryPop(), undefined);
  queue.push(book("btc", 1));
  assert.equal(queue.tryPop()?.snapshot.sequence, 1);
});

test("resolving marketId keeps the token stream and a mismatched marketId cannot replace it", t => {
  clock(t);
  const queue = new FeedQueue();
  queue.push(book("eth", 1, { marketId: undefined }));
  const resolved = book("eth", 2);
  queue.push(resolved);
  queue.push(book("eth", 3, { marketId: "wrong-condition" }));
  assert.deepEqual(drain(queue), [resolved]);
});

test("falls back to marketId when token quotes are not supplied", t => {
  clock(t);
  const queue = new FeedQueue();
  queue.push(book("eth", 1, { YES: undefined, NO: undefined }));
  queue.push(book("btc", 1, { YES: undefined, NO: undefined }));
  assert.equal(drain(queue).length, 2);
});

test("unhealthy status removes only its own queued book even before marketId is known", t => {
  clock(t);
  const queue = new FeedQueue();
  const eth = book("eth", 1, { marketId: undefined });
  const btc = book("btc");
  queue.push(eth);
  queue.push(btc);
  const status = { kind: "bookStatus", healthy: false, connected: false,
    roundId: eth.snapshot.roundId, yesAssetId: eth.snapshot.YES.assetId,
    noAssetId: eth.snapshot.NO.assetId, tsUnix: Date.now() / 1000 };
  queue.push(status);
  assert.deepEqual(drain(queue), [status, btc]);
});

test("reference signals are scoped by asset with a backwards-compatible BTC default", t => {
  clock(t);
  const queue = new FeedQueue();
  const btc = { kind: "oracle", tsUnix: ROUND + 100, price: 100_000 };
  const eth = { ...btc, asset: "eth", price: 3_000 };
  queue.push(btc);
  queue.push(eth);
  const nextBtc = { ...btc, asset: " BTC ", price: 100_001, tsUnix: ROUND + 101 };
  queue.push(nextBtc);
  queue.push(btc);
  assert.deepEqual(drain(queue), [nextBtc, eth]);
});

test("a second asset keeps its reference signal and paired book isolated from BTC", t => {
  clock(t);
  const queue = new FeedQueue();
  const btcBook = book("btc", 1);
  const ethBook = book("eth", 1);
  const btc = { kind: "oracle", asset: "btc", tsUnix: ROUND + 100, price: 100_000 };
  const eth = { kind: "oracle", asset: "eth", tsUnix: ROUND + 100, price: 3_000 };
  queue.push(btcBook);
  queue.push(ethBook);
  queue.push(btc);
  queue.push(eth);
  const events = drain(queue);
  assert.equal(events.find(event => event.kind === "book" && event.snapshot.marketId === btcBook.snapshot.marketId)?.snapshot.YES.assetId,
    btcBook.snapshot.YES.assetId);
  assert.equal(events.find(event => event.kind === "book" && event.snapshot.marketId === ethBook.snapshot.marketId)?.snapshot.YES.assetId,
    ethBook.snapshot.YES.assetId);
  assert.deepEqual(events.filter(event => event.kind === "oracle"), [btc, eth]);
});

test("invalid reference events cannot replace a valid asset signal", t => {
  clock(t);
  const queue = new FeedQueue();
  const valid = { kind: "oracle", asset: "eth", tsUnix: ROUND + 100, price: 3_000 };
  queue.push(valid);
  queue.push({ ...valid, tsUnix: Number.NaN, price: 9_000 });
  queue.push({ ...valid, tsUnix: ROUND + 101, price: Number.POSITIVE_INFINITY });
  assert.deepEqual(drain(queue), [valid]);
});

test("reference watermarks survive consumption and stale signals expire while queued", t => {
  const advance = clock(t);
  const queue = new FeedQueue();
  const valid = { kind: "oracle", asset: "eth", tsUnix: ROUND + 100, price: 3000 };
  queue.push(valid);
  assert.deepEqual(drain(queue), [valid]);
  queue.push({ ...valid, tsUnix: ROUND + 99, price: 2900 });
  queue.push({ ...valid, tsUnix: ROUND + 102, price: 2900 });
  queue.push({ ...valid, kind: "btc" });
  queue.push({ ...valid, asset: "" });
  assert.deepEqual(drain(queue), []);
  queue.push({ ...valid, tsUnix: ROUND + 100.5, sourceAt: ROUND + 99, expiresAt: ROUND + 101 });
  advance(ROUND + 101);
  assert.deepEqual(drain(queue), []);
  queue.push({ ...valid, tsUnix: ROUND + 90 });
  assert.deepEqual(drain(queue), []);
  queue.push({ ...valid, tsUnix: ROUND + 101 });
  assert.equal(queue.tryPop()?.price, 3000);
});

test("user events stay lossless, tick sizes precede books, and trade telemetry is bounded", t => {
  clock(t);
  const queue = new FeedQueue();
  for (let i = 0; i < 300; i++) queue.push({ kind: "marketTrade", token: "yes",
    price: 0.4, shares: i, takerSide: "BUY", tsUnix: ROUND + 100 });
  const snapshot = book();
  queue.push(snapshot);
  const tick = { kind: "tickSize", token: snapshot.snapshot.YES.assetId, tickSize: 0.001, tsUnix: ROUND + 100 };
  queue.push(tick);
  queue.push({ ...tick, tsUnix: ROUND + 99, tickSize: 0.01 });
  const first = { kind: "userStatus", healthy: false, tsUnix: ROUND + 100 };
  const second = { ...first, healthy: true };
  queue.push(first);
  queue.push(second);
  const events = drain(queue);
  assert.deepEqual(events.slice(0, 4), [first, second, snapshot, tick]);
  assert.equal(events.length, 260);
  assert.equal(events[4].shares, 44);
});

test("an async consumer wakes on usable data and times out when only expired data arrives", async t => {
  clock(t);
  const queue = new FeedQueue();
  const pending = queue.pop(100);
  const event = book();
  queue.push(event);
  assert.equal(await pending, event);
  const timeout = queue.pop(5);
  queue.push(book("btc", 2, { expiresAt: ROUND + 99 }));
  assert.equal(await timeout, null);
});

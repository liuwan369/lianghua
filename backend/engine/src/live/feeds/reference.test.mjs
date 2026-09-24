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
  constructor(url) {
    super(); this.url = url; Socket.instances.push(this);
    queueMicrotask(() => {
      if (Socket.autoOpen && this.readyState !== 3) { this.readyState = 1; this.emit("open"); }
    });
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3; this.emit("close");
  }
  frame(value) { this.emit("message", JSON.stringify(value)); }
}

mock.module("ws", { defaultExport: Socket });
const {
  ReferenceFeedUnsupportedError,
  ReferenceFeedInvalidEventError,
  referenceFeedCapability,
  referenceEvent,
  referenceVenueProducts,
  runReferenceFeed,
} = await import("../../../dist/live/feeds/btc.js");

async function harness(t, asset = "eth") {
  const offset = Socket.instances.length;
  const events = [];
  const feed = runReferenceFeed(event => events.push(event), asset);
  t.after(() => feed.stop());
  await delay(0);
  return { feed, events, sockets: Socket.instances.slice(offset),
    references: () => events.filter(event => event.kind === "btc" || event.kind === "oracle") };
}

const spot = (symbol, update = 1, overrides = {}) => ({ s: symbol, u: update, b: "3000", a: "3002", B: "2", A: "2", ...overrides });
const perp = (time, update = 1, overrides = {}) => ({ ...spot("ETHUSDT", update), E: time, ...overrides });
const coinbase = (time, update = 1, overrides = {}) => ({ type: "ticker", product_id: "ETH-USD", sequence: update,
  time: new Date(time).toISOString(), best_bid: "3000", best_ask: "3002", best_bid_size: "2", best_ask_size: "2", ...overrides });
const okx = (time, overrides = {}) => ({ arg: { channel: "tickers", instId: "ETH-USDT" },
  data: [{ instId: "ETH-USDT", ts: String(time), bidPx: "3000", askPx: "3002", bidSz: "2", askSz: "2" }], ...overrides });
const bybit = (time, update = 1, overrides = {}) => ({ topic: "tickers.ETHUSDT", type: "snapshot", ts: time, cs: update,
  data: { symbol: "ETHUSDT", bid1Price: "3000", ask1Price: "3002", bid1Size: "2", ask1Size: "2" }, ...overrides });

test("reference products are parameterized and do not reuse BTC symbols", () => {
  assert.deepEqual(referenceFeedCapability("BTC"), { asset: "btc", supported: true });
  assert.deepEqual(referenceFeedCapability("eth"), { asset: "eth", supported: true });
  assert.deepEqual(referenceFeedCapability("sol"), { asset: "sol", supported: true });

  const btc = referenceVenueProducts("btc");
  const eth = referenceVenueProducts("eth");
  const sol = referenceVenueProducts("sol");
  assert.equal(btc.binance, "btcusdt");
  assert.equal(eth.binance, "ethusdt");
  assert.equal(sol.binance, "solusdt");
  assert.notDeepEqual(eth, btc);
  assert.notDeepEqual(sol, btc);
  assert.equal(eth.coinbase, "ETH-USD");
  assert.equal(sol.okx, "SOL-USDT");
});

test("unsupported and disabled reference assets fail before opening a feed", () => {
  assert.deepEqual(referenceFeedCapability("xrp"), {
    asset: "xrp", supported: false, reason: "unsupported_asset",
  });
  assert.throws(() => runReferenceFeed(() => {}, "xrp"), error =>
    error instanceof ReferenceFeedUnsupportedError && error.capability.reason === "unsupported_asset");

  const previous = process.env.PM_REFERENCE_ASSETS;
  process.env.PM_REFERENCE_ASSETS = "btc,eth";
  try {
    assert.deepEqual(referenceFeedCapability("sol"), {
      asset: "sol", supported: false, reason: "disabled_by_configuration",
    });
    assert.throws(() => runReferenceFeed(() => {}, "sol"), error =>
      error instanceof ReferenceFeedUnsupportedError && error.capability.reason === "disabled_by_configuration");
  } finally {
    if (previous == null) delete process.env.PM_REFERENCE_ASSETS;
    else process.env.PM_REFERENCE_ASSETS = previous;
  }
});

test("asset-scoped reference events cannot relabel ETH or SOL as BTC", () => {
  assert.deepEqual(referenceEvent("btc", 1, 100_000), {
    kind: "btc", asset: "btc", tsUnix: 1, price: 100_000,
  });
  assert.deepEqual(referenceEvent("eth", 2, 3_000), {
    kind: "oracle", asset: "eth", tsUnix: 2, price: 3_000,
  });
  assert.deepEqual(referenceEvent("sol", 3, 150), {
    kind: "oracle", asset: "sol", tsUnix: 3, price: 150,
  });
  assert.throws(() => referenceEvent("eth", 0, 3_000), error =>
    error instanceof ReferenceFeedInvalidEventError && error.code === "reference_event_invalid");
  assert.throws(() => referenceEvent("eth", 2, Number.NaN), error =>
    error instanceof ReferenceFeedInvalidEventError && error.code === "reference_event_invalid");
});


test("actual BTC, ETH and SOL producers subscribe separately and expose unavailable state", async t => {
  const btc = await harness(t, "btc");
  const eth = await harness(t, "eth");
  const sol = await harness(t, "sol");
  for (const [asset, h] of [["btc", btc], ["eth", eth], ["sol", sol]]) {
    assert.equal(h.sockets.length, 5);
    assert.match(h.sockets[0].url, new RegExp(`${asset}usdt@bookTicker$`));
    assert.match(h.sockets[1].url, new RegExp(`${asset}usdt@bookTicker$`));
    assert.deepEqual(h.sockets[2].sent[0].product_ids, [`${asset.toUpperCase()}-USD`]);
    assert.equal(h.sockets[3].sent[0].args[0].instId, `${asset.toUpperCase()}-USDT`);
    assert.equal(h.sockets[4].sent[0].args[0], `tickers.${asset.toUpperCase()}USDT`);
    assert.equal(h.feed.getStatus().healthy, false);
    assert.equal(h.feed.getStatus().reason, "waiting_for_quotes");
    h.sockets[0].frame(spot(`${asset.toUpperCase()}USDT`));
    assert.equal(h.references()[0].asset, asset);
    assert.equal(h.references()[0].kind, asset === "btc" ? "btc" : "oracle");
    assert.equal(h.feed.getStatus().healthy, true);
  }
  assert.equal(btc.references().length, 1);
  assert.equal(eth.references().length, 1);
  assert.equal(sol.references().length, 1);
  assert.deepEqual(referenceFeedCapability("constructor"), { asset: "constructor", supported: false, reason: "unsupported_asset" });
});

test("every venue rejects wrong-product frames before they can become ETH references", async t => {
  const h = await harness(t);
  const time = Date.now() - 100;
  h.sockets[0].frame(spot("BTCUSDT"));
  h.sockets[1].frame(perp(time, 1, { s: "BTCUSDT" }));
  h.sockets[2].frame(coinbase(time, 1, { product_id: "BTC-USD" }));
  h.sockets[3].frame(okx(time, { arg: { channel: "tickers", instId: "BTC-USDT" } }));
  h.sockets[3].frame(okx(time, { data: [{ instId: "BTC-USDT", ts: String(time), bidPx: "60000", askPx: "60001" }] }));
  h.sockets[4].frame(bybit(time, 1, { topic: "tickers.BTCUSDT" }));
  h.sockets[4].frame(bybit(time, 1, { data: { symbol: "BTCUSDT", bid1Price: "60000", ask1Price: "60001" } }));
  assert.deepEqual(h.references(), []);
  h.sockets[0].frame(spot("ETHUSDT"));
  h.sockets[1].frame(perp(time));
  h.sockets[2].frame(coinbase(time));
  h.sockets[3].frame(okx(time));
  h.sockets[4].frame(bybit(time));
  assert.equal(h.events.filter(event => event.kind === "venue").length, 5);
  assert.equal(h.references().at(-1).asset, "eth");
  assert.equal(h.references().at(-1).clockSource, "mixed");
});

test("source clocks, future and stale rejection, replay order and unchanged-price freshness", async t => {
  let now = 1_800_000_100_000;
  t.mock.method(Date, "now", () => now);
  const h = await harness(t);
  h.sockets[1].frame(perp(now - 6_000));
  h.sockets[1].frame(perp(now + 2_000));
  h.sockets[2].frame(coinbase(now - 6_000));
  h.sockets[3].frame(okx(now - 6_000));
  h.sockets[4].frame(bybit(now - 6_000));
  assert.equal(h.references().length, 0);
  h.sockets[1].frame(perp(now - 100, 2));
  assert.equal(h.references()[0].sourceAt, (now - 100) / 1000);
  assert.equal(h.references()[0].tsUnix, (now - 100) / 1000);
  assert.equal(h.references()[0].expiresAt, (now - 100) / 1000 + 5);
  assert.equal(h.references()[0].clockSource, "exchange");
  h.sockets[1].frame(perp(now - 200, 3));
  h.sockets[1].frame(perp(now - 50, 1));
  h.sockets[1].frame(perp(now - 100, 2));
  assert.equal(h.references().length, 1);
  now += 2_000;
  h.sockets[1].frame(perp(now - 100, 3));
  assert.equal(h.references().length, 2);
  assert.equal(h.references()[1].price, h.references()[0].price);
  assert.equal(h.references()[1].sourceAt, h.references()[0].sourceAt + 2);
  now += 5_000;
  assert.equal(h.feed.getStatus().healthy, false);
  assert.equal(h.feed.getStatus().reason, "stale_reference");
  assert.equal(h.references().length, 2);
});

test("spot receive clock is explicit and a duplicate update cannot refresh it", async t => {
  let now = 1_800_000_100_000;
  t.mock.method(Date, "now", () => now);
  const h = await harness(t);
  h.sockets[0].frame(spot("ETHUSDT", 10));
  assert.equal(h.references()[0].clockSource, "received");
  assert.equal(h.references()[0].sourceAt, now / 1000);
  now += 6_000;
  h.sockets[0].frame(spot("ETHUSDT", 10));
  h.sockets[0].frame(spot("ETHUSDT", 9));
  assert.equal(h.references().length, 1);
  assert.equal(h.feed.getStatus().healthy, false);
  h.sockets[0].frame(spot("ETHUSDT", 11));
  assert.equal(h.references().length, 2);
  assert.equal(h.feed.getStatus().healthy, true);
});

test("malformed quotes do not consume sequence and valid Bybit delta retains its local quote", async t => {
  const h = await harness(t), now = Date.now() - 100;
  h.sockets[0].frame(spot("ETHUSDT", 1, { b: "3000garbage" }));
  h.sockets[0].frame(spot("ETHUSDT", 1, { B: "Infinity" }));
  h.sockets[0].frame(spot("ETHUSDT", 1, { a: "2999" }));
  h.sockets[0].frame(spot("ETHUSDT", 1, { u: undefined }));
  h.sockets[4].frame(bybit(now, 1, { type: "delta", data: { bid1Price: "3000" } }));
  assert.equal(h.references().length, 0);
  h.sockets[4].frame(bybit(now, 1));
  h.sockets[4].frame(bybit(now + 1, 2, { type: "delta", data: { bid1Price: "3001" } }));
  assert.equal(h.references().at(-1).price, 3001.5);
  h.sockets[4].frame(bybit(now + 2, 3, { type: "delta", data: { fundingRate: "0.0001" } }));
  assert.equal(h.references().length, 2);
  h.sockets[0].frame(spot("ETHUSDT", 1));
  assert.equal(h.events.filter(event => event.kind === "venue").length, 3);
});

test("conflicting venue prices cannot publish NaN or claim a healthy consensus", async t => {
  const h = await harness(t), now = Date.now() - 100;
  h.sockets[1].frame(perp(now));
  h.sockets[2].frame(coinbase(now, 1, { best_bid: "6000", best_ask: "6002" }));
  assert.equal(h.references().length, 1);
  assert.equal(h.feed.getStatus().healthy, false);
  assert.ok(h.references().every(event => Number.isFinite(event.price)));
});

test("stop terminates connecting sockets, ignores buffered frames and cancels retry", async t => {
  Socket.autoOpen = false;
  const offset = Socket.instances.length;
  const unavailable = runReferenceFeed(() => { assert.fail("stopped producer emitted"); }, "sol");
  const connecting = Socket.instances.slice(offset);
  unavailable.stop();
  Socket.autoOpen = true;
  assert.ok(connecting.every(socket => socket.readyState === 3));
  assert.equal(unavailable.getStatus().reason, "stopped");
  const h = await harness(t);
  const count = Socket.instances.length;
  h.sockets[0].terminate();
  await delay(0);
  h.feed.stop();
  for (const socket of h.sockets) socket.frame(spot("ETHUSDT"));
  await delay(650);
  assert.equal(Socket.instances.length, count);
  assert.equal(h.references().length, 0);
  assert.equal(h.feed.getStatus().reason, "stopped");
});

test("idle transport reconnects and retains its update watermark", async t => {
  let now = 1_800_000_100_000;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await harness(t);
  h.sockets[0].frame(spot("ETHUSDT", 20));
  const count = Socket.instances.length;
  now += 11_000;
  t.mock.timers.tick(1000);
  await delay(650);
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(Socket.instances.length, count + 5);
  const nextSpot = Socket.instances.slice(count).find(socket => socket.url === h.sockets[0].url);
  nextSpot.frame(spot("ETHUSDT", 19));
  assert.equal(h.references().length, 1);
  nextSpot.frame(spot("ETHUSDT", 21));
  assert.equal(h.references().length, 2);
});

// Binance aggTrade on two lines: a trade is delivered once, from whichever line
// has it first, and only when its aggregate id `a` is above every id already
// delivered (so a late/duplicate/out-of-order copy is dropped). A closed line
// reconnects. Lead signals go to FeedQueue's priority lane, never merged.
//
// Drives the real compiled ingest and runBinanceTrades against two local
// loopback WebSocket servers (no Binance connection). Run after `npm run build`:
//   node scripts/regress/binance-trades-dedupe.mjs
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { createAggTradeIngest, runBinanceTrades, binanceLeadFeed, LeadSignalDetector, binanceTradeUrls }
  from "../../dist/live/feeds/binance-trades.js";
import { FeedQueue } from "../../dist/live/feeds/index.js";

const frame = (a, p = "100000.00", T = 1_800_000_020_000 + a) => JSON.stringify({ e: "aggTrade", E: T + 3, s: "BTCUSDT", a, p,
  q: "0.010", f: a * 10, l: a * 10 + 1, T, m: false, M: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await sleep(10); } return true; };

assert.deepEqual(binanceTradeUrls("btcusdt"), ["wss://stream.binance.com:9443/ws/btcusdt@aggTrade",
  "wss://data-stream.binance.vision/ws/btcusdt@aggTrade"]);

// --- the shared ingest: duplicates, out-of-order and malformed frames ---
{
  const got = [];
  const ingest = createAggTradeIngest(t => got.push(t));
  // line A and line B interleaved, each in order, with overlaps
  const arrivals = [["A", 1], ["B", 1], ["B", 2], ["A", 2], ["A", 3], ["A", 5], ["B", 3], ["B", 4], ["B", 5], ["B", 6], ["A", 4], ["A", 6]];
  for (const [, a] of arrivals) ingest(frame(a), 1_800_000_020.1, 42);   // T = …020_00a: ~100 ms before
  assert.deepEqual(got.map(t => t.id), [1, 2, 3, 5, 6], "each id once; 4 arrived after 5 and is dropped");
  assert.deepEqual(got[0], { id: 1, price: 100000, tradeTimeMs: 1_800_000_020_001, receivedAtUnix: 1_800_000_020.1, receivedAtMonoMs: 42 });
  for (const bad of ["not json", "{}", JSON.stringify({ a: "7", p: "1", T: 1 }), JSON.stringify({ a: 7, p: "x", T: 1 }),
    JSON.stringify({ a: 7, p: "0", T: 1 }), JSON.stringify({ a: 7, p: "1" }), "null", JSON.stringify({ result: null, id: 1 })]) {
    assert.equal(ingest(bad, 0, 0), false, bad);
  }
  assert.equal(ingest(Buffer.from(frame(7, "100001.5")), 1_800_000_020.1, 2), true, "ws delivers Buffers");
  assert.equal(got.at(-1).price, 100001.5);
  assert.equal(got.length, 6, "malformed frames delivered nothing and did not move the id");
}

// --- a trade too old, or with an impossible time or id, never reaches the detector (review 10-25) ---
// The rule assumes we see a trade ~125 ms after it happened. When the leading
// line drops, the lagging one's copies are new ids but seconds old; a stray
// frame with a far-future time would sit in the 250 ms window, and one with a
// huge id would lift the watermark above every real trade.
{
  const got = [];
  const ingest = createAggTradeIngest(t => got.push(t));
  const T0 = 1_800_000_020_000, at = (ms) => ms / 1000;
  assert.equal(ingest(frame(1, "100000.00", T0), at(T0 + 120), 1), true, "a fresh trade is delivered");
  assert.equal(ingest(frame(2, "100030.00", T0 + 10), at(T0 + 10 + 4992), 2), false, "5 s old: dropped");
  assert.equal(ingest(frame(3, "100030.00", T0 + 20), at(T0 + 20 + 1001), 3), false, "just over 1 s old: dropped");
  assert.equal(ingest(frame(4, "100030.00", T0 + 30), at(T0 + 30 + 999), 4), true, "under 1 s: delivered");
  assert.equal(ingest(frame(5, "100030.00", 9e15), at(T0 + 40), 5), false, "a far-future trade time is dropped");
  assert.equal(ingest(frame(1e15, "100030.00", T0 + 50), at(T0 + 170), 6), false, "an id jump of 1e15 is dropped");
  assert.equal(ingest(frame(6, "100030.00", T0 + 60), at(T0 + 180), 7), true, "real trades still flow after a bad id");
  assert.deepEqual(got.map(t => t.id), [1, 4, 6]);
  // A too-old copy does not move the watermark: the next fresh one still lands.
  assert.equal(ingest(frame(7, "1", T0 + 70), at(T0 + 70 + 3000), 8), false);
  assert.equal(ingest(frame(7, "100030.00", T0 + 70), at(T0 + 190), 9), true);
  // The first trade after a start sets the watermark wherever Binance's id is.
  const fresh = [];
  assert.equal(createAggTradeIngest(t => fresh.push(t))(frame(4_100_000_000, "100000.00", T0), at(T0 + 100), 1), true);
}

// --- a line that only sends non-trade frames is not healthy and is recycled (review 10-25) ---
{
  const server = new WebSocketServer({ port: 0 });
  await new Promise(r => server.on("listening", r));
  let socket;
  server.on("connection", ws => { socket = ws; });
  const feed = runBinanceTrades(() => {}, "btcusdt", [`ws://127.0.0.1:${server.address().port}`]);
  assert.ok(await until(() => socket));
  const noise = setInterval(() => { try { socket.send("not json"); } catch {} }, 200);
  await sleep(1500);
  assert.equal(feed.isHealthy(), false, "garbage only: not healthy");
  socket.send(frame(1, "100000.00", Date.now() - 100));
  assert.ok(await until(() => feed.isHealthy(), 2000), "a real trade makes the line healthy");
  clearInterval(noise);
  feed.stop();
  for (const c of server.clients) c.terminate();
  server.close();
}

// --- two live lines: whichever has it first, each trade once, ids increasing ---
{
  const servers = [new WebSocketServer({ port: 0 }), new WebSocketServer({ port: 0 })];
  await Promise.all(servers.map(s => new Promise(r => s.on("listening", r))));
  const urls = servers.map(s => `ws://127.0.0.1:${s.address().port}`);
  const sockets = [[], []];
  const connections = [0, 0];
  servers.forEach((s, i) => s.on("connection", ws => { connections[i] += 1; sockets[i].push(ws); }));
  const got = [];
  const feed = runBinanceTrades(t => got.push(t), "btcusdt", urls);
  assert.equal(feed.isHealthy(), false, "no message yet");
  assert.ok(await until(() => sockets[0].length && sockets[1].length), "both lines connect");
  // Live lines take the real clock: a trade must be under 1 s old when it lands.
  const send = (line, a) => sockets[line].at(-1).send(frame(a, "100000.00", Date.now() - 50));
  // B is ahead for 1-3, A ahead for 4-6, then both resend old ids.
  for (const a of [1, 2, 3]) send(1, a);
  await sleep(50);
  for (const a of [1, 2, 3, 4, 5, 6]) send(0, a);
  await sleep(50);
  for (const a of [4, 5, 6, 2]) send(1, a);
  assert.ok(await until(() => got.length >= 6));
  await sleep(100);
  assert.deepEqual(got.map(t => t.id), [1, 2, 3, 4, 5, 6]);
  assert.ok(got.every(t => Math.abs(t.receivedAtUnix - Date.now() / 1000) < 5 && t.receivedAtMonoMs > 0));
  assert.equal(feed.isHealthy(), true);
  // Line A drops (Binance closes every 24 h): line B carries on, A reconnects after 1-2 s.
  sockets[0].at(-1).terminate();
  send(1, 7);
  assert.ok(await until(() => got.length === 7), "the other line still delivers");
  assert.equal(feed.isHealthy(), true, "one live line is healthy");
  assert.ok(await until(() => connections[0] === 2, 4000), "the dropped line reconnected");
  send(0, 7); send(0, 8);
  assert.ok(await until(() => got.length === 8));
  assert.deepEqual(got.map(t => t.id), [1, 2, 3, 4, 5, 6, 7, 8], "the id watermark survives a reconnect");
  feed.stop();
  assert.equal(feed.isHealthy(), false);
  await sleep(50);
  servers.forEach(s => { for (const c of s.clients) c.terminate(); s.close(); });
}

// --- binanceLeadFeed: trades -> detector -> lead event -> FeedQueue priority, never merged ---
{
  const server = new WebSocketServer({ port: 0 });
  await new Promise(r => server.on("listening", r));
  let socket;
  server.on("connection", ws => { socket = ws; });
  // Real wall clock decides S: open the valid period to the whole round for this test.
  const detector = new LeadSignalDetector({ windowMs: 250, thresholdBp: 2, fromSec: 0, toSec: 300 });
  const queue = new FeedQueue();
  const url = `ws://127.0.0.1:${server.address().port}`;
  // binanceLeadFeed builds its own URLs; route through runBinanceTrades with the same sink logic.
  const events = [];
  const sink = (event) => { events.push(event); queue.push(event); };
  const control = runBinanceTrades(trade => {
    const signal = detector.push(trade, trade.receivedAtUnix);
    if (signal) sink({ kind: "lead", ...signal });
  }, "btcusdt", [url]);
  assert.ok(await until(() => socket));
  const T = Date.now() - 100;
  const tape = [[1, "100000.00", T], [2, "100030.00", T + 10], [3, "100031.00", T + 20], [4, "100000.00", T + 30], [5, "100030.00", T + 40]];
  for (const [a, p, t] of tape) socket.send(frame(a, p, t));
  assert.ok(await until(() => events.length === 3));
  assert.deepEqual(events.map(e => [e.kind, e.direction, e.tradeId, e.refPrice]),
    [["lead", "UP", 2, 100000], ["lead", "DOWN", 4, 100031], ["lead", "UP", 5, 100000]]);
  queue.push({ kind: "book", snapshot: { tsUnix: Date.now() / 1000, marketId: "0xm", roundId: "1800000000" } });
  const popped = [queue.tryPop(), queue.tryPop(), queue.tryPop()];
  assert.deepEqual(popped.map(e => e?.tradeId), [2, 4, 5], "all three leads, in order, none merged");
  control.stop();
  for (const c of server.clients) c.terminate();
  server.close();
  // The exported producer has the shape ConnectOptions.leadFeed expects.
  const producer = binanceLeadFeed(detector);
  assert.equal(typeof producer, "function");
}
console.log("binance-trades-dedupe OK");

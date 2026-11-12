// Binance USD-M aggTrade through its venue ingest (shared by all its lines): a
// trade is delivered once, from whichever line has it first, and only when its
// aggregate id `a` is above every id already delivered (so a late/duplicate/
// out-of-order copy is dropped). A line carrying only garbage is not healthy.
// Lead signals go to FeedQueue's priority lane, never merged.
//
// Drives the real compiled VenueIngest, and runLeadTrades against loopback
// WebSocket servers (no venue connection). Run after `npm run build`:
//   node scripts/regress/binance-trades-dedupe.mjs
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { LeadSignalDetector } from "../../dist/live/feeds/binance-trades.js";
import { VenueIngest, runLeadTrades } from "../../dist/live/feeds/lead-trades.js";
import { leadPerpProducts } from "../../dist/live/feeds/btc.js";
import { FeedQueue } from "../../dist/live/feeds/index.js";

const createAggTradeIngest = (onTrade) => {
  const v = new VenueIngest("binance", "btcusdt", onTrade);
  return (raw, unix, mono) => v.frame(raw, "direct", unix, mono);
};
const runBybitTrades = (onTrade, urls) => runLeadTrades({ venues: ["bybit"], products: leadPerpProducts("btc"), urls: { bybit: urls } }, onTrade);

const frame = (a, p = "100000.00", T = 1_800_000_020_000 + a) => JSON.stringify({ e: "aggTrade", E: T + 3, s: "BTCUSDT", a, p,
  q: "0.010", f: a * 10, l: a * 10 + 1, T, m: false, M: true });
// Bybit linear publicTrade frame (seq orders trades; the delivered id is the delivery count).
const bybitFrame = (seq, i, p, T) => JSON.stringify({ topic: "publicTrade.BTCUSDT", type: "snapshot", ts: T,
  data: [{ T, s: "BTCUSDT", S: "Buy", v: "0.010", p, L: "PlusTick", i, BT: false, RPI: false, seq }] });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await sleep(10); } return true; };

// --- the shared ingest: duplicates, out-of-order and malformed frames ---
{
  const got = [];
  const ingest = createAggTradeIngest(t => got.push(t));
  // line A and line B interleaved, each in order, with overlaps
  const arrivals = [["A", 1], ["B", 1], ["B", 2], ["A", 2], ["A", 3], ["A", 5], ["B", 3], ["B", 4], ["B", 5], ["B", 6], ["A", 4], ["A", 6]];
  for (const [, a] of arrivals) ingest(frame(a), 1_800_000_020.1, 42);   // T = …020_00a: ~100 ms before
  assert.deepEqual(got.map(t => t.id), [1, 2, 3, 5, 6], "each id once; 4 arrived after 5 and is dropped");
  assert.deepEqual(got[0], { venue: "binance", id: 1, price: 100000, tradeTimeMs: 1_800_000_020_001, line: "direct",
    receivedAtUnix: 1_800_000_020.1, receivedAtMonoMs: 42 });
  const ok = { e: "aggTrade", s: "BTCUSDT", a: 7, p: "1", T: 1_800_000_020_007 };
  for (const bad of ["not json", "{}", JSON.stringify({ ...ok, a: "7" }), JSON.stringify({ ...ok, p: "x" }),
    JSON.stringify({ ...ok, p: "0" }), JSON.stringify({ ...ok, T: undefined }), JSON.stringify({ ...ok, s: "ETHUSDT" }),
    JSON.stringify({ ...ok, e: "trade" }), "null", JSON.stringify({ result: null, id: 1 })]) {
    assert.equal(ingest(bad, 1_800_000_020.1, 0), false, bad);
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
  const feed = runBybitTrades(() => {}, [`ws://127.0.0.1:${server.address().port}`]);
  assert.ok(await until(() => socket));
  const noise = setInterval(() => { try { socket.send("not json"); } catch {} }, 200);
  await sleep(1500);
  assert.equal(feed.isHealthy(), false, "garbage only: not healthy");
  socket.send(bybitFrame(1, "a", "100000.0", Date.now() - 100));
  assert.ok(await until(() => feed.isHealthy(), 2000), "a real trade makes the line healthy");
  clearInterval(noise);
  feed.stop();
  for (const c of server.clients) c.terminate();
  server.close();
}

// --- lead feed: trades -> detector -> lead event -> FeedQueue priority, never merged ---
{
  const server = new WebSocketServer({ port: 0 });
  await new Promise(r => server.on("listening", r));
  let socket;
  server.on("connection", ws => { socket = ws; });
  // Real wall clock decides S: open the valid period to the whole round for this test.
  const detector = new LeadSignalDetector({ windowMs: 250, thresholdBp: 2, fromSec: 0, toSec: 300 });
  const queue = new FeedQueue();
  const url = `ws://127.0.0.1:${server.address().port}`;
  // leadSignalFeed builds its own URLs; route through runLeadTrades with the same sink logic.
  const events = [];
  const sink = (event) => { events.push(event); queue.push(event); };
  const control = runBybitTrades(trade => {
    const signal = detector.push(trade, trade.receivedAtUnix);
    if (signal) sink({ kind: "lead", ...signal });
  }, [url]);
  assert.ok(await until(() => socket));
  const T = Date.now() - 100;
  const tape = [[1, "100000.00", T], [2, "100030.00", T + 10], [3, "100031.00", T + 20], [4, "100000.00", T + 30], [5, "100030.00", T + 40]];
  for (const [a, p, t] of tape) socket.send(bybitFrame(a, `t${a}`, p, t));
  assert.ok(await until(() => events.length === 3));
  assert.deepEqual(events.map(e => [e.kind, e.direction, e.tradeId, e.refPrice]),
    [["lead", "UP", 2, 100000], ["lead", "DOWN", 4, 100031], ["lead", "UP", 5, 100000]]);
  queue.push({ kind: "book", snapshot: { tsUnix: Date.now() / 1000, marketId: "0xm", roundId: "1800000000" } });
  const popped = [queue.tryPop(), queue.tryPop(), queue.tryPop()];
  assert.deepEqual(popped.map(e => e?.tradeId), [2, 4, 5], "all three leads, in order, none merged");
  control.stop();
  for (const c of server.clients) c.terminate();
  server.close();
}
console.log("binance-trades-dedupe OK");

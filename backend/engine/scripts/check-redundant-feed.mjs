// Drives the real runPolymarketFeed (two sockets) against a local WebSocket
// server, so each socket can be closed on demand. Run after `npm run build`:
//   node scripts/check-redundant-feed.mjs
// Proves:
//   1. one socket closing does not reach the consumer as a disconnect, and
//      books keep flowing from the other socket
//   2. only both sockets down reports transport_disconnected
//   3. forwarded sequence is strictly increasing; no side's time goes back;
//      a frame both sockets receive is forwarded once
//   4. the consumer's snapshot gate accepts the merged stream
//   5. stop() closes every socket and nothing is emitted afterwards
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { runPolymarketFeed } from "../dist/live/feeds/polymarket.js";
import { validateMarketSnapshot } from "../dist/platform/snapshot-gate.js";

const UP = "1".repeat(20), DOWN = "2".repeat(20);
const START = Math.floor(Date.now() / 1000 / 300) * 300;
const wss = new WebSocketServer({ port: 0 });
await new Promise(resolve => wss.once("listening", resolve));
const url = `ws://127.0.0.1:${wss.address().port}`;
const sockets = new Set();
wss.on("connection", sock => { sockets.add(sock); sock.on("close", () => sockets.delete(sock)); sock.on("message", () => {}); });

// The venue sends the same event to every subscriber; broadcast mirrors that.
// The feed only publishes when the top of book changes (or every 250ms), so
// each frame nudges the price, as a live book does.
let clock = Date.now(), tick = 0;
const frame = (upBase, _downBase) => {
  clock = Math.max(clock + 1, Date.now());
  const ts = String(clock);
  tick = (tick + 1) % 20;
  const upAsk = Math.round((upBase + tick / 100) * 100) / 100;
  const downAsk = Math.round((0.99 - upAsk) * 100) / 100;
  const side = (asset_id, ask) => ({ event_type: "book", asset_id, market: "0xm", timestamp: ts,
    bids: [{ price: (ask - 0.01).toFixed(2), size: "100" }], asks: [{ price: ask.toFixed(2), size: "100" }] });
  return JSON.stringify([side(UP, upAsk), side(DOWN, downAsk)]);
};
let framesSent = 0;
const broadcast = data => { framesSent += 1; for (const s of sockets) if (s.readyState === 1) s.send(data); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (pred, ms = 4000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) return false; await wait(10); } return true; };

const books = [], statuses = [];
let afterStop = 0, stoppedAt = 0;
const feed = runPolymarketFeed(event => {
  if (stoppedAt) { afterStop += 1; return; }
  if (event.kind === "book") books.push(event.snapshot);
  if (event.kind === "bookStatus") statuses.push({ ...event });
}, UP, DOWN, START + 300, { marketId: "0xm", roundId: String(START), url });

assert.ok(await until(() => sockets.size === 2), "two sockets connect");
for (let i = 0; i < 5; i += 1) { broadcast(frame(0.6, 0.4)); await wait(30); }
assert.ok(await until(() => books.length >= 3), "books arrive");
assert.equal(statuses.at(-1).healthy, true, "pair healthy with two live sockets");

// --- 1. close ONE socket: consumer must not see a disconnect ---
const beforeOne = statuses.length;
[...sockets][0].terminate();
await until(() => sockets.size === 1, 1000);
for (let i = 0; i < 6; i += 1) { broadcast(frame(0.61 + i / 100, 0.39 - i / 100)); await wait(30); }
const duringOne = statuses.slice(beforeOne);
assert.ok(duringOne.every(s => s.connected !== false), "one socket down is not reported as disconnected");
assert.ok(duringOne.every(s => s.healthy !== false), "the pair stays healthy while one socket reconnects");
const booksBeforeOne = books.length;
broadcast(frame(0.7, 0.3)); await wait(60);
assert.ok(books.length > booksBeforeOne, "books keep flowing from the surviving socket");
console.log("PASS 1 one socket closed: no disconnect reported, books keep flowing");

// Let the closed one come back so both are up again.
assert.ok(await until(() => sockets.size === 2, 3000), "closed socket reconnects");
for (let i = 0; i < 4; i += 1) { broadcast(frame(0.6, 0.4)); await wait(30); }

// --- 2. close BOTH: now a real disconnect ---
const beforeBoth = statuses.length;
for (const s of [...sockets]) s.terminate();
assert.ok(await until(() => statuses.slice(beforeBoth).some(s => s.connected === false)),
  "both sockets down is reported as disconnected");
const down = statuses.slice(beforeBoth).find(s => s.connected === false);
assert.equal(down.reason, "transport_disconnected");
assert.equal(down.healthy, false);
console.log("PASS 2 both sockets closed: transport_disconnected reported once");
assert.ok(await until(() => sockets.size === 2, 3000), "both reconnect");
for (let i = 0; i < 4; i += 1) { broadcast(frame(0.6, 0.4)); await wait(30); }
assert.ok(await until(() => statuses.at(-1).healthy === true), "healthy again after both reconnect");

// --- 3. ordering: sequence strictly up, no side back, no duplicates ---
// Every frame goes to both sockets, so without dedupe each venue event would
// be forwarded twice with the same exchange time. That is what is checked.
const sent = framesSent;
const times = books.map(b => `${b.YES.sourceAt}|${b.NO.sourceAt}`);
assert.equal(new Set(times).size, times.length, "no venue event is forwarded twice");
assert.ok(books.length <= sent, `forwarded ${books.length} books for ${sent} distinct frames (duplicates would exceed it)`);
for (let i = 1; i < books.length; i += 1) {
  const a = books[i - 1], b = books[i];
  assert.equal(b.sequence, a.sequence + 1, `sequence is contiguous at ${i}`);
  assert.equal(b.YES.sequence, b.sequence); assert.equal(b.NO.sequence, b.sequence);
  assert.ok(b.YES.sourceAt >= a.YES.sourceAt && b.NO.sourceAt >= a.NO.sourceAt, `no side goes back at ${i}`);
}
assert.equal(books[0].sequence, 1, "renumbering starts from the round's base");
console.log(`PASS 3 ${books.length} merged books for ${sent} frames: contiguous sequence, no regression, no duplicate`);

// --- 3b. sockets out of step: each numbers its own frames, and the venue
// does not deliver every frame to both. Socket B alone gets five frames, then
// socket A alone gets three newer ones. A's own counter is behind B's, so a
// merge that forwarded each socket's own numbers would go 1..5 then 1..3 and
// the consumer's gate would reject A as a sequence regression.
{
  const [a, b] = [...sockets];
  const start = books.length;
  const only = (sock, data) => { framesSent += 1; if (sock.readyState === 1) sock.send(data); };
  for (let i = 0; i < 5; i += 1) { only(b, frame(0.6, 0.4)); await wait(30); }
  for (let i = 0; i < 3; i += 1) { only(a, frame(0.6, 0.4)); await wait(30); }
  await wait(60);
  const seqs = books.slice(start).map(x => x.sequence);
  assert.equal(seqs.length, 8, `every frame from either socket forwarded (${seqs.length}/8)`);
  for (let i = 1; i < seqs.length; i += 1) assert.equal(seqs[i], seqs[i - 1] + 1, `sequence contiguous across sockets: ${seqs.join(",")}`);
  assert.equal(seqs[0], books[start - 1].sequence + 1, "continues the merged numbering");
}
console.log("PASS 3b sockets out of step: numbering continues across sockets");

// --- 3c. a slower socket delivers an older frame after a newer one ---
// Both sockets see the same event, but not at the same moment. The late copy
// of an older event must never be forwarded behind a newer one.
{
  const [a, b] = [...sockets];
  const older = frame(0.6, 0.4), newer = frame(0.6, 0.4);
  const start = books.length;
  a.send(newer); await wait(40);
  b.send(older); await wait(40);      // b is behind: its old copy arrives last
  b.send(newer); await wait(40);
  const got = books.slice(start);
  assert.equal(got.length, 1, `only the newer event is forwarded (${got.length})`);
  const newerAt = JSON.parse(newer)[0].timestamp / 1000;
  assert.equal(got[0].YES.sourceAt, newerAt, "the forwarded book is the newer one");
  framesSent += 2;
}
console.log("PASS 3c late older copy from a slower socket is dropped");

// --- 3d. P1-2: sides advance on different sockets ---
// Socket B alone moves DOWN; socket A alone then moves UP across the trigger
// while A's own DOWN is still old. The UP cross must reach the consumer
// immediately, paired with B's newer DOWN. A per-frame merge dropped it.
{
  const [a, b] = [...sockets];
  const t = Math.max(clock + 10, Date.now());
  const one = (asset_id, ask, ts) => ({ event_type: "book", asset_id, market: "0xm", timestamp: String(ts),
    bids: [{ price: (ask - 0.01).toFixed(2), size: "100" }], asks: [{ price: ask.toFixed(2), size: "100" }] });
  const start = books.length;
  b.send(JSON.stringify([one(UP, 0.60, t), one(DOWN, 0.40, t)]));
  a.send(JSON.stringify([one(UP, 0.60, t), one(DOWN, 0.40, t)]));
  await wait(60);
  b.send(JSON.stringify([one(DOWN, 0.31, t + 100)]));        // DOWN advances on B only
  await wait(60);
  a.send(JSON.stringify([one(UP, 0.68, t + 200)]));          // UP crosses on A; A's DOWN is still t
  await wait(80);
  clock = t + 200; framesSent += 5;
  const got = books.slice(start);
  const cross = got.find(x => x.YES.ask === 0.68);
  assert.ok(cross, `UP cross forwarded (saw ${JSON.stringify(got.map(x => [x.YES.ask, x.NO.ask]))})`);
  assert.equal(cross.NO.ask, 0.31, "the cross is paired with the newer DOWN from the other socket");
  assert.equal(cross.YES.sourceAt, (t + 200) / 1000, "UP carries its own exchange time");
  assert.equal(cross.NO.sourceAt, (t + 100) / 1000, "DOWN carries its own exchange time");
  assert.equal(cross.expiresAt, Math.min(START + 300, (t + 100) / 1000 + 2), "expiry follows the older side");
}
console.log("PASS 3d per-side merge: a cross on one socket is not held back by the other");

// --- 4. the consumer's gate accepts the merged stream in order ---
let watermark, accepted = 0;
const identity = { marketId: "0xm", roundId: String(START), endsAt: START + 300, yesAssetId: UP, noAssetId: DOWN };
for (const s of books) {
  if (s.expiresAt <= Date.now() / 1000) continue;
  const r = validateMarketSnapshot(s, identity, watermark, Math.min(s.expiresAt - 0.001, Date.now() / 1000), true);
  assert.ok(r.ok, `gate rejected merged book: ${r.reason}`);
  watermark = r.watermark; accepted += 1;
}
console.log(`PASS 4 snapshot gate accepted ${accepted} merged books in order`);

// --- 5. stop() closes every socket; nothing emitted afterwards ---
feed.stop(); stoppedAt = Date.now();
assert.ok(await until(() => sockets.size === 0, 2000), "stop closes every socket");
broadcast(frame(0.8, 0.2)); await wait(300);
assert.equal(afterStop, 0, "nothing is emitted after stop");
assert.equal(feed.isHealthy(), false);
console.log("PASS 5 stop: all sockets closed, nothing emitted after");

wss.close();
console.log("ALL PASS");
process.exit(0);

// Bybit USDT perpetual trades as the lead source (user 2026-10-29): the same
// 250 ms / 2 bp detector on Bybit linear publicTrade, two lines deduplicated.
// Bybit frames carry many trades; one sweep shares a `seq` and a time (live
// 2026-10-29: 59 of 66 multi-trade frames), so a trade is new when its seq is
// above the last one delivered, or equal with an id not yet delivered.
// Runs the real compiled ingest, runBybitTrades against two loopback servers,
// bybitLeadFeed, and readStrategyConfig picking the source. No Bybit connection.
//   node scripts/regress/bybit-trades.mjs   (after npm run build)
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createBybitTradeIngest, runBybitTrades, bybitLeadFeed, bybitTradeUrls, LeadSignalDetector }
  from "../../dist/live/feeds/binance-trades.js";
import { readStrategyConfig } from "../../dist/cli/platform.js";
import { normalizeBinanceLeadConfig, BINANCE_LEAD_DEFAULTS } from "../../dist/strategies/binance-lead.js";

const T0 = 1_800_000_020_000;
const trade = (seq, i, p = "80000.0", T = T0 + seq) => ({ T, s: "BTCUSDT", S: "Buy", v: "0.010", p, L: "PlusTick", i, BT: false, RPI: false, seq });
const frame = (...data) => JSON.stringify({ topic: "publicTrade.BTCUSDT", type: "snapshot", ts: T0, data });
const at = (ms) => ms / 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) return false; await sleep(10); } return true; };

assert.deepEqual(bybitTradeUrls(), ["wss://stream.bybit.com/v5/public/linear", "wss://stream.bytick.com/v5/public/linear"]);

// --- one ingest for both lines: a sweep sharing a seq, duplicates, order ---
{
  const got = [];
  const ingest = createBybitTradeIngest(t => got.push(t));
  // line A: a 3-trade sweep at seq 10; line B: the same sweep, split over two frames
  assert.equal(ingest(frame(trade(10, "a"), trade(10, "b", "80000.5"), trade(10, "c", "80001.0")), at(T0 + 110), 1), true);
  assert.equal(ingest(frame(trade(10, "a"), trade(10, "b", "80000.5")), at(T0 + 111), 2), false, "B's copy delivers nothing");
  assert.equal(ingest(frame(trade(10, "c", "80001.0")), at(T0 + 112), 3), false);
  assert.deepEqual(got.map(t => t.price), [80000, 80000.5, 80001], "each trade once, in the venue's order");
  // the rest of a sweep arriving in a later frame (same seq, new id) is delivered
  assert.equal(ingest(frame(trade(10, "d", "80001.5")), at(T0 + 113), 4), true);
  // an older seq is a duplicate or late copy: dropped
  assert.equal(ingest(frame(trade(9, "z", "1.0")), at(T0 + 114), 5), false);
  assert.equal(ingest(frame(trade(11, "e", "80002.0")), at(T0 + 115), 6), true);
  assert.deepEqual(got.map(t => t.id), [1, 2, 3, 4, 5], "ids are delivery order");
  assert.deepEqual(got[0], { id: 1, price: 80000, tradeTimeMs: T0 + 10, receivedAtUnix: at(T0 + 110), receivedAtMonoMs: 1 });
  for (const bad of ["not json", "{}", JSON.stringify({ op: "subscribe", success: true }),
    JSON.stringify({ topic: "publicTrade.ETHUSDT", data: [trade(20, "x")] }),
    frame({ ...trade(20, "x"), s: "ETHUSDT" }), frame({ ...trade(20, "x"), p: "x" }), frame({ ...trade(20, "x"), p: "0" }),
    frame({ ...trade(20, "x"), i: "" }), frame({ ...trade(20, "x"), seq: "20" }), frame({ ...trade(20, "x"), T: undefined })]) {
    assert.equal(ingest(bad, at(T0 + 120), 0), false, bad.slice(0, 60));
  }
  assert.equal(got.length, 5, "malformed frames delivered nothing");
  assert.equal(ingest(Buffer.from(frame(trade(21, "y", "80003.0"))), at(T0 + 121), 7), true, "ws delivers Buffers");
}
// --- stale, future and wild-seq trades never reach the detector (as Binance, review 10-25) ---
{
  const got = [];
  const ingest = createBybitTradeIngest(t => got.push(t));
  assert.equal(ingest(frame(trade(100, "a", "80000.0", T0)), at(T0 + 95), 1), true, "a fresh trade is delivered");
  assert.equal(ingest(frame(trade(101, "b", "80030.0", T0 + 10)), at(T0 + 10 + 1001), 2), false, "just over 1 s old: dropped");
  assert.equal(ingest(frame(trade(102, "c", "80030.0", T0 + 20)), at(T0 + 20 + 999), 3), true, "under 1 s: delivered");
  assert.equal(ingest(frame(trade(103, "d", "80030.0", 9e15)), at(T0 + 30), 4), false, "a far-future trade time is dropped");
  // seq is no watermark across time (see the outage case below): a wild seq on a
  // later trade is just a trade, and it cannot wedge the ones after it.
  assert.equal(ingest(frame(trade(1e15, "e", "80030.0", T0 + 40)), at(T0 + 140), 5), true, "a later trade, whatever its seq");
  assert.equal(ingest(frame(trade(104, "f", "80030.0", T0 + 50)), at(T0 + 150), 6), true, "real trades still flow");
  assert.deepEqual(got.map(t => t.price), [80000, 80030, 80030, 80030]);
}
// --- after a long outage the stream resumes (review 2026-10-29) ---
// Bybit's seq is the whole contract's match sequence: ~9,000-22,000 a second
// against ~90 trades. Both lines down 2 minutes put the next seq 1e6+ ahead, and
// the Binance-sized jump guard dropped every trade from then on, for good. A
// renumbered (lower) seq would drop them as duplicates with the feed "healthy".
// A copy of a delivered trade is never later than the latest delivered time, so
// a later trade is new whatever its seq says.
{
  const got = [];
  const ingest = createBybitTradeIngest(t => got.push(t));
  const S = 834_185_528_852, now = T0;
  assert.equal(ingest(frame(trade(S, "a", "80000.0", now)), at(now + 95), 1), true);
  for (let k = 0; k < 3; k++) {
    const T = now + 120_000 + k * 1000;
    assert.equal(ingest(frame(trade(S + (120 + k) * 9105, `b${k}`, "80001.0", T)), at(T + 95), 2), true, `trade ${k} after a 2 min outage`);
  }
  assert.equal(got.length, 4, "the stream resumed");
  assert.equal(ingest.lastWasCurrent(), true, "and the line counts as alive");
  // the other line's late copy of the last trade is still a duplicate
  assert.equal(ingest(frame(trade(S + 122 * 9105, "b2", "80001.0", now + 122_000)), at(now + 122_150), 3), false);
  // a renumbered, lower seq after a restart of theirs: later trades still flow
  const T = now + 130_000;
  assert.equal(ingest(frame(trade(5, "r1", "80002.0", T)), at(T + 95), 4), true, "a lower seq on a later trade is new");
  assert.equal(ingest(frame(trade(6, "r2", "80003.0", T + 10)), at(T + 105), 5), true);
  assert.equal(ingest(frame(trade(6, "r2", "80003.0", T + 10)), at(T + 106), 6), false, "its copy is a duplicate");
  assert.equal(got.length, 6);
  // inside the same millisecond a jump is still checked: a wild seq there is dropped
  assert.equal(ingest(frame(trade(6 + 2e6, "w", "1.0", T + 10)), at(T + 107), 7), false, "a wild seq at the same time is dropped");
}
// --- two loopback lines: subscribe sent on open, each trade once, a dead line reconnects ---
{
  const servers = [new WebSocketServer({ port: 0 }), new WebSocketServer({ port: 0 })];
  const subscribed = [[], []];
  const sockets = [[], []];
  servers.forEach((server, k) => server.on("connection", ws => {
    sockets[k].push(ws);
    ws.on("message", raw => subscribed[k].push(String(raw)));
  }));
  await Promise.all(servers.map(s => new Promise(r => s.on("listening", r))));
  const urls = servers.map(s => `ws://127.0.0.1:${s.address().port}`);
  const got = [];
  const feed = runBybitTrades(t => got.push(t), "BTCUSDT", urls);
  assert.ok(await until(() => sockets[0].length && sockets[1].length), "both lines connect");
  assert.ok(await until(() => subscribed[0].length && subscribed[1].length), "both subscribe");
  assert.deepEqual(JSON.parse(subscribed[0][0]), { op: "subscribe", args: ["publicTrade.BTCUSDT"] });
  const now = Date.now();
  const live = (seq, i, p) => frame(trade(seq, i, p, now - 90));
  sockets[1][0].send(live(500, "s1", "80000.0"));
  sockets[0][0].send(live(500, "s1", "80000.0"));
  sockets[0][0].send(live(501, "s2", "80001.0"));
  sockets[1][0].send(live(501, "s2", "80001.0"));
  assert.ok(await until(() => got.length === 2));
  await sleep(100);
  assert.equal(got.length, 2, "each trade once across the two lines");
  assert.equal(feed.isHealthy(), true);
  sockets[0][0].close();
  assert.ok(await until(() => sockets[0].length === 2), "a closed line reconnects");
  assert.ok(await until(() => subscribed[0].length === 2), "and subscribes again");
  feed.stop();
  assert.equal(feed.isHealthy(), false);
  await Promise.all(servers.map(s => new Promise(r => s.close(r))));
}
// --- bybitLeadFeed: the same detector rule on Bybit prices ---
{
  const detector = new LeadSignalDetector({ windowMs: 250, thresholdBp: 2, fromSec: 0, toSec: 300 });
  const events = [];
  const ingest = createBybitTradeIngest(t => { const s = detector.push(t, t.receivedAtUnix); if (s) events.push({ kind: "lead", ...s }); });
  ingest(frame(trade(1, "a", "80000.0", T0)), at(T0 + 95), 1);
  ingest(frame(trade(2, "b", "80008.0", T0 + 100)), at(T0 + 195), 2);       // +1.0 bp
  ingest(frame(trade(3, "c", "80016.1", T0 + 200)), at(T0 + 295), 3);       // +2.01 bp vs 80000 in 250 ms
  assert.equal(events.length, 1, "one signal");
  assert.equal(events[0].direction, "UP");
  assert.equal(events[0].refPrice, 80000);
  assert.ok(events[0].moveBp >= 2 && events[0].moveBp < 2.1);
  assert.equal(events[0].receivedAtUnix, at(T0 + 295), "S = when we saw the Bybit trade");
  assert.equal(typeof bybitLeadFeed(detector), "function");
}
// --- the config picks the source; an older file without it reads Binance spot ---
{
  assert.equal(BINANCE_LEAD_DEFAULTS.leadSource, "binance-spot", "the default stays the frozen Binance rule");
  assert.equal(normalizeBinanceLeadConfig({ leadSource: "bybit-perp" }).leadSource, "bybit-perp");
  for (const bad of ["okx", "", null, 1, "BYBIT-PERP"]) assert.throws(() => normalizeBinanceLeadConfig({ leadSource: bad }), String(bad));
  const dir = mkdtempSync(join(tmpdir(), "lead-source-"));
  const file = join(dir, "binance-lead-config.json");
  const base = { assetId: "btc", shares: 5, thresholdBp: 2, windowMs: 250, limitPremium: 0.03, fromSec: 15, toSec: 265,
    maxQuoteAgeSeconds: 2, maxQuoteSkewSeconds: 1.5, roundBudgetUsd: 5, totalBudgetUsd: 100, dailyLossUsd: 60,
    durationMinutes: 0, maxRounds: 24, mode: "live" };
  const doc = (config) => JSON.stringify({ schemaVersion: 1, strategyId: "binance-lead", savedRevision: 3, savedAt: "2026-10-29T00:00:00Z", config });
  writeFileSync(file, doc(base));
  assert.equal(readStrategyConfig(file).config.leadSource, "binance-spot", "revision 2 on the server has no leadSource");
  writeFileSync(file, doc({ ...base, leadSource: "bybit-perp" }));
  assert.equal(readStrategyConfig(file).config.leadSource, "bybit-perp");
  writeFileSync(file, doc({ ...base, leadSource: "kraken" }));
  assert.throws(() => readStrategyConfig(file), /leadSource/);
  rmSync(dir, { recursive: true, force: true });
}
console.log("bybit-trades OK");

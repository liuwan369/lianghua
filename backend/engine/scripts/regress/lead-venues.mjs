// Three lead venues, two lines each (lead-trades.ts), one detector per venue.
// 1) parsers: Binance USD-M aggTrade, OKX trades (multi-trade data), Bybit;
//    OKX "pong" and the subscribe ack carry nothing.
// 2) per-venue dedupe across lines: a trade on direct then tokyo is delivered
//    once with the first line, and the gap is counted as that line's lead; an
//    older trade after a newer one is dropped; either line alone delivers.
// 3) detectors are independent: a 2 bp move on OKX signals OKX only.
// 4) strategy: the first qualifying signal of any venue places the round's one
//    order; a later signal of another venue does nothing; an old state whose
//    signal has no venue/line restores as bybit/direct.
// Run after `npm run build`:  node scripts/regress/lead-venues.mjs
import assert from "node:assert/strict";
import { LeadSignalDetector } from "../../dist/live/feeds/binance-trades.js";
import { VenueIngest, parseBinanceFrame, parseBybitFrame, parseOkxFrame, binanceTradeUrls, okxTradeUrls }
  from "../../dist/live/feeds/lead-trades.js";
import { leadPerpProducts } from "../../dist/live/feeds/btc.js";
import { createStrategy } from "../../dist/strategies/binance-lead.js";

const T0 = 1_800_000_020_000;
const at = (ms) => ms / 1000;
const okxFrame = (...trades) => JSON.stringify({ arg: { channel: "trades", instId: "BTC-USDT-SWAP" },
  data: trades.map(([id, px, ts]) => ({ instId: "BTC-USDT-SWAP", tradeId: String(id), px: String(px), sz: "0.01", side: "buy", ts: String(ts), count: "1" })) });
const binanceFrame = (a, p, T) => JSON.stringify({ e: "aggTrade", E: T + 2, s: "BTCUSDT", a, p: String(p), q: "0.010", f: a, l: a, T, m: false });
const bybitFrame = (seq, i, p, T) => JSON.stringify({ topic: "publicTrade.BTCUSDT", type: "snapshot", ts: T,
  data: [{ T, s: "BTCUSDT", S: "Buy", v: "0.010", p: String(p), L: "PlusTick", i, BT: false, RPI: false, seq }] });

// --- 1. parsers and products ---
{
  assert.deepEqual(leadPerpProducts("btc"), { bybit: "BTCUSDT", binance: "btcusdt", okx: "BTC-USDT-SWAP" });
  assert.deepEqual(binanceTradeUrls("btcusdt"), ["wss://fstream.binance.com/market/ws/btcusdt@aggTrade"], "the /market path");
  assert.deepEqual(okxTradeUrls(), ["wss://ws.okx.com:8443/ws/v5/public"]);
  const out = [];
  parseBinanceFrame(binanceFrame(5_123_456_789, "80000.10", T0), "BTCUSDT", out);
  assert.deepEqual(out, [{ venue: "binance", id: 5_123_456_789, price: 80000.1, tradeTimeMs: T0 }]);
  out.length = 0;
  // OKX: several trades per push, newest first as OKX sends them -> id order
  parseOkxFrame(okxFrame([902, 80002, T0 + 2], [901, 80001, T0 + 1], [900, 80000, T0]), "BTC-USDT-SWAP", out);
  assert.deepEqual(out, [
    { venue: "okx", id: 900, price: 80000, tradeTimeMs: T0 },
    { venue: "okx", id: 901, price: 80001, tradeTimeMs: T0 + 1 },
    { venue: "okx", id: 902, price: 80002, tradeTimeMs: T0 + 2 }]);
  out.length = 0;
  for (const noise of ["pong", JSON.stringify({ event: "subscribe", arg: { channel: "trades", instId: "BTC-USDT-SWAP" }, connId: "a1" }),
    JSON.stringify({ event: "error", code: "60012", msg: "Invalid request" }), "not json",
    okxFrame([1, 80000, T0]).replace(/BTC-USDT-SWAP/g, "ETH-USDT-SWAP"),
    JSON.stringify({ arg: { channel: "trades", instId: "BTC-USDT-SWAP" }, data: [{ instId: "BTC-USDT-SWAP", tradeId: "x", px: "1", ts: String(T0) }] })]) {
    parseOkxFrame(noise, "BTC-USDT-SWAP", out);
  }
  assert.deepEqual(out, [], "OKX pong / acks / errors / other instruments carry no trades");
  parseBybitFrame(bybitFrame(10, "uuid-a", "80000.5", T0), "BTCUSDT", out);
  assert.deepEqual(out, [{ venue: "bybit", id: "uuid-a", seq: 10, price: 80000.5, tradeTimeMs: T0 }]);
  out.length = 0;
  parseBinanceFrame(JSON.stringify({ result: null, id: 1 }), "BTCUSDT", out);
  assert.deepEqual(out, []);
}

// --- 2. dedupe across direct and tokyo ---
{
  const got = [];
  const okx = new VenueIngest("okx", "BTC-USDT-SWAP", t => got.push(t));
  // direct first at mono 100, Tokyo's copy 7 ms later
  assert.equal(okx.frame(okxFrame([1000, 80000, T0]), "direct", at(T0 + 90), 100), true);
  assert.equal(okx.relayed({ venue: "okx", id: 1000, price: 80000, tradeTimeMs: T0, tokyoRecvMs: T0 + 40 }, at(T0 + 97), 107), 1);
  // tokyo first, direct 3 ms later
  assert.equal(okx.relayed({ venue: "okx", id: 1001, price: 80001, tradeTimeMs: T0 + 5, tokyoRecvMs: T0 + 45 }, at(T0 + 100), 110), 2);
  assert.equal(okx.frame(okxFrame([1001, 80001, T0 + 5]), "direct", at(T0 + 103), 113), false);
  assert.deepEqual(got.map(t => [t.id, t.line, t.relayRecvMs]), [[1000, "direct", undefined], [1001, "tokyo", T0 + 45]],
    "each trade once, with the line that had it first");
  const stats = okx.stats();
  assert.equal(stats.direct.delivered, 1); assert.equal(stats.tokyo.delivered, 1);
  assert.equal(stats.direct.leadCount, 1); assert.equal(stats.direct.leadSumMs, 7);
  assert.equal(stats.tokyo.leadCount, 1); assert.equal(stats.tokyo.leadSumMs, 3);
  assert.equal(stats.tokyo.leadMeanMs, 3);
  // a third copy does not count again
  okx.relayed({ venue: "okx", id: 1000, price: 80000, tradeTimeMs: T0, tokyoRecvMs: T0 + 40 }, at(T0 + 120), 130);
  assert.equal(okx.stats().direct.leadCount, 1, "only the first copy times the lead");
  // an older trade after a newer one is dropped
  assert.equal(okx.relayed({ venue: "okx", id: 999, price: 1, tradeTimeMs: T0 + 6, tokyoRecvMs: T0 + 46 }, at(T0 + 125), 135), 1);
  assert.equal(got.length, 2);
  // tokyo down: direct alone delivers
  for (let k = 0; k < 3; k++) assert.equal(okx.frame(okxFrame([1002 + k, 80002, T0 + 10 + k]), "direct", at(T0 + 130 + k), 140 + k), true);
  // direct down: tokyo alone delivers
  for (let k = 0; k < 3; k++) {
    assert.equal(okx.relayed({ venue: "okx", id: 1005 + k, price: 80003, tradeTimeMs: T0 + 20 + k, tokyoRecvMs: T0 + 60 }, at(T0 + 140 + k), 150 + k), 2);
  }
  assert.deepEqual(got.map(t => t.id), [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007]);
  // stale relayed copy (over 1 s) is refused and does not move the watermark
  assert.equal(okx.relayed({ venue: "okx", id: 1010, price: 1, tradeTimeMs: T0, tokyoRecvMs: T0 }, at(T0 + 1500), 200), 0);
  assert.equal(okx.frame(okxFrame([1009, 80004, T0 + 1450]), "direct", at(T0 + 1500), 201), true);
  // after a long gap a big id jump is a resume, inside a minute it is a bad frame
  assert.equal(okx.frame(okxFrame([1009 + 2e6, 1, T0 + 1460]), "direct", at(T0 + 1500), 202), false, "wild jump dropped");
  assert.equal(okx.frame(okxFrame([1009 + 2e6, 80005, T0 + 120_000]), "direct", at(T0 + 120_050), 203), true, "resume after 2 min");

  // Bybit across lines: the same UUID on tokyo after direct is a copy
  const bybitGot = [];
  const bybit = new VenueIngest("bybit", "BTCUSDT", t => bybitGot.push(t));
  assert.equal(bybit.frame(bybitFrame(50, "u1", 80000, T0), "direct", at(T0 + 90), 10), true);
  assert.equal(bybit.relayed({ venue: "bybit", id: "u1", seq: 50, price: 80000, tradeTimeMs: T0, tokyoRecvMs: T0 + 50 }, at(T0 + 91), 11), 1);
  assert.equal(bybit.relayed({ venue: "bybit", id: "u2", seq: 50, price: 80001, tradeTimeMs: T0, tokyoRecvMs: T0 + 50 }, at(T0 + 92), 12), 2,
    "the rest of the sweep from the other line");
  assert.deepEqual(bybitGot.map(t => [t.id, t.line]), [[1, "direct"], [2, "tokyo"]]);
  assert.equal(bybit.stats().direct.leadSumMs, 1);
}

// --- 3. per-venue detectors are independent ---
{
  const params = { windowMs: 250, thresholdBp: 2, fromSec: 0, toSec: 300 };
  const detectors = { bybit: new LeadSignalDetector(params), okx: new LeadSignalDetector(params) };
  const signals = [];
  const sink = t => { const s = detectors[t.venue].push(t, t.receivedAtUnix); if (s) signals.push(s); };
  const okx = new VenueIngest("okx", "BTC-USDT-SWAP", sink);
  const bybit = new VenueIngest("bybit", "BTCUSDT", sink);
  bybit.frame(bybitFrame(1, "b1", 80000, T0), "direct", at(T0 + 90), 1);
  bybit.frame(bybitFrame(2, "b2", 80001, T0 + 50), "direct", at(T0 + 140), 2);
  okx.frame(okxFrame([10, 80010, T0]), "direct", at(T0 + 90), 3);
  okx.relayed({ venue: "okx", id: 11, price: 80026.1, tradeTimeMs: T0 + 100, tokyoRecvMs: T0 + 120 }, at(T0 + 190), 4);   // +2.01 bp
  assert.equal(signals.length, 1, "one signal");
  assert.deepEqual([signals[0].venue, signals[0].line, signals[0].direction, signals[0].refPrice, signals[0].tradeId, signals[0].relayRecvMs],
    ["okx", "tokyo", "UP", 80010, 11, T0 + 120]);
  // Bybit's window still holds its own 80000 low: 80016.1 is +2.01 bp against it, not against OKX's prices.
  bybit.frame(bybitFrame(3, "b3", 80016.1, T0 + 150), "direct", at(T0 + 240), 5);
  assert.equal(signals.length, 2);
  assert.deepEqual([signals[1].venue, signals[1].line, signals[1].refPrice], ["bybit", "direct", 80000]);
}

// --- 4. strategy across venues, and restore of an old state ---
{
  const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
  const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
    instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                  { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
  const ctx = (now) => ({ mode: "live", now, markets: [market], books: [], estimateFee: () => 0,
    account: { cashUsd: 100, positions: [], orders: [], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 100, occupiedUsd: 0 } } });
  const book = (t) => ({ kind: "book", marketId: "0xm", roundId: ROUND, snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND,
    sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: 0.56, ask: 0.57, sourceAt: t, expiresAt: t + 2 }, NO: { assetId: DOWN, bid: 0.42, ask: 0.43, sourceAt: t, expiresAt: t + 2 } } });
  const lead = (S, venue, line, tradeId, direction = "UP") => ({ kind: "lead", assetId: "btc", direction, price: 100030, refPrice: 100000,
    moveBp: 3, venue, line, tradeId, tradeTimeMs: S * 1000 - 100, receivedAtUnix: S, receivedAtMonoMs: 5 });
  const s = createStrategy();
  s.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
  s.onEvent(book(START + 20), ctx(START + 20));
  const first = s.onEvent(lead(START + 21, "okx", "tokyo", 7), ctx(START + 21)).filter(a => a.kind === "submit");
  assert.equal(first.length, 1, "OKX's signal places the round's order");
  const later = s.onEvent(lead(START + 21.05, "bybit", "direct", 7, "DOWN"), ctx(START + 21.05)).filter(a => a.kind === "submit");
  assert.deepEqual(later, [], "Bybit's later signal (same trade id) does nothing");
  const state = s.exportState();
  assert.deepEqual([state.rounds[0].stages[0].signal.venue, state.rounds[0].stages[0].signal.line], ["okx", "tokyo"]);
  // A state saved before venues: the stage's signal has no venue/line.
  const old = JSON.parse(JSON.stringify(state));
  delete old.rounds[0].stages[0].signal.venue; delete old.rounds[0].stages[0].signal.line;
  delete old.config.leadVenues; delete old.config.tokyoRelay; old.config.leadSource = "bybit-perp";
  delete old.rounds[0].config.leadVenues; delete old.rounds[0].config.tokyoRelay; old.rounds[0].config.leadSource = "bybit-perp";
  const restored = createStrategy({}, old).exportState();
  assert.deepEqual([restored.rounds[0].stages[0].signal.venue, restored.rounds[0].stages[0].signal.line], ["bybit", "direct"]);
  assert.deepEqual(restored.config.leadVenues, ["bybit", "binance", "okx"]);
  assert.equal("leadSource" in restored.rounds[0].config, false);
  const badVenue = JSON.parse(JSON.stringify(state));
  badVenue.rounds[0].stages[0].signal.venue = "kraken";
  assert.throws(() => createStrategy({}, badVenue), /stage/);
}
console.log("lead-venues OK");

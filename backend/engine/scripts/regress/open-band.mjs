// openBandBp (user 2026-11-01, ±5bp): trade only a signal whose lead price is
// within the band of the round's opening lead price, signed by the signal:
// -band <= d < band, d = ln(price / open) × 1e4 (× -1 for DOWN). Backtest
// E:/pm-backup/research-1101/band.py; its open is the last trade at or before
// the round start (trade time).
// 1) the detector carries the round's open; none when the feed started mid-round.
// 2) the strategy skips outside the band, trades inside, keeps the attempt;
//    band 0 = no filter; an open from another round is not used.
// Run after `npm run build`:  node scripts/regress/open-band.mjs
import assert from "node:assert/strict";
import { LeadSignalDetector } from "../../dist/live/feeds/binance-trades.js";
import { createStrategy, normalizeBinanceLeadConfig } from "../../dist/strategies/binance-lead.js";

const R = 1_800_000_000;                                 // a round open (multiple of 300)
const PARAMS = { windowMs: 250, thresholdBp: 2, fromSec: 15, toSec: 265 };
let id = 0;
const push = (d, tSec, price) => d.push({ id: ++id, price, tradeTimeMs: Math.round(tSec * 1000), receivedAtUnix: tSec + 0.095, receivedAtMonoMs: 0 }, tSec + 0.095);

// --- 1. detector: the open is the last trade at or before the round start ---
{
  const d = new LeadSignalDetector(PARAMS);
  push(d, R - 10, 99_000);                               // previous round
  push(d, R - 0.4, 100_000);                             // last trade before the open -> the open
  push(d, R + 3, 100_100);
  push(d, R + 20, 100_100);
  const s = push(d, R + 20.1, 100_130);                  // +3 bp in 100 ms -> UP signal
  assert.equal(s?.direction, "UP");
  assert.equal(s.openPrice, 100_000, "open = last trade at or before R");
  // A trade exactly at the start opens the round itself.
  const e = new LeadSignalDetector(PARAMS);
  push(e, R + 300 - 1, 101_000); push(e, R + 300, 101_500); push(e, R + 320, 101_500);
  assert.equal(push(e, R + 320.1, 101_540).openPrice, 101_500, "a trade at R opens the round");
  // Feed started inside the round: no open.
  const f = new LeadSignalDetector(PARAMS);
  push(f, R + 20, 100_100);
  const g = push(f, R + 20.1, 100_130);
  assert.equal(g?.direction, "UP");
  assert.equal(g.openPrice, undefined, "no trade before the open: the round has no open price");
  // A gap longer than a round: the trade before is from two rounds back -> no open.
  const h = new LeadSignalDetector(PARAMS);
  push(h, R - 400, 100_000); push(h, R + 20, 100_100);
  assert.equal(push(h, R + 20.1, 100_130).openPrice, undefined, "a trade from an older round is not this round's open");
}

// --- 2. strategy ---
const START = R, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = { cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } };
const ctx = (now) => ({ mode: "live", now, markets: [market], books: [], account, estimateFee: () => 0.02 });
const book = (t) => ({ kind: "book", marketId: "0xm", roundId: ROUND,
  snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND, sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: 0.49, ask: 0.5, sourceAt: t, expiresAt: t + 2 }, NO: { assetId: DOWN, bid: 0.49, ask: 0.52, sourceAt: t, expiresAt: t + 2 } } });
let tid = 0;
const lead = (S, direction, price, openPrice, tradeSec = S - 0.095) => ({ kind: "lead", assetId: "btc", direction, price, refPrice: price,
  moveBp: direction === "UP" ? 2 : -2, ...(openPrice !== undefined ? { openPrice } : {}), tradeId: ++tid, tradeTimeMs: tradeSec * 1000,
  receivedAtUnix: S, receivedAtMonoMs: 0 });
const submits = (a) => a.filter(x => x.kind === "submit").map(x => x.order);
const begin = (cfg) => { const s = createStrategy(cfg); s.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20)); s.onEvent(book(START + 19), ctx(START + 19)); return s; };
const on = (s, e) => s.onEvent(e, ctx(e.receivedAtUnix + 0.002));
const reason = (s) => s.exportState().rounds[0].reason;
const OPEN = 100_000;
const at = (bp) => OPEN * Math.exp(bp / 1e4);            // price this many bp from the open

{
  const s = begin({ openBandBp: 5 });
  // UP 6 bp ahead: outside. DOWN at +6 bp means 6 bp behind: outside too.
  assert.equal(submits(on(s, lead(START + 20, "UP", at(6), OPEN))).length, 0, "UP 6 bp ahead of the open: skipped");
  assert.match(reason(s), /领先 6\.0 bp，超出 ±5 bp/);
  assert.equal(submits(on(s, lead(START + 21, "DOWN", at(6), OPEN))).length, 0, "DOWN while 6 bp above the open (6 behind): skipped");
  assert.match(reason(s), /落后 6\.0 bp/);
  // Boundaries on real 0.1 ticks (backtest -5 <= d < 5): 100050.1 = +5.009 bp out,
  // 99950.0 = -5.001 bp out, 99950.1 = -4.991 bp in.
  assert.equal(submits(on(s, lead(START + 22, "UP", 100_050.1, OPEN))).length, 0, "+5.009 bp is outside");
  assert.equal(submits(on(s, lead(START + 22.5, "UP", 99_950.0, OPEN))).length, 0, "-5.001 bp is outside");
  const [o] = submits(on(s, lead(START + 23, "UP", 99_950.1, OPEN)));
  assert.ok(o, "-4.991 bp is inside: the skipped signals did not use the round's attempt");
  assert.equal(o.tokenId, UP);
}
{
  const s = begin({ openBandBp: 5 });
  assert.equal(submits(on(s, lead(START + 20, "UP", at(1)))).length, 0, "no open price: skipped");
  assert.match(reason(s), /开盘价未知/);
  // An open stamped for another round (trade time in the previous round) is not used.
  assert.equal(submits(on(s, lead(START + 20.5, "UP", at(1), OPEN, START - 1))).length, 0, "an open from another round is not used");
  assert.ok(submits(on(s, lead(START + 21, "DOWN", at(-2), OPEN))).length === 1, "DOWN 2 bp below the open (2 ahead): inside");
}
{
  const s = begin({});                                   // default 0: no filter
  assert.equal(normalizeBinanceLeadConfig({}).openBandBp, 0);
  assert.equal(submits(on(s, lead(START + 20, "UP", at(40), OPEN))).length, 1, "band 0 trades any distance");
  assert.throws(() => normalizeBinanceLeadConfig({ openBandBp: -1 }), /openBandBp/);
}
console.log("open-band OK");

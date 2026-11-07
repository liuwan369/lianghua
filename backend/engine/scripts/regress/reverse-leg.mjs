// New plan 2026-11-07 (user, memory decision-2026-11-07-new-plan; backtest
// E:/pm-backup/research-1107/band_width.py, 21 days: +535 -> +803):
// 1) openLine "mean60": the band is measured from the mean of the lead price
//    over the 60 whole seconds (R-60, R] (each second = the last trade at or
//    before it), the official target's 60 s TWAP window. "tick" keeps the last
//    trade at or before R.
// 2) reverse leg: after the first order bought something, the round's first
//    signal on the other side whose ask is <= reverseMaxAsk buys `shares` of that
//    side, FAK ask + limitPremium, no band, until reverseToSec. At most once;
//    a signal on the first order's own side does nothing; client id ":2".
// 3) restore accepts a round with the two stages and rejects anything else.
// Run after `npm run build`:  node scripts/regress/reverse-leg.mjs
import assert from "node:assert/strict";
import { LeadSignalDetector } from "../../dist/live/feeds/binance-trades.js";
import { createStrategy, normalizeBinanceLeadConfig, presignPrices } from "../../dist/strategies/binance-lead.js";
import { leadSignalParams } from "../../dist/cli/platform.js";

const R = 1_800_000_000;
const PARAMS = { windowMs: 250, thresholdBp: 2, fromSec: 15, toSec: 265 };
let id = 0;
const push = (d, tSec, price) => d.push({ id: ++id, price, tradeTimeMs: Math.round(tSec * 1000), receivedAtUnix: tSec + 0.095, receivedAtMonoMs: 0 }, tSec + 0.095);

// --- 1. detector: openMean60 = mean of the 1 s grid over (R-60, R] ---
{
  const d = new LeadSignalDetector(PARAMS);
  // 100 000 until R-30.5, then 100 060 from R-30.5 on: seconds R-59..R-31 (29) at
  // 100 000, R-30..R (31) at 100 060 -> mean 100 000 + 60 * 31 / 60 = 100 031.
  push(d, R - 200, 100_000);
  for (let t = R - 199; t <= R - 31; t += 1) push(d, t, 100_000);
  push(d, R - 30.5, 100_060);
  for (let t = R - 30; t <= R + 20; t += 1) push(d, t, 100_060);
  const s = push(d, R + 20.1, 100_090);                   // +3 bp in 100 ms
  assert.equal(s?.direction, "UP");
  assert.equal(s.openPrice, 100_060, "tick open = last trade at or before R");
  assert.ok(Math.abs(s.openMean60 - 100_031) < 1e-6, `mean60 = 100031, got ${s.openMean60}`);
  // The feed started 30 s before the open: the window is not covered -> no mean.
  const e = new LeadSignalDetector(PARAMS);
  for (let t = R - 30; t <= R + 20; t += 1) push(e, t, 100_000);
  const g = push(e, R + 20.1, 100_030);
  assert.equal(g?.direction, "UP");
  assert.equal(g.openPrice, 100_000);
  assert.equal(g.openMean60, undefined, "history shorter than the 60 s window: no mean");
  // The next round gets its own mean.
  for (let t = R + 21; t <= R + 320; t += 1) push(e, t, 100_000);
  const h = push(e, R + 320.1, 100_030);
  assert.ok(Math.abs(h.openMean60 - 100_000) < 1e-6, "next round: mean of its own window");
}

// --- strategy harness ---
const START = R, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = (orders = [], positions = []) => ({ cashUsd: 1000, positions, orders, quarantinedOrderIds: [],
  risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } });
const ctx = (now, acct = account()) => ({ mode: "live", now, markets: [market], books: [], account: acct, estimateFee: () => 0.02 });
const book = (t, upAsk, downAsk) => ({ kind: "book", marketId: "0xm", roundId: ROUND,
  snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND, sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: upAsk - 0.01, ask: upAsk, sourceAt: t, expiresAt: t + 2 }, NO: { assetId: DOWN, bid: downAsk - 0.01, ask: downAsk, sourceAt: t, expiresAt: t + 2 } } });
let tid = 0;
const OPEN = 100_000;
const at = (bp) => OPEN * Math.exp(bp / 1e4);
// A key given as undefined means "absent" (the detector had no such price).
const lead = (S, direction, price, lines = {}) => {
  const open = "open" in lines ? lines.open : OPEN, mean = "mean" in lines ? lines.mean : OPEN;
  return leadEvent(S, direction, price, open, mean);
};
const leadEvent = (S, direction, price, open, mean) => ({ kind: "lead", assetId: "btc", direction, price, refPrice: price,
  moveBp: direction === "UP" ? 2 : -2, ...(open !== undefined ? { openPrice: open } : {}), ...(mean !== undefined ? { openMean60: mean } : {}),
  tradeId: ++tid, tradeTimeMs: (S - 0.095) * 1000, receivedAtUnix: S, receivedAtMonoMs: 0 });
const submits = (a) => a.filter(x => x.kind === "submit").map(x => x.order);
const CFG = { openBandBp: 5, openLine: "mean60", fromSec: 30, limitPremium: 0.08, reverseMaxAsk: 0.5, reverseToSec: 285, roundBudgetUsd: 10 };
const begin = (cfg = CFG) => { const s = createStrategy(cfg); s.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20)); return s; };
const on = (s, e, acct) => {
  const now = e.kind === "lead" ? e.receivedAtUnix + 0.002 : e.kind === "book" ? e.snapshot.tsUnix : e.kind === "order" ? e.order.updatedAt : e.ts;
  return s.onEvent(e, ctx(now, acct));
};
const record = (o, status, filledShares, at = START + 41) => ({ ...o, strategyId: "binance-lead", orderId: `0x${o.clientOrderId.slice(-1)}`,
  status, filledShares, reservedUsd: 0, reservedShares: 0, createdAt: at, updatedAt: at });
const round = (s) => s.exportState().rounds[0];

// --- 2. openLine mean60 decides the band; tick decides it under "tick" ---
{
  // Price 4 bp above the tick open but 7 bp above the 60 s mean: tick passes, mean60 does not.
  const tickCfg = { ...CFG, openLine: "tick" };
  const a = begin(tickCfg); on(a, book(START + 39, 0.5, 0.52));
  assert.equal(submits(on(a, lead(START + 40, "UP", at(4), { open: OPEN, mean: at(-3) }))).length, 1, "tick line: +4 bp is inside");
  const b = begin(); on(b, book(START + 39, 0.5, 0.52));
  assert.equal(submits(on(b, lead(START + 40, "UP", at(4), { open: OPEN, mean: at(-3) }))).length, 0, "mean60 line: +7 bp is outside");
  assert.match(round(b).reason, /60 秒均价.*领先 7\.0 bp/);
  // No 60 s mean (feed younger than the window): skipped, the attempt kept.
  assert.equal(submits(on(b, lead(START + 41, "UP", at(1), { mean: undefined }))).length, 0);
  assert.match(round(b).reason, /60 秒均价未知/);
  // fromSec 30: a signal at 29.9 s is outside.
  const c = begin(); on(c, book(START + 20, 0.5, 0.52));
  assert.equal(submits(on(c, lead(START + 29.9, "UP", at(1)))).length, 0, "before fromSec 30");
  assert.equal(submits(on(c, lead(START + 30.1, "UP", at(1)))).length, 1, "after fromSec 30");
  assert.equal(normalizeBinanceLeadConfig({}).openLine, "tick", "default keeps the old line");
  assert.throws(() => normalizeBinanceLeadConfig({ openLine: "close" }), /openLine/);
}

// --- 3. the reverse leg ---
{
  const s = begin(); on(s, book(START + 39, 0.5, 0.52));
  const [first] = submits(on(s, lead(START + 40, "UP", at(1))));
  assert.equal(first.clientOrderId, "binance-lead:0xm:1");
  const filled = record(first, "FILLED", 5);
  on(s, { kind: "order", order: filled }, account([filled], [{ tokenId: UP, shares: 5, costUsd: 2.9 }]));
  const acct = account([filled], [{ tokenId: UP, shares: 5, costUsd: 2.9 }]);
  // Same side again: nothing.
  on(s, book(START + 60, 0.6, 0.42), acct);
  assert.equal(submits(on(s, lead(START + 61, "UP", at(3)), acct)).length, 0, "a signal on the first order's side does nothing");
  // Opposite side but its ask 0.55 > 0.50: skipped, the leg stays available.
  on(s, book(START + 70, 0.46, 0.55), acct);
  assert.equal(submits(on(s, lead(START + 71, "DOWN", at(-1)), acct)).length, 0, "other side above reverseMaxAsk: skipped");
  assert.match(round(s).reason, /反转.*0\.55.*高于 0\.50/);
  // Opposite side at 0.40, far outside the band (no band on the leg): buys DOWN.
  on(s, book(START + 80, 0.61, 0.40), acct);
  const [rev] = submits(on(s, lead(START + 81, "DOWN", at(20)), acct));
  assert.ok(rev, "first reversal with the other ask <= 0.50 buys");
  assert.equal(rev.tokenId, DOWN);
  assert.equal(rev.clientOrderId, "binance-lead:0xm:2");
  assert.equal(rev.price, 0.48, "limit = 0.40 + 0.08");
  assert.equal(rev.shares, 5);
  assert.equal(rev.timeInForce, "FAK");
  assert.equal(round(s).stages.length, 2);
  assert.equal(round(s).stages[1].stage, 2);
  // Only once.
  const both = account([filled, record(rev, "FILLED", 5, START + 82)], [{ tokenId: UP, shares: 5, costUsd: 2.9 }, { tokenId: DOWN, shares: 5, costUsd: 2.4 }]);
  on(s, { kind: "order", order: record(rev, "FILLED", 5, START + 82) }, both);
  on(s, book(START + 90, 0.40, 0.62), both);
  assert.equal(submits(on(s, lead(START + 91, "UP", at(0)), both)).length, 0, "no third order");
  assert.equal(submits(on(s, lead(START + 92, "DOWN", at(0)), both)).length, 0, "no third order");
}
{
  // First order not filled: no reverse leg (nothing to hedge), and no second first order.
  const s = begin(); on(s, book(START + 39, 0.5, 0.52));
  const [first] = submits(on(s, lead(START + 40, "UP", at(1))));
  const none = record(first, "CANCELLED", 0);
  on(s, { kind: "order", order: none }, account([none]));
  on(s, book(START + 50, 0.6, 0.40), account([none]));
  assert.equal(submits(on(s, lead(START + 51, "DOWN", at(1)), account([none]))).length, 0, "unfilled first order: no reverse leg");
  // First order still in flight (SUBMITTING): no leg yet.
  const t = begin(); on(t, book(START + 39, 0.5, 0.52));
  submits(on(t, lead(START + 40, "UP", at(1))));
  on(t, book(START + 40.2, 0.6, 0.40));
  assert.equal(submits(on(t, lead(START + 40.3, "DOWN", at(1)))).length, 0, "first order not confirmed yet: no leg");
}
{
  // reverseToSec 285: a reversal at 285.1 s is too late; reverseMaxAsk 0 = off.
  const s = begin(); on(s, book(START + 39, 0.5, 0.52));
  const [first] = submits(on(s, lead(START + 40, "UP", at(1))));
  const filled = record(first, "FILLED", 5);
  const acct = account([filled], [{ tokenId: UP, shares: 5, costUsd: 2.9 }]);
  on(s, { kind: "order", order: filled }, acct);
  on(s, book(START + 285, 0.61, 0.40), acct);
  assert.equal(submits(on(s, lead(START + 285.1, "DOWN", at(0)), acct)).length, 0, "after reverseToSec");
  const off = begin({ ...CFG, reverseMaxAsk: 0 }); on(off, book(START + 39, 0.5, 0.52));
  const [f2] = submits(on(off, lead(START + 40, "UP", at(1))));
  const filled2 = record(f2, "FILLED", 5);
  const acct2 = account([filled2], [{ tokenId: UP, shares: 5, costUsd: 2.9 }]);
  on(off, { kind: "order", order: filled2 }, acct2);
  on(off, book(START + 60, 0.61, 0.40), acct2);
  assert.equal(submits(on(off, lead(START + 61, "DOWN", at(0)), acct2)).length, 0, "reverseMaxAsk 0: off");
  assert.equal(normalizeBinanceLeadConfig({}).reverseMaxAsk, 0, "default off");
  assert.throws(() => normalizeBinanceLeadConfig({ reverseMaxAsk: 1 }), /reverseMaxAsk/);
  assert.throws(() => normalizeBinanceLeadConfig({ reverseToSec: 301 }), /reverseToSec/);
  assert.throws(() => normalizeBinanceLeadConfig({ reverseMaxAsk: 0.5, makerHoldSec: 3 }), /reverse/);
  // The round budget still binds: 10 USD with 7.9 already in the round blocks a 2.5 leg.
  const tight = begin({ ...CFG, roundBudgetUsd: 10 }); on(tight, book(START + 39, 0.5, 0.52));
  const [f3] = submits(on(tight, lead(START + 40, "UP", at(1))));
  const filled3 = record(f3, "FILLED", 5);
  const acct3 = account([filled3], [{ tokenId: UP, shares: 5, costUsd: 7.9 }]);
  on(tight, { kind: "order", order: filled3 }, acct3);
  on(tight, book(START + 60, 0.61, 0.40), acct3);
  assert.equal(submits(on(tight, lead(START + 61, "DOWN", at(0)), acct3)).length, 0, "round budget blocks the leg");
  assert.match(round(tight).reason, /单场预算/);
}

// --- 4. restore: two stages round-trip; malformed second stages are rejected ---
{
  const s = begin(); on(s, book(START + 39, 0.5, 0.52));
  const [first] = submits(on(s, lead(START + 40, "UP", at(1))));
  const filled = record(first, "FILLED", 5);
  const acct = account([filled], [{ tokenId: UP, shares: 5, costUsd: 2.9 }]);
  on(s, { kind: "order", order: filled }, acct);
  on(s, book(START + 80, 0.61, 0.40), acct);
  submits(on(s, lead(START + 81, "DOWN", at(20)), acct));
  const saved = s.exportState();
  const back = createStrategy(CFG, saved);
  assert.equal(back.exportState().rounds[0].stages.length, 2, "two stages restore");
  // The CREATED leg is abandoned on restore (its signal is gone), like stage 1.
  assert.equal(back.exportState().rounds[0].stages[1].status, "ABANDONED");
  const bad = (mutate) => { const x = structuredClone(saved); mutate(x.rounds[0]); return () => createStrategy(CFG, x); };
  assert.throws(bad(r => { r.stages[1].clientOrderId = "binance-lead:0xm:1"; }), /stage/, "second stage with id :1");
  assert.throws(bad(r => { r.stages[1].tokenId = UP; r.stages[1].direction = "UP"; }), /stage/, "second stage on the first stage's side");
  assert.throws(bad(r => { r.stages.push(structuredClone(r.stages[1])); }), /round|stage/, "three stages");
  assert.throws(bad(r => { r.stages[1].stage = 1; }), /stage/, "second stage numbered 1");
  // Presign covers both sides already (every price on each token); nothing new needed.
  assert.ok(presignPrices(normalizeBinanceLeadConfig(CFG), 0.01).some(p => p.price === 0.48 && p.shares === 5));
}

// --- 5. the detector's period reaches reverseToSec (review 2026-11-07: it stopped
// at toSec 265, so a reversal at 265..285 s never reached the strategy) ---
{
  const on285 = normalizeBinanceLeadConfig(CFG);
  assert.equal(leadSignalParams(on285).toSec, 285, "leg on: detector runs to reverseToSec");
  assert.equal(leadSignalParams(normalizeBinanceLeadConfig({ ...CFG, reverseMaxAsk: 0 })).toSec, 265, "leg off: toSec as before");
  const d = new LeadSignalDetector(leadSignalParams(on285));
  for (let t = R + 200; t <= R + 270; t += 1) push(d, t, 100_000);
  assert.equal(push(d, R + 270.1, 100_030)?.direction, "UP", "a signal at 270 s is emitted");
  // Stage 1 is still held to [fromSec, toSec) by the strategy.
  const s = begin(); on(s, book(START + 269, 0.5, 0.52));
  assert.equal(submits(on(s, lead(START + 270, "UP", at(1)))).length, 0, "first order after toSec: none");
  assert.match(round(s).reason, /不在本场 \[30, 265\) 秒内/);
  // The leg itself at 270 s, after a first order at 40 s.
  const t = begin(); on(t, book(START + 39, 0.5, 0.52));
  const [first] = submits(on(t, lead(START + 40, "UP", at(1))));
  const filled = record(first, "FILLED", 5);
  const acct = account([filled], [{ tokenId: UP, shares: 5, costUsd: 2.9 }]);
  on(t, { kind: "order", order: filled }, acct);
  on(t, book(START + 269, 0.61, 0.40), acct);
  assert.equal(submits(on(t, lead(START + 270, "DOWN", at(0)), acct)).length, 1, "reverse leg at 270 s");
}
console.log("reverse-leg OK");

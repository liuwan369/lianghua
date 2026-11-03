// Size by the fair-value edge (user 2026-11-03; backtest E:/pm-backup/research-1103/fv_trade.py
// "band tier 5/10/20"). The detector puts the model's P(UP) on a signal as fairUp;
// the strategy buys highShares at edge >= highEdge, midShares at edge >= midEdge,
// else `shares`; edge = P(side) - ask - 0.07 ask (1 - ask).
// 1) leadFairUp on the detector's per-second history equals a naive reference
//    (the backtest's formula, min matrix summed in full); no history -> no fairUp;
//    a feed gap over 60 s restarts the history.
// 2) tiers: 5/10/20 at the boundaries, off by default, no fairUp -> base size.
// 3) presign covers every tier size; a restored 20-share stage is valid, a size
//    no tier gives is not.
// Run after `npm run build`:  node scripts/regress/fair-size.mjs
import assert from "node:assert/strict";
import { LeadSignalDetector, leadFairUp } from "../../dist/live/feeds/binance-trades.js";
import { createStrategy, leadFairEdge, leadTierShares, normalizeBinanceLeadConfig, presignPrices } from "../../dist/strategies/binance-lead.js";

const R = 1_800_000_000;                                 // a round open (multiple of 300)
const PARAMS = { windowMs: 250, thresholdBp: 2, fromSec: 15, toSec: 265 };

// --- naive reference: the backtest's p_up on a per-second grid ---
function reference(grid, T, S) {
  const r = Math.floor(T / 300) * 300, gv = Math.floor(T);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const O = mean(Array.from({ length: 60 }, (_, i) => grid(r - 59 + i)));
  const lr = Array.from({ length: 300 }, (_, i) => Math.log(grid(gv - 299 + i) / grid(gv - 300 + i)));
  const m = mean(lr), sigma = Math.sqrt(mean(lr.map(x => (x - m) ** 2)));
  const e = Math.max(0, Math.min(60, gv - (r + 240))), n = 60 - e;
  const A = e > 0 ? mean(Array.from({ length: e }, (_, i) => grid(r + 241 + i))) : 0;
  const EF = (e * A + n * S) / 60;
  const k = Math.floor(T - r), start = Math.max(241, k + 1);
  const t = Array.from({ length: 301 - start }, (_, i) => start + i - k).slice(-n);
  let total = 0;
  for (const a of t) for (const b of t) total += Math.min(a, b);
  const sd = (n / 60) * S * sigma * Math.sqrt(total) / n;
  // Phi by a slow, independent series (erf Taylor / continued enough terms).
  const x = 0.859 * (EF - O) / sd;
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function erf(x) {
  // Abramowitz-Stegun 7.1.26 is too coarse; integrate exp(-u^2) by Simpson.
  const N = 20_000, h = x / N;
  let s = 1 + Math.exp(-x * x);
  for (let i = 1; i < N; i++) s += (i % 2 ? 4 : 2) * Math.exp(-((i * h) ** 2));
  return (2 / Math.sqrt(Math.PI)) * s * h / 3;
}

// A price path: a slow wobble plus a step, trades every 0.37 s (several per second,
// some seconds with none), all trade times whole ms.
const path = s => 100_000 * Math.exp(3e-4 * Math.sin(s / 17) + 2e-4 * Math.sin(s / 3.1) + (s > R + 100 ? 1.5e-4 : 0));
let id = 0;
function run(detector, from, to, step = 0.37) {
  const trades = [];
  for (let s = from; s < to; s += step) {
    const ms = Math.round(s * 1000), p = Math.round(path(ms / 1000) * 10) / 10;
    trades.push([ms, p]);
    detector.push({ id: ++id, price: p, tradeTimeMs: ms, receivedAtUnix: ms / 1000 + 0.095, receivedAtMonoMs: 0 }, ms / 1000 + 0.095);
  }
  return trades;
}
const gridOf = trades => g => {                          // last trade at or before second g
  let p; for (const [ms, q] of trades) { if (ms <= g * 1000) p = q; else break; }
  return p;
};

// --- 1. the model on the detector's history ---
{
  const d = new LeadSignalDetector(PARAMS);
  const trades = run(d, R - 420, R + 250);
  const grid = gridOf(trades);
  // The detector's own history through a signal: force one with a +3 bp jump.
  for (const offset of [20, 130, 247.3]) {
    const before = trades.filter(([ms]) => ms <= (R + offset) * 1000);
    const d2 = new LeadSignalDetector(PARAMS);
    for (const [ms, p] of before) d2.push({ id: ++id, price: p, tradeTimeMs: ms, receivedAtUnix: ms / 1000 + 0.095, receivedAtMonoMs: 0 }, ms / 1000 + 0.095);
    const last = before.at(-1)[1], ms = Math.round((R + offset + 0.05) * 1000), jump = Math.round(last * 1.0003 * 10) / 10;
    const s = d2.push({ id: ++id, price: jump, tradeTimeMs: ms, receivedAtUnix: ms / 1000 + 0.095, receivedAtMonoMs: 0 }, ms / 1000 + 0.095);
    assert.equal(s?.direction, "UP", `a +3 bp trade at +${offset} s signals`);
    const g2 = gridOf([...before, [ms, jump]]);
    const want = reference(g2, ms / 1000, jump);
    assert.ok(Math.abs(s.fairUp - want) < 1e-6, `fairUp at +${offset} s: ${s.fairUp} vs reference ${want}`);
    assert.ok(Math.abs(leadFairUp(g2, ms, jump) - want) < 1e-6, "leadFairUp on a grid gives the same");
  }
  assert.ok(grid(R) > 0);
}
{
  // Under ~6 minutes of history: no fairUp (the vol window reaches floor(T) - 300).
  const d = new LeadSignalDetector(PARAMS);
  const trades = run(d, R - 200, R + 20);
  const ms = trades.at(-1)[0] + 10, p = Math.round(trades.at(-1)[1] * 1.0003 * 10) / 10;   // inside the 250 ms window
  const s = d.push({ id: ++id, price: p, tradeTimeMs: ms, receivedAtUnix: ms / 1000 + 0.095, receivedAtMonoMs: 0 }, ms / 1000 + 0.095);
  assert.equal(s?.direction, "UP");
  assert.equal(s.fairUp, undefined, "220 s of history is not enough");
}
{
  // A 70 s silence (feed down) restarts the history: no fairUp right after it.
  const d = new LeadSignalDetector(PARAMS);
  run(d, R - 420, R - 100);
  const trades = run(d, R - 30, R + 20);
  const ms = trades.at(-1)[0] + 10, p = Math.round(trades.at(-1)[1] * 1.0003 * 10) / 10;   // inside the 250 ms window
  const s = d.push({ id: ++id, price: p, tradeTimeMs: ms, receivedAtUnix: ms / 1000 + 0.095, receivedAtMonoMs: 0 }, ms / 1000 + 0.095);
  assert.equal(s?.direction, "UP");
  assert.equal(s.fairUp, undefined, "a gap over 60 s: the old seconds are not used");
}
{
  // A 25 s quiet market (real Bybit gaps reach 29 s) keeps the history.
  const d = new LeadSignalDetector(PARAMS);
  run(d, R - 420, R - 60);
  const trades = run(d, R - 35, R + 20);
  const ms = trades.at(-1)[0] + 10, p = Math.round(trades.at(-1)[1] * 1.0003 * 10) / 10;   // inside the 250 ms window
  const s = d.push({ id: ++id, price: p, tradeTimeMs: ms, receivedAtUnix: ms / 1000 + 0.095, receivedAtMonoMs: 0 }, ms / 1000 + 0.095);
  assert.ok(s?.fairUp > 0 && s.fairUp < 1, "a 25 s gap is a quiet market, the history holds");
}
{
  // A stuck feed repeating one price for 7 minutes: sigma 0, no estimate (review
  // 11-03: a certain 1/0 would buy the top tier); the order keeps the base size.
  const d = new LeadSignalDetector(PARAMS);
  for (let ms = (R - 420) * 1000; ms < (R + 20) * 1000; ms += 370) {
    d.push({ id: ++id, price: 100_000, tradeTimeMs: ms, receivedAtUnix: ms / 1000 + 0.095, receivedAtMonoMs: 0 }, ms / 1000 + 0.095);
  }
  const ms = (R + 20) * 1000 + 123;
  const s = d.push({ id: ++id, price: 100_030, tradeTimeMs: ms, receivedAtUnix: ms / 1000 + 0.095, receivedAtMonoMs: 0 }, ms / 1000 + 0.095);
  assert.equal(s?.direction, "UP");
  assert.equal(s.fairUp, undefined, "sigma 0: no fairUp");
}

// --- 2. tiers ---
const TIERS = { shares: 5, midEdge: 0.08, midShares: 10, highEdge: 0.13, highShares: 20 };
assert.ok(Math.abs(leadFairEdge(0.7, "UP", 0.5) - (0.7 - 0.5 - 0.07 * 0.25)) < 1e-12);
assert.ok(Math.abs(leadFairEdge(0.3, "DOWN", 0.5) - (0.7 - 0.5 - 0.07 * 0.25)) < 1e-12, "DOWN uses 1 - fairUp");
assert.equal(leadFairEdge(undefined, "UP", 0.5), undefined);
assert.equal(leadFairEdge(Number.NaN, "UP", 0.5), undefined);
assert.equal(leadTierShares(TIERS, 0.0799), 5);
assert.equal(leadTierShares(TIERS, 0.08), 10, "midEdge inclusive (backtest: e < 0.08 -> 5)");
assert.equal(leadTierShares(TIERS, 0.1299), 10);
assert.equal(leadTierShares(TIERS, 0.13), 20, "highEdge inclusive");
assert.equal(leadTierShares(TIERS, undefined), 5, "no fairUp: base size");
assert.equal(leadTierShares({ ...TIERS, highShares: 0 }, 0.5), 10, "high tier off");
const defaults = normalizeBinanceLeadConfig({});
assert.equal(leadTierShares(defaults, 0.5), 5, "tiers are off by default");
assert.throws(() => normalizeBinanceLeadConfig({ ...TIERS, highEdge: 0.05 }), /highEdge/);
assert.throws(() => normalizeBinanceLeadConfig({ midShares: -1 }), /midShares/);
assert.throws(() => normalizeBinanceLeadConfig({ midEdge: 2 }), /midEdge/);

// The strategy sizes the order by the signal's edge.
const START = R, UP = "11".repeat(38), DOWN = "22".repeat(38), ROUND = String(START);
const market = { id: "0xm", assetId: "btc", roundId: ROUND, name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const account = { cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } };
const ctx = now => ({ mode: "live", now, markets: [market], books: [], account, estimateFee: () => 0.02 });
const book = t => ({ kind: "book", marketId: "0xm", roundId: ROUND,
  snapshot: { assetId: "btc", marketId: "0xm", roundId: ROUND, sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
    YES: { assetId: UP, bid: 0.49, ask: 0.5, sourceAt: t, expiresAt: t + 2 }, NO: { assetId: DOWN, bid: 0.49, ask: 0.52, sourceAt: t, expiresAt: t + 2 } } });
const lead = (S, direction, fairUp) => ({ kind: "lead", assetId: "btc", direction, price: 100_000, refPrice: 100_000, moveBp: 2,
  openPrice: 100_000, ...(fairUp !== undefined ? { fairUp } : {}), tradeId: ++id, tradeTimeMs: (S - 0.095) * 1000, receivedAtUnix: S, receivedAtMonoMs: 0 });
const place = (cfg, event) => {
  const s = createStrategy({ openBandBp: 5, limitPremium: 0.08, ...cfg });
  s.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
  s.onEvent(book(START + 19), ctx(START + 19));
  const orders = s.onEvent(event, ctx(event.receivedAtUnix + 0.002)).filter(a => a.kind === "submit").map(a => a.order);
  return { s, orders };
};
// UP ask 0.50: fee 0.0175; edge = fairUp - 0.5175.
for (const [fairUp, want] of [[0.59, 5], [0.60, 10], [0.6474, 10], [0.6476, 20], [undefined, 5]]) {
  const { s, orders } = place(TIERS, lead(START + 20, "UP", fairUp));
  assert.equal(orders.length, 1);
  assert.equal(orders[0].shares, want, `fairUp ${fairUp}: ${want} shares`);
  assert.equal(orders[0].price, 0.58, "the limit is unchanged");
  const stage = s.exportState().rounds[0].stages[0];
  assert.equal(stage.fairEdge === undefined, fairUp === undefined, "the stage records the edge that sized it");
}
{
  // DOWN ask 0.52: P(DOWN) = 1 - fairUp = 0.70 -> edge 0.70 - 0.52 - 0.07*0.52*0.48 = 0.1625 -> 20.
  const { orders } = place(TIERS, lead(START + 20, "DOWN", 0.30));
  assert.equal(orders[0].shares, 20);
  assert.equal(orders[0].tokenId, DOWN);
}
assert.equal(place({}, lead(START + 20, "UP", 0.99)).orders[0].shares, 5, "tiers off: 5 whatever the edge");
{
  // A round budget too small for 20 shares refuses the order (it is not cut down).
  const { s, orders } = place({ ...TIERS, roundBudgetUsd: 10 }, lead(START + 20, "UP", 0.99));
  assert.equal(orders.length, 0);
  assert.match(s.exportState().rounds[0].reason, /单场预算/);
}

// --- 3. presign and restore ---
{
  const plan = presignPrices({ maxAsk: 0.8, limitPremium: 0.08, makerHoldSec: 0, ...TIERS }, 0.01);
  for (const limit of [0.58, 0.88]) {
    const sizes = plan.filter(p => p.price === limit).map(p => p.shares);
    assert.deepEqual(sizes, [5, 10, 20], `limit ${limit} signs 5, 10 and 20`);
  }
  // At 0.09 the 1 USD minimum gives 12 shares: tiers 5 and 10 merge into 12.
  assert.deepEqual(plan.filter(p => p.price === 0.09).map(p => p.shares), [12, 20]);
  assert.deepEqual(presignPrices({ maxAsk: 0.8, limitPremium: 0.08, makerHoldSec: 0, ...defaults }, 0.01).filter(p => p.price === 0.58).map(p => p.shares),
    [5], "tiers off: one size");
}
{
  const { s } = place(TIERS, lead(START + 20, "UP", 0.99));
  const state = s.exportState();
  assert.equal(state.rounds[0].stages[0].shares, 20);
  assert.doesNotThrow(() => createStrategy({}, state), "a restored 20-share stage is valid");
  const bad = structuredClone(state); bad.rounds[0].stages[0].shares = 7;
  assert.throws(() => createStrategy({}, bad), /invalid persisted/, "a size no tier gives is rejected");
  const off = structuredClone(state); off.rounds[0].config.highShares = 0;
  assert.throws(() => createStrategy({}, off), /invalid persisted/, "20 shares under a config without that tier is rejected");
}
console.log("fair-size OK");

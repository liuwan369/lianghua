// Skip a low-edge signal (user 2026-11-24, research-1123): the round's order
// is not sent when its edge (leadFairValue - limit - taker fee, the same edge
// edgeSizing reads) is below minEdge; the round keeps its attempt for a later
// signal. Live 1105 orders 11-14..11-23: the 229 with edge < -0.02 made -0.067
// a share (t -2.41); with band ±4 too, +26.7 -> +155.8, drawdown -79 -> -28.
// - off by default (null), and any number in [-1, 1] or null is accepted;
// - on: a signal whose edge is below the minimum is skipped, with the reason;
//   a later signal with enough edge trades;
// - an edge at the minimum trades (>=);
// - a signal without a fair value (no 300 s of history, e.g. after a restart)
//   is skipped while minEdge is on (user 2026-11-28); off, it trades.
// Run after `npm run build`:  node scripts/regress/min-edge.mjs
import assert from "node:assert/strict";
import { createStrategy, normalizeBinanceLeadConfig, leadFairValue } from "../../dist/strategies/binance-lead.js";

assert.equal(normalizeBinanceLeadConfig({}).minEdge, null, "off by default");
assert.equal(normalizeBinanceLeadConfig({ minEdge: -0.02 }).minEdge, -0.02);
assert.equal(normalizeBinanceLeadConfig({ minEdge: null }).minEdge, null);
for (const bad of ["-0.02", 2, -1.5, Number.NaN]) assert.throws(() => normalizeBinanceLeadConfig({ minEdge: bad }), /minEdge/, String(bad));

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38);
const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const ctx = now => ({ mode: "live", now, markets: [market], books: [], estimateFee: () => 0.02,
  account: { cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [], risk: { halted: false, availableUsd: 1000, occupiedUsd: 0 } } });
const book = t => ({ kind: "book", marketId: "0xm", roundId: String(START), snapshot: { assetId: "btc", marketId: "0xm", roundId: String(START),
  sourceAt: t, expiresAt: t + 2, tsUnix: t, receivedAtUnix: t, receivedAtMonoMs: 0, marketAgeMs: 50,
  YES: { assetId: UP, bid: 0.4, ask: 0.5, sourceAt: t, expiresAt: t + 2 }, NO: { assetId: DOWN, bid: 0.4, ask: 0.52, sourceAt: t, expiresAt: t + 2 } } });
// An UP signal `aheadBp` above the 60 s pre-open mean: the further ahead, the higher its fair value.
const MEAN = 100000;
const lead = (S, aheadBp, extra = {}) => ({ kind: "lead", assetId: "btc", direction: "UP", price: MEAN * Math.exp(aheadBp / 1e4), refPrice: MEAN,
  moveBp: 3, venue: "bybit", line: "direct", tradeId: S, tradeTimeMs: (S - 0.1) * 1000, receivedAtUnix: S, receivedAtMonoMs: 1,
  openMean60: MEAN, vol300Bp: 1, signals300: 2, ...extra });
// Limit = ask 0.50 + 0.04 = 0.54; edge = fair - 0.54 - 0.07 * 0.54 * 0.46.
const edgeOf = (S, aheadBp) => leadFairValue(lead(S, aheadBp), START + 300 - S) - 0.54 - 0.07 * 0.54 * 0.46;
const run = (config, S, aheadBp, extra) => {
  const st = createStrategy({ limitPremium: 0.04, ...config });
  st.onEvent({ kind: "timer", ts: START - 20 }, ctx(START - 20));
  st.onEvent(book(START + 20), ctx(START + 20));
  return { st, actions: st.onEvent(lead(S, aheadBp, extra), ctx(S + 0.002)) };
};
const submits = actions => actions.filter(a => a.kind === "submit").length;

const behind = -8, ahead = 8;                  // fair well under / over the 0.54 limit
assert.ok(edgeOf(START + 21, behind) < -0.1 && edgeOf(START + 40, ahead) > 0.1, "the fixture spans the minimum");
assert.equal(submits(run({}, START + 21, behind).actions), 1, "off: a low-edge signal still trades");
const on = run({ minEdge: -0.02 }, START + 21, behind);
assert.equal(submits(on.actions), 0, "on: a low-edge signal is skipped");
assert.match(on.st.exportState().rounds[0].reason, /优势 -0\.\d\d 低于 -0\.02/);
assert.equal(on.st.exportState().rounds[0].stages.length, 0, "the round keeps its attempt");
assert.equal(submits(on.st.onEvent(lead(START + 40, ahead), ctx(START + 40.002))), 1, "a later signal with edge trades");
// At the minimum: trades.
const exact = edgeOf(START + 21, ahead);
assert.equal(submits(run({ minEdge: exact }, START + 21, ahead).actions), 1, "edge == minEdge trades");
assert.equal(submits(run({ minEdge: exact + 1e-6 }, START + 21, ahead).actions), 0, "edge just under minEdge is skipped");
// No fair value (no volatility yet, e.g. after a restart): skipped while minEdge is on.
const blind = run({ minEdge: -0.02 }, START + 21, ahead, { vol300Bp: undefined });
assert.equal(submits(blind.actions), 0, "minEdge on, no fair value: skipped");
assert.match(blind.st.exportState().rounds[0].reason, /算不出优势/);
assert.equal(blind.st.exportState().rounds[0].stages.length, 0, "the round keeps its attempt");
assert.equal(submits(run({}, START + 21, ahead, { vol300Bp: undefined }).actions), 1, "minEdge off, no fair value: trades as before");
console.log("min-edge OK");

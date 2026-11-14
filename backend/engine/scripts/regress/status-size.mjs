// platform_status size (2026-11-14): every 2 s the engine journaled a ~50 KB
// status line (918 MB of journal in 17 h, 38 MB of ledger rows). Most of it the
// console never read: 8 recent rounds each with their full config and latest
// quote, every market's fee metadata, ten-level books twice (paired snapshot,
// legacy per-token books) for the current and the next market, plus limits and
// cash_flow_coverage.
//
// statusRuntime() keeps what the console reads (scripts/dashboard/ledger.py
// _runtime_projection, system-dashboard-server.py runtime_book/_modern_runtime,
// Ledger.position, settlement coverage) and nothing else. Built here with the
// real strategy: a running round that placed its FAK, two ended rounds still
// holding a position (redemption follows within minutes), two resolved rounds; the line must stay under 6 KB.
//
// Run after `npm run build`:  node scripts/regress/status-size.mjs
import assert from "node:assert/strict";
import { statusRuntime, STATUS_BOOK_LEVELS } from "../../dist/cli/platform.js";
import { createStrategy } from "../../dist/strategies/binance-lead.js";

const START = Math.floor(Date.now() / 1000 / 300) * 300 - 4 * 300;
const tok = (k, side) => `${String(k).padStart(38, "0")}${side}`.repeat(2);
const market = (k) => ({ id: `0x${String(k).padStart(64, "0")}`, assetId: "btc", roundId: String(START + k * 300),
  name: `btc-updown-5m-${START + k * 300}`, startsAt: START + k * 300, endsAt: START + (k + 1) * 300,
  instruments: [
    { tokenId: tok(k, 1), marketId: `0x${String(k).padStart(64, "0")}`, outcome: "Up", tickSize: 0.01, minOrderSize: 5,
      feeRate: 0.07, feeExponent: 1, takerDelayMs: 0 },
    { tokenId: tok(k, 2), marketId: `0x${String(k).padStart(64, "0")}`, outcome: "Down", tickSize: 0.01, minOrderSize: 5,
      feeRate: 0.07, feeExponent: 1, takerDelayMs: 0 }] });
const markets = [0, 1, 2, 3, 4, 5].map(market);   // 4 is running, 5 is next
const levels = (n) => Array.from({ length: n }, (_, i) => [Number((0.5 + i / 100).toFixed(2)), 100 + i]);
const sideOf = (token, t) => ({ assetId: token, bid: 0.55, ask: 0.57, bidSize: 20, askSize: 30, bids: levels(10),
  asks: levels(10), depthSourceAt: t, depthExpiresAt: t + 2, sourceAt: t, expiresAt: t + 2, sequence: 7 });
const snapshotOf = (k, t) => ({ assetId: "btc", marketId: markets[k].id, roundId: markets[k].roundId, sequence: 99,
  sourceAt: t, expiresAt: t + 2, YES: sideOf(tok(k, 1), t), NO: sideOf(tok(k, 2), t), tsUnix: t, receivedAtUnix: t,
  receivedAtMonoMs: 1, processedAtMonoMs: 2, marketAgeMs: 40, source: "polymarket-ws",
  upBidLevels: levels(10), upAskLevels: levels(10), downBidLevels: levels(10), downAskLevels: levels(10) });

let orders = [];
const positions = [];
const ctx = (now) => ({ mode: "live", now, markets, books: [], estimateFee: () => 0.05,
  account: { cashUsd: 100, positions, orders, quarantinedOrderIds: [], risk: { halted: false, availableUsd: 100, occupiedUsd: 0 } } });
const book = (k, t) => ({ kind: "book", marketId: markets[k].id, roundId: markets[k].roundId,
  snapshot: { ...snapshotOf(k, t), YES: { ...sideOf(tok(k, 1), t) }, NO: { ...sideOf(tok(k, 2), t), ask: 0.45 } } });
const lead = (t, tradeId) => ({ kind: "lead", assetId: "btc", venue: "bybit", line: "tokyo", relayRecvMs: t * 1000 - 60,
  direction: "UP", price: 100030, refPrice: 100000, moveBp: 3, openPrice: 99990, openMean60: 99991, tradeId,
  tradeTimeMs: t * 1000 - 100, receivedAtUnix: t, receivedAtMonoMs: 5 });
const strategy = createStrategy({ shares: 5, openBandBp: 5, openLine: "mean60", roundBudgetUsd: 10, totalBudgetUsd: 100,
  dailyLossUsd: 20 });
for (let k = 0; k <= 4; k += 1) {
  const t0 = START + k * 300;
  strategy.onEvent({ kind: "timer", ts: t0 - 20 }, ctx(t0 - 20));
  strategy.onEvent(book(k, t0 + 20), ctx(t0 + 20));
  const actions = strategy.onEvent(lead(t0 + 21, 40 + k), ctx(t0 + 21));
  const intent = actions.find((action) => action.kind === "place")?.order ?? actions[0]?.order;
  assert.ok(intent, `round ${k} places its FAK`);
  const order = { ...intent, strategyId: "binance-lead", orderId: `0xo${k}`, status: "FILLED", filledShares: 5,
    createdAt: t0 + 21, updatedAt: t0 + 21.3, reservedUsd: 0, reservedShares: 0 };
  orders = [...orders, order];
  strategy.onEvent({ kind: "order", order }, ctx(t0 + 22));
  // Rounds 2-4 hold their shares (2-3 not yet redeemed); rounds 0-1 are done.
  if (k >= 2) positions.push({ tokenId: order.tokenId, shares: 5, costUsd: 2.9, realizedPnlUsd: 0, markPrice: 0.5 });
}
const now = START + 4 * 300 + 40;
strategy.onEvent(book(4, now), ctx(now));
const state = { cashUsd: 90, positions, orders, fills: [], quarantinedOrderIds: [],
  risk: { halted: false, day: "2026-11-14", baselineAt: START, baselineEquityUsd: 100, equityUsd: 101, dailyPnlUsd: 1,
    occupiedUsd: 8.7, availableUsd: 91, cashFlowComplete: true, pnlVerified: true, dailyLossStatus: "active",
    unresolvedOrderCount: 0, reconciliationRequired: false } };
const work = new Set([2, 3].map((k) => markets[k].id));
const counters = (n) => ({ frames: n * 3, trades: n * 2, delivered: n, lastAt: now * 1000, leadSumMs: n * 12, leadCount: n,
  leadMeanMs: 12 });
const leadLines = { venues: Object.fromEntries(["bybit", "binance", "okx"].map((v) => [v, { direct: counters(12345),
  tokyo: counters(34567) }])), relay: { listening: true, port: 47001, error: null, messages: 99999, accepted: 99990,
  badSource: 0, badFormat: 0, badMac: 9, tcpClients: 1 } };
const build = (needsWork) => statusRuntime({ status: "running", mode: "live", startedAt: START, strategyId: "binance-lead", state,
  strategyStatus: strategy.getStatus(), markets, snapshots: markets.map((m, k) => snapshotOf(k, now)), now,
  needsWork, leadFeedHealthy: true, leadVenues: ["bybit", "binance", "okx"], leadRelay: true,
  leadLines });
const runtime = build((id) => work.has(id));
const line = JSON.stringify({ runtime, event: "platform_status", recv_ts: now, seq: 123456 });
const size = Buffer.byteLength(line);

// --- what the console reads is there ---
const sr = runtime.strategy_runtime;
assert.equal(sr.strategyId, "binance-lead");
assert.equal(sr.paused, false);
assert.equal(sr.currentRound.marketId, markets[4].id, "the running round is currentRound");
assert.equal(sr.currentRound.config.shares, 5, "currentRound keeps its config (实盘 strategy note, position config)");
assert.equal(sr.currentRound.latest.twoSided, true, "and its latest quote (book strategyView)");
assert.equal(sr.currentRound.stages[0].signal.tradeId, 44, "and its order with the signal");
assert.equal(sr.currentRound.upShares, 5, "roundOutcome enriches it");
assert.deepEqual(sr.rounds.map((r) => r.marketId), [2, 3].map((k) => markets[k].id),
  "other rounds: exactly those still needing work (settlement coverage, position by roundId)");
for (const round of sr.rounds) {
  assert.deepEqual(Object.keys(round).sort(), ["assetId", "attempted", "downShares", "downTokenId", "endsAt", "marketId",
    "name", "roundId", "startsAt", "status", "upShares", "upTokenId"],
    "a settling round: identity and coverage only (no config, latest, stages)");
  assert.equal(round.upShares, 5, "coverage: the shares still held");
}
assert.ok(!("config" in sr), "strategy_runtime.config was unread; gone");
assert.deepEqual(runtime.markets.map((m) => m.id), [markets[4].id],
  "markets: the current one; a settling one is named by its round already, the next one is not open yet");
assert.deepEqual(Object.keys(runtime.markets[0].instruments[0]).sort(),
  ["outcome", "tokenId"], "runtime_book maps Up/Down to tokens; nothing else reads instruments");
assert.deepEqual(runtime.snapshots.map((s) => s.marketId), [markets[4].id], "only the current market's book");
const snap = runtime.snapshots[0];
assert.equal(snap.YES.bids.length, STATUS_BOOK_LEVELS);
assert.equal(snap.NO.asks.length, STATUS_BOOK_LEVELS);
for (const key of ["sequence", "sourceAt", "expiresAt"]) assert.ok(key in snap, key);
for (const key of ["depthSourceAt", "sourceAt", "expiresAt", "bid", "ask", "bidSize", "askSize"]) assert.ok(key in snap.YES, key);
assert.ok(!("upBidLevels" in snap) && !("tsUnix" in snap), "legacy flat book fields are gone");
assert.ok(!("books" in runtime) && !("limits" in runtime) && !("cash_flow_coverage" in runtime), "unread keys are gone");
assert.equal(runtime.positions.length, 3);
assert.equal(runtime.positions_count, 3, "positions_count matches (ledger positions_complete)");
assert.deepEqual(Object.keys(runtime.positions[0]).sort(), ["costUsd", "shares", "tokenId"]);
assert.equal(runtime.risk.availableUsd, 91);
assert.equal(runtime.lead_lines.venues.bybit.tokyo.delivered, 34567);
// --- size ---
assert.ok(size < 6 * 1024, `status line must stay under 6 KB; got ${size} bytes`);
// A run that cannot redeem (RPC down) keeps every round in the line until it
// can: each costs its identity and coverage only.
const stuck = Buffer.byteLength(JSON.stringify(build((id) => id !== markets[4].id && id !== markets[5].id)));
const perRound = (stuck - size) / 2;
assert.ok(perRound < 600, `a settling round adds < 600 bytes; got ${perRound}`);
console.log(`status-size: ${size} bytes (${sr.rounds.length} settling rounds, ${runtime.markets.length} markets)`);
console.log("status-size OK");

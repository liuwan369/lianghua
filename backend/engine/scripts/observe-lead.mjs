// Observe-only run of the binance-lead rule against live public feeds: no
// account, no keys, no orders. The real compiled LeadSignalDetector, Binance
// aggTrade lines, Polymarket book feed, snapshot gate and BinanceLeadStrategy
// decide exactly as live; a submit action is written down instead of sent.
// Purpose: confirm on the server that signals arrive in time and the strategy
// decides what the backtest would (E:/pm-backup/forward-binance-agg.py).
//
// Run after `npm run build` (server: under the collector's node_modules):
//   node scripts/observe-lead.mjs --minutes 60 --out observe-lead.jsonl
// Each line: {kind:"signal"|"decision"|"round"|"health", ...}.
import { appendFileSync, writeFileSync } from "node:fs";
import { binanceLeadFeed, LeadSignalDetector } from "../dist/live/feeds/binance-trades.js";
import { runPolymarketFeed } from "../dist/live/feeds/polymarket.js";
import { validateMarketSnapshot } from "../dist/platform/snapshot-gate.js";
import { discoverMarket } from "../dist/platform/polymarket.js";
import { createStrategy, BINANCE_LEAD_DEFAULTS } from "../dist/strategies/binance-lead.js";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const minutes = Number(arg("minutes", "60"));
const out = arg("out", "observe-lead.jsonl");
writeFileSync(out, "");
const log = (row) => appendFileSync(out, JSON.stringify({ at: Date.now() / 1000, ...row }) + "\n");

const config = { ...BINANCE_LEAD_DEFAULTS };
const strategy = createStrategy(config);
const markets = new Map();          // id -> MarketInfo
const feeds = new Map();            // id -> feed control
const watermarks = new Map();       // id -> snapshot watermark
const pending = new Set();          // round starts being discovered
const account = { cashUsd: 1000, positions: [], orders: [], quarantinedOrderIds: [],
  risk: { halted: false, availableUsd: 1000, occupiedUsd: 0, blockedMarketIds: [] } };
const context = (now) => ({ mode: "live", now, markets: [...markets.values()].filter(m => m.endsAt > now), books: [], account,
  estimateFee: (o) => o.shares * 0.07 * 0.25 });
const step = (event, now = Date.now() / 1000) => {
  const actions = strategy.onEvent(event, context(now));
  for (const action of actions) if (action.kind === "submit") {
    const round = strategy.roundAt(now);
    log({ kind: "decision", marketId: action.order.marketId, roundId: action.order.roundId, tokenId: action.order.tokenId,
      direction: round?.stages[0]?.direction, limit: action.order.price, askAtSignal: round?.stages[0]?.askAtSignal,
      shares: action.order.shares, tif: action.order.timeInForce, signalTradeId: round?.stages[0]?.signal.tradeId,
      decidedAfterTradeMs: event.kind === "lead" ? Date.now() - event.tradeTimeMs : undefined,
      decidedAfterReceiveMs: event.kind === "lead" ? performance.now() - event.receivedAtMonoMs : undefined });
  }
  return actions;
};

async function addMarket(at) {
  const key = Math.floor(at / 300) * 300;
  if (pending.has(key)) return;
  pending.add(key);
  try {
    const [market] = await discoverMarket("btc", at);
    if (!market || markets.has(market.id) || market.endsAt <= Date.now() / 1000) return;
    markets.set(market.id, market);
    const up = market.instruments.find(i => /up|yes/i.test(i.outcome)), down = market.instruments.find(i => /down|no/i.test(i.outcome));
    const identity = { assetId: market.assetId, marketId: market.id, roundId: market.roundId, endsAt: market.endsAt,
      yesAssetId: up.tokenId, noAssetId: down.tokenId };
    let healthy = false;
    const feed = runPolymarketFeed((event) => {
      if (event.kind === "bookStatus") {
        healthy = event.healthy;
        if (!event.healthy) step({ kind: "error", strategyId: "binance-lead", marketId: market.id, code: "market_feed_unhealthy",
          message: `market_feed_unhealthy:${event.reason ?? "unknown"}` });
        return;
      }
      if (event.kind !== "book") return;
      const snapshot = { ...event.snapshot, assetId: market.assetId };
      const result = validateMarketSnapshot(snapshot, identity, watermarks.get(market.id), Date.now() / 1000,
        healthy && (feed.isHealthy?.() ?? true));
      if (!result.ok) return;
      watermarks.set(market.id, result.watermark);
      step({ kind: "book", snapshot, marketId: market.id, roundId: market.roundId, assetId: market.assetId });
    }, up.tokenId, down.tokenId, market.endsAt, { marketId: market.id, roundId: market.roundId });
    feeds.set(market.id, feed);
    step({ kind: "timer", ts: Date.now() / 1000 });
    log({ kind: "market", marketId: market.id, roundId: market.roundId, startsAt: market.startsAt });
  } catch (error) {
    log({ kind: "health", error: `discovery: ${error?.message ?? error}` });
  } finally { pending.delete(key); }
}

const detector = new LeadSignalDetector({ windowMs: config.windowMs, thresholdBp: config.thresholdBp,
  fromSec: config.fromSec, toSec: config.toSec });
let signals = 0;
const lead = binanceLeadFeed(detector)((event) => {
  if (event.kind !== "lead") return;
  signals += 1;
  const seenMs = Date.now();
  const actions = step({ ...event, assetId: "btc" });
  const round = strategy.roundAt(event.receivedAtUnix);
  log({ kind: "signal", tradeId: event.tradeId, direction: event.direction, moveBp: event.moveBp,
    tradeToReceiveMs: Math.round(event.receivedAtUnix * 1000 - event.tradeTimeMs),
    roundId: round?.roundId ?? null, placed: actions.some(a => a.kind === "submit"), reason: round?.reason ?? null,
    latest: round?.latest ?? null, handledInMs: Date.now() - seenMs });
});

const tick = setInterval(() => {
  const now = Date.now() / 1000;
  step({ kind: "timer", ts: now });
  // Discover the next round before it opens (only rounds found before the open trade), and the current one.
  void addMarket(now);
  if (Math.floor(now) % 300 >= 230) void addMarket(now + 300);
  for (const [id, market] of markets) if (market.endsAt + 5 < now) {
    feeds.get(id)?.stop(); feeds.delete(id); watermarks.delete(id);
    const round = strategy.exportState().rounds.find(r => r.marketId === id);
    log({ kind: "round", marketId: id, roundId: market.roundId, status: round?.status, attempted: !!round?.stages.length,
      reason: round?.reason, stage: round?.stages[0] ?? null });
    markets.delete(id);
    strategy.forgetRounds(new Set([id]));
  }
}, 1000);
const health = setInterval(() => log({ kind: "health", binanceHealthy: lead.isHealthy(), signals,
  markets: [...markets.keys()].length }), 30_000);

await new Promise(resolve => setTimeout(resolve, minutes * 60_000));
clearInterval(tick); clearInterval(health);
lead.stop();
for (const feed of feeds.values()) feed.stop();
log({ kind: "health", done: true, signals });
process.exit(0);

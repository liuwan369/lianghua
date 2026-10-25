// Settled rounds leave the live engine's memory while it runs, not only at the
// next start (2026-10-25 latency work). Every strategy save copies the whole
// account state; with every round of the run kept it was 877 KB after 300
// rounds and a lead signal took 77 ms to reach the POST instead of 12 ms.
//
// TradingCore.forgetMarkets drops markets, their orders, fills, positions'
// zero rows and indexes; TradingPlatform.forgetMarkets also its books and
// snapshots; BinanceLeadStrategy.forgetRounds its rounds. The CLI calls them
// with pruneSettledHistory's verdict, the same rule as at start-up.
//
// Run after `npm run build`:  node scripts/regress/runtime-prune.mjs
import assert from "node:assert/strict";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { createStrategy } from "../../dist/strategies/binance-lead.js";
import { pruneSettledHistory } from "../../dist/cli/platform.js";

const BASE = 1_800_000_000;
const token = (k, side) => `${side}`.repeat(70) + String(k).padStart(6, "0");
const market = (k) => {
  const start = BASE + 300 * k, id = `0x${String(k).padStart(64, "0")}`;
  return { id, assetId: "btc", roundId: String(start), name: `btc-updown-5m-${start}`, startsAt: start, endsAt: start + 300,
    instruments: [{ tokenId: token(k, 1), marketId: id, outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                  { tokenId: token(k, 2), marketId: id, outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
};
let now = BASE - 60, hashes = 0;
const gateway = { mode: "live", durableIdentity: false,
  async submit() { return { status: "accepted", orderId: `0xo${++hashes}`, venueStatus: "unmatched" }; },
  async cancel() { return true; } };
const platform = new TradingPlatform({ account: { accountId: "t", at: now, cashAt: now, cashUsd: 1000, positions: [],
  openOrders: [], complete: true }, instruments: [], limits: { capitalUsd: 1000, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null },
  now: () => now, adapters: { gateway, estimateFee: () => 0.02 } });
const strategy = createStrategy({}, undefined, { persist: s => platform.core.setStrategyState("binance-lead", s) });
platform.attach(strategy);
const book = (m) => {
  const side = (tokenId, ask) => ({ assetId: tokenId, bid: ask - 0.01, ask, bidSize: 10, askSize: 10, sourceAt: now, expiresAt: now + 2 });
  platform.ingest({ kind: "book", marketId: m.id, roundId: m.roundId, snapshot: { assetId: "btc", marketId: m.id, roundId: m.roundId,
    sourceAt: now, expiresAt: now + 2, tsUnix: now, receivedAtUnix: now, marketAgeMs: 10,
    YES: side(m.instruments[0].tokenId, 0.57), NO: side(m.instruments[1].tokenId, 0.45) } });
};
const lead = (S) => ({ kind: "lead", assetId: "btc", direction: "UP", price: 100030, refPrice: 100000, moveBp: 3, tradeId: S,
  tradeTimeMs: S * 1000 - 125, receivedAtUnix: S, receivedAtMonoMs: performance.now() });

// Rounds 0..3 each place one FAK; round 1 fills 5 shares (a position until redeemed).
for (let k = 0; k < 4; k += 1) {
  const m = market(k);
  now = m.startsAt - 20; platform.ingest({ kind: "market", market: m }); platform.ingest({ kind: "timer", ts: now });
  now = m.startsAt + 20; book(m);
  now = m.startsAt + 21; platform.ingest(lead(now)); await platform.idle();
  const order = platform.core.orders().at(-1);
  if (k === 1) {
    platform.core.applyFill({ tradeId: `t${k}`, orderId: order.orderId, marketId: m.id, roundId: m.roundId, tokenId: order.tokenId,
      direction: "BUY", price: 0.6, shares: 5, feeUsd: 0.04, ts: now + 0.3, status: "CONFIRMED", feeSource: "reported" });
  } else platform.core.confirmCancelled(order.orderId, true, "user_ws", now + 0.3);
  now = m.endsAt + 1; platform.ingest({ kind: "timer", ts: now }); await platform.idle();
}
const live = market(4);
now = live.startsAt - 20; platform.ingest({ kind: "market", market: live }); platform.ingest({ kind: "timer", ts: now });
now = live.startsAt + 20; book(live);

// Round 1 traded and is not settled yet: it must stay. Rounds 0, 2, 3 are done.
now = market(3).endsAt + 3_601;
const before = platform.core.snapshot();
const { state: pruned } = pruneSettledHistory(before, {}, now);
const dead = new Set(before.markets.map(m => m.id).filter(id => !pruned.markets.some(m => m.id === id)));
assert.deepEqual([...dead].sort(), [market(0).id, market(2).id, market(3).id].sort(), "the traded, unsettled round stays");
platform.forgetMarkets(dead);
strategy.forgetRounds(dead);
const after = platform.core.snapshot();
assert.deepEqual(after.markets.map(m => m.id).sort(), [market(1).id, live.id].sort());
assert.equal(after.orders.length, 1, "only round 1's order is kept");
assert.equal(after.orders[0].tokenId, market(1).instruments[0].tokenId);
assert.equal(after.fills.length, 1, "round 1's fill is kept");
assert.deepEqual(after.positions.map(p => [p.tokenId, p.shares]), [[market(1).instruments[0].tokenId, 5]], "the position to redeem is kept");
assert.deepEqual(strategy.exportState().rounds.map(r => r.marketId).sort(), [market(1).id, live.id].sort());
assert.deepEqual(after.strategyStates["binance-lead"].rounds.map(r => r.marketId).sort(), [market(1).id, live.id].sort(),
  "the saved strategy state follows");
assert.deepEqual(platform.market.list().map(m => m.id).sort(), [market(1).id, live.id].sort());
assert.equal(platform.market.books().filter(b => dead.has(b.marketId ?? "")
  || [0, 2, 3].some(k => market(k).instruments.some(i => i.tokenId === b.tokenId))).length, 0, "their books are gone");
assert.ok(JSON.stringify(after).length < JSON.stringify(before).length / 2, "the state shrank");

// The engine keeps working: the live round still trades, round 1 still settles.
now = live.startsAt + 21; platform.ingest(lead(now)); await platform.idle();
assert.equal(platform.core.orders().filter(o => o.tokenId === live.instruments[0].tokenId).length, 1, "the live round traded");
// A live market, an unknown one, or one still holding a position is refused, never half-removed.
assert.throws(() => platform.forgetMarkets(new Set([live.id])), /known and ended/);
assert.throws(() => platform.forgetMarkets(new Set(["0xnope"])), /known and ended/);
assert.throws(() => platform.forgetMarkets(new Set([market(1).id])), /position/);
assert.equal(platform.core.snapshot().markets.length, 2, "a refused call changed nothing");
console.log("runtime-prune OK");

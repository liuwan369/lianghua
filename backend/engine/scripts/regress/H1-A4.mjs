// BUGS H1 (second audit): after a restart, a position with no live quote was
// valued at cost (the last bid lived only in memory), so the daily-loss stop
// did not see an open loss until the venue resolved the round, 13-18 min later.
// BUGS A4: a resolved winner was marked at the book bid (0.98), not its payout.
// Fix: positions carry the venue's own mark (Data API curPrice) and whether the
// market has resolved; the core uses it when it has no quote, and always once
// the market has resolved.
//
// Run after `npm run build`:  node scripts/regress/H1-A4.mjs
import assert from "node:assert/strict";
import { TradingCore } from "../../dist/platform/core.js";

const UP = "111";
const instruments = [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 }];
const limits = { capitalUsd: 200, dailyLossUsd: 10, maxOrderUsd: 50, maxOpenOrders: 2 };
const adapters = { gateway: { mode: "live" } };
const now = 1_790_900_000;
const account = (positions, at) => ({ accountId: "0xa", at, cashAt: at, cashUsd: 30, positions, openOrders: [], complete: true });

// Run 1: 100 shares cost 70, the bid falls to 0.62 -> an open loss of 8.
const first = new TradingCore({ account: account([{ tokenId: UP, shares: 100, costUsd: 70, realizedPnlUsd: 0 }], now),
  instruments, limits, adapters, now: () => now });
first.mark({ tokenId: UP, ts: now + 1, bid: 0.62, ask: 0.63 });
assert.equal(Math.round(first.risk().dailyPnlUsd), -8, "control: the loss is seen while the bid is known");
const saved = first.snapshot();

// --- H1: restart; the round has ended, so no book comes. The venue still reports
// curPrice 0.62 for the position, read at startup. ---
const restarted = new TradingCore({ restored: saved, instruments, limits, adapters, now: () => now + 60,
  account: account([{ tokenId: UP, shares: 100, costUsd: 70, realizedPnlUsd: 0, markPrice: 0.62 }], now + 60) });
restarted.reconcile(account([{ tokenId: UP, shares: 100, costUsd: 70, realizedPnlUsd: 0, markPrice: 0.62 }], now + 60));
assert.equal(Math.round(restarted.risk().dailyPnlUsd), -8, "H1: after a restart the open loss is still counted");

// --- A4: the market resolved for this side; the stale 0.98 bid must not cap it ---
const winner = new TradingCore({ account: account([{ tokenId: UP, shares: 5, costUsd: 3.35, realizedPnlUsd: 0 }], now),
  instruments, limits, adapters, now: () => now });
winner.mark({ tokenId: UP, ts: now + 1, bid: 0.98, ask: 0.99 });
winner.reconcile(account([{ tokenId: UP, shares: 5, costUsd: 3.35, realizedPnlUsd: 0, markPrice: 1, resolved: true }], now + 2));
assert.equal(winner.risk().dailyPnlUsd.toFixed(2), "1.65", "A4: a resolved winner is worth its payout (5 x 1 - 3.35)");

// --- control: a live quote still wins over a venue mark for an unresolved market ---
const live = new TradingCore({ account: account([{ tokenId: UP, shares: 100, costUsd: 70, realizedPnlUsd: 0, markPrice: 0.5 }], now),
  instruments, limits, adapters, now: () => now });
live.mark({ tokenId: UP, ts: now + 1, bid: 0.71, ask: 0.72 });
assert.equal(Math.round(live.risk().dailyPnlUsd), 1, "an unresolved market is marked at its live bid");
console.log("H1-A4 OK");

// A BUY signs a USD budget (shares x limit). A resting BUY (GTC) filled below
// its limit gets its shares with budget left on the book; one filled to under
// one share step (0.01) of budget has nothing left that can trade.
// - a GTC bought 5.6 shares at 0.55 of a 5 x 0.63 budget is still PARTIAL: 0.07
//   of budget rests, its reservation is that, not 0;
// - a fill spending the budget to under 0.01 share makes it FILLED (2026-11-14
//   19:05: 4.99753 of 5 at 0.23, the venue said matched and refused the cancel;
//   it stayed UNKNOWN with 0.0006 reserved);
// - closeSpent() ends such a stuck UNKNOWN order (matched, budget spent, fills
//   settled) without the order detail; a pending fill or budget left keeps it;
// - a FAK still ends on its shares (unchanged);
// - replaysPreparedOrder never replays binance-lead's GTC (a gone signal).
// Real TradingPlatform/Core/Store, only the gateway faked.
// Run after `npm run build`:  node scripts/regress/gtc-budget.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingPlatform } from "../../dist/platform/platform.js";
import { PlatformStore } from "../../dist/platform/store.js";
import { replaysPreparedOrder } from "../../dist/platform/polymarket.js";

const START = 1_800_000_000, UP = "11".repeat(38), DOWN = "22".repeat(38);
const market = { id: "0xm", assetId: "btc", roundId: String(START), name: `btc-updown-5m-${START}`, startsAt: START, endsAt: START + 300,
  instruments: [{ tokenId: UP, marketId: "0xm", outcome: "Up", tickSize: 0.01, minOrderSize: 5 },
                { tokenId: DOWN, marketId: "0xm", outcome: "Down", tickSize: 0.01, minOrderSize: 5 }] };
const limits = { capitalUsd: 100, maxOrderUsd: 50, maxOpenOrders: 10, dailyLossUsd: null };
const settle = () => new Promise(r => setTimeout(r, 30));
let hashes = 0;

async function placed({ price, shares, timeInForce = "GTC", cancel = async () => true, venueStatus = "live" }) {
  const dir = mkdtempSync(join(tmpdir(), "gtc-budget-")); const store = new PlatformStore(join(dir, "state.json"));
  const hash = "0x" + (++hashes).toString(16).padStart(64, "0");
  const now = START + 120;
  const gateway = { mode: "live", durableIdentity: true,
    async submit(request, instrument, prepared) {
      prepared({ orderHash: hash, signedPayload: { sig: "s" }, preparedAt: now });
      return { status: "accepted", orderId: hash, venueStatus };
    }, cancel };
  const platform = new TradingPlatform({ account: { accountId: "t", at: START, cashAt: START, cashUsd: 100, positions: [], openOrders: [], complete: true },
    instruments: market.instruments, limits, restored: store.load(), now: () => now,
    adapters: { gateway, estimateFee: () => 0, persist: (s, c) => store.save(s, c), deferPersistence: () => store.defer(),
      persistPreparedOrder: o => store.savePreparedOrder(o) } });
  platform.ingest({ kind: "market", market });
  await platform.core.submit({ clientOrderId: `binance-lead:0xm:${hashes}`, strategyId: "binance-lead", tokenId: UP, direction: "BUY",
    price, shares, timeInForce, postOnly: false });
  await settle();
  const fill = (tradeId, fillPrice, fillShares, extra = {}) => platform.core.applyFill({ tradeId, orderId: hash, tokenId: UP, direction: "BUY",
    price: fillPrice, shares: fillShares, feeUsd: 0, ts: now, status: "CONFIRMED", isMaker: false, ...extra });
  return { dir, platform, hash, fill, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// --- at a better price: the shares are there, budget still rests ---
{
  const h = await placed({ price: 0.63, shares: 5 });
  h.fill("a", 0.55, 5.6);                                   // 3.08 of 3.15 spent
  const order = h.platform.core.order(h.hash);
  assert.equal(order.status, "PARTIAL", "0.07 of budget still on the book: not FILLED at 5.6 >= 5 shares");
  assert.ok(Math.abs(order.reservedUsd - 0.07) < 1e-6, `reservation follows the unspent budget: ${order.reservedUsd}`);
  h.fill("b", 0.63, 0.1111111);                             // the rest, at the limit
  const done = h.platform.core.order(h.hash);
  assert.equal(done.status, "FILLED", "budget spent");
  assert.equal(done.reservedUsd, 0);
  h.done();
}
// --- the 19:05 order: 4.99753 of 5 at 0.23 is filled ---
{
  const h = await placed({ price: 0.23, shares: 5 });
  h.fill("a", 0.23, 3.53, { isMaker: true });
  assert.equal(h.platform.core.order(h.hash).status, "PARTIAL");
  h.fill("b", 0.2300000681417075, 1.46753, { isMaker: true });
  const order = h.platform.core.order(h.hash);
  assert.equal(order.status, "FILLED", "0.0006 left at 0.23 is under one 0.01 share: nothing left to trade");
  assert.equal(order.reservedUsd, 0);
  h.done();
}
// --- the spending fill ends a stuck UNKNOWN order (refused cancel) ---
{
  const h = await placed({ price: 0.23, shares: 5, cancel: async () => false, venueStatus: "matched" });
  h.fill("a", 0.23, 3.53, { status: "CONFIRMED", isMaker: true });
  await h.platform.core.cancel(h.hash).catch(() => undefined);
  assert.equal(h.platform.core.order(h.hash).status, "UNKNOWN", "precondition: the refused cancel");
  assert.equal(h.platform.core.closeSpent(h.hash), false, "budget left: keep waiting");
  h.fill("b", 0.23, 1.46753, { status: "MATCHED", isMaker: true });
  assert.equal(h.platform.core.order(h.hash).status, "FILLED", "the fill that spends the budget ends it");
  h.done();
}
// --- closeSpent ends one restored stuck (the 19:05 state: UNKNOWN, budget
// spent, quarantined; an older engine never finished it) ---
const restoredStuck = async ({ settled }) => {
  const h = await placed({ price: 0.23, shares: 5, cancel: async () => false, venueStatus: "matched" });
  h.fill("a", 0.23, 3.53, { status: "CONFIRMED", isMaker: true });
  h.fill("b", 0.23, 1.46753, { status: settled ? "CONFIRMED" : "MATCHED", isMaker: true });
  const state = h.platform.core.snapshot();
  const order = state.orders.find(o => o.orderId === h.hash);
  Object.assign(order, { status: "UNKNOWN", venueStatus: "matched", reconciliationPending: true, reservedUsd: 0.0005681,
    error: "order detail unavailable; venue outcome pending" });
  state.quarantinedOrderIds = [h.hash];
  h.done();
  const p = new TradingPlatform({ account: { accountId: "t", at: START + 301, cashAt: START + 301, cashUsd: 98.85, positions: [], openOrders: [], complete: true },
    instruments: market.instruments, limits, restored: state, now: () => START + 310,
    adapters: { gateway: { mode: "live", durableIdentity: true, async submit() {}, async cancel() { return false; } }, estimateFee: () => 0 } });
  p.ingest({ kind: "market", market });
  return { p, hash: h.hash };
};
{
  const { p, hash } = await restoredStuck({ settled: false });
  assert.equal(p.core.closeSpent(hash), false, "a MATCHED (unsettled) fill keeps it open");
  const { p: q, hash: id } = await restoredStuck({ settled: true });
  assert.equal(q.core.order(id).status, "UNKNOWN", "precondition: restored stuck");
  assert.equal(q.core.closeSpent(id), true, "matched, budget spent, fills settled: filled");
  const closed = q.core.order(id);
  assert.deepEqual([closed.status, closed.reservedUsd, closed.reconciliationPending], ["FILLED", 0, false]);
  assert.equal(q.core.isOrderQuarantined(id), false);
  assert.equal(q.core.closeSpent(id), false, "closing twice is a no-op");
  assert.equal(q.account.current().risk.unresolvedOrderCount ?? 0, 0, "nothing left to resolve");
}
// --- a maker fill a hair over the limit (live 2026-11-14) keeps the
// reservation at the unfilled shares x limit, and the state restores ---
{
  const h = await placed({ price: 0.23, shares: 5 });
  h.fill("a", 0.2300000681417075, 3.53, { isMaker: true });
  const order = h.platform.core.order(h.hash);
  assert.equal(order.status, "PARTIAL");
  assert.ok(order.reservedUsd + 1e-8 >= (5 - 3.53) * 0.23, `reservation ${order.reservedUsd} under ${(5 - 3.53) * 0.23}`);
  const state = h.platform.core.snapshot();
  h.done();
  assert.doesNotThrow(() => new TradingPlatform({ account: { accountId: "t", at: START + 130, cashAt: START + 130, cashUsd: 99, positions: [], openOrders: [], complete: true },
    instruments: market.instruments, limits, restored: state, now: () => START + 131,
    adapters: { gateway: { mode: "live", durableIdentity: true, async submit() {}, async cancel() { return true; } }, estimateFee: () => 0 } }),
    "the state restores (validateAccount's reservation floor)");
}
// --- a FAILED leg of a GTC holding more than its shares: no negative reservation ---
{
  const h = await placed({ price: 0.63, shares: 5 });
  h.fill("a", 0.55, 5.3, { status: "MATCHED" });
  h.fill("b", 0.55, 0.3, { status: "MATCHED" });
  h.fill("b", 0.55, 0.3, { status: "FAILED" });
  const order = h.platform.core.order(h.hash);
  assert.ok(order.reservedUsd >= 0, `reservation never negative: ${order.reservedUsd}`);
  assert.ok(Math.abs(order.reservedUsd - (5 * 0.63 - 5.3 * 0.55)) < 1e-6, `unspent budget reserved: ${order.reservedUsd}`);
  h.done();
}
// --- a late leg never re-opens a FILLED order ---
{
  const h = await placed({ price: 0.63, shares: 5 });
  h.fill("a", 0.63, 5);
  assert.equal(h.platform.core.order(h.hash).status, "FILLED");
  try { h.fill("z", 0.55, 0.001); } catch { /* over budget: refused, fine */ }
  assert.equal(h.platform.core.order(h.hash).status, "FILLED", "still FILLED");
  h.done();
}
// --- a FAK still ends on its shares ---
{
  const h = await placed({ price: 0.63, shares: 5, timeInForce: "FAK", venueStatus: "matched" });
  h.fill("a", 0.55, 5);
  assert.equal(h.platform.core.order(h.hash).status, "FILLED");
  h.done();
}
// --- no signed replay of binance-lead's GTC ---
{
  const order = { status: "UNKNOWN", timeInForce: "GTC", postOnly: false, preparedReplayAttempts: 0, prepared: { orderHash: "0x1" } };
  const m = { endsAt: START + 300 };
  assert.equal(replaysPreparedOrder(order, undefined, m, START + 10), true, "another strategy's GTC still replays");
  assert.equal(replaysPreparedOrder({ ...order, strategyId: "binance-lead" }, undefined, m, START + 10), false, "the lead GTC answers a gone signal");
}
console.log("gtc-budget OK");
process.exit(0);
